// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// SMTP delivery. The only consumer of nodemailer.
// S5: the SMTP password is read from stored config and never logged or returned.

const fs   = require('fs');
const path = require('path');
const nodemailer = require('nodemailer'); // Q9: MIT-licensed SMTP email library (approved exception to no-new-packages rule)
const { log } = require('./log');

// ── Email helper ──────────────────────────────────────────────────────────────
/**
 * Send an email using the SMTP credentials from the app config.
 * The SMTP password is read from the stored config — never from a GET response.
 *
 * @param {object}      mailCfg       — config.mail object
 * @param {string|null} attachPath    — absolute path to attachment (or null)
 * @param {string|null} attachName    — filename displayed in email (or null)
 * @param {object}      [overrides]   — override to/subject/body (used for failure alerts)
 */
async function sendEmail(mailCfg, attachPath, attachName, overrides = {}) {
  const now            = new Date();
  const defaultSubject = `Dependency-Track Risk Report — ${now.toLocaleDateString()}`;
  const defaultBody    = `Please find attached the latest Dependency-Track risk report generated on ${now.toLocaleString()}.`;

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

  if (attachPath && fs.existsSync(attachPath)) {
    msg.attachments = [{ filename: attachName || path.basename(attachPath), path: attachPath }];
  }

  log('info', 'Sending email', {
    to:   msg.to,
    subj: msg.subject,
    smtp: `${mailCfg.smtp.host}:${mailCfg.smtp.port}`,
    attach: attachName || 'none',
  });
  await transporter.sendMail(msg);
  log('info', 'Email sent successfully');
}

module.exports = { sendEmail };
