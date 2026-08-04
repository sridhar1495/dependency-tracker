// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Violation Cache Service — routing and boot ────────────────────────────────
// This file is deliberately thin: it wires modules together, runs the boot
// sequence and dispatches requests. All behaviour lives under lib/ and routes/
// (CLAUDE.md §2, §6.1).
//
// Endpoints:
//   POST   /auth/register  /auth/login  /auth/logout  /auth/check-availability
//   GET    /auth/me
//   DELETE /auth/account
//   GET    /profile                             — signed-in user's details
//   PUT    /profile                             — update name / password
//   GET    /admin/users                         — accounts and their counts (administrator)
//   GET    /admin/overview                      — service-wide totals (administrator)
//   GET    /admin/users/:loginId                — one account's detail (administrator)
//   GET    /violation-cache/status              — build state for this user's connection
//   GET    /violation-cache/data                — the cached map (gzipped)
//   POST   /violation-cache/refresh             — trigger a background rebuild
//   GET    /violation-cache/config              — connection + settings + mail + schedule
//   POST   /violation-cache/config              — save any subset of the above
//   DELETE /violation-cache/config/dt-key       — forget the stored DT API key
//   POST   /violation-cache/config/test-connection — probe DT before saving
//   POST   /violation-cache/config/test-email   — send a test email
//   GET    /violation-cache/dt/api/v1/…         — read proxy to this user's DT
//   POST   /violation-cache/report/generate     — start a report job
//   GET    /violation-cache/report/list         — this user's reports
//   DELETE /violation-cache/report/:id          — delete a report and its bytes
//   GET    /violation-cache/report/:id/download — stream the workbook
//   POST   /violation-cache/report/:id/cancel   — cancel a running job
//   POST   /violation-cache/schedule/arm        — arm this user's schedule
//   GET    /violation-cache/schedule/status     — schedule state
//   DELETE /violation-cache/schedule            — disable the schedule
//   POST   /violation-cache/schedule/ack-notification — clear a failure notice
//
// Environment variables are documented in lib/config.js and .env.example.

const http = require('http');

const { load: loadEnvConfig, ConfigError } = require('./lib/config');
const { log, configure: configureLog }     = require('./lib/log');
const { jsonReply }                        = require('./lib/http-util');
const { readLegacyConnection }             = require('./lib/env-file');

const pool        = require('./db/pool');
const { migrate } = require('./db/migrate');

const cryptoLib     = require('./lib/crypto');
const cache         = require('./lib/violation-cache');
const caches        = require('./lib/caches');
const reports       = require('./lib/reports');
const reportsDb     = require('./lib/reports-db');
const scheduler     = require('./lib/scheduler');
const schedulesDb   = require('./lib/schedules');
const auth          = require('./lib/auth');
const admin         = require('./lib/admin');
const dtConnections = require('./lib/dt-connections');
const mailSettings  = require('./lib/mail-settings');

const routeModules = [
  require('./routes/auth'),
  require('./routes/profile'),
  require('./routes/admin'),
  require('./routes/dt-proxy'),
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

cache.configure({ cacheTtlMs: cfg.cacheTtlMs, jobStallMs: cfg.jobStallMs });
reports.configure({
  reportConcurrency:    cfg.reportConcurrency,
  violationConcurrency: cfg.violationConcurrency,
});

// Context handed to every route module. Per-user values are never put here —
// module scope holds only genuinely global state (CLAUDE.md §7.5).
const routeDeps = { paths: cfg.paths };

// ── Request dispatch ──────────────────────────────────────────────────────────
// Each route module is asked in turn and returns true once it has answered.
// Authentication runs before the first module, so a new route is authenticated
// by default (CLAUDE.md §6.6).
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

// ── Housekeeping ──────────────────────────────────────────────────────────────
// One timer for all retention work. Nothing here is per-user: with N users this
// is still one timer, which is the whole point (CLAUDE.md §13).
const HOUSEKEEPING_INTERVAL_MS = 10 * 60_000;
const RUN_HISTORY_RETENTION_DAYS = 90;

let housekeepingTimer = null;

async function housekeeping() {
  await auth.sweep();
  try {
    const runs = await schedulesDb.purgeRunsOlderThan(RUN_HISTORY_RETENTION_DAYS);
    const swept = await caches.sweepOrphaned();
    if (runs || swept) log('info', 'Housekeeping complete', { scheduleRuns: runs, caches: swept });
  } catch (e) {
    log('warn', `Housekeeping failed: ${e.message}`);
  }
}

// ── Boot sequence ─────────────────────────────────────────────────────────────
async function boot() {
  // Step 2: connection pool.
  pool.init(cfg.db);
  pool.onError(err => log('error', `Idle database client error: ${err.message}`));
  log('info', 'Database pool created', {
    host: cfg.db.host, port: cfg.db.port, database: cfg.db.database, max: cfg.db.max,
  });

  // Step 3: migrations. The listener must not start until these complete.
  await migrate({ pool: pool.getPool(), log });

  // Step 4: credentials and secrets.
  auth.configure(cfg);
  admin.load(cfg.paths.adminCreds);

  // S23: the encryption key is parsed once and handed to the two modules that
  // store secrets. Nothing else in the process holds it.
  const encryptionKey = cryptoLib.parseEncryptionKey(cfg.secretEncryptionKey);
  dtConnections.configure(encryptionKey);
  mailSettings.configure(encryptionKey);

  // Step 4b: one-shot seed of existing accounts from a pre-multi-user .env, so
  // upgrading a working deployment does not silently drop everyone back to
  // demo data. Guarded by system_state — it can only ever run once.
  const legacy = readLegacyConnection(cfg.envFile, cfg.legacyDt);
  const seeded = await dtConnections.migrateLegacyConnection(legacy);
  if (seeded.ran) log('info', 'Legacy DT connection migrated', { accounts: seeded.seeded });

  // Step 5: recover from a restart, then start background timers.
  // Both sweeps run before the listener starts, so nothing can be legitimately
  // in flight: anything still marked running belongs to the process that died.
  await reportsDb.failOrphaned();
  await caches.failOrphanedBuilds();
  await scheduler.start();
  housekeepingTimer = setInterval(() => { housekeeping(); }, HOUSEKEEPING_INTERVAL_MS);
  if (housekeepingTimer.unref) housekeepingTimer.unref();
  setTimeout(() => housekeeping(), 5_000).unref();

  // Step 6: accept requests.
  await new Promise((resolve) => server.listen(cfg.port, resolve));

  log('info', `Violation cache service listening on :${cfg.port}`);
  log('info', 'Authentication', {
    adminLogin:   admin.isEnabled() ? 'enabled' : 'DISABLED',
    sessionHours: `${cfg.session.absoluteHours} absolute / ${cfg.session.idleHours} idle`,
    enforcedOn:   'all routes',
    publicPaths:  [...PUBLIC_PATHS].join(', '),
  });
  log('info', 'Startup configuration', {
    cacheTtlHrs:          cfg.cacheTtlMs / 3_600_000,
    reportConcurrency:    cfg.reportConcurrency,
    violationConcurrency: cfg.violationConcurrency,
    jobStallMinutes:      cfg.jobStallMs / 60_000,
    schedulerPollSeconds: scheduler.POLL_INTERVAL_MS / 1000,
    logFormat:            cfg.logFormat,
    // Connections are per-user now; there is no service-wide DT URL or key to
    // report, and none is ever logged (CLAUDE.md §6.5).
    dtConnections:        'per user (encrypted at rest)',
  });
}

// ── Shutdown ──────────────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `Received ${signal} — shutting down`);
  scheduler.stop();
  if (housekeepingTimer) clearInterval(housekeepingTimer);
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
