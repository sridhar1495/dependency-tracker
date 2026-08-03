// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Scheduled-report endpoints ────────────────────────────────────────────────
//   POST   /violation-cache/schedule/arm               arm this user's schedule
//   GET    /violation-cache/schedule/status            state for the config panel
//   DELETE /violation-cache/schedule                   disable without discarding
//   POST   /violation-cache/schedule/ack-notification  clear a displayed failure
//
// Arming writes next_run_at; the poller does the rest. There is no per-user
// timer anywhere in the process (CLAUDE.md §6.8).

const { log } = require('../lib/log');
const { jsonReply, requireUser } = require('../lib/http-util');
const schedulesDb = require('../lib/schedules');
const scheduler   = require('../lib/scheduler');

async function handle({ method, path: parsedPath, res, principal }) {

  // ── POST /violation-cache/schedule/arm ──────────────────────────────────
  if (method === 'POST' && parsedPath === '/violation-cache/schedule/arm') {
    const userId = requireUser(principal, res);
    if (!userId) return true;
    try {
      const sched = await schedulesDb.get(userId);
      if (!sched || !sched.enabled) {
        jsonReply(res, 400, {
          error: 'The schedule is not enabled — enable it in Settings first.',
          code: 'SCHEDULE_DISABLED',
        });
        return true;
      }
      if (!sched.projectCount) {
        jsonReply(res, 400, {
          error: 'No projects are selected — click Schedule Reports to choose them first.',
          code: 'NO_PROJECTS',
        });
        return true;
      }
      const updated = await schedulesDb.arm(userId, scheduler.calcNextRun(sched));
      log('info', 'Schedule armed', { userId, nextRun: updated.nextRunAt });
      jsonReply(res, 200, { ok: true, nextRun: updated.nextRunAt });
    } catch (err) {
      log('error', `Arming the schedule failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not arm the schedule.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── GET /violation-cache/schedule/status ────────────────────────────────
  if (method === 'GET' && parsedPath === '/violation-cache/schedule/status') {
    const userId = requireUser(principal, res);
    if (!userId) return true;
    try {
      const sched = await schedulesDb.get(userId);
      if (!sched) { jsonReply(res, 200, { enabled: false, projectCount: 0, isRunning: false }); return true; }
      jsonReply(res, 200, {
        enabled:             sched.enabled,
        frequency:           sched.frequency,
        nextRun:             sched.nextRunAt,
        lastRun:             sched.lastRunAt,
        lastRunStatus:       sched.lastRunStatus,
        lastRunError:        sched.lastRunError,
        failureNotification: sched.failureNotification,
        // Per-user, from running_since — not a process variable, so it stays
        // correct across a restart and for every user independently.
        isRunning:           Boolean(sched.runningSince),
        projectCount:        sched.projectCount,
      });
    } catch (err) {
      log('error', `Schedule status failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not load the schedule.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── DELETE /violation-cache/schedule ────────────────────────────────────
  if (method === 'DELETE' && parsedPath === '/violation-cache/schedule') {
    const userId = requireUser(principal, res);
    if (!userId) return true;
    try {
      await schedulesDb.disable(userId);
      log('info', 'Schedule disabled', { userId });
      jsonReply(res, 200, { ok: true, message: 'Schedule disabled' });
    } catch (err) {
      log('error', `Disabling the schedule failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not disable the schedule.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /violation-cache/schedule/ack-notification ─────────────────────
  if (method === 'POST' && parsedPath === '/violation-cache/schedule/ack-notification') {
    const userId = requireUser(principal, res);
    if (!userId) return true;
    try {
      await schedulesDb.ackNotification(userId);
      jsonReply(res, 200, { ok: true });
    } catch (err) {
      log('error', `Acknowledging the schedule notice failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not clear the notice.', code: 'INTERNAL' });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
