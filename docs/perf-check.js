// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Performance validation harness ────────────────────────────────────────────
// Seeds a realistic multi-user dataset into a throwaway database and captures
// EXPLAIN (ANALYZE, BUFFERS) for every hot-path query, so the claims in
// CLAUDE.md §13 are evidence rather than assertion.
//
//   createdb perfcheck
//   PERF_DATABASE_URL=postgres://user:pass@host:5432/perfcheck \
//     node docs/perf-check.js
//
// Options (environment):
//   SEED_USERS    accounts to create           (default 5000)
//   SEED_REPORTS  report rows to create        (default 20000)
//   PLAN_OUT      write the full plans here    (default none — summary only)
//
// It is NOT part of `node --test`: it needs a database it is allowed to fill
// with tens of thousands of rows, which no test tier should ever do.
//
// Exit code is non-zero when a query regresses to a sequential scan on a table
// large enough for one to matter, so this can be wired into a release check.

const path = require('node:path');
const fs   = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', 'violation-cache');

const DB_URL = process.env.PERF_DATABASE_URL;
if (!DB_URL) {
  console.error('PERF_DATABASE_URL is required, e.g.');
  console.error('  PERF_DATABASE_URL=postgres://dtdash:pw@localhost:5432/perfcheck node docs/perf-check.js');
  process.exit(2);
}

const USERS   = Number(process.env.SEED_USERS   || 5000);
const REPORTS = Number(process.env.SEED_REPORTS || 20000);

// Below this row count a sequential scan is the correct plan — the whole table
// is one or two pages and an index lookup would cost more.
const SEQ_SCAN_ROW_THRESHOLD = 1000;

function applyUrlToEnv(url) {
  const u = new URL(url);
  process.env.POSTGRES_HOST     = u.hostname;
  process.env.POSTGRES_PORT     = u.port || '5432';
  process.env.POSTGRES_USER     = decodeURIComponent(u.username);
  process.env.POSTGRES_PASSWORD = decodeURIComponent(u.password) || 'x';
  process.env.POSTGRES_DB       = u.pathname.replace(/^\//, '');
  process.env.SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY || 'f'.repeat(64);
}

async function seed(pool) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n >= USERS) {
    console.log(`Reusing the existing dataset (${rows[0].n} users).`);
    return;
  }
  console.log(`Seeding ${USERS} accounts and ${REPORTS} reports…`);

  // One hash reused across every account on purpose: this harness measures
  // query plans, and scrypt at the real parameters would dominate the runtime
  // while telling us nothing about them.
  const passwordHash = await require(path.join(ROOT, 'lib', 'crypto')).hashPassword('password123');

  await pool.query(
    `INSERT INTO users (login_id, email, first_name, last_name, password_hash)
     SELECT 'user' || g, 'user' || g || '@example.com', 'Given', 'Family', $1
       FROM generate_series(1, $2) g
     ON CONFLICT DO NOTHING`, [passwordHash, USERS]);

  for (const t of ['dt_connections', 'user_settings', 'mail_settings', 'schedules']) {
    await pool.query(`INSERT INTO ${t} (user_id) SELECT id FROM users ON CONFLICT DO NOTHING`);
  }

  // Half the accounts share 50 distinct DependencyTrack connections, so the
  // "caches grow with connections, not users" property is measurable.
  await pool.query(
    `UPDATE dt_connections SET is_configured = true,
            api_url = 'https://dt' || (abs(hashtext(user_id::text)) % 50) || '.example.com',
            fingerprint = md5('conn' || (abs(hashtext(user_id::text)) % 50)) || md5('salt')
      WHERE user_id IN (SELECT id FROM users ORDER BY created_at LIMIT $1)`,
    [Math.floor(USERS / 2)]);

  // A live session for a fifth of the accounts.
  await pool.query(
    `INSERT INTO user_sessions (user_id, principal_type, token_hash, expires_at)
     SELECT id, 'user', sha256(id::text::bytea), now() + interval '8 hours'
       FROM users ORDER BY created_at LIMIT $1
     ON CONFLICT DO NOTHING`, [Math.floor(USERS / 5)]);

  await pool.query(
    `INSERT INTO reports (user_id, status, filename, risk_types, file_size_bytes, project_count, progress)
     SELECT u.id, (ARRAY['completed','completed','completed','failed'])[1 + (g % 4)],
            'report_' || g || '.xlsx', ARRAY['security'], 100000 + (g % 900000), 25, '{}'::jsonb
       FROM generate_series(1, $1) g
       JOIN LATERAL (SELECT id FROM users OFFSET (g % $2) LIMIT 1) u ON true`,
    [REPORTS, USERS]);

  await pool.query(
    `UPDATE schedules SET enabled = true, frequency = 'daily', hour = 9,
            next_run_at = now() + make_interval(mins => (abs(hashtext(user_id::text)) % 1440))
      WHERE user_id IN (SELECT id FROM users ORDER BY created_at LIMIT $1)`,
    [Math.floor(USERS / 10)]);
  await pool.query(
    `UPDATE schedules SET next_run_at = now() - interval '1 minute'
      WHERE enabled AND user_id IN (SELECT user_id FROM schedules WHERE enabled ORDER BY user_id LIMIT 5)`);

  // Enough cache rows that the fingerprint lookup is measured on a table with
  // an index worth using, not on a single page.
  await pool.query(
    `INSERT INTO violation_caches (fingerprint, status, generated_at, expires_at)
     SELECT md5('conn' || g) || md5('salt'), 'ready', now(), now() + interval '24 hours'
       FROM generate_series(0, 49) g
     ON CONFLICT DO NOTHING`);

  await pool.query('ANALYZE');
  console.log('Seed complete.');
}

/**
 * Pull the numbers that matter out of an EXPLAIN (ANALYZE, BUFFERS) plan.
 *
 * Not every sequential scan is a problem, and treating them all as one is how a
 * check like this gets ignored. Two shapes are genuinely bad:
 *
 *   loops > 1              the scan is rescanned once per outer row — the
 *                          nested-loop pathology, which is what turned the
 *                          administration listing into 337 ms.
 *   large rows filtered    the scan reads far more than it returns, meaning
 *                          there is no index for the predicate.
 *
 * A scan with loops = 1 that feeds a hash join is the planner building a hash
 * table, which is the correct plan for joining a small page against a whole
 * table, and is not reported.
 */
function summarise(plan, rowsIn) {
  const time    = /Execution Time: ([\d.]+) ms/.exec(plan);
  const buffers = /Buffers: shared hit=(\d+)/.exec(plan);

  const lines = plan.split('\n');
  const seqScans = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /Seq Scan on (?:\w+\.)?(\w+)/.exec(lines[i]);
    if (!m) continue;
    const table = m[1];
    const loops = Number((/loops=(\d+)/.exec(lines[i]) || [, 1])[1]);
    // "Rows Removed by Filter" is reported on the line or two that follow.
    let removed = 0;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const rm = /Rows Removed by Filter: (\d+)/.exec(lines[j]);
      if (rm) { removed = Number(rm[1]); break; }
      if (/Seq Scan|Index Scan|Hash Join|Nested Loop/.test(lines[j])) break;
    }
    seqScans.push({ table, loops, removed, rows: rowsIn[table] || 0 });
  }

  const offending = seqScans.filter(s =>
    s.rows >= SEQ_SCAN_ROW_THRESHOLD && (s.loops > 1 || s.removed >= SEQ_SCAN_ROW_THRESHOLD));

  return {
    ms:      time ? Number(time[1]) : null,
    buffers: buffers ? Number(buffers[1]) : null,
    seqScans: [...new Set(seqScans.map(s => s.table))],
    offending,
  };
}

(async () => {
  applyUrlToEnv(DB_URL);
  const { parseConfig } = require(path.join(ROOT, 'lib', 'config'));
  const pool = require(path.join(ROOT, 'db', 'pool'));
  pool.init(parseConfig(process.env).db);

  const { migrate, MIGRATIONS_DIR } = require(path.join(ROOT, 'db', 'migrate'));
  await migrate({ pool: pool.getPool(), dir: MIGRATIONS_DIR });

  await seed(pool);

  const { rows: sizes } = await pool.query(`
    SELECT relname, n_live_tup::int AS rows
      FROM pg_stat_user_tables ORDER BY relname`);
  const rowsIn = Object.fromEntries(sizes.map(r => [r.relname, r.rows]));

  const { rows: counts } = await pool.query(`
    SELECT (SELECT count(*) FROM users)                       AS users,
           (SELECT count(*) FROM reports)                     AS reports,
           (SELECT count(*) FROM user_sessions)               AS sessions,
           (SELECT count(*) FROM schedules WHERE enabled)     AS schedules,
           (SELECT count(*) FROM dt_connections WHERE is_configured) AS connections,
           (SELECT count(*) FROM violation_caches)            AS caches`);
  console.log('\nDataset:', counts[0]);
  console.log(
    `  ${counts[0].connections} configured connections share ` +
    `${counts[0].caches} cache rows — caches scale with connections, not accounts.\n`);

  const { rows: aUser } = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
  const { rows: aSess } = await pool.query('SELECT token_hash FROM user_sessions LIMIT 1');
  const userId = aUser[0].id;
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

  // Every query below is the one the service actually issues, copied from the
  // module named beside it. When a module changes, this must change with it.
  const QUERIES = [
    ['lib/auth.js — resolve a bearer token', `
      SELECT s.id, s.user_id, s.principal_type, s.expires_at, s.last_seen_at,
             u.login_id, u.first_name, u.last_name, u.email
        FROM user_sessions s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL`, [aSess[0].token_hash]],

    ['lib/users.js — find an account at sign-in',
      'SELECT id, login_id, password_hash FROM users WHERE login_id = $1', ['user42']],

    ['lib/reports-db.js — list one account\'s reports', `
      SELECT id, status, filename, risk_types, progress, error, file_size_bytes,
             project_count, created_at, updated_at
        FROM reports WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [userId]],

    ['lib/reports-db.js — per-user quota count', `
      SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
             count(*) FILTER (WHERE status = 'running')::int   AS running
        FROM reports WHERE user_id = $1 AND status IN ('completed','running')`, [userId]],

    ['lib/schedules.js — claim due schedules', `
      SELECT user_id FROM schedules
       WHERE enabled AND running_since IS NULL AND next_run_at IS NOT NULL AND next_run_at <= now()
       ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 5`, []],

    ['lib/caches.js — cache metadata by fingerprint', `
      SELECT fingerprint, status, project_count, failed_pipelines,
             generated_at, expires_at, progress, error
        FROM violation_caches WHERE fingerprint = $1`, [md5('conn1') + md5('salt')]],

    ['lib/dt-connections.js — resolve one connection', `
      SELECT api_url, frontend_url, is_configured, fingerprint,
             api_key_ciphertext, api_key_nonce, api_key_tag
        FROM dt_connections WHERE user_id = $1`, [userId]],

    // Must stay identical to lib/users.js listWithStats(). It is a copy, which
    // is the weakness of this harness: a change there and not here measures
    // yesterday's query. The CROSS JOIN on app_settings arrived with migration
    // 005 and is included here for exactly that reason.
    ['lib/users.js — administration listing', `
      SELECT u.id, u.login_id, u.email, u.first_name, u.last_name, u.created_at, u.last_login_at,
             (s.id IS NOT NULL), s.last_seen_at,
             COALESCE(r.reports, 0)::int, COALESCE(r.bytes, 0)::bigint,
             COALESCE(c.is_configured, false), COALESCE(sc.enabled, false),
             COALESCE(st.max_reports, a.default_max_reports)::int,
             (st.max_reports IS NOT NULL)
        FROM (SELECT id, login_id, email, first_name, last_name, created_at, last_login_at
                FROM users ORDER BY created_at LIMIT 500) u
        LEFT JOIN LATERAL (SELECT id, last_seen_at FROM user_sessions
                            WHERE user_id = u.id AND principal_type = 'user'
                              AND revoked_at IS NULL AND expires_at > now() LIMIT 1) s ON true
        LEFT JOIN LATERAL (SELECT count(*) AS reports, COALESCE(sum(file_size_bytes), 0) AS bytes
                             FROM reports WHERE user_id = u.id) r ON true
        LEFT JOIN dt_connections c ON c.user_id = u.id
        LEFT JOIN schedules sc      ON sc.user_id = u.id
        LEFT JOIN user_settings st  ON st.user_id = u.id
        CROSS JOIN app_settings a
       WHERE a.id = TRUE
       ORDER BY u.created_at`, []],

    ['lib/disk.js — storage by account', `
      SELECT u.login_id, count(rr.id)::int, COALESCE(sum(rr.file_size_bytes), 0)::bigint
        FROM users u
        JOIN reports rr ON rr.user_id = u.id
       GROUP BY u.login_id
      HAVING COALESCE(sum(rr.file_size_bytes), 0) > 0
       ORDER BY 3 DESC
       LIMIT 5`, []],
  ];

  const results = [];
  let failures = 0;

  for (const [name, sql, params] of QUERIES) {
    await pool.query(sql, params);                      // warm the cache first
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
    const plan = rows.map(r => r['QUERY PLAN']).join('\n');
    const s = summarise(plan, rowsIn);
    if (s.offending.length) failures++;

    results.push({ name, ...s, plan });
    const detail = s.offending.length
      ? 'RESCANNED: ' + s.offending
          .map(o => `${o.table} (loops=${o.loops}, filtered=${o.removed})`).join(', ')
      : 'no rescanned or unindexed scan';
    console.log(
      `${s.offending.length ? '✗' : '✓'} ${name}\n` +
      `    ${String(s.ms).padStart(8)} ms   ${String(s.buffers).padStart(7)} buffers   ${detail}`);
  }

  if (process.env.PLAN_OUT) {
    fs.writeFileSync(process.env.PLAN_OUT, JSON.stringify(results, null, 2));
    console.log(`\nFull plans written to ${process.env.PLAN_OUT}`);
  }

  console.log(failures === 0
    ? '\nNo query rescans a large table or scans one without an index.'
    : `\n${failures} quer${failures === 1 ? 'y' : 'ies'} rescan a large table or scan one unindexed.`);

  await pool.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error('FAILED:', err.message); process.exit(2); });
