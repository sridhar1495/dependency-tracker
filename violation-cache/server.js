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
//   GET    /violation-cache/status              — current state + build progress
//   GET    /violation-cache/data                — the cached map (only when ready/stale)
//   GET    /violation-cache/config              — current effective API key (redacted) + whether .env is mounted
//   POST   /violation-cache/refresh             — trigger a background rebuild
//   POST   /violation-cache/config              — update DT_API_KEY in .env (persists across restarts)
//   POST   /violation-cache/report/generate     — start a vulnerability Excel report job
//   GET    /violation-cache/report/list         — list all report jobs with status
//   DELETE /violation-cache/report/:id          — delete a report job + file
//   GET    /violation-cache/report/:id/download — stream the completed Excel file
//   POST   /violation-cache/report/:id/cancel   — cancel a running report job
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

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const ExcelJS    = require('exceljs');    // MIT-licensed Excel generation library
const nodemailer = require('nodemailer'); // Q9: MIT-licensed SMTP email library (approved exception to no-new-packages rule)

// ── Static config (set once at startup, never change at runtime) ──────────────
const PORT         = parseInt(process.env.PORT || '3001', 10);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_HOURS || '24', 10) * 3_600_000;
const CACHE_DIR    = process.env.CACHE_DIR || '/data';
const CACHE_FILE   = path.join(CACHE_DIR, 'violation-cache.json');
const CACHE_TMP    = path.join(CACHE_DIR, 'violation-cache.tmp.json');
// Path to the bind-mounted .env file — writable so the config endpoint can persist changes.
const ENV_FILE     = process.env.ENV_FILE || '/app/.env';
// User-configurable settings persist in app-config.json (separate from DT connection .env)
const CONFIG_FILE  = path.join(CACHE_DIR, 'app-config.json');
const CONFIG_TMP   = path.join(CACHE_DIR, 'app-config.tmp.json');
// Scheduled report files live here and are deleted after each successful email send
const SCHED_DIR    = path.join(CACHE_DIR, 'scheduled-reports');

// ── Report generation config ──────────────────────────────────────────────────
// Static constants — edit here to change behaviour; no env-var override needed.
const REPORT_DIR         = path.join(CACHE_DIR, 'reports');
const REPORT_REGISTRY    = path.join(REPORT_DIR, 'registry.json');
const REPORT_TMP         = path.join(REPORT_DIR, 'registry.tmp.json');
const REPORT_TIMEOUT_MS  = 30 * 60_000;  // 30 min hard limit per job
const FINDINGS_PAGE_SIZE    = 300;  // DT API page size for findings
const VIOLATIONS_PAGE_SIZE  = 300;  // DT API page size for violation queries
const REPORT_CONCURRENCY    = 5;    // projects fetched in parallel for security
const VIOLATION_CONCURRENCY = 3;    // max concurrent violation fetches (license+operational)
const DEFAULT_MAX_REPORTS   = 10;   // default combined completed + running ceiling (overridden by app config)
const VALID_RISK_TYPES      = new Set(['security', 'license', 'operational']);

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

// ── App config helpers ────────────────────────────────────────────────────────
// All user-configurable settings (max downloads, email, schedule) persist in
// /data/app-config.json.  Loaded fresh before each operation so UI changes take
// effect without a service restart.

const DEFAULT_CONFIG = {
  maxReports: 10,
  mail: {
    enabled: false,
    smtp:    { host: '', port: 587, secure: false, user: '', pass: '' },
    from:    '',
    to:      [],
    cc:      [],
    subject: '',
    body:    '',
  },
  schedule: {
    enabled:             false,
    frequency:           'daily',  // 'daily' | 'weekly' | 'monthly'
    hour:                9,
    weekDays:            [1],      // 0=Sun..6=Sat; used for 'weekly'
    monthDay:            1,        // 1-28; used for 'monthly'
    projectUuids:        [],
    riskTypes:           ['security', 'license', 'operational'],
    lastRun:             null,     // ISO8601 — updated after each run
    lastRunStatus:       null,     // 'success' | 'failed'
    lastRunError:        null,
    nextRun:             null,     // ISO8601 — set when scheduler is armed
    failureNotification: null,     // human-readable message; cleared when frontend ACKs
  },
};

function deepMerge(target, source) {
  const out = JSON.parse(JSON.stringify(target));
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = out[key];
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)
        && tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return deepMerge(DEFAULT_CONFIG, raw);
    }
  } catch (e) {
    log('warn', `Could not load app config, using defaults: ${e.message}`);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_TMP, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(CONFIG_TMP, CONFIG_FILE);
  } catch (e) {
    log('error', `Failed to save app config: ${e.message}`);
  }
}

/** Dynamic max-reports limit — re-read from config so UI changes apply immediately. */
function getMaxReports() {
  const n = loadConfig().maxReports;
  return (typeof n === 'number' && n > 0) ? n : DEFAULT_MAX_REPORTS;
}

/**
 * Return a sanitised copy of config safe to send to the browser.
 * The SMTP password is masked; all other fields are returned as-is.
 */
function sanitiseConfigForClient(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (out.mail && out.mail.smtp) {
    // O4: never expose credentials — indicate presence with a mask
    out.mail.smtp.pass = out.mail.smtp.pass ? '••••••••' : '';
  }
  return out;
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

/** Read the full request body as a string (default max 64 KB; pass maxBytes to override). */
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

// ── Report job registry ───────────────────────────────────────────────────────
// In-memory Map; loaded from REPORT_REGISTRY on startup and saved atomically
// after every status transition.
//
// Job shape stored in registry file (cancelFlag is runtime-only, not persisted):
//   { id, status, filename, error, progress:{done,total}, createdAt, updatedAt }

const reportJobs = new Map(); // id → full job object (includes runtime cancelFlag)

function saveRegistry() {
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const entries = [];
    for (const job of reportJobs.values()) {
      // Omit runtime-only fields before persisting
      const { cancelFlag, watchdogId, ...persisted } = job; // eslint-disable-line no-unused-vars
      entries.push(persisted);
    }
    fs.writeFileSync(REPORT_TMP, JSON.stringify(entries, null, 2), 'utf8');
    fs.renameSync(REPORT_TMP, REPORT_REGISTRY);
  } catch (e) {
    log('error', `Failed to save report registry: ${e.message}`);
  }
}

function loadRegistry() {
  try {
    if (!fs.existsSync(REPORT_REGISTRY)) return;
    const entries = JSON.parse(fs.readFileSync(REPORT_REGISTRY, 'utf8'));
    for (const entry of entries) {
      // Jobs that were 'running' when the service stopped cannot be resumed —
      // mark them failed so the user knows what happened.
      if (entry.status === 'running') {
        entry.status    = 'failed';
        entry.error     = 'Service restarted while this report was being generated.';
        entry.updatedAt = new Date().toISOString();
      }
      reportJobs.set(entry.id, { ...entry, cancelFlag: { cancelled: false } });
    }
    log('info', `Loaded ${reportJobs.size} report job(s) from registry`);
  } catch (e) {
    log('warn', `Could not load report registry (starting fresh): ${e.message}`);
  }
}

// ── Semaphore helper (limits concurrent async tasks) ─────────────────────────
function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return function acquire(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve().then(fn).then(
          v => { active--; if (queue.length) queue.shift()(); resolve(v); },
          e => { active--; if (queue.length) queue.shift()(); reject(e); }
        );
      };
      if (active < limit) run();
      else queue.push(run);
    });
  };
}

// ── Shared report data collector ─────────────────────────────────────────────
/**
 * Fetch security findings, license violations, and operational violations for
 * a list of projects.  Shared between runReportJob (registry-tracked) and
 * runScheduledJob (fire-and-email).
 *
 * @param {string}   apiUrl
 * @param {string}   apiKey
 * @param {Array}    projects    — [{ uuid, name, version }]
 * @param {string[]} riskTypes   — subset of ['security','license','operational']
 * @param {{ cancelled: boolean }} cancelFlag
 * @param {Function} [onProgress]  — called with (riskType) after each project finishes that category
 * @returns {Promise<object>} collected data maps
 */
async function collectReportData(apiUrl, apiKey, projects, riskTypes, cancelFlag, onProgress) {
  const semaphore     = makeSemaphore(REPORT_CONCURRENCY);
  const violationSema = makeSemaphore(VIOLATION_CONCURRENCY);

  const secFindings       = [];
  const secProjectSummary = new Map();
  const secComponentMap   = new Map();
  const licViolations     = [];
  const licProjectSummary = new Map();
  const opsViolations     = [];
  const opsProjectSummary = new Map();

  const tasks = projects.map(proj =>
    semaphore(async () => {
      if (cancelFlag.cancelled) return;

      await Promise.all([
        // ── Security findings ───────────────────────────────────────
        riskTypes.includes('security')
          ? (async () => {
              log('info', `[collect] Security findings for "${proj.name}" ${proj.version || ''}`);
              const findings = await fetchAllFindings(apiUrl, apiKey, proj.name, proj.version || '', cancelFlag);
              const sev = { critical: 0, high: 0, medium: 0, low: 0, unassigned: 0 };
              for (const f of findings) {
                secFindings.push(f);
                const s = (f.vulnerability?.severity || 'UNASSIGNED').toLowerCase();
                if (s in sev) sev[s]++; else sev.unassigned++;
                const c    = f.component || {};
                const cKey = [c.name, c.group].filter(Boolean).join('-');
                if (cKey) {
                  const entry = secComponentMap.get(cKey) || { count: 0, projects: new Set() };
                  entry.count++;
                  entry.projects.add(proj.name);
                  secComponentMap.set(cKey, entry);
                }
              }
              secProjectSummary.set(proj.uuid, { name: proj.name, version: proj.version, ...sev });
              if (onProgress) onProgress('security');
            })()
          : Promise.resolve(),

        // ── License violations ──────────────────────────────────────
        riskTypes.includes('license')
          ? violationSema(async () => {
              log('info', `[collect] License violations for "${proj.name}" ${proj.version || ''}`);
              const counts = { fail: 0, warn: 0, info: 0 };
              await streamViolationsForProject(apiUrl, apiKey, proj, 'license', cancelFlag, (v) => {
                const c   = v.component       || {};
                const pc  = v.policyCondition || {};
                const pol = pc.policy         || {};
                const state = (pol.violationState || 'INFO').toUpperCase();
                licViolations.push({
                  projName:    proj.name,
                  projVersion: proj.version || '',
                  component:   [c.name, c.group].filter(Boolean).join('-') || c.name || '',
                  compVersion: c.version                         || '',
                  licenseName: c.resolvedLicense?.name           || '',
                  licenseId:   c.resolvedLicense?.licenseId      || '',
                  license:     pc.value                          || '',
                  policy:      pol.name                          || '',
                  state,
                });
                const stLower = state.toLowerCase();
                if (stLower in counts) counts[stLower]++;
              });
              licProjectSummary.set(proj.uuid, { name: proj.name, version: proj.version, ...counts });
              if (onProgress) onProgress('license');
            })
          : Promise.resolve(),

        // ── Operational violations ──────────────────────────────────
        riskTypes.includes('operational')
          ? violationSema(async () => {
              log('info', `[collect] Operational violations for "${proj.name}" ${proj.version || ''}`);
              const counts = { fail: 0, warn: 0, info: 0 };
              await streamViolationsForProject(apiUrl, apiKey, proj, 'operational', cancelFlag, (v) => {
                const c   = v.component       || {};
                const pc  = v.policyCondition || {};
                const pol = pc.policy         || {};
                const state = (pol.violationState || 'INFO').toUpperCase();
                opsViolations.push({
                  projName:    proj.name,
                  projVersion: proj.version || '',
                  component:   [c.name, c.group].filter(Boolean).join('-') || c.name || '',
                  compVersion: c.version  || '',
                  policy:      pol.name   || '',
                  subject:     pc.subject || '',
                  condition:   pc.value   || '',
                  state,
                });
                const stLower = state.toLowerCase();
                if (stLower in counts) counts[stLower]++;
              });
              opsProjectSummary.set(proj.uuid, { name: proj.name, version: proj.version, ...counts });
              if (onProgress) onProgress('operational');
            })
          : Promise.resolve(),
      ]);
    })
  );

  await Promise.all(tasks);

  if (cancelFlag.cancelled) {
    throw Object.assign(new Error('__CANCELLED__'), { isCancelled: true });
  }

  return {
    secFindings, secProjectSummary, secComponentMap,
    licViolations, licProjectSummary,
    opsViolations, opsProjectSummary,
  };
}

// ── Findings fetch helper ─────────────────────────────────────────────────────
/**
 * Fetch all finding pages from DependencyTrack for one project.
 * Uses the text-search API:
 *   /api/v1/finding?textSearchInput={name}%20{version}&severity=...
 * Paginates until X-Total-Count is satisfied or a short page is returned.
 * Checks cancelFlag before every page request.
 */
async function fetchAllFindings(apiUrl, apiKey, name, version, cancelFlag) {
  const baseQs = [
    'showInactive=false',
    'showSuppressed=false',
    'textSearchField=vulnerability_id,vulnerability_title,component_name,component_version,project_name',
    `textSearchInput=${encodeURIComponent(`${name} ${version}`)}`,
    'severity=critical,high,medium,low,unassigned',
    `pageSize=${FINDINGS_PAGE_SIZE}`,
  ].join('&');

  const all = [];
  let page = 1;
  while (true) {
    if (cancelFlag.cancelled) throw Object.assign(new Error('__CANCELLED__'), { isCancelled: true });
    const urlPath = `/api/v1/finding?${baseQs}&pageNumber=${page}`;
    log('info', `[report-fetch] GET ${apiUrl}${urlPath}`);
    const { json, headers } = await dtGetWithRetry(urlPath, apiUrl, apiKey);
    const batch = Array.isArray(json) ? json : [];
    all.push(...batch);
    const total = parseInt(headers['x-total-count'] || '0', 10);
    if ((total > 0 && all.length >= total) || batch.length < FINDINGS_PAGE_SIZE) break;
    page++;
  }
  return all;
}

// ── Per-project violation fetch helper ───────────────────────────────────────
/**
 * Stream all violation pages for one project and risk type, invoking onItem(v)
 * for each violation as it is received.  The raw DT objects are NOT accumulated
 * in an array — each page's objects are processed by the caller's callback and
 * then become eligible for GC before the next page is fetched.  This keeps
 * memory usage bounded to ~one page of raw objects at a time regardless of how
 * many total violations a project has.
 *
 * @param {Function} onItem  called synchronously for each violation object on a page
 * @returns {Promise<number>} total violation count processed
 */
async function streamViolationsForProject(apiUrl, apiKey, proj, riskType, cancelFlag, onItem) {
  const dtRiskType = riskType === 'license' ? 'LICENSE' : 'OPERATIONAL';
  // DT's project={uuid} filter is silently ignored on this version; instead use
  // project_name text search (same pattern as fetchAllFindings) and filter by
  // project UUID in-memory to exclude partial-name matches from other projects.
  const baseQs = [
    'showInactive=false',
    'suppressed=false',
    `riskType=${dtRiskType}`,
    'textSearchField=project_name',
    `textSearchInput=${encodeURIComponent(proj.name)}`,
    `pageSize=${VIOLATIONS_PAGE_SIZE}`,
  ].join('&');

  let processed = 0;
  let fetched   = 0;   // unfiltered count from API, used for pagination boundary
  let page = 1;
  while (true) {
    if (cancelFlag.cancelled) throw Object.assign(new Error('__CANCELLED__'), { isCancelled: true });
    const urlPath = `/api/v1/violation?${baseQs}&pageNumber=${page}`;
    log('info', `[report-fetch] GET ${apiUrl}${urlPath}`);
    const { json, headers } = await dtGetWithRetry(urlPath, apiUrl, apiKey);
    const batch = Array.isArray(json) ? json : (json?.violations || []);
    for (const v of batch) {
      // Only keep violations whose project UUID matches exactly — guards against
      // text-search returning partial-name matches from other projects.
      if (v.project?.uuid === proj.uuid) { onItem(v); processed++; }
    }
    fetched += batch.length;
    const total = parseInt(headers['x-total-count'] || '0', 10);
    if (batch.length < VIOLATIONS_PAGE_SIZE || (total > 0 && fetched >= total)) break;
    page++;
  }
  return processed;
}

// ── Excel report builder ──────────────────────────────────────────────────────
/**
 * Build a multi-sheet XLSX report and write it to filePath.
 * Sheets are added only for the risk types present in reportData.riskTypes:
 *
 *   security    → Vulnerability Findings, Security Project Summary, Component Summary
 *   license     → License Violations, License Project Summary
 *   operational → Operational Violations, Operational Project Summary
 *
 * @param {string} filePath
 * @param {{ riskTypes: string[],
 *           secFindings: object[], secProjectSummary: Map, secComponentMap: Map,
 *           licViolations: object[], licProjectSummary: Map,
 *           opsViolations: object[], opsProjectSummary: Map }} reportData
 */
async function buildExcelReport(filePath, reportData) {
  const {
    riskTypes,
    secFindings, secProjectSummary, secComponentMap,
    licViolations, licProjectSummary,
    opsViolations, opsProjectSummary,
  } = reportData;

  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Dependency-Track Risk Dashboard';
  wb.created  = new Date();
  wb.modified = new Date();

  function styleHeader(sheet) {
    const row = sheet.getRow(1);
    row.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF374151' } };
    row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    row.height    = 28;
    sheet.views   = [{ state: 'frozen', ySplit: 1 }];
  }

  function alternateShading(sheet) {
    sheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      if (rowNum % 2 === 0) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
        });
      }
    });
  }

  // ── Security sheets ───────────────────────────────────────────────────────
  if (riskTypes.includes('security')) {
    // Sheet: Vulnerability Findings
    const ws1 = wb.addWorksheet('SV_Vulnerability Findings');
    ws1.columns = [
      { header: 'S.No',            key: 'sno',        width: 6  },
      { header: 'Project Name',    key: 'projName',   width: 28 },
      { header: 'Project Version', key: 'projVer',    width: 14 },
      { header: 'Vulnerability',   key: 'vulnId',     width: 20 },
      { header: 'Severity',        key: 'severity',   width: 12 },
      { header: 'CWE',             key: 'cwe',        width: 22 },
      { header: 'Score',           key: 'score',      width: 8  },
      { header: 'Component',       key: 'component',  width: 36 },
      { header: 'Current Version', key: 'curVer',     width: 14 },
      { header: 'Latest Version',  key: 'latestVer',  width: 14 },
    ];
    styleHeader(ws1);
    secFindings.forEach((f, idx) => {
      const v    = f.vulnerability || {};
      const c    = f.component     || {};
      const cwes = (v.cwes || []).map(w => `CWE-${w.cweId}`).join(', ');
      const comp = [c.name, c.group].filter(Boolean).join('-');
      ws1.addRow({
        sno:       idx + 1,
        projName:  c.projectName    || '',
        projVer:   c.projectVersion || '',
        vulnId:    v.vulnId         || '',
        severity:  v.severity       || '',
        cwe:       cwes,
        score:     v.cvssV3BaseScore != null ? v.cvssV3BaseScore : '',
        component: comp,
        curVer:    c.version        || '',
        latestVer: c.latestVersion  || '',
      });
    });
    alternateShading(ws1);

    // Sheet: Security Project Summary
    const ws2 = wb.addWorksheet('SV_Project Summary');
    ws2.columns = [
      { header: 'S.No',            key: 'sno',        width: 6  },
      { header: 'Project Name',    key: 'projName',   width: 28 },
      { header: 'Project Version', key: 'projVer',    width: 14 },
      { header: 'Critical',        key: 'critical',   width: 10 },
      { header: 'High',            key: 'high',       width: 10 },
      { header: 'Medium',          key: 'medium',     width: 10 },
      { header: 'Low',             key: 'low',        width: 10 },
      { header: 'Unassigned',      key: 'unassigned', width: 12 },
    ];
    styleHeader(ws2);
    let sno2 = 1;
    for (const s of secProjectSummary.values()) {
      ws2.addRow({
        sno: sno2++, projName: s.name, projVer: s.version || '',
        critical: s.critical, high: s.high, medium: s.medium, low: s.low, unassigned: s.unassigned,
      });
    }

    // Sheet: Component Summary
    const ws3 = wb.addWorksheet('SV_Component Summary');
    ws3.columns = [
      { header: 'S.No',                key: 'sno',      width: 6  },
      { header: 'Component',           key: 'comp',     width: 40 },
      { header: 'Vulnerability Count', key: 'count',    width: 18 },
      { header: 'Affected Projects',   key: 'projects', width: 55 },
    ];
    styleHeader(ws3);
    let sno3 = 1;
    const sortedComps = [...secComponentMap.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [comp, entry] of sortedComps) {
      ws3.addRow({
        sno: sno3++, comp, count: entry.count,
        projects: [...entry.projects].sort().join(', '),
      });
    }
  }

  // ── License sheets ────────────────────────────────────────────────────────
  if (riskTypes.includes('license')) {
    // Sheet 1: License Violations (one row per violation)
    const wsL1 = wb.addWorksheet('LR_Violations');
    wsL1.columns = [
      { header: 'S.No',              key: 'sno',         width: 6  },
      { header: 'Project Name',      key: 'projName',    width: 28 },
      { header: 'Project Version',   key: 'projVer',     width: 14 },
      { header: 'Component',         key: 'component',   width: 36 },
      { header: 'Component Version', key: 'compVer',     width: 14 },
      { header: 'License Name',      key: 'licenseName', width: 34 },
      { header: 'License ID',        key: 'licenseId',   width: 24 },
      { header: 'Policy Condition',  key: 'license',     width: 30 },
      { header: 'Policy',            key: 'policy',      width: 30 },
      { header: 'State',             key: 'state',       width: 10 },
    ];
    styleHeader(wsL1);
    licViolations.forEach((v, idx) => {
      wsL1.addRow({
        sno:         idx + 1,
        projName:    v.projName,
        projVer:     v.projVersion,
        component:   v.component,
        compVer:     v.compVersion,
        licenseName: v.licenseName,
        licenseId:   v.licenseId,
        license:     v.license,
        policy:      v.policy,
        state:       v.state,
      });
    });
    alternateShading(wsL1);

    // Sheet 2: License Project Summary
    const wsL2 = wb.addWorksheet('LR_Project Summary');
    wsL2.columns = [
      { header: 'S.No',            key: 'sno',      width: 6  },
      { header: 'Project Name',    key: 'projName', width: 28 },
      { header: 'Project Version', key: 'projVer',  width: 14 },
      { header: 'Fail',            key: 'fail',     width: 10 },
      { header: 'Warn',            key: 'warn',     width: 10 },
      { header: 'Info',            key: 'info',     width: 10 },
    ];
    styleHeader(wsL2);
    let snoL = 1;
    for (const s of licProjectSummary.values()) {
      wsL2.addRow({ sno: snoL++, projName: s.name, projVer: s.version || '', fail: s.fail, warn: s.warn, info: s.info });
    }

    // Sheet 3: Unique License Risks — one row per unique component + component version.
    // Aggregates violation counts and affected projects across all fetched data.
    const compLicMap = new Map(); // key: "component||compVersion" → entry
    for (const v of licViolations) {
      const key = `${v.component}||${v.compVersion}`;
      if (!compLicMap.has(key)) {
        compLicMap.set(key, {
          component:   v.component,
          compVersion: v.compVersion,
          licenseName: v.licenseName,
          licenseId:   v.licenseId,
          fail: 0, warn: 0, info: 0,
          projects: new Set(),
        });
      }
      const entry = compLicMap.get(key);
      // Prefer non-empty licenseName/licenseId if a later violation has it
      if (!entry.licenseName && v.licenseName) entry.licenseName = v.licenseName;
      if (!entry.licenseId   && v.licenseId)   entry.licenseId   = v.licenseId;
      const st = v.state.toLowerCase();
      if (st === 'fail') entry.fail++;
      else if (st === 'warn') entry.warn++;
      else entry.info++;
      entry.projects.add(v.projName);
    }
    const wsL3 = wb.addWorksheet('LR_Unique Risks');
    wsL3.columns = [
      { header: 'S.No',               key: 'sno',         width: 6  },
      { header: 'Component',          key: 'component',   width: 36 },
      { header: 'Component Version',  key: 'compVer',     width: 14 },
      { header: 'License Name',       key: 'licenseName', width: 34 },
      { header: 'License ID',         key: 'licenseId',   width: 24 },
      { header: 'Total Violations',   key: 'total',       width: 16 },
      { header: 'Fail',               key: 'fail',        width: 10 },
      { header: 'Warn',               key: 'warn',        width: 10 },
      { header: 'Info',               key: 'info',        width: 10 },
      { header: 'Affected Projects',  key: 'projCount',   width: 16 },
      { header: 'Project Names',      key: 'projNames',   width: 60 },
    ];
    styleHeader(wsL3);
    // Sort by Fail desc, Warn desc, total desc
    const sortedCompsL = [...compLicMap.values()].sort((a, b) => {
      if (b.fail !== a.fail) return b.fail - a.fail;
      if (b.warn !== a.warn) return b.warn - a.warn;
      return (b.fail + b.warn + b.info) - (a.fail + a.warn + a.info);
    });
    let snoL3 = 1;
    for (const e of sortedCompsL) {
      wsL3.addRow({
        sno:         snoL3++,
        component:   e.component,
        compVer:     e.compVersion,
        licenseName: e.licenseName,
        licenseId:   e.licenseId,
        total:       e.fail + e.warn + e.info,
        fail:        e.fail,
        warn:        e.warn,
        info:        e.info,
        projCount:   e.projects.size,
        projNames:   [...e.projects].sort().join(', '),
      });
    }
    alternateShading(wsL3);
  }

  // ── Operational sheets ────────────────────────────────────────────────────
  if (riskTypes.includes('operational')) {
    // Sheet: Operational Violations
    const wsO1 = wb.addWorksheet('OR_Violations');
    wsO1.columns = [
      { header: 'S.No',              key: 'sno',       width: 6  },
      { header: 'Project Name',      key: 'projName',  width: 28 },
      { header: 'Project Version',   key: 'projVer',   width: 14 },
      { header: 'Component',         key: 'component', width: 36 },
      { header: 'Component Version', key: 'compVer',   width: 14 },
      { header: 'Policy',            key: 'policy',    width: 30 },
      { header: 'Subject',           key: 'subject',   width: 20 },
      { header: 'Condition',         key: 'condition', width: 24 },
      { header: 'State',             key: 'state',     width: 10 },
    ];
    styleHeader(wsO1);
    opsViolations.forEach((v, idx) => {
      wsO1.addRow({
        sno:       idx + 1,
        projName:  v.projName,
        projVer:   v.projVersion,
        component: v.component,
        compVer:   v.compVersion,
        policy:    v.policy,
        subject:   v.subject,
        condition: v.condition,
        state:     v.state,
      });
    });
    alternateShading(wsO1);

    // Sheet: Operational Project Summary
    const wsO2 = wb.addWorksheet('OR_Project Summary');
    wsO2.columns = [
      { header: 'S.No',            key: 'sno',      width: 6  },
      { header: 'Project Name',    key: 'projName', width: 28 },
      { header: 'Project Version', key: 'projVer',  width: 14 },
      { header: 'Fail',            key: 'fail',     width: 10 },
      { header: 'Warn',            key: 'warn',     width: 10 },
      { header: 'Info',            key: 'info',     width: 10 },
    ];
    styleHeader(wsO2);
    let snoO = 1;
    for (const s of opsProjectSummary.values()) {
      wsO2.addRow({ sno: snoO++, projName: s.name, projVer: s.version || '', fail: s.fail, warn: s.warn, info: s.info });
    }

    // Sheet 3: Unique Operational Risks — one row per unique component + version
    const opsCompMap = new Map(); // key: "component||compVersion" → entry
    for (const v of opsViolations) {
      const key = `${v.component}||${v.compVersion}`;
      if (!opsCompMap.has(key)) {
        opsCompMap.set(key, {
          component:   v.component,
          compVersion: v.compVersion,
          fail: 0, warn: 0, info: 0,
          projects: new Set(),
        });
      }
      const entry = opsCompMap.get(key);
      const st = v.state.toLowerCase();
      if (st === 'fail') entry.fail++;
      else if (st === 'warn') entry.warn++;
      else entry.info++;
      entry.projects.add(v.projName);
    }
    const wsO3 = wb.addWorksheet('OR_Unique Risks');
    wsO3.columns = [
      { header: 'S.No',              key: 'sno',       width: 6  },
      { header: 'Component',         key: 'component', width: 36 },
      { header: 'Component Version', key: 'compVer',   width: 14 },
      { header: 'Fail',              key: 'fail',      width: 10 },
      { header: 'Warn',              key: 'warn',      width: 10 },
      { header: 'Info',              key: 'info',      width: 10 },
      { header: 'Affected Projects', key: 'projCount', width: 16 },
      { header: 'Project Names',     key: 'projNames', width: 60 },
    ];
    styleHeader(wsO3);
    const sortedOpsComps = [...opsCompMap.values()].sort((a, b) => {
      if (b.fail !== a.fail) return b.fail - a.fail;
      if (b.warn !== a.warn) return b.warn - a.warn;
      return (b.fail + b.warn + b.info) - (a.fail + a.warn + a.info);
    });
    let snoO3 = 1;
    for (const e of sortedOpsComps) {
      wsO3.addRow({
        sno:       snoO3++,
        component: e.component,
        compVer:   e.compVersion,
        fail:      e.fail,
        warn:      e.warn,
        info:      e.info,
        projCount: e.projects.size,
        projNames: [...e.projects].sort().join(', '),
      });
    }
    alternateShading(wsO3);
  }

  await wb.xlsx.writeFile(filePath);
}

// ── Report job runner ─────────────────────────────────────────────────────────
/**
 * Registry-tracked background job.  Delegates data collection to collectReportData
 * so the logic is shared with runScheduledJob.
 *
 * @param {string}   id        — job UUID
 * @param {Array}    projects  — [{ uuid, name, version }]
 * @param {string[]} riskTypes — subset of ['security','license','operational']
 */
async function runReportJob(id, projects, riskTypes) {
  const job = reportJobs.get(id);

  job.status    = 'running';
  job.riskTypes = riskTypes;
  // One progress counter per selected risk type so the UI shows an independent bar.
  job.progress  = Object.fromEntries(
    riskTypes.map(rt => [rt, { done: 0, total: projects.length }])
  );
  job.updatedAt = new Date().toISOString();
  saveRegistry();

  const watchdog = setTimeout(() => {
    log('warn', `Report job ${id} timed out after ${REPORT_TIMEOUT_MS / 60_000} min`);
    job.cancelFlag.cancelled = true;
    job.cancelReason = 'timeout';
  }, REPORT_TIMEOUT_MS);

  try {
    const { apiUrl, apiKey } = getEffectiveConfig();
    if (!apiKey) throw new Error('DT_API_KEY is not configured on the cache service.');

    const reportData = await collectReportData(
      apiUrl, apiKey, projects, riskTypes, job.cancelFlag,
      (rt) => {
        job.progress[rt].done++;
        job.updatedAt = new Date().toISOString();
        saveRegistry();
      }
    );

    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `vulnerability_report_${ts}.xlsx`;
    const filePath = path.join(REPORT_DIR, filename);
    fs.mkdirSync(REPORT_DIR, { recursive: true });

    const totalRows = reportData.secFindings.length + reportData.licViolations.length + reportData.opsViolations.length;
    log('info', `Report ${id}: building Excel (${totalRows} rows, types: ${riskTypes.join(',')})`);
    await buildExcelReport(filePath, { riskTypes, ...reportData });

    clearTimeout(watchdog);
    job.status    = 'completed';
    job.filename  = filename;
    job.filePath  = filePath;
    job.updatedAt = new Date().toISOString();
    log('info', `Report ${id}: completed — ${filename}`);

  } catch (err) {
    clearTimeout(watchdog);
    const isCancelled = err.isCancelled || job.cancelFlag.cancelled;
    job.status    = 'failed';
    job.error     = isCancelled
      ? (job.cancelReason === 'timeout'
          ? `Timed out after ${REPORT_TIMEOUT_MS / 60_000} minutes.`
          : 'Cancelled by user.')
      : err.message;
    job.updatedAt = new Date().toISOString();
    log('error', `Report ${id} failed: ${job.error}`);
  }

  saveRegistry();
}

/** Serialise a job for the API response (strip runtime-only fields). */
function jobToApi(job) {
  const { cancelFlag, watchdogId, filePath, ...pub } = job; // eslint-disable-line no-unused-vars
  return pub;
}

// ── Email helper ──────────────────────────────────────────────────────────────
/**
 * Send an email using the SMTP credentials from the app config.
 * The SMTP password is read from the stored config — never from a GET response.
 *
 * @param {object}      mailCfg       — config.mail object
 * @param {string|null} attachPath    — absolute path to attachment (or null)
 * @param {string|null} attachName    — filename displayed in email (or null)
 * @param {object}      [overrides]   — override to/subject/body (used for failure alerts)
 */
async function sendEmail(mailCfg, attachPath, attachName, overrides = {}) {
  const now            = new Date();
  const defaultSubject = `Dependency-Track Risk Report — ${now.toLocaleDateString()}`;
  const defaultBody    = `Please find attached the latest Dependency-Track risk report generated on ${now.toLocaleString()}.`;

  const transporter = nodemailer.createTransport({
    host:   mailCfg.smtp.host,
    port:   mailCfg.smtp.port,
    secure: mailCfg.smtp.secure,
    auth:   mailCfg.smtp.user
      ? { user: mailCfg.smtp.user, pass: mailCfg.smtp.pass }
      : undefined,
  });

  const msg = {
    from:    mailCfg.from,
    to:      (overrides.to || mailCfg.to).join(', '),
    subject: overrides.subject || mailCfg.subject || defaultSubject,
    text:    overrides.body    || mailCfg.body    || defaultBody,
  };
  const cc = (overrides.cc || mailCfg.cc || []);
  if (cc.length) msg.cc = cc.join(', ');

  if (attachPath && fs.existsSync(attachPath)) {
    msg.attachments = [{ filename: attachName || path.basename(attachPath), path: attachPath }];
  }

  log('info', 'Sending email', {
    to:   msg.to,
    subj: msg.subject,
    smtp: `${mailCfg.smtp.host}:${mailCfg.smtp.port}`,
    attach: attachName || 'none',
  });
  await transporter.sendMail(msg);
  log('info', 'Email sent successfully');
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
/**
 * Calculate the next local-time Date when the job should fire.
 * Uses server's local timezone (no external timezone library needed).
 *
 * @param {object} schedule — config.schedule
 * @returns {Date}
 */
function calcNextRun(schedule) {
  const now = new Date();

  if (schedule.frequency === 'daily') {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), schedule.hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  if (schedule.frequency === 'weekly') {
    const targetDays = (schedule.weekDays || [1]).sort((a, b) => a - b);
    // Scan the next 8 days to find the first matching weekday that is in the future
    for (let d = 1; d <= 8; d++) {
      const candidate = new Date(
        now.getFullYear(), now.getMonth(), now.getDate() + d, schedule.hour, 0, 0, 0
      );
      if (targetDays.includes(candidate.getDay())) return candidate;
    }
    // Fallback (shouldn't happen with valid config)
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, schedule.hour, 0, 0, 0);
  }

  if (schedule.frequency === 'monthly') {
    const day  = Math.min(schedule.monthDay || 1, 28); // cap at 28 — always valid in any month
    let next   = new Date(now.getFullYear(), now.getMonth(), day, schedule.hour, 0, 0, 0);
    if (next <= now) next = new Date(now.getFullYear(), now.getMonth() + 1, day, schedule.hour, 0, 0, 0);
    return next;
  }

  // Unknown frequency — default to 24 h from now
  return new Date(now.getTime() + 24 * 3_600_000);
}

let _schedulerTimer   = null;
let _schedulerRunning = false;

/** Arm (or re-arm) the scheduler based on the current app config. */
function armScheduler() {
  if (_schedulerTimer) { clearTimeout(_schedulerTimer); _schedulerTimer = null; }

  const cfg = loadConfig();
  if (!cfg.schedule.enabled) {
    log('info', 'Scheduler disabled — not arming');
    return;
  }

  const next    = calcNextRun(cfg.schedule);
  const msUntil = Math.max(next.getTime() - Date.now(), 1000); // minimum 1 s to avoid tight loops

  cfg.schedule.nextRun = next.toISOString();
  saveConfig(cfg);

  log('info', 'Scheduler armed', { nextRun: next.toISOString(), msUntil });
  _schedulerTimer = setTimeout(async () => {
    _schedulerTimer = null;
    await runScheduledJob();
    armScheduler(); // re-arm for the next occurrence after each firing
  }, msUntil);
}

async function runScheduledJob() {
  if (_schedulerRunning) {
    log('warn', 'Scheduled job already running — skipping this occurrence (overlap protection)');
    return;
  }

  _schedulerRunning = true;
  const cfg = loadConfig();
  log('info', 'Scheduled report job starting', { projectCount: cfg.schedule.projectUuids.length });

  let reportFilePath = null;
  let reportFileName = null;

  try {
    const { apiUrl, apiKey } = getEffectiveConfig();
    if (!apiKey) throw new Error('DT_API_KEY is not configured');
    if (!cfg.schedule.projectUuids.length) throw new Error('No project UUIDs stored in schedule config');

    // Resolve stored UUIDs against live DT project list — skip UUIDs that no longer exist
    const storedSet = new Set(cfg.schedule.projectUuids);
    const projects  = [];
    let page = 1;
    while (true) {
      const { json } = await dtGetWithRetry(
        `/api/v1/project?pageSize=500&pageNumber=${page}&onlyRoot=false`, apiUrl, apiKey
      );
      const batch = Array.isArray(json) ? json : [];
      for (const p of batch) {
        if (storedSet.has(p.uuid)) {
          projects.push({ uuid: p.uuid, name: p.name, version: p.version || '' });
        }
      }
      if (batch.length < 500) break;
      page++;
    }
    if (projects.length === 0) throw new Error('None of the stored project UUIDs matched live DT data');
    log('info', `Scheduled job: ${projects.length}/${storedSet.size} UUIDs resolved`);

    fs.mkdirSync(SCHED_DIR, { recursive: true });
    const ts      = new Date().toISOString().replace(/[:.]/g, '-');
    reportFileName = `scheduled_report_${ts}.xlsx`;
    reportFilePath = path.join(SCHED_DIR, reportFileName);

    const riskTypes  = cfg.schedule.riskTypes || ['security', 'license', 'operational'];
    const cancelFlag = { cancelled: false };

    const reportData = await collectReportData(
      apiUrl, apiKey, projects, riskTypes, cancelFlag,
      (rt) => log('info', `Scheduled job progress: ${rt} project done`)
    );

    await buildExcelReport(reportFilePath, { riskTypes, ...reportData });
    log('info', `Scheduled job: Excel written (${reportFileName})`);

    // Email if configured
    if (cfg.mail.enabled) {
      await sendEmail(cfg.mail, reportFilePath, reportFileName);
    }

    // Delete the file — it was emailed (or mail was intentionally disabled)
    try { fs.unlinkSync(reportFilePath); } catch (_) {}
    reportFilePath = null;

    const newCfg = loadConfig();
    newCfg.schedule.lastRun             = new Date().toISOString();
    newCfg.schedule.lastRunStatus       = 'success';
    newCfg.schedule.lastRunError        = null;
    newCfg.schedule.failureNotification = null;
    saveConfig(newCfg);
    log('info', 'Scheduled job completed successfully');

  } catch (err) {
    log('error', `Scheduled job failed: ${err.message}`);
    if (reportFilePath) { try { fs.unlinkSync(reportFilePath); } catch (_) {} }

    const newCfg = loadConfig();
    newCfg.schedule.lastRun             = new Date().toISOString();
    newCfg.schedule.lastRunStatus       = 'failed';
    newCfg.schedule.lastRunError        = err.message;
    // O3: notification persists until the browser ACKs it (POST /violation-cache/schedule/ack-notification)
    newCfg.schedule.failureNotification = `Scheduled report failed on ${new Date().toLocaleString()}: ${err.message}`;
    saveConfig(newCfg);

    // Send failure alert to the From address so someone is notified even without opening the UI
    try {
      const freshCfg = loadConfig();
      if (freshCfg.mail.enabled && freshCfg.mail.from && freshCfg.mail.smtp.host) {
        await sendEmail(freshCfg.mail, null, null, {
          to:      [freshCfg.mail.from],
          cc:      [],
          subject: 'Dependency-Track Scheduled Report Failed',
          body:    `The scheduled Dependency-Track report failed on ${new Date().toLocaleString()}.\n\nError: ${err.message}\n\nPlease check the server logs for details.`,
        });
      }
    } catch (emailErr) {
      log('error', `Failed to send failure alert email: ${emailErr.message}`);
    }
  } finally {
    _schedulerRunning = false;
  }
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
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

  // ── GET /violation-cache/config ───────────────────────────────────────────
  // Returns the full app config (sanitised — SMTP password is masked) plus
  // the current effective API key and .env mount status.
  // The dashboard reads this on page load and after the config panel is opened.
  if (method === 'GET' && url === '/violation-cache/config') {
    const { apiKey: effectiveKey } = getEffectiveConfig();
    const clientCfg = sanitiseConfigForClient(loadConfig());
    jsonReply(res, 200, {
      apiKey:         effectiveKey,
      envFileMounted: fs.existsSync(ENV_FILE),
      config:         clientCfg,
    });
    return;
  }

  // ── POST /violation-cache/config ──────────────────────────────────────────
  // Accepts:
  //   { apiKey }          — update DT_API_KEY in .env (backward compat)
  //   { config: {...} }   — save full app config (maxReports, mail, schedule)
  //   Both fields may appear together.
  if (method === 'POST' && url === '/violation-cache/config') {
    try {
      const raw  = await readBody(req, 256 * 1024); // 256 KB — project UUID lists can be large
      const body = JSON.parse(raw);

      // ── API key update (existing behaviour) ──────────────────────────
      if (body.apiKey !== undefined) {
        if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
          jsonReply(res, 400, { error: 'apiKey must be a non-empty string' });
          return;
        }
        const cleanKey = body.apiKey.replace(/[\x00-\x1F\x7F]/g, '').trim();
        if (!fs.existsSync(ENV_FILE)) {
          jsonReply(res, 503, { error: `Config file not found at ${ENV_FILE}. Ensure .env is bind-mounted.` });
          return;
        }
        patchEnvFile(ENV_FILE, { DT_API_KEY: cleanKey });
        log('info', `DT_API_KEY updated in ${ENV_FILE}`, { key: `***${cleanKey.slice(-4)}` });
      }

      // ── Full app config update ────────────────────────────────────────
      if (body.config !== undefined) {
        if (typeof body.config !== 'object' || body.config === null) {
          jsonReply(res, 400, { error: 'config must be an object' });
          return;
        }
        const prevCfg    = loadConfig();
        const prevMax    = prevCfg.maxReports || DEFAULT_MAX_REPORTS;
        const newMax     = typeof body.config.maxReports === 'number' && body.config.maxReports > 0
          ? body.config.maxReports : prevMax;

        // Restore real SMTP password when client sent the masked placeholder
        if (body.config.mail?.smtp?.pass === '••••••••') {
          if (body.config.mail) body.config.mail.smtp.pass = prevCfg.mail.smtp.pass;
        }

        const merged = deepMerge(prevCfg, body.config);

        const schedChanged = JSON.stringify(prevCfg.schedule) !== JSON.stringify(merged.schedule);

        saveConfig(merged);
        log('info', 'App config updated', {
          maxReports:  merged.maxReports,
          mailEnabled: merged.mail.enabled,
          schedEnabled: merged.schedule.enabled,
        });

        // Re-arm only if the scheduler timer was already active so that
        // config changes take effect on the next run. First-time arming
        // is done exclusively via POST /violation-cache/schedule/arm,
        // which is called by the "Schedule Reports" toolbar button.
        if (schedChanged && _schedulerTimer !== null) armScheduler();

        // Trim oldest completed reports when maxReports decreased
        if (newMax < prevMax) {
          const completed = Array.from(reportJobs.values())
            .filter(j => j.status === 'completed')
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // oldest first
          const toDelete = completed.slice(0, Math.max(0, completed.length - newMax));
          for (const j of toDelete) {
            if (j.filePath && fs.existsSync(j.filePath)) {
              try { fs.unlinkSync(j.filePath); } catch (_) {}
            }
            reportJobs.delete(j.id);
            log('info', `Trimmed old report ${j.id} (maxReports reduced to ${newMax})`);
          }
          if (toDelete.length) saveRegistry();
        }

        // Re-arm scheduler based on updated config
        if (schedChanged) armScheduler();
      }

      jsonReply(res, 200, { ok: true });

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

  // ── Report endpoints (/violation-cache/report/*) ──────────────────────────
  // Parse pathname for dynamic :id segments
  const parsedPath = new URL(url, 'http://x').pathname;

  // POST /violation-cache/report/generate
  if (method === 'POST' && parsedPath === '/violation-cache/report/generate') {
    try {
      const raw  = await readBody(req, 5 * 1024 * 1024); // 5 MB — project list can be large
      const body = JSON.parse(raw);

      if (!Array.isArray(body.projects) || body.projects.length === 0) {
        jsonReply(res, 400, { error: 'projects must be a non-empty array' });
        return;
      }

      // riskTypes defaults to ['security'] for backward compatibility when omitted.
      const riskTypes = Array.isArray(body.riskTypes) && body.riskTypes.length > 0
        ? body.riskTypes
        : ['security'];
      const invalidTypes = riskTypes.filter(t => !VALID_RISK_TYPES.has(t));
      if (invalidTypes.length > 0) {
        jsonReply(res, 400, {
          error: `Invalid risk type(s): ${invalidTypes.join(', ')}. Valid values: security, license, operational`,
        });
        return;
      }

      const jobs = Array.from(reportJobs.values());
      const completedCount = jobs.filter(j => j.status === 'completed').length;
      const runningCount   = jobs.filter(j => j.status === 'running').length;
      const maxReports     = getMaxReports();
      if (completedCount + runningCount >= maxReports) {
        jsonReply(res, 429, {
          error: `Report limit reached (${completedCount} completed + ${runningCount} in-progress = ${completedCount + runningCount} / ${maxReports}). ` +
                 'Delete existing reports or raise the limit in Settings.',
          completedCount,
          runningCount,
          maxReports,
        });
        return;
      }

      const id  = crypto.randomUUID();
      const job = {
        id,
        status:       'pending',
        filename:     null,
        filePath:     null,
        error:        null,
        riskTypes,
        progress:     { done: 0, total: body.projects.length },
        createdAt:    new Date().toISOString(),
        updatedAt:    new Date().toISOString(),
        cancelFlag:   { cancelled: false },
        cancelReason: null,
      };
      reportJobs.set(id, job);
      saveRegistry();

      // Fire and forget — status is polled via /report/list
      runReportJob(id, body.projects, riskTypes).catch(err =>
        log('error', `Unhandled report job error (${id}): ${err.message}`)
      );

      log('info', `Report job created: ${id} (${body.projects.length} projects)`);
      jsonReply(res, 201, { id, message: 'Report generation started' });
    } catch (e) {
      log('error', `Report generate error: ${e.message}`);
      jsonReply(res, 400, { error: e.message });
    }
    return;
  }

  // GET /violation-cache/report/list
  if (method === 'GET' && parsedPath === '/violation-cache/report/list') {
    const list = Array.from(reportJobs.values())
      .map(jobToApi)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    jsonReply(res, 200, list);
    return;
  }

  // ── POST /violation-cache/config/test-email ──────────────────────────────
  // Sends a plain-text test email.
  // Accepts an optional JSON body with form-level SMTP credentials so the
  // user can test connectivity before saving.  If useStoredPass:true is set
  // the real stored password is substituted (the browser never has it).
  // Falls back to saved config when no body is supplied.
  if (method === 'POST' && parsedPath === '/violation-cache/config/test-email') {
    try {
      const cfg = loadConfig();
      let mailCfg;

      const raw = await readBody(req).catch(() => '');
      const body = raw ? JSON.parse(raw) : null;

      if (body && body.smtp) {
        // Q10: use form credentials for the test; substitute stored password
        // when the browser sends useStoredPass:true (placeholder was shown).
        const storedPass = cfg.mail && cfg.mail.smtp ? cfg.mail.smtp.pass : '';
        mailCfg = {
          enabled: true,
          smtp: {
            host:   body.smtp.host   || '',
            port:   body.smtp.port   || 587,
            secure: !!body.smtp.secure,
            user:   body.smtp.user   || '',
            pass:   body.useStoredPass ? storedPass : (body.smtp.pass || ''),
          },
          from: body.from || '',
          to:   body.to   || [],
          cc:   body.cc   || [],
        };
      } else {
        if (!cfg.mail.enabled) {
          jsonReply(res, 400, { error: 'Email is not enabled in configuration' });
          return;
        }
        mailCfg = cfg.mail;
      }

      if (!mailCfg.smtp.host || !mailCfg.from || !mailCfg.to.length) {
        jsonReply(res, 400, { error: 'SMTP host, From address, and at least one To address are required' });
        return;
      }
      await sendEmail(mailCfg, null, null, {
        subject: 'Dependency-Track — Test Email',
        body:    `This is a test email from the Dependency-Track Risk Dashboard sent on ${new Date().toLocaleString()}. Your SMTP configuration is working correctly.`,
      });
      jsonReply(res, 200, { ok: true, message: 'Test email sent successfully' });
    } catch (e) {
      log('error', `Test email failed: ${e.message}`);
      jsonReply(res, 500, { error: `Email failed: ${e.message}` });
    }
    return;
  }

  // ── POST /violation-cache/schedule/arm ───────────────────────────────────
  // Explicitly arms the scheduler. Called by the "Schedule Reports" button
  // after project UUIDs are saved, so saving config alone never starts the timer.
  if (method === 'POST' && parsedPath === '/violation-cache/schedule/arm') {
    const cfg = loadConfig();
    if (!cfg.schedule.enabled) {
      jsonReply(res, 400, { error: 'Schedule is not enabled — enable it in settings first' });
      return;
    }
    if (!cfg.schedule.projectUuids.length) {
      jsonReply(res, 400, { error: 'No project UUIDs saved — click Schedule Reports to select projects first' });
      return;
    }
    armScheduler();
    const updated = loadConfig();
    log('info', 'Scheduler armed via API', { nextRun: updated.schedule.nextRun });
    jsonReply(res, 200, { ok: true, nextRun: updated.schedule.nextRun });
    return;
  }

  // ── GET /violation-cache/schedule/status ─────────────────────────────────
  if (method === 'GET' && parsedPath === '/violation-cache/schedule/status') {
    const cfg = loadConfig();
    jsonReply(res, 200, {
      enabled:             cfg.schedule.enabled,
      frequency:           cfg.schedule.frequency,
      nextRun:             cfg.schedule.nextRun,
      lastRun:             cfg.schedule.lastRun,
      lastRunStatus:       cfg.schedule.lastRunStatus,
      lastRunError:        cfg.schedule.lastRunError,
      failureNotification: cfg.schedule.failureNotification,
      isRunning:           _schedulerRunning,
      projectCount:        cfg.schedule.projectUuids.length,
    });
    return;
  }

  // ── DELETE /violation-cache/schedule ─────────────────────────────────────
  // Disables the scheduled job without removing configuration.
  if (method === 'DELETE' && parsedPath === '/violation-cache/schedule') {
    const cfg = loadConfig();
    cfg.schedule.enabled = false;
    cfg.schedule.nextRun = null;
    saveConfig(cfg);
    armScheduler(); // will immediately clear the timer because enabled=false
    log('info', 'Schedule cancelled via API');
    jsonReply(res, 200, { ok: true, message: 'Schedule disabled' });
    return;
  }

  // ── POST /violation-cache/schedule/ack-notification ──────────────────────
  // Clears the failureNotification field once the browser has displayed it.
  if (method === 'POST' && parsedPath === '/violation-cache/schedule/ack-notification') {
    const cfg = loadConfig();
    cfg.schedule.failureNotification = null;
    saveConfig(cfg);
    jsonReply(res, 200, { ok: true });
    return;
  }

  // Dynamic :id routes
  const dlMatch     = parsedPath.match(/^\/violation-cache\/report\/([^/]+)\/download$/);
  const cancelMatch = parsedPath.match(/^\/violation-cache\/report\/([^/]+)\/cancel$/);
  const idMatch     = parsedPath.match(/^\/violation-cache\/report\/([^/]+)$/);

  // GET /violation-cache/report/:id/download
  if (method === 'GET' && dlMatch) {
    const id  = dlMatch[1];
    const job = reportJobs.get(id);
    if (!job) { jsonReply(res, 404, { error: 'Report not found' }); return; }
    if (job.status !== 'completed') {
      jsonReply(res, 409, { error: `Report is not ready (status: ${job.status})` });
      return;
    }
    if (!fs.existsSync(job.filePath)) {
      jsonReply(res, 410, { error: 'Report file no longer exists on disk' });
      return;
    }
    try {
      const stat = fs.statSync(job.filePath);
      res.writeHead(200, {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${job.filename}"`,
        'Content-Length':      stat.size,
        'Cache-Control':       'no-store',
      });
      fs.createReadStream(job.filePath).pipe(res);
    } catch (e) {
      log('error', `Report download failed (${id}): ${e.message}`);
      jsonReply(res, 500, { error: 'Failed to stream report file' });
    }
    return;
  }

  // POST /violation-cache/report/:id/cancel
  if (method === 'POST' && cancelMatch) {
    const id  = cancelMatch[1];
    const job = reportJobs.get(id);
    if (!job) { jsonReply(res, 404, { error: 'Report not found' }); return; }
    if (job.status !== 'running') {
      jsonReply(res, 409, { error: `Cannot cancel — job is not running (status: ${job.status})` });
      return;
    }
    job.cancelFlag.cancelled = true;
    job.cancelReason = 'user';
    log('info', `Report job ${id} cancel requested by user`);
    jsonReply(res, 200, { ok: true, message: 'Cancellation requested' });
    return;
  }

  // DELETE /violation-cache/report/:id
  if (method === 'DELETE' && idMatch) {
    const id  = idMatch[1];
    const job = reportJobs.get(id);
    if (!job) { jsonReply(res, 404, { error: 'Report not found' }); return; }
    if (job.status === 'running') {
      jsonReply(res, 409, { error: 'Cancel the job before deleting it' });
      return;
    }
    // Delete the file only for completed jobs (failed jobs never produced a file)
    if (job.status === 'completed' && job.filePath && fs.existsSync(job.filePath)) {
      try { fs.unlinkSync(job.filePath); } catch (e) {
        log('warn', `Could not delete report file ${job.filePath}: ${e.message}`);
      }
    }
    reportJobs.delete(id);
    saveRegistry();
    log('info', `Report job ${id} deleted`);
    jsonReply(res, 200, { ok: true });
    return;
  }

  // ── Allow DELETE in CORS preflight ───────────────────────────────────────
  res.writeHead(404);
  res.end('Not found');

}).listen(PORT, () => {
  loadRegistry(); // restore persisted report jobs before serving requests

  const { apiUrl, apiKey } = getEffectiveConfig();
  const appCfg = loadConfig();
  log('info', `Violation cache service listening on :${PORT}`);
  log('info', 'Startup configuration', {
    apiUrl,
    apiKey:       apiKey ? `***${apiKey.slice(-4)}` : 'NOT SET',
    cacheTtlHrs:  CACHE_TTL_MS / 3_600_000,
    cacheFile:    CACHE_FILE,
    envFile:      `${ENV_FILE} (${fs.existsSync(ENV_FILE) ? 'mounted ✓' : 'NOT FOUND — config endpoint disabled'})`,
    maxReports:   appCfg.maxReports,
    mailEnabled:  appCfg.mail.enabled,
    schedEnabled: appCfg.schedule.enabled,
    logFormat:    LOG_JSON ? 'json' : 'text',
  });

  // Arm the scheduler if it was enabled before the service restarted
  armScheduler();

  const s = getStatus();
  if (s.status === 'none' || s.status === 'stale') {
    log('info', `Auto-triggering cache build (status: ${s.status})`);
    runJob().catch(err => log('error', `Startup job error: ${err.message}`));
  } else {
    log('info', `Cache status on startup: ${s.status}`);
  }
});
