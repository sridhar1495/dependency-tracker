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
  // Security findings, keyed to the same leaf projects the metrics already
  // claim have vulnerabilities — makeProject()'s formula gives project i+100
  // metrics.critical = i % 4, so leaf 101 (i=1) is guaranteed at least one.
  // Shaped exactly like a real DT finding: {vulnerability, component}, the
  // same object the report path and the vulnerability dialog both consume.
  const findings = [];
  const SEV_CWE = {
    CRITICAL: { severity: 'CRITICAL', cvss: 9.8, cwe: 89 },
    HIGH:     { severity: 'HIGH',     cvss: 7.5, cwe: 79 },
    MEDIUM:   { severity: 'MEDIUM',   cvss: 5.3, cwe: 400 },
    LOW:      { severity: 'LOW',      cvss: 2.1, cwe: null },
  };
  for (const leaf of Object.values(children).flat()) {
    const m = leaf.metrics;
    const counts = [['CRITICAL', m.critical], ['HIGH', m.high], ['MEDIUM', m.medium], ['LOW', m.low]];
    let seq = 0;
    for (const [level, count] of counts) {
      for (let k = 0; k < count; k++) {
        seq++;
        const shape = SEV_CWE[level];
        findings.push({
          vulnerability: {
            vulnId: `CVE-2024-${leaf.uuid.slice(0, 4)}${String(seq).padStart(2, '0')}`,
            severity: shape.severity,
            cvssV3BaseScore: shape.cvss,
            cwes: shape.cwe ? [{ cweId: shape.cwe, name: 'stub weakness' }] : [],
            analysisStatus: 'NOT_SET',
          },
          component: {
            name: `dep-${leaf.name}-${seq}`, group: '', version: '1.0.0', latestVersion: '2.0.0',
            projectName: leaf.name, projectVersion: leaf.version,
          },
        });
      }
    }
  }

  return { roots, children, violations, findings };
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

    // Findings drive both the report workbook and the vulnerability dialog.
    // Both callers send textSearchInput=`${name} ${version}` (violation-cache/
    // lib/reports.js's fetchAllFindings and the dashboard's vulnFindingsQuery
    // deliberately match it), so the stub recovers the project by splitting on
    // the last space rather than reimplementing DT's fuzzy full-text search —
    // it only has to give the app data shaped correctly, not BE DependencyTrack.
    if (u.pathname === '/api/v1/finding') {
      const input = u.searchParams.get('textSearchInput') || '';
      const sepAt = input.lastIndexOf(' ');
      const name  = sepAt === -1 ? input : input.slice(0, sepAt);
      const list  = portfolio.findings.filter(f => f.component.projectName === name);

      const pageSize   = parseInt(u.searchParams.get('pageSize') || '300', 10);
      const pageNumber = parseInt(u.searchParams.get('pageNumber') || '1', 10);
      const start = (pageNumber - 1) * pageSize;
      const page  = list.slice(start, start + pageSize);
      return send(200, page, { 'X-Total-Count': String(list.length) });
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
