-- SPDX-License-Identifier: MIT
-- 017 — the administrator's colour theme.
--
-- ── Why its own table ────────────────────────────────────────────────────────
-- `branding_assets` is not reused. Its rows are image bytes with a sniffed mime
-- type and pixel dimensions, and not one of those columns means anything for a
-- theme. `app_settings` is not reused either: it is read on every
-- administration listing, and a 2 KB document plus its rendered stylesheet
-- would ride along on queries that want a quota.
--
-- ── Why both the document AND the CSS are stored ─────────────────────────────
-- `doc` is what the administration screen shows back, what the download button
-- serves, and what a future format version would read. `css` is what the public
-- `/branding/theme.css` route serves on every page load.
--
-- Regenerating the CSS per request would put a template render on the path
-- every single page load takes. Regenerating it at boot would mean a change to
-- the generator silently applying itself to a stored theme nobody re-reviewed.
-- It is generated once, on save, by the same code that validated the document.
--
-- ── What is NOT in here ──────────────────────────────────────────────────────
-- No CSS the operator wrote. `lib/theme.js` renders `css` from an allow-list of
-- token names and colours it re-serialised itself (S35), so this column holds
-- text this service constructed, never text it was handed.

CREATE TABLE IF NOT EXISTS app_themes (
  -- Singleton, the same shape app_settings uses: the theme belongs to the
  -- installation, not to a user (§7.5 does not apply — there is no principal).
  id          boolean     PRIMARY KEY DEFAULT TRUE CHECK (id),
  name        text,
  doc         jsonb       NOT NULL,
  css         text        NOT NULL,
  etag        text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_themes_name_len CHECK (name IS NULL OR char_length(name) <= 60)
);

-- No index: the table holds at most one row, reached by its primary key.
