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

// The administrator's reserved data identity, seeded by migration 004. It holds
// the administrator's own DependencyTrack connection, settings, mail config and
// schedule so those flow through the ordinary per-user paths — it is NOT an
// account, is never authenticated against, and is excluded from every listing
// (S28). See db/migrations/004_admin_principal.sql.
const ADMIN_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000001';

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
 * @returns {Promise<{ id: string, passwordHash: string, mustChangePassword: boolean }|null>}
 */
async function verifyLookup(loginId) {
  const { rows } = await query(
    `SELECT id, password_hash AS "passwordHash",
            must_change_password AS "mustChangePassword"
       FROM users WHERE login_id = $1`,
    [loginId]
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

/**
 * Replace an account's password on an administrator's behalf.
 *
 * `must_change_password` is set in the same statement, so there is no window in
 * which the administrator's chosen password works as an ordinary credential.
 * Until the user picks their own, their session can reach only the set-password
 * and logout routes — which is what stops a password reset from doubling as a
 * way to read that user's DependencyTrack connection and reports.
 *
 * Revoking the existing session is the caller's job (auth.revokeUserSessions),
 * because it must also evict the in-process token cache.
 *
 * @returns {Promise<object|null>} null when no such account, so the caller 404s
 */
async function adminResetPassword(id, passwordHash, { loginIdAttempted = null } = {}) {
  // The audit row is written in the SAME transaction as the password change,
  // not after it. Writing it afterwards meant a failure there left the password
  // already replaced while the caller was told the reset had failed — the
  // administrator would retry against a credential that had silently changed.
  // Either both happen or neither does.
  return tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE users SET password_hash = $2, must_change_password = TRUE
        WHERE id = $1 AND id <> $3
        RETURNING ${PUBLIC_COLUMNS}`,
      [id, passwordHash, ADMIN_PRINCIPAL_ID]
    );
    if (!rows[0]) return null;
    await client.query(
      `INSERT INTO login_audit (user_id, login_id_attempted, event)
       VALUES ($1, $2, 'admin_password_reset')`,
      [id, loginIdAttempted]
    );
    return rows[0];
  });
}

/**
 * Store a password the user chose themselves and clear the forced-change flag.
 * Separate from updateProfile so the flag can only ever be cleared by this one
 * path — the user actually setting a password.
 */
async function completePasswordChange(id, passwordHash) {
  const { rows } = await query(
    `UPDATE users SET password_hash = $2, must_change_password = FALSE
      WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [id, passwordHash]
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

/**
 * Which of the supplied identifiers are already taken.
 *
 * One query for both, so registration can report every clashing field at once
 * instead of making the user resubmit to discover the second one. Advisory: the
 * unique indexes remain the final arbiter, since another registration can land
 * between this check and the insert.
 *
 * @returns {Promise<{loginId: boolean, email: boolean}>} true = taken
 */
async function findTakenIdentifiers({ loginId, email }) {
  const { rows } = await query(
    `SELECT
       EXISTS (SELECT 1 FROM users WHERE login_id = $1)                       AS "loginId",
       ($2::citext IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE email = $2)) AS "email"`,
    [loginId || '', email || null]
  );
  return rows[0];
}

/** Total account count. Used by the administration panel. */
async function count() {
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM users WHERE id <> $1', [ADMIN_PRINCIPAL_ID]
  );
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
            COALESCE(sc.enabled, false)            AS "scheduleEnabled",
            -- The number actually enforced, and whether it was chosen for this
            -- account or inherited. The screen shows both: a limit with no
            -- indication of where it came from cannot be acted on, because the
            -- administrator cannot tell what changing the global default does.
            COALESCE(st.max_reports, a.default_max_reports)::int AS "maxReports",
            (st.max_reports IS NOT NULL)           AS "maxReportsOverridden"
       FROM (
         SELECT id, login_id, email, first_name, last_name, created_at, last_login_at
           FROM users WHERE id <> $2 ORDER BY created_at LIMIT $1
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
       LEFT JOIN user_settings st  ON st.user_id = u.id
       -- One row by construction (singleton primary key), so this is a constant
       -- the planner materialises once, not a join that grows the result.
       CROSS JOIN app_settings a
      WHERE a.id = TRUE
      ORDER BY u.created_at`,
    [limit, ADMIN_PRINCIPAL_ID]
  );
  return rows;
}

/**
 * One account's detail, for the administration panel's per-user view.
 *
 * Same rule as the listing: metadata and counts only. It reports the shape of
 * someone's configuration — whether a DependencyTrack connection exists, how
 * many recipients their mail settings name — never its contents. There is
 * deliberately no path from here to an API key, an SMTP password or a report's
 * bytes (S27).
 *
 * @returns {Promise<object|null>} null when the account does not exist
 */
async function detailForAdmin(loginId) {
  const { rows } = await query(
    `SELECT u.id, u.login_id AS "loginId", u.email,
            u.first_name AS "firstName", u.last_name AS "lastName",
            u.created_at AS "createdAt", u.updated_at AS "updatedAt",
            u.last_login_at AS "lastLoginAt",

            s.issued_at    AS "sessionIssuedAt",
            s.last_seen_at AS "sessionLastSeenAt",
            s.expires_at   AS "sessionExpiresAt",
            s.user_agent   AS "sessionUserAgent",
            s.ip_address   AS "sessionIpAddress",

            c.api_url AS "dtApiUrl", c.frontend_url AS "dtFrontendUrl",
            c.is_configured AS "dtConfigured",
            (c.api_key_ciphertext IS NOT NULL) AS "dtHasApiKey",
            c.updated_at AS "dtUpdatedAt",

            COALESCE(st.max_reports, aps.default_max_reports)::int AS "maxReports",
            (st.max_reports IS NOT NULL) AS "maxReportsOverridden",
            aps.default_max_reports::int AS "defaultMaxReports",

            m.enabled AS "mailEnabled", m.smtp_host AS "mailHost",
            m.smtp_port AS "mailPort", m.from_addr AS "mailFrom",
            COALESCE(array_length(m.to_addrs, 1), 0) AS "mailRecipients",
            (m.smtp_pass_ciphertext IS NOT NULL) AS "mailHasPassword",

            sc.enabled AS "scheduleEnabled", sc.frequency, sc.hour,
            sc.next_run_at AS "nextRunAt", sc.last_run_at AS "lastRunAt",
            sc.last_run_status AS "lastRunStatus",
            (SELECT count(*)::int FROM schedule_projects p WHERE p.user_id = u.id) AS "scheduleProjects",

            r.total::int      AS "reportCount",
            r.completed::int  AS "reportsCompleted",
            r.running::int    AS "reportsRunning",
            r.failed::int     AS "reportsFailed",
            r.bytes::bigint   AS "storageBytes",
            r.newest          AS "newestReportAt"
       FROM users u
       LEFT JOIN LATERAL (
         SELECT issued_at, last_seen_at, expires_at, user_agent, ip_address
           FROM user_sessions
          WHERE user_id = u.id AND principal_type = 'user'
            AND revoked_at IS NULL AND expires_at > now()
          LIMIT 1
       ) s ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS total,
                count(*) FILTER (WHERE status = 'completed') AS completed,
                count(*) FILTER (WHERE status = 'running')   AS running,
                count(*) FILTER (WHERE status = 'failed')    AS failed,
                COALESCE(sum(file_size_bytes), 0)            AS bytes,
                max(created_at)                              AS newest
           FROM reports WHERE user_id = u.id
       ) r ON true
       LEFT JOIN dt_connections c ON c.user_id = u.id
       LEFT JOIN user_settings st ON st.user_id = u.id
       LEFT JOIN mail_settings m  ON m.user_id  = u.id
       LEFT JOIN schedules sc     ON sc.user_id = u.id
       -- Singleton, so this stays a constant rather than multiplying rows.
       CROSS JOIN app_settings aps
      WHERE u.login_id = $1 AND u.id <> $2 AND aps.id = TRUE`,
    [loginId, ADMIN_PRINCIPAL_ID]
  );
  return rows[0] || null;
}

module.exports = {
  create, findById, findByLoginId, verifyLookup, updateProfile,
  adminResetPassword, completePasswordChange,
  touchLastLogin, deleteById, isLoginIdAvailable, isEmailAvailable,
  findTakenIdentifiers, count,
  listWithStats, detailForAdmin, PUBLIC_COLUMNS, ADMIN_PRINCIPAL_ID,
};
