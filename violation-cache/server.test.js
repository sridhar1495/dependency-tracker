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

// ── GET /violation-cache/config response shape ─────────────────────────────────
// Tests for the logic that drives the GET endpoint: getEffectiveConfig() is the
// source of truth — the endpoint just wraps it.  We verify the three scenarios
// that matter for the dashboard's key-priority logic.
describe('GET /violation-cache/config — effective key scenarios', () => {
  test('returns the .env key when one has been persisted (user-set takes priority over startup)', () => {
    const file = tmpFile('DT_API_KEY=user-saved-key\n');
    try {
      const cfg = getEffectiveConfig(file, 'http://dt:8080', 'startup-env-key');
      // .env key must win — this is what the GET endpoint returns
      assert.equal(cfg.apiKey, 'user-saved-key');
    } finally { cleanup(file); }
  });

  test('returns the startup key when .env exists but has no DT_API_KEY (install-time only)', () => {
    const file = tmpFile('DT_API_INTERNAL_URL=http://dt:8080\n');
    try {
      const cfg = getEffectiveConfig(file, 'http://dt:8080', 'startup-key');
      assert.equal(cfg.apiKey, 'startup-key');
    } finally { cleanup(file); }
  });

  test('returns empty string when neither .env key nor startup key is present (mock mode)', () => {
    const cfg = getEffectiveConfig('/nonexistent.env', '', '');
    assert.equal(cfg.apiKey, '');
  });

  test('persisted key survives a subsequent patchEnvFile update (round-trip)', () => {
    const file = tmpFile('DT_API_KEY=original-key\n');
    try {
      patchEnvFile(file, { DT_API_KEY: 'updated-key' });
      const cfg = getEffectiveConfig(file, 'http://dt:8080', 'startup-key');
      assert.equal(cfg.apiKey, 'updated-key');
    } finally { cleanup(file); }
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

// ── jobToApi includes riskTypes ───────────────────────────────────────────────
// Verify jobToApi (already tested above) correctly passes through riskTypes.

describe('jobToApi() with riskTypes field', () => {
  test('riskTypes is included in API output', () => {
    const job = {
      id: 'j1', status: 'completed', filename: 'r.xlsx',
      filePath: '/data/r.xlsx', error: null,
      riskTypes: ['security', 'license'],
      progress: { done: 2, total: 2 },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:01:00Z',
      cancelFlag: { cancelled: false },
      watchdogId: 1,
    };
    const out = jobToApi(job);
    assert.deepEqual(out.riskTypes, ['security', 'license']);
  });

  test('riskTypes for security-only job is preserved', () => {
    const job = {
      id: 'j2', status: 'running', filename: null,
      filePath: null, error: null,
      riskTypes: ['security'],
      progress: { done: 0, total: 3 },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      cancelFlag: { cancelled: false },
    };
    assert.deepEqual(jobToApi(job).riskTypes, ['security']);
  });

  test('job without riskTypes (legacy) returns undefined riskTypes gracefully', () => {
    const job = {
      id: 'j3', status: 'completed', filename: 'old.xlsx',
      filePath: '/data/old.xlsx', error: null,
      progress: { done: 1, total: 1 },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:01:00Z',
      cancelFlag: { cancelled: false },
    };
    const out = jobToApi(job);
    assert.equal(out.riskTypes, undefined);
    assert.equal(out.id, 'j3');  // other fields still present
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

// ── deepMerge ─────────────────────────────────────────────────────────────────
function deepMerge(target, source) {
  const out = JSON.parse(JSON.stringify(target));
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = out[key];
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)
        && tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

describe('deepMerge()', () => {
  test('shallow key override', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 99 });
    assert.equal(result.a, 1);
    assert.equal(result.b, 99);
  });

  test('nested object merge does not replace sibling keys', () => {
    const target = { mail: { host: 'old', port: 25, user: 'u' } };
    const source = { mail: { host: 'new' } };
    const result = deepMerge(target, source);
    assert.equal(result.mail.host, 'new');
    assert.equal(result.mail.port, 25);
    assert.equal(result.mail.user, 'u');
  });

  test('array in source replaces array in target (no element-level merge)', () => {
    const result = deepMerge({ tags: ['a', 'b'] }, { tags: ['x'] });
    assert.deepEqual(result.tags, ['x']);
  });

  test('does not mutate target', () => {
    const target = { a: { b: 1 } };
    deepMerge(target, { a: { b: 2 } });
    assert.equal(target.a.b, 1);
  });

  test('null source value replaces object target value', () => {
    const result = deepMerge({ a: { x: 1 } }, { a: null });
    assert.equal(result.a, null);
  });

  test('adds keys present only in source', () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    assert.equal(result.a, 1);
    assert.equal(result.b, 2);
  });

  test('deeply nested three levels', () => {
    const target = { a: { b: { c: 1, d: 2 } } };
    const source = { a: { b: { c: 99 } } };
    const result = deepMerge(target, source);
    assert.equal(result.a.b.c, 99);
    assert.equal(result.a.b.d, 2);
  });
});

// ── sanitiseConfigForClient ───────────────────────────────────────────────────
function sanitiseConfigForClient(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (out.mail && out.mail.smtp) {
    out.mail.smtp.pass = out.mail.smtp.pass ? '••••••••' : '';
  }
  return out;
}

describe('sanitiseConfigForClient()', () => {
  test('masks a non-empty smtp.pass with bullet placeholder', () => {
    const cfg = { mail: { smtp: { host: 'smtp.example.com', pass: 's3cr3t' } } };
    const out = sanitiseConfigForClient(cfg);
    assert.equal(out.mail.smtp.pass, '••••••••');
  });

  test('leaves smtp.pass empty string when not set', () => {
    const cfg = { mail: { smtp: { pass: '' } } };
    const out = sanitiseConfigForClient(cfg);
    assert.equal(out.mail.smtp.pass, '');
  });

  test('does not mutate the original config', () => {
    const cfg = { mail: { smtp: { pass: 'secret' } } };
    sanitiseConfigForClient(cfg);
    assert.equal(cfg.mail.smtp.pass, 'secret');
  });

  test('preserves all other fields unchanged', () => {
    const cfg = {
      maxReports: 5,
      mail: { enabled: true, smtp: { host: 'smtp.test', port: 587, pass: 'x' }, from: 'a@b.com' },
    };
    const out = sanitiseConfigForClient(cfg);
    assert.equal(out.maxReports, 5);
    assert.equal(out.mail.enabled, true);
    assert.equal(out.mail.smtp.host, 'smtp.test');
    assert.equal(out.mail.smtp.port, 587);
    assert.equal(out.mail.from, 'a@b.com');
  });

  test('handles config with no mail section', () => {
    const cfg = { maxReports: 10, schedule: { enabled: false } };
    const out = sanitiseConfigForClient(cfg);
    assert.equal(out.maxReports, 10);
    assert.equal(out.schedule.enabled, false);
  });
});

// ── loadConfig / saveConfig ───────────────────────────────────────────────────
const DEFAULT_CONFIG_TEST = {
  maxReports: 10,
  mail: {
    enabled: false,
    smtp:    { host: '', port: 587, secure: false, user: '', pass: '' },
    from:    '',
    to:      [],
    cc:      [],
    subject: '',
    body:    '',
  },
  schedule: {
    enabled:             false,
    frequency:           'daily',
    hour:                9,
    weekDays:            [1],
    monthDay:            1,
    projectUuids:        [],
    riskTypes:           ['security', 'license', 'operational'],
    lastRun:             null,
    lastRunStatus:       null,
    lastRunError:        null,
    nextRun:             null,
    failureNotification: null,
  },
};

function loadConfigTest(configFile) {
  try {
    if (fs.existsSync(configFile)) {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      return deepMerge(DEFAULT_CONFIG_TEST, raw);
    }
  } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG_TEST));
}

function saveConfigTest(cfg, configFile, tmpFile2) {
  fs.writeFileSync(tmpFile2, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmpFile2, configFile);
}

describe('loadConfig / saveConfig', () => {
  let cfgFile, cfgTmp;
  beforeEach(() => {
    const base = path.join(os.tmpdir(), `dt-appcfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cfgFile = `${base}.json`;
    cfgTmp  = `${base}.tmp.json`;
  });
  afterEach(() => {
    try { fs.unlinkSync(cfgFile); } catch (_) {}
    try { fs.unlinkSync(cfgTmp);  } catch (_) {}
  });

  test('returns defaults when file does not exist', () => {
    const cfg = loadConfigTest(cfgFile);
    assert.equal(cfg.maxReports, 10);
    assert.equal(cfg.mail.enabled, false);
    assert.equal(cfg.schedule.enabled, false);
    assert.equal(cfg.schedule.frequency, 'daily');
  });

  test('saves and reloads config round-trip', () => {
    const cfg = loadConfigTest(cfgFile);
    cfg.maxReports = 25;
    cfg.mail.enabled = true;
    cfg.mail.from = 'test@example.com';
    saveConfigTest(cfg, cfgFile, cfgTmp);
    const loaded = loadConfigTest(cfgFile);
    assert.equal(loaded.maxReports, 25);
    assert.equal(loaded.mail.enabled, true);
    assert.equal(loaded.mail.from, 'test@example.com');
  });

  test('merges partial user config with defaults (missing keys filled from defaults)', () => {
    fs.writeFileSync(cfgFile, JSON.stringify({ maxReports: 7 }), 'utf8');
    const cfg = loadConfigTest(cfgFile);
    assert.equal(cfg.maxReports, 7);
    assert.equal(cfg.mail.smtp.port, 587);   // default filled in
    assert.deepEqual(cfg.schedule.weekDays, [1]);  // default weekDays
  });

  test('persists nested schedule config correctly', () => {
    const cfg = loadConfigTest(cfgFile);
    cfg.schedule.enabled = true;
    cfg.schedule.frequency = 'weekly';
    cfg.schedule.weekDays = [1, 3, 5];
    cfg.schedule.hour = 8;
    saveConfigTest(cfg, cfgFile, cfgTmp);
    const loaded = loadConfigTest(cfgFile);
    assert.equal(loaded.schedule.enabled, true);
    assert.equal(loaded.schedule.frequency, 'weekly');
    assert.deepEqual(loaded.schedule.weekDays, [1, 3, 5]);
    assert.equal(loaded.schedule.hour, 8);
  });

  test('handles corrupted JSON by returning defaults', () => {
    fs.writeFileSync(cfgFile, '{ invalid json !!!', 'utf8');
    const cfg = loadConfigTest(cfgFile);
    assert.equal(cfg.maxReports, 10);
  });

  test('write is atomic (tmp file used then renamed)', () => {
    const cfg = loadConfigTest(cfgFile);
    saveConfigTest(cfg, cfgFile, cfgTmp);
    assert.ok(fs.existsSync(cfgFile), 'config file should exist after save');
    assert.ok(!fs.existsSync(cfgTmp), 'tmp file should be gone after rename');
  });
});

// ── calcNextRun ───────────────────────────────────────────────────────────────
function calcNextRun(schedule) {
  const now = new Date();
  if (schedule.frequency === 'daily') {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), schedule.hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }
  if (schedule.frequency === 'weekly') {
    const targetDays = (schedule.weekDays || [1]).sort((a, b) => a - b);
    for (let d = 1; d <= 8; d++) {
      const candidate = new Date(
        now.getFullYear(), now.getMonth(), now.getDate() + d, schedule.hour, 0, 0, 0
      );
      if (targetDays.includes(candidate.getDay())) return candidate;
    }
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, schedule.hour, 0, 0, 0);
  }
  if (schedule.frequency === 'monthly') {
    const day  = Math.min(schedule.monthDay || 1, 28);
    let next   = new Date(now.getFullYear(), now.getMonth(), day, schedule.hour, 0, 0, 0);
    if (next <= now) next = new Date(now.getFullYear(), now.getMonth() + 1, day, schedule.hour, 0, 0, 0);
    return next;
  }
  return new Date(now.getTime() + 24 * 3_600_000);
}

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
