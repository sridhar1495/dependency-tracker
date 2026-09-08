// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── End-to-end regression suite ───────────────────────────────────────────────
// The fifth tier (CLAUDE.md §10.2). Everything else tests a unit, a route with
// a stubbed data layer, or the schema. This drives the assembled product: the
// real server.js as a child process, a real PostgreSQL, the real dashboard
// pages behind an nginx-equivalent, and stubs for the only two genuinely
// external things — DependencyTrack and SMTP.
//
//   node --test e2e.test.js                        (skips without a database)
//   TEST_DATABASE_URL=postgres://… node --test e2e.test.js
//
// It is opt-in on the same switch as db.test.js, and it DESTROYS the contents
// of the database that variable points at. Point it at a throwaway.
//
// The browser tier inside it is opt-in again, on whether Playwright can be
// resolved — §3 caps the dependency list at three packages, so it cannot be
// one. Absent, that section skips and the rest still runs. See e2e/README.md.
//
// ── What belongs here, and what does not ──────────────────────────────────────
// A test earns its place here only if it needs the pieces joined up. "Does the
// merge produce the right recipient list" is a unit test; "do those addresses
// reach RCPT TO" is this. Anything provable with a stub belongs in
// server.test.js, which runs in two seconds and offline.
//
// State is shared across tests within a section on purpose: an end-to-end flow
// is a sequence, and re-registering an account per assertion would test the
// registration route forty times and everything else once.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const stackLib = require('./e2e/stack');
const { makeClient, makeSql, resolvePlaywright, chromiumPath } = require('./e2e/client');

const ENABLED = Boolean(process.env.TEST_DATABASE_URL);
const SKIP = !ENABLED && 'TEST_DATABASE_URL not set';

/** @type {any} */ let stack;
/** @type {any} */ let api;
/** @type {any} */ let sql;
/** @type {any} */ let dt;

const PASSWORD = 'correcthorsebatterystaple';
const account = (id) => ({
  loginId: id, email: `${id}@example.com`,
  firstName: 'Test', lastName: 'Person', password: PASSWORD,
});

before(async () => {
  if (!ENABLED) return;
  stack = await stackLib.start();
  api = makeClient(stack.url);
  sql = makeSql(stack.databaseUrl);
  dt = stack.dt;
}, { timeout: 180_000 });

after(async () => {
  if (stack) await stack.stop();
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — registration and password policy', { skip: SKIP }, () => {
  test('a valid account can be created, and the response carries no credential', async () => {
    const r = await api.register(account('alice'));
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.json)}`);
    assert.doesNotMatch(JSON.stringify(r.json || {}), /token|password/i);
  });

  test('a duplicate login ID or email is refused with 409', async () => {
    const dupId = await api.register({ ...account('alice'), email: 'other@example.com' });
    assert.equal(dupId.status, 409);
    const dupMail = await api.register({ ...account('bob'), email: 'alice@example.com' });
    assert.equal(dupMail.status, 409);
  });

  test('the password policy is length-only, and enforced end to end', async () => {
    // §7.1: minimum 12, maximum 128, no spaces, and deliberately no complexity
    // rule. The frontend mirrors this; here it is checked at the route.
    for (const [password, why] of [
      ['short', 'below the minimum'],
      ['a'.repeat(129), 'above the maximum'],
      ['twelve chars plus spaces', 'contains spaces'],
    ]) {
      const r = await api.register({ ...account(`pw${Math.random().toString(36).slice(2, 8)}`), password });
      assert.equal(r.status, 400, `${why} was accepted`);
    }
    const ok = await api.register({ ...account('twelvechars'), password: 'a'.repeat(12) });
    assert.ok(ok.status < 300, 'exactly twelve characters must be accepted');
  });

  test('the reserved login IDs cannot be registered', async () => {
    // Otherwise a database account could shadow the administrator (§7.4).
    for (const loginId of ['admin', 'root', 'system', '__administrator__']) {
      const r = await api.register(account(loginId));
      assert.ok(r.status >= 400, `${loginId} was accepted`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — sessions and tokens', { skip: SKIP }, () => {
  let token;

  test('a wrong password is 401 and names neither factor', async () => {
    const r = await api.login('alice', 'wrongpasswordentirely');
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.json?.error || '', /no such user|unknown user|does not exist/i);
  });

  test('a correct password issues a bearer token that is not a JWT', async () => {
    const r = await api.login('alice', PASSWORD);
    assert.equal(r.status, 200);
    token = r.json.token;
    assert.ok(token);
    assert.notEqual(token.split('.').length, 3, 'a JWT would mean a library crept in (§3)');
  });

  test('a second sign-in conflicts, and forcing it retires the first', async () => {
    // One live session per user, enforced by a partial unique index (§7.2).
    const conflict = await api.login('alice', PASSWORD);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'SESSION_EXISTS');

    const forced = await api.login('alice', PASSWORD, { force: true });
    assert.equal(forced.status, 200);
    const displaced = await api.get('/auth/me', token);
    assert.equal(displaced.status, 401, 'the replaced token must stop working at once');
    token = forced.json.token;
  });

  test('every malformed token shape is one 401 with a stable code', async () => {
    for (const bad of [undefined, 'not-a-token', '']) {
      const r = await api.get('/violation-cache/config', bad);
      assert.equal(r.status, 401);
      assert.equal(r.json.code, 'INVALID_SESSION');
    }
  });

  test('logging out kills the token immediately, not when the cache expires', async () => {
    // §7.3: revocation must evict the 60-second principal cache explicitly.
    const t = await api.signUp(account('logouttest'));
    assert.ok((await api.post('/auth/logout', {}, t)).status < 300);
    assert.equal((await api.get('/auth/me', t)).status, 401);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — brute force and identifier disclosure', { skip: SKIP }, () => {
  test('five failures lock the account out, correct password included', async () => {
    await api.register(account('lockme'));
    for (let i = 0; i < 6; i++) await api.login('lockme', 'wrongpasswordhere');
    const r = await api.login('lockme', PASSWORD);
    assert.equal(r.status, 429, 'the correct password should still be locked out');
  });

  test('the availability check reports "taken" without naming the owner', async () => {
    const r = await api.checkAvailability('loginId', 'alice');
    assert.equal(r.status, 200);
    assert.equal(r.json.available, false);
    assert.doesNotMatch(JSON.stringify(r.json), /alice@|Person/,
      'the response must not identify who holds it (§12)');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — the DependencyTrack connection and its secret', { skip: SKIP }, () => {
  let token;
  before(async () => { if (ENABLED) token = await api.signUp(account('connuser')); });

  test('the connection test probes a real endpoint and reports the version', async () => {
    // §6.2: the probe is /api/v1/project?pageSize=1, because it proves the URL
    // is an API root, the key is accepted, and the key carries VIEW_PORTFOLIO.
    const r = await api.post('/violation-cache/config/test-connection',
      { apiUrl: dt.url, apiKey: dt.apiKey }, token);
    assert.equal(r.status, 200);
    assert.match(JSON.stringify(r.json), /4\.11\.0/, 'the DT version should be reported');
  });

  test('a bad key fails the test rather than being saved', async () => {
    const r = await api.post('/violation-cache/config/test-connection',
      { apiUrl: dt.url, apiKey: 'wrong-key' }, token);
    assert.ok(r.status >= 400 || r.json?.ok === false, `${r.status} ${JSON.stringify(r.json)}`);
  });

  test('the API key is stored but never returned', async () => {
    // §7.7: the UI is told only whether a key is configured.
    assert.equal((await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey })).status, 200);
    const r = await api.get('/violation-cache/config', token);
    assert.ok(!JSON.stringify(r.json).includes(dt.apiKey), 'the API key leaked into a response');
    assert.equal(r.json.connection.hasApiKey, true);
  });

  test('the key is encrypted at rest, not stored in the clear', async () => {
    const rows = await sql(
      `SELECT api_key_ciphertext, api_key_nonce, api_key_tag FROM dt_connections
        WHERE api_key_ciphertext IS NOT NULL LIMIT 1`);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].api_key_nonce && rows[0].api_key_tag, 'AES-256-GCM needs a nonce and a tag');
    assert.ok(!rows[0].api_key_ciphertext.toString('utf8').includes(dt.apiKey),
      'the plaintext key is readable in the database');
  });

  test('the key never appears in the log', async () => {
    // §6.5: DT API keys are redacted to *** plus the last four.
    assert.ok(!stack.log().includes(dt.apiKey), 'the API key was written to the log');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — the DependencyTrack proxy', { skip: SKIP }, () => {
  let token;
  before(async () => {
    if (!ENABLED) return;
    token = await api.signUp(account('proxyuser'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
  });

  test('a GET under /api/v1/ is forwarded with the stored key attached', async () => {
    const r = await api.get('/violation-cache/dt/api/v1/project?onlyRoot=true', token);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
  });

  test('the browser never holds a DependencyTrack credential', async () => {
    // The whole point of the proxy: the key is attached server-side (§8.3).
    const r = await api.get('/violation-cache/dt/api/v1/project?onlyRoot=true', token);
    assert.ok(!JSON.stringify([...r.headers]).includes(dt.apiKey));
  });

  test('only GET, and only under /api/v1/, are allowed through', async () => {
    // §12: this is the outbound trust boundary, and it is bounded by method
    // and path rather than by blocking private address ranges.
    assert.ok((await api.post('/violation-cache/dt/api/v1/project', {}, token)).status >= 400);
    assert.ok((await api.get('/violation-cache/dt/api/version', token)).status >= 400);
  });

  test('the proxy is authenticated like everything else', async () => {
    assert.equal((await api.get('/violation-cache/dt/api/v1/project')).status, 401);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — the violation cache and the risk snapshot it writes', { skip: SKIP }, () => {
  let token;

  before(async () => {
    if (!ENABLED) return;
    token = await api.signUp(account('cacheuser'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
  });

  test('a build runs to completion', async () => {
    const started = await api.post('/violation-cache/refresh', {}, token);
    assert.ok([202, 409].includes(started.status), `${started.status} ${JSON.stringify(started.json)}`);
    const final = await api.waitForCache(token);
    assert.equal(final.status, 'ready', JSON.stringify(final));
  }, { timeout: 150_000 });

  test('the cached map is served gzipped', async () => {
    const res = await fetch(`${stack.url}/violation-cache/data`, { headers: api.bearer(token) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'gzip');
  });

  test('the completed build recorded today, and the window is dense', async () => {
    // §6.3 Q22: the snapshot is written on the way out of a successful build.
    const r = await api.get('/violation-cache/risk-series?period=week', token);
    assert.equal(r.status, 200);
    assert.equal(r.json.points.length, 7, 'a week is seven days whether or not they were captured');
    const today = r.json.points[6];
    assert.equal(today.captured, true, JSON.stringify(today));
    assert.ok(today.sev && today.pol, 'both halves must be stored separately');
  });

  test('a day nobody refreshed comes back uncaptured, never as zero', async () => {
    const r = await api.get('/violation-cache/risk-series?period=week', token);
    const earlier = r.json.points[0];
    assert.equal(earlier.captured, false);
    assert.equal(earlier.sev, null, 'a gap must not be reported as a measurement of zero');
  });

  test('the snapshot sums DependencyTrack\'s ACTIVE ROOT projects, and nothing else', async () => {
    // The agreement between the graph and the KPI tiles. Summing every project
    // double-counts, because a parent's numbers already carry its descendants'.
    const roots = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=true`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    const expected = roots.reduce((a, p) => a + (p.metrics.critical || 0), 0);
    const r = await api.get('/violation-cache/risk-series?period=week', token);
    const today = r.json.points[6];
    assert.equal(today.sev.critical, expected);
    assert.equal(today.rootProjectCount, roots.length);
  });

  test('the crawl asks for exactly onlyRoot and excludeInactive', async () => {
    const projectCalls = dt.calls().filter(c => c.includes('/api/v1/project?'));
    assert.ok(projectCalls.some(c => c.includes('onlyRoot=true') && c.includes('excludeInactive=true')),
      `no snapshot crawl seen in: ${projectCalls.slice(0, 4).join(' | ')}`);
  });

  test('the three periods are the only ones accepted', async () => {
    for (const [period, days] of [['week', 7], ['month', 30], ['year', 365]]) {
      const r = await api.get(`/violation-cache/risk-series?period=${period}`, token);
      assert.equal(r.json.points.length, days, period);
    }
    for (const bad of ['decade', '7', '', 'WEEK']) {
      const r = await api.get(`/violation-cache/risk-series?period=${bad}`, token);
      assert.equal(r.status, 400, `period=${JSON.stringify(bad)} should be refused`);
      assert.equal(r.json.code, 'INVALID_PERIOD');
    }
    // Absent is different from empty: absent means "you choose".
    const none = await api.get('/violation-cache/risk-series', token);
    assert.equal(none.json.period, 'week');
  });

  test('one row per connection per day, whatever the build count', async () => {
    await api.post('/violation-cache/refresh', {}, token);
    await api.waitForCache(token);
    const rows = await sql(
      `SELECT count(*)::int AS n FROM risk_snapshots
        GROUP BY fingerprint, day ORDER BY n DESC LIMIT 1`);
    assert.equal(rows[0].n, 1, 'a second build on the same day must overwrite, not append');
  }, { timeout: 150_000 });

  test('an unreadable API key does not break the trend panel', async () => {
    // S34: the series reads the fingerprint through getForClient, so it never
    // decrypts a secret it has no use for. Swapping in getResolved is invisible
    // from outside until a key cannot be decrypted — at which point the whole
    // panel would 503 over a graph that never needed the key. Corrupting the
    // ciphertext is the only way to observe that from end to end.
    const token = await api.signUp(account('unreadablekey'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    const [{ id }] = await sql(`SELECT id FROM users WHERE login_id = 'unreadablekey'`);
    await sql(
      `UPDATE dt_connections SET api_key_ciphertext = decode('00ff00ff','hex') WHERE user_id = $1`, [id]);

    const series = await api.get('/violation-cache/risk-series?period=week', token);
    assert.equal(series.status, 200, `a graph must not 503 on a key it does not read (${series.status})`);
    assert.equal(series.json.points.length, 7);

    // And the routes that genuinely need the key still say so, actionably.
    const data = await api.get('/violation-cache/data', token);
    assert.ok(data.status >= 400, 'a route that needs the key must not pretend it worked');
    assert.match(JSON.stringify(data.json), /re-enter|could not be read/i,
      'the user should be told to re-enter the key (§7.7)');
  }, { timeout: 60_000 });

  test('history outlives the cache row it was built from', async () => {
    // Migration 012 declares no foreign key on purpose: housekeeping deletes
    // cache rows routinely, and a cascade would take a year of history with it.
    const [{ fingerprint }] = await sql(
      'SELECT fingerprint FROM risk_snapshots LIMIT 1');
    const before = await sql('SELECT count(*)::int AS n FROM risk_snapshots WHERE fingerprint = $1', [fingerprint]);
    await sql('DELETE FROM violation_caches WHERE fingerprint = $1', [fingerprint]);
    const after = await sql('SELECT count(*)::int AS n FROM risk_snapshots WHERE fingerprint = $1', [fingerprint]);
    assert.equal(after[0].n, before[0].n, 'deleting the cache row destroyed the history');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — isolation between accounts', { skip: SKIP }, () => {
  let owner, other, reportId, scheduleId, rootUuid;

  before(async () => {
    if (!ENABLED) return;
    owner = await api.signUp(account('owner'));
    other = await api.signUp(account('intruder'));
    await api.saveConnection(owner, { apiUrl: dt.url, apiKey: dt.apiKey });
    const roots = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=true`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    rootUuid = roots[0].uuid;

    const rep = await api.generateReport(owner, {
      projects: [{ uuid: rootUuid, name: roots[0].name, version: '' }],
    });
    reportId = rep.json && rep.json.id;
    const sch = await api.createSchedule(owner, {
      name: 'owned', frequency: 'daily', hour: 9, minute: 0, riskTypes: ['security'],
      projects: [{ uuid: rootUuid, name: roots[0].name, version: '' }],
    });
    scheduleId = sch.json && sch.json.schedule && sch.json.schedule.id;
  }, { timeout: 120_000 });

  test('a fresh account sees no connection and no history', async () => {
    const cfg = await api.get('/violation-cache/config', other);
    assert.notEqual(cfg.json.connection.isConfigured, true);
    const series = await api.get('/violation-cache/risk-series?period=week', other);
    assert.equal(series.json.configured, false);
    assert.ok(series.json.points.every(p => !p.captured));
  });

  test('every cross-account read is 404, never 403', async () => {
    // §7.5: confirming another user's resource exists is itself a disclosure.
    const probes = [
      ['GET', `/violation-cache/report/${reportId}/download`],
      ['GET', `/violation-cache/schedules/${scheduleId}/runs`],
    ];
    for (const [method, path] of probes) {
      const r = await api.request(path, { method, headers: api.bearer(other) });
      assert.equal(r.status, 404, `${method} ${path} answered ${r.status}`);
    }
  });

  test('every cross-account write is 404 too', async () => {
    assert.equal((await api.del(`/violation-cache/report/${reportId}`, other)).status, 404);
    assert.equal((await api.put(`/violation-cache/schedules/${scheduleId}`, { subject: 'x' }, other)).status, 404);
    assert.equal((await api.del(`/violation-cache/schedules/${scheduleId}`, other)).status, 404);
  });

  test('accounts sharing one connection share one cache and one history', async () => {
    // The performance-by-design guarantee: N users on one DT cause one crawl.
    await api.saveConnection(other, { apiUrl: dt.url, apiKey: dt.apiKey });
    const mine = await api.get('/violation-cache/risk-series?period=week', owner);
    const theirs = await api.get('/violation-cache/risk-series?period=week', other);
    assert.equal(theirs.json.configured, true);
    assert.deepEqual(theirs.json.points.map(p => p.captured), mine.json.points.map(p => p.captured),
      'the same connection must yield the same series');

    const fps = await sql('SELECT count(DISTINCT fingerprint)::int AS n FROM violation_caches');
    const conns = await sql('SELECT count(*)::int AS n FROM dt_connections WHERE fingerprint IS NOT NULL');
    assert.ok(fps[0].n <= conns[0].n, 'a cache per account would defeat the shared build');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — reports', { skip: SKIP }, () => {
  let token, project;

  before(async () => {
    if (!ENABLED) return;
    token = await api.signUp(account('reportuser'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    const roots = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=true`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    project = { uuid: roots[0].uuid, name: roots[0].name, version: '' };
  });

  test('a report is generated and downloads as a real workbook', async () => {
    const started = await api.generateReport(token, { projects: [project] });
    assert.ok(started.status < 300, `${started.status} ${JSON.stringify(started.json)}`);
    const done = await api.waitForReport(token, started.json.id);
    assert.equal(done && done.status, 'completed', JSON.stringify(done));

    const res = await fetch(`${stack.url}/violation-cache/report/${started.json.id}/download`,
      { headers: api.bearer(token) });
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200);
    assert.equal(bytes.subarray(0, 2).toString(), 'PK', 'an xlsx is a zip');
    assert.match(res.headers.get('content-disposition') || '', /filename/i);
  }, { timeout: 150_000 });

  test('a report name is validated, not sanitised', async () => {
    // §6.7: it becomes a filename and travels in a Content-Disposition header,
    // so what would break either is refused rather than silently rewritten.
    for (const reportName of ['a/b', 'a"b', '../escape', 'nul byte']) {
      const r = await api.generateReport(token, { projects: [project], reportName });
      assert.equal(r.status, 400, `${JSON.stringify(reportName)} was accepted`);
    }
  });

  test('an ordinary name is accepted and kept', async () => {
    const r = await api.generateReport(token, { projects: [project], reportName: 'Quarterly review' });
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.json)}`);
    assert.match(r.json.filename, /Quarterly review/);
  });

  test('the CWE summary adds no upstream call beyond /api/v1/finding', async () => {
    // §6.7: cwes and vulnId are already in the finding response.
    const seen = dt.calls().filter(c => c.startsWith('GET /api/v1/'));
    const unexpected = seen.filter(c =>
      !/\/api\/v1\/(project|violation|finding)/.test(c));
    assert.deepEqual(unexpected, [], `unexpected upstream calls: ${unexpected.join(', ')}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — schedules: the three CC states and the body override', { skip: SKIP }, () => {
  let token, project, id;

  before(async () => {
    if (!ENABLED) return;
    token = await api.signUp(account('scheduser'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    const roots = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=true`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    project = { uuid: roots[0].uuid, name: roots[0].name, version: '' };
  });

  test('a new schedule inherits everything from the account', async () => {
    const r = await api.createSchedule(token, {
      name: 'inherits', frequency: 'weekly', hour: 9, minute: 30, weekDays: [1],
      riskTypes: ['operational'], projects: [project],
    });
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.json)}`);
    id = r.json.schedule.id;

    const s = (await api.listSchedules(token)).find(x => x.id === id);
    assert.equal(s.ccEnabled, true, 'inherit is the default');
    assert.ok(s.cc === null || s.cc === undefined);
    assert.ok(s.mailBody === null || s.mailBody === undefined);
  });

  test('"copy nobody" is reachable, and distinct from "inherit"', async () => {
    // The three states migration 011 made expressible over the wire. JSON
    // cannot distinguish the middle one without the ccEnabled flag.
    await api.put(`/violation-cache/schedules/${id}`,
      { to: 'ops@example.com', ccEnabled: false, subject: 'Ops', mailBody: 'Please review.' }, token);
    let s = (await api.listSchedules(token)).find(x => x.id === id);
    assert.equal(s.ccEnabled, false, 'copy-nobody must survive the round trip');
    assert.equal(s.mailBody, 'Please review.');

    await api.put(`/violation-cache/schedules/${id}`, { ccEnabled: true, cc: '' }, token);
    s = (await api.listSchedules(token)).find(x => x.id === id);
    assert.equal(s.ccEnabled, true);
    assert.ok(s.cc === null || s.cc === undefined, 'switching back on returns to inherit');
  });

  test('the database refuses a To override addressed to nobody', async () => {
    // An empty to_addrs is a silent outage rather than a configuration, so the
    // CHECK rejects it — with cardinality(), which array_length() would not.
    await assert.rejects(
      sql(`UPDATE schedules SET to_addrs = '{}'::text[] WHERE id = $1`, [id]),
      /sched_to_addrs_nonempty/);
  });

  test('the quota blocks at the administrator\'s limit and never deletes', async () => {
    const before = (await api.listSchedules(token)).length;
    let blocked = null;
    for (let i = 0; i < 40; i++) {
      const r = await api.createSchedule(token, {
        name: `q${i}`, frequency: 'daily', hour: 8, minute: 0,
        riskTypes: ['security'], projects: [project],
      });
      if (r.status >= 400) { blocked = r; break; }
    }
    assert.ok(blocked, 'the schedule quota was never reached');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.code, 'QUOTA_REACHED');
    assert.ok((await api.listSchedules(token)).length >= before,
      'being over a limit must block, never trim (§7.5)');
  }, { timeout: 120_000 });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — scheduled delivery, asserted at the SMTP envelope', { skip: SKIP }, () => {
  let token, project;

  /** Trigger a run and wait for it to reach a terminal state. */
  async function sendNowAndWait(id) {
    const r = await api.post(`/violation-cache/schedules/${id}/run-now`, {}, token);
    assert.ok(r.status < 300, `Send now answered ${r.status} ${JSON.stringify(r.json)}`);
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const rows = await sql(
        `SELECT status FROM schedule_runs WHERE schedule_id = $1 ORDER BY id DESC LIMIT 1`, [id]);
      if (rows[0] && ['success', 'failed'].includes(rows[0].status)) return rows[0].status;
      await new Promise(s => setTimeout(s, 250));
    }
    return 'timeout';
  }

  before(async () => {
    if (!ENABLED) return;
    token = await api.signUp(account('mailuser'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    await api.saveMail(token, {
      enabled: true, from: 'dashboard@example.com',
      to: 'account-to@example.com', cc: 'account-cc@example.com',
      subject: 'Account subject', body: 'Account body',
      smtp: { host: stack.smtp.host, port: stack.smtp.port, secure: false, user: 'u', pass: 'p' },
    });
    const roots = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=true`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    project = { uuid: roots[0].uuid, name: roots[0].name, version: '' };
  }, { timeout: 60_000 });

  test('a schedule that inherits reaches the account recipients', async () => {
    stack.smtp.reset();
    const r = await api.createSchedule(token, {
      name: 'inherit-all', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security'], projects: [project],
    });
    assert.equal(await sendNowAndWait(r.json.schedule.id), 'success');

    const mail = await stack.smtp.waitFor('account-to@example.com', 10_000);
    assert.ok(mail, 'no message reached the account To address');
    assert.match(mail.to.join(','), /account-cc@example.com/, 'the account CC should be copied');
    assert.match(mail.data, /^Subject: Account subject$/m);
  }, { timeout: 180_000 });

  test('an override replaces To, and "copy nobody" really sends no CC', async () => {
    stack.smtp.reset();
    const r = await api.createSchedule(token, {
      name: 'override-nobody', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security'], projects: [project],
      to: 'only-me@example.com', ccEnabled: false,
      subject: 'Override subject', mailBody: 'Override body text',
    });
    assert.equal(await sendNowAndWait(r.json.schedule.id), 'success');

    const mail = await stack.smtp.waitFor('only-me@example.com', 10_000);
    assert.ok(mail, 'no message reached the override To address');
    assert.doesNotMatch(mail.to.join(','), /account-cc@example.com/,
      'copy-nobody still copied the account list');
    assert.match(mail.data, /^Subject: Override subject$/m);
    assert.match(mail.data, /Override body text/);
    assert.doesNotMatch(mail.data, /Account body/, 'both bodies were sent');
    assert.match(mail.data, /Content-Disposition:\s*attachment/i);
    assert.match(mail.data, /\.xlsx/);
  }, { timeout: 180_000 });

  test('overriding To no longer silently drops the account CC', async () => {
    // The implicit rule migration 011 retired. With a visible switch, dropping
    // CC behind the user's back while the switch reads "on" is the surprise.
    stack.smtp.reset();
    const r = await api.createSchedule(token, {
      name: 'override-inherit-cc', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security'], projects: [project],
      to: 'elsewhere@example.com', ccEnabled: true,
    });
    assert.equal(await sendNowAndWait(r.json.schedule.id), 'success');

    const mail = await stack.smtp.waitFor('elsewhere@example.com', 10_000);
    assert.ok(mail, 'no message reached the override To address');
    assert.match(mail.to.join(','), /account-cc@example.com/,
      'the account CC must still be copied when only To is overridden');
    assert.match(mail.data, /^Subject: Account subject$/m, 'the subject should still be inherited');
  }, { timeout: 180_000 });

  test('one account runs one schedule at a time', async () => {
    // The guarantee claimOne()'s NOT EXISTS clause exists to keep: five
    // schedules due at 09:00 must not open five crawls against one connection.
    const a = await api.createSchedule(token, {
      name: 'race-a', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security'], projects: [project],
    });
    const b = await api.createSchedule(token, {
      name: 'race-b', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security'], projects: [project],
    });
    const first = await api.post(`/violation-cache/schedules/${a.json.schedule.id}/run-now`, {}, token);
    assert.ok(first.status < 300);
    const second = await api.post(`/violation-cache/schedules/${b.json.schedule.id}/run-now`, {}, token);
    assert.equal(second.status, 409, 'a second concurrent run should be refused');
    assert.equal(second.json.code, 'ALREADY_RUNNING');
    await sendNowAndWait(a.json.schedule.id).catch(() => {});
  }, { timeout: 180_000 });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — the database after the product has used it', { skip: SKIP }, () => {
  test('a manual run does not move the timetable', async () => {
    // Recomputing next_run_at would push a Monday 09:00 schedule a week every
    // time somebody tested it (§6.8).
    const rows = await sql(
      `SELECT id, next_run_at FROM schedules WHERE last_run_at IS NOT NULL
        ORDER BY last_run_at DESC LIMIT 1`);
    assert.ok(rows.length, 'expected at least one schedule to have run');
    const after = await sql('SELECT next_run_at FROM schedules WHERE id = $1', [rows[0].id]);
    assert.deepEqual(after[0].next_run_at, rows[0].next_run_at);
  });

  test('cancelling a schedule keeps the record that it ran', async () => {
    // schedule_projects cascades; schedule_runs is ON DELETE SET NULL.
    const ran = await sql(
      `SELECT schedule_id FROM schedule_runs WHERE schedule_id IS NOT NULL
        AND status = 'success' ORDER BY id DESC LIMIT 1`);
    assert.ok(ran.length, 'expected a completed run to exist');
    const id = ran[0].schedule_id;

    const before = await sql('SELECT count(*)::int AS n FROM schedule_runs WHERE schedule_id IS NULL');
    await sql('DELETE FROM schedules WHERE id = $1', [id]);
    const after = await sql('SELECT count(*)::int AS n FROM schedule_runs WHERE schedule_id IS NULL');
    assert.ok(after[0].n > before[0].n, 'the run record went with the schedule');
    const projects = await sql('SELECT count(*)::int AS n FROM schedule_projects WHERE schedule_id = $1', [id]);
    assert.equal(projects[0].n, 0, 'the project rows should have cascaded');
  });

  test('deleting an account removes everything it owns and nothing it does not', async () => {
    const token = await api.signUp(account('deleteme'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    const [{ id }] = await sql(`SELECT id FROM users WHERE login_id = 'deleteme'`);

    const owned = await sql(
      `SELECT (SELECT count(*) FROM dt_connections WHERE user_id = $1)
            + (SELECT count(*) FROM user_settings  WHERE user_id = $1)
            + (SELECT count(*) FROM user_sessions  WHERE user_id = $1) AS n`, [id]);
    assert.ok(Number(owned[0].n) >= 2, 'expected the account to own rows across the schema');

    assert.ok((await api.del('/auth/account', token, { password: PASSWORD })).status < 300);
    const left = await sql(
      `SELECT (SELECT count(*) FROM users          WHERE id = $1)
            + (SELECT count(*) FROM dt_connections WHERE user_id = $1)
            + (SELECT count(*) FROM user_settings  WHERE user_id = $1)
            + (SELECT count(*) FROM user_sessions  WHERE user_id = $1) AS n`, [id]);
    assert.equal(Number(left[0].n), 0, 'an owned row survived the cascade');

    const audit = await sql(
      `SELECT count(*)::int AS n FROM login_audit WHERE login_id_attempted = 'deleteme'`);
    assert.ok(audit[0].n >= 1, 'the audit trail must survive account deletion (§5.4)');
    assert.equal((await api.get('/auth/me', token)).status, 401);
  }, { timeout: 60_000 });

  test('no snapshot ever stored a negative count', async () => {
    const rows = await sql(
      `SELECT count(*)::int AS n FROM risk_snapshots
        WHERE sev_critical < 0 OR sev_high < 0 OR ops_fail < 0 OR secpol_fail < 0`);
    assert.equal(rows[0].n, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — administration', { skip: SKIP }, () => {
  let adminToken, userToken;

  before(async () => {
    if (!ENABLED) return;
    const r = await api.login(stack.admin.loginId, stack.admin.password, { isAdmin: true, force: true });
    adminToken = r.json && r.json.token;
    userToken = await api.signUp(account('ordinary'));
  });

  test('the administrator signs in against the credentials file', async () => {
    // §7.4: never against the database.
    assert.ok(adminToken, 'administrator sign-in failed');
    const me = await api.get('/auth/me', adminToken);
    assert.equal(me.json.user.isAdmin, true);
  });

  test('the readable surface exposes no credential', async () => {
    const r = await api.get('/admin/users', adminToken);
    assert.equal(r.status, 200);
    const body = JSON.stringify(r.json);
    assert.doesNotMatch(body, /scrypt\$/, 'a password hash reached the listing');
    assert.doesNotMatch(body, /__administrator__/, 'the reserved principal must be excluded');
  });

  test('an ordinary account is refused administration with 403', async () => {
    // 403 rather than 404 here: the route exists, the principal is simply not
    // permitted — which is different from another user's resource (§11.1).
    assert.equal((await api.get('/admin/users', userToken)).status, 403);
    assert.equal((await api.get('/admin/overview', userToken)).status, 403);
  });

  test('the write allow-list is closed', async () => {
    // §7.6: exactly six writes are handled, and adding a seventh means editing
    // the list in a diff somebody reads.
    for (const [method, path] of [
      ['DELETE', '/admin/users/ordinary'],
      ['POST', '/admin/users'],
      ['PUT', '/admin/overview'],
      ['DELETE', '/admin/settings'],
    ]) {
      const r = await api.request(path, { method, headers: api.bearer(adminToken) });
      assert.ok([404, 405].includes(r.status), `${method} ${path} answered ${r.status}`);
    }
  });

  test('the administrator cannot edit a profile or reset the reserved row', async () => {
    assert.ok((await api.put('/profile', { firstName: 'Nope' }, adminToken)).status >= 400);
    const r = await api.post('/admin/users/__administrator__/password', { password: PASSWORD }, adminToken);
    assert.ok(r.status >= 400, 'there must be no second way to authenticate as the administrator');
  });

  test('a password reset signs the account out and forces a change', async () => {
    // S29: the password the administrator typed can only ever be spent
    // replacing itself.
    const victim = await api.signUp(account('resetme'));
    assert.equal((await api.get('/auth/me', victim)).status, 200);

    const reset = await api.post('/admin/users/resetme/password', { password: 'TemporaryPass1234' }, adminToken);
    assert.ok(reset.status < 300, `${reset.status} ${JSON.stringify(reset.json)}`);
    assert.equal((await api.get('/auth/me', victim)).status, 401, 'the old session must be revoked');

    const back = await api.login('resetme', 'TemporaryPass1234');
    assert.equal(back.status, 200);
    const gated = await api.get('/violation-cache/config', back.json.token);
    assert.equal(gated.status, 403);
    assert.equal(gated.json.code, 'PASSWORD_CHANGE_REQUIRED');

    const audit = await sql(
      `SELECT count(*)::int AS n FROM login_audit WHERE login_id_attempted = 'resetme'`);
    assert.ok(audit[0].n >= 1, 'every reset must be audited');
  }, { timeout: 60_000 });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('e2e — the public surface', { skip: SKIP }, () => {
  test('/healthz says only that the process is listening', async () => {
    // S33: it must disclose exactly what a closed port would.
    const r = await api.get('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: 'ok' });
  });

  test('/branding is public and carries no account data', async () => {
    // S32: the sign-in page reads it before a token exists.
    const r = await api.get('/branding');
    assert.equal(r.status, 200);
    assert.doesNotMatch(JSON.stringify(r.json), /user|account|email|count/i);
  });

  test('everything else is authenticated by default', async () => {
    // §6.6: a new route is private unless it is added to PUBLIC_PATHS.
    for (const path of [
      '/violation-cache/config', '/violation-cache/status', '/violation-cache/data',
      '/violation-cache/risk-series', '/violation-cache/report/list',
      '/violation-cache/schedules', '/profile', '/admin/users', '/auth/me',
    ]) {
      assert.equal((await api.get(path)).status, 401, `${path} is reachable without a token`);
    }
  });

  test('an unknown route is a JSON 404 with a stable code', async () => {
    const r = await api.get('/violation-cache/no-such-route', await api.signUp(account('probe404')));
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'NOT_FOUND');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The browser tier. Opt-in on whether Playwright resolves, because §3 forbids
// making it a dependency. See e2e/README.md for how to provide it.
// ══════════════════════════════════════════════════════════════════════════════
const playwright = ENABLED ? resolvePlaywright() : null;
const BROWSER_SKIP = SKIP || (!playwright && 'Playwright is not available — see e2e/README.md');

describe('e2e — the dashboard in a real browser', { skip: BROWSER_SKIP }, () => {
  let browser, page, token, errors;
  const USER = account('browseruser');

  before(async () => {
    if (BROWSER_SKIP) return;
    token = await api.signUp(USER);
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    await api.saveMail(token, {
      enabled: true, from: 'dashboard@example.com', to: 'team@example.com',
      subject: 'Subject', body: 'Body',
      smtp: { host: stack.smtp.host, port: stack.smtp.port, secure: false, user: 'u', pass: 'p' },
    });
    await api.post('/violation-cache/refresh', {}, token);
    await api.waitForCache(token);

    // Seed history with deliberate gaps, so the carry-forward drawing (Q23) is
    // exercised rather than a single-point series.
    const [{ fingerprint }] = await sql(
      `SELECT fingerprint FROM dt_connections WHERE fingerprint IS NOT NULL LIMIT 1`);
    for (const daysAgo of [6, 5, 3]) {
      await sql(
        `INSERT INTO risk_snapshots
           (fingerprint, day, root_project_count, sev_critical, sev_high, sev_medium,
            sev_low, sev_unassigned, ops_fail, ops_warn, ops_info,
            lic_fail, lic_warn, lic_info, secpol_fail, secpol_warn, secpol_info)
         VALUES ($1, CURRENT_DATE - $2::int, 3, 4, 12, 20, 5, 2, 6, 3, 0, 3, 0, 9, 3, 6, 0)
         ON CONFLICT (fingerprint, day) DO NOTHING`, [fingerprint, daysAgo]);
    }
    await api.post('/auth/logout', {}, token);

    browser = await playwright.chromium.launch({ executablePath: chromiumPath() });
    errors = [];
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', e => errors.push(e.message));
  }, { timeout: 180_000 });

  after(async () => { if (browser) await browser.close(); });

  test('the auth gate redirects before painting anything', async () => {
    // §8.4: the gate runs in <head>, so a signed-out visitor never sees a
    // dashboard flash.
    await page.goto(`${stack.url}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    assert.match(page.url(), /login\.html/);

    await page.evaluate(() => localStorage.setItem('dt_session_token', 'not-a-valid-token'));
    await page.goto(`${stack.url}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    assert.match(page.url(), /login\.html/, 'an expired token must also be sent back');
  }, { timeout: 60_000 });

  test('signing in through the form reaches the dashboard', async () => {
    await page.goto(`${stack.url}/login.html`, { waitUntil: 'networkidle' });
    await page.locator('#liLoginId').fill(USER.loginId);
    await page.locator('#liPassword').fill(USER.password);
    await page.locator('#liSubmit').click();
    await page.waitForTimeout(2500);
    if (await page.locator('#sessionModal').isVisible().catch(() => false)) {
      await page.locator('#sessionModal .btn.primary').first().click();
      await page.waitForTimeout(2500);
    }
    assert.doesNotMatch(page.url(), /login\.html/);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('booting')), false);
  }, { timeout: 90_000 });

  test('the table, the cards and the live banner all render', async () => {
    await page.waitForTimeout(2500);
    assert.ok(await page.locator('#tableBody tr').count() > 0, 'no project rows rendered');
    assert.ok(await page.locator('.summary-card').count() >= 5);
    assert.match(await page.locator('#dataBanner').textContent(), /Live/i);
    assert.equal(await page.locator('#searchInput').isDisabled(), false,
      'table controls should be enabled once there is a table (§8.5)');
  }, { timeout: 60_000 });

  test('the vulnerability dialog opens from the eye icon and lists real findings', async () => {
    // The eye icon only appears on a leaf row with at least one finding
    // (CLAUDE.md §8.1 vulnerability dialog rules) — the dt-stub portfolio
    // guarantees leaf 101 has one, but this scans for whichever row actually
    // has the icon rather than assuming a project name or position.
    const eyeBtn = page.locator('.vuln-eye-btn').first();
    await eyeBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const projectTitle = await eyeBtn.getAttribute('title');
    await eyeBtn.click();
    await page.waitForTimeout(1200);

    assert.equal(await page.locator('#vulnDialog').evaluate(e => e.classList.contains('open')), true,
      'the dialog should be open');
    assert.match(await page.locator('#vulnDialogProject').textContent(), /\S/, 'the project name should be shown');

    const rows = page.locator('#vulnDialogRows tr');
    await rows.first().waitFor({ state: 'attached', timeout: 10_000 });
    const rowCount = await rows.count();
    assert.ok(rowCount > 0, 'the stub seeded findings for this project — the dialog must show them');
    assert.equal(await page.locator('#vulnDialogTableWrap').isHidden(), false);

    // Column order and content: Vulnerability, Severity, CVSS, CWE, Component,
    // Current, Latest — matching the report workbook's own columns (§6.7).
    const firstRow = await rows.first().locator('td').allTextContents();
    assert.equal(firstRow.length, 7);
    assert.match(firstRow[0], /^CVE-/, 'the vulnerability id column');
    assert.ok(/CRITICAL|HIGH|MEDIUM|LOW/i.test(firstRow[1]), 'the severity pill column');

    // Sorted worst-first: the first row's severity pill class must be at least
    // as severe as the last row's, never the reverse.
    const sevOf = t => ['critical', 'high', 'medium', 'low', 'unassigned'].indexOf(t.trim().toLowerCase());
    const lastRow = await rows.last().locator('td').allTextContents();
    assert.ok(sevOf(firstRow[1]) <= sevOf(lastRow[1]), 'rows should be worst-severity-first');

    assert.doesNotMatch(projectTitle, /<|>/, 'the title attribute must be free of raw markup (escHtml)');

    await page.locator('#vulnDialog .modal-close').click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#vulnDialog').evaluate(e => e.classList.contains('open')), false);
  }, { timeout: 60_000 });

  test('a clean project (no findings) shows no eye icon at all', async () => {
    // hasVulnerabilities() gates the icon — this is a structural guarantee,
    // not just a visual one, so it is checked against the live rendered table
    // rather than only against the pure helper in dashboard.test.js.
    const iconCount = await page.locator('.vuln-eye-btn').count();
    const rowCount = await page.locator('#tableBody tr').count();
    assert.ok(iconCount < rowCount, 'at least one row (a group, or a clean leaf) must have no icon');
  });

  test('the trend chart agrees with the KPI card above it', async () => {
    // The reason the default metric is the tile arithmetic: two different
    // numbers for "Critical" on one screen is a support ticket.
    const both = await page.evaluate(() => {
      const s = window.__trendSeries();
      const point = s.points[s.points.length - 1];
      const card = [...document.querySelectorAll('.summary-card')]
        .find(e => /Critical/i.test(e.textContent));
      return {
        chart: window.__trendValues(point, 'total').critical,
        tile: parseInt(card.querySelector('.value').textContent.trim(), 10),
      };
    });
    assert.equal(both.chart, both.tile, `chart ${both.chart} vs tile ${both.tile}`);
  });

  test('an unrefreshed day is carried forward and marked as carried', async () => {
    // Q23: continuous to read, impossible to quote as a measurement.
    assert.ok(await page.locator('#trendCharts svg rect.trend-gap-band').count() >= 1,
      'the carried stretch should be shaded');
    assert.equal(await page.evaluate(() => {
      const p = document.querySelector('#trendCharts svg path[fill-opacity]');
      return (p.getAttribute('d').match(/M/g) || []).length;
    }), 1, 'the stacked area should be one continuous shape');
    assert.equal(await page.evaluate(() => {
      const captured = window.__trendSeries().points.filter(p => p.captured).length;
      return document.querySelectorAll('#trendCharts svg circle').length === captured * 4;
    }), true, 'only measured days may carry a marker');
    assert.match(await page.locator('#trendLegend').textContent(), /carried forward/);
  });

  test('the tooltip names the day a carried number came from', async () => {
    const gapIndex = await page.evaluate(() => {
      const s = window.__trendSeries();
      for (let i = 1; i < s.points.length; i++) {
        if (!s.points[i].captured && s.points.slice(0, i).some(p => p.captured)) return i;
      }
      return -1;
    });
    assert.ok(gapIndex > 0, 'the seeded series should contain a mid-series gap');

    const box = await page.locator('#trendCharts svg').boundingBox();
    const geom = await page.evaluate(() => {
      const c = document.querySelector('.trend-cell');
      return { x0: Number(c.dataset.x0), x1: Number(c.dataset.x1), vb: Number(c.dataset.width) };
    });
    const n = await page.evaluate(() => window.__trendSeries().points.length);
    const vx = geom.x0 + (geom.x1 - geom.x0) * (gapIndex / (n - 1));
    await page.mouse.move(box.x + (vx / geom.vb) * box.width, box.y + box.height * 0.5);
    await page.waitForTimeout(400);

    const tip = await page.locator('#trendTip').textContent();
    assert.match(tip, /No refresh that day/);
    assert.match(tip, /reading/, 'it must name the day the number came from');
    assert.equal(await page.locator('#trendTip .trend-tip-row').count(), 4,
      'the four values should still be readable');
    await page.mouse.move(5, 5);
  }, { timeout: 60_000 });

  test('every trend control works', async () => {
    await page.click('#trendChartType'); await page.waitForTimeout(300);
    assert.ok(await page.locator('#trendCharts svg path[fill="none"]').count() >= 4, 'lines');
    await page.click('#trendChartType'); await page.waitForTimeout(300);

    await page.click('#trendSplit'); await page.waitForTimeout(400);
    assert.equal(await page.locator('#trendCharts svg').count(), 4, 'four small multiples');
    await page.click('#trendChartType'); await page.waitForTimeout(300);
    assert.ok(await page.locator('#trendCharts svg rect[fill-opacity]').count() > 0, 'bars');
    await page.click('#trendChartType'); await page.click('#trendSplit'); await page.waitForTimeout(400);

    for (const [period, days] of [['month', 30], ['year', 365]]) {
      await page.selectOption('#trendPeriod', period);
      await page.waitForTimeout(900);
      assert.equal(await page.evaluate(() => window.__trendSeries().points.length), days, period);
    }
    await page.selectOption('#trendPeriod', 'week'); await page.waitForTimeout(700);
  }, { timeout: 90_000 });

  test('the panel remembers whether it was collapsed', async () => {
    // clientWidth of a hidden element is zero, so the collapsed state also has
    // to survive without caching every chart at padding width (§8.1).
    await page.click('#trendToggle'); await page.waitForTimeout(300);
    assert.equal(await page.locator('#trendBody').isHidden(), true);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    assert.equal(await page.locator('#trendBody').isHidden(), true);
    await page.click('#trendToggle'); await page.waitForTimeout(600);
    assert.equal(await page.locator('#trendCharts svg').count(), 1, 're-opening should redraw');
  }, { timeout: 90_000 });

  test('the settings panel shows one footer and never the stored key', async () => {
    await page.click('#settingsBtn'); await page.waitForTimeout(900);
    assert.ok(!(await page.content()).includes(dt.apiKey), 'the API key reached the DOM');

    const footers = await page.evaluate(() =>
      [...document.querySelectorAll('.cfg-panel-footer')].filter(e => e.offsetParent !== null).length);
    assert.equal(footers, 1, 'two footers on screen is the defect PR #115 fixed');

    const gaps = await page.evaluate(() => ({
      main: getComputedStyle(document.getElementById('cfgMainView')).rowGap,
      sched: getComputedStyle(document.getElementById('cfgSchedView')).rowGap,
    }));
    assert.equal(gaps.main, gaps.sched, 'both views must space their sections the same (§8.10)');
    assert.notEqual(gaps.main, '0px');
    await page.locator('.cfg-close').first().click();
    await page.waitForTimeout(600);
  }, { timeout: 60_000 });

  test('the schedule drill-down opens from the toolbar and Cancel goes back', async () => {
    // A schedule is created where the project selection lives, not in Settings.
    const box = page.locator('#tableBody input[type=checkbox]').first();
    if (await box.count()) { await box.click({ force: true }); await page.waitForTimeout(400); }
    await page.click('#genReportBtn'); await page.waitForTimeout(400);
    await page.locator('#rptDropMenu button:has-text("Schedule Reports")').click();
    await page.waitForTimeout(1200);

    assert.equal(await page.locator('#cfgSchedView').isVisible(), true);
    assert.equal(await page.evaluate(() =>
      [...document.querySelectorAll('.cfg-panel-footer')].filter(e => e.offsetParent !== null).length), 1);
    assert.match(await page.locator('#cfgSaveBtn').textContent(), /schedule/i,
      'the primary button must say which of the two things it saves');
    assert.equal(await page.locator('#cfgSchedCcEnabled').count(), 1);
    assert.equal(await page.locator('#cfgSchedMessage').count(), 1);

    // Turning CC off clears and disables the field, because a blank field with
    // the switch on means "inherit" — a different instruction (§8.1).
    const cc = page.locator('#cfgSchedCc');
    await page.locator('#cfgSchedCcEnabled').click(); await page.waitForTimeout(400);
    assert.equal(await cc.isDisabled(), true);
    assert.match(await cc.getAttribute('placeholder'), /no copy|nobody/i);
    await page.locator('#cfgSchedCcEnabled').click(); await page.waitForTimeout(400);
    assert.equal(await cc.isDisabled(), false);

    // Dirty: Cancel must ask, and both answers are documented behaviour.
    await page.locator('#cfgCancelBtn').click(); await page.waitForTimeout(700);
    assert.equal(await page.locator('#confirmModal').evaluate(e => e.classList.contains('open')), true);
    await page.locator('#confirmCancelBtn').click(); await page.waitForTimeout(700);
    assert.equal(await page.locator('#cfgSchedView').isVisible(), true, 'keep editing should stay');

    await page.locator('#cfgCancelBtn').click(); await page.waitForTimeout(700);
    await page.locator('#confirmOkBtn').click(); await page.waitForTimeout(900);
    assert.equal(await page.locator('#cfgMainView').isVisible(), true);
    assert.equal(await page.locator('#configPanel').first().evaluate(e => e.classList.contains('open')), true,
      'Cancel in the editor is one step back, never a dismissal');
    await page.locator('.cfg-close').first().click(); await page.waitForTimeout(600);
  }, { timeout: 120_000 });

  test('the CSV export neutralises formula-leading cells', async () => {
    // §12: Excel evaluates a quoted cell too, and project names come from SBOM
    // metadata rather than from the operator.
    const download = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await page.click('#exportBtn');
    const file = await download;
    assert.ok(file, 'no CSV download was offered');
    const csv = require('fs').readFileSync(await file.path(), 'utf8');
    const risky = csv.split('\n').slice(1).filter(l => /^"?[=+\-@]/.test(l));
    assert.deepEqual(risky, [], 'a cell begins with a formula character');
  }, { timeout: 60_000 });

  test('the theme switches and the charts follow it without JavaScript', async () => {
    // An SVG fill of var(--critical) re-resolves on the switch exactly as a
    // div's background does (§8.1).
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.click('#themeBtn'); await page.waitForTimeout(400);
    assert.notEqual(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), before);
    assert.equal(await page.evaluate(() => {
      const p = document.querySelector('#trendCharts svg path[fill-opacity], #trendCharts svg path[stroke]');
      return /var\(--/.test(p.getAttribute('fill') || p.getAttribute('stroke') || '');
    }), true);
    await page.click('#themeBtn'); await page.waitForTimeout(300);
  }, { timeout: 60_000 });

  test('an ordinary account cannot reach the administration screen', async () => {
    // §8.4: being signed in is not enough, so the page is not shown at all.
    await page.goto(`${stack.url}/admin.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    assert.doesNotMatch(page.url(), /admin\.html/);
  }, { timeout: 60_000 });

  test('the administration screen loads for the administrator and leaks nothing', async () => {
    const admin = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    admin.on('pageerror', e => errors.push(e.message));
    await admin.goto(`${stack.url}/login.html`, { waitUntil: 'networkidle' });
    await admin.locator('#liIsAdmin').check().catch(() => {});
    await admin.locator('#liLoginId').fill(stack.admin.loginId);
    await admin.locator('#liPassword').fill(stack.admin.password);
    await admin.locator('#liSubmit').click();
    await admin.waitForTimeout(2500);
    if (await admin.locator('#sessionModal').isVisible().catch(() => false)) {
      await admin.locator('#sessionModal .btn.primary').first().click();
      await admin.waitForTimeout(2500);
    }
    await admin.goto(`${stack.url}/admin.html`, { waitUntil: 'networkidle' });
    await admin.waitForTimeout(2000);

    assert.match(admin.url(), /admin\.html/);
    const html = await admin.content();
    assert.doesNotMatch(html, /scrypt\$/, 'a password hash was rendered');
    assert.doesNotMatch(html, /__administrator__/, 'the reserved principal was listed');
    await admin.close();
  }, { timeout: 120_000 });

  test('nothing threw anywhere in the browser run', async () => {
    assert.deepEqual(errors, []);
  });
});
