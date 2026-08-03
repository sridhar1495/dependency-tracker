// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Structured logging (O3) ───────────────────────────────────────────────────
// The single logging entry point for the whole service. Never use console.*
// directly (CLAUDE.md §6.5).
//
// Format is chosen once at boot via configure(); text by default, newline-
// delimited JSON when LOG_FORMAT=json, which suits Datadog, Loki and Grafana.
//
// S2: never pass a password, password hash, session token, token hash, SMTP
// password or full DT API key in `meta`. DT API keys are redacted to the last
// four characters by their callers.

let _json = false;

/** Set the output format. Called once from the boot sequence. */
function configure(logFormat) {
  _json = logFormat === 'json';
}

/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @param {object} [meta]  serialisable context; omitted from output when empty
 */
function log(level, message, meta = {}) {
  const ts      = new Date().toISOString();
  const hasMeta = Object.keys(meta).length > 0;

  if (_json) {
    const entry = { level, ts, msg: message };
    if (hasMeta) Object.assign(entry, meta);
    const out = JSON.stringify(entry);
    if (level === 'error') console.error(out);
    else if (level === 'warn') console.warn(out);
    else console.log(out);
    return;
  }

  const suffix = hasMeta ? ` ${JSON.stringify(meta)}` : '';
  const line   = `[cache] ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = { log, configure };
