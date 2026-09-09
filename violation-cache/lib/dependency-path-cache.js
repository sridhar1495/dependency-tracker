// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Cached dependency-graph walks — data access ───────────────────────────────
// Mirrors lib/caches.js's shape for violation_caches, one project at a time
// instead of one connection: row CRUD, job status, the advisory-locked
// builder election, and the two housekeeping sweeps (CLAUDE.md §6.3, §7.5).
//
// Split from lib/dependency-paths.js (the walk itself) for the same reason
// violation_caches is split from violation-cache.js: runJob there calls this
// module's functions through the imported reference, which is what lets a
// test replace acquireBuildLock/markBuilding/etc. without a database —
// stubbing a same-file bare call does not work in JavaScript.

const crypto = require('crypto');
const { query, getPool } = require('../db/pool');
const { log } = require('./log');
const { lockKeyFor } = require('./caches');

const DEFAULT_STALL_MS = 15 * 60_000;

// Overridable the same way violation-cache.js's is, so a test can shrink the
// window to milliseconds instead of waiting out fifteen real minutes to prove
// the watchdog fires (CLAUDE.md §10.5's "raced against a deadline" rule).
let _cfg = null;
function configure(cfg) { _cfg = cfg; }

/** The stall window a caller reading a row directly should use, so nobody keeps a second copy of the default. */
function stallWindowMs() { return (_cfg && _cfg.stallMs) || DEFAULT_STALL_MS; }

const META_COLUMNS = `
  fingerprint, project_uuid AS "projectUuid", status,
  bom_import_at AS "bomImportAt", total_components AS "totalComponents",
  resolved_components AS "resolvedComponents", paths, error,
  updated_at AS "updatedAt"
`;

async function getMeta(fingerprint, projectUuid) {
  const { rows } = await query(
    `SELECT ${META_COLUMNS} FROM dependency_paths WHERE fingerprint = $1 AND project_uuid = $2`,
    [fingerprint, projectUuid]
  );
  return rows[0] || null;
}

/**
 * building / stalled / ready / failed / none. No 'stale' — bom-import
 * staleness is a live comparison the route makes (it already has a fresh
 * project fetch in hand for the direct-dependency check), not a stored state.
 */
function deriveStatus(row, stallMs = DEFAULT_STALL_MS) {
  if (!row) return 'none';
  if (row.status === 'building') {
    if (!row.updatedAt) return 'building';
    const quietMs = Date.now() - new Date(row.updatedAt).getTime();
    return quietMs > stallMs ? 'stalled' : 'building';
  }
  return row.status; // 'ready' | 'failed'
}

async function markBuilding(fingerprint, projectUuid) {
  await query(
    `INSERT INTO dependency_paths
       (fingerprint, project_uuid, status, total_components, resolved_components, error)
     VALUES ($1, $2, 'building', 0, 0, NULL)
     ON CONFLICT (fingerprint, project_uuid) DO UPDATE
       SET status = 'building', error = NULL,
           total_components = 0, resolved_components = 0, updated_at = now()`,
    [fingerprint, projectUuid]
  );
}

async function setProgress(fingerprint, projectUuid, { total, resolved }) {
  await query(
    `UPDATE dependency_paths
        SET total_components = $3, resolved_components = $4, updated_at = now()
      WHERE fingerprint = $1 AND project_uuid = $2`,
    [fingerprint, projectUuid, total, resolved]
  );
}

/** Touched only while a walk is actually advancing — see dependency-paths.js's runJob watchdog. */
async function touchBuild(fingerprint, projectUuid) {
  const { rowCount } = await query(
    `UPDATE dependency_paths SET updated_at = now()
      WHERE fingerprint = $1 AND project_uuid = $2 AND status = 'building'`,
    [fingerprint, projectUuid]
  );
  return rowCount > 0;
}

async function storeResult(fingerprint, projectUuid, { paths, totalComponents, bomImportAt }) {
  await query(
    `UPDATE dependency_paths
        SET status = 'ready', paths = $3::jsonb,
            total_components = $4, resolved_components = $4,
            bom_import_at = $5, error = NULL, updated_at = now()
      WHERE fingerprint = $1 AND project_uuid = $2`,
    [fingerprint, projectUuid, JSON.stringify(paths), totalComponents, bomImportAt]
  );
}

async function markFailed(fingerprint, projectUuid, message) {
  await query(
    `UPDATE dependency_paths SET status = 'failed', error = $3, updated_at = now()
      WHERE fingerprint = $1 AND project_uuid = $2`,
    [fingerprint, projectUuid, String(message).slice(0, 500)]
  );
}

/** Mirrors caches.failOrphanedBuilds() — run at boot, before the listener starts (CLAUDE.md §6.3). */
async function failOrphanedBuilds() {
  const { rowCount } = await query(
    `UPDATE dependency_paths SET status = 'failed',
            error = 'The service restarted while this walk was running.'
      WHERE status = 'building'`
  );
  if (rowCount) log('info', 'Marked interrupted dependency-path walks as failed', { count: rowCount });
  return rowCount;
}

/** Mirrors caches.sweepOrphaned() — no time-based expiry here, only orphaned connections. */
async function sweepOrphaned() {
  const { rowCount } = await query(
    `DELETE FROM dependency_paths
      WHERE fingerprint NOT IN (SELECT fingerprint FROM dt_connections WHERE fingerprint IS NOT NULL)`
  );
  if (rowCount) log('info', 'Swept unused dependency-path caches', { removed: rowCount });
  return rowCount;
}

// ── Advisory lock, keyed per (fingerprint, project) ─────────────────────────
// violation_caches' lock is one bigint per connection; this needs one per
// project within a connection, so the pair is folded through SHA-256 first
// and the existing hi/lo split (caches.lockKeyFor) is reused rather than
// duplicated.
async function acquireBuildLock(fingerprint, projectUuid) {
  const combined = crypto.createHash('sha256')
    .update(`${fingerprint}:${projectUuid}`, 'utf8').digest('hex');
  const { hi, lo } = lockKeyFor(combined);
  const client = await getPool().connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [hi, lo]);
    if (!rows[0].ok) { client.release(); return { acquired: false, release: async () => {} }; }
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

module.exports = {
  configure, stallWindowMs, getMeta, deriveStatus,
  markBuilding, setProgress, touchBuild, storeResult, markFailed,
  failOrphanedBuilds, sweepOrphaned, acquireBuildLock,
  DEFAULT_STALL_MS,
};
