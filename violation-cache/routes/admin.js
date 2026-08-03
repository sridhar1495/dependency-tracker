// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Administration — read only ────────────────────────────────────────────────
//   GET /admin/users            accounts with session, report and storage counts
//   GET /admin/overview         service-wide totals
//   GET /admin/users/:loginId   one account's detail
//
// Deliberately read-only. There is no route here that disconnects a session,
// resets a password or deletes an account: an administrator who can do those
// things is a much larger blast radius than this panel is worth, and none of it
// was asked for.
//
// S25: the administrator sees metadata about accounts, never their contents.
// No password hash, no DependencyTrack API key, no SMTP password, and no report
// bytes are reachable from any route in this file — an administrator cannot read
// another person's report, only count them.

const { log } = require('../lib/log');
const { jsonReply } = require('../lib/http-util');
const users  = require('../lib/users');
const caches = require('../lib/caches');

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

async function handle({ method, path: parsedPath, res, principal }) {

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
        // Settings panel (CLAUDE.md §7.6).
        dependencyTrack: {
          configured:  row.dtConfigured === true,
          apiUrl:      row.dtApiUrl || '',
          frontendUrl: row.dtFrontendUrl || '',
          hasApiKey:   row.dtHasApiKey === true,
          updatedAt:   row.dtUpdatedAt,
        },
        settings: { maxReports: row.maxReports },
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
