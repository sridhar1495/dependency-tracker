// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── The installation-wide default SMTP server (migration 018) ────────────────
// One administrator-owned mail server every account with no SMTP host of its
// own can fall back to. lib/mail-settings.js is what actually resolves the
// fallback for a given account; this module owns the row itself — reading,
// saving and clearing it — the same split app-settings.js/user-settings.js
// already draw between the installation's own configuration and a per-user one.
//
// The password is AES-256-GCM encrypted at rest, exactly like a user's own
// (CLAUDE.md §7.7): a per-record nonce and auth tag stored alongside it, never
// returned in any response, and the same '••••••••' placeholder convention so
// re-saving the form without retyping the password leaves it untouched.

const { query } = require('../db/pool');
const { log } = require('./log');
const { encryptSecret, decryptSecret } = require('./crypto');

/** The literal the frontend sends when the administrator did not retype it. */
const PASSWORD_PLACEHOLDER = '••••••••';

let _key = null;
function configure(encryptionKey) { _key = encryptionKey; }
function key() {
  if (!_key) throw new Error('default-mail-settings has not been configured — call configure() during boot');
  return _key;
}

/** The administration screen's view: password masked, never disclosed. */
async function getForAdmin() {
  const { rows } = await query(
    `SELECT enabled, smtp_host AS "smtpHost", smtp_port AS "smtpPort",
            smtp_secure AS "smtpSecure", smtp_user AS "smtpUser", from_addr AS "fromAddr",
            (smtp_pass_ciphertext IS NOT NULL) AS "hasPassword", updated_at AS "updatedAt"
       FROM default_mail_settings WHERE id = TRUE`
  );
  const row = rows[0];
  if (!row) return null;
  return {
    enabled: row.enabled,
    smtp: {
      host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure,
      user: row.smtpUser, pass: row.hasPassword ? PASSWORD_PLACEHOLDER : '',
    },
    from: row.fromAddr,
    updatedAt: row.updatedAt,
  };
}

/**
 * The row with its password decrypted, for lib/mail-settings.js's fallback.
 * Server-side only — never handed to a route response.
 *
 * A decryption failure disables the fallback rather than breaking every
 * account that relies on it: the accounts affected are told to re-enter their
 * own SMTP details, the same degradation an account's own unreadable password
 * already gets (CLAUDE.md §7.7).
 */
async function getResolved() {
  const { rows } = await query(
    `SELECT enabled, smtp_host AS "smtpHost", smtp_port AS "smtpPort",
            smtp_secure AS "smtpSecure", smtp_user AS "smtpUser", from_addr AS "fromAddr",
            smtp_pass_ciphertext AS ct, smtp_pass_nonce AS nonce, smtp_pass_tag AS tag
       FROM default_mail_settings WHERE id = TRUE`
  );
  const row = rows[0];
  if (!row || !row.enabled || !row.smtpHost) return null;

  let pass = '';
  if (row.ct && row.nonce && row.tag) {
    try {
      pass = decryptSecret({ ciphertext: row.ct, nonce: row.nonce, tag: row.tag }, key());
    } catch (_) {
      log('error', 'The installation default SMTP password could not be decrypted');
      return null;
    }
  }

  return {
    smtp: { host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure, user: row.smtpUser, pass },
    from: row.fromAddr,
  };
}

/**
 * Save the default. The password is written only when a real one is supplied —
 * the placeholder, an empty string or an omitted field all leave it untouched,
 * the identical rule lib/mail-settings.js's save() follows.
 */
async function save(input) {
  const smtp = input.smtp || {};
  const suppliedPass = typeof smtp.pass === 'string' ? smtp.pass : '';
  const writePassword = suppliedPass !== '' && suppliedPass !== PASSWORD_PLACEHOLDER;

  const port = Number(smtp.port);
  if (smtp.port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw Object.assign(new Error('SMTP port must be between 1 and 65535.'),
      { code: 'VALIDATION_FAILED', field: 'smtpPort' });
  }

  const params = [
    Boolean(input.enabled),
    String(smtp.host || '').trim(),
    Number.isInteger(port) ? port : 587,
    Boolean(smtp.secure),
    String(smtp.user || '').trim(),
    String(input.from || '').trim(),
  ];

  if (writePassword) {
    const sealed = encryptSecret(suppliedPass, key());
    params.push(sealed.ciphertext, sealed.nonce, sealed.tag);
    await query(
      `INSERT INTO default_mail_settings
              (id, enabled, smtp_host, smtp_port, smtp_secure, smtp_user, from_addr,
               smtp_pass_ciphertext, smtp_pass_nonce, smtp_pass_tag)
       VALUES (TRUE, $1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE
              SET enabled = EXCLUDED.enabled, smtp_host = EXCLUDED.smtp_host,
                  smtp_port = EXCLUDED.smtp_port, smtp_secure = EXCLUDED.smtp_secure,
                  smtp_user = EXCLUDED.smtp_user, from_addr = EXCLUDED.from_addr,
                  smtp_pass_ciphertext = EXCLUDED.smtp_pass_ciphertext,
                  smtp_pass_nonce = EXCLUDED.smtp_pass_nonce, smtp_pass_tag = EXCLUDED.smtp_pass_tag`,
      params
    );
  } else {
    await query(
      `INSERT INTO default_mail_settings (id, enabled, smtp_host, smtp_port, smtp_secure, smtp_user, from_addr)
       VALUES (TRUE, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
              SET enabled = EXCLUDED.enabled, smtp_host = EXCLUDED.smtp_host,
                  smtp_port = EXCLUDED.smtp_port, smtp_secure = EXCLUDED.smtp_secure,
                  smtp_user = EXCLUDED.smtp_user, from_addr = EXCLUDED.from_addr`,
      params
    );
  }

  log('info', 'Default mail settings saved', { enabled: Boolean(input.enabled), passwordChanged: writePassword });
  return getForAdmin();
}

/** Remove the default. Every account falls back to needing its own SMTP server. */
async function clear() {
  await query('DELETE FROM default_mail_settings WHERE id = TRUE');
  log('info', 'Default mail settings cleared');
}

module.exports = { configure, getForAdmin, getResolved, save, clear, PASSWORD_PLACEHOLDER };
