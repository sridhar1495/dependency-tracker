// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Administrator principal ───────────────────────────────────────────────────
// The administrator is authenticated against /data/admin-credentials.json, never
// against the database (CLAUDE.md §7.4). That file is created by install.sh.
//
// S13: this module NEVER creates the file. If it is absent the service starts
// normally with administrator login disabled and says so at boot, rather than
// silently generating credentials that nobody knows.

const fs = require('fs');
const { log } = require('./log');
const { verifyPassword } = require('./crypto');

let _creds   = null;   // { loginId, passwordHash }
let _reason  = null;   // why administrator login is unavailable, if it is

/**
 * Load the credentials file. Called once during boot, after configuration and
 * before the listener starts.
 *
 * @param {string} filePath
 * @returns {{ enabled: boolean, loginId: string|null, reason: string|null }}
 */
function load(filePath) {
  _creds  = null;
  _reason = null;

  if (!fs.existsSync(filePath)) {
    _reason = `Administrator credentials file not found at ${filePath}. ` +
              'Run ./install.sh to create one.';
    log('warn', 'Administrator login is DISABLED', { reason: _reason });
    return { enabled: false, loginId: null, reason: _reason };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    _reason = `Administrator credentials file at ${filePath} is not valid JSON.`;
    log('error', 'Administrator login is DISABLED', { reason: _reason, err: e.message });
    return { enabled: false, loginId: null, reason: _reason };
  }

  if (!parsed || typeof parsed.loginId !== 'string' || typeof parsed.passwordHash !== 'string'
      || !parsed.loginId.trim() || !parsed.passwordHash.trim()) {
    _reason = `Administrator credentials file at ${filePath} is missing loginId or passwordHash.`;
    log('error', 'Administrator login is DISABLED', { reason: _reason });
    return { enabled: false, loginId: null, reason: _reason };
  }

  // The file holds a password hash and must not be world-readable.
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode & 0o077) {
      log('warn', 'Administrator credentials file is readable by other users', {
        file: filePath, mode: mode.toString(8), expected: '600',
      });
    }
  } catch (_) { /* stat failed; not worth failing boot over */ }

  _creds = { loginId: parsed.loginId.trim(), passwordHash: parsed.passwordHash.trim() };
  log('info', 'Administrator login enabled', { loginId: _creds.loginId });
  return { enabled: true, loginId: _creds.loginId, reason: null };
}

/** Is administrator login available? */
function isEnabled() { return _creds !== null; }

/** The configured administrator login ID, or null. Used to reserve it at registration. */
function loginId() { return _creds ? _creds.loginId : null; }

/** Why administrator login is unavailable, for an actionable error response. */
function disabledReason() { return _reason; }

/**
 * Verify administrator credentials.
 * Returns false for a wrong login ID as well as a wrong password, so the caller
 * cannot distinguish the two.
 *
 * @returns {Promise<boolean>}
 */
async function verify(candidateLoginId, password) {
  if (!_creds) return false;
  if (typeof candidateLoginId !== 'string') return false;
  // The administrator login ID is compared case-insensitively, matching the
  // citext behaviour of database login IDs.
  if (candidateLoginId.trim().toLowerCase() !== _creds.loginId.toLowerCase()) return false;
  return verifyPassword(password, _creds.passwordHash);
}

/** Test seam: install credentials without touching the filesystem. */
function _setForTest(creds) { _creds = creds; _reason = creds ? null : 'disabled'; }

module.exports = { load, isEnabled, loginId, disabledReason, verify, _setForTest };
