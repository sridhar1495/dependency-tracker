// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Scheduled-report endpoints: arm, status, disable and failure acknowledgement.

const { log } = require('../lib/log');
const { jsonReply } = require('../lib/http-util');
const { loadConfig, saveConfig } = require('../lib/app-config');
const scheduler = require('../lib/scheduler');

async function handle({ method, path: parsedPath, res }) {
    // ── POST /violation-cache/schedule/arm ───────────────────────────────────
    // Explicitly arms the scheduler. Called by the "Schedule Reports" button
    // after project UUIDs are saved, so saving config alone never starts the timer.
    if (method === 'POST' && parsedPath === '/violation-cache/schedule/arm') {
      const cfg = loadConfig();
      if (!cfg.schedule.enabled) {
        jsonReply(res, 400, { error: 'Schedule is not enabled — enable it in settings first' });
        return true;
      }
      if (!cfg.schedule.projectUuids.length) {
        jsonReply(res, 400, { error: 'No project UUIDs saved — click Schedule Reports to select projects first' });
        return true;
      }
      scheduler.armScheduler();
      const updated = loadConfig();
      log('info', 'Scheduler armed via API', { nextRun: updated.schedule.nextRun });
      jsonReply(res, 200, { ok: true, nextRun: updated.schedule.nextRun });
      return true;
    }
  
    // ── GET /violation-cache/schedule/status ─────────────────────────────────
    if (method === 'GET' && parsedPath === '/violation-cache/schedule/status') {
      const cfg = loadConfig();
      jsonReply(res, 200, {
        enabled:             cfg.schedule.enabled,
        frequency:           cfg.schedule.frequency,
        nextRun:             cfg.schedule.nextRun,
        lastRun:             cfg.schedule.lastRun,
        lastRunStatus:       cfg.schedule.lastRunStatus,
        lastRunError:        cfg.schedule.lastRunError,
        failureNotification: cfg.schedule.failureNotification,
        isRunning:           scheduler.isRunning(),
        projectCount:        cfg.schedule.projectUuids.length,
      });
      return true;
    }
  
    // ── DELETE /violation-cache/schedule ─────────────────────────────────────
    // Disables the scheduled job without removing configuration.
    if (method === 'DELETE' && parsedPath === '/violation-cache/schedule') {
      const cfg = loadConfig();
      cfg.schedule.enabled = false;
      cfg.schedule.nextRun = null;
      saveConfig(cfg);
      scheduler.armScheduler(); // will immediately clear the timer because enabled=false
      log('info', 'Schedule cancelled via API');
      jsonReply(res, 200, { ok: true, message: 'Schedule disabled' });
      return true;
    }
  
    // ── POST /violation-cache/schedule/ack-notification ──────────────────────
    // Clears the failureNotification field once the browser has displayed it.
    if (method === 'POST' && parsedPath === '/violation-cache/schedule/ack-notification') {
      const cfg = loadConfig();
      cfg.schedule.failureNotification = null;
      saveConfig(cfg);
      jsonReply(res, 200, { ok: true });
      return true;
    }

  return false;
}

module.exports = { handle };
