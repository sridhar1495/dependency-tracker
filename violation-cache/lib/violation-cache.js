// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Violation cache build ─────────────────────────────────────────────────────
// Builds the per-project violation count map for ONE DependencyTrack connection
// and stores it, gzipped, against that connection's fingerprint.
//
// The build is elected by an advisory lock, so users sharing a connection share
// a single crawl: ten users on one DT instance cause one build, not ten
// (CLAUDE.md §7.5, §13). Callers that lose the election report "building" and
// let the browser poll for the winner's result.
//
// The two-phase pipeline structure is preserved from the single-tenant version:
// phase 1 fetches page 1 of all nine pipelines in parallel to learn accurate
// page counts, phase 2 fetches the remainder (CLAUDE.md §6.3).

const { log } = require('./log');
// Held as a module reference rather than destructured so the offline tests can
// substitute it (CLAUDE.md §10.1). It is still the one and only entry point to
// the DT API (§6.2).
const dtFetch = require('./dt-fetch');
const caches = require('./caches');

const PAGE_SIZE  = 100;
const RISK_TYPES = ['OPERATIONAL', 'LICENSE', 'SECURITY'];
const STATES     = ['FAIL', 'WARN', 'INFO'];
const CAT        = { OPERATIONAL: 'ops', LICENSE: 'lic', SECURITY: 'secpolicy' };
const SEV        = { FAIL: 'fail', WARN: 'warn', INFO: 'info' };

// Q15: the watchdog measures SILENCE, not elapsed time. It used to be a flat
// 30-minute deadline, which killed a healthy crawl purely for having a lot of
// data to get through and threw away every page it had already fetched. How
// long a portfolio takes to walk is a property of the portfolio; how long it
// can sit without advancing a single page is a property of it being broken.
// The window is configurable because "broken" depends on how slow the upstream
// DependencyTrack is allowed to be.
const DEFAULT_STALL_MS     = 15 * 60_000;
const HEARTBEAT_MS         = 30_000;  // how often a progressing build touches the row
const PROGRESS_INTERVAL_MS = 1000;    // P14: publish progress at most once a second

// Fingerprints being built by THIS process. The advisory lock is the real guard
// across processes; this avoids re-entering within one.
const _building = new Set();

let _cfg = null;
function configure(cfg) { _cfg = cfg; }
function cfg() {
  if (!_cfg) throw new Error('violation-cache has not been configured — call configure() during boot');
  return _cfg;
}

/** The stall window, falling back to the default when not configured. */
function stallMs() {
  return (_cfg && _cfg.jobStallMs) || DEFAULT_STALL_MS;
}

/** Is this process currently building for that connection? */
function isBuilding(fingerprint) { return _building.has(fingerprint); }

/**
 * Status for a connection, in the shape the dashboard already understands.
 *
 * @param {object|null} conn resolved connection, or null when unconfigured
 */
async function getStatus(conn) {
  if (!conn || !conn.isConfigured || !conn.fingerprint) return { status: 'no-key' };

  const meta = await caches.getMeta(conn.fingerprint);
  const status = caches.deriveStatus(meta, stallMs());

  if (status === 'building') {
    return { status: 'building', progress: (meta && meta.progress) || { pagesDone: 0, pagesTotal: 0 } };
  }
  // A build that stopped reporting is reported as its own state so the caller
  // can restart it, rather than being hidden behind 'building' — which is what
  // made a stranded row unrecoverable.
  if (status === 'stalled') return { status: 'stalled' };
  if (status === 'none') return { status: 'none' };
  if (status === 'failed') return { status: 'error', error: meta.error };

  return {
    status,
    generatedAt:     meta.generatedAt,
    expiresAt:       meta.expiresAt,
    projectCount:    meta.projectCount || 0,
    failedPipelines: meta.failedPipelines || 0,
  };
}

/**
 * Build the cache for one connection.
 *
 * Returns `{ started: false }` when another builder already holds the lock —
 * that is the shared-cache behaviour working, not an error.
 *
 * @param {{ apiUrl: string, apiKey: string, fingerprint: string }} conn
 */
async function runJob(conn) {
  const { apiUrl, apiKey, fingerprint } = conn;
  if (!apiKey || !fingerprint) {
    log('error', 'Cannot build violation cache without a configured connection');
    return { started: false, reason: 'not configured' };
  }
  if (_building.has(fingerprint)) {
    return { started: false, reason: 'already building in this process' };
  }

  const lock = await caches.acquireBuildLock(fingerprint);
  if (!lock.acquired) {
    log('info', 'Another builder already holds this connection — sharing its result', {
      fingerprint: fingerprint.slice(0, 12),
    });
    return { started: false, reason: 'another builder holds the lock' };
  }

  _building.add(fingerprint);
  await caches.markBuilding(fingerprint);
  log('info', 'Violation fetch job started', {
    fingerprint: fingerprint.slice(0, 12), apiUrl, apiKey: `***${apiKey.slice(-4)}`,
  });

  const progress = { pagesDone: 0, pagesTotal: 0, failedPipelines: 0 };
  let lastPublish = 0;
  const publish = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastPublish) < PROGRESS_INTERVAL_MS) return;
    lastPublish = now;
    try { await caches.setProgress(fingerprint, progress); } catch (_) { /* non-fatal */ }
  };

  // ── Stall watchdog and heartbeat ──────────────────────────────────────
  // One timer does both jobs, because they are the same observation. If the
  // page count has moved since the last beat the build is alive, so touch the
  // row; if it has not moved for the whole stall window the build is wedged, so
  // stop it. The row is touched ONLY when progress advanced — a heartbeat that
  // ticked regardless would keep a hung build looking healthy to every other
  // process, which is precisely the failure being fixed.
  const limitMs = stallMs();
  // The beat has to be finer than the window it is measuring, or a short window
  // is decided by one or two samples. Half the window, capped at HEARTBEAT_MS so
  // a long window still refreshes the row often enough for other processes.
  const beatMs  = Math.max(1, Math.min(HEARTBEAT_MS, Math.floor(limitMs / 2)));
  let timedOut     = false;
  let lastSeenPages = -1;
  let lastMovedAt   = Date.now();

  const watchdog = setInterval(() => {
    if (progress.pagesDone !== lastSeenPages) {
      lastSeenPages = progress.pagesDone;
      lastMovedAt   = Date.now();
      caches.touchBuild(fingerprint).catch(() => { /* the next beat retries */ });
      return;
    }
    if ((Date.now() - lastMovedAt) > limitMs) {
      timedOut = true;
      log('error', 'Violation cache build stalled — no progress within the stall window', {
        fingerprint: fingerprint.slice(0, 12),
        progress: `${progress.pagesDone}/${progress.pagesTotal}`,
        stallMinutes: Math.round(limitMs / 60_000),
      });
    }
  }, beatMs);
  if (watchdog.unref) watchdog.unref();

  const map    = {};
  const emptyV = () => ({ fail: 0, warn: 0, info: 0, unassigned: 0 });
  const apply  = (items, ck, sk) => {
    for (const v of items) {
      const uuid = v.project?.uuid; if (!uuid) continue;
      if (!map[uuid]) map[uuid] = { ops: emptyV(), lic: emptyV(), secpolicy: emptyV() };
      map[uuid][ck][sk]++;
    }
  };

  try {
    const pipelines = RISK_TYPES.flatMap(rt => STATES.map(st => ({ rt, st })));

    // ── Phase 1: page counts, all nine pipelines in parallel (P2) ───────
    const phase1 = await Promise.all(pipelines.map(async ({ rt, st }) => {
      const baseUrl = `/api/v1/violation?riskType=${rt}&violationState=${st}&pageSize=${PAGE_SIZE}`;
      try {
        const r1 = await dtFetch.dtGetWithRetry(`${baseUrl}&pageNumber=1`, apiUrl, apiKey);
        const totalCount = parseInt(r1.headers['x-total-count'] || '0', 10);
        const totalPages = totalCount > 0 ? Math.ceil(totalCount / PAGE_SIZE) : 1;
        return { rt, st, r1, totalPages, baseUrl, failed: false };
      } catch (err) {
        log('error', `Pipeline ${rt}/${st} failed on page 1`, { error: err.message });
        progress.failedPipelines++;
        return { rt, st, failed: true };
      }
    }));

    progress.pagesTotal = phase1.reduce((sum, p) => sum + (p.failed ? 0 : p.totalPages), 0);
    await publish(true);

    for (const p of phase1) {
      if (p.failed) continue;
      const items = Array.isArray(p.r1.json) ? p.r1.json : (p.r1.json.violations || []);
      apply(items, CAT[p.rt], SEV[p.st]);
      progress.pagesDone++;
    }
    await publish(true);

    // ── Phase 2: remaining pages ────────────────────────────────────────
    await Promise.all(phase1.filter(p => !p.failed && p.totalPages > 1)
      .map(async ({ rt, st, totalPages, baseUrl }) => {
        const ck = CAT[rt], sk = SEV[st];
        try {
          for (let page = 2; page <= totalPages; page++) {
            if (timedOut) throw new Error('Build stalled');
            const r = await dtFetch.dtGetWithRetry(`${baseUrl}&pageNumber=${page}`, apiUrl, apiKey);
            const items = Array.isArray(r.json) ? r.json : (r.json.violations || []);
            apply(items, ck, sk);
            progress.pagesDone++;
            await publish();
          }
        } catch (err) {
          log('error', `Pipeline ${rt}/${st} failed fetching pages 2+`, { error: err.message });
          progress.failedPipelines++;
        }
      }));

    if (timedOut) {
      await caches.markFailed(fingerprint,
        `Stopped: no progress for ${Math.round(limitMs / 60_000)} minutes ` +
        `(reached page ${progress.pagesDone} of ${progress.pagesTotal}).`);
      return { started: true, completed: false, stalled: true };
    }

    await caches.storeResult(fingerprint, map, {
      projectCount: Object.keys(map).length,
      failedPipelines: progress.failedPipelines,
      ttlMs: cfg().cacheTtlMs,
    });
    return { started: true, completed: true, projectCount: Object.keys(map).length };

  } catch (err) {
    log('error', `Violation cache build failed: ${err.message}`, {
      fingerprint: fingerprint.slice(0, 12),
    });
    await caches.markFailed(fingerprint, err.message).catch(() => {});
    return { started: true, completed: false, error: err.message };
  } finally {
    clearInterval(watchdog);
    _building.delete(fingerprint);
    await lock.release();
  }
}

module.exports = {
  configure, runJob, getStatus, isBuilding,
  // Exposed so a caller reading a row directly applies the same stall window
  // this module builds with, rather than a second copy of the default.
  stallWindowMs: stallMs,
  PAGE_SIZE, RISK_TYPES, STATES, CAT, SEV,
  DEFAULT_STALL_MS, HEARTBEAT_MS,
};
