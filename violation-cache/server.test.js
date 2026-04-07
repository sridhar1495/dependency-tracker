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
    // Simulate by passing a directory path as the file (read will fail)
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
});

// ── API key sanitisation ──────────────────────────────────────────────────────
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
});
