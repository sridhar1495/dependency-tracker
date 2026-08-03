// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Migration runner ──────────────────────────────────────────────────────────
// Applies the numbered .sql files in db/migrations/ that have not yet been
// recorded in schema_migrations (CLAUDE.md §5.3).
//
// Guarantees:
//   • Serialised by a session-level advisory lock, so two containers starting at
//     the same time cannot both apply the same migration.
//   • Each migration runs inside its own transaction together with the ledger
//     insert, so a failure leaves neither the schema change nor the record.
//   • Runs to completion before the HTTP listener starts.
//
// Migration files are append-only. A merged migration is never edited — write a
// new one instead.

const fs   = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Q13: a fixed key so every replica contends for the same lock. The value is
// arbitrary but must never change, or the mutual exclusion is lost.
const ADVISORY_LOCK_KEY = 4_027_180_115;

const FILENAME_RE = /^(\d{3,})_[a-z0-9_]+\.sql$/;

/**
 * List migration files in application order.
 * Rejects a directory containing duplicate version numbers, which would
 * otherwise apply non-deterministically depending on filesystem ordering.
 *
 * @param {string} dir
 * @returns {{ version: number, name: string, file: string }[]}
 */
function listMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];

  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.sql')) continue;
    const m = FILENAME_RE.exec(name);
    if (!m) {
      throw Object.assign(
        new Error(`Migration filename "${name}" must match NNN_snake_case.sql`),
        { code: 'MIGRATION_BAD_NAME' }
      );
    }
    entries.push({ version: parseInt(m[1], 10), name, file: path.join(dir, name) });
  }

  entries.sort((a, b) => a.version - b.version);

  for (let i = 1; i < entries.length; i++) {
    if (entries[i].version === entries[i - 1].version) {
      throw Object.assign(
        new Error(
          `Duplicate migration version ${entries[i].version}: ` +
          `"${entries[i - 1].name}" and "${entries[i].name}"`
        ),
        { code: 'MIGRATION_DUPLICATE_VERSION' }
      );
    }
  }

  return entries;
}

/** Create the ledger if this is a fresh database. */
async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     integer     PRIMARY KEY,
      name        text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** Versions already applied, as a Set of integers. */
async function appliedVersions(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations');
  return new Set(rows.map(r => r.version));
}

/**
 * Apply all pending migrations.
 *
 * @param {object}   opts
 * @param {import('pg').Pool} opts.pool
 * @param {string}   [opts.dir]  migrations directory (overridable for tests)
 * @param {Function} [opts.log]  log(level, message, meta)
 * @returns {Promise<{ applied: string[], alreadyApplied: number }>}
 */
async function migrate({ pool, dir = MIGRATIONS_DIR, log = () => {} }) {
  const migrations = listMigrations(dir);

  // A dedicated client held for the whole run: an advisory lock taken with
  // pg_advisory_lock is session-scoped, so it must not be returned to the pool
  // between acquiring and releasing it.
  const client = await pool.connect();
  const applied = [];

  try {
    // P7: migrations may build indexes on large tables, which can legitimately
    // exceed the 30 s statement_timeout the pool sets for normal queries.
    await client.query('SET statement_timeout = 0');
    await client.query('SET idle_in_transaction_session_timeout = 0');

    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    log('info', 'Migration lock acquired');

    await ensureLedger(client);
    const done = await appliedVersions(client);
    const pending = migrations.filter(m => !done.has(m.version));

    if (pending.length === 0) {
      log('info', 'Database schema up to date', { applied: done.size });
      return { applied, alreadyApplied: done.size };
    }

    log('info', `Applying ${pending.length} migration(s)`, {
      pending: pending.map(m => m.name),
    });

    for (const m of pending) {
      const sql = fs.readFileSync(m.file, 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [m.version, m.name]
        );
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection already dead */ }
        throw Object.assign(
          new Error(`Migration ${m.name} failed: ${err.message}`),
          { code: 'MIGRATION_FAILED', cause: err, migration: m.name }
        );
      }
      applied.push(m.name);
      log('info', `Applied migration ${m.name}`);
    }

    return { applied, alreadyApplied: done.size };
  } finally {
    // Release before returning the client, otherwise the lock survives on a
    // pooled session and the next boot blocks forever.
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } catch (_) { /* connection already dead; the lock dies with the session */ }
    client.release();
  }
}

module.exports = { migrate, listMigrations, MIGRATIONS_DIR, ADVISORY_LOCK_KEY };
