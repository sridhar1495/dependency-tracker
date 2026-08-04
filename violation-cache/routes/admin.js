// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Administration ────────────────────────────────────────────────────────────
//   GET /admin/users                      accounts with session, report and storage counts
//   GET /admin/overview                   service-wide totals
//   GET /admin/storage                    disk and database usage
//   GET /admin/users/:loginId             one account's detail
//   GET /admin/settings                   service-wide settings
//   PUT /admin/settings                   change the default report limit
//   PUT /admin/users/:loginId/settings    set or clear one account's limit
//   POST /admin/users/:loginId/password   reset one account's password
//
// This area WAS read-only. It is not any more, and the three writes above are
// the whole of what it can do — deliberately a closed list rather than a
// general-purpose account editor. Everything else about an account is still
// only readable: there is no route here that deletes an account, edits a name,
// disconnects a session on its own, or reads anybody's data.
//
// S29: the password reset is the most privileged thing in the service, because
// the administrator chooses a value that authenticates as somebody else. Three
// things bound it. The account's sessions are revoked and its cached token
// evicted, so the person being reset is signed out rather than silently
// followed. `must_change_password` is set, so the value the administrator typed
// only ever reaches the set-password route and cannot be used to browse that
// user's connection or reports. And every reset is written to login_audit.
//
// S25: the administrator sees metadata about accounts, never their contents.
// No password hash, no DependencyTrack API key, no SMTP password, and no report
// bytes are reachable from any route in this file — an administrator cannot read
// another person's report, only count them.

const { log } = require('../lib/log');
const { jsonReply, readJson } = require('../lib/http-util');
const users       = require('../lib/users');
const caches      = require('../lib/caches');
const appSettings = require('../lib/app-settings');
const userSettings = require('../lib/user-settings');
const cryptoLib   = require('../lib/crypto');
const validate    = require('../lib/validate');
const auth        = require('../lib/auth');
const disk        = require('../lib/disk');

/**
 * Administrator-only guard.
 *
 * Authentication already happened before dispatch; this is the authorisation
 * half. A signed-in ordinary user gets 403, not 404: unlike another user's
 * report, the existence of an administration area is not a secret.
 */
function requireAdmin(principal, res) {
  if (principal && principal.isAdmin) return true;
  jsonReply(res, 403, {
    error: 'This area is available to the administrator only.',
    code: 'ADMIN_ONLY',
  });
  return false;
}

/**
 * Resolve the target of a per-account write.
 *
 * Replies itself on every failure path. The reserved administrator principal is
 * unreachable here because detailForAdmin excludes it, so an attempt to reset
 * "the administrator's" password is a 404 like any other unknown login — their
 * credentials live in the on-disk file, not the database (CLAUDE.md §7.4).
 *
 * @returns {Promise<object|null>} the account row, or null once answered
 */
async function targetAccount(loginId, res) {
  const row = await users.detailForAdmin(loginId);
  if (!row) {
    jsonReply(res, 404, { error: 'No such account.', code: 'NOT_FOUND' });
    return null;
  }
  return row;
}

async function handle({ method, path: parsedPath, req, res, principal }) {

  // ── GET /admin/users ────────────────────────────────────────────────────
  if (method === 'GET' && parsedPath === '/admin/users') {
    if (!requireAdmin(principal, res)) return true;
    try {
      const rows = await users.listWithStats();
      jsonReply(res, 200, {
        users: rows.map(u => ({
          loginId:         u.loginId,
          name:            `${u.firstName} ${u.lastName}`.trim(),
          email:           u.email,
          createdAt:       u.createdAt,
          lastLoginAt:     u.lastLoginAt,
          sessionActive:   u.sessionActive,
          lastSeenAt:      u.lastSeenAt,
          reportCount:     u.reportCount,
          storageBytes:    Number(u.storageBytes),
          dtConfigured:    u.dtConfigured,
          scheduleEnabled: u.scheduleEnabled,
          maxReports:      u.maxReports,
          // The list shows the number AND where it came from: a limit with no
          // indication of its origin cannot be acted on, because the
          // administrator cannot tell what changing the default would do to it.
          maxReportsOverridden: u.maxReportsOverridden === true,
        })),
      });
    } catch (err) {
      log('error', `Administration listing failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not load the account list.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── GET /admin/overview ─────────────────────────────────────────────────
  if (method === 'GET' && parsedPath === '/admin/overview') {
    if (!requireAdmin(principal, res)) return true;
    try {
      const rows = await users.listWithStats();
      jsonReply(res, 200, {
        userCount:       rows.length,
        activeSessions:  rows.filter(u => u.sessionActive).length,
        reportCount:     rows.reduce((n, u) => n + u.reportCount, 0),
        storageBytes:    rows.reduce((n, u) => n + Number(u.storageBytes), 0),
        dtConfigured:    rows.filter(u => u.dtConfigured).length,
        schedulesActive: rows.filter(u => u.scheduleEnabled).length,
        // How many distinct DependencyTrack connections are actually being
        // crawled. Fewer caches than configured users is the shared-cache
        // design working, and is the number worth watching as users are added.
        cacheCount:      await caches.count(),
      });
    } catch (err) {
      log('error', `Administration overview failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not load the overview.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── GET /admin/storage ──────────────────────────────────────────────────
  if (method === 'GET' && parsedPath === '/admin/storage') {
    if (!requireAdmin(principal, res)) return true;
    try {
      jsonReply(res, 200, await disk.stats());
    } catch (err) {
      log('error', `Storage stats failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not read storage usage.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── GET /admin/settings ─────────────────────────────────────────────────
  if (method === 'GET' && parsedPath === '/admin/settings') {
    if (!requireAdmin(principal, res)) return true;
    try {
      const s = await appSettings.get();
      jsonReply(res, 200, {
        defaultMaxReports: s.defaultMaxReports,
        updatedAt:         s.updatedAt,
        limits: { min: appSettings.MIN_MAX_REPORTS, max: appSettings.MAX_MAX_REPORTS },
      });
    } catch (err) {
      log('error', `Settings read failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not load the settings.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── PUT /admin/settings ─────────────────────────────────────────────────
  // Changes the limit for every account that has no override. It never deletes
  // a report: lowering the default stops affected accounts creating new ones
  // until they are back under it. `affectedAccounts` says how many that is, so
  // the consequence is visible before the change rather than discovered after.
  if (method === 'PUT' && parsedPath === '/admin/settings') {
    if (!requireAdmin(principal, res)) return true;
    const body = await readJson(req, res);
    if (body === null) return true;
    try {
      if (body.defaultMaxReports === undefined) {
        jsonReply(res, 400, { error: 'defaultMaxReports is required.', code: 'VALIDATION_FAILED' });
        return true;
      }
      const saved = await appSettings.setDefaultMaxReports(body.defaultMaxReports);
      const affected = await appSettings.accountsOverDefault(saved.defaultMaxReports);
      log('info', 'Default report limit changed', {
        defaultMaxReports: saved.defaultMaxReports, accountsNowOverLimit: affected,
      });
      jsonReply(res, 200, { defaultMaxReports: saved.defaultMaxReports, affectedAccounts: affected });
    } catch (err) {
      if (err.code === 'VALIDATION_FAILED') {
        jsonReply(res, 400, { error: err.message, code: 'VALIDATION_FAILED', field: err.field });
        return true;
      }
      log('error', `Settings update failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not save the settings.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── PUT /admin/users/:loginId/settings ──────────────────────────────────
  // `maxReports: null` returns the account to the global default; a number
  // pins it there regardless of what the default becomes later.
  const perUser = parsedPath.match(/^\/admin\/users\/([^/]+)\/settings$/);
  if (method === 'PUT' && perUser) {
    if (!requireAdmin(principal, res)) return true;
    const body = await readJson(req, res);
    if (body === null) return true;
    try {
      const loginId = decodeURIComponent(perUser[1]);
      const row = await targetAccount(loginId, res);
      if (!row) return true;

      if (!Object.prototype.hasOwnProperty.call(body, 'maxReports')) {
        jsonReply(res, 400, { error: 'maxReports is required.', code: 'VALIDATION_FAILED' });
        return true;
      }

      const settings = body.maxReports === null
        ? await userSettings.clearMaxReportsOverride(row.id)
        : await userSettings.setMaxReportsOverride(row.id, body.maxReports);

      if (!settings) {
        jsonReply(res, 404, { error: 'No such account.', code: 'NOT_FOUND' });
        return true;
      }
      log('info', 'Account report limit changed', {
        userId: row.id,
        maxReports: settings.maxReports,
        overridden: settings.maxReportsOverride !== null,
      });
      jsonReply(res, 200, {
        maxReports: settings.maxReports,
        overridden: settings.maxReportsOverride !== null,
      });
    } catch (err) {
      if (err.code === 'VALIDATION_FAILED') {
        jsonReply(res, 400, { error: err.message, code: 'VALIDATION_FAILED', field: err.field });
        return true;
      }
      log('error', `Account settings update failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not save the limit.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /admin/users/:loginId/password ─────────────────────────────────
  // See S29 at the top of this file for what bounds this.
  const pwReset = parsedPath.match(/^\/admin\/users\/([^/]+)\/password$/);
  if (method === 'POST' && pwReset) {
    if (!requireAdmin(principal, res)) return true;
    const body = await readJson(req, res);
    if (body === null) return true;
    try {
      const loginId = decodeURIComponent(pwReset[1]);
      const row = await targetAccount(loginId, res);
      if (!row) return true;

      // The same rule the user's own password must satisfy — one validator,
      // so an administrator cannot set a password the owner could not
      // (CLAUDE.md §8.8).
      const problem = validate.validatePassword(body.password);
      if (problem) {
        jsonReply(res, 400, { error: problem, code: 'VALIDATION_FAILED', field: 'password' });
        return true;
      }

      const hash = await cryptoLib.hashPassword(body.password);
      // The new hash and its audit row commit together, so a failure leaves the
      // old password working rather than a changed password nobody was told about.
      const updated = await users.adminResetPassword(row.id, hash, { loginIdAttempted: loginId });
      if (!updated) {
        jsonReply(res, 404, { error: 'No such account.', code: 'NOT_FOUND' });
        return true;
      }

      // Sign them out everywhere. revokeUserSessions also evicts the in-process
      // token cache, so an already-issued bearer token stops working on the very
      // next request rather than up to a minute later (CLAUDE.md §7.3). Safe to
      // run after the commit: it is idempotent, and the password has already
      // changed, so a session that briefly survived could not be re-established.
      await auth.revokeUserSessions(row.id);
      log('info', 'Administrator reset an account password', { userId: row.id });

      jsonReply(res, 200, { ok: true, mustChangePassword: true, sessionsRevoked: true });
    } catch (err) {
      log('error', `Password reset failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not reset the password.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── GET /admin/users/:loginId ───────────────────────────────────────────
  const detail = parsedPath.match(/^\/admin\/users\/([^/]+)$/);
  if (method === 'GET' && detail) {
    if (!requireAdmin(principal, res)) return true;
    try {
      const loginId = decodeURIComponent(detail[1]);
      const row = await users.detailForAdmin(loginId);
      if (!row) {
        jsonReply(res, 404, { error: 'No such account.', code: 'NOT_FOUND' });
        return true;
      }

      // Explicitly named rather than spread, so a column added to the query
      // later cannot reach a response without someone deciding it should.
      jsonReply(res, 200, {
        account: {
          loginId: row.loginId, email: row.email,
          firstName: row.firstName, lastName: row.lastName,
          createdAt: row.createdAt, updatedAt: row.updatedAt,
          lastLoginAt: row.lastLoginAt,
        },
        session: row.sessionIssuedAt ? {
          issuedAt:  row.sessionIssuedAt,
          lastSeenAt: row.sessionLastSeenAt,
          expiresAt: row.sessionExpiresAt,
          userAgent: row.sessionUserAgent,
          ipAddress: row.sessionIpAddress,
        } : null,
        // Whether a key exists, never the key. Same rule as the user's own
        // Settings panel (CLAUDE.md §7.7).
        dependencyTrack: {
          configured:  row.dtConfigured === true,
          apiUrl:      row.dtApiUrl || '',
          frontendUrl: row.dtFrontendUrl || '',
          hasApiKey:   row.dtHasApiKey === true,
          updatedAt:   row.dtUpdatedAt,
        },
        settings: {
          maxReports:        row.maxReports,
          overridden:        row.maxReportsOverridden === true,
          defaultMaxReports: row.defaultMaxReports,
          limits: { min: appSettings.MIN_MAX_REPORTS, max: appSettings.MAX_MAX_REPORTS },
        },
        mail: {
          enabled:     row.mailEnabled === true,
          host:        row.mailHost || '',
          port:        row.mailPort,
          from:        row.mailFrom || '',
          recipients:  row.mailRecipients || 0,
          hasPassword: row.mailHasPassword === true,
        },
        schedule: {
          enabled:       row.scheduleEnabled === true,
          frequency:     row.frequency,
          hour:          row.hour,
          projectCount:  row.scheduleProjects,
          nextRunAt:     row.nextRunAt,
          lastRunAt:     row.lastRunAt,
          lastRunStatus: row.lastRunStatus,
        },
        reports: {
          total:        row.reportCount,
          completed:    row.reportsCompleted,
          running:      row.reportsRunning,
          failed:       row.reportsFailed,
          storageBytes: Number(row.storageBytes),
          newestAt:     row.newestReportAt,
        },
      });
    } catch (err) {
      log('error', `Administration detail failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not load the account.', code: 'INTERNAL' });
    }
    return true;
  }

  return false;
}

module.exports = { handle, requireAdmin };
