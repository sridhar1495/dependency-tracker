// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Database integration tier — OPT-IN.
//
//   TEST_DATABASE_URL=postgres://user:pass@host:5432/dbname \
//     node --test violation-cache/db.test.js
//
// Skipped entirely when TEST_DATABASE_URL is unset so the default `node --test`
// run stays offline and needs no database or Docker (CLAUDE.md §10.2).
//
// These tests create their own throwaway schema and drop it afterwards. They
// never assume pre-existing data.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const DB_URL  = process.env.TEST_DATABASE_URL;
const ENABLED = Boolean(DB_URL);

// Modules under test perform no I/O at require time, so importing them directly
// is safe and is the preferred approach for new code (CLAUDE.md §10.3).
const { migrate, listMigrations, MIGRATIONS_DIR } = require('./db/migrate');

let pg = null;
let pool = null;

if (ENABLED) pg = require('pg');

// ── Helpers ───────────────────────────────────────────────────────────────────
function tmpMigrationsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-migrations-'));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql, 'utf8');
  }
  return dir;
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* already gone */ }
}

/** Drop everything this suite may have created, so runs are repeatable. */
async function resetSchema() {
  await pool.query('DROP TABLE IF EXISTS schema_migrations');
  await pool.query('DROP TABLE IF EXISTS _mig_probe_a');
  await pool.query('DROP TABLE IF EXISTS _mig_probe_b');
  await pool.query('DROP TABLE IF EXISTS _lock_probe');
}

// ── Pure tests — these run even without a database ───────────────────────────
describe('listMigrations (no database required)', () => {
  test('returns files sorted by numeric version, not lexically', () => {
    const dir = tmpMigrationsDir({
      '002_second.sql': '-- b',
      '010_tenth.sql':  '-- j',
      '001_first.sql':  '-- a',
    });
    try {
      const found = listMigrations(dir);
      assert.deepEqual(found.map(m => m.version), [1, 2, 10]);
      assert.deepEqual(found.map(m => m.name), ['001_first.sql', '002_second.sql', '010_tenth.sql']);
    } finally { cleanupDir(dir); }
  });

  test('rejects a filename that does not match NNN_snake_case.sql', () => {
    const dir = tmpMigrationsDir({ 'add-users.sql': '-- nope' });
    try {
      assert.throws(() => listMigrations(dir), (e) => e.code === 'MIGRATION_BAD_NAME');
    } finally { cleanupDir(dir); }
  });

  test('rejects duplicate version numbers', () => {
    const dir = tmpMigrationsDir({ '001_a.sql': '-- a', '001_b.sql': '-- b' });
    try {
      assert.throws(() => listMigrations(dir), (e) => e.code === 'MIGRATION_DUPLICATE_VERSION');
    } finally { cleanupDir(dir); }
  });

  test('ignores non-.sql files', () => {
    const dir = tmpMigrationsDir({ '001_a.sql': '-- a', 'README.md': '# notes' });
    try {
      assert.equal(listMigrations(dir).length, 1);
    } finally { cleanupDir(dir); }
  });

  test('returns an empty list for a directory that does not exist', () => {
    assert.deepEqual(listMigrations('/nonexistent/path/xyz'), []);
  });

  test('the shipped migrations directory is well formed', () => {
    const found = listMigrations(MIGRATIONS_DIR);
    assert.ok(found.length >= 1, 'expected at least 001_init.sql');
    assert.equal(found[0].name, '001_init.sql');
  });
});

// ── Integration tier ─────────────────────────────────────────────────────────
describe('migration runner against PostgreSQL', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 5 });
    await resetSchema();
  });

  after(async () => {
    if (pool) { await resetSchema(); await pool.end(); }
  });

  test('applies pending migrations and records them in the ledger', async () => {
    const dir = tmpMigrationsDir({
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS _mig_probe_a (id int PRIMARY KEY);',
      '002_b.sql': 'CREATE TABLE IF NOT EXISTS _mig_probe_b (id int PRIMARY KEY);',
    });
    try {
      const result = await migrate({ pool, dir });
      assert.deepEqual(result.applied, ['001_a.sql', '002_b.sql']);
      assert.equal(result.alreadyApplied, 0);

      const { rows } = await pool.query('SELECT version, name FROM schema_migrations ORDER BY version');
      assert.deepEqual(rows.map(r => r.version), [1, 2]);

      const t = await pool.query("SELECT to_regclass('_mig_probe_a') AS a, to_regclass('_mig_probe_b') AS b");
      assert.ok(t.rows[0].a, '_mig_probe_a should exist');
      assert.ok(t.rows[0].b, '_mig_probe_b should exist');
    } finally { cleanupDir(dir); }
  });

  test('is idempotent — a second run applies nothing', async () => {
    const dir = tmpMigrationsDir({
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS _mig_probe_a (id int PRIMARY KEY);',
      '002_b.sql': 'CREATE TABLE IF NOT EXISTS _mig_probe_b (id int PRIMARY KEY);',
    });
    try {
      const result = await migrate({ pool, dir });
      assert.deepEqual(result.applied, []);
      assert.equal(result.alreadyApplied, 2);
    } finally { cleanupDir(dir); }
  });

  test('applies only the new migration when one is appended', async () => {
    const dir = tmpMigrationsDir({
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS _mig_probe_a (id int PRIMARY KEY);',
      '002_b.sql': 'CREATE TABLE IF NOT EXISTS _mig_probe_b (id int PRIMARY KEY);',
      '003_c.sql': 'ALTER TABLE _mig_probe_a ADD COLUMN IF NOT EXISTS label text;',
    });
    try {
      const result = await migrate({ pool, dir });
      assert.deepEqual(result.applied, ['003_c.sql']);

      const col = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='_mig_probe_a' AND column_name='label'"
      );
      assert.equal(col.rowCount, 1);
    } finally { cleanupDir(dir); }
  });

  test('a failing migration rolls back and is not recorded', async () => {
    const dir = tmpMigrationsDir({
      '004_bad.sql': 'CREATE TABLE _mig_probe_bad (id int); SELECT this_function_does_not_exist();',
    });
    try {
      await assert.rejects(
        () => migrate({ pool, dir }),
        (e) => e.code === 'MIGRATION_FAILED' && /004_bad\.sql/.test(e.message)
      );

      const ledger = await pool.query('SELECT version FROM schema_migrations WHERE version = 4');
      assert.equal(ledger.rowCount, 0, 'failed migration must not be recorded');

      const tbl = await pool.query("SELECT to_regclass('_mig_probe_bad') AS t");
      assert.equal(tbl.rows[0].t, null, 'table from the failed migration must be rolled back');
    } finally { cleanupDir(dir); }
  });

  test('the advisory lock serialises concurrent runners — each migration applies once', async () => {
    const dir = tmpMigrationsDir({
      '005_lock.sql': 'CREATE TABLE IF NOT EXISTS _lock_probe (id int PRIMARY KEY);',
    });
    try {
      // Five runners race for the same pending migration.
      const results = await Promise.all(
        Array.from({ length: 5 }, () => migrate({ pool, dir }))
      );
      const totalApplied = results.reduce((sum, r) => sum + r.applied.length, 0);
      assert.equal(totalApplied, 1, 'exactly one runner should have applied the migration');

      const ledger = await pool.query('SELECT count(*)::int AS n FROM schema_migrations WHERE version = 5');
      assert.equal(ledger.rows[0].n, 1, 'ledger must contain exactly one row for version 5');
    } finally { cleanupDir(dir); }
  });

  test('the advisory lock is released after a run', async () => {
    const dir = tmpMigrationsDir({ '006_noop.sql': 'SELECT 1;' });
    try {
      await migrate({ pool, dir });
      const held = await pool.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'"
      );
      assert.equal(held.rows[0].n, 0, 'no advisory lock should remain held');
    } finally { cleanupDir(dir); }
  });

  test('the shipped 001_init.sql installs the citext extension', async () => {
    await pool.query('DROP TABLE IF EXISTS schema_migrations');
    await migrate({ pool, dir: MIGRATIONS_DIR });
    const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'citext'");
    assert.equal(ext.rowCount, 1, 'citext must be installed');

    // citext is what gives case-insensitive uniqueness in phase 1.
    const cmp = await pool.query("SELECT ('Alice'::citext = 'alice'::citext) AS same");
    assert.equal(cmp.rows[0].same, true);
  });
});

// ── Pool helpers ─────────────────────────────────────────────────────────────
describe('pool tx() helper', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  let dbPool;

  before(async () => {
    // db/pool.js is a singleton wired at boot; here we exercise the same
    // semantics against a throwaway pool so the test never touches process state.
    dbPool = new pg.Pool({ connectionString: DB_URL, max: 5 });
    await dbPool.query('CREATE TABLE IF NOT EXISTS _tx_probe (v int)');
    await dbPool.query('TRUNCATE _tx_probe');
  });

  after(async () => {
    if (dbPool) { await dbPool.query('DROP TABLE IF EXISTS _tx_probe'); await dbPool.end(); }
  });

  /** Same implementation as db/pool.js tx(), bound to the throwaway pool. */
  async function tx(fn) {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection dead */ }
      throw err;
    } finally { client.release(); }
  }

  test('commits when the callback resolves', async () => {
    await tx(async (c) => { await c.query('INSERT INTO _tx_probe VALUES (1)'); });
    const { rows } = await dbPool.query('SELECT count(*)::int AS n FROM _tx_probe');
    assert.equal(rows[0].n, 1);
  });

  test('rolls back every statement when the callback throws', async () => {
    await assert.rejects(() => tx(async (c) => {
      await c.query('INSERT INTO _tx_probe VALUES (2)');
      await c.query('INSERT INTO _tx_probe VALUES (3)');
      throw new Error('boom');
    }), /boom/);

    const { rows } = await dbPool.query('SELECT count(*)::int AS n FROM _tx_probe');
    assert.equal(rows[0].n, 1, 'the two inserts must both be rolled back');
  });

  test('returns the callback result', async () => {
    const out = await tx(async (c) => (await c.query('SELECT 42 AS answer')).rows[0].answer);
    assert.equal(out, 42);
  });
});
