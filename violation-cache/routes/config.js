// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Configuration endpoints: effective DT key + app config, and the SMTP test send.

const fs   = require('fs');
const { log } = require('../lib/log');
const { jsonReply, readBody } = require('../lib/http-util');
const { patchEnvFile } = require('../lib/env-file');
const {
  loadConfig, saveConfig, deepMerge, sanitiseConfigForClient, DEFAULT_MAX_REPORTS,
} = require('../lib/app-config');
const { sendEmail } = require('../lib/mail');
const { reportJobs, saveRegistry } = require('../lib/reports');
const scheduler = require('../lib/scheduler');

async function handle({ method, url, path: parsedPath, req, res, deps }) {
    // ── GET /violation-cache/config ───────────────────────────────────────────
    // Returns the full app config (sanitised — SMTP password is masked) plus
    // the current effective API key and .env mount status.
    // The dashboard reads this on page load and after the config panel is opened.
    if (method === 'GET' && url === '/violation-cache/config') {
      const { apiKey: effectiveKey } = deps.getEffectiveConfig();
      const clientCfg = sanitiseConfigForClient(loadConfig());
      jsonReply(res, 200, {
        apiKey:         effectiveKey,
        envFileMounted: fs.existsSync(deps.envFile),
        config:         clientCfg,
      });
      return true;
    }

    // ── POST /violation-cache/config ──────────────────────────────────────────
    // Accepts:
    //   { apiKey }          — update DT_API_KEY in .env (backward compat)
    //   { config: {...} }   — save full app config (maxReports, mail, schedule)
    //   Both fields may appear together.
    if (method === 'POST' && url === '/violation-cache/config') {
      try {
        const raw  = await readBody(req, 256 * 1024); // 256 KB — project UUID lists can be large
        const body = JSON.parse(raw);
  
        // ── API key update (existing behaviour) ──────────────────────────
        if (body.apiKey !== undefined) {
          if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
            jsonReply(res, 400, { error: 'apiKey must be a non-empty string' });
            return true;
          }
          const cleanKey = body.apiKey.replace(/[\x00-\x1F\x7F]/g, '').trim();
          if (!fs.existsSync(deps.envFile)) {
            jsonReply(res, 503, { error: `Config file not found at ${deps.envFile}. Ensure .env is bind-mounted.` });
            return true;
          }
          patchEnvFile(deps.envFile, { DT_API_KEY: cleanKey });
          log('info', `DT_API_KEY updated in ${deps.envFile}`, { key: `***${cleanKey.slice(-4)}` });
        }
  
        // ── Full app config update ────────────────────────────────────────
        if (body.config !== undefined) {
          if (typeof body.config !== 'object' || body.config === null) {
            jsonReply(res, 400, { error: 'config must be an object' });
            return true;
          }
          const prevCfg    = loadConfig();
          const prevMax    = prevCfg.maxReports || DEFAULT_MAX_REPORTS;
          const newMax     = typeof body.config.maxReports === 'number' && body.config.maxReports > 0
            ? body.config.maxReports : prevMax;
  
          // Restore real SMTP password when client sent the masked placeholder
          if (body.config.mail?.smtp?.pass === '••••••••') {
            if (body.config.mail) body.config.mail.smtp.pass = prevCfg.mail.smtp.pass;
          }
  
          const merged = deepMerge(prevCfg, body.config);
  
          const schedChanged = JSON.stringify(prevCfg.schedule) !== JSON.stringify(merged.schedule);
  
          saveConfig(merged);
          log('info', 'App config updated', {
            maxReports:  merged.maxReports,
            mailEnabled: merged.mail.enabled,
            schedEnabled: merged.schedule.enabled,
          });
  
          // Re-arm only if the scheduler timer was already active so that
          // config changes take effect on the next run. First-time arming
          // is done exclusively via POST /violation-cache/schedule/arm,
          // which is called by the "Schedule Reports" toolbar button.
          if (schedChanged && scheduler.isArmed()) scheduler.armScheduler();
  
          // Trim oldest completed reports when maxReports decreased
          if (newMax < prevMax) {
            const completed = Array.from(reportJobs.values())
              .filter(j => j.status === 'completed')
              .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // oldest first
            const toDelete = completed.slice(0, Math.max(0, completed.length - newMax));
            for (const j of toDelete) {
              if (j.filePath && fs.existsSync(j.filePath)) {
                try { fs.unlinkSync(j.filePath); } catch (_) {}
              }
              reportJobs.delete(j.id);
              log('info', `Trimmed old report ${j.id} (maxReports reduced to ${newMax})`);
            }
            if (toDelete.length) saveRegistry();
          }
  
          // Re-arm scheduler based on updated config
          if (schedChanged) scheduler.armScheduler();
        }
  
        jsonReply(res, 200, { ok: true });
  
      } catch (e) {
        if (e.code === 'PATCH_READ_FAILED') {
          log('error', `Config update failed — could not read .env: ${e.message}`);
          jsonReply(res, 500, { error: 'Could not read configuration file — check file permissions' });
        } else if (e.code === 'PATCH_WRITE_FAILED') {
          log('error', `Config update failed — could not write .env: ${e.message}`);
          jsonReply(res, 500, { error: 'Could not write configuration file — check file permissions' });
        } else {
          log('error', `Config update error: ${e.message}`);
          jsonReply(res, 500, { error: e.message });
        }
      }
      return true;
    }

    // ── POST /violation-cache/config/test-email ──────────────────────────────
    // Sends a plain-text test email.
    // Accepts an optional JSON body with form-level SMTP credentials so the
    // user can test connectivity before saving.  If useStoredPass:true is set
    // the real stored password is substituted (the browser never has it).
    // Falls back to saved config when no body is supplied.
    if (method === 'POST' && parsedPath === '/violation-cache/config/test-email') {
      try {
        const cfg = loadConfig();
        let mailCfg;
  
        const raw = await readBody(req).catch(() => '');
        const body = raw ? JSON.parse(raw) : null;
  
        if (body && body.smtp) {
          // Q10: use form credentials for the test; substitute stored password
          // when the browser sends useStoredPass:true (placeholder was shown).
          const storedPass = cfg.mail && cfg.mail.smtp ? cfg.mail.smtp.pass : '';
          mailCfg = {
            enabled: true,
            smtp: {
              host:   body.smtp.host   || '',
              port:   body.smtp.port   || 587,
              secure: !!body.smtp.secure,
              user:   body.smtp.user   || '',
              pass:   body.useStoredPass ? storedPass : (body.smtp.pass || ''),
            },
            from: body.from || '',
            to:   body.to   || [],
            cc:   body.cc   || [],
          };
        } else {
          if (!cfg.mail.enabled) {
            jsonReply(res, 400, { error: 'Email is not enabled in configuration' });
            return true;
          }
          mailCfg = cfg.mail;
        }
  
        if (!mailCfg.smtp.host || !mailCfg.from || !mailCfg.to.length) {
          jsonReply(res, 400, { error: 'SMTP host, From address, and at least one To address are required' });
          return true;
        }
        await sendEmail(mailCfg, null, null, {
          subject: 'Dependency-Track — Test Email',
          body:    `This is a test email from the Dependency-Track Risk Dashboard sent on ${new Date().toLocaleString()}. Your SMTP configuration is working correctly.`,
        });
        jsonReply(res, 200, { ok: true, message: 'Test email sent successfully' });
      } catch (e) {
        log('error', `Test email failed: ${e.message}`);
        jsonReply(res, 500, { error: `Email failed: ${e.message}` });
      }
      return true;
    }

  return false;
}

module.exports = { handle };
