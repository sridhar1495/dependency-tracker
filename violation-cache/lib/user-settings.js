// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Per-user preferences ──────────────────────────────────────────────────────
// Seeded at registration, so every read finds a row and no call site needs a
// "might not exist" branch.
//
// The report ceiling is still enforced PER USER and never as a global counter
// (CLAUDE.md §7.5) — what changed in migration 005 is who chooses the number.
// It is an administrator's capacity decision about the server's disk, so:
//
//   max_reports IS NULL  → follow app_settings.default_max_reports
//   max_reports = n      → an administrator set this account's own limit
//
// NULL is the only honest encoding of "not decided here". A stored 10 could not
// be told apart from an unset 10, so raising the global default would silently
// skip every account that happened to sit on the old one.

const { query } = require('../db/pool');
const appSettings = require('./app-settings');

const MIN_MAX_REPORTS = appSettings.MIN_MAX_REPORTS;
const MAX_MAX_REPORTS = appSettings.MAX_MAX_REPORTS;

/**
 * This account's settings, with the quota already resolved.
 *
 * `maxReports` is the number that is actually enforced. `maxReportsOverride` is
 * the raw column, so the administration screen can tell an inherited value from
 * a deliberate one — the two must never be conflated at a call site, which is
 * why resolution happens here and only here.
 */
async function get(userId) {
  const { rows } = await query(
    `SELECT s.max_reports                                  AS "maxReportsOverride",
            COALESCE(s.max_reports, a.default_max_reports) AS "maxReports"
       FROM user_settings s
       CROSS JOIN app_settings a
      WHERE s.user_id = $1 AND a.id = TRUE`,
    [userId]
  );
  if (rows[0]) return rows[0];
  // No settings row at all: fall back to the global default rather than a
  // constant, so a repaired account still sees the administrator's choice.
  return { maxReports: await appSettings.getDefaultMaxReports(), maxReportsOverride: null };
}

/** The report ceiling enforced for this account. */
async function getMaxReports(userId) {
  const { maxReports } = await get(userId);
  return (Number.isInteger(maxReports) && maxReports > 0)
    ? maxReports
    : appSettings.FALLBACK_MAX_REPORTS;
}

/**
 * Give one account a limit of its own, overriding the global default.
 *
 * Administrator-only: a user cannot set this for themselves, which is why the
 * config route ignores `maxReports` in a submitted body entirely.
 *
 * Like the global setting, this never deletes reports. Lowering it stops the
 * account creating new ones until it is back under the limit.
 *
 * @throws {Error} code VALIDATION_FAILED when out of range
 */
async function setMaxReportsOverride(userId, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_MAX_REPORTS || n > MAX_MAX_REPORTS) {
    throw Object.assign(
      new Error(`Maximum reports must be a whole number between ${MIN_MAX_REPORTS} and ${MAX_MAX_REPORTS}.`),
      { code: 'VALIDATION_FAILED', field: 'maxReports' }
    );
  }
  const { rowCount } = await query(
    'UPDATE user_settings SET max_reports = $2 WHERE user_id = $1', [userId, n]
  );
  if (!rowCount) return null;
  return get(userId);
}

/** Return an account to the global default. */
async function clearMaxReportsOverride(userId) {
  const { rowCount } = await query(
    'UPDATE user_settings SET max_reports = NULL WHERE user_id = $1', [userId]
  );
  if (!rowCount) return null;
  return get(userId);
}

module.exports = {
  get, getMaxReports, setMaxReportsOverride, clearMaxReportsOverride,
  MIN_MAX_REPORTS, MAX_MAX_REPORTS,
};
