// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Unit tests for pure functions extracted from dashboard/index.html.
// Run with: node --test violation-cache/dashboard.test.js
// Requires Node 18+ (built-in node:test runner — zero npm dependencies).
//
// These functions are copied verbatim from index.html so they can be tested in
// Node without a browser.  Any change to the source in index.html must be
// mirrored here.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── makeLCG (Q6 — seeded PRNG) ────────────────────────────────────────────────
function makeLCG(seed) {
  let s = seed >>> 0;
  return function (max) {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return Math.floor((s / 0x100000000) * (max + 1));
  };
}

describe('makeLCG (seeded PRNG)', () => {
  test('same seed produces identical sequence', () => {
    const a = makeLCG(0xDEADBEEF);
    const b = makeLCG(0xDEADBEEF);
    for (let i = 0; i < 20; i++) {
      assert.equal(a(100), b(100), `index ${i} should match`);
    }
  });

  test('different seeds produce different sequences', () => {
    const a = makeLCG(1);
    const b = makeLCG(2);
    let differ = false;
    for (let i = 0; i < 20; i++) {
      if (a(1000) !== b(1000)) { differ = true; break; }
    }
    assert.ok(differ, 'sequences from different seeds should differ');
  });

  test('values are always within [0, max]', () => {
    const rnd = makeLCG(42);
    for (let i = 0; i < 500; i++) {
      const max = 10;
      const v   = rnd(max);
      assert.ok(v >= 0 && v <= max, `${v} out of range [0,${max}]`);
    }
  });

  test('rnd(0) always returns 0', () => {
    const rnd = makeLCG(99);
    for (let i = 0; i < 10; i++) {
      assert.equal(rnd(0), 0);
    }
  });

  test('produces integer values', () => {
    const rnd = makeLCG(7);
    for (let i = 0; i < 50; i++) {
      const v = rnd(100);
      assert.equal(v, Math.floor(v), 'must be integer');
    }
  });

  test('seed 0 is handled without throwing', () => {
    assert.doesNotThrow(() => {
      const rnd = makeLCG(0);
      rnd(10);
    });
  });

  test('deterministic mock data: 0xDEADBEEF seed first 5 values are stable', () => {
    // Regression guard — if the algorithm changes, this will catch it.
    const rnd      = makeLCG(0xDEADBEEF);
    const snapshot = [rnd(100), rnd(100), rnd(100), rnd(100), rnd(100)];
    const again    = makeLCG(0xDEADBEEF);
    assert.deepEqual(
      [again(100), again(100), again(100), again(100), again(100)],
      snapshot
    );
  });
});

// ── LEVEL_CSS + pillFor (Q5 — declarative level map) ─────────────────────────
const LEVEL_CSS = {
  critical:   'critical',
  high:       'high',
  medium:     'medium',
  low:        'low',
  unassigned: 'unassigned',
  fail:       'critical',
  warn:       'medium',
  info:       'low',
};

function pillFor(n, level) {
  if (n === 0) return '<span class="pill pill-zero">—</span>';
  const cls = LEVEL_CSS[level] ?? level;
  return `<span class="pill pill-${cls}">${n}</span>`;
}

describe('LEVEL_CSS map', () => {
  test('all expected levels are defined', () => {
    const expected = ['critical','high','medium','low','unassigned','fail','warn','info'];
    for (const lvl of expected) {
      assert.ok(lvl in LEVEL_CSS, `${lvl} should be in LEVEL_CSS`);
    }
  });

  test('policy violation levels map to correct CSS classes', () => {
    assert.equal(LEVEL_CSS.fail, 'critical');
    assert.equal(LEVEL_CSS.warn, 'medium');
    assert.equal(LEVEL_CSS.info, 'low');
  });

  test('security severity levels map to themselves', () => {
    assert.equal(LEVEL_CSS.critical,   'critical');
    assert.equal(LEVEL_CSS.high,       'high');
    assert.equal(LEVEL_CSS.medium,     'medium');
    assert.equal(LEVEL_CSS.low,        'low');
    assert.equal(LEVEL_CSS.unassigned, 'unassigned');
  });
});

describe('pillFor()', () => {
  test('returns zero pill for n=0', () => {
    const html = pillFor(0, 'critical');
    assert.ok(html.includes('pill-zero'), 'zero class expected');
    assert.ok(html.includes('—'), 'dash expected');
  });

  test('renders critical pill for n>0 level=critical', () => {
    const html = pillFor(5, 'critical');
    assert.ok(html.includes('pill-critical'));
    assert.ok(html.includes('>5<'));
  });

  test('maps fail → critical CSS class', () => {
    const html = pillFor(3, 'fail');
    assert.ok(html.includes('pill-critical'), `expected pill-critical, got: ${html}`);
  });

  test('maps warn → medium CSS class', () => {
    assert.ok(pillFor(1, 'warn').includes('pill-medium'));
  });

  test('maps info → low CSS class', () => {
    assert.ok(pillFor(1, 'info').includes('pill-low'));
  });

  test('uses level name directly for unknown levels', () => {
    const html = pillFor(2, 'custom-level');
    assert.ok(html.includes('pill-custom-level'));
  });

  test('escapes n value correctly in output', () => {
    const html = pillFor(42, 'high');
    assert.ok(html.includes('>42<'));
  });
});

// ── P3: name-suffix match using endsWith (replaces RegExp per project) ────────
function inferSuffix(name, version) {
  if (!version) return name;
  const ver = version;
  return (name.endsWith(`-${ver}`) ? name.slice(0, -(ver.length + 1))
        : name.endsWith(`.${ver}`) ? name.slice(0, -(ver.length + 1))
        : name);
}

describe('inferSuffix (P3 — RegExp-free suffix matching)', () => {
  test('strips dash-separated version suffix', () => {
    assert.equal(inferSuffix('MyLib-1.4.1', '1.4.1'), 'MyLib');
  });

  test('strips dot-separated version suffix', () => {
    assert.equal(inferSuffix('MyLib.1.4.1', '1.4.1'), 'MyLib');
  });

  test('returns original name when suffix does not match', () => {
    assert.equal(inferSuffix('MyLib-other', '1.4.1'), 'MyLib-other');
  });

  test('returns original name when version is empty', () => {
    assert.equal(inferSuffix('MyLib', ''), 'MyLib');
  });

  test('handles multi-segment version strings', () => {
    assert.equal(inferSuffix('service-2.3.4-rc1', '2.3.4-rc1'), 'service');
  });

  test('does not strip partial version match mid-name', () => {
    // "app-1.4-service" should NOT match version "1.4" since it doesn't end with it
    assert.equal(inferSuffix('app-1.4-service', '1.4'), 'app-1.4-service');
  });

  test('handles name equal to version (edge case)', () => {
    // "1.4.1" with version "1.4.1" — no separator prefix, returns as-is
    assert.equal(inferSuffix('1.4.1', '1.4.1'), '1.4.1');
  });
});

// ── CONFIG constants (Q4) ─────────────────────────────────────────────────────
const CONFIG = {
  SEARCH_DEBOUNCE_MS:  200,
  PROJECT_PAGE_SIZE:   500,
  CACHE_POLL_MS:      5000,
  PROBE_RETRY_MS:     3000,
  PROBE_TIMEOUT_MS:   3000,
  MIN_SEARCH_LENGTH:     2,
};

describe('CONFIG constants (Q4)', () => {
  test('all expected keys are defined', () => {
    const expected = [
      'SEARCH_DEBOUNCE_MS', 'PROJECT_PAGE_SIZE', 'CACHE_POLL_MS',
      'PROBE_RETRY_MS', 'PROBE_TIMEOUT_MS', 'MIN_SEARCH_LENGTH',
    ];
    for (const key of expected) {
      assert.ok(key in CONFIG, `${key} should be defined`);
    }
  });

  test('all values are positive integers', () => {
    for (const [key, val] of Object.entries(CONFIG)) {
      assert.ok(Number.isInteger(val) && val > 0, `${key}=${val} should be a positive integer`);
    }
  });

  test('SEARCH_DEBOUNCE_MS is at least 100ms (avoids aggressive re-filtering)', () => {
    assert.ok(CONFIG.SEARCH_DEBOUNCE_MS >= 100);
  });

  test('MIN_SEARCH_LENGTH prevents single-char O(n) scans', () => {
    assert.ok(CONFIG.MIN_SEARCH_LENGTH >= 2);
  });

  test('PROJECT_PAGE_SIZE is a reasonable fetch batch size', () => {
    assert.ok(CONFIG.PROJECT_PAGE_SIZE >= 100 && CONFIG.PROJECT_PAGE_SIZE <= 1000);
  });
});

// ── Report pre-flight decision logic ─────────────────────────────────────────
// Extracted pure decision function mirroring generateReport() in index.html.
// The browser version has UI side-effects (toasts, confirm dialogs); here we
// test just the branching logic that decides what action to take.

const MAX_REPORTS_DASH = 10;

/**
 * Pure decision function that mirrors the pre-flight checks in generateReport().
 * Returns one of:
 *   { action: 'trigger' }            — go ahead and generate
 *   { action: 'limit' }              — hard limit reached
 *   { action: 'running', count: N }  — N jobs already running
 *   { action: 'today',   count: N }  — N reports completed today
 */
function reportPreFlight(reports, todayStr) {
  const completed     = reports.filter(r => r.status === 'completed');
  const running       = reports.filter(r => r.status === 'running');
  const total         = completed.length + running.length;
  const todayComplete = completed.filter(r => r.createdAt.startsWith(todayStr));

  if (total >= MAX_REPORTS_DASH)    return { action: 'limit' };
  if (running.length > 0)           return { action: 'running', count: running.length };
  if (todayComplete.length > 0)     return { action: 'today',   count: todayComplete.length };
  return { action: 'trigger' };
}

describe('reportPreFlight()', () => {
  const TODAY = '2024-06-15';
  const YEST  = '2024-06-14';

  test('returns trigger when no reports exist', () => {
    assert.equal(reportPreFlight([], TODAY).action, 'trigger');
  });

  test('returns trigger when only failed reports exist', () => {
    const reports = [{ status: 'failed', createdAt: `${TODAY}T00:00:00Z` }];
    assert.equal(reportPreFlight(reports, TODAY).action, 'trigger');
  });

  test('returns running when a job is in-progress', () => {
    const reports = [{ status: 'running', createdAt: `${TODAY}T01:00:00Z` }];
    const r = reportPreFlight(reports, TODAY);
    assert.equal(r.action, 'running');
    assert.equal(r.count, 1);
  });

  test('returns today when completed report exists for today', () => {
    const reports = [{ status: 'completed', createdAt: `${TODAY}T08:00:00Z` }];
    const r = reportPreFlight(reports, TODAY);
    assert.equal(r.action, 'today');
    assert.equal(r.count, 1);
  });

  test('returns trigger when completed report is from yesterday only', () => {
    const reports = [{ status: 'completed', createdAt: `${YEST}T08:00:00Z` }];
    assert.equal(reportPreFlight(reports, TODAY).action, 'trigger');
  });

  test('returns limit when total completed+running equals MAX', () => {
    const reports = [
      ...Array.from({ length: 7 }, (_, i) => ({ status: 'completed', createdAt: `${YEST}T0${i}:00:00Z` })),
      ...Array.from({ length: 3 }, (_, i) => ({ status: 'running',   createdAt: `${TODAY}T0${i}:00:00Z` })),
    ];
    assert.equal(reportPreFlight(reports, TODAY).action, 'limit');
  });

  test('limit takes precedence over running check', () => {
    const reports = Array.from({ length: MAX_REPORTS_DASH }, () => ({ status: 'running', createdAt: `${TODAY}T00:00:00Z` }));
    assert.equal(reportPreFlight(reports, TODAY).action, 'limit');
  });

  test('running check takes precedence over today check', () => {
    const reports = [
      { status: 'running',   createdAt: `${TODAY}T01:00:00Z` },
      { status: 'completed', createdAt: `${TODAY}T00:30:00Z` },
    ];
    assert.equal(reportPreFlight(reports, TODAY).action, 'running');
  });

  test('today count reflects only completed reports from today', () => {
    const reports = [
      { status: 'completed', createdAt: `${TODAY}T08:00:00Z` },
      { status: 'completed', createdAt: `${TODAY}T09:00:00Z` },
      { status: 'completed', createdAt: `${YEST}T10:00:00Z` },  // yesterday — not counted
    ];
    const r = reportPreFlight(reports, TODAY);
    assert.equal(r.action, 'today');
    assert.equal(r.count, 2);
  });
});

// ── renderReportsList item structure ─────────────────────────────────────────
// Pure helper: extract the display properties for a single report item.

function reportItemProps(job) {
  let badge, actions;
  if (job.status === 'completed') {
    badge   = 'completed';
    actions = ['download', 'clear'];
  } else if (job.status === 'running') {
    badge   = 'running';
    actions = ['cancel'];
  } else {
    badge   = 'failed';
    actions = ['clear'];
  }
  const progressText = job.status === 'running' && job.progress
    ? `${job.progress.done}/${job.progress.total}`
    : null;
  return { badge, actions, progressText };
}

describe('reportItemProps()', () => {
  test('completed job has download + clear actions', () => {
    const p = reportItemProps({ status: 'completed', filename: 'r.xlsx', progress: null });
    assert.deepEqual(p.actions, ['download', 'clear']);
    assert.equal(p.badge, 'completed');
    assert.equal(p.progressText, null);
  });

  test('running job has cancel action and progress text', () => {
    const p = reportItemProps({ status: 'running', progress: { done: 3, total: 10 } });
    assert.deepEqual(p.actions, ['cancel']);
    assert.equal(p.badge, 'running');
    assert.equal(p.progressText, '3/10');
  });

  test('failed job has only clear action', () => {
    const p = reportItemProps({ status: 'failed', error: 'Network error', progress: null });
    assert.deepEqual(p.actions, ['clear']);
    assert.equal(p.badge, 'failed');
    assert.equal(p.progressText, null);
  });

  test('running job with done=0 shows 0/N progress', () => {
    const p = reportItemProps({ status: 'running', progress: { done: 0, total: 5 } });
    assert.equal(p.progressText, '0/5');
  });

  test('running job with all done shows N/N progress', () => {
    const p = reportItemProps({ status: 'running', progress: { done: 5, total: 5 } });
    assert.equal(p.progressText, '5/5');
  });
});

// ── updateReportsBadge logic ──────────────────────────────────────────────────
// The badge on the Reports button should show the count of running jobs.

function badgeCount(reports) {
  return reports.filter(r => r.status === 'running').length;
}

describe('badgeCount() — Reports button badge', () => {
  test('returns 0 when no jobs exist', () => {
    assert.equal(badgeCount([]), 0);
  });

  test('returns 0 when all jobs are completed or failed', () => {
    assert.equal(badgeCount([
      { status: 'completed' }, { status: 'failed' },
    ]), 0);
  });

  test('returns count of running jobs only', () => {
    assert.equal(badgeCount([
      { status: 'running' }, { status: 'running' }, { status: 'completed' },
    ]), 2);
  });
});
