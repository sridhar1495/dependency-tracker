// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Storage headroom ──────────────────────────────────────────────────────────
// The administrator needs to know the host is about to run out of disk BEFORE
// PostgreSQL stops accepting writes, because at that point the service cannot
// record a report, a session or an audit row — it fails in every direction at
// once and the cause is not obvious from any of them.
//
// Three numbers answer it: how much room is left on the filesystem, how much of
// it this installation is using, and which accounts are using it.
//
// ── Why statfs on the data directory tells the truth ─────────────────────────
// docker-compose.yml bind-mounts BOTH ./violation-cache/data (this service's
// /data) and ./violation-cache/pgdata (the database's storage) from the same
// host directory, so they are siblings on one filesystem. Measuring the one
// this container can already see reports the same free space as measuring the
// database's, without mounting PostgreSQL's data files into this process — the
// numbers are wanted, the ability to read the files is not.
//
// That equivalence is a property of the compose file, not of the universe. An
// operator who relocates pgdata to a separate disk gets headroom for the wrong
// filesystem, which is why the reported path is included in the response rather
// than hidden: the answer names what it measured.
//
// fs.statfs is built into Node — no dependency, one syscall (CLAUDE.md §3).

const fs = require('fs');
const { promisify } = require('util');
const { query } = require('../db/pool');
const { log } = require('./log');
const users = require('./users');

const statfs = promisify(fs.statfs);

// P18: the whole payload is cached briefly. Free space does not move meaningfully
// second to second, and pg_database_size scans the catalogue — an administration
// screen that polls must not turn into load.
const CACHE_TTL_MS = 10_000;

// Headroom below which the screen should say something. Chosen as a share
// rather than an absolute: "2 GB left" means very different things on a 20 GB
// volume and a 2 TB one.
const WARN_BELOW_FRACTION     = 0.15;
const CRITICAL_BELOW_FRACTION = 0.05;

let _path = null;
let _cache = null;   // { at: number, value: object }

/** Called once during boot with the directory this service already mounts. */
function configure({ dataPath }) {
  _path = dataPath;
  _cache = null;
}

/** Warning level for a given free share, so the UI does not invent thresholds. */
function levelFor(freeFraction) {
  if (freeFraction === null) return 'unknown';
  if (freeFraction <= CRITICAL_BELOW_FRACTION) return 'critical';
  if (freeFraction <= WARN_BELOW_FRACTION) return 'warning';
  return 'ok';
}

/**
 * Filesystem headroom for the directory this service holds.
 *
 * Returns `available: null` rather than throwing when the path cannot be
 * stat-ed. A missing number is a gap in a status screen; an exception would
 * take out the whole administration response for something advisory.
 */
async function filesystem() {
  if (!_path) return { path: null, available: null, total: null, used: null, freeFraction: null };
  try {
    const st = await statfs(_path);
    // bavail, not bfree: blocks reserved for root are not room this service has.
    const available = st.bavail * st.bsize;
    const total     = st.blocks * st.bsize;
    return {
      path: _path,
      available,
      total,
      used: total - available,
      freeFraction: total > 0 ? available / total : null,
    };
  } catch (err) {
    log('warn', `Could not read filesystem usage: ${err.message}`, { path: _path });
    return { path: _path, available: null, total: null, used: null, freeFraction: null };
  }
}

/** How much of that filesystem this installation's database occupies. */
async function databaseBytes() {
  try {
    const { rows } = await query('SELECT pg_database_size(current_database())::bigint AS bytes');
    return Number(rows[0].bytes);
  } catch (err) {
    log('warn', `Could not read database size: ${err.message}`);
    return null;
  }
}

/**
 * Report bytes per account, largest first, so the administrator can see whose
 * reports are consuming the volume rather than only that something is.
 */
async function topStorageAccounts(limit = 5) {
  try {
    const { rows } = await query(
      `SELECT u.login_id AS "loginId",
              count(r.id)::int AS "reportCount",
              COALESCE(sum(r.file_size_bytes), 0)::bigint AS bytes
         FROM users u
         JOIN reports r ON r.user_id = u.id
        WHERE u.id <> $2
        GROUP BY u.login_id
        HAVING COALESCE(sum(r.file_size_bytes), 0) > 0
        ORDER BY bytes DESC
        LIMIT $1`,
      [limit, users.ADMIN_PRINCIPAL_ID]
    );
    return rows.map(r => ({ ...r, bytes: Number(r.bytes) }));
  } catch (err) {
    log('warn', `Could not read per-account storage: ${err.message}`);
    return [];
  }
}

/** The whole storage picture, cached for CACHE_TTL_MS. */
async function stats() {
  const now = Date.now();
  if (_cache && (now - _cache.at) < CACHE_TTL_MS) return _cache.value;

  const [fsInfo, dbBytes, top] = await Promise.all([
    filesystem(), databaseBytes(), topStorageAccounts(),
  ]);

  const value = {
    filesystem: {
      path:         fsInfo.path,
      totalBytes:   fsInfo.total,
      usedBytes:    fsInfo.used,
      availableBytes: fsInfo.available,
      freePercent:  fsInfo.freeFraction === null ? null : Math.round(fsInfo.freeFraction * 1000) / 10,
      level:        levelFor(fsInfo.freeFraction),
    },
    databaseBytes: dbBytes,
    topAccounts:   top,
    measuredAt:    new Date(now).toISOString(),
  };
  _cache = { at: now, value };
  return value;
}

/** Drop the cache. Used by tests; never needed in normal operation. */
function clearCache() { _cache = null; }

module.exports = {
  configure, stats, filesystem, databaseBytes, topStorageAccounts, levelFor, clearCache,
  CACHE_TTL_MS, WARN_BELOW_FRACTION, CRITICAL_BELOW_FRACTION,
};
