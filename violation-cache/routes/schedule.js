// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Scheduled-report endpoints ────────────────────────────────────────────────
//   GET    /violation-cache/schedules                  list this user's schedules
//   POST   /violation-cache/schedules                  create one (quota enforced)
//   PUT    /violation-cache/schedules/:id              edit the definition
//   DELETE /violation-cache/schedules/:id              cancel one
//   DELETE /violation-cache/schedules                  cancel every one of them
//   POST   /violation-cache/schedules/:id/arm          arm it
//   POST   /violation-cache/schedules/:id/disable      stop it, keep the definition
//   POST   /violation-cache/schedules/:id/ack-notification  clear a displayed failure
//
// Arming writes next_run_at; the poller does the rest. There is no per-user
// timer anywhere in the process (CLAUDE.md §6.8).
//
// Every route resolves the schedule through schedulesDb, which scopes by
// user_id as well as id. Another user's schedule is therefore not found rather
// than forbidden (CLAUDE.md §7.5) — a 403 would confirm it exists.

const { log } = require('../lib/log');
const { jsonReply, requireUser, readBody } = require('../lib/http-util');
const schedulesDb  = require('../lib/schedules');
const scheduler    = require('../lib/scheduler');
const userSettings = require('../lib/user-settings');

const PREFIX = '/violation-cache/schedules';

/** The shape the dashboard renders. Never includes anything but this user's. */
function forClient(row, projects) {
  return {
    id:                  row.id,
    name:                row.name || '',
    enabled:             row.enabled,
    frequency:           row.frequency,
    // UTC, both ways. The dashboard converts to and from the browser's zone.
    hour:                row.hour,
    minute:              row.minute ?? 0,
    weekDays:            row.weekDays || [],
    monthDay:            row.monthDay,
    riskTypes:           row.riskTypes || [],
    reportName:          row.reportName || '',
    nextRun:             row.nextRunAt,
    lastRun:             row.lastRunAt,
    lastRunStatus:       row.lastRunStatus,
    lastRunError:        row.lastRunError,
    failureNotification: row.failureNotification,
    // Per-schedule, from running_since — not a process variable, so it stays
    // correct across a restart and for every schedule independently.
    isRunning:           Boolean(row.runningSince),
    projectCount:        row.projectCount ?? (projects ? projects.length : 0),
    projectUuids:        projects ? projects.map(p => p.uuid) : undefined,
  };
}

/** 404 for a schedule that is missing OR somebody else's — deliberately alike. */
function notFound(res) {
  jsonReply(res, 404, { error: 'Schedule not found.', code: 'NOT_FOUND' });
}

function validationReply(res, err) {
  jsonReply(res, 400, { error: err.message, code: 'VALIDATION_FAILED', field: err.field });
}

/** `/violation-cache/schedules/<id>[/<action>]` → { id, action } */
function parseTarget(parsedPath) {
  if (!parsedPath.startsWith(`${PREFIX}/`)) return null;
  const rest = parsedPath.slice(PREFIX.length + 1);
  if (!rest) return null;
  const [id, action, ...extra] = rest.split('/');
  if (extra.length) return null;
  return { id, action: action || null };
}

async function handle({ method, path: parsedPath, req, res, principal }) {
  const target = parseTarget(parsedPath);
  const isCollection = parsedPath === PREFIX;
  if (!target && !isCollection) return false;

  const userId = requireUser(principal, res);
  if (!userId) return true;

  // ── GET /violation-cache/schedules ──────────────────────────────────────
  if (method === 'GET' && isCollection) {
    try {
      const [rows, maxSchedules] = await Promise.all([
        schedulesDb.list(userId),
        userSettings.getMaxSchedules(userId),
      ]);
      jsonReply(res, 200, {
        schedules: rows.map(r => forClient(r)),
        maxSchedules,
        count: rows.length,
      });
    } catch (err) {
      log('error', `Listing schedules failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not load your schedules.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /violation-cache/schedules ─────────────────────────────────────
  if (method === 'POST' && isCollection) {
    try {
      // 256 KB, matching the config route: a schedule's project selection can
      // be several hundred UUIDs and the default 64 KB would refuse a large
      // portfolio (CLAUDE.md §12).
      const body = JSON.parse(await readBody(req, 256 * 1024) || '{}');

      // The quota is this account's own, never a global counter (§7.5). It is
      // checked here rather than in the data layer so the check and the message
      // the user reads stay in one place.
      const [count, maxSchedules] = await Promise.all([
        schedulesDb.countForUser(userId),
        userSettings.getMaxSchedules(userId),
      ]);
      if (count >= maxSchedules) {
        jsonReply(res, 429, {
          error: `Schedule limit reached (${count} / ${maxSchedules}). Cancel one, or ask your `
               + 'administrator to raise the limit.',
          code: 'QUOTA_REACHED', count, maxSchedules,
        });
        return true;
      }

      const created = await schedulesDb.create(userId, body);
      if (Array.isArray(body.projects)) {
        await schedulesDb.setProjects(userId, created.id, body.projects);
      }
      const fresh = await schedulesDb.get(userId, created.id);
      log('info', 'Schedule created', { userId, scheduleId: created.id });
      jsonReply(res, 201, { schedule: forClient(fresh) });
    } catch (err) {
      if (err.code === 'VALIDATION_FAILED') { validationReply(res, err); return true; }
      log('error', `Creating a schedule failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not create the schedule.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── DELETE /violation-cache/schedules ───────────────────────────────────
  // Cancel everything at once. Scoped by user_id, so it can only ever reach
  // this account's rows.
  if (method === 'DELETE' && isCollection) {
    try {
      const removed = await schedulesDb.removeAll(userId);
      log('info', 'All schedules cancelled', { userId, removed });
      jsonReply(res, 200, { ok: true, removed });
    } catch (err) {
      log('error', `Cancelling all schedules failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not cancel your schedules.', code: 'INTERNAL' });
    }
    return true;
  }

  if (!target) return false;
  const { id, action } = target;

  // ── GET /violation-cache/schedules/:id ──────────────────────────────────
  if (method === 'GET' && !action) {
    try {
      const row = await schedulesDb.get(userId, id);
      if (!row) { notFound(res); return true; }
      const projects = await schedulesDb.getProjects(userId, id);
      jsonReply(res, 200, { schedule: forClient(row, projects) });
    } catch (err) {
      log('error', `Reading a schedule failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not load the schedule.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── PUT /violation-cache/schedules/:id ──────────────────────────────────
  if (method === 'PUT' && !action) {
    try {
      const body = JSON.parse(await readBody(req, 256 * 1024) || '{}');
      const updated = await schedulesDb.update(userId, id, body);
      if (!updated) { notFound(res); return true; }
      if (Array.isArray(body.projects)) {
        await schedulesDb.setProjects(userId, id, body.projects);
      }
      const fresh = await schedulesDb.get(userId, id);
      jsonReply(res, 200, { schedule: forClient(fresh) });
    } catch (err) {
      if (err.code === 'VALIDATION_FAILED') { validationReply(res, err); return true; }
      log('error', `Saving a schedule failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not save the schedule.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── DELETE /violation-cache/schedules/:id ───────────────────────────────
  if (method === 'DELETE' && !action) {
    try {
      const gone = await schedulesDb.remove(userId, id);
      if (!gone) { notFound(res); return true; }
      log('info', 'Schedule cancelled', { userId, scheduleId: id });
      jsonReply(res, 200, { ok: true });
    } catch (err) {
      log('error', `Cancelling a schedule failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not cancel the schedule.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /violation-cache/schedules/:id/arm ─────────────────────────────
  if (method === 'POST' && action === 'arm') {
    try {
      const row = await schedulesDb.get(userId, id);
      if (!row) { notFound(res); return true; }
      if (!row.projectCount) {
        jsonReply(res, 400, {
          error: 'No projects are selected — choose them before starting this schedule.',
          code: 'NO_PROJECTS',
        });
        return true;
      }
      const updated = await schedulesDb.arm(userId, id, scheduler.calcNextRun(row));
      log('info', 'Schedule armed', { userId, scheduleId: id, nextRun: updated.nextRunAt });
      jsonReply(res, 200, { ok: true, nextRun: updated.nextRunAt, schedule: forClient(updated) });
    } catch (err) {
      log('error', `Arming the schedule failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not arm the schedule.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /violation-cache/schedules/:id/disable ─────────────────────────
  if (method === 'POST' && action === 'disable') {
    try {
      const updated = await schedulesDb.disable(userId, id);
      if (!updated) { notFound(res); return true; }
      log('info', 'Schedule disabled', { userId, scheduleId: id });
      jsonReply(res, 200, { ok: true, schedule: forClient(updated) });
    } catch (err) {
      log('error', `Disabling the schedule failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not stop the schedule.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /violation-cache/schedules/:id/ack-notification ────────────────
  if (method === 'POST' && action === 'ack-notification') {
    try {
      const cleared = await schedulesDb.ackNotification(userId, id);
      if (!cleared) { notFound(res); return true; }
      jsonReply(res, 200, { ok: true });
    } catch (err) {
      log('error', `Acknowledging the schedule notice failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not clear the notice.', code: 'INTERNAL' });
    }
    return true;
  }

  return false;
}

module.exports = { handle, forClient, PREFIX };
