-- SPDX-License-Identifier: MIT
-- 015 — a schedule may store a RULE for which projects it covers, not only a list.
--
-- ── Why ──────────────────────────────────────────────────────────────────────
-- `schedule_projects` holds a frozen set of UUIDs chosen when the schedule was
-- created. Every release moves which version DependencyTrack marks `isLatest`,
-- so a schedule meant to cover "the current release of everything under this
-- group" had to be deleted and rebuilt by hand each time — and until somebody
-- did, it silently kept reporting the previous release.
--
-- `selection_mode` says how the stored rows are to be read:
--
--   'fixed'         the projects themselves. Today's behaviour, and the DEFAULT,
--                   so no existing schedule changes what it covers.
--   'latest_under'  ANCHORS, not targets. Each run descends from them applying
--                   each level's own DependencyTrack collectionLogic and
--                   collects the LEAVES — the same rule the dashboard's group
--                   rows already roll up by, so a report covers exactly the
--                   projects the group row on screen is summarising.
--   'latest_all'    the whole portfolio's latest-marked leaves. No anchors are
--                   stored at all, which is why `schedule_projects` being empty
--                   can no longer mean "not configured yet".
--
-- ── Why the run history grows two columns ────────────────────────────────────
-- Under a rule the covered set moves on its own, and the two directions are not
-- equally safe. Growth is benign. SHRINKAGE is a security blind spot: a deleted
-- branch, an un-marked `isLatest` or an archived project quietly narrows the
-- report, and nobody notices an absence — the workbook still arrives and still
-- looks healthy.
--
-- `resolved_project_count` makes drift visible in run history; `resolved_projects`
-- is what lets a run DIFF itself against the one before it and say which projects
-- left, by name, in the covering email. A count alone answers "12 became 9" but
-- not "which three stopped being covered", which is the question that matters.
--
-- Bounded: `schedule_runs` is swept at 90 days and a resolution is capped, so
-- this is tens of kilobytes per run at worst (CLAUDE.md §13).
--
-- Non-destructive. Nothing is dropped, and every existing row keeps its meaning.

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS selection_mode text NOT NULL DEFAULT 'fixed';

-- The allowed set belongs in the database as well as in normalise(), per §5.4:
-- a mode this service cannot resolve must never reach a run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'schedules_selection_mode'
  ) THEN
    ALTER TABLE schedules ADD CONSTRAINT schedules_selection_mode
      CHECK (selection_mode IN ('fixed', 'latest_under', 'latest_all'));
  END IF;
END $$;

ALTER TABLE schedule_runs
  ADD COLUMN IF NOT EXISTS resolved_project_count integer;

-- jsonb rather than a uuid[]: the diff prints NAMES, and carrying them here is
-- what keeps the email readable without a second lookup against a portfolio
-- that may no longer contain the project that vanished.
ALTER TABLE schedule_runs
  ADD COLUMN IF NOT EXISTS resolved_projects jsonb;

-- No index. Both columns are read only for the run they belong to and for the
-- immediately preceding run of the same schedule, both of which the existing
-- ix_runs_user_time already serves (§5.4: no speculative indexes).
