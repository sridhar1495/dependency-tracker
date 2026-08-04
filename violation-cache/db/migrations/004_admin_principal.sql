-- SPDX-License-Identifier: MIT
-- 004 — a data identity for the administrator principal.
--
-- The administrator is AUTHENTICATED against /data/admin-credentials.json and
-- never against this table (CLAUDE.md §7.4). That rule is unchanged. What was
-- missing is somewhere to keep the administrator's OWN dashboard configuration:
-- a DependencyTrack connection, report quota, mail settings and a schedule.
--
-- Every per-user table is keyed by users(id) with ON DELETE CASCADE. Rather than
-- widen all of them to accept "either a user id or the administrator", which
-- would touch every query in the service, the administrator gets one reserved
-- row here and then flows through the existing per-user paths unchanged.
--
-- Three properties make that safe:
--
--   * The id is fixed and reserved. gen_random_uuid() produces version-4 uuids
--     with 122 random bits; this one is chosen, not generated, and no other row
--     can collide with it.
--   * The login_id cannot be registered. Underscore IS a legal login character,
--     so this name is added to ALWAYS_RESERVED in lib/validate.js and rejected
--     by name at registration. The unique index is the backstop behind that.
--   * The password hash is deliberately unusable. Nothing authenticates against
--     this row — the sign-in route only reaches users.verifyLookup() for
--     non-administrator sign-ins — but if it ever did, verifyPassword() returns
--     false for a malformed hash rather than throwing.
--
-- The administration panel excludes this row: it is a configuration holder, not
-- an account, and listing it would invite someone to treat it as one.

INSERT INTO users (id, login_id, email, first_name, last_name, password_hash)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  '__administrator__',
  NULL,
  'System',
  'Administrator',
  -- Not a valid scrypt$N$r$p$salt$dk string, so it can never verify.
  'reserved-principal-no-password'
)
ON CONFLICT (id) DO NOTHING;

-- The same rows registration seeds for a real account, so every later read is a
-- plain indexed lookup with no "row might not exist" branch (CLAUDE.md §6.2).
INSERT INTO dt_connections (user_id) VALUES ('00000000-0000-4000-8000-000000000001')
  ON CONFLICT (user_id) DO NOTHING;
INSERT INTO user_settings  (user_id) VALUES ('00000000-0000-4000-8000-000000000001')
  ON CONFLICT (user_id) DO NOTHING;
INSERT INTO mail_settings  (user_id) VALUES ('00000000-0000-4000-8000-000000000001')
  ON CONFLICT (user_id) DO NOTHING;
INSERT INTO schedules      (user_id) VALUES ('00000000-0000-4000-8000-000000000001')
  ON CONFLICT (user_id) DO NOTHING;
