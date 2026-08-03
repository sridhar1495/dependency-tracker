// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Installer tests — the uninstall contract.
//
//   node --test violation-cache/installer.test.js
//
// These run offline and need no Docker: install.sh is executed against a
// throwaway copy of the repository with a stub `docker` on PATH, so the
// destructive paths can be exercised safely (CLAUDE.md §10.2, §10.3).
//
// The behaviour under test is the one that loses people's data when it is
// wrong: a plain uninstall must keep the database directory, and only the
// explicit full uninstall may delete it.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT   = path.join(__dirname, '..');
const INSTALL_SH  = path.join(REPO_ROOT, 'install.sh');

let sandbox;

/**
 * A throwaway repository containing just enough for the uninstall path:
 * install.sh, a compose file, and populated data directories.
 */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-installer-'));

  fs.copyFileSync(INSTALL_SH, path.join(dir, 'install.sh'));
  fs.chmodSync(path.join(dir, 'install.sh'), 0o755);
  fs.copyFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
  fs.writeFileSync(path.join(dir, '.env'), 'POSTGRES_PASSWORD=sandbox\nSECRET_ENCRYPTION_KEY=x\n');

  fs.mkdirSync(path.join(dir, 'violation-cache', 'pgdata'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'violation-cache', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'violation-cache', 'pgdata', 'PG_VERSION'), '16\n');
  fs.writeFileSync(path.join(dir, 'violation-cache', 'data', 'admin-credentials.json'), '{}');

  // A stub `docker` that satisfies `docker compose version` and records the
  // arguments every invocation received, so the test can assert on the flags.
  const binDir = path.join(dir, 'stubbin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'docker'), [
    '#!/usr/bin/env bash',
    `echo "$@" >> "${path.join(dir, 'docker-calls.log')}"`,
    'if [[ "$1" == "compose" && "$2" == "version" ]]; then echo "v2.0.0"; exit 0; fi',
    'exit 0',
  ].join('\n'));
  fs.chmodSync(path.join(binDir, 'docker'), 0o755);

  return dir;
}

/** Run install.sh in the sandbox. Returns { status, stdout }. */
function runInstaller(args, { input = '' } = {}) {
  const binDir = path.join(sandbox, 'stubbin');
  try {
    const stdout = execFileSync('bash', [path.join(sandbox, 'install.sh'), ...args], {
      cwd: sandbox,
      input,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: (err.stdout || '') + (err.stderr || '') };
  }
}

const exists = (...p) => fs.existsSync(path.join(sandbox, ...p));
const dockerCalls = () => {
  const f = path.join(sandbox, 'docker-calls.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

describe('install.sh --uninstall — keeps every byte of data', () => {
  beforeEach(() => { sandbox = makeSandbox(); });
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

  test('the database directory survives', () => {
    const r = runInstaller(['--uninstall', '--non-interactive']);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(exists('violation-cache', 'pgdata', 'PG_VERSION'),
      'the database must still be on disk after a plain uninstall');
  });

  test('the administrator credentials file and .env survive', () => {
    runInstaller(['--uninstall', '--non-interactive']);
    assert.ok(exists('violation-cache', 'data', 'admin-credentials.json'));
    assert.ok(exists('.env'));
  });

  test('docker compose down is called WITHOUT -v', () => {
    // -v removes volumes. At this level nothing on disk may be discarded, so
    // the flag would state the opposite of the intent.
    runInstaller(['--uninstall', '--non-interactive']);
    const calls = dockerCalls();
    assert.match(calls, /compose .*down/, 'compose down should have run');
    assert.doesNotMatch(calls, /down .*-v/, '-v must not be passed on a plain uninstall');
    assert.doesNotMatch(calls, /--rmi/, 'images are kept on a plain uninstall');
  });

  test('the banner tells the operator the data is kept', () => {
    const r = runInstaller(['--uninstall', '--non-interactive']);
    assert.match(r.stdout, /Your data is KEPT/);
    assert.match(r.stdout, /pgdata/);
  });

  test('answering anything but y aborts and touches nothing', () => {
    const r = runInstaller(['--uninstall'], { input: 'n\n' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Aborted/);
    assert.equal(dockerCalls().includes('down'), false, 'nothing may be removed after an abort');
    assert.ok(exists('violation-cache', 'pgdata', 'PG_VERSION'));
  });
});

describe('install.sh --all — deletes the data directories', () => {
  beforeEach(() => { sandbox = makeSandbox(); });
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

  test('the database and credentials directories are removed', () => {
    const r = runInstaller(['--all', '--non-interactive']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(exists('violation-cache', 'pgdata'), false, 'the database directory must be gone');
    assert.equal(exists('violation-cache', 'data'), false, 'the credentials directory must be gone');
  });

  test('images and volumes are removed too', () => {
    runInstaller(['--all', '--non-interactive']);
    const calls = dockerCalls();
    assert.match(calls, /down .*-v/);
    assert.match(calls, /--rmi all/);
  });

  test('.env is deliberately kept, and the banner says so', () => {
    const r = runInstaller(['--all', '--non-interactive']);
    assert.ok(exists('.env'), 'the generated secrets are not silently destroyed');
    assert.match(r.stdout, /\.env was kept/);
  });

  test('interactively it demands the word DELETE', () => {
    const r = runInstaller(['--all'], { input: 'y\n' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Aborted/, 'a plain "y" must not be enough to wipe the database');
    assert.ok(exists('violation-cache', 'pgdata', 'PG_VERSION'), 'nothing may be deleted after an abort');
    assert.equal(dockerCalls().includes('down'), false);
  });

  test('typing DELETE goes through', () => {
    const r = runInstaller(['--all'], { input: 'DELETE\n' });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(exists('violation-cache', 'pgdata'), false);
  });

  test('the banner names exactly what is destroyed', () => {
    const r = runInstaller(['--all'], { input: 'nope\n' });
    assert.match(r.stdout, /FULL UNINSTALL/);
    assert.match(r.stdout, /pgdata/);
    assert.match(r.stdout, /every user account, setting, schedule and report/);
    assert.match(r.stdout, /admin/i);
  });
});

describe('install.sh --help', () => {
  beforeEach(() => { sandbox = makeSandbox(); });
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

  test('documents both uninstall levels and their data impact', () => {
    const r = runInstaller(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--uninstall/);
    assert.match(r.stdout, /KEEPS all data/);
    assert.match(r.stdout, /--all/);
    assert.match(r.stdout, /DELETE the/);
  });
});
