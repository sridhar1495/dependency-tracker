// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Scheduled reports — data access ───────────────────────────────────────────
// Covers schedules, schedule_projects and schedule_runs.
//
// A user owns any number of schedules (migration 009), each with its own
// frequency, time, project list and delivery name. Every function here is
// scoped by user_id as well as by schedule id, so asking for somebody else's
// schedule gets nothing back and the route turns that into a 404 rather than a
// 403 (CLAUDE.md §7.5) — a 403 would confirm the row exists.
//
// The claim query is the heart of the multi-tenant scheduler: one poller marks
// due rows with FOR UPDATE SKIP LOCKED, so overlap protection lives in the
// database rather than in a process variable, and the design stays correct if
// the service is ever run as more than one replica (CLAUDE.md §6.8).

const { query, tx } = require('../db/pool');
const validate = require('./validate');

/** Comma-separated string or array → trimmed, de-duplicated address list. */
function toAddressList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(raw.map(v => String(v).trim()).filter(Boolean))];
}

// The same shape mail-settings accepts. Deliberately permissive — an address
// this rejects could not be typed into the account-level field either.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VALID_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const VALID_RISK_TYPES  = new Set(['security', 'license', 'operational']);
const MAX_NAME_LENGTH   = 120;

// Schedule ids and project_uuid are uuid columns. Anything else is rejected
// here rather than handed to PostgreSQL, which would raise a type error — and
// for an id that means a malformed one reads as "not found" instead of a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// hour/minute/week_days/month_day are UTC. The picker in the dashboard shows
// browser-local time and converts on the way in and out, so the value stored
// here means the same instant wherever the container and the user happen to be.
const SCHEDULE_COLUMNS = `
  id, user_id AS "userId", name, enabled, frequency, hour, minute,
  week_days AS "weekDays", month_day AS "monthDay", risk_types AS "riskTypes",
  next_run_at AS "nextRunAt", running_since AS "runningSince",
  last_run_at AS "lastRunAt", last_run_status AS "lastRunStatus",
  last_run_error AS "lastRunError", failure_notification AS "failureNotification",
  report_name AS "reportName", created_at AS "createdAt",
  to_addrs AS "toAddrs", cc_addrs AS "ccAddrs", subject
`;

const PROJECT_COUNT = `
  (SELECT count(*)::int FROM schedule_projects p WHERE p.schedule_id = s.id) AS "projectCount"
`;

// ── Reading ───────────────────────────────────────────────────────────────────

/** Every schedule this account owns, oldest first so the list order is stable. */
async function list(userId) {
  const { rows } = await query(
    `SELECT ${SCHEDULE_COLUMNS}, ${PROJECT_COUNT}
       FROM schedules s WHERE s.user_id = $1 ORDER BY s.created_at, s.id`,
    [userId]
  );
  return rows;
}

/**
 * One schedule, or null.
 *
 * Scoped by user_id as well as id: a schedule that belongs to somebody else is
 * indistinguishable here from one that does not exist, which is what lets the
 * route answer 404 without having to know whose it was.
 */
async function get(userId, scheduleId) {
  if (!UUID_RE.test(String(scheduleId || ''))) return null;
  const { rows } = await query(
    `SELECT ${SCHEDULE_COLUMNS}, ${PROJECT_COUNT}
       FROM schedules s WHERE s.id = $2 AND s.user_id = $1`,
    [userId, scheduleId]
  );
  return rows[0] || null;
}

/** How many schedules this account has, for the quota check. */
async function countForUser(userId) {
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM schedules WHERE user_id = $1', [userId]
  );
  return rows[0].n;
}

/** Projects selected for one schedule. */
async function getProjects(userId, scheduleId) {
  if (!UUID_RE.test(String(scheduleId || ''))) return [];
  const { rows } = await query(
    `SELECT project_uuid AS "uuid", project_name AS "name", project_version AS "version"
       FROM schedule_projects WHERE user_id = $1 AND schedule_id = $2 ORDER BY project_name`,
    [userId, scheduleId]
  );
  return rows;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Normalise a submitted definition, or throw VALIDATION_FAILED.
 *
 * Returns only the keys the caller actually supplied, so an update can leave
 * everything else alone and a create can fall back to the column defaults. The
 * two paths share this function precisely so they cannot disagree about what a
 * valid schedule is.
 */
function normalise(input) {
  const out = {};

  if (input.frequency !== undefined) {
    if (!VALID_FREQUENCIES.has(input.frequency)) {
      throw fail('Frequency must be daily, weekly or monthly.', 'frequency');
    }
    out.frequency = input.frequency;
  }
  if (input.hour !== undefined) {
    const h = Number(input.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw fail('Hour must be between 0 and 23.', 'hour');
    out.hour = h;
  }
  if (input.minute !== undefined) {
    const m = Number(input.minute);
    if (!Number.isInteger(m) || m < 0 || m > 59) throw fail('Minute must be between 0 and 59.', 'minute');
    out.minute = m;
  }
  if (input.monthDay !== undefined) {
    const d = Number(input.monthDay);
    if (!Number.isInteger(d) || d < 1 || d > 28) throw fail('Day of month must be between 1 and 28.', 'monthDay');
    out.monthDay = d;
  }
  if (input.weekDays !== undefined) {
    if (!Array.isArray(input.weekDays)) throw fail('Days of week must be a list.', 'weekDays');
    const days = [...new Set(input.weekDays.map(Number))]
      .filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
      .sort((a, b) => a - b);
    if (input.weekDays.length && days.length === 0) {
      throw fail('Days of week must be numbers from 0 (Sunday) to 6.', 'weekDays');
    }
    out.weekDays = days;
  }
  if (input.riskTypes !== undefined) {
    if (!Array.isArray(input.riskTypes)) throw fail('Risk types must be a list.', 'riskTypes');
    const types = input.riskTypes.filter(t => VALID_RISK_TYPES.has(t));
    if (types.length === 0) throw fail('Select at least one risk type.', 'riskTypes');
    out.riskTypes = types;
  }
  if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);

  // The label shown in the settings list. Bounded rather than pattern-matched:
  // unlike reportName it never becomes a filename or a header, and it is
  // escaped before it reaches innerHTML like every other user-supplied string.
  if (input.name !== undefined) {
    const trimmed = typeof input.name === 'string' ? input.name.trim() : '';
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw fail(`A schedule name may be at most ${MAX_NAME_LENGTH} characters.`, 'name');
    }
    // Control characters would make the list render strangely and serve no
    // purpose in a label.
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw fail('A schedule name may not contain control characters.', 'name');
    }
    out.name = trimmed === '' ? null : trimmed;
  }

  // ── Recipient overrides ─────────────────────────────────────────────────
  // NULL means "use the account's list" and an empty array would mean "send to
  // nobody", so the two must not be conflated. A blank field from the form is
  // therefore stored as NULL — the user clearing an override is asking to go
  // back to the account default, not asking to stop delivering.
  if (input.to !== undefined) {
    const list = toAddressList(input.to);
    if (list.length === 0) out.toAddrs = null;
    else {
      const bad = list.find(a => !EMAIL_RE.test(a));
      if (bad) throw fail(`"${bad}" is not a valid email address.`, 'to');
      out.toAddrs = list;
    }
  }
  if (input.cc !== undefined) {
    const list = toAddressList(input.cc);
    // An empty CC is meaningful only when To is also overridden; on its own it
    // reads as "inherit", which is what NULL says.
    if (list.length === 0) out.ccAddrs = null;
    else {
      const bad = list.find(a => !EMAIL_RE.test(a));
      if (bad) throw fail(`"${bad}" is not a valid email address.`, 'cc');
      out.ccAddrs = list;
    }
  }
  if (input.subject !== undefined) {
    const trimmed = typeof input.subject === 'string' ? input.subject.trim() : '';
    if (trimmed.length > 200) throw fail('A subject may be at most 200 characters.', 'subject');
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw fail('A subject may not contain control characters.', 'subject');
    }
    out.subject = trimmed === '' ? null : trimmed;
  }

  // An optional delivery name. NULL means "generate one", so an empty string
  // from the form is stored as NULL rather than as a name nobody typed.
  if (input.reportName !== undefined) {
    const problem = validate.validateReportName(input.reportName);
    if (problem) throw fail(problem, 'reportName');
    const trimmed = typeof input.reportName === 'string' ? input.reportName.trim() : '';
    out.reportName = trimmed === '' ? null : trimmed;
  }

  return out;
}

function fail(message, field) {
  return Object.assign(new Error(message), { code: 'VALIDATION_FAILED', field });
}

// ── Writing ───────────────────────────────────────────────────────────────────

// The columns a caller may set, paired with their SQL name. Listed once so the
// insert and the update cannot drift apart.
const WRITABLE = [
  ['enabled', 'enabled'], ['frequency', 'frequency'], ['hour', 'hour'], ['minute', 'minute'],
  ['weekDays', 'week_days'], ['monthDay', 'month_day'], ['riskTypes', 'risk_types'],
  ['name', 'name'], ['reportName', 'report_name'],
  ['toAddrs', 'to_addrs'], ['ccAddrs', 'cc_addrs'], ['subject', 'subject'],
];

// Arrays need their type stated: an empty JS array reaches PostgreSQL with no
// element type to infer from.
const CASTS = {
  week_days: '::smallint[]', risk_types: '::text[]',
  to_addrs: '::text[]', cc_addrs: '::text[]',
};

/**
 * Create a schedule for this account.
 *
 * The quota is enforced by the route, not here: the check and the message
 * belong together, and a data-access module that refused writes on a policy
 * ground would be a second place to look for one.
 */
async function create(userId, input = {}) {
  const fields = normalise(input);
  const cols = ['user_id'], vals = ['$1'], params = [userId];
  for (const [key, col] of WRITABLE) {
    if (fields[key] === undefined) continue;
    params.push(fields[key]);
    cols.push(col);
    vals.push(`$${params.length}${CASTS[col] || ''}`);
  }
  const { rows } = await query(
    `INSERT INTO schedules (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING id`,
    params
  );
  return get(userId, rows[0].id);
}

/** Update a definition in place. Returns null when the schedule is not this user's. */
async function update(userId, scheduleId, input = {}) {
  if (!UUID_RE.test(String(scheduleId || ''))) return null;
  const fields = normalise(input);
  const sets = [], params = [userId, scheduleId];
  for (const [key, col] of WRITABLE) {
    if (fields[key] === undefined) continue;
    params.push(fields[key]);
    sets.push(`${col} = $${params.length}${CASTS[col] || ''}`);
  }
  if (sets.length === 0) return get(userId, scheduleId);
  const { rowCount } = await query(
    `UPDATE schedules SET ${sets.join(', ')} WHERE id = $2 AND user_id = $1`, params
  );
  if (!rowCount) return null;
  return get(userId, scheduleId);
}

/**
 * Delete one schedule. Its projects go with it; its run history does not
 * (schedule_runs.schedule_id is ON DELETE SET NULL), so cancelling a schedule
 * never erases the record that it ran.
 */
async function remove(userId, scheduleId) {
  if (!UUID_RE.test(String(scheduleId || ''))) return false;
  const { rowCount } = await query(
    'DELETE FROM schedules WHERE id = $2 AND user_id = $1', [userId, scheduleId]
  );
  return rowCount > 0;
}

/** Delete every schedule this account owns. Returns how many went. */
async function removeAll(userId) {
  const { rowCount } = await query('DELETE FROM schedules WHERE user_id = $1', [userId]);
  return rowCount;
}

/** Replace one schedule's selected projects wholesale, in one transaction. */
async function setProjects(userId, scheduleId, projects) {
  if (!UUID_RE.test(String(scheduleId || ''))) return [];
  await tx(async (client) => {
    // Scoped by user_id as well: without it a crafted schedule id would empty
    // somebody else's selection even though the insert below could not refill it.
    await client.query(
      'DELETE FROM schedule_projects WHERE user_id = $1 AND schedule_id = $2', [userId, scheduleId]
    );
    for (const p of projects) {
      if (!p || !UUID_RE.test(String(p.uuid || ''))) continue;
      await client.query(
        `INSERT INTO schedule_projects (user_id, schedule_id, project_uuid, project_name, project_version)
         SELECT $1, $2, $3, $4, $5
          WHERE EXISTS (SELECT 1 FROM schedules WHERE id = $2 AND user_id = $1)
         ON CONFLICT (schedule_id, project_uuid) DO NOTHING`,
        [userId, scheduleId, p.uuid, String(p.name || ''), String(p.version || '')]
      );
    }
  });
  return getProjects(userId, scheduleId);
}

/** Arm one schedule by writing its next fire time. */
async function arm(userId, scheduleId, nextRunAt) {
  if (!UUID_RE.test(String(scheduleId || ''))) return null;
  const { rowCount } = await query(
    'UPDATE schedules SET enabled = true, next_run_at = $3 WHERE id = $2 AND user_id = $1',
    [userId, scheduleId, nextRunAt]
  );
  if (!rowCount) return null;
  return get(userId, scheduleId);
}

/** Disable one schedule without discarding its definition. */
async function disable(userId, scheduleId) {
  if (!UUID_RE.test(String(scheduleId || ''))) return null;
  const { rowCount } = await query(
    'UPDATE schedules SET enabled = false, next_run_at = NULL WHERE id = $2 AND user_id = $1',
    [userId, scheduleId]
  );
  if (!rowCount) return null;
  return get(userId, scheduleId);
}

// ── The poller's claim ────────────────────────────────────────────────────────

/**
 * Claim the single most-overdue schedule that may run right now.
 *
 * SKIP LOCKED means a row already being claimed by another poller (or another
 * replica) is passed over rather than waited on, so one slow user never blocks
 * everybody else.
 *
 * The NOT EXISTS clause is what keeps a user's schedules serialised now that
 * they may have several. Overlap protection used to be free: running_since sat
 * on a row that was itself unique per user. It is not free any more, and
 * without this an account with five schedules at 09:00 would open five parallel
 * crawls against one DependencyTrack connection — exactly the N-times-per-user
 * upstream work §13 forbids.
 */
async function claimOne() {
  const { rows } = await query(
    `UPDATE schedules SET running_since = now()
      WHERE id = (
        SELECT s.id FROM schedules s
         WHERE s.enabled AND s.running_since IS NULL
           AND s.next_run_at IS NOT NULL AND s.next_run_at <= now()
           AND NOT EXISTS (
             SELECT 1 FROM schedules r
              WHERE r.user_id = s.user_id AND r.running_since IS NOT NULL
           )
         ORDER BY s.next_run_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING ${SCHEDULE_COLUMNS}`
  );
  return rows[0] || null;
}

/**
 * Claim up to `limit` due schedules.
 *
 * One statement per claim rather than one for all of them: each claim has to
 * commit before the next runs, or two schedules belonging to the same user
 * would both pass the NOT EXISTS check in the same snapshot and start together.
 * `limit` is small and bounded (CLAUDE.md §13), so the extra round trips cost
 * nothing next to the guarantee.
 */
async function claimDue(limit = 5) {
  const claimed = [];
  for (let i = 0; i < limit; i++) {
    const row = await claimOne();
    if (!row) break;
    claimed.push(row);
  }
  return claimed;
}

/**
 * Claim one schedule for a run the user asked for by hand.
 *
 * Same guarantee as the poller's claim and for the same reason: at most one of
 * an account's schedules runs at a time, so pressing Send now while a scheduled
 * run is in flight waits rather than opening a second crawl. Returns null when
 * the schedule is not this user's, is already running, or another of theirs is.
 *
 * Unlike claimOne it ignores enabled and next_run_at — a paused schedule can
 * still be sent by hand, which is most of the point of pausing one.
 */
async function claimForManualRun(userId, scheduleId) {
  if (!UUID_RE.test(String(scheduleId || ''))) return null;
  const { rows } = await query(
    `UPDATE schedules SET running_since = now()
      WHERE id = (
        SELECT s.id FROM schedules s
         WHERE s.id = $2 AND s.user_id = $1 AND s.running_since IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM schedules r
              WHERE r.user_id = s.user_id AND r.running_since IS NOT NULL
           )
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${SCHEDULE_COLUMNS}`,
    [userId, scheduleId]
  );
  return rows[0] || null;
}

/** Release a claim and record the outcome. */
async function finishRun(scheduleId, { status, error, nextRunAt }) {
  const failureNotification = status === 'failed'
    ? `Scheduled report failed on ${new Date().toLocaleString()}: ${error || 'unknown error'}`
    : null;

  await query(
    `UPDATE schedules
        SET running_since = NULL, last_run_at = now(), last_run_status = $2,
            last_run_error = $3, failure_notification = $4, next_run_at = $5
      WHERE id = $1`,
    [scheduleId, status, error || null, failureNotification, nextRunAt || null]
  );
}

/**
 * Clear claims orphaned by a restart, so a crash mid-run does not wedge a
 * schedule permanently — and, now that a claim also blocks the same user's
 * other schedules, does not wedge all of them.
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
async function ackNotification(userId, scheduleId) {
  if (!UUID_RE.test(String(scheduleId || ''))) return false;
  const { rowCount } = await query(
    'UPDATE schedules SET failure_notification = NULL WHERE id = $2 AND user_id = $1',
    [userId, scheduleId]
  );
  return rowCount > 0;
}

// ── Run history ───────────────────────────────────────────────────────────────
async function startRun(userId, scheduleId) {
  const { rows } = await query(
    "INSERT INTO schedule_runs (user_id, schedule_id, status) VALUES ($1, $2, 'running') RETURNING id",
    [userId, scheduleId]
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

/**
 * Recent runs for one account, or for one of its schedules.
 *
 * scheduleId is optional because a run outlives the schedule that produced it
 * (ON DELETE SET NULL), so "everything this account has run" is still a
 * meaningful question after a schedule is cancelled.
 */
async function recentRuns(userId, { scheduleId = null, limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT id, schedule_id AS "scheduleId", started_at AS "startedAt",
            finished_at AS "finishedAt", status, error, file_size_bytes AS "fileSizeBytes"
       FROM schedule_runs
      WHERE user_id = $1 AND ($2::uuid IS NULL OR schedule_id = $2)
      ORDER BY started_at DESC LIMIT $3`,
    [userId, scheduleId && UUID_RE.test(String(scheduleId)) ? scheduleId : null, limit]
  );
  return rows;
}

/**
 * Run counts plus the most recent few, for one schedule.
 *
 * The totals are over the retention window, not all time: schedule_runs is
 * swept at 90 days (CLAUDE.md §13), so a lifetime counter here would quietly
 * shrink. The caller labels it as such rather than showing a number that means
 * something different every month.
 */
async function runStats(userId, scheduleId, { limit = 5, retentionDays = 90 } = {}) {
  if (!UUID_RE.test(String(scheduleId || ''))) {
    return { total: 0, succeeded: 0, failed: 0, running: 0, recent: [], retentionDays };
  }
  const { rows } = await query(
    `SELECT count(*)::int                                        AS "total",
            count(*) FILTER (WHERE status = 'success')::int      AS "succeeded",
            count(*) FILTER (WHERE status = 'failed')::int       AS "failed",
            count(*) FILTER (WHERE status = 'running')::int      AS "running"
       FROM schedule_runs WHERE user_id = $1 AND schedule_id = $2`,
    [userId, scheduleId]
  );
  const recent = await recentRuns(userId, { scheduleId, limit });
  return { ...rows[0], recent, retentionDays };
}

/** Drop history beyond the retention window (CLAUDE.md §13). */
async function purgeRunsOlderThan(days = 90) {
  const { rowCount } = await query(
    'DELETE FROM schedule_runs WHERE started_at < now() - make_interval(days => $1)', [days]
  );
  return rowCount;
}

module.exports = {
  list, get, countForUser, getProjects, create, update, remove, removeAll,
  setProjects, arm, disable, claimDue, claimOne, claimForManualRun,
  finishRun, releaseStaleClaims,
  ackNotification, startRun, completeRun, recentRuns, runStats, purgeRunsOlderThan,
  normalise, VALID_FREQUENCIES, VALID_RISK_TYPES, MAX_NAME_LENGTH,
};
