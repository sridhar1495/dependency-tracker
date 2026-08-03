// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── DependencyTrack API access ────────────────────────────────────────────────
// Every call to the DT API goes through dtGetWithRetry. Do not add ad-hoc
// fetch/https.get calls elsewhere (CLAUDE.md §6.2).

const http    = require('http');
const https   = require('https');
const { log } = require('./log');
const { sleep } = require('./async-utils');

// ── HTTP keep-alive agents (P1) ───────────────────────────────────────────────
// Reusing connections across the 9 parallel pipelines avoids repeated TCP+TLS
// handshakes for every page fetch (potentially hundreds of connections).
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 20 });

const MAX_RETRIES  = 3;
const RETRY_DELAYS = [2000, 4000, 8000];

/** Perform a GET against the DT API and return parsed JSON plus response headers. */
function dtGet(urlPath, apiUrl, apiKey) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${apiUrl}${urlPath}`;
    const isHttps = fullUrl.startsWith('https');
    const mod     = isHttps ? https : http;
    const req     = mod.request(fullUrl, {
      method:             'GET',
      headers:            { 'X-Api-Key': apiKey, Accept: 'application/json' },
      rejectUnauthorized: false,
      agent:              isHttps ? httpsAgent : httpAgent, // P1: reuse connections
    }, (res) => {
      // Timeout on the response body stream — catches servers that send headers
      // then stall before flushing the body.
      const bodyTimer = setTimeout(() => {
        res.destroy(new Error('Response body timeout'));
      }, 90_000);

      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        clearTimeout(bodyTimer);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(Object.assign(
            new Error(`HTTP ${res.statusCode} for ${urlPath}`),
            { statusCode: res.statusCode }
          ));
          return;
        }
        try {
          resolve({ json: JSON.parse(body), headers: res.headers });
        } catch (e) {
          reject(new Error(`JSON parse failed for ${urlPath}: ${e.message}`));
        }
      });
      res.on('error', err => { clearTimeout(bodyTimer); reject(err); });
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('Request timeout')));
    req.end();
  });
}

/** dtGet with per-page exponential-backoff retry (2 s → 4 s → 8 s). */
async function dtGetWithRetry(urlPath, apiUrl, apiKey, attempt = 0) {
  try {
    return await dtGet(urlPath, apiUrl, apiKey);
  } catch (err) {
    if (attempt < MAX_RETRIES - 1) {
      const delay = RETRY_DELAYS[attempt];
      log('warn', `Retry ${attempt + 1}/${MAX_RETRIES - 1} for ${urlPath} after ${delay}ms`, { error: err.message });
      await sleep(delay);
      return dtGetWithRetry(urlPath, apiUrl, apiKey, attempt + 1);
    }
    throw err;
  }
}

module.exports = { dtGet, dtGetWithRetry, MAX_RETRIES, RETRY_DELAYS, httpAgent, httpsAgent };
