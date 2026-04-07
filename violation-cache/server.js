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

/** Parse a .env file and return a plain key→value object. */
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
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

/** Write a single key=value update into the .env file, preserving all other lines. */
function patchEnvFile(filePath, updates) {
  let lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split('\n') : [];
  const remaining = new Set(Object.keys(updates));

  lines = lines.map(line => {
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) return line;
    const key = line.slice(0, eqIdx).trim();
    if (key in updates) {
      remaining.delete(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  // Append any keys that weren't already in the file
  for (const key of remaining) {
    lines.push(`${key}=${updates[key]}`);
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

/**
 * Read the effective DT_API_URL and DT_API_KEY.
 * Priority: .env file (if mounted and readable) > Docker Compose env vars (startup values).
 * This means changes written to .env via the config endpoint are picked up on the next job.
 */
function getEffectiveConfig() {
  const envVars = parseEnvFile(ENV_FILE);

  const rawUrl = envVars['DT_API_INTERNAL_URL'] || STARTUP_API_URL;
  const apiUrl = rawUrl.replace(/\/$/, '');

  const rawKey = envVars['DT_API_KEY'] || STARTUP_API_KEY;
  const apiKey = rawKey.replace(/[\x00-\x1F\x7F]/g, '').trim();

  return { apiUrl, apiKey };
}

// ── Fetch parameters ──────────────────────────────────────────────────────────
const PAGE_SIZE   = 100;
const RISK_TYPES  = ['OPERATIONAL', 'LICENSE', 'SECURITY'];
const STATES      = ['FAIL', 'WARN', 'INFO'];
const CAT         = { OPERATIONAL: 'ops', LICENSE: 'lic', SECURITY: 'secpolicy' };
const SEV         = { FAIL: 'fail', WARN: 'warn', INFO: 'info' };

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
    const mod     = fullUrl.startsWith('https') ? https : http;
    const req     = mod.request(fullUrl, {
      method:             'GET',
      headers:            { 'X-Api-Key': apiKey, Accept: 'application/json' },
      rejectUnauthorized: false,
    }, (res) => {
      // Timeout on the response body stream — catches servers that send headers
      // then stall before sending the body.
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
      console.warn(
        `[cache] Retry ${attempt + 1}/${MAX_RETRIES - 1} for ${urlPath} ` +
        `after ${delay}ms: ${err.message}`
      );
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
    console.error('[cache] Failed to read cache file:', e.message);
    return null;
  }
}

function writeCacheFile(data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_TMP, JSON.stringify(data));
  fs.renameSync(CACHE_TMP, CACHE_FILE);  // atomic on POSIX
}

function getStatus() {
  if (jobRunning) {
    return {
      status:   'building',
      progress: {
        pagesDone:  jobProgress.pagesDone,
        pagesTotal: jobProgress.pagesTotal,
      },
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
    console.log('[cache] Job already running — skipping duplicate trigger');
    return;
  }

  // Re-read .env immediately before the job so any key/URL update is picked up.
  const { apiUrl, apiKey } = getEffectiveConfig();
  console.log(`[cache] Effective DT_API_URL : ${apiUrl}`);
  console.log(`[cache] Effective DT_API_KEY : ${apiKey ? '***' + apiKey.slice(-4) : 'NOT SET'}`);

  if (!apiKey) {
    console.error('[cache] DT_API_KEY not set — cannot fetch violations');
    return;
  }

  jobRunning  = true;
  jobProgress = { pagesDone: 0, pagesTotal: 0, failedPipelines: 0 };
  console.log('[cache] Violation fetch job started');

  let jobTimedOut = false;
  const watchdog  = setTimeout(() => {
    jobTimedOut = true;
    jobRunning  = false;
    console.error(
      `[cache] Job watchdog fired after ${JOB_TIMEOUT_MS / 60_000} min — ` +
      `force-resetting state (progress was ${jobProgress.pagesDone}/${jobProgress.pagesTotal})`
    );
  }, JOB_TIMEOUT_MS);

  const map    = {};
  const emptyV = () => ({ fail: 0, warn: 0, info: 0, unassigned: 0 });

  async function runPipeline(riskType, state) {
    const ck      = CAT[riskType];
    const sk      = SEV[state];
    const label   = `${riskType}/${state}`;
    const baseUrl =
      `/api/v1/violation?riskType=${riskType}&violationState=${state}` +
      `&pageSize=${PAGE_SIZE}`;

    console.log(`[cache] Pipeline ${label}: fetching page 1`);
    const r1         = await dtGetWithRetry(`${baseUrl}&pageNumber=1`, apiUrl, apiKey);
    const totalCount = parseInt(r1.headers['x-total-count'] || '0', 10);
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / PAGE_SIZE) : 1;

    jobProgress.pagesTotal += totalPages;
    console.log(`[cache] Pipeline ${label}: ${totalCount} violations, ${totalPages} page(s)`);

    const items1 = Array.isArray(r1.json) ? r1.json : (r1.json.violations || []);
    items1.forEach(v => {
      const uuid = v.project?.uuid; if (!uuid) return;
      if (!map[uuid]) map[uuid] = { ops: emptyV(), lic: emptyV(), secpolicy: emptyV() };
      map[uuid][ck][sk]++;
    });
    jobProgress.pagesDone++;

    for (let page = 2; page <= totalPages; page++) {
      if (jobTimedOut) {
        console.warn(`[cache] Pipeline ${label}: aborting at page ${page} — job timed out`);
        throw new Error('Job timed out');
      }
      console.log(`[cache] Pipeline ${label}: fetching page ${page}/${totalPages}`);
      const r = await dtGetWithRetry(`${baseUrl}&pageNumber=${page}`, apiUrl, apiKey);
      const items = Array.isArray(r.json) ? r.json : (r.json.violations || []);
      items.forEach(v => {
        const uuid = v.project?.uuid; if (!uuid) return;
        if (!map[uuid]) map[uuid] = { ops: emptyV(), lic: emptyV(), secpolicy: emptyV() };
        map[uuid][ck][sk]++;
      });
      jobProgress.pagesDone++;
    }

    console.log(`[cache] Pipeline ${label}: done (${totalPages} page(s) fetched)`);
  }

  try {
    await Promise.all(
      RISK_TYPES.flatMap(rt => STATES.map(st =>
        runPipeline(rt, st).catch(err => {
          console.error(`[cache] Pipeline ${rt}/${st} failed: ${err.message}`);
          jobProgress.failedPipelines++;
        })
      ))
    );

    if (jobTimedOut) return;

    const now       = new Date();
    const cacheData = {
      generatedAt:     now.toISOString(),
      expiresAt:       new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
      projectCount:    Object.keys(map).length,
      failedPipelines: jobProgress.failedPipelines,
      map,
    };

    try {
      writeCacheFile(cacheData);
      console.log(
        `[cache] Job complete — ${cacheData.projectCount} projects with violations, ` +
        `${cacheData.failedPipelines} failed pipeline(s), expires ${cacheData.expiresAt}`
      );
    } catch (e) {
      console.error('[cache] Failed to write cache file:', e.message);
    }
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

/** Read the full request body as a string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  () => resolve(data));
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
      jsonReply(res, 500, { error: e.message });
    }
    return;
  }

  // ── POST /violation-cache/config ──────────────────────────────────────────
  // Accepts { apiKey } and writes it to the bind-mounted .env file so the
  // next job run picks up the updated key without a container restart.
  // The API URL is intentionally excluded — it is a server-admin concern
  // (Docker-internal URL) and must not be overwritten with a browser URL.
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
        jsonReply(res, 400, { error: 'apiKey must not be empty after sanitisation' });
        return;
      }

      if (!fs.existsSync(ENV_FILE)) {
        jsonReply(res, 503, {
          error: `Config file not found at ${ENV_FILE}. ` +
                 'Ensure .env is bind-mounted into the container.'
        });
        return;
      }

      patchEnvFile(ENV_FILE, { DT_API_KEY: cleanKey });
      console.log(`[cache] DT_API_KEY updated in ${ENV_FILE} (***${cleanKey.slice(-4)})`);
      jsonReply(res, 200, { ok: true, message: 'API key updated; will take effect on next job run' });
    } catch (e) {
      console.error('[cache] Config update error:', e.message);
      jsonReply(res, 500, { error: e.message });
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
    runJob().catch(err => console.error('[cache] Unhandled job error:', err.message));
    jsonReply(res, 202, { status: 'building', message: 'Job started' });
    return;
  }

  res.writeHead(404);
  res.end('Not found');

}).listen(PORT, () => {
  const { apiUrl, apiKey } = getEffectiveConfig();
  console.log(`[cache] Violation cache service listening on :${PORT}`);
  console.log(`[cache] DT_API_URL      : ${apiUrl}`);
  console.log(`[cache] DT_API_KEY      : ${apiKey ? '***' + apiKey.slice(-4) : 'NOT SET'}`);
  console.log(`[cache] CACHE_TTL_HOURS : ${CACHE_TTL_MS / 3_600_000}`);
  console.log(`[cache] CACHE_FILE      : ${CACHE_FILE}`);
  console.log(`[cache] ENV_FILE        : ${ENV_FILE} (${fs.existsSync(ENV_FILE) ? 'mounted ✓' : 'NOT FOUND — config endpoint disabled'})`);

  const s = getStatus();
  if (s.status === 'none' || s.status === 'stale') {
    console.log(`[cache] Auto-triggering initial cache build (status: ${s.status})`);
    runJob().catch(err => console.error('[cache] Startup job error:', err.message));
  } else {
    console.log(`[cache] Cache status on startup: ${s.status}`);
  }
});

