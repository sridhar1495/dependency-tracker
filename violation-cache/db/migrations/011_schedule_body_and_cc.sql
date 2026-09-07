-- SPDX-License-Identifier: MIT
-- 011 — a schedule may write its own message body, and "copy nobody" becomes a
--       state a user can actually choose.
--
-- ── Why the body moves ───────────────────────────────────────────────────────
-- Migration 010 gave a schedule its own To, CC and Subject, on the grounds that
-- a weekly operational report and a monthly licence report usually go to
-- different people. The body was left behind, which made the split half a
-- feature: the covering note is the part that says what the reader is looking
-- at, and one account-wide sentence cannot introduce two different reports.
--
-- The SMTP connection still stays on the account — host, port, TLS, credentials
-- and From describe one mail server the account authenticates to (§6.8).
--
-- ── Why CC needs a data change, not just a control ───────────────────────────
-- The three states already existed in the schema after 010: NULL means "use the
-- account's list", an empty array means "copy nobody", a populated array is an
-- override. But neither of the two code paths could produce the middle one —
-- `schedules.normalise()` turned an empty list into NULL, and the route's
-- `forClient()` turned it back into null on the way out. So "copy nobody" was
-- expressible in PostgreSQL and unreachable from the product.
--
-- Making it reachable retires an implicit rule. Until now, overriding To
-- silently dropped the account's CC, because there was no way to say "no CC"
-- and copying strangers on a report addressed elsewhere was the worse default.
-- With a visible toggle that reasoning inverts: a user who can see CC switched
-- on would be astonished to find it dropped because they also set To.
--
-- ── DATA IMPACT (CLAUDE.md §5.3) ─────────────────────────────────────────────
-- Adds one nullable column: every existing schedule keeps NULL and therefore
-- keeps sending exactly the body it sends today.
--
-- It also WRITES to cc_addrs, for one narrow set of rows — see below. No row
-- changes where its mail is delivered as a result; the update exists precisely
-- so that none does.

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS body text;

DO $$
BEGIN
  -- Long enough for a real covering note, short enough that it cannot be used
  -- to smuggle a payload into the mail queue. The same shape as sched_subject_len.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sched_body_len') THEN
    ALTER TABLE schedules ADD CONSTRAINT sched_body_len
      CHECK (body IS NULL OR char_length(body) <= 5000);
  END IF;
END $$;

-- ── Preserving what the implicit rule used to do ─────────────────────────────
-- Under the old merge, a schedule that overrode To sent NO CC at all, whatever
-- cc_addrs said, because scheduler.applyScheduleRecipients() only inherited the
-- account CC when To was inherited too. The new merge honours cc_addrs
-- directly, so those rows would silently START copying the account's CC list on
-- their next run — people who have never been on that report receiving it,
-- with nothing in any diff to explain why.
--
-- Writing the old behaviour down as data is what stops that: these rows meant
-- "copy nobody", so they are made to say it. Rows that inherit To are untouched
-- and keep inheriting CC exactly as before.
UPDATE schedules
   SET cc_addrs = '{}'::text[]
 WHERE to_addrs IS NOT NULL
   AND cardinality(to_addrs) >= 1
   AND cc_addrs IS NULL;
