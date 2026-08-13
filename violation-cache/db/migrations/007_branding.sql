-- ── Branding: the administrator's title and login background ────────────────
-- Requirement: the administrator may rename the application and replace the
-- animated sign-in background. Both are service-wide, not per-user.

-- The title is small, always wanted alongside the rest of the settings, and has
-- the same owner, so it lives on the existing singleton row. NULL means "use the
-- built-in default" — the same encoding migration 005 uses for an inherited
-- report quota, and for the same reason: an empty string is a title somebody
-- typed, NULL is the absence of one, and conflating them makes "reset it to the
-- default" impossible to express.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS app_title text;

ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_title_len;
ALTER TABLE app_settings ADD  CONSTRAINT app_settings_title_len
  CHECK (app_title IS NULL OR length(btrim(app_title)) BETWEEN 1 AND 60);

-- ── branding_assets ──────────────────────────────────────────────────────────
-- The image bytes get a table of their OWN and are deliberately NOT a column on
-- app_settings. The administration listing CROSS JOINs app_settings for every
-- account row (see docs/PERFORMANCE.md §1.2); a multi-megabyte bytea on that
-- table would put image bytes in the path of a hot query. The reports /
-- report_file_chunks split exists for exactly this reason.
--
-- No chunking here: chunking bounds memory for 50 MB report files, and this is
-- capped at 5 MB by both the CHECK below and lib/image.js.
CREATE TABLE IF NOT EXISTS branding_assets (
  kind        text        PRIMARY KEY,
  bytes       bytea       NOT NULL,
  mime_type   text        NOT NULL,
  -- sha256 of `bytes`. Serves as the HTTP ETag and as the cache-busting version
  -- in the image URL, so a browser re-fetches exactly when the image changes.
  etag        text        NOT NULL,
  width       integer     NOT NULL,
  height      integer     NOT NULL,
  byte_size   integer     NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- One known asset today. A CHECK rather than a free-text column so a typo
  -- cannot silently create a second, unread row.
  CONSTRAINT branding_kind CHECK (kind IN ('login_background')),
  -- SVG is absent on purpose: it is XML, can carry script, and this asset is
  -- served from our own origin to unauthenticated visitors (S32).
  CONSTRAINT branding_mime CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT branding_size CHECK (byte_size > 0 AND byte_size <= 5242880),
  CONSTRAINT branding_dims CHECK (width > 0 AND height > 0)
);

-- No index beyond the primary key: every read is a single lookup by `kind`.

DROP TRIGGER IF EXISTS trg_branding_assets_updated_at ON branding_assets;
CREATE TRIGGER trg_branding_assets_updated_at BEFORE UPDATE ON branding_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
