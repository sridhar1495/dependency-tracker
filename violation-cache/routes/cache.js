// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Violation cache endpoints: build status, cached payload, manual rebuild.

const fs = require('fs');
const { log } = require('../lib/log');
const { jsonReply } = require('../lib/http-util');
const cache = require('../lib/violation-cache');

/**
 * @param {{ method: string, url: string, path: string, req: object, res: object,
 *           deps: object }} ctx
 * @returns {Promise<boolean>} true when this module handled the request
 */
async function handle({ method, url, res, deps }) {
    // ── GET /violation-cache/status ───────────────────────────────────────────
    if (method === 'GET' && url === '/violation-cache/status') {
      jsonReply(res, 200, cache.getStatus());
      return true;
    }
  
    // ── GET /violation-cache/data ─────────────────────────────────────────────
    if (method === 'GET' && url === '/violation-cache/data') {
      if (!fs.existsSync(deps.paths.cacheFile)) {
        jsonReply(res, 404, { error: 'No cache available' });
        return true;
      }
      try {
        const raw = fs.readFileSync(deps.paths.cacheFile);
        res.writeHead(200, {
          'Content-Type':   'application/json',
          'Content-Length': raw.length,
          'Cache-Control':  'no-store',
        });
        res.end(raw);
      } catch (e) {
        log('error', `Failed to serve cache file: ${e.message}`);
        jsonReply(res, 500, { error: 'Failed to read cache file' });
      }
      return true;
    }

    // ── POST /violation-cache/refresh ─────────────────────────────────────────
    if (method === 'POST' && url === '/violation-cache/refresh') {
      const { apiKey } = deps.getEffectiveConfig();
      if (!apiKey) {
        jsonReply(res, 503, { error: 'DT_API_KEY not configured on the cache service' });
        return true;
      }
      if (cache.isJobRunning()) {
        jsonReply(res, 409, { status: 'building', message: 'Job already running' });
        return true;
      }
      cache.runJob().catch(err => log('error', `Unhandled job error: ${err.message}`));
      jsonReply(res, 202, { status: 'building', message: 'Job started' });
      return true;
    }

  return false;
}

module.exports = { handle };
