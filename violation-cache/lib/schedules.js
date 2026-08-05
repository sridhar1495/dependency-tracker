// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Scheduled reports — data access ───────────────────────────────────────────
// Covers schedules, schedule_projects and schedule_runs.
//
// The claim query is the heart of the multi-tenant scheduler: one poller marks
// due rows with FOR UPDATE SKIP LOCKED, so per-user overlap protection lives in
// the database rather than in a process variable, and the design stays correct
// if the service is ever run as more than one replica (CLAUDE.md §6.8).

const { query, tx } = require('../db/pool');
const validate = require('./validate');

const VALID_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const VALID_RISK_TYPES  = new Set(['security', 'license', 'operational']);

const SCHEDULE_COLUMNS = `
  user_id AS "userId", enabled, frequency, hour,
  week_days AS "weekDays", month_day AS "monthDay", risk_types AS "riskTypes",
  next_run_at AS "nextRunAt", running_since AS "runningSince",
  last_run_at AS "lastRunAt", last_run_status AS "lastRunStatus",
  last_run_error AS "lastRunError", failure_notification AS "failureNotification",
  report_name AS "reportName"
`;

/** The schedule plus its selected project count. */
async function get(userId) {
  const { rows } = await query(
    `SELECT ${SCHEDULE_COLUMNS},
            (SELECT count(*)::int FROM schedule_projects p WHERE p.user_id = s.user_id) AS "projectCount"
       FROM schedules s WHERE s.user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

/** Project UUIDs selected for this user's schedule. */
async function getProjects(userId) {
  const { rows } = await query(
    `SELECT project_uuid AS "uuid", project_name AS "name", project_version AS "version"
       FROM schedule_projects WHERE user_id = $1 ORDER BY project_name`,
    [userId]
  );
  return rows;
}

/** Validate and persist the schedule definition. Does not arm it. */
async function save(userId, input) {
  if (input.frequency !== undefined && !VALID_FREQUENCIES.has(input.frequency)) {
    throw Object.assign(new Error('Frequency must be daily, weekly or monthly.'),
      { code: 'VALIDATION_FAILED', field: 'frequency' });
  }
  if (input.hour !== undefined) {
    const h = Number(input.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      throw Object.assign(new Error('Hour must be between 0 and 23.'),
        { code: 'VALIDATION_FAILED', field: 'hour' });
    }
  }
  if (input.monthDay !== undefined) {
    const d = Number(input.monthDay);
    if (!Number.isInteger(d) || d < 1 || d > 28) {
      throw Object.assign(new Error('Day of month must be between 1 and 28.'),
        { code: 'VALIDATION_FAILED', field: 'monthDay' });
    }
  }
  const riskTypes = Array.isArray(input.riskTypes) ? input.riskTypes.filter(t => VALID_RISK_TYPES.has(t)) : null;
  if (riskTypes && riskTypes.length === 0) {
    throw Object.assign(new Error('Select at least one risk type.'),
      { code: 'VALIDATION_FAILED', field: 'riskTypes' });
  }
  // An optional delivery name. NULL means "generate one", so an empty string
  // from the form is stored as NULL rather than as a name nobody typed.
  let reportName;
  if (input.reportName !== undefined) {
    const problem = validate.validateReportName(input.reportName);
    if (problem) {
      throw Object.assign(new Error(problem), { code: 'VALIDATION_FAILED', field: 'reportName' });
    }
    const trimmed = typeof input.reportName === 'string' ? input.reportName.trim() : '';
    reportName = trimmed === '' ? null : trimmed;
  }

  const weekDays = Array.isArray(input.weekDays)
    ? input.weekDays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
    : null;

  await query(
    `UPDATE schedules SET
        enabled    = COALESCE($2, enabled),
        frequency  = COALESCE($3, frequency),
        hour       = COALESCE($4, hour),
        week_days  = COALESCE($5::smallint[], week_days),
        month_day  = COALESCE($6, month_day),
        risk_types = COALESCE($7::text[], risk_types),
        -- $8 distinguishes "not supplied" from "cleared": undefined leaves the
        -- stored name alone, an empty field clears it back to auto-generated.
        report_name = CASE WHEN $9 THEN $8 ELSE report_name END
      WHERE user_id = $1`,
    [userId,
     input.enabled === undefined ? null : Boolean(input.enabled),
     input.frequency ?? null,
     input.hour === undefined ? null : Number(input.hour),
     weekDays,
     input.monthDay === undefined ? null : Number(input.monthDay),
     riskTypes,
     reportName ?? null,
     input.reportName !== undefined]
  );
  return get(userId);
}

// project_uuid is a uuid column. Anything else is dropped here rather than
// handed to PostgreSQL, which would raise a type error and fail the whole save.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replace the selected projects wholesale, in one transaction. */
async function setProjects(userId, projects) {
  await tx(async (client) => {
    await client.query('DELETE FROM schedule_projects WHERE user_id = $1', [userId]);
    for (const p of projects) {
      if (!p || !UUID_RE.test(String(p.uuid || ''))) continue;
      await client.query(
        `INSERT INTO schedule_projects (user_id, project_uuid, project_name, project_version)
         VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, project_uuid) DO NOTHING`,
        [userId, p.uuid, String(p.name || ''), String(p.version || '')]
      );
    }
  });
  return getProjects(userId);
}

/** Arm the schedule by writing its next fire time. */
async function arm(userId, nextRunAt) {
  await query(
    'UPDATE schedules SET enabled = true, next_run_at = $2 WHERE user_id = $1',
    [userId, nextRunAt]
  );
  return get(userId);
}

/** Disable without discarding the definition. */
async function disable(userId) {
  await query(
    'UPDATE schedules SET enabled = false, next_run_at = NULL WHERE user_id = $1', [userId]
  );
  return get(userId);
}

/**
 * Claim up to `limit` schedules that are due.
 *
 * SKIP LOCKED means a row already being claimed by another poller (or another
 * replica) is passed over rather than waited on, so one slow user never blocks
 * everybody else. Setting running_since in the same statement makes the claim
 * visible to the next tick.
 */
async function claimDue(limit = 5) {
  const { rows } = await query(
    `UPDATE schedules SET running_since = now()
      WHERE user_id IN (
        SELECT user_id FROM schedules
         WHERE enabled AND running_since IS NULL AND next_run_at IS NOT NULL AND next_run_at <= now()
         ORDER BY next_run_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING ${SCHEDULE_COLUMNS}`,
    [limit]
  );
  return rows;
}

/** Release a claim and record the outcome. */
async function finishRun(userId, { status, error, nextRunAt }) {
  const failureNotification = status === 'failed'
    ? `Scheduled report failed on ${new Date().toLocaleString()}: ${error || 'unknown error'}`
    : null;

  await query(
    `UPDATE schedules
        SET running_since = NULL, last_run_at = now(), last_run_status = $2,
            last_run_error = $3, failure_notification = $4, next_run_at = $5
      WHERE user_id = $1`,
    [userId, status, error || null, failureNotification, nextRunAt || null]
  );
}

/**
 * Clear claims orphaned by a restart, so a crash mid-run does not wedge a
 * schedule permanently.
 *
 * @param {number} olderThanMinutes anything claimed longer ago than this is stale
 */
async function releaseStaleClaims(olderThanMinutes = 45) {
  const { rowCount } = await query(
    `UPDATE schedules SET running_since = NULL
      WHERE running_since IS NOT NULL
        AND running_since < now() - make_interval(mins => $1)`,
    [olderThanMinutes]
  );
  return rowCount;
}

/** Clear the failure notice once the browser has displayed it. */
async function ackNotification(userId) {
  await query('UPDATE schedules SET failure_notification = NULL WHERE user_id = $1', [userId]);
}

// ── Run history ───────────────────────────────────────────────────────────────
async function startRun(userId) {
  const { rows } = await query(
    "INSERT INTO schedule_runs (user_id, status) VALUES ($1, 'running') RETURNING id", [userId]
  );
  return rows[0].id;
}

async function completeRun(runId, { status, error, fileSizeBytes }) {
  await query(
    `UPDATE schedule_runs
        SET finished_at = now(), status = $2, error = $3, file_size_bytes = $4
      WHERE id = $1`,
    [runId, status, error || null, fileSizeBytes || null]
  );
}

async function recentRuns(userId, limit = 20) {
  const { rows } = await query(
    `SELECT id, started_at AS "startedAt", finished_at AS "finishedAt",
            status, error, file_size_bytes AS "fileSizeBytes"
       FROM schedule_runs WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

/** Drop history beyond the retention window (CLAUDE.md §13). */
async function purgeRunsOlderThan(days = 90) {
  const { rowCount } = await query(
    'DELETE FROM schedule_runs WHERE started_at < now() - make_interval(days => $1)', [days]
  );
  return rowCount;
}

module.exports = {
  get, getProjects, save, setProjects, arm, disable,
  claimDue, finishRun, releaseStaleClaims, ackNotification,
  startRun, completeRun, recentRuns, purgeRunsOlderThan,
  VALID_FREQUENCIES, VALID_RISK_TYPES,
};
