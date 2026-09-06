// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Service-wide settings ─────────────────────────────────────────────────────
// Configuration the administrator owns, as opposed to anything a user chooses
// for themselves. Exactly one row exists, seeded by migration 005 and guarded by
// a singleton primary key, so there is never a question of which row is current.
//
// This is not per-user state in module scope (CLAUDE.md §7.5) — it belongs to
// the installation, not to a principal, and every read goes to the database.

const { query } = require('../db/pool');

// The floor and ceiling an override may also take, so a global value can never
// be one a per-user override could not express.
const MIN_MAX_REPORTS = 1;
const MAX_MAX_REPORTS = 1000;

// The schedule ceiling is the same idea applied to a different resource: not
// disk but recurring upstream work, since every schedule crawls DependencyTrack
// on its own timetable. Bounded far lower than reports for that reason.
const MIN_MAX_SCHEDULES = 1;
const MAX_MAX_SCHEDULES = 100;

// Used only if the row is somehow missing — the service must not fail closed on
// report creation because a settings read came back empty.
const FALLBACK_MAX_REPORTS = 10;
const FALLBACK_MAX_SCHEDULES = 5;

/** Every service-wide setting, in the shape the administration screen renders. */
async function get() {
  const { rows } = await query(
    `SELECT default_max_reports   AS "defaultMaxReports",
            default_max_schedules AS "defaultMaxSchedules",
            updated_at            AS "updatedAt"
       FROM app_settings WHERE id = TRUE`
  );
  return rows[0] || {
    defaultMaxReports:   FALLBACK_MAX_REPORTS,
    defaultMaxSchedules: FALLBACK_MAX_SCHEDULES,
    updatedAt:           null,
  };
}

/** The default report ceiling for accounts with no override of their own. */
async function getDefaultMaxReports() {
  const { defaultMaxReports } = await get();
  return (Number.isInteger(defaultMaxReports) && defaultMaxReports > 0)
    ? defaultMaxReports
    : FALLBACK_MAX_REPORTS;
}

/**
 * Set the default every non-overridden account follows.
 *
 * Changing this does not touch anybody's reports. Lowering it stops affected
 * accounts creating new ones until they are back under the limit; it never
 * deletes what they already have, because one administrator click must not
 * destroy many users' data.
 *
 * @throws {Error} code VALIDATION_FAILED when out of range
 */
async function setDefaultMaxReports(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_MAX_REPORTS || n > MAX_MAX_REPORTS) {
    throw Object.assign(
      new Error(`The default report limit must be a whole number between ${MIN_MAX_REPORTS} and ${MAX_MAX_REPORTS}.`),
      { code: 'VALIDATION_FAILED', field: 'defaultMaxReports' }
    );
  }
  const { rows } = await query(
    `UPDATE app_settings SET default_max_reports = $1 WHERE id = TRUE
     RETURNING default_max_reports AS "defaultMaxReports"`,
    [n]
  );
  return rows[0];
}

/** The default schedule ceiling for accounts with no override of their own. */
async function getDefaultMaxSchedules() {
  const { defaultMaxSchedules } = await get();
  return (Number.isInteger(defaultMaxSchedules) && defaultMaxSchedules > 0)
    ? defaultMaxSchedules
    : FALLBACK_MAX_SCHEDULES;
}

/**
 * Set the default number of schedules every non-overridden account follows.
 *
 * Like the report limit, lowering this never deletes anything. Accounts already
 * over the new number keep every schedule they have and simply cannot add more
 * — one administrator click must not silently stop other people's reports.
 *
 * @throws {Error} code VALIDATION_FAILED when out of range
 */
async function setDefaultMaxSchedules(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_MAX_SCHEDULES || n > MAX_MAX_SCHEDULES) {
    throw Object.assign(
      new Error(`The default schedule limit must be a whole number between ${MIN_MAX_SCHEDULES} and ${MAX_MAX_SCHEDULES}.`),
      { code: 'VALIDATION_FAILED', field: 'defaultMaxSchedules' }
    );
  }
  const { rows } = await query(
    `UPDATE app_settings SET default_max_schedules = $1 WHERE id = TRUE
     RETURNING default_max_schedules AS "defaultMaxSchedules"`,
    [n]
  );
  return rows[0];
}

/** How many accounts would be over a proposed schedule default. */
async function accountsOverScheduleDefault(proposed) {
  const { rows } = await query(
    `SELECT count(*)::int AS "affected"
       FROM user_settings s
       JOIN (
         SELECT user_id, count(*)::int AS n FROM schedules GROUP BY user_id
       ) c ON c.user_id = s.user_id
      WHERE s.max_schedules IS NULL AND c.n > $1`,
    [Number(proposed)]
  );
  return rows[0].affected;
}

/**
 * How many accounts would be over a proposed default, so the administrator is
 * told the consequence before saving rather than after.
 *
 * Only accounts that actually follow the default are counted — an overridden
 * account is unaffected by this value by definition.
 */
async function accountsOverDefault(proposed) {
  const { rows } = await query(
    `SELECT count(*)::int AS "affected"
       FROM user_settings s
       JOIN (
         SELECT user_id, count(*)::int AS active
           FROM reports
          WHERE status IN ('completed', 'running')
          GROUP BY user_id
       ) r ON r.user_id = s.user_id
      WHERE s.max_reports IS NULL AND r.active > $1`,
    [Number(proposed)]
  );
  return rows[0].affected;
}

module.exports = {
  get,
  getDefaultMaxReports, setDefaultMaxReports, accountsOverDefault,
  getDefaultMaxSchedules, setDefaultMaxSchedules, accountsOverScheduleDefault,
  MIN_MAX_REPORTS, MAX_MAX_REPORTS, FALLBACK_MAX_REPORTS,
  MIN_MAX_SCHEDULES, MAX_MAX_SCHEDULES, FALLBACK_MAX_SCHEDULES,
};
