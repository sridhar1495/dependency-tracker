// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Report generation ─────────────────────────────────────────────────────────
// Collects data from DependencyTrack and builds the workbook.
//
// Report state lives in the database (lib/reports-db.js), not in a process Map
// or a JSON registry, so reports are owned by a user and survive a restart.
// The only per-report process state is the cancel flag, which is inherently
// runtime-only (CLAUDE.md §7.5).

const { log } = require('./log');
const { dtGetWithRetry } = require('./dt-fetch');
const { makeSemaphore } = require('./async-utils');
const { buildExcelReport } = require('./excel');
const reportsDb = require('./reports-db');

const REPORT_TIMEOUT_MS     = 30 * 60_000;  // 30 min hard limit per job
const FINDINGS_PAGE_SIZE    = 300;  // DT API page size for findings
const VIOLATIONS_PAGE_SIZE  = 300;  // DT API page size for violation queries
const VALID_RISK_TYPES      = new Set(['security', 'license', 'operational']);

// reportId → { cancelled: boolean }. Runtime-only: a cancel request is
// meaningful just for the process actually running that job.
const _cancelFlags = new Map();

let _deps = null;
function configure(d) { _deps = d; }
function deps() {
  if (!_deps) throw new Error('reports has not been configured — call configure() during boot');
  return _deps;
}

/** Register a cancel flag for a running report. */
function registerCancelFlag(reportId) {
  const flag = { cancelled: false };
  _cancelFlags.set(reportId, flag);
  return flag;
}

/** Request cancellation. Returns false when this process is not running that job. */
function requestCancel(reportId) {
  const flag = _cancelFlags.get(reportId);
  if (!flag) return false;
  flag.cancelled = true;
  return true;
}

function isRunningHere(reportId) { return _cancelFlags.has(reportId); }

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
  const semaphore     = makeSemaphore(deps().reportConcurrency);
  const violationSema = makeSemaphore(deps().violationConcurrency);

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
    'analysisStatus=NOT_SET,EXPLOITABLE,IN_TRIAGE',
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


// ── Report job runner ─────────────────────────────────────────────────────────
/**
 * Generate a report for one user and store it in the database.
 *
 * Fire-and-forget: the route returns the report id immediately and the browser
 * polls /report/list (CLAUDE.md §6.6).
 *
 * @param {string} userId  owner — every write is scoped to them
 * @param {string} reportId
 * @param {{apiUrl: string, apiKey: string}} conn  resolved DT connection
 * @param {Array}  projects
 * @param {string[]} riskTypes
 */
async function runReportJob(userId, reportId, conn, projects, riskTypes) {
  const cancelFlag = registerCancelFlag(reportId);

  // One counter per selected risk type, so the UI shows an independent bar.
  const progress = Object.fromEntries(
    riskTypes.map(rt => [rt, { done: 0, total: projects.length }])
  );
  await reportsDb.setStatus(reportId, 'running', { progress });

  let cancelReason = null;
  const watchdog = setTimeout(() => {
    cancelFlag.cancelled = true;
    cancelReason = 'timeout';
    log('warn', `Report timed out after ${REPORT_TIMEOUT_MS / 60_000} min`, { reportId });
  }, REPORT_TIMEOUT_MS);

  try {
    const reportData = await collectReportData(
      conn.apiUrl, conn.apiKey, projects, riskTypes, cancelFlag,
      (rt) => {
        progress[rt].done++;
        // P13: throttled to at most one write per second, not one per project.
        reportsDb.writeProgress(reportId, progress)
          .catch(e => log('warn', `Progress write failed: ${e.message}`));
      }
    );

    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `vulnerability_report_${ts}.xlsx`;

    const totalRows = reportData.secFindings.length
      + reportData.licViolations.length + reportData.opsViolations.length;
    log('info', `Building workbook (${totalRows} rows, types: ${riskTypes.join(',')})`, { reportId });

    // Built in memory and written straight to the database — reports never
    // touch the filesystem any more.
    const buffer = await buildExcelReport(null, { riskTypes, ...reportData });
    await reportsDb.writeProgress(reportId, progress, { force: true });
    await reportsDb.storeFile(reportId, buffer, filename);

    log('info', 'Report completed', { userId, reportId, bytes: buffer.length });
    return { completed: true, bytes: buffer.length };

  } catch (err) {
    const isCancelled = err.isCancelled || cancelFlag.cancelled;
    const message = isCancelled
      ? (cancelReason === 'timeout'
          ? `Timed out after ${REPORT_TIMEOUT_MS / 60_000} minutes.`
          : 'Cancelled by user.')
      : err.message;
    await reportsDb.setStatus(reportId, 'failed', { error: message }).catch(() => {});
    log('error', `Report failed: ${message}`, { userId, reportId });
    return { completed: false, error: message };

  } finally {
    clearTimeout(watchdog);
    _cancelFlags.delete(reportId);
    reportsDb.forgetProgress(reportId);
  }
}

module.exports = {
  configure, collectReportData, fetchAllFindings, streamViolationsForProject,
  runReportJob, registerCancelFlag, requestCancel, isRunningHere,
  REPORT_TIMEOUT_MS, FINDINGS_PAGE_SIZE, VIOLATIONS_PAGE_SIZE, VALID_RISK_TYPES,
};
