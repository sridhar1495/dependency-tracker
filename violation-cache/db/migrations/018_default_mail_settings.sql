-- SPDX-License-Identifier: MIT
-- 018 — an installation-wide default SMTP server.
--
-- ── Why this exists ───────────────────────────────────────────────────────────
-- mail_settings is per-user by design (CLAUDE.md §6.9, §6.8): each account
-- authenticates to its own mail server, and duplicating one account's SMTP
-- password onto another's row was never on the table. But most installations
-- have exactly one mail server their accounts would all use anyway, and asking
-- every new user to find and enter its host, port and credentials before they
-- can receive a single report is friction with no isolation benefit behind it.
--
-- This table is that one server, administrator-owned, exactly the shape
-- app_settings and app_themes already are: it describes the installation, not
-- a principal, so §7.5's per-user scoping does not apply to it.
--
-- ── How it is used, not merged ───────────────────────────────────────────────
-- This is NOT a per-property cascade like the colour theme (Q49) — a user's
-- own SMTP settings are either complete or they are not, and lib/mail-settings.js
-- resolves to this row as one unit only when an account has `enabled = true`
-- but has never set its own smtp_host. An account that has configured its own
-- server is never touched by a later change here, and a user's own recipients,
-- subject and body are never read from this table — only the connection itself
-- (host, port, TLS, credentials, From address) is installation-wide; who a
-- user's own reports go to stays theirs to say.
--
-- ── Why its own table, not app_settings ──────────────────────────────────────
-- Same reasoning migration 017 gave for app_themes: app_settings is read on
-- every administration listing, and an encrypted secret riding along on a
-- query that only wants a report quota is a column nobody there needed.
--
-- ── DATA IMPACT (CLAUDE.md §5.3) ─────────────────────────────────────────────
-- Creates one new, empty table. Nothing existing changes: with no row present,
-- lib/mail-settings.js's fallback finds nothing to fall back to and every
-- account's mail behaves exactly as it did before this migration.

CREATE TABLE IF NOT EXISTS default_mail_settings (
  -- Singleton, the same shape app_settings and app_themes use: this describes
  -- the installation, not a user.
  id                   boolean     PRIMARY KEY DEFAULT TRUE CHECK (id),
  enabled              boolean     NOT NULL DEFAULT false,
  smtp_host            text        NOT NULL DEFAULT '',
  smtp_port            integer     NOT NULL DEFAULT 587,
  smtp_secure          boolean     NOT NULL DEFAULT false,
  smtp_user            text        NOT NULL DEFAULT '',
  smtp_pass_ciphertext bytea,
  smtp_pass_nonce      bytea,
  smtp_pass_tag        bytea,
  from_addr            text        NOT NULL DEFAULT '',
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT default_mail_port CHECK (smtp_port BETWEEN 1 AND 65535),
  CONSTRAINT default_mail_pass_complete CHECK (
    (smtp_pass_ciphertext IS NULL AND smtp_pass_nonce IS NULL AND smtp_pass_tag IS NULL) OR
    (smtp_pass_ciphertext IS NOT NULL AND smtp_pass_nonce IS NOT NULL AND smtp_pass_tag IS NOT NULL)
  )
);

-- No index: the table holds at most one row, reached by its primary key.

DROP TRIGGER IF EXISTS trg_default_mail_settings_updated_at ON default_mail_settings;
CREATE TRIGGER trg_default_mail_settings_updated_at BEFORE UPDATE ON default_mail_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
