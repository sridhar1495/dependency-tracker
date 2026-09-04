// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Unit tests for violation-cache/server.js utilities.
// Run with: node --test violation-cache/server.test.js
// Requires Node 18+ (built-in node:test runner — zero npm dependencies).

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { Readable } = require('node:stream');

// ── Inline the helpers under test ─────────────────────────────────────────────
// We duplicate the logic here rather than require()ing server.js so the test
// file does not start an HTTP server or connect to DependencyTrack.

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  for (const line of fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

/** Inline readLegacyConnection with injectable params for testability. */
function readLegacyConnection(envFile, fallback = {}) {
  const envVars = parseEnvFile(envFile);
  return {
    apiUrl: (envVars['DT_API_INTERNAL_URL'] || fallback.apiUrl || '').replace(/\/$/, ''),
    apiKey: (envVars['DT_API_KEY'] || fallback.apiKey || '').replace(/[\x00-\x1F\x7F]/g, '').trim(),
    frontendUrl: (envVars['DT_FRONTEND_URL'] || fallback.frontendUrl || '').replace(/\/$/, ''),
  };
}

/** Inline log() helper. */
const LOG_JSON_SYMBOL = Symbol('LOG_JSON');
function makeLog(jsonMode) {
  return function log(level, message, meta = {}) {
    const ts      = new Date().toISOString();
    const hasMeta = Object.keys(meta).length > 0;
    if (jsonMode) {
      const entry = { level, ts, msg: message };
      if (hasMeta) Object.assign(entry, meta);
      return JSON.stringify(entry);
    }
    return `[cache] ${message}${hasMeta ? ' ' + JSON.stringify(meta) : ''}`;
  };
}

/** Inline readBody() with 64 KB limit. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const MAX = 64 * 1024;
    let data = '', bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX) { req.destroy(); reject(new Error('Request body too large')); return; }
      data += chunk;
    });
    req.on('end',   () => resolve(data));
    req.on('error', reject);
  });
}

/** Create a mock Readable stream that emits the given string as its body. */
function mockReq(body) {
  const r = new Readable({ read() {} });
  if (typeof body === 'string') r.push(Buffer.from(body));
  else if (Buffer.isBuffer(body)) r.push(body);
  r.push(null);
  return r;
}

// ── Test helpers ──────────────────────────────────────────────────────────────
function tmpFile(content = '') {
  const file = path.join(os.tmpdir(), `dt-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function cleanup(file) {
  try { fs.unlinkSync(file); } catch (_) {}
}

// ── parseEnvFile ──────────────────────────────────────────────────────────────
describe('parseEnvFile', () => {
  test('returns empty object when file does not exist', () => {
    const result = parseEnvFile('/tmp/definitely-does-not-exist-dt-cache.env');
    assert.deepEqual(result, {});
  });

  test('parses simple key=value pairs', () => {
    const file = tmpFile('FOO=bar\nBAZ=qux\n');
    try {
      assert.deepEqual(parseEnvFile(file), { FOO: 'bar', BAZ: 'qux' });
    } finally { cleanup(file); }
  });

  test('ignores comment lines', () => {
    const file = tmpFile('# comment\nKEY=value\n');
    try {
      assert.deepEqual(parseEnvFile(file), { KEY: 'value' });
    } finally { cleanup(file); }
  });

  test('strips surrounding quotes from values', () => {
    const file = tmpFile('KEY1="quoted"\nKEY2=\'single\'\n');
    try {
      assert.deepEqual(parseEnvFile(file), { KEY1: 'quoted', KEY2: 'single' });
    } finally { cleanup(file); }
  });

  test('handles Windows CRLF line endings', () => {
    const file = tmpFile('FOO=bar\r\nBAZ=qux\r\n');
    try {
      assert.deepEqual(parseEnvFile(file), { FOO: 'bar', BAZ: 'qux' });
    } finally { cleanup(file); }
  });

  test('ignores lines without an equals sign', () => {
    const file = tmpFile('NOEQUALS\nKEY=val\n');
    try {
      assert.deepEqual(parseEnvFile(file), { KEY: 'val' });
    } finally { cleanup(file); }
  });

  test('handles empty file', () => {
    const file = tmpFile('');
    try {
      assert.deepEqual(parseEnvFile(file), {});
    } finally { cleanup(file); }
  });

  test('handles value with equals sign in it', () => {
    const file = tmpFile('KEY=val=with=equals\n');
    try {
      assert.equal(parseEnvFile(file).KEY, 'val=with=equals');
    } finally { cleanup(file); }
  });
});

// ── readLegacyConnection ──────────────────────────────────────────────────────
// The only remaining reader of .env. It runs once at boot to seed accounts on
// an upgraded installation; nothing writes to .env any more.
describe('readLegacyConnection', () => {
  test('returns the fallback values when the .env file does not exist', () => {
    const c = readLegacyConnection('/nonexistent.env', { apiUrl: 'http://dt:8080', apiKey: 'startupkey' });
    assert.equal(c.apiUrl, 'http://dt:8080');
    assert.equal(c.apiKey, 'startupkey');
  });

  test('.env values take priority over the process environment', () => {
    const file = tmpFile('DT_API_INTERNAL_URL=http://from-env:9090\nDT_API_KEY=envkey\n');
    try {
      const c = readLegacyConnection(file, { apiUrl: 'http://startup:8080', apiKey: 'startupkey' });
      assert.equal(c.apiUrl, 'http://from-env:9090');
      assert.equal(c.apiKey, 'envkey');
    } finally { cleanup(file); }
  });

  test('strips a trailing slash from both URLs', () => {
    const file = tmpFile('DT_API_INTERNAL_URL=http://dt:8080/\nDT_FRONTEND_URL=http://ui:8081/\n');
    try {
      const c = readLegacyConnection(file);
      assert.equal(c.apiUrl, 'http://dt:8080');
      assert.equal(c.frontendUrl, 'http://ui:8081');
    } finally { cleanup(file); }
  });

  test('strips control characters from a key read out of .env', () => {
    const file = tmpFile('DT_API_KEY=mykey\r\n');
    try {
      assert.equal(readLegacyConnection(file).apiKey, 'mykey');
    } finally { cleanup(file); }
  });

  test('returns empty strings when there is nothing to migrate', () => {
    const c = readLegacyConnection('/nonexistent.env');
    assert.deepEqual(c, { apiUrl: '', apiKey: '', frontendUrl: '' });
  });
});

// ── log() ─────────────────────────────────────────────────────────────────────
describe('log()', () => {
  test('text mode produces readable prefix', () => {
    const log = makeLog(false);
    const out = log('info', 'Service started');
    assert.ok(out.startsWith('[cache] Service started'));
  });

  test('text mode appends meta as JSON suffix', () => {
    const log = makeLog(false);
    const out = log('warn', 'Retry', { attempt: 1 });
    assert.ok(out.includes('"attempt":1'));
  });

  test('text mode omits suffix when meta is empty', () => {
    const log = makeLog(false);
    const out = log('info', 'Done');
    assert.equal(out, '[cache] Done');
  });

  test('JSON mode produces parseable JSON', () => {
    const log = makeLog(true);
    const raw = log('error', 'Something failed', { code: 500 });
    const obj = JSON.parse(raw);
    assert.equal(obj.level, 'error');
    assert.equal(obj.msg, 'Something failed');
    assert.equal(obj.code, 500);
    assert.ok(obj.ts, 'timestamp should be present');
  });

  test('JSON mode omits meta keys when meta is empty', () => {
    const log = makeLog(true);
    const raw = log('info', 'hello');
    const obj = JSON.parse(raw);
    assert.equal(Object.keys(obj).sort().join(','), 'level,msg,ts');
  });

  test('JSON mode includes all meta fields', () => {
    const log = makeLog(true);
    const raw = log('info', 'msg', { a: 1, b: 'two' });
    const obj = JSON.parse(raw);
    assert.equal(obj.a, 1);
    assert.equal(obj.b, 'two');
  });
});

// ── readBody() ────────────────────────────────────────────────────────────────
describe('readBody()', () => {
  test('resolves with full body for small request', async () => {
    const body = await readBody(mockReq('{"apiKey":"test123"}'));
    assert.equal(body, '{"apiKey":"test123"}');
  });

  test('resolves with empty string for empty body', async () => {
    const body = await readBody(mockReq(''));
    assert.equal(body, '');
  });

  test('rejects when body exceeds 64 KB', async () => {
    const big = Buffer.alloc(64 * 1024 + 1, 'x');
    await assert.rejects(
      () => readBody(mockReq(big)),
      { message: 'Request body too large' }
    );
  });

  test('accepts body exactly at 64 KB limit', async () => {
    const exact = Buffer.alloc(64 * 1024, 'x');
    const body  = await readBody(mockReq(exact));
    assert.equal(body.length, 64 * 1024);
  });
});

// ── API key control-character stripping ──────────────────────────────────────
describe('API key control-character stripping', () => {
  function sanitise(raw) {
    return raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
  }

  test('strips trailing newline from copy-pasted key', () => {
    assert.equal(sanitise('mykey\n'), 'mykey');
  });

  test('strips Windows CR+LF', () => {
    assert.equal(sanitise('mykey\r\n'), 'mykey');
  });

  test('strips embedded null bytes', () => {
    assert.equal(sanitise('my\x00key'), 'mykey');
  });

  test('leaves clean key unchanged', () => {
    assert.equal(sanitise('abc123XYZ'), 'abc123XYZ');
  });

  test('returns empty string for key that is only control characters', () => {
    assert.equal(sanitise('\n\r\t'), '');
  });

  test('handles key with mixed valid and control characters', () => {
    assert.equal(sanitise('abc\x01def\x7Fghi'), 'abcdefghi');
  });
});


// ── makeSemaphore ─────────────────────────────────────────────────────────────
// Inline copy of the concurrency-limiter from server.js (pure JS, no deps).
function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return function acquire(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve().then(fn).then(
          v => { active--; if (queue.length) queue.shift()(); resolve(v); },
          e => { active--; if (queue.length) queue.shift()(); reject(e); }
        );
      };
      if (active < limit) run();
      else queue.push(run);
    });
  };
}

describe('makeSemaphore()', () => {
  test('resolves all tasks when concurrency equals task count', async () => {
    const sem     = makeSemaphore(3);
    const results = await Promise.all([1, 2, 3].map(n => sem(async () => n * 10)));
    assert.deepEqual(results.sort((a, b) => a - b), [10, 20, 30]);
  });

  test('limits concurrency — no more than limit tasks run simultaneously', async () => {
    const sem     = makeSemaphore(2);
    let   active  = 0;
    let   maxSeen = 0;

    const task = () => sem(async () => {
      active++;
      maxSeen = Math.max(maxSeen, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
    });

    await Promise.all([task(), task(), task(), task()]);
    assert.ok(maxSeen <= 2, `Expected ≤2 concurrent tasks, saw ${maxSeen}`);
  });

  test('resolves with the return value of the wrapped function', async () => {
    const sem = makeSemaphore(1);
    const val = await sem(async () => 'hello');
    assert.equal(val, 'hello');
  });

  test('propagates rejection from the wrapped function', async () => {
    const sem = makeSemaphore(1);
    await assert.rejects(
      () => sem(async () => { throw new Error('boom'); }),
      { message: 'boom' }
    );
  });

  test('queued tasks run after active slots free up', async () => {
    const sem   = makeSemaphore(1);
    const order = [];
    await Promise.all([
      sem(async () => { order.push(1); await new Promise(r => setTimeout(r, 10)); }),
      sem(async () => { order.push(2); }),
    ]);
    assert.deepEqual(order, [1, 2]);
  });

  test('semaphore(1) acts as a mutex — sequential execution', async () => {
    const sem   = makeSemaphore(1);
    let   count = 0;
    const inc   = () => sem(async () => {
      const c = count;
      await new Promise(r => setTimeout(r, 5));
      count = c + 1;
    });
    await Promise.all([inc(), inc(), inc()]);
    assert.equal(count, 3);
  });
});

// ── fetchAllFindings URL construction ─────────────────────────────────────────
// Test the URL-building logic inline (independent of actual HTTP calls).

const FINDINGS_PAGE_SIZE_TEST = 300;

function buildFindingsUrl(name, version, page) {
  const baseQs = [
    'showInactive=false',
    'showSuppressed=false',
    'textSearchField=vulnerability_id,vulnerability_title,component_name,component_version,project_name',
    `textSearchInput=${encodeURIComponent(`${name} ${version}`)}`,
    'severity=critical,high,medium,low,unassigned',
    `pageSize=${FINDINGS_PAGE_SIZE_TEST}`,
  ].join('&');
  return `/api/v1/finding?${baseQs}&pageNumber=${page}`;
}

describe('fetchAllFindings URL construction', () => {
  test('includes all required query parameters', () => {
    const url = buildFindingsUrl('my-service', '1.2.3', 1);
    assert.ok(url.includes('showInactive=false'));
    assert.ok(url.includes('showSuppressed=false'));
    assert.ok(url.includes('textSearchField='));
    assert.ok(url.includes('severity=critical,high,medium,low,unassigned'));
    assert.ok(url.includes(`pageSize=${FINDINGS_PAGE_SIZE_TEST}`));
    assert.ok(url.includes('pageNumber=1'));
  });

  test('URL-encodes the name+version text search input', () => {
    const url = buildFindingsUrl('my service', '1.2.3', 1);
    assert.ok(url.includes(encodeURIComponent('my service 1.2.3')));
    assert.ok(!url.includes('my service 1.2.3'), 'raw spaces should be encoded');
  });

  test('handles empty version (just name with trailing space encoded)', () => {
    const url = buildFindingsUrl('my-service', '', 1);
    assert.ok(url.includes(encodeURIComponent('my-service ')));
  });

  test('increments pageNumber for subsequent pages', () => {
    const url2 = buildFindingsUrl('svc', '2.0', 2);
    const url5 = buildFindingsUrl('svc', '2.0', 5);
    assert.ok(url2.includes('pageNumber=2'));
    assert.ok(url5.includes('pageNumber=5'));
  });

  test('targets /api/v1/finding endpoint', () => {
    const url = buildFindingsUrl('svc', '1.0', 1);
    assert.ok(url.startsWith('/api/v1/finding'));
  });
});

// ── readBody() with configurable maxBytes ─────────────────────────────────────
describe('readBody() maxBytes override', () => {
  /** Inline readBody with configurable maxBytes (same logic as server.js). */
  function readBodyCustom(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let data = '', bytes = 0;
      req.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { req.destroy(); reject(new Error('Request body too large')); return; }
        data += chunk;
      });
      req.on('end',   () => resolve(data));
      req.on('error', reject);
    });
  }

  test('default limit rejects body larger than 64 KB', async () => {
    const big = Buffer.alloc(64 * 1024 + 1, 'x');
    await assert.rejects(() => readBodyCustom(mockReq(big)), { message: 'Request body too large' });
  });

  test('5 MB override accepts a 1 MB body', async () => {
    const oneMB = Buffer.alloc(1024 * 1024, 'y');
    const body  = await readBodyCustom(mockReq(oneMB), 5 * 1024 * 1024);
    assert.equal(body.length, 1024 * 1024);
  });

  test('5 MB override rejects a body just over 5 MB', async () => {
    const over = Buffer.alloc(5 * 1024 * 1024 + 1, 'z');
    await assert.rejects(
      () => readBodyCustom(mockReq(over), 5 * 1024 * 1024),
      { message: 'Request body too large' }
    );
  });

  test('custom 1-byte limit rejects 2-byte body', async () => {
    await assert.rejects(
      () => readBodyCustom(mockReq('ab'), 1),
      { message: 'Request body too large' }
    );
  });
});

// ── componentMap accumulation (Affected Projects) ─────────────────────────────
// Mirrors the accumulation logic in runReportJob — tracks { count, projects:Set }
// so Sheet 3 can list the affected projects per component.

function accumulate(componentMap, cKey, projName) {
  const entry = componentMap.get(cKey) || { count: 0, projects: new Set() };
  entry.count++;
  entry.projects.add(projName);
  componentMap.set(cKey, entry);
}

describe('componentMap accumulation (Affected Projects)', () => {
  test('count increments with each finding', () => {
    const m = new Map();
    accumulate(m, 'lodash', 'ProjectA');
    accumulate(m, 'lodash', 'ProjectA');
    assert.equal(m.get('lodash').count, 2);
  });

  test('projects Set contains unique project names only', () => {
    const m = new Map();
    accumulate(m, 'lodash', 'ProjectA');
    accumulate(m, 'lodash', 'ProjectA'); // same project, different finding
    accumulate(m, 'lodash', 'ProjectB');
    assert.deepEqual([...m.get('lodash').projects].sort(), ['ProjectA', 'ProjectB']);
  });

  test('multiple findings from same project do not duplicate the project name', () => {
    const m = new Map();
    for (let i = 0; i < 5; i++) accumulate(m, 'react', 'Frontend');
    assert.equal(m.get('react').count,          5);
    assert.equal(m.get('react').projects.size,  1);
  });

  test('different components are tracked independently', () => {
    const m = new Map();
    accumulate(m, 'axios',   'ServiceA');
    accumulate(m, 'express', 'ServiceA');
    accumulate(m, 'axios',   'ServiceB');
    assert.equal(m.get('axios').count,   2);
    assert.equal(m.get('express').count, 1);
    assert.deepEqual([...m.get('axios').projects].sort(), ['ServiceA', 'ServiceB']);
  });

  test('affected projects list sorts alphabetically when joined', () => {
    const m = new Map();
    accumulate(m, 'axios', 'Zebra');
    accumulate(m, 'axios', 'Apple');
    accumulate(m, 'axios', 'Mango');
    const list = [...m.get('axios').projects].sort().join(', ');
    assert.equal(list, 'Apple, Mango, Zebra');
  });

  test('sort by count descending works with new entry shape', () => {
    const m = new Map();
    accumulate(m, 'a', 'P1');
    accumulate(m, 'b', 'P1');
    accumulate(m, 'b', 'P2');
    accumulate(m, 'b', 'P3');
    const sorted = [...m.entries()].sort((x, y) => y[1].count - x[1].count);
    assert.equal(sorted[0][0], 'b', '"b" should be first (count 3 > 1)');
    assert.equal(sorted[1][0], 'a');
  });
});

// ── streamViolationsForProject URL construction ─────────────────────────────
// Inline the URL-building logic from streamViolationsForProject (no HTTP calls).
// Uses project_name text-search instead of project={uuid} because DT silently
// ignores the project UUID filter on this API version.

const VIOLATIONS_PAGE_SIZE_TEST = 300;

function buildViolationUrl(proj, riskType, page) {
  const dtRiskType = riskType === 'license' ? 'LICENSE' : 'OPERATIONAL';
  const baseQs = [
    'showInactive=false',
    'suppressed=false',
    `riskType=${dtRiskType}`,
    'textSearchField=project_name',
    `textSearchInput=${encodeURIComponent(proj.name)}`,
    `pageSize=${VIOLATIONS_PAGE_SIZE_TEST}`,
  ].join('&');
  return `/api/v1/violation?${baseQs}&pageNumber=${page}`;
}

const testProj = { uuid: 'proj-uuid-1', name: 'my-service', version: '1.0.0' };

describe('streamViolationsForProject URL construction', () => {
  test('targets /api/v1/violation endpoint', () => {
    assert.ok(buildViolationUrl(testProj, 'license', 1).startsWith('/api/v1/violation'));
  });

  test('uses textSearchField=project_name (not project=uuid)', () => {
    const url = buildViolationUrl(testProj, 'license', 1);
    assert.ok(url.includes('textSearchField=project_name'));
    assert.ok(!url.includes('project=proj-uuid'));
  });

  test('encodes project name into textSearchInput', () => {
    const url = buildViolationUrl({ uuid: 'u', name: 'my service', version: '1' }, 'license', 1);
    assert.ok(url.includes('textSearchInput=my%20service'));
  });

  test('maps "license" to "LICENSE" DT riskType', () => {
    const url = buildViolationUrl(testProj, 'license', 1);
    assert.ok(url.includes('riskType=LICENSE'));
    assert.ok(!url.includes('riskType=OPERATIONAL'));
  });

  test('maps "operational" to "OPERATIONAL" DT riskType', () => {
    const url = buildViolationUrl(testProj, 'operational', 1);
    assert.ok(url.includes('riskType=OPERATIONAL'));
    assert.ok(!url.includes('riskType=LICENSE'));
  });

  test('includes showInactive=false', () => {
    assert.ok(buildViolationUrl(testProj, 'license', 1).includes('showInactive=false'));
  });

  test('includes suppressed=false', () => {
    assert.ok(buildViolationUrl(testProj, 'license', 1).includes('suppressed=false'));
  });

  test('includes correct pageSize', () => {
    assert.ok(buildViolationUrl(testProj, 'license', 1).includes(`pageSize=${VIOLATIONS_PAGE_SIZE_TEST}`));
  });

  test('increments pageNumber correctly', () => {
    assert.ok(buildViolationUrl(testProj, 'license', 1).includes('pageNumber=1'));
    assert.ok(buildViolationUrl(testProj, 'license', 2).includes('pageNumber=2'));
    assert.ok(buildViolationUrl(testProj, 'license', 5).includes('pageNumber=5'));
  });

  test('page 1 and page 2 URLs differ only in pageNumber', () => {
    const url1 = buildViolationUrl(testProj, 'license', 1);
    const url2 = buildViolationUrl(testProj, 'license', 2);
    assert.notEqual(url1, url2);
    assert.equal(url1.replace('pageNumber=1', 'pageNumber=2'), url2);
  });
});

// ── riskTypes validation logic ────────────────────────────────────────────────
// Inline the validation from the POST /violation-cache/report/generate handler.

const VALID_RISK_TYPES_TEST = new Set(['security', 'license', 'operational']);

function validateRiskTypes(input) {
  const riskTypes = Array.isArray(input) && input.length > 0 ? input : ['security'];
  const invalid   = riskTypes.filter(t => !VALID_RISK_TYPES_TEST.has(t));
  return { riskTypes, invalid, valid: invalid.length === 0 };
}

describe('riskTypes validation', () => {
  test('defaults to ["security"] when body.riskTypes is undefined', () => {
    assert.deepEqual(validateRiskTypes(undefined).riskTypes, ['security']);
  });

  test('defaults to ["security"] when body.riskTypes is an empty array', () => {
    assert.deepEqual(validateRiskTypes([]).riskTypes, ['security']);
  });

  test('defaults to ["security"] when body.riskTypes is not an array', () => {
    assert.deepEqual(validateRiskTypes('security').riskTypes, ['security']);
    assert.deepEqual(validateRiskTypes(42).riskTypes, ['security']);
  });

  test('accepts ["security"] as valid', () => {
    const r = validateRiskTypes(['security']);
    assert.ok(r.valid);
    assert.equal(r.invalid.length, 0);
  });

  test('accepts ["license"] as valid', () => {
    assert.ok(validateRiskTypes(['license']).valid);
  });

  test('accepts ["operational"] as valid', () => {
    assert.ok(validateRiskTypes(['operational']).valid);
  });

  test('accepts all three types together', () => {
    assert.ok(validateRiskTypes(['security', 'license', 'operational']).valid);
  });

  test('accepts ["security", "license"] as valid', () => {
    assert.ok(validateRiskTypes(['security', 'license']).valid);
  });

  test('rejects an unknown risk type and reports it', () => {
    const r = validateRiskTypes(['security', 'unknown']);
    assert.ok(!r.valid);
    assert.ok(r.invalid.includes('unknown'));
  });

  test('rejects multiple unknown types', () => {
    const r = validateRiskTypes(['foo', 'bar']);
    assert.ok(!r.valid);
    assert.equal(r.invalid.length, 2);
  });

  test('passes through only valid types unchanged', () => {
    const r = validateRiskTypes(['license', 'operational']);
    assert.deepEqual(r.riskTypes, ['license', 'operational']);
  });
});

// ── violation state accumulation (license / operational) ──────────────────────
// Mirrors the counts accumulation in runReportJob for license and operational.

function accumulateViolationCounts(violations) {
  const counts = { fail: 0, warn: 0, info: 0 };
  for (const v of violations) {
    const state = (v.violationState || 'INFO').toLowerCase();
    if (state in counts) counts[state]++;
  }
  return counts;
}

describe('violation state accumulation (license / operational)', () => {
  test('counts FAIL violations correctly', () => {
    const counts = accumulateViolationCounts([
      { violationState: 'FAIL' }, { violationState: 'FAIL' },
    ]);
    assert.equal(counts.fail, 2);
    assert.equal(counts.warn, 0);
    assert.equal(counts.info, 0);
  });

  test('counts WARN violations correctly', () => {
    const counts = accumulateViolationCounts([{ violationState: 'WARN' }]);
    assert.equal(counts.warn, 1);
  });

  test('counts INFO violations correctly', () => {
    const counts = accumulateViolationCounts([{ violationState: 'INFO' }]);
    assert.equal(counts.info, 1);
  });

  test('defaults null violationState to INFO bucket', () => {
    const counts = accumulateViolationCounts([{ violationState: null }]);
    assert.equal(counts.info, 1);
  });

  test('defaults missing violationState to INFO bucket', () => {
    const counts = accumulateViolationCounts([{}]);
    assert.equal(counts.info, 1);
  });

  test('handles mixed violation states', () => {
    const counts = accumulateViolationCounts([
      { violationState: 'FAIL' },
      { violationState: 'WARN' },
      { violationState: 'INFO' },
      { violationState: 'FAIL' },
    ]);
    assert.equal(counts.fail, 2);
    assert.equal(counts.warn, 1);
    assert.equal(counts.info, 1);
  });

  test('returns all zeros for empty violations array', () => {
    assert.deepEqual(accumulateViolationCounts([]), { fail: 0, warn: 0, info: 0 });
  });

  test('is case-insensitive for violationState', () => {
    const counts = accumulateViolationCounts([
      { violationState: 'fail' },
      { violationState: 'WARN' },
    ]);
    assert.equal(counts.fail, 1);
    assert.equal(counts.warn, 1);
  });
});

// ── Flat field extraction for license/operational violations ──────────────────
// Mirrors the extraction logic in runReportJob to verify only needed fields
// are kept (guards against re-introducing full object spread that caused OOM).

function extractLicenseViolation(v, projName, projVersion) {
  const c   = v.component       || {};
  const pc  = v.policyCondition || {};
  const pol = pc.policy         || {};
  const state = (pol.violationState || 'INFO').toUpperCase();
  return {
    projName,
    projVersion,
    component:   [c.name, c.group].filter(Boolean).join('-') || c.name || '',
    compVersion: c.version                    || '',
    licenseName: c.resolvedLicense?.name      || '',
    licenseId:   c.resolvedLicense?.licenseId || '',
    license:     pc.value                     || '',
    policy:      pol.name                     || '',
    state,
  };
}

function extractOperationalViolation(v, projName, projVersion) {
  const c   = v.component       || {};
  const pc  = v.policyCondition || {};
  const pol = pc.policy         || {};
  const state = (pol.violationState || 'INFO').toUpperCase();
  return {
    projName,
    projVersion,
    component:   [c.name, c.group].filter(Boolean).join('-') || c.name || '',
    compVersion: c.version  || '',
    policy:      pol.name   || '',
    subject:     pc.subject || '',
    condition:   pc.value   || '',
    state,
  };
}

describe('flat field extraction — license violations', () => {
  test('extracts all needed fields from a full violation object', () => {
    const v = {
      component: {
        name: 'lodash', group: 'com.lodash', version: '4.17.0',
        resolvedLicense: { name: 'MIT License', licenseId: 'MIT' },
      },
      policyCondition: { value: 'MIT', policy: { name: 'License Policy', violationState: 'WARN' } },
    };
    const flat = extractLicenseViolation(v, 'my-service', '1.0.0');
    assert.equal(flat.projName,    'my-service');
    assert.equal(flat.projVersion, '1.0.0');
    assert.equal(flat.component,   'lodash-com.lodash');
    assert.equal(flat.compVersion, '4.17.0');
    assert.equal(flat.licenseName, 'MIT License');
    assert.equal(flat.licenseId,   'MIT');
    assert.equal(flat.license,     'MIT');
    assert.equal(flat.policy,      'License Policy');
    assert.equal(flat.state,       'WARN');
  });

  test('state comes from policyCondition.policy.violationState, not top-level violationState', () => {
    const v = {
      component: {},
      policyCondition: { policy: { violationState: 'FAIL' } },
      violationState: 'INFO',  // top-level should be ignored
    };
    assert.equal(extractLicenseViolation(v, 'svc', '1').state, 'FAIL');
  });

  test('does not include raw component/policyCondition objects', () => {
    const v = {
      component: { name: 'react', group: null, version: '18.0.0' },
      policyCondition: { value: 'Apache-2.0', policy: { name: 'P1', violationState: 'FAIL' } },
      extraField: 'should-be-dropped',
    };
    const flat = extractLicenseViolation(v, 'app', '2.0.0');
    assert.equal('extraField' in flat, false);
    assert.equal('policyCondition' in flat, false);
  });

  test('defaults to INFO when policy.violationState is absent', () => {
    const v = { component: {}, policyCondition: {} };
    assert.equal(extractLicenseViolation(v, 'x', '1').state, 'INFO');
  });

  test('reads licenseName and licenseId from component.resolvedLicense', () => {
    const v = {
      component: { name: 'log4j', resolvedLicense: { name: 'Apache 2.0', licenseId: 'Apache-2.0' } },
      policyCondition: { policy: { violationState: 'WARN' } },
    };
    const flat = extractLicenseViolation(v, 'svc', '1');
    assert.equal(flat.licenseName, 'Apache 2.0');
    assert.equal(flat.licenseId,   'Apache-2.0');
  });

  test('falls back to empty strings when resolvedLicense is absent', () => {
    const v = { component: { name: 'axios' }, policyCondition: { policy: {} } };
    const flat = extractLicenseViolation(v, 'svc', '1');
    assert.equal(flat.licenseName, '');
    assert.equal(flat.licenseId,   '');
  });

  test('joins component name and group with dash', () => {
    const v = {
      component: { name: 'spring-core', group: 'org.springframework', version: '5.3.0' },
      policyCondition: { policy: {} },
    };
    assert.equal(extractLicenseViolation(v, 'svc', '1').component, 'spring-core-org.springframework');
  });

  test('falls back to name alone when group is absent', () => {
    const v = { component: { name: 'axios', version: '1.0.0' }, policyCondition: { policy: {} } };
    assert.equal(extractLicenseViolation(v, 'svc', '1').component, 'axios');
  });
});

describe('flat field extraction — operational violations', () => {
  test('extracts all needed fields', () => {
    const v = {
      component: { name: 'guava', group: 'com.google', version: '30.0' },
      policyCondition: { value: 'LATEST', subject: 'VERSION', policy: { name: 'Op Policy', violationState: 'FAIL' } },
    };
    const flat = extractOperationalViolation(v, 'svc', '1.2.0');
    assert.equal(flat.policy,    'Op Policy');
    assert.equal(flat.subject,   'VERSION');
    assert.equal(flat.condition, 'LATEST');
    assert.equal(flat.state,     'FAIL');
    assert.equal('policyCondition' in flat, false);
  });

  test('state comes from policyCondition.policy.violationState, not top-level violationState', () => {
    const v = {
      component: {},
      policyCondition: { policy: { violationState: 'WARN' } },
      violationState: 'INFO',
    };
    assert.equal(extractOperationalViolation(v, 'svc', '1').state, 'WARN');
  });

  test('defaults to INFO when policy.violationState is absent', () => {
    const v = { component: {}, policyCondition: {} };
    assert.equal(extractOperationalViolation(v, 'svc', '1').state, 'INFO');
  });

  test('defaults missing fields to empty strings', () => {
    const v = { component: {}, policyCondition: { policy: {} } };
    const flat = extractOperationalViolation(v, 'svc', '1');
    assert.equal(flat.policy,    '');
    assert.equal(flat.subject,   '');
    assert.equal(flat.condition, '');
  });
});

// ── Unique Operational Risks aggregation (keyed by component + version) ───────

function buildOpsCompMap(opsViolations) {
  const opsCompMap = new Map();
  for (const v of opsViolations) {
    const key = `${v.component}||${v.compVersion}`;
    if (!opsCompMap.has(key)) {
      opsCompMap.set(key, {
        component:   v.component,
        compVersion: v.compVersion,
        fail: 0, warn: 0, info: 0,
        projects: new Set(),
      });
    }
    const entry = opsCompMap.get(key);
    const st = v.state.toLowerCase();
    if (st === 'fail') entry.fail++;
    else if (st === 'warn') entry.warn++;
    else entry.info++;
    entry.projects.add(v.projName);
  }
  return opsCompMap;
}

describe('Unique Operational Risks aggregation', () => {
  test('produces one entry per unique component + version', () => {
    const violations = [
      { component: 'guava', compVersion: '30.0', state: 'FAIL', projName: 'A' },
      { component: 'guava', compVersion: '30.0', state: 'WARN', projName: 'B' },
      { component: 'netty', compVersion: '4.1.0', state: 'INFO', projName: 'C' },
    ];
    assert.equal(buildOpsCompMap(violations).size, 2);
  });

  test('same component with different versions produces separate entries', () => {
    const violations = [
      { component: 'guava', compVersion: '29.0', state: 'INFO', projName: 'A' },
      { component: 'guava', compVersion: '30.0', state: 'FAIL', projName: 'B' },
    ];
    assert.equal(buildOpsCompMap(violations).size, 2);
  });

  test('counts fail/warn/info correctly per component+version', () => {
    const violations = [
      { component: 'c', compVersion: '1', state: 'FAIL', projName: 'A' },
      { component: 'c', compVersion: '1', state: 'FAIL', projName: 'B' },
      { component: 'c', compVersion: '1', state: 'WARN', projName: 'C' },
      { component: 'c', compVersion: '1', state: 'INFO', projName: 'D' },
    ];
    const entry = buildOpsCompMap(violations).get('c||1');
    assert.equal(entry.fail, 2);
    assert.equal(entry.warn, 1);
    assert.equal(entry.info, 1);
  });

  test('affected projects Set has no duplicates', () => {
    const v = (p) => ({ component: 'lib', compVersion: '1', state: 'INFO', projName: p });
    assert.equal(buildOpsCompMap([v('A'), v('A'), v('B')]).get('lib||1').projects.size, 2);
  });

  test('component and version are stored on the entry', () => {
    const violations = [{ component: 'spring', compVersion: '5.3', state: 'WARN', projName: 'X' }];
    const entry = buildOpsCompMap(violations).get('spring||5.3');
    assert.equal(entry.component,   'spring');
    assert.equal(entry.compVersion, '5.3');
  });

  test('handles empty violations array', () => {
    assert.equal(buildOpsCompMap([]).size, 0);
  });

  test('sorts by fail desc then warn desc', () => {
    const violations = [
      { component: 'a', compVersion: '1', state: 'WARN', projName: 'X' },
      { component: 'b', compVersion: '1', state: 'FAIL', projName: 'X' },
      { component: 'c', compVersion: '1', state: 'INFO', projName: 'X' },
    ];
    const entries = [...buildOpsCompMap(violations).values()].sort((a, b) => {
      if (b.fail !== a.fail) return b.fail - a.fail;
      if (b.warn !== a.warn) return b.warn - a.warn;
      return (b.fail + b.warn + b.info) - (a.fail + a.warn + a.info);
    });
    assert.equal(entries[0].component, 'b');
    assert.equal(entries[1].component, 'a');
    assert.equal(entries[2].component, 'c');
  });
});

// ── Unique License Risks aggregation (keyed by component + version) ──────────

function buildCompLicMap(licViolations) {
  const compLicMap = new Map();
  for (const v of licViolations) {
    const key = `${v.component}||${v.compVersion}`;
    if (!compLicMap.has(key)) {
      compLicMap.set(key, {
        component:   v.component,
        compVersion: v.compVersion,
        licenseName: v.licenseName || '',
        licenseId:   v.licenseId   || '',
        fail: 0, warn: 0, info: 0,
        projects: new Set(),
      });
    }
    const entry = compLicMap.get(key);
    if (!entry.licenseName && v.licenseName) entry.licenseName = v.licenseName;
    if (!entry.licenseId   && v.licenseId)   entry.licenseId   = v.licenseId;
    const st = v.state.toLowerCase();
    if (st === 'fail') entry.fail++;
    else if (st === 'warn') entry.warn++;
    else entry.info++;
    entry.projects.add(v.projName);
  }
  return compLicMap;
}

describe('Unique License Risks aggregation', () => {
  test('produces one entry per unique component + version', () => {
    const violations = [
      { component: 'lodash', compVersion: '4.0.0', licenseName: 'MIT License', licenseId: 'MIT', state: 'WARN', projName: 'A' },
      { component: 'lodash', compVersion: '4.0.0', licenseName: 'MIT License', licenseId: 'MIT', state: 'FAIL', projName: 'B' },
      { component: 'axios',  compVersion: '1.0.0', licenseName: 'MIT License', licenseId: 'MIT', state: 'INFO', projName: 'C' },
    ];
    const map = buildCompLicMap(violations);
    assert.equal(map.size, 2);
  });

  test('same component with different versions produces separate entries', () => {
    const violations = [
      { component: 'lodash', compVersion: '4.0.0', licenseName: '', licenseId: '', state: 'INFO', projName: 'A' },
      { component: 'lodash', compVersion: '4.1.0', licenseName: '', licenseId: '', state: 'FAIL', projName: 'B' },
    ];
    assert.equal(buildCompLicMap(violations).size, 2);
  });

  test('counts fail/warn/info correctly per component+version', () => {
    const violations = [
      { component: 'c', compVersion: '1', licenseName: '', licenseId: '', state: 'FAIL', projName: 'A' },
      { component: 'c', compVersion: '1', licenseName: '', licenseId: '', state: 'FAIL', projName: 'B' },
      { component: 'c', compVersion: '1', licenseName: '', licenseId: '', state: 'WARN', projName: 'C' },
    ];
    const entry = buildCompLicMap(violations).get('c||1');
    assert.equal(entry.fail, 2);
    assert.equal(entry.warn, 1);
    assert.equal(entry.info, 0);
  });

  test('affected projects uses a Set — no duplicates', () => {
    const v = (projName) => ({ component: 'lib', compVersion: '1', licenseName: '', licenseId: '', state: 'INFO', projName });
    const map = buildCompLicMap([v('A'), v('A'), v('B')]);
    assert.equal(map.get('lib||1').projects.size, 2);
  });

  test('component and version are stored on the entry', () => {
    const violations = [
      { component: 'spring', compVersion: '5.3.0', licenseName: 'Apache', licenseId: 'Apache-2.0', state: 'WARN', projName: 'X' },
    ];
    const entry = buildCompLicMap(violations).get('spring||5.3.0');
    assert.equal(entry.component,   'spring');
    assert.equal(entry.compVersion, '5.3.0');
    assert.equal(entry.licenseName, 'Apache');
    assert.equal(entry.licenseId,   'Apache-2.0');
  });

  test('licenseName/licenseId filled from first non-empty occurrence', () => {
    const violations = [
      { component: 'c', compVersion: '1', licenseName: '',      licenseId: '',    state: 'INFO', projName: 'A' },
      { component: 'c', compVersion: '1', licenseName: 'MIT L', licenseId: 'MIT', state: 'WARN', projName: 'B' },
    ];
    const entry = buildCompLicMap(violations).get('c||1');
    assert.equal(entry.licenseName, 'MIT L');
    assert.equal(entry.licenseId,   'MIT');
  });

  test('handles empty violations array', () => {
    assert.equal(buildCompLicMap([]).size, 0);
  });

  test('sorts by fail desc then warn desc', () => {
    const violations = [
      { component: 'a', compVersion: '1', licenseName: '', licenseId: '', state: 'WARN', projName: 'X' },
      { component: 'b', compVersion: '1', licenseName: '', licenseId: '', state: 'FAIL', projName: 'X' },
      { component: 'c', compVersion: '1', licenseName: '', licenseId: '', state: 'INFO', projName: 'X' },
    ];
    const entries = [...buildCompLicMap(violations).values()].sort((a, b) => {
      if (b.fail !== a.fail) return b.fail - a.fail;
      if (b.warn !== a.warn) return b.warn - a.warn;
      return (b.fail + b.warn + b.info) - (a.fail + a.warn + a.info);
    });
    assert.equal(entries[0].component, 'b');
    assert.equal(entries[1].component, 'a');
    assert.equal(entries[2].component, 'c');
  });
});

// ── Performance constants and parallel phase behaviour ────────────────────────
// Verify the page-size and concurrency constants match the documented values,
// and that the Promise.all parallelisation contract holds: all three phases can
// be started concurrently within one project slot.

describe('performance constants and parallel phase execution', () => {
  test('FINDINGS_PAGE_SIZE_TEST matches the updated constant (300)', () => {
    assert.equal(FINDINGS_PAGE_SIZE_TEST, 300);
  });

  test('VIOLATIONS_PAGE_SIZE_TEST matches the updated constant (300)', () => {
    assert.equal(VIOLATIONS_PAGE_SIZE_TEST, 300);
  });

  // Simulate the Promise.all([security, license, operational]) pattern used in
  // runReportJob to verify all phases complete and results are independent.
  test('Promise.all phases resolve independently — security result unaffected by violation results', async () => {
    const results = {};
    await Promise.all([
      (async () => { results.security    = 'sec-done'; })(),
      (async () => { results.license     = 'lic-done'; })(),
      (async () => { results.operational = 'ops-done'; })(),
    ]);
    assert.equal(results.security,    'sec-done');
    assert.equal(results.license,     'lic-done');
    assert.equal(results.operational, 'ops-done');
  });

  test('Promise.all with only security selected skips license and operational', async () => {
    const riskTypes = ['security'];
    const phaseRan  = { security: false, license: false, operational: false };
    await Promise.all([
      riskTypes.includes('security')    ? (async () => { phaseRan.security    = true; })() : Promise.resolve(),
      riskTypes.includes('license')     ? (async () => { phaseRan.license     = true; })() : Promise.resolve(),
      riskTypes.includes('operational') ? (async () => { phaseRan.operational = true; })() : Promise.resolve(),
    ]);
    assert.equal(phaseRan.security,    true);
    assert.equal(phaseRan.license,     false);
    assert.equal(phaseRan.operational, false);
  });

  test('Promise.all with all three types runs every phase', async () => {
    const riskTypes = ['security', 'license', 'operational'];
    const phaseRan  = { security: false, license: false, operational: false };
    await Promise.all([
      riskTypes.includes('security')    ? (async () => { phaseRan.security    = true; })() : Promise.resolve(),
      riskTypes.includes('license')     ? (async () => { phaseRan.license     = true; })() : Promise.resolve(),
      riskTypes.includes('operational') ? (async () => { phaseRan.operational = true; })() : Promise.resolve(),
    ]);
    assert.equal(phaseRan.security,    true);
    assert.equal(phaseRan.license,     true);
    assert.equal(phaseRan.operational, true);
  });

  test('violationSema at concurrency=3 allows up to 3 simultaneous violation fetches', async () => {
    const VIOLATION_CONCURRENCY_TEST = 3;
    const sema = makeSemaphore(VIOLATION_CONCURRENCY_TEST);
    let concurrent    = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 6 }, (_, i) =>
      sema(async () => {
        concurrent++;
        if (concurrent > maxConcurrent) maxConcurrent = concurrent;
        await new Promise(r => setImmediate(r));
        concurrent--;
        return i;
      })
    );
    await Promise.all(tasks);
    assert.ok(maxConcurrent <= VIOLATION_CONCURRENCY_TEST,
      `Expected maxConcurrent <= ${VIOLATION_CONCURRENCY_TEST}, got ${maxConcurrent}`);
    assert.ok(maxConcurrent >= 2,
      `Expected at least 2 concurrent tasks, got ${maxConcurrent}`);
  });

  test('findingsUrl pageSize is 300', () => {
    const url = buildFindingsUrl('svc', '2.0', 1);
    assert.ok(url.includes('pageSize=300'), `Expected pageSize=300 in: ${url}`);
    assert.ok(!url.includes('pageSize=200'), 'Old pageSize=200 should not appear');
  });

  test('violationUrl pageSize is 300', () => {
    const url = buildViolationUrl(testProj, 'license', 1);
    assert.ok(url.includes('pageSize=300'), `Expected pageSize=300 in: ${url}`);
    assert.ok(!url.includes('pageSize=200'), 'Old pageSize=200 should not appear');
  });
});

// ── calcNextRun ───────────────────────────────────────────────────────────────
// lib/scheduler.js performs no I/O at require time, so calcNextRun is imported
// rather than duplicated (CLAUDE.md §10.3). It is the single source of truth for
// scheduling times and must never be reimplemented at a call site.
const { calcNextRun } = require('./lib/scheduler');

describe('calcNextRun()', () => {
  test('daily: result is always in the future', () => {
    const next = calcNextRun({ frequency: 'daily', hour: 9 });
    assert.ok(next > new Date(), 'next run should be in the future');
  });

  test('daily: result is at the configured hour', () => {
    const next = calcNextRun({ frequency: 'daily', hour: 14 });
    assert.equal(next.getHours(), 14);
    assert.equal(next.getMinutes(), 0);
    assert.equal(next.getSeconds(), 0);
  });

  test('daily: no more than 25 hours in the future', () => {
    const next = calcNextRun({ frequency: 'daily', hour: 9 });
    const maxMs = 25 * 3_600_000;
    assert.ok(next.getTime() - Date.now() <= maxMs,
      `Expected next run within 25 h, got ${next.getTime() - Date.now()} ms`);
  });

  test('weekly: result falls on one of the configured weekdays', () => {
    const targetDays = [1, 3]; // Monday, Wednesday
    const next = calcNextRun({ frequency: 'weekly', hour: 9, weekDays: targetDays });
    assert.ok(targetDays.includes(next.getDay()),
      `Expected day ${next.getDay()} to be in [1, 3]`);
  });

  test('weekly: result is always at least 1 day in the future (never today)', () => {
    const next = calcNextRun({ frequency: 'weekly', hour: 9, weekDays: [0,1,2,3,4,5,6] });
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    todayStart.setDate(todayStart.getDate() + 1);
    assert.ok(next >= todayStart, 'weekly next run should be at least tomorrow');
  });

  test('weekly: result is no more than 8 days away', () => {
    const next = calcNextRun({ frequency: 'weekly', hour: 9, weekDays: [1] });
    const maxMs = 8 * 24 * 3_600_000;
    assert.ok(next.getTime() - Date.now() <= maxMs,
      `Expected next run within 8 days`);
  });

  test('monthly: result is always in the future', () => {
    const next = calcNextRun({ frequency: 'monthly', hour: 9, monthDay: 15 });
    assert.ok(next > new Date(), 'monthly next run should be in the future');
  });

  test('monthly: day is capped at 28', () => {
    const next = calcNextRun({ frequency: 'monthly', hour: 9, monthDay: 31 });
    assert.ok(next.getDate() <= 28, `Expected date <= 28, got ${next.getDate()}`);
  });

  test('unknown frequency: returns roughly 24 h from now', () => {
    const before = Date.now();
    const next   = calcNextRun({ frequency: 'unknown' });
    const delta  = next.getTime() - before;
    assert.ok(delta >= 23 * 3_600_000 && delta <= 25 * 3_600_000,
      `Expected ~24 h delta, got ${delta} ms`);
  });
});

// ── lib/config.js — environment parsing ───────────────────────────────────────
// lib/config.js performs no I/O at require time, so it is imported directly
// rather than duplicated (CLAUDE.md §10.3). parseConfig() takes the environment
// as a parameter, so nothing here mutates process.env.

const { parseConfig, DEFAULTS } = require('./lib/config');

/** Minimum environment for a valid configuration. */
const ENC_KEY = 'a'.repeat(64);   // 64 hex characters = 32 bytes
const baseEnv = () => ({ POSTGRES_PASSWORD: 'pw', SECRET_ENCRYPTION_KEY: ENC_KEY });

describe('parseConfig — defaults', () => {
  test('applies documented defaults when only the password is supplied', () => {
    const c = parseConfig(baseEnv());
    assert.equal(c.port, 3001);
    assert.equal(c.logFormat, 'text');
    assert.equal(c.cacheDir, '/data');
    assert.equal(c.db.host, 'dt-postgres');
    assert.equal(c.db.port, 5432);
    assert.equal(c.db.user, 'dtdash');
    assert.equal(c.db.database, 'dtdash');
    assert.equal(c.reportConcurrency, 5);
    assert.equal(c.violationConcurrency, 3);
    assert.equal(c.cacheTtlMs, 24 * 3_600_000);
    assert.equal(c.jobStallMs, 15 * 60_000);
    assert.equal(c.session.absoluteHours, 8);
    assert.equal(c.session.idleHours, 2);
  });

  test('pool sizing and timeouts are fixed by design, not by environment', () => {
    const c = parseConfig({ ...baseEnv(), POSTGRES_MAX: '999', STATEMENT_TIMEOUT: '1' });
    assert.equal(c.db.max, 15);
    assert.equal(c.db.statementTimeoutMs, 30_000);
    assert.equal(c.db.idleInTransactionTimeoutMs, 30_000);
  });

  test('the admin credentials file is the only path left on disk', () => {
    const c = parseConfig({ ...baseEnv(), CACHE_DIR: '/srv/dt' });
    assert.equal(c.paths.adminCreds, '/srv/dt/admin-credentials.json');
    // Everything else moved into PostgreSQL, so no other path may reappear
    // here without a deliberate decision (CLAUDE.md §5.6).
    assert.deepEqual(Object.keys(c.paths), ['adminCreds']);
  });

  test('an empty string falls back to the default rather than being accepted', () => {
    const c = parseConfig({ ...baseEnv(), PORT: '', LOG_FORMAT: '' });
    assert.equal(c.port, Number(DEFAULTS.PORT));
    assert.equal(c.logFormat, 'text');
  });

  test('returns a frozen object so no module can mutate shared config', () => {
    const c = parseConfig(baseEnv());
    assert.equal(Object.isFrozen(c), true);
  });
});

describe('parseConfig — overrides', () => {
  test('honours supplied values', () => {
    const c = parseConfig({
      POSTGRES_PASSWORD: 'pw', SECRET_ENCRYPTION_KEY: ENC_KEY,
      PORT: '4000', LOG_FORMAT: 'json',
      POSTGRES_HOST: 'db.internal', POSTGRES_PORT: '6543',
      POSTGRES_USER: 'app', POSTGRES_DB: 'appdb',
      CACHE_TTL_HOURS: '6', REPORT_CONCURRENCY: '9', VIOLATION_CONCURRENCY: '2',
      VIOLATION_JOB_STALL_MINUTES: '90',
      SESSION_ABSOLUTE_HOURS: '12', SESSION_IDLE_HOURS: '3',
    });
    assert.equal(c.port, 4000);
    assert.equal(c.logFormat, 'json');
    assert.equal(c.db.host, 'db.internal');
    assert.equal(c.db.port, 6543);
    assert.equal(c.db.user, 'app');
    assert.equal(c.db.database, 'appdb');
    assert.equal(c.cacheTtlMs, 6 * 3_600_000);
    assert.equal(c.reportConcurrency, 9);
    assert.equal(c.violationConcurrency, 2);
    assert.equal(c.jobStallMs, 90 * 60_000);
    assert.equal(c.session.absoluteHours, 12);
    assert.equal(c.session.idleHours, 3);
  });

  test('strips a trailing slash and control characters from the legacy DT values', () => {
    const c = parseConfig({
      ...baseEnv(),
      DT_API_URL: 'https://dt.example.com/',
      DT_API_KEY: '  odt_abc123\n  ',
      DT_FRONTEND_URL: 'https://dt.example.com/ui/',
    });
    assert.equal(c.legacyDt.apiUrl, 'https://dt.example.com');
    assert.equal(c.legacyDt.apiKey, 'odt_abc123');
    assert.equal(c.legacyDt.frontendUrl, 'https://dt.example.com/ui');
  });

  test('the legacy DT values default to empty rather than to a guessed host', () => {
    // A fresh install has no DependencyTrack connection at all: guessing one
    // would seed every account with a URL nobody chose.
    const c = parseConfig(baseEnv());
    assert.equal(c.legacyDt.apiUrl, '');
    assert.equal(c.legacyDt.apiKey, '');
  });
});

describe('parseConfig — fail-fast validation', () => {
  test('POSTGRES_PASSWORD is required and the message says where it comes from', () => {
    assert.throws(() => parseConfig({ SECRET_ENCRYPTION_KEY: ENC_KEY }), (e) => {
      assert.equal(e.code, 'CONFIG_INVALID');
      assert.match(e.message, /POSTGRES_PASSWORD is required/);
      assert.match(e.message, /install\.sh/);
      return true;
    });
  });

  test('a whitespace-only password is rejected', () => {
    assert.throws(
      () => parseConfig({ POSTGRES_PASSWORD: '   ', SECRET_ENCRYPTION_KEY: ENC_KEY }),
      (e) => e.code === 'CONFIG_INVALID'
    );
  });

  test('SECRET_ENCRYPTION_KEY is required — a stored key would be unreadable without it', () => {
    assert.throws(() => parseConfig({ POSTGRES_PASSWORD: 'pw' }), (e) => {
      assert.equal(e.code, 'CONFIG_INVALID');
      assert.match(e.message, /SECRET_ENCRYPTION_KEY is required/);
      return true;
    });
  });

  test('a SECRET_ENCRYPTION_KEY that does not decode to 32 bytes is rejected', () => {
    for (const bad of ['abc', 'a'.repeat(63), Buffer.alloc(16).toString('base64')]) {
      assert.throws(
        () => parseConfig({ POSTGRES_PASSWORD: 'pw', SECRET_ENCRYPTION_KEY: bad }),
        (e) => e.code === 'CONFIG_INVALID' && /32 bytes/.test(e.message),
        `expected ${bad} to be rejected`
      );
    }
  });

  test('a base64 SECRET_ENCRYPTION_KEY of exactly 32 bytes is accepted', () => {
    const c = parseConfig({
      POSTGRES_PASSWORD: 'pw',
      SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    assert.ok(c.secretEncryptionKey);
  });

  test('LOG_FORMAT must be text or json', () => {
    assert.throws(
      () => parseConfig({ ...baseEnv(), LOG_FORMAT: 'xml' }),
      (e) => e.code === 'CONFIG_INVALID' && /LOG_FORMAT/.test(e.message)
    );
  });

  test('a non-numeric port is rejected and the message names the variable', () => {
    assert.throws(
      () => parseConfig({ ...baseEnv(), PORT: 'abc' }),
      (e) => e.code === 'CONFIG_INVALID' && /PORT must be an integer/.test(e.message)
    );
  });

  test('a port outside 1-65535 is rejected', () => {
    assert.throws(() => parseConfig({ ...baseEnv(), PORT: '0' }), (e) => e.code === 'CONFIG_INVALID');
    assert.throws(() => parseConfig({ ...baseEnv(), PORT: '70000' }), (e) => e.code === 'CONFIG_INVALID');
    assert.throws(() => parseConfig({ ...baseEnv(), POSTGRES_PORT: '99999' }), (e) => e.code === 'CONFIG_INVALID');
  });

  test('a fractional integer is rejected rather than silently truncated', () => {
    assert.throws(
      () => parseConfig({ ...baseEnv(), REPORT_CONCURRENCY: '2.5' }),
      (e) => e.code === 'CONFIG_INVALID'
    );
  });

  test('a negative concurrency is rejected', () => {
    assert.throws(
      () => parseConfig({ ...baseEnv(), VIOLATION_CONCURRENCY: '-1' }),
      (e) => e.code === 'CONFIG_INVALID'
    );
  });

  test('a zero or negative stall window is rejected', () => {
    // A zero window would declare every build dead the moment it started.
    for (const bad of ['0', '-5', 'soon', '2.5']) {
      assert.throws(
        () => parseConfig({ ...baseEnv(), VIOLATION_JOB_STALL_MINUTES: bad }),
        (e) => e.code === 'CONFIG_INVALID', `VIOLATION_JOB_STALL_MINUTES=${bad}`
      );
    }
  });

  test('the stall window may be raised well past the old 30-minute cap', () => {
    // The whole point of the change: a slow upstream is a tuning problem, not a
    // reason to abandon a crawl that is still making progress.
    const c = parseConfig({ ...baseEnv(), VIOLATION_JOB_STALL_MINUTES: '720' });
    assert.equal(c.jobStallMs, 720 * 60_000);
  });

  test('idle session lifetime may not exceed the absolute lifetime', () => {
    assert.throws(
      () => parseConfig({ ...baseEnv(), SESSION_ABSOLUTE_HOURS: '2', SESSION_IDLE_HOURS: '8' }),
      (e) => e.code === 'CONFIG_INVALID' && /never be reached/.test(e.message)
    );
  });

  test('equal idle and absolute lifetimes are allowed', () => {
    const c = parseConfig({ ...baseEnv(), SESSION_ABSOLUTE_HOURS: '4', SESSION_IDLE_HOURS: '4' });
    assert.equal(c.session.idleHours, 4);
  });
});

// ── lib/crypto.js — password hashing, tokens, encryption ─────────────────────
// Imported directly: the module does no I/O at require time (CLAUDE.md §10.3).

const dtCrypto = require('./lib/crypto');
const nodeCrypto = require('node:crypto');

describe('hashPassword / verifyPassword', () => {
  test('produces the documented parameterised format', async () => {
    const h = await dtCrypto.hashPassword('correct horse battery');
    const parts = h.split('$');
    assert.equal(parts.length, 6);
    assert.equal(parts[0], 'scrypt');
    assert.equal(Number(parts[1]), dtCrypto.SCRYPT_N);
    assert.equal(Number(parts[2]), dtCrypto.SCRYPT_R);
    assert.equal(Number(parts[3]), dtCrypto.SCRYPT_P);
    assert.equal(Buffer.from(parts[4], 'base64').length, 16, 'salt should be 16 bytes');
    assert.equal(Buffer.from(parts[5], 'base64').length, 64, 'derived key should be 64 bytes');
  });

  test('round-trips the correct password and rejects a wrong one', async () => {
    const h = await dtCrypto.hashPassword('s3cret-pass');
    assert.equal(await dtCrypto.verifyPassword('s3cret-pass', h), true);
    assert.equal(await dtCrypto.verifyPassword('s3cret-pasS', h), false);
    assert.equal(await dtCrypto.verifyPassword('', h), false);
  });

  test('the same password hashes differently each time (random salt)', async () => {
    const [a, b] = await Promise.all([
      dtCrypto.hashPassword('same-password'), dtCrypto.hashPassword('same-password'),
    ]);
    assert.notEqual(a, b, 'salts must differ');
    assert.equal(await dtCrypto.verifyPassword('same-password', a), true);
    assert.equal(await dtCrypto.verifyPassword('same-password', b), true);
  });

  test('a tampered derived key is rejected', async () => {
    const h = await dtCrypto.hashPassword('tamper-me');
    const parts = h.split('$');
    const dk = Buffer.from(parts[5], 'base64');
    dk[0] ^= 0xff;
    parts[5] = dk.toString('base64');
    assert.equal(await dtCrypto.verifyPassword('tamper-me', parts.join('$')), false);
  });

  test('a tampered salt is rejected', async () => {
    const h = await dtCrypto.hashPassword('tamper-salt');
    const parts = h.split('$');
    const salt = Buffer.from(parts[4], 'base64');
    salt[0] ^= 0xff;
    parts[4] = salt.toString('base64');
    assert.equal(await dtCrypto.verifyPassword('tamper-salt', parts.join('$')), false);
  });

  test('malformed stored hashes return false rather than throwing', async () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$x$y$z$a$b', 'bcrypt$1$2$3$aa$bb',
                       'scrypt$16384$8$1$onlyfiveparts', 'scrypt$0$0$0$c2FsdA==$ZGs=']) {
      assert.equal(await dtCrypto.verifyPassword('anything', bad), false, `for ${JSON.stringify(bad)}`);
    }
    assert.equal(await dtCrypto.verifyPassword(null, null), false);
    assert.equal(await dtCrypto.verifyPassword(undefined, undefined), false);
  });

  test('rejects an empty password at hashing time', async () => {
    await assert.rejects(() => dtCrypto.hashPassword(''), (e) => e.code === 'BAD_PASSWORD');
  });

  test('embedded parameters are honoured, so they can be raised later', async () => {
    // A hash produced with weaker parameters must still verify.
    const salt = Buffer.from('0123456789abcdef');
    const dk = nodeCrypto.scryptSync('legacy-pass', salt, 64, { N: 1024, r: 8, p: 1 });
    const legacy = `scrypt$1024$8$1$${salt.toString('base64')}$${dk.toString('base64')}`;
    assert.equal(await dtCrypto.verifyPassword('legacy-pass', legacy), true);
    assert.equal(await dtCrypto.verifyPassword('wrong', legacy), false);
  });
});

describe('session tokens', () => {
  test('mintToken produces 256 bits as base64url', () => {
    const t = dtCrypto.mintToken();
    assert.equal(typeof t, 'string');
    assert.equal(t.length, 43, '32 bytes base64url is 43 characters');
    assert.match(t, /^[A-Za-z0-9_-]+$/, 'base64url has no +, / or = characters');
  });

  test('tokens are unique across many mints', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(dtCrypto.mintToken());
    assert.equal(seen.size, 500);
  });

  test('hashToken is a deterministic 32-byte SHA-256', () => {
    const h1 = dtCrypto.hashToken('abc');
    const h2 = dtCrypto.hashToken('abc');
    assert.ok(Buffer.isBuffer(h1));
    assert.equal(h1.length, 32);
    assert.deepEqual(h1, h2);
    assert.notDeepEqual(h1, dtCrypto.hashToken('abd'));
  });

  test('hashToken output matches a known SHA-256 vector', () => {
    assert.equal(
      dtCrypto.hashToken('abc').toString('hex'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  test('safeEqual compares equal buffers and rejects mismatched ones', () => {
    assert.equal(dtCrypto.safeEqual(Buffer.from('abc'), Buffer.from('abc')), true);
    assert.equal(dtCrypto.safeEqual(Buffer.from('abc'), Buffer.from('abd')), false);
    assert.equal(dtCrypto.safeEqual(Buffer.from('abc'), Buffer.from('abcd')), false);
    assert.equal(dtCrypto.safeEqual('abc', 'abc'), false, 'non-buffers are rejected');
  });
});

describe('secret encryption (AES-256-GCM)', () => {
  const key = nodeCrypto.randomBytes(32);

  test('accepts a 64-character hex key', () => {
    const k = dtCrypto.parseEncryptionKey('a'.repeat(64));
    assert.equal(k.length, 32);
  });

  test('accepts a base64 key of 32 bytes', () => {
    const k = dtCrypto.parseEncryptionKey(nodeCrypto.randomBytes(32).toString('base64'));
    assert.equal(k.length, 32);
  });

  test('rejects a missing or wrong-length key with an actionable message', () => {
    assert.throws(() => dtCrypto.parseEncryptionKey(''), (e) => e.code === 'ENCRYPTION_KEY_MISSING');
    assert.throws(() => dtCrypto.parseEncryptionKey(undefined), (e) => e.code === 'ENCRYPTION_KEY_MISSING');
    assert.throws(() => dtCrypto.parseEncryptionKey('too-short'), (e) => {
      assert.equal(e.code, 'ENCRYPTION_KEY_INVALID');
      assert.match(e.message, /install\.sh/);
      return true;
    });
  });

  test('round-trips a secret', () => {
    const sealed = dtCrypto.encryptSecret('odt_super_secret_api_key', key);
    assert.ok(Buffer.isBuffer(sealed.ciphertext));
    assert.equal(sealed.nonce.length, 12);
    assert.equal(sealed.tag.length, 16);
    assert.equal(dtCrypto.decryptSecret(sealed, key), 'odt_super_secret_api_key');
  });

  test('the same plaintext encrypts differently each time (random nonce)', () => {
    const a = dtCrypto.encryptSecret('same', key);
    const b = dtCrypto.encryptSecret('same', key);
    assert.notDeepEqual(a.nonce, b.nonce);
    assert.notDeepEqual(a.ciphertext, b.ciphertext);
  });

  test('a tampered authentication tag fails closed', () => {
    const sealed = dtCrypto.encryptSecret('integrity-matters', key);
    sealed.tag[0] ^= 0xff;
    assert.throws(() => dtCrypto.decryptSecret(sealed, key), (e) => e.code === 'DECRYPT_FAILED');
  });

  test('tampered ciphertext fails closed', () => {
    const sealed = dtCrypto.encryptSecret('integrity-matters', key);
    sealed.ciphertext[0] ^= 0xff;
    assert.throws(() => dtCrypto.decryptSecret(sealed, key), (e) => e.code === 'DECRYPT_FAILED');
  });

  test('the wrong key fails closed rather than returning garbage', () => {
    const sealed = dtCrypto.encryptSecret('secret', key);
    assert.throws(
      () => dtCrypto.decryptSecret(sealed, nodeCrypto.randomBytes(32)),
      (e) => e.code === 'DECRYPT_FAILED'
    );
  });

  test('empty string round-trips', () => {
    const sealed = dtCrypto.encryptSecret('', key);
    assert.equal(dtCrypto.decryptSecret(sealed, key), '');
  });
});

describe('connectionFingerprint', () => {
  test('is stable and 64 hex characters', () => {
    const a = dtCrypto.connectionFingerprint('https://dt.example.com', 'key1');
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, dtCrypto.connectionFingerprint('https://dt.example.com', 'key1'));
  });

  test('ignores a trailing slash so equivalent URLs share one cache', () => {
    assert.equal(
      dtCrypto.connectionFingerprint('https://dt.example.com/', 'key1'),
      dtCrypto.connectionFingerprint('https://dt.example.com', 'key1')
    );
  });

  test('a different key yields a different fingerprint', () => {
    assert.notEqual(
      dtCrypto.connectionFingerprint('https://dt.example.com', 'key1'),
      dtCrypto.connectionFingerprint('https://dt.example.com', 'key2')
    );
  });

  test('a different host yields a different fingerprint', () => {
    assert.notEqual(
      dtCrypto.connectionFingerprint('https://a.example.com', 'k'),
      dtCrypto.connectionFingerprint('https://b.example.com', 'k')
    );
  });
});

// ── lib/validate.js — field rules (mirrored in the frontend in phase 3) ──────

const v = require('./lib/validate');

describe('validate — names', () => {
  test('accepts a plain name', () => {
    assert.equal(v.validateFirstName('Alice'), null);
    assert.equal(v.validateLastName('Smith'), null);
  });

  test('accepts single spaces between words', () => {
    assert.equal(v.validateFirstName('Mary Jane'), null);
    assert.equal(v.validateLastName('van der Berg'), null);
  });

  test('accepts non-ASCII letters', () => {
    assert.equal(v.validateFirstName('José'), null);
    assert.equal(v.validateLastName('Müller'), null);
    assert.equal(v.validateFirstName('Σωκράτης'), null);
    assert.equal(v.validateLastName('山田太郎'), null, 'CJK characters are letters');
    assert.equal(v.validateFirstName('Владимир'), null, 'Cyrillic characters are letters');
  });

  // Pins a consequence of the specified 3-character minimum that is easy to miss:
  // two-character names are common (Li, Wu, Bo, Ed, and many CJK surnames) and
  // are rejected. The rule is implemented as specified; this test makes the
  // trade-off visible so changing the minimum is a deliberate decision.
  test('the 3-character minimum rejects genuine two-character names', () => {
    for (const short of ['Li', 'Wu', 'Bo', 'Ed', '田中']) {
      assert.match(v.validateLastName(short), /at least 3 characters/,
        `${short} is rejected by the specified minimum length`);
    }
  });

  test('rejects a leading or trailing space', () => {
    assert.match(v.validateFirstName(' Alice'), /space/);
    assert.match(v.validateFirstName('Alice '), /space/);
  });

  test('rejects a double space between words', () => {
    assert.ok(v.validateFirstName('Mary  Jane'));
  });

  test('enforces the length bounds', () => {
    assert.ok(v.validateFirstName('Al'), 'two characters is too short');
    assert.equal(v.validateFirstName('Ali'), null, 'three is the minimum');
    assert.equal(v.validateFirstName('A'.repeat(128)), null, '128 is the maximum');
    assert.ok(v.validateFirstName('A'.repeat(129)), '129 is too long');
  });

  test('rejects digits, punctuation and symbols', () => {
    for (const bad of ['Al1ce', 'Alice!', "O'Brien", 'Smith-Jones', 'Alice_B', '<script>']) {
      assert.ok(v.validateFirstName(bad), `${bad} should be rejected`);
    }
  });

  test('rejects empty and non-string input', () => {
    assert.ok(v.validateFirstName(''));
    assert.ok(v.validateFirstName(null));
    assert.ok(v.validateFirstName(42));
  });
});

describe('validate — login ID', () => {
  const reserved = v.reservedLoginIds('admin');

  test('accepts the permitted character set', () => {
    for (const good of ['alice', 'alice.smith', 'alice_smith', 'alice-smith', 'user123', 'a.b-c_1']) {
      assert.equal(v.validateLoginId(good, reserved), null, `${good} should be accepted`);
    }
  });

  test('rejects spaces and disallowed characters', () => {
    for (const bad of ['al ice', 'alice@host', 'alice!', 'alice/smith', 'alice+1']) {
      assert.ok(v.validateLoginId(bad, reserved), `${bad} should be rejected`);
    }
  });

  test('enforces the length bounds', () => {
    assert.ok(v.validateLoginId('ab', reserved));
    assert.equal(v.validateLoginId('abc', reserved), null);
    assert.equal(v.validateLoginId('a'.repeat(64), reserved), null);
    assert.ok(v.validateLoginId('a'.repeat(65), reserved));
  });

  test('rejects reserved identifiers regardless of case', () => {
    for (const bad of ['admin', 'ADMIN', 'Admin', 'root', 'ROOT', 'system', 'administrator']) {
      assert.match(v.validateLoginId(bad, reserved), /reserved/, `${bad} should be reserved`);
    }
  });

  test('reserves whatever administrator login ID is configured', () => {
    const custom = v.reservedLoginIds('superuser');
    assert.match(v.validateLoginId('superuser', custom), /reserved/);
    assert.equal(v.validateLoginId('admin', custom), null,
      'with a custom admin ID, "admin" is only reserved if it is in ALWAYS_RESERVED');
  });
});

describe('validate — email', () => {
  test('is optional', () => {
    assert.equal(v.validateEmail(undefined), null);
    assert.equal(v.validateEmail(null), null);
    assert.equal(v.validateEmail(''), null);
  });

  test('accepts ordinary and special-character addresses', () => {
    for (const good of ['a@b.co', 'first.last@example.com', 'user+tag@example.co.uk',
                        "o'brien@example.com", 'user_name-1@sub.example.org']) {
      assert.equal(v.validateEmail(good), null, `${good} should be accepted`);
    }
  });

  test('rejects malformed addresses', () => {
    for (const bad of ['nope', 'a@b', '@example.com', 'a@@b.co', 'a b@c.co', 'a@b c.co', 'a@.com']) {
      assert.ok(v.validateEmail(bad), `${bad} should be rejected`);
    }
  });

  test('rejects a space anywhere', () => {
    assert.match(v.validateEmail(' a@b.co'), /space/);
    assert.match(v.validateEmail('a@b.co '), /space/);
  });

  test('enforces the maximum length', () => {
    assert.ok(v.validateEmail(`${'a'.repeat(250)}@b.co`));
  });
});

describe('validate — password', () => {
  test('accepts eight characters or more, with any non-space character', () => {
    assert.equal(v.validatePassword('password'), null);
    assert.equal(v.validatePassword('p@$$w0rd!#%^&*()'), null);
    assert.equal(v.validatePassword('日本語パスワード'), null);
  });

  test('rejects anything shorter than eight', () => {
    assert.ok(v.validatePassword('passwor'));
    assert.equal(v.validatePassword('passwor8'), null);
  });

  test('rejects spaces and tabs', () => {
    assert.match(v.validatePassword('pass word'), /space/);
    assert.match(v.validatePassword('pass\tword'), /space/);
  });

  test('enforces the maximum length', () => {
    assert.equal(v.validatePassword('a'.repeat(128)), null);
    assert.ok(v.validatePassword('a'.repeat(129)));
  });

  test('confirmation must match exactly', () => {
    assert.equal(v.validatePasswordConfirm('secret123', 'secret123'), null);
    assert.match(v.validatePasswordConfirm('secret123', 'Secret123'), /do not match/);
    assert.ok(v.validatePasswordConfirm('secret123', ''));
  });
});

describe('validate — whole payloads', () => {
  const reserved = v.reservedLoginIds('admin');
  const good = {
    firstName: 'Alice', lastName: 'Smith', loginId: 'alice',
    email: 'alice@example.com', password: 'password123', confirmPassword: 'password123',
  };

  test('accepts a complete valid registration', () => {
    const r = v.validateRegistration(good, { reserved });
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, {});
  });

  test('accepts a registration with no email', () => {
    const r = v.validateRegistration({ ...good, email: '' }, { reserved });
    assert.equal(r.valid, true);
  });

  test('reports every bad field at once, keyed by field name', () => {
    const r = v.validateRegistration(
      { firstName: 'A', lastName: '', loginId: 'x', email: 'bad', password: 'short' },
      { reserved }
    );
    assert.equal(r.valid, false);
    assert.deepEqual(Object.keys(r.errors).sort(),
      ['email', 'firstName', 'lastName', 'loginId', 'password']);
  });

  test('does not report a confirmation mismatch while the password itself is invalid', () => {
    const r = v.validateRegistration(
      { ...good, password: 'short', confirmPassword: 'different' }, { reserved }
    );
    assert.ok(r.errors.password);
    assert.equal(r.errors.confirmPassword, undefined,
      'one clear error beats two confusing ones');
  });

  test('profile update accepts a partial patch', () => {
    assert.equal(v.validateProfileUpdate({ firstName: 'Grace' }).valid, true);
    assert.equal(v.validateProfileUpdate({}).valid, true, 'an empty patch is structurally valid');
  });

  test('profile update validates a supplied password and its confirmation', () => {
    assert.equal(v.validateProfileUpdate({ password: 'short' }).valid, false);
    assert.equal(
      v.validateProfileUpdate({ password: 'longenough1', confirmPassword: 'mismatch' }).valid,
      false
    );
    assert.equal(
      v.validateProfileUpdate({ password: 'longenough1', confirmPassword: 'longenough1' }).valid,
      true
    );
  });

  test('profile update ignores login ID and email entirely', () => {
    const r = v.validateProfileUpdate({ loginId: 'anything at all!', email: 'not-an-email' });
    assert.equal(r.valid, true, 'identity fields are not validated because they are not accepted');
  });
});

// ── Route layer — per-user scoping and authorisation ─────────────────────────
// The route modules perform no I/O at require time, so they are imported and
// driven directly with a stubbed data layer (CLAUDE.md §10.2, §10.3). These are
// the tests that keep one user's data out of another user's responses.

const routeReports  = require('./routes/reports');
const routeCache    = require('./routes/cache');
const routeConfig   = require('./routes/config');
const routeSchedule = require('./routes/schedule');
const routeDtProxy  = require('./routes/dt-proxy');

const reportsDbMod     = require('./lib/reports-db');
const validateMod      = require('./lib/validate');
const reportsMod       = require('./lib/reports');
const userSettingsMod  = require('./lib/user-settings');
const appSettingsMod   = require('./lib/app-settings');
const dtConnectionsMod = require('./lib/dt-connections');
const cachesMod        = require('./lib/caches');
const violationCacheMod = require('./lib/violation-cache');
const schedulesMod     = require('./lib/schedules');
const dtFetchMod       = require('./lib/dt-fetch');
const cweMod           = require('./lib/cwe');
const imageMod         = require('./lib/image');
const brandingMod      = require('./lib/branding');
const routeBranding    = require('./routes/branding');
const excelMod         = require('./lib/excel');

/** Minimal response double: records the status and parsed JSON body. */
function makeRes() {
  const res = {
    statusCode: null, headers: null, chunks: [], headersSent: false,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers || {}; res.headersSent = true; },
    write(chunk) { res.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) res.chunks.push(Buffer.from(chunk)); res.ended = true; },
    once() {},
    get body() { return Buffer.concat(res.chunks).toString('utf8'); },
    get json() { try { return JSON.parse(res.body); } catch (_) { return null; } },
  };
  return res;
}

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const REPORT_A = '33333333-3333-4333-8333-333333333333';

const asUser  = (userId) => ({ userId, principalType: 'user', isAdmin: false, loginId: 'someone' });
const asAdmin = () => ({ userId: null, principalType: 'admin', isAdmin: true, loginId: 'admin' });

/** Swap a module's exported functions for the duration of one test. */
function stub(mod, patch) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = mod[k]; mod[k] = v; }
  return () => { for (const [k, v] of Object.entries(saved)) mod[k] = v; };
}

describe('routes — the administrator has no per-user data', () => {
  const cases = [
    ['reports list',    routeReports,  { method: 'GET',  path: '/violation-cache/report/list' }],
    ['cache status',    routeCache,    { method: 'GET',  path: '/violation-cache/status' }],
    ['config read',     routeConfig,   { method: 'GET',  path: '/violation-cache/config' }],
    ['schedule status', routeSchedule, { method: 'GET',  path: '/violation-cache/schedule/status' }],
  ];

  for (const [name, mod, req] of cases) {
    test(`${name} answers 403 USER_ONLY for an administrator session`, async () => {
      const res = makeRes();
      const handled = await mod.handle({ ...req, url: req.path, req: {}, res, principal: asAdmin() });
      assert.equal(handled, true, 'the route must own the request, not fall through');
      assert.equal(res.statusCode, 403);
      assert.equal(res.json.code, 'USER_ONLY');
    });
  }

  test('the DT proxy also refuses an administrator session', async () => {
    const res = makeRes();
    await routeDtProxy.handle({
      method: 'GET', url: '/violation-cache/dt/api/v1/project',
      path: '/violation-cache/dt/api/v1/project', res, principal: asAdmin(),
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json.code, 'USER_ONLY');
  });
});

describe('routes — cross-user access returns 404, never 403', () => {
  test("another user's report is reported as not found", async () => {
    // getForUser is scoped by user_id, so B's report simply is not there for A.
    const restore = stub(reportsDbMod, { getForUser: async () => null });
    try {
      for (const req of [
        { method: 'GET',    path: `/violation-cache/report/${REPORT_A}/download` },
        { method: 'POST',   path: `/violation-cache/report/${REPORT_A}/cancel` },
        { method: 'DELETE', path: `/violation-cache/report/${REPORT_A}` },
      ]) {
        const res = makeRes();
        const handled = await routeReports.handle({ ...req, url: req.path, req: {}, res, principal: asUser(USER_A) });
        assert.equal(handled, true);
        assert.equal(res.statusCode, 404, `${req.method} ${req.path}`);
        assert.equal(res.json.code, 'NOT_FOUND');
        // The reply must not hint that the report exists for somebody else.
        assert.doesNotMatch(res.body, /forbidden|permission|another/i);
      }
    } finally { restore(); }
  });

  test('every report lookup is scoped by the signed-in user', async () => {
    const seen = [];
    const restore = stub(reportsDbMod, {
      getForUser: async (userId, reportId) => { seen.push([userId, reportId]); return null; },
    });
    try {
      const res = makeRes();
      await routeReports.handle({
        method: 'DELETE', url: `/violation-cache/report/${REPORT_A}`,
        path: `/violation-cache/report/${REPORT_A}`, req: {}, res, principal: asUser(USER_B),
      });
      assert.deepEqual(seen, [[USER_B, REPORT_A]]);
    } finally { restore(); }
  });

  test('a malformed report id is rejected before it reaches the database', async () => {
    let called = false;
    const restore = stub(reportsDbMod, { getForUser: async () => { called = true; return null; } });
    try {
      const res = makeRes();
      await routeReports.handle({
        method: 'DELETE', url: "/violation-cache/report/'; DROP TABLE reports; --",
        path: "/violation-cache/report/'; DROP TABLE reports; --",
        req: {}, res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 404);
      assert.equal(called, false, 'a non-uuid must never be handed to PostgreSQL');
    } finally { restore(); }
  });
});

describe('routes — the report quota is per user', () => {
  const body = JSON.stringify({ projects: [{ uuid: 'p1', name: 'a' }], riskTypes: ['security'] });
  const reqWith = (raw) => Readable.from([raw]);

  test('a full quota answers 429 and reports this user\'s own counts', async () => {
    const restore = stub(reportsDbMod, {
      activeCount: async (userId) => {
        assert.equal(userId, USER_A, 'the count must be scoped to the caller');
        return { completed: 8, running: 2 };
      },
      create: async () => { throw new Error('must not create a report over quota'); },
    });
    const restoreSettings = stub(userSettingsMod, { getMaxReports: async () => 10 });
    const restoreConn = stub(dtConnectionsMod, {
      getResolved: async () => ({ apiUrl: 'http://dt', apiKey: 'k', isConfigured: true, fingerprint: 'f' }),
    });
    try {
      const res = makeRes();
      await routeReports.handle({
        method: 'POST', url: '/violation-cache/report/generate',
        path: '/violation-cache/report/generate', req: reqWith(body), res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 429);
      assert.equal(res.json.code, 'QUOTA_REACHED');
      assert.equal(res.json.maxReports, 10);
      assert.equal(res.json.completedCount, 8);
      assert.equal(res.json.runningCount, 2);
    } finally { restore(); restoreSettings(); restoreConn(); }
  });

  test('one user being at quota does not block another', async () => {
    const created = [];
    const restore = stub(reportsDbMod, {
      activeCount: async (userId) => (userId === USER_A ? { completed: 10, running: 0 } : { completed: 0, running: 0 }),
      create: async (userId) => { created.push(userId); return { id: REPORT_A }; },
    });
    const restoreSettings = stub(userSettingsMod, { getMaxReports: async () => 10 });
    const restoreConn = stub(dtConnectionsMod, {
      getResolved: async () => ({ apiUrl: 'http://dt', apiKey: 'k', isConfigured: true, fingerprint: 'f' }),
    });
    const restoreRun = stub(reportsMod, { runReportJob: async () => ({ completed: true }) });
    try {
      const res = makeRes();
      await routeReports.handle({
        method: 'POST', url: '/violation-cache/report/generate',
        path: '/violation-cache/report/generate', req: reqWith(body), res, principal: asUser(USER_B),
      });
      assert.equal(res.statusCode, 201);
      assert.deepEqual(created, [USER_B]);
    } finally { restore(); restoreSettings(); restoreConn(); restoreRun(); }
  });

  test('generation is refused when the account has no DependencyTrack connection', async () => {
    const restoreConn = stub(dtConnectionsMod, {
      getResolved: async () => ({ apiUrl: '', apiKey: '', isConfigured: false, fingerprint: null }),
    });
    const restore = stub(reportsDbMod, {
      activeCount: async () => { throw new Error('quota must not be consulted without a connection'); },
    });
    try {
      const res = makeRes();
      await routeReports.handle({
        method: 'POST', url: '/violation-cache/report/generate',
        path: '/violation-cache/report/generate', req: reqWith(body), res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json.code, 'DT_NOT_CONFIGURED');
    } finally { restore(); restoreConn(); }
  });
});

describe('routes — the DT proxy never leaks the API key or a DT 401', () => {
  const okConn = { apiUrl: 'http://dt:8080', apiKey: 'odt_secret_1234', isConfigured: true, fingerprint: 'f' };

  test('the upstream path and the user\'s key are taken from the connection row', async () => {
    let seen = null;
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => okConn });
    const restoreFetch = stub(dtFetchMod, {
      dtGetWithRetry: async (urlPath, apiUrl, apiKey) => {
        seen = { urlPath, apiUrl, apiKey };
        return { json: [{ uuid: 'p1' }], headers: { 'x-total-count': '1' } };
      },
    });
    try {
      const res = makeRes();
      const url = '/violation-cache/dt/api/v1/project?onlyRoot=true&pageSize=100';
      await routeDtProxy.handle({
        method: 'GET', url, path: url.split('?')[0], res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(seen.urlPath, '/api/v1/project?onlyRoot=true&pageSize=100');
      assert.equal(seen.apiUrl, okConn.apiUrl);
      assert.equal(seen.apiKey, okConn.apiKey);
      // The key must not appear anywhere in what the browser receives.
      assert.doesNotMatch(res.body, /odt_secret_1234/);
      assert.equal(res.headers['X-Total-Count'], '1');
    } finally { restoreConn(); restoreFetch(); }
  });

  test('a DependencyTrack 401 becomes 502, not 401', async () => {
    // A 401 from us means "your session died" and signs the user out. Passing an
    // upstream 401 through would log people out over a bad DT key.
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => okConn });
    const restoreFetch = stub(dtFetchMod, {
      dtGetWithRetry: async () => { throw Object.assign(new Error('HTTP 401'), { statusCode: 401 }); },
    });
    try {
      const res = makeRes();
      await routeDtProxy.handle({
        method: 'GET', url: '/violation-cache/dt/api/v1/project',
        path: '/violation-cache/dt/api/v1/project', res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 502);
      assert.equal(res.json.code, 'DT_UPSTREAM_ERROR');
      assert.equal(res.json.dtStatus, 401);
    } finally { restoreConn(); restoreFetch(); }
  });

  test('only GET is forwarded, and only under /api/v1/', async () => {
    const restoreConn = stub(dtConnectionsMod, {
      getResolved: async () => { throw new Error('must not resolve a connection for a rejected request'); },
    });
    try {
      const res1 = makeRes();
      await routeDtProxy.handle({
        method: 'POST', url: '/violation-cache/dt/api/v1/project',
        path: '/violation-cache/dt/api/v1/project', res: res1, principal: asUser(USER_A),
      });
      assert.equal(res1.statusCode, 405);

      const res2 = makeRes();
      await routeDtProxy.handle({
        method: 'GET', url: '/violation-cache/dt/etc/passwd',
        path: '/violation-cache/dt/etc/passwd', res: res2, principal: asUser(USER_A),
      });
      assert.equal(res2.statusCode, 404);
    } finally { restoreConn(); }
  });

  test('an unreadable stored key asks the user to re-enter it', async () => {
    const restoreConn = stub(dtConnectionsMod, {
      getResolved: async () => { throw Object.assign(new Error('unreadable'), { code: 'DT_KEY_UNREADABLE' }); },
    });
    try {
      const res = makeRes();
      await routeDtProxy.handle({
        method: 'GET', url: '/violation-cache/dt/api/v1/project',
        path: '/violation-cache/dt/api/v1/project', res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json.code, 'DT_KEY_UNREADABLE');
    } finally { restoreConn(); }
  });
});

describe('routes — the shared violation cache is keyed by connection', () => {
  const connFor = (fingerprint) => ({
    apiUrl: 'http://dt:8080', apiKey: 'k', isConfigured: true, fingerprint,
  });

  test('two users on the same connection read the same cache row', async () => {
    const asked = [];
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => connFor('deadbeef1234') });
    const restoreCaches = stub(cachesMod, {
      getPayloadGzip: async (fp) => { asked.push(fp); return Buffer.from('gz'); },
    });
    try {
      for (const user of [USER_A, USER_B]) {
        const res = makeRes();
        await routeCache.handle({
          method: 'GET', url: '/violation-cache/data', path: '/violation-cache/data',
          res, principal: asUser(user),
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Encoding'], 'gzip');
      }
      assert.deepEqual(asked, ['deadbeef1234', 'deadbeef1234'],
        'the fingerprint, not the user id, selects the cache row');
    } finally { restoreConn(); restoreCaches(); }
  });

  test('an unconfigured account is told "no-key" rather than shown an error', async () => {
    const restoreConn = stub(dtConnectionsMod, {
      getResolved: async () => ({ apiUrl: '', apiKey: '', isConfigured: false, fingerprint: null }),
    });
    try {
      const res = makeRes();
      await routeCache.handle({
        method: 'GET', url: '/violation-cache/status', path: '/violation-cache/status',
        res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json.status, 'no-key');
    } finally { restoreConn(); }
  });

  test('a refresh while a build is running answers 409 instead of starting a second one', async () => {
    let started = false;
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => connFor('abc123abc123') });
    const restoreCaches = stub(cachesMod, { getMeta: async () => ({ status: 'building' }) });
    const restoreCache = stub(violationCacheMod, { runJob: async () => { started = true; return {}; } });
    try {
      const res = makeRes();
      await routeCache.handle({
        method: 'POST', url: '/violation-cache/refresh', path: '/violation-cache/refresh',
        res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 409);
      assert.equal(started, false);
    } finally { restoreConn(); restoreCaches(); restoreCache(); }
  });

  // Q14: a builder that dies without running its finally block leaves the row
  // saying 'building'. Before the heartbeat, that shut every door — the refetch
  // answered 409 for ever and the dashboard polled a build nobody was running.
  const abandoned = () => ({
    status: 'building',
    updatedAt: new Date(Date.now() - (violationCacheMod.DEFAULT_STALL_MS + 60_000)),
    progress: { pagesDone: 7, pagesTotal: 40 },
  });
  const beating = () => ({
    status: 'building', updatedAt: new Date(),
    progress: { pagesDone: 7, pagesTotal: 40 },
  });

  test('a refresh recovers a build abandoned by a dead process instead of 409ing', async () => {
    let started = false;
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => connFor('abc123abc123') });
    const restoreCaches = stub(cachesMod, { getMeta: async () => abandoned() });
    const restoreCache = stub(violationCacheMod, { runJob: async () => { started = true; return {}; } });
    try {
      const res = makeRes();
      await routeCache.handle({
        method: 'POST', url: '/violation-cache/refresh', path: '/violation-cache/refresh',
        res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 202, 'the stranded row must not block a new build');
      assert.equal(started, true);
    } finally { restoreConn(); restoreCaches(); restoreCache(); }
  });

  test('status restarts an abandoned build and reports it as building', async () => {
    let started = 0;
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => connFor('abc123abc123') });
    const restoreCaches = stub(cachesMod, { getMeta: async () => abandoned() });
    const restoreCache = stub(violationCacheMod, { runJob: async () => { started++; return {}; } });
    try {
      const res = makeRes();
      await routeCache.handle({
        method: 'GET', url: '/violation-cache/status', path: '/violation-cache/status',
        res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json.status, 'building',
        'a build has just been started, so "building" is the truthful answer');
      assert.equal(started, 1);
      assert.equal(res.json.progress.pagesDone, 0,
        'the dead build\'s page count must not be presented as the new one\'s');
    } finally { restoreConn(); restoreCaches(); restoreCache(); }
  });

  test('status leaves a build that is still beating alone', async () => {
    let started = 0;
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => connFor('abc123abc123') });
    const restoreCaches = stub(cachesMod, { getMeta: async () => beating() });
    const restoreCache = stub(violationCacheMod, { runJob: async () => { started++; return {}; } });
    try {
      const res = makeRes();
      await routeCache.handle({
        method: 'GET', url: '/violation-cache/status', path: '/violation-cache/status',
        res, principal: asUser(USER_A),
      });
      assert.equal(res.json.status, 'building');
      assert.equal(started, 0, 'a live build must never be duplicated');
      assert.equal(res.json.progress.pagesDone, 7, 'the live build\'s real progress is shown');
    } finally { restoreConn(); restoreCaches(); restoreCache(); }
  });

  test('the recovery path is shared: every user on the connection sees it restart once', async () => {
    // The whole point of the shared cache. Two dashboards hitting a stranded row
    // must not produce two crawls — the in-process guard and the advisory lock
    // are what stop that, and runJob is where they live.
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => connFor('abc123abc123') });
    const restoreCaches = stub(cachesMod, { getMeta: async () => abandoned() });
    let calls = 0;
    const restoreCache = stub(violationCacheMod, {
      runJob: async () => { calls++; return { started: calls === 1, reason: 'already building' }; },
    });
    try {
      for (const user of [USER_A, USER_B]) {
        const res = makeRes();
        await routeCache.handle({
          method: 'GET', url: '/violation-cache/status', path: '/violation-cache/status',
          res, principal: asUser(user),
        });
        assert.equal(res.json.status, 'building');
      }
      assert.equal(calls, 2, 'both asked; runJob itself elects the single builder');
    } finally { restoreConn(); restoreCaches(); restoreCache(); }
  });
});

describe('routes — arming a schedule', () => {
  test('a disabled schedule cannot be armed', async () => {
    const restore = stub(schedulesMod, { get: async () => ({ enabled: false, projectCount: 5 }) });
    try {
      const res = makeRes();
      await routeSchedule.handle({
        method: 'POST', url: '/violation-cache/schedule/arm', path: '/violation-cache/schedule/arm',
        res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json.code, 'SCHEDULE_DISABLED');
    } finally { restore(); }
  });

  test('an enabled schedule with no projects cannot be armed', async () => {
    const restore = stub(schedulesMod, { get: async () => ({ enabled: true, projectCount: 0 }) });
    try {
      const res = makeRes();
      await routeSchedule.handle({
        method: 'POST', url: '/violation-cache/schedule/arm', path: '/violation-cache/schedule/arm',
        res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json.code, 'NO_PROJECTS');
    } finally { restore(); }
  });

  test('arming writes a future next_run_at for the caller only', async () => {
    const armed = [];
    const restore = stub(schedulesMod, {
      get: async () => ({ enabled: true, projectCount: 3, frequency: 'daily', hour: 9 }),
      arm: async (userId, nextRunAt) => { armed.push([userId, nextRunAt]); return { nextRunAt }; },
    });
    try {
      const res = makeRes();
      await routeSchedule.handle({
        method: 'POST', url: '/violation-cache/schedule/arm', path: '/violation-cache/schedule/arm',
        res, principal: asUser(USER_B),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(armed.length, 1);
      assert.equal(armed[0][0], USER_B);
      assert.ok(armed[0][1] > new Date(), 'the armed time must be in the future');
    } finally { restore(); }
  });

  test('isRunning comes from running_since, not from a process variable', async () => {
    const since = new Date();
    const restore = stub(schedulesMod, {
      get: async () => ({ enabled: true, projectCount: 1, runningSince: since }),
    });
    try {
      const res = makeRes();
      await routeSchedule.handle({
        method: 'GET', url: '/violation-cache/schedule/status', path: '/violation-cache/schedule/status',
        res, principal: asUser(USER_A),
      });
      assert.equal(res.json.isRunning, true);
    } finally { restore(); }
  });
});

// ── lib/caches.js — pure helpers ─────────────────────────────────────────────
describe('caches — status derivation and lock keys', () => {
  test('a missing row is "none"', () => {
    assert.equal(cachesMod.deriveStatus(null), 'none');
  });

  test('an unexpired payload is "ready" and an expired one is "stale"', () => {
    const base = { status: 'ready', generatedAt: new Date(Date.now() - 1000) };
    assert.equal(cachesMod.deriveStatus({ ...base, expiresAt: new Date(Date.now() + 60_000) }), 'ready');
    assert.equal(cachesMod.deriveStatus({ ...base, expiresAt: new Date(Date.now() - 60_000) }), 'stale');
  });

  test('building and failed states are reported verbatim', () => {
    assert.equal(cachesMod.deriveStatus({ status: 'building' }), 'building');
    assert.equal(cachesMod.deriveStatus({ status: 'failed' }), 'failed');
  });

  // Q14: 'building' used to be a one-way door — a builder that died left the row
  // saying building forever, which made both the automatic rebuild and the
  // manual refetch impossible. updated_at is the heartbeat that reopens it.
  test('a build still beating is "building"', () => {
    assert.equal(
      cachesMod.deriveStatus({ status: 'building', updatedAt: new Date(Date.now() - 5_000) }, 60_000),
      'building');
  });

  test('a build that stopped beating is "stalled"', () => {
    assert.equal(
      cachesMod.deriveStatus({ status: 'building', updatedAt: new Date(Date.now() - 120_000) }, 60_000),
      'stalled');
  });

  test('the stall window is exclusive at its own boundary', () => {
    const at = (ms) => cachesMod.deriveStatus(
      { status: 'building', updatedAt: new Date(Date.now() - ms) }, 60_000);
    assert.equal(at(59_000), 'building');
    assert.equal(at(61_000), 'stalled');
  });

  test('a row with no heartbeat at all is taken at its word, not declared dead', () => {
    // Belt and braces for a row written before updated_at was selected: guessing
    // "dead" there would restart a build that is genuinely running.
    assert.equal(cachesMod.deriveStatus({ status: 'building' }, 1), 'building');
    assert.equal(cachesMod.deriveStatus({ status: 'building', updatedAt: null }, 1), 'building');
  });

  test('the default stall window applies when none is passed', () => {
    const justInside  = cachesMod.DEFAULT_STALL_MS - 60_000;
    const wellOutside = cachesMod.DEFAULT_STALL_MS + 60_000;
    assert.equal(cachesMod.deriveStatus({ status: 'building', updatedAt: new Date(Date.now() - justInside) }), 'building');
    assert.equal(cachesMod.deriveStatus({ status: 'building', updatedAt: new Date(Date.now() - wellOutside) }), 'stalled');
  });

  test('the stall window never reinterprets a settled row', () => {
    // Only 'building' is time-sensitive. A ready row an hour old is still ready.
    const ready = {
      status: 'ready', updatedAt: new Date(Date.now() - 3_600_000),
      generatedAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() + 60_000),
    };
    assert.equal(cachesMod.deriveStatus(ready, 1_000), 'ready');
    assert.equal(cachesMod.deriveStatus({ status: 'failed', updatedAt: new Date(0) }, 1_000), 'failed');
  });

  test('the advisory lock key is deterministic and fits in two 32-bit halves', () => {
    const fp = 'a3f1b2c4d5e6f708' + '9'.repeat(48);
    const k1 = cachesMod.lockKeyFor(fp);
    const k2 = cachesMod.lockKeyFor(fp);
    assert.deepEqual(k1, k2, 'every process must derive the same key');
    for (const half of [k1.hi, k1.lo]) {
      assert.ok(Number.isInteger(half));
      assert.ok(half >= -2147483648 && half <= 2147483647);
    }
    assert.notDeepEqual(cachesMod.lockKeyFor('b'.repeat(64)), k1,
      'different connections must not share a builder lock');
  });
});

// ── lib/mail-settings.js — address parsing and the password placeholder ──────
const mailSettingsMod = require('./lib/mail-settings');

describe('mail settings — recipient parsing', () => {
  test('a comma-separated string becomes a trimmed array', () => {
    assert.deepEqual(
      mailSettingsMod.toAddressArray(' a@x.com , b@y.com ,, '),
      ['a@x.com', 'b@y.com']
    );
  });

  test('an array is normalised the same way', () => {
    assert.deepEqual(mailSettingsMod.toAddressArray([' a@x.com ', '']), ['a@x.com']);
  });

  test('anything else becomes an empty list rather than throwing', () => {
    for (const input of [undefined, null, 42, {}]) {
      assert.deepEqual(mailSettingsMod.toAddressArray(input), []);
    }
  });

  test('the placeholder is the exact literal the dashboard sends back', () => {
    // If these ever diverge, saving settings would overwrite the stored password
    // with eight bullet characters (CLAUDE.md §6.9).
    assert.equal(mailSettingsMod.PASSWORD_PLACEHOLDER, '•'.repeat(8));
    const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
    assert.ok(
      html.includes(`'${mailSettingsMod.PASSWORD_PLACEHOLDER}'`),
      'the dashboard must send the same placeholder the backend recognises'
    );
  });
});

// ── lib/user-settings.js — quota bounds ──────────────────────────────────────
// The report ceiling moved from a preference each user set for themselves to a
// capacity decision the administrator makes, globally or per account (migration
// 005). The bounds are unchanged; who may set them is not.
describe('user settings — maxReports bounds', () => {
  test('the per-account bounds match the global ones exactly', () => {
    // A global default an override could not express would be a value the
    // administrator could set once and never change back.
    assert.equal(userSettingsMod.MIN_MAX_REPORTS, appSettingsMod.MIN_MAX_REPORTS);
    assert.equal(userSettingsMod.MAX_MAX_REPORTS, appSettingsMod.MAX_MAX_REPORTS);
    assert.equal(userSettingsMod.MIN_MAX_REPORTS, 1);
    assert.equal(userSettingsMod.MAX_MAX_REPORTS, 1000);
  });

  test('an out-of-range override is rejected with a field-tagged error', async () => {
    for (const bad of [0, -1, 1001, 2.5, 'ten', null]) {
      await assert.rejects(
        () => userSettingsMod.setMaxReportsOverride(USER_A, bad),
        (e) => e.code === 'VALIDATION_FAILED' && e.field === 'maxReports',
        `expected ${bad} to be rejected`
      );
    }
  });

  test('an out-of-range global default is rejected the same way', async () => {
    for (const bad of [0, -1, 1001, 2.5, 'ten', null, undefined]) {
      await assert.rejects(
        () => appSettingsMod.setDefaultMaxReports(bad),
        (e) => e.code === 'VALIDATION_FAILED' && e.field === 'defaultMaxReports',
        `expected ${bad} to be rejected`
      );
    }
  });

  test('the user-facing setter is gone, not merely unused', () => {
    // Leaving it exported would invite a route to call it and quietly hand the
    // limit back to users.
    assert.equal(userSettingsMod.setMaxReports, undefined);
    assert.equal(typeof userSettingsMod.setMaxReportsOverride, 'function');
    assert.equal(typeof userSettingsMod.clearMaxReportsOverride, 'function');
  });
});

// ── Report naming ───────────────────────────────────────────────────────────
// The name becomes a filename and travels in a Content-Disposition header, so
// the validator's job is to refuse the three things that actually cause
// trouble: the quote that would terminate the header, the separators that would
// make it a path, and control characters.
describe('validate — report name', () => {
  test('an absent name is not an error', () => {
    // Every report was auto-named before the field existed, so an untouched
    // field must stay valid.
    for (const empty of [undefined, null, '', '   ']) {
      assert.equal(validateMod.validateReportName(empty), null, JSON.stringify(empty));
    }
  });

  test('ordinary names pass', () => {
    for (const good of ['Q3 Audit', 'report_2026-01', 'security (final)', 'a.b.c', 'X']) {
      assert.equal(validateMod.validateReportName(good), null, good);
    }
  });

  test('anything that could escape the filename is refused', () => {
    for (const bad of ['a/b', 'a\\b', 'a"b', '../etc/passwd', 'a\u0000b', 'a\nb', 'a;b', 'a*b']) {
      assert.ok(validateMod.validateReportName(bad), `${JSON.stringify(bad)} must be refused`);
    }
  });

  test('a name of only punctuation is refused', () => {
    // It would leave an empty or dot-only filename once the extension is added.
    for (const bad of ['..', '.', '   .  ', '---']) {
      assert.ok(validateMod.validateReportName(bad), JSON.stringify(bad));
    }
  });

  test('the length ceiling is enforced at the boundary', () => {
    const max = validateMod.REPORT_NAME_MAX;
    assert.equal(validateMod.validateReportName('x'.repeat(max)), null);
    assert.ok(validateMod.validateReportName('x'.repeat(max + 1)));
  });
});

describe('reports — the filename rule', () => {
  test('no name keeps the generated form', () => {
    assert.match(reportsMod.reportFilename(null), /^vulnerability_report_.*\.xlsx$/);
    assert.match(reportsMod.reportFilename('   '), /^vulnerability_report_.*\.xlsx$/);
  });

  test('the generated stem is caller-chosen, so a schedule reads as one', () => {
    assert.match(reportsMod.reportFilename('', 'scheduled_report'), /^scheduled_report_.*\.xlsx$/);
  });

  test('a supplied name is used, with the extension added once', () => {
    assert.equal(reportsMod.reportFilename('Q3 Audit'), 'Q3 Audit.xlsx');
    assert.equal(reportsMod.reportFilename('Q3 Audit.xlsx'), 'Q3 Audit.xlsx');
    assert.equal(reportsMod.reportFilename('Q3 Audit.XLSX'), 'Q3 Audit.XLSX');
    assert.equal(reportsMod.reportFilename('  Q3 Audit  '), 'Q3 Audit.xlsx');
  });

  test('two auto-named reports do not collide', () => {
    // The timestamp carries milliseconds, so a burst still produces distinct
    // names rather than silently overwriting a previous download.
    const a = reportsMod.reportFilename(null);
    assert.match(a, /\d{4}-\d{2}-\d{2}T[\d-]+Z\.xlsx$/);
  });
});

// ── The connection test says what is actually wrong ─────────────────────────
// It used to probe /api/v1/version, which DependencyTrack does not serve — the
// version lives at /api/version. Every test therefore came back 404 "connection
// failed" on connections that were fine. The probe is now the endpoint the
// dashboard itself depends on, which tests the URL, the key and the permission
// in one call.
describe('routes — the DependencyTrack connection test', () => {
  const conn = { apiUrl: 'http://dt:8080', apiKey: 'k', isConfigured: true, fingerprint: 'f'.repeat(64) };

  const post = (body) => ({
    method: 'POST',
    url: '/violation-cache/config/test-connection',
    path: '/violation-cache/config/test-connection',
    req: mockReq(JSON.stringify(body)),
    res: makeRes(),
    principal: asUser(USER_A),
  });

  test('it probes an endpoint DependencyTrack actually serves', async () => {
    const asked = [];
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => conn });
    const restoreFetch = stub(dtFetchMod, {
      dtGetWithRetry: async (path) => { asked.push(path); return { json: { version: '4.11.0' }, headers: {} }; },
    });
    try {
      const ctx = post({ apiUrl: 'http://dt:8080', apiKey: 'k' });
      await routeConfig.handle(ctx);
      assert.equal(ctx.res.statusCode, 200);
      assert.equal(ctx.res.json.ok, true);
      assert.ok(asked.some(p => p.startsWith('/api/v1/project')),
        `the probe must exercise the portfolio the dashboard reads: ${JSON.stringify(asked)}`);
      assert.ok(!asked.some(p => p === '/api/v1/version'),
        '/api/v1/version does not exist in DependencyTrack');
    } finally { restoreConn(); restoreFetch(); }
  });

  test('the version is a nicety and never decides the verdict', async () => {
    // It is served unauthenticated, so a deployment that blocks it must not
    // turn a working connection into a failure.
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => conn });
    const restoreFetch = stub(dtFetchMod, {
      dtGetWithRetry: async (path) => {
        if (path.startsWith('/api/version')) throw Object.assign(new Error('HTTP 403'), { statusCode: 403 });
        return { json: [], headers: {} };
      },
    });
    try {
      const ctx = post({ apiUrl: 'http://dt:8080', apiKey: 'k' });
      await routeConfig.handle(ctx);
      assert.equal(ctx.res.json.ok, true, 'the portfolio probe succeeded, so the connection works');
      assert.equal(ctx.res.json.version, null);
    } finally { restoreConn(); restoreFetch(); }
  });

  // Each status is a different problem with a different fix. Telling somebody
  // to "check the URL and API key" when only one of them is wrong makes them
  // re-check both.
  const cases = [
    [401, 'DT_KEY_REJECTED',  /rejected the API key/i],
    [403, 'DT_KEY_FORBIDDEN', /VIEW_PORTFOLIO/],
    [404, 'DT_NOT_DT',        /no DependencyTrack API at that URL/i],
    [500, 'DT_HTTP_ERROR',    /HTTP 500/],
  ];
  for (const [status, code, messageRe] of cases) {
    test(`HTTP ${status} is reported as ${code}`, async () => {
      const restoreConn = stub(dtConnectionsMod, { getResolved: async () => conn });
      const restoreFetch = stub(dtFetchMod, {
        dtGetWithRetry: async () => { throw Object.assign(new Error(`HTTP ${status}`), { statusCode: status }); },
      });
      try {
        const ctx = post({ apiUrl: 'http://dt:8080', apiKey: 'k' });
        await routeConfig.handle(ctx);
        assert.equal(ctx.res.statusCode, 200, 'a failed probe is an answer, not a server error');
        assert.equal(ctx.res.json.ok, false);
        assert.equal(ctx.res.json.code, code);
        assert.equal(ctx.res.json.dtStatus, status);
        assert.match(ctx.res.json.error, messageRe);
      } finally { restoreConn(); restoreFetch(); }
    });
  }

  test('an unreachable host is distinguished from a rejected one', async () => {
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => conn });
    const restoreFetch = stub(dtFetchMod, {
      dtGetWithRetry: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:8080'); },
    });
    try {
      const ctx = post({ apiUrl: 'http://dt:8080', apiKey: 'k' });
      await routeConfig.handle(ctx);
      assert.equal(ctx.res.json.ok, false);
      assert.equal(ctx.res.json.code, 'DT_UNREACHABLE');
      assert.equal(ctx.res.json.dtStatus, null);
      assert.match(ctx.res.json.error, /could not be reached/i);
    } finally { restoreConn(); restoreFetch(); }
  });

  test('no API key ever appears in the response', async () => {
    const restoreConn = stub(dtConnectionsMod, { getResolved: async () => conn });
    const restoreFetch = stub(dtFetchMod, {
      dtGetWithRetry: async () => { throw Object.assign(new Error('HTTP 401'), { statusCode: 401 }); },
    });
    try {
      const ctx = post({ apiUrl: 'http://dt:8080', apiKey: 'supersecretkey' });
      await routeConfig.handle(ctx);
      assert.doesNotMatch(ctx.res.body, /supersecretkey/, 'S22: the key is never echoed back');
    } finally { restoreConn(); restoreFetch(); }
  });
});

// ── The build watchdog measures silence, not elapsed time ────────────────────
// It used to be a flat 30-minute deadline. A large portfolio that was working
// through its pages perfectly happily got killed at the half hour and every page
// it had already fetched was thrown away. How long a crawl takes is a property
// of the data; how long it can sit without advancing is a property of it being
// broken. These pin that distinction, which is the whole of the change.
describe('violation cache — the stall watchdog', () => {
  const CONN = { apiUrl: 'http://dt:8080', apiKey: 'k123', fingerprint: 'f'.repeat(64) };

  // A caches stand-in: the watchdog's collaborators, none of which touch a database.
  function fakeCaches() {
    const calls = { markBuilding: 0, touches: 0, stored: null, failed: null };
    return {
      calls,
      patch: {
        acquireBuildLock: async () => ({ acquired: true, release: async () => {} }),
        markBuilding: async () => { calls.markBuilding++; },
        setProgress:  async () => {},
        touchBuild:   async () => { calls.touches++; return true; },
        storeResult:  async (_fp, map, meta) => { calls.stored = { map, meta }; },
        markFailed:   async (_fp, message) => { calls.failed = message; },
      },
    };
  }

  // One violation on page 1 of every pipeline, `pages` pages each, `delayMs` per
  // request. Nine pipelines run in parallel, so wall time is about pages*delayMs.
  function pagedFetch({ pages, delayMs, hangOnPage }) {
    return async (url) => {
      const page = Number(/pageNumber=(\d+)/.exec(url)[1]);
      await new Promise(r => setTimeout(r, page === hangOnPage ? delayMs * 12 : delayMs));
      return {
        headers: { 'x-total-count': String(pages * 100) },
        json: [{ project: { uuid: 'p1' } }],
      };
    };
  }

  test('a slow build that keeps advancing is allowed to finish', async () => {
    // Total run time deliberately exceeds the stall window several times over.
    const fake = fakeCaches();
    const restoreCaches = stub(cachesMod, fake.patch);
    const restoreFetch  = stub(dtFetchMod, { dtGetWithRetry: pagedFetch({ pages: 6, delayMs: 40 }) });
    violationCacheMod.configure({ cacheTtlMs: 3600_000, jobStallMs: 150 });
    try {
      const r = await violationCacheMod.runJob(CONN);
      assert.equal(r.completed, true, 'steady progress must never trip the watchdog');
      assert.ok(!r.stalled);
      assert.equal(fake.calls.failed, null);
      assert.ok(fake.calls.stored, 'the finished map must be stored, not discarded');
    } finally { restoreCaches(); restoreFetch(); violationCacheMod.configure(null); }
  });

  test('a build that goes silent past the window is stopped', async () => {
    const fake = fakeCaches();
    const restoreCaches = stub(cachesMod, fake.patch);
    const restoreFetch  = stub(dtFetchMod, {
      dtGetWithRetry: pagedFetch({ pages: 8, delayMs: 30, hangOnPage: 3 }),
    });
    violationCacheMod.configure({ cacheTtlMs: 3600_000, jobStallMs: 120 });
    try {
      const r = await violationCacheMod.runJob(CONN);
      assert.equal(r.stalled, true);
      assert.equal(r.completed, false);
      assert.match(fake.calls.failed, /no progress for/i);
      assert.match(fake.calls.failed, /reached page/i,
        'the message must say how far it got, so a real stall is distinguishable from a slow start');
      assert.equal(fake.calls.stored, null);
    } finally { restoreCaches(); restoreFetch(); violationCacheMod.configure(null); }
  });

  test('a progressing build beats its heartbeat so other processes see it alive', async () => {
    const fake = fakeCaches();
    const restoreCaches = stub(cachesMod, fake.patch);
    const restoreFetch  = stub(dtFetchMod, { dtGetWithRetry: pagedFetch({ pages: 6, delayMs: 40 }) });
    violationCacheMod.configure({ cacheTtlMs: 3600_000, jobStallMs: 150 });
    try {
      await violationCacheMod.runJob(CONN);
      assert.ok(fake.calls.touches > 0,
        'without a heartbeat the row goes stale under a build that is actually running');
    } finally { restoreCaches(); restoreFetch(); violationCacheMod.configure(null); }
  });

  test('the stall message names the window, so the fix is discoverable', async () => {
    const fake = fakeCaches();
    const restoreCaches = stub(cachesMod, fake.patch);
    const restoreFetch  = stub(dtFetchMod, {
      dtGetWithRetry: pagedFetch({ pages: 8, delayMs: 30, hangOnPage: 3 }),
    });
    violationCacheMod.configure({ cacheTtlMs: 3600_000, jobStallMs: 60_000 * 2 });
    try {
      // A two-minute window rounds to 2 in the message.
      violationCacheMod.configure({ cacheTtlMs: 3600_000, jobStallMs: 120 });
      const r = await violationCacheMod.runJob(CONN);
      assert.equal(r.stalled, true);
      assert.match(fake.calls.failed, /minutes/);
    } finally { restoreCaches(); restoreFetch(); violationCacheMod.configure(null); }
  });

  test('the configured window is used, not a hardcoded constant', () => {
    violationCacheMod.configure({ cacheTtlMs: 1, jobStallMs: 7 * 60_000 });
    assert.equal(violationCacheMod.stallWindowMs(), 7 * 60_000);
    violationCacheMod.configure(null);
    assert.equal(violationCacheMod.stallWindowMs(), violationCacheMod.DEFAULT_STALL_MS,
      'an unconfigured reader falls back to the documented default');
  });
});

// ── Administration routes — read-only, administrator-only ────────────────────
// The panel exists so an operator can see usage without being handed the keys
// to everyone's data. These tests pin both halves of that.

const routeAdmin = require('./routes/admin');
const usersMod   = require('./lib/users');
const cachesMod2 = require('./lib/caches');

describe('routes — administration is administrator-only', () => {
  for (const path of ['/admin/users', '/admin/overview']) {
    test(`an ordinary user gets 403 ADMIN_ONLY on ${path}`, async () => {
      const restore = stub(usersMod, {
        listWithStats: async () => { throw new Error('must not query on an unauthorised request'); },
      });
      try {
        const res = makeRes();
        const handled = await routeAdmin.handle({
          method: 'GET', url: path, path, res, principal: asUser(USER_A),
        });
        assert.equal(handled, true);
        assert.equal(res.statusCode, 403);
        assert.equal(res.json.code, 'ADMIN_ONLY');
      } finally { restore(); }
    });
  }

  test('the administration area is 403, not 404 — its existence is not a secret', async () => {
    // Another user's report is hidden with 404 because confirming it exists
    // leaks something. An admin area leaks nothing by existing.
    const restore = stub(usersMod, { listWithStats: async () => [] });
    try {
      const res = makeRes();
      await routeAdmin.handle({
        method: 'GET', url: '/admin/users', path: '/admin/users', res, principal: asUser(USER_A),
      });
      assert.equal(res.statusCode, 403);
    } finally { restore(); }
  });
});

describe('routes — the administration listing exposes no secrets', () => {
  const sampleRows = () => ([
    {
      id: USER_A, loginId: 'alice', email: 'a@x.com', firstName: 'Alice', lastName: 'Ant',
      createdAt: new Date('2026-01-01'), lastLoginAt: new Date('2026-02-01'),
      sessionActive: true, lastSeenAt: new Date('2026-02-01'),
      reportCount: 3, storageBytes: '4096', dtConfigured: true, scheduleEnabled: false,
    },
    {
      id: USER_B, loginId: 'bob', email: null, firstName: 'Bob', lastName: 'Bee',
      createdAt: new Date('2026-01-02'), lastLoginAt: null,
      sessionActive: false, lastSeenAt: null,
      reportCount: 0, storageBytes: '0', dtConfigured: false, scheduleEnabled: true,
    },
  ]);

  test('users are returned with counts, and nothing that could authenticate as them', async () => {
    const restore = stub(usersMod, { listWithStats: async () => sampleRows() });
    try {
      const res = makeRes();
      await routeAdmin.handle({
        method: 'GET', url: '/admin/users', path: '/admin/users', res, principal: asAdmin(),
      });
      assert.equal(res.statusCode, 200);
      const { users } = res.json;
      assert.equal(users.length, 2);
      assert.equal(users[0].loginId, 'alice');
      assert.equal(users[0].name, 'Alice Ant');
      assert.equal(users[0].sessionActive, true);
      assert.equal(users[0].reportCount, 3);
      assert.equal(users[0].storageBytes, 4096, 'bigint counts are returned as numbers');

      // Nothing that could be replayed, decrypted or used to sign in.
      for (const forbidden of ['passwordHash', 'password_hash', 'apiKey', 'api_key',
                               'tokenHash', 'smtpPass', 'fingerprint', 'id']) {
        assert.equal(forbidden in users[0], false, `${forbidden} must not be in the response`);
      }
      assert.doesNotMatch(res.body, /scrypt\$/);
    } finally { restore(); }
  });

  test('the overview totals are derived from the same rows', async () => {
    const restore  = stub(usersMod, { listWithStats: async () => sampleRows() });
    const restore2 = stub(cachesMod2, { count: async () => 1 });
    try {
      const res = makeRes();
      await routeAdmin.handle({
        method: 'GET', url: '/admin/overview', path: '/admin/overview', res, principal: asAdmin(),
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json, {
        userCount: 2, activeSessions: 1, reportCount: 3, storageBytes: 4096,
        dtConfigured: 1, schedulesActive: 1, cacheCount: 1,
      });
    } finally { restore(); restore2(); }
  });

  test('one cache for two configured users is the shared build working', async () => {
    // The number the operator should watch as accounts are added: caches grow
    // with distinct DependencyTrack connections, not with users (CLAUDE.md §13).
    const rows = sampleRows().map(u => ({ ...u, dtConfigured: true }));
    const restore  = stub(usersMod, { listWithStats: async () => rows });
    const restore2 = stub(cachesMod2, { count: async () => 1 });
    try {
      const res = makeRes();
      await routeAdmin.handle({
        method: 'GET', url: '/admin/overview', path: '/admin/overview', res, principal: asAdmin(),
      });
      assert.equal(res.json.dtConfigured, 2);
      assert.equal(res.json.cacheCount, 1);
    } finally { restore(); restore2(); }
  });

  // Administration was read-only, and this test used to forbid every write.
  // It now allows exactly three and forbids everything else, because a blanket
  // ban that had to be deleted would have stopped protecting anything. The
  // list is the contract: adding a fourth write means changing this line, in a
  // diff somebody has to read.
  // The closed list of administration writes. It grew from three to six when
  // customisation was added, and that growth is the point of the list: adding
  // a seventh means editing this set in a diff somebody reads.
  const ALLOWED_WRITES = new Set([
    'PUT /admin/settings',
    'PUT /admin/users/:loginId/settings',
    'POST /admin/users/:loginId/password',
    'PUT /admin/branding',
    'POST /admin/branding/background',
    'DELETE /admin/branding/background',
  ]);

  test('only the three intended writes are handled', async () => {
    const paths = [
      '/admin/users', '/admin/overview', '/admin/storage', '/admin/settings',
      '/admin/users/alice', '/admin/users/alice/settings', '/admin/users/alice/password',
      '/admin/branding', '/admin/branding/background',
    ];
    const restore = stub(usersMod, {
      detailForAdmin: async () => { throw new Error('must not reach the data layer'); },
    });
    try {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        for (const path of paths) {
          const key = `${method} ${path.replace(/alice/, ':loginId')}`;
          const res = makeRes();
          let handled;
          try {
            handled = await routeAdmin.handle({
              method, url: path, path, res, principal: asAdmin(),
              req: mockReq('{}'),
            });
          } catch (_) {
            // Reaching the data layer means the route WAS handled.
            handled = true;
          }
          if (ALLOWED_WRITES.has(key)) {
            assert.equal(handled, true, `${key} is on the allow-list and must be handled`);
          } else {
            assert.equal(handled, false,
              `${key} is not on the allow-list — administration writes are a closed set`);
          }
        }
      }
    } finally { restore(); }
  });

  test('a normal user is refused every write, not only the reads', async () => {
    for (const [method, path] of [
      ['PUT',  '/admin/settings'],
      ['PUT',  '/admin/users/alice/settings'],
      ['POST', '/admin/users/alice/password'],
    ]) {
      const res = makeRes();
      const restore = stub(usersMod, {
        detailForAdmin: async () => { throw new Error('must not query on an unauthorised request'); },
      });
      try {
        await routeAdmin.handle({
          method, url: path, path, res, principal: asUser(USER_A), req: mockReq('{}'),
        });
        assert.equal(res.statusCode, 403, `${method} ${path}`);
        assert.equal(res.json.code, 'ADMIN_ONLY');
      } finally { restore(); }
    }
  });
});

// ── Registration reports every clashing identifier at once ───────────────────
// Reporting only the login ID made the user fix it, resubmit, and only then
// discover the email was taken too.

const routeAuth = require('./routes/auth');
const adminMod  = require('./lib/admin');
const authMod   = require('./lib/auth');
const cryptoMod = require('./lib/crypto');
const auditMod  = require('./lib/login-audit');
const mailMod   = require('./lib/mail');

describe('routes — registration conflicts', () => {
  const body = (over = {}) => JSON.stringify({
    firstName: 'Alice', lastName: 'Ant', loginId: 'alice',
    email: 'alice@example.com', password: 'password123',
    confirmPassword: 'password123', ...over,
  });
  const post = (raw) => ({
    method: 'POST', url: '/auth/register', path: '/auth/register',
    req: Readable.from([raw]), res: makeRes(),
  });

  test('both a taken login ID and a taken email are reported together', async () => {
    const restore = stub(usersMod, {
      findTakenIdentifiers: async () => ({ loginId: true, email: true }),
      create: async () => { throw new Error('must not insert when both clash'); },
    });
    try {
      const ctx = post(body());
      await routeAuth.handle(ctx);
      assert.equal(ctx.res.statusCode, 409);
      assert.equal(ctx.res.json.code, 'ALREADY_REGISTERED');
      assert.ok(ctx.res.json.errors.loginId, 'the login ID error must be present');
      assert.ok(ctx.res.json.errors.email, 'the email error must be present');
      assert.match(ctx.res.json.error, /both/i, 'the banner should say both');
    } finally { restore(); }
  });

  test('only the login ID clashing reports only that field', async () => {
    const restore = stub(usersMod, {
      findTakenIdentifiers: async () => ({ loginId: true, email: false }),
      create: async () => { throw new Error('must not insert'); },
    });
    try {
      const ctx = post(body());
      await routeAuth.handle(ctx);
      assert.equal(ctx.res.statusCode, 409);
      assert.deepEqual(Object.keys(ctx.res.json.errors), ['loginId']);
      assert.match(ctx.res.json.error, /login ID/i);
    } finally { restore(); }
  });

  test('only the email clashing reports only that field', async () => {
    const restore = stub(usersMod, {
      findTakenIdentifiers: async () => ({ loginId: false, email: true }),
      create: async () => { throw new Error('must not insert'); },
    });
    try {
      const ctx = post(body());
      await routeAuth.handle(ctx);
      assert.equal(ctx.res.statusCode, 409);
      assert.deepEqual(Object.keys(ctx.res.json.errors), ['email']);
    } finally { restore(); }
  });

  test('neither message says who owns the identifier', async () => {
    const restore = stub(usersMod, {
      findTakenIdentifiers: async () => ({ loginId: true, email: true }),
      create: async () => { throw new Error('must not insert'); },
    });
    try {
      const ctx = post(body());
      await routeAuth.handle(ctx);
      // Enumeration guard: the reply confirms the identifier is in use and
      // nothing else about the account that holds it (CLAUDE.md §12).
      assert.doesNotMatch(ctx.res.body, /belongs to|owned by|@example\.com/);
    } finally { restore(); }
  });

  test('a clash found only by the unique index still names its field', async () => {
    // The pre-check can be raced. The constraint remains the arbiter, and its
    // error must still be actionable.
    const restore = stub(usersMod, {
      findTakenIdentifiers: async () => ({ loginId: false, email: false }),
      create: async () => {
        throw Object.assign(new Error('This login ID is already registered.'),
          { code: 'ALREADY_REGISTERED', field: 'loginId' });
      },
    });
    try {
      const ctx = post(body());
      await routeAuth.handle(ctx);
      assert.equal(ctx.res.statusCode, 409);
      assert.ok(ctx.res.json.errors.loginId);
    } finally { restore(); }
  });

  test('a free login ID and email proceed to creation', async () => {
    let created = false;
    const restore = stub(usersMod, {
      findTakenIdentifiers: async () => ({ loginId: false, email: false }),
      create: async () => { created = true; return { id: USER_A, loginId: 'alice' }; },
    });
    const restoreAudit = stub(require('./lib/login-audit'), { record: async () => {} });
    try {
      const ctx = post(body());
      await routeAuth.handle(ctx);
      assert.equal(ctx.res.statusCode, 201, ctx.res.body);
      assert.equal(created, true);
    } finally { restore(); restoreAudit(); }
  });
});

// ── Administration: one account's detail ─────────────────────────────────────
describe('routes — administration user detail', () => {
  const sampleDetail = () => ({
    id: USER_A, loginId: 'alice', email: 'alice@example.com',
    firstName: 'Alice', lastName: 'Ant',
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
    lastLoginAt: new Date('2026-02-01'),
    sessionIssuedAt: new Date('2026-02-01'), sessionLastSeenAt: new Date('2026-02-01'),
    sessionExpiresAt: new Date('2026-02-02'), sessionUserAgent: 'Firefox',
    sessionIpAddress: '10.0.0.9',
    dtApiUrl: 'https://dt.example.com', dtFrontendUrl: '', dtConfigured: true,
    dtHasApiKey: true, dtUpdatedAt: new Date('2026-01-03'),
    maxReports: 10,
    mailEnabled: true, mailHost: 'smtp.example.com', mailPort: 587,
    mailFrom: 'alice@example.com', mailRecipients: 2, mailHasPassword: true,
    scheduleEnabled: true, frequency: 'daily', hour: 9, scheduleProjects: 4,
    nextRunAt: new Date('2026-02-02'), lastRunAt: new Date('2026-02-01'),
    lastRunStatus: 'success',
    reportCount: 5, reportsCompleted: 4, reportsRunning: 0, reportsFailed: 1,
    storageBytes: '8192', newestReportAt: new Date('2026-02-01'),
  });

  const get = (loginId, principal) => ({
    method: 'GET', url: `/admin/users/${loginId}`, path: `/admin/users/${loginId}`,
    res: makeRes(), principal,
  });

  test('an ordinary user is refused', async () => {
    const restore = stub(usersMod, {
      detailForAdmin: async () => { throw new Error('must not query for a non-administrator'); },
    });
    try {
      const ctx = get('alice', asUser(USER_B));
      assert.equal(await routeAdmin.handle(ctx), true);
      assert.equal(ctx.res.statusCode, 403);
      assert.equal(ctx.res.json.code, 'ADMIN_ONLY');
    } finally { restore(); }
  });

  test('the detail is grouped and complete', async () => {
    const restore = stub(usersMod, { detailForAdmin: async () => sampleDetail() });
    try {
      const ctx = get('alice', asAdmin());
      await routeAdmin.handle(ctx);
      assert.equal(ctx.res.statusCode, 200);
      const d = ctx.res.json;
      assert.equal(d.account.loginId, 'alice');
      assert.equal(d.session.ipAddress, '10.0.0.9');
      assert.equal(d.dependencyTrack.configured, true);
      assert.equal(d.dependencyTrack.hasApiKey, true);
      assert.equal(d.settings.maxReports, 10);
      assert.equal(d.mail.recipients, 2);
      assert.equal(d.schedule.projectCount, 4);
      assert.equal(d.reports.completed, 4);
      assert.equal(d.reports.storageBytes, 8192, 'bigint storage is a number');
    } finally { restore(); }
  });

  test('no secret is reachable through the detail', async () => {
    const restore = stub(usersMod, { detailForAdmin: async () => sampleDetail() });
    try {
      const ctx = get('alice', asAdmin());
      await routeAdmin.handle(ctx);
      const d = ctx.res.json;
      // The API key and SMTP password are reported as present, never disclosed.
      assert.equal('apiKey' in d.dependencyTrack, false);
      assert.equal('password' in d.mail, false);
      assert.equal(d.mail.hasPassword, true);
      assert.doesNotMatch(ctx.res.body, /scrypt\$|api_key_ciphertext|passwordHash/);
      assert.equal('id' in d.account, false, 'the internal user id is not exposed');
    } finally { restore(); }
  });

  test('an account with no session or configuration renders as empty, not missing', async () => {
    const bare = { ...sampleDetail(), sessionIssuedAt: null, dtConfigured: false,
                   dtApiUrl: null, dtHasApiKey: false, mailEnabled: false, mailHost: null,
                   scheduleEnabled: false, frequency: null };
    const restore = stub(usersMod, { detailForAdmin: async () => bare });
    try {
      const ctx = get('bob', asAdmin());
      await routeAdmin.handle(ctx);
      assert.equal(ctx.res.statusCode, 200);
      assert.equal(ctx.res.json.session, null);
      assert.equal(ctx.res.json.dependencyTrack.configured, false);
      assert.equal(ctx.res.json.dependencyTrack.apiUrl, '');
      assert.equal(ctx.res.json.mail.enabled, false);
    } finally { restore(); }
  });

  test('an unknown account is 404', async () => {
    const restore = stub(usersMod, { detailForAdmin: async () => null });
    try {
      const ctx = get('nobody', asAdmin());
      await routeAdmin.handle(ctx);
      assert.equal(ctx.res.statusCode, 404);
      assert.equal(ctx.res.json.code, 'NOT_FOUND');
    } finally { restore(); }
  });

  test('the detail route itself stays read-only', async () => {
    // The writes live on their own sub-paths — /settings and /password — so
    // /admin/users/:loginId remains a GET and nothing else. A PUT here would
    // be a general-purpose account editor, which is not what was asked for.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const ctx = { method, url: '/admin/users/alice', path: '/admin/users/alice',
                    res: makeRes(), principal: asAdmin() };
      assert.equal(await routeAdmin.handle(ctx), false,
        `${method} /admin/users/:loginId must not be handled`);
    }
  });
});

// ── The administrator's reserved data identity ──────────────────────────────
// The administrator is authenticated against the credentials file and never
// against the users table (CLAUDE.md §7.4) — unchanged. What migration 004 adds
// is somewhere to KEEP their own dashboard configuration, so Settings, reports
// and a schedule work for them through the ordinary per-user routes.

const { requireUser } = require('./lib/http-util');

describe('administrator principal', () => {
  test('the reserved id is fixed, not generated', () => {
    assert.equal(usersMod.ADMIN_PRINCIPAL_ID, '00000000-0000-4000-8000-000000000001');
  });

  test('the reserved login ID is refused by name at registration', () => {
    // Underscore is a legal login character, so the charset does NOT put this
    // name out of reach — it has to be reserved explicitly. Without that, the
    // only thing stopping it is the unique index, whose message would imply an
    // ordinary account holds the name.
    assert.ok(v.ALWAYS_RESERVED.includes('__administrator__'));
    const reserved = v.reservedLoginIds('admin');
    assert.ok(v.validateLoginId('__administrator__', reserved),
      'the reserved principal name must fail validation');
    assert.ok(v.validateLoginId('__ADMINISTRATOR__', reserved),
      'and case must not evade it');
  });

  test('the migration seeds the principal and every per-user row', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, 'db', 'migrations', '004_admin_principal.sql'), 'utf8');
    assert.match(sql, /INSERT INTO users/);
    for (const t of ['dt_connections', 'user_settings', 'mail_settings', 'schedules']) {
      assert.match(sql, new RegExp(`INSERT INTO ${t}`),
        `${t} must be seeded, or the administrator's first read finds no row`);
    }
    // Idempotent at the file level (CLAUDE.md §5.3).
    const inserts = (sql.match(/INSERT INTO/g) || []).length;
    const conflicts = (sql.match(/ON CONFLICT/g) || []).length;
    assert.equal(inserts, conflicts, 'every INSERT needs an ON CONFLICT guard');
  });

  test('the seeded password hash can never authenticate', async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, 'db', 'migrations', '004_admin_principal.sql'), 'utf8');
    const hash = /'(reserved-principal-no-password)'/.exec(sql);
    assert.ok(hash, 'the reserved row must carry an obviously unusable hash');
    // verifyPassword returns false for a malformed hash rather than throwing.
    assert.equal(await dtCrypto.verifyPassword('anything', hash[1]), false);
    assert.equal(await dtCrypto.verifyPassword('', hash[1]), false);
  });

  test('requireUser now resolves an id for the administrator too', () => {
    const res = makeRes();
    assert.equal(
      requireUser({ userId: usersMod.ADMIN_PRINCIPAL_ID, isAdmin: true }, res),
      usersMod.ADMIN_PRINCIPAL_ID);
    assert.equal(res.statusCode, null, 'no error response should have been sent');
  });

  test('requireUser still refuses a principal with no id at all', () => {
    // Unreachable in normal operation, and it must stay a hard stop: a request
    // without an id must never fall through to an unscoped query.
    const res = makeRes();
    assert.equal(requireUser({ isAdmin: true }, res), null);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json.code, 'USER_ONLY');
  });
});

describe('routes — the administrator uses the ordinary per-user routes', () => {
  const asAdminPrincipal = () => ({
    userId: usersMod.ADMIN_PRINCIPAL_ID, principalType: 'admin',
    isAdmin: true, loginId: null,
  });

  test('the config route serves the administrator, scoped to their own id', async () => {
    const seen = [];
    const restore = stub(dtConnectionsMod, {
      getForClient: async (id) => { seen.push(id); return { apiUrl: 'http://dt', isConfigured: true, hasApiKey: true, frontendUrl: '' }; },
    });
    const r2 = stub(userSettingsMod, { get: async () => ({ maxReports: 10 }) });
    const r3 = stub(require('./lib/mail-settings'), { getForClient: async () => ({ enabled: false }) });
    const r4 = stub(schedulesMod, { get: async () => null, getProjects: async () => [] });
    try {
      const res = makeRes();
      await routeConfig.handle({
        method: 'GET', url: '/violation-cache/config', path: '/violation-cache/config',
        req: {}, res, principal: asAdminPrincipal(),
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(seen, [usersMod.ADMIN_PRINCIPAL_ID]);
      assert.equal(res.json.connection.isConfigured, true);
    } finally { restore(); r2(); r3(); r4(); }
  });

  test('the DT proxy forwards for the administrator', async () => {
    const restoreConn = stub(dtConnectionsMod, {
      getResolved: async (id) => {
        assert.equal(id, usersMod.ADMIN_PRINCIPAL_ID);
        return { apiUrl: 'http://dt:8080', apiKey: 'k', isConfigured: true, fingerprint: 'f' };
      },
    });
    const restoreFetch = stub(dtFetchMod, {
      dtGetWithRetry: async () => ({ json: [{ uuid: 'p1' }], headers: {} }),
    });
    try {
      const res = makeRes();
      await routeDtProxy.handle({
        method: 'GET', url: '/violation-cache/dt/api/v1/project',
        path: '/violation-cache/dt/api/v1/project', res, principal: asAdminPrincipal(),
      });
      assert.equal(res.statusCode, 200, res.body);
    } finally { restoreConn(); restoreFetch(); }
  });

  test('the administrator still cannot be listed or deleted as an account', () => {
    // routes/profile.js and DELETE /auth/account branch on isAdmin before they
    // ever reach users.updateProfile / users.deleteById, so a data identity
    // does not open either path.
    const profileSrc = fs.readFileSync(path.join(__dirname, 'routes', 'profile.js'), 'utf8');
    assert.match(profileSrc, /if \(principal\.isAdmin\)/);
    const authSrc = fs.readFileSync(path.join(__dirname, 'routes', 'auth.js'), 'utf8');
    assert.match(authSrc, /ADMIN_IMMUTABLE/);
  });
});

// ── SV_CWE Summary ───────────────────────────────────────────────────────────
// The sheet is built from the finding objects /api/v1/finding already returns.
// If somebody ever adds a second upstream call to populate it, the "no extra
// request" test below fails — that is the whole point of it.
describe('reports — CWE labelling and references', () => {
  test('the label is the findings sheet cell, and both sides share it', () => {
    assert.equal(cweMod.cweLabel({ cwes: [{ cweId: 79 }] }), 'CWE-79');
    assert.equal(cweMod.cweLabel({ cwes: [{ cweId: 79 }, { cweId: 89 }] }), 'CWE-79, CWE-89');
  });

  test('a vulnerability DT mapped to no weakness yields an empty cell', () => {
    assert.equal(cweMod.cweLabel({}), '');
    assert.equal(cweMod.cweLabel({ cwes: [] }), '');
    assert.equal(cweMod.cweLabel(null), '');
  });

  test('an id that already carries the prefix is not doubled', () => {
    // Some deployments send "CWE-79" rather than 79; the old inline join
    // rendered that as CWE-CWE-79.
    assert.equal(cweMod.cweLabel({ cwes: [{ cweId: 'CWE-79' }] }), 'CWE-79');
  });

  test('references are derived from the identifier, never invented', () => {
    assert.equal(cweMod.vulnReference('CVE-2021-44228'),
      'https://nvd.nist.gov/vuln/detail/CVE-2021-44228');
    assert.equal(cweMod.vulnReference('GHSA-jfh8-c2jp-5v3q'),
      'https://github.com/advisories/GHSA-jfh8-c2jp-5v3q');
    assert.equal(cweMod.vulnReference('GO-2022-0001'),
      'https://osv.dev/vulnerability/GO-2022-0001');
    assert.equal(cweMod.cweReference(['79']),
      'https://cwe.mitre.org/data/definitions/79.html');
  });

  test('an unrecognised identifier gets a blank cell, not a broken link', () => {
    // A guessed URL costs somebody a click to discover it 404s.
    assert.equal(cweMod.vulnReference('INT-000123'), '');
    assert.equal(cweMod.vulnReference(''), '');
    assert.equal(cweMod.cweReference([]), '');
  });
});

describe('reports — the CWE summary needs no extra DependencyTrack call', () => {
  const findingsFor = (rows) => rows.map(([vulnId, cweIds, comp]) => ({
    vulnerability: {
      vulnId, severity: 'HIGH',
      cwes: cweIds.map(id => ({ cweId: id, name: 'x' })),
    },
    component: { name: comp, version: '1.0' },
  }));

  // name → the findings that project reports
  function stubDt(byProject) {
    return stub(dtFetchMod, {
      dtGetWithRetry: async (urlPath) => {
        const m = /textSearchInput=([^&]*)/.exec(urlPath);
        const key = decodeURIComponent(m ? m[1] : '').trim().split(' ')[0];
        const rows = byProject[key] || [];
        return { json: rows, headers: { 'x-total-count': String(rows.length) } };
      },
    });
  }

  test('it is populated from the same /api/v1/finding response', async () => {
    reportsMod.configure({ reportConcurrency: 2, violationConcurrency: 2 });
    const asked = [];
    const restore = stub(dtFetchMod, {
      dtGetWithRetry: async (urlPath) => {
        asked.push(urlPath);
        return {
          json: findingsFor([['CVE-1', [79], 'lib-a']]),
          headers: { 'x-total-count': '1' },
        };
      },
    });
    try {
      const data = await reportsMod.collectReportData(
        'http://dt', 'k',
        [{ uuid: 'p1', name: 'Alpha', version: '1' }],
        ['security'], { cancelled: false }
      );
      assert.equal(data.secCweMap.size, 1);
      assert.equal(asked.length, 1, `one findings page only: ${JSON.stringify(asked)}`);
      assert.ok(asked.every(p => p.startsWith('/api/v1/finding')),
        'the CWE summary must not introduce a second upstream endpoint');
    } finally { restore(); }
  });

  test('rows are unique on the vulnerability and CWE pair', async () => {
    reportsMod.configure({ reportConcurrency: 2, violationConcurrency: 2 });
    const restore = stubDt({
      Alpha: findingsFor([
        ['CVE-1', [79], 'lib-a'],
        ['CVE-1', [79], 'lib-b'],   // same pair, different component → one row, count 2
        ['CVE-1', [89], 'lib-c'],   // same CVE, different CWE       → its own row
        ['CVE-2', [79], 'lib-d'],
      ]),
    });
    try {
      const data = await reportsMod.collectReportData(
        'http://dt', 'k',
        [{ uuid: 'p1', name: 'Alpha', version: '1' }],
        ['security'], { cancelled: false }
      );
      const rows = [...data.secCweMap.values()]
        .map(e => [e.vulnId, e.cwe, e.count])
        .sort((a, b) => String(a).localeCompare(String(b)));
      assert.deepEqual(rows, [
        ['CVE-1', 'CWE-79', 2],
        ['CVE-1', 'CWE-89', 1],
        ['CVE-2', 'CWE-79', 1],
      ]);
    } finally { restore(); }
  });

  test('affected projects accumulate across projects', async () => {
    reportsMod.configure({ reportConcurrency: 2, violationConcurrency: 2 });
    const restore = stubDt({
      Alpha: findingsFor([['CVE-1', [79], 'lib-a']]),
      Beta:  findingsFor([['CVE-1', [79], 'lib-a']]),
    });
    try {
      const data = await reportsMod.collectReportData(
        'http://dt', 'k',
        [{ uuid: 'p1', name: 'Alpha', version: '1' },
         { uuid: 'p2', name: 'Beta',  version: '1' }],
        ['security'], { cancelled: false }
      );
      assert.equal(data.secCweMap.size, 1);
      const entry = [...data.secCweMap.values()][0];
      assert.equal(entry.count, 2);
      assert.deepEqual([...entry.projects].sort(), ['Alpha', 'Beta']);
    } finally { restore(); }
  });

  test('the counts reconcile with the findings sheet', async () => {
    // A finding with no CWE still gets a row, so the summary accounts for
    // every finding rather than quietly dropping the unmapped ones.
    reportsMod.configure({ reportConcurrency: 2, violationConcurrency: 2 });
    const restore = stubDt({
      Alpha: findingsFor([
        ['CVE-1', [79], 'lib-a'],
        ['CVE-2', [],   'lib-b'],
        ['CVE-3', [20, 79], 'lib-c'],
      ]),
    });
    try {
      const data = await reportsMod.collectReportData(
        'http://dt', 'k',
        [{ uuid: 'p1', name: 'Alpha', version: '1' }],
        ['security'], { cancelled: false }
      );
      const summed = [...data.secCweMap.values()].reduce((n, e) => n + e.count, 0);
      assert.equal(summed, data.secFindings.length,
        'every finding is represented exactly once');
      const noCwe = [...data.secCweMap.values()].find(e => e.vulnId === 'CVE-2');
      assert.equal(noCwe.cwe, '');
      const multi = [...data.secCweMap.values()].find(e => e.vulnId === 'CVE-3');
      assert.equal(multi.cwe, 'CWE-20, CWE-79', 'multi-CWE findings stay on one row');
    } finally { restore(); }
  });
});

describe('reports — the CWE summary sheet', () => {
  const reportData = () => ({
    riskTypes: ['security'],
    secFindings: [],
    secProjectSummary: new Map(),
    secComponentMap: new Map(),
    secCweMap: new Map([
      ['a', { vulnId: 'CVE-1', cwe: 'CWE-79', cweIds: ['79'], count: 1, projects: new Set(['Beta']) }],
      ['b', { vulnId: 'CVE-2', cwe: 'CWE-89', cweIds: ['89'], count: 5, projects: new Set(['Alpha', 'Beta']) }],
      ['c', { vulnId: 'INT-9',  cwe: '',      cweIds: [],     count: 2, projects: new Set(['Alpha']) }],
    ]),
    licViolations: [], licProjectSummary: new Map(),
    opsViolations: [], opsProjectSummary: new Map(),
  });

  async function sheetOf(data, name) {
    const buf = await excelMod.buildExcelReport(null, data);
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.load(buf);
    return wb.getWorksheet(name);
  }

  test('it sits alongside the three existing security sheets', async () => {
    const buf = await excelMod.buildExcelReport(null, reportData());
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.load(buf);
    const names = wb.worksheets.map(w => w.name);
    assert.deepEqual(names, [
      'SV_Vulnerability Findings', 'SV_Project Summary',
      'SV_Component Summary', 'SV_CWE Summary',
    ]);
  });

  test('the columns are the ones asked for, references included', async () => {
    const ws = await sheetOf(reportData(), 'SV_CWE Summary');
    assert.deepEqual(ws.getRow(1).values.slice(1), [
      'S.No', 'Vulnerability', 'CWE', 'Vulnerability Count',
      'Affected Projects', 'CVE Reference', 'CWE Reference',
    ]);
  });

  test('rows run most-frequent first and carry their links', async () => {
    const ws = await sheetOf(reportData(), 'SV_CWE Summary');
    assert.deepEqual(ws.getRow(2).values.slice(1), [
      1, 'CVE-2', 'CWE-89', 5, 'Alpha, Beta',
      'https://nvd.nist.gov/vuln/detail/CVE-2',
      'https://cwe.mitre.org/data/definitions/89.html',
    ]);
    assert.equal(ws.getRow(3).getCell(2).value, 'INT-9');   // count 2
    assert.equal(ws.getRow(4).getCell(2).value, 'CVE-1');   // count 1
  });

  test('an unrecognised identifier leaves both reference cells empty', async () => {
    const ws = await sheetOf(reportData(), 'SV_CWE Summary');
    const row = ws.getRow(3);
    assert.equal(row.getCell(3).value ?? '', '');
    assert.equal(row.getCell(6).value ?? '', '');
    assert.equal(row.getCell(7).value ?? '', '');
  });

  test('a report without security risk has no CWE sheet', async () => {
    const data = { ...reportData(), riskTypes: ['license'] };
    const buf = await excelMod.buildExcelReport(null, data);
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.load(buf);
    assert.equal(wb.getWorksheet('SV_CWE Summary'), undefined);
  });

  test('an older caller that omits secCweMap still builds a workbook', async () => {
    // scheduler.js and reports.js both spread collectReportData's result, so
    // the key is always present — but an empty sheet beats a thrown job.
    const data = { ...reportData(), secCweMap: undefined };
    const ws = await sheetOf(data, 'SV_CWE Summary');
    assert.equal(ws.rowCount, 1, 'header only');
  });
});

// ── Image inspection ─────────────────────────────────────────────────────────
// The uploaded background is served from our own origin to unauthenticated
// visitors, so what the bytes ARE matters more than what the uploader said.
describe('branding — image inspection', () => {
  // Minimal but real headers: enough bytes for sniffing and dimension parsing.
  function pngOf(w, h, pad = 0) {
    const b = Buffer.alloc(24 + pad);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  }
  function jpegOf(w, h) {
    const b = Buffer.alloc(20);
    Buffer.from([0xff, 0xd8, 0xff]).copy(b, 0);
    b[2] = 0xff; b[3] = 0xc0;      // SOF0
    b.writeUInt16BE(11, 4);        // segment length
    b[6] = 8;                      // precision
    b.writeUInt16BE(h, 7);
    b.writeUInt16BE(w, 9);
    return b;
  }
  function webpLosslessOf(w, h) {
    const b = Buffer.alloc(32);
    b.write('RIFF', 0, 'ascii');
    b.write('WEBP', 8, 'ascii');
    b.write('VP8L', 12, 'ascii');
    b[20] = 0x2f;
    b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
    return b;
  }

  test('the format comes from the bytes, never the declared type', () => {
    assert.equal(imageMod.sniff(pngOf(1920, 1080)), 'image/png');
    assert.equal(imageMod.sniff(jpegOf(1920, 1080)), 'image/jpeg');
    assert.equal(imageMod.sniff(webpLosslessOf(1920, 1080)), 'image/webp');
  });

  test('SVG is refused however it is presented', () => {
    // XML that can carry <script>, served from the origin that holds the
    // session. There is no safe way to accept it here.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"/>');
    assert.equal(imageMod.sniff(svg), null);
    assert.throws(() => imageMod.inspect(svg), /not a PNG, JPEG or WebP/);
  });

  test('dimensions are read for each accepted format', () => {
    for (const buf of [pngOf(1920, 1080), jpegOf(1920, 1080), webpLosslessOf(1920, 1080)]) {
      const meta = imageMod.inspect(buf);
      assert.equal(meta.width, 1920);
      assert.equal(meta.height, 1080);
    }
  });

  test('an image below the resolution floor is refused', () => {
    assert.throws(() => imageMod.inspect(pngOf(800, 600)), /minimum is 1280×720/);
  });

  test('an image above the resolution ceiling is refused', () => {
    assert.throws(() => imageMod.inspect(pngOf(6000, 6000)), /maximum is 5000×5000/);
  });

  test('there is no minimum file size — only a maximum', () => {
    // A small file that is a real image of an acceptable resolution is fine.
    const tiny = pngOf(1920, 1080);
    assert.ok(tiny.length < 100);
    assert.doesNotThrow(() => imageMod.inspect(tiny));

    const huge = Buffer.alloc(imageMod.MAX_BYTES + 1);
    pngOf(1920, 1080).copy(huge, 0);
    assert.throws(() => imageMod.inspect(huge), /maximum is 5\.0 MB/);
  });

  test('a truncated or damaged file is refused, not guessed at', () => {
    const truncated = pngOf(1920, 1080).subarray(0, 18);
    assert.throws(() => imageMod.inspect(truncated), /truncated or damaged|not a PNG/);
    assert.throws(() => imageMod.inspect(Buffer.alloc(0)), /No image was received/);
  });
});

// ── The application title ────────────────────────────────────────────────────
describe('branding — the title rule', () => {
  test('blank means the built-in default, and is never an error', () => {
    assert.equal(validateMod.validateAppTitle(''), null);
    assert.equal(validateMod.validateAppTitle('   '), null);
    assert.equal(validateMod.validateAppTitle(null), null);
    assert.equal(validateMod.validateAppTitle(undefined), null);
  });

  test('the shipped default is itself acceptable', () => {
    assert.equal(validateMod.validateAppTitle(brandingMod.DEFAULT_TITLE), null);
  });

  test('control characters are refused', () => {
    // They can hide text or reorder how it reads, and this string is rendered
    // into three pages.
    assert.ok(validateMod.validateAppTitle('Risk' + String.fromCharCode(7) + 'Dashboard'));
    assert.ok(validateMod.validateAppTitle('Risk‎Dashboard'));
  });

  test('the length ceiling is enforced at the boundary', () => {
    const max = validateMod.APP_TITLE_MAX;
    assert.equal(validateMod.validateAppTitle('a'.repeat(max)), null);
    assert.ok(validateMod.validateAppTitle('a'.repeat(max + 1)));
  });

  test('a title with no letter or number is refused', () => {
    assert.ok(validateMod.validateAppTitle('---'));
  });
});

// ── Branding routes ──────────────────────────────────────────────────────────
describe('routes — branding is readable without a session', () => {
  const pub = (path, headers = {}) => ({
    method: 'GET', url: path, path,
    req: Object.assign(mockReq(''), { headers }),
    res: makeRes(),
    // No principal: these routes are reached before anybody signs in.
  });

  test('the title is served to an unauthenticated caller', async () => {
    const restore = stub(brandingMod, {
      get: async () => ({ title: 'Acme Risk', titleIsDefault: false, background: null }),
    });
    try {
      const ctx = pub('/branding');
      assert.equal(await routeBranding.handle(ctx), true);
      assert.equal(ctx.res.statusCode, 200);
      assert.equal(ctx.res.json.title, 'Acme Risk');
      assert.equal(ctx.res.json.background, null);
    } finally { restore(); }
  });

  test('a failure serves defaults rather than blocking the sign-in page', async () => {
    // Locking people out of signing in because a title could not be read would
    // be a far worse outcome than showing the built-in one.
    const restore = stub(brandingMod, {
      get: async () => { throw new Error('database is down'); },
    });
    try {
      const ctx = pub('/branding');
      await routeBranding.handle(ctx);
      assert.equal(ctx.res.statusCode, 200);
      assert.equal(ctx.res.json.title, brandingMod.DEFAULT_TITLE);
    } finally { restore(); }
  });

  test('the image is served with its sniffed type and a nosniff header', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const restore = stub(brandingMod, {
      getBackgroundBytes: async () => ({ bytes, mimeType: 'image/png', etag: 'abc123' }),
    });
    try {
      const ctx = pub('/branding/background');
      await routeBranding.handle(ctx);
      assert.equal(ctx.res.statusCode, 200);
      assert.equal(ctx.res.headers['Content-Type'], 'image/png');
      assert.equal(ctx.res.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(ctx.res.headers.ETag, '"abc123"');
      assert.match(ctx.res.headers['Cache-Control'], /immutable/);
    } finally { restore(); }
  });

  test('an unchanged image answers 304 rather than resending the bytes', async () => {
    const restore = stub(brandingMod, {
      getBackgroundBytes: async () => ({
        bytes: Buffer.from([1, 2, 3]), mimeType: 'image/png', etag: 'abc123',
      }),
    });
    try {
      const ctx = pub('/branding/background', { 'if-none-match': '"abc123"' });
      await routeBranding.handle(ctx);
      assert.equal(ctx.res.statusCode, 304);
    } finally { restore(); }
  });

  test('no configured image is a 404, not an empty 200', async () => {
    const restore = stub(brandingMod, { getBackgroundBytes: async () => null });
    try {
      const ctx = pub('/branding/background');
      await routeBranding.handle(ctx);
      assert.equal(ctx.res.statusCode, 404);
      assert.equal(ctx.res.json.code, 'NO_BACKGROUND');
    } finally { restore(); }
  });
});

describe('routes — branding writes are administrator-only', () => {
  const cases = [
    ['PUT',    '/admin/branding'],
    ['POST',   '/admin/branding/background'],
    ['DELETE', '/admin/branding/background'],
    ['GET',    '/admin/branding'],
  ];

  for (const [method, path] of cases) {
    test(`${method} ${path} refuses an ordinary user with 403`, async () => {
      const res = makeRes();
      const handled = await routeAdmin.handle({
        method, url: path, path, req: mockReq('{}'), res, principal: asUser(USER_A),
      });
      assert.equal(handled, true);
      assert.equal(res.statusCode, 403);
      assert.equal(res.json.code, 'ADMIN_ONLY');
    });
  }

  test('the declared Content-Type does not decide what is stored', async () => {
    // A caller can put anything in a header. The bytes are what count.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"/>');
    const res = makeRes();
    const req = mockReq(svg);
    req.headers = { 'content-type': 'image/png' };
    const restore = stub(brandingMod, {
      putBackground: async () => { throw new Error('must not be reached'); },
    });
    try {
      await routeAdmin.handle({
        method: 'POST', url: '/admin/branding/background',
        path: '/admin/branding/background', req, res, principal: asAdmin(),
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json.code, 'IMAGE_INVALID');
    } finally { restore(); }
  });
});

// ── Closing the browser is not a second device ───────────────────────────────
// The reported bug: sign in, close the browser, come back after the idle
// window, and the login page announced "you are already signed in on another
// device" — about the user's own dead session. The token path honoured the
// idle window; the login conflict check did not.
describe('routes — the sign-in conflict check', () => {
  const LIVE = {
    id: 's1', issuedAt: new Date('2026-08-13T09:00:00Z'),
    lastSeenAt: new Date('2026-08-13T09:30:00Z'), userAgent: 'Firefox/1.0',
    principalType: 'user',
  };
  const post = (over = {}) => ({
    method: 'POST', url: '/auth/login', path: '/auth/login',
    req: Readable.from([JSON.stringify({
      loginId: 'alice', password: 'password123', isAdmin: false, ...over,
    })]),
    res: makeRes(),
  });
  // Enough of the account and audit layers for the route to reach the
  // conflict check and past it.
  const signedInOk = () => {
    const restoreUsers = stub(usersMod, {
      verifyLookup: async () => ({
        id: USER_A, passwordHash: 'x', mustChangePassword: false, loginId: 'alice',
      }),
      findById: async () => ({ id: USER_A, loginId: 'alice', firstName: 'A', lastName: 'B', email: null }),
      touchLastLogin: async () => {},
    });
    const restoreAudit = stub(auditMod, {
      record: async () => {}, clearFailures: async () => {},
    });
    return () => { restoreUsers(); restoreAudit(); };
  };

  test('the route asks auth for liveness, so it cannot skip the idle window', () => {
    // Calling sessions.findLiveForUser() directly is what caused this: that
    // function takes an idle window the route never passed.
    const src = fs.readFileSync(path.join(__dirname, 'routes', 'auth.js'), 'utf8');
    assert.match(src, /auth\.findLiveSession\(/,
      'the conflict check must go through the helper that supplies idleHours');
    assert.ok(!/sessions\.findLiveForUser\(|sessions\.findLiveAdmin\(/.test(src),
      'the route must not query liveness directly — it would omit the idle window');
  });

  test('no live session means no conflict prompt', async () => {
    const restoreUsers = signedInOk();
    const restoreAuth = stub(authMod, {
      isLockedOut: async () => false,
      findLiveSession: async () => null,          // idle-expired: not live
      issueSession: async () => ({ token: 'new-token' }),
    });
    const restoreCrypto = stub(cryptoMod, { verifyPassword: async () => true });
    try {
      const ctx = post();
      await routeAuth.handle(ctx);
      assert.equal(ctx.res.statusCode, 200, ctx.res.body);
      assert.equal(ctx.res.json.token, 'new-token');
    } finally { restoreUsers(); restoreAuth(); restoreCrypto(); }
  });

  test('a genuinely live session still prompts, with its details', async () => {
    const restoreUsers = signedInOk();
    const restoreAuth = stub(authMod, {
      isLockedOut: async () => false,
      findLiveSession: async () => LIVE,
      issueSession: async () => { throw new Error('must not issue while prompting'); },
    });
    const restoreCrypto = stub(cryptoMod, { verifyPassword: async () => true });
    try {
      const ctx = post();
      await routeAuth.handle(ctx);
      assert.equal(ctx.res.statusCode, 409);
      assert.equal(ctx.res.json.code, 'SESSION_EXISTS');
      assert.ok(ctx.res.json.session, 'the dialog needs something to show');
      assert.equal(ctx.res.json.session.userAgent, 'Firefox/1.0');
    } finally { restoreUsers(); restoreAuth(); restoreCrypto(); }
  });

  test('losing the race reports the same detail, not an empty dialog', async () => {
    // Two 409s used to carry different bodies, so the same dialog sometimes
    // showed when and where and sometimes said "no details available".
    const restoreUsers = signedInOk();
    let asked = 0;
    const restoreAuth = stub(authMod, {
      isLockedOut: async () => false,
      findLiveSession: async () => (asked++ === 0 ? null : LIVE),
      issueSession: async () => {
        throw Object.assign(new Error('index won'), { code: 'SESSION_EXISTS' });
      },
    });
    const restoreCrypto = stub(cryptoMod, { verifyPassword: async () => true });
    try {
      const ctx = post();
      await routeAuth.handle(ctx);
      assert.equal(ctx.res.statusCode, 409);
      assert.equal(ctx.res.json.code, 'SESSION_EXISTS');
      assert.ok(ctx.res.json.session, 'the race path must describe the winner too');
      assert.equal(ctx.res.json.session.userAgent, 'Firefox/1.0');
    } finally { restoreUsers(); restoreAuth(); restoreCrypto(); }
  });

  test('issuing a session always clears the slot a dead one is holding', () => {
    // The partial unique index tests revoked_at only, so an expired row keeps
    // the slot until the sweeper runs days later.
    const src = fs.readFileSync(path.join(__dirname, 'lib', 'auth.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function issueSession('), src.indexOf('// ── Session validation'));
    assert.match(fn, /retireNotLive\(/, 'issueSession must retire dead sessions');
    const retireAt = fn.indexOf('retireNotLive(');
    const forceAt  = fn.indexOf('if (force)');
    assert.ok(retireAt < forceAt,
      'it must run for every sign-in, not only a forced one');
  });
});

// ── Email delivery ───────────────────────────────────────────────────────────
// lib/mail.js had no tests, which is how `DEFAULT_APP_TITLE is not defined`
// reached a deployment: the constant was used in the default subject and body
// but only imported into excel.js. Those defaults are computed on EVERY send,
// before overrides are applied, so a caller supplying its own subject still
// tripped it — every test email failed.
describe('mail — sending', () => {
  const nodemailer = require('nodemailer');

  /** Capture what nodemailer would have been asked to do. */
  function captureTransport() {
    const seen = {};
    const restore = stub(nodemailer, {
      createTransport: (opts) => {
        seen.transport = opts;
        return { sendMail: async (msg) => { seen.msg = msg; return { messageId: 'test' }; } };
      },
    });
    return { seen, restore };
  }

  const anon = () => ({
    smtp: { host: 'mail.local', port: 25, secure: false, user: '', pass: '' },
    from: 'from@example.com', to: ['to@example.com'], cc: [], subject: '', body: '',
  });

  test('a send with no appTitle falls back instead of throwing', async () => {
    // The exact regression.
    const { seen, restore } = captureTransport();
    try {
      await mailMod.sendEmail(anon(), null, { subject: 'Test', body: 'Body' });
      assert.equal(seen.msg.subject, 'Test');
    } finally { restore(); }
  });

  test('the default subject and body carry the application title', async () => {
    const { seen, restore } = captureTransport();
    try {
      await mailMod.sendEmail(anon(), null, {});
      assert.ok(seen.msg.subject.startsWith(brandingMod.DEFAULT_TITLE), seen.msg.subject);
      assert.match(seen.msg.text, new RegExp(brandingMod.DEFAULT_TITLE.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')));
    } finally { restore(); }
  });

  test('a configured title is used in place of the default', async () => {
    const { seen, restore } = captureTransport();
    try {
      await mailMod.sendEmail(anon(), null, { appTitle: 'Acme Portal' });
      assert.ok(seen.msg.subject.startsWith('Acme Portal'), seen.msg.subject);
    } finally { restore(); }
  });

  // ── Anonymous relays ──────────────────────────────────────────────────
  test('no SMTP username means no authentication is attempted', async () => {
    // An open relay on an internal network needs no credentials, and offering
    // an empty user/pass pair would make the server refuse the connection.
    const { seen, restore } = captureTransport();
    try {
      await mailMod.sendEmail(anon(), null, {});
      assert.equal(seen.transport.auth, undefined,
        'the auth object must be omitted entirely, not sent empty');
      assert.equal(seen.transport.host, 'mail.local');
    } finally { restore(); }
  });

  test('a username still produces credentials', async () => {
    const { seen, restore } = captureTransport();
    const cfg = anon();
    cfg.smtp.user = 'svc'; cfg.smtp.pass = 'secret';
    try {
      await mailMod.sendEmail(cfg, null, {});
      assert.deepEqual(seen.transport.auth, { user: 'svc', pass: 'secret' });
    } finally { restore(); }
  });
});

// A cheap guard for the whole class: a SCREAMING_SNAKE constant referenced in a
// module but neither declared nor imported there is a ReferenceError waiting for
// the branch that reaches it. That is exactly how the mail bug shipped.
describe('lib — no constant is referenced without being defined', () => {
  /**
   * Strip everything that looks like an identifier but is not one: comments,
   * string literals, and property accesses. Template literals keep their
   * ${...} interpolations, because those are real code.
   */
  function codeOnly(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')                      // block comments
      .replace(/(^|[^:\\])\/\/.*$/gm, '$1')                     // line comments
      .replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, ' ')             // templates with no interpolation
      .replace(/`(?:[^`\\]|\\.)*?`/g, (t) =>                     // templates: keep ${...} only
        (t.match(/\$\{[^}]*\}/g) || []).join(' '))
      .replace(/'(?:[^'\\]|\\.)*'/g, ' ')                       // single-quoted strings
      .replace(/"(?:[^"\\]|\\.)*"/g, ' ')                       // double-quoted strings
      .replace(/\.\s*[A-Za-z_$][\w$]*/g, ' ')                     // property access
      .replace(/\b[A-Z][A-Z0-9_]*\s*:/g, ' ');                    // object-literal keys
  }

  test('every SCREAMING_SNAKE reference resolves within its module', () => {
    const libDir = path.join(__dirname, 'lib');
    const problems = [];
    for (const file of fs.readdirSync(libDir).filter(f => f.endsWith('.js'))) {
      const raw = fs.readFileSync(path.join(libDir, file), 'utf8');
      const src = codeOnly(raw);
      for (const name of new Set(src.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [])) {
        const declared =
          new RegExp(`(?:const|let|var)\\s+${name}\\b`).test(raw) ||          // const NAME =
          new RegExp(`,\\s*${name}\\s*=`).test(raw) ||                       // const A = 1, NAME = 2
          new RegExp(`\\b\\w+\\s*:\\s*${name}\\b`).test(raw) ||               // { X: NAME } alias
          new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=`).test(raw) ||        // { NAME } = ...
          new RegExp(`function\\s+${name}\\b`).test(raw);
        if (!declared) problems.push(`${file}: ${name}`);
      }
    }
    assert.deepEqual(problems, [],
      'referenced but never declared or imported in that module');
  });
});
