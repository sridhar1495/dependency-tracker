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

    const st = await pool.query('SELECT max_reports AS m FROM user_settings WHERE user_id = $1', [u.id]);
    assert.equal(st.rows[0].m, 10);
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
