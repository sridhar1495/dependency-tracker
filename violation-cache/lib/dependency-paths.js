// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Dependency-path resolution ────────────────────────────────────────────────
// Answers two different questions about one project's DependencyTrack
// component graph, at two different costs:
//
//   Direct or transitive?   One DT call (GET /api/v1/project/{uuid}), always
//                           live, never cached — see getDirectDependencies().
//                           This is the release-engineer's primary signal and
//                           must never lag behind what DependencyTrack reports.
//
//   What is the path?       Only asked when a Transitive tag needs verifying.
//                           Walks GET /api/v1/component/project/{uuid}/
//                           dependencyGraph/{componentUuid} outward from the
//                           project's direct dependencies, which is where the
//                           real cost is — dozens of calls for one project —
//                           so this half is cached (dependency_paths, migration
//                           013, via lib/dependency-path-cache.js) and opt-in,
//                           mirroring violation_caches' shared, advisory-locked,
//                           job-status shape (CLAUDE.md §6.3, §7.5). Q25: that
//                           data-access half lives in its own module for the
//                           same reason violation_caches does: runJob below
//                           calls it through the imported reference, which is
//                           what lets a test replace acquireBuildLock/
//                           markBuilding/etc. without a database.
//
// Both halves are shared by fingerprint, not by user, for the reason every
// other cache in this schema is: users on the same DependencyTrack connection
// share one walk of one project (§7.5, §13).
//
// This is also the module a future license-risk dialog reuses unchanged
// (getDirectDependencies takes a project, never a finding), since "is this
// component direct or transitive" does not depend on why the caller is asking.

const { log } = require('./log');
const dtFetch = require('./dt-fetch');
const { makeSemaphore } = require('./async-utils');
const depCache = require('./dependency-path-cache');

// A defensive ceiling on the walk, the same reasoning as the snapshot crawl's
// page ceiling (CLAUDE.md §6.3): an ordinary project's graph is at most a few
// hundred components, so 2000 is headroom, not a target, and it exists purely
// so a toggle click cannot become an unbounded fetch loop.
const MAX_GRAPH_NODES  = 2000;
const MAX_CHAIN_LENGTH = 40; // guards path reconstruction against a malformed cycle
const WALK_CONCURRENCY = 5;  // matches REPORT_CONCURRENCY/VIOLATION_CONCURRENCY's order of magnitude

// Q27: a hard cap on how many distinct roots' chains one component keeps —
// a widely shared package (a common logging library, say) can be reachable
// from dozens of direct dependencies, and without a ceiling that fans out
// into both the walk's own per-node bookkeeping and an unreadable wall of
// chains in one dialog row. No count is shown once the cap is hit — exact
// "+N more" counting is deferred, not built now.
const MAX_ROOTS_PER_COMPONENT = 8;

const PROGRESS_INTERVAL_MS = 1000; // P: publish progress at most once a second
const HEARTBEAT_MS         = 30_000;

// Fingerprint+project pairs being walked by THIS process. The advisory lock is
// the real cross-process guard; this only avoids re-entering within one.
const _building = new Set();

function buildingKey(fingerprint, projectUuid) { return `${fingerprint}:${projectUuid}`; }

// ── Component identity ──────────────────────────────────────────────────────
// purl when DependencyTrack gives one; a composite of group/name/version when
// it does not (the project's own root pseudo-component, seen in practice, has
// no purl at all). The vulnerability dialog's finding rows and this walk's
// discovered nodes must derive a key the identical way, or a component would
// silently read as "no path recorded" purely because the two sides disagreed
// on its name.
function componentKey(c) {
  if (c && c.purl) return c.purl;
  return `${(c && c.group) || ''}::${(c && c.name) || ''}::${(c && c.version) || ''}`;
}

// ── Direct dependencies (Tier 1 — live, never cached) ───────────────────────
/**
 * @returns {Promise<{direct: object[], lastBomImport: number|null}>}
 */
async function getDirectDependencies(apiUrl, apiKey, projectUuid) {
  const { json } = await dtFetch.dtGetWithRetry(`/api/v1/project/${projectUuid}`, apiUrl, apiKey);
  // directDependencies is a JSON STRING on the project response, not a nested
  // object — DependencyTrack encodes it that way, so it is parsed twice.
  let direct = [];
  if (typeof json.directDependencies === 'string' && json.directDependencies) {
    try {
      const parsed = JSON.parse(json.directDependencies);
      if (Array.isArray(parsed)) direct = parsed;
    } catch (err) {
      log('warn', `project.directDependencies did not parse as JSON: ${err.message}`, { projectUuid });
    }
  }
  return { direct, lastBomImport: json.lastBomImport || null };
}

// ── The walk (Tier 2 — expensive, cached) ───────────────────────────────────
/**
 * Discover as much of the project's transitive graph as MAX_GRAPH_NODES
 * allows, starting from its direct dependencies, and compute one shortest
 * chain **per distinct direct-dependency root** that reaches a transitive
 * component (Q27) — a shared low-level package reachable from three
 * different direct dependencies gets three chains, one per root, not one
 * chain plus a flag. Two components sharing the same root but reaching a
 * target by different intermediate hops are deliberately not distinguished
 * further than that root's one (shortest) chain — enumerating every route
 * within a single root is the combinatorial case CLAUDE.md's dependency-paths
 * note warns about, and is deferred rather than built now.
 *
 * A component the walk never reaches is not an error — DependencyTrack simply
 * recorded no edge to it, which is the ordinary case for an SBOM built from a
 * manifest rather than a scanned artefact. It has no entry in the returned
 * paths map; the caller shows that plainly rather than inventing a chain.
 *
 * Q26: when `targets` (componentKeys) is given, the walk stops as soon as
 * every one of them is settled — reached by at least one root, or found to
 * already be a direct dependency — rather than discovering the rest of the
 * project's graph regardless of whether anything needs it. Only the finding
 * rows a dialog actually displays ever need a path; a 200-component project
 * with 40 open findings walking to all 200 is real, measured DependencyTrack
 * load for work nobody asked for (CLAUDE.md §13). `targets` omitted or empty
 * walks exhaustively, as before — the shape a full-graph caller still wants.
 * A scoped walk may therefore surface only the first root it happens to find
 * for a given target, not every root that reaches it — in practice a single
 * dependencyGraph response tends to reveal several sibling branches at once
 * (see the design note above the diamond-graph tests), so this is rarer than
 * it sounds, but it is not a guarantee.
 */
async function walkGraph(
  apiUrl, apiKey, projectUuid, directDeps, onProgress = () => {}, shouldStop = () => false, targets = null
) {
  const nodes        = new Map(); // uuid -> {name, version, purl, group, ...}
  const rootsReaching = new Map(); // uuid -> Set<root uuid> — every distinct root known to reach it
  const parentByRoot = new Map(); // uuid -> Map<root uuid, parent uuid> — one predecessor per root
  const expanded      = new Set(); // uuids whose own dependencyGraph call has been made

  const directUuids = [...new Set(directDeps.map(d => d && d.uuid).filter(Boolean))];
  for (const d of directDeps) if (d && d.uuid) nodes.set(d.uuid, d);
  for (const uuid of directUuids) rootsReaching.set(uuid, new Set([uuid]));
  const directSet = new Set(directUuids);

  // null/undefined means "walk everything" (unchanged default behaviour); an
  // array — even an empty one, meaning every requested target already turned
  // out to be direct — means "walk only these", so an empty array must stop
  // immediately rather than silently falling back to an exhaustive walk.
  const targetSet = targets ? new Set(targets) : null;
  const settled = new Set();
  const isDone = () => targetSet !== null && settled.size >= targetSet.size;
  // A target is settled once its path is knowable — direct (trivial) or it
  // is reached by at least one root — never merely because its name has been
  // seen; a component can appear as metadata before it is reachable.
  const checkSettled = (uuid) => {
    if (!targetSet || !(directSet.has(uuid) || rootsReaching.has(uuid))) return;
    const info = nodes.get(uuid);
    if (!info) return;
    const key = componentKey(info);
    if (targetSet.has(key)) settled.add(key);
  };
  for (const uuid of directUuids) checkSettled(uuid);

  const sem = makeSemaphore(WALK_CONCURRENCY);
  let queue = directUuids;
  let resolvedCalls = 0;

  while (queue.length && nodes.size < MAX_GRAPH_NODES && !shouldStop() && !isDone()) {
    const batch = queue;
    const nextQueue = [];

    await Promise.all(batch.map(uuid => sem(async () => {
      if (expanded.has(uuid) || shouldStop() || isDone()) return;
      expanded.add(uuid);
      let graph;
      try {
        const { json } = await dtFetch.dtGetWithRetry(
          `/api/v1/component/project/${projectUuid}/dependencyGraph/${uuid}`, apiUrl, apiKey);
        graph = json;
      } catch (err) {
        log('warn', `Dependency-graph expansion failed for one component: ${err.message}`, { projectUuid });
        return;
      }
      resolvedCalls++;
      onProgress(nodes.size, resolvedCalls);

      for (const [nodeUuid, info] of Object.entries(graph || {})) {
        if (!nodes.has(nodeUuid)) nodes.set(nodeUuid, info);
        checkSettled(nodeUuid);
        const kids = Array.isArray(info && info.dependencyGraph) ? info.dependencyGraph : null;
        if (!kids) continue;

        const myRoots = rootsReaching.get(nodeUuid);
        if (!myRoots) continue; // this node's own reachability has not been recorded yet
        for (const kidUuid of kids) {
          if (!nodes.has(kidUuid) && graph[kidUuid]) nodes.set(kidUuid, graph[kidUuid]);
          // A direct dependency is already its own root — it never gains a
          // transitive chain, regardless of which other branch also reaches it.
          if (!directSet.has(kidUuid)) {
            if (!rootsReaching.has(kidUuid)) rootsReaching.set(kidUuid, new Set());
            const kidRoots = rootsReaching.get(kidUuid);
            for (const root of myRoots) {
              if (kidRoots.has(root)) continue; // already have a (shortest) chain via this root
              if (kidRoots.size >= MAX_ROOTS_PER_COMPONENT) break; // Q27: bounded fan-in
              kidRoots.add(root);
              if (!parentByRoot.has(kidUuid)) parentByRoot.set(kidUuid, new Map());
              parentByRoot.get(kidUuid).set(root, nodeUuid);
            }
            checkSettled(kidUuid);
          }
          if (!expanded.has(kidUuid) && nodes.size < MAX_GRAPH_NODES) nextQueue.push(kidUuid);
        }
      }
    })));

    queue = isDone() ? [] : [...new Set(nextQueue)];
  }
  onProgress(nodes.size, resolvedCalls);

  // ── Reconstruct one shortest chain per distinct root, per transitive component ──
  const paths = {};
  for (const [uuid, info] of nodes) {
    if (directSet.has(uuid) || !parentByRoot.has(uuid)) continue; // direct, or never reached
    const chains = [];
    for (const root of rootsReaching.get(uuid)) {
      const chain = [];
      let cur = uuid;
      let guard = 0;
      while (cur && guard++ < MAX_CHAIN_LENGTH) {
        const n = nodes.get(cur);
        chain.unshift((n && n.name) || cur);
        if (directSet.has(cur)) break;
        const pmap = parentByRoot.get(cur);
        cur = pmap ? pmap.get(root) : undefined;
      }
      chains.push(chain);
    }
    paths[componentKey(info)] = { chains };
  }

  return { paths, totalComponents: nodes.size };
}

/**
 * Build (or rebuild) the cached walk for one project.
 *
 * Returns `{ started: false }` when another builder already holds the lock —
 * the shared-cache behaviour working, not an error (CLAUDE.md §7.5) — or when
 * every requested target is already a key in the stored `paths` from a
 * previous walk, which is what keeps a re-toggle instant for the common case
 * of reopening a dialog whose findings have not changed.
 *
 * @param {{apiUrl: string, apiKey: string, fingerprint: string}} conn
 * @param {string} projectUuid
 * @param {string[]|null} [targets] componentKeys the caller actually needs a
 *   path for (Q26) — omitted or empty walks the whole graph, as before.
 * @param {boolean} [force] Q29: skip the "already covered by the cached
 *   walk" short-circuit and re-walk regardless. Still refuses a second
 *   concurrent walk — `_building` and the advisory lock are unaffected —
 *   force means "don't trust a ready cache", not "cancel one in flight".
 */
async function runJob(conn, projectUuid, targets = null, force = false) {
  const { apiUrl, apiKey, fingerprint } = conn;
  const key = buildingKey(fingerprint, projectUuid);
  if (_building.has(key)) return { started: false, reason: 'already building in this process' };

  if (!force && targets && targets.length) {
    const existing = await depCache.getMeta(fingerprint, projectUuid);
    if (existing && existing.status === 'ready') {
      const known = new Set(Object.keys(existing.paths || {}));
      if (targets.every(t => known.has(t))) {
        return { started: false, reason: 'already covered by the cached walk' };
      }
    }
  }

  const lock = await depCache.acquireBuildLock(fingerprint, projectUuid);
  if (!lock.acquired) {
    log('info', 'Another builder already holds this project — sharing its result', {
      fingerprint: fingerprint.slice(0, 12), projectUuid,
    });
    return { started: false, reason: 'another builder holds the lock' };
  }

  _building.add(key);
  await depCache.markBuilding(fingerprint, projectUuid);
  log('info', 'Dependency-path walk started', { fingerprint: fingerprint.slice(0, 12), projectUuid });

  const state = { total: 0, resolved: 0 };
  let lastPublish = 0;
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && (now - lastPublish) < PROGRESS_INTERVAL_MS) return;
    lastPublish = now;
    depCache.setProgress(fingerprint, projectUuid, state).catch(() => { /* non-fatal */ });
  };

  // Stall watchdog and heartbeat — one timer, same shape as
  // violation-cache.js's: touch the row only while resolvedCalls is actually
  // advancing, so a hung walk's silence is what makes it detectable.
  const limitMs = depCache.stallWindowMs();
  let timedOut = false;
  let lastSeenResolved = -1;
  let lastMovedAt = Date.now();
  const beatMs = Math.max(1, Math.min(HEARTBEAT_MS, Math.floor(limitMs / 2)));
  const watchdog = setInterval(() => {
    if (state.resolved !== lastSeenResolved) {
      lastSeenResolved = state.resolved;
      lastMovedAt = Date.now();
      depCache.touchBuild(fingerprint, projectUuid).catch(() => { /* the next beat retries */ });
      return;
    }
    if ((Date.now() - lastMovedAt) > limitMs) {
      timedOut = true;
      log('error', 'Dependency-path walk stalled — no progress within the stall window', {
        fingerprint: fingerprint.slice(0, 12), projectUuid, resolved: state.resolved,
      });
    }
  }, beatMs);
  if (watchdog.unref) watchdog.unref();

  try {
    const { direct, lastBomImport } = await getDirectDependencies(apiUrl, apiKey, projectUuid);

    // A requested target that turns out to already be direct needs no walk at
    // all — defensive against a caller's list going stale between its own
    // Tier-1 read and this POST; the frontend already excludes these itself.
    const directKeys = new Set(direct.map(componentKey));
    const scopedTargets = targets ? targets.filter(t => !directKeys.has(t)) : null;

    const { paths, totalComponents } = await walkGraph(
      apiUrl, apiKey, projectUuid, direct,
      (total, resolved) => { state.total = total; state.resolved = resolved; publish(); },
      () => timedOut,
      scopedTargets
    );

    if (timedOut) {
      await depCache.markFailed(fingerprint, projectUuid,
        `Stopped: no progress for ${Math.round(limitMs / 60_000)} minutes.`);
      return { started: true, completed: false, stalled: true };
    }

    // Nothing left for the watchdog to watch — stop it here, not in finally,
    // for the same reason violation-cache.js does: it would otherwise measure
    // storeResult's own write as silence and log a stall against a walk that
    // just succeeded.
    clearInterval(watchdog);

    await depCache.storeResult(fingerprint, projectUuid, {
      paths, totalComponents,
      bomImportAt: lastBomImport ? new Date(lastBomImport) : null,
    });
    log('info', 'Dependency-path walk stored', {
      fingerprint: fingerprint.slice(0, 12), projectUuid, totalComponents,
      transitiveWithPaths: Object.keys(paths).length,
    });
    return { started: true, completed: true, totalComponents };
  } catch (err) {
    log('error', `Dependency-path walk failed: ${err.message}`, {
      fingerprint: fingerprint.slice(0, 12), projectUuid,
    });
    await depCache.markFailed(fingerprint, projectUuid, err.message).catch(() => {});
    return { started: true, completed: false, error: err.message };
  } finally {
    clearInterval(watchdog);
    _building.delete(key);
    await lock.release();
  }
}

module.exports = {
  componentKey, getDirectDependencies, walkGraph, runJob,
  MAX_GRAPH_NODES, MAX_CHAIN_LENGTH, WALK_CONCURRENCY, MAX_ROOTS_PER_COMPONENT,
};
