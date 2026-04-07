// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Unit tests for violation-cache/server.js utilities.
// Run with: node --test violation-cache/server.test.js
// Requires Node 18+ (built-in node:test runner — zero npm dependencies).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

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
