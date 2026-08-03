// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── App config (/data/app-config.json) ────────────────────────────────────────
// User-configurable settings, stored separately from the DT connection .env.
// Loaded fresh before each operation so UI changes take effect without a restart
// and concurrent writers never persist a stale snapshot.
//
// Phase 5 moves this per-user into the database; the shape below is the
// single-tenant form that phase 0 must preserve unchanged.

const fs = require('fs');
const { log } = require('./log');

const DEFAULT_MAX_REPORTS = 10;

const DEFAULT_CONFIG = {
  maxReports: 10,
  mail: {
    enabled: false,
    smtp:    { host: '', port: 587, secure: false, user: '', pass: '' },
    from:    '',
    to:      [],
    cc:      [],
    subject: '',
    body:    '',
  },
  schedule: {
    enabled:             false,
    frequency:           'daily',  // 'daily' | 'weekly' | 'monthly'
    hour:                9,
    weekDays:            [1],      // 0=Sun..6=Sat; used for 'weekly'
    monthDay:            1,        // 1-28; used for 'monthly'
    projectUuids:        [],
    riskTypes:           ['security', 'license', 'operational'],
    lastRun:             null,     // ISO8601 — updated after each run
    lastRunStatus:       null,     // 'success' | 'failed'
    lastRunError:        null,
    nextRun:             null,     // ISO8601 — set when scheduler is armed
    failureNotification: null,     // human-readable message; cleared when frontend ACKs
  },
};

// Paths are injected at boot rather than read from process.env here, so this
// module performs no I/O and reads no environment at require time.
let _paths = null;

/** @param {{ cacheDir: string, configFile: string, configTmp: string }} paths */
function configure(paths) {
  _paths = paths;
}

function paths() {
  if (!_paths) throw new Error('app-config has not been configured — call configure() during boot');
  return _paths;
}

/**
 * Recursively merge `source` into a deep copy of `target`.
 * Arrays are replaced, not concatenated, so a saved config that predates a new
 * DEFAULT_CONFIG key still gains that key.
 */
function deepMerge(target, source) {
  const out = JSON.parse(JSON.stringify(target));
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = out[key];
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)
        && tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

/** Read app-config.json merged over DEFAULT_CONFIG. Never cache the result. */
function loadConfig() {
  const { configFile } = paths();
  try {
    if (fs.existsSync(configFile)) {
      const rawJson = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      return deepMerge(DEFAULT_CONFIG, rawJson);
    }
  } catch (e) {
    log('warn', `Could not load app config, using defaults: ${e.message}`);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/** Write app-config.json atomically (tmp file then rename). */
function saveConfig(cfg) {
  const { cacheDir, configFile, configTmp } = paths();
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(configTmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(configTmp, configFile);
  } catch (e) {
    log('error', `Failed to save app config: ${e.message}`);
  }
}

/** Dynamic max-reports limit — re-read from config so UI changes apply immediately. */
function getMaxReports() {
  const n = loadConfig().maxReports;
  return (typeof n === 'number' && n > 0) ? n : DEFAULT_MAX_REPORTS;
}

/**
 * Return a sanitised copy of config safe to send to the browser.
 * O4/S4: the SMTP password is masked; it must never appear in a response body.
 */
function sanitiseConfigForClient(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (out.mail && out.mail.smtp) {
    out.mail.smtp.pass = out.mail.smtp.pass ? '••••••••' : '';
  }
  return out;
}

module.exports = {
  configure, deepMerge, loadConfig, saveConfig, getMaxReports,
  sanitiseConfigForClient, DEFAULT_CONFIG, DEFAULT_MAX_REPORTS,
};
