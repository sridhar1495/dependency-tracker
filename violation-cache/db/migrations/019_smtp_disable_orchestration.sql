-- SPDX-License-Identifier: MIT
-- 019 — distinguish an admin-caused schedule pause from a user's own.
--
-- Migration 018 gave every account a fallback SMTP server. This one finishes
-- the story: mail configuration moved from per-user to admin-only (SMTP
-- host/port/TLS/credentials are no longer editable per account — see
-- lib/mail-settings.js and dashboard/index.html), so when the administrator's
-- server becomes unavailable — cleared, or disabled — no account can send at
-- all, and a schedule left `enabled` would simply fail on its next run.
--
-- Proactively pausing every enabled schedule at the moment SMTP goes away,
-- and resuming exactly those when it comes back, needs to tell "the admin
-- paused this" apart from "the user paused this" — otherwise re-enabling would
-- also resurrect a schedule its owner deliberately stopped.
--
-- ── DATA IMPACT (CLAUDE.md §5.3) ─────────────────────────────────────────────
-- Adds one boolean column, defaulted false. No existing row's `enabled` state
-- changes; nothing is deleted.

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS disabled_by_smtp boolean NOT NULL DEFAULT false;

-- Drives the admin toggle's re-enable pass: "every schedule I paused, and
-- only those". Partial, on the same reasoning as ix_sched_running — the rows
-- matching this are a small, transient set even at scale.
CREATE INDEX IF NOT EXISTS ix_sched_disabled_by_smtp
  ON schedules (disabled_by_smtp) WHERE disabled_by_smtp;
