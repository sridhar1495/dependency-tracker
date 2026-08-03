// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Scheduled report timing and execution.
//
// calcNextRun is a pure function and the single source of truth for timing
// (CLAUDE.md §6.8). Phase 5 replaces the single setTimeout with one poller that
// claims due rows using FOR UPDATE SKIP LOCKED.

const fs   = require('fs');
const path = require('path');
const { log } = require('./log');
const { dtGetWithRetry } = require('./dt-fetch');
const { buildExcelReport } = require('./excel');
const { sendEmail } = require('./mail');
const { collectReportData } = require('./reports');
const { loadConfig, saveConfig } = require('./app-config');

// Injected at boot: { schedDir, getEffectiveConfig }
let _deps = null;

function configure(d) { _deps = d; }

function deps() {
  if (!_deps) throw new Error('scheduler has not been configured — call configure() during boot');
  return _deps;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
/**
 * Calculate the next local-time Date when the job should fire.
 * Uses server's local timezone (no external timezone library needed).
 *
 * @param {object} schedule — config.schedule
 * @returns {Date}
 */
function calcNextRun(schedule) {
  const now = new Date();

  if (schedule.frequency === 'daily') {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), schedule.hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  if (schedule.frequency === 'weekly') {
    const targetDays = (schedule.weekDays || [1]).sort((a, b) => a - b);
    // Scan the next 8 days to find the first matching weekday that is in the future
    for (let d = 1; d <= 8; d++) {
      const candidate = new Date(
        now.getFullYear(), now.getMonth(), now.getDate() + d, schedule.hour, 0, 0, 0
      );
      if (targetDays.includes(candidate.getDay())) return candidate;
    }
    // Fallback (shouldn't happen with valid config)
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, schedule.hour, 0, 0, 0);
  }

  if (schedule.frequency === 'monthly') {
    const day  = Math.min(schedule.monthDay || 1, 28); // cap at 28 — always valid in any month
    let next   = new Date(now.getFullYear(), now.getMonth(), day, schedule.hour, 0, 0, 0);
    if (next <= now) next = new Date(now.getFullYear(), now.getMonth() + 1, day, schedule.hour, 0, 0, 0);
    return next;
  }

  // Unknown frequency — default to 24 h from now
  return new Date(now.getTime() + 24 * 3_600_000);
}

let _schedulerTimer   = null;
let _schedulerRunning = false;

/** Arm (or re-arm) the scheduler based on the current app config. */
function armScheduler() {
  if (_schedulerTimer) { clearTimeout(_schedulerTimer); _schedulerTimer = null; }

  const cfg = loadConfig();
  if (!cfg.schedule.enabled) {
    log('info', 'Scheduler disabled — not arming');
    return;
  }

  const next    = calcNextRun(cfg.schedule);
  const msUntil = Math.max(next.getTime() - Date.now(), 1000); // minimum 1 s to avoid tight loops

  cfg.schedule.nextRun = next.toISOString();
  saveConfig(cfg);

  log('info', 'Scheduler armed', { nextRun: next.toISOString(), msUntil });
  _schedulerTimer = setTimeout(async () => {
    _schedulerTimer = null;
    await runScheduledJob();
    armScheduler(); // re-arm for the next occurrence after each firing
  }, msUntil);
}

async function runScheduledJob() {
  if (_schedulerRunning) {
    log('warn', 'Scheduled job already running — skipping this occurrence (overlap protection)');
    return;
  }

  _schedulerRunning = true;
  const cfg = loadConfig();
  log('info', 'Scheduled report job starting', { projectCount: cfg.schedule.projectUuids.length });

  let reportFilePath = null;
  let reportFileName = null;

  try {
    const { apiUrl, apiKey } = deps().getEffectiveConfig();
    if (!apiKey) throw new Error('DT_API_KEY is not configured');
    if (!cfg.schedule.projectUuids.length) throw new Error('No project UUIDs stored in schedule config');

    // Resolve stored UUIDs against live DT project list — skip UUIDs that no longer exist
    const storedSet = new Set(cfg.schedule.projectUuids);
    const projects  = [];
    let page = 1;
    while (true) {
      const { json } = await dtGetWithRetry(
        `/api/v1/project?pageSize=500&pageNumber=${page}&onlyRoot=false`, apiUrl, apiKey
      );
      const batch = Array.isArray(json) ? json : [];
      for (const p of batch) {
        if (storedSet.has(p.uuid)) {
          projects.push({ uuid: p.uuid, name: p.name, version: p.version || '' });
        }
      }
      if (batch.length < 500) break;
      page++;
    }
    if (projects.length === 0) throw new Error('None of the stored project UUIDs matched live DT data');
    log('info', `Scheduled job: ${projects.length}/${storedSet.size} UUIDs resolved`);

    fs.mkdirSync(deps().schedDir, { recursive: true });
    const ts      = new Date().toISOString().replace(/[:.]/g, '-');
    reportFileName = `scheduled_report_${ts}.xlsx`;
    reportFilePath = path.join(deps().schedDir, reportFileName);

    const riskTypes  = cfg.schedule.riskTypes || ['security', 'license', 'operational'];
    const cancelFlag = { cancelled: false };

    const reportData = await collectReportData(
      apiUrl, apiKey, projects, riskTypes, cancelFlag,
      (rt) => log('info', `Scheduled job progress: ${rt} project done`)
    );

    await buildExcelReport(reportFilePath, { riskTypes, ...reportData });
    log('info', `Scheduled job: Excel written (${reportFileName})`);

    // Email if configured
    if (cfg.mail.enabled) {
      await sendEmail(cfg.mail, reportFilePath, reportFileName);
    }

    // Delete the file — it was emailed (or mail was intentionally disabled)
    try { fs.unlinkSync(reportFilePath); } catch (_) {}
    reportFilePath = null;

    const newCfg = loadConfig();
    newCfg.schedule.lastRun             = new Date().toISOString();
    newCfg.schedule.lastRunStatus       = 'success';
    newCfg.schedule.lastRunError        = null;
    newCfg.schedule.failureNotification = null;
    saveConfig(newCfg);
    log('info', 'Scheduled job completed successfully');

  } catch (err) {
    log('error', `Scheduled job failed: ${err.message}`);
    if (reportFilePath) { try { fs.unlinkSync(reportFilePath); } catch (_) {} }

    const newCfg = loadConfig();
    newCfg.schedule.lastRun             = new Date().toISOString();
    newCfg.schedule.lastRunStatus       = 'failed';
    newCfg.schedule.lastRunError        = err.message;
    // O3: notification persists until the browser ACKs it (POST /violation-cache/schedule/ack-notification)
    newCfg.schedule.failureNotification = `Scheduled report failed on ${new Date().toLocaleString()}: ${err.message}`;
    saveConfig(newCfg);

    // Send failure alert to the From address so someone is notified even without opening the UI
    try {
      const freshCfg = loadConfig();
      if (freshCfg.mail.enabled && freshCfg.mail.from && freshCfg.mail.smtp.host) {
        await sendEmail(freshCfg.mail, null, null, {
          to:      [freshCfg.mail.from],
          cc:      [],
          subject: 'Dependency-Track Scheduled Report Failed',
          body:    `The scheduled Dependency-Track report failed on ${new Date().toLocaleString()}.\n\nError: ${err.message}\n\nPlease check the server logs for details.`,
        });
      }
    } catch (emailErr) {
      log('error', `Failed to send failure alert email: ${emailErr.message}`);
    }
  } finally {
    _schedulerRunning = false;
  }
}

/** True when a timer is currently armed. Used to decide whether a config save re-arms. */
function isArmed() { return _schedulerTimer !== null; }

/** True while a scheduled job is executing (overlap protection). */
function isRunning() { return _schedulerRunning; }

/** Clear any pending timer. Called from the SIGTERM handler. */
function stop() {
  if (_schedulerTimer) { clearTimeout(_schedulerTimer); _schedulerTimer = null; }
}

module.exports = { configure, calcNextRun, armScheduler, runScheduledJob, isArmed, isRunning, stop };
