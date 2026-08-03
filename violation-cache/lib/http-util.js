// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── HTTP response and request-body helpers ────────────────────────────────────
// Every JSON response in the service goes through jsonReply so that the
// Content-Length and no-store cache headers are always consistent.

/**
 * Send a JSON response.
 * Error bodies use `{ error }`, plus a stable `code` where the frontend has to
 * branch on the reason (CLAUDE.md §11.1).
 */
function jsonReply(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control':  'no-store',
  });
  res.end(payload);
}

/**
 * Read the full request body as a string.
 * S3: the default 64 KB ceiling bounds memory per in-flight request. Overrides
 * are per route and must be justified (CLAUDE.md §12).
 *
 * @param {import('http').IncomingMessage} req
 * @param {number} [maxBytes=65536]
 */
function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '', bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { req.destroy(); reject(new Error('Request body too large')); return; }
      data += chunk;
    });
    req.on('end',   () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Read and parse a JSON request body, replying 400 itself on failure.
 *
 * @returns {Promise<object|null>} the parsed body, or null once a reply is sent
 */
async function readJson(req, res, maxBytes = 64 * 1024) {
  let raw;
  try {
    raw = await readBody(req, maxBytes);
  } catch (e) {
    jsonReply(res, 400, { error: e.message, code: 'BODY_TOO_LARGE' });
    return null;
  }
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    jsonReply(res, 400, { error: 'Request body is not valid JSON.', code: 'BAD_JSON' });
    return null;
  }
}

/**
 * Resolve the owning user for a per-user route.
 *
 * The administrator principal has no `userId` and therefore no data of its own;
 * every per-user route is scoped by `user_id` without exception (CLAUDE.md §7.5),
 * so there is nothing sensible to return.
 *
 * @returns {string|null} the user id, or null once a 403 has been sent
 */
function requireUser(principal, res) {
  if (principal && principal.userId) return principal.userId;
  jsonReply(res, 403, {
    error: 'This is a per-user setting and the administrator account has none.',
    code: 'USER_ONLY',
  });
  return null;
}

module.exports = { jsonReply, readBody, readJson, requireUser };
