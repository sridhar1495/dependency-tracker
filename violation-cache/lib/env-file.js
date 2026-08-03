// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── .env helpers (Q7, Q8) ─────────────────────────────────────────────────────
// The bind-mounted .env file currently carries the shared DT connection. Phase 4
// moves that per-user into the database and these helpers are retired with it.

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
 * Write key=value updates into a .env file, preserving all other lines.
 * Q7: normalises CRLF before splitting.
 * Q8: throws typed errors for read and write failures so callers can log them separately.
 */
function patchEnvFile(filePath, updates) {
  // Q8: separate read error
  let content;
  try {
    content = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n') // Q7
      : '';
  } catch (e) {
    throw Object.assign(
      new Error(`Failed to read ${filePath}: ${e.message}`),
      { code: 'PATCH_READ_FAILED', cause: e }
    );
  }

  const remaining = new Set(Object.keys(updates));
  const lines = content.split('\n').map(line => {
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) return line;
    const key = line.slice(0, eqIdx).trim();
    if (key in updates) {
      remaining.delete(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  // Append any keys that were not already in the file
  for (const key of remaining) lines.push(`${key}=${updates[key]}`);

  // Q8: separate write error
  try {
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  } catch (e) {
    throw Object.assign(
      new Error(`Failed to write ${filePath}: ${e.message}`),
      { code: 'PATCH_WRITE_FAILED', cause: e }
    );
  }
}

/**
 * Read the effective DT_API_URL and DT_API_KEY.
 * Priority: .env file (if mounted and readable) > values captured at startup.
 * Called before every job so changes written via /config are picked up immediately.
 *
 * @param {string} envFile
 * @param {string} startupApiUrl
 * @param {string} startupApiKey
 */
function getEffectiveConfig(envFile, startupApiUrl, startupApiKey) {
  const envVars = parseEnvFile(envFile);
  const apiUrl  = (envVars['DT_API_INTERNAL_URL'] || startupApiUrl || '').replace(/\/$/, '');
  const apiKey  = (envVars['DT_API_KEY'] || startupApiKey || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  return { apiUrl, apiKey };
}

module.exports = { parseEnvFile, patchEnvFile, getEffectiveConfig };
