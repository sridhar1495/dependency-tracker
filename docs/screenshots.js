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
    // Named explicitly, not `.first()`: the first data-leaf="1" checkbox in
    // DOM order belongs to Collection 4's stale child (Q39's fixture), which
    // Q45's roll-up deliberately excludes from `filtered` — checking it left
    // generateReport() with nothing to report on and a silent "No projects
    // shown" toast the dropdown timeout never explained. service-102 sits
    // under Group 2, a plain root with no collectionLogic and no children of
    // its own, so it is always counted. (service-101 looks equally plain by
    // name but is itself a group — Q35's three-deep branch hangs service-201
    // off it — so its own checkbox is data-leaf="0", not "1".)
    log('6. Reports');
    await page.locator('#tableBody tr:has-text("service-102") .proj-select-cb[data-leaf="1"]').check();
    await pause(page, 400);
    await page.locator('#genReportBtn').click();
    await page.waitForSelector('#rptDropMenu.open', { timeout: 5_000 });
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
    await page.locator('#tableBody tr:has-text("service-102") .proj-select-cb[data-leaf="1"]').check();
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

      // The sections start collapsed, which photographs as four empty bars. A
      // guide needs what is inside them, so each one is opened for its own
      // shot and closed again — the panes are tall enough that two open at
      // once pushes the second below the fold.
      // `.acc-head` is the toggle; the section itself is what gets shot, so
      // each image carries its own heading and nothing above it.
      const accordion = (id) => admin.locator(`#${id} .acc-head`);

      await accordion('accUsers').click();
      await admin.waitForTimeout(900);
      await admin.locator('#usersBody tr').first().click().catch(() => {});
      await admin.waitForTimeout(1200);
      await shoot(admin, 'administration');

      await admin.locator('#btnEditLimit').click().catch(() => {});
      await admin.waitForTimeout(800);
      if (await admin.locator('#limitModal.open').count()) {
        await shootEl(admin, '#limitModal .modal', 'guide-admin-account-limit');
        await admin.locator('#limitModal .modal-actions .btn').first().click();
        await admin.waitForTimeout(500);
      }

      await admin.locator('#btnResetPw').click().catch(() => {});
      await admin.waitForTimeout(800);
      if (await admin.locator('#pwModal.open').count()) {
        await shootEl(admin, '#pwModal .modal', 'guide-admin-reset');
        await admin.locator('#pwModal .modal-actions .btn').first().click();
        await admin.waitForTimeout(500);
      }
      await accordion('accUsers').click();
      await admin.waitForTimeout(700);

      await accordion('accReports').click();
      await admin.waitForTimeout(900);
      await shootEl(admin, '#accReports', 'guide-admin-limits');
      await accordion('accReports').click();
      await admin.waitForTimeout(700);

      await accordion('accBranding').click();
      await admin.waitForTimeout(900);
      await shootEl(admin, '#accBranding', 'guide-admin-branding');

      // ── 11. The colour theme, actually applied ────────────────────────────
      // Everything above is the built-in palette. This is the one place the
      // product proves a THEMED installation, not just the control that sets
      // one — for docs/THEME_TOKENS.md, which maps each token to the region
      // it paints and needs a real "after" to point at. Deliberately partial
      // (Q49): several tokens are left at their built-in value, so the same
      // pair of images is also the evidence that an omitted property keeps
      // its default rather than falling back to black.
      //
      // Both the "before" and "after" shots are forced to dark explicitly —
      // never left to whatever this browser reports for prefers-color-scheme
      // (headless Chromium's default is "light", which every OTHER image in
      // this file inherits without asking). Dark is the product's own
      // designed default — :root itself, before any [data-theme] override —
      // and it is the richer half of this demo theme (nine properties against
      // three), so showing it is the point. Capturing dedicated "before"
      // shots here, in the SAME forced scheme as the "after" ones, is what
      // keeps the comparison isolated to the theme alone: reusing the
      // existing dashboard.png/login.png (both captured in whatever this
      // browser's default turned out to be) would silently vary the colour
      // SCHEME at the same time as the theme, which is a different question.
      log('11. The colour theme, applied');
      await page.evaluate(() => localStorage.setItem('dt_theme', 'dark'));
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('#tableBody tr', { timeout: 30_000 });
      await pause(page, 1500);
      await shoot(page, 'theme-demo-dashboard-before');

      const visitor = await browser.newPage({ viewport: VIEWPORT });
      await visitor.goto(`${stack.url}/login.html`, { waitUntil: 'networkidle' });
      await visitor.evaluate(() => localStorage.setItem('dt_theme', 'dark'));
      await visitor.reload({ waitUntil: 'networkidle' });
      await pause(visitor, 900);
      await shoot(visitor, 'theme-demo-login-before');

      const themeUpload = await api.put('/admin/theme', {
        version: 1,
        name: 'Ocean (doc demo)',
        dark: {
          bg: '#071b24', surface: '#0d2b38', surface2: '#113649',
          border: '#1c5068', text: '#eaf6fb', 'text-muted': '#8fb9c9',
          accent: '#00b8a9', 'accent-hover': '#00a396', critical: '#ff5470',
        },
        light: {
          bg: '#eefbf9', surface: '#ffffff', accent: '#00897b',
        },
      }, adminLogin.json.token);
      if (themeUpload.status === 200) {
        // The signed-in user, reloaded: the stylesheet link already exists on
        // every page, so a normal reload is enough to pick up the new
        // colours. A full reload re-runs the boot gate (§8.4), and it needs
        // longer to settle than an in-page state change does — 1200ms here
        // once left the topbar mid-repaint (still its pre-reload background)
        // while the rest of the page had already picked up the new
        // stylesheet.
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForSelector('#tableBody tr', { timeout: 30_000 });
        await pause(page, 2500);
        await shoot(page, 'theme-demo-dashboard');

        // A visitor who has never signed in: the theme is public (S32) for
        // exactly this reason, and this is the claim the e2e browser tier
        // proves — a signed-out session computes the theme's colours too.
        await visitor.reload({ waitUntil: 'networkidle' });
        await pause(visitor, 900);
        await shoot(visitor, 'theme-demo-login');

        await api.del('/admin/theme', adminLogin.json.token);
      } else {
        log(`  (skipped theme demo — PUT /admin/theme answered ${themeUpload.status})`);
      }
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
