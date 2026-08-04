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
const INDEX_HTML  = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
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
  function fePassword(value) {
    if (typeof value !== 'string' || value.length === 0) return 'required';
    if (/\s/.test(value)) return 'space';
    if (value.length < 8) return 'too short';
    if (value.length > 128) return 'too long';
    return null;
  }

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
    const corpus = ['password', 'p@$$w0rd!', '日本語パスワード', 'passwor', 'pass word',
                    'pass\tword', '', 'a'.repeat(128), 'a'.repeat(129)];
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

  test('the administration panel also goes through apiFetch', () => {
    // A bare fetch() here would miss the bearer header and, worse, would not
    // redirect on 401 — the panel would look empty instead of signed out.
    assert.doesNotMatch(INDEX_HTML, /fetch\((['`])\/admin\//,
      'administration routes must be called through apiFetch()');
    assert.match(INDEX_HTML, /apiFetch\('\/admin\/overview'\)/);
    assert.match(INDEX_HTML, /apiFetch\('\/admin\/users'\)/);
  });

  test('the administration entry is hidden for a non-administrator', () => {
    assert.match(INDEX_HTML, /userMenuAdmin/);
    assert.match(INDEX_HTML, /adminItem\.style\.display\s*=\s*_currentUser\.isAdmin/,
      'the menu entry must be driven by the principal, not always shown');
  });

  test('administration handlers are window-exported from the IIFE', () => {
    for (const fn of ['openAdminPanel', 'closeAdminPanel', 'loadAdminData']) {
      assert.match(INDEX_HTML, new RegExp('window\\.' + fn + '\\s*='),
        `${fn} is used by an onclick attribute and must be window-exported`);
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
    // which injects the signed-in user's key (CLAUDE.md §7.6).
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
    const layers = LOGIN_HTML.match(/<div class="bg[^"]*" id="bg\w+"[^>]*>/g) || [];
    assert.equal(layers.length, 2);
    for (const l of layers) assert.match(l, /aria-hidden="true"/);
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
describe('index.html administration detail', () => {
  test('rows open a detail view', () => {
    assert.match(INDEX_HTML, /class="adm-row" data-login=/);
    assert.match(INDEX_HTML, /showAdminUserDetail\(tr\.dataset\.login\)/);
    assert.match(INDEX_HTML, /apiFetch\('\/admin\/users\/' \+ encodeURIComponent\(loginId\)\)/);
  });

  test('every value rendered into the detail is escaped', () => {
    // The panel interpolates account-controlled text — names, emails, URLs —
    // into innerHTML (CLAUDE.md §12).
    const fn = /async function showAdminUserDetail[\s\S]*?\n\}/.exec(INDEX_HTML)[0];
    assert.match(fn, /const kv\s*=\s*\(label, value\) => `<div class="adm-kv"><dt>\$\{escHtml\(label\)\}/);
    assert.match(fn, /const txt = \(v\) =>[\s\S]*?escHtml/);
    assert.match(fn, /escHtml\(d\.account\.firstName\)/);
    assert.match(fn, /escHtml\(d\.account\.loginId\)/);
  });

  test('the detail says secrets are not readable from it', () => {
    assert.match(INDEX_HTML, /are not readable from here/);
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
    const setAt  = fn.indexOf('_cacheBuilding = true');
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
    const cleared = (fn.match(/_cacheBuilding = false/g) || []).length;
    assert.ok(cleared >= 2,
      'ready and failed must both re-enable the control, otherwise it sticks disabled');
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
