// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── DependencyTrack read proxy ────────────────────────────────────────────────
//   GET /violation-cache/dt/api/v1/…   forward to the signed-in user's DT
//
// S21: the DT API key never reaches the browser (CLAUDE.md §7.7). Before this
// module the dashboard held the key in localStorage and sent it as X-Api-Key on
// every request, which meant anyone with access to the browser — or to a
// cross-site script on the page — had the key itself. Now the browser sends only
// its session token and the key is injected here, server side, from the row that
// belongs to that user.
//
// Read-only by design: only GET is forwarded, and only under /api/v1/. The proxy
// is not a general-purpose tunnel into DependencyTrack.

const { log } = require('../lib/log');
const { jsonReply } = require('../lib/http-util');
// Held as a module reference rather than destructured so the offline route
// tests can substitute it (CLAUDE.md §10.1). It is still the one and only
// entry point to the DT API (§6.2).
const dtFetch = require('../lib/dt-fetch');
const dtConnections = require('../lib/dt-connections');

const PREFIX = '/violation-cache/dt';

async function handle({ method, url, path: parsedPath, res, principal }) {
  if (!parsedPath.startsWith(`${PREFIX}/`)) return false;

  if (method !== 'GET') {
    jsonReply(res, 405, {
      error: 'Only GET requests are proxied to DependencyTrack.',
      code: 'METHOD_NOT_ALLOWED',
    });
    return true;
  }

  // Everything after the prefix, query string included — the browser builds the
  // same DT paths it always did, just against this origin.
  const upstreamPath = url.slice(PREFIX.length);
  if (!upstreamPath.startsWith('/api/v1/')) {
    jsonReply(res, 404, { error: 'Not a DependencyTrack API path.', code: 'NOT_FOUND' });
    return true;
  }

  // Every principal that reaches here has an id to scope by, the administrator
  // included (migration 004). This stays as a guard: a principal without one
  // must never reach an unscoped connection lookup.
  if (!principal.userId) {
    jsonReply(res, 403, {
      error: 'This session has no DependencyTrack connection of its own.',
      code: 'USER_ONLY',
    });
    return true;
  }

  let conn;
  try {
    conn = await dtConnections.getResolved(principal.userId);
  } catch (err) {
    if (err.code === 'DT_KEY_UNREADABLE') {
      jsonReply(res, 503, { error: err.message, code: 'DT_KEY_UNREADABLE' });
      return true;
    }
    throw err;
  }

  if (!conn || !conn.isConfigured || !conn.apiKey) {
    // The dashboard branches on this code to fall back to demo data rather than
    // showing an error (CLAUDE.md §11.2).
    jsonReply(res, 503, {
      error: 'No DependencyTrack connection is configured for this account.',
      code: 'DT_NOT_CONFIGURED',
    });
    return true;
  }

  try {
    const { json, headers } = await dtFetch.dtGetWithRetry(upstreamPath, conn.apiUrl, conn.apiKey);
    const payload = JSON.stringify(json);
    const out = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control':  'no-store',
      // The pagination loop in the dashboard reads this header; without the
      // expose header it is invisible to fetch() under the service's open CORS
      // policy (CLAUDE.md §12).
      'Access-Control-Expose-Headers': 'X-Total-Count',
    };
    if (headers['x-total-count'] !== undefined) out['X-Total-Count'] = headers['x-total-count'];
    res.writeHead(200, out);
    res.end(payload);
  } catch (err) {
    // An upstream 401 must NOT surface as our 401 — apiFetch() treats any 401 as
    // "the session died" and would sign the user out over a bad DT key.
    const dtStatus = err.statusCode || null;
    log('warn', 'DT proxy request failed', {
      userId: principal.userId, path: upstreamPath.split('?')[0], dtStatus,
      error: err.message,
    });
    jsonReply(res, 502, {
      error: dtStatus
        ? `DependencyTrack returned HTTP ${dtStatus}. Check the connection URL and API key in Settings.`
        : `DependencyTrack could not be reached: ${err.message}`,
      code: 'DT_UPSTREAM_ERROR',
      dtStatus,
    });
  }
  return true;
}

module.exports = { handle, PREFIX };
