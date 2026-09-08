// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── End-to-end stack ──────────────────────────────────────────────────────────
// Brings up everything the product needs and nothing it does not: a real
// PostgreSQL (the operator's, via TEST_DATABASE_URL), the real server.js, the
// real dashboard pages behind an nginx-equivalent, and stubs for the only two
// things that are genuinely external — DependencyTrack and SMTP.
//
// Two deliberate choices:
//
//   server.js runs as a CHILD PROCESS. CLAUDE.md §10.4 forbids importing it —
//   it would start an HTTP server inside the test runner — and a child process
//   is also what the container actually does, boot sequence and all.
//
//   Everything else runs IN-PROCESS. The stubs and the proxy are a few dozen
//   lines of `http`/`net` each, so spawning them would buy nothing and cost
//   port files, orphan processes and a class of flakiness that has no upside.
//
// Ports are assigned by the OS, never hard-coded, so a run cannot collide with
// a developer's running stack or with a parallel CI job.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dtStub = require('./dt-stub');
const smtpStub = require('./smtp-stub');
const webProxy = require('./web-proxy');

const APP_DIR = path.join(__dirname, '..');

/** Administrator credentials the suite signs in with. */
const ADMIN = { loginId: 'admin', password: 'E2eAdmin@Passw0rd' };

/** Ask the OS for a free port, then let it go. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** scrypt hash in the stored format, as install.sh writes it (CLAUDE.md §7.1). */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, dk) => {
      if (err) return reject(err);
      resolve(`scrypt$16384$8$1$${salt.toString('base64')}$${dk.toString('base64')}`);
    });
  });
}

/**
 * Drop and recreate the public schema, so every run starts from a fresh
 * install rather than from whatever the last one left behind.
 *
 * This DESTROYS the contents of the database TEST_DATABASE_URL points at —
 * the same contract db.test.js already has. Point it at a throwaway database.
 */
async function resetSchema(databaseUrl) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
}

/** Parse TEST_DATABASE_URL into the environment variables server.js reads. */
function dbEnv(databaseUrl) {
  const u = new URL(databaseUrl);
  return {
    POSTGRES_HOST: u.hostname,
    POSTGRES_PORT: u.port || '5432',
    POSTGRES_USER: decodeURIComponent(u.username),
    POSTGRES_PASSWORD: decodeURIComponent(u.password) || 'x',
    POSTGRES_DB: u.pathname.replace(/^\//, ''),
  };
}

/**
 * Start the whole stack.
 *
 * @param {object} [opts]
 * @param {string} [opts.databaseUrl] defaults to TEST_DATABASE_URL
 * @param {boolean} [opts.verbose] stream the backend's log to stderr
 */
async function start(opts = {}) {
  const databaseUrl = opts.databaseUrl || process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required to start the e2e stack');

  await resetSchema(databaseUrl);

  const dt = await dtStub.start();
  const smtp = await smtpStub.start();

  // /data equivalent: the administrator credentials file and nothing else
  // (CLAUDE.md §5.6).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-e2e-'));
  fs.writeFileSync(
    path.join(dataDir, 'admin-credentials.json'),
    JSON.stringify({
      loginId: ADMIN.loginId, firstName: 'End', lastName: 'ToEnd',
      passwordHash: await hashPassword(ADMIN.password),
    }, null, 2),
    { mode: 0o600 }
  );

  const apiPort = await freePort();
  const logLines = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      ...dbEnv(databaseUrl),
      PORT: String(apiPort),
      CACHE_DIR: dataDir,
      LOG_FORMAT: 'json',
      // A 32-byte key in the documented hex form. Fixed rather than random so a
      // failed run's database can still be opened by hand afterwards.
      SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
      // Nothing to seed: this is a fresh install, not an upgrade.
      DT_API_URL: '', DT_API_KEY: '', DT_FRONTEND_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (buf) => {
    const text = buf.toString();
    logLines.push(text);
    if (opts.verbose) process.stderr.write(text);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const web = await webProxy.start({ apiPort });

  // Wait for the listener. Migrations run before it opens (CLAUDE.md §6.1), so
  // a healthy /healthz means the schema is ready too.
  const deadline = Date.now() + 60000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`${web.url}/healthz`);
      if (r.ok) { up = true; break; }
    } catch (_) { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!up) {
    const log = logLines.join('');
    await stopChild(child);
    await Promise.all([dt.close(), smtp.close(), web.close()]);
    throw new Error(`the backend did not become healthy.\n--- backend log ---\n${log}`);
  }

  return {
    url: web.url,
    apiPort,
    dt,
    smtp,
    dataDir,
    databaseUrl,
    admin: { ...ADMIN },
    /** The backend's log so far, for diagnosing a failure. */
    log: () => logLines.join(''),
    stop: async () => {
      await stopChild(child);
      await Promise.all([dt.close(), smtp.close(), web.close()]);
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

/** SIGTERM, then SIGKILL if it will not go. */
function stopChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(kill); resolve(); });
    child.kill('SIGTERM');
  });
}

module.exports = { start, resetSchema, freePort, hashPassword, ADMIN };
