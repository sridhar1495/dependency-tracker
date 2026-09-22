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

const { test, describe, before, after, afterEach } = require('node:test');
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

  test('Q39: the snapshot rolls the hierarchy up the way the table does', async () => {
    // This used to sum the roots' own reported metrics, and that was the right
    // answer while nothing was rolled up. It is not any more: the stub's root 4
    // is an AGGREGATE_LATEST_VERSION_CHILDREN collection over a stale child
    // (critical 5) and a latest one (critical 3), so "what DT reported for the
    // roots" and "what the cards show" are now different numbers — and the
    // graph has to be the second one, or it contradicts the tiles directly
    // above it (§6.3).
    const all = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=false`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    const list = Array.isArray(all) ? all : all.values;
    const byUuid = new Map(list.map(p => [p.uuid, p]));
    const childrenOf = (uuid) => list.filter(p => p.parent && p.parent.uuid === uuid);

    // Recompute the expectation independently of lib/project-tree.js, so this
    // is a check on the product rather than the same function twice.
    const rollup = (p) => {
      const kids = childrenOf(p.uuid);
      if (!kids.length) return p.metrics.critical || 0;
      const counted = p.collectionLogic === 'AGGREGATE_LATEST_VERSION_CHILDREN'
        ? kids.filter(k => k.isLatest === true) : kids;
      return counted.reduce((a, k) => a + rollup(k), 0);
    };
    const roots = list.filter(p => !p.parent || !byUuid.has(p.parent.uuid));
    const expected = roots.reduce((a, p) => a + rollup(p), 0);

    const r = await api.get('/violation-cache/risk-series?period=week', token);
    const today = r.json.points[6];
    assert.equal(today.sev.critical, expected,
      'the snapshot must equal the collection-aware roll-up, not the roots as reported');
    assert.equal(today.rootProjectCount, roots.length, 'descendants are not roots');

    // And the specific number the defect turned on: root 4 contributes its
    // latest child's 3, never 3 + 5.
    const collection = list.find(p => p.collectionLogic === 'AGGREGATE_LATEST_VERSION_CHILDREN');
    assert.ok(collection, 'the stub should still carry a collection root');
    assert.equal(rollup(collection), 3, 'the fixture itself must still pose the question');
  });

  test('Q39: the crawl sweeps the whole active portfolio, in one request', async () => {
    // Narrowed, not dropped: onlyRoot flipped because the roll-up needs the
    // descendants, but "active only" and "never a request per parent" are the
    // halves that still bound what this costs DependencyTrack (§13, Q34).
    const projectCalls = dt.calls().filter(c => c.includes('/api/v1/project?'));
    assert.ok(projectCalls.some(c => c.includes('onlyRoot=false') && c.includes('excludeInactive=true')),
      `no snapshot crawl seen in: ${projectCalls.slice(0, 4).join(' | ')}`);
    assert.ok(!dt.calls().some(c => c.includes('/children')),
      'the hierarchy comes from parent links, never a per-parent descent');
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

  test('Q37: the workbook marks Direct/Transitive and prints the real chain', async () => {
    // Against the stub's actual dependency graph, not a hand-written fixture:
    // each leaf declares a `carrier-for-<leaf>` direct component, half its
    // findings hang off the carrier, and its two license violations reuse one
    // direct and one transitive component. So a report over a leaf must come
    // back with both labels present and a chain that names the carrier.
    const all = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=false`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    const leaf = (Array.isArray(all) ? all : all.values).find(p => /^service-/.test(p.name));
    assert.ok(leaf, 'the stub portfolio should contain a leaf project');

    const started = await api.generateReport(token, {
      projects: [{ uuid: leaf.uuid, name: leaf.name, version: leaf.version || '' }],
      riskTypes: ['security', 'license'],
    });
    assert.ok(started.status < 300, `${started.status} ${JSON.stringify(started.json)}`);
    const done = await api.waitForReport(token, started.json.id);
    assert.equal(done && done.status, 'completed', JSON.stringify(done));

    const res = await fetch(`${stack.url}/violation-cache/report/${started.json.id}/download`,
      { headers: api.bearer(token) });
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));

    const headers = (ws) => ws.getRow(1).values.slice(1).map(String);
    const column  = (ws, header) => {
      const i = headers(ws).indexOf(header) + 1;
      assert.ok(i > 0, `${ws.name} has no ${header} column: ${headers(ws).join(', ')}`);
      const out = [];
      ws.eachRow((row, n) => { if (n > 1) out.push(String(row.getCell(i).value ?? '')); });
      return out;
    };

    // ── Security findings ──────────────────────────────────────────────────
    const sv = wb.getWorksheet('SV_Vulnerability Findings');
    const svOrigin = column(sv, 'Origin');
    const svPath   = column(sv, 'Dependency Path');
    assert.ok(svOrigin.length > 0, 'the leaf should have findings to report on');
    assert.ok(svOrigin.includes('Direct'), `no Direct row: ${JSON.stringify(svOrigin)}`);
    assert.ok(svOrigin.includes('Transitive'), `no Transitive row: ${JSON.stringify(svOrigin)}`);
    assert.ok(!svOrigin.includes(''), 'every row must be classified — a blank means Tier 1 failed');

    // The chain is real: it names the intermediate carrier, not just the target.
    const chains = svPath.filter(v => v.includes('\u2192'));
    assert.ok(chains.length > 0, `no chain was printed: ${JSON.stringify(svPath)}`);
    for (const c of chains) assert.match(c, /carrier-for-/, 'the chain must name the component in between');
    // And a Direct row is blank rather than carrying somebody else's chain.
    svOrigin.forEach((o, i) => {
      if (o === 'Direct') assert.equal(svPath[i], '', 'a direct component has no chain');
    });
    assert.ok(!svPath.includes('Not resolved'),
      'the walk should have completed for every transitive row in this report');

    // ── License risk ───────────────────────────────────────────────────────
    const lr = wb.getWorksheet('LR_Violations');
    const lrOrigin = column(lr, 'Origin');
    assert.ok(lrOrigin.includes('Direct') && lrOrigin.includes('Transitive'),
      `the stub seeds one of each: ${JSON.stringify(lrOrigin)}`);
    const lrChains = column(lr, 'Dependency Path').filter(v => v.includes('\u2192'));
    assert.ok(lrChains.length > 0, 'the license sheet must print the chain too');
    for (const c of lrChains) assert.match(c, /carrier-for-/);

    const uniq = wb.getWorksheet('LR_Unique Risks');
    assert.ok(headers(uniq).includes('Origin'));
    assert.ok(headers(uniq).includes('Dependency Path'));
    const uniqOrigin = column(uniq, 'Origin');
    const uniqPath   = column(uniq, 'Dependency Path');
    assert.ok(uniqOrigin.length > 0, 'the leaf seeds license violations, so this sheet has rows');
    for (const v of uniqOrigin) {
      assert.ok(['Direct', 'Transitive', 'Mixed'].includes(v), `unexpected aggregate origin ${JSON.stringify(v)}`);
    }
    // Every line in the aggregated cell names the project(s) it belongs to —
    // that attribution is the whole reason this column is safe to add to a
    // sheet that folds several projects into one row.
    uniqOrigin.forEach((o, i) => {
      const lines = uniqPath[i].split('\n').filter(Boolean);
      assert.ok(lines.length > 0, `a ${o} row must say something: ${JSON.stringify(uniqPath[i])}`);
      for (const line of lines) {
        assert.match(line, /\((?:[^()]+)\)$|^(?:Direct in|No path recorded|Not resolved): /,
          `every line must attribute itself to projects: ${JSON.stringify(line)}`);
      }
      if (o === 'Direct') {
        assert.match(lines[0], /^Direct in: /, 'a wholly-direct row says where, and shows no chain');
        assert.equal(lines.length, 1);
      }
      if (o === 'Transitive') {
        assert.ok(!lines.some(l => l.startsWith('Direct in:')),
          'a wholly-transitive row must not claim a direct project');
        assert.ok(lines.some(l => l.includes('carrier-for-')),
          `the real chain should appear here too: ${JSON.stringify(lines)}`);
      }
    });

    // §6.3a/Q26 end to end: one Tier-1 read for the project, and a graph walk
    // scoped to it — never a call per finding.
    const projectReads = dt.calls().filter(c => c.includes(`/api/v1/project/${leaf.uuid}`)).length;
    assert.ok(projectReads >= 1 && projectReads <= 4,
      `Tier 1 is once per project, not once per finding: ${projectReads}`);
  }, { timeout: 180_000 });

  test('Q37: a second report reuses the cached walk instead of re-crawling the graph', async () => {
    // The dependency_paths cache is shared by fingerprint (§7.5), so the walk
    // the previous test paid for must serve this one — that is the whole
    // reason origin resolution goes through runJob rather than walkGraph.
    const all = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=false`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    const leaf = (Array.isArray(all) ? all : all.values).find(p => /^service-/.test(p.name));

    dt.reset();
    const started = await api.generateReport(token, {
      projects: [{ uuid: leaf.uuid, name: leaf.name, version: leaf.version || '' }],
      riskTypes: ['security'],
    });
    const done = await api.waitForReport(token, started.json.id);
    assert.equal(done && done.status, 'completed', JSON.stringify(done));

    const graphCalls = dt.calls().filter(c => c.includes('/dependencyGraph/')).length;
    assert.equal(graphCalls, 0,
      `a cached walk must not be re-crawled: ${graphCalls} dependencyGraph calls`);
  }, { timeout: 180_000 });

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
  let token, project, adminToken;

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
    adminToken = (await api.login(stack.admin.loginId, stack.admin.password,
      { isAdmin: true, force: true })).json.token;
    // The SMTP connection is the administrator's, entirely (Q52) — every
    // account in this describe sends through this one server.
    await api.saveAdminMail(adminToken, {
      enabled: true,
      smtp: { host: stack.smtp.host, port: stack.smtp.port, secure: false, user: 'u', pass: 'p' },
      from: 'installation@example.com',
    });
    token = await api.signUp(account('mailuser'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    await api.saveMail(token, {
      enabled: true, from: 'dashboard@example.com',
      to: 'account-to@example.com', cc: 'account-cc@example.com',
      subject: 'Account subject', body: 'Account body',
    });
    const roots = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=true`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    project = { uuid: roots[0].uuid, name: roots[0].name, version: '' };
  }, { timeout: 60_000 });

  after(async () => {
    if (!ENABLED) return;
    await api.del('/admin/mail', adminToken);
  });

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

describe('e2e — the installation SMTP server and schedule pause/resume (Q52)', { skip: SKIP }, () => {
  let token, project, adminToken;

  async function sendNowAndWait(id) {
    const r = await api.post(`/violation-cache/schedules/${id}/run-now`, {}, token);
    if (r.status >= 300) return { status: r.status, code: r.json && r.json.code };
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const rows = await sql(
        `SELECT status FROM schedule_runs WHERE schedule_id = $1 ORDER BY id DESC LIMIT 1`, [id]);
      if (rows[0] && ['success', 'failed'].includes(rows[0].status)) return { status: 200, runStatus: rows[0].status };
      await new Promise(s => setTimeout(s, 250));
    }
    return { status: 200, runStatus: 'timeout' };
  }

  before(async () => {
    if (!ENABLED) return;
    adminToken = (await api.login(stack.admin.loginId, stack.admin.password,
      { isAdmin: true, force: true })).json.token;
    token = await api.signUp(account('defaultmailuser'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    await api.saveMail(token, { enabled: true, to: 'reachedby-install@example.com' });
    const roots = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=true`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    project = { uuid: roots[0].uuid, name: roots[0].name, version: '' };
  }, { timeout: 60_000 });

  afterEach(async () => {
    await api.del('/admin/mail', adminToken);
  });

  test('an enabled account sends through the installation\'s configured connection', async () => {
    const put = await api.saveAdminMail(adminToken, {
      enabled: true,
      smtp: { host: stack.smtp.host, port: stack.smtp.port, secure: false, user: 'u', pass: 'p' },
      from: 'installation-default@example.com',
    });
    assert.equal(put.status, 200, JSON.stringify(put.json));

    stack.smtp.reset();
    const r = await api.createSchedule(token, {
      name: 'via-install', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security'], projects: [project],
    });
    const result = await sendNowAndWait(r.json.schedule.id);
    assert.equal(result.runStatus, 'success', JSON.stringify(result));

    const mail = await stack.smtp.waitFor('reachedby-install@example.com', 10_000);
    assert.ok(mail, 'no message reached the account\'s recipient through the installation server');
    assert.match(mail.data, /From:.*installation-default@example\.com/i);
  }, { timeout: 180_000 });

  test('no connection configured refuses a send, rather than silently doing nothing', async () => {
    // No connection configured at all — afterEach already cleared it.
    const r = await api.createSchedule(token, {
      name: 'no-connection', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security'], projects: [project],
    });
    const result = await sendNowAndWait(r.json.schedule.id);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'MAIL_NOT_CONFIGURED');
  }, { timeout: 60_000 });

  test('an outage pauses an enabled schedule, and recovery resumes exactly it — a user\'s own pause survives', async () => {
    await api.saveAdminMail(adminToken, {
      enabled: true,
      smtp: { host: stack.smtp.host, port: stack.smtp.port, secure: false, user: 'u', pass: 'p' },
      from: 'installation-default@example.com',
    });
    const armed = await api.createSchedule(token, {
      name: 'armed-before-outage', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security'], projects: [project],
    });
    // A schedule is created disabled (schema default); arming it is what
    // disableAllEnabledForSmtp() below actually needs to find.
    const arm1 = await api.post(`/violation-cache/schedules/${armed.json.schedule.id}/arm`, {}, token);
    assert.equal(arm1.status, 200, JSON.stringify(arm1.json));

    // A second schedule the user arms, then disables THEMSELVES, before the
    // outage — this must never come back on its own.
    const ownPause = await api.createSchedule(token, {
      name: 'user-paused', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security'], projects: [project],
    });
    await api.post(`/violation-cache/schedules/${ownPause.json.schedule.id}/arm`, {}, token);
    await api.post(`/violation-cache/schedules/${ownPause.json.schedule.id}/disable`, {}, token);

    // The outage: clearing the connection must pause the armed schedule.
    const cleared = await api.del('/admin/mail', adminToken);
    assert.equal(cleared.status, 200);
    assert.ok(cleared.json.schedulesPaused >= 1, JSON.stringify(cleared.json));
    let list = await api.listSchedules(token);
    let armedRow = list.find(s => s.id === armed.json.schedule.id);
    assert.equal(armedRow.enabled, false);
    assert.equal(armedRow.disabledBySmtp, true);
    let ownRow = list.find(s => s.id === ownPause.json.schedule.id);
    assert.equal(ownRow.disabledBySmtp, false, 'the user\'s own pause must not be reflagged as SMTP-caused');

    // Recovery: only the SMTP-paused schedule comes back.
    const restored = await api.saveAdminMail(adminToken, {
      enabled: true,
      smtp: { host: stack.smtp.host, port: stack.smtp.port, secure: false, user: 'u', pass: 'p' },
      from: 'installation-default@example.com',
    });
    assert.ok(restored.json.schedulesResumed >= 1, JSON.stringify(restored.json));
    list = await api.listSchedules(token);
    armedRow = list.find(s => s.id === armed.json.schedule.id);
    assert.equal(armedRow.enabled, true);
    assert.equal(armedRow.disabledBySmtp, false);
    ownRow = list.find(s => s.id === ownPause.json.schedule.id);
    assert.equal(ownRow.enabled, false, 'a schedule the user disabled themselves must stay disabled');
  }, { timeout: 60_000 });
});

// ══════════════════════════════════════════════════════════════════════════════
/**
 * Pull the xlsx attachment out of a raw SMTP conversation.
 *
 * The stub keeps the DATA verbatim, so this walks the MIME body looking for a
 * run of base64 lines whose decoded bytes carry a zip's local-file header —
 * rather than parsing boundaries, which would make the helper depend on how
 * nodemailer happens to lay out a multipart message.
 */
function xlsxFromMime(raw) {
  const isB64 = (s) => /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  let run = [];
  const settle = () => {
    const lines = run; run = [];
    if (lines.length < 2) return null;
    const buf = Buffer.from(lines.join(''), 'base64');
    return buf.subarray(0, 2).toString() === 'PK' ? buf : null;
  };
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    // A run has to *start* with a full-width wrapped line, or a short word in
    // the covering note would open one; once open, the final short line joins.
    if (isB64(line) && (run.length ? true : line.length >= 60)) { run.push(line); continue; }
    const hit = settle();
    if (hit) return hit;
  }
  return settle();
}

describe('e2e — Q37 survives the scheduler\'s own report path', { skip: SKIP }, () => {
  // lib/scheduler.js is the second of Q37's two call sites and the only one no
  // test drove end to end: a manual report is downloaded over HTTP, a scheduled
  // one is built in memory and attached to an email (§6.8), so nothing proved
  // the workbook that actually reaches an inbox carries the Origin and
  // Dependency Path columns. This opens the delivered attachment and reads them.
  let token, leaf, adminToken;

  before(async () => {
    if (!ENABLED) return;
    adminToken = (await api.login(stack.admin.loginId, stack.admin.password,
      { isAdmin: true, force: true })).json.token;
    await api.saveAdminMail(adminToken, {
      enabled: true,
      smtp: { host: stack.smtp.host, port: stack.smtp.port, secure: false, user: 'u', pass: 'p' },
      from: 'installation@example.com',
    });
    token = await api.signUp(account('schedorigin'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    await api.saveMail(token, {
      enabled: true, from: 'dashboard@example.com', to: 'origins@example.com',
      subject: 'Scheduled origins', body: 'Attached.',
    });
    // A leaf, not a root: the stub hangs its findings and its dependency graph
    // off the leaves, so a root would produce a workbook with nothing to label.
    const all = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=false`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    const p = (Array.isArray(all) ? all : all.values).find(x => /^service-/.test(x.name));
    leaf = { uuid: p.uuid, name: p.name, version: p.version || '' };
  }, { timeout: 60_000 });

  after(async () => {
    if (!ENABLED) return;
    await api.del('/admin/mail', adminToken);
  });

  test('the emailed workbook carries Origin and the real chain', async () => {
    const created = await api.createSchedule(token, {
      name: 'origins-daily', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security', 'license'], projects: [leaf],
    });
    assert.ok(created.status < 300, `${created.status} ${JSON.stringify(created.json)}`);

    const r = await api.post(
      `/violation-cache/schedules/${created.json.schedule.id}/run-now`, {}, token);
    assert.ok(r.status < 300, `Send now answered ${r.status} ${JSON.stringify(r.json)}`);

    const mail = await stack.smtp.waitFor('origins@example.com', 120_000);
    assert.ok(mail, 'the scheduled report never reached SMTP');
    assert.match(mail.data, /Content-Disposition:\s*attachment/i);

    const bytes = xlsxFromMime(mail.data);
    assert.ok(bytes, 'no xlsx attachment was found in the delivered message');
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.load(bytes);

    const headers = (ws) => ws.getRow(1).values.slice(1).map(String);
    const column  = (ws, header) => {
      const i = headers(ws).indexOf(header) + 1;
      assert.ok(i > 0, `${ws.name} has no ${header} column: ${headers(ws).join(', ')}`);
      const out = [];
      ws.eachRow((row, n) => { if (n > 1) out.push(String(row.getCell(i).value ?? '')); });
      return out;
    };

    const sv = wb.getWorksheet('SV_Vulnerability Findings');
    const origin = column(sv, 'Origin');
    const paths  = column(sv, 'Dependency Path');
    assert.ok(origin.length > 0, 'the leaf should have findings to report on');
    assert.ok(origin.includes('Direct') && origin.includes('Transitive'),
      `both labels should appear: ${JSON.stringify(origin)}`);
    assert.ok(!origin.includes(''), 'every row must be classified in a mailed report too');
    const chains = paths.filter(v => v.includes('→'));
    assert.ok(chains.length > 0, `no chain was printed: ${JSON.stringify(paths)}`);
    for (const c of chains) assert.match(c, /carrier-for-/);

    // The unique sheet's aggregate travels too — it is computed in excel.js
    // from the same origins map, so a scheduler call site that forgot to pass
    // `conn` would leave this blank rather than failing loudly.
    const uniq = wb.getWorksheet('LR_Unique Risks');
    assert.ok(headers(uniq).includes('Dependency Path'));
    assert.ok(column(uniq, 'Origin').some(v => ['Direct', 'Transitive', 'Mixed'].includes(v)),
      'the aggregated origin should be populated in a mailed workbook');
  }, { timeout: 240_000 });
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

  // ── The colour theme (Q49) ────────────────────────────────────────────
  // The one claim no unit test can make: that a PARTIAL upload really does
  // leave the omitted properties at their built-in values, in a real browser,
  // through the real cascade — which is the entire mechanism.
  test('a partial theme overrides what it sets and nothing else', async () => {
    const put = await api.put('/admin/theme', {
      version: 1, name: 'E2E', dark: { accent: '#123456' },
    }, adminToken);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    try {
      const css = await api.raw('/branding/theme.css');
      assert.equal(css.status, 200);
      assert.match(css.headers['content-type'], /^text\/css/);
      assert.match(css.text, /--accent: #123456;/);
      // The omitted properties are simply absent — there is no merge step and
      // no defaults table, so nothing can write a stale value here.
      assert.doesNotMatch(css.text, /--bg:/);
      // Not "no mention of data-theme=light anywhere" — the dark block's own
      // selector now legitimately names it, as the :not() it excludes (Q49:
      // that scoping is what stops a dark-only theme leaking into light
      // mode). What must be absent is an actual light RULE.
      assert.doesNotMatch(css.text, /^:root\[data-theme="light"\] \{/m,
        'no light half was supplied, so no light block is emitted');
      assert.equal(css.headers['cache-control'], 'no-cache');
    } finally {
      assert.equal((await api.del('/admin/theme', adminToken)).status, 200);
    }
  });

  test('the stylesheet is public — the sign-in page needs it before a token', async () => {
    // S32, the same reasoning as the icon and the background.
    const r = await api.raw('/branding/theme.css');
    assert.equal(r.status, 200, 'no token was sent and it must still answer');
    assert.match(r.text, /No theme configured/, 'an empty sheet, not a 404');
  });

  test('a file with a bad key is refused whole, naming it', async () => {
    const r = await api.put('/admin/theme', {
      version: 1, dark: { acccent: '#123456', bg: '#000000' },
    }, adminToken);
    assert.equal(r.status, 400);
    assert.match(r.json.problems.join(' '), /dark\.acccent/);
    // And nothing was stored — the valid half must not be half-applied.
    const after = await api.raw('/branding/theme.css');
    assert.match(after.text, /No theme configured/);
  });

  test('an ordinary account cannot change the theme', async () => {
    assert.equal((await api.put('/admin/theme',
      { version: 1, dark: { accent: '#000000' } }, userToken)).status, 403);
    assert.equal((await api.del('/admin/theme', userToken)).status, 403);
    assert.equal((await api.get('/admin/theme', userToken)).status, 403);
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
    assert.equal(r.json.trendEnabled, true, 'an untouched installation shows the panel');
    assert.ok(!('icon' in r.json) || r.json.icon === null || r.json.icon.version,
      'the icon is metadata or absent — never bytes on this route');
  });

  test('/branding/icon reaches the backend rather than the SPA fallback', async () => {
    // Q47 + §9.1: `location /branding` is a prefix, so the icon is covered —
    // but a route that is NOT covered fails by serving index.html where JSON
    // was expected, which is a much more confusing symptom than a 404. This
    // asserts the shape of the miss, with no icon configured.
    const r = await api.get('/branding/icon');
    assert.equal(r.status, 404, 'no icon uploaded, so a real 404 from the service');
    assert.doesNotMatch(r.text || '', /<!DOCTYPE|<html/i,
      'HTML here means the request fell through to the single-page fallback');
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
  let browser, page, token, errors, adminToken;
  const USER = account('browseruser');

  before(async () => {
    if (BROWSER_SKIP) return;
    // The schedule editor refuses to open while email is unavailable (Q52),
    // and two tests below open it from the toolbar — the installation's SMTP
    // server has to be configured, or #cfgSchedView never becomes visible.
    adminToken = (await api.login(stack.admin.loginId, stack.admin.password,
      { isAdmin: true, force: true })).json.token;
    await api.saveAdminMail(adminToken, {
      enabled: true,
      smtp: { host: stack.smtp.host, port: stack.smtp.port, secure: false, user: 'u', pass: 'p' },
      from: 'installation@example.com',
    });
    token = await api.signUp(USER);
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    await api.saveMail(token, {
      enabled: true, from: 'dashboard@example.com', to: 'team@example.com',
      subject: 'Subject', body: 'Body',
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

  after(async () => {
    if (browser) await browser.close();
    if (adminToken) await api.del('/admin/mail', adminToken);
  });

  // A test that fails between opening a modal and closing it leaves the overlay
  // on screen, and `.modal-overlay.open` covers the whole viewport — so every
  // later test that clicks anything dies on "intercepts pointer events" after a
  // full 30s timeout apiece. One real failure then reports as six, and the five
  // decoys all name a control that has nothing wrong with it. Closing here
  // costs nothing when the test passed (there is no open modal to close) and
  // keeps a genuine failure reporting as exactly one failure, with its own
  // message. It deliberately does not assert — cleanup that can itself fail is
  // one more way to lose the real error.
  // The Settings/schedule side panel (#configPanel, §8.10's slide-in pattern)
  // is the identical failure mode one class over: `.cfg-panel.open` covers the
  // same width as the toolbar it slid out from, so a test that fails midway
  // through the schedule drill-down leaves it there for every later click to
  // "intercept pointer events" against, same as an un-closed modal would.
  afterEach(async () => {
    if (!page || page.isClosed()) return;
    await page.evaluate(() => {
      document.querySelectorAll('.modal-overlay.open, .cfg-panel.open')
        .forEach(el => el.classList.remove('open'));
    }).catch(() => {});
  });

  /**
   * The dependency-path walk is asynchronous end to end — a POST that starts a
   * job, then a 1.5s poll until the row is `ready` — so the only honest wait is
   * for the chain itself to appear. What a bare waitForSelector cannot say is
   * WHY it never did: still building, failed upstream, refused to start, or
   * nothing transitive to resolve are four different faults with one symptom.
   * #vulnDepPathStatus carries the distinguishing message in every one of those
   * cases (startDepPathPoll/onVulnDepPathToggle in index.html both write it),
   * so quote it rather than making the next person re-derive it from CI logs.
   */
  /**
   * Put the page back the way a test found it: scrolled to the top, pointer in
   * the corner.
   *
   * The scroll half is not cosmetic. Clicking a row far enough down the table
   * makes Playwright scroll it into view, and the trend panel sits above the
   * table — so a test that clicks a low row leaves the charts off the top of
   * the viewport. The trend tooltip test derives its hover coordinates from
   * `#trendCharts svg`'s bounding box, which is then negative, and the
   * mousemove lands outside the window: #trendTip is built on that event, so
   * it never appears and the failure reads as "the tooltip is broken" three
   * tests away from the test that actually scrolled.
   *
   * The pointer half matches what the tooltip test already does at its end.
   */
  const restoreViewport = async () => {
    await page.evaluate(() => {
      // window.scrollTo alone is not enough: this page scrolls an inner
      // container, so window.scrollY reads 0 while the charts sit 56px above
      // the viewport. Walk the charts' own ancestors and reset whichever one
      // actually moved.
      window.scrollTo(0, 0);
      for (let el = document.getElementById('trendCharts'); el; el = el.parentElement) {
        if (el.scrollTop) el.scrollTop = 0;
      }
    });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200); // the chart resize handler is debounced at 150ms
  };

  async function waitForDepPathChains(ms) {
    try {
      await page.waitForSelector('.dep-path-chain', { timeout: ms });
    } catch (err) {
      const lines = [];
      const add = (label, v) => lines.push(`  ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

      add('#vulnDepPathStatus',
        await page.locator('#vulnDepPathStatus').textContent().catch(() => '(unreadable)'));
      add('toggle checked',
        await page.locator('#vulnDepPathToggle').isChecked().catch(() => '(unreadable)'));
      add('dialog rows', await page.locator('#vulnDialogRows tr').count().catch(() => -1));

      // What the page believes, and what the route actually answered. The four
      // states the dialog renders identically — 'none' (no row was ever
      // written), 'stalled' (the watchdog gave up), 'failed' (the walk threw)
      // and 'ready' with an empty `paths` — are the whole question here, and
      // only these two reads tell them apart.
      const state = await page.evaluate(() => window.__depPathState()).catch(e => ({ unreadable: e.message }));
      add('page state', state);
      if (state && state.project) {
        add('GET dependency-paths', await page.evaluate(async (uuid) => {
          const r = await fetch(`/violation-cache/dependency-paths/${uuid}`, {
            headers: { Authorization: `Bearer ${localStorage.getItem('dt_session_token')}` },
          });
          const b = await r.json().catch(() => ({}));
          return {
            http: r.status, status: b.status, error: b.error, stale: b.stale,
            totalComponents: b.totalComponents, resolvedComponents: b.resolvedComponents,
            pathKeys: Object.keys(b.paths || {}).length, routesExact: b.routesExact,
          };
        }, state.project).catch(e => ({ unreadable: e.message })));
      }

      // The server logs its own reason (`Dependency-path walk failed: …`,
      // `… stalled …`, `… expansion failed for one component: …`) and the
      // harness has been capturing it all along — it was simply never shown,
      // which is why two CI runs could fail without naming a cause.
      const serverLog = (stack.log() || '').split('\n')
        .filter(l => /[Dd]ependency-path|dependencyGraph/.test(l)).slice(-12);
      if (serverLog.length) lines.push('  server log:\n    ' + serverLog.join('\n    '));

      err.message += '\n' + lines.join('\n');
      throw err;
    }
  }

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

  test('Q34: the hierarchy is rebuilt from parent links, not an embedded children[]', async () => {
    // The regression this exists for: a DependencyTrack v5 upgrade stopped
    // guaranteeing the embedded children[] the old crawl descended by, and the
    // dashboard silently rendered root projects alone. The stub no longer
    // supplies that field at all (e2e/dt-stub.js), so the tree below can only
    // appear if the flat sweep fetched the descendants and buildTree nested
    // them on parent.uuid.
    //
    // Asserting a row COUNT would not have caught it — roots alone are still
    // "> 0 rows", which is exactly why the old assertion passed throughout.
    await page.waitForTimeout(1500);
    const toggles = page.locator('#tableBody .tree-toggle');
    assert.ok(await toggles.count() > 0,
      'no expander rendered — every project came back as a root, so no parent link survived');

    // The descendant is on screen by name, not merely as an extra row: the
    // stub names roots "Group N" and their children "service-N". Under the
    // old crawl against a v5-shaped stub this is what would be missing.
    assert.match(await page.locator('#tableBody').textContent(), /service-\d+/,
      'no child project rendered — the sweep never fetched below the roots');

    // Groups render expanded, so collapsing is what proves the row is really
    // nested under its parent rather than sitting beside it as another root.
    const expanded = await page.locator('#tableBody tr').count();
    await toggles.first().click();
    await page.waitForTimeout(400);
    const collapsed = await page.locator('#tableBody tr').count();
    assert.ok(collapsed < expanded,
      `collapsing a group must hide its children (${expanded} → ${collapsed})`);

    await toggles.first().click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#tableBody tr').count(), expanded,
      're-expanding must restore exactly the rows the collapse hid');
  }, { timeout: 60_000 });

  test('Q35: a group row totals its descendants, through an intermediate group', async () => {
    // The stub's root 1 is three deep — Group 1 → service-101 → service-201 —
    // and service-101 is now an intermediate GROUP, not a leaf. So the chain
    // only reads equal if the rollup climbed through it. Group 2 is two deep,
    // covering the ordinary case in the same pass.
    //
    // Read the rendered cells rather than any internal state: this has to be
    // what a user actually sees, and the four category columns follow the
    // select/name/level/isLatest cells, so security.critical is index 4.
    const byName = await page.evaluate(() => {
      const out = {};
      for (const tr of document.querySelectorAll('#tableBody tr')) {
        const name = tr.querySelector('.proj-name-text');
        const tds  = tr.querySelectorAll('td');
        if (name && tds.length > 4) out[name.textContent.trim()] = tds[4].textContent.trim();
      }
      return out;
    });

    for (const n of ['Group 1', 'service-101', 'service-201', 'Group 2', 'service-102']) {
      assert.ok(n in byName, `row "${n}" missing — got ${JSON.stringify(Object.keys(byName))}`);
    }
    assert.equal(byName['service-101'], byName['service-201'],
      'the intermediate group must equal its single leaf');
    assert.equal(byName['Group 1'], byName['service-201'],
      'and the root must equal it too — the rollup has to climb two levels, not one');
    assert.equal(byName['Group 2'], byName['service-102'],
      'the ordinary two-level case must still total its leaf');
  }, { timeout: 60_000 });

  test('Q39: a collection root set to "latest only" counts only its latest child', async () => {
    // The stub's root 4 is a real Collection Project with
    // collectionLogic = AGGREGATE_LATEST_VERSION_CHILDREN over two children:
    // service-401 (critical 5, not latest) and service-402 (critical 3,
    // latest). A dashboard that ignores collectionLogic renders 8 here; one
    // that honours it renders 3. No unit test can prove this end to end,
    // because the whole defect was that the field never survived parsing —
    // this is the only assertion that reads it off the real payload, through
    // the real parser, to a rendered cell.
    await page.locator('#searchInput').fill('');
    await page.waitForTimeout(400);
    const byName = await page.evaluate(() => {
      const out = {};
      for (const tr of document.querySelectorAll('#tableBody tr')) {
        const name = tr.querySelector('.proj-name-text');
        const tds  = tr.querySelectorAll('td');
        if (name && tds.length > 4) out[name.textContent.trim()] = tds[4].textContent.trim();
      }
      return out;
    });
    for (const n of ['Collection 4', 'service-401', 'service-402']) {
      assert.ok(n in byName, `row "${n}" missing — got ${JSON.stringify(Object.keys(byName))}`);
    }
    assert.equal(byName['service-401'], '5', 'the stale child keeps its own count');
    assert.equal(byName['service-402'], '3', 'the latest child keeps its own count');
    assert.equal(byName['Collection 4'], '3',
      `the collection root must show only its latest child's 3, not 8 — got ${byName['Collection 4']}`);
  }, { timeout: 60_000 });

  test('Q53: a search filter no longer excludes an uncounted leaf', async () => {
    // service-401 is the STALE child of the "latest only" Collection 4 root —
    // Q39 correctly keeps it out of Collection 4's OWN rollup (3, not 8), but
    // before this fix a filter also hid the row entirely, even when it
    // matched. Searching its own name must now show it; the parent's own
    // total must stay exactly as the unfiltered test above proved.
    await page.locator('#searchInput').fill('service-401');
    await page.waitForTimeout(400);
    const byName = await page.evaluate(() => {
      const out = {};
      for (const tr of document.querySelectorAll('#tableBody tr')) {
        const name = tr.querySelector('.proj-name-text');
        const tds  = tr.querySelectorAll('td');
        if (name && tds.length > 4) out[name.textContent.trim()] = tds[4].textContent.trim();
      }
      return out;
    });
    assert.ok('service-401' in byName,
      `the stale child must render while filtered — it matched the search; got ${JSON.stringify(Object.keys(byName))}`);
    assert.equal(byName['service-401'], '5', 'its own count is unaffected by the filter');
    assert.equal(byName['Collection 4'], '3',
      'the parent\'s own rollup must stay exactly as Q39 computes it, filter or not');
    assert.ok(!('service-402' in byName), 'the sibling that does not match the search must not render');

    await page.locator('#searchInput').fill('');
    await page.waitForTimeout(400);
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
    // Current, Latest, Origin — the first seven matching the report workbook's
    // own columns (§6.7), Origin added for the Direct/Transitive badge.
    const firstRow = await rows.first().locator('td').allTextContents();
    assert.equal(firstRow.length, 8);
    assert.match(firstRow[0], /^CVE-/, 'the vulnerability id column');
    assert.ok(/CRITICAL|HIGH|MEDIUM|LOW/i.test(firstRow[1]), 'the severity pill column');
    assert.ok(/Direct|Transitive/.test(firstRow[7]), 'the origin column');

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

  test('Q40: the origin read is issued before the findings crawl, not after it', async () => {
    // The reported symptom was an Origin column stuck on `…` through the whole
    // of a project's FIRST open, correct on every one after. That reads like a
    // memo bug; it was an ordering one — Tier 1 waited on a crawl it shares
    // nothing with but the project uuid, and the memo only looked like a cure
    // because it took the crawl out from in front of it.
    //
    // Asserting on elapsed time would be flaky, so this asserts on the stub's
    // own request log instead: with the defect the project read came strictly
    // after the finding pages, and with the fix it comes first. A project no
    // earlier test has opened, so there is no memo to hide the ordering.
    const eyeBtn = page.locator('.vuln-eye-btn').last();
    await eyeBtn.waitFor({ state: 'visible', timeout: 10_000 });
    dt.reset();
    await eyeBtn.click();
    await page.waitForSelector('#vulnDialogRows tr', { timeout: 20_000 });
    await page.waitForTimeout(800); // let Tier 1 land

    const calls   = dt.calls();
    const project = calls.findIndex(c => /\/api\/v1\/project\/[0-9a-f-]+$/.test(c));
    const finding = calls.findIndex(c => c.includes('/api/v1/finding'));
    assert.ok(project >= 0, `no Tier-1 project read in: ${calls.join(' | ')}`);
    assert.ok(finding >= 0, `no finding crawl in: ${calls.join(' | ')}`);
    assert.ok(project < finding,
      `Tier 1 must not queue behind the crawl — project at ${project}, finding at ${finding}`);

    // And the column really is populated on this first open, not just ordered.
    const origins = await page.locator('#vulnDialogRows tr td:nth-child(8)').allTextContents();
    assert.ok(origins.length > 0, 'the dialog should have rows');
    assert.ok(origins.every(t => /Direct|Transitive/.test(t)),
      `every row must be classified on a first open, got: ${JSON.stringify(origins)}`);

    await page.locator('#vulnDialog .modal-close').click();
    await page.waitForTimeout(300);
    await restoreViewport();
  }, { timeout: 60_000 });

  test('the dependency-path toggle resolves real Direct/Transitive chains, live and once cached', async () => {
    // dt-stub.js seeds each leaf with a synthetic "carrier" component that is
    // itself direct, with half the leaf's findings reachable only through it —
    // a real, if small, transitive graph to walk end to end.
    const eyeBtn = page.locator('.vuln-eye-btn').first();
    await eyeBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await eyeBtn.click();
    await page.waitForTimeout(1200);

    // Tier 1: the Origin column is populated the instant the dialog renders,
    // with no toggle touched — it is live and free, never gated.
    const originTexts = await page.locator('#vulnDialogRows .vuln-origin').allTextContents();
    assert.ok(originTexts.length > 0);
    assert.ok(originTexts.some(t => /Direct/.test(t)), 'at least one finding must be Direct');
    assert.ok(originTexts.some(t => /Transitive/.test(t)), 'at least one finding must be Transitive');
    assert.ok(!(await page.locator('.dep-path-chain').count()), 'no chain is shown before the toggle is used');

    // Toggling on triggers the walk and shows a chain per Transitive row.
    // 45s, not 15s and no longer 30s: observed flaky under CI resource
    // contention at each tighter margin — the walk itself is small (Q26 scopes
    // it to exactly this dialog's targets, a dozen stub components here), but
    // a loaded runner's Postgres and HTTP round trips, plus a 1.5s poll
    // interval, can still eat the difference. This bound is correctness, not
    // performance: the cache-hit re-toggle below still asserts 3s, which is
    // the timing claim that actually matters.
    await page.locator('#vulnDepPathToggle').click();
    await waitForDepPathChains(45_000);
    const chains = await page.locator('.dep-path-chain').allTextContents();
    assert.ok(chains.length > 0);
    for (const chain of chains) {
      assert.match(chain, /carrier-for-/, 'the chain must name the intermediate component, not just the target');
    }

    // Q33: the stub gives exactly one transitive component a second route in
    // from the same carrier (carrier → comp and carrier → relay → comp), so a
    // route-count badge must appear. Two routes total, one of them the chain
    // on screen, so it reads "1 more route from carrier-for-…" — singular,
    // and with no "+". The absence of the "+" is the assertion that matters:
    // it can only hold if the walk really did stop taking Q26's early exit and
    // really did see the whole edge set, which no unit test can prove.
    const badges = await page.locator('.dep-path-routes').allTextContents();
    assert.ok(badges.length > 0, 'a component reachable two ways must carry a route count');
    assert.ok(badges.some(b => /^1 more route from carrier-for-/.test(b.trim())),
      `expected an exact "1 more route from carrier-…" badge, got ${JSON.stringify(badges)}`);
    assert.ok(!badges.some(b => /\+/.test(b)),
      'this walk is complete and acyclic, so no count may be reported as a floor');

    // Toggling off hides the chains without discarding the Direct/Transitive badges.
    await page.locator('#vulnDepPathToggle').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.dep-path-chain').count(), 0);
    assert.ok((await page.locator('#vulnDialogRows .vuln-origin').allTextContents())
      .some(t => /Transitive/.test(t)), 'the badge itself survives toggling the paths off');

    // Toggling back on is a cache hit — instant, no second walk needed.
    const t0 = Date.now();
    await page.locator('#vulnDepPathToggle').click();
    await page.waitForSelector('.dep-path-chain', { timeout: 3000 });
    assert.ok(Date.now() - t0 < 3000, 'a resolved walk must render immediately on re-toggle, not re-poll');

    await page.locator('#vulnDialog .modal-close').click();
    await page.waitForTimeout(400);
    // 90s so the 45s chain wait above cannot be truncated by the test's own
    // budget: a walk cut off at the outer boundary reports as the test timing
    // out rather than as the chain never arriving, which loses the one piece
    // of information worth having.
  }, { timeout: 90_000 });

  test('License Risk shows real violations, filters by origin locally, and shares the dependency-path cache with Security', async () => {
    // dt-stub.js seeds each leaf with two license violations reusing that
    // leaf's own finding components — one direct (FAIL), one transitive via
    // the carrier (WARN) — the same components the previous test's walk
    // already resolved, so this proves the cache really is shared by
    // component (CLAUDE.md §8.1 Q28), not duplicated per finding type.
    const eyeBtn = page.locator('.vuln-eye-btn').first();
    await eyeBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await eyeBtn.click();
    await page.waitForTimeout(1200);

    // Switch to License Risk — fetched lazily, the first time this dropdown reaches it.
    await page.selectOption('#vulnViewType', 'license');
    await page.waitForSelector('#vulnDialogRows tr', { timeout: 15_000 });

    assert.equal(
      await page.locator('#vulnDialogTable').evaluate(e => e.classList.contains('vuln-table--license')), true,
      'the table must switch to the license column set');

    const rowTexts = await page.locator('#vulnDialogRows tr').allTextContents();
    assert.equal(rowTexts.length, 2, 'exactly the two seeded license violations for this project');
    assert.ok(rowTexts.some(t => /GPL-3\.0-only/.test(t)), 'the resolved license name must render');
    assert.ok(rowTexts.some(t => /Copyleft licences prohibited/.test(t)), 'the policy name must render');
    assert.ok(rowTexts.some(t => /FAIL/.test(t)), 'the direct violation\'s state must render');
    assert.ok(rowTexts.some(t => /WARN/.test(t)), 'the transitive violation\'s state must render');

    const originTexts = await page.locator('#vulnDialogRows .vuln-origin').allTextContents();
    assert.ok(originTexts.some(t => /Direct/.test(t)), 'the FAIL violation\'s component is direct');
    assert.ok(originTexts.some(t => /Transitive/.test(t)), 'the WARN violation\'s component is transitive');

    // The origin filter is local — narrows without a network round trip.
    await page.selectOption('#vulnOriginFilter', 'direct');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#vulnDialogRows tr').count(), 1, 'Direct-only shows exactly the direct violation');

    await page.selectOption('#vulnOriginFilter', 'transitive');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#vulnDialogRows tr').count(), 1, 'Transitive-only shows exactly the transitive violation');

    await page.selectOption('#vulnOriginFilter', 'both');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#vulnDialogRows tr').count(), 2, 'Both restores every row');

    // The toggle and its cache are shared with Security — the transitive
    // component here is the very same one the earlier test already walked,
    // so this must resolve, never read "no path recorded".
    await page.locator('#vulnDepPathToggle').click();
    await waitForDepPathChains(45_000);
    const chains = await page.locator('.dep-path-chain').allTextContents();
    assert.ok(chains.length > 0);
    assert.ok(!chains.some(t => /No path recorded/.test(t)),
      'a component Security already resolved must never read as unresolved from License');
    for (const chain of chains) {
      assert.match(chain, /carrier-for-/, 'the chain must name the intermediate component');
    }

    // Switching back to Security must not have lost its own data or state.
    await page.selectOption('#vulnViewType', 'security');
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator('#vulnDialogTable').evaluate(e => e.classList.contains('vuln-table--license')), false);
    assert.ok((await page.locator('#vulnDialogRows tr').count()) > 0, 'security rows must still be there');

    await page.locator('#vulnDialog .modal-close').click();
    await page.waitForTimeout(400);
  }, { timeout: 90_000 });   // as above: room for the 45s chain wait plus a 15s License fetch

  test('Q36: a click beside the dialog does not dismiss it — only the ✕ does', async () => {
    // The reported bug: the dialog starts a finding crawl on open, and a
    // mis-aimed click on the backdrop threw that work away with nothing on
    // screen to say it had happened.
    const eyeBtn = page.locator('.vuln-eye-btn').first();
    await eyeBtn.click();
    await page.waitForSelector('#vulnDialogRows tr', { timeout: 15_000 });

    // Click the overlay itself, well clear of the dialog card. Playwright
    // refuses a click the card would intercept, so position is the assertion:
    // this lands on the backdrop and nowhere else.
    await page.locator('#vulnDialog').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(400);
    assert.equal(
      await page.locator('#vulnDialog').evaluate(e => e.classList.contains('open')), true,
      'a backdrop click must leave the findings dialog open');
    assert.ok(await page.locator('#vulnDialogRows tr').count() > 0,
      'and must not have discarded what it had already loaded');

    await page.locator('#vulnDialog .modal-close').click();
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator('#vulnDialog').evaluate(e => e.classList.contains('open')), false,
      'the ✕ must still close it');
    await restoreViewport();
  }, { timeout: 60_000 });

  test('Q36: reopening a project reuses the fetch, while the Origin badges stay live', async () => {
    // .nth(1) rather than .first(): every earlier test in this block opens the
    // first project, so its rows are already memoised and this test would
    // prove nothing about the initial fetch.
    const eyeBtn = page.locator('.vuln-eye-btn').nth(1);
    const findingCalls = () => dt.calls().filter(c => c.includes('/api/v1/finding?')).length;

    dt.reset();
    await eyeBtn.click();
    await page.waitForSelector('#vulnDialogRows tr', { timeout: 15_000 });
    const firstRows = await page.locator('#vulnDialogRows tr').count();
    assert.ok(findingCalls() >= 1, 'the first open must actually crawl DependencyTrack');

    await page.locator('#vulnDialog .modal-close').click();
    await page.waitForTimeout(300);

    dt.reset();
    await eyeBtn.click();
    await page.waitForSelector('#vulnDialogRows tr', { timeout: 15_000 });
    assert.equal(findingCalls(), 0, 'reopening the same project must not crawl it again');
    assert.equal(await page.locator('#vulnDialogRows tr').count(), firstRows,
      'and the memo must render the same rows, not an empty table');

    // §6.3a is the other half: the Direct/Transitive set is deliberately NOT
    // memoised, so the reopen must still ask DependencyTrack for it. A memo
    // that swallowed this would let a badge go stale against the live graph.
    assert.ok(dt.calls().some(c => /\/api\/v1\/project\/[0-9a-f-]+$/.test(c)),
      'Tier 1 must still be resolved live on a memo hit');

    await page.locator('#vulnDialog .modal-close').click();
    await page.waitForTimeout(300);
    await restoreViewport();
  }, { timeout: 90_000 });

  test('a clean project (no findings) shows no eye icon at all', async () => {
    // hasVulnerabilities() gates the icon — this is a structural guarantee,
    // not just a visual one, so it is checked against the live rendered table
    // rather than only against the pure helper in dashboard.test.js.
    const iconCount = await page.locator('.vuln-eye-btn').count();
    const rowCount = await page.locator('#tableBody tr').count();
    assert.ok(iconCount < rowCount, 'at least one row (a group, or a clean leaf) must have no icon');
  });

  test('Q45: the tile counts the projects the collection root actually counts', async () => {
    // The stub's Collection 4 counts only service-402 (critical 3, latest) and
    // not service-401 (critical 5, stale). Q39 made the ROW obey that; the
    // tile's project count kept walking allProjects, so one tile disagreed
    // with itself — a figure that honoured the aggregation over a count that
    // did not. This is the only assertion that reads both halves of one tile
    // off the rendered page.
    await page.locator('#searchInput').fill('');
    await page.waitForTimeout(400);
    await restoreViewport();

    const card = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.summary-card')]
        .find(e => /Critical/i.test(e.textContent));
      return { value: el.querySelector('.value').textContent.trim(),
               sub: el.querySelector('.sub').textContent,
               all: el.textContent };
    });
    const counted = await page.evaluate(() => [...window.__countedLeafUuids()]);
    const names = await page.evaluate((u) => u.map(x => (window.__allProjects()
      .find(p => p.uuid === x) || {}).name), counted);

    assert.ok(names.includes('service-402'), 'the latest child is counted');
    assert.ok(!names.includes('service-401'),
      `the stale child must not be counted — got ${JSON.stringify(names)}`);
    assert.ok(!/\bof \d/.test(card.all),
      'nothing is filtered, so no "of N" denominator should be drawn');

    // The other half of the same tile, read off the page: the "N projects"
    // sub-line must fold the identical set the figure above it does. Counting
    // it here independently is what makes the two halves provably one set —
    // the defect was that they were two.
    const expected = await page.evaluate(() => {
      const counted = window.__countedLeafUuids();
      return window.__allProjects().filter(p => counted.has(p.uuid)
        && ((p.security.critical || 0) + (p.operations.fail || 0)
          + (p.license.fail || 0) + ((p.secpolicy && p.secpolicy.fail) || 0)) > 0).length;
    });
    const rendered = Number(/(\d+)\s*projects/.exec(card.sub)[1]);
    assert.equal(rendered, expected,
      `the tile's project count must fold the counted leaves (${rendered} vs ${expected})`);
  }, { timeout: 60_000 });

  test('Q46: filtering moves the tiles and names the portfolio total beside them', async () => {
    // Before this the tiles described the whole portfolio regardless of what
    // the table was showing, so filtering to one team left four headline
    // numbers answering a question nobody had asked.
    const before = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.summary-card')]
        .find(e => /Critical/i.test(e.textContent));
      return parseInt(el.querySelector('.value').textContent.trim(), 10);
    });

    await page.locator('#searchInput').fill('service-402');
    await page.waitForTimeout(500);

    const after = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.summary-card')]
        .find(e => /Critical/i.test(e.textContent));
      return {
        value: parseInt(el.querySelector('.value').textContent.trim(), 10),
        of: [...el.querySelectorAll('.card-of')].map(s => s.textContent.trim()).join('|'),
      };
    });

    assert.ok(after.value < before,
      `filtering to one project must narrow the tile (${after.value} vs ${before})`);
    assert.match(after.of, new RegExp(`of ${before}`),
      `the portfolio total must stay visible beside it — got "${after.of}"`);

    await page.locator('#searchInput').fill('');
    await page.waitForTimeout(500);
    const restored = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.summary-card')]
        .find(e => /Critical/i.test(e.textContent));
      return { value: parseInt(el.querySelector('.value').textContent.trim(), 10),
               of: [...el.querySelectorAll('.card-of')].map(s => s.textContent.trim()).join('') };
    });
    assert.equal(restored.value, before, 'clearing the filter restores the portfolio figure');
    assert.equal(restored.of, '', 'and drops the denominator, which now has nothing to contrast');
  }, { timeout: 60_000 });

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

    // Q55: the first day of a gap is compared against its OWN inherited
    // reading (Q23's row === the previous position's row here), so the delta
    // must read "no change" — a real browser proof that the tooltip compares
    // against the previous POSITION, not the last real measurement further back.
    assert.equal(await page.locator('#trendTip .trend-tip-delta').count(), 4,
      'every level gets a delta once a previous position exists');
    assert.match(await page.locator('#trendTip .trend-tip-delta').first().textContent(), /±0/,
      'nothing was measured on this carried day, so nothing changed');
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

  test('a saved schedule still shows its anchors when reopened', async () => {
    // The list route (reloadSchedules) attaches only a project COUNT, never
    // projectUuids — a schedule opened straight from that cached list used to
    // read its anchors as empty and show "No anchors — re-select them from the
    // toolbar" even though the row beside it correctly said "Latest under 1
    // anchor". service-102 is a leaf under Group 2 and DT's own stub marks it
    // isLatest (i % 3 === 0), so latest_under resolves it to exactly one
    // project — a clean, unambiguous count to assert on.
    //
    // The prior test leaves a checkbox selection behind — cancelling its own
    // schedule editor does not clear the tree's selection, by design (§8.5:
    // "Never mutate allProjects… derive everything else from it" says nothing
    // about the checkbox state, which is a deliberately persistent workspace).
    // Start from a known-clean selection so this test's own count is not
    // whatever the previous test happened to leave checked.
    await page.evaluate(() => toggleSelectAll(false));
    await page.locator('tr:has-text("service-102") .proj-select-cb[data-leaf="1"]').check();
    await page.waitForTimeout(300);
    await page.click('#genReportBtn'); await page.waitForTimeout(400);
    await page.locator('#rptDropMenu button:has-text("Schedule Reports")').click();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#cfgSchedView').isVisible(), true);

    const label = `Reopen check ${Date.now()}`;
    await page.fill('#cfgSchedLabel', label);
    await page.selectOption('#cfgSchedMode', 'latest_under');
    await page.waitForTimeout(300);
    // Still inside the freshly-picked selection (schedCurrentAnchors reads
    // _schedPendingProjects here) — this half already worked before the fix.
    const beforeSave = await page.locator('#cfgSchedProjects').textContent();
    assert.match(beforeSave, /anchor/i);
    assert.match(beforeSave, /1 project/);
    assert.doesNotMatch(beforeSave, /No anchors/);

    await page.click('#cfgSaveBtn');
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('#cfgSchedView').isVisible(), true, 'saving keeps the editor open');
    // The editor's own re-render after save must already be correct — not just
    // the cold reopen below — since saveScheduleEditor() also went through the
    // list-cached, anchor-less path before this fix.
    const afterSave = await page.locator('#cfgSchedProjects').textContent();
    assert.match(afterSave, /anchor/i);
    assert.match(afterSave, /1 project/);
    assert.doesNotMatch(afterSave, /No anchors/);

    await page.click('#cfgBackBtn');
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#cfgMainView').isVisible(), true);
    assert.match(await page.locator('#cfgSchedList').textContent(), /Latest under 1 anchor/,
      'the list row itself always had the right count — projectCount, not projectUuids');

    // The actual regression: a cold reopen, straight from the list-cached row.
    await page.locator(`#cfgSchedList .sched-row:has-text("${label}")`).click();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('#cfgSchedView').isVisible(), true);
    const reopened = await page.locator('#cfgSchedProjects').textContent();
    assert.doesNotMatch(reopened, /No anchors/, 'the anchor must survive a cold reopen');
    assert.match(reopened, /anchor/i);
    assert.match(reopened, /1 project/);

    // Clean up: cancel deletes it outright (§8.1), so later tests in this
    // shared-page suite see the same schedule list they would have otherwise.
    await page.click('#cfgSchedDeleteBtn'); await page.waitForTimeout(700);
    await page.locator('#confirmOkBtn').click(); await page.waitForTimeout(900);
    assert.equal(await page.locator('#cfgMainView').isVisible(), true);
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

  test('Q49: a partial theme resolves through the cascade, in a real browser', async () => {
    // The one claim no unit test can make. Everything else about this feature
    // is provable with a stub; that an OMITTED property still computes to the
    // built-in value is a fact about the browser's cascade, and it is the
    // whole reason there is no merge logic anywhere in the codebase.
    const adminToken = (await api.login(stack.admin.loginId, stack.admin.password,
      { isAdmin: true, force: true })).json.token;

    const read = async () => {
      // A signed-out visitor on the sign-in page: the theme has to reach the
      // one screen that renders before anybody holds a token.
      const visitor = await browser.newPage();
      try {
        await visitor.goto(`${stack.url}/login.html`, { waitUntil: 'networkidle' });
        return await visitor.evaluate(() => {
          const cs = getComputedStyle(document.documentElement);
          return {
            accent: cs.getPropertyValue('--accent').trim(),
            bg:     cs.getPropertyValue('--bg').trim(),
          };
        });
      } finally { await visitor.close(); }
    };

    const before = await read();
    assert.ok(before.accent && before.bg, 'the built-in tokens must resolve to begin with');

    const put = await api.put('/admin/theme',
      { version: 1, name: 'E2E', dark: { accent: '#123456' } }, adminToken);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    try {
      const after = await read();
      assert.equal(after.accent, '#123456', 'the supplied property must win');
      assert.equal(after.bg, before.bg,
        'an omitted property must keep its built-in value — this is the feature');
    } finally {
      assert.equal((await api.del('/admin/theme', adminToken)).status, 200);
    }

    const restored = await read();
    assert.equal(restored.accent, before.accent,
      'removing the theme must return every property, not only the ones it set');
  }, { timeout: 90_000 });

  test('Q49: a dark-only theme does not leak into light mode', async () => {
    // The regression this exists for shipped once: the generated dark block
    // was a bare `:root`, unconditional, and this stylesheet loads AFTER the
    // page's own <style> — so in light mode an unscoped dark rule and the
    // page's OWN `[data-theme="light"] { … }` have equal specificity, and the
    // theme file, being later in the document, won regardless of which
    // scheme was active. A dark-only theme — the case the user guide calls
    // "fine and common" — silently overwrote every light-mode colour it never
    // mentioned. It was found from a real screenshot, not a test: the
    // existing browser case above sets the same property in both schemes, so
    // it never exercised the one branch that leaks. This is the fact only a
    // real browser's cascade can prove, the same reasoning the test above is
    // built on.
    const adminToken = (await api.login(stack.admin.loginId, stack.admin.password,
      { isAdmin: true, force: true })).json.token;

    const readLight = async () => {
      const visitor = await browser.newPage();
      try {
        await visitor.goto(`${stack.url}/login.html`, { waitUntil: 'networkidle' });
        await visitor.evaluate(() => localStorage.setItem('dt_theme', 'light'));
        await visitor.reload({ waitUntil: 'networkidle' });
        return await visitor.evaluate(() => {
          const cs = getComputedStyle(document.documentElement);
          return {
            theme: document.documentElement.getAttribute('data-theme'),
            bg:     cs.getPropertyValue('--bg').trim(),
            accent: cs.getPropertyValue('--accent').trim(),
          };
        });
      } finally { await visitor.close(); }
    };

    const before = await readLight();
    assert.equal(before.theme, 'light', 'the visitor must actually be in light mode for this to prove anything');

    // Dark-only: no `light` key in the document at all.
    const put = await api.put('/admin/theme',
      { version: 1, name: 'dark-only', dark: { accent: '#123456' } }, adminToken);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    try {
      const after = await readLight();
      assert.equal(after.accent, before.accent,
        'a DARK-only theme must not touch light mode at all — --accent must stay the built-in light value');
      assert.equal(after.bg, before.bg,
        'and every other light-mode property must be equally untouched');
    } finally {
      assert.equal((await api.del('/admin/theme', adminToken)).status, 200);
    }
  }, { timeout: 90_000 });

  test('Q54: the three tree row colours are themeable, and actually paint a real row', async () => {
    // The generic cascade mechanism is already proven above for --accent/--bg;
    // this proves the SPECIFIC claim Q54 makes — that uploading a theme
    // actually repaints a real <tr> in the real table, not just that the
    // custom property resolves somewhere on the page.
    const adminToken = (await api.login(stack.admin.loginId, stack.admin.password,
      { isAdmin: true, force: true })).json.token;
    const groupBg = () => page.evaluate(() => {
      const row = [...document.querySelectorAll('#tableBody tr.group-row')][0];
      return row ? getComputedStyle(row).backgroundColor : null;
    });

    const before = await groupBg();
    assert.ok(before, 'a group row must exist to test against');

    const put = await api.put('/admin/theme',
      { version: 1, name: 'Q54 e2e', dark: { 'tree-group-bg': 'rgb(18,52,86)' },
        light: { 'tree-group-bg': 'rgb(18,52,86)' } }, adminToken);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    try {
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      assert.equal(await groupBg(), 'rgb(18, 52, 86)',
        'the uploaded colour must reach the actual row, not just the token');
    } finally {
      assert.equal((await api.del('/admin/theme', adminToken)).status, 200);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
    }
  }, { timeout: 90_000 });

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

// ── Latest-only scheduling, end to end (PR 2) ────────────────────────────────
describe('e2e — a latest-only schedule delivers the projects the rule resolves to',
  { skip: SKIP }, () => {
  // The unit tests prove the resolver; this proves the whole path — a stored
  // rule, resolved against a live sweep at run time, reaching an inbox with the
  // right projects in it. The stub's Collection 4 is a real
  // AGGREGATE_LATEST_VERSION_CHILDREN root over a stale child and a latest one,
  // so "the rule was applied" and "the rule was ignored" produce visibly
  // different workbooks rather than the same one.
  let token, collection, latestChild, staleChild, adminToken;

  before(async () => {
    if (!ENABLED) return;
    adminToken = (await api.login(stack.admin.loginId, stack.admin.password,
      { isAdmin: true, force: true })).json.token;
    await api.saveAdminMail(adminToken, {
      enabled: true,
      smtp: { host: stack.smtp.host, port: stack.smtp.port, secure: false, user: 'u', pass: 'p' },
      from: 'installation@example.com',
    });
    token = await api.signUp(account('latestonly'));
    await api.saveConnection(token, { apiUrl: dt.url, apiKey: dt.apiKey });
    await api.saveMail(token, {
      enabled: true, from: 'dashboard@example.com', to: 'latestonly@example.com',
      subject: 'Latest only', body: 'Attached.',
    });
    const all = await (await fetch(`${dt.url}/api/v1/project?onlyRoot=false`,
      { headers: { 'X-Api-Key': dt.apiKey } })).json();
    const list = Array.isArray(all) ? all : all.values;
    collection  = list.find(p => p.collectionLogic === 'AGGREGATE_LATEST_VERSION_CHILDREN');
    assert.ok(collection, 'the stub must still carry a LATEST collection root');
    const kids = list.filter(p => p.parent && p.parent.uuid === collection.uuid);
    latestChild = kids.find(p => p.isLatest === true);
    staleChild  = kids.find(p => p.isLatest !== true);
    assert.ok(latestChild && staleChild, 'and a latest child beside a stale one');
  }, { timeout: 60_000 });

  after(async () => {
    if (!ENABLED) return;
    await api.del('/admin/mail', adminToken);
  });

  test('an anchored rule covers the latest child and not the stale one', async () => {
    const created = await api.createSchedule(token, {
      name: 'latest-under', frequency: 'daily', hour: 9, minute: 0,
      riskTypes: ['security'],
      selectionMode: 'latest_under',
      // The ANCHOR, not the target. Nothing here names service-402.
      projects: [{ uuid: collection.uuid, name: collection.name, version: collection.version || '' }],
    });
    assert.ok(created.status < 300, `${created.status} ${JSON.stringify(created.json)}`);
    assert.equal(created.json.schedule.selectionMode, 'latest_under',
      'the mode must survive the round trip, or the run resolves as fixed');

    const r = await api.post(
      `/violation-cache/schedules/${created.json.schedule.id}/run-now`, {}, token);
    assert.ok(r.status < 300, `Send now answered ${r.status} ${JSON.stringify(r.json)}`);

    const mail = await stack.smtp.waitFor('latestonly@example.com', 120_000);
    assert.ok(mail, 'the scheduled report never reached SMTP');
    const bytes = xlsxFromMime(mail.data);
    assert.ok(bytes, 'no xlsx attachment was found in the delivered message');
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.load(bytes);

    const ws = wb.getWorksheet('SV_Project Summary');
    assert.ok(ws, 'the workbook must carry the security project summary');
    const names = [];
    ws.eachRow((row, n) => { if (n > 1) names.push(String(row.getCell(2).value || '')); });

    assert.ok(names.includes(latestChild.name),
      `the latest child ${latestChild.name} must be covered; got ${JSON.stringify(names)}`);
    assert.ok(!names.includes(staleChild.name),
      `the stale child ${staleChild.name} must NOT be covered; got ${JSON.stringify(names)}`);
    assert.ok(!names.includes(collection.name),
      'the anchor is traversed, never reported on (Q42)');
  }, { timeout: 180_000 });

  test('a rule schedule arms with no stored anchors at all (latest_all)', async () => {
    // latest_all stores nothing in schedule_projects, which used to mean "not
    // configured yet" — the route would refuse to arm it and it would never run.
    const created = await api.createSchedule(token, {
      name: 'latest-all', frequency: 'daily', hour: 10, minute: 0,
      riskTypes: ['security'], selectionMode: 'latest_all', projects: [],
    });
    assert.ok(created.status < 300, `${created.status} ${JSON.stringify(created.json)}`);
    assert.equal(created.json.schedule.projectCount, 0, 'no anchors are stored by design');

    const armed = await api.post(
      `/violation-cache/schedules/${created.json.schedule.id}/arm`, {}, token);
    assert.ok(armed.status < 300,
      `arming a latest_all schedule answered ${armed.status} ${JSON.stringify(armed.json)}`);
  }, { timeout: 60_000 });
});
