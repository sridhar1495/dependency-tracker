-- 003_system_state.sql — a tiny key/value table for one-shot operational markers.
--
-- Purpose: record that a one-time data migration has run, so it never runs
-- twice. schema_migrations tracks DDL; this tracks data steps that cannot be
-- expressed as DDL — such as seeding existing accounts from the legacy .env
-- DependencyTrack connection when per-user connections land.
--
-- Indexes: none. The primary key is the only access path and the table holds a
-- handful of rows.

CREATE TABLE IF NOT EXISTS system_state (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
