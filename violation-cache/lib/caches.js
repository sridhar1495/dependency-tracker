// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Shared violation cache — data access ──────────────────────────────────────
// The single biggest performance-by-design element in the migration.
//
// A cache row is keyed by a fingerprint of the DependencyTrack connection, NOT
// by user. Twenty users pointing at the same DT instance with the same key share
// one row and one build, so adding users does not multiply the load placed on
// DependencyTrack (CLAUDE.md §7.5, §13).
//
// Exactly one builder is elected with pg_try_advisory_lock. Losers do not wait:
// they report "building" and let the browser poll, which is what keeps a slow
// crawl from tying up connections.

const zlib = require('zlib');
const { promisify } = require('util');
const { query } = require('../db/pool');
const { log } = require('./log');

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Advisory locks take a bigint. Fold the hex fingerprint into a signed 64-bit
// value deterministically so every process derives the same key.
function lockKeyFor(fingerprint) {
  // Two 32-bit halves keep the result inside PostgreSQL's bigint range.
  const hi = parseInt(fingerprint.slice(0, 8), 16) | 0;
  const lo = parseInt(fingerprint.slice(8, 16), 16) | 0;
  return { hi, lo };
}

// Metadata only — payload_gzip is bytea and is never selected alongside it.
const META_COLUMNS = `
  fingerprint, status, project_count AS "projectCount",
  failed_pipelines AS "failedPipelines", generated_at AS "generatedAt",
  expires_at AS "expiresAt", progress, error
`;

/** Cache metadata for a connection, without the payload. */
async function getMeta(fingerprint) {
  const { rows } = await query(
    `SELECT ${META_COLUMNS} FROM violation_caches WHERE fingerprint = $1`, [fingerprint]
  );
  return rows[0] || null;
}

/**
 * The gzipped payload exactly as stored, for streaming to the browser with
 * Content-Encoding: gzip — no decompress/recompress round trip.
 */
async function getPayloadGzip(fingerprint) {
  const { rows } = await query(
    'SELECT payload_gzip FROM violation_caches WHERE fingerprint = $1', [fingerprint]
  );
  return rows[0] ? rows[0].payload_gzip : null;
}

/** The payload decoded, for server-side use such as report enrichment. */
async function getPayload(fingerprint) {
  const buf = await getPayloadGzip(fingerprint);
  if (!buf) return null;
  return JSON.parse((await gunzip(buf)).toString('utf8'));
}

/**
 * Derive the status the dashboard should act on.
 * Mirrors the previous file-based semantics: none / building / ready / stale.
 */
function deriveStatus(row) {
  if (!row) return 'none';
  if (row.status === 'building') return 'building';
  if (row.status === 'failed') return 'failed';
  if (!row.generatedAt || !row.expiresAt) return 'none';
  return new Date(row.expiresAt).getTime() < Date.now() ? 'stale' : 'ready';
}

/**
 * Try to become the builder for this connection.
 *
 * pg_try_advisory_lock returns immediately rather than blocking, so a caller
 * that loses simply reports "building". The lock is session-scoped, so it is
 * held on a dedicated client for the whole build and released in finally.
 *
 * @returns {Promise<{acquired: boolean, release: Function}>}
 */
async function acquireBuildLock(fingerprint) {
  const { hi, lo } = lockKeyFor(fingerprint);
  const { getPool } = require('../db/pool');
  const client = await getPool().connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [hi, lo]);
    if (!rows[0].ok) {
      client.release();
      return { acquired: false, release: async () => {} };
    }
    return {
      acquired: true,
      release: async () => {
        try { await client.query('SELECT pg_advisory_unlock($1, $2)', [hi, lo]); }
        catch (_) { /* connection already gone; the lock dies with the session */ }
        finally { client.release(); }
      },
    };
  } catch (err) {
    client.release();
    throw err;
  }
}

/** Mark a build as started, creating the row on first use. */
async function markBuilding(fingerprint) {
  await query(
    `INSERT INTO violation_caches (fingerprint, status, progress, error)
     VALUES ($1, 'building', '{}'::jsonb, NULL)
     ON CONFLICT (fingerprint) DO UPDATE
       SET status = 'building', error = NULL, progress = '{}'::jsonb`,
    [fingerprint]
  );
}

/** Publish progress during a build so pollers can show a page count. */
async function setProgress(fingerprint, progress) {
  await query(
    'UPDATE violation_caches SET progress = $2::jsonb WHERE fingerprint = $1',
    [fingerprint, JSON.stringify(progress)]
  );
}

/** Store a finished map, gzipped, and set the TTL. */
async function storeResult(fingerprint, map, { projectCount, failedPipelines, ttlMs }) {
  const payload = await gzip(Buffer.from(JSON.stringify(map), 'utf8'));
  const now = new Date();
  await query(
    `UPDATE violation_caches
        SET status = 'ready', payload_gzip = $2, project_count = $3,
            failed_pipelines = $4, generated_at = $5, expires_at = $6,
            progress = '{}'::jsonb, error = NULL
      WHERE fingerprint = $1`,
    [fingerprint, payload, projectCount, failedPipelines, now, new Date(now.getTime() + ttlMs)]
  );
  log('info', 'Violation cache stored', {
    fingerprint: fingerprint.slice(0, 12), projectCount, failedPipelines,
    gzipBytes: payload.length,
  });
}

/** Record a failed build without discarding a previously good payload. */
async function markFailed(fingerprint, message) {
  await query(
    `UPDATE violation_caches SET status = 'failed', error = $2, progress = '{}'::jsonb
      WHERE fingerprint = $1`,
    [fingerprint, String(message).slice(0, 500)]
  );
}

/**
 * Delete cache rows that no configured connection points at any more, plus
 * anything long expired. Without this the table accumulates a row per API key
 * that was ever used (CLAUDE.md §13).
 */
async function sweepOrphaned(expiredDays = 7) {
  const { rowCount } = await query(
    `DELETE FROM violation_caches
      WHERE fingerprint NOT IN (
              SELECT fingerprint FROM dt_connections WHERE fingerprint IS NOT NULL
            )
         OR (expires_at IS NOT NULL AND expires_at < now() - make_interval(days => $1))`,
    [expiredDays]
  );
  if (rowCount) log('info', 'Swept unused violation caches', { removed: rowCount });
  return rowCount;
}

/** How many distinct connections currently have a cache. For observability. */
async function count() {
  const { rows } = await query('SELECT count(*)::int AS n FROM violation_caches');
  return rows[0].n;
}

module.exports = {
  getMeta, getPayload, getPayloadGzip, deriveStatus,
  acquireBuildLock, markBuilding, setProgress, storeResult, markFailed,
  sweepOrphaned, count, lockKeyFor,
};
