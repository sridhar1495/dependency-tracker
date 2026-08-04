// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Authentication audit trail — data access ──────────────────────────────────
// Append-only. Rows survive deletion of the account they refer to (the foreign
// key is ON DELETE SET NULL), with the attempted login ID retained as text so
// the trail stays readable.
//
// S9: never record a password, a token or a token hash here. The login ID and
// the outcome are the whole point; the credential is not.

const { query } = require('../db/pool');

const EVENTS = new Set([
  'register', 'login', 'logout', 'failed', 'force_disconnect', 'delete', 'lockout',
  // An administrator set somebody else's password. The most privileged thing
  // the administration screen can do, so it is never silent.
  'admin_password_reset',
]);

/**
 * Record an authentication event.
 *
 * @param {object}      e
 * @param {string|null} [e.userId]           null when the account is unknown or deleted
 * @param {string}      [e.loginIdAttempted] what the caller typed
 * @param {string}      e.event              one of EVENTS
 * @param {string|null} [e.ipAddress]
 * @param {string|null} [e.userAgent]
 */
async function record({ userId = null, loginIdAttempted = null, event, ipAddress = null, userAgent = null }) {
  if (!EVENTS.has(event)) {
    throw Object.assign(new Error(`Unknown audit event "${event}"`), { code: 'AUDIT_BAD_EVENT' });
  }
  await query(
    `INSERT INTO login_audit (user_id, login_id_attempted, event, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, loginIdAttempted, event, ipAddress, userAgent]
  );
}

/**
 * Count recent failed attempts for a login ID and source address.
 * Backs the brute-force lockout: five failures in the window triggers it
 * (CLAUDE.md §12).
 *
 * @param {string} loginId
 * @param {string|null} ipAddress
 * @param {number} windowMinutes
 */
async function recentFailures(loginId, ipAddress, windowMinutes = 15) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM login_audit
      WHERE event = 'failed'
        AND login_id_attempted = $1
        AND ($2::inet IS NULL OR ip_address = $2::inet)
        AND created_at > now() - make_interval(mins => $3)`,
    [loginId, ipAddress, windowMinutes]
  );
  return rows[0].n;
}

/** Clear the failure streak after a successful authentication. */
async function clearFailures(loginId, ipAddress) {
  await query(
    `DELETE FROM login_audit
      WHERE event = 'failed'
        AND login_id_attempted = $1
        AND ($2::inet IS NULL OR ip_address = $2::inet)`,
    [loginId, ipAddress]
  );
}

/** Most recent events for one user, newest first. Backs the administration panel. */
async function recentForUser(userId, limit = 50) {
  const { rows } = await query(
    `SELECT id, event, ip_address AS "ipAddress", created_at AS "createdAt"
       FROM login_audit
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

/**
 * Drop entries older than the retention period.
 * @param {number} [days=90]
 * @returns {Promise<number>} rows removed
 */
async function purgeOlderThan(days = 90) {
  const { rowCount } = await query(
    'DELETE FROM login_audit WHERE created_at < now() - make_interval(days => $1)', [days]
  );
  return rowCount;
}

module.exports = { record, recentFailures, clearFailures, recentForUser, purgeOlderThan, EVENTS };
