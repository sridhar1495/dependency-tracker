#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Documentation screenshots ────────────────────────────────────────────────
//   TEST_DATABASE_URL=postgres://… node docs/screenshots.js
//
// Regenerates the PNGs in docs/images/ that README.md and the integration guide
// embed. Like docs/perf-check.js this is a tool, not a test tier (CLAUDE.md
// §10.2): nothing runs it automatically and it is not wired into CI.
//
// **Every pixel comes from e2e/dt-stub.js.** It boots the same assembled stack
// e2e.test.js does — the real server.js as a child process, a real PostgreSQL,
// the real pages — with DependencyTrack and SMTP stubbed. The portfolio,
// findings, policy violations and dependency graph in these images are the
// stub's synthetic fixtures ("Group 1", "service-101", "carrier-for-…"), so a
// screenshot can never leak a real project name, a real CVE against somebody's
// product, or anything from an operator's own DependencyTrack. That is the
// whole reason this drives the stub rather than a live instance, and it is the
// property to preserve if this file is ever extended.
//
// It DESTROYS the contents of the database TEST_DATABASE_URL points at, for the
// same reason the end-to-end tier does. Point it at a throwaway.

const fs   = require('fs');
const path = require('path');

const stackLib = require('../violation-cache/e2e/stack');
const { makeClient, resolvePlaywright, chromiumPath } = require('../violation-cache/e2e/client');

const OUT_DIR  = path.join(__dirname, 'images');
const PASSWORD = 'screenshot-account-pw';
const VIEWPORT = { width: 1500, height: 950 };

// A demo account, not an operator's. The name appears in the header chip of
// every screenshot, so it is deliberately obvious that this is a fixture.
const DEMO = {
  loginId: 'demo', email: 'demo@example.com',
  firstName: 'Demo', lastName: 'User', password: PASSWORD,
};

function log(msg) { process.stdout.write(`${msg}\n`); }

async function shoot(page, name, opts = {}) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ file: undefined, path: file, ...opts });
  log(`  wrote docs/images/${name}.png`);
}

async function main() {
  if (!process.env.TEST_DATABASE_URL) {
    console.error('TEST_DATABASE_URL is required — and its database WILL be destroyed.');
    process.exit(2);
  }
  const playwright = resolvePlaywright();
  if (!playwright) {
    console.error('Playwright is not resolvable. npm install -g --no-save playwright && npx playwright install chromium');
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  log('Booting the stubbed stack…');
  const stack = await stackLib.start();
  const api   = makeClient(stack.url);
  let browser;

  try {
    const token = await api.signUp(DEMO);
    await api.saveConnection(token, { apiUrl: stack.dt.url, apiKey: stack.dt.apiKey });
    await api.post('/violation-cache/refresh', {}, token);
    await api.waitForCache(token);

    // Seed a few days of history with deliberate gaps, so the trend panel shows
    // the carry-forward drawing (Q23) rather than a single lonely point.
    const sql = require('../violation-cache/e2e/client').makeSql(stack.databaseUrl);
    const [{ fingerprint }] = await sql(
      `SELECT fingerprint FROM dt_connections WHERE fingerprint IS NOT NULL LIMIT 1`);
    for (const [daysAgo, crit] of [[6, 5], [5, 7], [3, 4], [1, 6], [0, 6]]) {
      await sql(
        `INSERT INTO risk_snapshots
           (fingerprint, day, root_project_count, sev_critical, sev_high, sev_medium,
            sev_low, sev_unassigned, ops_fail, ops_warn, ops_info,
            lic_fail, lic_warn, lic_info, secpol_fail, secpol_warn, secpol_info)
         VALUES ($1, CURRENT_DATE - $2::int, 3, $3, 12, 20, 5, 2, 6, 3, 0, 3, 0, 9, 3, 6, 0)
         ON CONFLICT (fingerprint, day) DO NOTHING`, [fingerprint, daysAgo, crit]);
    }
    await api.post('/auth/logout', {}, token);

    browser = await playwright.chromium.launch({ executablePath: chromiumPath() });
    const page = await browser.newPage({ viewport: VIEWPORT });

    // ── 1. Sign-in ──────────────────────────────────────────────────────────
    log('Capturing…');
    await page.goto(`${stack.url}/login.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900); // let the decorative background settle
    await shoot(page, 'login');

    // ── 2. The dashboard ────────────────────────────────────────────────────
    await page.locator('#liLoginId').fill(DEMO.loginId);
    await page.locator('#liPassword').fill(DEMO.password);
    await page.locator('#liSubmit').click();
    await page.waitForTimeout(2500);
    if (await page.locator('#sessionModal').isVisible().catch(() => false)) {
      await page.locator('#sessionModal .btn.primary').first().click();
      await page.waitForTimeout(2500);
    }
    await page.waitForSelector('#tableBody tr', { timeout: 30_000 });
    await page.waitForTimeout(1200);
    await shoot(page, 'dashboard');

    // ── 3. The risk trend, on its own ───────────────────────────────────────
    const trend = page.locator('#trendPanel');
    if (await trend.count()) await shoot(page, 'risk-trend', { clip: await trend.boundingBox() });

    // ── 4. The findings dialog, with Origin and resolved paths ──────────────
    // The toggle is what makes this image worth having: it is the one view that
    // shows Direct/Transitive and the chain behind a transitive finding.
    await page.locator('.vuln-eye-btn').first().click();
    await page.waitForSelector('#vulnDialogRows tr', { timeout: 30_000 });
    await page.locator('#vulnDepPathToggle').click();
    await page.waitForSelector('.dep-path-chain', { timeout: 60_000 });
    await page.waitForTimeout(500);
    await shoot(page, 'findings-dialog');
    await page.locator('#vulnDialog .modal-close').click();
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      for (let el = document.getElementById('trendCharts'); el; el = el.parentElement) {
        if (el.scrollTop) el.scrollTop = 0;
      }
    });

    // ── 5. Settings ─────────────────────────────────────────────────────────
    await page.click('#settingsBtn');
    await page.waitForTimeout(900);
    await shoot(page, 'settings');
    await page.locator('.cfg-close').first().click();
    await page.waitForTimeout(500);

    // ── 6. Administration ───────────────────────────────────────────────────
    const admin = await browser.newPage({ viewport: VIEWPORT });
    const adminLogin = await api.post('/auth/login',
      { loginId: stack.admin.loginId, password: stack.admin.password, isAdmin: true, force: true });
    if (adminLogin.json && adminLogin.json.token) {
      await admin.goto(`${stack.url}/login.html`, { waitUntil: 'domcontentloaded' });
      await admin.evaluate((t) => localStorage.setItem('dt_session_token', t), adminLogin.json.token);
      await admin.goto(`${stack.url}/admin.html`, { waitUntil: 'networkidle' });
      await admin.waitForTimeout(2000);
      await shoot(admin, 'administration');
    } else {
      log('  (skipped administration — the credentials file was not available)');
    }

    log('Done. Every image above is stub data.');
  } finally {
    if (browser) await browser.close();
    await stack.stop();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
