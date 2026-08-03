// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Violation cache build job and its on-disk representation.
//
// Phase 7 replaces the single global cache file with a shared, fingerprint-keyed
// database row. Until then this module owns the process-global job state, which
// is the reason the service is currently single-tenant.

const fs = require('fs');
const { log } = require('./log');
const { dtGetWithRetry } = require('./dt-fetch');

// ── Fetch parameters ──────────────────────────────────────────────────────────
const PAGE_SIZE  = 100;
const RISK_TYPES = ['OPERATIONAL', 'LICENSE', 'SECURITY'];
const STATES     = ['FAIL', 'WARN', 'INFO'];
const CAT        = { OPERATIONAL: 'ops', LICENSE: 'lic', SECURITY: 'secpolicy' };
const SEV        = { FAIL: 'fail', WARN: 'warn', INFO: 'info' };

// ── In-memory job state ───────────────────────────────────────────────────────
let jobRunning  = false;
let jobProgress = { pagesDone: 0, pagesTotal: 0, failedPipelines: 0 };

// Injected at boot: { cacheDir, cacheFile, cacheTmp, cacheTtlMs, getEffectiveConfig }
let _deps = null;

function configure(deps) { _deps = deps; }

function deps() {
  if (!_deps) throw new Error('violation-cache has not been configured — call configure() during boot');
  return _deps;
}

/** True while a cache build is in flight. */
function isJobRunning() { return jobRunning; }

// ── Cache file helpers ────────────────────────────────────────────────────────
function readCacheFile() {
  if (!fs.existsSync(deps().cacheFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(deps().cacheFile, 'utf8'));
  } catch (e) {
    log('error', `Failed to read cache file: ${e.message}`);
    return null;
  }
}

function writeCacheFile(data) {
  fs.mkdirSync(deps().cacheDir, { recursive: true });
  fs.writeFileSync(deps().cacheTmp, JSON.stringify(data), { mode: 0o640 });
  fs.renameSync(deps().cacheTmp, deps().cacheFile); // atomic on POSIX
}

function getStatus() {
  if (jobRunning) {
    return {
      status:   'building',
      progress: { pagesDone: jobProgress.pagesDone, pagesTotal: jobProgress.pagesTotal },
    };
  }
  const { apiKey } = deps().getEffectiveConfig();
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
  const { apiUrl, apiKey } = deps().getEffectiveConfig();
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
      expiresAt:       new Date(now.getTime() + deps().cacheTtlMs).toISOString(),
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

module.exports = {
  configure, runJob, getStatus, readCacheFile, writeCacheFile, isJobRunning,
  PAGE_SIZE, RISK_TYPES, STATES, CAT, SEV, JOB_TIMEOUT_MS,
};
