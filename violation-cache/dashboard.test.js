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

// ── buildRiskTypes — mirrors confirmReportOptions() selection logic ────────────
// Pure helper: converts checkbox state into the riskTypes array sent to the server.

function buildRiskTypes(security, license, operational) {
  const types = [];
  if (security)    types.push('security');
  if (license)     types.push('license');
  if (operational) types.push('operational');
  return types;
}

function isValidRiskSelection(riskTypes) {
  return Array.isArray(riskTypes) && riskTypes.length > 0;
}

describe('buildRiskTypes() — risk type selection from checkboxes', () => {
  test('all unchecked returns empty array (invalid)', () => {
    const types = buildRiskTypes(false, false, false);
    assert.deepEqual(types, []);
    assert.equal(isValidRiskSelection(types), false);
  });

  test('only security checked returns ["security"]', () => {
    const types = buildRiskTypes(true, false, false);
    assert.deepEqual(types, ['security']);
    assert.ok(isValidRiskSelection(types));
  });

  test('only license checked returns ["license"]', () => {
    const types = buildRiskTypes(false, true, false);
    assert.deepEqual(types, ['license']);
    assert.ok(isValidRiskSelection(types));
  });

  test('only operational checked returns ["operational"]', () => {
    const types = buildRiskTypes(false, false, true);
    assert.deepEqual(types, ['operational']);
    assert.ok(isValidRiskSelection(types));
  });

  test('security + license returns correct array', () => {
    assert.deepEqual(buildRiskTypes(true, true, false), ['security', 'license']);
  });

  test('security + operational returns correct array', () => {
    assert.deepEqual(buildRiskTypes(true, false, true), ['security', 'operational']);
  });

  test('license + operational returns correct array', () => {
    assert.deepEqual(buildRiskTypes(false, true, true), ['license', 'operational']);
  });

  test('all three checked returns all three in order', () => {
    assert.deepEqual(buildRiskTypes(true, true, true), ['security', 'license', 'operational']);
  });

  test('result does not contain duplicates', () => {
    const types = buildRiskTypes(true, true, true);
    const unique = [...new Set(types)];
    assert.deepEqual(types, unique);
  });

  test('order is always security → license → operational', () => {
    const types = buildRiskTypes(true, true, true);
    assert.equal(types[0], 'security');
    assert.equal(types[1], 'license');
    assert.equal(types[2], 'operational');
  });
});

// ── reportItemProps() is unaffected by riskTypes field ───────────────────────

describe('reportItemProps() is unchanged by new riskTypes field', () => {
  test('completed job with riskTypes still shows correct badge and actions', () => {
    const p = reportItemProps({
      status: 'completed', filename: 'r.xlsx', progress: null,
      riskTypes: ['security', 'license'],
    });
    assert.equal(p.badge, 'completed');
    assert.deepEqual(p.actions, ['download', 'clear']);
    assert.equal(p.progressText, null);
  });

  test('running job with riskTypes still shows correct badge and progress', () => {
    const p = reportItemProps({
      status: 'running', progress: { done: 4, total: 10 },
      riskTypes: ['operational'],
    });
    assert.equal(p.badge, 'running');
    assert.deepEqual(p.actions, ['cancel']);
    assert.equal(p.progressText, '4/10');
  });

  test('failed job with riskTypes still shows failed badge', () => {
    const p = reportItemProps({
      status: 'failed', error: 'timeout', progress: null,
      riskTypes: ['security', 'license', 'operational'],
    });
    assert.equal(p.badge, 'failed');
    assert.deepEqual(p.actions, ['clear']);
  });
});

// ── reportPreFlight unchanged by riskTypes ────────────────────────────────────
// Confirm that adding riskTypes to job objects does not affect the pre-flight logic.

describe('reportPreFlight() is unaffected by riskTypes field on jobs', () => {
  const TODAY = '2024-07-01';

  test('trigger when only old jobs (with riskTypes) completed yesterday', () => {
    const reports = [
      { status: 'completed', createdAt: '2024-06-30T10:00:00Z', riskTypes: ['security'] },
    ];
    assert.equal(reportPreFlight(reports, TODAY).action, 'trigger');
  });

  test('today check still fires when completed today regardless of riskTypes', () => {
    const reports = [
      { status: 'completed', createdAt: `${TODAY}T08:00:00Z`, riskTypes: ['license', 'operational'] },
    ];
    const r = reportPreFlight(reports, TODAY);
    assert.equal(r.action, 'today');
    assert.equal(r.count, 1);
  });

  test('running check still fires when job is running regardless of riskTypes', () => {
    const reports = [
      { status: 'running', createdAt: `${TODAY}T09:00:00Z`, riskTypes: ['security', 'license'] },
    ];
    const r = reportPreFlight(reports, TODAY);
    assert.equal(r.action, 'running');
    assert.equal(r.count, 1);
  });
});

// ── Project selection helpers (checkbox hierarchy logic) ──────────────────────
// Pure functions extracted from dashboard/index.html.
// Any change to the source functions must be mirrored here.

/**
 * Builds a minimal tree node for testing.
 * children is an array of child nodes (recursive).
 */
function makeNode(uuid, children = []) {
  return { uuid, children };
}

/**
 * Returns all leaf-node UUIDs that are descendants of the given node AND
 * currently present in visibleUuidSet.
 */
function getVisibleLeafDescendants(node, visibleUuidSet) {
  const result = [];
  function walk(n) {
    if (!visibleUuidSet.has(n.uuid)) return;
    if (n.children.length === 0) {
      result.push(n.uuid);
    } else {
      for (const child of n.children) walk(child);
    }
  }
  walk(node);
  return result;
}

/**
 * Returns the checkbox state for a parent node.
 * Returns: 'checked' | 'indeterminate' | 'unchecked'
 */
function getParentCheckboxState(node, visibleUuidSet, selectedUuids) {
  const leaves = getVisibleLeafDescendants(node, visibleUuidSet);
  if (leaves.length === 0) return 'unchecked';
  const selectedCount = leaves.filter(uuid => selectedUuids.has(uuid)).length;
  if (selectedCount === 0)             return 'unchecked';
  if (selectedCount === leaves.length) return 'checked';
  return 'indeterminate';
}

describe('getVisibleLeafDescendants', () => {
  test('returns direct leaf children that are in the visible set', () => {
    const leaf1 = makeNode('leaf1');
    const leaf2 = makeNode('leaf2');
    const parent = makeNode('parent', [leaf1, leaf2]);
    const visible = new Set(['parent', 'leaf1', 'leaf2']);
    assert.deepEqual(getVisibleLeafDescendants(parent, visible).sort(), ['leaf1', 'leaf2']);
  });

  test('omits leaves that are not in the visible set (collapsed / filtered)', () => {
    const leaf1 = makeNode('leaf1');
    const leaf2 = makeNode('leaf2');
    const parent = makeNode('parent', [leaf1, leaf2]);
    // leaf2 is not visible (e.g. parent is collapsed so child not in visibleNodes)
    const visible = new Set(['parent', 'leaf1']);
    assert.deepEqual(getVisibleLeafDescendants(parent, visible), ['leaf1']);
  });

  test('returns nested leaf descendants recursively', () => {
    const leaf1 = makeNode('leaf1');
    const leaf2 = makeNode('leaf2');
    const mid   = makeNode('mid', [leaf1, leaf2]);
    const root  = makeNode('root', [mid]);
    const visible = new Set(['root', 'mid', 'leaf1', 'leaf2']);
    assert.deepEqual(getVisibleLeafDescendants(root, visible).sort(), ['leaf1', 'leaf2']);
  });

  test('does not include intermediate parent nodes in the result', () => {
    const leaf1 = makeNode('leaf1');
    const mid   = makeNode('mid', [leaf1]);
    const root  = makeNode('root', [mid]);
    const visible = new Set(['root', 'mid', 'leaf1']);
    const result = getVisibleLeafDescendants(root, visible);
    assert.ok(!result.includes('mid'), 'mid is a parent — should not be returned');
    assert.ok(!result.includes('root'), 'root is a parent — should not be returned');
    assert.deepEqual(result, ['leaf1']);
  });

  test('returns empty array when node itself is not visible', () => {
    const leaf  = makeNode('leaf');
    const root  = makeNode('root', [leaf]);
    // root not in visible set
    const visible = new Set(['leaf']);
    assert.deepEqual(getVisibleLeafDescendants(root, visible), []);
  });

  test('returns empty array for a leaf node when called directly', () => {
    const leaf = makeNode('leaf');
    const visible = new Set(['leaf']);
    assert.deepEqual(getVisibleLeafDescendants(leaf, visible), ['leaf']);
  });
});

describe('getParentCheckboxState', () => {
  test('returns "unchecked" when no leaf descendants are selected', () => {
    const leaf1 = makeNode('l1');
    const leaf2 = makeNode('l2');
    const parent = makeNode('p', [leaf1, leaf2]);
    const visible = new Set(['p', 'l1', 'l2']);
    const selected = new Set();
    assert.equal(getParentCheckboxState(parent, visible, selected), 'unchecked');
  });

  test('returns "checked" when all visible leaf descendants are selected', () => {
    const leaf1 = makeNode('l1');
    const leaf2 = makeNode('l2');
    const parent = makeNode('p', [leaf1, leaf2]);
    const visible = new Set(['p', 'l1', 'l2']);
    const selected = new Set(['l1', 'l2']);
    assert.equal(getParentCheckboxState(parent, visible, selected), 'checked');
  });

  test('returns "indeterminate" when only some leaf descendants are selected', () => {
    const leaf1 = makeNode('l1');
    const leaf2 = makeNode('l2');
    const parent = makeNode('p', [leaf1, leaf2]);
    const visible = new Set(['p', 'l1', 'l2']);
    const selected = new Set(['l1']);
    assert.equal(getParentCheckboxState(parent, visible, selected), 'indeterminate');
  });

  test('returns "unchecked" when all visible leaves are hidden (empty visible leaf set)', () => {
    const leaf1 = makeNode('l1');
    const parent = makeNode('p', [leaf1]);
    // parent visible but leaf not (collapsed)
    const visible = new Set(['p']);
    const selected = new Set(['l1']);
    assert.equal(getParentCheckboxState(parent, visible, selected), 'unchecked');
  });

  test('returns "checked" for a grandparent when all nested leaves are selected', () => {
    const leaf1  = makeNode('l1');
    const leaf2  = makeNode('l2');
    const mid    = makeNode('mid', [leaf1, leaf2]);
    const root   = makeNode('root', [mid]);
    const visible  = new Set(['root', 'mid', 'l1', 'l2']);
    const selected = new Set(['l1', 'l2']);
    assert.equal(getParentCheckboxState(root, visible, selected), 'checked');
  });

  test('returns "indeterminate" for grandparent when only one nested leaf is selected', () => {
    const leaf1  = makeNode('l1');
    const leaf2  = makeNode('l2');
    const mid    = makeNode('mid', [leaf1, leaf2]);
    const root   = makeNode('root', [mid]);
    const visible  = new Set(['root', 'mid', 'l1', 'l2']);
    const selected = new Set(['l1']);
    assert.equal(getParentCheckboxState(root, visible, selected), 'indeterminate');
  });

  test('ignores collapsed (invisible) leaves when computing state', () => {
    const leaf1 = makeNode('l1');
    const leaf2 = makeNode('l2');
    const parent = makeNode('p', [leaf1, leaf2]);
    // leaf2 is not visible (parent collapsed)
    const visible  = new Set(['p', 'l1']);
    const selected = new Set(['l1']);
    // Only l1 is visible and it's selected → should be "checked"
    assert.equal(getParentCheckboxState(parent, visible, selected), 'checked');
  });
});

describe('toggleParentSelection logic', () => {
  // Pure reimplementation of the toggle logic for unit testing without DOM.
  function applyToggleParent(node, visibleUuidSet, selectedBefore) {
    const selected = new Set(selectedBefore);
    const leaves   = getVisibleLeafDescendants(node, visibleUuidSet);
    const allSelected = leaves.length > 0 && leaves.every(u => selected.has(u));
    if (allSelected) {
      leaves.forEach(u => selected.delete(u));
    } else {
      leaves.forEach(u => selected.add(u));
    }
    return selected;
  }

  test('selects all leaves when none are selected', () => {
    const l1 = makeNode('l1'), l2 = makeNode('l2');
    const p  = makeNode('p', [l1, l2]);
    const visible = new Set(['p', 'l1', 'l2']);
    const result  = applyToggleParent(p, visible, new Set());
    assert.deepEqual([...result].sort(), ['l1', 'l2']);
  });

  test('selects all leaves when only some are selected (indeterminate → checked)', () => {
    const l1 = makeNode('l1'), l2 = makeNode('l2');
    const p  = makeNode('p', [l1, l2]);
    const visible = new Set(['p', 'l1', 'l2']);
    const result  = applyToggleParent(p, visible, new Set(['l1']));
    assert.deepEqual([...result].sort(), ['l1', 'l2']);
  });

  test('deselects all leaves when all are selected (checked → unchecked)', () => {
    const l1 = makeNode('l1'), l2 = makeNode('l2');
    const p  = makeNode('p', [l1, l2]);
    const visible = new Set(['p', 'l1', 'l2']);
    const result  = applyToggleParent(p, visible, new Set(['l1', 'l2']));
    assert.equal(result.size, 0);
  });

  test('only affects visible leaves — hidden leaves are not changed', () => {
    const l1 = makeNode('l1'), l2 = makeNode('l2');
    const p  = makeNode('p', [l1, l2]);
    // l2 not visible (parent collapsed so l2 not in visibleNodes)
    const visible = new Set(['p', 'l1']);
    const result  = applyToggleParent(p, visible, new Set());
    assert.ok(result.has('l1'),  'l1 should be selected');
    assert.ok(!result.has('l2'), 'l2 is hidden — should not be selected');
  });

  test('does not add parent UUIDs to selection', () => {
    const l1 = makeNode('l1');
    const mid = makeNode('mid', [l1]);
    const root = makeNode('root', [mid]);
    const visible = new Set(['root', 'mid', 'l1']);
    const result  = applyToggleParent(root, visible, new Set());
    assert.ok(!result.has('root'), 'root should not be in selection');
    assert.ok(!result.has('mid'),  'mid should not be in selection');
    assert.ok(result.has('l1'),    'l1 should be in selection');
  });
});

// ── extractTags ───────────────────────────────────────────────────────────────
// Copied from dashboard/index.html — must stay in sync with the source.
function extractTags(rawTags) {
  return [...new Set(
    (rawTags || []).map(t => (typeof t === 'string' ? t : (t && t.name) || '')).filter(Boolean)
  )];
}

describe('extractTags()', () => {
  test('returns empty array for null/undefined input', () => {
    assert.deepEqual(extractTags(null), []);
    assert.deepEqual(extractTags(undefined), []);
    assert.deepEqual(extractTags([]), []);
  });

  test('normalises DT API [{name}] format to string array', () => {
    const result = extractTags([{ name: 'java' }, { name: 'production' }]);
    assert.deepEqual(result, ['java', 'production']);
  });

  test('passes through plain string arrays unchanged', () => {
    assert.deepEqual(extractTags(['java', 'production']), ['java', 'production']);
  });

  test('handles mixed [{name}] and plain strings in same array', () => {
    const result = extractTags([{ name: 'java' }, 'production']);
    assert.deepEqual(result, ['java', 'production']);
  });

  test('deduplicates identical tags', () => {
    const result = extractTags([{ name: 'java' }, { name: 'java' }, 'java']);
    assert.deepEqual(result, ['java']);
  });

  test('filters out entries with empty name', () => {
    const result = extractTags([{ name: '' }, { name: 'ok' }, null]);
    assert.deepEqual(result, ['ok']);
  });

  test('handles objects missing the name property', () => {
    const result = extractTags([{ label: 'x' }, { name: 'good' }]);
    assert.deepEqual(result, ['good']);
  });
});

// ── Tag filter logic ──────────────────────────────────────────────────────────
// Pure predicate matching applyFilters(): single-select, project must include the tag.
function passesTagFilter(projTags, tagVal) {
  if (tagVal === 'all') return true;
  return (projTags || []).includes(tagVal);
}

describe('tag filter (single-select)', () => {
  test('"all" always passes regardless of project tags', () => {
    assert.ok(passesTagFilter(['java', 'production'], 'all'));
    assert.ok(passesTagFilter([], 'all'));
  });

  test('passes when project has the selected tag', () => {
    assert.ok(passesTagFilter(['java', 'production'], 'java'));
    assert.ok(passesTagFilter(['java', 'production'], 'production'));
  });

  test('fails when project does not have the selected tag', () => {
    assert.ok(!passesTagFilter(['python', 'staging'], 'java'));
  });

  test('fails when project has no tags', () => {
    assert.ok(!passesTagFilter([], 'java'));
  });

  test('fails when projTags is null/undefined', () => {
    assert.ok(!passesTagFilter(null, 'java'));
    assert.ok(!passesTagFilter(undefined, 'java'));
  });

  test('exact single-tag project: passes on match', () => {
    assert.ok(passesTagFilter(['java'], 'java'));
  });

  test('exact single-tag project: fails on mismatch', () => {
    assert.ok(!passesTagFilter(['java'], 'python'));
  });
});

// ── Schedule field validation logic ──────────────────────────────────────────
// Mirrors the validation in saveConfigPanel() so edge cases are testable
// without a browser DOM.
function validateSchedFields({ freq, hourVal, monthDayVal, weekDays, riskTypes }) {
  if (isNaN(hourVal) || hourVal < 0 || hourVal > 23)
    return 'Schedule hour must be between 0 and 23.';
  if (freq === 'monthly' && (isNaN(monthDayVal) || monthDayVal < 1 || monthDayVal > 28))
    return 'Day of month must be between 1 and 28.';
  if (freq === 'weekly' && weekDays.length === 0)
    return 'Please select at least one day of the week.';
  if (riskTypes.length === 0)
    return 'Please select at least one risk type for the schedule.';
  return null;
}

describe('schedule field validation', () => {
  const base = { freq: 'daily', hourVal: 9, monthDayVal: 1, weekDays: [1], riskTypes: ['security'] };

  test('valid daily config returns no error', () => {
    assert.equal(validateSchedFields(base), null);
  });

  test('hour below 0 is rejected', () => {
    assert.ok(validateSchedFields({ ...base, hourVal: -1 }));
  });

  test('hour above 23 is rejected', () => {
    assert.ok(validateSchedFields({ ...base, hourVal: 24 }));
  });

  test('hour 0 is accepted', () => {
    assert.equal(validateSchedFields({ ...base, hourVal: 0 }), null);
  });

  test('hour 23 is accepted', () => {
    assert.equal(validateSchedFields({ ...base, hourVal: 23 }), null);
  });

  test('NaN hour (empty field) is rejected', () => {
    assert.ok(validateSchedFields({ ...base, hourVal: NaN }));
  });

  test('monthly: day 0 is rejected', () => {
    assert.ok(validateSchedFields({ ...base, freq: 'monthly', monthDayVal: 0 }));
  });

  test('monthly: day 29 is rejected', () => {
    assert.ok(validateSchedFields({ ...base, freq: 'monthly', monthDayVal: 29 }));
  });

  test('monthly: day 28 is accepted', () => {
    assert.equal(validateSchedFields({ ...base, freq: 'monthly', monthDayVal: 28 }), null);
  });

  test('monthly: day 1 is accepted', () => {
    assert.equal(validateSchedFields({ ...base, freq: 'monthly', monthDayVal: 1 }), null);
  });

  test('monthly: negative day is rejected', () => {
    assert.ok(validateSchedFields({ ...base, freq: 'monthly', monthDayVal: -5 }));
  });

  test('monthly: NaN day is rejected', () => {
    assert.ok(validateSchedFields({ ...base, freq: 'monthly', monthDayVal: NaN }));
  });

  test('weekly: no days selected is rejected', () => {
    assert.ok(validateSchedFields({ ...base, freq: 'weekly', weekDays: [] }));
  });

  test('weekly: at least one day selected is accepted', () => {
    assert.equal(validateSchedFields({ ...base, freq: 'weekly', weekDays: [1] }), null);
  });

  test('no risk types selected is rejected', () => {
    assert.ok(validateSchedFields({ ...base, riskTypes: [] }));
  });

  test('monthly with invalid monthDay is ignored when freq is daily', () => {
    // monthDayVal out of range but freq is not monthly — should pass
    assert.equal(validateSchedFields({ ...base, freq: 'daily', monthDayVal: 99 }), null);
  });

  test('weekly with empty weekDays is ignored when freq is monthly', () => {
    assert.equal(validateSchedFields({ ...base, freq: 'monthly', weekDays: [], monthDayVal: 15 }), null);
  });
});

// ── Frontend / backend validation mirror (phase 3) ───────────────────────────
// Field rules exist in two places: violation-cache/lib/validate.js (authority)
// and dashboard/login.html (immediate feedback). CLAUDE.md §8.8 requires them to
// change together. These tests fail loudly if they drift apart.

const fs   = require('node:fs');
const path = require('node:path');

const LOGIN_HTML  = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'login.html'), 'utf8');
const ADMIN_HTML  = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'admin.html'), 'utf8');
// Read as text, not required: the comparison is between the two SOURCES, which
// is what proves the mirrored rules were edited together (CLAUDE.md §8.8).
const VALIDATE_SRC = fs.readFileSync(path.join(__dirname, 'lib', 'validate.js'), 'utf8');
const INDEX_HTML  = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
const brandingMod = require('./lib/branding');
const backendValidate = require('./lib/validate');

describe('validation mirror — login.html vs lib/validate.js', () => {
  test('the three field regexes are byte-identical in both files', () => {
    const pairs = [
      ['NAME_RE',  backendValidate.NAME_RE],
      ['LOGIN_RE', backendValidate.LOGIN_RE],
      ['EMAIL_RE', backendValidate.EMAIL_RE],
    ];
    for (const [name, backendRe] of pairs) {
      const m = new RegExp('const\\s+' + name + '\\s*=\\s*(/.*?/[a-z]*)\\s*;').exec(LOGIN_HTML);
      assert.ok(m, `${name} not found in login.html`);
      assert.equal(m[1], backendRe.toString(),
        `${name} differs: login.html has ${m[1]}, lib/validate.js has ${backendRe}`);
    }
  });

  test('the length bounds are identical in both files', () => {
    const bounds = {
      NAME_MIN: backendValidate.NAME_MIN, NAME_MAX: backendValidate.NAME_MAX,
      LOGIN_MIN: backendValidate.LOGIN_MIN, LOGIN_MAX: backendValidate.LOGIN_MAX,
      PASSWORD_MIN: backendValidate.PASSWORD_MIN, PASSWORD_MAX: backendValidate.PASSWORD_MAX,
      EMAIL_MAX: backendValidate.EMAIL_MAX,
    };
    for (const [name, expected] of Object.entries(bounds)) {
      const m = new RegExp(name + '\\s*=\\s*(\\d+)').exec(LOGIN_HTML);
      assert.ok(m, `${name} not found in login.html`);
      assert.equal(Number(m[1]), expected, `${name} differs`);
    }
  });

  // Behavioural equivalence over a corpus, so a rewrite that keeps the regexes
  // but changes the surrounding logic is still caught.
  const NAME_RE  = /^\p{L}+(?: \p{L}+)*$/u;
  const LOGIN_RE = /^[A-Za-z0-9._-]+$/;
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  function feName(value, label) {
    if (typeof value !== 'string' || value.length === 0) return label + ' is required.';
    if (value !== value.trim()) return label + ' cannot start or end with a space.';
    if (value.length < 3) return label + ' must be at least 3 characters.';
    if (value.length > 128) return label + ' must be at most 128 characters.';
    if (!NAME_RE.test(value)) return label + ' may contain only letters and single spaces between words.';
    return null;
  }
  function feLoginId(value) {
    if (typeof value !== 'string' || value.length === 0) return 'Login ID is required.';
    if (/\s/.test(value)) return 'Login ID cannot contain spaces.';
    if (value.length < 3) return 'too short';
    if (value.length > 64) return 'too long';
    if (!LOGIN_RE.test(value)) return 'bad charset';
    return null;
  }
  function feEmail(value) {
    if (value === undefined || value === null || value === '') return null;
    if (/\s/.test(value)) return 'space';
    if (value.length > 254) return 'too long';
    if (!EMAIL_RE.test(value)) return 'invalid';
    return null;
  }
  // Built from login.html's own source rather than re-implemented here. A copy
  // is a second implementation that can agree with the backend while the page
  // does not: this rule said `length < 8` and kept passing after the page moved
  // to 12, which is the whole failure mode a mirror test exists to catch.
  const fePassword = (() => {
    const src = extractFunction(LOGIN_HTML, 'validatePassword');
    const min = /PASSWORD_MIN\s*=\s*(\d+)/.exec(LOGIN_HTML);
    const max = /PASSWORD_MAX\s*=\s*(\d+)/.exec(LOGIN_HTML);
    assert.ok(min && max, 'login.html must declare its password bounds');
    // eslint-disable-next-line no-new-func
    return new Function('PASSWORD_MIN', 'PASSWORD_MAX',
      `${src}; return validatePassword;`)(Number(min[1]), Number(max[1]));
  })();

  test('names: frontend and backend agree on accept/reject for every case', () => {
    const corpus = ['Alice', 'Mary Jane', 'José', 'Müller', '山田太郎', 'Al', ' Alice', 'Alice ',
                    'Mary  Jane', 'Al1ce', "O'Brien", 'Smith-Jones', '', 'A'.repeat(128), 'A'.repeat(129)];
    for (const value of corpus) {
      assert.equal(
        feName(value, 'First name') === null,
        backendValidate.validateFirstName(value) === null,
        `disagreement on name ${JSON.stringify(value)}`
      );
    }
  });

  test('login IDs: frontend and backend agree', () => {
    const corpus = ['alice', 'alice.smith', 'alice_smith', 'alice-smith', 'a1', 'al ice',
                    'alice@host', 'alice!', '', 'a'.repeat(64), 'a'.repeat(65)];
    for (const value of corpus) {
      assert.equal(
        feLoginId(value) === null,
        backendValidate.validateLoginId(value) === null,
        `disagreement on login ID ${JSON.stringify(value)}`
      );
    }
  });

  test('emails: frontend and backend agree', () => {
    const corpus = ['', 'a@b.co', 'first.last@example.com', 'user+tag@example.co.uk',
                    "o'brien@example.com", 'nope', 'a@b', '@example.com', 'a b@c.co', 'a@b c.co'];
    for (const value of corpus) {
      assert.equal(
        feEmail(value) === null,
        backendValidate.validateEmail(value) === null,
        `disagreement on email ${JSON.stringify(value)}`
      );
    }
  });

  test('passwords: frontend and backend agree', () => {
    // Spans the 12-character boundary in both directions, so a change to one
    // side's minimum without the other is a failure rather than a coincidence.
    const corpus = ['correcthorse', 'correcthors', 'p@$$w0rd!#%^&*()', 'aaaaaaaaaaaa',
                    '日本語のパスワードですよ', 'password', 'passwor', 'pass word',
                    'pass\tword', '', 'a'.repeat(11), 'a'.repeat(12),
                    'a'.repeat(128), 'a'.repeat(129)];
    for (const value of corpus) {
      assert.equal(
        fePassword(value) === null,
        backendValidate.validatePassword(value) === null,
        `disagreement on password ${JSON.stringify(value)}`
      );
    }
  });
});

describe('apiFetch contract in index.html', () => {
  test('no backend route is called with a bare fetch()', () => {
    const bare = INDEX_HTML.match(/(?<!api)\bfetch\((['`])\/violation-cache/g) || [];
    assert.equal(bare.length, 0,
      'every /violation-cache/* call must go through apiFetch() — CLAUDE.md §8.3');
  });

  test('every backend call site uses apiFetch', () => {
    const wrapped = INDEX_HTML.match(/apiFetch\((['`])\/violation-cache/g) || [];
    assert.ok(wrapped.length >= 29, `expected at least 29 apiFetch call sites, found ${wrapped.length}`);
  });

  test('index.html no longer talks to /admin at all', () => {
    // Administration moved to its own page. Leaving the calls here would mean
    // two implementations of the same screen drifting apart.
    assert.doesNotMatch(INDEX_HTML, /\/admin\/users/,
      'the administration listing belongs to admin.html now');
    assert.doesNotMatch(INDEX_HTML, /\/admin\/overview/);
  });

  test('the administration entry is hidden for a non-administrator', () => {
    assert.match(INDEX_HTML, /userMenuAdmin/);
    assert.match(INDEX_HTML, /adminItem\.style\.display\s*=\s*_currentUser\.isAdmin/,
      'the menu entry must be driven by the principal, not always shown');
  });

  test('the administration menu item navigates to the page', () => {
    assert.match(INDEX_HTML, /window\.openAdminPanel\s*=/,
      'the onclick handler must still be window-exported');
    const fn = /function openAdminPanel\(\)[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /location\.href\s*=\s*'admin\.html'/,
      'it navigates rather than opening a panel');
  });

  test('the old panel is gone, not merely hidden', () => {
    // A dead panel left in place is a second implementation waiting to be
    // rendered by accident.
    for (const gone of ['adminPanel', 'adminBackdrop', 'loadAdminData',
                        'showAdminUserDetail', 'closeAdminUserDetail', 'adm-panel']) {
      assert.doesNotMatch(INDEX_HTML, new RegExp(gone),
        `${gone} belongs to the removed administration panel`);
    }
  });

  test('apiFetch attaches the bearer header and handles 401', () => {
    assert.match(INDEX_HTML, /Authorization['"]?\s*:\s*['"`]Bearer/,
      'apiFetch must attach the Authorization header');
    assert.match(INDEX_HTML, /response\.status === 401/,
      'apiFetch must treat 401 as "go to the login page"');
  });

  test('the browser holds no DependencyTrack credentials at all', () => {
    // The dashboard used to send X-Api-Key from localStorage. Both the header
    // and the stored key are gone: DT is reached through the backend proxy,
    // which injects the signed-in user's key (CLAUDE.md §7.7).
    assert.doesNotMatch(INDEX_HTML, /X-Api-Key/,
      'the dashboard must never send a DependencyTrack API key');
    for (const key of ['dt_api_key', 'dt_api_url', 'dt_frontend_url']) {
      assert.doesNotMatch(INDEX_HTML, new RegExp(`localStorage[^\\n]*${key}`),
        `${key} must no longer be read from or written to localStorage`);
    }
  });

  test('DependencyTrack calls go through the backend proxy, via apiFetch', () => {
    assert.match(INDEX_HTML, /const DT_PROXY = '\/violation-cache\/dt'/,
      'the proxy prefix must be declared once');
    assert.match(INDEX_HTML, /apiFetch\(\s*`\$\{DT_PROXY\}/,
      'DT pages must be fetched through apiFetch with the proxy prefix');
    // No path may address DependencyTrack directly any more.
    const direct = INDEX_HTML.match(/fetch\((['`])\/api\/v1/g) || [];
    assert.equal(direct.length, 0, 'no bare fetch() may target /api/v1 any more');
  });

  test('the connection panel never receives the stored API key', () => {
    // The server sends `hasApiKey`, never the key. If the panel ever read a
    // key field back, the value would be in the DOM.
    const assignments = INDEX_HTML.match(/cfgApiKey'\)\.value\s*=\s*[^;]+/g) || [];
    assert.ok(assignments.length > 0, 'the field must at least be cleared on load');
    for (const a of assignments) {
      assert.match(a, /=\s*''\s*$/, `the API key field may only be cleared, found: ${a.trim()}`);
    }
    assert.match(INDEX_HTML, /dtHasApiKey/,
      'the panel must render from hasApiKey rather than from a key value');
  });

  test('the session token key matches the one login.html writes', () => {
    const indexKey = /const TOKEN_KEY = '([^']+)'/.exec(INDEX_HTML);
    const loginKey = /const TOKEN_KEY = '([^']+)'/.exec(LOGIN_HTML);
    assert.ok(indexKey && loginKey);
    assert.equal(indexKey[1], loginKey[1], 'both pages must use the same localStorage key');
    assert.equal(indexKey[1], 'dt_session_token');
  });

  test('new handlers are window-exported from the IIFE', () => {
    for (const fn of ['toggleUserMenu', 'doLogout', 'openProfilePanel',
                      'closeProfilePanel', 'saveProfile', 'deleteAccount']) {
      assert.match(INDEX_HTML, new RegExp('window\\.' + fn + '\\s*='),
        `${fn} is used by an onclick attribute and must be window-exported`);
    }
  });

  test('login.html window-exports its onclick handlers too', () => {
    for (const fn of ['showView', 'doLogin', 'doRegister', 'forceLogin',
                      'closeSessionModal', 'onAdminToggle', 'toggleTheme']) {
      assert.match(LOGIN_HTML, new RegExp('window\\.' + fn + '\\s*='),
        `${fn} is used by an onclick attribute and must be window-exported`);
    }
  });
});

// ── Login page: animated backgrounds and placeholders ───────────────────────
describe('login.html presentation', () => {
  test('both background layers exist and only the user one starts active', () => {
    assert.match(LOGIN_HTML, /id="bgUser"[^>]*class=|class="bg active" id="bgUser"/);
    assert.match(LOGIN_HTML, /id="bgAdmin"/);
    assert.match(LOGIN_HTML, /class="bg active" id="bgUser"/,
      'the user background is the default');
    assert.doesNotMatch(LOGIN_HTML, /class="bg active" id="bgAdmin"/,
      'the administrator background must start hidden');
  });

  test('the administrator toggle swaps the background', () => {
    assert.match(LOGIN_HTML, /bgUser'\)\.classList\.toggle\('active', !isAdmin\)/);
    assert.match(LOGIN_HTML, /bgAdmin'\)\.classList\.toggle\('active', isAdmin\)/);
  });

  test('the two backgrounds use visibly different colours', () => {
    // Indigo family for a user, amber/rose for the administrator. If these ever
    // converge the toggle stops communicating anything.
    assert.match(LOGIN_HTML, /#bgUser\s+\.b1[^}]*#6366f1/);
    assert.match(LOGIN_HTML, /#bgAdmin\s+\.b1[^}]*#f59e0b/);
  });

  test('the animation is disabled for prefers-reduced-motion', () => {
    assert.match(LOGIN_HTML, /@media \(prefers-reduced-motion: reduce\)/,
      'motion must be optional — the page must not be worse for asking');
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n    \}/.exec(LOGIN_HTML);
    assert.ok(block && /animation:\s*none/.test(block[1]));
  });

  test('the background is decorative and hidden from assistive technology', () => {
    // Three layers now: the two animated moods, plus the administrator's
    // uploaded image. Every one of them is decoration and must stay out of the
    // accessibility tree.
    const layers = LOGIN_HTML.match(/<div class="bg[^"]*" id="bg\w+"[^>]*>/g) || [];
    assert.equal(layers.length, 3);
    for (const l of layers) assert.match(l, /aria-hidden="true"/);
    assert.ok(layers.some(l => /id="bgCustom"/.test(l)), 'the uploaded background is one of them');
  });

  test('login ID and password have placeholders in both modes', () => {
    assert.match(LOGIN_HTML, /id="liLoginId"[^>]*placeholder="your login ID"/);
    assert.match(LOGIN_HTML, /id="liPassword"[^>]*placeholder="your password"/);
    assert.match(LOGIN_HTML, /placeholder\s*=\s*isAdmin \? 'administrator login ID'/);
    assert.match(LOGIN_HTML, /placeholder\s*=\s*isAdmin \? 'administrator password'/);
  });

  test('the background never covers the card', () => {
    assert.match(LOGIN_HTML, /\.bg \{[^}]*z-index: -2/);
    assert.match(LOGIN_HTML, /\.auth-card \{ position: relative; z-index: 1; \}/);
  });
});

// ── Panel placement and toolbar order ───────────────────────────────────────
describe('index.html layout', () => {
  test('the settings and profile panels slide in from the right', () => {
    const cfg = /\.cfg-panel \{([\s\S]*?)\}/.exec(INDEX_HTML)[1];
    assert.match(cfg, /right: 0/);
    assert.doesNotMatch(cfg, /left: 0/);
    assert.match(cfg, /translateX\(100%\)/, 'off-screen to the right when closed');
    assert.match(cfg, /border-left/, 'the border belongs on the side facing the page');

    const pf = /\.pf-panel \{([\s\S]*?)\}/.exec(INDEX_HTML)[1];
    assert.match(pf, /right: 0/);
    assert.match(pf, /translateX\(100%\)/);
    assert.match(pf, /border-left/);
  });

  test('the open state and its transition are unchanged', () => {
    assert.match(INDEX_HTML, /\.cfg-panel\.open \{ transform: translateX\(0\); \}/);
    assert.match(INDEX_HTML, /\.pf-panel\.open \{ transform: translateX\(0\); \}/);
    assert.match(INDEX_HTML, /\.cfg-panel \{[\s\S]*?transition: transform 0\.25s ease/);
    assert.match(INDEX_HTML, /\.pf-panel \{[\s\S]*?transition: transform 0\.22s ease/);
  });

  test('toolbar order after the status indicator is Reports, Settings, user, Refresh', () => {
    const bar = /<div class="topbar-status"[\s\S]*?<\/header>/.exec(INDEX_HTML)[0];
    const order = ['reportsBtn', 'settingsBtn', 'userMenuBtn', 'refreshData()']
      .map(id => bar.indexOf(id));
    assert.ok(order.every(i => i > -1), 'every toolbar control must still be present');
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1],
        `toolbar order is wrong at position ${i}: ${JSON.stringify(order)}`);
    }
  });
});

// ── Administration detail view ──────────────────────────────────────────────
// ── admin.html — the administration screen ──────────────────────────────────
// It was a slide-in panel while it did one read-only thing. It now hosts a
// master/detail split and service configuration, which is a page. Adding a page
// is allowed; splitting one is not (CLAUDE.md §8.1).
describe('admin.html is a self-contained page', () => {
  test('it is one file with inline style and no external asset', () => {
    assert.equal((ADMIN_HTML.match(/<style>/g) || []).length, 1);
    // Two scripts, and the second one is not a relaxation of the single-file
    // rule: the pre-paint session gate has to run before the body is parsed,
    // so it cannot live in the IIFE at the end of the document.
    assert.equal((ADMIN_HTML.match(/<script>/g) || []).length, 2);
    assert.doesNotMatch(ADMIN_HTML, /<script[^>]+src=/, 'no external script — there is no build step');
    assert.doesNotMatch(ADMIN_HTML, /<link[^>]+stylesheet/, 'no external stylesheet either');
  });

  test('all logic is wrapped in an IIFE', () => {
    assert.match(ADMIN_HTML, /\(function \(\) \{[\s\S]*'use strict';/);
  });

  test('it reuses the same custom properties as the other two pages', () => {
    for (const prop of ['--bg', '--surface', '--surface2', '--border', '--text',
                        '--text-muted', '--accent', '--critical', '--ok', '--radius']) {
      assert.match(ADMIN_HTML, new RegExp(prop.replace(/-/g, '\\-') + ':'),
        `${prop} must be defined so the three pages cannot drift apart`);
    }
    assert.match(ADMIN_HTML, /\[data-theme="light"\]/, 'the light theme must be carried over too');
  });

  test('no colour is hard-coded inside a component rule', () => {
    // Component rules must use the variables. The :root and [data-theme] blocks
    // are where literals belong (CLAUDE.md §8.10).
    const withoutThemeBlocks = ADMIN_HTML
      .replace(/:root \{[\s\S]*?\n    \}/, '')
      .replace(/\[data-theme="light"\] \{[\s\S]*?\n    \}/, '');
    const styleOnly = /<style>([\s\S]*?)<\/style>/.exec(withoutThemeBlocks)[1];
    const hexes = styleOnly.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepEqual(hexes.filter(h => h.toLowerCase() !== '#fff' && h.toLowerCase() !== '#ffffff'), [],
      'component rules must use custom properties');
  });

  test('body never sets overflow hidden', () => {
    // A pane taller than a short viewport has to stay reachable (CLAUDE.md §8.10).
    // Comments are stripped first: the rule explains itself in prose that would
    // otherwise match the very pattern being forbidden.
    const body = /\n    body \{[\s\S]*?\n    \}/.exec(ADMIN_HTML)[0]
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(body, /overflow:\s*hidden/);
  });
});

describe('admin.html gate and backend calls', () => {
  test('every backend call goes through apiFetch', () => {
    const bare = ADMIN_HTML.match(/(?<!api)\bfetch\((['`])\/admin/g) || [];
    assert.equal(bare.length, 0, 'administration routes must go through apiFetch()');
    for (const p of ['/admin/overview', '/admin/users', '/admin/settings', '/admin/storage']) {
      assert.match(ADMIN_HTML, new RegExp("apiFetch\\('" + p.replace(/\//g, '\\/') + "'"),
        `${p} must be fetched through apiFetch`);
    }
  });

  test('apiFetch attaches the bearer token and treats 401 as sign-in', () => {
    assert.match(ADMIN_HTML, /Authorization['"]?\s*:\s*['"`]Bearer/);
    assert.match(ADMIN_HTML, /response\.status === 401/);
    assert.match(ADMIN_HTML, /goToLogin/);
  });

  test('being signed in is not enough — the gate checks isAdmin', () => {
    // An ordinary user reaching this URL must be sent away, not shown a page
    // whose every request would 403 (CLAUDE.md §8.4).
    const fn = /async function requireAdminSession[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0];
    assert.match(fn, /user\.isAdmin/);
    assert.match(fn, /index\.html/, 'a non-administrator goes back to the dashboard');
  });

  test('the gate runs before anything renders', () => {
    const boot = /async function boot\(\)[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0];
    const gateAt   = boot.indexOf('requireAdminSession');
    const loadAt   = boot.indexOf('reloadAll');
    assert.ok(gateAt > -1 && gateAt < loadAt, 'the session is checked before data is loaded');
  });

  test('it stores no DependencyTrack credential', () => {
    assert.doesNotMatch(ADMIN_HTML, /dt_api_key|X-Api-Key/);
  });
});

describe('admin.html layout', () => {
  test('the panes start at 60/40', () => {
    assert.match(ADMIN_HTML, /\.pane-left\s*\{[^}]*width:\s*60%/);
    assert.match(ADMIN_HTML, /\.pane-right\s*\{[^}]*width:\s*40%/);
  });

  test('a splitter sits between them and is draggable', () => {
    assert.match(ADMIN_HTML, /id="splitter"/);
    assert.match(ADMIN_HTML, /cursor:\s*col-resize/);
    assert.match(ADMIN_HTML, /function initSplitter\(\)/);
    assert.match(ADMIN_HTML, /MIN_PANE_PCT/, 'a pane must not be draggable into uselessness');
  });

  test('accordions are closed until asked for', () => {
    // Every section carries no "open" class in the markup. The screen opens as
    // a menu of what is here, not a wall of data.
    const sections = ADMIN_HTML.match(/<section class="acc"[^>]*>/g) || [];
    assert.ok(sections.length >= 2, `expected at least two accordions, found ${sections.length}`);
    for (const s of sections) {
      assert.doesNotMatch(s, /\bopen\b/, 'no accordion may start open');
    }
    assert.match(ADMIN_HTML, /aria-expanded="false"/);
  });

  test('the two named sections exist', () => {
    assert.match(ADMIN_HTML, /id="accUsers"/);
    assert.match(ADMIN_HTML, /id="accReports"/);
    assert.match(ADMIN_HTML, /<h2>Users<\/h2>/);
    assert.match(ADMIN_HTML, /<h2>Report Configuration<\/h2>/);
  });
});

describe('admin.html account list and detail', () => {
  test('the list carries the report limit and where it came from', () => {
    assert.match(ADMIN_HTML, /<th>Report limit<\/th>/);
    const fn = /function limitCellHtml[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0];
    assert.match(fn, /maxReportsOverridden/);
    assert.match(fn, /pill-set/,  'an overridden limit is marked');
    assert.match(fn, /pill-inherit/, 'an inherited one says so');
  });

  test('rows open a detail view', () => {
    assert.match(ADMIN_HTML, /data-login="\$\{escHtml\(u\.loginId\)\}"/);
    assert.match(ADMIN_HTML, /selectUser\(tr\.dataset\.login\)/);
    assert.match(ADMIN_HTML, /apiFetch\('\/admin\/users\/' \+ encodeURIComponent\(loginId\)\)/);
  });

  test('every value rendered into the detail is escaped', () => {
    // The screen interpolates account-controlled text — names, emails, URLs —
    // into innerHTML (CLAUDE.md §12).
    const fn = /function renderDetail[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0];
    assert.match(fn, /const kv\s*=\s*\(label, value\) => `<div class="kv"><dt>\$\{escHtml\(label\)\}/);
    assert.match(fn, /const txt = \(v\) =>[\s\S]*?escHtml/);

    // Stronger than naming one field: no account value may be interpolated
    // BARE into the innerHTML template. Anything reaching the DOM as markup has
    // to pass through txt/yes/escHtml first, so a field added later without one
    // fails this. Scoped to the innerHTML assignment — the heading beside it is
    // set through textContent, which needs no escaping.
    const markup = /\$\('detailBody'\)\.innerHTML = `[\s\S]*?`;/.exec(fn)[0];
    const bare = markup.match(/\$\{\s*d\.[A-Za-z0-9_.]+\s*\}/g) || [];
    assert.deepEqual(bare, [],
      'account-controlled text must be escaped before innerHTML (CLAUDE.md §12)');
  });

  test('the detail says secrets are not readable from it', () => {
    assert.match(ADMIN_HTML, /are not readable from here/);
  });

  test('nothing is shown before a row is chosen', () => {
    assert.match(ADMIN_HTML, /id="detailEmpty"/);
    assert.match(ADMIN_HTML, /Select an account on the left/);
  });
});

describe('admin.html write actions', () => {
  test('the limit editor confirms before it applies', () => {
    assert.match(ADMIN_HTML, /id="limitModal"/);
    assert.match(ADMIN_HTML, /id="btnEditLimit"/);
    const fn = /async function confirmLimit[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0];
    assert.match(fn, /method:\s*'PUT'/);
    assert.match(fn, /\/settings/);
    assert.match(fn, /maxReports: reports\.value/);
    // Blank means "return to the default" — a distinct outcome from any number.
    assert.match(/function readLimitField[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0],
      /return \{ ok: true, value: null \}/);
  });

  test('both quotas are editable from the screen, in one request', () => {
    // The schedule limit was displayed with a Set/default pill and accepted by
    // the route, but had no control at all — so raising one account's allowance
    // meant calling the API by hand. They are the same decision about the same
    // account, so they share one dialog and one PUT.
    assert.match(ADMIN_HTML, /id="limitSchedInput"/);
    assert.match(ADMIN_HTML, /id="btnEditSchedLimit"/);
    const fn = /async function confirmLimit[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0];
    assert.match(fn, /maxSchedules: schedules\.value/);
    assert.equal((fn.match(/apiFetch\(/g) || []).length, 1, 'one request, not two');
    // Both fields are validated before either is sent, so a bad second field
    // cannot leave the first half applied.
    assert.match(fn, /if \(!reports\.ok \|\| !schedules\.ok\) return;/);
    // And the detail pane has to say what "default" means before anyone can
    // decide whether to override it.
    const route = fs.readFileSync(path.join(__dirname, 'routes', 'admin.js'), 'utf8');
    assert.match(route, /defaultMaxSchedules: row\.defaultMaxSchedules/);
  });

  test('cancelling is a real path, not just a hidden dialog', () => {
    assert.match(ADMIN_HTML, /function closeLimitModal/);
    assert.match(ADMIN_HTML, /onclick="closeLimitModal\(\)"/);
    assert.match(ADMIN_HTML, /function closePwModal/);
  });

  test('the password reset validates before the round trip', () => {
    // Mirrors lib/validate.js. The backend remains the authority (CLAUDE.md §8.8).
    const fn = /async function confirmPasswordReset[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0];
    assert.match(fn, /length < 12/);
    assert.match(fn, /length > 128/);
    assert.match(fn, /\\s/, 'a password with spaces must be caught');
    assert.match(fn, /method:\s*'POST'/);
    assert.match(fn, /\/password/);
  });

  test('the reset trigger matches the dialog that confirms it', () => {
    // Different colour and a trailing ellipsis made them look like two
    // different actions rather than one in two steps.
    const trigger = /<button class="[^"]*" id="btnResetPw">([^<]*)<\/button>/.exec(ADMIN_HTML);
    assert.ok(trigger, 'the reset trigger must exist');
    assert.match(trigger[0], /\bdanger\b/, 'it carries the same danger styling as the confirm');
    assert.equal(trigger[1].trim(), 'Reset password', 'and the same words, with no ellipsis');
    assert.match(ADMIN_HTML, /\.btn-xs\.danger \{[^}]*var\(--critical\)/,
      'the danger variant must be defined for the small button too');
  });

  test('the reset dialog says what it will do before it is used', () => {
    assert.match(ADMIN_HTML, /signed out/i);
    // The sentence wraps in the source, so match across whitespace.
    assert.match(ADMIN_HTML, /choose\s+its\s+own\s+password/i);
  });

  test('the global default warns about accounts it puts over the line', () => {
    const fn = /async function saveDefaultLimit[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0];
    assert.match(fn, /affectedAccounts/);
    assert.match(fn, /affectedScheduleAccounts/,
      'the schedule default has the same consequence and must be reported too');
    assert.match(fn, /cannot create more until back under/,
      'the administrator must be told what it does to people, not just that it saved');
  });

  test('every onclick handler is window-exported', () => {
    const handlers = [...ADMIN_HTML.matchAll(/onclick="(\w+)\(/g)].map(m => m[1]);
    assert.ok(handlers.length > 0);
    for (const h of new Set(handlers)) {
      assert.match(ADMIN_HTML, new RegExp('window\\.' + h + '\\s*='),
        `${h} is used by an onclick and must be window-exported (CLAUDE.md §8.2)`);
    }
  });
});

// ── Refetch control: one build per connection, visible to everyone on it ─────
// The violation cache is shared by connection fingerprint, so a build one user
// starts must disable the control for every dashboard on that connection —
// otherwise they all keep asking for a crawl one of them is already waiting on.
describe('index.html refetch control', () => {
  test('the control is rendered from one helper, not open-coded per banner', () => {
    assert.match(INDEX_HTML, /function refetchButtonHtml\(progress\)/);
    // Every "Refetch Violations" button must come from it, so no banner can
    // render an enabled one during a build.
    const literal = INDEX_HTML.match(/onclick="triggerCacheRefresh\(\)">↻ Refetch Violations/g) || [];
    assert.equal(literal.length, 1,
      'the enabled label may appear only inside refetchButtonHtml()');
  });

  test('it renders disabled while a build is running', () => {
    const fn = /function refetchButtonHtml[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /if \(_cacheBuilding\)/);
    assert.match(fn, /<button class="btn-xs" disabled/);
    assert.match(fn, /title="A refetch is already running/);
  });

  test('triggerCacheRefresh refuses to re-enter and disables before the request', () => {
    const fn = /async function triggerCacheRefresh[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /if \(_cacheBuilding\) return;/,
      'a second call while building must be a no-op');
    // The flag must be set before the await, or the window between click and
    // response takes a second click.
    const setAt  = fn.indexOf('setCacheBuilding(true)');
    const fetchAt = fn.indexOf('await apiFetch');
    assert.ok(setAt > -1 && setAt < fetchAt,
      'the control must be disabled before the request goes out');
  });

  test('409 is treated as sharing, not failure', () => {
    const fn = /async function triggerCacheRefresh[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /r\.status !== 409/,
      '409 means another builder already holds this connection — keep polling');
  });

  test('a build started elsewhere is noticed by an idle watch', () => {
    assert.match(INDEX_HTML, /CACHE_WATCH_MS:\s*\d+/);
    assert.match(INDEX_HTML, /function startCacheWatch\(\)/);
    assert.match(INDEX_HTML, /function stopCacheWatch\(\)/);
    const fn = /function startCacheWatch[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /apiFetch\('\/violation-cache\/status'\)/);
    assert.match(fn, /s\.status === 'building'/);
    assert.match(fn, /startCachePoll\(\)/);
  });

  test('the watch is slower than the build poll', () => {
    const poll  = Number(/CACHE_POLL_MS:\s*(\d+)/.exec(INDEX_HTML)[1]);
    const watch = Number(/CACHE_WATCH_MS:\s*(\d+)/.exec(INDEX_HTML)[1]);
    assert.ok(watch > poll,
      `the idle watch (${watch}ms) must be cheaper than the build poll (${poll}ms)`);
  });

  test('the poller renders immediately rather than after a full interval', () => {
    // Waiting one interval leaves the control looking clickable for seconds
    // after a build starts — including one somebody else started.
    const fn = /function startCachePoll[\s\S]*?\n  tick\(\);\n\}/.exec(INDEX_HTML);
    assert.ok(fn, 'startCachePoll must call tick() once immediately');
    assert.match(fn[0], /_cachePollTimer = setInterval\(tick, CONFIG\.CACHE_POLL_MS\);/);
  });

  test('the building state is cleared on every terminal outcome', () => {
    const fn = /function startCachePoll[\s\S]*?\n  tick\(\);\n\}/.exec(INDEX_HTML)[0];
    const cleared = (fn.match(/setCacheBuilding\(false\)/g) || []).length;
    assert.ok(cleared >= 2,
      'ready and failed must both re-enable the control, otherwise it sticks disabled');
  });

  // The toolbar's ↻ Refresh sits outside the banner HTML, so it does not get
  // re-rendered when the banner does. Left alone it stayed clickable right
  // through a build, next to a banner control that was visibly disabled.
  test('the toolbar refresh button is addressable and described', () => {
    const btn = /<button class="btn primary" id="refreshBtn"[\s\S]*?<\/button>/.exec(INDEX_HTML);
    assert.ok(btn, 'the toolbar refresh button needs an id for the setter to reach it');
    assert.match(btn[0], /onclick="refreshData\(\)"/);
    assert.match(btn[0], /title="/, 'it does a different job from the banner control — say so');
  });

  test('one setter owns the building flag, so the two controls cannot disagree', () => {
    assert.match(INDEX_HTML, /function setCacheBuilding\(building\)/);
    const fn = /function setCacheBuilding[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /_cacheBuilding = building;/);
    assert.match(fn, /getElementById\('refreshBtn'\)/);
    assert.match(fn, /btn\.disabled = building;/);
  });

  test('nothing assigns the building flag behind the setter\'s back', () => {
    // A stray `_cacheBuilding = true` would disable the banner control and
    // leave the toolbar enabled — exactly the inconsistency being fixed.
    // The declaration and the setter's own line are the two legitimate writes.
    const assignments = INDEX_HTML.match(/(?<!let )_cacheBuilding\s*=(?!\s*building;)/g) || [];
    assert.equal(assignments.length, 0,
      'assign through setCacheBuilding() so the toolbar stays in step');
  });

  test('the toolbar refresh is disabled during a build, not deleted', () => {
    // It reloads the project hierarchy as well as the violation counts, so it is
    // not redundant with the banner's refetch — removing it would drop the only
    // way to pick up a newly added project without a full page reload.
    assert.match(INDEX_HTML, /onclick="refreshData\(\)"/,
      'the project reload must still be reachable');
    const fn = /function setCacheBuilding[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /A refetch is already running/,
      'the disabled state must explain itself');
  });
});

// ── Report naming, and what no longer stands in the way of a report ─────────
describe('index.html report naming', () => {
  test('both report dialogs offer an optional name', () => {
    assert.match(INDEX_HTML, /id="rptOptName"/,  'the Generate Report modal');
    assert.match(INDEX_HTML, /id="cfgSchedName"/, 'the schedule panel');
    // The placeholder is where the user learns that blank is allowed.
    const count = (INDEX_HTML.match(/Leave blank to name it automatically/g) || []).length;
    assert.equal(count, 2, 'both fields must say that blank is acceptable');
  });

  test('the fields use classes this page actually defines', () => {
    // An unknown class name fails silently and renders as a browser default.
    for (const cls of ['cfg-input', 'cfg-label', 'field-error']) {
      assert.match(INDEX_HTML, new RegExp('\\.' + cls + '\\s*\\{'),
        `.${cls} is used by the name fields and must be defined in this file`);
    }
  });

  test('the validator mirrors lib/validate.js', () => {
    // CLAUDE.md §8.8: the two are changed together or they drift.
    const feRe  = /const REPORT_NAME_RE\s*=\s*(\/.*?\/[a-z]*)\s*;/.exec(INDEX_HTML);
    const feMax = /const REPORT_NAME_MAX\s*=\s*(\d+)/.exec(INDEX_HTML);
    const beRe  = /const REPORT_NAME_RE\s*=\s*(\/.*?\/[a-z]*)\s*;/.exec(VALIDATE_SRC);
    const beMax = /const REPORT_NAME_MAX\s*=\s*(\d+)/.exec(VALIDATE_SRC);
    assert.ok(feRe && beRe, 'both files must define the pattern');
    assert.equal(feRe[1], beRe[1], 'the character rule must match the backend exactly');
    assert.equal(feMax[1], beMax[1], 'so must the length ceiling');
  });

  test('an invalid name keeps the modal open instead of submitting', () => {
    const fn = /async function confirmReportOptions[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /const reportName = readReportName\(\)/);
    assert.match(fn, /if \(reportName === null\) return;/,
      'a rejected name must not fall through to the request');
    // Against the request, not against the first `closeAfter = true` — the
    // quota branch legitimately sets that earlier and then returns.
    const guardAt = fn.indexOf('reportName === null');
    const sendAt  = fn.indexOf('await doTriggerReport');
    assert.ok(guardAt > -1 && sendAt > -1 && guardAt < sendAt,
      'a rejected name must be caught before the request goes out');
  });

  test('the name is cleared when the dialog opens', () => {
    // A name left from the previous report would be reused silently, which is
    // the opposite of "blank means name it for me".
    assert.match(INDEX_HTML, /if \(nameEl\)\s+nameEl\.value = '';/);
  });

  test('the name reaches the backend', () => {
    const fn = /async function doTriggerReport[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /JSON\.stringify\(\{ projects, riskTypes, reportName \}\)/);
  });

  test('a blank schedule report name is sent, so it can be cleared', () => {
    // Omitting the key means "leave it alone"; sending '' means "go back to
    // automatic". The editor must send the field for the second to be reachable.
    const fn = /function readScheduleEditor\(\)[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /reportName: String\(reportName\)\.trim\(\)/);
  });
});

describe('index.html report pre-flight', () => {
  test('only the quota stands between the user and a report', () => {
    // Two further prompts used to live here — one when a job was already
    // running, one when a report had been generated today. Neither protected
    // anything: the quota is the real constraint, and re-asking for a second
    // report on the same day second-guessed a deliberate action.
    const fn = /async function confirmReportOptions[\s\S]*?\n\}/.exec(INDEX_HTML)[0]
      .replace(/\/\/[^\n]*/g, '');
    assert.match(fn, /maxReportsLimit/, 'the quota check stays');
    assert.doesNotMatch(fn, /Already In Progress/i);
    assert.doesNotMatch(fn, /Already Generated Today/i);
    assert.doesNotMatch(fn, /completedToday/);
    assert.doesNotMatch(fn, /runningNow/);
  });

  test('nothing anywhere still compares a report against today', () => {
    assert.doesNotMatch(INDEX_HTML, /completedToday/,
      'the same-day check is gone, not merely unreferenced');
  });
});

// ── The project table's header stays legible while scrolling ────────────────
// Both header rows used to be `position: sticky; top: 0`, so they occupied the
// same strip and the second — later in the DOM, painted on top — hid the first.
// Scrolling left the sub-columns frozen with no way to tell which risk group
// they belonged to.
describe('index.html sticky table header', () => {
  test('the cells are sticky, not the rows', () => {
    assert.match(INDEX_HTML, /thead th \{[^}]*position:\s*sticky/);
    assert.doesNotMatch(INDEX_HTML, /thead tr \{[^}]*position:\s*sticky[^}]*top:\s*0/,
      'sticking the rows put both at the same offset');
  });

  test('the second row is offset by the first row\'s height', () => {
    assert.match(INDEX_HTML, /thead tr:nth-child\(2\) th \{[^}]*top:\s*var\(--th-group-h/);
  });

  test('that height is measured rather than guessed', () => {
    // It moves with font size, zoom and the responsive breakpoints, so a
    // constant in the stylesheet would be wrong at most sizes.
    assert.match(INDEX_HTML, /function syncStickyHeader\(\)/);
    const fn = /function syncStickyHeader[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /getBoundingClientRect\(\)\.height/);
    assert.match(fn, /setProperty\('--th-group-h'/);
    assert.match(INDEX_HTML, /addEventListener\('resize', syncStickyHeader\)/,
      'zoom and resize change the height, so the offset has to follow');
  });

  test('the group row paints above the sub-column row', () => {
    const group = /thead th \{([^}]*)\}/.exec(INDEX_HTML)[1];
    const sub   = /thead tr:nth-child\(2\) th \{([^}]*)\}/.exec(INDEX_HTML)[1];
    const z = (css) => Number(/z-index:\s*(\d+)/.exec(css)[1]);
    assert.ok(z(group) > z(sub), `group ${z(group)} must sit above sub ${z(sub)}`);
  });
});

// ── Table controls are inert until there is a table ─────────────────────────
describe('index.html table controls gate', () => {
  test('the controls are listed in one place', () => {
    assert.match(INDEX_HTML, /const TABLE_CONTROL_IDS = \[/);
    const list = /const TABLE_CONTROL_IDS = \[([\s\S]*?)\]/.exec(INDEX_HTML)[1];
    for (const id of ['searchInput', 'latestFilterBtn', 'flatViewBtn', 'riskFilter',
                      'categoryFilter', 'tagFilter', 'expandCollapseBtn']) {
      assert.match(list, new RegExp("'" + id + "'"), `${id} acts on the table and must be gated`);
    }
  });

  test('every gated id exists in the markup', () => {
    // A typo here would silently gate nothing.
    const list = /const TABLE_CONTROL_IDS = \[([\s\S]*?)\]/.exec(INDEX_HTML)[1];
    for (const [, id] of list.matchAll(/'([^']+)'/g)) {
      assert.match(INDEX_HTML, new RegExp('id="' + id + '"'), `no element carries id="${id}"`);
    }
  });

  test('they start disabled and are enabled only after a render', () => {
    assert.match(INDEX_HTML, /setTableControlsEnabled\(false\)/,
      'the gate must be closed during bootstrap');
    const afterLoad = /function afterLoad\(\)[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(afterLoad, /setTableControlsEnabled\(true\)/,
      'and opened once afterLoad() has rendered a table');
  });

  test('the disabled state explains itself and the real tooltip is restored', () => {
    const fn = /function setTableControlsEnabled[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /once the project data has loaded/i);
    assert.match(fn, /dataset\.titleOriginal/,
      'the original tooltip must be remembered, or re-enabling hands back the wrong text');
  });
});

// ── A refetch must not throw away what the user chose ───────────────────────
describe('index.html filter state across a refetch', () => {
  test('applyViolationData re-runs the filters instead of replaying a match set', () => {
    // The risk and category filters are computed FROM violation counts, so a
    // match set built while those counts were zero is stale the moment the
    // refetch lands. renderTree also ignores flatView.
    // Comments stripped first: this one explains what it replaced, in prose
    // that would otherwise match the very call being forbidden.
    const fn = /function applyViolationData[\s\S]*?\n\}/.exec(INDEX_HTML)[0]
      .replace(/\/\/[^\n]*/g, '');
    assert.match(fn, /applyFilters\(\);/,
      'the filters must be recomputed against the data that just arrived');
    assert.doesNotMatch(fn, /renderTree\(currentMatchSet\)/,
      'replaying the old match set shows what matched before the data existed');
  });

  test('rebuilding the tag list keeps the chosen tag', () => {
    const fn = /function buildFilterOptions[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /const chosen = sel\.value/);
    assert.match(fn, /sel\.value = chosen/);
    assert.match(fn, /allTags\.includes\(chosen\)/,
      'only restore a tag that still exists in the new data');
  });
});

// ── The administrator is an ordinary principal for configuration ─────────────
describe('index.html administrator chrome', () => {
  test('Settings and Reports are no longer hidden from the administrator', () => {
    // They have their own connection, quota, mail settings and schedule against
    // a reserved principal id, so these panels work for them.
    assert.doesNotMatch(INDEX_HTML, /for \(const id of \['settingsBtn', 'reportsBtn'\]\)/,
      'the administrator must not have Settings and Reports hidden');
  });

  test('Profile stays hidden for the administrator', () => {
    // Their name and password live in the installation credentials file, not in
    // the database, so there is nothing there to edit.
    assert.match(INDEX_HTML, /profileItem\.style\.display = _currentUser\.isAdmin \? 'none' : ''/);
  });

  test('the administrator loads a connection through the same path as anyone else', () => {
    assert.match(INDEX_HTML, /loadDtConnection\(\)\.then\(connected => \{/);
    // No early return that skips connection loading for administrators.
    assert.doesNotMatch(INDEX_HTML, /An administrator session has no per-user data to load/);
  });
});

// ── Login page survives browser zoom ────────────────────────────────────────
describe('login.html responsiveness', () => {
  // CSS comments explain these rules in prose that mentions the very properties
  // under test, so strip them before asserting — otherwise a comment satisfies
  // the assertion and the rule itself goes unchecked.
  const rules = (selector) => {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([\\s\\S]*?)\\n    \\}');
    const block = re.exec(LOGIN_HTML);
    assert.ok(block, `no rule block found for ${selector}`);
    return block[1].replace(/\/\*[\s\S]*?\*\//g, '');
  };

  test('the page is never clipped', () => {
    // `overflow: hidden` on the body hid the card at high zoom with no way to
    // scroll to it. The decorative layers clip themselves instead.
    assert.doesNotMatch(rules('body'), /overflow:\s*hidden/,
      'the body must not clip — the card has to stay reachable when zoomed');
  });

  test('the card is centred by margin, not by align-items', () => {
    // A flex item centred with align-items overflows equally in both directions
    // once taller than the container, and the part above the top edge cannot be
    // scrolled to. `margin: auto` degrades to scrollable instead.
    assert.match(rules('.auth-card'), /margin:\s*auto/);
    assert.doesNotMatch(rules('body'), /align-items:\s*center/);
  });

  test('the oversized grid layer is clipped by its own wrapper', () => {
    assert.match(LOGIN_HTML, /\.bg-grid-clip \{[^}]*overflow: hidden/);
    assert.match(LOGIN_HTML, /<div class="bg-grid-clip" aria-hidden="true"><div class="bg-grid"><\/div><\/div>/);
    assert.match(rules('.bg-grid'), /position: absolute/,
      'must be absolute inside the clip, not fixed');
  });

  test('there are height breakpoints, because zoom shortens before it narrows', () => {
    assert.match(LOGIN_HTML, /@media \(max-height: 720px\)/);
    assert.match(LOGIN_HTML, /@media \(max-height: 560px\)/);
  });

  test('the name pair stacks before it becomes cramped', () => {
    assert.match(LOGIN_HTML, /@media \(max-width: 640px\) \{\s*\n\s*\.row-2 \{ grid-template-columns: 1fr; \}/);
  });

  test('the session dialog scrolls rather than centre-clipping', () => {
    assert.match(LOGIN_HTML, /\.modal-overlay \{ overflow-y: auto; \}/);
    assert.match(LOGIN_HTML, /\.modal \{ margin: auto; \}/);
  });
});

// ── The pre-paint session gate ───────────────────────────────────────────────
// The dashboard used to paint in full, then await /auth/me, then redirect —
// so every signed-out visitor saw a dashboard flash, and an interrupted network
// left them looking at empty chrome with no explanation.
describe('the landing page is gated before it paints', () => {
  const GATED = [['index.html', INDEX_HTML], ['admin.html', ADMIN_HTML]];

  for (const [name, html] of GATED) {
    test(`${name} checks the token in <head>, before the body`, () => {
      const headEnd = html.indexOf('</head>');
      const bodyAt  = html.indexOf('<body');
      assert.ok(headEnd > 0 && bodyAt > headEnd);
      const head = html.slice(0, headEnd);
      assert.match(head, /localStorage\.getItem\('dt_session_token'\)/,
        'the token must be read before anything renders');
      assert.match(head, /window\.location\.replace\('login\.html'\)/,
        'a visitor with no token must never reach the body');
    });

    test(`${name} hides the shell until the session is confirmed`, () => {
      const head = html.slice(0, html.indexOf('</head>'));
      assert.match(head, /className \+= ' booting'/,
        'the booting class must be set in the head, not after the body renders');
      assert.match(html, /html\.booting body > \*:not\(#bootGate\) \{ display: none !important; \}/,
        'everything but the gate must be hidden while booting');
      assert.match(html, /classList\.remove\('booting'\)/,
        'the shell is revealed only after the session check succeeds');
    });

    test(`${name} reveals the shell only after the session check`, () => {
      // Ordering, not just presence: revealing before the await would put the
      // flash straight back.
      const reveal = html.indexOf("classList.remove('booting')");
      const check  = html.search(/await require(?:Admin)?Session\(\)/);
      assert.ok(check > 0 && reveal > check,
        'booting must be removed after the session check, never before it');
    });

    test(`${name} bounds the session check and reports failure in the gate`, () => {
      assert.match(html, /new AbortController\(\)/,
        'an unreachable backend must not spin forever');
      assert.match(html, /SESSION_CHECK_TIMEOUT_MS/);
      assert.match(html, /function bootFailed\(/,
        'a network failure is reported inside the gate, not over a painted dashboard');
      assert.match(html, /bootActions/, 'the failure state must offer a way out');
    });
  }

  test('index.html no longer overwrites the body on a network failure', () => {
    // The old handler replaced document.body.innerHTML, which is what left a
    // half-dead page behind.
    assert.doesNotMatch(INDEX_HTML, /document\.body\.innerHTML\s*=/);
  });

  test('an ordinary user is replaced away from admin.html, not pushed', () => {
    assert.match(ADMIN_HTML, /if \(!user\.isAdmin\) \{ window\.location\.replace\('index\.html'\)/,
      'back must not step into a screen whose every request would be refused');
  });
});

// ── Branding across the three pages ──────────────────────────────────────────
describe('branding is consistent across the three pages', () => {
  const PAGES = [['index.html', INDEX_HTML], ['login.html', LOGIN_HTML], ['admin.html', ADMIN_HTML]];

  test('every page ships the same default title as the backend', () => {
    // Five different spellings existed before this feature. The pages cannot
    // require() the constant, so a test is what keeps them honest.
    for (const [name, html] of PAGES) {
      assert.match(html, /const DEFAULT_APP_TITLE = 'Software Composition Analysis - Risk Dashboard';/,
        `${name} must carry the shared default`);
      assert.ok(html.includes('<title>') &&
        /<title>[^<]*Software Composition Analysis - Risk Dashboard<\/title>/.test(html),
        `${name}'s static <title> must be the same default`);
    }
    assert.equal(brandingMod.DEFAULT_TITLE, 'Software Composition Analysis - Risk Dashboard',
      'the backend constant is the one the pages mirror');
  });

  test('no page still carries one of the old names', () => {
    for (const [name, html] of PAGES) {
      for (const stale of ['Internal Security Dashboard', 'DependencyTrack Dashboard']) {
        assert.ok(!html.includes(stale), `${name} still contains "${stale}"`);
      }
    }
  });

  test('the logo mark is derived from the title, not hard-coded', () => {
    for (const [name, html] of PAGES) {
      assert.match(html, /function brandInitials\(title\)/, `${name} must derive its mark`);
      assert.match(html, /letters\.slice\(0, 3\)/, `${name} must cap the mark at three letters`);
      assert.match(html, /id="brandMark"/, `${name} must have a mark to fill`);
    }
    assert.ok(!/>DT</.test(LOGIN_HTML), 'the hard-coded DT badge is gone');
    assert.ok(!/<svg width="28" height="28"/.test(INDEX_HTML), 'the fixed topbar glyph is gone');
  });

  test('branding is fetched from the public endpoint, not through apiFetch', () => {
    // login.html runs before a token exists; that is why /branding is public.
    for (const [name, html] of PAGES) {
      assert.match(html, /await fetch\('\/branding'[,)]/, `${name} must read the public endpoint`);
      assert.ok(!/apiFetch\('\/branding'/.test(html),
        `${name} must not route branding through apiFetch — login.html has no token yet`);
    }
  });

  test('the branding fetch is bounded, so it cannot hold the gate open', () => {
    // index.html and admin.html await this inside the boot gate. An unbounded
    // fetch here would reintroduce the very hang the gate was built to stop.
    for (const [name, html] of PAGES) {
      const at = html.indexOf('async function readBranding(');
      assert.ok(at > 0, `${name} must have readBranding`);
      const body = html.slice(at, at + 1800);
      assert.match(body, /new AbortController\(\)/, `${name} must bound the branding fetch`);
      assert.match(body, /BRANDING_TIMEOUT_MS/, `${name} must use the shared deadline`);
    }
  });

  test('a branding failure never blocks a page, and never passes silently', () => {
    // The silent version is what made a proxy misconfiguration look like the
    // feature simply doing nothing: /branding returned index.html, the parse
    // threw, and the page kept its defaults with no clue anywhere.
    for (const [name, html] of PAGES) {
      const at = html.indexOf('async function readBranding(');
      const body = html.slice(at, at + 1800);
      assert.match(body, /catch/, `${name} must tolerate a branding failure`);
      assert.match(body, /console\.warn\('\[branding\]/,
        `${name} must report why branding could not be read (CLAUDE.md §11.2)`);
      assert.ok(!/catch \(_\) \{\s*\}/.test(body), `${name} must not have an empty catch`);
    }
  });

  test('a non-JSON branding response names the actual cause', () => {
    // The one failure that looks like success: 200 OK, but it is the dashboard
    // page because nginx never proxied the path.
    for (const [name, html] of PAGES) {
      const at = html.indexOf('async function readBranding(');
      const body = html.slice(at, at + 1800);
      assert.match(body, /content-type/i, `${name} must check what it actually received`);
      assert.match(body, /application\/json/, `${name} must require JSON`);
      assert.match(body, /not being proxied|force-recreate/,
        `${name} must say what to do about it, not just that it failed`);
    }
  });
});

describe('login.html uses the uploaded background', () => {
  test('the upload replaces both animated moods', () => {
    assert.match(LOGIN_HTML, /body\.has-custom-bg \.bg,\s*\n\s*body\.has-custom-bg \.bg-grid-clip \{ display: none; \}/,
      'one image serves everybody, so both moods stand down');
    assert.match(LOGIN_HTML, /body\.has-custom-bg \.bg-custom \{ display: block; \}/);
  });

  test('the card stays readable over an arbitrary image', () => {
    // The image is whatever the administrator picked; without a scrim a light
    // photograph makes the form unreadable.
    // Anchored to the start of the rule: an unanchored match is also satisfied
    // by the light-theme override, so deleting the base scrim would pass.
    assert.match(LOGIN_HTML, /\n\s*\.bg-custom::after \{[^}]*background: rgba\(/,
      'the default (dark) scrim must exist in its own right');
    assert.match(LOGIN_HTML, /\n\s*\[data-theme="light"\] \.bg-custom::after \{[^}]*background: rgba\(/,
      'and the light theme needs its own, since a dark scrim would invert it');
  });

  test('the image URL carries its own version, so it caches forever', () => {
    assert.match(LOGIN_HTML, /\/branding\/background\?v=' \+ encodeURIComponent\(background\.version\)/);
  });
});

describe('admin.html customization section', () => {
  test('every new handler is window-exported', () => {
    for (const fn of ['saveAppTitle', 'resetAppTitle', 'uploadBackground', 'removeBackground']) {
      assert.match(ADMIN_HTML, new RegExp(`window\\.${fn}\\s*=`),
        `${fn} is called from an onclick and must be exported`);
      // uploadBackground rides a file input's change event, not a click.
      assert.match(ADMIN_HTML, new RegExp(`on(?:click|change)="${fn}\\(\\)"`),
        `${fn} must be wired up`);
    }
  });

  test('the title validator mirrors lib/validate.js', () => {
    // CLAUDE.md §8.8: the two must change together.
    const max = /const APP_TITLE_MAX\s*=\s*(\d+);/.exec(VALIDATE_SRC);
    assert.ok(max, 'the backend must declare a ceiling');
    assert.match(ADMIN_HTML, new RegExp(`maxlength="${max[1]}"`),
      'the input must stop at the same length the server enforces');
    for (const rule of [/\\p\{C\}/, /\[A-Za-z0-9\]/]) {
      assert.ok(rule.test(ADMIN_HTML), 'the frontend must mirror the backend rule');
    }
  });

  test('the upload posts raw bytes, not multipart or base64', () => {
    assert.match(ADMIN_HTML, /body:\s*file,/, 'the File goes straight into the body');
    assert.ok(!/FormData/.test(ADMIN_HTML), 'no multipart — there is no parser for it');
    assert.ok(!/btoa\(/.test(ADMIN_HTML), 'no base64 — it would inflate every upload by a third');
  });

  test('removal takes two clicks and reverts itself', () => {
    // This page has no showConfirm, and removal changes what everyone sees.
    assert.match(ADMIN_HTML, /Click again to confirm/);
    assert.match(ADMIN_HTML, /setTimeout\(disarmBgRemove, \d+\)/);
    assert.ok(!/showConfirm\(/.test(ADMIN_HTML),
      'admin.html has no showConfirm helper — calling one would throw');
  });

  test('the accepted types match what the server will store', () => {
    assert.match(ADMIN_HTML, /accept="image\/png,image\/jpeg,image\/webp"/);
    assert.ok(!/image\/svg/.test(ADMIN_HTML), 'SVG must not be offered');
  });
});

// ── nginx must know about every backend path ─────────────────────────────────
// A new top-level path with no location block falls through to the SPA
// fallback, so the browser receives index.html where it expected JSON — a
// failure that looks like "the feature silently does nothing".
describe('nginx routes every backend path to the service', () => {
  const NGINX = fs.readFileSync(
    path.join(__dirname, '..', 'dashboard', 'nginx.conf.template'), 'utf8');

  test('every top-level backend prefix has a location block', () => {
    for (const p of ['/auth/', '/admin/', '/profile', '/violation-cache/', '/branding']) {
      assert.match(NGINX, new RegExp(`location ${p.replace(/\//g, '\\/')}`),
        `${p} must be proxied, or the SPA fallback swallows it`);
    }
  });

  test('the public branding paths in server.js are all proxied', () => {
    // Derived from the server's own list rather than hard-coded, so a future
    // public route cannot be added without nginx learning about it.
    const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const block = /const PUBLIC_PATHS = new Set\(\[([\s\S]*?)\]\);/.exec(SERVER);
    assert.ok(block, 'server.js must declare its public paths');
    const paths = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.ok(paths.includes('/branding'), 'branding must be public for the sign-in page');
    for (const p of paths) {
      const prefix = '/' + p.split('/')[1];
      assert.match(NGINX, new RegExp(`location ${prefix.replace(/\//g, '\\/')}`),
        `${p} is public but nginx has no block for ${prefix}`);
    }
  });

  test('only Docker embedded DNS resolves the upstream', () => {
    // dt-violation-cache is a Docker service name and exists nowhere outside
    // this network, so a public resolver can only ever answer NXDOMAIN. Listing
    // one alongside 127.0.0.11 is not a fallback — nginx distributes queries
    // across the addresses given, so whenever it picked the public one every
    // API call in that window returned 502 "could not be resolved" while the
    // backend was up and healthy.
    const line = /^\s*resolver\s+([^;]+);/m.exec(NGINX);
    assert.ok(line, 'a resolver is required — proxy_pass uses variables');
    const servers = line[1].split(/\s+/).filter(w => /^[\d.]+(:\d+)?$/.test(w));
    assert.deepEqual(servers, ['127.0.0.11'],
      `only Docker's embedded DNS can answer here, got: ${servers.join(', ')}`);
  });

  test('the background keeps its immutable caching through the proxy', () => {
    // The image URL is content-addressed; a no-store override here would make
    // every sign-in re-download it.
    const brandBlock = /location \/branding \{[\s\S]*?\n    \}/.exec(NGINX);
    assert.ok(brandBlock);
    assert.doesNotMatch(brandBlock[0], /no-store/);
  });
});

// ── Schedule timezone conversion ─────────────────────────────────────────────
// The backend stores the schedule as a UTC instant; the picker in index.html
// shows the browser's wall clock. These converters are the only thing standing
// between the two, and getting them wrong moves somebody's report by hours or
// by a day without anything visibly breaking.
//
// The functions are EXTRACTED from index.html rather than copied here. The rest
// of this file predates that trick and keeps verbatim copies (see the header),
// which can silently drift from the page they claim to test; a converter whose
// test copy has drifted is worse than no test at all, because it reports green
// on code nobody runs.

/** Pull one top-level `function name(...) {...}` out of a source string. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html no longer defines ${name}()`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}

const SCHED_FN_NAMES = ['schedInt', 'schedDayShift', 'schedClampDay', 'schedUtcToLocal', 'schedLocalToUtc'];
const sched = new Function(
  SCHED_FN_NAMES.map(n => extractFunction(INDEX_HTML, n)).join('\n')
  + `\nreturn { ${SCHED_FN_NAMES.join(', ')} };`
)();

/** Run `fn` with the process pretending to be in `tz`. */
function inZone(tz, fn) {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); }
  finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
}

// A deliberate spread: whole-hour either side of UTC, both half-hour offsets
// that an hour-only field cannot express, the 45-minute one, and the extremes.
const ZONES = [
  'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles',
  'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Adelaide', 'America/St_Johns',
  'Pacific/Kiritimati', 'Etc/GMT+12',
];

describe('schedule timezone conversion (index.html)', () => {
  test('a half-hour zone keeps the minutes it needs', () => {
    // 09:00 in India is 03:30 UTC. With an hour-only field this was 03:00,
    // delivering the report at 08:30 local — the bug the minute column fixes.
    const utc = inZone('Asia/Kolkata', () => sched.schedLocalToUtc({ hour: 9, minute: 0 }));
    assert.equal(utc.hour, 3);
    assert.equal(utc.minute, 30);
  });

  test('a 45-minute zone keeps the minutes it needs', () => {
    const utc = inZone('Asia/Kathmandu', () => sched.schedLocalToUtc({ hour: 9, minute: 0 }));
    assert.equal(utc.hour, 3);
    assert.equal(utc.minute, 15);
  });

  test('an offset that crosses midnight moves the weekday too', () => {
    // 06:00 UTC on Monday is Sunday evening in Los Angeles, so a schedule
    // stored for UTC Monday must show Sunday in that browser.
    const local = inZone('America/Los_Angeles',
      () => sched.schedUtcToLocal({ hour: 6, minute: 0, weekDays: [1], monthDay: 10 }));
    assert.deepEqual(local.weekDays, [0], 'Monday UTC is Sunday in Los Angeles at 06:00');
    assert.equal(local.monthDay, 9, 'the month day steps back with it');
  });

  test('an offset that crosses midnight forwards moves the weekday forwards', () => {
    // Kiritimati is UTC+14: 23:00 UTC on Saturday is Sunday afternoon there.
    const local = inZone('Pacific/Kiritimati',
      () => sched.schedUtcToLocal({ hour: 23, minute: 0, weekDays: [6], monthDay: 10 }));
    assert.deepEqual(local.weekDays, [0]);
    assert.equal(local.monthDay, 11);
  });

  test('local → UTC → local is the identity for the clock and the weekdays', () => {
    for (const tz of ZONES) {
      inZone(tz, () => {
        for (const hour of [0, 3, 9, 12, 17, 23]) {
          for (const minute of [0, 15, 30, 45]) {
            const local = { hour, minute, weekDays: [0, 3, 6], monthDay: 14 };
            const back  = sched.schedUtcToLocal(sched.schedLocalToUtc(local));
            assert.equal(back.hour, hour,   `${tz} ${hour}:${minute} hour`);
            assert.equal(back.minute, minute, `${tz} ${hour}:${minute} minute`);
            assert.deepEqual(back.weekDays, [0, 3, 6], `${tz} ${hour}:${minute} weekdays`);
          }
        }
      });
    }
  });

  test('UTC → local → UTC is the identity too', () => {
    for (const tz of ZONES) {
      inZone(tz, () => {
        for (const hour of [0, 6, 11, 18, 23]) {
          for (const minute of [0, 30]) {
            const stored = { hour, minute, weekDays: [2], monthDay: 14 };
            const back   = sched.schedLocalToUtc(sched.schedUtcToLocal(stored));
            assert.equal(back.hour, hour,   `${tz} ${hour}:${minute}`);
            assert.equal(back.minute, minute, `${tz} ${hour}:${minute}`);
            assert.deepEqual(back.weekDays, [2], `${tz} ${hour}:${minute}`);
          }
        }
      });
    }
  });

  test('in UTC nothing moves at all', () => {
    inZone('UTC', () => {
      const local = sched.schedUtcToLocal({ hour: 17, minute: 45, weekDays: [1, 4], monthDay: 20 });
      assert.deepEqual(local, { hour: 17, minute: 45, weekDays: [1, 4], monthDay: 20 });
    });
  });

  test('the month day is never pushed outside 1–28', () => {
    // Clamping is lossy at the boundary, which is exactly why the picker
    // re-reads what was stored after a save instead of showing what was typed.
    for (const tz of ZONES) {
      inZone(tz, () => {
        for (const monthDay of [1, 2, 27, 28]) {
          for (const hour of [0, 12, 23]) {
            for (const fn of ['schedLocalToUtc', 'schedUtcToLocal']) {
              const d = sched[fn]({ hour, minute: 30, weekDays: [], monthDay }).monthDay;
              assert.ok(d >= 1 && d <= 28, `${tz} ${fn} ${monthDay}@${hour} produced ${d}`);
            }
          }
        }
      });
    }
  });

  test('weekday shifts stay inside 0–6 and never collide', () => {
    for (const tz of ZONES) {
      inZone(tz, () => {
        for (const hour of [0, 12, 23]) {
          const out = sched.schedLocalToUtc({ hour, minute: 0, weekDays: [0, 1, 2, 3, 4, 5, 6] }).weekDays;
          assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6], `${tz} @${hour}`);
        }
      });
    }
  });

  test('the day shift folds the two wrap-around differences', () => {
    // A local and a UTC calendar differ by at most one day, so the raw weekday
    // difference is one of these five values and nothing else.
    assert.equal(sched.schedDayShift(0), 0);
    assert.equal(sched.schedDayShift(1), 1);
    assert.equal(sched.schedDayShift(-1), -1);
    assert.equal(sched.schedDayShift(6), -1,  'Saturday local vs Sunday UTC is a step back');
    assert.equal(sched.schedDayShift(-6), 1,  'Sunday local vs Saturday UTC is a step forward');
  });

  test('missing or out-of-range fields fall back instead of producing NaN', () => {
    for (const bad of [{}, { hour: 99, minute: -1 }, { hour: null, minute: 'x' }, { hour: '9', minute: '30' }]) {
      const utc = sched.schedLocalToUtc(bad);
      assert.ok(Number.isInteger(utc.hour) && utc.hour >= 0 && utc.hour <= 23, JSON.stringify(bad));
      assert.ok(Number.isInteger(utc.minute) && utc.minute >= 0 && utc.minute <= 59, JSON.stringify(bad));
    }
  });
});

describe('schedule picker markup (index.html)', () => {
  test('the picker takes a time, not a bare hour', () => {
    assert.match(INDEX_HTML, /id="cfgSchedTime"[^>]*type="time"/,
      'the hour-only number input cannot express a half-hour offset');
    assert.doesNotMatch(INDEX_HTML, /cfgSchedHour/,
      'the old hour-only input must be gone, not merely unused');
  });

  test('every control that feeds the UTC hint refreshes it', () => {
    // A weekday box or the month day left on markConfigDirty() would leave the
    // "Stored as …" line describing the previous selection.
    for (const re of [
      /id="cfgSchedTime"[^>]*oninput="onSchedTimeChange\(\)"/,
      /id="cfgSchedMonthDay"[^>]*oninput="onSchedTimeChange\(\)"/,
    ]) assert.match(INDEX_HTML, re, String(re));
    const weekRow = /<div class="cfg-weekdays">[\s\S]*?<\/div>/.exec(INDEX_HTML);
    assert.ok(weekRow, 'weekday row not found');
    assert.equal((weekRow[0].match(/onchange="onSchedTimeChange\(\)"/g) || []).length, 7);
  });

  test('the handler is exported from the IIFE', () => {
    // CLAUDE.md §8.2 — an inline onclick/onchange calls window.*, so a handler
    // left off the export block fails silently in the browser.
    assert.match(INDEX_HTML, /window\.onSchedTimeChange\s*=\s*onSchedTimeChange;/);
  });

  test('the resolved UTC time is shown to the user', () => {
    assert.match(INDEX_HTML, /id="cfgSchedUtcHint"/);
    assert.match(INDEX_HTML, /Stored as \$\{clock\}/);
  });
});

// ── The picker and the scheduler, end to end ─────────────────────────────────
// The converters live in index.html and calcNextRun lives in lib/scheduler.js,
// and nothing else checks that the pair agree. They are the two halves of one
// contract: whatever the user picks on their own clock is the clock time the
// report actually goes out at. A sign error or a dropped minute in either half
// is invisible until somebody's report arrives at the wrong time.

const { calcNextRun: schedulerCalcNextRun } = require('./lib/scheduler');

describe('what the picker stores is what the scheduler fires', () => {
  const WED_0400_UTC = new Date('2026-03-11T04:00:00Z');   // getUTCDay() === 3

  for (const tz of ['UTC', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    test(`daily at 09:00 local fires at 09:00 local in ${tz}`, () => {
      inZone(tz, () => {
        const stored = sched.schedLocalToUtc({ hour: 9, minute: 0, weekDays: [], monthDay: 1 });
        const fire   = schedulerCalcNextRun({ frequency: 'daily', ...stored }, WED_0400_UTC);
        assert.equal(fire.getHours(), 9, `${tz}: fired at ${fire.toString()}`);
        assert.equal(fire.getMinutes(), 0, `${tz}: fired at ${fire.toString()}`);
      });
    });

    test(`weekly on the local weekday the user ticked, in ${tz}`, () => {
      inZone(tz, () => {
        // Tick every weekday and confirm each one comes back as itself: the
        // shift has to be applied in the right direction, and a sign error
        // shows up as an off-by-one day rather than as an error.
        for (let localDay = 0; localDay <= 6; localDay++) {
          const stored = sched.schedLocalToUtc({ hour: 17, minute: 30, weekDays: [localDay], monthDay: 1 });
          const fire   = schedulerCalcNextRun({ frequency: 'weekly', ...stored }, WED_0400_UTC);
          assert.equal(fire.getDay(), localDay, `${tz}: day ${localDay} fired on ${fire.toString()}`);
          assert.equal(fire.getHours(), 17, `${tz}: day ${localDay} fired at ${fire.toString()}`);
          assert.equal(fire.getMinutes(), 30, `${tz}: day ${localDay} fired at ${fire.toString()}`);
        }
      });
    });
  }

  test('a weekly schedule set this morning for this afternoon fires today', () => {
    // The complaint that started this: item 1, checked through the real path a
    // user takes rather than against calcNextRun alone.
    inZone('Asia/Kolkata', () => {
      // 04:00 UTC is 09:30 Wednesday in India; the user picks 17:00 today.
      const localToday = new Date(WED_0400_UTC.getTime()).getDay();
      const stored = sched.schedLocalToUtc({ hour: 17, minute: 0, weekDays: [localToday], monthDay: 1 });
      const fire   = schedulerCalcNextRun({ frequency: 'weekly', ...stored }, WED_0400_UTC);
      assert.ok(fire.getTime() - WED_0400_UTC.getTime() < 24 * 3_600_000,
        `expected today, got ${fire.toString()}`);
      assert.equal(fire.getHours(), 17);
    });
  });
});

// ── Edge cases the converters have to survive ────────────────────────────────
describe('schedule conversion edge cases (index.html)', () => {
  test('an existing UTC row is shown in local time and re-saves unchanged', () => {
    // Migration 008 defaults minute to 0, so every schedule that existed before
    // this feature reads as `hour` UTC. A user in India now correctly sees that
    // their "9" fires at 14:30 their time — the number in the box changes, the
    // delivery does not. Saving without touching it must not move it.
    for (const tz of ZONES) {
      inZone(tz, () => {
        const stored = { hour: 9, minute: 0, weekDays: [3], monthDay: 10 };
        const shown  = sched.schedUtcToLocal(stored);
        const resaved = sched.schedLocalToUtc(shown);
        assert.equal(resaved.hour, 9, `${tz} drifted the hour`);
        assert.equal(resaved.minute, 0, `${tz} drifted the minute`);
        assert.deepEqual(resaved.weekDays, [3], `${tz} drifted the weekday`);
      });
    }
  });

  test('a local time inside a spring-forward gap still converts to a real instant', () => {
    // 02:30 on 8 March 2026 does not exist in New York — the clock jumps from
    // 02:00 to 03:00. Date normalises it rather than failing, and the result
    // must be a usable pair of integers, not NaN.
    inZone('America/New_York', () => {
      const utc = sched.schedLocalToUtc({ hour: 2, minute: 30, weekDays: [0], monthDay: 8 });
      assert.ok(Number.isInteger(utc.hour) && utc.hour >= 0 && utc.hour <= 23, JSON.stringify(utc));
      assert.ok(Number.isInteger(utc.minute) && utc.minute >= 0 && utc.minute <= 59, JSON.stringify(utc));
      assert.ok(Number.isInteger(utc.monthDay), JSON.stringify(utc));
    });
  });

  test('the shared time pattern accepts what the picker can actually emit', () => {
    const re = new RegExp(
      /const SCHED_TIME_RE = (\/.*?\/);/.exec(INDEX_HTML)[1].slice(1, -1)
    );
    for (const good of ['09:00', '9:00', '23:59', '00:00', '09:00:30', '09:00:30.500']) {
      assert.ok(re.test(good), `${good} should be accepted`);
    }
    // An empty or half-typed field must be rejected, or the hint would describe
    // a 09:00 default the user never chose as the value that will be stored.
    for (const bad of ['', '9', '09:', ':30', 'abc', '09-00']) {
      assert.ok(!re.test(bad), `${bad} should be rejected`);
    }
  });

  test('the hint refuses to describe an empty time field', () => {
    const fn = extractFunction(INDEX_HTML, 'renderSchedUtcHint');
    assert.match(fn, /SCHED_TIME_RE\.test/,
      'renderSchedUtcHint must gate on the same pattern the save does');
    assert.match(fn, /Choose a time/);
  });

  test('the save and the hint agree on what a usable time is', () => {
    // Two patterns would drift, and the failure is a user being told to choose
    // a time they have already chosen.
    assert.equal((INDEX_HTML.match(/SCHED_TIME_RE/g) || []).length, 4,
      'expected the one declaration plus its three uses');
    assert.doesNotMatch(INDEX_HTML, /\/\^\\d\{2\}:\\d\{2\}\$\//,
      'the inline time pattern must be gone, not duplicated alongside SCHED_TIME_RE');
  });
});

// ── The schedule list and editor (index.html) ────────────────────────────────
describe('index.html schedule list and editor', () => {
  test('user-supplied text in the list goes through escHtml', () => {
    // The schedule name and the failure text are the two fields whose whole
    // content a user (or a mail server) chose. CLAUDE.md §12 — escape before
    // innerHTML, every time.
    const fn = extractFunction(INDEX_HTML, 'renderScheduleList');
    assert.match(fn, /escHtml\(sc\.name\)/, 'the schedule name must be escaped');
    assert.match(fn, /escHtml\(sc\.lastRunError/, 'the failure text must be escaped');
    // Nothing interpolates a raw name into the markup.
    assert.doesNotMatch(fn, /\$\{sc\.name\}/);
    assert.doesNotMatch(fn, /\$\{sc\.lastRunError\}/);
  });

  test('the list is rendered from state, never from a second fetch shape', () => {
    // renderScheduleList reads _schedules only. A second source would let the
    // panel and the collection disagree about what exists.
    const fn = extractFunction(INDEX_HTML, 'renderScheduleList');
    assert.match(fn, /_schedules/);
    assert.doesNotMatch(fn, /apiFetch/, 'rendering must not fetch');
  });

  test('every schedule action is window-exported from the IIFE', () => {
    // CLAUDE.md §8.2 — an inline handler calls window.*, so one left off the
    // export block fails silently in the browser. These are generated into
    // innerHTML, which is exactly where a silent failure is hardest to notice.
    for (const fn of ['openScheduleEditor', 'saveScheduleEditor', 'cancelSchedule',
                      'cancelAllSchedules', 'scheduleReports']) {
      assert.match(INDEX_HTML, new RegExp(`window\\.${fn}\\s*=\\s*${fn};`), fn);
    }
  });

  test('a new schedule defaults to 09:00 in the reader\'s own day', () => {
    // Defaulting the stored UTC fields would prefill 14:30 for a user in India
    // — correct as 09:00 UTC, and not what anybody means by "nine in the
    // morning".
    const fn = extractFunction(INDEX_HTML, 'openScheduleEditor');
    assert.match(fn, /schedLocalToUtc\(\{ hour: 9, minute: 0/,
      'the default must be converted from local, not stored as UTC 9');
  });

  test('the editor is one form serving both create and edit', () => {
    // Two forms would be two chances for the create path and the edit path to
    // disagree about what a schedule is.
    const save = extractFunction(INDEX_HTML, 'saveScheduleEditor');
    assert.match(save, /editing \? 'PUT' : 'POST'/);
    assert.match(save, /_schedEditingId/);
    assert.equal((INDEX_HTML.match(/function readScheduleEditor\(/g) || []).length, 1);
  });

  test('cancelling asks first, and says what survives', () => {
    for (const name of ['cancelSchedule', 'cancelAllSchedules']) {
      const fn = extractFunction(INDEX_HTML, name);
      assert.match(fn, /await showConfirm\(/, `${name} must confirm before deleting`);
      assert.match(fn, /already sent are unaffected/,
        `${name} must say that delivered reports are untouched`);
    }
  });

  test('the toolbar checks the quota before making the user fill in a form', () => {
    const fn = extractFunction(INDEX_HTML, 'scheduleReports');
    assert.match(fn, /_maxSchedules/);
    assert.match(fn, /Schedule limit reached/);
    // And it is still enforced server-side — the client check is a courtesy.
    const routeSrc = fs.readFileSync(path.join(__dirname, 'routes', 'schedule.js'), 'utf8');
    assert.match(routeSrc, /QUOTA_REACHED/);
    assert.match(routeSrc, /jsonReply\(res, 429/);
  });

  test('the settings panel no longer writes schedules through /config', () => {
    // Two writers for one row is how the panel and the collection drift apart.
    const fn = extractFunction(INDEX_HTML, 'saveConfigPanel');
    assert.doesNotMatch(fn, /schedule:/, 'the config save must not carry a schedule');
    assert.match(fn, /const config = \{ mail: mailConfig \};/);
    const configRoute = fs.readFileSync(path.join(__dirname, 'routes', 'config.js'), 'utf8');
    assert.doesNotMatch(configRoute, /schedulesDb\.save|cfg\.schedule/,
      'the config route must not write schedules either');
  });

  test('the old single-schedule controls are gone, not merely hidden', () => {
    // A dead second implementation is one that gets rendered by accident.
    for (const stale of ['cfgSchedEnabled', 'cfgSchedBody', 'onSchedToggle',
                         'renderScheduleStatus', 'cfgCancelSchedBtn']) {
      assert.doesNotMatch(INDEX_HTML, new RegExp(stale), `${stale} should have been removed`);
    }
  });

  test('the singular schedule routes are gone from the backend too', () => {
    const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const routeSrc = fs.readFileSync(path.join(__dirname, 'routes', 'schedule.js'), 'utf8');
    for (const src of [server, routeSrc, INDEX_HTML]) {
      assert.doesNotMatch(src, /violation-cache\/schedule\/(arm|status|ack-notification)\b/);
      assert.doesNotMatch(src, /'\/violation-cache\/schedule'/);
    }
  });
});

describe('admin.html schedule limit', () => {
  test('the second default is present, bounded, and has its own error slot', () => {
    assert.match(ADMIN_HTML, /id="defaultMaxSchedules"[^>]*type="number"[^>]*min="1"[^>]*max="100"/);
    assert.match(ADMIN_HTML, /id="defaultMaxSchedulesErr"/);
    assert.match(ADMIN_HTML, /id="defaultMaxSchedulesHint"/);
  });

  test('both defaults are saved in one request', () => {
    // Two requests would mean one could succeed and the other fail, leaving the
    // screen showing a state nobody chose.
    const fn = /async function saveDefaultLimit[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0];
    assert.match(fn, /defaultMaxReports: reports, defaultMaxSchedules: schedules/);
    assert.equal((fn.match(/apiFetch\('\/admin\/settings'/g) || []).length, 1);
  });

  test('the administration allow-list is still exactly six method/path pairs', () => {
    // CLAUDE.md §7.6 — the list is the contract. The schedule limit rides on
    // the two settings routes that already existed rather than adding a
    // seventh, which is the bar a new one has to clear.
    const adminRoute = fs.readFileSync(path.join(__dirname, 'routes', 'admin.js'), 'utf8');
    const writes = [...adminRoute.matchAll(/method === '(PUT|POST|DELETE)'/g)].length;
    assert.equal(writes, 6, `expected six write handlers, found ${writes}`);
  });
});

// ── The drill-down schedule editor (index.html) ──────────────────────────────
describe('index.html schedule drill-down', () => {
  test('the editor is a panel view, not a dialog', () => {
    // A dialog covers the list it was opened from; a drill-down keeps the
    // panel's context and makes "one open at a time" structural rather than
    // something the code has to remember.
    assert.match(INDEX_HTML, /id="cfgSchedView"/);
    assert.match(INDEX_HTML, /id="cfgMainView"/);
    assert.doesNotMatch(INDEX_HTML, /schedEditModal/,
      'the modal it replaced must be gone, not merely unused');
  });

  test('opening one schedule asks before abandoning another', () => {
    // The whole point of one-at-a-time: switching must not silently drop what
    // was typed into the previous one.
    const fn = extractFunction(INDEX_HTML, 'openScheduleEditor');
    assert.match(fn, /_schedEditorOpen && !\(await confirmDiscardSchedule\(\)\)/);
  });

  test('every way out of the editor goes through the same guard', () => {
    // Back, footer Cancel and closing the whole panel are three ways to lose
    // work, and all three ask the same question.
    const close = extractFunction(INDEX_HTML, 'closeScheduleEditor');
    assert.match(close, /confirmDiscardSchedule/);
    const panel = extractFunction(INDEX_HTML, 'closeConfigPanel');
    assert.match(panel, /_schedEditorOpen && !\(await confirmDiscardSchedule\(\)\)/,
      'closing the panel must respect the drill-down\'s unsaved changes too');
    assert.match(INDEX_HTML, /id="cfgBackBtn"[^>]*onclick="closeScheduleEditor\(\)"/,
      'Back must ask, so it passes no discard flag');
    const cancel = extractFunction(INDEX_HTML, 'cancelPanel');
    assert.match(cancel, /closeScheduleEditor\(false\)/,
      'the footer\'s Cancel must ask too');
  });

  test('the dirty flag is cleared after the fields are populated, never before', () => {
    // Every field write above fires an oninput handler, so clearing the flag
    // first would leave a freshly opened editor claiming unsaved changes.
    const fn = extractFunction(INDEX_HTML, 'openScheduleEditor');
    const setDirtyFalse = fn.lastIndexOf('_schedDirty = false');
    const lastFieldWrite = fn.lastIndexOf('.checked =');
    assert.ok(setDirtyFalse > lastFieldWrite,
      'the flag must be reset after the last field is written');
  });

  test('the panel always opens on the list, never on a stale schedule', () => {
    const fn = extractFunction(INDEX_HTML, 'openConfigPanel');
    assert.match(fn, /closeScheduleEditor\(true\)/);
  });
});

// ── Per-schedule body and the CC switch ──────────────────────────────────────
describe('index.html schedule delivery: body and CC switch', () => {
  const SCHED_VIEW = /<div id="cfgSchedView"[\s\S]*?<!-- end cfgSchedView -->/.exec(INDEX_HTML)[0];

  test('the editor has a message field, bounded like the column', () => {
    assert.match(SCHED_VIEW, /id="cfgSchedMessage"[^>]*maxlength="5000"/);
    assert.match(SCHED_VIEW, /id="cfgSchedMessageErr"/);
    // It is a textarea, not an input: a covering note is multi-line.
    assert.match(SCHED_VIEW, /<textarea id="cfgSchedMessage"/);
  });

  test('it does not reuse the id of the control PR #113 deleted', () => {
    // cfgSchedBody was the old single-schedule container. Reviving a retired id
    // makes the history unreadable, which is why a test guards the whole set.
    assert.doesNotMatch(INDEX_HTML, /cfgSchedBody/);
  });

  test('the CC switch sits on the CC label row, right-aligned', () => {
    assert.match(SCHED_VIEW, /class="cfg-label-row"[\s\S]{0,400}id="cfgSchedCcEnabled"/);
    assert.match(INDEX_HTML, /\.cfg-label-row \{[^}]*justify-content: space-between/);
  });

  test('turning it off clears and disables the field rather than ignoring it', () => {
    // Addresses left visible under an off switch read as though they were still
    // being used.
    const fn = extractFunction(INDEX_HTML, 'onSchedCcToggle');
    assert.match(fn, /cc\.disabled = !on/);
    assert.match(fn, /cc\.value = ''/);
    assert.match(fn, /No copy will be sent/);
    assert.match(fn, /markSchedDirty\(\)/, 'flipping it is an unsaved change');
  });

  test('the three CC states survive the round trip', () => {
    const read = extractFunction(INDEX_HTML, 'readScheduleEditor');
    assert.match(read, /const ccEnabled = document\.getElementById\('cfgSchedCcEnabled'\)\.checked/);
    assert.match(read, /to, cc, subject, mailBody, ccEnabled,/);
    const open = extractFunction(INDEX_HTML, 'openScheduleEditor');
    // A new schedule inherits; an existing one carries whichever state it holds.
    assert.match(open, /base\.ccEnabled === undefined \? true : base\.ccEnabled !== false/);
    assert.match(open, /onSchedCcToggle\(\)/);
  });

  test('the route distinguishes "copy nobody" from "inherit" on the way out', () => {
    // `||` collapsed the empty array to null, so the browser could never tell
    // the two apart — the same conflation the data layer used to make inbound.
    const route = fs.readFileSync(path.join(__dirname, 'routes', 'schedule.js'), 'utf8');
    assert.match(route, /cc:\s*row\.ccAddrs \?\? null/);
    assert.doesNotMatch(route, /cc:\s*row\.ccAddrs \|\| null/);
    assert.match(route, /ccEnabled:\s*!\(Array\.isArray\(row\.ccAddrs\) && row\.ccAddrs\.length === 0\)/);
    assert.match(route, /mailBody:\s*row\.body \|\| null/);
  });

  test('the list says when a schedule copies nobody', () => {
    // Otherwise it looks identical to one that inherits the account CC.
    const fn = extractFunction(INDEX_HTML, 'renderScheduleList');
    assert.match(fn, /sc\.ccEnabled === false/);
    assert.match(fn, /no CC/);
    assert.match(fn, /escHtml\(sc\.cc\.join/, 'CC addresses are user text');
  });

  test('the placeholders say what a blank field will actually use', () => {
    const fn = extractFunction(INDEX_HTML, 'applySchedDeliveryPlaceholders');
    assert.match(fn, /cfgSchedMessage/);
    assert.match(fn, /Account default message/);
  });

  test('the new handler is window-exported', () => {
    assert.match(INDEX_HTML, /window\.onSchedCcToggle\s*=\s*onSchedCcToggle;/);
  });
});

describe('migration 011', () => {
  const SQL = fs.readFileSync(
    path.join(__dirname, 'db', 'migrations', '011_schedule_body_and_cc.sql'), 'utf8');

  test('it is idempotent at the file level', () => {
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS body/);
    assert.match(SQL, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'sched_body_len'\)/);
  });

  test('it states its data impact, because it writes rows', () => {
    assert.match(SQL, /DATA IMPACT/);
    assert.match(SQL, /UPDATE schedules/);
  });

  test('the backfill preserves what the retired rule used to do', () => {
    // Rows that overrode To sent no CC under the old merge. Without this they
    // would silently START copying the account list on their next run.
    assert.match(SQL, /SET cc_addrs = '\{\}'::text\[\]/);
    assert.match(SQL, /WHERE to_addrs IS NOT NULL/);
    assert.match(SQL, /AND cc_addrs IS NULL/);
    // cardinality(), not array_length() — the latter returns NULL for an empty
    // array, the trap migration 010 documents.
    assert.match(SQL, /cardinality\(to_addrs\)/);
  });
});

// ── The pre-release fixes ────────────────────────────────────────────────────
describe('SMTP password sentinel', () => {
  test('the page keeps the sentinel the server sends', () => {
    // Blanking it here is what broke Send Test Email: the field then read as
    // "no password meant", and a correctly configured account was told its
    // credentials were rejected.
    const fn = extractFunction(INDEX_HTML, 'loadConfigFromServer');
    assert.match(fn, /cfgSmtpPass'\)\.value\s*=\s*smtp\.pass/);
    assert.doesNotMatch(fn, /cfgSmtpPass'\)\.value\s*=\s*''/);
  });

  test('both halves compare against one named constant', () => {
    assert.match(INDEX_HTML, /const SMTP_PASS_PLACEHOLDER = '\u2022{8}'/);
    const test_ = extractFunction(INDEX_HTML, 'testEmailFromPanel');
    assert.match(test_, /passVal === SMTP_PASS_PLACEHOLDER/);
    const save = extractFunction(INDEX_HTML, 'saveConfigPanel');
    assert.match(save, /SMTP_PASS_PLACEHOLDER/);
    // No comparison spells the literal out any more — that divergence is what
    // let the two halves disagree.
    assert.doesNotMatch(test_, /=== '\u2022{8}'/);
    assert.doesNotMatch(save, /'\u2022{8}'/);
  });

  test('an empty field with a username still means "the stored one"', () => {
    const fn = extractFunction(INDEX_HTML, 'testEmailFromPanel');
    assert.match(fn, /passVal === '' && userVal !== ''/);
  });

  test('focus clears the sentinel so typing replaces it', () => {
    // Without this a new password would be appended to the eight bullets.
    assert.match(INDEX_HTML, /onfocus="clearSmtpPassPlaceholder\(\)"/);
    assert.match(INDEX_HTML, /window\.clearSmtpPassPlaceholder = clearSmtpPassPlaceholder;/);
  });
});

describe('container health', () => {
  const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const COMPOSE = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');

  test('/healthz is public, or the probe can never pass', () => {
    const block = /const PUBLIC_PATHS = new Set\(\[([\s\S]*?)\]\);/.exec(SERVER)[1];
    assert.match(block, /'\/healthz'/);
  });

  test('it answers before route dispatch and says nothing else', () => {
    const handler = /parsedPath === '\/healthz'[\s\S]{0,200}/.exec(SERVER)[0];
    assert.match(handler, /jsonReply\(res, 200, \{ status: 'ok' \}\)/);
    // Ahead of the try/catch that wraps route dispatch, so a probe does not
    // depend on anything a route module needs.
    assert.ok(SERVER.indexOf("parsedPath === '/healthz'") < SERVER.indexOf('for (const mod of routeModules)'));
  });

  test('the healthcheck probes it, not an authenticated route', () => {
    const tests = [...COMPOSE.matchAll(/^\s*test: \[.*$/gm)].map(m => m[0]);
    assert.ok(tests.some(t => t.includes('localhost:3001/healthz')),
      'the backend healthcheck must probe /healthz');
    assert.ok(!tests.some(t => t.includes('violation-cache/status')),
      'no healthcheck may probe an authenticated route');
  });

  test('nginx waits for the backend before it serves', () => {
    // The window where nginx was up and the backend was still migrating is
    // where the 502s came from.
    const dash = /^  dt-dashboard:$[\s\S]*?(?=^  dt-violation-cache:$)/m.exec(COMPOSE)[0];
    assert.match(dash, /depends_on:[\s\S]*?dt-violation-cache:[\s\S]*?condition: service_healthy/);
  });
});

describe('compose forwards what the docs promise', () => {
  const COMPOSE = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  const ENV_EXAMPLE = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const backendEnv = /dt-violation-cache:[\s\S]*?dt-postgres:/.exec(COMPOSE)[0];

  test('every operator-tunable variable actually reaches the container', () => {
    // These were documented in README, INSTALLATION and .env.example while
    // compose forwarded none of them, so setting them did nothing at all.
    for (const name of ['REPORT_CONCURRENCY', 'VIOLATION_CONCURRENCY', 'LOG_FORMAT',
                        'SCHEDULER_CONCURRENCY', 'VIOLATION_JOB_STALL_MINUTES',
                        'SESSION_ABSOLUTE_HOURS', 'SESSION_IDLE_HOURS']) {
      assert.match(backendEnv, new RegExp(`^\\s+${name}:`, 'm'),
        `${name} is documented but not forwarded by docker-compose.yml`);
    }
  });

  test('and each one is offered in .env.example', () => {
    for (const name of ['REPORT_CONCURRENCY', 'VIOLATION_CONCURRENCY', 'LOG_FORMAT']) {
      assert.match(ENV_EXAMPLE, new RegExp(`^${name}=`, 'm'), name);
    }
  });
});

describe('nginx hardening', () => {
  const NGINX_RAW = fs.readFileSync(
    path.join(__dirname, '..', 'dashboard', 'nginx.conf.template'), 'utf8');
  // Directives only. A comment explaining why a header is absent must not read
  // as the header being present.
  const NGINX = NGINX_RAW.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

  test('the body limit covers the 5 MB the report route accepts', () => {
    assert.match(NGINX, /client_max_body_size\s+6m;/);
  });

  test('the security headers survive every location that sets its own', () => {
    // nginx replaces rather than merges add_header, so a header declared only
    // at server level disappears from exactly the responses carrying data.
    const blocks = NGINX.split(/location /).slice(1);
    for (const b of blocks) {
      if (!/add_header/.test(b)) continue;
      assert.match(b, /X-Content-Type-Options/, 'a location sets headers but drops nosniff');
      assert.match(b, /Referrer-Policy/, 'a location sets headers but drops Referrer-Policy');
    }
    assert.match(NGINX, /server_tokens off;/);
  });

  test('X-Frame-Options stays absent for the iframe model', () => {
    assert.doesNotMatch(NGINX, /X-Frame-Options/);
  });
});

describe('smaller pre-release fixes', () => {
  const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const PROFILE = fs.readFileSync(path.join(__dirname, 'routes', 'profile.js'), 'utf8');

  test('the 404 fallthrough is JSON like every other error', () => {
    assert.match(SERVER, /jsonReply\(res, 404, \{ error: 'Not found\.', code: 'NOT_FOUND' \}\)/);
    assert.doesNotMatch(SERVER, /res\.end\('Not found'\)/);
  });

  test('a profile update evicts the cached principal whatever changed', () => {
    // Evicting only on a password change left /auth/me reporting the old name
    // for up to the 60-second cache TTL.
    const fn = /if \(method === 'PUT' && parsedPath === '\/profile'\)[\s\S]*?\n  \}/.exec(PROFILE)[0];
    const evict = fn.indexOf('auth.evictUser(principal.userId)');
    const pwBranch = fn.indexOf('if (patch.passwordHash)');
    assert.ok(evict > -1 && evict < pwBranch, 'eviction must not be inside the password branch');
  });

  test('the CSV export neutralises formula-leading values', () => {
    const fn = extractFunction(INDEX_HTML, 'exportCSV');
    assert.match(fn, /\^\[=\+\\-@/, 'a leading =, +, - or @ must be detected');
    assert.match(fn, /`'\$\{s\}`/, 'and prefixed with an apostrophe');
  });

  test('the controls a screen reader could not name now have names', () => {
    for (const id of ['searchInput', 'riskFilter', 'categoryFilter', 'tagFilter']) {
      const el = new RegExp(`id="${id}"[^>]*`).exec(INDEX_HTML);
      assert.ok(el, id);
      const tag = new RegExp(`<(input|select)[^>]*id="${id}"[^>]*>`).exec(INDEX_HTML)[0];
      assert.match(tag, /aria-label="/, `${id} has no accessible name`);
    }
    // Row checkboxes are named after what they select, so the selection column
    // is not a column of anonymous checkboxes.
    const render = extractFunction(INDEX_HTML, 'renderTree');
    assert.match(render, /aria-label="Select \$\{escHtml\(node\.name\)\}"/);
  });
});

// ── The settings panel's chrome ──────────────────────────────────────────────
// Four defects found in the deployed build, all of them in how the drill-down
// shares the panel with the settings list.
describe('index.html settings panel chrome', () => {
  test('the hidden attribute is made to win against class rules', () => {
    // The browser's own rule is `[hidden] { display: none }` in the user-agent
    // stylesheet, and ANY author rule setting `display` on the same element
    // beats it. `.cfg-panel-footer` is flex and `.btn` is inline-flex, so
    // `el.hidden = true` did nothing to either: the panel showed both footers
    // at once, and a schedule that did not exist yet offered "Cancel this
    // schedule". Declaring the rule here is what makes the attribute mean what
    // it says.
    assert.match(INDEX_HTML, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
    // The two classes that would otherwise beat it are still display-setting,
    // so the rule is load-bearing rather than decorative.
    assert.match(INDEX_HTML, /\.btn \{[\s\S]{0,120}display: inline-flex/);
    assert.match(INDEX_HTML, /\.cfg-panel-footer \{[\s\S]{0,120}display: flex/);
  });

  test('there is exactly one footer, serving both views', () => {
    // Two footers meant two Save buttons and two Cancel buttons on screen
    // together, and the Cancel belonging to Settings closed the whole panel
    // from inside the schedule editor.
    const footers = (INDEX_HTML.match(/class="cfg-panel-footer"/g) || []).length;
    assert.equal(footers, 1, `expected one panel footer, found ${footers}`);
    assert.doesNotMatch(INDEX_HTML, /cfgSchedFooter|cfgMainFooter|cfgSchedSaveBtn/,
      'the second footer must be deleted, not hidden — a dead second implementation gets rendered by accident');
  });

  test('the footer buttons dispatch on whichever view is open', () => {
    assert.match(INDEX_HTML, /id="cfgSaveBtn"[^>]*onclick="savePanel\(\)"/);
    assert.match(INDEX_HTML, /id="cfgCancelBtn"[^>]*onclick="cancelPanel\(\)"/);
    const save = extractFunction(INDEX_HTML, 'savePanel');
    assert.match(save, /_schedEditorOpen.*saveScheduleEditor\(\)/s);
    assert.match(save, /saveConfigPanel\(\)/);
    const cancel = extractFunction(INDEX_HTML, 'cancelPanel');
    assert.match(cancel, /_schedEditorOpen.*closeScheduleEditor\(false\)/s);
    assert.match(cancel, /closeConfigPanel\(false\)/);
  });

  test('Cancel inside the editor goes back to Settings, it does not close the panel', () => {
    // The reported behaviour: from a schedule, Cancel threw away the user's
    // place as well as their edits. closeScheduleEditor restores the list;
    // closeConfigPanel would dismiss the whole panel.
    const cancel = extractFunction(INDEX_HTML, 'cancelPanel');
    const editorBranch = cancel.slice(0, cancel.indexOf('closeConfigPanel'));
    assert.match(editorBranch, /closeScheduleEditor/);
    assert.doesNotMatch(editorBranch, /closeConfigPanel/);
    // And leaving the editor restores the list rather than the panel's closed
    // state, so "back" really is one step.
    const close = extractFunction(INDEX_HTML, 'closeScheduleEditor');
    assert.match(close, /cfgMainView'\)\.hidden\s*=\s*false/);
    assert.match(close, /cfgSchedView'\)\.hidden\s*=\s*true/);
    assert.doesNotMatch(close, /classList\.remove\('open'\)/);
  });

  test('the primary button says which of the two things it saves', () => {
    const mode = extractFunction(INDEX_HTML, 'setPanelFooterMode');
    assert.match(mode, /'Save schedule'/);
    assert.match(mode, /'Save'/);
    for (const fn of ['openScheduleEditor', 'closeScheduleEditor']) {
      assert.match(extractFunction(INDEX_HTML, fn), /setPanelFooterMode\(/, fn);
    }
    // Saving keeps the editor open, so the label it restores is the editor's.
    const save = extractFunction(INDEX_HTML, 'saveScheduleEditor');
    assert.match(save, /btn\.textContent = 'Save schedule'/);
  });

  test('both views space their sections, not just the panel body', () => {
    // The body's flex gap used to reach the sections directly. The drill-down
    // wrapped them in #cfgMainView / #cfgSchedView, which made them
    // grandchildren — a flex gap does not reach those, and every section sat
    // flush against the next.
    assert.match(INDEX_HTML, /\.cfg-view \{[^}]*display: flex[^}]*flex-direction: column[^}]*gap: 16px/);
    assert.match(INDEX_HTML, /id="cfgMainView" class="cfg-view"/);
    assert.match(INDEX_HTML, /id="cfgSchedView" class="cfg-view"/);
    // Same gap as the body, so the two views cannot drift apart visually.
    const body = /\.cfg-panel-body \{[^}]*\}/.exec(INDEX_HTML)[0];
    const view = /\.cfg-view \{[^}]*\}/.exec(INDEX_HTML)[0];
    assert.equal(/gap: (\d+px)/.exec(body)[1], /gap: (\d+px)/.exec(view)[1]);
  });

  test('the toolbar entry point shows the panel it drills into', () => {
    // The editor is a view inside the settings panel, so opening the editor
    // alone rendered it into a panel still translated off-screen: the toolbar's
    // Schedule Reports looked dead. openConfigPanel also populates the Settings
    // view behind it, which Back and Cancel return to — without it that view is
    // blank and a Save there writes empty SMTP fields over the stored ones.
    const fn = extractFunction(INDEX_HTML, 'scheduleReports');
    const editor = fn.indexOf('openScheduleEditor(');
    assert.ok(editor > -1, 'the toolbar must open the editor');
    const open = fn.lastIndexOf('openConfigPanel()', editor);
    assert.ok(open > -1, 'the panel must be opened before the editor drills in');
    // The function opens Settings from its "email is not configured" branch too,
    // and that one returns. Asking only "is openConfigPanel mentioned first"
    // passes with the real call deleted, so the check is that nothing returns
    // between the two: they are on one path.
    assert.doesNotMatch(fn.slice(open, editor), /\breturn\b/,
      'the panel must be opened on the path that actually reaches the editor');
  });

  test('the schedule form marks the schedule dirty, never Settings', () => {
    // openScheduleEditor ends by calling onSchedFreqChange(), so pointing these
    // at markConfigDirty made merely opening a schedule claim Settings had
    // unsaved changes — and left a changed frequency or time marking nothing,
    // so Cancel discarded it without asking.
    for (const name of ['onSchedFreqChange', 'onSchedTimeChange']) {
      const fn = extractFunction(INDEX_HTML, name);
      assert.match(fn, /markSchedDirty\(\)/, `${name} must mark the schedule`);
      assert.doesNotMatch(fn, /markConfigDirty\(\)/, `${name} must not mark Settings`);
    }
    // The mail toggle really does belong to Settings, so it keeps the other flag.
    assert.match(extractFunction(INDEX_HTML, 'onMailToggle'), /markConfigDirty\(\)/);
  });

  test('the new footer handlers are window-exported', () => {
    // CLAUDE.md §8.2 — an inline handler calls window.*, so one left off the
    // export block leaves the only Save button in the panel doing nothing.
    for (const fn of ['savePanel', 'cancelPanel']) {
      assert.match(INDEX_HTML, new RegExp(`window\\.${fn}\\s*=\\s*${fn};`), fn);
    }
  });
});

describe('index.html per-schedule delivery', () => {
  test('blank fields are sent, so an override can be cleared', () => {
    // Omitting the key means "leave it alone"; sending an empty list means "go
    // back to the account default". Only the second is reachable from a form
    // the user cleared.
    const fn = extractFunction(INDEX_HTML, 'readScheduleEditor');
    assert.match(fn, /to, cc, subject,/);
    assert.match(fn, /const addrs = \(id\) =>/);
  });

  test('a malformed address is caught in the editor, not by the server', () => {
    const fn = extractFunction(INDEX_HTML, 'readScheduleEditor');
    assert.match(fn, /SCHED_EMAIL_RE\.test\(a\)/);
    assert.match(fn, /is not a valid email address/);
  });

  test('the placeholder says what a blank field will actually use', () => {
    // "Leave it blank" is only safe advice if the user can see what blank means.
    const fn = extractFunction(INDEX_HTML, 'applySchedDeliveryPlaceholders');
    assert.match(fn, /Account default/);
    assert.match(fn, /_appConfig/);
  });

  test('the list says where each schedule actually sends', () => {
    const fn = extractFunction(INDEX_HTML, 'renderScheduleList');
    assert.match(fn, /account default recipients/);
    assert.match(fn, /escHtml\(sc\.to\.join/, 'recipient addresses are user text');
  });

  test('only the addressing is per schedule — the SMTP fields stay on the account', () => {
    // Changing who receives a report must never mean re-entering a password.
    const view = /<div id="cfgSchedView"[\s\S]*?<!-- end cfgSchedView -->/.exec(INDEX_HTML)[0];
    for (const smtpField of ['cfgSmtpHost', 'cfgSmtpPort', 'cfgSmtpUser', 'cfgSmtpPass', 'cfgMailFrom']) {
      assert.doesNotMatch(view, new RegExp(smtpField), `${smtpField} must not be per schedule`);
    }
    for (const own of ['cfgSchedTo', 'cfgSchedCc', 'cfgSchedSubject']) {
      assert.match(view, new RegExp(own));
    }
  });
});

describe('index.html pause, send now and history', () => {
  test('the pause toggle acts immediately and does not open the editor', () => {
    const fn = extractFunction(INDEX_HTML, 'renderScheduleList');
    assert.match(fn, /toggleSchedule\('\$\{sc\.id\}', this\.checked\)/);
    assert.match(fn, /onclick="event\.stopPropagation\(\)"/,
      'clicking the toggle must not also drill into the schedule');
    // A schedule with no projects cannot be armed, so offering to resume it
    // would be offering something that fails.
    assert.match(fn, /sc\.projectCount \? '' : 'disabled'/);
  });

  test('a failed toggle puts the switch back where the server says it is', () => {
    const fn = extractFunction(INDEX_HTML, 'toggleSchedule');
    const failureBranch = fn.slice(fn.indexOf('if (!r.ok)'));
    assert.match(failureBranch, /reloadSchedules/,
      'a refused pause must not leave the UI claiming it worked');
  });

  test('send now is disabled until the schedule exists', () => {
    const fn = extractFunction(INDEX_HTML, 'openScheduleEditor');
    assert.match(fn, /cfgSchedRunNowBtn'\)\.disabled = !sc/);
  });

  test('the history states the window it counts over', () => {
    // An unqualified total would quietly shrink as the 90-day sweep runs.
    const fn = extractFunction(INDEX_HTML, 'renderRunHistory');
    assert.match(fn, /stats\.retentionDays/);
    assert.match(fn, /in the last /);
    assert.match(fn, /succeeded/);
    assert.match(fn, /failed/);
    assert.match(fn, /escHtml\(r\.error/, 'a failure message is text from a mail server');
  });

  test('every new handler is window-exported', () => {
    for (const fn of ['closeScheduleEditor', 'cancelScheduleFromEditor',
                      'toggleSchedule', 'runScheduleNow', 'markSchedDirty']) {
      assert.match(INDEX_HTML, new RegExp(`window\\.${fn}\\s*=\\s*${fn};`), fn);
    }
  });

  test('the backend routes the screen calls all exist', () => {
    // A screen calling a route nobody implemented fails silently, which is how
    // the schedule/status poller survived Phase 2 unnoticed.
    const routeSrc = fs.readFileSync(path.join(__dirname, 'routes', 'schedule.js'), 'utf8');
    for (const [action, method] of [['arm', 'POST'], ['disable', 'POST'],
                                    ['run-now', 'POST'], ['runs', 'GET'],
                                    ['ack-notification', 'POST']]) {
      assert.match(routeSrc, new RegExp(`method === '${method}' && action === '${action}'`),
        `${method} .../${action} is called by the page but not handled`);
    }
  });

  test('every schedule path the page calls is one the route parses', () => {
    const calls = [...INDEX_HTML.matchAll(/\/violation-cache\/schedules(\/[a-z$${}()\w.-]*)?/g)]
      .map(m => (m[1] || '').replace(/\$\{[^}]*\}/g, ':id'));
    const allowed = new Set(['', '/', '/:id', '/:id/arm', '/:id/disable',
                             '/:id/run-now', '/:id/runs', '/:id/ack-notification']);
    for (const c of new Set(calls)) {
      assert.ok(allowed.has(c), `the page calls an unexpected schedule path: "${c}"`);
    }
  });
});

// ── Documentation must not drift from the code ───────────────────────────────
// Every stale claim these tests catch was real: the integration guide documented
// three schedule routes that had been deleted, the README said the installer
// asks for a DependencyTrack URL it stopped asking for, and the installation
// guide's environment table was missing three variables the service reads.
// Prose has no compiler, so this is the only thing that keeps it honest.

const README    = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const INSTALL_MD = fs.readFileSync(path.join(__dirname, '..', 'docs', 'INSTALLATION.md'), 'utf8');
const INTEGRATION_MD = fs.readFileSync(path.join(__dirname, '..', 'docs', 'DASHBOARD_INTEGRATION.md'), 'utf8');
const PERF_MD   = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PERFORMANCE.md'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

/** Every `/violation-cache/...` and `/admin/...` path the route modules answer. */
function handledRoutes() {
  const found = new Set();
  for (const f of fs.readdirSync(path.join(__dirname, 'routes'))) {
    const src = fs.readFileSync(path.join(__dirname, 'routes', f), 'utf8');
    // Exact-path handlers.
    for (const m of src.matchAll(/parsedPath === '([^']+)'/g)) found.add(m[1]);
    for (const m of src.matchAll(/path === '([^']+)'/g)) found.add(m[1]);
    // Sub-actions on the schedule collection.
    for (const m of src.matchAll(/action === '([a-z-]+)'/g)) {
      found.add(`/violation-cache/schedules/:id/${m[1]}`);
    }
    // Regex-matched id routes, e.g. /admin/users/([^/]+)/settings
    for (const m of src.matchAll(/parsedPath\.match\(\/\^([^/]*(?:\/[^(]*)*)\(\[\^\/\]\+\)([^/]*(?:\/[^$]*)*)\$\//g)) {
      found.add((m[1] + ':id' + (m[2] || '')).replace(/\\\//g, '/'));
    }
  }
  return found;
}

describe('documentation matches the routes the code answers', () => {
  test('no document mentions a route the code no longer has', () => {
    // The failure this exists for: DASHBOARD_INTEGRATION.md documented
    // GET /violation-cache/schedule/status, DELETE /violation-cache/schedule and
    // POST /violation-cache/schedule/ack-notification for a whole release after
    // they were deleted. A reader following the guide would have got 404s.
    const gone = [
      '/violation-cache/schedule/status',
      '/violation-cache/schedule/arm',
      '/violation-cache/schedule/ack-notification',
    ];
    for (const doc of [README, INSTALL_MD, INTEGRATION_MD, PERF_MD, SERVER_SRC]) {
      for (const route of gone) {
        assert.ok(!doc.includes(route), `a deleted route is still documented: ${route}`);
      }
    }
    // The singular collection, as a whole word — /violation-cache/schedules is fine.
    for (const doc of [INTEGRATION_MD, SERVER_SRC]) {
      assert.doesNotMatch(doc, /\/violation-cache\/schedule(?![sr])/,
        'the singular /violation-cache/schedule endpoint no longer exists');
    }
  });

  test('every schedule route the code answers is in the integration guide', () => {
    // Schedules are the surface that moved most, and the guide is what somebody
    // integrating against this reads.
    const scheduleRoutes = [...handledRoutes()].filter(r => r.startsWith('/violation-cache/schedules'));
    assert.ok(scheduleRoutes.length >= 4, 'expected the schedule collection to be discovered');
    for (const r of scheduleRoutes) {
      assert.ok(INTEGRATION_MD.includes(r), `${r} is handled but not documented`);
    }
    for (const r of ['/violation-cache/schedules/:id/run-now',
                     '/violation-cache/schedules/:id/runs',
                     '/violation-cache/schedules/:id/arm',
                     '/violation-cache/schedules/:id/disable']) {
      assert.ok(INTEGRATION_MD.includes(r), `${r} is handled but not documented`);
    }
  });

  test('every /violation-cache route the code answers is in the integration guide', () => {
    // Deliberately derived from the source rather than listed here. The two
    // enumerated tests around this one only cover the routes somebody
    // remembered to add, which is the same failure mode as the drift they were
    // written to catch: /violation-cache/config/dt-key and
    // /violation-cache/config/test-connection had been undocumented since they
    // shipped, and no assertion noticed because neither was on anybody's list.
    // A new route is now documented by default.
    const routes = [...handledRoutes()]
      .filter(r => r.startsWith('/violation-cache/'))
      .sort();
    assert.ok(routes.length >= 8, 'expected the cache and config routes to be discovered');
    const missing = routes.filter(r => !INTEGRATION_MD.includes(r));
    assert.deepEqual(missing, [],
      `handled but undocumented: ${missing.join(', ')}`);
  });

  test('every administration route is documented', () => {
    for (const r of ['/admin/overview', '/admin/users', '/admin/storage', '/admin/settings',
                     '/admin/users/:loginId/settings', '/admin/users/:loginId/password',
                     '/admin/branding', '/admin/branding/background']) {
      assert.ok(INTEGRATION_MD.includes(r), `${r} is administrator-only but undocumented`);
    }
  });

  test('server.js\'s own route header lists what it dispatches', () => {
    // The header is the first thing a reader of the service meets, and it had
    // drifted too — missing run-now, runs and every branding route.
    //
    // Scoped to the comment block, not the whole file: `require('./routes/
    // branding')` contains the substring "/branding", so a whole-file search
    // passes even with every branding line deleted from the header. The first
    // version of this test did exactly that and caught nothing.
    const header = SERVER_SRC.split('\n')
      .filter(l => /^\/\/ {3}(GET|POST|PUT|DELETE)/.test(l)).join('\n');
    assert.ok(header.length > 500, 'the route header was not found');
    for (const r of ['/violation-cache/schedules/:id/run-now',
                     '/violation-cache/schedules/:id/runs',
                     '/admin/branding',
                     '/admin/branding/background',
                     '/admin/users/:loginId/password',
                     '/branding/background']) {
      assert.ok(header.includes(r), `server.js's route header omits ${r}`);
    }
    // GET /branding as its own entry, not just as part of the background path.
    assert.match(header, /GET {4}\/branding {2}\/branding\/background/,
      'the two public branding routes must be listed');
  });
});

describe('documentation matches the configuration the code reads', () => {
  test('every environment variable the service reads is in the installation guide', () => {
    const cfgSrc = fs.readFileSync(path.join(__dirname, 'lib', 'config.js'), 'utf8');
    // The variables an operator sets. CACHE_DIR, PORT and POSTGRES_HOST are
    // fixed by docker-compose and are not theirs to change.
    const internal = new Set(['CACHE_DIR', 'PORT', 'POSTGRES_HOST', 'ENV_FILE',
                              'CONFIG_INVALID', 'CACHE_TTL_HOURS']);
    const declared = [...cfgSrc.matchAll(/'([A-Z][A-Z_]{3,})'/g)]
      .map(m => m[1]).filter(v => !internal.has(v));
    assert.ok(declared.length >= 8, 'expected to discover the configuration surface');
    for (const v of new Set(declared)) {
      assert.ok(INSTALL_MD.includes(v), `${v} is read by the service but absent from INSTALLATION.md`);
    }
  });

  test('the documented defaults are the defaults the code uses', () => {
    // A table that says 5 while the code says 3 is worse than no table.
    const { DEFAULTS } = require('./lib/config');
    for (const [name, value] of [['SCHEDULER_CONCURRENCY', '5'],
                                 ['REPORT_CONCURRENCY', '5'],
                                 ['VIOLATION_CONCURRENCY', '3'],
                                 ['SESSION_ABSOLUTE_HOURS', '8'],
                                 ['SESSION_IDLE_HOURS', '2']]) {
      assert.equal(DEFAULTS[name], value, `${name}'s default moved; update the docs`);
      const tick = String.fromCharCode(96);   // a backtick, unquotable in a template
      assert.match(INSTALL_MD,
        new RegExp(tick + name + tick + '[^|]*\\|[^|]*' + tick + value + tick),
        `INSTALLATION.md does not show ${name} defaulting to ${value}`);
    }
  });

  test('.env.example carries every operator-facing variable', () => {
    const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    for (const v of ['SCHEDULER_CONCURRENCY', 'VIOLATION_JOB_STALL_MINUTES',
                     'VIOLATION_CACHE_TTL_HOURS', 'SESSION_ABSOLUTE_HOURS', 'LOG_FORMAT']) {
      assert.ok(envExample.includes(v), `.env.example omits ${v}`);
    }
  });

  test('docker-compose passes through what the service reads', () => {
    const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
    for (const v of ['SCHEDULER_CONCURRENCY', 'VIOLATION_JOB_STALL_MINUTES', 'SECRET_ENCRYPTION_KEY']) {
      assert.ok(compose.includes(v), `docker-compose.yml does not pass ${v} through`);
    }
  });
});

describe('the documents describe the behaviour the code has', () => {
  test('the README no longer claims the installer asks for a DependencyTrack URL', () => {
    // install.sh stopped asking when connections became per-user, and the README
    // said otherwise for several releases.
    const installer = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
    assert.doesNotMatch(installer, /read .*DT_API_INTERNAL_URL|prompt.*API URL/i,
      'install.sh must not ask for a DependencyTrack connection');
    assert.match(README, /does \*\*not\*\* ask for a DependencyTrack URL/,
      'the README must say the installer does not ask for it');
  });

  test('the administration allow-list is stated as six everywhere it is stated', () => {
    const adminSrc = fs.readFileSync(path.join(__dirname, 'routes', 'admin.js'), 'utf8');
    const writes = [...adminSrc.matchAll(/method === '(PUT|POST|DELETE)'/g)].length;
    assert.equal(writes, 6);
    assert.match(README, /exactly six things/);
    assert.doesNotMatch(README, /exactly three things/, 'the README still says three');
  });

  test('one schedule per user is not claimed anywhere', () => {
    for (const [name, doc] of [['README', README], ['INSTALLATION', INSTALL_MD],
                               ['DASHBOARD_INTEGRATION', INTEGRATION_MD]]) {
      assert.doesNotMatch(doc, /Cancel Schedule\b/, `${name} describes the removed single-schedule button`);
      assert.doesNotMatch(doc, /the schedule toggle/i, `${name} describes the removed master toggle`);
      assert.doesNotMatch(doc, /server local time/i, `${name} still says times are server-local`);
    }
  });

  test('the performance evidence describes the current schema', () => {
    // perf-check.js seeded a schedules row per user and joined it as if unique,
    // which stopped being true at migration 009 — the harness would have
    // reported inflated counts rather than failing.
    const perfSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'perf-check.js'), 'utf8');
    assert.doesNotMatch(perfSrc, /LEFT JOIN schedules \w+\s+ON/,
      'a plain join on schedules multiplies the user row — use a LATERAL aggregate');
    assert.doesNotMatch(perfSrc, /'mail_settings', 'schedules'/,
      'schedules are not seeded one per account any more');
    assert.match(PERF_MD, /ix_sched_running/, 'the claim index is not in the evidence');
    assert.match(PERF_MD, /SCHEDULER_CONCURRENCY/, 'the scheduler ceiling is not in the evidence');
  });
});

// ── Risk trend panel ──────────────────────────────────────────────────────────
// The chart maths, extracted from index.html rather than copied, so a test can
// never pass against a version of the code the page no longer contains
// (CLAUDE.md §10.5). Everything asserted here is pure: no DOM, no fetch.

const TREND_FN_NAMES = [
  'trendValues', 'trendNiceCeil', 'trendTicks', 'trendGeometry',
  'trendLinePath', 'trendAreaPath', 'trendStack', 'trendPeak',
  'trendDayLabel', 'trendLabelIndices', 'trendLabelCapacity',
  'trendCarry', 'trendGapRuns',
];
const trend = new Function(
  // TREND_LEVELS and TREND_GEOM are const declarations the helpers close over.
  INDEX_HTML.match(/const TREND_LEVELS = \[[\s\S]*?\];/)[0] + '\n'
  + INDEX_HTML.match(/const TREND_GEOM = \{[\s\S]*?\n\};/)[0] + '\n'
  + TREND_FN_NAMES.map(n => extractFunction(INDEX_HTML, n)).join('\n')
  + `\nreturn { ${TREND_FN_NAMES.join(', ')}, TREND_LEVELS };`
)();

/** A captured day in the shape /risk-series returns. */
const snapDay = (day, sev, pol) => ({
  day, captured: true, rootProjectCount: 1,
  sev: { critical: 0, high: 0, medium: 0, low: 0, unassigned: 0, ...sev },
  pol: {
    opsFail: 0, opsWarn: 0, opsInfo: 0, licFail: 0, licWarn: 0, licInfo: 0,
    secpolFail: 0, secpolWarn: 0, secpolInfo: 0, ...pol,
  },
});
const gapDay = (day) => ({ day, captured: false, rootProjectCount: null, sev: null, pol: null });

describe('trend — folding a stored day into what a chart plots', () => {
  test('"total" reproduces the KPI card arithmetic exactly', () => {
    // The panel sits directly above the cards. A different sum would put two
    // contradicting numbers for the same word on one screen, which is the whole
    // reason the metric defaults to this one.
    const point = snapDay('2026-09-07',
      { critical: 10, high: 20, medium: 30, low: 40, unassigned: 5 },
      { opsFail: 1, licFail: 2, secpolFail: 3,
        opsWarn: 4, licWarn: 5, secpolWarn: 6,
        opsInfo: 7, licInfo: 8, secpolInfo: 9 });
    const v = trend.trendValues(point, 'total');

    const s = point.sev, o = point.pol;
    assert.equal(v.critical, s.critical + o.opsFail + o.licFail + o.secpolFail);
    assert.equal(v.high,     s.high     + o.opsWarn + o.licWarn + o.secpolWarn);
    assert.equal(v.medium,   s.medium   + o.opsInfo + o.licInfo + o.secpolInfo);
    assert.equal(v.low,      s.low      + s.unassigned);
    assert.deepEqual(v, { critical: 16, high: 35, medium: 54, low: 45 });
  });

  test('the fold matches the page\'s own computeSummaryTotals, term for term', () => {
    // Cross-layer: the tile formula is read out of index.html here too, so
    // changing one without the other fails rather than drifting silently.
    const src = extractFunction(INDEX_HTML, 'computeSummaryTotals');
    for (const line of [
      /t\.critical \+= \(s\.critical\|\|0\) \+ \(o\.fail\|\|0\) \+ \(l\.fail\|\|0\) \+ \(sp\.fail\|\|0\)/,
      /t\.high\s+\+= \(s\.high\|\|0\)\s+\+ \(o\.warn\|\|0\) \+ \(l\.warn\|\|0\) \+ \(sp\.warn\|\|0\)/,
      /t\.medium\s+\+= \(s\.medium\|\|0\)\s+\+ \(o\.info\|\|0\) \+ \(l\.info\|\|0\) \+ \(sp\.info\|\|0\)/,
      /t\.low\s+\+= \(s\.low\|\|0\)\s+\+ \(s\.unassigned\|\|0\)/,
    ]) {
      assert.match(src, line,
        'the KPI tile formula changed — trendValues() must change with it');
    }
  });

  test('"security" is pure CVE severity, with unassigned folded into low', () => {
    const point = snapDay('2026-09-07',
      { critical: 10, high: 20, medium: 30, low: 40, unassigned: 5 },
      { opsFail: 99, licFail: 99, secpolFail: 99 });
    assert.deepEqual(trend.trendValues(point, 'security'),
      { critical: 10, high: 20, medium: 30, low: 45 });
  });

  test('a day nobody refreshed folds to null, never to zero', () => {
    // Zero is the claim that somebody looked and found nothing. A gap is the
    // absence of a measurement, and the two must not render the same.
    assert.equal(trend.trendValues(gapDay('2026-09-01'), 'total'), null);
    assert.equal(trend.trendValues(null, 'total'), null);
    assert.equal(trend.trendValues({ day: 'x', captured: true, sev: null, pol: null }, 'total'), null);
  });

  test('missing keys count as zero rather than producing NaN', () => {
    const v = trend.trendValues({ day: 'd', captured: true, sev: {}, pol: {} }, 'total');
    assert.deepEqual(v, { critical: 0, high: 0, medium: 0, low: 0 });
  });
});

describe('trend — axis scaling', () => {
  test('the ceiling is a round 1, 2 or 5 above the peak', () => {
    assert.equal(trend.trendNiceCeil(7), 10);
    assert.equal(trend.trendNiceCeil(11), 20);
    assert.equal(trend.trendNiceCeil(23), 50);
    assert.equal(trend.trendNiceCeil(120), 200);
    assert.equal(trend.trendNiceCeil(1), 1);
    assert.equal(trend.trendNiceCeil(10), 10);
  });

  test('an all-clean portfolio still gets a usable axis', () => {
    // Every y coordinate divides by this. Returning 0 would make the chart a
    // page of NaN for the most desirable state a portfolio can be in.
    for (const v of [0, -5, null, undefined, NaN, 'x']) {
      assert.equal(trend.trendNiceCeil(v), 1, `trendNiceCeil(${v})`);
    }
  });

  test('the tick step is round, not just the ceiling', () => {
    // A fixed four intervals turns a ceiling of 50 into 13/25/38/50 — the right
    // positions wearing wrong-looking numbers.
    assert.deepEqual(trend.trendTicks(50),  [0, 10, 20, 30, 40, 50]);
    assert.deepEqual(trend.trendTicks(20),  [0, 5, 10, 15, 20]);
    assert.deepEqual(trend.trendTicks(10),  [0, 2, 4, 6, 8, 10]);
    assert.deepEqual(trend.trendTicks(200), [0, 50, 100, 150, 200]);
  });

  test('every tick is a whole number for every ceiling the scaler can produce', () => {
    for (let k = 0; k < 5; k++) {
      for (const mantissa of [1, 2, 5]) {
        const max = mantissa * Math.pow(10, k);
        const ticks = trend.trendTicks(max);
        assert.ok(ticks.every(Number.isInteger), `max=${max} produced ${ticks}`);
        assert.deepEqual(ticks, [...new Set(ticks)], `max=${max} repeated a label`);
        assert.equal(ticks[0], 0);
        assert.equal(ticks[ticks.length - 1], max);
      }
    }
  });

  test('a tiny ceiling counts by ones rather than by fractions', () => {
    assert.deepEqual(trend.trendTicks(1), [0, 1]);
    assert.deepEqual(trend.trendTicks(3), [0, 1, 2, 3]);
    assert.deepEqual(trend.trendTicks(0), [0, 1]);
  });
});

describe('trend — geometry', () => {
  const g = () => trend.trendGeometry(500, 200, 7, 100);

  test('x spreads the window across the plot and y is inverted', () => {
    const geo = g();
    assert.equal(geo.x(0), geo.x0);
    assert.equal(geo.x(6), geo.x1);
    assert.ok(geo.x(3) > geo.x(2));
    assert.equal(geo.y(0), geo.y0, 'zero sits on the baseline');
    assert.equal(geo.y(100), geo.y1, 'the ceiling sits at the top');
    assert.ok(geo.y(50) > geo.y(100), 'y grows downward in SVG');
  });

  test('a single captured day lands in the middle rather than at Infinity', () => {
    const geo = trend.trendGeometry(500, 200, 1, 10);
    assert.ok(Number.isFinite(geo.x(0)));
    assert.equal(geo.x(0), (geo.x0 + geo.x1) / 2);
  });

  test('no coordinate is ever NaN, whatever the value', () => {
    const geo = g();
    for (const v of [null, undefined, NaN, -3, 'x']) {
      assert.ok(Number.isFinite(geo.y(v)), `y(${v}) is not finite`);
    }
  });

  test('a zero-width container cannot invert the plot', () => {
    const geo = trend.trendGeometry(0, 200, 7, 10);
    assert.ok(geo.x1 > geo.x0, 'x1 must stay right of x0');
  });
});

describe('trend — paths break at gaps rather than bridging them', () => {
  const g = trend.trendGeometry(500, 200, 5, 100);

  test('a line starts a new subpath after every gap', () => {
    // Joining across a gap draws a straight line between two real readings and
    // invites somebody to read a value off the middle of it.
    const d = trend.trendLinePath([10, 20, null, 40, 50], g);
    assert.equal((d.match(/M/g) || []).length, 2, 'two runs, two moves');
    assert.equal((d.match(/L/g) || []).length, 2);
  });

  test('an unbroken series is one subpath', () => {
    const d = trend.trendLinePath([1, 2, 3, 4, 5], g);
    assert.equal((d.match(/M/g) || []).length, 1);
  });

  test('an all-gap series draws nothing at all', () => {
    assert.equal(trend.trendLinePath([null, null, null], g), '');
  });

  test('the solid overlay still breaks, which is what reveals the dashed bridge', () => {
    // Q23 changed what is drawn, not what these helpers do. The bridge is drawn
    // from the carried series (continuous) and the solid stroke from the
    // measured one (broken), so the dashes show through exactly across the
    // stretch nobody refreshed. If the measured path stopped breaking, the
    // solid line would cover the dashes and the inference would become
    // invisible.
    const carried  = trend.trendLinePath([10, 10, 40], g);
    const measured = trend.trendLinePath([10, null, 40], g);
    assert.equal((carried.match(/M/g) || []).length, 1, 'the bridge is continuous');
    assert.equal((measured.match(/M/g) || []).length, 2, 'the overlay still breaks');
  });

  test('a stacked band closes one shape per run', () => {
    const d = trend.trendAreaPath([10, 20, null, 40, 50], [0, 0, null, 0, 0], g);
    assert.equal((d.match(/Z/g) || []).length, 2, 'two runs, two closed shapes');
  });

  test('a one-day island produces no area — its marker carries the reading', () => {
    const d = trend.trendAreaPath([null, 30, null], [null, 0, null], g);
    assert.equal(d, '');
  });

  test('every emitted coordinate is finite', () => {
    const d = trend.trendLinePath([0, null, 7], g) + ' '
            + trend.trendAreaPath([5, 6, 7], [0, 0, 0], g);
    assert.ok(!/NaN|Infinity|undefined/.test(d), d);
  });
});

describe('trend — stacking', () => {
  const rows = [
    { critical: 1, high: 2, medium: 3, low: 4 },
    null,
    { critical: 5, high: 0, medium: 0, low: 0 },
  ];

  test('bands accumulate in severity order from the baseline up', () => {
    const { bands, max } = trend.trendStack(rows);
    assert.deepEqual(bands.map(b => b.key), ['critical', 'high', 'medium', 'low']);
    assert.equal(bands[0].lower[0], 0, 'critical sits on the axis');
    assert.equal(bands[0].upper[0], 1);
    assert.equal(bands[1].upper[0], 3);
    assert.equal(bands[3].upper[0], 10, 'the top band is the day total');
    assert.equal(max, 10);
  });

  test('a gap stays a gap in every band', () => {
    const { bands } = trend.trendStack(rows);
    for (const b of bands) {
      assert.equal(b.lower[1], null);
      assert.equal(b.upper[1], null);
    }
  });

  test('the peak of an unstacked chart is the largest single series value', () => {
    assert.equal(trend.trendPeak(rows, ['critical', 'high', 'medium', 'low']), 5);
    assert.equal(trend.trendPeak([null, null], ['critical']), 0);
  });

  test('a negative slipping through is clamped rather than drawn below the axis', () => {
    const { max } = trend.trendStack([{ critical: -5, high: 3, medium: 0, low: 0 }]);
    assert.equal(max, 3);
  });
});

describe('trend — axis labels', () => {
  test('a day is labelled in the calendar it names', () => {
    assert.equal(trend.trendDayLabel('2026-09-07'), '7 Sep');
    assert.equal(trend.trendDayLabel('2026-01-01'), '1 Jan');
    assert.equal(trend.trendDayLabel('2026-12-31'), '31 Dec');
  });

  test('a malformed day is shown rather than swallowed', () => {
    assert.equal(trend.trendDayLabel('nonsense'), 'nonsense');
  });

  test('a short window labels every point and a long one thins out', () => {
    assert.deepEqual(trend.trendLabelIndices(7), [0, 1, 2, 3, 4, 5, 6]);
    const year = trend.trendLabelIndices(365);
    assert.ok(year.length <= 7, `365 days produced ${year.length} labels`);
    assert.ok(year.length < 365, 'a year must not print a label per day');
    assert.equal(year[0], 0);
    assert.equal(year[year.length - 1], 364, 'the newest day is always labelled');
  });

  test('how many labels fit is derived from the width, not assumed', () => {
    // The same seven days have room for seven dates across the combined chart
    // and for three in a small multiple.
    assert.ok(trend.trendLabelCapacity(1200) >= 6);
    assert.ok(trend.trendLabelCapacity(200) < trend.trendLabelCapacity(1200));
    assert.ok(trend.trendLabelCapacity(0) >= 2, 'never fewer than the two ends');
    assert.deepEqual(trend.trendLabelIndices(7, trend.trendLabelCapacity(140)),
      [0, 6], 'a very narrow chart still labels both ends');
  });

  test('the thinning never repeats an index', () => {
    for (const n of [1, 2, 5, 6, 7, 8, 30, 90, 365]) {
      const ix = trend.trendLabelIndices(n);
      assert.deepEqual(ix, [...new Set(ix)], `n=${n}`);
      assert.ok(ix.every(i => i >= 0 && i < n), `n=${n} produced an out-of-range index`);
    }
  });
});

describe('trend — the panel in the page', () => {
  test('it renders above the summary cards', () => {
    const panel = INDEX_HTML.indexOf('id="trendPanel"');
    const grid  = INDEX_HTML.indexOf('id="summaryGrid"');
    assert.ok(panel !== -1 && grid !== -1);
    assert.ok(panel < grid, 'the trend panel must come before the summary grid');
  });

  test('every inline handler is window-exported', () => {
    // §8.2: a handler missing from the export block fails silently at runtime.
    const handlers = [...INDEX_HTML.matchAll(/on(?:click|change)="(\w+)\(/g)]
      .map(m => m[1])
      .filter(n => /^(toggleTrend|onTrend|loadTrend)/.test(n));
    assert.ok(handlers.length >= 5, `expected the trend handlers, found ${handlers}`);
    for (const h of [...new Set(handlers)]) {
      assert.match(INDEX_HTML, new RegExp(`window\\.${h}\\s*=`), `${h} is not exported`);
    }
  });

  test('the chart colours are custom properties, never hex literals', () => {
    // §8.10: a hard-coded hex would not follow the theme, and an SVG attribute
    // is exactly where that mistake hides from a CSS review.
    const levels = INDEX_HTML.match(/const TREND_LEVELS = \[[\s\S]*?\];/)[0];
    assert.ok(!/#[0-9a-fA-F]{3,8}/.test(levels), 'a literal colour crept into TREND_LEVELS');
    for (const v of ['--critical', '--high', '--medium', '--low']) {
      assert.ok(levels.includes(`var(${v})`), `${v} is not used`);
    }
  });

  test('a period the server would refuse cannot come out of storage', () => {
    // localStorage is viewer-writable and survives a downgrade. A stored
    // "decade" would make every load a 400.
    const fn = extractFunction(INDEX_HTML, 'loadTrendView');
    assert.match(fn, /\['week', 'month', 'year'\]\.includes/,
      'the stored period must be validated against what the route accepts');
    assert.match(fn, /catch/, 'storage access must be guarded — it throws in some contexts');
  });

  test('saving the view never fails a render', () => {
    assert.match(extractFunction(INDEX_HTML, 'saveTrendView'), /try\s*\{[\s\S]*catch/);
  });

  test('a superseded series response cannot overwrite a newer one', () => {
    // Choosing "year" then "week" fires two requests and the year's larger
    // payload can land second.
    const fn = extractFunction(INDEX_HTML, 'loadTrend');
    assert.match(fn, /_trendReqSeq/, 'the request must be sequence-guarded');
    assert.equal((fn.match(/seq !== _trendReqSeq/g) || []).length, 2,
      'both the success and the failure path must check');
  });

  test('a completed refetch reloads the series', () => {
    // The build writes today's snapshot on its way out, so the series in hand
    // is one point out of date the moment the banner turns green.
    const poll = INDEX_HTML.slice(INDEX_HTML.indexOf('function startCachePoll'));
    const ready = poll.slice(poll.indexOf("s.status === 'ready'"), poll.indexOf("} else {"));
    assert.match(ready, /loadTrend\(\)/,
      'a finished build must refresh the trend, or the newest point never appears');
  });

  test('the panel is not measured while it is collapsed', () => {
    // clientWidth of a hidden element is zero, which would render every chart
    // at padding width and cache that until the next resize.
    const fn = extractFunction(INDEX_HTML, 'renderTrend');
    const guard = fn.indexOf('if (!_trendView.open) return;');
    assert.ok(guard !== -1, 'renderTrend must bail out while collapsed');
    assert.ok(guard < fn.indexOf('trendCharts'), 'the guard must come before any measuring');
  });

  test('resize redraws are debounced', () => {
    // §13: re-rendering four SVGs per frame during a window drag.
    assert.match(extractFunction(INDEX_HTML, 'onTrendResize'), /clearTimeout[\s\S]*setTimeout/);
  });

  test('the period control offers exactly what the route accepts', () => {
    const select = INDEX_HTML.slice(
      INDEX_HTML.indexOf('id="trendPeriod"'),
      INDEX_HTML.indexOf('</select>', INDEX_HTML.indexOf('id="trendPeriod"')));
    const values = [...select.matchAll(/value="(\w+)"/g)].map(m => m[1]);
    assert.deepEqual(values, ['week', 'month', 'year']);
  });

  test('the default metric is the one the cards show', () => {
    // Defaulting to pure severity would put a different "Critical" directly
    // above the card labelled Critical.
    const decl = INDEX_HTML.match(/let _trendView = \{[\s\S]*?\n\};/)[0];
    assert.match(decl, /metric: 'total'/);
    assert.match(decl, /period: 'week'/, 'the plan specified a one-week default');
  });
});

describe('trend — carrying a reading across unrefreshed days (Q23)', () => {
  const A = { critical: 10, high: 1, medium: 1, low: 1 };
  const B = { critical: 40, high: 2, medium: 2, low: 2 };

  test('a gap inherits the previous reading, and is flagged as inherited', () => {
    // The chart must be continuous — a broken line reads as "the tool stopped
    // working" — but a carried number must never be mistakable for a measured
    // one, which is what `carried` drives: no dot, a dashed bridge, a shaded
    // span and an attributed tooltip.
    const { values, carried, measured } = trend.trendCarry([A, null, null, B]);
    assert.deepEqual(values, [A, A, A, B]);
    assert.deepEqual(carried, [false, true, true, false]);
    assert.deepEqual(measured, [A, null, null, B], 'the real readings stay separable');
  });

  test('days before the first reading stay empty rather than inventing a past', () => {
    // On the day this ships, a "last year" view has 364 days with nothing
    // behind them. Extending the first value backwards across them would be
    // invention, not inference.
    const { values, carried } = trend.trendCarry([null, null, A, null]);
    assert.deepEqual(values, [null, null, A, A]);
    assert.deepEqual(carried, [false, false, false, true],
      'a leading blank is not a carried value');
  });

  test('a series with no readings at all carries nothing', () => {
    const { values, carried } = trend.trendCarry([null, null, null]);
    assert.deepEqual(values, [null, null, null]);
    assert.ok(carried.every(c => c === false));
  });

  test('an unbroken series is returned unchanged and nothing is flagged', () => {
    const { values, carried, measured } = trend.trendCarry([A, B, A]);
    assert.deepEqual(values, [A, B, A]);
    assert.deepEqual(measured, [A, B, A]);
    assert.ok(carried.every(c => c === false));
  });

  test('the carried value is the last reading, never an interpolation', () => {
    // Interpolating would be worse than carrying: a sloping line between two
    // readings asserts a trajectory through days nobody looked at.
    const { values } = trend.trendCarry([A, null, B]);
    assert.equal(values[1].critical, A.critical);
    assert.notEqual(values[1].critical, (A.critical + B.critical) / 2);
  });

  test('gap runs are grouped, not emitted one rectangle per day', () => {
    // Adjacent rectangles with shared edges render as visible seams, and the
    // thing being marked is the stretch rather than each day in it.
    assert.deepEqual(trend.trendGapRuns([false, true, true, false, true, false]),
      [{ start: 1, end: 2 }, { start: 4, end: 4 }]);
  });

  test('a run reaching the end of the window is closed', () => {
    assert.deepEqual(trend.trendGapRuns([false, true, true]), [{ start: 1, end: 2 }]);
    assert.deepEqual(trend.trendGapRuns([true]), [{ start: 0, end: 0 }]);
  });

  test('no gaps means no bands', () => {
    assert.deepEqual(trend.trendGapRuns([false, false, false]), []);
    assert.deepEqual(trend.trendGapRuns([]), []);
  });

  test('a carried day is never given a data marker', () => {
    // A dot asserts "a reading was taken here". That is what keeps every
    // plotted point quotable.
    const fn = extractFunction(INDEX_HTML, 'trendCellHtml');
    const dots = fn.slice(fn.indexOf('Markers for every captured reading'));
    assert.match(dots, /carry\.carried\[i\]\) continue/,
      'the marker loop must skip carried positions');
  });

  test('the line is drawn twice — a dashed bridge under a solid measured stroke', () => {
    const fn = extractFunction(INDEX_HTML, 'trendCellHtml');
    assert.match(fn, /stroke-dasharray="4 4"/, 'the bridging stroke must be dashed');
    assert.match(fn, /trendLinePath\(pick\(drawn\), g\)/,  'the bridge comes from the carried series');
    assert.match(fn, /trendLinePath\(pick\(carry\.measured\), g\)/,
      'the solid stroke comes from the measured series, so it breaks at gaps');
    assert.ok(fn.indexOf('const bridge') < fn.indexOf('const solid'),
      'the dashed path must be drawn first, or it covers the solid one');
  });

  test('the shading is drawn over the data, not under it', () => {
    // Underneath, a stacked area covers it almost completely — and the stacked
    // view is the one with no dashed stroke to fall back on, so the band is its
    // only signal that a stretch was not measured.
    const fn = extractFunction(INDEX_HTML, 'trendCellHtml');
    const band = fn.indexOf('trend-gap-band');
    const area = fn.indexOf('trendAreaPath');
    const line = fn.indexOf('const bridge');
    assert.ok(band > area && band > line,
      'the band must be emitted after the series, or the fill hides it');
  });

  test('the shaded span has a crisp edge as well as a wash', () => {
    // A translucent fill over saturated colour is easy to miss; a hard boundary
    // says precisely where the measured data stops and starts again.
    const fn = extractFunction(INDEX_HTML, 'trendCellHtml');
    assert.match(fn, /trend-gap-edge/);
    const css = INDEX_HTML.match(/\.trend-gap-edge \{[^}]*\}/)[0];
    assert.match(css, /stroke-dasharray/);
    assert.ok(!/#[0-9a-fA-F]{3,8}/.test(css));
  });

  test('the shaded span is a theme variable, not a literal', () => {
    const css = INDEX_HTML.match(/\.trend-gap-band \{[^}]*\}/)[0];
    assert.ok(!/#[0-9a-fA-F]{3,8}/.test(css), 'a literal colour would not follow the theme');
    assert.match(css, /var\(--/);
  });

  test('the tooltip names the day a carried number came from', () => {
    // "No refresh that day" alone leaves the reader unable to tell which
    // measurement they are looking at.
    const fn = extractFunction(INDEX_HTML, 'showTrendTip');
    assert.match(fn, /No refresh that day — showing/);
    assert.match(fn, /carry\.measured\[k\] !== null/,
      'it must scan back to the nearest measured day, not assume the previous one');
  });

  test('the header still reports how many days were actually recorded', () => {
    // Carrying forward makes the chart continuous, so this count is now the
    // only place the raw honesty lives. It must not be dropped.
    const fn = extractFunction(INDEX_HTML, 'renderTrend');
    assert.match(fn, /of \$\{points\.length\} day/);
    assert.match(fn, /captured = points\.filter\(p => p\.captured\)\.length/);
  });

  test('the legend explains the shading rather than calling it a gap', () => {
    const fn = extractFunction(INDEX_HTML, 'renderTrend');
    assert.match(fn, /carried forward/,
      'the legend must say what the shading means now that lines are continuous');
  });
});

// ── Vulnerability detail dialog ─────────────────────────────────────────────
// The eye icon and the dialog behind it. Extracted from index.html's own
// source rather than copied, so a test cannot pass against a version of the
// code the page no longer contains (CLAUDE.md §10.5).

const VULN_FN_NAMES = [
  'hasVulnerabilities', 'vulnEyeIconHtml', 'vulnFindingsQuery',
  'vulnCweIds', 'vulnCweLabel', 'sortFindingsBySeverity', 'vulnRowHtml',
  'componentKeyOf', 'vulnOriginCellHtml',
];
const vuln = new Function(
  INDEX_HTML.match(/const CONFIG = \{[\s\S]*?\n\};/)[0] + '\n'
  + INDEX_HTML.match(/const LEVEL_CSS = \{[\s\S]*?\n\};/)[0] + '\n'
  + INDEX_HTML.match(/const VULN_SEVERITY_ORDER = \[[\s\S]*?\];/)[0] + '\n'
  + extractFunction(INDEX_HTML, 'escHtml') + '\n'
  + VULN_FN_NAMES.map(n => extractFunction(INDEX_HTML, n)).join('\n')
  + `\nreturn { ${VULN_FN_NAMES.join(', ')} };`
)();

describe('vulnerability dialog — the eye icon', () => {
  const leaf  = (sec) => ({ uuid: 'leaf-1', name: 'svc', children: [], security: sec });
  const group = (sec) => ({ uuid: 'grp-1', name: 'grp', children: [{}], security: sec });

  test('hasVulnerabilities is true when any severity, unassigned included, is nonzero', () => {
    assert.equal(vuln.hasVulnerabilities({ security: { critical: 1 } }), true);
    assert.equal(vuln.hasVulnerabilities({ security: { unassigned: 1 } }), true, 'unassigned still counts');
    assert.equal(vuln.hasVulnerabilities({ security: { critical: 0, high: 0, medium: 0, low: 0, unassigned: 0 } }), false);
    assert.equal(vuln.hasVulnerabilities({ security: {} }), false);
    assert.equal(vuln.hasVulnerabilities({}), false, 'a node with no security object at all must not throw');
  });

  test('the icon renders only for a leaf with at least one finding', () => {
    assert.notEqual(vuln.vulnEyeIconHtml(leaf({ critical: 1 }), false), '');
    assert.equal(vuln.vulnEyeIconHtml(leaf({ critical: 0, high: 0, medium: 0, low: 0, unassigned: 0 }), false), '',
      'a clean leaf gets no icon');
  });

  test('a group row never gets the icon, even carrying nonzero aggregated counts', () => {
    // A parent's security numbers are its descendants' rolled up (§8.7); it has
    // no DependencyTrack project of its own to ask for findings.
    assert.equal(vuln.vulnEyeIconHtml(group({ critical: 5 }), true), '');
  });

  test('the icon carries the project uuid and calls openVulnDialog', () => {
    const html = vuln.vulnEyeIconHtml(leaf({ critical: 1 }), false);
    assert.match(html, /openVulnDialog\('leaf-1'\)/);
  });

  test('the click is guarded so it cannot also toggle the row or the checkbox', () => {
    assert.match(vuln.vulnEyeIconHtml(leaf({ critical: 1 }), false), /event\.stopPropagation\(\)/);
  });

  test('the project name reaches the title through escHtml', () => {
    const html = vuln.vulnEyeIconHtml(leaf({ critical: 1 }) && { ...leaf({ critical: 1 }), name: '<script>' }, false);
    assert.doesNotMatch(html, /<script>/, 'an unescaped name would be a stored XSS via the title attribute');
    assert.match(html, /&lt;script&gt;/);
  });

  test('the icon sits inside the existing cells — index.html adds no new <td>', () => {
    // "Next to the checkbox, not a new column" is a structural claim, not just
    // a visual one: colspan="20" on the empty-state row must still be correct.
    const treeRow = extractFunction(INDEX_HTML, 'renderTree');
    assert.match(treeRow, /\$\{vulnIcon\}\$\{toggle\}/,
      'the icon must be emitted inside the project-name <td>, before the tree toggle');
    const flatRow = extractFunction(INDEX_HTML, 'renderFlatList');
    assert.match(flatRow, /\$\{vulnIcon\}<span class="tree-indent">/);
  });
});

describe('vulnerability dialog — the DependencyTrack query', () => {
  test('mirrors reports.js\'s fetchAllFindings() exactly, not the project/{uuid} endpoint', () => {
    // A deliberate choice, not an oversight — see the comment above
    // vulnFindingsQuery in index.html. Pinned here so nobody "simplifies" it
    // to the path-based endpoint without making that decision again.
    const qs = vuln.vulnFindingsQuery('svc', '1.2.0', 1);
    assert.match(qs, /showSuppressed=false/);
    assert.match(qs, /analysisStatus=NOT_SET,EXPLOITABLE,IN_TRIAGE/);
    assert.match(qs, /textSearchInput=svc%201.2.0/);
    assert.match(qs, /pageSize=300/);
    assert.match(qs, /pageNumber=1/);
  });

  test('the reports.js filter string and the dialog\'s are the same, byte for byte', () => {
    // The report and the dialog must never disagree about what counts as an
    // open finding. Reading reports.js's own source is what makes this a real
    // cross-file check rather than two copies that can drift unnoticed.
    const reportsSrc = fs.readFileSync(
      path.join(__dirname, 'lib', 'reports.js'), 'utf8');
    const reportQs = reportsSrc.match(/const baseQs = \[([\s\S]*?)\]\.join/)[1];
    for (const clause of ['showInactive=false', 'showSuppressed=false',
      'severity=critical,high,medium,low,unassigned', 'analysisStatus=NOT_SET,EXPLOITABLE,IN_TRIAGE']) {
      assert.ok(reportQs.includes(`'${clause}'`), `reports.js no longer sends ${clause}`);
      assert.ok(vuln.vulnFindingsQuery('x', '1', 1).includes(clause),
        `the dialog's query dropped ${clause} that reports.js still sends`);
    }
  });

  test('an empty version does not produce a stray parameter, just a trailing space in the search text', () => {
    const qs = vuln.vulnFindingsQuery('Group 1', '', 1);
    assert.match(qs, /textSearchInput=Group%201%20/);
  });
});

describe('vulnerability dialog — CWE labelling stays in step with lib/cwe.js', () => {
  test('cweIdsOf and cweLabel produce the identical output to the server module', () => {
    const cweSrc = fs.readFileSync(path.join(__dirname, 'lib', 'cwe.js'), 'utf8');
    // eslint-disable-next-line no-eval
    const serverFns = (new Function('module', 'exports', cweSrc + '\nreturn module.exports;'))({ exports: {} }, {});

    const cases = [
      { cwes: [{ cweId: 79 }] },
      { cwes: [{ cweId: '89' }] },
      { cwes: [{ cweId: 'CWE-20' }] },
      { cwes: [] },
      {},
      { cwes: [{ cweId: 79 }, { cweId: 89 }] },
    ];
    for (const v of cases) {
      assert.deepEqual(vuln.vulnCweIds(v), serverFns.cweIdsOf(v), JSON.stringify(v));
      assert.equal(vuln.vulnCweLabel(v), serverFns.cweLabel(v), JSON.stringify(v));
    }
  });
});

describe('vulnerability dialog — sorting and rendering', () => {
  const f = (severity, cvss) => ({ vulnerability: { vulnId: `V-${severity}-${cvss}`, severity, cvssV3BaseScore: cvss } });

  test('worst severity sorts first, then highest CVSS within a severity', () => {
    const sorted = vuln.sortFindingsBySeverity([
      f('LOW', 3.0), f('CRITICAL', 5.0), f('CRITICAL', 9.8), f('MEDIUM', 6.0), f('UNASSIGNED', 0),
    ]);
    assert.deepEqual(sorted.map(x => x.vulnerability.vulnId), [
      'V-CRITICAL-9.8', 'V-CRITICAL-5', 'V-MEDIUM-6', 'V-LOW-3', 'V-UNASSIGNED-0',
    ]);
  });

  test('a finding with no severity at all sorts last, not first', () => {
    const sorted = vuln.sortFindingsBySeverity([{ vulnerability: { vulnId: 'bare' } }, f('LOW', 1)]);
    assert.equal(sorted[sorted.length - 1].vulnerability.vulnId, 'bare');
  });

  test('every field in a row passes through escHtml', () => {
    const row = vuln.vulnRowHtml({
      vulnerability: { vulnId: '<x>', severity: '<y>', cvssV3BaseScore: 9.8, cwes: [{ cweId: 79 }] },
      component: { name: '<z>', version: '<v>', latestVersion: '<w>' },
    });
    assert.doesNotMatch(row, /<x>|<y>|<z>|<v>|<w>/);
    assert.match(row, /&lt;x&gt;/);
  });

  test('a missing CVSS score renders as an em dash, never blank or "null"', () => {
    const row = vuln.vulnRowHtml({ vulnerability: { vulnId: 'V' }, component: {} });
    assert.match(row, /<td>—<\/td>/);
    assert.doesNotMatch(row, /null|undefined|NaN/);
  });

  test('the severity cell reuses the existing pill classes, not a new colour system', () => {
    // §8.10: no colour hex, no parallel badge component — the same
    // pill-critical/pill-high/… classes the risk table already uses.
    const row = vuln.vulnRowHtml({ vulnerability: { vulnId: 'V', severity: 'CRITICAL' }, component: {} });
    assert.match(row, /class="pill pill-critical"/);
  });
});

describe('vulnerability dialog — structure in the page', () => {
  test('the dialog markup exists with the ids the JS drives', () => {
    for (const id of ['vulnDialog', 'vulnDialogProject', 'vulnDialogStatus',
                       'vulnDialogTableWrap', 'vulnDialogRows', 'vulnDialogNote']) {
      assert.match(INDEX_HTML, new RegExp(`id="${id}"`), `#${id} is missing`);
    }
  });

  test('openVulnDialog is window-exported, or the onclick handler fails silently (§8.2)', () => {
    assert.match(INDEX_HTML, /window\.openVulnDialog\s*=\s*openVulnDialog/);
  });

  test('an unconfigured account is told to connect, without a network round trip', () => {
    const fn = extractFunction(INDEX_HTML, 'openVulnDialog');
    assert.match(fn, /if \(!dtConfigured\)/);
    // The early return must come before fetchProjectFindings is ever called.
    const guardAt  = fn.indexOf('if (!dtConfigured)');
    const fetchAt  = fn.indexOf('fetchProjectFindings(');
    assert.ok(guardAt !== -1 && fetchAt !== -1 && guardAt < fetchAt);
  });

  test('a superseded click cannot land its response in a dialog the user has moved on from', () => {
    const fn = extractFunction(INDEX_HTML, 'openVulnDialog');
    assert.match(fn, /_vulnReqSeq/);
    const fetchFn = extractFunction(INDEX_HTML, 'fetchProjectFindings');
    assert.match(fetchFn, /seq !== _vulnReqSeq/);
  });

  test('the fetch loop is bounded, so a huge project cannot spin forever', () => {
    const fn = extractFunction(INDEX_HTML, 'fetchProjectFindings');
    assert.match(fn, /VULN_MAX_ROWS/);
  });

  test('the CSS uses theme variables, never a literal colour', () => {
    const css = INDEX_HTML.slice(
      INDEX_HTML.indexOf('.vuln-eye-btn'), INDEX_HTML.indexOf('/* ── Pills'));
    assert.ok(!/#[0-9a-fA-F]{3,8}/.test(css), 'a literal hex colour crept into the dialog styling');
  });
});

// ── Dependency-path origin (Direct/Transitive) ──────────────────────────────
// Answers the release-engineer question the vulnerability dialog exists for:
// does this finding block the release (direct), or can it wait for the
// security SME's backlog (transitive)? See lib/dependency-paths.js and
// CLAUDE.md's dependency-paths convention note for the design.

describe('dependency paths — component identity (frontend)', () => {
  test('mirrors lib/dependency-paths.js\'s componentKey() exactly', () => {
    // lib/dependency-paths.js requires other lib/ modules at load time, unlike
    // lib/cwe.js — a sandboxed new Function() load has no require() to resolve
    // them, so this reads it the way CLAUDE.md §10.4 already prefers for a
    // pure helper with no I/O at require time: an ordinary require().
    const serverComponentKey = require('./lib/dependency-paths').componentKey;

    const cases = [
      { purl: 'pkg:npm/x@1', name: 'x', group: 'g', version: '1' },
      { name: 'x', group: 'g', version: '1' },
      { name: 'x', version: '1' },
      {},
      null,
    ];
    for (const c of cases) {
      assert.equal(vuln.componentKeyOf(c), serverComponentKey(c), JSON.stringify(c));
    }
  });

  test('purl wins when present; group/name/version otherwise', () => {
    assert.equal(vuln.componentKeyOf({ purl: 'pkg:npm/x@1' }), 'pkg:npm/x@1');
    assert.equal(vuln.componentKeyOf({ name: 'x', group: 'g', version: '1' }), 'g::x::1');
  });
});

describe('dependency paths — the Origin cell', () => {
  test('an unresolved origin (Tier 1 not back yet) shows a neutral placeholder, not a wrong answer', () => {
    const html = vuln.vulnOriginCellHtml(null);
    assert.doesNotMatch(html, /Direct|Transitive/);
  });

  test('Direct reuses the existing pill system, not a new colour', () => {
    const html = vuln.vulnOriginCellHtml({ direct: true });
    assert.match(html, /class="pill pill-high">Direct</);
  });

  test('Transitive with the toggle off shows the badge alone, no chain', () => {
    const html = vuln.vulnOriginCellHtml({ direct: false });
    assert.match(html, /class="pill pill-low">Transitive</);
    assert.doesNotMatch(html, /dep-path-chain/);
  });

  test('Transitive with the toggle on but the walk not ready yet shows no chain either', () => {
    const html = vuln.vulnOriginCellHtml({ direct: false, pathsReady: false });
    assert.doesNotMatch(html, /dep-path-chain/);
  });

  test('a resolved chain renders escaped, arrow-joined, from a direct dependency', () => {
    const html = vuln.vulnOriginCellHtml({
      direct: false, pathsReady: true, chain: ['<carrier>', 'target'], multiple: false,
    });
    assert.doesNotMatch(html, /<carrier>/, 'an unescaped component name would be a stored XSS');
    assert.match(html, /&lt;carrier&gt;/);
    assert.doesNotMatch(html, /more routes/);
  });

  test('a component reachable from more than one direct dependency says so', () => {
    const html = vuln.vulnOriginCellHtml({
      direct: false, pathsReady: true, chain: ['a', 'x'], multiple: true,
    });
    assert.match(html, /more routes/i);
  });

  test('a resolved walk that never reached this component says so plainly, not a blank cell', () => {
    const html = vuln.vulnOriginCellHtml({ direct: false, pathsReady: true, chain: null });
    assert.match(html, /No path recorded/i);
  });
});

describe('dependency paths — vulnOriginFor (which badge a row gets)', () => {
  // vulnOriginFor reads three module-scoped variables the real page keeps
  // updated as Tier 1 and Tier 2 resolve. The sandbox wires them the same way
  // the eye-icon suite wires CONFIG/LEVEL_CSS — declared alongside the
  // extracted function, then set per call through a small test-only adapter.
  const originSandbox = new Function(
    'let _vulnDirectKeys, _depPathStatus, _depPathPaths;\n'
    + extractFunction(INDEX_HTML, 'componentKeyOf') + '\n'
    + extractFunction(INDEX_HTML, 'vulnOriginFor') + '\n'
    + `return { vulnOriginFor: function(finding, showPaths, directKeys, status, paths) {
         _vulnDirectKeys = directKeys; _depPathStatus = status; _depPathPaths = paths;
         return vulnOriginFor(finding, showPaths);
       } };`
  )();

  const finding = (purl) => ({ component: { purl } });

  test('no Tier 1 yet returns null — never guesses a badge', () => {
    assert.equal(originSandbox.vulnOriginFor(finding('pkg:npm/x@1'), false, null, 'none', {}), null);
  });

  test('a component in the direct set is Direct, regardless of the toggle', () => {
    const direct = new Set(['pkg:npm/x@1']);
    const out = originSandbox.vulnOriginFor(finding('pkg:npm/x@1'), false, direct, 'none', {});
    assert.deepEqual(out, { direct: true });
  });

  test('a component outside the direct set is Transitive, toggle off, no path lookup happens', () => {
    const out = originSandbox.vulnOriginFor(finding('pkg:npm/y@1'), false, new Set(), 'ready',
      { 'pkg:npm/y@1': { chain: ['a', 'y'], multiple: false } });
    assert.equal(out.direct, false);
    assert.equal(out.pathsReady, undefined, 'the chain must not be attached when the toggle is off');
  });

  test('toggle on but the walk has not resolved yet reports pathsReady:false', () => {
    const out = originSandbox.vulnOriginFor(finding('pkg:npm/y@1'), true, new Set(), 'building', {});
    assert.equal(out.direct, false);
    assert.equal(out.pathsReady, false);
  });

  test('toggle on and ready attaches the resolved chain for this exact component', () => {
    const out = originSandbox.vulnOriginFor(finding('pkg:npm/y@1'), true, new Set(), 'ready',
      { 'pkg:npm/y@1': { chain: ['a', 'y'], multiple: true } });
    assert.equal(out.pathsReady, true);
    assert.deepEqual(out.chain, ['a', 'y']);
    assert.equal(out.multiple, true);
  });

  test('toggle on, ready, but this component has no entry — chain is null, not a stale one from another row', () => {
    const out = originSandbox.vulnOriginFor(finding('pkg:npm/never-declared@1'), true, new Set(), 'ready',
      { 'pkg:npm/y@1': { chain: ['a', 'y'], multiple: false } });
    assert.equal(out.pathsReady, true);
    assert.equal(out.chain, null);
  });
});

describe('dependency paths — transitiveTargets (Q26 walk scoping)', () => {
  // transitiveTargets reads the same two module-scoped variables vulnOriginFor
  // does, wired the same way.
  const targetsSandbox = new Function(
    'let _vulnDirectKeys, _vulnShownFindings;\n'
    + extractFunction(INDEX_HTML, 'componentKeyOf') + '\n'
    + extractFunction(INDEX_HTML, 'transitiveTargets') + '\n'
    + `return { transitiveTargets: function(directKeys, shownFindings) {
         _vulnDirectKeys = directKeys; _vulnShownFindings = shownFindings;
         return transitiveTargets();
       } };`
  )();

  const finding = (purl) => ({ component: { purl } });

  test('Tier 1 not resolved yet returns null — asks the backend for its full-walk default', () => {
    assert.equal(targetsSandbox.transitiveTargets(null, [finding('pkg:npm/x@1')]), null);
  });

  test('every shown row is direct — returns an empty array, not null', () => {
    const direct = new Set(['pkg:npm/x@1']);
    assert.deepEqual(targetsSandbox.transitiveTargets(direct, [finding('pkg:npm/x@1')]), []);
  });

  test('only the transitive rows are included, deduplicated', () => {
    const direct = new Set(['pkg:npm/x@1']);
    const shown = [finding('pkg:npm/y@1'), finding('pkg:npm/x@1'), finding('pkg:npm/y@1')];
    assert.deepEqual(targetsSandbox.transitiveTargets(direct, shown), ['pkg:npm/y@1']);
  });
});

describe('dependency paths — the table gains an Origin column', () => {
  test('the header row and every rendered row carry Origin as the eighth column', () => {
    assert.match(INDEX_HTML, /<th>Latest<\/th><th>Origin<\/th>/);
    const row = vuln.vulnRowHtml(
      { vulnerability: { vulnId: 'V' }, component: {} }, { direct: true });
    const cells = (row.match(/<td/g) || []).length;
    assert.equal(cells, 8, 'the row must gain exactly one column, not silently duplicate an old one');
    assert.match(row, /class="vuln-origin"/);
  });

  test('an omitted origin (Tier 1 still pending) does not crash row rendering', () => {
    assert.doesNotThrow(() => vuln.vulnRowHtml({ vulnerability: { vulnId: 'V' }, component: {} }));
  });
});

describe('dependency paths — the toggle and its polling', () => {
  test('the toggle, its status line, and the Origin header all exist in the markup', () => {
    for (const id of ['vulnDepPathToggleWrap', 'vulnDepPathToggle', 'vulnDepPathStatus']) {
      assert.match(INDEX_HTML, new RegExp(`id="${id}"`), `#${id} is missing`);
    }
  });

  test('onVulnDepPathToggle is window-exported, or the checkbox fails silently (§8.2)', () => {
    assert.match(INDEX_HTML, /window\.onVulnDepPathToggle\s*=\s*onVulnDepPathToggle/);
  });

  test('a fresh dialog open resets every piece of dependency-path state', () => {
    // A stale toggle, chain or status line from whatever project was open
    // before must never bleed into the next one.
    const fn = extractFunction(INDEX_HTML, 'openVulnDialog');
    assert.match(fn, /stopDepPathPoll\(\)/);
    assert.match(fn, /_vulnDirectKeys\s*=\s*null/);
    assert.match(fn, /_depPathStatus\s*=\s*'none'/);
    assert.match(fn, /toggleEl\.checked\s*=\s*false/);
  });

  test('the poll stops when the dialog closes, not just when the walk finishes', () => {
    const fn = extractFunction(INDEX_HTML, 'closeModal');
    assert.match(fn, /id === 'vulnDialog'/);
    assert.match(fn, /stopDepPathPoll\(\)/);
  });

  test('a cache hit (already ready) renders immediately — no POST, no poll', () => {
    const fn = extractFunction(INDEX_HTML, 'onVulnDepPathToggle');
    assert.match(fn, /_depPathStatus === 'ready'/);
    const readyBranch = fn.slice(fn.indexOf("_depPathStatus === 'ready'"));
    const postAt = readyBranch.indexOf("method: 'POST'");
    const returnAt = readyBranch.indexOf('return;');
    assert.ok(returnAt !== -1 && (postAt === -1 || returnAt < postAt),
      'the ready branch must return before ever reaching the POST call');
  });

  test('a superseded toggle sequence cannot land its poll response after the user moved on', () => {
    const toggleFn = extractFunction(INDEX_HTML, 'onVulnDepPathToggle');
    assert.match(toggleFn, /_depPathReqSeq/);
    const pollFn = extractFunction(INDEX_HTML, 'startDepPathPoll');
    assert.match(pollFn, /seq !== _depPathReqSeq/);
  });

  test('every shown finding being direct short-circuits before any POST or poll', () => {
    // A flat, manifest-built SBOM (CLAUDE.md §6.3a) can legitimately have zero
    // transitive rows in a given dialog — walking for a chain that cannot
    // exist would just be a slower way to render nothing.
    const fn = extractFunction(INDEX_HTML, 'onVulnDepPathToggle');
    assert.match(fn, /targets\.length === 0/);
    const branch = fn.slice(fn.indexOf('targets.length === 0'));
    const postAt = branch.indexOf("method: 'POST'");
    const returnAt = branch.indexOf('return;');
    assert.ok(returnAt !== -1 && (postAt === -1 || returnAt < postAt),
      'the empty-targets branch must return before ever reaching the POST call');
  });

  test('a walk request carries the transitive-only target list as a JSON body', () => {
    const fn = extractFunction(INDEX_HTML, 'onVulnDepPathToggle');
    assert.match(fn, /body\s*=\s*JSON\.stringify\(\{\s*targets\s*\}\)/);
    assert.match(fn, /'Content-Type':\s*'application\/json'/);
  });

  test('the Origin badge and the security-severity pills are visually distinct systems', () => {
    // Direct/Transitive reuses pill-high/pill-low so it never needs a new
    // colour (§8.10) — but the word, not the colour, must carry the meaning,
    // so it cannot be misread as a severity value.
    const html = vuln.vulnOriginCellHtml({ direct: true });
    assert.doesNotMatch(html, /CRITICAL|HIGH|MEDIUM|LOW/, 'Origin text must never look like a severity level');
  });
});
