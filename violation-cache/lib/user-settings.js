// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Per-user preferences ──────────────────────────────────────────────────────
// Seeded at registration, so every read finds a row and no call site needs a
// "might not exist" branch.
//
// max_reports is a PER-USER quota, never a global counter (CLAUDE.md §7.5).

const { query } = require('../db/pool');

const DEFAULT_MAX_REPORTS = 10;
const MIN_MAX_REPORTS = 1;
const MAX_MAX_REPORTS = 1000;

async function get(userId) {
  const { rows } = await query(
    'SELECT max_reports AS "maxReports" FROM user_settings WHERE user_id = $1', [userId]
  );
  return rows[0] || { maxReports: DEFAULT_MAX_REPORTS };
}

/** The per-user report ceiling, falling back to the default for safety. */
async function getMaxReports(userId) {
  const { maxReports } = await get(userId);
  return (Number.isInteger(maxReports) && maxReports > 0) ? maxReports : DEFAULT_MAX_REPORTS;
}

/**
 * @throws {Error} code VALIDATION_FAILED when out of range
 */
async function setMaxReports(userId, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_MAX_REPORTS || n > MAX_MAX_REPORTS) {
    throw Object.assign(
      new Error(`Maximum reports must be a whole number between ${MIN_MAX_REPORTS} and ${MAX_MAX_REPORTS}.`),
      { code: 'VALIDATION_FAILED', field: 'maxReports' }
    );
  }
  await query('UPDATE user_settings SET max_reports = $2 WHERE user_id = $1', [userId, n]);
  return { maxReports: n };
}

module.exports = { get, getMaxReports, setMaxReports, DEFAULT_MAX_REPORTS, MIN_MAX_REPORTS, MAX_MAX_REPORTS };
