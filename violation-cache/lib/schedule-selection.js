// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Which projects a schedule covers ─────────────────────────────────────────
// A schedule stores either a list of projects or a RULE for finding them, and
// this module turns the rule into the list. Pure: it takes a portfolio and
// returns uuids, reads no environment, touches no database and performs no I/O
// at require time, so `server.test.js` can drive every mode with no PostgreSQL
// (CLAUDE.md §10.4).
//
// The cap is deliberately NOT here. How many projects one run may crawl is a
// deployment concern with an environment variable behind it, and a pure fold
// that reads `process.env` is neither pure nor testable — `lib/scheduler.js`
// applies it to what this returns.

const projectTree = require('./project-tree');

/** The three ways a schedule can say which projects it covers. */
const SELECTION_MODES = ['fixed', 'latest_under', 'latest_all'];
const MODE_SET = new Set(SELECTION_MODES);

/** The default, and what every schedule written before migration 015 has. */
const DEFAULT_MODE = 'fixed';

function isMode(v) { return typeof v === 'string' && MODE_SET.has(v); }

// ── Leaves ───────────────────────────────────────────────────────────────────
// Q42: a group is traversed, never reported on. Three reasons, the third
// decisive:
//
//   * A group row's figures on the dashboard are its children's sum, not its
//     own — Q35's "replace, never add" — so a group has no numbers of its own
//     that the screen is showing.
//   * The three policy categories come from our own /api/v1/violation crawl
//     bucketed by uuid, so an organisational parent with no SBOM has nothing to
//     report and querying it is an upstream call per group returning zero rows
//     (§13).
//   * Including a group would put findings in the workbook that the dashboard
//     row does not account for — reintroducing exactly the discrepancy the
//     collection-aware resolution below exists to remove.
//
// The cost, inherited from Q35 rather than introduced here: a group that
// carries its OWN SBOM has its own findings excluded from the dashboard and now
// from the report as well. Changing that is a decision about "replace, never
// add", and it would move the dashboard too.
function isLeafNode(node) {
  return !node || !Array.isArray(node.children) || node.children.length === 0;
}

/** Index a built tree by uuid, so an anchor can be found in one lookup. */
function indexTree(roots) {
  const byUuid = new Map();
  const walk = (node, seen) => {
    if (!node || byUuid.has(node.uuid) || seen.has(node)) return;
    seen.add(node);
    byUuid.set(node.uuid, node);
    for (const kid of node.children || []) walk(kid, seen);
  };
  const seen = new Set();
  for (const root of roots || []) walk(root, seen);
  return byUuid;
}

// ── Descending from one anchor ───────────────────────────────────────────────
/**
 * Every leaf beneath `node` that its own level's collectionLogic counts.
 *
 * Q43: the descent applies `projectTree.collectionChildren()` at EVERY level,
 * not just the anchor's. That is the same function the dashboard's group-row
 * roll-up uses (Q39) and it is hand-mirrored in `index.html` with a cross-file
 * test, so the set this returns is exactly the set the group row on screen is
 * summarising. A schedule resolved any other way would cover projects the
 * dashboard's own arithmetic leaves out, and somebody comparing the report to
 * the screen would be right to call one of them wrong.
 *
 * A consequence worth knowing rather than discovering: under
 * AGGREGATE_LATEST_VERSION_CHILDREN a child that is itself a GROUP is excluded,
 * because it has no version and DT reports `isLatest: false` for it (§8.7). So
 * anchoring on a "latest only" parent that contains sub-groups stops at its
 * direct latest leaves. That is what the dashboard shows for the same row; it
 * is not a bug, and it is why the editor previews the resolved count.
 *
 * An anchor that is itself a leaf resolves to itself. The editor promotes a
 * leaf selection to its parent before saving (`promoteAnchors`), so this is the
 * defensive path — a stored anchor whose children were deleted since.
 */
// The `seen` set here and in `indexTree` is defence behind `buildTree`'s
// single-parent invariant, not something reachable while that holds: a node is
// pushed into exactly one parent's `children`, so a two-node cycle roots
// nowhere and is never walked at all. Kept because the portfolio comes from an
// external system and `project-tree.js`'s own post-order walk carries the same
// guard — but a mutation removing it does NOT fail a test, and that is expected
// rather than a gap in coverage.
function leavesUnder(node, out, seen) {
  if (!node || seen.has(node)) return out;
  seen.add(node);
  if (isLeafNode(node)) { out.push(node); return out; }
  for (const kid of projectTree.collectionChildren(node)) leavesUnder(kid, out, seen);
  return out;
}

// ── Promotion ────────────────────────────────────────────────────────────────
/**
 * Replace any leaf anchor with its parent, deduped, order preserved.
 *
 * Selecting `service-401 v1.2` and asking for latest-only means "the latest
 * release here", not "this exact version forever" — the version is the one
 * thing that is going to change. Promotion happens once, HERE, rather than
 * separately in the browser and on the server, so the preview and the run can
 * never disagree about what was anchored.
 *
 * It is not silent: the editor renders what it promoted to, because promotion
 * WIDENS the selection — a leaf's parent also holds its siblings, so the
 * resolved set can legitimately be larger than the rows that were ticked.
 *
 * An anchor with no parent (a childless top-level project) stays itself: there
 * is nothing to promote to, and dropping it would silently empty the schedule.
 */
function promoteAnchors(anchorUuids, portfolio) {
  const byUuid = indexTree(projectTree.buildTree(portfolio));
  const out = [];
  const seen = new Set();
  for (const uuid of anchorUuids || []) {
    const node = byUuid.get(uuid);
    let target = uuid;
    if (node && isLeafNode(node) && node.parentUuid && byUuid.has(node.parentUuid)) {
      target = node.parentUuid;
    }
    if (!seen.has(target)) { seen.add(target); out.push(target); }
  }
  return out;
}

// ── Resolution ───────────────────────────────────────────────────────────────
/**
 * Which projects a schedule covers, resolved against the portfolio in hand.
 *
 * @param {object}   opts
 * @param {string}   opts.mode         one of SELECTION_MODES; anything else is 'fixed'
 * @param {string[]} opts.anchorUuids  the stored `schedule_projects` rows
 * @param {object[]} opts.portfolio    the flat sweep, as DT returned it
 * @returns {{uuids: string[], perAnchor: Array<{uuid: string, count: number}>, mode: string}}
 *
 * `perAnchor` is what the editor's "this anchor currently resolves to nothing"
 * warning reads, and what makes a misconfigured branch visible at save time
 * rather than as a quietly narrower report months later.
 */
function resolveProjects({ mode, anchorUuids, portfolio } = {}) {
  const useMode = isMode(mode) ? mode : DEFAULT_MODE;
  const anchors = Array.isArray(anchorUuids) ? anchorUuids : [];

  if (useMode === 'fixed') {
    // Deduped, but otherwise exactly what was stored — resolution is a no-op
    // and the portfolio is not consulted at all.
    const seen = new Set();
    const uuids = anchors.filter(u => (seen.has(u) ? false : (seen.add(u), true)));
    return { mode: useMode, uuids, perAnchor: uuids.map(uuid => ({ uuid, count: 1 })) };
  }

  const roots = projectTree.buildTree(portfolio);

  if (useMode === 'latest_all') {
    // No anchor, so no level's collectionLogic applies: there is no parent
    // whose configuration could say which children to count. "Every project
    // marked latest" is the plain reading, and it is deliberately NOT the
    // per-level rule `latest_under` uses — rolling up from every root would
    // silently drop anything beneath a LATEST root, which is the opposite of
    // what "all latest" means to somebody reading it.
    const uuids = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (isLeafNode(node)) { if (node.isLatest === true) uuids.push(node.uuid); return; }
      for (const kid of node.children) walk(kid);
    };
    for (const root of roots) walk(root);
    return { mode: useMode, uuids, perAnchor: [] };
  }

  // latest_under
  const byUuid = indexTree(roots);
  const uuids = [];
  const claimed = new Set();
  const perAnchor = [];
  for (const anchorUuid of anchors) {
    const node = byUuid.get(anchorUuid);
    if (!node) { perAnchor.push({ uuid: anchorUuid, count: 0 }); continue; }
    // A fresh `seen` per anchor: two anchors may legitimately share a subtree,
    // and the second must still report what IT resolves to. `claimed` is what
    // keeps the returned list free of duplicates.
    const leaves = leavesUnder(node, [], new Set());
    let count = 0;
    for (const leaf of leaves) {
      if (leaf.isLatest !== true) continue;
      count++;
      if (!claimed.has(leaf.uuid)) { claimed.add(leaf.uuid); uuids.push(leaf.uuid); }
    }
    perAnchor.push({ uuid: anchorUuid, count });
  }
  return { mode: useMode, uuids, perAnchor };
}

// ── Drift ────────────────────────────────────────────────────────────────────
/** How many removed projects the drift line names before it starts counting. */
const MAX_DRIFT_NAMES = 10;

/**
 * One line naming how this run's covered set differs from the last one's.
 *
 * Q44: growth and shrinkage are not equally safe, so the covering email says
 * which happened. A branch that is deleted, un-marked `isLatest` or archived
 * quietly narrows the report, and nobody notices an absence — the workbook
 * still arrives and still looks healthy. The project-summary sheets do list
 * what was covered, but comparing two months' workbooks by hand is precisely
 * the work this product exists to remove.
 *
 * Removals are named and additions are counted. That asymmetry is deliberate:
 * a project that stopped being covered is the thing somebody has to go and
 * look at, while a new one is self-evident in the workbook it appears in.
 *
 * @returns {string|null} null when nothing changed, or when there is no
 *   baseline — a first run has not drifted from anything, and saying so would
 *   put a line on every first report that reads like a warning.
 */
function describeDrift(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current)) return null;
  const label = (p) => (p && p.name ? `${p.name}${p.version ? ` ${p.version}` : ''}` : (p && p.uuid) || '');
  const before = new Map(previous.filter(p => p && p.uuid).map(p => [p.uuid, p]));
  const after = new Map(current.filter(p => p && p.uuid).map(p => [p.uuid, p]));

  const removed = [...before.keys()].filter(u => !after.has(u)).map(u => label(before.get(u)));
  const added = [...after.keys()].filter(u => !before.has(u)).length;
  if (!removed.length && !added) return null;

  const parts = [`Projects covered: ${after.size} (was ${before.size}`];
  if (removed.length) {
    removed.sort();
    // Capped, because a reorganisation can drop dozens and an unreadable wall
    // of names is skipped rather than read. What is hidden is admitted.
    const shown = removed.slice(0, MAX_DRIFT_NAMES);
    const more = removed.length - shown.length;
    parts.push(` — ${removed.length} no longer covered: ${shown.join(', ')}`);
    if (more) parts.push(`, +${more} more`);
  }
  if (added) parts.push(`${removed.length ? '; ' : ' — '}${added} newly covered`);
  return `${parts.join('')})`;
}

module.exports = {
  SELECTION_MODES, DEFAULT_MODE, isMode, MAX_DRIFT_NAMES,
  isLeafNode, promoteAnchors, resolveProjects, describeDrift,
};
