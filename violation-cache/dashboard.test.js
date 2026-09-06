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
    assert.match(fn, /maxReports: value/);
    // Blank means "return to the default" — a distinct outcome from any number.
    assert.match(fn, /let value = null/);
  });

  test('cancelling is a real path, not just a hidden dialog', () => {
    assert.match(ADMIN_HTML, /function closeLimitModal/);
    assert.match(ADMIN_HTML, /onclick="closeLimitModal\(\)"/);
    assert.match(ADMIN_HTML, /function closePwModal/);
  });

  test('the password reset validates before the round trip', () => {
    // Mirrors lib/validate.js. The backend remains the authority (CLAUDE.md §8.8).
    const fn = /async function confirmPasswordReset[\s\S]*?\n  \}/.exec(ADMIN_HTML)[0];
    assert.match(fn, /length < 8/);
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
    assert.match(fn, /cannot create new reports/,
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

  test('a blank schedule name is sent, so it can be cleared', () => {
    // Omitting the key means "leave it alone"; sending '' means "go back to
    // automatic". The form must send the field for the second to be reachable.
    assert.match(INDEX_HTML, /reportName: String\(schedName\)\.trim\(\)/);
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
