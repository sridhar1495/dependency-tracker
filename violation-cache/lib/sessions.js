// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Bearer-token sessions — data access ───────────────────────────────────────
// S8: only the SHA-256 of a token is ever stored or queried. The token itself
// never reaches this module — callers hash it first via lib/crypto.js — so a
// database disclosure yields nothing usable.
//
// The "one live session per user" rule is enforced by a partial unique index,
// not by the code below: two simultaneous logins cannot both succeed even if
// they interleave perfectly (CLAUDE.md §7.2).

const { query } = require('../db/pool');

// token_hash is bytea and is deliberately excluded from projections — there is
// no reason to read it back, and naming columns keeps bytea off the wire.
const SESSION_COLUMNS = `
  id, user_id AS "userId", principal_type AS "principalType",
  issued_at AS "issuedAt", expires_at AS "expiresAt",
  last_seen_at AS "lastSeenAt", revoked_at AS "revokedAt",
  user_agent AS "userAgent", ip_address AS "ipAddress"
`;

/** Raised when the single-live-session index rejects a second session. */
function asSessionExists(err) {
  if (err && err.code === '23505' &&
      (err.constraint === 'ux_sessions_one_live_per_user' ||
       err.constraint === 'ux_sessions_one_live_admin')) {
    return Object.assign(
      new Error('An active session already exists for this account.'),
      { code: 'SESSION_EXISTS', cause: err }
    );
  }
  return err;
}

/**
 * Issue a session.
 *
 * @param {object}  input
 * @param {Buffer}  input.tokenHash       SHA-256 of the bearer token (32 bytes)
 * @param {string}  [input.userId]        null for the administrator principal
 * @param {string}  input.principalType   'user' | 'admin'
 * @param {number}  input.absoluteHours   lifetime from now
 * @param {string}  [input.userAgent]
 * @param {string}  [input.ipAddress]
 * @throws {Error} code SESSION_EXISTS when a live session is already present
 */
async function create({ tokenHash, userId = null, principalType, absoluteHours, userAgent = null, ipAddress = null }) {
  try {
    const { rows } = await query(
      `INSERT INTO user_sessions
         (user_id, principal_type, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6)
       RETURNING ${SESSION_COLUMNS}`,
      [userId, principalType, tokenHash, absoluteHours, userAgent, ipAddress]
    );
    return rows[0];
  } catch (err) {
    throw asSessionExists(err);
  }
}

/**
 * Resolve a token hash to a live session.
 *
 * "Live" means not revoked, within its absolute expiry, and within the idle
 * window. All three are evaluated in SQL so the caller cannot forget one.
 *
 * @param {Buffer} tokenHash
 * @param {number} idleHours
 * @returns {Promise<object|null>} the session with its user, or null
 */
async function findLiveByTokenHash(tokenHash, idleHours) {
  const { rows } = await query(
    `SELECT s.id, s.user_id AS "userId", s.principal_type AS "principalType",
            s.expires_at AS "expiresAt", s.last_seen_at AS "lastSeenAt",
            u.login_id AS "loginId", u.first_name AS "firstName", u.last_name AS "lastName",
            u.email, u.must_change_password AS "mustChangePassword"
       FROM user_sessions s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(hours => $2)`,
    [tokenHash, idleHours]
  );
  return rows[0] || null;
}

/** The live session for a user, if any. Used to describe it before force-disconnect. */
async function findLiveForUser(userId) {
  const { rows } = await query(
    `SELECT ${SESSION_COLUMNS} FROM user_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [userId]
  );
  return rows[0] || null;
}

/** The live administrator session, if any. */
async function findLiveAdmin() {
  const { rows } = await query(
    `SELECT ${SESSION_COLUMNS} FROM user_sessions
      WHERE principal_type = 'admin' AND revoked_at IS NULL AND expires_at > now()`
  );
  return rows[0] || null;
}

/**
 * Advance the idle clock.
 * P10: callers throttle this to at most once per minute per session. Writing it
 * on every request would mean one row update per API call.
 */
async function touch(id) {
  await query('UPDATE user_sessions SET last_seen_at = now() WHERE id = $1', [id]);
}

/** Revoke one session by token hash. Returns true when a live session was revoked. */
async function revokeByTokenHash(tokenHash) {
  const { rowCount } = await query(
    'UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash]
  );
  return rowCount > 0;
}

/** Revoke every live session for a user. Used by force-disconnect at login. */
async function revokeAllForUser(userId) {
  const { rowCount } = await query(
    'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
  return rowCount;
}

/** Revoke the live administrator session. */
async function revokeAdmin() {
  const { rowCount } = await query(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE principal_type = 'admin' AND revoked_at IS NULL`
  );
  return rowCount;
}

/**
 * Delete rows that can never authenticate again.
 * Without this the table grows without bound (CLAUDE.md §13).
 *
 * @param {number} [retentionDays=7] how long revoked/expired rows are kept for audit
 * @returns {Promise<number>} rows removed
 */
async function sweepExpired(retentionDays = 7) {
  const { rowCount } = await query(
    `DELETE FROM user_sessions
      WHERE (expires_at < now() - make_interval(days => $1))
         OR (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => $1))`,
    [retentionDays]
  );
  return rowCount;
}

module.exports = {
  create, findLiveByTokenHash, findLiveForUser, findLiveAdmin,
  touch, revokeByTokenHash, revokeAllForUser, revokeAdmin, sweepExpired,
};
