// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Per-user SMTP configuration ───────────────────────────────────────────────
// S19: the SMTP password is AES-256-GCM encrypted at rest and is never returned
// in any response. The browser is told only whether one is set, via the same
// '••••••••' placeholder the previous single-tenant UI used — so sending that
// placeholder back means "keep the stored password" (CLAUDE.md §6.9).

const { query } = require('../db/pool');
const { log } = require('./log');
const { encryptSecret, decryptSecret } = require('./crypto');
// Module reference, not a destructured binding, so a route test can substitute
// it (CLAUDE.md §10.1) — the same reason routes/schedule.js imports scheduler.js
// this way rather than calling calcNextRun() directly.
const defaultMailSettings = require('./default-mail-settings');

/** The literal the frontend sends when the user did not retype the password. */
const PASSWORD_PLACEHOLDER = '••••••••';

const SAFE_COLUMNS = `
  user_id AS "userId", enabled, smtp_host AS "smtpHost", smtp_port AS "smtpPort",
  smtp_secure AS "smtpSecure", smtp_user AS "smtpUser",
  from_addr AS "fromAddr", to_addrs AS "toAddrs", cc_addrs AS "ccAddrs",
  subject, body,
  (smtp_pass_ciphertext IS NOT NULL) AS "hasPassword"
`;

let _key = null;
function configure(encryptionKey) { _key = encryptionKey; }
function key() {
  if (!_key) throw new Error('mail-settings has not been configured — call configure() during boot');
  return _key;
}

/**
 * Whether this account's own connection is unset, so the installation default
 * would apply — the only trigger lib/mail-settings.js's fallback recognises
 * (see the module banner: a whole-server fallback, not a per-property one).
 */
function hostIsUnset(row) {
  return !row.smtpHost;
}

/**
 * Settings as the browser may see them: password masked, never disclosed.
 *
 * `smtp`/`from` are always this account's own stored values, verbatim — even
 * when blank. They are what a bare Save resubmits, and populating them with
 * the installation default's values here would mean the very next save bakes
 * that default into this account's row as if it had been typed in, which
 * would stop it ever picking up a later change to the default (the "inherit"
 * meaning a NULL/blank already carries everywhere else in this schema).
 *
 * `usingDefault` and `defaultSmtp` are what let the frontend show a
 * placeholder for what will actually be used — the same "Account default: …"
 * pattern the schedule editor's delivery fields already use — without ever
 * writing it into the form's real value.
 */
async function getForClient(userId) {
  const { rows } = await query(`SELECT ${SAFE_COLUMNS} FROM mail_settings WHERE user_id = $1`, [userId]);
  const row = rows[0];
  if (!row) return null;

  let usingDefault = false;
  let defaultSmtp = null;

  if (row.enabled && hostIsUnset(row)) {
    const def = await defaultMailSettings.getForAdmin();
    if (def && def.enabled && def.smtp.host) {
      usingDefault = true;
      defaultSmtp = { host: def.smtp.host, port: def.smtp.port, from: def.from };
    }
  }

  return {
    enabled: row.enabled, usingDefault, defaultSmtp,
    smtp: {
      host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure,
      user: row.smtpUser, pass: row.hasPassword ? PASSWORD_PLACEHOLDER : '',
    },
    from: row.fromAddr, to: row.toAddrs || [], cc: row.ccAddrs || [],
    subject: row.subject, body: row.body,
  };
}

/**
 * Settings with the password decrypted, for sending mail. Server-side only.
 * A decryption failure disables sending rather than throwing into a job.
 */
async function getResolved(userId) {
  const { rows } = await query(
    `SELECT enabled, smtp_host AS "smtpHost", smtp_port AS "smtpPort",
            smtp_secure AS "smtpSecure", smtp_user AS "smtpUser",
            from_addr AS "fromAddr", to_addrs AS "toAddrs", cc_addrs AS "ccAddrs",
            subject, body,
            smtp_pass_ciphertext AS ct, smtp_pass_nonce AS nonce, smtp_pass_tag AS tag
       FROM mail_settings WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return null;

  let pass = '';
  if (row.ct && row.nonce && row.tag) {
    try {
      pass = decryptSecret({ ciphertext: row.ct, nonce: row.nonce, tag: row.tag }, key());
    } catch (_) {
      log('error', 'Stored SMTP password could not be decrypted', { userId });
      throw Object.assign(
        new Error('Your stored SMTP password could not be read. Please re-enter it in Settings.'),
        { code: 'SMTP_PASS_UNREADABLE' }
      );
    }
  }

  const smtp = { host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure, user: row.smtpUser, pass };
  const resolved = row.enabled ? await applyDefaultFallback(smtp, row.fromAddr) : { smtp, from: row.fromAddr };

  return {
    enabled: row.enabled,
    smtp: resolved.smtp, from: resolved.from, to: row.toAddrs || [], cc: row.ccAddrs || [],
    subject: row.subject, body: row.body,
  };
}

/**
 * Apply the installation default's connection to a candidate `{smtp, from}`
 * when `smtp.host` is blank — the same whole-server substitution getResolved()
 * performs on a stored row, exposed here for a caller building its own
 * candidate (routes/config.js's test-email, which sends what is live on
 * screen rather than what is stored) rather than reading one from the
 * database. A per-property merge is deliberately not offered: an account
 * that has typed in its own host is testing its own server, full stop,
 * however that turns out.
 */
async function applyDefaultFallback(smtp, from) {
  if (smtp.host) return { smtp, from };
  const def = await defaultMailSettings.getResolved();
  if (!def) return { smtp, from };
  return { smtp: { ...def.smtp }, from: from || def.from };
}

/** Normalise a comma-separated string or array into a clean address array. */
function toAddressArray(value) {
  if (Array.isArray(value)) return value.map(s => String(s).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/**
 * Save mail settings. The password is written only when a real one is supplied:
 * the placeholder, an empty string or an omitted field all leave it untouched.
 */
async function save(userId, input) {
  const smtp = input.smtp || {};
  const suppliedPass = typeof smtp.pass === 'string' ? smtp.pass : '';
  const writePassword = suppliedPass !== '' && suppliedPass !== PASSWORD_PLACEHOLDER;

  const port = Number(smtp.port);
  if (smtp.port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw Object.assign(new Error('SMTP port must be between 1 and 65535.'),
      { code: 'VALIDATION_FAILED', field: 'smtpPort' });
  }

  const params = [
    userId,
    Boolean(input.enabled),
    String(smtp.host || '').trim(),
    Number.isInteger(port) ? port : 587,
    Boolean(smtp.secure),
    String(smtp.user || '').trim(),
    String(input.from || '').trim(),
    toAddressArray(input.to),
    toAddressArray(input.cc),
    String(input.subject || ''),
    String(input.body || ''),
  ];

  if (writePassword) {
    const sealed = encryptSecret(suppliedPass, key());
    params.push(sealed.ciphertext, sealed.nonce, sealed.tag);
    await query(
      `UPDATE mail_settings
          SET enabled=$2, smtp_host=$3, smtp_port=$4, smtp_secure=$5, smtp_user=$6,
              from_addr=$7, to_addrs=$8, cc_addrs=$9, subject=$10, body=$11,
              smtp_pass_ciphertext=$12, smtp_pass_nonce=$13, smtp_pass_tag=$14
        WHERE user_id=$1`, params
    );
  } else {
    await query(
      `UPDATE mail_settings
          SET enabled=$2, smtp_host=$3, smtp_port=$4, smtp_secure=$5, smtp_user=$6,
              from_addr=$7, to_addrs=$8, cc_addrs=$9, subject=$10, body=$11
        WHERE user_id=$1`, params
    );
  }

  log('info', 'Mail settings saved', { userId, enabled: Boolean(input.enabled), passwordChanged: writePassword });
  return getForClient(userId);
}

/**
 * How many accounts are actually relying on the installation default right
 * now — enabled, with no host of their own — so the administration screen can
 * say what a change here would touch, the same way appSettings.accountsOverDefault
 * does for the report ceiling.
 */
async function countReliantOnDefault() {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM mail_settings WHERE enabled AND smtp_host = ''`
  );
  return rows[0].n;
}

module.exports = {
  configure, getForClient, getResolved, save, toAddressArray, PASSWORD_PLACEHOLDER,
  countReliantOnDefault, applyDefaultFallback,
};
