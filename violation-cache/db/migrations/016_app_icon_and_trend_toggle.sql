-- SPDX-License-Identifier: MIT
-- 016 — an uploadable application icon, and an administrator switch for the
--       risk-trend panel.
--
-- ── The icon ─────────────────────────────────────────────────────────────────
-- The logo mark is derived from the application title's initials (§8.1), which
-- is a good default and not a brand. `branding_assets` already carries bytes,
-- a sniffed mime type, dimensions and an ETag, so an icon is a second `kind`
-- rather than a second table — one upload path, one serving path, one cache
-- rule.
--
-- Widening the CHECK means dropping and re-adding it. **No data is touched**:
-- every existing row is 'login_background', which the new constraint still
-- permits, so this is a strictly wider rule rather than a destructive change
-- (CLAUDE.md §5.3).
--
-- SVG stays out, for `app_icon` exactly as for `login_background`: it is XML,
-- it can carry script, and both are served from our own origin to
-- unauthenticated visitors — the sign-in page shows the mark before anybody
-- has a token (S32). The size and dimension bounds an icon must meet are
-- narrower than a full-page background's and are enforced in `lib/image.js`,
-- where the error can say WHICH bound was missed; the CHECK here stays the
-- outer envelope both share.
--
-- ── The trend switch ─────────────────────────────────────────────────────────
-- `trend_enabled` hides the risk-trend panel for every user when the
-- administrator turns it off. Display only: `risk_snapshots` keeps being
-- written by each completed violation-cache build, so re-enabling shows
-- unbroken history rather than a gap for the period it was off. A snapshot is
-- one row per connection per day and is swept at SNAPSHOT_RETENTION_DAYS, so
-- capturing through an off period costs nothing worth saving.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branding_kind') THEN
    ALTER TABLE branding_assets DROP CONSTRAINT branding_kind;
  END IF;
  ALTER TABLE branding_assets ADD CONSTRAINT branding_kind
    CHECK (kind IN ('login_background', 'app_icon'));
END $$;

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS trend_enabled boolean NOT NULL DEFAULT TRUE;

-- No index. `branding_assets` is read by primary key and `app_settings` is a
-- single row (§5.4: no speculative indexes).
