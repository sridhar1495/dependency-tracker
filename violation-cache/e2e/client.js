// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Test client ───────────────────────────────────────────────────────────────
// Thin helpers so the suite reads as behaviour rather than as plumbing, plus
// the payload shapes the routes actually take.
//
// Those shapes live here for a reason. Writing the first version of this suite,
// every one of them was guessed wrong — `{dt:…}` for `{connection:…}`,
// `{loginId}` for `{field,value}`, `{admin}` for `{isAdmin}`, `name` for
// `reportName`, and bare uuid strings where the route wants project objects.
// Each cost a debugging round. Naming them once, in one module, is what stops
// the next person paying that again.

const { execFileSync } = require('child_process');

/** A client bound to one running stack. */
function makeClient(baseUrl) {
  const request = async (path, opts = {}) => {
    const res = await fetch(baseUrl + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* not every response is JSON */ }
    return { status: res.status, json, headers: res.headers, res };
  };

  const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
  const post = (p, body, token) =>
    request(p, { method: 'POST', headers: bearer(token), body: JSON.stringify(body ?? {}) });
  const put = (p, body, token) =>
    request(p, { method: 'PUT', headers: bearer(token), body: JSON.stringify(body ?? {}) });
  const del = (p, token, body) =>
    request(p, { method: 'DELETE', headers: bearer(token), body: body ? JSON.stringify(body) : undefined });
  const get = (p, token) => request(p, { headers: bearer(token) });

  return {
    baseUrl, request, get, post, put, del, bearer,

    /** Register an account. Returns the response. */
    register: (u) => post('/auth/register', u),

    /** Sign in. `force` replaces a live session; `isAdmin` uses the credentials file. */
    login: (loginId, password, extra = {}) => post('/auth/login', { loginId, password, ...extra }),

    /** Register and sign in, returning the bearer token. */
    async signUp(u) {
      await post('/auth/register', u);
      const r = await post('/auth/login', { loginId: u.loginId, password: u.password, force: true });
      return r.json && r.json.token;
    },

    /** Save the DependencyTrack connection. The key is `connection`, not `dt`. */
    saveConnection: (token, { apiUrl, apiKey, frontendUrl = '' }) =>
      post('/violation-cache/config', { connection: { apiUrl, apiKey, frontendUrl } }, token),

    /** Save mail settings. They live under `config.mail`. */
    saveMail: (token, mail) => post('/violation-cache/config', { config: { mail } }, token),

    /**
     * Create a schedule. `projects` is an array of OBJECTS — the data layer
     * skips any entry without a uuid, so bare strings vanish silently.
     */
    createSchedule: (token, body) => post('/violation-cache/schedules', body, token),

    listSchedules: async (token) => {
      const r = await get('/violation-cache/schedules', token);
      return (r.json && r.json.schedules) || [];
    },

    /** Generate a report. The name field is `reportName`. */
    generateReport: (token, { projects, riskTypes = ['security'], reportName = '' }) =>
      post('/violation-cache/report/generate', { projects, riskTypes, reportName }, token),

    /** The report list is a bare array, not `{reports: […]}`. */
    listReports: async (token) => {
      const r = await get('/violation-cache/report/list', token);
      return Array.isArray(r.json) ? r.json : [];
    },

    /** Availability check: `{field, value}`, not `{loginId}`. */
    checkAvailability: (field, value) => post('/auth/check-availability', { field, value }),

    /** Poll until the violation cache reports ready. */
    async waitForCache(token, timeoutMs = 120000) {
      const until = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < until) {
        const r = await get('/violation-cache/status', token);
        last = r.json;
        if (last && (last.status === 'ready' || last.status === 'error')) return last;
        await new Promise(s => setTimeout(s, 300));
      }
      return last;
    },

    /** Poll the report list until a job reaches a terminal status. */
    async waitForReport(token, id, timeoutMs = 120000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const found = (await this.listReports(token)).find(x => x.id === id);
        if (found && ['completed', 'failed'].includes(found.status)) return found;
        await new Promise(s => setTimeout(s, 300));
      }
      return null;
    },
  };
}

/**
 * Run one SQL statement against the stack's database and return the scalar.
 *
 * Used only to observe what the product wrote — never to set the state a test
 * then asserts on, which would be testing the fixture.
 */
function makeSql(databaseUrl) {
  const { Client } = require('pg');
  return async (text, params = []) => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query(text, params);
      return rows;
    } finally {
      await client.end();
    }
  };
}

/**
 * Find Playwright without depending on it.
 *
 * CLAUDE.md §3 caps the dependency list at three packages, so the browser tier
 * cannot add a fourth. It is resolved at run time from wherever the operator
 * has it — a global install, an explicit path, or not at all, in which case the
 * tier skips rather than fails.
 *
 * @returns {object|null} the playwright module, or null when unavailable
 */
function resolvePlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_PATH) candidates.push(process.env.PLAYWRIGHT_PATH);
  candidates.push('playwright', 'playwright-core');
  // Global installs, which is how CI and most developers will have it.
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (root) candidates.push(`${root}/playwright`, `${root}/playwright-core`);
  } catch (_) { /* npm not on PATH; the other candidates still apply */ }

  for (const c of candidates) {
    try { return require(c); } catch (_) { /* try the next */ }
  }
  return null;
}

/** The Chromium binary to drive, when the environment pins one. */
function chromiumPath() {
  return process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
}

module.exports = { makeClient, makeSql, resolvePlaywright, chromiumPath };
