-- SPDX-License-Identifier: MIT
-- 008_schedule_minute.sql
--
-- The schedule fires at a whole hour, which cannot express what a user in a
-- half-hour timezone asked for. The picker now takes browser-local time and
-- stores the UTC instant, so 09:00 in Asia/Kolkata (UTC+05:30) is 03:30 UTC —
-- unrepresentable while the only field was `hour`. India, Nepal, South
-- Australia, Newfoundland and the Chatham Islands are all sub-hour offsets;
-- rounding any of them silently moves the delivery by up to 45 minutes.
--
-- Default 0 so every existing row keeps firing at exactly the time it fires
-- today. No index: `minute` is never a search key — the poller's only key is
-- next_run_at, which is already computed from these fields.

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS minute smallint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sched_minute' AND conrelid = 'schedules'::regclass
  ) THEN
    ALTER TABLE schedules ADD CONSTRAINT sched_minute CHECK (minute BETWEEN 0 AND 59);
  END IF;
END $$;
