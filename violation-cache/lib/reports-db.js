// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Report metadata and file bytes — data access ──────────────────────────────
// Replaces the JSON registry and the .xlsx files under /data/reports.
//
// Two performance properties matter here and are the reason for the split:
//
//   P12: bytes live in report_file_chunks, so listing reports never reads file
//        content. No projection in this module selects the chunk column
//        alongside metadata.
//   P13: progress is written at most once per second per report. The previous
//        implementation rewrote the whole registry file after every project and
//        risk type — roughly 1,500 writes for a 500-project report.
//
// Every query is scoped by user_id. A report belonging to someone else is
// reported as not found, never as forbidden (CLAUDE.md §7.5).

const { query, tx } = require('../db/pool');
const { log } = require('./log');

// 4 MB slices: large enough that a big workbook is a handful of rows, small
// enough that streaming one chunk never spikes memory.
const CHUNK_BYTES = 4 * 1024 * 1024;

// A workbook larger than this indicates something pathological; refusing beats
// filling the volume.
const MAX_REPORT_BYTES = 200 * 1024 * 1024;

const PUBLIC_COLUMNS = `
  id, status, filename, risk_types AS "riskTypes", progress, error,
  file_size_bytes AS "fileSizeBytes", project_count AS "projectCount",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

/** Create a pending report and return its row. */
async function create(userId, { riskTypes, projectCount }) {
  const { rows } = await query(
    `INSERT INTO reports (user_id, status, risk_types, project_count, progress)
     VALUES ($1, 'pending', $2, $3, '{}'::jsonb)
     RETURNING ${PUBLIC_COLUMNS}`,
    [userId, riskTypes, projectCount]
  );
  return rows[0];
}

/** All of a user's reports, newest first. Never touches chunk bytes. */
async function listForUser(userId, limit = 200) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM reports WHERE user_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

/** One report, scoped by owner. Returns null for someone else's report. */
async function getForUser(userId, reportId) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM reports WHERE id = $1 AND user_id = $2`,
    [reportId, userId]
  );
  return rows[0] || null;
}

/** Completed plus running count, for the per-user quota check. */
async function activeCount(userId) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE status = 'completed')::int AS completed,
       count(*) FILTER (WHERE status = 'running')::int   AS running
     FROM reports WHERE user_id = $1 AND status IN ('completed','running')`,
    [userId]
  );
  return rows[0] || { completed: 0, running: 0 };
}

async function setStatus(reportId, status, patch = {}) {
  await query(
    `UPDATE reports
        SET status = $2,
            filename = COALESCE($3, filename),
            error = COALESCE($4, error),
            file_size_bytes = COALESCE($5, file_size_bytes),
            progress = COALESCE($6::jsonb, progress)
      WHERE id = $1`,
    [reportId, status, patch.filename ?? null, patch.error ?? null,
     patch.fileSizeBytes ?? null, patch.progress ? JSON.stringify(patch.progress) : null]
  );
}

/**
 * Persist progress, throttled.
 *
 * The caller keeps the authoritative counters in memory and calls this freely;
 * the write is skipped unless a second has passed or `force` is set. Returns
 * whether a write actually happened, which the tests assert on.
 */
const _lastProgressWrite = new Map(); // reportId → epoch ms
const PROGRESS_INTERVAL_MS = 1000;

async function writeProgress(reportId, progress, { force = false } = {}) {
  const now  = Date.now();
  const last = _lastProgressWrite.get(reportId) || 0;
  if (!force && (now - last) < PROGRESS_INTERVAL_MS) return false;

  _lastProgressWrite.set(reportId, now);
  await query('UPDATE reports SET progress = $2::jsonb WHERE id = $1',
    [reportId, JSON.stringify(progress)]);
  return true;
}

function forgetProgress(reportId) { _lastProgressWrite.delete(reportId); }

/**
 * Store a finished workbook as chunks, in one transaction, and mark the report
 * completed. Either the whole file and its status land, or neither does.
 */
async function storeFile(reportId, buffer, filename) {
  if (buffer.length > MAX_REPORT_BYTES) {
    throw Object.assign(
      new Error(`Report is ${(buffer.length / 1048576).toFixed(1)} MB, above the ${MAX_REPORT_BYTES / 1048576} MB limit.`),
      { code: 'REPORT_TOO_LARGE' }
    );
  }

  await tx(async (client) => {
    await client.query('DELETE FROM report_file_chunks WHERE report_id = $1', [reportId]);
    let seq = 0;
    for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
      const slice = buffer.subarray(offset, Math.min(offset + CHUNK_BYTES, buffer.length));
      await client.query(
        'INSERT INTO report_file_chunks (report_id, seq, chunk) VALUES ($1, $2, $3)',
        [reportId, seq++, slice]
      );
    }
    await client.query(
      `UPDATE reports SET status = 'completed', filename = $2, file_size_bytes = $3
        WHERE id = $1`,
      [reportId, filename, buffer.length]
    );
  });

  log('info', 'Report stored', {
    reportId, bytes: buffer.length, chunks: Math.ceil(buffer.length / CHUNK_BYTES),
  });
}

/** How many chunks a report has. Used to drive streaming. */
async function chunkCount(reportId) {
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM report_file_chunks WHERE report_id = $1', [reportId]
  );
  return rows[0].n;
}

/**
 * Fetch one chunk. Reading in sequence keeps peak memory at one chunk rather
 * than one whole file — the driver buffers each value it returns.
 */
async function getChunk(reportId, seq) {
  const { rows } = await query(
    'SELECT chunk FROM report_file_chunks WHERE report_id = $1 AND seq = $2', [reportId, seq]
  );
  return rows[0] ? rows[0].chunk : null;
}

/** Delete a report and its bytes. Scoped by owner; chunks cascade. */
async function deleteForUser(userId, reportId) {
  const { rowCount } = await query(
    'DELETE FROM reports WHERE id = $1 AND user_id = $2', [reportId, userId]
  );
  _lastProgressWrite.delete(reportId);
  return rowCount > 0;
}

// trimToLimit() was removed with migration 005. It deleted a user's oldest
// completed reports when their limit was lowered, which was defensible while
// each user chose their own number. The limit is now an administrator's, and
// the same call from a global change would have destroyed reports across many
// accounts at once. Being over the limit blocks new reports; it never deletes
// existing ones. Do not reintroduce a trim without deciding that question again.

/**
 * Fail reports left running by a restart. The previous implementation did the
 * same thing for the JSON registry on boot.
 */
async function failOrphaned() {
  const { rowCount } = await query(
    `UPDATE reports SET status = 'failed',
            error = 'The service restarted while this report was being generated.'
      WHERE status IN ('running', 'pending')`
  );
  if (rowCount) log('info', 'Marked interrupted reports as failed', { count: rowCount });
  return rowCount;
}

/** Storage consumed per user, for the administration panel. */
async function storageByUser() {
  const { rows } = await query(
    `SELECT user_id AS "userId", count(*)::int AS reports,
            COALESCE(sum(file_size_bytes), 0)::bigint AS bytes
       FROM reports GROUP BY user_id`
  );
  return rows;
}

module.exports = {
  create, listForUser, getForUser, activeCount, setStatus,
  writeProgress, forgetProgress, storeFile, chunkCount, getChunk,
  deleteForUser, failOrphaned, storageByUser,
  CHUNK_BYTES, MAX_REPORT_BYTES, PROGRESS_INTERVAL_MS,
};
