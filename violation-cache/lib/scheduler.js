// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Multi-tenant scheduler ────────────────────────────────────────────────────
// One poller ticks every 60 seconds and claims due schedules with
// FOR UPDATE SKIP LOCKED. There is never one timer per user (CLAUDE.md §6.8):
// with N users that would mean N timers, and a restart would lose all of them.
//
// calcNextRun is a pure function and the single source of truth for timing.
// It reads and returns UTC instants; the browser is the only place a timezone
// is ever applied. Its clock is injectable so tests can pin a weekday.
//
// Per-user overlap protection is the schedules.running_since column, not a
// process variable, so one user's long-running report never blocks another's.
// A user may own several schedules (migration 009); claimDue keeps at most one
// of them running at a time, so five schedules due at 09:00 do not become five
// parallel crawls against that user's single DependencyTrack connection.

const { log } = require('./log');
const { dtGetWithRetry } = require('./dt-fetch');
const { buildExcelReport } = require('./excel');
const { sendEmail } = require('./mail');
const branding = require('./branding');
// Module reference as well as the destructured collector: reportFilename() is
// the single rule for what a report is called, shared with the manual path.
const reports = require('./reports');
const { collectReportData } = reports;
const schedulesDb = require('./schedules');
const mailSettings = require('./mail-settings');
const dtConnections = require('./dt-connections');

const POLL_INTERVAL_MS  = 60_000;  // one tick a minute
const STALE_CLAIM_MINS  = 45;      // longer than the 30-minute report watchdog

// How many scheduled reports may build at once, across all accounts
// (SCHEDULER_CONCURRENCY, default 5). Read through configure() rather than as a
// constant so an operator can tune it for their DependencyTrack without a
// rebuild — the ceiling that matters is DT's, not this service's.
const FALLBACK_CONCURRENCY = 5;
let _maxConcurrent = FALLBACK_CONCURRENCY;

/** Set the pool ceiling. Called once from the boot sequence. */
function configure({ schedulerConcurrency } = {}) {
  if (Number.isInteger(schedulerConcurrency) && schedulerConcurrency > 0) {
    _maxConcurrent = schedulerConcurrency;
  }
}
function maxConcurrent() { return _maxConcurrent; }

let _pollTimer    = null;
let _running      = 0;      // jobs building right now, in this process
let _claiming     = false;  // a claim loop is in progress
let _refillWanted = false;  // a slot freed while that loop was running

// ── Timing ────────────────────────────────────────────────────────────────────
// Q19: hour/minute/weekDays/monthDay are UTC, and this function reads them with
// getUTC* accessors only. It used to build candidates from the server's local
// calendar, which made the answer depend on the container's TZ — an invisible
// variable that changes the delivery time of every schedule in the system if a
// base image ever ships with one set. The stored value is now an instant, not a
// wall-clock reading whose meaning depends on where the process happens to run,
// and the browser is the only place a timezone is applied (CLAUDE.md §6.8).
//
// No behaviour changed for existing installations: nothing set TZ, so the
// server's local calendar already was UTC. This makes that explicit instead of
// accidental, and the Dockerfile pins TZ=UTC so logs agree with it.
/**
 * Calculate the next UTC instant at which the job should fire.
 *
 * @param {object} schedule — frequency, hour, minute, weekDays, monthDay (all UTC)
 * @param {Date} [now] — injectable clock; tests pass a fixed instant
 * @returns {Date}
 */
function calcNextRun(schedule, now = new Date()) {
  const hour   = clampInt(schedule.hour, 0, 23, 9);
  const minute = clampInt(schedule.minute, 0, 59, 0);
  const Y = now.getUTCFullYear();
  const M = now.getUTCMonth();
  const D = now.getUTCDate();

  if (schedule.frequency === 'daily') {
    const next = new Date(Date.UTC(Y, M, D, hour, minute, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  if (schedule.frequency === 'weekly') {
    // Copy before sorting: this is the caller's array, and the row read from
    // the database is reused for the run itself.
    const wanted = (schedule.weekDays && schedule.weekDays.length) ? schedule.weekDays : [1];
    const targetDays = [...wanted].sort((a, b) => a - b);

    // Q20: d starts at 0, so today is a candidate. It used to start at 1, which
    // meant a Tuesday schedule armed on Tuesday morning waited a full week
    // rather than firing that afternoon — the one case a user is most likely to
    // be watching for, because they just set it up. The `candidate <= now`
    // guard is what makes starting at 0 safe: today is offered only while its
    // time is still ahead. d runs to 7 so that a today-only schedule whose time
    // has already passed still finds the same weekday next week.
    for (let d = 0; d <= 7; d++) {
      const candidate = new Date(Date.UTC(Y, M, D + d, hour, minute, 0, 0));
      if (candidate <= now) continue;
      if (targetDays.includes(candidate.getUTCDay())) return candidate;
    }
    // Unreachable for a valid weekDays array — every weekday appears in an
    // 8-day window. Kept so a corrupt row cannot return undefined.
    return new Date(Date.UTC(Y, M, D + 7, hour, minute, 0, 0));
  }

  if (schedule.frequency === 'monthly') {
    const day = Math.min(clampInt(schedule.monthDay, 1, 28, 1), 28); // always valid in any month
    let next  = new Date(Date.UTC(Y, M, day, hour, minute, 0, 0));
    if (next <= now) next = new Date(Date.UTC(Y, M + 1, day, hour, minute, 0, 0));
    return next;
  }

  // Unknown frequency — default to 24 h from now
  return new Date(now.getTime() + 24 * 3_600_000);
}

/** Coerce a stored field to an integer in range, falling back to `dflt`. */
function clampInt(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return dflt;
  return n;
}

/**
 * Merge a schedule's own recipients over the account's mail settings.
 *
 * The SMTP connection stays on the account — one mail server it authenticates
 * to — and only the addressing is per schedule, so changing who receives a
 * report never means re-entering a password.
 *
 * NULL means "inherit"; it is not the same as an empty list, which would be a
 * schedule addressed to nobody. Only a non-null override replaces the account
 * value, which is why an untouched schedule keeps delivering exactly where it
 * always did.
 */
function applyScheduleRecipients(account, schedule) {
  if (!account) return account;
  if (!schedule) return account;
  const to = schedule.toAddrs && schedule.toAddrs.length ? schedule.toAddrs : account.to;
  // CC is taken from the schedule whenever it overrode To as well: a schedule
  // that names its own recipients but inherits the account's CC list would copy
  // people who have nothing to do with it.
  const cc = schedule.toAddrs && schedule.toAddrs.length
    ? (schedule.ccAddrs || [])
    : account.cc;
  return {
    ...account,
    to,
    cc,
    subject: schedule.subject || account.subject,
  };
}

/**
 * What next_run_at should be once this run finishes.
 *
 * A run the user asked for by hand must not move the timetable: pressing Send
 * now on a Monday-09:00 schedule sends a report now and leaves Monday 09:00
 * alone. Recomputing would silently push it a week whenever somebody tested it.
 * A paused schedule keeps its NULL either way.
 */
function nextRunAfter(schedule, manual) {
  if (manual) return schedule.nextRunAt || null;
  return calcNextRun(schedule);
}

// ── One scheduled run ─────────────────────────────────────────────────────────
/**
 * Build and email one user's scheduled report.
 *
 * Everything is scoped to that user: their DT connection, their project
 * selection, their mail settings. The workbook is built in memory and emailed;
 * scheduled reports are never written to disk (CLAUDE.md §6.8).
 */
async function runScheduledJob(schedule, { manual = false } = {}) {
  const userId     = schedule.userId;
  const scheduleId = schedule.id;
  const runId      = await schedulesDb.startRun(userId, scheduleId);
  let fileSize     = null;

  try {
    const conn = await dtConnections.getResolved(userId);
    if (!conn || !conn.isConfigured) {
      throw new Error('No DependencyTrack connection is configured for this account.');
    }

    const selected = await schedulesDb.getProjects(userId, scheduleId);
    if (selected.length === 0) throw new Error('No projects are selected for this schedule.');

    // Resolve stored UUIDs against live DT data — a project may have been
    // removed since the schedule was created.
    const wanted = new Set(selected.map(p => p.uuid));
    const projects = [];
    let page = 1;
    while (true) {
      const { json } = await dtGetWithRetry(
        `/api/v1/project?pageSize=500&pageNumber=${page}&onlyRoot=false`, conn.apiUrl, conn.apiKey
      );
      const batch = Array.isArray(json) ? json : [];
      for (const p of batch) {
        if (wanted.has(p.uuid)) projects.push({ uuid: p.uuid, name: p.name, version: p.version || '' });
      }
      if (batch.length < 500) break;
      page++;
    }
    if (projects.length === 0) {
      throw new Error('None of the selected projects were found in DependencyTrack.');
    }
    log('info', 'Scheduled report starting', {
      userId, scheduleId, selected: selected.length, resolved: projects.length,
    });

    const riskTypes  = (schedule.riskTypes && schedule.riskTypes.length)
      ? schedule.riskTypes : ['security', 'license', 'operational'];
    const cancelFlag = { cancelled: false };

    const reportData = await collectReportData(
      conn.apiUrl, conn.apiKey, projects, riskTypes, cancelFlag
    );
    const appTitle = await branding.getTitle();
    const buffer = await buildExcelReport(null, { riskTypes, appTitle, ...reportData });
    fileSize = buffer.length;

    const account = await mailSettings.getResolved(userId);
    const mail = applyScheduleRecipients(account, schedule);
    if (mail && mail.enabled) {
      // The same naming rule manual reports use. A schedule with a name sends
      // it verbatim on every run; without one it keeps the timestamped form.
      const filename = reports.reportFilename(schedule.reportName, 'scheduled_report');
      await sendEmail(mail, { filename, content: buffer }, { appTitle });
      log('info', 'Scheduled report emailed', {
        userId, scheduleId, bytes: buffer.length,
        // Recipient counts, never addresses — a log line is not the place for
        // somebody's mailing list (CLAUDE.md §6.5).
        recipients: mail.to.length, ccRecipients: mail.cc.length,
        addressing: schedule.toAddrs ? 'schedule' : 'account',
      });
    } else {
      log('warn', 'Scheduled report built but email is disabled — nothing was sent',
        { userId, scheduleId });
    }

    await schedulesDb.completeRun(runId, { status: 'success', fileSizeBytes: fileSize });
    await schedulesDb.finishRun(scheduleId, {
      status: 'success', nextRunAt: nextRunAfter(schedule, manual),
    });
    return { ok: true };

  } catch (err) {
    log('error', `Scheduled report failed: ${err.message}`, { userId, scheduleId });
    await schedulesDb.completeRun(runId, { status: 'failed', error: err.message, fileSizeBytes: fileSize });
    await schedulesDb.finishRun(scheduleId, {
      status: 'failed', error: err.message, nextRunAt: nextRunAfter(schedule, manual),
    });

    // Best-effort alert to the From address, so a failure is noticed without
    // opening the dashboard. Never let this throw into the poller.
    try {
      const mail = await mailSettings.getResolved(userId);
      if (mail && mail.enabled && mail.from && mail.smtp.host) {
        // Read here rather than reused from the try block: this path is also
        // reached when the failure happened before the title was fetched.
        const alertTitle = await branding.getTitle().catch(() => branding.DEFAULT_TITLE);
        await sendEmail(mail, null, {
          to: [mail.from], cc: [],
          appTitle: alertTitle,
          subject: `${alertTitle} — scheduled report failed`,
          body: `The scheduled report failed on ${new Date().toLocaleString()}.\n\n`
              + `Error: ${err.message}\n\nCheck the dashboard for details.`,
        });
      }
    } catch (alertErr) {
      log('error', `Failure alert email could not be sent: ${alertErr.message}`,
        { userId, scheduleId });
    }
    return { ok: false, error: err.message };
  }
}

// ── Poller ────────────────────────────────────────────────────────────────────
// P20: a continuous worker pool, not a batch per tick.
//
// The tick used to claim up to N due schedules and then `await Promise.all` on
// all of them before it could claim anything else. One slow report therefore
// idled every other slot: with five claimed, four finishing in two minutes and
// one taking thirty, the service ran at a fifth of its capacity for
// twenty-eight minutes while work sat queued behind it. That is head-of-line
// blocking, and it cost more throughput than the concurrency number did.
//
// Now the tick only *fills* free slots and returns. Each job releases its own
// slot when it settles and immediately pulls the next piece of work, so a fast
// job never waits on a slow neighbour and a freed slot is reused in
// milliseconds rather than at the next minute boundary.
//
// `_running` and `_claiming` are process-global mutable state, which §7.5
// normally forbids — but they describe THIS PROCESS's capacity, not any
// principal's data. The per-user guarantee still lives in the database, in
// claimOne's NOT EXISTS clause, which is what keeps it correct across a restart
// and across replicas.

/**
 * Claim and start work until the pool is full or nothing is due.
 *
 * Jobs are deliberately NOT awaited here: awaiting them is precisely what
 * caused the blocking this replaces. Each one re-enters through its own
 * `finally`, so the pool refills itself.
 *
 * @returns {Promise<number>} how many jobs this call started
 */
async function fill() {
  // Two claim loops must not run at once or they would over-claim past the
  // ceiling. A caller that arrives while one is in progress asks it to go round
  // again rather than giving up, so a slot freed mid-loop is not stranded.
  if (_claiming) { _refillWanted = true; return 0; }
  _claiming = true;
  let started = 0;
  try {
    do {
      _refillWanted = false;
      while (_running < maxConcurrent()) {
        const row = await schedulesDb.claimOne();
        if (!row) break;                       // nothing due, or every account busy
        _running++;
        started++;
        log('info', 'Scheduled report claimed', {
          userId: row.userId, scheduleId: row.id, running: _running,
        });
        // runScheduledJob owns its own error handling and always releases the
        // database claim; the catch here is the last resort that keeps a thrown
        // error from becoming an unhandled rejection (CLAUDE.md §11.1).
        runScheduledJob(row)
          .catch(err => log('error', `Scheduled report crashed: ${err.message}`,
            { userId: row.userId, scheduleId: row.id }))
          .finally(() => {
            _running--;
            // A slot just freed. Take the next piece of work now instead of
            // waiting up to a minute for the next tick — this is the whole
            // point of the change.
            fill().catch(err => log('error', `Scheduler refill failed: ${err.message}`));
          });
      }
    } while (_refillWanted);
  } finally {
    _claiming = false;
  }
  return started;
}

/**
 * One tick: top the pool up.
 *
 * Returns as soon as the free slots are filled, so a long-running report cannot
 * delay the next claim. Exported so tests can drive a tick directly instead of
 * waiting a minute.
 */
async function tick() {
  try {
    const started = await fill();
    return { started, running: _running };
  } catch (err) {
    log('error', `Scheduler tick failed: ${err.message}`);
    return { error: err.message, running: _running };
  }
}

/** Start the poller. Called once from the boot sequence. */
async function start() {
  // A crash mid-run would otherwise leave running_since set forever, wedging
  // that user's schedule permanently.
  const released = await schedulesDb.releaseStaleClaims(STALE_CLAIM_MINS);
  if (released) log('info', `Released ${released} stale schedule claim(s) from a previous run`);

  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => { tick(); }, POLL_INTERVAL_MS);
  if (_pollTimer.unref) _pollTimer.unref();
  log('info', 'Scheduler poller started', {
    intervalSeconds: POLL_INTERVAL_MS / 1000, maxConcurrent: maxConcurrent(),
  });
}

/**
 * Stop the poller. Called from the SIGTERM handler.
 *
 * In-flight jobs are not awaited: a report can take half an hour and a shutdown
 * cannot wait that long. Their database claims are recovered by
 * releaseStaleClaims() at the next boot, which is the same mechanism that
 * handles a crash — so an abandoned run is a case the service already has an
 * answer for rather than a new one this introduces.
 */
function stop() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

/** True while any scheduled report is building in this process. */
function isRunning() { return _running > 0; }

/** How many are building right now — for tests and for the boot log. */
function runningCount() { return _running; }

module.exports = {
  configure, maxConcurrent,
  calcNextRun, nextRunAfter, applyScheduleRecipients, runScheduledJob,
  fill, tick, start, stop, isRunning, runningCount,
  POLL_INTERVAL_MS, STALE_CLAIM_MINS, FALLBACK_CONCURRENCY,
};
