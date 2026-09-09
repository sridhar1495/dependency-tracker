// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Dependency-path endpoints ─────────────────────────────────────────────────
//   GET  /violation-cache/dependency-paths/:projectUuid   direct set (live) + cached walk state
//   POST /violation-cache/dependency-paths/:projectUuid   ask for a walk — body: { targets?: string[], force?: boolean }
//
// The direct-dependency set is fetched live on every GET — one DependencyTrack
// call, never cached, so the Direct/Transitive badge can never lag behind what
// DependencyTrack currently reports. The full graph walk is the expensive,
// opt-in half, shared by fingerprint and cached in dependency_paths (migration
// 013) exactly the way the violation cache is (CLAUDE.md §7.5, §13).
//
// `targets` (Q26) scopes that walk to the componentKeys the dialog actually
// needs a path for, rather than the project's entire graph — a 200-component
// project with 40 open findings has no reason to resolve the other 160.
//
// `force` (Q29) skips runJob's "already covered by the cached walk"
// short-circuit — the dialog's manual "Refetch paths" control, for when a
// user suspects the cached result and DependencyTrack's own state have
// diverged. It never bypasses the in-progress guard just below: a build
// already running is still the same build, forced or not.

const { log } = require('../lib/log');
const { jsonReply, readJson, requireUser } = require('../lib/http-util');
const depPaths      = require('../lib/dependency-paths');
const depCache      = require('../lib/dependency-path-cache');
const dtConnections = require('../lib/dt-connections');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same ceiling the dialog itself caps rendered findings at (CONFIG.VULN_MAX_ROWS
// in index.html) — a target list cannot legitimately be longer than that.
const MAX_TARGETS = 900;

/**
 * `targets` (Q26): componentKeys the caller actually needs a path for, so the
 * walk resolves only what a dialog will show rather than a project's whole
 * graph. The field being absent (not merely empty) is what falls back to
 * "walk everything" — an explicitly empty array is a real instruction
 * ("nothing to resolve") and must not silently balloon into a full walk.
 */
function parseTargets(body) {
  if (!body || !Array.isArray(body.targets)) return null;
  return body.targets.filter(t => typeof t === 'string' && t).slice(0, MAX_TARGETS);
}

/** Resolve the caller's connection, replying itself on the failure paths — same shape routes/cache.js uses. */
async function connectionFor(userId, res) {
  let conn;
  try {
    conn = await dtConnections.getResolved(userId);
  } catch (err) {
    if (err.code === 'DT_KEY_UNREADABLE') {
      jsonReply(res, 503, { error: err.message, code: 'DT_KEY_UNREADABLE' });
      return null;
    }
    throw err;
  }
  if (!conn || !conn.isConfigured || !conn.apiKey) {
    jsonReply(res, 503, {
      error: 'No DependencyTrack connection is configured for this account.',
      code: 'DT_NOT_CONFIGURED',
    });
    return null;
  }
  return conn;
}

async function handle({ method, path: parsedPath, req, res, principal }) {
  const m = parsedPath.match(/^\/violation-cache\/dependency-paths\/([^/]+)$/);
  if (!m || (method !== 'GET' && method !== 'POST')) return false;

  const projectUuid = m[1];
  if (!UUID_RE.test(projectUuid)) {
    jsonReply(res, 400, { error: 'Not a valid project id.', code: 'INVALID_PROJECT' });
    return true;
  }

  const userId = requireUser(principal, res);
  if (!userId) return true;

  try {
    const conn = await connectionFor(userId, res);
    if (!conn) return true;

    // ── GET: the direct set, live, plus whatever the cached walk currently says ──
    if (method === 'GET') {
      const { direct, lastBomImport } = await depPaths.getDirectDependencies(
        conn.apiUrl, conn.apiKey, projectUuid);

      const meta = await depCache.getMeta(conn.fingerprint, projectUuid);
      const status = depCache.deriveStatus(meta, depCache.stallWindowMs());

      // Stale is a live comparison, not a stored state: a row built against an
      // older BOM import is still shown — something to verify against beats
      // nothing while a re-walk has not been asked for — but flagged so the
      // dialog can offer a refresh rather than presenting it as current.
      const bomChanged = Boolean(
        status === 'ready' && meta && meta.bomImportAt && lastBomImport &&
        new Date(meta.bomImportAt).getTime() < lastBomImport
      );

      jsonReply(res, 200, {
        direct: direct.map(d => ({
          uuid: d.uuid || null, purl: d.purl || null,
          name: d.name || null, group: d.group || null, version: d.version || null,
        })),
        status,
        stale: bomChanged,
        totalComponents: (meta && meta.totalComponents) || 0,
        resolvedComponents: (meta && meta.resolvedComponents) || 0,
        paths: status === 'ready' ? (meta.paths || {}) : {},
        error: status === 'failed' ? (meta && meta.error) : null,
      });
      return true;
    }

    // ── POST: ask for a walk ────────────────────────────────────────────────
    const body = await readJson(req, res);
    if (body === null) return true; // readJson already replied 400
    const targets = parseTargets(body);
    const force = body.force === true;

    // Only a build that is genuinely alive blocks a new one — a row left
    // 'building' by a process that died reads as 'stalled' and falls through,
    // matching /violation-cache/refresh's recovery behaviour (CLAUDE.md §6.3).
    // A forced request is refused here exactly like an ordinary one — force
    // means "don't trust a ready cache", not "cancel a build in progress".
    const meta = await depCache.getMeta(conn.fingerprint, projectUuid);
    if (depCache.deriveStatus(meta, depCache.stallWindowMs()) === 'building') {
      jsonReply(res, 409, { status: 'building', message: 'A walk is already in progress.' });
      return true;
    }
    depPaths.runJob(conn, projectUuid, targets, force).catch(err =>
      log('error', `Dependency-path walk error: ${err.message}`, { userId, projectUuid }));
    jsonReply(res, 202, { status: 'building', message: 'Walk started' });
    return true;
  } catch (err) {
    log('error', `Dependency-paths route failed: ${err.message}`, { userId, projectUuid });
    jsonReply(res, 500, { error: 'Could not resolve dependency paths.', code: 'INTERNAL' });
    return true;
  }
}

module.exports = { handle };
