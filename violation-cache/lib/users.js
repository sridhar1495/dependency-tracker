// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── User accounts — data access ───────────────────────────────────────────────
// Every statement here is parameterised and every read of user-owned data is
// scoped by user_id (CLAUDE.md §5.1, §7.5).
//
// This module stores credentials; it never derives them. Hashing and
// verification live in lib/crypto.js so the KDF can be changed in one place.

const { query, tx } = require('../db/pool');

// Columns returned to callers. password_hash is deliberately excluded from every
// projection except verifyLookup(), so it cannot leak into an API response by
// accident (S7).
const PUBLIC_COLUMNS = `
  id, login_id AS "loginId", email,
  first_name AS "firstName", last_name AS "lastName",
  created_at AS "createdAt", updated_at AS "updatedAt", last_login_at AS "lastLoginAt"
`;

// Maps a unique-violation constraint name onto the field the user must correct.
const UNIQUE_CONSTRAINT_FIELD = {
  ux_users_login_id: 'loginId',
  ux_users_email:    'email',
};

/** Translate a PostgreSQL unique violation into a typed, field-aware error. */
function asConflict(err) {
  if (err && err.code === '23505') {
    const field = UNIQUE_CONSTRAINT_FIELD[err.constraint] || null;
    return Object.assign(
      new Error(field === 'email'
        ? 'This email address is already registered.'
        : 'This login ID is already registered.'),
      { code: 'ALREADY_REGISTERED', field, cause: err }
    );
  }
  return err;
}

/**
 * Create a user and seed every dependent configuration row in one transaction.
 *
 * Seeding here — rather than lazily on first read — means no later code path
 * needs a "row might not exist" branch: every per-user lookup is a single
 * indexed read that always finds a row.
 *
 * @param {{ loginId: string, email: string|null, firstName: string,
 *           lastName: string, passwordHash: string }} input
 * @returns {Promise<object>} the created user, without the password hash
 */
async function create({ loginId, email, firstName, lastName, passwordHash }) {
  try {
    return await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO users (login_id, email, first_name, last_name, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${PUBLIC_COLUMNS}`,
        [loginId, email || null, firstName, lastName, passwordHash]
      );
      const user = rows[0];

      await client.query('INSERT INTO dt_connections (user_id) VALUES ($1)', [user.id]);
      await client.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
      await client.query('INSERT INTO mail_settings (user_id) VALUES ($1)', [user.id]);
      await client.query('INSERT INTO schedules (user_id) VALUES ($1)', [user.id]);

      return user;
    });
  } catch (err) {
    throw asConflict(err);
  }
}

/** Look up a user by id. Returns null when absent. */
async function findById(id) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** Look up a user by login ID (case-insensitive via citext). Returns null when absent. */
async function findByLoginId(loginId) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE login_id = $1`, [loginId]
  );
  return rows[0] || null;
}

/**
 * Fetch the stored password hash for an authentication attempt.
 * Separate from findByLoginId so the hash is only read where it is needed.
 *
 * @returns {Promise<{ id: string, passwordHash: string }|null>}
 */
async function verifyLookup(loginId) {
  const { rows } = await query(
    'SELECT id, password_hash AS "passwordHash" FROM users WHERE login_id = $1', [loginId]
  );
  return rows[0] || null;
}

/**
 * Update the mutable profile fields.
 * Login ID and email are intentionally NOT updatable: the frontend renders them
 * read-only and this function ignores them even if supplied, so a crafted
 * request cannot change an identity (CLAUDE.md §9.3).
 *
 * @param {string} id
 * @param {{ firstName?: string, lastName?: string, passwordHash?: string }} patch
 * @returns {Promise<object|null>} the updated user, or null when absent
 */
async function updateProfile(id, patch) {
  const sets = [];
  const params = [id];

  if (patch.firstName !== undefined) { params.push(patch.firstName); sets.push(`first_name = $${params.length}`); }
  if (patch.lastName  !== undefined) { params.push(patch.lastName);  sets.push(`last_name = $${params.length}`); }
  if (patch.passwordHash !== undefined) { params.push(patch.passwordHash); sets.push(`password_hash = $${params.length}`); }

  if (sets.length === 0) return findById(id);

  const { rows } = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    params
  );
  return rows[0] || null;
}

/** Record a successful authentication. */
async function touchLastLogin(id) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

/**
 * Delete an account and everything it owns.
 * Sessions, DT connection, settings, mail settings, schedules, schedule
 * projects, runs, reports and report chunks all cascade. login_audit rows
 * survive with user_id set to null so the trail outlives the account.
 *
 * @returns {Promise<boolean>} true when a row was removed
 */
async function deleteById(id) {
  const { rowCount } = await query('DELETE FROM users WHERE id = $1', [id]);
  return rowCount > 0;
}

/**
 * Is this login ID free?
 * The answer is advisory only — the unique index is the real arbiter, because a
 * competing registration can land between this check and the insert.
 */
async function isLoginIdAvailable(loginId) {
  const { rowCount } = await query('SELECT 1 FROM users WHERE login_id = $1', [loginId]);
  return rowCount === 0;
}

/** Is this email address free? Advisory only, as above. */
async function isEmailAvailable(email) {
  if (!email) return true;
  const { rowCount } = await query('SELECT 1 FROM users WHERE email = $1', [email]);
  return rowCount === 0;
}

/** Total account count. Used by the administration panel. */
async function count() {
  const { rows } = await query('SELECT count(*)::int AS n FROM users');
  return rows[0].n;
}

/**
 * Every account with the counts the administration panel renders.
 *
 * One query rather than a per-user round trip: with a few hundred accounts the
 * N+1 shape would be several hundred queries for one page view (CLAUDE.md §13).
 * The aggregates are computed in lateral subqueries so a user with no reports
 * still appears, with zeroes.
 *
 * Read-only, and it returns no secret of any kind — no password hash, no API
 * key, not even whether the DT key decrypts (S24).
 */
async function listWithStats({ limit = 500 } = {}) {
  const { rows } = await query(
    // P16: the page of users is selected BEFORE the laterals run. Ordering and
    // limiting at the top level instead made PostgreSQL evaluate every lateral
    // for all 5,000 accounts and throw away 4,500 of the results — 337 ms and
    // 136,861 buffers, against 7 ms and 4,873 this way.
    //
    // S26/P17: `principal_type = 'user'` is not a filter, it is what makes
    // ux_sessions_one_live_per_user usable. That index is partial on
    // (revoked_at IS NULL AND principal_type = 'user'), and without the
    // predicate the planner fell back to scanning the whole session table once
    // per account. An administrator session has user_id NULL, so it could never
    // have matched anyway and no row changes.
    `SELECT u.id, u.login_id AS "loginId", u.email,
            u.first_name AS "firstName", u.last_name AS "lastName",
            u.created_at AS "createdAt", u.last_login_at AS "lastLoginAt",
            (s.id IS NOT NULL)                     AS "sessionActive",
            s.last_seen_at                         AS "lastSeenAt",
            COALESCE(r.reports, 0)::int            AS "reportCount",
            COALESCE(r.bytes, 0)::bigint           AS "storageBytes",
            COALESCE(c.is_configured, false)       AS "dtConfigured",
            COALESCE(sc.enabled, false)            AS "scheduleEnabled"
       FROM (
         SELECT id, login_id, email, first_name, last_name, created_at, last_login_at
           FROM users ORDER BY created_at LIMIT $1
       ) u
       LEFT JOIN LATERAL (
         SELECT id, last_seen_at FROM user_sessions
          WHERE user_id = u.id AND principal_type = 'user'
            AND revoked_at IS NULL AND expires_at > now()
          LIMIT 1
       ) s ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS reports, COALESCE(sum(file_size_bytes), 0) AS bytes
           FROM reports WHERE user_id = u.id
       ) r ON true
       LEFT JOIN dt_connections c ON c.user_id = u.id
       LEFT JOIN schedules sc      ON sc.user_id = u.id
      ORDER BY u.created_at`,
    [limit]
  );
  return rows;
}

module.exports = {
  create, findById, findByLoginId, verifyLookup, updateProfile,
  touchLastLogin, deleteById, isLoginIdAvailable, isEmailAvailable, count,
  listWithStats, PUBLIC_COLUMNS,
};
