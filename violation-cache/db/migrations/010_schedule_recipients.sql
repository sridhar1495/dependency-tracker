-- SPDX-License-Identifier: MIT
-- 010 — a schedule may address its own recipients, and the phantom schedules
--       left behind by registration are removed.
--
-- ── Why recipients move ──────────────────────────────────────────────────────
-- Migration 009 let a user own several schedules, but every one of them still
-- emailed the same list: To, CC and Subject lived once per account on
-- mail_settings. That defeats most of the reason to have several — a weekly
-- operational report and a monthly licence report usually go to different
-- people.
--
-- The SMTP connection stays on the account: host, port, TLS, username, password
-- and the From address describe one mail server the account authenticates to,
-- and duplicating them per schedule would mean re-entering a password to change
-- a recipient. Only the addressing moves.
--
-- ── How "inherited" is represented ───────────────────────────────────────────
-- NULL, not an empty array. The two are different answers: NULL means "use the
-- account's list", an empty array would mean "send to nobody", and a schedule
-- that silently stopped delivering is worse than one that refuses to save. The
-- same reasoning as user_settings.max_reports in migration 005 — a value cannot
-- encode "not decided here".
--
-- ── DATA IMPACT (CLAUDE.md §5.3) ─────────────────────────────────────────────
-- Adds three nullable columns. Every existing schedule keeps NULL and therefore
-- keeps delivering exactly where it delivers today.
--
-- It also DELETES rows — see the second section, which explains which and why.

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS to_addrs text[];
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS cc_addrs text[];
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS subject  text;

DO $$
BEGIN
  -- An override that exists must name somebody. NULL is how a schedule says
  -- "use the account list"; an empty array would be a schedule addressed to
  -- nobody, which is a silent delivery failure rather than a configuration.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sched_to_addrs_nonempty') THEN
    -- cardinality(), not array_length(). array_length returns NULL for an empty
    -- array, and a CHECK treats NULL as satisfied — so the obvious spelling of
    -- this constraint accepts exactly the value it exists to reject.
    ALTER TABLE schedules ADD CONSTRAINT sched_to_addrs_nonempty
      CHECK (to_addrs IS NULL OR cardinality(to_addrs) >= 1);
  END IF;
  -- CC may legitimately be an empty list: "copy nobody" is a real choice, and
  -- distinct from "inherit the account's CC list".
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sched_subject_len') THEN
    ALTER TABLE schedules ADD CONSTRAINT sched_subject_len
      CHECK (subject IS NULL OR char_length(subject) <= 200);
  END IF;
END $$;

-- ── Phantom schedules from registration ──────────────────────────────────────
-- Until migration 009, `users.create` inserted a schedules row for every new
-- account, because the schema required exactly one per user. Registration does
-- not do that any more and an account now starts with none — but every account
-- created before this still carries that row, and it renders in the settings
-- list as an unnamed schedule with no projects that can never fire.
--
-- 009 removed the administrator's copy; this removes everybody else's. The
-- guard is deliberately narrow: only a row that has never been enabled, never
-- named, never given a report name, never armed, never run, has no projects and
-- carries no recipient override of its own. Anything a user has actually
-- touched is left alone, so nothing anyone configured is lost.
DELETE FROM schedules s
 WHERE NOT s.enabled
   AND s.name IS NULL AND s.report_name IS NULL
   AND s.last_run_at IS NULL AND s.next_run_at IS NULL AND s.running_since IS NULL
   AND s.to_addrs IS NULL AND s.cc_addrs IS NULL AND s.subject IS NULL
   AND NOT EXISTS (SELECT 1 FROM schedule_projects p WHERE p.schedule_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM schedule_runs r WHERE r.schedule_id = s.id);
