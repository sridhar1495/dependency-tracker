// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Violation Cache Service — routing and boot ────────────────────────────────
// This file is deliberately thin: it wires modules together, runs the boot
// sequence and dispatches requests. All behaviour lives under lib/ and routes/
// (CLAUDE.md §2, §6.1).
//
// Endpoints:
//   GET    /violation-cache/status              — current state + build progress
//   GET    /violation-cache/data                — the cached map (only when ready/stale)
//   GET    /violation-cache/config              — effective API key (redacted) + app config
//   POST   /violation-cache/config              — update DT_API_KEY and/or app config
//   POST   /violation-cache/config/test-email   — send a test email
//   POST   /violation-cache/refresh             — trigger a background rebuild
//   POST   /violation-cache/report/generate     — start a vulnerability Excel report job
//   GET    /violation-cache/report/list         — list all report jobs with status
//   DELETE /violation-cache/report/:id          — delete a report job + file
//   GET    /violation-cache/report/:id/download — stream the completed Excel file
//   POST   /violation-cache/report/:id/cancel   — cancel a running report job
//   POST   /violation-cache/schedule/arm        — arm the scheduler
//   GET    /violation-cache/schedule/status     — schedule state
//   DELETE /violation-cache/schedule            — disable the schedule
//   POST   /violation-cache/schedule/ack-notification — clear a failure notice
//
// Environment variables are documented in lib/config.js and .env.example.

const http = require('http');

const { load: loadEnvConfig, ConfigError } = require('./lib/config');
const { log, configure: configureLog }     = require('./lib/log');
const { jsonReply }                        = require('./lib/http-util');
const { getEffectiveConfig }               = require('./lib/env-file');

const pool        = require('./db/pool');
const { migrate } = require('./db/migrate');

const appConfig = require('./lib/app-config');
const cache     = require('./lib/violation-cache');
const reports   = require('./lib/reports');
const scheduler = require('./lib/scheduler');
const auth      = require('./lib/auth');
const admin     = require('./lib/admin');

const routeModules = [
  require('./routes/auth'),
  require('./routes/profile'),
  require('./routes/cache'),
  require('./routes/config'),
  require('./routes/reports'),
  require('./routes/schedule'),
];

// ── Route authentication policy ───────────────────────────────────────────────
// Routes are authenticated by DEFAULT. Adding a path to PUBLIC_PATHS is an
// explicit decision that must be justified in the PR (CLAUDE.md §6.6, §12).
const PUBLIC_PATHS = new Set([
  '/auth/register',            // creating an account cannot require an account
  '/auth/check-availability',  // needed during registration; rate limited, reveals no owner
  '/auth/login',               // the entry point itself
]);

// Everything else — including every /violation-cache/* route — now requires a
// bearer token. The dashboard sends one via apiFetch() as of phase 3.
function isPublic(path) {
  return PUBLIC_PATHS.has(path);
}

// ── Boot step 1: read and validate configuration ──────────────────────────────
// Done before anything else so a misconfigured container fails immediately with
// an actionable message instead of half-starting.
let cfg;
try {
  cfg = loadEnvConfig();
} catch (err) {
  if (err instanceof ConfigError || err.code === 'CONFIG_INVALID') {
    console.error(`[cache] FATAL: invalid configuration — ${err.message}`);
    process.exit(1);
  }
  throw err;
}
configureLog(cfg.logFormat);

// One bound accessor for the shared DT connection, injected into every module
// that needs it. Phase 4 replaces this with a per-user lookup.
const effectiveConfig = () =>
  getEffectiveConfig(cfg.envFile, cfg.dt.startupApiUrl, cfg.dt.startupApiKey);

appConfig.configure({
  cacheDir:   cfg.cacheDir,
  configFile: cfg.paths.configFile,
  configTmp:  cfg.paths.configTmp,
});
cache.configure({
  cacheDir:   cfg.cacheDir,
  cacheFile:  cfg.paths.cacheFile,
  cacheTmp:   cfg.paths.cacheTmp,
  cacheTtlMs: cfg.cacheTtlMs,
  getEffectiveConfig: effectiveConfig,
});
reports.configure({
  reportDir:      cfg.paths.reportDir,
  reportRegistry: require('path').join(cfg.paths.reportDir, 'registry.json'),
  reportTmp:      require('path').join(cfg.paths.reportDir, 'registry.tmp.json'),
  reportConcurrency:    cfg.reportConcurrency,
  violationConcurrency: cfg.violationConcurrency,
  getEffectiveConfig: effectiveConfig,
});
scheduler.configure({
  schedDir: cfg.paths.schedDir,
  getEffectiveConfig: effectiveConfig,
});

// Context handed to every route module.
const routeDeps = {
  paths:   cfg.paths,
  envFile: cfg.envFile,
  getEffectiveConfig: effectiveConfig,
};

// ── Request dispatch ──────────────────────────────────────────────────────────
// Each route module is asked in turn and returns true once it has answered.
// Phase 2 inserts the authentication check here, before the first module runs,
// so a new route is authenticated by default (CLAUDE.md §6.6).
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      // PUT is required by the profile endpoint; Authorization by every
      // authenticated route.
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  const { method, url } = req;
  const parsedPath = new URL(url, 'http://x').pathname;
  const ctx = { method, url, path: parsedPath, req, res, deps: routeDeps };

  try {
    // ── Authentication, before any route sees the request ────────────────
    // A missing, malformed, expired or revoked token is a single 401 with a
    // stable code; the frontend treats any 401 as "go to the login page".
    if (!isPublic(parsedPath)) {
      const token = auth.bearerFromRequest(req);
      const principal = token ? await auth.resolveToken(token) : null;
      if (!principal) {
        jsonReply(res, 401, {
          error: 'Your session is not valid. Please sign in again.',
          code: 'INVALID_SESSION',
        });
        return;
      }
      ctx.principal = principal;
    }

    for (const mod of routeModules) {
      if (await mod.handle(ctx)) return;
      // O5: a handler that wrote a response but reported "not mine" would fall
      // through to the 404 below, truncating a streamed body. Fail loudly rather
      // than silently corrupting the response.
      if (res.headersSent) {
        log('error', 'Route handler sent a response but did not return true', {
          path: parsedPath, method,
        });
        return;
      }
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    log('error', `Unhandled route error: ${err.message}`, { path: parsedPath, method });
    if (!res.headersSent) jsonReply(res, 500, { error: 'Internal server error' });
    else res.end();
  }
});

// ── Boot sequence ─────────────────────────────────────────────────────────────
let sessionSweeper = null;

async function boot() {
  // Step 2: connection pool.
  pool.init(cfg.db);
  pool.onError(err => log('error', `Idle database client error: ${err.message}`));
  log('info', 'Database pool created', {
    host: cfg.db.host, port: cfg.db.port, database: cfg.db.database, max: cfg.db.max,
  });

  // Step 3: migrations. The listener must not start until these complete.
  await migrate({ pool: pool.getPool(), log });

  // Step 4: administrator credentials. Never created here — if the file is
  // absent, administrator login is disabled and the reason is logged.
  auth.configure(cfg);
  admin.load(cfg.paths.adminCreds);
  if (!cfg.secretEncryptionKey) {
    log('warn', 'SECRET_ENCRYPTION_KEY is not set — required from phase 4 to store DT API keys');
  }

  // Step 5: restore persisted state and start background timers.
  reports.loadRegistry();
  scheduler.armScheduler();
  // Sweep expired sessions and stale audit rows so neither table grows without
  // bound. Runs every 10 minutes, and once shortly after boot.
  sessionSweeper = setInterval(() => { auth.sweep(); }, 10 * 60_000);
  if (sessionSweeper.unref) sessionSweeper.unref();
  setTimeout(() => auth.sweep(), 5_000).unref();

  // Step 6: accept requests.
  await new Promise((resolve) => server.listen(cfg.port, resolve));

  const { apiUrl, apiKey } = effectiveConfig();
  const appCfg = appConfig.loadConfig();
  log('info', `Violation cache service listening on :${cfg.port}`);
  log('info', 'Authentication', {
    adminLogin:   admin.isEnabled() ? 'enabled' : 'DISABLED',
    sessionHours: `${cfg.session.absoluteHours} absolute / ${cfg.session.idleHours} idle`,
    enforcedOn:   'all routes',
    publicPaths:  [...PUBLIC_PATHS].join(', '),
  });
  log('info', 'Startup configuration', {
    apiUrl,
    apiKey:       apiKey ? `***${apiKey.slice(-4)}` : 'NOT SET',
    cacheTtlHrs:  cfg.cacheTtlMs / 3_600_000,
    cacheFile:    cfg.paths.cacheFile,
    envFile:      `${cfg.envFile} (${require('fs').existsSync(cfg.envFile) ? 'mounted ✓' : 'NOT FOUND — config endpoint disabled'})`,
    maxReports:   appCfg.maxReports,
    mailEnabled:  appCfg.mail.enabled,
    schedEnabled: appCfg.schedule.enabled,
    logFormat:    cfg.logFormat,
  });

  const s = cache.getStatus();
  if (s.status === 'none' || s.status === 'stale') {
    log('info', `Auto-triggering cache build (status: ${s.status})`);
    cache.runJob().catch(err => log('error', `Startup job error: ${err.message}`));
  } else {
    log('info', `Cache status on startup: ${s.status}`);
  }
}

// ── Shutdown ──────────────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `Received ${signal} — shutting down`);
  scheduler.stop();
  if (sessionSweeper) clearInterval(sessionSweeper);
  auth.clearCache();
  server.close();
  try { await pool.close(); } catch (e) { log('warn', `Pool close failed: ${e.message}`); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// An unhandled rejection must never take the process down (CLAUDE.md §11.1).
process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled promise rejection: ${reason && reason.message ? reason.message : reason}`);
});

boot().catch((err) => {
  log('error', `FATAL: boot failed — ${err.message}`, { code: err.code });
  process.exit(1);
});
