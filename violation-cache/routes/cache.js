// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Violation cache endpoints ─────────────────────────────────────────────────
//   GET  /violation-cache/status   build state for the signed-in user's connection
//   GET  /violation-cache/data     the cached count map
//   POST /violation-cache/refresh  ask for a rebuild
//
// The cache is shared, keyed by a fingerprint of the DependencyTrack connection
// rather than by user, so twenty accounts pointing at one DT instance with the
// same key cause one crawl and not twenty (CLAUDE.md §7.5, §13). Callers that
// lose the builder election are told "building" and poll for the winner's
// result — exactly what a second tab already did.

const { log } = require('../lib/log');
const { jsonReply, requireUser } = require('../lib/http-util');
const cache  = require('../lib/violation-cache');
const caches = require('../lib/caches');
const dtConnections = require('../lib/dt-connections');

/**
 * Resolve the caller's connection, replying itself on the failure paths.
 *
 * @returns {Promise<object|null>} the resolved connection, or null once answered
 */
async function connectionFor(userId, res, { quiet = false } = {}) {
  let conn;
  try {
    conn = await dtConnections.getResolved(userId);
  } catch (err) {
    if (err.code === 'DT_KEY_UNREADABLE') {
      if (quiet) { jsonReply(res, 200, { status: 'no-key', reason: err.message }); return null; }
      jsonReply(res, 503, { error: err.message, code: 'DT_KEY_UNREADABLE' });
      return null;
    }
    throw err;
  }
  if (!conn || !conn.isConfigured || !conn.apiKey) {
    // 'no-key' is the status the dashboard already understands as "fall back to
    // demo data", so an unconfigured account is not an error.
    if (quiet) { jsonReply(res, 200, { status: 'no-key' }); return null; }
    jsonReply(res, 503, {
      error: 'No DependencyTrack connection is configured for this account.',
      code: 'DT_NOT_CONFIGURED',
    });
    return null;
  }
  return conn;
}

async function handle({ method, path: parsedPath, res, principal }) {

  // ── GET /violation-cache/status ─────────────────────────────────────────
  if (method === 'GET' && parsedPath === '/violation-cache/status') {
    const userId = requireUser(principal, res);
    if (!userId) return true;
    try {
      const conn = await connectionFor(userId, res, { quiet: true });
      if (!conn) return true;

      const status = await cache.getStatus(conn);

      // Missing, expired or abandoned: try to become the builder. A caller that
      // loses the election gets `started:false` back straight away and polls.
      //
      // 'stalled' is the recovery path for a build whose process died. It is
      // answered as 'building' because that is what it now is — a fresh build
      // has just been started — and reporting it any other way would make the
      // dashboard offer a refetch it has already begun.
      if (status.status === 'none' || status.status === 'stale' || status.status === 'stalled') {
        if (status.status === 'stalled') {
          log('warn', 'Restarting an abandoned violation cache build', {
            fingerprint: conn.fingerprint.slice(0, 12),
          });
        }
        cache.runJob(conn).catch(err =>
          log('error', `Cache build error: ${err.message}`, { userId }));
        if (status.status !== 'stale') {
          jsonReply(res, 200, { status: 'building', progress: { pagesDone: 0, pagesTotal: 0 } });
          return true;
        }
      }
      jsonReply(res, 200, status);
    } catch (err) {
      log('error', `Cache status failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not read the cache status.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── GET /violation-cache/data ───────────────────────────────────────────
  if (method === 'GET' && parsedPath === '/violation-cache/data') {
    const userId = requireUser(principal, res);
    if (!userId) return true;
    try {
      const conn = await connectionFor(userId, res);
      if (!conn) return true;

      const payload = await caches.getPayloadGzip(conn.fingerprint);
      if (!payload) {
        jsonReply(res, 404, { error: 'No cache available yet.', code: 'NO_CACHE' });
        return true;
      }
      // P15: stored gzipped and served gzipped — no decompress/recompress round
      // trip, and the count map compresses to a fraction of its JSON size.
      res.writeHead(200, {
        'Content-Type':     'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length':   payload.length,
        'Cache-Control':    'no-store',
      });
      res.end(payload);
    } catch (err) {
      log('error', `Serving the cache failed: ${err.message}`, { userId });
      if (!res.headersSent) jsonReply(res, 500, { error: 'Could not read the cache.', code: 'INTERNAL' });
      else res.end();
    }
    return true;
  }

  // ── POST /violation-cache/refresh ───────────────────────────────────────
  if (method === 'POST' && parsedPath === '/violation-cache/refresh') {
    const userId = requireUser(principal, res);
    if (!userId) return true;
    try {
      const conn = await connectionFor(userId, res);
      if (!conn) return true;

      // Only a build that is genuinely alive blocks a new one. A row left
      // saying 'building' by a process that died reads as 'stalled' and falls
      // through, so the button recovers on its own instead of answering 409
      // forever (CLAUDE.md §6.3).
      const meta = await caches.getMeta(conn.fingerprint);
      if (caches.deriveStatus(meta, cache.stallWindowMs()) === 'building') {
        jsonReply(res, 409, { status: 'building', message: 'A build is already in progress.' });
        return true;
      }
      cache.runJob(conn).catch(err =>
        log('error', `Cache build error: ${err.message}`, { userId }));
      jsonReply(res, 202, { status: 'building', message: 'Job started' });
    } catch (err) {
      log('error', `Cache refresh failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not start a rebuild.', code: 'INTERNAL' });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
