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

// lib/config.js requires an encryption key from phase 4 onward. Any valid
// 32-byte value works here — these tests exercise storage and isolation, not
// the key material itself.
process.env.SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY || 'f'.repeat(64);

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

// ── Schema and data-access tier (phase 1) ────────────────────────────────────
// These exercise the real modules against a real database. The pool singleton is
// initialised once here; every test scopes its own data and cleans up after.

describe('schema and data access', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  let pool, users, sessions, audit;

  // A 32-byte SHA-256-shaped hash, as the token_hash CHECK requires.
  const hashOf = (s) => require('node:crypto').createHash('sha256').update(s).digest();

  before(async () => {
    const url = new URL(DB_URL);
    process.env.POSTGRES_HOST     = url.hostname;
    process.env.POSTGRES_PORT     = url.port || '5432';
    process.env.POSTGRES_USER     = decodeURIComponent(url.username);
    process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password) || 'x';
    process.env.POSTGRES_DB       = url.pathname.replace(/^\//, '');

    const { parseConfig } = require('./lib/config');
    pool = require('./db/pool');
    pool.init(parseConfig(process.env).db);

    await migrate({ pool: pool.getPool(), dir: MIGRATIONS_DIR });

    users    = require('./lib/users');
    sessions = require('./lib/sessions');
    audit    = require('./lib/login-audit');
  });

  after(async () => {
    if (pool) {
      await pool.query("DELETE FROM users WHERE login_id LIKE 'zz_%'");
      await pool.query("DELETE FROM login_audit WHERE login_id_attempted LIKE 'zz_%'");
      await pool.query("DELETE FROM user_sessions WHERE principal_type = 'admin'");
      await pool.close();
    }
  });

  const newUser = (suffix, email) => ({
    loginId: `zz_${suffix}`,
    email: email === undefined ? `zz_${suffix}@example.com` : email,
    firstName: 'Ada', lastName: 'Lovelace', passwordHash: 'scrypt$16384$8$1$c2FsdA==$ZGs=',
  });

  test('create() seeds every dependent configuration row in one transaction', async () => {
    const u = await users.create(newUser('seed'));
    assert.ok(u.id);
    assert.equal(u.loginId, 'zz_seed');
    assert.equal(u.firstName, 'Ada');
    assert.equal(u.passwordHash, undefined, 'password hash must not be returned');

    for (const t of ['dt_connections', 'user_settings', 'mail_settings', 'schedules']) {
      const { rows } = await pool.query(`SELECT 1 FROM ${t} WHERE user_id = $1`, [u.id]);
      assert.equal(rows.length, 1, `${t} row should have been seeded`);
    }

    const cfg = await pool.query(
      'SELECT is_configured AS c FROM dt_connections WHERE user_id = $1', [u.id]
    );
    assert.equal(cfg.rows[0].c, false, 'a new account starts unconfigured, so it sees mock data');

    // A new account inherits the administrator's default rather than storing a
    // copy of it. A stored 10 could not be told apart from a deliberate 10, so
    // raising the default would skip everybody who happened to sit on the old
    // one (migration 005).
    const st = await pool.query('SELECT max_reports AS m FROM user_settings WHERE user_id = $1', [u.id]);
    assert.equal(st.rows[0].m, null, 'the seeded row must inherit, not pin');
    const eff = await pool.query(
      `SELECT COALESCE(s.max_reports, a.default_max_reports) AS m
         FROM user_settings s CROSS JOIN app_settings a
        WHERE s.user_id = $1 AND a.id = TRUE`, [u.id]);
    assert.equal(eff.rows[0].m, 10, 'and resolve to the global default');
  });

  test('duplicate login ID is rejected with a field-aware error', async () => {
    await users.create(newUser('dup', null));
    await assert.rejects(
      () => users.create({ ...newUser('other', null), loginId: 'zz_dup' }),
      (e) => e.code === 'ALREADY_REGISTERED' && e.field === 'loginId'
    );
  });

  test('duplicate login ID differing only in case is rejected (citext)', async () => {
    await assert.rejects(
      () => users.create({ ...newUser('other2', null), loginId: 'ZZ_DUP' }),
      (e) => e.code === 'ALREADY_REGISTERED' && e.field === 'loginId'
    );
  });

  test('duplicate email is rejected and names the email field', async () => {
    await users.create(newUser('mail1', 'shared@example.com'));
    await assert.rejects(
      () => users.create({ ...newUser('mail2', 'SHARED@example.com') }),
      (e) => e.code === 'ALREADY_REGISTERED' && e.field === 'email'
    );
  });

  test('a rejected registration leaves no partial rows behind', async () => {
    const before = await pool.query('SELECT count(*)::int n FROM dt_connections');
    await assert.rejects(() => users.create({ ...newUser('x', null), loginId: 'zz_dup' }));
    const after = await pool.query('SELECT count(*)::int n FROM dt_connections');
    assert.equal(after.rows[0].n, before.rows[0].n, 'the transaction must have rolled back');
  });

  test('multiple accounts may omit the email address', async () => {
    await users.create(newUser('noemail1', null));
    await users.create(newUser('noemail2', null));
    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM users WHERE login_id LIKE 'zz_noemail%' AND email IS NULL"
    );
    assert.equal(rows[0].n, 2, 'NULL emails must not collide');
  });

  test('availability checks are case-insensitive', async () => {
    assert.equal(await users.isLoginIdAvailable('zz_dup'), false);
    assert.equal(await users.isLoginIdAvailable('ZZ_DUP'), false);
    assert.equal(await users.isLoginIdAvailable('zz_definitely_free'), true);
    assert.equal(await users.isEmailAvailable('shared@example.com'), false);
    assert.equal(await users.isEmailAvailable('free@example.com'), true);
    assert.equal(await users.isEmailAvailable(null), true, 'no email is always available');
  });

  test('updateProfile changes names but ignores login ID and email', async () => {
    const u = await users.create(newUser('profile', null));
    const updated = await users.updateProfile(u.id, {
      firstName: 'Grace', lastName: 'Hopper',
      loginId: 'zz_hacked', email: 'hacked@example.com', // must be ignored
    });
    assert.equal(updated.firstName, 'Grace');
    assert.equal(updated.lastName, 'Hopper');
    assert.equal(updated.loginId, 'zz_profile', 'login ID must not be changeable');
    assert.equal(updated.email, null, 'email must not be changeable');
  });

  test('verifyLookup returns the hash, findByLoginId never does', async () => {
    const v = await users.verifyLookup('zz_profile');
    assert.match(v.passwordHash, /^scrypt\$/);
    const f = await users.findByLoginId('zz_profile');
    assert.equal(f.passwordHash, undefined);
  });

  test('deleting an account cascades to owned rows but preserves the audit trail', async () => {
    const u = await users.create(newUser('cascade', null));
    await sessions.create({
      tokenHash: hashOf(`tok-${u.id}`), userId: u.id,
      principalType: 'user', absoluteHours: 8,
    });
    await pool.query("INSERT INTO reports (user_id, risk_types) VALUES ($1, '{security}')", [u.id]);
    await pool.query(
      "INSERT INTO report_file_chunks (report_id, seq, chunk) SELECT id, 0, '\\x00' FROM reports WHERE user_id = $1",
      [u.id]
    );
    await audit.record({ userId: u.id, loginIdAttempted: 'zz_cascade', event: 'login' });

    assert.equal(await users.deleteById(u.id), true);

    for (const t of ['user_sessions', 'dt_connections', 'user_settings', 'mail_settings',
                     'schedules', 'reports']) {
      const { rows } = await pool.query(`SELECT count(*)::int n FROM ${t} WHERE user_id = $1`, [u.id]);
      assert.equal(rows[0].n, 0, `${t} rows should have cascaded away`);
    }
    const chunks = await pool.query('SELECT count(*)::int n FROM report_file_chunks');
    assert.equal(chunks.rows[0].n, 0, 'report bytes should cascade with the report');

    const trail = await pool.query(
      "SELECT user_id, login_id_attempted FROM login_audit WHERE login_id_attempted = 'zz_cascade'"
    );
    assert.equal(trail.rowCount, 1, 'the audit row must survive');
    assert.equal(trail.rows[0].user_id, null, 'its user_id must be nulled');
    assert.equal(trail.rows[0].login_id_attempted, 'zz_cascade', 'the attempted login ID is retained');
  });
});

describe('session lifecycle', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  let pool, users, sessions;
  const crypto = require('node:crypto');
  const hashOf = (s) => crypto.createHash('sha256').update(s).digest();
  let user;

  before(async () => {
    pool = require('./db/pool');
    if (!pool.isReady()) {
      const url = new URL(DB_URL);
      process.env.POSTGRES_HOST = url.hostname;
      process.env.POSTGRES_PORT = url.port || '5432';
      process.env.POSTGRES_USER = decodeURIComponent(url.username);
      process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password) || 'x';
      process.env.POSTGRES_DB = url.pathname.replace(/^\//, '');
      const { parseConfig } = require('./lib/config');
      pool.init(parseConfig(process.env).db);
      await migrate({ pool: pool.getPool(), dir: MIGRATIONS_DIR });
    }
    users = require('./lib/users');
    sessions = require('./lib/sessions');
    await pool.query("DELETE FROM users WHERE login_id = 'zz_sess'");
    user = await users.create({
      loginId: 'zz_sess', email: null, firstName: 'Session', lastName: 'Tester',
      passwordHash: 'scrypt$16384$8$1$c2FsdA==$ZGs=',
    });
  });

  after(async () => {
    if (pool && pool.isReady()) {
      await pool.query("DELETE FROM users WHERE login_id = 'zz_sess'");
      await pool.query("DELETE FROM user_sessions WHERE principal_type = 'admin'");
      await pool.close();
    }
  });

  test('a live session resolves from its token hash', async () => {
    const th = hashOf('token-alpha');
    await sessions.create({ tokenHash: th, userId: user.id, principalType: 'user', absoluteHours: 8 });
    const found = await sessions.findLiveByTokenHash(th, 2);
    assert.ok(found);
    assert.equal(found.userId, user.id);
    assert.equal(found.loginId, 'zz_sess');
    assert.equal(found.principalType, 'user');
  });

  test('a second live session for the same user is rejected by the database', async () => {
    await assert.rejects(
      () => sessions.create({
        tokenHash: hashOf('token-beta'), userId: user.id,
        principalType: 'user', absoluteHours: 8,
      }),
      (e) => e.code === 'SESSION_EXISTS'
    );
  });

  test('after revocation a new session may be issued', async () => {
    assert.equal(await sessions.revokeByTokenHash(hashOf('token-alpha')), true);
    assert.equal(await sessions.findLiveByTokenHash(hashOf('token-alpha'), 2), null,
      'a revoked token must not resolve');

    const th = hashOf('token-gamma');
    await sessions.create({ tokenHash: th, userId: user.id, principalType: 'user', absoluteHours: 8 });
    assert.ok(await sessions.findLiveByTokenHash(th, 2));
  });

  test('an unknown token resolves to null', async () => {
    assert.equal(await sessions.findLiveByTokenHash(hashOf('never-issued'), 2), null);
  });

  test('an expired session does not resolve', async () => {
    const th = hashOf('token-expired');
    await sessions.revokeAllForUser(user.id);
    await sessions.create({ tokenHash: th, userId: user.id, principalType: 'user', absoluteHours: 8 });
    // Backdate issue and expiry together: the sessions_expiry_after_issue CHECK
    // correctly forbids a row that expires before it was issued.
    await pool.query(
      `UPDATE user_sessions
          SET issued_at = now() - interval '10 hours', expires_at = now() - interval '1 minute'
        WHERE token_hash = $1`, [th]
    );
    assert.equal(await sessions.findLiveByTokenHash(th, 2), null, 'absolute expiry must be enforced in SQL');
  });

  test('an idle session does not resolve even when within its absolute lifetime', async () => {
    const th = hashOf('token-idle');
    await sessions.revokeAllForUser(user.id);
    await sessions.create({ tokenHash: th, userId: user.id, principalType: 'user', absoluteHours: 8 });
    await pool.query("UPDATE user_sessions SET last_seen_at = now() - interval '3 hours' WHERE token_hash = $1", [th]);
    assert.equal(await sessions.findLiveByTokenHash(th, 2), null, 'idle window must be enforced');

    await sessions.touch((await sessions.findLiveForUser(user.id)).id);
    assert.ok(await sessions.findLiveByTokenHash(th, 2), 'touch() should revive it within the absolute window');
  });

  test('findLiveForUser describes the session for the force-disconnect prompt', async () => {
    const live = await sessions.findLiveForUser(user.id);
    assert.ok(live.issuedAt instanceof Date);
    assert.ok(live.lastSeenAt instanceof Date);
    assert.equal(live.principalType, 'user');
  });

  test('the administrator principal has its own single-session rule', async () => {
    await sessions.revokeAdmin();
    await sessions.create({ tokenHash: hashOf('admin-1'), principalType: 'admin', absoluteHours: 8 });
    await assert.rejects(
      () => sessions.create({ tokenHash: hashOf('admin-2'), principalType: 'admin', absoluteHours: 8 }),
      (e) => e.code === 'SESSION_EXISTS'
    );
    const a = await sessions.findLiveByTokenHash(hashOf('admin-1'), 2);
    assert.equal(a.principalType, 'admin');
    assert.equal(a.userId, null, 'the administrator is not a database user');
  });

  test('sweepExpired removes only rows that can never authenticate again', async () => {
    await pool.query(
      `INSERT INTO user_sessions (principal_type, token_hash, issued_at, expires_at, revoked_at)
       VALUES ('admin', $1, now() - interval '31 days', now() - interval '30 days',
               now() - interval '30 days')`,
      [hashOf('ancient')]
    );
    const removed = await sessions.sweepExpired(7);
    assert.ok(removed >= 1, 'the ancient row should have been swept');
    const live = await sessions.findLiveByTokenHash(hashOf('admin-1'), 2);
    assert.ok(live, 'a live session must survive the sweep');
  });
});

describe('login audit', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  let pool, audit;

  before(async () => {
    pool = require('./db/pool');
    if (!pool.isReady()) {
      const url = new URL(DB_URL);
      process.env.POSTGRES_HOST = url.hostname;
      process.env.POSTGRES_PORT = url.port || '5432';
      process.env.POSTGRES_USER = decodeURIComponent(url.username);
      process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password) || 'x';
      process.env.POSTGRES_DB = url.pathname.replace(/^\//, '');
      const { parseConfig } = require('./lib/config');
      pool.init(parseConfig(process.env).db);
      await migrate({ pool: pool.getPool(), dir: MIGRATIONS_DIR });
    }
    audit = require('./lib/login-audit');
    await pool.query("DELETE FROM login_audit WHERE login_id_attempted LIKE 'zz_%'");
  });

  after(async () => {
    if (pool && pool.isReady()) {
      await pool.query("DELETE FROM login_audit WHERE login_id_attempted LIKE 'zz_%'");
      await pool.close();
    }
  });

  test('records an event with no user id (unknown account)', async () => {
    await audit.record({ loginIdAttempted: 'zz_ghost', event: 'failed', ipAddress: '10.0.0.1' });
    assert.equal(await audit.recentFailures('zz_ghost', '10.0.0.1'), 1);
  });

  test('rejects an unknown event name rather than writing junk', async () => {
    await assert.rejects(
      () => audit.record({ loginIdAttempted: 'zz_ghost', event: 'hacked' }),
      (e) => e.code === 'AUDIT_BAD_EVENT'
    );
  });

  test('counts failures per login ID and address for the lockout rule', async () => {
    for (let i = 0; i < 4; i++) {
      await audit.record({ loginIdAttempted: 'zz_brute', event: 'failed', ipAddress: '10.0.0.2' });
    }
    assert.equal(await audit.recentFailures('zz_brute', '10.0.0.2'), 4);
    assert.equal(await audit.recentFailures('zz_brute', '10.0.0.9'), 0, 'a different address is a different bucket');
    assert.equal(await audit.recentFailures('zz_other', '10.0.0.2'), 0, 'a different login is a different bucket');
  });

  test('clearFailures resets the streak after a successful login', async () => {
    await audit.clearFailures('zz_brute', '10.0.0.2');
    assert.equal(await audit.recentFailures('zz_brute', '10.0.0.2'), 0);
  });

  test('failures outside the window do not count', async () => {
    await audit.record({ loginIdAttempted: 'zz_old', event: 'failed', ipAddress: '10.0.0.3' });
    await pool.query(
      "UPDATE login_audit SET created_at = now() - interval '30 minutes' WHERE login_id_attempted = 'zz_old'"
    );
    assert.equal(await audit.recentFailures('zz_old', '10.0.0.3', 15), 0);
    assert.equal(await audit.recentFailures('zz_old', '10.0.0.3', 60), 1);
  });

  test('purgeOlderThan removes entries past the retention period', async () => {
    await audit.record({ loginIdAttempted: 'zz_ancient', event: 'login' });
    await pool.query(
      "UPDATE login_audit SET created_at = now() - interval '100 days' WHERE login_id_attempted = 'zz_ancient'"
    );
    const removed = await audit.purgeOlderThan(90);
    assert.ok(removed >= 1);
    const { rowCount } = await pool.query(
      "SELECT 1 FROM login_audit WHERE login_id_attempted = 'zz_ancient'"
    );
    assert.equal(rowCount, 0);
  });
});

// ── Authentication layer (phase 2) ───────────────────────────────────────────
// Exercises lib/auth.js against a real database: token cache behaviour,
// revocation eviction, and the force-disconnect path.

describe('auth token cache and revocation', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  let pool, users, auth, dtCrypto;
  let user;

  before(async () => {
    pool = require('./db/pool');
    if (!pool.isReady()) {
      const url = new URL(DB_URL);
      process.env.POSTGRES_HOST = url.hostname;
      process.env.POSTGRES_PORT = url.port || '5432';
      process.env.POSTGRES_USER = decodeURIComponent(url.username);
      process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password) || 'x';
      process.env.POSTGRES_DB = url.pathname.replace(/^\//, '');
      const { parseConfig } = require('./lib/config');
      pool.init(parseConfig(process.env).db);
      await migrate({ pool: pool.getPool(), dir: MIGRATIONS_DIR });
    }
    users     = require('./lib/users');
    auth      = require('./lib/auth');
    dtCrypto  = require('./lib/crypto');
    auth.configure({ session: { absoluteHours: 8, idleHours: 2 } });

    await pool.query("DELETE FROM users WHERE login_id = 'zz_auth'");
    user = await users.create({
      loginId: 'zz_auth', email: null, firstName: 'Auth', lastName: 'Tester',
      passwordHash: await dtCrypto.hashPassword('password123'),
    });
  });

  after(async () => {
    if (pool && pool.isReady()) {
      auth.clearCache();
      await pool.query("DELETE FROM users WHERE login_id = 'zz_auth'");
      await pool.query("DELETE FROM user_sessions WHERE principal_type = 'admin'");
      await pool.close();
    }
  });

  test('issueSession returns a token that resolves to the right principal', async () => {
    auth.clearCache();
    const { token } = await auth.issueSession({ userId: user.id, principalType: 'user' });
    const p = await auth.resolveToken(token);
    assert.ok(p);
    assert.equal(p.userId, user.id);
    assert.equal(p.loginId, 'zz_auth');
    assert.equal(p.isAdmin, false);
  });

  test('the resolved token is cached, so repeat calls avoid the database', async () => {
    auth.clearCache();
    const { token } = await auth.issueSession({ userId: user.id, principalType: 'user', force: true });
    assert.equal(auth.cacheSize(), 0);
    await auth.resolveToken(token);
    assert.equal(auth.cacheSize(), 1, 'first resolve populates the cache');
    await auth.resolveToken(token);
    await auth.resolveToken(token);
    assert.equal(auth.cacheSize(), 1, 'repeat resolves reuse the entry');
  });

  test('a second session is refused unless force is used', async () => {
    await assert.rejects(
      () => auth.issueSession({ userId: user.id, principalType: 'user' }),
      (e) => e.code === 'SESSION_EXISTS'
    );
  });

  test('force revokes the previous session AND evicts it from the cache', async () => {
    auth.clearCache();
    const first = await auth.issueSession({ userId: user.id, principalType: 'user', force: true });
    assert.ok(await auth.resolveToken(first.token));
    assert.equal(auth.cacheSize(), 1);

    const second = await auth.issueSession({ userId: user.id, principalType: 'user', force: true });

    // The critical property: revocation must be immediate, not delayed by the
    // 60-second cache window.
    assert.equal(await auth.resolveToken(first.token), null, 'old token must be dead at once');
    assert.ok(await auth.resolveToken(second.token), 'new token must work');
  });

  test('revokeToken kills the session and evicts the cache entry', async () => {
    auth.clearCache();
    const { token } = await auth.issueSession({ userId: user.id, principalType: 'user', force: true });
    await auth.resolveToken(token);
    assert.equal(auth.cacheSize(), 1);

    assert.equal(await auth.revokeToken(token), true);
    assert.equal(auth.cacheSize(), 0, 'cache entry must be evicted on revocation');
    assert.equal(await auth.resolveToken(token), null);
  });

  test('an unknown or malformed token resolves to null without throwing', async () => {
    assert.equal(await auth.resolveToken('not-a-real-token'), null);
    assert.equal(await auth.resolveToken(''), null);
    assert.equal(await auth.resolveToken(null), null);
    assert.equal(await auth.resolveToken(undefined), null);
  });

  test('deleting the user makes the token unusable', async () => {
    auth.clearCache();
    const victim = await users.create({
      loginId: 'zz_victim', email: null, firstName: 'Victim', lastName: 'User',
      passwordHash: await dtCrypto.hashPassword('password123'),
    });
    const { token } = await auth.issueSession({ userId: victim.id, principalType: 'user' });
    assert.ok(await auth.resolveToken(token));

    await auth.revokeUserSessions(victim.id);
    await users.deleteById(victim.id);
    auth.evictUser(victim.id);

    assert.equal(await auth.resolveToken(token), null);
  });

  test('the administrator session is independent of user sessions', async () => {
    auth.clearCache();
    const userSession  = await auth.issueSession({ userId: user.id, principalType: 'user', force: true });
    const adminSession = await auth.issueSession({ principalType: 'admin', force: true });

    const up = await auth.resolveToken(userSession.token);
    const ap = await auth.resolveToken(adminSession.token);
    assert.equal(up.isAdmin, false);
    assert.equal(ap.isAdmin, true);

    // The resolved principal carries the reserved configuration identity, so
    // Settings, reports and a schedule work for the administrator through the
    // ordinary per-user routes (migration 004).
    assert.equal(ap.userId, require('./lib/users').ADMIN_PRINCIPAL_ID);
    assert.notEqual(ap.userId, up.userId, 'and it is nobody else\'s data');

    // The SESSION row is unchanged: sessions_principal_shape requires
    // user_id IS NULL for an administrator, and it still is. The reserved id
    // exists only on the resolved principal.
    const { rows } = await pool.query(
      'SELECT user_id, principal_type FROM user_sessions WHERE id = $1', [ap.sessionId]);
    assert.equal(rows[0].user_id, null,
      'the administrator session row must keep user_id NULL');
    assert.equal(rows[0].principal_type, 'admin');

    // Revoking the administrator must not disturb the user.
    await auth.revokeToken(adminSession.token);
    assert.equal(await auth.resolveToken(adminSession.token), null);
    assert.ok(await auth.resolveToken(userSession.token), 'user session must survive');
  });

  test('isLockedOut trips after the configured number of failures', async () => {
    const audit = require('./lib/login-audit');
    await audit.clearFailures('zz_lock', '10.9.9.9');
    assert.equal(await auth.isLockedOut('zz_lock', '10.9.9.9'), false);

    for (let i = 0; i < auth.LOCKOUT_THRESHOLD; i++) {
      await audit.record({ loginIdAttempted: 'zz_lock', event: 'failed', ipAddress: '10.9.9.9' });
    }
    assert.equal(await auth.isLockedOut('zz_lock', '10.9.9.9'), true);
    assert.equal(await auth.isLockedOut('zz_lock', '10.9.9.8'), false, 'a different address is separate');

    await audit.clearFailures('zz_lock', '10.9.9.9');
    assert.equal(await auth.isLockedOut('zz_lock', '10.9.9.9'), false, 'a success clears the streak');
  });

  test('sweep removes dead sessions without disturbing live ones', async () => {
    auth.clearCache();
    const live = await auth.issueSession({ userId: user.id, principalType: 'user', force: true });
    await pool.query(
      `INSERT INTO user_sessions (principal_type, token_hash, issued_at, expires_at, revoked_at)
       VALUES ('admin', $1, now() - interval '40 days', now() - interval '39 days',
               now() - interval '39 days')`,
      [dtCrypto.hashToken('dead-session')]
    );
    await auth.sweep();
    assert.ok(await auth.resolveToken(live.token), 'the live session must survive the sweep');
  });
});

describe('admin credential file', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  const admin = require('./lib/admin');
  const dtCrypto = require('./lib/crypto');

  test('a missing file disables administrator login with an actionable reason', () => {
    const r = admin.load('/nonexistent/admin-credentials.json');
    assert.equal(r.enabled, false);
    assert.equal(admin.isEnabled(), false);
    assert.match(admin.disabledReason(), /install\.sh/);
  });

  test('malformed JSON disables login rather than crashing', () => {
    const f = path.join(os.tmpdir(), `admin-bad-${Date.now()}.json`);
    fs.writeFileSync(f, '{not json');
    try {
      assert.equal(admin.load(f).enabled, false);
      assert.match(admin.disabledReason(), /valid JSON/);
    } finally { fs.unlinkSync(f); }
  });

  test('a file missing passwordHash disables login', () => {
    const f = path.join(os.tmpdir(), `admin-part-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify({ loginId: 'admin' }));
    try {
      assert.equal(admin.load(f).enabled, false);
      assert.match(admin.disabledReason(), /passwordHash/);
    } finally { fs.unlinkSync(f); }
  });

  test('a valid file enables login and verifies the password', async () => {
    const f = path.join(os.tmpdir(), `admin-ok-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify({
      loginId: 'sysadmin',
      passwordHash: await dtCrypto.hashPassword('Str0ngAdminPass'),
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    try {
      const r = admin.load(f);
      assert.equal(r.enabled, true);
      assert.equal(r.loginId, 'sysadmin');
      assert.equal(await admin.verify('sysadmin', 'Str0ngAdminPass'), true);
      assert.equal(await admin.verify('SYSADMIN', 'Str0ngAdminPass'), true, 'login ID is case-insensitive');
      assert.equal(await admin.verify('sysadmin', 'wrong'), false);
      assert.equal(await admin.verify('someoneelse', 'Str0ngAdminPass'), false);
    } finally { fs.unlinkSync(f); admin._setForTest(null); }
  });

  test('verify returns false when administrator login is disabled', async () => {
    admin._setForTest(null);
    assert.equal(await admin.verify('admin', 'anything'), false);
  });
});

// ── Multi-tenant data layer (phase 4–7) ──────────────────────────────────────
// The isolation guarantees that make the service safe for concurrent users:
// per-user scoping, encrypted secrets, chunked report bytes, a shared cache
// keyed by connection fingerprint, and single-claim scheduling.

describe('multi-tenant data access', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  let pool, users, dtCrypto, dtConnections, userSettings, appSettings, mailSettings,
      schedulesDb, reportsDb, caches;
  let alice, bob;

  // Real DependencyTrack project ids are uuids, and so is schedule_projects.project_uuid.
  const PROJ_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const PROJ_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const PROJ_3 = 'cccccccc-3333-4333-8333-cccccccccccc';

  before(async () => {
    pool = require('./db/pool');
    if (!pool.isReady()) {
      const url = new URL(DB_URL);
      process.env.POSTGRES_HOST     = url.hostname;
      process.env.POSTGRES_PORT     = url.port || '5432';
      process.env.POSTGRES_USER     = decodeURIComponent(url.username);
      process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password) || 'x';
      process.env.POSTGRES_DB       = url.pathname.replace(/^\//, '');
      const { parseConfig } = require('./lib/config');
      pool.init(parseConfig(process.env).db);
      await migrate({ pool: pool.getPool(), dir: MIGRATIONS_DIR });
    }

    users         = require('./lib/users');
    dtCrypto      = require('./lib/crypto');
    dtConnections = require('./lib/dt-connections');
    userSettings  = require('./lib/user-settings');
    appSettings   = require('./lib/app-settings');
    mailSettings  = require('./lib/mail-settings');
    schedulesDb   = require('./lib/schedules');
    reportsDb     = require('./lib/reports-db');
    caches        = require('./lib/caches');

    const key = dtCrypto.parseEncryptionKey(process.env.SECRET_ENCRYPTION_KEY);
    dtConnections.configure(key);
    mailSettings.configure(key);

    await pool.query("DELETE FROM users WHERE login_id IN ('zz_alice', 'zz_bob')");
    const hash = await dtCrypto.hashPassword('password123');
    alice = await users.create({ loginId: 'zz_alice', email: null, firstName: 'Alice', lastName: 'Ant', passwordHash: hash });
    bob   = await users.create({ loginId: 'zz_bob',   email: null, firstName: 'Bob',   lastName: 'Bee', passwordHash: hash });
  });

  after(async () => {
    if (pool && pool.isReady()) {
      await pool.query("DELETE FROM users WHERE login_id IN ('zz_alice', 'zz_bob')");
      await pool.query("DELETE FROM violation_caches WHERE fingerprint LIKE 'zz%'");
      await pool.query("DELETE FROM system_state WHERE key = 'legacy_dt_connection_migrated'");
      await pool.close();
    }
  });

  // ── dt_connections ─────────────────────────────────────────────────────
  test('registration seeds exactly one row in each per-user table', async () => {
    for (const table of ['dt_connections', 'user_settings', 'mail_settings', 'schedules']) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [alice.id]
      );
      assert.equal(rows[0].n, 1, `${table} should have been seeded at registration`);
    }
  });

  test('a new account starts unconfigured, so the dashboard shows demo data', async () => {
    const conn = await dtConnections.getForClient(alice.id);
    assert.equal(conn.isConfigured, false);
    assert.equal(conn.hasApiKey, false);
  });

  test('the API key round-trips through encryption but never appears in the client view', async () => {
    await dtConnections.save(alice.id, {
      apiUrl: 'https://dt.example.com/', apiKey: 'odt_alice_key_1234', frontendUrl: 'https://ui.example.com/',
    });

    const client = await dtConnections.getForClient(alice.id);
    assert.equal(client.apiUrl, 'https://dt.example.com', 'the trailing slash is normalised away');
    assert.equal(client.frontendUrl, 'https://ui.example.com');
    assert.equal(client.isConfigured, true);
    assert.equal(client.hasApiKey, true);
    assert.equal(client.apiKey, undefined, 'the key must not be in the client projection');
    assert.doesNotMatch(JSON.stringify(client), /odt_alice_key_1234/);

    const resolved = await dtConnections.getResolved(alice.id);
    assert.equal(resolved.apiKey, 'odt_alice_key_1234');

    // The stored bytes must not be the plaintext.
    const { rows } = await pool.query(
      'SELECT api_key_ciphertext AS ct FROM dt_connections WHERE user_id = $1', [alice.id]
    );
    assert.doesNotMatch(rows[0].ct.toString('utf8'), /odt_alice_key_1234/);
  });

  test('saving without a key keeps the stored one and updates the URLs', async () => {
    await dtConnections.save(alice.id, { apiUrl: 'https://dt2.example.com', frontendUrl: 'https://ui2.example.com' });
    const resolved = await dtConnections.getResolved(alice.id);
    assert.equal(resolved.apiKey, 'odt_alice_key_1234', 'the key survives a URL-only save');
    assert.equal(resolved.apiUrl, 'https://dt2.example.com');
    assert.equal(resolved.frontendUrl, 'https://ui2.example.com');
  });

  test('identical credentials produce one fingerprint, different ones do not', async () => {
    await dtConnections.save(alice.id, { apiUrl: 'https://shared.example.com', apiKey: 'same_key' });
    await dtConnections.save(bob.id,   { apiUrl: 'https://shared.example.com', apiKey: 'same_key' });
    const a = await dtConnections.getForClient(alice.id);
    const b = await dtConnections.getForClient(bob.id);
    assert.equal(a.fingerprint, b.fingerprint, 'shared credentials must share one cache row');

    await dtConnections.save(bob.id, { apiUrl: 'https://shared.example.com', apiKey: 'different_key' });
    const b2 = await dtConnections.getForClient(bob.id);
    assert.notEqual(b2.fingerprint, a.fingerprint);
  });

  test('clearing the key marks the connection unconfigured and drops the fingerprint', async () => {
    await dtConnections.clearKey(bob.id);
    const conn = await dtConnections.getForClient(bob.id);
    assert.equal(conn.hasApiKey, false);
    assert.equal(conn.isConfigured, false);
    assert.equal(conn.fingerprint, null);
    // Restore for later tests.
    await dtConnections.save(bob.id, { apiUrl: 'https://bob.example.com', apiKey: 'bob_key' });
  });

  test('the legacy .env migration runs at most once', async () => {
    await pool.query("DELETE FROM system_state WHERE key = 'legacy_dt_connection_migrated'");
    const first  = await dtConnections.migrateLegacyConnection({ apiUrl: 'https://legacy', apiKey: 'legacy_key' });
    const second = await dtConnections.migrateLegacyConnection({ apiUrl: 'https://legacy', apiKey: 'legacy_key' });
    assert.equal(first.ran, true);
    assert.equal(second.ran, false, 'a second boot must not re-seed anyone');
  });

  // ── user_settings / app_settings ───────────────────────────────────────
  test('the report ceiling is still enforced per user', async () => {
    await userSettings.setMaxReportsOverride(alice.id, 3);
    try {
      assert.equal(await userSettings.getMaxReports(alice.id), 3);
      assert.equal(await userSettings.getMaxReports(bob.id), 10,
        "overriding one account's limit must not touch anybody else's");
    } finally {
      await userSettings.clearMaxReportsOverride(alice.id);
    }
  });

  test('the global default reaches every account that has no override', async () => {
    await userSettings.setMaxReportsOverride(alice.id, 3);
    try {
      await appSettings.setDefaultMaxReports(77);
      assert.equal(await userSettings.getMaxReports(bob.id), 77, 'bob follows the default');
      assert.equal(await userSettings.getMaxReports(alice.id), 3, 'alice is pinned and does not');

      // Clearing hands the account back to the default, whatever it is now.
      const cleared = await userSettings.clearMaxReportsOverride(alice.id);
      assert.equal(cleared.maxReports, 77);
      assert.equal(cleared.maxReportsOverride, null);
    } finally {
      await appSettings.setDefaultMaxReports(10);
      await userSettings.clearMaxReportsOverride(alice.id);
    }
  });

  test('an override is distinguishable from an inherited value of the same number', async () => {
    // The whole reason the column is nullable. Without this distinction the
    // administration screen cannot say what changing the default would do.
    await appSettings.setDefaultMaxReports(10);
    await userSettings.setMaxReportsOverride(alice.id, 10);
    try {
      const pinned    = await userSettings.get(alice.id);
      const inherited = await userSettings.get(bob.id);
      assert.equal(pinned.maxReports, inherited.maxReports, 'the same effective number');
      assert.equal(pinned.maxReportsOverride, 10, 'but one is pinned');
      assert.equal(inherited.maxReportsOverride, null, 'and the other is not');

      await appSettings.setDefaultMaxReports(30);
      assert.equal(await userSettings.getMaxReports(alice.id), 10, 'the pin holds');
      assert.equal(await userSettings.getMaxReports(bob.id), 30, 'the inherited one moves');
    } finally {
      await appSettings.setDefaultMaxReports(10);
      await userSettings.clearMaxReportsOverride(alice.id);
    }
  });

  test('the singleton settings row cannot be duplicated', async () => {
    await assert.rejects(
      () => pool.query('INSERT INTO app_settings (id, default_max_reports) VALUES (TRUE, 5)'),
      (e) => e.code === '23505', 'a second global settings row must collide'
    );
  });

  // ── mail_settings ──────────────────────────────────────────────────────
  test('the SMTP password is encrypted, masked to the client and kept on a placeholder save', async () => {
    await mailSettings.save(alice.id, {
      enabled: true,
      smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'alice', pass: 'sup3rsecret' },
      from: 'alice@example.com', to: 'ops@example.com, dev@example.com', cc: '',
    });

    const client = await mailSettings.getForClient(alice.id);
    assert.equal(client.smtp.pass, mailSettings.PASSWORD_PLACEHOLDER);
    assert.deepEqual(client.to, ['ops@example.com', 'dev@example.com']);
    assert.doesNotMatch(JSON.stringify(client), /sup3rsecret/);

    // Saving the placeholder back must not overwrite the stored password.
    await mailSettings.save(alice.id, {
      enabled: true,
      smtp: { host: 'smtp.example.com', port: 2525, secure: true, user: 'alice', pass: mailSettings.PASSWORD_PLACEHOLDER },
      from: 'alice@example.com', to: ['ops@example.com'], cc: [],
    });
    const resolved = await mailSettings.getResolved(alice.id);
    assert.equal(resolved.smtp.pass, 'sup3rsecret');
    assert.equal(resolved.smtp.port, 2525, 'the rest of the form still saved');
  });

  test('an out-of-range SMTP port is rejected before any write', async () => {
    await assert.rejects(
      () => mailSettings.save(alice.id, { smtp: { port: 99999 } }),
      (e) => e.code === 'VALIDATION_FAILED' && e.field === 'smtpPort'
    );
  });

  // ── reports + chunked bytes ────────────────────────────────────────────
  test('a report round-trips through chunked storage byte for byte', async () => {
    const report = await reportsDb.create(alice.id, { riskTypes: ['security'], projectCount: 2 });
    // Deliberately larger than CHUNK_BYTES so more than one row is written.
    const payload = require('node:crypto').randomBytes(reportsDb.CHUNK_BYTES * 2 + 1234);

    await reportsDb.storeFile(report.id, payload, 'report.xlsx');

    const chunks = await reportsDb.chunkCount(report.id);
    assert.equal(chunks, 3, 'a 2-and-a-bit chunk payload must occupy three rows');

    const parts = [];
    for (let seq = 0; seq < chunks; seq++) parts.push(await reportsDb.getChunk(report.id, seq));
    assert.ok(Buffer.concat(parts).equals(payload), 'the reassembled file must be identical');

    const meta = await reportsDb.getForUser(alice.id, report.id);
    assert.equal(meta.status, 'completed');
    assert.equal(Number(meta.fileSizeBytes), payload.length);
    assert.equal(meta.chunk, undefined, 'listing projections never carry bytes');

    await reportsDb.deleteForUser(alice.id, report.id);
    assert.equal(await reportsDb.chunkCount(report.id), 0, 'chunks cascade with the report');
  });

  test("one user cannot read or delete another user's report", async () => {
    const report = await reportsDb.create(alice.id, { riskTypes: ['security'], projectCount: 1 });
    try {
      assert.equal(await reportsDb.getForUser(bob.id, report.id), null,
        "Bob must not be able to read Alice's report");
      assert.equal(await reportsDb.deleteForUser(bob.id, report.id), false);
      assert.ok(await reportsDb.getForUser(alice.id, report.id), 'and it must still be there for Alice');
    } finally {
      await reportsDb.deleteForUser(alice.id, report.id);
    }
  });

  test('the active count is scoped to one user', async () => {
    const mine = [];
    for (let i = 0; i < 3; i++) {
      const r = await reportsDb.create(alice.id, { riskTypes: ['security'], projectCount: 1 });
      await reportsDb.storeFile(r.id, Buffer.from(`report ${i}`), `r${i}.xlsx`);
      mine.push(r.id);
    }
    const theirs = await reportsDb.create(bob.id, { riskTypes: ['security'], projectCount: 1 });
    await reportsDb.storeFile(theirs.id, Buffer.from('bob'), 'bob.xlsx');
    try {
      assert.equal((await reportsDb.activeCount(alice.id)).completed, 3);
      assert.equal((await reportsDb.activeCount(bob.id)).completed, 1);

      // trimToLimit() was removed with migration 005: the limit is now an
      // administrator's, and one global change must not delete reports across
      // many accounts. Being over the limit blocks new reports; it never
      // deletes existing ones.
      assert.equal(reportsDb.trimToLimit, undefined,
        'a report-deleting helper must not sit unwired waiting to be re-called');
    } finally {
      for (const id of mine) await reportsDb.deleteForUser(alice.id, id);
      await reportsDb.deleteForUser(bob.id, theirs.id);
    }
  });

  test('progress writes are throttled to at most one a second', async () => {
    const r = await reportsDb.create(alice.id, { riskTypes: ['security'], projectCount: 1 });
    try {
      assert.equal(await reportsDb.writeProgress(r.id, { security: { done: 1, total: 9 } }), true);
      assert.equal(await reportsDb.writeProgress(r.id, { security: { done: 2, total: 9 } }), false,
        'a second write inside the interval is skipped');
      assert.equal(await reportsDb.writeProgress(r.id, { security: { done: 3, total: 9 } }, { force: true }), true);

      const meta = await reportsDb.getForUser(alice.id, r.id);
      assert.equal(meta.progress.security.done, 3);
    } finally {
      reportsDb.forgetProgress(r.id);
      await reportsDb.deleteForUser(alice.id, r.id);
    }
  });

  test('reports left running by a restart are failed, not left stuck', async () => {
    const r = await reportsDb.create(alice.id, { riskTypes: ['security'], projectCount: 1 });
    try {
      await reportsDb.setStatus(r.id, 'running');
      await reportsDb.failOrphaned();
      const meta = await reportsDb.getForUser(alice.id, r.id);
      assert.equal(meta.status, 'failed');
      assert.match(meta.error, /restarted/);
    } finally { await reportsDb.deleteForUser(alice.id, r.id); }
  });

  test('deleting an account removes everything it owned', async () => {
    const hash = await dtCrypto.hashPassword('password123');
    const doomed = await users.create({
      loginId: 'zz_doomed', email: null, firstName: 'Doo', lastName: 'Med', passwordHash: hash,
    });
    const report = await reportsDb.create(doomed.id, { riskTypes: ['security'], projectCount: 1 });
    await reportsDb.storeFile(report.id, Buffer.from('bytes'), 'x.xlsx');

    await pool.query('DELETE FROM users WHERE id = $1', [doomed.id]);

    for (const [table, column] of [
      ['dt_connections', 'user_id'], ['user_settings', 'user_id'], ['mail_settings', 'user_id'],
      ['schedules', 'user_id'], ['reports', 'user_id'],
    ]) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [doomed.id]);
      assert.equal(rows[0].n, 0, `${table} should have cascaded`);
    }
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM report_file_chunks WHERE report_id = $1', [report.id]
    );
    assert.equal(rows[0].n, 0, 'report bytes should have cascaded too');
  });

  // ── schedules ──────────────────────────────────────────────────────────
  test('a due schedule is claimed exactly once, even by concurrent pollers', async () => {
    await schedulesDb.save(alice.id, {
      enabled: true, frequency: 'daily', hour: 9, riskTypes: ['security'],
    });
    await schedulesDb.setProjects(alice.id, [{ uuid: PROJ_1, name: 'svc', version: '1.0' }]);
    // Backdate the due time so the row is claimable right now.
    await pool.query("UPDATE schedules SET next_run_at = now() - interval '1 minute', running_since = NULL WHERE user_id = $1", [alice.id]);

    const [first, second] = await Promise.all([schedulesDb.claimDue(5), schedulesDb.claimDue(5)]);
    const claimed = [...first, ...second].filter(r => r.userId === alice.id);
    assert.equal(claimed.length, 1, 'FOR UPDATE SKIP LOCKED must hand the row to one poller only');

    await schedulesDb.finishRun(alice.id, { status: 'success', nextRunAt: new Date(Date.now() + 86_400_000) });
    const after = await schedulesDb.get(alice.id);
    assert.equal(after.runningSince, null, 'the claim is released when the run finishes');
    assert.equal(after.lastRunStatus, 'success');
  });

  test('a disabled schedule is never claimed', async () => {
    await schedulesDb.disable(alice.id);
    await pool.query("UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE user_id = $1", [alice.id]);
    const due = await schedulesDb.claimDue(5);
    assert.equal(due.filter(r => r.userId === alice.id).length, 0);
  });

  test('a claim orphaned by a crash is released after the stale window', async () => {
    await schedulesDb.save(alice.id, { enabled: true, frequency: 'daily', hour: 9 });
    await pool.query("UPDATE schedules SET running_since = now() - interval '2 hours' WHERE user_id = $1", [alice.id]);
    const released = await schedulesDb.releaseStaleClaims(45);
    assert.ok(released >= 1);
    assert.equal((await schedulesDb.get(alice.id)).runningSince, null);
  });

  test('a failed run leaves a notice the dashboard can acknowledge', async () => {
    await schedulesDb.finishRun(alice.id, { status: 'failed', error: 'SMTP refused', nextRunAt: new Date(Date.now() + 3600_000) });
    let sched = await schedulesDb.get(alice.id);
    assert.match(sched.failureNotification, /SMTP refused/);
    await schedulesDb.ackNotification(alice.id);
    sched = await schedulesDb.get(alice.id);
    assert.equal(sched.failureNotification, null);
  });

  test('schedule projects are replaced wholesale and scoped by user', async () => {
    await schedulesDb.setProjects(alice.id, [
      { uuid: PROJ_1, name: 'a', version: '1' }, { uuid: PROJ_2, name: 'b', version: '2' },
    ]);
    await schedulesDb.setProjects(bob.id, [{ uuid: PROJ_3, name: 'z', version: '9' }]);

    await schedulesDb.setProjects(alice.id, [{ uuid: PROJ_2, name: 'c', version: '3' }]);
    assert.deepEqual((await schedulesDb.getProjects(alice.id)).map(p => p.uuid), [PROJ_2]);
    assert.deepEqual((await schedulesDb.getProjects(bob.id)).map(p => p.uuid), [PROJ_3],
      "replacing Alice's selection must not touch Bob's");
  });

  test('a malformed project uuid is dropped instead of failing the whole save', async () => {
    // The list comes from the browser; one bad entry must not cost the user
    // their entire selection.
    const kept = await schedulesDb.setProjects(alice.id, [
      { uuid: PROJ_1, name: 'good', version: '1' },
      { uuid: 'not-a-uuid', name: 'bad', version: '1' },
      { name: 'missing uuid' },
    ]);
    assert.deepEqual(kept.map(p => p.uuid), [PROJ_1]);
  });

  test('run history is recorded and purged by age', async () => {
    const runId = await schedulesDb.startRun(alice.id);
    await schedulesDb.completeRun(runId, { status: 'success', fileSizeBytes: 4096 });
    const recent = await schedulesDb.recentRuns(alice.id, 5);
    assert.equal(recent[0].status, 'success');
    assert.equal(Number(recent[0].fileSizeBytes), 4096);

    await pool.query("UPDATE schedule_runs SET started_at = now() - interval '200 days' WHERE id = $1", [runId]);
    assert.ok(await schedulesDb.purgeRunsOlderThan(90) >= 1);
  });

  // ── violation_caches ───────────────────────────────────────────────────
  test('exactly one builder is elected per fingerprint', async () => {
    const fp = 'zz' + 'a'.repeat(62);
    const first = await caches.acquireBuildLock(fp);
    try {
      assert.equal(first.acquired, true);
      const second = await caches.acquireBuildLock(fp);
      assert.equal(second.acquired, false, 'a second builder must lose the election, not wait');
      await second.release();
    } finally { await first.release(); }

    // Once released, the next caller may build.
    const third = await caches.acquireBuildLock(fp);
    assert.equal(third.acquired, true);
    await third.release();
  });

  test('different fingerprints build concurrently', async () => {
    const a = await caches.acquireBuildLock('zz' + 'b'.repeat(62));
    const b = await caches.acquireBuildLock('zz' + 'c'.repeat(62));
    try {
      assert.equal(a.acquired, true);
      assert.equal(b.acquired, true, 'unrelated connections must not block each other');
    } finally { await a.release(); await b.release(); }
  });

  test('a stored map round-trips through gzip and reports its metadata', async () => {
    const fp  = 'zz' + 'd'.repeat(62);
    // A realistic map: the compression saving comes from the repetition across
    // hundreds of projects, which is exactly why the payload is stored gzipped.
    const map = {};
    for (let i = 0; i < 300; i++) {
      map[`0000${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`] = {
        ops: { fail: 2, warn: 0, info: 1, unassigned: 0 },
        lic: { fail: 0, warn: 1, info: 0, unassigned: 0 },
        secpolicy: { fail: 0, warn: 0, info: 0, unassigned: 0 },
      };
    }
    await caches.markBuilding(fp);
    assert.equal(caches.deriveStatus(await caches.getMeta(fp)), 'building');

    await caches.storeResult(fp, map, { projectCount: 300, failedPipelines: 0, ttlMs: 3600_000 });
    const meta = await caches.getMeta(fp);
    assert.equal(caches.deriveStatus(meta), 'ready');
    assert.equal(meta.projectCount, 300);
    assert.deepEqual(await caches.getPayload(fp), map);

    // The gzipped bytes are what the route streams; they must be smaller than
    // the JSON they encode for the transfer saving to be real.
    const gz = await caches.getPayloadGzip(fp);
    assert.ok(gz.length < JSON.stringify(map).length);
  });

  test('an expired cache reads as stale rather than ready', async () => {
    const fp = 'zz' + 'e'.repeat(62);
    await caches.markBuilding(fp);
    await caches.storeResult(fp, {}, { projectCount: 0, failedPipelines: 0, ttlMs: -1000 });
    assert.equal(caches.deriveStatus(await caches.getMeta(fp)), 'stale');
  });

  test('a failed build keeps the previous payload', async () => {
    const fp = 'zz' + 'f'.repeat(62);
    await caches.markBuilding(fp);
    await caches.storeResult(fp, { a: 1 }, { projectCount: 1, failedPipelines: 0, ttlMs: 3600_000 });
    await caches.markFailed(fp, 'upstream exploded');
    const meta = await caches.getMeta(fp);
    assert.equal(meta.status, 'failed');
    assert.deepEqual(await caches.getPayload(fp), { a: 1 },
      'a failed rebuild must not discard data the dashboard could still show');
  });

  // Q14: 'building' is written by runJob and cleared only by storeResult or
  // markFailed. A process killed in between leaves the row asserting a build
  // that nobody is running — which then blocks both the automatic rebuild and
  // the manual refetch. These pin the two ways out.
  // A dead builder is simulated by winding its heartbeat back. The updated_at
  // trigger rewrites the column on every UPDATE, so it has to be suspended for
  // the statement — which is also a useful reminder that in production nothing
  // can forge an old heartbeat.
  const backdateHeartbeat = async (fp, interval) => {
    await pool.query('ALTER TABLE violation_caches DISABLE TRIGGER trg_violation_caches_updated_at');
    try {
      await pool.query(
        `UPDATE violation_caches SET updated_at = now() - $2::interval WHERE fingerprint = $1`,
        [fp, interval]);
    } finally {
      await pool.query('ALTER TABLE violation_caches ENABLE TRIGGER trg_violation_caches_updated_at');
    }
  };

  test('markBuilding stamps a heartbeat the stall check can read', async () => {
    const fp = 'zz' + '1'.repeat(62);
    await caches.markBuilding(fp);
    const meta = await caches.getMeta(fp);
    assert.ok(meta.updatedAt instanceof Date, 'updated_at must come back with the metadata');
    assert.ok(Date.now() - meta.updatedAt.getTime() < 60_000, 'and be fresh at the start of a build');
    assert.equal(caches.deriveStatus(meta, 60_000), 'building');
    await pool.query('DELETE FROM violation_caches WHERE fingerprint = $1', [fp]);
  });

  test('a build that stops beating reads as stalled and becomes rebuildable', async () => {
    const fp = 'zz' + '2'.repeat(62);
    await caches.markBuilding(fp);
    // Wind the heartbeat back rather than waiting out a real stall window.
    await backdateHeartbeat(fp, '40 minutes');
    const meta = await caches.getMeta(fp);
    assert.equal(caches.deriveStatus(meta, 15 * 60_000), 'stalled');
    assert.equal(caches.deriveStatus(meta, 60 * 60_000), 'building',
      'a longer stall window keeps trusting the same row — the window is the policy');
    await pool.query('DELETE FROM violation_caches WHERE fingerprint = $1', [fp]);
  });

  test('touchBuild revives the heartbeat of a running build', async () => {
    const fp = 'zz' + '3'.repeat(62);
    await caches.markBuilding(fp);
    await backdateHeartbeat(fp, '40 minutes');
    assert.equal(caches.deriveStatus(await caches.getMeta(fp), 15 * 60_000), 'stalled');

    assert.equal(await caches.touchBuild(fp), true);
    assert.equal(caches.deriveStatus(await caches.getMeta(fp), 15 * 60_000), 'building',
      'a build that resumes reporting must stop looking dead');
    await pool.query('DELETE FROM violation_caches WHERE fingerprint = $1', [fp]);
  });

  test('touchBuild cannot resurrect a build that already finished', async () => {
    // A heartbeat racing the final store must not drag the row back to
    // 'building' — the dashboard would poll a build that is already done.
    const fp = 'zz' + '4'.repeat(62);
    await caches.markBuilding(fp);
    await caches.storeResult(fp, { a: 1 }, { projectCount: 1, failedPipelines: 0, ttlMs: 3600_000 });
    assert.equal(await caches.touchBuild(fp), false, 'no building row was there to touch');
    assert.equal((await caches.getMeta(fp)).status, 'ready');

    await caches.markFailed(fp, 'boom');
    assert.equal(await caches.touchBuild(fp), false);
    assert.equal((await caches.getMeta(fp)).status, 'failed');
    await pool.query('DELETE FROM violation_caches WHERE fingerprint = $1', [fp]);
  });

  test('a restart fails builds it orphaned, so the next visit rebuilds', async () => {
    const orphaned = 'zz' + '5'.repeat(62);
    const finished = 'zz' + '6'.repeat(62);
    await caches.markBuilding(orphaned);
    await caches.markBuilding(finished);
    await caches.storeResult(finished, { a: 1 }, { projectCount: 1, failedPipelines: 0, ttlMs: 3600_000 });

    const count = await caches.failOrphanedBuilds();
    assert.ok(count >= 1);

    const orphanMeta = await caches.getMeta(orphaned);
    assert.equal(orphanMeta.status, 'failed');
    assert.match(orphanMeta.error, /service restarted/i,
      'the reason must say what happened, not just that it failed');
    assert.equal(caches.deriveStatus(orphanMeta), 'failed',
      'failed is the state the dashboard already knows how to rebuild from');

    assert.equal((await caches.getMeta(finished)).status, 'ready',
      'a build that completed before the restart must be left alone');

    // Idempotent: a second boot with nothing stranded changes nothing.
    assert.equal(await caches.failOrphanedBuilds(), 0);
    await pool.query('DELETE FROM violation_caches WHERE fingerprint = ANY($1)',
      [[orphaned, finished]]);
  });

  test('an orphaned build keeps whatever payload it had', async () => {
    // The row is failed, not emptied: the dashboard can still show yesterday's
    // counts while the replacement build runs.
    const fp = 'zz' + '7'.repeat(62);
    await caches.markBuilding(fp);
    await caches.storeResult(fp, { a: 2 }, { projectCount: 1, failedPipelines: 0, ttlMs: 3600_000 });
    await caches.markBuilding(fp);              // a rebuild that then gets killed
    await caches.failOrphanedBuilds();
    assert.deepEqual(await caches.getPayload(fp), { a: 2 });
    await pool.query('DELETE FROM violation_caches WHERE fingerprint = $1', [fp]);
  });

  test('caches nobody points at any more are swept away', async () => {
    const orphan = 'zz' + '0'.repeat(62);
    await caches.markBuilding(orphan);
    await caches.sweepOrphaned();
    assert.equal(await caches.getMeta(orphan), null);

    // A cache still referenced by a configured connection survives.
    const conn = await dtConnections.getForClient(alice.id);
    await caches.markBuilding(conn.fingerprint);
    await caches.sweepOrphaned();
    assert.ok(await caches.getMeta(conn.fingerprint), 'a live connection keeps its cache');
    await pool.query('DELETE FROM violation_caches WHERE fingerprint = $1', [conn.fingerprint]);
  });
});

// ── Administration listing (phase 9) ─────────────────────────────────────────
// The panel's single query. It must stay one query — the N+1 shape it replaces
// would be a few hundred round trips for one page view (CLAUDE.md §13).

describe('administration listing', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  let pool, users, dtCrypto, reportsDb, dtConnections, schedulesDb, sessions;
  let carol, dave;

  before(async () => {
    pool = require('./db/pool');
    if (!pool.isReady()) {
      const url = new URL(DB_URL);
      process.env.POSTGRES_HOST     = url.hostname;
      process.env.POSTGRES_PORT     = url.port || '5432';
      process.env.POSTGRES_USER     = decodeURIComponent(url.username);
      process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password) || 'x';
      process.env.POSTGRES_DB       = url.pathname.replace(/^\//, '');
      const { parseConfig } = require('./lib/config');
      pool.init(parseConfig(process.env).db);
      await migrate({ pool: pool.getPool(), dir: MIGRATIONS_DIR });
    }
    users         = require('./lib/users');
    dtCrypto      = require('./lib/crypto');
    reportsDb     = require('./lib/reports-db');
    dtConnections = require('./lib/dt-connections');
    schedulesDb   = require('./lib/schedules');
    sessions      = require('./lib/sessions');
    dtConnections.configure(dtCrypto.parseEncryptionKey(process.env.SECRET_ENCRYPTION_KEY));

    await pool.query("DELETE FROM users WHERE login_id IN ('zz_carol', 'zz_dave')");
    const hash = await dtCrypto.hashPassword('password123');
    carol = await users.create({ loginId: 'zz_carol', email: 'carol@x.com', firstName: 'Carol', lastName: 'Cat', passwordHash: hash });
    dave  = await users.create({ loginId: 'zz_dave',  email: null,          firstName: 'Dave',  lastName: 'Dog', passwordHash: hash });
  });

  after(async () => {
    if (pool && pool.isReady()) {
      await pool.query("DELETE FROM users WHERE login_id IN ('zz_carol', 'zz_dave')");
      await pool.close();
    }
  });

  const forUser = (rows, loginId) => rows.find(r => r.loginId === loginId);

  test('a brand-new account appears with zeroes rather than being missing', async () => {
    const rows = await users.listWithStats();
    const dave_ = forUser(rows, 'zz_dave');
    assert.ok(dave_, 'an account with no reports and no session must still be listed');
    assert.equal(dave_.reportCount, 0);
    assert.equal(Number(dave_.storageBytes), 0);
    assert.equal(dave_.sessionActive, false);
    assert.equal(dave_.dtConfigured, false);
    assert.equal(dave_.scheduleEnabled, false);
  });

  test('report count and storage are attributed to the right account', async () => {
    const r1 = await reportsDb.create(carol.id, { riskTypes: ['security'], projectCount: 1 });
    const r2 = await reportsDb.create(carol.id, { riskTypes: ['security'], projectCount: 1 });
    await reportsDb.storeFile(r1.id, Buffer.alloc(1000, 1), 'a.xlsx');
    await reportsDb.storeFile(r2.id, Buffer.alloc(2000, 2), 'b.xlsx');
    try {
      const rows = await users.listWithStats();
      assert.equal(forUser(rows, 'zz_carol').reportCount, 2);
      assert.equal(Number(forUser(rows, 'zz_carol').storageBytes), 3000);
      assert.equal(forUser(rows, 'zz_dave').reportCount, 0,
        "another account's reports must not be counted here");
    } finally {
      await reportsDb.deleteForUser(carol.id, r1.id);
      await reportsDb.deleteForUser(carol.id, r2.id);
    }
  });

  test('a live session shows as active and a revoked one does not', async () => {
    const hashOf = require('node:crypto').createHash('sha256').update('zz-admin-token').digest();
    await sessions.create({
      userId: carol.id, principalType: 'user', tokenHash: hashOf, absoluteHours: 8,
    });
    try {
      assert.equal(forUser(await users.listWithStats(), 'zz_carol').sessionActive, true);
      await sessions.revokeAllForUser(carol.id);
      assert.equal(forUser(await users.listWithStats(), 'zz_carol').sessionActive, false);
    } finally {
      await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [carol.id]);
    }
  });

  test('an expired session does not count as active', async () => {
    const hashOf = require('node:crypto').createHash('sha256').update('zz-expired-token').digest();
    await pool.query(
      `INSERT INTO user_sessions (user_id, principal_type, token_hash, issued_at, expires_at)
       VALUES ($1, 'user', $2, now() - interval '10 hours', now() - interval '1 hour')`,
      [carol.id, hashOf]
    );
    try {
      assert.equal(forUser(await users.listWithStats(), 'zz_carol').sessionActive, false);
    } finally {
      await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [carol.id]);
    }
  });

  test('connection and schedule flags track the per-user rows', async () => {
    await dtConnections.save(carol.id, { apiUrl: 'https://dt.example.com', apiKey: 'carol_key' });
    await schedulesDb.save(carol.id, { enabled: true, frequency: 'daily', hour: 8 });
    const rows = await users.listWithStats();
    assert.equal(forUser(rows, 'zz_carol').dtConfigured, true);
    assert.equal(forUser(rows, 'zz_carol').scheduleEnabled, true);
    assert.equal(forUser(rows, 'zz_dave').dtConfigured, false,
      "one account's connection must not light up another's row");
  });

  test('the listing returns no credential material at all', async () => {
    const rows = await users.listWithStats();
    const serialised = JSON.stringify(rows);
    assert.doesNotMatch(serialised, /scrypt\$/, 'no password hash may be selected');
    assert.doesNotMatch(serialised, /carol_key/, 'no API key may be selected');
    for (const key of ['passwordHash', 'password_hash', 'api_key_ciphertext', 'tokenHash']) {
      assert.equal(key in rows[0], false, `${key} must not be projected`);
    }
  });

  test('it is one query, not one per user', async () => {
    // A regression to the N+1 shape would be invisible in output but multiply
    // the round trips by the number of accounts.
    // Count at the driver, not at db/pool: lib/users.js destructures query() at
    // require time, so patching the wrapper would intercept nothing.
    const pg = pool.getPool();
    const realQuery = pg.query.bind(pg);
    let calls = 0;
    pg.query = (...args) => { calls++; return realQuery(...args); };
    try {
      await users.listWithStats();
      assert.equal(calls, 1, `expected a single query, made ${calls}`);
    } finally { pg.query = realQuery; }
  });
});

// ── Administration detail (per-user view) ────────────────────────────────────
describe('administration user detail', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  let pool, users, dtCrypto, dtConnections, mailSettings, schedulesDb, reportsDb;
  let erin;

  before(async () => {
    pool = require('./db/pool');
    if (!pool.isReady()) {
      const url = new URL(DB_URL);
      process.env.POSTGRES_HOST     = url.hostname;
      process.env.POSTGRES_PORT     = url.port || '5432';
      process.env.POSTGRES_USER     = decodeURIComponent(url.username);
      process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password) || 'x';
      process.env.POSTGRES_DB       = url.pathname.replace(/^\//, '');
      const { parseConfig } = require('./lib/config');
      pool.init(parseConfig(process.env).db);
      await migrate({ pool: pool.getPool(), dir: MIGRATIONS_DIR });
    }
    users         = require('./lib/users');
    dtCrypto      = require('./lib/crypto');
    dtConnections = require('./lib/dt-connections');
    mailSettings  = require('./lib/mail-settings');
    schedulesDb   = require('./lib/schedules');
    reportsDb     = require('./lib/reports-db');
    const key = dtCrypto.parseEncryptionKey(process.env.SECRET_ENCRYPTION_KEY);
    dtConnections.configure(key);
    mailSettings.configure(key);

    await pool.query("DELETE FROM users WHERE login_id = 'zz_erin'");
    erin = await users.create({
      loginId: 'zz_erin', email: 'erin@example.com', firstName: 'Erin', lastName: 'Elk',
      passwordHash: await dtCrypto.hashPassword('password123'),
    });
  });

  after(async () => {
    if (pool && pool.isReady()) {
      await pool.query("DELETE FROM users WHERE login_id = 'zz_erin'");
      await pool.close();
    }
  });

  test('a brand-new account returns a complete row with empty sections', async () => {
    const d = await users.detailForAdmin('zz_erin');
    assert.ok(d, 'the account must be found');
    assert.equal(d.loginId, 'zz_erin');
    assert.equal(d.dtConfigured, false);
    assert.equal(d.dtHasApiKey, false);
    assert.equal(d.mailEnabled, false);
    assert.equal(d.scheduleEnabled, false);
    assert.equal(d.reportCount, 0);
    assert.equal(Number(d.storageBytes), 0);
    assert.equal(d.sessionIssuedAt, null);
    assert.equal(d.maxReports, 10, 'the seeded default is visible');
  });

  test('configuration is reflected without disclosing any secret', async () => {
    await dtConnections.save(erin.id, { apiUrl: 'https://dt.example.com', apiKey: 'erin_secret_key' });
    await mailSettings.save(erin.id, {
      enabled: true,
      smtp: { host: 'smtp.example.com', port: 587, user: 'erin', pass: 'erin_smtp_pw' },
      from: 'erin@example.com', to: 'a@x.com, b@x.com',
    });
    await schedulesDb.save(erin.id, { enabled: true, frequency: 'weekly', hour: 7 });

    const d = await users.detailForAdmin('zz_erin');
    assert.equal(d.dtConfigured, true);
    assert.equal(d.dtApiUrl, 'https://dt.example.com');
    assert.equal(d.dtHasApiKey, true, 'presence is reported');
    assert.equal(d.mailEnabled, true);
    assert.equal(d.mailRecipients, 2, 'the recipient count, not the addresses');
    assert.equal(d.mailHasPassword, true);
    assert.equal(d.scheduleEnabled, true);
    assert.equal(d.frequency, 'weekly');

    // Neither secret may appear anywhere in the projection.
    const serialised = JSON.stringify(d);
    assert.doesNotMatch(serialised, /erin_secret_key/);
    assert.doesNotMatch(serialised, /erin_smtp_pw/);
    assert.doesNotMatch(serialised, /scrypt\$/);
  });

  test('report counts are broken down by status and scoped to the account', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await reportsDb.create(erin.id, { riskTypes: ['security'], projectCount: 1 });
      ids.push(r.id);
    }
    await reportsDb.storeFile(ids[0], Buffer.alloc(500, 1), 'a.xlsx');
    await reportsDb.storeFile(ids[1], Buffer.alloc(1500, 2), 'b.xlsx');
    await reportsDb.setStatus(ids[2], 'failed', { error: 'nope' });
    try {
      const d = await users.detailForAdmin('zz_erin');
      assert.equal(d.reportCount, 3);
      assert.equal(d.reportsCompleted, 2);
      assert.equal(d.reportsFailed, 1);
      assert.equal(Number(d.storageBytes), 2000);
      assert.ok(d.newestReportAt instanceof Date);
    } finally {
      for (const id of ids) await reportsDb.deleteForUser(erin.id, id);
    }
  });

  test('an unknown login ID returns null rather than throwing', async () => {
    assert.equal(await users.detailForAdmin('zz_nobody_at_all'), null);
  });

  test('the login ID lookup is case-insensitive, matching sign-in', async () => {
    const d = await users.detailForAdmin('ZZ_ERIN');
    assert.ok(d, 'citext means the administrator need not match the stored case');
    assert.equal(d.loginId, 'zz_erin');
  });

  test('it is one query', async () => {
    const pg = pool.getPool();
    const realQuery = pg.query.bind(pg);
    let calls = 0;
    pg.query = (...args) => { calls++; return realQuery(...args); };
    try {
      await users.detailForAdmin('zz_erin');
      assert.equal(calls, 1, `expected a single query, made ${calls}`);
    } finally { pg.query = realQuery; }
  });
});

// ── Registration conflict detection ─────────────────────────────────────────
describe('taken-identifier detection', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  let pool, users, dtCrypto;

  before(async () => {
    pool = require('./db/pool');
    if (!pool.isReady()) {
      const url = new URL(DB_URL);
      process.env.POSTGRES_HOST     = url.hostname;
      process.env.POSTGRES_PORT     = url.port || '5432';
      process.env.POSTGRES_USER     = decodeURIComponent(url.username);
      process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password) || 'x';
      process.env.POSTGRES_DB       = url.pathname.replace(/^\//, '');
      const { parseConfig } = require('./lib/config');
      pool.init(parseConfig(process.env).db);
      await migrate({ pool: pool.getPool(), dir: MIGRATIONS_DIR });
    }
    users    = require('./lib/users');
    dtCrypto = require('./lib/crypto');
    await pool.query("DELETE FROM users WHERE login_id = 'zz_frank'");
    await users.create({
      loginId: 'zz_frank', email: 'frank@example.com', firstName: 'Frank', lastName: 'Fox',
      passwordHash: await dtCrypto.hashPassword('password123'),
    });
  });

  after(async () => {
    if (pool && pool.isReady()) {
      await pool.query("DELETE FROM users WHERE login_id = 'zz_frank'");
      await pool.close();
    }
  });

  test('both clashes are detected in one call', async () => {
    const t = await users.findTakenIdentifiers({ loginId: 'zz_frank', email: 'frank@example.com' });
    assert.deepEqual(t, { loginId: true, email: true });
  });

  test('each clash is detected independently', async () => {
    assert.deepEqual(
      await users.findTakenIdentifiers({ loginId: 'zz_frank', email: 'free@example.com' }),
      { loginId: true, email: false });
    assert.deepEqual(
      await users.findTakenIdentifiers({ loginId: 'zz_free', email: 'frank@example.com' }),
      { loginId: false, email: true });
  });

  test('free identifiers report free', async () => {
    assert.deepEqual(
      await users.findTakenIdentifiers({ loginId: 'zz_free', email: 'free@example.com' }),
      { loginId: false, email: false });
  });

  test('an omitted email is never reported as taken', async () => {
    // Email is optional, and a blank one must not collide with anything.
    for (const email of [null, undefined, '']) {
      assert.deepEqual(
        await users.findTakenIdentifiers({ loginId: 'zz_free', email }),
        { loginId: false, email: false }, `email=${JSON.stringify(email)}`);
    }
  });

  test('detection is case-insensitive, like the unique indexes', async () => {
    assert.deepEqual(
      await users.findTakenIdentifiers({ loginId: 'ZZ_FRANK', email: 'FRANK@EXAMPLE.COM' }),
      { loginId: true, email: true },
      'citext means differing case is still the same identifier');
  });

  test('it is one query for both fields', async () => {
    const pg = pool.getPool();
    const realQuery = pg.query.bind(pg);
    let calls = 0;
    pg.query = (...args) => { calls++; return realQuery(...args); };
    try {
      await users.findTakenIdentifiers({ loginId: 'zz_frank', email: 'frank@example.com' });
      assert.equal(calls, 1);
    } finally { pg.query = realQuery; }
  });
});

// ── The administrator's reserved data identity (migration 004) ──────────────
describe('administrator principal', { skip: !ENABLED && 'TEST_DATABASE_URL not set' }, () => {
  let pool, users, dtCrypto, dtConnections, userSettings, appSettings, reportsDb;

  before(async () => {
    pool = require('./db/pool');
    if (!pool.isReady()) {
      const url = new URL(DB_URL);
      process.env.POSTGRES_HOST     = url.hostname;
      process.env.POSTGRES_PORT     = url.port || '5432';
      process.env.POSTGRES_USER     = decodeURIComponent(url.username);
      process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password) || 'x';
      process.env.POSTGRES_DB       = url.pathname.replace(/^\//, '');
      const { parseConfig } = require('./lib/config');
      pool.init(parseConfig(process.env).db);
      await migrate({ pool: pool.getPool(), dir: MIGRATIONS_DIR });
    }
    users         = require('./lib/users');
    dtCrypto      = require('./lib/crypto');
    dtConnections = require('./lib/dt-connections');
    userSettings  = require('./lib/user-settings');
    appSettings   = require('./lib/app-settings');
    reportsDb     = require('./lib/reports-db');
    dtConnections.configure(dtCrypto.parseEncryptionKey(process.env.SECRET_ENCRYPTION_KEY));
  });

  after(async () => { if (pool && pool.isReady()) await pool.close(); });

  const ADMIN = () => users.ADMIN_PRINCIPAL_ID;

  // A throwaway account for the password-reset tests. Created here rather than
  // borrowed from another block so this suite owns its own data (CLAUDE.md §10.4).
  let alice;
  before(async () => {
    alice = await users.create({
      loginId: 'resettarget', email: null, firstName: 'Reset', lastName: 'Target',
      passwordHash: await dtCrypto.hashPassword('originalpass1'),
    });
  });
  after(async () => { if (alice) await users.deleteById(alice.id); });

  test('the migration seeded the principal and all four per-user rows', async () => {
    const { rows } = await pool.query(
      'SELECT login_id AS "loginId", first_name AS "firstName" FROM users WHERE id = $1', [ADMIN()]);
    assert.equal(rows.length, 1, 'the reserved row must exist');
    assert.equal(rows[0].loginId, '__administrator__');

    for (const t of ['dt_connections', 'user_settings', 'mail_settings', 'schedules']) {
      const { rows: r } = await pool.query(
        `SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [ADMIN()]);
      assert.equal(r[0].n, 1, `${t} must have a row for the administrator`);
    }
  });

  test('re-running the migration changes nothing', async () => {
    // Migrations must be idempotent at the file level (CLAUDE.md §5.3).
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '004_admin_principal.sql'), 'utf8');
    await pool.query(sql);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [ADMIN()]);
    assert.equal(rows[0].n, 1, 'a second application must not duplicate anything');
  });

  test('the administrator gets a working connection through the ordinary module', async () => {
    await dtConnections.save(ADMIN(), {
      apiUrl: 'https://admin-dt.example.com', apiKey: 'admin_own_secret_key',
    });
    const client = await dtConnections.getForClient(ADMIN());
    assert.equal(client.isConfigured, true);
    assert.equal(client.hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(client), /admin_own_secret_key/,
      'the key is no more readable for the administrator than for anyone else');

    const resolved = await dtConnections.getResolved(ADMIN());
    assert.equal(resolved.apiKey, 'admin_own_secret_key');
  });

  test('an administrator password reset and its audit row commit together', async () => {
    // They were two statements. A failure on the second left the password
    // already replaced while the caller was told the reset had failed — the
    // administrator would then retry against a credential that had silently
    // moved. Either both land or neither does.
    const before = await pool.query(
      'SELECT password_hash AS h, must_change_password AS m FROM users WHERE id = $1', [alice.id]);
    const auditBefore = await pool.query(
      "SELECT count(*)::int AS n FROM login_audit WHERE user_id = $1 AND event = 'admin_password_reset'",
      [alice.id]);

    const hash = await dtCrypto.hashPassword('adminchosen123');
    const updated = await users.adminResetPassword(alice.id, hash, { loginIdAttempted: 'resettarget' });
    assert.ok(updated, 'the account exists, so the reset returns it');

    const after = await pool.query(
      'SELECT password_hash AS h, must_change_password AS m FROM users WHERE id = $1', [alice.id]);
    assert.notEqual(after.rows[0].h, before.rows[0].h, 'the hash changed');
    assert.equal(after.rows[0].m, true, 'and the account must now choose its own');

    const auditAfter = await pool.query(
      "SELECT count(*)::int AS n FROM login_audit WHERE user_id = $1 AND event = 'admin_password_reset'",
      [alice.id]);
    assert.equal(auditAfter.rows[0].n, auditBefore.rows[0].n + 1, 'exactly one audit row');
  });

  test('the audit event is accepted by the database, not only by the application', async () => {
    // The event list is a CHECK constraint as well as a Set in login-audit.js.
    // Adding one to the Set alone made the reset fail at the INSERT.
    await pool.query(
      "INSERT INTO login_audit (user_id, login_id_attempted, event) VALUES ($1, 'x', 'admin_password_reset')",
      [alice.id]);
    await assert.rejects(
      () => pool.query(
        "INSERT INTO login_audit (user_id, login_id_attempted, event) VALUES ($1, 'x', 'not_an_event')",
        [alice.id]),
      (e) => e.code === '23514', 'an unknown event must still be refused');
  });

  test('the reserved principal cannot have its password reset', async () => {
    // Their credentials live in the on-disk file. A row that could be reset
    // here would be a second, silent way to authenticate as the administrator.
    const hash = await dtCrypto.hashPassword('shouldnotwork1');
    const result = await users.adminResetPassword(ADMIN(), hash, { loginIdAttempted: '__administrator__' });
    assert.equal(result, null, 'the reserved row must be untouchable');
    const row = await pool.query(
      'SELECT must_change_password AS m FROM users WHERE id = $1', [ADMIN()]);
    assert.equal(row.rows[0].m, false);
  });

  test('completing a password change clears the flag and only the flag', async () => {
    const hash = await dtCrypto.hashPassword('chosenbyme1234');
    const done = await users.completePasswordChange(alice.id, hash);
    assert.ok(done);
    const row = await pool.query(
      'SELECT password_hash AS h, must_change_password AS m FROM users WHERE id = $1', [alice.id]);
    assert.equal(row.rows[0].m, false);
    assert.equal(row.rows[0].h, hash);
  });

  test('verifyLookup carries the flag, so login can act on it', async () => {
    const hash = await dtCrypto.hashPassword('adminchosen456');
    await users.adminResetPassword(alice.id, hash, { loginIdAttempted: 'resettarget' });
    const row = await users.verifyLookup('resettarget');
    assert.equal(row.mustChangePassword, true);
    await users.completePasswordChange(alice.id, hash);
    assert.equal((await users.verifyLookup('resettarget')).mustChangePassword, false);
  });

  test('the administrator takes their quota from the global default', async () => {
    // They are not listed in the administration screen, so no override can ever
    // be set for them through the UI. Their limit is whatever everyone else's
    // default is (CLAUDE.md §7.4).
    const before = await userSettings.get(ADMIN());
    assert.equal(before.maxReportsOverride, null, 'the reserved row inherits');
    try {
      await appSettings.setDefaultMaxReports(42);
      assert.equal(await userSettings.getMaxReports(ADMIN()), 42);
    } finally {
      await appSettings.setDefaultMaxReports(10);
    }
  });

  test('the administrator owns their own reports, scoped like anyone else', async () => {
    const r = await reportsDb.create(ADMIN(), { riskTypes: ['security'], projectCount: 1 });
    try {
      assert.ok(await reportsDb.getForUser(ADMIN(), r.id), 'the administrator can read their own');
      const someoneElse = '11111111-1111-4111-8111-111111111111';
      assert.equal(await reportsDb.getForUser(someoneElse, r.id), null,
        "and nobody else can — the administrator's reports are scoped too");
    } finally { await reportsDb.deleteForUser(ADMIN(), r.id); }
  });

  test('the reserved principal is excluded from the administration listing', async () => {
    const rows = await users.listWithStats();
    assert.equal(rows.some(u => u.id === ADMIN()), false,
      'it holds configuration, it is not an account');
    assert.equal(rows.some(u => u.loginId === '__administrator__'), false);
  });

  test('it is excluded from the account count', async () => {
    const listed = (await users.listWithStats()).length;
    assert.equal(await users.count(), listed,
      'the count and the listing must agree, or the panel contradicts itself');
  });

  test('it cannot be opened as an account detail', async () => {
    assert.equal(await users.detailForAdmin('__administrator__'), null);
  });

  test('the seeded hash cannot authenticate even if the name is submitted', async () => {
    const row = await users.verifyLookup('__administrator__');
    assert.ok(row, 'the row is findable — the protection is the hash, not obscurity');
    for (const attempt of ['', 'password', 'reserved-principal-no-password']) {
      assert.equal(await dtCrypto.verifyPassword(attempt, row.passwordHash), false,
        `"${attempt}" must not authenticate`);
    }
  });
});
