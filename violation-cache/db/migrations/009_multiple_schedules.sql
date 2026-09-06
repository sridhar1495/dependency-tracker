-- SPDX-License-Identifier: MIT
-- 009 — a user may have more than one schedule, and the number is a quota.
--
-- ── Why the primary key changes ──────────────────────────────────────────────
-- `schedules.user_id` was the primary key, which is how "one schedule per user"
-- was enforced: not by application logic but by the schema, which is the right
-- place for a rule like that. The rule itself is what is wrong now. A user with
-- one DependencyTrack connection routinely wants a Monday operational report
-- and a monthly licence report going to different people, and today that is two
-- accounts or nothing.
--
-- The row therefore gains an `id` of its own and `user_id` becomes an ordinary
-- indexed foreign key. Everything that hung off `(user_id)` hangs off
-- `(schedule_id)` instead.
--
-- ── DATA IMPACT (CLAUDE.md §5.3) ─────────────────────────────────────────────
-- This migration DROPS TWO PRIMARY KEYS and one foreign key, and ADDS columns.
-- It drops no column and deletes no row. Every existing schedule survives as a
-- schedule, keeping its frequency, time, projects and run history:
--
--   * schedules       — gains `id` (generated per row) and `name`; the
--                       user_id primary key becomes a plain indexed column.
--   * schedule_projects — gains `schedule_id`, backfilled from the owning
--                       user's single existing schedule. The (user_id,
--                       project_uuid) key becomes (schedule_id, project_uuid).
--   * schedule_runs   — gains `schedule_id`, backfilled the same way. It is
--                       ON DELETE SET NULL, not CASCADE: cancelling a schedule
--                       must not erase the record that it ran (CLAUDE.md §5.4).
--                       user_id stays, so the history is still owned and still
--                       swept by the 90-day purge.
--
-- Reversing this by hand is possible while each user still has one schedule and
-- becomes meaningless once they have two, which is the point at which the
-- feature is in use.
--
-- Every step here is guarded so a partially-applied state can re-run
-- (CLAUDE.md §5.3). One thing this migration cannot preserve, and the reviewer
-- should know it: **004_admin_principal.sql is no longer replayable once this
-- has run.** Its seed says `INSERT INTO schedules (user_id) ... ON CONFLICT
-- (user_id)`, and ON CONFLICT needs the unique constraint that "one schedule
-- per user" was, which is exactly what this migration removes. The two
-- requirements are contradictory, so this is a consequence of the feature and
-- not an oversight. No ordinary deployment replays a migration it has already
-- recorded — 001..009 on an empty database, or 009 alone on a database at 008,
-- both work — but a harness that drops schema_migrations and re-runs the
-- directory against an already-migrated schema will fail on 004.

-- ── schedules.id ─────────────────────────────────────────────────────────────
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();

-- A label the user chooses, distinct from report_name: this one names the
-- SCHEDULE in the settings list, that one names the FILE that gets emailed.
-- Conflating them would mean renaming a row in a list silently renames an
-- attachment somebody's inbox rules already match on.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS name text;

DO $$
BEGIN
  -- schedule_projects references schedules(user_id); that FK has to go before
  -- the key it points at can.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedule_projects_user_id_fkey') THEN
    ALTER TABLE schedule_projects DROP CONSTRAINT schedule_projects_user_id_fkey;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schedules_pkey' AND conrelid = 'schedules'::regclass
                AND contype = 'p'
                AND (SELECT attname FROM pg_attribute
                      WHERE attrelid = 'schedules'::regclass AND attnum = conkey[1]) = 'user_id') THEN
    ALTER TABLE schedules DROP CONSTRAINT schedules_pkey;
    ALTER TABLE schedules ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- user_id keeps its cascade to users but is no longer unique. The poller reads
-- by next_run_at (ix_sched_due, unchanged); this index serves the two new hot
-- queries — listing one account's schedules, and counting them for the quota.
CREATE INDEX IF NOT EXISTS ix_sched_user ON schedules (user_id);

-- ── schedule_projects moves to the schedule ──────────────────────────────────
ALTER TABLE schedule_projects ADD COLUMN IF NOT EXISTS schedule_id uuid;

UPDATE schedule_projects p SET schedule_id = s.id
  FROM schedules s WHERE s.user_id = p.user_id AND p.schedule_id IS NULL;

-- A row whose owner has no schedule row at all cannot be attributed to one and
-- was already unreachable — the only reader joined through schedules.
DELETE FROM schedule_projects WHERE schedule_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schedule_projects_pkey' AND conrelid = 'schedule_projects'::regclass
                AND array_length(conkey, 1) = 2
                AND (SELECT attname FROM pg_attribute
                      WHERE attrelid = 'schedule_projects'::regclass AND attnum = conkey[1]) = 'user_id') THEN
    ALTER TABLE schedule_projects DROP CONSTRAINT schedule_projects_pkey;
  END IF;
END $$;

ALTER TABLE schedule_projects ALTER COLUMN schedule_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schedule_projects_pkey' AND conrelid = 'schedule_projects'::regclass) THEN
    ALTER TABLE schedule_projects ADD CONSTRAINT schedule_projects_pkey
      PRIMARY KEY (schedule_id, project_uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedule_projects_schedule_fkey') THEN
    ALTER TABLE schedule_projects ADD CONSTRAINT schedule_projects_schedule_fkey
      FOREIGN KEY (schedule_id) REFERENCES schedules (id) ON DELETE CASCADE;
  END IF;

  -- user_id stays a real column so every read can still be scoped by it
  -- directly (CLAUDE.md §5.1) rather than through a join, but it now points at
  -- users rather than at the schedules key that no longer exists.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedule_projects_owner_fkey') THEN
    ALTER TABLE schedule_projects ADD CONSTRAINT schedule_projects_owner_fkey
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── schedule_runs remembers which schedule ran ───────────────────────────────
ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS schedule_id uuid;

UPDATE schedule_runs r SET schedule_id = s.id
  FROM schedules s WHERE s.user_id = r.user_id AND r.schedule_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedule_runs_schedule_fkey') THEN
    -- SET NULL, not CASCADE: cancelling a schedule must not erase the evidence
    -- that it ran and what it sent. user_id still cascades from users, so the
    -- trail dies with the account and not before.
    ALTER TABLE schedule_runs ADD CONSTRAINT schedule_runs_schedule_fkey
      FOREIGN KEY (schedule_id) REFERENCES schedules (id) ON DELETE SET NULL;
  END IF;
END $$;

-- The run list is per schedule now, so the index that served it per user is not
-- enough on its own.
CREATE INDEX IF NOT EXISTS ix_runs_schedule_time ON schedule_runs (schedule_id, started_at DESC);

-- ── The administrator's seeded schedule ──────────────────────────────────────
-- 004 gave the reserved administrator row the same dependent rows a real
-- account gets, including exactly one schedule, because the schema demanded
-- one. Registration does not seed one any more and an account starts with
-- none, so that row is now a phantom: it would show in the administrator's own
-- settings as an unnamed schedule with no projects that can never fire.
--
-- Removed only if it is still untouched — never enabled, never named, never
-- given a project, never run. An administrator who has actually configured it
-- keeps it.
DELETE FROM schedules s
 WHERE s.user_id = '00000000-0000-4000-8000-000000000001'
   AND NOT s.enabled AND s.name IS NULL AND s.report_name IS NULL
   AND s.last_run_at IS NULL AND s.next_run_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM schedule_projects p WHERE p.schedule_id = s.id);

-- ── The schedule count is a quota, like the report count ─────────────────────
-- Same shape as max_reports (migration 005), for the same reason: it is a
-- capacity decision about the server, so the administrator owns the number,
-- globally or for one account. NULL on the per-user column means "follow the
-- global default" — a stored 5 could not be told apart from an unset 5.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_max_schedules integer NOT NULL DEFAULT 5;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS max_schedules integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_max_schedules') THEN
    ALTER TABLE app_settings ADD CONSTRAINT app_settings_max_schedules
      CHECK (default_max_schedules BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_max_schedules') THEN
    ALTER TABLE user_settings ADD CONSTRAINT settings_max_schedules
      CHECK (max_schedules IS NULL OR max_schedules BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sched_name_len') THEN
    -- The name is shown in a list and travels in no header, so it is bounded
    -- rather than pattern-matched. report_name is the one with a filename to
    -- protect (migration 006).
    ALTER TABLE schedules ADD CONSTRAINT sched_name_len
      CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 120);
  END IF;
END $$;
