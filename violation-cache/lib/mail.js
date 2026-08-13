// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// SMTP delivery. The only consumer of nodemailer.
// S5: the SMTP password is read from stored config and never logged or returned.



const nodemailer = require('nodemailer'); // Q9: MIT-licensed SMTP email library (approved exception to no-new-packages rule)
const { log } = require('./log');

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
    auth:   mailCfg.smtp.user
      ? { user: mailCfg.smtp.user, pass: mailCfg.smtp.pass }
      : undefined,
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

module.exports = { sendEmail };
