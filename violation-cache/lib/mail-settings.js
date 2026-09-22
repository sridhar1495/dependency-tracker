// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Per-user mail preferences ─────────────────────────────────────────────────
// The SMTP connection itself — host, port, TLS, credentials — is administrator-
// owned (lib/default-mail-settings.js, migration 018) and no longer lives here.
// What stays per account is everything about WHO a report goes to and WHAT it
// says: whether this account wants email at all, its own From (reply)
// address, its default recipients, subject and covering note. An account that
// wants its reports to arrive "from" a different address than another account
// can still say so; it just cannot point the whole installation at a
// different mail server, which was never a per-account decision this product
// needed to support.
//
// `smtp_host`/`smtp_port`/`smtp_secure`/`smtp_user`/`smtp_pass_*` still exist
// as columns on `mail_settings` (migration 002) — dropping them is a
// destructive migration this change does not need to make, and an
// installation upgrading from before this feature keeps the bytes rather than
// losing them. Nothing reads or writes them any more.

const { query } = require('../db/pool');
const { log } = require('./log');
const defaultMailSettings = require('./default-mail-settings');

const SAFE_COLUMNS = `
  user_id AS "userId", enabled, from_addr AS "fromAddr",
  to_addrs AS "toAddrs", cc_addrs AS "ccAddrs", subject, body
`;

/**
 * Settings as the browser may see them.
 *
 * `smtpAvailable` is what lets Settings show "waiting on your administrator"
 * instead of a set of controls that quietly do nothing — it answers "can
 * this account possibly send right now", independent of whether the account
 * itself has turned email on.
 */
async function getForClient(userId) {
  const { rows } = await query(`SELECT ${SAFE_COLUMNS} FROM mail_settings WHERE user_id = $1`, [userId]);
  const row = rows[0];
  if (!row) return null;
  const smtpAvailable = await defaultMailSettings.isAvailable();
  return {
    enabled: row.enabled, smtpAvailable,
    from: row.fromAddr, to: row.toAddrs || [], cc: row.ccAddrs || [],
    subject: row.subject, body: row.body,
  };
}

/**
 * Settings with the installation's SMTP connection resolved in, for sending
 * mail. Server-side only.
 *
 * `null` covers two different reasons a caller must treat identically —
 * either this account never turned email on, or the administrator's server
 * is not available right now — because in both cases the answer is the same:
 * nothing can be sent, and a caller checking `enabled` alone would send with
 * an empty host the moment the installation's own connection disappeared.
 */
async function getResolved(userId) {
  const { rows } = await query(
    `SELECT enabled, from_addr AS "fromAddr", to_addrs AS "toAddrs", cc_addrs AS "ccAddrs",
            subject, body
       FROM mail_settings WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row || !row.enabled) return null;

  const def = await defaultMailSettings.getResolved();
  if (!def) return null;

  return {
    enabled: true,
    smtp: def.smtp,
    from: row.fromAddr || def.from,
    to: row.toAddrs || [], cc: row.ccAddrs || [],
    subject: row.subject, body: row.body,
  };
}

/** Normalise a comma-separated string or array into a clean address array. */
function toAddressArray(value) {
  if (Array.isArray(value)) return value.map(s => String(s).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/**
 * Save this account's mail preferences: enabled, From, recipients, subject,
 * body. No SMTP connection to validate or encrypt here any more — that is
 * entirely the administrator's, via lib/default-mail-settings.js.
 */
async function save(userId, input) {
  const params = [
    userId,
    Boolean(input.enabled),
    String(input.from || '').trim(),
    toAddressArray(input.to),
    toAddressArray(input.cc),
    String(input.subject || ''),
    String(input.body || ''),
  ];
  await query(
    `UPDATE mail_settings
        SET enabled=$2, from_addr=$3, to_addrs=$4, cc_addrs=$5, subject=$6, body=$7
      WHERE user_id=$1`, params
  );
  log('info', 'Mail settings saved', { userId, enabled: Boolean(input.enabled) });
  return getForClient(userId);
}

/**
 * How many accounts have email turned on — every one of them depends on the
 * installation's server now, unconditionally, so this is what the
 * administration screen shows as "accounts this affects" (the same reasoning
 * appSettings.accountsOverDefault gives the report ceiling).
 */
async function countEnabled() {
  const { rows } = await query(`SELECT count(*)::int AS n FROM mail_settings WHERE enabled`);
  return rows[0].n;
}

module.exports = {
  getForClient, getResolved, save, toAddressArray, countEnabled,
};
