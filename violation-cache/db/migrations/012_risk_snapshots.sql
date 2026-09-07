-- SPDX-License-Identifier: MIT
-- 012 — a daily record of what the portfolio looked like, so risk can be shown
--       as a trend rather than only as today's number.
--
-- ── What a row is ────────────────────────────────────────────────────────────
-- One row per DependencyTrack connection per day. It is written at the end of a
-- violation-cache build, which is the only moment the service has a complete,
-- consistent picture of a portfolio; the last build of a day overwrites the
-- earlier ones, so the row always holds the most recent measurement for that
-- day rather than the first.
--
-- Keyed by fingerprint, not by user, for exactly the reason violation_caches is
-- (CLAUDE.md §7.5): twenty accounts pointing at one DependencyTrack share one
-- crawl, and so they must share one snapshot. Keying it per user would multiply
-- both the storage and the upstream work by the number of accounts and produce
-- twenty identical series.
--
-- The consequence worth naming: rotating a DependencyTrack API key changes the
-- fingerprint, and the history restarts. That is inherent to sharing by
-- credential — two connections that cannot be proven identical must not be
-- allowed to pool their history — and it is the same behaviour the cache
-- already has.
--
-- ── Why both halves are stored ───────────────────────────────────────────────
-- "Critical" means two different things in this product, and the screen already
-- shows the second one:
--
--   pure CVE severity   the vulnerability counts DependencyTrack embeds per
--                       project — sev_critical here
--   the tile number     that, PLUS operational, licence and security-policy
--                       failures folded together — what the KPI tiles display
--
-- Which of the two a trend graph should plot is a presentation question, and a
-- presentation question must not be answered by a schema: this table accretes
-- history, so a wrong answer here cannot be corrected later without discarding
-- the record. Storing the components separately costs nine integers per
-- connection per day and NO additional upstream request — the policy counts are
-- already in memory, having just been crawled — and it leaves the choice where
-- it can still be changed. The reader folds; the recorder does not.
--
-- Note that the four severity columns and the nine policy columns are summed
-- over the SAME set of projects: DependencyTrack's root projects, active only.
-- That is the set the dashboard's tiles sum, so the two agree by construction.
--
-- ── Why there is no foreign key to violation_caches ──────────────────────────
-- caches.sweepOrphaned() deletes cache rows for connections nobody points at any
-- more, and expired ones a week after they lapse. A cache row is a 24-hour
-- artefact; this history is the entire point of the feature. A cascade would
-- let ordinary housekeeping quietly destroy a year of measurements, so the two
-- lifetimes are kept independent and this table is bounded by its own retention
-- sweep instead (SNAPSHOT_RETENTION_DAYS, CLAUDE.md §13).
--
-- ── Why there is no second index ─────────────────────────────────────────────
-- The only query is "this connection's rows, newest window, in day order", and
-- the primary key is already a btree on (fingerprint, day): the range scan and
-- the ordering both come out of it. §5.4 admits an index when a query in the
-- design needs one, and none does. The retention sweep scans, deliberately — it
-- runs from ten-minutely housekeeping over a table bounded at retention days ×
-- connections, not from a request.
--
-- ── DATA IMPACT (CLAUDE.md §5.3) ─────────────────────────────────────────────
-- Creates one table. Nothing existing is read, altered or deleted. The table is
-- empty until the first violation-cache build completes after this ships, and
-- the graph therefore has nothing to draw until then — which is why this lands
-- ahead of the UI rather than with it.

CREATE TABLE IF NOT EXISTS risk_snapshots (
  fingerprint        text        NOT NULL,
  -- A calendar day in UTC. date, not timestamptz: the row answers "what did
  -- this look like on the 4th", and two builds on the same day are the same
  -- row. captured_at below keeps the precise instant of the winning build.
  day                date        NOT NULL,
  captured_at        timestamptz NOT NULL DEFAULT now(),

  -- How many root projects these totals were summed over. Named for what it is:
  -- it is NOT the size of the portfolio, which counts leaves.
  root_project_count integer     NOT NULL DEFAULT 0,

  -- Pure CVE severity, from each project's embedded metrics.
  sev_critical       integer     NOT NULL DEFAULT 0,
  sev_high           integer     NOT NULL DEFAULT 0,
  sev_medium         integer     NOT NULL DEFAULT 0,
  sev_low            integer     NOT NULL DEFAULT 0,
  sev_unassigned     integer     NOT NULL DEFAULT 0,

  -- Policy violations, from the crawl this build just finished. Column names
  -- mirror the dashboard's own breakdown keys (ops / lic / secpol) so the two
  -- can be read against each other.
  ops_fail           integer     NOT NULL DEFAULT 0,
  ops_warn           integer     NOT NULL DEFAULT 0,
  ops_info           integer     NOT NULL DEFAULT 0,
  lic_fail           integer     NOT NULL DEFAULT 0,
  lic_warn           integer     NOT NULL DEFAULT 0,
  lic_info           integer     NOT NULL DEFAULT 0,
  secpol_fail        integer     NOT NULL DEFAULT 0,
  secpol_warn        integer     NOT NULL DEFAULT 0,
  secpol_info        integer     NOT NULL DEFAULT 0,

  PRIMARY KEY (fingerprint, day)
);

DO $$
BEGIN
  -- The same shape violation_caches has asserted since migration 002. The two
  -- tables are keyed on the same SHA-256, and a constraint stated on one but
  -- not the other is worse than none on either: a truncated fingerprint would
  -- be refused by the cache and accepted here, leaving a row of history that
  -- nothing can ever look up again.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'risk_snapshots_fingerprint') THEN
    ALTER TABLE risk_snapshots ADD CONSTRAINT risk_snapshots_fingerprint
      CHECK (length(fingerprint) = 64);
  END IF;

  -- A count cannot be negative. Cheap to state, and it turns a summing bug into
  -- a failed write rather than a graph that dips below the axis.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'risk_snapshots_nonneg') THEN
    ALTER TABLE risk_snapshots ADD CONSTRAINT risk_snapshots_nonneg
      CHECK (root_project_count >= 0
         AND sev_critical >= 0 AND sev_high >= 0 AND sev_medium >= 0
         AND sev_low >= 0 AND sev_unassigned >= 0
         AND ops_fail >= 0 AND ops_warn >= 0 AND ops_info >= 0
         AND lic_fail >= 0 AND lic_warn >= 0 AND lic_info >= 0
         AND secpol_fail >= 0 AND secpol_warn >= 0 AND secpol_info >= 0);
  END IF;
END $$;
