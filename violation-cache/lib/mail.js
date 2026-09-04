// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// SMTP delivery. The only consumer of nodemailer.
// S5: the SMTP password is read from stored config and never logged or returned.



const nodemailer = require('nodemailer'); // Q9: MIT-licensed SMTP email library (approved exception to no-new-packages rule)
const { log } = require('./log');
// The fallback for the default subject and body. Required here as well as in
// excel.js: sendEmail computes its defaults before overrides are applied, so
// this is reached on EVERY send, including one that supplies its own subject.
const { DEFAULT_TITLE: DEFAULT_APP_TITLE } = require('./branding');

// Q18: tuneable constants at the top of the file.
const CONNECT_TIMEOUT_MS  = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS   = 60_000;

// ── Email helper ──────────────────────────────────────────────────────────────
/**
 * Send an email using one user's decrypted SMTP settings.
 *
 * S20: mailCfg comes from mail-settings.getResolved(). The password is used here
 * and nowhere else — it is never logged and never returned in a response.
 *
 * @param {object} mailCfg  resolved settings: { smtp:{host,port,secure,user,pass}, from, to, cc, subject, body }
 * @param {{filename: string, content: Buffer}|null} attachment
 *        Scheduled reports are built in memory and attached directly, so
 *        nothing is written to disk (CLAUDE.md §6.8).
 * @param {object} [overrides]  override to/cc/subject/body, used for failure alerts
 * @param {string} [overrides.appTitle]  the configured application name, used in
 *        the default subject and body only — a user who wrote their own subject
 *        keeps it.
 */
async function sendEmail(mailCfg, attachment, overrides = {}) {
  const now            = new Date();
  const appTitle       = (typeof overrides.appTitle === 'string' && overrides.appTitle.trim())
    ? overrides.appTitle.trim()
    : DEFAULT_APP_TITLE;
  const defaultSubject = `${appTitle} Report — ${now.toLocaleDateString()}`;
  const defaultBody    = `Please find attached the latest report from ${appTitle}, generated on ${now.toLocaleString()}.`;

  const transporter = nodemailer.createTransport({
    host:   mailCfg.smtp.host,
    port:   mailCfg.smtp.port,
    secure: mailCfg.smtp.secure,
    // No username means no authentication is attempted at all. The auth object
    // is omitted rather than sent empty: an empty user/pass pair makes many
    // relays refuse the connection outright.
    auth:   mailCfg.smtp.user
      ? { user: mailCfg.smtp.user, pass: mailCfg.smtp.pass }
      : undefined,
    // Bounded, because nodemailer's defaults are minutes long and a host that
    // accepts the TCP connection but never speaks would otherwise hang the
    // request. A test email that never returns says less than a bad error does.
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout:   GREETING_TIMEOUT_MS,
    // Inactivity, not total: a large attachment still has as long as it needs
    // so long as bytes keep moving.
    socketTimeout:     SOCKET_TIMEOUT_MS,
  });

  const msg = {
    from:    mailCfg.from,
    to:      (overrides.to || mailCfg.to).join(', '),
    subject: overrides.subject || mailCfg.subject || defaultSubject,
    text:    overrides.body    || mailCfg.body    || defaultBody,
  };
  const cc = (overrides.cc || mailCfg.cc || []);
  if (cc.length) msg.cc = cc.join(', ');

  if (attachment && attachment.content) {
    msg.attachments = [{ filename: attachment.filename || 'report.xlsx', content: attachment.content }];
  }

  log('info', 'Sending email', {
    to:   msg.to,
    subj: msg.subject,
    smtp: `${mailCfg.smtp.host}:${mailCfg.smtp.port}`,
    attach: attachment ? `${attachment.filename} (${attachment.content.length} bytes)` : 'none',
  });
  await transporter.sendMail(msg);
  log('info', 'Email sent successfully');
}

// ── SMTP failure translation ─────────────────────────────────────────────────
/**
 * Turn a transport failure into something the person configuring it can act on.
 *
 * nodemailer surfaces the underlying OpenSSL or socket error verbatim, and those
 * strings mislead more than they help: the commonest misconfiguration of all —
 * TLS ticked against a plaintext port — reports "wrong version number", which
 * sounds like a TLS version mismatch and is actually "this is not TLS at all".
 *
 * @param {Error} err            what sendEmail threw
 * @param {object} [smtp]        { host, port, secure }, to name the setting at fault
 * @returns {{message: string, code: string}|null} null when unrecognised, so the
 *          caller falls back to the raw message rather than inventing a cause
 */
function describeSmtpError(err, smtp = {}) {
  const raw  = String((err && err.message) || '');
  const code = String((err && err.code) || '');
  const port = smtp.port;
  const at   = smtp.host ? `${smtp.host}:${port}` : 'the mail server';

  // TLS attempted against a plaintext port. The server answered with its SMTP
  // greeting and OpenSSL tried to read that text as a TLS record.
  if (/wrong version number/i.test(raw) || code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
    return {
      code: 'SMTP_TLS_ON_PLAINTEXT_PORT',
      message: `${at} is not using TLS on this port. Clear the TLS checkbox — the ` +
               'connection still upgrades with STARTTLS if the server offers it. ' +
               'TLS should be ticked only for an implicit-TLS port, usually 465.',
    };
  }
  // The mirror image: plaintext attempted against an implicit-TLS port.
  if (/socket disconnected before secure|before secure TLS connection/i.test(raw)) {
    return {
      code: 'SMTP_TLS_REQUIRED',
      message: `${at} closed the connection before any mail was exchanged, which ` +
               'usually means it expects TLS from the start. Tick the TLS checkbox' +
               (port && Number(port) !== 465 ? ', or use port 465.' : '.'),
    };
  }
  if (code === 'ECONNREFUSED') {
    return { code: 'SMTP_CONNECTION_REFUSED',
             message: `Nothing is accepting connections at ${at}. Check the host and port.` };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code: 'SMTP_HOST_UNKNOWN',
             message: `The host ${smtp.host || ''} could not be resolved. Check the spelling, ` +
                      'and that this server can reach your DNS.' };
  }
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(raw)) {
    return { code: 'SMTP_TIMEOUT',
             message: `${at} did not answer in time. It is usually a firewall between this ` +
                      'server and the mail server, or the wrong port.' };
  }
  if (code === 'EAUTH' || /invalid login|authentication fail|535/i.test(raw)) {
    return { code: 'SMTP_AUTH_REJECTED',
             message: 'The mail server rejected the username or password. Leave both blank ' +
                      'if it accepts mail without authentication.' };
  }
  if (/missing credentials/i.test(raw)) {
    return { code: 'SMTP_AUTH_REQUIRED',
             message: `${at} requires authentication. Enter a username and password.` };
  }
  if (/self.signed certificate|unable to verify the first certificate|DEPTH_ZERO/i.test(raw) ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return { code: 'SMTP_UNTRUSTED_CERT',
             message: `The certificate presented by ${at} is not trusted by this server. ` +
                      'It is usually an internal certificate authority that has not been installed.' };
  }
  if (code === 'EENVELOPE' || /550|553|relay access denied|sender address rejected/i.test(raw)) {
    return { code: 'SMTP_ENVELOPE_REJECTED',
             message: 'The mail server rejected the From or To address. Internal relays often ' +
                      'accept only their own domains, or only known senders.' };
  }
  return null;
}

module.exports = {
  sendEmail, describeSmtpError,
  CONNECT_TIMEOUT_MS, GREETING_TIMEOUT_MS, SOCKET_TIMEOUT_MS,
};
