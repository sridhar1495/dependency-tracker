#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Documentation screenshots ────────────────────────────────────────────────
//   TEST_DATABASE_URL=postgres://… node docs/screenshots.js
//
// Regenerates the PNGs in docs/images/ that README.md and docs/USER_GUIDE.md
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
// **It is one continuous journey, in the order the user guide tells it**: an
// account is registered through the page, signs in with nothing configured,
// adds its DependencyTrack connection, and only then sees a portfolio. Shooting
// the finished state and reconstructing the earlier screens afterwards would
// mean the "first run" image had to be faked; here it is simply what the
// product showed at that moment. The numbered sections below match the guide's
// own headings, so a guide section that gains a step has one obvious place to
// gain its picture.
//
// It DESTROYS the contents of the database TEST_DATABASE_URL points at, for the
// same reason the end-to-end tier does. Point it at a throwaway.

const fs   = require('fs');
const path = require('path');

const stackLib = require('../violation-cache/e2e/stack');
const { makeClient, makeSql, resolvePlaywright, chromiumPath } =
  require('../violation-cache/e2e/client');

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
  await page.screenshot({ path: file, ...opts });
  log(`  wrote docs/images/${name}.png`);
}

/** Screenshot one element, with a little breathing room around it. */
async function shootEl(page, selector, name, pad = 12) {
  const box = await page.locator(selector).boundingBox();
  if (!box) { log(`  (skipped ${name} — ${selector} is not visible)`); return; }
  await shoot(page, name, {
    clip: {
      x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
      width: Math.min(VIEWPORT.width - Math.max(0, box.x - pad), box.width + pad * 2),
      height: Math.min(VIEWPORT.height - Math.max(0, box.y - pad), box.height + pad * 2),
    },
  });
}

const pause = (page, ms) => page.waitForTimeout(ms);

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
  const sql   = makeSql(stack.databaseUrl);
  let browser;

  try {
    browser = await playwright.chromium.launch({ executablePath: chromiumPath() });
    const page = await browser.newPage({ viewport: VIEWPORT });

    // ── 1. Signing in for the first time ────────────────────────────────────
    log('1. Registration and sign-in');
    await page.goto(`${stack.url}/login.html`, { waitUntil: 'networkidle' });
    await pause(page, 900); // let the decorative background settle
    await shoot(page, 'login');

    await page.locator('#loginAlt button:has-text("Create an account")').click();
    await pause(page, 500);
    await page.locator('#rgFirstName').fill(DEMO.firstName);
    await page.locator('#rgLastName').fill(DEMO.lastName);
    await page.locator('#rgLoginId').fill(DEMO.loginId);
    await page.locator('#rgEmail').fill(DEMO.email);
    await page.locator('#rgPassword').fill(DEMO.password);
    await page.locator('#rgConfirm').fill(DEMO.password);
    await page.locator('#rgLoginId').blur();
    await pause(page, 800); // the availability check answers on blur
    await shoot(page, 'guide-register');

    await page.locator('#rgSubmit').click();
    await page.waitForSelector('#viewLogin.active', { timeout: 20_000 });
    await pause(page, 600);
    await shoot(page, 'guide-account-created');

    await page.locator('#liPassword').fill(DEMO.password);
    await page.locator('#liSubmit').click();
    await pause(page, 2500);
    if (await page.locator('#sessionModal').isVisible().catch(() => false)) {
      await page.locator('#sessionModal .btn.primary').first().click();
      await pause(page, 2500);
    }

    // ── 2. The first run, with nothing configured yet ───────────────────────
    // This is the one screen that cannot be reconstructed later, which is why
    // the journey runs in this order: once a connection is saved the product
    // never shows it again for this account.
    log('2. First run — demo data, no connection');
    await pause(page, 2000);
    await shoot(page, 'guide-first-run');

    const token = await page.evaluate(() => localStorage.getItem('dt_session_token'));
    if (!token) throw new Error('signed in but no session token in localStorage');

    // ── 3. Connecting to DependencyTrack ────────────────────────────────────
    log('3. The DependencyTrack connection');
    await page.click('#settingsBtn');
    await pause(page, 900);
    await page.locator('#cfgApiUrl').fill(stack.dt.url);
    await page.locator('#cfgApiKey').fill(stack.dt.apiKey);
    await page.locator('#cfgFrontendUrl').fill(stack.dt.url);
    await page.locator('#cfgTestConnBtn').click();
    await pause(page, 2500); // the probe is one real request to the stub
    await shootEl(page, '#configPanel', 'guide-connection');
    await page.locator('#cfgSaveBtn').click();
    await pause(page, 3000);

    // Build the cache and seed a few days of history with deliberate gaps, so
    // the trend panel shows the carry-forward drawing (Q23) rather than a
    // single lonely point. Done over the API because a guide should not tell
    // anyone to wait out a crawl for a picture.
    log('   building the violation cache…');
    await api.post('/violation-cache/refresh', {}, token);
    await api.waitForCache(token);
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

    // ── 4. Reading the portfolio ────────────────────────────────────────────
    log('4. The dashboard');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#tableBody tr', { timeout: 60_000 });
    await pause(page, 1800);
    await shoot(page, 'dashboard');
    await shootEl(page, '#trendPanel', 'risk-trend', 0);

    // ── 5. The findings dialog ──────────────────────────────────────────────
    log('5. Findings, origin and dependency paths');
    await page.locator('.vuln-eye-btn').first().click();
    await page.waitForSelector('#vulnDialogRows tr', { timeout: 30_000 });
    await page.locator('#vulnDepPathToggle').click();
    await page.waitForSelector('.dep-path-chain', { timeout: 90_000 });
    await pause(page, 600);
    await shoot(page, 'findings-dialog');

    await page.locator('#vulnViewType').selectOption('license');
    await pause(page, 3000);
    await shoot(page, 'guide-findings-license');

    await page.locator('#vulnViewType').selectOption('security');
    await pause(page, 800);
    await page.locator('#vulnOriginFilter').selectOption('transitive');
    await pause(page, 600);
    await shootEl(page, '#vulnDialog .modal', 'guide-findings-filters');
    await page.locator('#vulnDialog .modal-close').click();
    await pause(page, 500);
    await restoreViewport(page);

    // ── 6. Generating a report ──────────────────────────────────────────────
    log('6. Reports');
    await page.locator('#tableBody .proj-select-cb[data-leaf="1"]').first().check();
    await pause(page, 400);
    await page.locator('#genReportBtn').click();
    await pause(page, 400);
    await page.locator('.rpt-drop-item:has-text("Generate Report")').click();
    await page.waitForSelector('#reportOptionsModal.open', { timeout: 15_000 });
    await page.locator('#rptOptLicense').check();
    await pause(page, 700);
    await shootEl(page, '#reportOptionsModal .modal', 'guide-report-options');
    await page.locator('#reportOptionsModal .btn.primary').first().click();
    await pause(page, 12_000); // let the report actually finish

    await page.locator('#reportsBtn').click();
    await page.waitForSelector('#reportsModal.open', { timeout: 15_000 });
    await pause(page, 1200);
    await shootEl(page, '#reportsModal .modal', 'guide-reports');
    await page.locator('#reportsModal .modal-close').click();
    await pause(page, 500);

    // ── 7. Email settings ───────────────────────────────────────────────────
    // This comes before scheduling because the product enforces that order:
    // scheduleReports() refuses to open the editor until mail is configured,
    // which is exactly what the guide has to tell a reader.
    log('7. Email settings');
    await page.click('#settingsBtn');
    await pause(page, 1000);
    // The checkbox itself is visually replaced by .cfg-toggle-slider, so the
    // switch has to be clicked the way a person clicks it.
    await page.locator('label.cfg-toggle:has(#cfgMailEnabled) .cfg-toggle-slider').click();
    await pause(page, 600);
    await page.locator('#cfgMailFrom').fill('dashboard@example.com');
    await page.locator('#cfgMailTo').fill('security-team@example.com');
    await page.locator('#cfgMailSubject').fill('Weekly dependency risk report');
    await page.locator('#cfgSmtpHost').fill(stack.smtp.host);
    await page.locator('#cfgSmtpPort').fill(String(stack.smtp.port));
    await page.locator('#cfgSmtpUser').fill('dashboard');
    await page.locator('#cfgSmtpPass').fill('smtp-password');
    await pause(page, 400);
    await shoot(page, 'settings');
    await page.locator('#cfgSaveBtn').click();
    await pause(page, 2500);
    await page.locator('.cfg-close').first().click();
    await pause(page, 800);

    // ── 8. Scheduling a report ──────────────────────────────────────────────
    log('8. Schedules');
    await page.locator('#tableBody .proj-select-cb[data-leaf="1"]').first().check();
    await pause(page, 400);
    await page.locator('#genReportBtn').click();
    await pause(page, 400);
    await page.locator('.rpt-drop-item:has-text("Schedule Reports")').click();
    await page.waitForSelector('#cfgSchedView', { state: 'visible', timeout: 20_000 });
    await pause(page, 1000);
    // Two different fields, deliberately (§5.5): `cfgSchedLabel` is what the
    // settings list calls this schedule, `cfgSchedName` is what the generated
    // workbook is called.
    await page.locator('#cfgSchedLabel').fill('Weekly security review');
    await page.locator('#cfgSchedName').fill('weekly-security-review.xlsx');
    await page.locator('#cfgSchedFreq').selectOption('weekly');
    await pause(page, 600);
    await shootEl(page, '#configPanel', 'guide-schedule-editor');
    await page.locator('#cfgSaveBtn').click();
    await pause(page, 3000);
    // Saving stays in the editor; Back is what returns to the list this shot
    // is about, and the list sits below the connection and mail sections, so
    // the panel has to be scrolled to it.
    await page.locator('#cfgBackBtn').click();
    await pause(page, 1200);
    await page.locator('#cfgSchedList').scrollIntoViewIfNeeded();
    await pause(page, 700);
    await shootEl(page, '#configPanel', 'guide-schedules');
    await page.locator('.cfg-close').first().click();
    await pause(page, 800);

    // ── 9. Your account ─────────────────────────────────────────────────────
    log('9. Profile');
    await page.locator('#userMenuBtn').click();
    await pause(page, 500);
    await page.locator('#userMenuProfile').click();
    await pause(page, 1200);
    await shootEl(page, '#profilePanel', 'guide-profile');
    await page.locator('.pf-close').first().click();
    await pause(page, 500);

    // ── 10. Administration ───────────────────────────────────────────────────
    log('10. Administration');
    const admin = await browser.newPage({ viewport: VIEWPORT });
    const adminLogin = await api.post('/auth/login',
      { loginId: stack.admin.loginId, password: stack.admin.password, isAdmin: true, force: true });
    if (adminLogin.json && adminLogin.json.token) {
      await admin.goto(`${stack.url}/login.html`, { waitUntil: 'domcontentloaded' });
      await admin.evaluate((t) => localStorage.setItem('dt_session_token', t), adminLogin.json.token);
      await admin.goto(`${stack.url}/admin.html`, { waitUntil: 'networkidle' });
      await admin.waitForTimeout(2500);
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

/**
 * Put the page back where it started. The dashboard scrolls an inner container,
 * so window.scrollTo is not enough — the same trap e2e.test.js documents.
 */
async function restoreViewport(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (let el = document.getElementById('trendCharts'); el; el = el.parentElement) {
      if (el.scrollTop) el.scrollTop = 0;
    }
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
