// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Q39: the portfolio hierarchy, and whose numbers a parent actually carries ─
//
// `dashboard/index.html` has rolled group rows up since Q35, and since Q39 it
// does so according to each parent's own `collectionLogic`. The risk-trend
// graph did neither: `captureSnapshot()` swept `onlyRoot=true` and summed what
// DependencyTrack reported against each root's own uuid, which CLAUDE.md §8.7
// recorded as a known gap ("still not rolled up: the risk-trend graph").
//
// That gap stopped being theoretical the moment the table became collection-
// aware: a portfolio with one `AGGREGATE_LATEST_VERSION_CHILDREN` root had a
// graph reading 22 under cards reading 25, on the same screen, which is exactly
// the contradiction §6.3 exists to forbid.
//
// So this module is the server's copy of the page's three tree functions. It is
// **hand-mirrored, and that is the accepted trade**: §3 forbids a bundler and
// there is no build step, so a browser page cannot `require()` a lib module —
// the same duplication `lib/cwe.js`/the dialog's CWE cell and
// `componentKey()`/`componentKeyOf()` already carry. What makes it safe is the
// same thing: a cross-file test reads `index.html`'s real source and asserts
// the two produce identical answers, so they cannot drift in silence.
//
// It performs no I/O and is pure, so §10.4 lets a test `require()` it directly.

/** What the table renders, plus the `unassigned` levels it does not. */
const SEV_KEYS = ['critical', 'high', 'medium', 'low', 'unassigned'];

/** DT sends a tag as {name} on some versions and a bare string on others. */
function tagNames(raw) {
  return (raw || [])
    .map(t => (typeof t === 'string' ? t : (t && t.name) || ''))
    .filter(Boolean);
}

/**
 * Which of a node's children count toward its total.
 *
 * Mirrors `collectionChildren()` in `dashboard/index.html`. The four modes, and
 * why the last line is a decision rather than a fallback, are documented there
 * and in CLAUDE.md §8.7 — in short: NONE and absent sum everything, because
 * DependencyTrack v4 has no collection projects at all and an organisational
 * parent with no SBOM of its own would otherwise report zero over a failing
 * subtree, which is the case Q35 exists to fix.
 */
function collectionChildren(node) {
  const kids = node.children || [];
  switch (node.collectionLogic) {
    case 'AGGREGATE_LATEST_VERSION_CHILDREN':
      return kids.filter(c => c.isLatest === true);
    case 'AGGREGATE_DIRECT_CHILDREN_WITH_TAG':
      // An empty tag matches nothing rather than everything: the parent is
      // configured to filter, and summing it all would report a total the
      // operator explicitly asked not to see.
      return node.collectionTag
        ? kids.filter(c => (c.tags || []).includes(node.collectionTag))
        : [];
    default:
      return kids;
  }
}

/**
 * Nest a flat portfolio on each project's own parent link.
 *
 * `parent.uuid`, never an embedded `children[]` — Q34's rule, for Q34's reason:
 * DependencyTrack v5 dropped that array and a crawl gated on it rendered roots
 * alone. A project whose parent is unknown to this list is treated as a root,
 * so an incomplete page degrades to a flat list rather than to nothing.
 */
function buildTree(projects) {
  const nodes = new Map();
  for (const p of projects || []) {
    if (!p || !p.uuid) continue;
    nodes.set(p.uuid, {
      uuid: p.uuid,
      parentUuid: (p.parent && p.parent.uuid) || p.parentUuid || null,
      isLatest: p.isLatest === true,
      tags: tagNames(p.tags),
      collectionLogic: typeof p.collectionLogic === 'string' ? p.collectionLogic : '',
      collectionTag: (typeof p.collectionTag === 'string'
        ? p.collectionTag
        : (p.collectionTag && p.collectionTag.name) || ''),
      metrics: p.metrics || {},
      children: [],
    });
  }
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentUuid && nodes.get(node.parentUuid);
    // A self-referencing link is not a parent. Pushing it would make the
    // post-order walk below recurse until the stack dies.
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * Attach each project's own counts, then replace every non-leaf's with the sum
 * of the children its collection logic actually counts.
 *
 * Replace, never add (Q35): a root DependencyTrack has already rolled up
 * reports its descendants' totals *as its own*, so adding a computed child sum
 * on top would double it.
 */
function aggregate(roots, violationMap, polKeys, mapCategory, num) {
  const seen = new Set();
  const map = violationMap || {};

  function visit(node) {
    if (seen.has(node.uuid)) return;
    seen.add(node.uuid);

    // Own numbers first, for every node — a leaf keeps these, and a parent
    // needs its children's before it can discard its own.
    node.sev = {};
    for (const k of SEV_KEYS) node.sev[k] = num(node.metrics[k]);
    node.pol = {};
    const v = map[node.uuid];
    for (const [cat, state] of polKeys) {
      const bucket = v && v[mapCategory[cat]];
      node.pol[`${cat}_${state}`] = bucket ? num(bucket[state]) : 0;
    }

    if (node.children.length === 0) return;
    node.children.forEach(visit);

    const counted = collectionChildren(node);
    for (const k of SEV_KEYS) node.sev[k] = counted.reduce((t, c) => t + c.sev[k], 0);
    for (const [cat, state] of polKeys) {
      const key = `${cat}_${state}`;
      node.pol[key] = counted.reduce((t, c) => t + c.pol[key], 0);
    }
  }

  roots.forEach(visit);
  return roots;
}

module.exports = { SEV_KEYS, tagNames, collectionChildren, buildTree, aggregate };
