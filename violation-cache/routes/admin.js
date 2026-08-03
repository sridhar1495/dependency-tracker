// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Administration — read only ────────────────────────────────────────────────
//   GET /admin/users     accounts with session, report and storage counts
//   GET /admin/overview  service-wide totals
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

  return false;
}

module.exports = { handle, requireAdmin };
