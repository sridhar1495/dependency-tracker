// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Environment configuration ─────────────────────────────────────────────────
// Single place where process.env is read and validated.  The boot sequence calls
// load() first and fails fast with an actionable message, so a misconfigured
// container never reaches the point of accepting requests (CLAUDE.md §6.1).
//
// parseConfig(env) is pure and takes the environment as a parameter so it can be
// unit-tested without mutating process.env.

const path = require('path');

// Q12: defaults live here rather than being scattered through the modules that
// consume them, so a reader can see the whole tuneable surface in one place.
const DEFAULTS = {
  PORT:                      '3001',
  LOG_FORMAT:                'text',
  CACHE_DIR:                 '/data',
  ENV_FILE:                  '/app/.env',
  CACHE_TTL_HOURS:           '24',
  REPORT_CONCURRENCY:        '5',
  VIOLATION_CONCURRENCY:     '3',
  SCHEDULER_CONCURRENCY:     '5',
  VIOLATION_JOB_STALL_MINUTES: '15',
  POSTGRES_HOST:             'dt-postgres',
  POSTGRES_PORT:             '5432',
  POSTGRES_USER:             'dtdash',
  POSTGRES_DB:               'dtdash',
  SESSION_ABSOLUTE_HOURS:    '8',
  SESSION_IDLE_HOURS:        '2',
};

// Pool sizing and timeouts are fixed by the design (CLAUDE.md §5.2) rather than
// exposed as environment variables — they are tuned against the server's
// max_connections and changing one without the other is a footgun.
const POOL_MAX                       = 15;
const STATEMENT_TIMEOUT_MS           = 30_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
  }
}

/** Read a value, falling back to the documented default. */
function raw(env, key) {
  const v = env[key];
  return (v === undefined || v === null || v === '') ? DEFAULTS[key] : String(v);
}

/** Parse a positive integer, or throw a message naming the variable. */
function positiveInt(env, key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = raw(env, key);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(
      `${key} must be an integer between ${min} and ${max} (received "${value}")`
    );
  }
  return n;
}

/** Parse a non-empty string, or throw. */
function requiredString(env, key, hint) {
  const value = raw(env, key);
  if (!value || !String(value).trim()) {
    throw new ConfigError(`${key} is required but was not set.${hint ? ` ${hint}` : ''}`);
  }
  return String(value).trim();
}

/**
 * Build the effective configuration from an environment object.
 * Pure — no process.env access, no I/O — so it is directly unit-testable.
 *
 * @param {object} env  typically process.env
 * @returns {object} frozen configuration
 * @throws {ConfigError} on any missing or malformed value
 */
function parseConfig(env) {
  const cacheDir = raw(env, 'CACHE_DIR');
  const logFormat = raw(env, 'LOG_FORMAT');
  if (logFormat !== 'text' && logFormat !== 'json') {
    throw new ConfigError(`LOG_FORMAT must be "text" or "json" (received "${logFormat}")`);
  }

  const cfg = {
    port:      positiveInt(env, 'PORT', { min: 1, max: 65535 }),
    logFormat,
    cacheDir,
    envFile:   raw(env, 'ENV_FILE'),

    // Paths derived once so no module recomputes them. Only the administrator
    // credentials file remains on disk — caches, app config, reports and
    // scheduled reports all moved into PostgreSQL (CLAUDE.md §5.6).
    paths: {
      adminCreds: path.join(cacheDir, 'admin-credentials.json'),
    },

    cacheTtlMs:           positiveInt(env, 'CACHE_TTL_HOURS', { min: 1, max: 8760 }) * 3_600_000,
    reportConcurrency:    positiveInt(env, 'REPORT_CONCURRENCY', { min: 1, max: 50 }),
    violationConcurrency: positiveInt(env, 'VIOLATION_CONCURRENCY', { min: 1, max: 50 }),

    // How many scheduled reports may build at once, across all accounts. Each
    // one is still limited to reportConcurrency upstream calls, so the total
    // load on DependencyTrack is the product of the two — raising this without
    // knowing where DT's knee is buys 5xx responses and retries, not speed.
    // Capped at 50 for the same reason the other two are.
    schedulerConcurrency: positiveInt(env, 'SCHEDULER_CONCURRENCY', { min: 1, max: 50 }),

    // How long a violation-cache build may go WITHOUT advancing a page before it
    // is presumed wedged. This is not a cap on how long a build may take: a
    // large portfolio that keeps making progress runs to completion however long
    // that needs (CLAUDE.md §6.3).
    jobStallMs:           positiveInt(env, 'VIOLATION_JOB_STALL_MINUTES', { min: 1, max: 1440 }) * 60_000,

    // S1: session lifetimes, enforced from phase 2 onward.
    session: {
      absoluteHours: positiveInt(env, 'SESSION_ABSOLUTE_HOURS', { min: 1, max: 720 }),
      idleHours:     positiveInt(env, 'SESSION_IDLE_HOURS', { min: 1, max: 720 }),
    },

    // S16: AES-256-GCM key for DT API keys and SMTP passwords. Mandatory from
    // phase 4, which is the point at which secrets are actually stored: without
    // it a user could save an API key that could never be read back. The format
    // is validated here so a malformed key fails at boot rather than at the
    // moment someone first saves one.
    secretEncryptionKey: requiredString(
      env, 'SECRET_ENCRYPTION_KEY',
      'It is generated by install.sh and encrypts stored DependencyTrack API keys and SMTP passwords.'
    ),

    db: {
      host:     raw(env, 'POSTGRES_HOST'),
      port:     positiveInt(env, 'POSTGRES_PORT', { min: 1, max: 65535 }),
      user:     raw(env, 'POSTGRES_USER'),
      database: raw(env, 'POSTGRES_DB'),
      password: requiredString(
        env, 'POSTGRES_PASSWORD',
        'It is generated by install.sh and passed through docker-compose.'
      ),
      max: POOL_MAX,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },

    // Legacy single-tenant DT connection. The service no longer reads these at
    // request time — they exist solely so a deployment upgrading from the
    // single-tenant build can seed its existing accounts once, after which the
    // marker in system_state stops them ever being read again.
    legacyDt: {
      apiUrl:      (env.DT_API_URL || '').replace(/\/$/, ''),
      apiKey:      (env.DT_API_KEY || '').replace(/[\x00-\x1F\x7F]/g, '').trim(),
      frontendUrl: (env.DT_FRONTEND_URL || '').replace(/\/$/, ''),
    },
  };

  if (cfg.session.idleHours > cfg.session.absoluteHours) {
    throw new ConfigError(
      `SESSION_IDLE_HOURS (${cfg.session.idleHours}) cannot exceed ` +
      `SESSION_ABSOLUTE_HOURS (${cfg.session.absoluteHours}) — the idle window would never be reached`
    );
  }

  // Validate the encryption key's shape now if one was supplied, so a malformed
  // value fails at boot rather than when a user first saves a secret.
  if (cfg.secretEncryptionKey !== null) {
    const raw = String(cfg.secretEncryptionKey).trim();
    const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
      ? 32
      : Buffer.from(raw, 'base64').length;
    if (bytes !== 32) {
      throw new ConfigError(
        'SECRET_ENCRYPTION_KEY must decode to 32 bytes — supply 64 hex characters ' +
        'or a base64 value of 32 bytes. install.sh generates one.'
      );
    }
  }

  return Object.freeze(cfg);
}

/** Build the configuration from the real environment. */
function load(env = process.env) {
  return parseConfig(env);
}

module.exports = { parseConfig, load, ConfigError, DEFAULTS };
