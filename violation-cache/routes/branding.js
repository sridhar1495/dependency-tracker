// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Branding (public) ────────────────────────────────────────────────────────
//   GET /branding             title + background, icon and theme metadata
//   GET /branding/background  the uploaded image bytes
//   GET /branding/icon        the logo mark's bytes
//   GET /branding/theme.css   the administrator's generated colour theme
//
// S32: these four are the only unauthenticated routes outside /auth, and the
// justification is that the sign-in page needs them BEFORE a token exists —
// branding on a sign-in screen is public by construction, since anyone who can
// reach the page can see it. They expose nothing else: no account, no setting,
// no count. The write side lives in routes/admin.js behind the administrator
// guard, as every other change to service configuration does.

const { log } = require('../lib/log');
const { jsonReply } = require('../lib/http-util');
const branding = require('../lib/branding');

// Served when no theme is configured — see the route below for why this is a
// 200 rather than a 404.
const EMPTY_THEME_CSS = '/* No theme configured. */\n';

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
        // Q47: the mark falls back to the title's initials when absent, so the
        // page needs to know which it is drawing before it draws anything.
        icon: b.icon
          ? { version: b.icon.etag, width: b.icon.width, height: b.icon.height }
          : null,
        // Q48: the dashboard needs this before it draws anything, and it is no
        // more sensitive than the title beside it — it says whether a panel is
        // on screen, not what is in it.
        trendEnabled: b.trendEnabled,
        // Q49: the version is what the pages put in the stylesheet's URL, so
        // it is immutable and a changed theme is a different URL. `null` means
        // "emit no <link> at all" — the built-in blocks are the fallback.
        theme: b.theme ? { version: b.theme.etag, name: b.theme.name || null } : null,
      });
    } catch (e) {
      // The sign-in page must render even when this fails, so the failure is
      // reported as "no customisation" rather than as an error the page has to
      // handle. Locking people out of signing in because a title could not be
      // read would be a far worse outcome than showing the default one.
      log('warn', 'Branding read failed; serving defaults', { err: e.message });
      jsonReply(res, 200, {
        title: branding.DEFAULT_TITLE, titleIsDefault: true, background: null, icon: null,
        trendEnabled: true, theme: null,
      });
    }
    return true;
  }

  // ── The image itself ───────────────────────────────────────────────────
  // S32, same reasoning as the background: the sign-in page draws the mark
  // before anybody has a token, so anyone who can reach the page can already
  // see it. Returns an image and nothing else — no account, no setting, no
  // count. SVG is refused upstream at upload, so these bytes are always a
  // raster image from our own origin.
  if (method === 'GET' && path === '/branding/icon') {
    try {
      const asset = await branding.getIconBytes();
      if (!asset) {
        jsonReply(res, 404, { error: 'No application icon is configured.', code: 'NO_ICON' });
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
        'Cache-Control':  'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(asset.bytes);
    } catch (e) {
      log('error', 'Icon read failed', { err: e.message });
      jsonReply(res, 500, { error: 'Could not read the icon.', code: 'INTERNAL' });
    }
    return true;
  }

  // S32/Q49: public, for exactly the reason the icon and the background are —
  // the sign-in page must be themed and it renders before any token exists.
  // Returns `text/css` and nothing else: no account, no setting, no count.
  //
  // The bytes are text THIS SERVICE generated from an allow-list of token
  // names and colours it re-serialised itself (S35, lib/theme.js), never text
  // an operator wrote. A 404 is the ordinary state and costs the page nothing:
  // the built-in :root blocks are the fallback by construction.
  if (method === 'GET' && path === '/branding/theme.css') {
    try {
      const theme = await branding.getThemeCss();
      // No theme configured is the ordinary state, and it answers 200 with an
      // empty sheet rather than 404. The pages link this unconditionally, so a
      // 404 would put a failed request in every console on every installation
      // that never set a theme — and it would say nothing a zero-length
      // stylesheet does not. The built-in :root blocks are the fallback.
      const css = theme ? theme.css : EMPTY_THEME_CSS;
      const etag = `"${theme ? theme.etag : 'none'}"`;

      if (ctx.req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
        res.end();
        return true;
      }
      const body = Buffer.from(css, 'utf8');
      // `no-cache` means "revalidate", not "do not store": the browser keeps
      // the bytes and sends If-None-Match, so the usual answer is a ~100-byte
      // 304. It cannot be `immutable` like the icon's, because this URL
      // carries no version — the pages are static files with no templating to
      // stamp one in, and a year-long cache would hide every later change.
      res.writeHead(200, {
        'Content-Type':   'text/css; charset=utf-8',
        'Content-Length': body.length,
        ETag:             etag,
        'Cache-Control':  'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    } catch (e) {
      log('error', 'Theme read failed', { err: e.message });
      jsonReply(res, 500, { error: 'Could not read the theme.', code: 'INTERNAL' });
    }
    return true;
  }

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
