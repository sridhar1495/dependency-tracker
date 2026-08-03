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

/**
 * Can we allocate a pty with GNU `script`?
 *
 * Needed because bash only shows a `read -p` prompt on a terminal. util-linux
 * ships it on every Linux including the CI image; BSD/macOS `script` takes
 * different flags, so there the interactive suites skip rather than fail — the
 * static checks below still run everywhere.
 */
const PTY = (() => {
  try {
    execFileSync('script', ['-qec', 'true', '/dev/null'], { stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
})();
const NO_PTY = !PTY && 'GNU `script` is unavailable — cannot drive the prompts';

let sandbox;

/**
 * A throwaway repository containing just enough for the uninstall path:
 * install.sh, a compose file, and populated data directories.
 */
function makeSandbox({ fresh = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-installer-'));

  fs.copyFileSync(INSTALL_SH, path.join(dir, 'install.sh'));
  fs.chmodSync(path.join(dir, 'install.sh'), 0o755);
  fs.copyFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
  fs.copyFileSync(path.join(REPO_ROOT, '.env.example'), path.join(dir, '.env.example'));

  // The installer hashes the administrator password with the service's own
  // crypto module, so a fresh-install run needs it present.
  fs.mkdirSync(path.join(dir, 'violation-cache', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'violation-cache', 'lib', 'crypto.js'),
                  path.join(dir, 'violation-cache', 'lib', 'crypto.js'));

  if (fresh) {
    // No .env, no data directories: exactly what a first install sees.
    fs.mkdirSync(path.join(dir, 'stubbin'));
    writeDockerStub(dir);
    return dir;
  }

  fs.writeFileSync(path.join(dir, '.env'), 'POSTGRES_PASSWORD=sandbox\nSECRET_ENCRYPTION_KEY=x\n');
  fs.mkdirSync(path.join(dir, 'violation-cache', 'pgdata'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'violation-cache', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'violation-cache', 'pgdata', 'PG_VERSION'), '16\n');
  fs.writeFileSync(path.join(dir, 'violation-cache', 'data', 'admin-credentials.json'), '{}');

  fs.mkdirSync(path.join(dir, 'stubbin'));
  writeDockerStub(dir);
  return dir;
}

/**
 * A stub `docker` that satisfies `docker compose version`, reports a recent
 * server version, and records every invocation so the tests can assert on the
 * flags actually passed.
 */
function writeDockerStub(dir) {
  const bin = path.join(dir, 'stubbin', 'docker');
  fs.writeFileSync(bin, [
    '#!/usr/bin/env bash',
    `echo "$@" >> "${path.join(dir, 'docker-calls.log')}"`,
    'if [[ "$1" == "compose" && "$2" == "version" ]]; then echo "v2.0.0"; exit 0; fi',
    'if [[ "$1" == "version" ]]; then echo "26.0.0"; exit 0; fi',
    'exit 0',
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
}

// The installer colours its output. Assertions are about the words, not the
// escape codes, so strip them once here rather than in every test.
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Run install.sh in the sandbox. Returns { status, stdout } with ANSI removed.
 *
 * Driven through a pty (`script -qec`) rather than a plain pipe. Bash's
 * `read -p` displays its prompt ONLY when input comes from a terminal, so over
 * a pipe the prompts are invisible and a test could not tell "asked and
 * answered" from "never asked at all" — exactly the regression these tests
 * exist to catch. The pty also merges stderr, where `read` writes its prompts.
 */
function runInstaller(args, { input = '' } = {}) {
  const binDir = path.join(sandbox, 'stubbin');
  const command = ['bash', path.join(sandbox, 'install.sh'), ...args]
    .map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  try {
    const stdout = execFileSync('script', ['-qec', command, '/dev/null'], {
      cwd: sandbox,
      input,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout.replace(ANSI, '') };
  } catch (err) {
    return {
      status: err.status,
      stdout: ((err.stdout || '') + (err.stderr || '')).replace(ANSI, ''),
    };
  }
}

const exists = (...p) => fs.existsSync(path.join(sandbox, ...p));
const dockerCalls = () => {
  const f = path.join(sandbox, 'docker-calls.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

describe('install.sh --uninstall — keeps every byte of data', { skip: NO_PTY }, () => {
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

describe('install.sh --all — deletes the data directories', { skip: NO_PTY }, () => {
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

describe('install.sh — credential prompts on a first install', { skip: NO_PTY }, () => {
  beforeEach(() => { sandbox = makeSandbox({ fresh: true }); });
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

  /** Read the sandbox .env as a key→value map. */
  const env = () => Object.fromEntries(
    fs.readFileSync(path.join(sandbox, '.env'), 'utf8')
      .split('\n').filter(l => l.includes('='))
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  // Prompt order: dashboard port, PostgreSQL username, password, database,
  // administrator login ID, administrator password.
  const answers = (a) => a.join('\n') + '\n';

  test('pressing Enter through every prompt takes the documented defaults', () => {
    const r = runInstaller([], { input: answers(['', '', '', '', '', '']) });
    assert.equal(r.status, 0, r.stdout);
    const e = env();
    assert.equal(e.DT_DASHBOARD_PORT, '3000');
    assert.equal(e.POSTGRES_USER, 'dtdash');
    assert.equal(e.POSTGRES_DB, 'dtdash');
    assert.ok(e.POSTGRES_PASSWORD && e.POSTGRES_PASSWORD.length >= 16,
      'a password must be generated when none is given');
    assert.ok(/^[0-9a-f]{64}$/.test(e.SECRET_ENCRYPTION_KEY),
      'the encryption key must be generated as 64 hex characters');
  });

  test('supplied PostgreSQL credentials are stored', () => {
    const r = runInstaller([], { input: answers(['3100', 'riskdb', 'Sup3rSecret!', 'riskdata', '', '']) });
    assert.equal(r.status, 0, r.stdout);
    const e = env();
    assert.equal(e.DT_DASHBOARD_PORT, '3100');
    assert.equal(e.POSTGRES_USER, 'riskdb');
    assert.equal(e.POSTGRES_PASSWORD, 'Sup3rSecret!');
    assert.equal(e.POSTGRES_DB, 'riskdata');
  });

  test('the summary prints both credential sets so they can be recorded', () => {
    const r = runInstaller([], { input: answers(['', 'riskdb', 'Sup3rSecret!', 'riskdata', 'ops', 'Adm1nPass!']) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /Credentials — record these now/);
    // Administrator
    assert.match(r.stdout, /Username : ops/);
    assert.match(r.stdout, /Password : Adm1nPass!/);
    // PostgreSQL
    assert.match(r.stdout, /Database : riskdata/);
    assert.match(r.stdout, /Username : riskdb/);
    assert.match(r.stdout, /Password : Sup3rSecret!/);
  });

  test('the summary says where each value can be found later', () => {
    const r = runInstaller([], { input: answers(['', '', '', '', '', '']) });
    assert.match(r.stdout, /Where to find these later/);
    assert.match(r.stdout, /grep \^POSTGRES_/);
    assert.match(r.stdout, /grep loginId/);
    // The administrator password genuinely cannot be recovered, and saying so
    // is more useful than implying it can.
    assert.match(r.stdout, /only its scrypt hash is stored/);
    assert.match(r.stdout, /re-run this installer/);
    assert.match(r.stdout, /Back up/);
  });

  test('the administrator password is hashed, never stored in the clear', () => {
    const r = runInstaller([], { input: answers(['', '', '', '', 'ops', 'Adm1nPass!']) });
    assert.equal(r.status, 0, r.stdout);
    const creds = fs.readFileSync(
      path.join(sandbox, 'violation-cache', 'data', 'admin-credentials.json'), 'utf8');
    assert.match(creds, /"loginId": "ops"/);
    assert.match(creds, /"passwordHash": "scrypt\$16384\$8\$1\$/);
    assert.doesNotMatch(creds, /Adm1nPass!/, 'the plaintext must never reach the file');
    assert.equal(
      (fs.statSync(path.join(sandbox, 'violation-cache', 'data', 'admin-credentials.json')).mode & 0o777),
      0o600, 'the credentials file must be owner-only');
  });

  test('the default administrator password is used and named when none is given', () => {
    const r = runInstaller([], { input: answers(['', '', '', '', '', '']) });
    assert.match(r.stdout, /Password : ScaAdmin@dt8624/);
    assert.match(r.stdout, /the documented default/);
  });

  test('.env is not world-readable once it holds secrets', () => {
    runInstaller([], { input: answers(['', '', '', '', '', '']) });
    assert.equal(fs.statSync(path.join(sandbox, '.env')).mode & 0o777, 0o600);
  });
});

describe('install.sh — an existing database is still asked about, then protected', { skip: NO_PTY }, () => {
  beforeEach(() => { sandbox = makeSandbox(); });   // pgdata already populated
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

  const envText = () => fs.readFileSync(path.join(sandbox, '.env'), 'utf8');

  // Prompt order with an existing database and an existing administrator file:
  // port, pg user, pg password, pg database, [confirm if changed], reset admin?
  const answers = (a) => a.join('\n') + '\n';

  test('the credentials are still offered, not silently skipped', () => {
    // Skipping the questions leaves an operator wondering why they were never
    // asked. They are shown, with the current values as defaults.
    const r = runInstaller([], { input: answers(['', '', '', '', '']) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /PostgreSQL username/);
    assert.match(r.stdout, /PostgreSQL password/);
    assert.match(r.stdout, /PostgreSQL database name/);
    assert.match(r.stdout, /An existing database was found/);
  });

  test('pressing Enter through them changes nothing and warns about nothing', () => {
    const r = runInstaller([], { input: answers(['', '', '', '', '']) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(envText(), /POSTGRES_PASSWORD=sandbox/, 'the stored password survives');
    assert.doesNotMatch(r.stdout, /Write the new values anyway/,
      'an unchanged answer must not trigger the confirmation');
  });

  test('changing a value is challenged, and declining reverts it', () => {
    // PostgreSQL reads these only at cluster initialisation, so writing a new
    // one against an existing database would break the connection.
    const r = runInstaller([], { input: answers(['', 'newuser', '', '', 'n', '']) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /You changed the PostgreSQL username/);
    assert.match(r.stdout, /would keep its old values and the service would fail to connect/);
    assert.match(r.stdout, /permanently erases every account, setting and report/);
    assert.match(r.stdout, /Keeping the existing database credentials/);
    assert.doesNotMatch(envText(), /POSTGRES_USER=newuser/, 'the change must not be written');
  });

  test('confirming the change writes it, with the consequence stated', () => {
    const r = runInstaller([], { input: answers(['', 'newuser', '', '', 'y', '']) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /will not start until .*pgdata is deleted/);
    assert.match(envText(), /POSTGRES_USER=newuser/);
  });

  test('a changed database name is challenged too', () => {
    const r = runInstaller([], { input: answers(['', '', '', 'otherdb', 'n', '']) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /You changed the PostgreSQL database name/);
    assert.doesNotMatch(envText(), /POSTGRES_DB=otherdb/);
  });
});

describe('install.sh — an existing administrator can be reset', { skip: NO_PTY }, () => {
  beforeEach(() => {
    sandbox = makeSandbox();
    fs.writeFileSync(
      path.join(sandbox, 'violation-cache', 'data', 'admin-credentials.json'),
      JSON.stringify({ loginId: 'existing-admin', passwordHash: 'scrypt$16384$8$1$a$b' }));
  });
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

  const creds = () => fs.readFileSync(
    path.join(sandbox, 'violation-cache', 'data', 'admin-credentials.json'), 'utf8');
  const answers = (a) => a.join('\n') + '\n';

  test('a reset is offered rather than the question being skipped', () => {
    // Unlike the database credentials this one is safe to change at any time:
    // it is a single file, and recreating it touches no account or report.
    const r = runInstaller([], { input: answers(['', '', '', '', 'n']) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /An administrator account already exists: existing-admin/);
    assert.match(r.stdout, /user accounts, settings/);
    assert.match(r.stdout, /Reset the administrator login ID and password\?/);
  });

  test('declining keeps the existing credentials and reports them by name', () => {
    const r = runInstaller([], { input: answers(['', '', '', '', 'n']) });
    assert.match(r.stdout, /Keeping the existing administrator credentials/);
    assert.match(creds(), /"loginId": ?"existing-admin"/, 'the file is untouched');
    assert.match(r.stdout, /Username : existing-admin/,
      'the summary reports the login ID from the file, not a guess');
    assert.match(r.stdout, /unchanged — the credentials file already existed/);
  });

  test('accepting replaces them with the new values', () => {
    const r = runInstaller([], { input: answers(['', '', '', '', 'y', 'newadmin', 'Br@ndNewPass1']) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /Resetting the administrator account/);
    assert.match(r.stdout, /Administrator account reset: newadmin/);
    assert.match(creds(), /"loginId": "newadmin"/);
    assert.match(creds(), /"passwordHash": "scrypt\$16384\$8\$1\$/);
    assert.doesNotMatch(creds(), /Br@ndNewPass1/, 'the plaintext never reaches the file');
    assert.match(r.stdout, /Username : newadmin/);
    assert.match(r.stdout, /Password : Br@ndNewPass1/, 'printed once so it can be recorded');
  });

  test('the reset prompt defaults to the existing login ID', () => {
    const r = runInstaller([], { input: answers(['', '', '', '', 'y', '', 'Br@ndNewPass1']) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /Administrator login ID       \[existing-admin\]/);
    assert.match(creds(), /"loginId": "existing-admin"/, 'Enter keeps the same name');
  });

  test('a non-interactive run never resets it', () => {
    // Automation must not silently invalidate the administrator credential.
    const r = runInstaller(['--non-interactive']);
    assert.equal(r.status, 0, r.stdout);
    assert.match(creds(), /"loginId": ?"existing-admin"/);
    assert.match(creds(), /scrypt\$16384\$8\$1\$a\$b/, 'the original hash is untouched');
  });
});

// ── Dockerfile and .dockerignore must agree ─────────────────────────────────
// A path the Dockerfile COPYs but .dockerignore excludes fails the build with
// "failed to compute cache key: ... not found". That happened for real when
// package-lock.json was added to the Dockerfile for `npm ci` while it was still
// listed in .dockerignore, and no test caught it because nothing here builds an
// image. This check is static, so it catches the whole class offline.
describe('Dockerfile and .dockerignore agree', () => {
  const svcDir     = path.join(REPO_ROOT, 'violation-cache');
  const dockerfile = fs.readFileSync(path.join(svcDir, 'Dockerfile'), 'utf8');
  const ignoreFile = fs.readFileSync(path.join(svcDir, '.dockerignore'), 'utf8');

  /** Source paths named by COPY lines, excluding the destination argument. */
  const copiedPaths = dockerfile
    .split('\n')
    .filter(l => /^\s*COPY\s/i.test(l))
    .flatMap(l => l.replace(/^\s*COPY\s+/i, '').trim().split(/\s+/).slice(0, -1));

  const ignorePatterns = ignoreFile
    .split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  /** Does an ignore pattern exclude this exact path? */
  const excludes = (pattern, filePath) => {
    const clean = filePath.replace(/\/$/, '');
    const pat   = pattern.replace(/\/$/, '');
    if (pat === clean) return true;
    if (pat.startsWith('*.')) return clean.endsWith(pat.slice(1));
    return false;
  };

  test('the Dockerfile COPYs at least the manifests and the source directories', () => {
    // Guards the guard: if COPY parsing silently returned nothing, every
    // assertion below would pass vacuously.
    assert.ok(copiedPaths.includes('package.json'), copiedPaths.join(', '));
    assert.ok(copiedPaths.includes('server.js'));
    for (const dir of ['db/', 'lib/', 'routes/']) {
      assert.ok(copiedPaths.includes(dir), `${dir} must be COPYed — ${copiedPaths.join(', ')}`);
    }
  });

  test('no COPYed path is excluded by .dockerignore', () => {
    for (const copied of copiedPaths) {
      for (const pattern of ignorePatterns) {
        assert.equal(excludes(pattern, copied), false,
          `Dockerfile COPYs "${copied}" but .dockerignore excludes it via "${pattern}" — ` +
          'the build will fail with "failed to compute cache key"');
      }
    }
  });

  test('npm ci has its lock file available in the build context', () => {
    // `npm ci` fails outright without package-lock.json, so this pair has to
    // stay consistent (CLAUDE.md §9.3).
    if (!/npm ci/.test(dockerfile)) return;
    assert.ok(copiedPaths.includes('package-lock.json'),
      'the Dockerfile runs `npm ci` but never COPYs package-lock.json');
    assert.ok(fs.existsSync(path.join(svcDir, 'package-lock.json')),
      'package-lock.json must be committed for `npm ci` to work');
    assert.equal(ignorePatterns.includes('package-lock.json'), false,
      '.dockerignore must not exclude the lock file that `npm ci` reads');
  });

  test('every backend directory in the repository is COPYed into the image', () => {
    // A new directory that nobody adds a COPY for is silently missing at
    // runtime rather than failing the build (CLAUDE.md §9.3).
    const backendDirs = fs.readdirSync(svcDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(n => !['node_modules', 'data', 'pgdata'].includes(n));
    for (const dir of backendDirs) {
      assert.ok(copiedPaths.includes(`${dir}/`) || copiedPaths.includes(dir),
        `violation-cache/${dir} exists but the Dockerfile never COPYs it`);
    }
  });
});

describe('install.sh --help', { skip: NO_PTY }, () => {
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
