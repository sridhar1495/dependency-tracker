// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── .env reader (Q7) ──────────────────────────────────────────────────────────
// Read-only. The DependencyTrack connection is per-user and lives encrypted in
// the database (CLAUDE.md §5.6), so nothing writes to .env any more — the patch
// helper that used to live here went with the single-tenant config endpoint.
//
// The one remaining caller is the boot-time legacy migration, which reads a
// pre-multi-user .env once to seed existing accounts.

const fs = require('fs');

/** Parse a .env file and return a plain key→value object. */
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  // Q7: normalise Windows CRLF so keys/values don't carry a trailing \r
  for (const line of fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

/**
 * Read the DependencyTrack connection a single-tenant deployment was using.
 *
 * Values in the bind-mounted .env win over the ones captured from the process
 * environment at startup, because the retired config endpoint used to write
 * them there.
 *
 * @param {string} envFile
 * @param {{apiUrl: string, apiKey: string, frontendUrl: string}} fallback
 * @returns {{apiUrl: string, apiKey: string, frontendUrl: string}}
 */
function readLegacyConnection(envFile, fallback = {}) {
  const envVars = parseEnvFile(envFile);
  return {
    apiUrl: (envVars['DT_API_INTERNAL_URL'] || fallback.apiUrl || '').replace(/\/$/, ''),
    apiKey: (envVars['DT_API_KEY'] || fallback.apiKey || '').replace(/[\x00-\x1F\x7F]/g, '').trim(),
    frontendUrl: (envVars['DT_FRONTEND_URL'] || fallback.frontendUrl || '').replace(/\/$/, ''),
  };
}

module.exports = { parseEnvFile, readLegacyConnection };
