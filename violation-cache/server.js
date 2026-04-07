// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Violation Cache Service ───────────────────────────────────────────────────
// Fetches all policy violations from DependencyTrack and stores a compact
// per-project count map in a JSON file.  The dashboard reads this file once
// on page load instead of streaming thousands of violation objects through
// the browser.
//
// Endpoints:
//   GET  /violation-cache/status   — current state + build progress
//   GET  /violation-cache/data     — the cached map (only when ready/stale)
//   POST /violation-cache/refresh  — trigger a background rebuild
//   POST /violation-cache/config   — update DT_API_KEY in .env (persists across restarts)
//
// Status values:
//   none      — no cache file exists yet
//   building  — job is currently running
//   ready     — file exists and TTL has not expired
//   stale     — file exists but TTL has expired
//   no-key    — DT_API_KEY is not set; cannot fetch
//
// Environment variables:
//   PORT                — HTTP port (default 3001)
//   DT_API_URL          — DependencyTrack API base URL
//   DT_API_KEY          — API key for DependencyTrack
//   CACHE_TTL_HOURS     — hours before cache expires (default 24)
//   CACHE_DIR           — directory for cache files (default /data)
//   ENV_FILE            — path to bind-mounted .env file (default /app/.env)
//   LOG_FORMAT          — set to "json" for structured JSON log output

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Static config (set once at startup, never change at runtime) ──────────────
const PORT         = parseInt(process.env.PORT || '3001', 10);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_HOURS || '24', 10) * 3_600_000;
const CACHE_DIR    = process.env.CACHE_DIR || '/data';
const CACHE_FILE   = path.join(CACHE_DIR, 'violation-cache.json');
const CACHE_TMP    = path.join(CACHE_DIR, 'violation-cache.tmp.json');
// Path to the bind-mounted .env file — writable so the config endpoint can persist changes.
const ENV_FILE     = process.env.ENV_FILE || '/app/.env';

// ── Dynamic config — re-read from .env before every job run ──────────────────
// Falls back to env vars injected by Docker Compose (initial values).
const STARTUP_API_URL = (process.env.DT_API_URL || 'http://localhost:8080').replace(/\/$/, '');
const STARTUP_API_KEY = (process.env.DT_API_KEY || '').replace(/[\x00-\x1F\x7F]/g, '').trim();

// ── Structured logging (O3) ───────────────────────────────────────────────────
// Set LOG_FORMAT=json in .env or environment to emit newline-delimited JSON.
// Compatible with Datadog, Loki, Grafana, and other log aggregators.
const LOG_JSON = process.env.LOG_FORMAT === 'json';

function log(level, message, meta = {}) {
  const ts      = new Date().toISOString();
  const hasMeta = Object.keys(meta).length > 0;
  if (LOG_JSON) {
    const entry = { level, ts, msg: message };
    if (hasMeta) Object.assign(entry, meta);
    const out = JSON.stringify(entry);
    if (level === 'error') console.error(out);
    else if (level === 'warn') console.warn(out);
    else console.log(out);
  } else {
    const suffix = hasMeta ? ` ${JSON.stringify(meta)}` : '';
    const line   = `[cache] ${message}${suffix}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

// ── HTTP keep-alive agents (P1) ───────────────────────────────────────────────
// Reusing connections across the 9 parallel pipelines avoids repeated
// TCP+TLS handshakes for every page fetch (can be hundreds of connections).
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 20 });

// ── .env helpers (Q7, Q8) ─────────────────────────────────────────────────────

/** Parse a .env file and return a plain key→value object. */
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  // Q7: normalise Windows CRLF so keys/values don't carry a trailing \r
  for (const line of fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

/**
 * Write key=value updates into a .env file, preserving all other lines.
 * Q7: normalises CRLF before splitting.
 * Q8: throws typed errors for read and write failures so callers can log them separately.
 */
function patchEnvFile(filePath, updates) {
  // Q8: separate read error
  let content;
  try {
    content = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n') // Q7
      : '';
  } catch (e) {
    throw Object.assign(
      new Error(`Failed to read ${filePath}: ${e.message}`),
      { code: 'PATCH_READ_FAILED', cause: e }
    );
  }

  const remaining = new Set(Object.keys(updates));
  let lines = content.split('\n').map(line => {
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) return line;
    const key = line.slice(0, eqIdx).trim();
    if (key in updates) {
      remaining.delete(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  // Append any keys that were not already in the file
  for (const key of remaining) lines.push(`${key}=${updates[key]}`);

  // Q8: separate write error
  try {
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  } catch (e) {
    throw Object.assign(
      new Error(`Failed to write ${filePath}: ${e.message}`),
      { code: 'PATCH_WRITE_FAILED', cause: e }
    );
  }
}

/**
 * Read the effective DT_API_URL and DT_API_KEY.
 * Priority: .env file (if mounted and readable) > Docker Compose env vars.
 * Called before every job so changes written via /config are picked up immediately.
 */
function getEffectiveConfig() {
  const envVars = parseEnvFile(ENV_FILE);
  const apiUrl  = (envVars['DT_API_INTERNAL_URL'] || STARTUP_API_URL).replace(/\/$/, '');
  const apiKey  = (envVars['DT_API_KEY'] || STARTUP_API_KEY).replace(/[\x00-\x1F\x7F]/g, '').trim();
  return { apiUrl, apiKey };
}

// ── Fetch parameters ──────────────────────────────────────────────────────────
const PAGE_SIZE  = 100;
const RISK_TYPES = ['OPERATIONAL', 'LICENSE', 'SECURITY'];
const STATES     = ['FAIL', 'WARN', 'INFO'];
const CAT        = { OPERATIONAL: 'ops', LICENSE: 'lic', SECURITY: 'secpolicy' };
const SEV        = { FAIL: 'fail', WARN: 'warn', INFO: 'info' };

// ── Retry config ──────────────────────────────────────────────────────────────
const MAX_RETRIES  = 3;
const RETRY_DELAYS = [2000, 4000, 8000];

// ── In-memory job state ───────────────────────────────────────────────────────
let jobRunning  = false;
let jobProgress = { pagesDone: 0, pagesTotal: 0, failedPipelines: 0 };

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Perform a GET request to the DT API and return parsed JSON + response headers. */
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

/** dtGet with per-page exponential-backoff retry. */
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

// ── Cache file helpers ────────────────────────────────────────────────────────
function readCacheFile() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    log('error', `Failed to read cache file: ${e.message}`);
    return null;
  }
}

function writeCacheFile(data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_TMP, JSON.stringify(data), { mode: 0o640 });
  fs.renameSync(CACHE_TMP, CACHE_FILE); // atomic on POSIX
}

function getStatus() {
  if (jobRunning) {
    return {
      status:   'building',
      progress: { pagesDone: jobProgress.pagesDone, pagesTotal: jobProgress.pagesTotal },
    };
  }
  const { apiKey } = getEffectiveConfig();
  if (!apiKey) return { status: 'no-key' };
  const data = readCacheFile();
  if (!data) return { status: 'none' };
  const expired = new Date(data.expiresAt).getTime() < Date.now();
  return {
    status:          expired ? 'stale' : 'ready',
    generatedAt:     data.generatedAt,
    expiresAt:       data.expiresAt,
    projectCount:    data.projectCount    || 0,
    failedPipelines: data.failedPipelines || 0,
  };
}

// ── Violation fetch job ───────────────────────────────────────────────────────
const JOB_TIMEOUT_MS = 30 * 60_000; // 30-minute watchdog

async function runJob() {
  if (jobRunning) {
    log('info', 'Job already running — skipping duplicate trigger');
    return;
  }

  // Re-read .env immediately before the job so any key/URL update is picked up.
  const { apiUrl, apiKey } = getEffectiveConfig();
  log('info', 'Effective config for this run', {
    apiUrl,
    apiKey: apiKey ? `***${apiKey.slice(-4)}` : 'NOT SET',
  });

  if (!apiKey) {
    log('error', 'DT_API_KEY not set — cannot fetch violations');
    return;
  }

  jobRunning  = true;
  jobProgress = { pagesDone: 0, pagesTotal: 0, failedPipelines: 0 };
  log('info', 'Violation fetch job started');

  let jobTimedOut = false;
  const watchdog  = setTimeout(() => {
    jobTimedOut = true;
    jobRunning  = false;
    log('error', 'Job watchdog fired — force-resetting state', {
      timeoutMin: JOB_TIMEOUT_MS / 60_000,
      progress:   `${jobProgress.pagesDone}/${jobProgress.pagesTotal}`,
    });
  }, JOB_TIMEOUT_MS);

  const map    = {};
  const emptyV = () => ({ fail: 0, warn: 0, info: 0, unassigned: 0 });

  const pipelines = RISK_TYPES.flatMap(rt => STATES.map(st => ({ rt, st })));

  // ── Phase 1: Discover total page counts (P2) ──────────────────────────────
  // Run all 9 page-1 fetches in parallel first so pagesTotal is accurate
  // from the start and the progress indicator doesn't undercount early on.
  const phase1 = await Promise.all(
    pipelines.map(async ({ rt, st }) => {
      const label   = `${rt}/${st}`;
      const baseUrl = `/api/v1/violation?riskType=${rt}&violationState=${st}&pageSize=${PAGE_SIZE}`;
      try {
        log('info', `Pipeline ${label}: fetching page 1`);
        const r1         = await dtGetWithRetry(`${baseUrl}&pageNumber=1`, apiUrl, apiKey);
        const totalCount = parseInt(r1.headers['x-total-count'] || '0', 10);
        const totalPages = totalCount > 0 ? Math.ceil(totalCount / PAGE_SIZE) : 1;
        log('info', `Pipeline ${label}: ${totalCount} violations across ${totalPages} page(s)`);
        return { rt, st, r1, totalCount, totalPages, baseUrl, failed: false };
      } catch (err) {
        log('error', `Pipeline ${label} failed on page 1`, { error: err.message });
        jobProgress.failedPipelines++;
        return { rt, st, failed: true };
      }
    })
  );

  // Set accurate total now that all page counts are known
  jobProgress.pagesTotal = phase1.reduce((sum, p) => sum + (p.failed ? 0 : p.totalPages), 0);
  log('info', `Discovery complete — ${jobProgress.pagesTotal} total pages across ${pipelines.length} pipelines`);

  // Apply page-1 data
  for (const p of phase1) {
    if (p.failed) continue;
    const ck    = CAT[p.rt];
    const sk    = SEV[p.st];
    const items = Array.isArray(p.r1.json) ? p.r1.json : (p.r1.json.violations || []);
    items.forEach(v => {
      const uuid = v.project?.uuid; if (!uuid) return;
      if (!map[uuid]) map[uuid] = { ops: emptyV(), lic: emptyV(), secpolicy: emptyV() };
      map[uuid][ck][sk]++;
    });
    jobProgress.pagesDone++;
  }

  // ── Phase 2: Fetch remaining pages (page 2+) ──────────────────────────────
  await Promise.all(
    phase1
      .filter(p => !p.failed && p.totalPages > 1)
      .map(async ({ rt, st, totalPages, baseUrl }) => {
        const label = `${rt}/${st}`;
        const ck    = CAT[rt];
        const sk    = SEV[st];
        try {
          for (let page = 2; page <= totalPages; page++) {
            if (jobTimedOut) {
              log('warn', `Pipeline ${label}: aborting at page ${page} — job timed out`);
              throw new Error('Job timed out');
            }
            log('info', `Pipeline ${label}: fetching page ${page}/${totalPages}`);
            const r = await dtGetWithRetry(`${baseUrl}&pageNumber=${page}`, apiUrl, apiKey);
            const items = Array.isArray(r.json) ? r.json : (r.json.violations || []);
            items.forEach(v => {
              const uuid = v.project?.uuid; if (!uuid) return;
              if (!map[uuid]) map[uuid] = { ops: emptyV(), lic: emptyV(), secpolicy: emptyV() };
              map[uuid][ck][sk]++;
            });
            jobProgress.pagesDone++;
          }
          log('info', `Pipeline ${label}: done`);
        } catch (err) {
          log('error', `Pipeline ${label} failed fetching pages 2+`, { error: err.message });
          jobProgress.failedPipelines++;
        }
      })
  );

  try {
    if (jobTimedOut) return;

    const now       = new Date();
    const cacheData = {
      generatedAt:     now.toISOString(),
      expiresAt:       new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
      projectCount:    Object.keys(map).length,
      failedPipelines: jobProgress.failedPipelines,
      map,
    };

    writeCacheFile(cacheData);
    log('info', 'Job complete', {
      projects:        cacheData.projectCount,
      failedPipelines: cacheData.failedPipelines,
      expiresAt:       cacheData.expiresAt,
    });
  } catch (e) {
    log('error', `Failed to write cache file: ${e.message}`);
  } finally {
    clearTimeout(watchdog);
    if (!jobTimedOut) jobRunning = false;
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function jsonReply(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control':  'no-store',
  });
  res.end(payload);
}

/** Read the full request body as a string (max 64 KB). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const MAX = 64 * 1024;
    let data = '', bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX) { req.destroy(); reject(new Error('Request body too large')); return; }
      data += chunk;
    });
    req.on('end',   () => resolve(data));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    res.end();
    return;
  }

  const { method, url } = req;

  // ── GET /violation-cache/status ───────────────────────────────────────────
  if (method === 'GET' && url === '/violation-cache/status') {
    jsonReply(res, 200, getStatus());
    return;
  }

  // ── GET /violation-cache/data ─────────────────────────────────────────────
  if (method === 'GET' && url === '/violation-cache/data') {
    if (!fs.existsSync(CACHE_FILE)) {
      jsonReply(res, 404, { error: 'No cache available' });
      return;
    }
    try {
      const raw = fs.readFileSync(CACHE_FILE);
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
    return;
  }

  // ── POST /violation-cache/config ──────────────────────────────────────────
  // Accepts { apiKey } and persists it to the bind-mounted .env file so the
  // next job run uses the updated key without a container restart.
  if (method === 'POST' && url === '/violation-cache/config') {
    try {
      const raw  = await readBody(req);
      const body = JSON.parse(raw);

      if (!body.apiKey || typeof body.apiKey !== 'string') {
        jsonReply(res, 400, { error: 'apiKey is required' });
        return;
      }
      const cleanKey = body.apiKey.replace(/[\x00-\x1F\x7F]/g, '').trim();
      if (!cleanKey) {
        jsonReply(res, 400, { error: 'apiKey is empty after sanitisation' });
        return;
      }
      if (!fs.existsSync(ENV_FILE)) {
        jsonReply(res, 503, {
          error: `Config file not found at ${ENV_FILE}. Ensure .env is bind-mounted.`,
        });
        return;
      }

      // Q8: handle read and write errors separately
      patchEnvFile(ENV_FILE, { DT_API_KEY: cleanKey });
      log('info', `DT_API_KEY updated in ${ENV_FILE}`, { key: `***${cleanKey.slice(-4)}` });
      jsonReply(res, 200, { ok: true, message: 'API key updated; takes effect on next job run' });

    } catch (e) {
      if (e.code === 'PATCH_READ_FAILED') {
        log('error', `Config update failed — could not read .env: ${e.message}`);
        jsonReply(res, 500, { error: 'Could not read configuration file — check file permissions' });
      } else if (e.code === 'PATCH_WRITE_FAILED') {
        log('error', `Config update failed — could not write .env: ${e.message}`);
        jsonReply(res, 500, { error: 'Could not write configuration file — check file permissions' });
      } else {
        log('error', `Config update error: ${e.message}`);
        jsonReply(res, 500, { error: e.message });
      }
    }
    return;
  }

  // ── POST /violation-cache/refresh ─────────────────────────────────────────
  if (method === 'POST' && url === '/violation-cache/refresh') {
    const { apiKey } = getEffectiveConfig();
    if (!apiKey) {
      jsonReply(res, 503, { error: 'DT_API_KEY not configured on the cache service' });
      return;
    }
    if (jobRunning) {
      jsonReply(res, 409, { status: 'building', message: 'Job already running' });
      return;
    }
    runJob().catch(err => log('error', `Unhandled job error: ${err.message}`));
    jsonReply(res, 202, { status: 'building', message: 'Job started' });
    return;
  }

  res.writeHead(404);
  res.end('Not found');

}).listen(PORT, () => {
  const { apiUrl, apiKey } = getEffectiveConfig();
  log('info', `Violation cache service listening on :${PORT}`);
  log('info', 'Startup configuration', {
    apiUrl,
    apiKey:       apiKey ? `***${apiKey.slice(-4)}` : 'NOT SET',
    cacheTtlHrs:  CACHE_TTL_MS / 3_600_000,
    cacheFile:    CACHE_FILE,
    envFile:      `${ENV_FILE} (${fs.existsSync(ENV_FILE) ? 'mounted ✓' : 'NOT FOUND — config endpoint disabled'})`,
    logFormat:    LOG_JSON ? 'json' : 'text',
  });

  const s = getStatus();
  if (s.status === 'none' || s.status === 'stale') {
    log('info', `Auto-triggering cache build (status: ${s.status})`);
    runJob().catch(err => log('error', `Startup job error: ${err.message}`));
  } else {
    log('info', `Cache status on startup: ${s.status}`);
  }
});
