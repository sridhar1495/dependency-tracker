// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── nginx-equivalent ──────────────────────────────────────────────────────────
// Serves the three dashboard pages and forwards the API paths to the backend,
// so the browser sees ONE origin exactly as it does behind nginx in the real
// stack.
//
// This is not an attempt to reimplement nginx.conf.template — it reproduces the
// one property the frontend depends on: same-origin `/auth/*`, `/profile`,
// `/admin/*`, `/branding` and `/violation-cache/*`, with everything else served
// as a file and unknown paths falling back to index.html the way `try_files`
// does. Testing the dashboard against a different origin would exercise CORS
// rather than the product.

const http = require('http');
const fs = require('fs');
const path = require('path');

const DASHBOARD_DIR = path.join(__dirname, '..', '..', 'dashboard');

// The same prefixes nginx.conf.template proxies. Kept as a list rather than a
// regex so a reader can compare it with the template line by line.
const PROXIED = ['/auth/', '/profile', '/admin/', '/branding', '/violation-cache/', '/healthz'];

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function start({ apiPort, port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://web');
    const proxied = PROXIED.some(p =>
      u.pathname === p.replace(/\/$/, '') || u.pathname.startsWith(p));

    if (proxied) {
      const upstream = http.request(
        { host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers },
        (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
      );
      upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `upstream: ${err.message}` }));
      });
      req.pipe(upstream);
      return;
    }

    const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '');
    const full = path.join(DASHBOARD_DIR, rel);
    if (full.startsWith(DASHBOARD_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(full)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(fs.readFileSync(full));
      return;
    }

    // try_files $uri $uri/ /index.html
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html')));
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const bound = server.address().port;
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { start, PROXIED, DASHBOARD_DIR };
