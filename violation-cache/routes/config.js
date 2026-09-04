// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Per-user configuration ────────────────────────────────────────────────────
//   GET    /violation-cache/config                  connection + settings + mail + schedule
//   POST   /violation-cache/config                  save any subset of the above
//   DELETE /violation-cache/config/dt-key           forget the stored DT API key
//   POST   /violation-cache/config/test-connection  probe DT before saving
//   POST   /violation-cache/config/test-email       send a test message
//
// Everything here is scoped to `principal.userId`. Nothing is read from or
// written to .env or app-config.json any more — the single-tenant files are
// gone (CLAUDE.md §5.6).
//
// S22: neither the DT API key nor the SMTP password is ever present in a
// response. The client is told only whether each is configured.

const { log } = require('../lib/log');
const { jsonReply, readJson, requireUser } = require('../lib/http-util');
// Module references, not destructured bindings, so the offline route tests
// can substitute them (CLAUDE.md §10.1).
const dtFetch = require('../lib/dt-fetch');
const branding = require('../lib/branding');
const mail    = require('../lib/mail');
const dtConnections = require('../lib/dt-connections');
const userSettings  = require('../lib/user-settings');
const mailSettings  = require('../lib/mail-settings');
const schedulesDb   = require('../lib/schedules');
const scheduler     = require('../lib/scheduler');

/** Shape the schedule row the way the dashboard's config panel expects it. */
function scheduleForClient(row, projects) {
  if (!row) return { enabled: false };
  return {
    enabled:             row.enabled,
    frequency:           row.frequency,
    hour:                row.hour,
    weekDays:            row.weekDays || [],
    monthDay:            row.monthDay,
    riskTypes:           row.riskTypes || [],
    reportName:          row.reportName || '',
    nextRun:             row.nextRunAt,
    lastRun:             row.lastRunAt,
    lastRunStatus:       row.lastRunStatus,
    lastRunError:        row.lastRunError,
    failureNotification: row.failureNotification,
    projectUuids:        projects.map(p => p.uuid),
    projectCount:        projects.length,
  };
}

async function handle({ method, path: parsedPath, req, res, principal }) {

  // ── GET /violation-cache/config ─────────────────────────────────────────
  if (method === 'GET' && parsedPath === '/violation-cache/config') {
    const userId = requireUser(principal, res);
    if (!userId) return true;

    try {
      const [conn, settings, mailCfg, sched, projects] = await Promise.all([
        dtConnections.getForClient(userId),
        userSettings.get(userId),
        mailSettings.getForClient(userId),
        schedulesDb.get(userId),
        schedulesDb.getProjects(userId),
      ]);

      jsonReply(res, 200, {
        connection: {
          apiUrl:       conn ? conn.apiUrl : '',
          frontendUrl:  conn ? conn.frontendUrl : '',
          isConfigured: conn ? conn.isConfigured : false,
          hasApiKey:    conn ? conn.hasApiKey : false,
        },
        config: {
          maxReports: settings.maxReports,
          mail:       mailCfg || { enabled: false },
          schedule:   scheduleForClient(sched, projects),
        },
      });
    } catch (err) {
      log('error', `Config read failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not load your settings.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /violation-cache/config ────────────────────────────────────────
  if (method === 'POST' && parsedPath === '/violation-cache/config') {
    const userId = requireUser(principal, res);
    if (!userId) return true;

    // 256 KB: a schedule's project selection can be several hundred UUIDs
    // (CLAUDE.md §12).
    const body = await readJson(req, res, 256 * 1024);
    if (body === null) return true;

    try {
      // ── DependencyTrack connection ────────────────────────────────
      if (body.connection !== undefined) {
        if (typeof body.connection !== 'object' || body.connection === null) {
          jsonReply(res, 400, { error: 'connection must be an object.', code: 'VALIDATION_FAILED' });
          return true;
        }
        await dtConnections.save(userId, body.connection);
      }

      const cfg = body.config;
      if (cfg !== undefined) {
        if (typeof cfg !== 'object' || cfg === null) {
          jsonReply(res, 400, { error: 'config must be an object.', code: 'VALIDATION_FAILED' });
          return true;
        }

        // ── Report ceiling ──────────────────────────────────────────
        // Deliberately NOT read from the body. The limit is an administrator's
        // capacity decision about the server's disk, set globally or per
        // account from the administration screen, so a user submitting one is
        // ignored rather than refused — the same defensive shape the profile
        // route uses for loginId and email. The value is still returned by GET
        // so the dashboard can show what the account is allowed.

        // ── SMTP ────────────────────────────────────────────────────
        if (cfg.mail !== undefined) {
          if (typeof cfg.mail !== 'object' || cfg.mail === null) {
            jsonReply(res, 400, { error: 'mail must be an object.', code: 'VALIDATION_FAILED' });
            return true;
          }
          await mailSettings.save(userId, cfg.mail);
        }

        // ── Schedule ────────────────────────────────────────────────
        if (cfg.schedule !== undefined) {
          if (typeof cfg.schedule !== 'object' || cfg.schedule === null) {
            jsonReply(res, 400, { error: 'schedule must be an object.', code: 'VALIDATION_FAILED' });
            return true;
          }
          await schedulesDb.save(userId, cfg.schedule);
          if (Array.isArray(cfg.schedule.projects)) {
            await schedulesDb.setProjects(userId, cfg.schedule.projects);
          }

          // Keep next_run_at consistent with the definition that was just
          // saved. calcNextRun is the single source of truth for timing, so
          // the value is never computed anywhere else (CLAUDE.md §6.8).
          const saved = await schedulesDb.get(userId);
          if (saved && saved.enabled && saved.projectCount > 0) {
            await schedulesDb.arm(userId, scheduler.calcNextRun(saved));
          } else if (saved && !saved.enabled) {
            await schedulesDb.disable(userId);
          }
        }
      }

      const connection = await dtConnections.getForClient(userId);
      jsonReply(res, 200, {
        ok: true,
        connection: {
          apiUrl:       connection ? connection.apiUrl : '',
          frontendUrl:  connection ? connection.frontendUrl : '',
          isConfigured: connection ? connection.isConfigured : false,
          hasApiKey:    connection ? connection.hasApiKey : false,
        },
      });
    } catch (err) {
      if (err.code === 'VALIDATION_FAILED') {
        jsonReply(res, 400, { error: err.message, code: 'VALIDATION_FAILED', field: err.field });
        return true;
      }
      log('error', `Config update failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not save your settings.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── DELETE /violation-cache/config/dt-key ───────────────────────────────
  // Used when a stored key can no longer be decrypted, and by "Disconnect".
  if (method === 'DELETE' && parsedPath === '/violation-cache/config/dt-key') {
    const userId = requireUser(principal, res);
    if (!userId) return true;
    try {
      await dtConnections.clearKey(userId);
      jsonReply(res, 200, { ok: true });
    } catch (err) {
      log('error', `Clearing the DT key failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not clear the API key.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /violation-cache/config/test-connection ────────────────────────
  // Probes DT with the supplied credentials so the user finds out before
  // saving. An omitted key means "test the one already stored" — the browser
  // never has it to send back.
  if (method === 'POST' && parsedPath === '/violation-cache/config/test-connection') {
    const userId = requireUser(principal, res);
    if (!userId) return true;

    const body = await readJson(req, res);
    if (body === null) return true;

    try {
      let apiUrl = typeof body.apiUrl === 'string' ? body.apiUrl.trim().replace(/\/$/, '') : '';
      let apiKey = typeof body.apiKey === 'string' ? body.apiKey.replace(/[\x00-\x1F\x7F]/g, '').trim() : '';

      if (!apiUrl || !apiKey) {
        const stored = await dtConnections.getResolved(userId);
        if (!apiUrl) apiUrl = stored ? stored.apiUrl : '';
        if (!apiKey) apiKey = stored ? stored.apiKey : '';
      }
      if (!apiUrl || !apiKey) {
        jsonReply(res, 400, {
          error: 'Enter both a DependencyTrack URL and an API key.',
          code: 'VALIDATION_FAILED',
        });
        return true;
      }

      // Probe the endpoint the dashboard itself depends on, one page of one
      // project. That tests all three things at once — the URL is a
      // DependencyTrack API root, the key is accepted, and the key carries the
      // permission this dashboard needs.
      //
      // It used to probe /api/v1/version, which does not exist: DependencyTrack
      // serves its version at /api/version (see docs/INSTALLATION.md). Every
      // test therefore came back as a 404 "connection failed" on a connection
      // that was in fact fine. /api/version would not have been a good probe
      // either — it is unauthenticated, so it proves nothing about the key.
      await dtFetch.dtGetWithRetry('/api/v1/project?pageSize=1&pageNumber=1', apiUrl, apiKey);

      // The version is a nicety, not part of the verdict. It lives on an
      // unauthenticated path, so a deployment that blocks it must not turn a
      // working connection into a failure.
      let version = null, application = null;
      try {
        const { json } = await dtFetch.dtGetWithRetry('/api/version', apiUrl, apiKey);
        if (json) { version = json.version || null; application = json.application || null; }
      } catch (_) { /* advisory only */ }

      jsonReply(res, 200, { ok: true, version, application });
    } catch (err) {
      if (err.code === 'DT_KEY_UNREADABLE') {
        jsonReply(res, 503, { error: err.message, code: 'DT_KEY_UNREADABLE' });
        return true;
      }

      // Say what is actually wrong. "HTTP 401" and "HTTP 404" are different
      // problems with different fixes, and telling somebody to "check the URL
      // and API key" when only one of them is wrong makes them re-check both.
      const dtStatus = err.statusCode || null;
      let code = 'DT_UNREACHABLE';
      let message;
      if (dtStatus === 401) {
        code = 'DT_KEY_REJECTED';
        message = 'DependencyTrack rejected the API key. Check the key itself.';
      } else if (dtStatus === 403) {
        code = 'DT_KEY_FORBIDDEN';
        message = 'The API key was accepted but is not permitted to list projects. '
                + 'It needs the VIEW_PORTFOLIO permission.';
      } else if (dtStatus === 404) {
        code = 'DT_NOT_DT';
        message = 'The server answered, but there is no DependencyTrack API at that URL. '
                + 'Give the API base URL without a trailing path, for example '
                + 'http://dependency-track:8080';
      } else if (dtStatus) {
        code = 'DT_HTTP_ERROR';
        message = `DependencyTrack returned HTTP ${dtStatus}.`;
      } else {
        message = `DependencyTrack could not be reached: ${err.message}`;
      }
      jsonReply(res, 200, { ok: false, dtStatus, code, error: message });
    }
    return true;
  }

  // ── POST /violation-cache/config/test-email ─────────────────────────────
  // Uses the values currently on screen so connectivity can be checked before
  // saving. useStoredPass:true substitutes the stored password, which the
  // browser only ever sees as a placeholder.
  if (method === 'POST' && parsedPath === '/violation-cache/config/test-email') {
    const userId = requireUser(principal, res);
    if (!userId) return true;

    const body = await readJson(req, res);
    if (body === null) return true;

    try {
      let mailCfg;
      if (body && body.smtp) {
        let storedPass = '';
        if (body.useStoredPass) {
          const stored = await mailSettings.getResolved(userId);
          storedPass = stored ? stored.smtp.pass : '';
        }
        mailCfg = {
          enabled: true,
          smtp: {
            host:   body.smtp.host || '',
            port:   body.smtp.port || 587,
            secure: Boolean(body.smtp.secure),
            user:   body.smtp.user || '',
            pass:   body.useStoredPass ? storedPass : (body.smtp.pass || ''),
          },
          from: body.from || '',
          to:   mailSettings.toAddressArray(body.to),
          cc:   mailSettings.toAddressArray(body.cc),
        };
      } else {
        const stored = await mailSettings.getResolved(userId);
        if (!stored || !stored.enabled) {
          jsonReply(res, 400, { error: 'Email is not enabled in your settings.', code: 'MAIL_DISABLED' });
          return true;
        }
        mailCfg = stored;
      }

      if (!mailCfg.smtp.host || !mailCfg.from || !mailCfg.to.length) {
        jsonReply(res, 400, {
          error: 'SMTP host, From address and at least one To address are required.',
          code: 'VALIDATION_FAILED',
        });
        return true;
      }

      // The configured title, like every other message the service sends.
      const appTitle = await branding.getTitle();
      await mail.sendEmail(mailCfg, null, {
        appTitle,
        subject: `${appTitle} — test email`,
        body: `This is a test email from ${appTitle}, sent on ${new Date().toLocaleString()}. `
            + 'Your SMTP configuration is working correctly.',
      });
      jsonReply(res, 200, { ok: true, message: 'Test email sent successfully' });
    } catch (err) {
      if (err.code === 'SMTP_PASS_UNREADABLE') {
        jsonReply(res, 503, { error: err.message, code: 'SMTP_PASS_UNREADABLE' });
        return true;
      }
      log('error', `Test email failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: `Email failed: ${err.message}`, code: 'MAIL_SEND_FAILED' });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
