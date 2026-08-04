-- SPDX-License-Identifier: MIT
-- 005 — the report quota becomes an administrator setting, and a password reset
-- can require the user to choose a new one.
--
-- ── Why the quota moves ──────────────────────────────────────────────────────
-- max_reports was a per-user preference each account edited for itself. It is
-- really a capacity decision about the server's disk, so it belongs to whoever
-- runs the server. It stays per-user in the data model — the quota is still
-- enforced per user, never as a global counter (CLAUDE.md §7.5) — but the value
-- is now chosen by the administrator, globally or for one account.
--
-- ── How "inherited" is represented ───────────────────────────────────────────
-- The column becomes NULLABLE, and NULL means "follow the global default".
-- That distinction cannot be expressed by a value: a stored 10 is
-- indistinguishable from an unset 10, so raising the global default would skip
-- every account that happened to sit on the old one. NULL is the only honest
-- encoding of "not decided here", and it makes the resolution a plain COALESCE.
--
-- ── DATA IMPACT (CLAUDE.md §5.3) ─────────────────────────────────────────────
-- This migration WRITES to existing rows. No column and no row is dropped.
--
--   * user_settings.max_reports = 10 → NULL. Ten was the old default, so these
--     accounts never expressed a preference; they now follow the global value,
--     which is itself seeded to 10. Nothing changes for them today.
--   * user_settings.max_reports <> 10 → LEFT AS IS, and now reads as a
--     deliberate administrator override. Somebody chose that number; silently
--     resetting it to the default would be the destructive option.
--
-- The effect is reversible by hand if it is ever wrong: an account that should
-- follow the global default is set back to NULL, and one that should not is
-- given its number back.

-- ── app_settings ─────────────────────────────────────────────────────────────
-- Service-wide configuration the administrator owns. Deliberately NOT
-- system_state: that table is documented as a ledger of one-shot operational
-- markers (003), and mixing settings into it would blur "has this run?" with
-- "what is configured?". More sections are expected here, so it is a real table
-- with typed columns and constraints rather than a jsonb bag.
--
-- Exactly one row, enforced by the primary key: `id` may only ever be TRUE, so
-- a second INSERT collides instead of creating a second source of truth.
CREATE TABLE IF NOT EXISTS app_settings (
  id                  boolean     PRIMARY KEY DEFAULT TRUE,
  default_max_reports integer     NOT NULL DEFAULT 10,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT app_settings_singleton CHECK (id),
  -- The same range the per-user column has always had, so a global value can
  -- never be one an override could not also express.
  CONSTRAINT app_settings_max_reports CHECK (default_max_reports BETWEEN 1 AND 1000)
);

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON app_settings;
CREATE TRIGGER trg_app_settings_updated_at BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seeded with the value that was the per-user default, so the migration is a
-- no-op for every account that had not customised it.
INSERT INTO app_settings (id, default_max_reports) VALUES (TRUE, 10)
  ON CONFLICT (id) DO NOTHING;

-- ── user_settings.max_reports becomes an override ────────────────────────────
ALTER TABLE user_settings ALTER COLUMN max_reports DROP DEFAULT;
ALTER TABLE user_settings ALTER COLUMN max_reports DROP NOT NULL;

-- The CHECK has to be replaced rather than kept: a NULL passes `BETWEEN` as
-- unknown, which a CHECK treats as satisfied, but stating it explicitly means a
-- reader does not have to know that rule to see that NULL is intended.
ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS settings_max_reports;
ALTER TABLE user_settings ADD  CONSTRAINT settings_max_reports
  CHECK (max_reports IS NULL OR max_reports BETWEEN 1 AND 1000);

-- Accounts still on the old default follow the global value from now on.
-- Idempotent by construction: after the first run no row matches.
UPDATE user_settings SET max_reports = NULL WHERE max_reports = 10;

-- The administrator has no account in the administration screen and so no
-- override can ever be set for them through the UI. Their quota comes from the
-- global value like everyone else's default (CLAUDE.md §7.4).
UPDATE user_settings SET max_reports = NULL
  WHERE user_id = '00000000-0000-4000-8000-000000000001';

-- ── Forced password change ───────────────────────────────────────────────────
-- Set when an administrator resets somebody's password. Until the user chooses
-- their own, the session they are issued may reach only the set-password and
-- logout routes — so the password the administrator typed cannot be used to
-- browse that user's DependencyTrack connection or reports.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT FALSE;

-- No index: the flag is only ever read for a single user already located by
-- primary key or by the login_id unique index, and it is true for a handful of
-- rows at most. A partial index here would earn nothing (CLAUDE.md §5.4).

-- ── login_audit gains the reset event ────────────────────────────────────────
-- The event list is a CHECK constraint, not just an application Set, so a new
-- event type needs the database's agreement as well (CLAUDE.md §5.4). Without
-- this the reset route updates the password and then fails inserting its own
-- audit row — the operation half-happens and the caller is told it did not.
--
-- Not destructive: the constraint is widened, never narrowed, so every existing
-- row still satisfies it.
ALTER TABLE login_audit DROP CONSTRAINT IF EXISTS audit_event;
ALTER TABLE login_audit ADD  CONSTRAINT audit_event CHECK (event IN (
  'register', 'login', 'logout', 'failed', 'force_disconnect', 'delete', 'lockout',
  'admin_password_reset'
));
