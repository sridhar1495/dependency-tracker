-- SPDX-License-Identifier: MIT
-- 013 — cached dependency-graph walks, so a release engineer can tell a direct
--       finding from a transitive one, and verify the transitive ones.
--
-- ── The problem this answers ─────────────────────────────────────────────────
-- A release engineer scanning open findings needs a fast release/backlog split:
-- a DIRECT dependency's vulnerability blocks the release; a TRANSITIVE one goes
-- to the security SME's backlog. That split does not need this table at all —
-- it is a single membership check against DependencyTrack's own
-- project.directDependencies, cheap enough to do live on every dialog open.
--
-- What DOES need caching is the second step: when an engineer wants to verify a
-- "Transitive" tag rather than take it on faith, showing the actual chain from
-- the project down to that component means walking DependencyTrack's
-- dependencyGraph endpoint node by node — potentially dozens of calls for one
-- project. That walk is opt-in (a toggle in the dialog, off by default) and
-- this table is where its result is kept so a second user, or a second click,
-- does not pay for it twice.
--
-- ── Why this is a separate table from violation_caches ───────────────────────
-- Different lifetime, different trigger, different shape. A violation cache
-- expires on a fixed TTL and is rebuilt on every refresh; a dependency-path
-- walk stays correct for as long as the project's SBOM does not change, however
-- long that is, and only goes stale when DependencyTrack records a new BOM
-- import (bom_import_at below). Folding the two together would mean either
-- rebuilding the graph on every violation refetch — most of which touch the
-- SBOM not at all — or leaving a violation-cache row we cannot express "stale"
-- for on the wrong schedule.
--
-- ── Why keyed by (fingerprint, project_uuid), not by project alone ───────────
-- The same reason as every other shared cache in this schema (CLAUDE.md §7.5):
-- users sharing one DependencyTrack connection share one walk of one project.
-- project_uuid alone would let two different DependencyTrack instances that
-- happen to reuse a UUID (a restored install, a cloned instance) read each
-- other's cached graph.
--
-- ── Why the direct-dependency set is not a column here ───────────────────────
-- It costs one DependencyTrack call (GET /api/v1/project/{uuid}) and is always
-- fetched live, every time the dialog opens — there is no staleness question
-- to cache an answer for, and the Direct/Transitive badge must never lag a
-- moment behind what DependencyTrack currently reports. Only the expensive,
-- opt-in, multi-call graph WALK is worth caching; the row below is that walk's
-- result plus enough of its own job-status shape (mirroring violation_caches,
-- CLAUDE.md §6.3) to recover from a process that died mid-walk.
--
-- ── DATA IMPACT (CLAUDE.md §5.3) ─────────────────────────────────────────────
-- Creates one table. Nothing existing is read, altered or deleted.

CREATE TABLE IF NOT EXISTS dependency_paths (
  fingerprint          text        NOT NULL,
  project_uuid         uuid        NOT NULL,

  -- building | ready | failed. No 'stale' here — staleness is not time-based
  -- (see bom_import_at) so it is derived at read time, not stored as a status.
  status               text        NOT NULL DEFAULT 'building',

  -- DependencyTrack's project.lastBomImport this row was walked against, so a
  -- reader can tell "a newer BOM has landed since this walk" from a project
  -- response that costs one call it is already making for the direct set.
  -- NULL means the project has never had a BOM imported, or DependencyTrack
  -- did not report one — either way, nothing to compare staleness against.
  bom_import_at        timestamptz,

  -- Discovered so far, so a poller can show "resolved 12 of 40" while a walk
  -- is in flight. total_components grows as the frontier is discovered; it is
  -- not known upfront the way a paginated fetch's page count is.
  total_components     integer     NOT NULL DEFAULT 0,
  resolved_components  integer     NOT NULL DEFAULT 0,

  -- One shortest chain per transitive component reached by the walk, keyed by
  -- component identity (purl, or name@group@version when a purl is absent —
  -- see lib/dependency-paths.js). A component the walk never reaches — DT
  -- recorded no edge to it, which is the common case for a flat Maven SBOM —
  -- simply has no entry; the dialog says so rather than inventing a path.
  --   { "<componentKey>": { "chain": ["directDepName", ..., "targetName"],
  --                          "multiple": true|false } }
  -- "multiple" means the walk found more than one route in from a different
  -- direct dependency (a shared low-level package is the common case) — it is
  -- a signal, not a second stored chain, so a diamond-heavy graph cannot blow
  -- this row up combinatorially.
  paths                jsonb       NOT NULL DEFAULT '{}'::jsonb,

  error                text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (fingerprint, project_uuid)
);

DO $$
BEGIN
  -- Same shape violation_caches and risk_snapshots have asserted since
  -- migrations 002 and 012 — the three tables key on the same SHA-256, and a
  -- constraint stated on two of them but not the third is worse than none on
  -- any: a truncated fingerprint would be refused by the other caches and
  -- accepted here, leaving a row nothing else can ever look up.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dependency_paths_fingerprint') THEN
    ALTER TABLE dependency_paths ADD CONSTRAINT dependency_paths_fingerprint
      CHECK (length(fingerprint) = 64);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dependency_paths_status') THEN
    ALTER TABLE dependency_paths ADD CONSTRAINT dependency_paths_status
      CHECK (status IN ('building', 'ready', 'failed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dependency_paths_nonneg') THEN
    ALTER TABLE dependency_paths ADD CONSTRAINT dependency_paths_nonneg
      CHECK (total_components >= 0 AND resolved_components >= 0);
  END IF;
END $$;
