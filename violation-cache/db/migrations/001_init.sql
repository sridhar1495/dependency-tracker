-- 001_init.sql — extension bootstrap for the multi-user migration.
--
-- Scope: phase 0 establishes the migration mechanism only. Application tables
-- land in phase 1 as 002_*.sql.
--
-- Indexes: none. No tables are created here, so there is nothing to index.
--
-- citext gives case-insensitive uniqueness for login IDs and email addresses
-- with an ordinary B-tree index, rather than a functional lower() index that
-- every call site would have to remember to match (CLAUDE.md §5.4).
--
-- gen_random_uuid() is built into PostgreSQL 13+, so pgcrypto is NOT required.

CREATE EXTENSION IF NOT EXISTS citext;
