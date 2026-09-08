// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── DependencyTrack stub ──────────────────────────────────────────────────────
// Stands in for a real DependencyTrack so the end-to-end suite can run offline.
//
// It mirrors the upstream's ROUTING, not just its payloads, because the routing
// is where this product has been caught out before: `/api/version` is
// unauthenticated and lives OUTSIDE `/api/v1`, and an unknown path 404s. A stub
// that answers whatever it is asked lets a connection test pass against an
// endpoint that does not exist upstream (CLAUDE.md §6.2).
//
// No I/O at require time — start() is called by the harness.

const http = require('http');

const API_KEY = 'e2e-dependency-track-key';

/** A project in the shape the DT API returns, metrics embedded. */
function makeProject(i, parentUuid) {
  return {
    uuid: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
    name: parentUuid ? `service-${i}` : `Group ${i}`,
    version: parentUuid ? `1.${i}.0` : '',
    parent: parentUuid ? { uuid: parentUuid } : undefined,
    isLatest: i % 3 === 0,
    tags: [{ name: i % 2 ? 'production' : 'staging' }],
    metrics: {
      critical: i % 4, high: (i % 5) + 1, medium: (i % 7) + 2,
      low: i % 3, unassigned: i % 2,
    },
  };
}

const ROOT_IDS = [1, 2, 3];
const uuidOf = (i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;

function buildPortfolio() {
  const roots = ROOT_IDS.map(i => {
    const p = makeProject(i, null);
    // The dashboard only fetches children for a project whose embedded
    // children[] is non-empty, so this field decides the shape of the crawl.
    p.children = [{ uuid: uuidOf(i + 100) }];
    return p;
  });
  const children = {};
  for (const i of ROOT_IDS) {
    const c = makeProject(i + 100, uuidOf(i));
    c.children = [];
    children[uuidOf(i)] = [c];
  }

  // Policy violations, spread so every risk type and state has some.
  const violations = [];
  const all = [...roots, ...Object.values(children).flat()];
  const spread = [
    ['OPERATIONAL', 'FAIL', 2], ['OPERATIONAL', 'WARN', 1], ['OPERATIONAL', 'INFO', 1],
    ['LICENSE', 'FAIL', 1], ['LICENSE', 'WARN', 1], ['LICENSE', 'INFO', 3],
    ['SECURITY', 'FAIL', 1], ['SECURITY', 'WARN', 2], ['SECURITY', 'INFO', 1],
  ];
  for (const p of all) {
    for (const [riskType, violationState, n] of spread) {
      for (let k = 0; k < n; k++) {
        violations.push({ riskType, violationState, project: { uuid: p.uuid } });
      }
    }
  }
  return { roots, children, violations };
}

/**
 * Start the stub.
 *
 * @param {object} [opts]
 * @param {number} [opts.port] 0 lets the OS choose, which is what the harness does
 * @returns {Promise<{url, apiKey, close, calls, reset, portfolio}>}
 */
async function start(opts = {}) {
  const portfolio = buildPortfolio();
  let calls = [];

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://dt');
    calls.push(`${req.method} ${u.pathname}${u.search}`);

    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    // Unauthenticated, and deliberately NOT under /api/v1 — this is where the
    // real DependencyTrack puts it.
    if (u.pathname === '/api/version') {
      return send(200, { version: '4.11.0', application: 'Dependency-Track' });
    }
    if (!u.pathname.startsWith('/api/v1/')) return send(404, { error: 'Not found' });
    if (req.headers['x-api-key'] !== API_KEY) return send(401, { error: 'Unauthorised' });

    if (u.pathname === '/api/v1/project') {
      const onlyRoot = u.searchParams.get('onlyRoot') === 'true';
      const list = onlyRoot
        ? portfolio.roots
        : [...portfolio.roots, ...Object.values(portfolio.children).flat()];
      return send(200, list, { 'X-Total-Count': String(list.length) });
    }

    const m = u.pathname.match(/^\/api\/v1\/project\/([^/]+)\/children$/);
    if (m) {
      const kids = portfolio.children[m[1]] || [];
      return send(200, kids, { 'X-Total-Count': String(kids.length) });
    }

    if (u.pathname === '/api/v1/violation') {
      const rt = u.searchParams.get('riskType');
      const st = u.searchParams.get('violationState');
      const list = portfolio.violations.filter(v => v.riskType === rt && v.violationState === st);
      return send(200, list, { 'X-Total-Count': String(list.length) });
    }

    // Findings drive the report workbook. An empty set is enough: the report
    // tier asserts that a workbook is produced, not what a CVE row looks like.
    if (u.pathname.startsWith('/api/v1/finding')) {
      return send(200, [], { 'X-Total-Count': '0' });
    }

    send(404, { error: 'Not found' });
  });

  await new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    apiKey: API_KEY,
    portfolio,
    /** Every path this stub has been asked for, so a test can assert on traffic. */
    calls: () => [...calls],
    reset: () => { calls = []; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { start, API_KEY, uuidOf, ROOT_IDS };
