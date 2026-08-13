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
 * Resolve the owning principal for a per-user route.
 *
 * Every per-user route is scoped by `user_id` without exception (CLAUDE.md §7.5)
 * — this returns the id to scope by. The administrator has one too, from
 * migration 004, so they configure their own DependencyTrack connection and see
 * their own dashboard through exactly these routes rather than a parallel set.
 *
 * The 403 below is now unreachable in normal operation and stays as a guard: a
 * principal with no id must never fall through to an unscoped query.
 *
 * @returns {string|null} the id to scope by, or null once a 403 has been sent
 */
function requireUser(principal, res) {
  if (principal && principal.userId) return principal.userId;
  jsonReply(res, 403, {
    error: 'This session has no configuration of its own.',
    code: 'USER_ONLY',
  });
  return null;
}

/**
 * Read the full request body as a Buffer.
 *
 * readBody() concatenates onto a string, which decodes each chunk as UTF-8 and
 * destroys any byte that is not valid UTF-8 — fine for JSON, silently corrupting
 * for an image. Binary uploads must use this instead.
 *
 * @param {import('http').IncomingMessage} req
 * @param {number} maxBytes  no default: a binary route states its own ceiling
 */
function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { jsonReply, readBody, readBuffer, readJson, requireUser };
