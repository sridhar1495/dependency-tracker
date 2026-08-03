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

module.exports = { jsonReply, readBody };
