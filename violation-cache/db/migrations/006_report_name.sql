-- SPDX-License-Identifier: MIT
-- 006 — a schedule can carry the name its reports are delivered under.
--
-- A manual report's name travels with the request and is written straight to
-- reports.filename, which already exists. A schedule has no request: it fires
-- on a timer, so the name it should use has to be stored with the schedule.
--
-- NULL means "generate a name", which is what every existing schedule does
-- today. That is the same encoding user_settings.max_reports uses for "follow
-- the default" (migration 005) and for the same reason: an empty string is a
-- name the user typed, NULL is the absence of one, and conflating the two makes
-- "clear the name" impossible to express.
--
-- DATA IMPACT: none. The column is added nullable with no default, so every
-- existing schedule keeps generating names exactly as before.

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS report_name text;

-- The length ceiling matches lib/validate.js. The character set is NOT checked
-- here: the application validator is the authority on shape, and a CHECK using
-- a POSIX class would reject perfectly good non-ASCII names — the same
-- reasoning the users table applies to first_name and last_name (002).
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS sched_report_name_len;
ALTER TABLE schedules ADD  CONSTRAINT sched_report_name_len
  CHECK (report_name IS NULL OR length(report_name) BETWEEN 1 AND 120);

-- No index: the column is only ever read alongside the row it belongs to,
-- which is already located by primary key (CLAUDE.md §5.4).
