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

function patchEnvFile(filePath, updates) {
  let content;
  try {
    content = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
      : '';
  } catch (e) {
    throw Object.assign(
      new Error(`Failed to read ${filePath}: ${e.message}`),
      { code: 'PATCH_READ_FAILED', cause: e }
    );
  }

  const remaining = new Set(Object.keys(updates));
  let lines = content.split('\n').map(line => {
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) return line;
    const key = line.slice(0, eqIdx).trim();
    if (key in updates) {
      remaining.delete(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const key of remaining) lines.push(`${key}=${updates[key]}`);

  try {
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  } catch (e) {
    throw Object.assign(
      new Error(`Failed to write ${filePath}: ${e.message}`),
      { code: 'PATCH_WRITE_FAILED', cause: e }
    );
  }
}

/** Inline getEffectiveConfig with injectable params for testability. */
function getEffectiveConfig(envFile, startupUrl, startupKey) {
  const envVars = parseEnvFile(envFile);
  const apiUrl  = (envVars['DT_API_INTERNAL_URL'] || startupUrl || '').replace(/\/$/, '');
  const apiKey  = (envVars['DT_API_KEY'] || startupKey || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  return { apiUrl, apiKey };
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

// ── patchEnvFile ──────────────────────────────────────────────────────────────
describe('patchEnvFile', () => {
  test('updates an existing key in place', () => {
    const file = tmpFile('DT_API_KEY=old\nOTHER=keep\n');
    try {
      patchEnvFile(file, { DT_API_KEY: 'newkey' });
      const result = parseEnvFile(file);
      assert.equal(result.DT_API_KEY, 'newkey');
      assert.equal(result.OTHER, 'keep');
    } finally { cleanup(file); }
  });

  test('appends a new key when it does not already exist', () => {
    const file = tmpFile('EXISTING=yes\n');
    try {
      patchEnvFile(file, { NEW_KEY: 'hello' });
      const result = parseEnvFile(file);
      assert.equal(result.EXISTING, 'yes');
      assert.equal(result.NEW_KEY, 'hello');
    } finally { cleanup(file); }
  });

  test('creates the file when it does not exist', () => {
    const file = path.join(os.tmpdir(), `dt-cache-test-new-${Date.now()}.env`);
    try {
      patchEnvFile(file, { KEY: 'value' });
      assert.equal(parseEnvFile(file).KEY, 'value');
    } finally { cleanup(file); }
  });

  test('preserves comment lines', () => {
    const file = tmpFile('# a comment\nKEY=val\n');
    try {
      patchEnvFile(file, { KEY: 'new' });
      const raw = fs.readFileSync(file, 'utf8');
      assert.ok(raw.includes('# a comment'), 'comment should be preserved');
    } finally { cleanup(file); }
  });

  test('normalises Windows CRLF before patching', () => {
    const file = tmpFile('DT_API_KEY=old\r\nOTHER=keep\r\n');
    try {
      patchEnvFile(file, { DT_API_KEY: 'updated' });
      const result = parseEnvFile(file);
      assert.equal(result.DT_API_KEY, 'updated');
      assert.equal(result.OTHER, 'keep');
    } finally { cleanup(file); }
  });

  test('throws PATCH_READ_FAILED when file is unreadable', () => {
    assert.throws(
      () => patchEnvFile('/tmp', { KEY: 'val' }),
      (err) => err.code === 'PATCH_READ_FAILED' || err.code === 'PATCH_WRITE_FAILED'
    );
  });

  test('updates multiple keys in one call', () => {
    const file = tmpFile('A=1\nB=2\nC=3\n');
    try {
      patchEnvFile(file, { A: '10', C: '30' });
      const result = parseEnvFile(file);
      assert.equal(result.A, '10');
      assert.equal(result.B, '2');
      assert.equal(result.C, '30');
    } finally { cleanup(file); }
  });

  test('does not duplicate a key that already exists', () => {
    const file = tmpFile('KEY=old\n');
    try {
      patchEnvFile(file, { KEY: 'new' });
      const raw   = fs.readFileSync(file, 'utf8');
      const count = (raw.match(/^KEY=/gm) || []).length;
      assert.equal(count, 1, 'key should appear exactly once');
    } finally { cleanup(file); }
  });
});

// ── getEffectiveConfig ────────────────────────────────────────────────────────
describe('getEffectiveConfig', () => {
  test('returns startup values when .env file does not exist', () => {
    const cfg = getEffectiveConfig('/nonexistent.env', 'http://dt:8080', 'startupkey');
    assert.equal(cfg.apiUrl, 'http://dt:8080');
    assert.equal(cfg.apiKey, 'startupkey');
  });

  test('.env values take priority over startup values', () => {
    const file = tmpFile('DT_API_INTERNAL_URL=http://from-env:9090\nDT_API_KEY=envkey\n');
    try {
      const cfg = getEffectiveConfig(file, 'http://startup:8080', 'startupkey');
      assert.equal(cfg.apiUrl, 'http://from-env:9090');
      assert.equal(cfg.apiKey, 'envkey');
    } finally { cleanup(file); }
  });

  test('strips trailing slash from apiUrl', () => {
    const file = tmpFile('DT_API_INTERNAL_URL=http://dt:8080/\n');
    try {
      const cfg = getEffectiveConfig(file, '', '');
      assert.equal(cfg.apiUrl, 'http://dt:8080');
    } finally { cleanup(file); }
  });

  test('strips control characters from apiKey read from .env', () => {
    const file = tmpFile(`DT_API_KEY=mykey\r\n`);
    try {
      const cfg = getEffectiveConfig(file, '', '');
      assert.equal(cfg.apiKey, 'mykey');
    } finally { cleanup(file); }
  });

  test('falls back to startup key when .env has no DT_API_KEY', () => {
    const file = tmpFile('DT_API_INTERNAL_URL=http://dt:8080\n');
    try {
      const cfg = getEffectiveConfig(file, 'http://dt:8080', 'fallback-key');
      assert.equal(cfg.apiKey, 'fallback-key');
    } finally { cleanup(file); }
  });

  test('returns empty strings when no config anywhere', () => {
    const cfg = getEffectiveConfig('/nonexistent.env', '', '');
    assert.equal(cfg.apiUrl, '');
    assert.equal(cfg.apiKey, '');
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

// ── loadRegistry / saveRegistry logic ────────────────────────────────────────
// Inline a test-scoped version of the registry helpers so we don't start a
// real HTTP server.

function makeRegistry() {
  const jobs = new Map();

  function saveRegistry(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'registry.tmp.json');
    const dst = path.join(dir, 'registry.json');
    const entries = [];
    for (const job of jobs.values()) {
      const { cancelFlag, watchdogId, ...persisted } = job; // eslint-disable-line no-unused-vars
      entries.push(persisted);
    }
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
    fs.renameSync(tmp, dst);
    return dst;
  }

  function loadRegistry(regPath) {
    if (!fs.existsSync(regPath)) return;
    const entries = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    for (const entry of entries) {
      if (entry.status === 'running') {
        entry.status    = 'failed';
        entry.error     = 'Service restarted while this report was being generated.';
        entry.updatedAt = new Date().toISOString();
      }
      jobs.set(entry.id, { ...entry, cancelFlag: { cancelled: false } });
    }
  }

  return { jobs, saveRegistry, loadRegistry };
}

describe('saveRegistry / loadRegistry', () => {
  function tmpDir() {
    const d = path.join(os.tmpdir(), `dt-reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  test('saveRegistry persists jobs to registry.json atomically', () => {
    const dir = tmpDir();
    try {
      const { jobs, saveRegistry } = makeRegistry();
      jobs.set('abc', { id: 'abc', status: 'completed', filename: 'f.xlsx',
        filePath: '/data/f.xlsx', error: null, progress: { done: 1, total: 1 },
        createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:01:00Z',
        cancelFlag: { cancelled: false } });
      const dst = saveRegistry(dir);
      assert.ok(fs.existsSync(dst), 'registry.json should exist');
      const data = JSON.parse(fs.readFileSync(dst, 'utf8'));
      assert.equal(data.length, 1);
      assert.equal(data[0].id, 'abc');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('saveRegistry omits cancelFlag and watchdogId from persisted output', () => {
    const dir = tmpDir();
    try {
      const { jobs, saveRegistry } = makeRegistry();
      jobs.set('xyz', { id: 'xyz', status: 'running', cancelFlag: { cancelled: false },
        watchdogId: 42, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        filename: null, filePath: null, error: null, progress: { done: 0, total: 2 } });
      const dst = saveRegistry(dir);
      const data = JSON.parse(fs.readFileSync(dst, 'utf8'));
      assert.ok(!('cancelFlag'  in data[0]), 'cancelFlag should not be persisted');
      assert.ok(!('watchdogId'  in data[0]), 'watchdogId should not be persisted');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('loadRegistry marks running jobs as failed with "Service restarted" message', () => {
    const dir = tmpDir();
    try {
      const { jobs, saveRegistry, loadRegistry } = makeRegistry();
      jobs.set('run1', { id: 'run1', status: 'running', cancelFlag: { cancelled: false },
        filename: null, filePath: null, error: null, progress: { done: 0, total: 5 },
        createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' });
      const dst = saveRegistry(dir);

      // Simulate service restart by loading into a fresh registry
      const { jobs: jobs2, loadRegistry: load2 } = makeRegistry();
      load2(dst);

      const reloaded = jobs2.get('run1');
      assert.equal(reloaded.status, 'failed');
      assert.ok(reloaded.error.includes('Service restarted'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('loadRegistry preserves completed and failed job statuses unchanged', () => {
    const dir = tmpDir();
    try {
      const { jobs, saveRegistry, loadRegistry } = makeRegistry();
      jobs.set('c1', { id: 'c1', status: 'completed', filename: 'r.xlsx',
        filePath: '/data/r.xlsx', error: null, progress: { done: 3, total: 3 },
        createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:01:00Z',
        cancelFlag: { cancelled: false } });
      jobs.set('f1', { id: 'f1', status: 'failed', filename: null,
        filePath: null, error: 'API error', progress: { done: 1, total: 3 },
        createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:01:00Z',
        cancelFlag: { cancelled: false } });
      const dst = saveRegistry(dir);

      const { jobs: j2, loadRegistry: l2 } = makeRegistry();
      l2(dst);

      assert.equal(j2.get('c1').status, 'completed');
      assert.equal(j2.get('f1').status, 'failed');
      assert.equal(j2.get('f1').error,  'API error');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('loadRegistry is a no-op when registry file does not exist', () => {
    const { jobs, loadRegistry } = makeRegistry();
    loadRegistry('/tmp/definitely-no-registry-here-dt.json');
    assert.equal(jobs.size, 0);
  });

  test('loadRegistry adds cancelFlag object to every loaded job', () => {
    const dir = tmpDir();
    try {
      const { jobs, saveRegistry, loadRegistry } = makeRegistry();
      jobs.set('j1', { id: 'j1', status: 'completed', filename: 'x.xlsx',
        filePath: '/x.xlsx', error: null, progress: { done: 1, total: 1 },
        createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        cancelFlag: { cancelled: false } });
      const dst = saveRegistry(dir);

      const { jobs: j2, loadRegistry: l2 } = makeRegistry();
      l2(dst);
      assert.ok(typeof j2.get('j1').cancelFlag === 'object', 'cancelFlag should be restored');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── jobToApi ──────────────────────────────────────────────────────────────────
// Inline jobToApi (same logic as server.js).
function jobToApi(job) {
  const { cancelFlag, watchdogId, filePath, ...pub } = job; // eslint-disable-line no-unused-vars
  return pub;
}

describe('jobToApi()', () => {
  const BASE = {
    id: 'test-id', status: 'completed', filename: 'r.xlsx',
    filePath: '/data/r.xlsx', error: null,
    progress: { done: 2, total: 2 },
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:01:00Z',
    cancelFlag: { cancelled: false },
    watchdogId: 99,
  };

  test('strips cancelFlag from output', () => {
    assert.ok(!('cancelFlag' in jobToApi({ ...BASE })));
  });

  test('strips watchdogId from output', () => {
    assert.ok(!('watchdogId' in jobToApi({ ...BASE })));
  });

  test('strips filePath from output', () => {
    assert.ok(!('filePath' in jobToApi({ ...BASE })));
  });

  test('preserves id, status, filename, progress, createdAt, updatedAt', () => {
    const out = jobToApi({ ...BASE });
    assert.equal(out.id,        'test-id');
    assert.equal(out.status,    'completed');
    assert.equal(out.filename,  'r.xlsx');
    assert.equal(out.createdAt, '2024-01-01T00:00:00Z');
    assert.equal(out.updatedAt, '2024-01-01T00:01:00Z');
    assert.deepEqual(out.progress, { done: 2, total: 2 });
  });
});

// ── Report generation pre-flight logic ───────────────────────────────────────
// Inline the limit-check logic from the generate endpoint and generateReport().

function checkReportLimit(jobs, MAX_REPORTS) {
  const completedCount = jobs.filter(j => j.status === 'completed').length;
  const runningCount   = jobs.filter(j => j.status === 'running'  ).length;
  const total          = completedCount + runningCount;
  if (total >= MAX_REPORTS) return { limitReached: true, completedCount, runningCount };
  return { limitReached: false, completedCount, runningCount };
}

describe('Report limit check', () => {
  const MAX = 10;

  test('returns limitReached:false when no jobs exist', () => {
    assert.equal(checkReportLimit([], MAX).limitReached, false);
  });

  test('returns limitReached:false when total is exactly MAX-1', () => {
    const jobs = Array.from({ length: MAX - 1 }, (_, i) => ({ status: 'completed', id: `${i}` }));
    assert.equal(checkReportLimit(jobs, MAX).limitReached, false);
  });

  test('returns limitReached:true when completed alone equals MAX', () => {
    const jobs = Array.from({ length: MAX }, () => ({ status: 'completed' }));
    assert.equal(checkReportLimit(jobs, MAX).limitReached, true);
  });

  test('returns limitReached:true when running + completed equals MAX', () => {
    const jobs = [
      ...Array.from({ length: 7 }, () => ({ status: 'completed' })),
      ...Array.from({ length: 3 }, () => ({ status: 'running' })),
    ];
    assert.equal(checkReportLimit(jobs, MAX).limitReached, true);
  });

  test('failed jobs do not count toward the limit', () => {
    const jobs = [
      ...Array.from({ length: MAX - 1 }, () => ({ status: 'completed' })),
      ...Array.from({ length: 5 },       () => ({ status: 'failed' })),
    ];
    assert.equal(checkReportLimit(jobs, MAX).limitReached, false);
  });

  test('reports correct completedCount and runningCount', () => {
    const jobs = [
      { status: 'completed' }, { status: 'completed' },
      { status: 'running' },
      { status: 'failed' },
    ];
    const result = checkReportLimit(jobs, MAX);
    assert.equal(result.completedCount, 2);
    assert.equal(result.runningCount,   1);
  });
});

// ── fetchAllFindings URL construction ─────────────────────────────────────────
// Test the URL-building logic inline (independent of actual HTTP calls).

const FINDINGS_PAGE_SIZE_TEST = 200;

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
