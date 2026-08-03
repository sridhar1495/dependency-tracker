-- 002_schema.sql — application schema for the multi-user migration.
--
-- Creates every table in the approved data model in one coherent migration.
-- Later phases wire them up; nothing here changes runtime behaviour on its own.
--
-- Ownership: every table holding user data cascades from users(id), so deleting
-- an account removes all of it in a single statement. login_audit is the sole
-- exception (ON DELETE SET NULL) so the authentication trail survives deletion.
--
-- Validation split: length and structural rules are CHECK constraints here;
-- character-set rules (Unicode letters, e-mail shape) live in lib/validate.js.
-- The cluster is initialised with --locale=C, so POSIX classes such as
-- [[:alpha:]] match ASCII only and a CHECK using one would wrongly reject
-- valid non-ASCII names. A loose CHECK plus a strict application validator is
-- safer than a strict CHECK that is wrong.
--
-- Indexes: each one below is justified by a query in the design document.
-- No speculative indexes.

-- ── updated_at maintenance ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id       citext      NOT NULL,
  email          citext,
  first_name     text        NOT NULL,
  last_name      text        NOT NULL,
  password_hash  text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,

  CONSTRAINT users_login_id_len   CHECK (length(login_id) BETWEEN 3 AND 64),
  CONSTRAINT users_login_id_trim  CHECK (login_id = btrim(login_id::text)),
  CONSTRAINT users_first_name_len CHECK (length(first_name) BETWEEN 3 AND 128),
  CONSTRAINT users_last_name_len  CHECK (length(last_name)  BETWEEN 3 AND 128),
  -- No leading or trailing whitespace; the app additionally restricts the
  -- character set and collapses internal runs of spaces.
  CONSTRAINT users_first_name_trim CHECK (first_name = btrim(first_name)),
  CONSTRAINT users_last_name_trim  CHECK (last_name  = btrim(last_name)),
  -- Loose structural check only: exactly one @, no whitespace, something either side.
  CONSTRAINT users_email_shape CHECK (
    email IS NULL OR (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  ),
  CONSTRAINT users_email_len CHECK (email IS NULL OR length(email) <= 254)
);

-- citext gives case-insensitive uniqueness with a plain B-tree, so no call site
-- has to remember to match a lower() functional index.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_login_id ON users (login_id);
-- Partial: e-mail is optional, and NULLs must not collide with one another.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (email) WHERE email IS NOT NULL;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── user_sessions ────────────────────────────────────────────────────────────
-- Administrator sessions are authenticated against the on-disk credentials
-- file, not the users table, so user_id is null for them.
CREATE TABLE IF NOT EXISTS user_sessions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        REFERENCES users (id) ON DELETE CASCADE,
  principal_type text        NOT NULL,
  token_hash     bytea       NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  user_agent     text,
  ip_address     inet,

  CONSTRAINT sessions_principal_type CHECK (principal_type IN ('user', 'admin')),
  -- user_id is present exactly when the principal is a database user.
  CONSTRAINT sessions_principal_shape CHECK (
    (principal_type = 'user'  AND user_id IS NOT NULL) OR
    (principal_type = 'admin' AND user_id IS NULL)
  ),
  CONSTRAINT sessions_expiry_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT sessions_token_hash_len CHECK (octet_length(token_hash) = 32)  -- SHA-256
);

-- Only the hash is ever stored, so this is also the lookup key on every request.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_token ON user_sessions (token_hash);

-- S6: one live session per user, enforced by the database rather than by
-- application logic, so two simultaneous logins cannot both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_one_live_per_user
  ON user_sessions (user_id)
  WHERE revoked_at IS NULL AND principal_type = 'user';

-- The same rule for the single administrator principal. Indexing a constant
-- expression permits at most one matching row in the whole table.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_one_live_admin
  ON user_sessions ((true))
  WHERE revoked_at IS NULL AND principal_type = 'admin';

-- Drives the periodic expiry sweep; partial so revoked rows are not scanned.
CREATE INDEX IF NOT EXISTS ix_sessions_expiry
  ON user_sessions (expires_at) WHERE revoked_at IS NULL;

-- ── login_audit ──────────────────────────────────────────────────────────────
-- ON DELETE SET NULL: the trail must outlive the account it refers to.
-- login_id_attempted is kept as text so a deleted user's events remain readable.
CREATE TABLE IF NOT EXISTS login_audit (
  id                 bigserial   PRIMARY KEY,
  user_id            uuid        REFERENCES users (id) ON DELETE SET NULL,
  login_id_attempted text,
  event              text        NOT NULL,
  ip_address         inet,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_event CHECK (event IN (
    'register', 'login', 'logout', 'failed', 'force_disconnect', 'delete', 'lockout'
  ))
);

CREATE INDEX IF NOT EXISTS ix_audit_user_time ON login_audit (user_id, created_at DESC);
-- Supports the 90-day retention sweep.
CREATE INDEX IF NOT EXISTS ix_audit_created ON login_audit (created_at);

-- ── dt_connections ───────────────────────────────────────────────────────────
-- One DependencyTrack connection per user. The API key is AES-256-GCM
-- ciphertext; nonce and authentication tag are stored alongside it and the
-- plaintext never leaves the service.
CREATE TABLE IF NOT EXISTS dt_connections (
  user_id            uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  api_url            text        NOT NULL DEFAULT '',
  api_key_ciphertext bytea,
  api_key_nonce      bytea,
  api_key_tag        bytea,
  frontend_url       text        NOT NULL DEFAULT '',
  is_configured      boolean     NOT NULL DEFAULT false,
  -- SHA-256 of the normalised URL + key. Joins this user to a shared cache row.
  fingerprint        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Either the whole encrypted triple is present or none of it is.
  CONSTRAINT dt_key_complete CHECK (
    (api_key_ciphertext IS NULL AND api_key_nonce IS NULL AND api_key_tag IS NULL) OR
    (api_key_ciphertext IS NOT NULL AND api_key_nonce IS NOT NULL AND api_key_tag IS NOT NULL)
  ),
  CONSTRAINT dt_fingerprint_len CHECK (fingerprint IS NULL OR length(fingerprint) = 64)
);

-- Resolves a user to the shared violation cache row for their connection.
CREATE INDEX IF NOT EXISTS ix_dt_connections_fingerprint
  ON dt_connections (fingerprint) WHERE fingerprint IS NOT NULL;

DROP TRIGGER IF EXISTS trg_dt_connections_updated_at ON dt_connections;
CREATE TRIGGER trg_dt_connections_updated_at BEFORE UPDATE ON dt_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── user_settings ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  user_id     uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  max_reports integer     NOT NULL DEFAULT 10,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT settings_max_reports CHECK (max_reports BETWEEN 1 AND 1000)
);

DROP TRIGGER IF EXISTS trg_user_settings_updated_at ON user_settings;
CREATE TRIGGER trg_user_settings_updated_at BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── mail_settings ────────────────────────────────────────────────────────────
-- Recipients are arrays rather than a child table: they are always read and
-- written as a whole unit, so a join would add cost for no benefit.
CREATE TABLE IF NOT EXISTS mail_settings (
  user_id              uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  enabled              boolean     NOT NULL DEFAULT false,
  smtp_host            text        NOT NULL DEFAULT '',
  smtp_port            integer     NOT NULL DEFAULT 587,
  smtp_secure          boolean     NOT NULL DEFAULT false,
  smtp_user            text        NOT NULL DEFAULT '',
  smtp_pass_ciphertext bytea,
  smtp_pass_nonce      bytea,
  smtp_pass_tag        bytea,
  from_addr            text        NOT NULL DEFAULT '',
  to_addrs             text[]      NOT NULL DEFAULT '{}',
  cc_addrs             text[]      NOT NULL DEFAULT '{}',
  subject              text        NOT NULL DEFAULT '',
  body                 text        NOT NULL DEFAULT '',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mail_port CHECK (smtp_port BETWEEN 1 AND 65535),
  CONSTRAINT mail_pass_complete CHECK (
    (smtp_pass_ciphertext IS NULL AND smtp_pass_nonce IS NULL AND smtp_pass_tag IS NULL) OR
    (smtp_pass_ciphertext IS NOT NULL AND smtp_pass_nonce IS NOT NULL AND smtp_pass_tag IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS trg_mail_settings_updated_at ON mail_settings;
CREATE TRIGGER trg_mail_settings_updated_at BEFORE UPDATE ON mail_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── schedules ────────────────────────────────────────────────────────────────
-- running_since provides per-user overlap protection: a claimed row is
-- non-null, so a second poller tick skips it.
CREATE TABLE IF NOT EXISTS schedules (
  user_id              uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  enabled              boolean     NOT NULL DEFAULT false,
  frequency            text        NOT NULL DEFAULT 'daily',
  hour                 smallint    NOT NULL DEFAULT 9,
  week_days            smallint[]  NOT NULL DEFAULT '{1}',
  month_day            smallint    NOT NULL DEFAULT 1,
  risk_types           text[]      NOT NULL DEFAULT '{security,license,operational}',
  next_run_at          timestamptz,
  running_since        timestamptz,
  last_run_at          timestamptz,
  last_run_status      text,
  last_run_error       text,
  failure_notification text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sched_frequency CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  CONSTRAINT sched_hour      CHECK (hour BETWEEN 0 AND 23),
  -- Capped at 28 so the day is valid in every month, including February.
  CONSTRAINT sched_month_day CHECK (month_day BETWEEN 1 AND 28),
  CONSTRAINT sched_last_status CHECK (last_run_status IS NULL OR last_run_status IN ('success', 'failed'))
);

-- P8: the poller's only search key. Partial so it contains just the rows that
-- can actually be claimed, keeping the index tiny regardless of user count.
CREATE INDEX IF NOT EXISTS ix_sched_due
  ON schedules (next_run_at) WHERE enabled AND running_since IS NULL;

DROP TRIGGER IF EXISTS trg_schedules_updated_at ON schedules;
CREATE TRIGGER trg_schedules_updated_at BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── schedule_projects ────────────────────────────────────────────────────────
-- A child table rather than an array: a user may select hundreds of projects,
-- and counting or joining them stays cheap while keeping the schedules row narrow.
CREATE TABLE IF NOT EXISTS schedule_projects (
  user_id         uuid NOT NULL REFERENCES schedules (user_id) ON DELETE CASCADE,
  project_uuid    uuid NOT NULL,
  project_name    text NOT NULL DEFAULT '',
  project_version text NOT NULL DEFAULT '',

  PRIMARY KEY (user_id, project_uuid)
);

-- ── schedule_runs ────────────────────────────────────────────────────────────
-- Append-only execution history, retained 90 days.
CREATE TABLE IF NOT EXISTS schedule_runs (
  id              bigserial   PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text        NOT NULL DEFAULT 'running',
  error           text,
  file_size_bytes bigint,

  CONSTRAINT run_status CHECK (status IN ('running', 'success', 'failed'))
);

CREATE INDEX IF NOT EXISTS ix_runs_user_time ON schedule_runs (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_runs_started   ON schedule_runs (started_at);

-- ── reports ──────────────────────────────────────────────────────────────────
-- Metadata only. The generated bytes live in report_file_chunks so that listing
-- reports never reads file content.
CREATE TABLE IF NOT EXISTS reports (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status          text        NOT NULL DEFAULT 'pending',
  filename        text,
  risk_types      text[]      NOT NULL DEFAULT '{}',
  progress        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  file_size_bytes bigint,
  project_count   integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT report_status CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  CONSTRAINT report_size   CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0)
);

-- P9: progress is rewritten repeatedly while a report runs. Leaving free space
-- in each page lets those updates stay heap-only, so the indexes below are not
-- touched on every write and the table does not bloat.
ALTER TABLE reports SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.05);

-- Serves the report list endpoint, already ordered.
CREATE INDEX IF NOT EXISTS ix_reports_user_created ON reports (user_id, created_at DESC);
-- Serves the per-user quota count without scanning completed history.
CREATE INDEX IF NOT EXISTS ix_reports_user_active
  ON reports (user_id) WHERE status IN ('completed', 'running');

DROP TRIGGER IF EXISTS trg_reports_updated_at ON reports;
CREATE TRIGGER trg_reports_updated_at BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── report_file_chunks ───────────────────────────────────────────────────────
-- 4 MB slices, read in seq order through a cursor when streaming a download, so
-- peak memory is one chunk rather than one file.
CREATE TABLE IF NOT EXISTS report_file_chunks (
  report_id uuid    NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  seq       integer NOT NULL,
  chunk     bytea   NOT NULL,

  PRIMARY KEY (report_id, seq),
  CONSTRAINT chunk_seq_nonneg CHECK (seq >= 0)
);

-- ── violation_caches ─────────────────────────────────────────────────────────
-- Not owned by a user. One row per logical DT connection, identified by
-- fingerprint, shared by every user whose credentials produce that fingerprint.
-- The API key itself is never stored here.
CREATE TABLE IF NOT EXISTS violation_caches (
  fingerprint      text        PRIMARY KEY,
  status           text        NOT NULL DEFAULT 'building',
  payload_gzip     bytea,
  project_count    integer     NOT NULL DEFAULT 0,
  failed_pipelines integer     NOT NULL DEFAULT 0,
  generated_at     timestamptz,
  expires_at       timestamptz,
  progress         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cache_status      CHECK (status IN ('building', 'ready', 'failed')),
  CONSTRAINT cache_fingerprint CHECK (length(fingerprint) = 64)
);

-- Drives TTL expiry checks and the cleanup sweep.
CREATE INDEX IF NOT EXISTS ix_caches_expiry ON violation_caches (expires_at);

DROP TRIGGER IF EXISTS trg_violation_caches_updated_at ON violation_caches;
CREATE TRIGGER trg_violation_caches_updated_at BEFORE UPDATE ON violation_caches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
