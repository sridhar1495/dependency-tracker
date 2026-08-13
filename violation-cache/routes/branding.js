// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Branding (public) ────────────────────────────────────────────────────────
//   GET /branding             title + background metadata
//   GET /branding/background  the uploaded image bytes
//
// S32: these two are the only unauthenticated routes outside /auth, and the
// justification is that the sign-in page needs them BEFORE a token exists —
// branding on a sign-in screen is public by construction, since anyone who can
// reach the page can see it. They expose nothing else: no account, no setting,
// no count. The write side lives in routes/admin.js behind the administrator
// guard, as every other change to service configuration does.

const { log } = require('../lib/log');
const { jsonReply } = require('../lib/http-util');
const branding = require('../lib/branding');

async function handle(ctx) {
  const { method, path, res } = ctx;

  // ── Title and background metadata ──────────────────────────────────────
  if (method === 'GET' && path === '/branding') {
    try {
      const b = await branding.get();
      jsonReply(res, 200, {
        title: b.title,
        titleIsDefault: b.titleIsDefault,
        // The hash doubles as the cache-busting version the page puts in the
        // image URL, so a changed background is fetched and an unchanged one
        // never is.
        background: b.background
          ? { version: b.background.etag, width: b.background.width, height: b.background.height }
          : null,
      });
    } catch (e) {
      // The sign-in page must render even when this fails, so the failure is
      // reported as "no customisation" rather than as an error the page has to
      // handle. Locking people out of signing in because a title could not be
      // read would be a far worse outcome than showing the default one.
      log('warn', 'Branding read failed; serving defaults', { err: e.message });
      jsonReply(res, 200, {
        title: branding.DEFAULT_TITLE, titleIsDefault: true, background: null,
      });
    }
    return true;
  }

  // ── The image itself ───────────────────────────────────────────────────
  if (method === 'GET' && path === '/branding/background') {
    try {
      const asset = await branding.getBackgroundBytes();
      if (!asset) {
        jsonReply(res, 404, { error: 'No background image is configured.', code: 'NO_BACKGROUND' });
        return true;
      }

      const etag = `"${asset.etag}"`;
      if (ctx.req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return true;
      }

      res.writeHead(200, {
        'Content-Type':   asset.mimeType,
        'Content-Length': asset.bytes.length,
        ETag:             etag,
        // The URL carries ?v=<etag>, so a given URL's bytes can never change.
        // The browser fetches the background once and re-reads it from its own
        // cache on every later sign-in.
        'Cache-Control':  'public, max-age=31536000, immutable',
        // The type above was sniffed from the file's magic bytes, not taken
        // from the uploader. Stop the browser second-guessing it anyway.
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(asset.bytes);
    } catch (e) {
      log('error', 'Background read failed', { err: e.message });
      jsonReply(res, 500, { error: 'The background image could not be read.' });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
