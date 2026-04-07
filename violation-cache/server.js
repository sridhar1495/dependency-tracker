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
//
// Status values:
//   none      — no cache file exists yet
//   building  — job is currently running
//   ready     — file exists and TTL has not expired
//   stale     — file exists but TTL has expired
//   no-key    — DT_API_KEY env var is not set; cannot fetch

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT         || '3001',  10);
const DT_API_URL   = (process.env.DT_API_URL || 'http://localhost:8080').replace(/\/$/, '');
// Strip any control characters (newlines, carriage returns, tabs) that may be
// introduced by copy-paste or Windows line endings in the .env file.
const DT_API_KEY   = (process.env.DT_API_KEY || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_HOURS || '24', 10) * 3_600_000;
const CACHE_DIR    = process.env.CACHE_DIR   || '/data';
const CACHE_FILE   = path.join(CACHE_DIR, 'violation-cache.json');
const CACHE_TMP    = path.join(CACHE_DIR, 'violation-cache.tmp.json');

// ── Fetch parameters ──────────────────────────────────────────────────────────
const PAGE_SIZE   = 100;
const RISK_TYPES  = ['OPERATIONAL', 'LICENSE', 'SECURITY'];
const STATES      = ['FAIL', 'WARN', 'INFO'];
const CAT         = { OPERATIONAL: 'ops', LICENSE: 'lic', SECURITY: 'secpolicy' };
const SEV         = { FAIL: 'fail', WARN: 'warn', INFO: 'info' };

// ── Retry config ──────────────────────────────────────────────────────────────
const MAX_RETRIES    = 3;           // total attempts per page (1 initial + 2 retries)
const RETRY_DELAYS   = [2000, 4000, 8000]; // ms between attempts

// ── In-memory job state ────────────────────────────────────────────────────────
let jobRunning = false;
let jobProgress = { pagesDone: 0, pagesTotal: 0, failedPipelines: 0 };

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Perform a GET request to the DT API and return parsed JSON + response headers. */
function dtGet(urlPath) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${DT_API_URL}${urlPath}`;
    const mod     = fullUrl.startsWith('https') ? https : http;
    const req     = mod.request(fullUrl, {
      method:              'GET',
      headers:             { 'X-Api-Key': DT_API_KEY, Accept: 'application/json' },
      rejectUnauthorized:  false,
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
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
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('Request timeout')));
    req.end();
  });
}

/** dtGet with per-page exponential-backoff retry. */
async function dtGetWithRetry(urlPath, attempt = 0) {
  try {
    return await dtGet(urlPath);
  } catch (err) {
    if (attempt < MAX_RETRIES - 1) {
      const delay = RETRY_DELAYS[attempt];
      console.warn(
        `[cache] Retry ${attempt + 1}/${MAX_RETRIES - 1} for ${urlPath} ` +
        `after ${delay}ms: ${err.message}`
      );
      await sleep(delay);
      return dtGetWithRetry(urlPath, attempt + 1);
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
  if (!DT_API_KEY) return { status: 'no-key' };
  const data = readCacheFile();
  if (!data) return { status: 'none' };
  const expired = new Date(data.expiresAt).getTime() < Date.now();
  return {
    status:         expired ? 'stale' : 'ready',
    generatedAt:    data.generatedAt,
    expiresAt:      data.expiresAt,
    projectCount:   data.projectCount   || 0,
    failedPipelines: data.failedPipelines || 0,
  };
}

// ── Violation fetch job ───────────────────────────────────────────────────────
async function runJob() {
  if (jobRunning) {
    console.log('[cache] Job already running — skipping duplicate trigger');
    return;
  }
  if (!DT_API_KEY) {
    console.error('[cache] DT_API_KEY not set — cannot fetch violations');
    return;
  }

  jobRunning  = true;
  jobProgress = { pagesDone: 0, pagesTotal: 0, failedPipelines: 0 };
  console.log('[cache] Violation fetch job started');

  const map    = {};           // { uuid: { ops, lic, secpolicy } }
  const emptyV = () => ({ fail: 0, warn: 0, info: 0, unassigned: 0 });

  /** Fetch all pages for one riskType × violationState combination. */
  async function runPipeline(riskType, state) {
    const ck      = CAT[riskType];
    const sk      = SEV[state];
    const baseUrl =
      `/api/v1/violation?riskType=${riskType}&violationState=${state}` +
      `&pageSize=${PAGE_SIZE}`;

    // Page 1 — discover total count
    const r1         = await dtGetWithRetry(`${baseUrl}&pageNumber=1`);
    const totalCount = parseInt(r1.headers['x-total-count'] || '0', 10);
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / PAGE_SIZE) : 1;

    jobProgress.pagesTotal += totalPages;   // running total; becomes exact after all p1s

    const items1 = Array.isArray(r1.json) ? r1.json : (r1.json.violations || []);
    items1.forEach(v => {
      const uuid = v.project?.uuid; if (!uuid) return;
      if (!map[uuid]) map[uuid] = { ops: emptyV(), lic: emptyV(), secpolicy: emptyV() };
      map[uuid][ck][sk]++;
    });
    jobProgress.pagesDone++;

    // Remaining pages — sequential within this pipeline, each with retry
    for (let page = 2; page <= totalPages; page++) {
      const r = await dtGetWithRetry(`${baseUrl}&pageNumber=${page}`);
      const items = Array.isArray(r.json) ? r.json : (r.json.violations || []);
      items.forEach(v => {
        const uuid = v.project?.uuid; if (!uuid) return;
        if (!map[uuid]) map[uuid] = { ops: emptyV(), lic: emptyV(), secpolicy: emptyV() };
        map[uuid][ck][sk]++;
      });
      jobProgress.pagesDone++;
    }
  }

  // Launch all 9 pipelines simultaneously; individual pipeline errors are non-fatal
  await Promise.all(
    RISK_TYPES.flatMap(rt => STATES.map(st =>
      runPipeline(rt, st).catch(err => {
        console.error(`[cache] Pipeline ${rt}/${st} failed after retries: ${err.message}`);
        jobProgress.failedPipelines++;
      })
    ))
  );

  const now      = new Date();
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
      `${cacheData.failedPipelines} failed pipeline(s), ` +
      `expires ${cacheData.expiresAt}`
    );
  } catch (e) {
    console.error('[cache] Failed to write cache file:', e.message);
  }

  jobRunning = false;
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

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Pre-flight
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

  // ── POST /violation-cache/refresh ─────────────────────────────────────────
  if (method === 'POST' && url === '/violation-cache/refresh') {
    if (!DT_API_KEY) {
      jsonReply(res, 503, { error: 'DT_API_KEY not configured on the cache service' });
      return;
    }
    if (jobRunning) {
      jsonReply(res, 409, { status: 'building', message: 'Job already running' });
      return;
    }
    // Fire-and-forget — errors are logged by runJob
    runJob().catch(err => console.error('[cache] Unhandled job error:', err.message));
    jsonReply(res, 202, { status: 'building', message: 'Job started' });
    return;
  }

  res.writeHead(404);
  res.end('Not found');

}).listen(PORT, () => {
  console.log(`[cache] Violation cache service listening on :${PORT}`);
  console.log(`[cache] DT_API_URL      : ${DT_API_URL}`);
  console.log(`[cache] DT_API_KEY      : ${DT_API_KEY ? '***' + DT_API_KEY.slice(-4) : 'NOT SET'}`);
  console.log(`[cache] CACHE_TTL_HOURS : ${CACHE_TTL_MS / 3_600_000}`);
  console.log(`[cache] CACHE_FILE      : ${CACHE_FILE}`);

  // Auto-trigger on startup when no valid (non-stale) cache exists
  const s = getStatus();
  if (s.status === 'none' || s.status === 'stale') {
    console.log(`[cache] Auto-triggering initial cache build (status: ${s.status})`);
    runJob().catch(err => console.error('[cache] Startup job error:', err.message));
  } else {
    console.log(`[cache] Cache status on startup: ${s.status}`);
  }
});
