// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Branding ─────────────────────────────────────────────────────────────────
// The application title and the sign-in background, both owned by the
// administrator and both service-wide.
//
// Q17: this is process-global mutable state, which §7.5 normally forbids — but
// the rule is about *per-user* state. Branding belongs to the installation, not
// to a principal: every user sees the same title and the same background, so
// there is exactly one value to hold and no possibility of one user reading
// another's. Caching it is the difference between one database round trip per
// page load per user and one per change.
//
// The cache is invalidated by the writers below, which is sound on the one
// supported topology (a single replica, documented in docs/PERFORMANCE.md §4).
// A second replica would serve a stale title until its own next write — the
// same known limitation the session token cache carries, and the same fix
// (LISTEN/NOTIFY) would apply.

const crypto = require('crypto');
const { query } = require('../db/pool');

// The name the product ships with. The three HTML pages repeat this string as
// their static <title>, and a test asserts they still match — they cannot
// require() this file, and a default that differs per page is the bug this
// feature was partly raised to fix.
const DEFAULT_TITLE = 'Software Composition Analysis - Risk Dashboard';

const BACKGROUND_KIND = 'login_background';
// Q47: the logo mark is the title's initials unless an icon is uploaded. A
// second `kind` rather than a second table — one upload path, one serving
// path, one cache rule (migration 016).
const ICON_KIND = 'app_icon';

// { title, background } — background is metadata only, never the bytes.
let _cache = null;
// Bytes are held separately: the metadata is wanted on every page load, the
// bytes only by whoever is actually rendering the image.
let _bytesCache = null;
// Q49: the theme is read on EVERY page load, including the sign-in page, and
// it is one row that changes when an administrator uploads a file. Caching the
// rendered stylesheet here is what keeps that read off the database entirely.
let _themeCache = null;

/** Drop the cache. Called by every writer here, and by tests. */
function invalidate() {
  _cache = null;
  _bytesCache = null;
  _themeCache = null;
}

/**
 * Everything the sign-in page needs, in one read.
 * @returns {Promise<{ title: string, background: object|null }>}
 */
async function get() {
  if (_cache) return _cache;

  const [settings, asset, icon, theme] = await Promise.all([
    query('SELECT app_title AS "appTitle", trend_enabled AS "trendEnabled" '
          + 'FROM app_settings WHERE id = TRUE'),
    // Never SELECT * here: this table holds a bytea column (CLAUDE.md §5.1).
    query(
      `SELECT mime_type AS "mimeType", etag, width, height,
              byte_size AS "byteSize", updated_at AS "updatedAt"
         FROM branding_assets WHERE kind = $1`,
      [BACKGROUND_KIND]
    ),
    query(
      `SELECT mime_type AS "mimeType", etag, width, height,
              byte_size AS "byteSize", updated_at AS "updatedAt"
         FROM branding_assets WHERE kind = $1`,
      [ICON_KIND]
    ),
    // Metadata only — `css` and `doc` are wanted by one route each, not by
    // every sign-in page render, so they are read separately below.
    query('SELECT name, etag FROM app_themes WHERE id = TRUE'),
  ]);

  const stored = settings.rows[0] && settings.rows[0].appTitle;
  _cache = {
    title: (typeof stored === 'string' && stored.trim()) ? stored.trim() : DEFAULT_TITLE,
    // True when the administrator set a title, so the screen can show whether
    // it is showing their value or the built-in one.
    titleIsDefault: !(typeof stored === 'string' && stored.trim()),
    background: asset.rows[0] || null,
    icon: icon.rows[0] || null,
    // Q48: the administrator may hide the risk-trend panel. Absent on a row
    // written before migration 016, so it reads as ON — the panel existed
    // before the switch did, and a column default must never turn a working
    // feature off for an installation that never asked.
    trendEnabled: settings.rows[0] ? settings.rows[0].trendEnabled !== false : true,
    // Q49: the pages emit the <link> only when there is something to link to.
    // The etag is in the URL, so a changed theme is a different URL and the
    // response can be immutable.
    theme: theme.rows[0] || null,
  };
  return _cache;
}

/** The configured title, or the built-in default. */
async function getTitle() {
  return (await get()).title;
}

/**
 * Set or clear the title.
 * @param {string|null} value  null or blank restores the built-in default
 */
async function setTitle(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  await query('UPDATE app_settings SET app_title = $1 WHERE id = TRUE', [trimmed || null]);
  invalidate();
  return get();
}

/**
 * The stored image, bytes included.
 * @returns {Promise<{bytes: Buffer, mimeType: string, etag: string}|null>}
 */
async function getBackgroundBytes() {
  if (_bytesCache !== null) return _bytesCache.etag ? _bytesCache : null;

  const { rows } = await query(
    'SELECT bytes, mime_type AS "mimeType", etag FROM branding_assets WHERE kind = $1',
    [BACKGROUND_KIND]
  );
  // Cache the absence too, so a deployment with no custom background does not
  // query on every sign-in page load.
  _bytesCache = rows[0] || { etag: null };
  return rows[0] || null;
}

/**
 * Store an inspected image, replacing whatever was there.
 * @param {{bytes: Buffer, mimeType: string, width: number, height: number}} img
 */
async function putBackground({ bytes, mimeType, width, height }) {
  const etag = crypto.createHash('sha256').update(bytes).digest('hex');
  await query(
    `INSERT INTO branding_assets (kind, bytes, mime_type, etag, width, height, byte_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (kind) DO UPDATE
        SET bytes = EXCLUDED.bytes, mime_type = EXCLUDED.mime_type,
            etag  = EXCLUDED.etag,  width     = EXCLUDED.width,
            height = EXCLUDED.height, byte_size = EXCLUDED.byte_size,
            updated_at = now()`,
    [BACKGROUND_KIND, bytes, mimeType, etag, width, height, bytes.length]
  );
  invalidate();
  return get();
}

/** Remove the uploaded image; the animated background becomes visible again. */
async function clearBackground() {
  await query('DELETE FROM branding_assets WHERE kind = $1', [BACKGROUND_KIND]);
  invalidate();
  return get();
}

/** The icon's bytes, or null. Read on its own so `get()` never carries them. */
async function getIconBytes() {
  const { rows } = await query(
    'SELECT bytes, mime_type AS "mimeType", etag FROM branding_assets WHERE kind = $1',
    [ICON_KIND]
  );
  return rows[0] || null;
}

async function putIcon({ bytes, mimeType, width, height }) {
  const etag = crypto.createHash('sha256').update(bytes).digest('hex');
  await query(
    `INSERT INTO branding_assets (kind, bytes, mime_type, etag, width, height, byte_size)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (kind) DO UPDATE
            SET bytes = EXCLUDED.bytes, mime_type = EXCLUDED.mime_type,
                etag = EXCLUDED.etag, width = EXCLUDED.width,
                height = EXCLUDED.height, byte_size = EXCLUDED.byte_size`,
    [ICON_KIND, bytes, mimeType, etag, width, height, bytes.length]
  );
  invalidate();
}

/** Remove the icon. The mark falls back to the title's initials. */
async function clearIcon() {
  await query('DELETE FROM branding_assets WHERE kind = $1', [ICON_KIND]);
  invalidate();
}

/** Show or hide the risk-trend panel for every user (Q48). */
async function setTrendEnabled(enabled) {
  await query(
    `INSERT INTO app_settings (id, trend_enabled) VALUES (TRUE, $1)
     ON CONFLICT (id) DO UPDATE SET trend_enabled = EXCLUDED.trend_enabled`,
    [enabled === true]
  );
  invalidate();
}

// ── The administrator's colour theme (Q49) ───────────────────────────────────

/**
 * The generated stylesheet `/branding/theme.css` serves, or null.
 *
 * Cached including the absence, so an installation with no theme does not
 * query on every page load — the same reasoning `getBackgroundBytes` uses.
 */
async function getThemeCss() {
  if (_themeCache !== null) return _themeCache.etag ? _themeCache : null;
  const { rows } = await query('SELECT css, etag FROM app_themes WHERE id = TRUE');
  _themeCache = rows[0] || { etag: null };
  return rows[0] || null;
}

/** The stored document itself, for the administration screen and its download. */
async function getThemeDoc() {
  const { rows } = await query('SELECT name, doc, etag, updated_at AS "updatedAt" '
                               + 'FROM app_themes WHERE id = TRUE');
  return rows[0] || null;
}

/**
 * Store a validated document and the stylesheet it renders to.
 *
 * Both are written together, by the caller that validated the one and
 * generated the other, so the served CSS can never be the output of a
 * different version of the generator than the document was checked against.
 */
async function putTheme({ name, doc, css }) {
  const etag = crypto.createHash('sha256').update(css).digest('hex');
  await query(
    `INSERT INTO app_themes (id, name, doc, css, etag, updated_at)
          VALUES (TRUE, $1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE
            SET name = EXCLUDED.name, doc = EXCLUDED.doc, css = EXCLUDED.css,
                etag = EXCLUDED.etag, updated_at = EXCLUDED.updated_at`,
    [name || null, JSON.stringify(doc), css, etag]
  );
  invalidate();
  return etag;
}

/** Remove the theme. Every page falls back to its own built-in blocks. */
async function clearTheme() {
  await query('DELETE FROM app_themes WHERE id = TRUE');
  invalidate();
}

module.exports = {
  get, getTitle, setTitle,
  getThemeCss, getThemeDoc, putTheme, clearTheme,
  getBackgroundBytes, putBackground, clearBackground,
  getIconBytes, putIcon, clearIcon, setTrendEnabled,
  invalidate,
  DEFAULT_TITLE, BACKGROUND_KIND, ICON_KIND,
};
