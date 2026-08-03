# Codebase Instructions for AI Assistants

This document captures the architecture, conventions, and design decisions of the
**dependency-tracker** project. Every AI-assisted change must follow these rules.

> **Revision 2.0 — multi-user migration.** The project is moving from a single-tenant,
> file-backed appliance to a multi-user application with authentication and a
> PostgreSQL system of record. This revision reverses several previously hard rules.
> Read [§0 What Changed](#0-what-changed-in-revision-20) and
> [§1.2 Migration Status](#12-migration-status) before making any change.

---

## 0. What Changed in Revision 2.0

| Rule in revision 1 | Rule now | Why |
|---|---|---|
| "Do **not** add a database" | PostgreSQL 16 is the system of record | Multi-user operation requires per-user data isolation, transactional integrity and concurrent-safe queue semantics that files cannot provide. |
| "No npm packages other than `exceljs` and `nodemailer`" | `pg` is added — and nothing else | Authentication uses Node's built-in `crypto`; no bcrypt, argon2 or JWT library. |
| File persistence under `/data/*.json` | Database tables; `/data` keeps only the admin credentials file | Files have no ownership model and no atomic multi-row updates. |
| No authentication | Bearer-token sessions on every endpoint | The service currently returns the DT API key to any unauthenticated caller. |
| DT connection configured in `.env` at install time | Per-user connection stored encrypted in the database | Each user has their own DependencyTrack connection. |
| `server.js` is a single ~1,900-line file | Split into `db/`, `lib/`, `routes/` | The file would exceed 4,000 lines otherwise. **The frontend single-file rule is unchanged.** |
| "Do **not** write integration tests that require Docker" | A database integration tier exists, opt-in via `TEST_DATABASE_URL` | The default `node --test` run stays offline and dependency-free. |

Rules **not** changed: no frontend framework, no bundler, no web framework (Express
et al.), raw `http` module only, no build step, `node --test` as the only test runner.

---

## 1. Project Overview

A three-container Docker stack that adds a multi-user hierarchical dashboard,
violation-cache service and reporting engine on top of an existing
[OWASP DependencyTrack](https://dependencytrack.org/) (DT) deployment.

```
docker-compose.yml
├── dt-dashboard          nginx:alpine     — serves login.html + index.html; proxies /api/* and /violation-cache/*
├── dt-violation-cache    node:22-alpine   — auth, caching, reports, scheduler
└── dt-postgres           postgres:16-alpine — system of record
```

### 1.1 Design authority

The full design is `docs/DependencyTrack-Dashboard-Multi-User-Architecture-Plan.docx`.
Where this file and that document disagree, **this file wins for coding conventions**
and the plan wins for architecture and sequencing. Raise the conflict rather than
silently choosing.

### 1.2 Migration status

The codebase is in transition. Each phase ships as its own pull request. Do not
write code that assumes a later phase has landed.

| Phase | Scope | Status |
|---|---|---|
| — | Coding standards (this file) | **Merged** |
| 0 | Postgres service, migration runner, connection pool, module split | **Merged** |
| 1 | Schema, indexes, data-access modules | **Merged** |
| 2 | Authentication backend | **Merged** |
| 3 | Authentication frontend (`login.html`, `apiFetch`, profile) | **Merged** |
| 4 | Per-user DT connection | **In review** |
| 5 | Per-user settings, mail, multi-tenant scheduler | **In review** |
| 6 | Reports in the database | **In review** |
| 7 | Shared violation cache | **In review** |
| 8 | Installer, infrastructure, documentation | Not started |
| 9 | Administration panel (read-only) | Not started |
| 10 | Performance validation | Not started |

**Milestone M1 = phases 0–3.** At the end of M1 the dashboard is gated behind login
but still uses one shared DT connection. That interim state is a demo checkpoint and
is **not** released to users, so no backwards-compatibility shims or feature flags
are to be written for it.

**Milestone M2 = phases 4–7**, delivered as one pull request rather than four. At the
end of M2 every user has their own DependencyTrack connection, settings, mail
configuration, schedule and reports, and the violation cache is shared by connection
fingerprint. The single-tenant files (`app-config.json`, `violation-cache.json`, the
report registry and the `/data/reports` directory) are gone; `/data` holds only
`admin-credentials.json`.

---

## 2. Repository Layout

```
dependency-tracker/
├── dashboard/
│   ├── index.html              # Single-file dashboard SPA (~3 600 lines)
│   ├── login.html              # Single-file login/register page  [phase 3]
│   └── nginx.conf.template     # nginx config with envsubst placeholders
├── violation-cache/
│   ├── server.js               # Routing + boot only (~400 lines after phase 0)
│   ├── db/
│   │   ├── pool.js             # pg.Pool wrapper: query(), tx()
│   │   ├── migrate.js          # Migration runner (advisory-locked)
│   │   └── migrations/         # 001_init.sql, 002_*.sql — append only
│   ├── lib/
│   │   ├── crypto.js           # scrypt, token mint/hash, AES-256-GCM
│   │   ├── auth.js             # Sessions, token cache, rate limiting
│   │   ├── validate.js         # Field validators (mirrored in the frontend)
│   │   ├── users.js sessions.js login-audit.js admin.js
│   │   ├── dt-connections.js user-settings.js mail-settings.js
│   │   ├── reports-db.js caches.js schedules.js scheduler.js
│   │   └── dt-fetch.js excel.js mail.js reports.js violation-cache.js
│   ├── routes/                 # auth.js profile.js dt-proxy.js config.js reports.js schedule.js cache.js
│   ├── server.test.js          # Unit tests for server helpers
│   ├── dashboard.test.js       # Unit tests for dashboard helpers
│   ├── db.test.js              # DB integration tier (opt-in)  [phase 1]
│   ├── package.json            # Dependencies: exceljs, nodemailer, pg
│   └── Dockerfile
├── docs/
├── install.sh
├── docker-compose.yml
└── .env.example
```

---

## 3. Technology Choices — Do Not Change Without Discussion

| Layer | Choice | Reason |
|---|---|---|
| Backend HTTP server | Node.js built-in `http`/`https` | No web framework |
| Database | PostgreSQL 16 (`postgres:16-alpine`) | PostgreSQL Licence; JSONB, partial indexes, `FOR UPDATE SKIP LOCKED` |
| Database driver | `pg` ^8.13 | MIT; pure JavaScript, no native build step |
| Password hashing | Built-in `crypto.scrypt` | OWASP-recommended KDF, zero dependencies |
| Session tokens | Built-in `crypto.randomBytes` + SHA-256 | Revocable, no JWT library |
| Secret encryption | Built-in AES-256-GCM | Protects DT API keys and SMTP passwords at rest |
| Excel generation | `exceljs` ^4.4.0 | MIT |
| Email delivery | `nodemailer` ^6.10.1 | MIT |
| Frontend | Vanilla HTML5 / CSS3 / ES2020+ | Zero build step, no npm |
| Frontend PRNG | Linear congruential generator (hand-rolled) | Deterministic mock data |
| Containers | `node:22-alpine`, `nginx:alpine`, `postgres:16-alpine` | Minimal image size |
| Test runner | Node.js built-in `node:test` | No test framework installed |

**Hard rules:**

- Do **not** add npm packages other than `exceljs`, `nodemailer` and `pg`.
  Adding a fourth requires explicit approval and a licence check recorded in the PR.
- Do **not** add an authentication library. Use `node:crypto` as specified in §7.
- Do **not** add an ORM or query builder. Write parameterised SQL.
- Do **not** introduce a frontend framework (React, Vue, Svelte) or a bundler.
- Do **not** add a web framework (Express, Fastify, Koa). Use the raw `http` module.
- Every new dependency PR must record `npm ls --omit=dev` and a clean
  `npm audit --omit=dev` in its description.

---

## 4. Code Style

### 4.1 Formatting

- **Indent:** 2 spaces (no tabs).
- **Semicolons:** always present.
- **Quotes:** single quotes for string literals; template literals `` ` `` only for interpolation.
- **Line length:** soft limit ~100 characters.
- **Trailing commas:** used in multi-line arrays/objects.

### 4.2 Declarations

- `const` for anything that is not reassigned; `let` otherwise. Never `var`.
- Arrow functions for callbacks and short expressions.
- Named `function` declarations for top-level logic and exported handlers.

### 4.3 Naming Conventions

| What | Convention | Examples |
|---|---|---|
| Variables, functions | `camelCase` | `loadData`, `summaryTotals` |
| Constants | `SCREAMING_SNAKE_CASE` | `PAGE_SIZE`, `CACHE_TTL_MS` |
| Private/internal fields | leading underscore | `_nameLower`, `_incomplete`, `_cachePollTimer` |
| Short loop variables | single letter or 2-char abbreviation | `i`, `p`, `ck`, `sk` |
| SQL identifiers | `snake_case` | `user_sessions`, `last_seen_at` |
| SQL keywords | UPPERCASE in multi-line statements | `SELECT … FROM … WHERE` |
| Migration files | `NNN_snake_case.sql`, zero-padded | `001_init.sql` |
| DT = DependencyTrack | always abbreviate in code comments | `// fetch from DT API` |

### 4.4 Section Dividers

Use the dash-banner style to separate logical sections inside a file:

```javascript
// ── Logging ──────────────────────────────────────────────────────────
```

### 4.5 Decision Markers

Inline comments use lettered prefixes to trace design decisions:

- **Q-numbers** — design/architecture rationale (`// Q4: tuneable constants at top of file`)
- **P-numbers** — performance optimisations (`// P4: pre-computed lowercase for search`)
- **O-numbers** — observability notes (`// O3: JSON log format for log aggregators`)
- **S-numbers** — security rationale (`// S2: token hashed before storage`) — **new in revision 2**

Highest numbers currently in use: **Q13, P15, O5, S23**. When adding logic with a
non-obvious trade-off, add the next number in the appropriate series. Check the
current maximum before assigning — parallel branches can claim the same number.

### 4.6 Module Style (backend)

- CommonJS (`require` / `module.exports`) — matches the existing codebase.
- One concern per module. A module that needs another module's private state is
  a sign the split is wrong.
- Modules export named functions, never a default object literal of everything.
- No module performs I/O at require time. Connecting, migrating and listening all
  happen from the explicit boot sequence in `server.js`.

---

## 5. Database

### 5.1 Access rules

- **All** database access goes through `db/pool.js`. No module creates its own
  `Client` or `Pool`.
- Every query is **parameterised** (`$1`, `$2`). String concatenation or template
  interpolation of values into SQL is prohibited without exception.
- Multi-statement writes use the `tx()` helper so they commit or roll back as a unit:

```javascript
await tx(async (client) => {
  const { rows } = await client.query('INSERT INTO users (...) VALUES ($1) RETURNING id', [v]);
  await client.query('INSERT INTO user_settings (user_id) VALUES ($1)', [rows[0].id]);
});
```

- Never `SELECT *` on a table that holds a `bytea` column. Name the columns.
- Every query that reads user-owned data is scoped by `user_id`. There is no
  "trusted" read path.

### 5.2 Pool configuration

- `max: 15`, against a server `max_connections` of 50.
- `statement_timeout: 30000` and `idle_in_transaction_session_timeout: 30000`.
- The pool is created once at boot and closed on `SIGTERM`.

### 5.3 Migrations

- Plain `.sql` files in `db/migrations/`, numbered and **append-only**. A migration
  that has been merged is never edited — write a new one.
- The runner applies pending migrations inside a transaction, guarded by
  `pg_advisory_lock`, so concurrent container starts cannot race.
- Applied versions are recorded in `schema_migrations`.
- Migrations run automatically at boot, before the HTTP listener starts.
- Every migration must be **idempotent at the file level** (`CREATE TABLE IF NOT
  EXISTS`, `CREATE INDEX IF NOT EXISTS`) so a partially-applied state can recover.
- Destructive statements (`DROP`, `ALTER … DROP COLUMN`) require an explicit note
  in the PR description explaining the data impact.

### 5.4 Schema conventions

- Primary keys are `uuid` generated with `gen_random_uuid()`, except append-only
  audit and history tables which use `bigserial`.
- Timestamps are `timestamptz`, never `timestamp`. Default `now()`.
- Case-insensitive unique text (login IDs, email addresses) uses the `citext`
  extension rather than functional lower() indexes.
- Foreign keys to `users(id)` are `ON DELETE CASCADE`, except audit tables which
  are `ON DELETE SET NULL` so the trail survives account deletion.
- Constraints belong in the database, not only in application code. If a rule can
  be expressed as a `CHECK` or a partial unique index, express it there as well.
- Indexes are added only when a query in the design needs them. No speculative
  indexes; each one is justified in the migration's comment header.

### 5.5 What lives in the database

| Table | Purpose |
|---|---|
| `users` | Accounts, credentials |
| `user_sessions` | Bearer-token sessions (one live per user) |
| `login_audit` | Authentication event trail |
| `dt_connections` | Per-user DT URL and encrypted API key |
| `user_settings` | Per-user preferences (`max_reports`) |
| `mail_settings` | Per-user SMTP configuration |
| `schedules`, `schedule_projects`, `schedule_runs` | Scheduled reports |
| `reports`, `report_file_chunks` | Report metadata and file bytes |
| `violation_caches` | Shared violation cache, keyed by connection fingerprint |
| `schema_migrations` | Migration ledger |

### 5.6 What remains on disk

Only `/data/admin-credentials.json` (mode `0600`), created by `install.sh`.
Nothing else. The `.env` file holds infrastructure configuration only — never DT
connection values, and never user data.

---

## 6. Backend Service

### 6.1 Boot sequence (`server.js`)

Strict order. Each step must complete before the next begins:

1. Read and validate environment configuration; fail fast with a clear message on
   anything missing or malformed.
2. Create the connection pool.
3. Run pending migrations.
4. Load the admin credentials file if present (see §7.4).
5. Start background timers (session sweeper, scheduler poller).
6. Start the HTTP listener.

The process must not accept requests before migrations complete.

### 6.2 HTTP fetch helpers

All DT API calls go through `dtGetWithRetry()`:

- 3 attempts maximum; delays 2 s → 4 s → 8 s.
- Only retry on network errors and 5xx; surface 4xx immediately.
- Accepts an optional `cancelFlag`; a cancelled job stops retrying instead of
  burning the full backoff sequence.

Do **not** add ad-hoc `fetch`/`https.get` calls outside this helper.

### 6.3 Concurrent pipelines

The violation cache builds via 9 parallel pipelines: 3 risk types
(`ops`, `lic`, `secpolicy`) × 3 states (`FAIL`, `WARN`, `INFO`).

1. **Phase 1** — fire all pipelines in parallel to get page counts (accurate progress).
2. **Phase 2** — fetch pages 2+ with a `makeSemaphore` to limit concurrency.

Preserve this two-phase structure for any new paginated fetch logic.

### 6.4 Semaphore

`makeSemaphore(limit)` is the single concurrency-limiting primitive. Use it whenever
spawning multiple async tasks against the external DT API.

```javascript
const sem = makeSemaphore(5);
await sem(() => doWork());
```

### 6.5 Logging

Use `log(level, message, meta)` exclusively. Never `console.log`.

```javascript
log('info',  'Cache built', { projectCount: 42 });
log('warn',  'Partial failure', { failed: 3 });
log('error', 'Job crashed', { err: e.message });
```

Output format is controlled by `LOG_FORMAT` (`text` or `json`).

**Never log:** passwords, password hashes, session tokens, token hashes, SMTP
passwords, DT API keys in full, or the secret encryption key. DT API keys are
redacted to `***` plus the last four characters. Log a `user_id`, never a login ID
together with a credential.

### 6.6 HTTP route pattern

Each route is a plain `if` block keyed on `method + path`, returning early:

```javascript
if (method === 'GET' && path === '/violation-cache/status') {
  jsonReply(res, 200, getStatus());
  return;
}
```

- Routes must not block the event loop. Long work runs in a background closure and
  returns a job id immediately (fire-and-forget + polling).
- Every route handler that awaits is wrapped in `try/catch` replying 500.
- Authentication is applied centrally **before** route dispatch (§7.3), not
  per-route. A new route is authenticated by default; making one public requires
  adding it to the explicit public list and justifying it in the PR.

### 6.7 Report jobs

- Status transitions: `pending` → `running` → `completed` | `failed`.
- Cancellation uses a `cancelFlag` object (`{ cancelled: false }`) passed by
  reference. Set `cancelFlag.cancelled = true` to stop.
- `collectReportData()` awaits `Promise.allSettled` so a job reaches its terminal
  status only after every pipeline has actually stopped.
- Progress is persisted **at most once per second**, never per project.
- A 30-minute watchdog fails stale `running` jobs; a startup sweep does the same
  for jobs orphaned by a restart.

### 6.8 Scheduler

- `calcNextRun(schedule)` is a pure function and the single source of truth for
  timing. Do not duplicate its logic.
  - `daily`: next occurrence of `hour` (tomorrow if already past)
  - `weekly`: scans the next 8 days for a matching `weekDays` entry
  - `monthly`: `monthDay` capped at 28; rolls to next month if already past
- Scheduling is driven by **one poller** that ticks every 60 seconds and claims due
  rows with `FOR UPDATE SKIP LOCKED`. Never create one timer per user.
- Per-user overlap protection is the `running_since` column, not a process variable.
- Scheduled reports are built in memory and emailed; they are never written to disk.

### 6.9 Email (`nodemailer`)

- `sendEmail(mailCfg, attachment, overrides)` builds a transporter from the user's
  decrypted SMTP settings.
- The SMTP password placeholder `'••••••••'` sent by the frontend must be detected
  and discarded so the stored password is not overwritten.
- Never return a password in any HTTP response.

---

## 7. Authentication & Multi-Tenancy

### 7.1 Passwords

- `crypto.scrypt`, N=16384, r=8, p=1, 16-byte random salt, 64-byte derived key.
- Stored as `scrypt$N$r$p$<base64 salt>$<base64 dk>` so parameters can be raised later.
- **Always the asynchronous `crypto.scrypt`. `scryptSync` is prohibited** — it blocks
  the event loop for ~100 ms per call and a login burst would stall the whole service.
- Comparison uses `crypto.timingSafeEqual`.

### 7.2 Session tokens

- `crypto.randomBytes(32)` encoded base64url.
- Only the **SHA-256 of the token** is stored. The token itself never touches the
  database or a log line.
- Sent by the browser as `Authorization: Bearer <token>`.
- Stored client-side in `localStorage` under `dt_session_token` — shared across tabs
  of one browser, not across browsers, which is the required behaviour.
- Expiry: absolute (`SESSION_ABSOLUTE_HOURS`, default 8) and idle
  (`SESSION_IDLE_HOURS`, default 2).
- One live session per user, enforced by a **partial unique index**, not by
  application logic.

### 7.3 Request authentication

- A single check runs before route dispatch: hash the bearer token, look it up,
  attach the principal to the request.
- An in-process cache holds validated tokens for 60 seconds to avoid a database
  round trip per request. Revocation (logout, force-disconnect, deletion) must
  **explicitly evict** the cache entry.
- `last_seen_at` is flushed at most once per minute per session, never per request.
- Missing, malformed, expired or revoked tokens all return **401** with a stable
  code. The frontend treats any 401 as "go to the login page".

### 7.4 Administrator principal

- Validated against `/data/admin-credentials.json`, never against the database.
- Created by `install.sh`. If the file is absent the service starts normally with
  administrator login **disabled**, logs a warning at boot, and returns an
  actionable error to anyone attempting an administrator login. It must never be
  created silently at runtime.
- Registration must reject the configured administrator login ID plus `root` and
  `system`, otherwise a database user can shadow the administrator.

### 7.5 Multi-tenancy rules

These are the rules that make the service safe for concurrent users. Violating one
is a correctness bug, not a style issue.

- **No per-user state in module scope.** Process-global mutable variables may hold
  only genuinely global state (the pool, the token cache, the scheduler timer).
  Anything belonging to a user lives in the database.
- **Every read and write is scoped by `user_id`.** No exceptions, including
  administrator paths.
- **Cross-user access returns 404, not 403.** Never confirm that another user's
  resource exists.
- **Quotas are per user** (report limits, storage), never global counters.
- **Shared caches are keyed by a fingerprint**, never by user, so that users with
  identical upstream credentials share one build. Single-builder election uses
  `pg_try_advisory_lock`.

### 7.6 Secrets at rest

- DT API keys and SMTP passwords are encrypted with AES-256-GCM using
  `SECRET_ENCRYPTION_KEY`, with a per-record nonce and the auth tag stored alongside.
- A decryption failure surfaces to the user as "re-enter your API key". It must
  never crash a request or be logged with the ciphertext.
- **The DT API key is never returned in any HTTP response.** The UI is told only
  whether a key is configured.

---

## 8. Frontend

### 8.1 Two single-file pages

The dashboard is `index.html`; the login/registration page is `login.html`. Each is
a self-contained HTML file with inline `<style>` and a single `<script>`.

**Do not split either file into separate JS/CSS assets** — the no-build-step
constraint requires this. Adding a *page* is allowed; splitting a *page* is not.

```
<style>   — CSS custom properties + all rules
<body>    — semantic HTML (header, main, modals)
<script>  — IIFE wrapping all state and logic
```

`login.html` reuses the same CSS custom properties and form classes as `index.html`
so the two are visually identical. Duplicating a small amount of CSS between the two
files is accepted and preferred over introducing a shared asset.

### 8.2 IIFE + window exports

All JavaScript is wrapped in an IIFE. `onclick=""` handlers call functions exposed
through `window.*` exports at the bottom of the IIFE. Any new handler must be added
to that export block or it will silently fail.

### 8.3 Backend calls go through `apiFetch()`

Every call to `/violation-cache/*` uses the `apiFetch(path, opts)` wrapper, which:

1. attaches the `Authorization: Bearer` header,
2. redirects to `login.html` when no token is present,
3. clears the token and redirects on any 401.

**Never call `fetch()` directly against a backend route.** There is no exception:
DependencyTrack is reached through `DT_PROXY` (`/violation-cache/dt/…`) on the same
backend, which attaches the signed-in user's API key server-side. The browser holds
no DependencyTrack credentials at all.

### 8.4 Auth gate

`index.html` validates the session before any data loading, theme initialisation or
rendering. An unauthenticated visitor never sees dashboard chrome.

### 8.5 State management

Flat, module-scoped globals, no reactive framework.

| Variable | Type | Role |
|---|---|---|
| `allProjects` | `Project[]` | Single source of truth |
| `filtered` | `Project[]` | Current filter result |
| `treeRoots` | `TreeNode[]` | Rendered hierarchy |
| `nodeMap` | `Map<uuid, TreeNode>` | Fast UUID lookup |
| `expandedUuids` | `Set<uuid>` | Open group rows |
| `summaryTotals` | object | Computed once after load |
| `flatView` | boolean | Hierarchy vs flat toggle |
| `selectedProjectUuids` | `Set<uuid>` | Checkbox-selected for report |
| `_configPanelDirty` | boolean | Unsaved changes in config panel |
| `_appConfig` | object \| null | Last fetched app config |
| `_currentUser` | object \| null | Authenticated principal |
| `dtConfigured` | boolean | Server reports a usable DT connection for this user |
| `dtApiUrl` / `dtFrontendUrl` | string | Shown in Settings; requests never use them directly |
| `dtHasApiKey` | boolean | A key is stored — **never its value** |

Never mutate `allProjects` after initial load. Derive everything else from it.

### 8.6 Data model

```javascript
// Project (leaf data shape)
{
  uuid:        string,
  name:        string,
  version:     string,
  parentUuid:  string | null,
  level:       number,          // 1 = root
  isLatest:    boolean,
  tags:        string[],
  security:    { critical, high, medium, low, unassigned },
  operations:  { fail, warn, info, unassigned },
  license:     { fail, warn, info, unassigned },
  secpolicy:   { fail, warn, info, unassigned },
  _nameLower:  string,          // P4: pre-computed, do not recompute elsewhere
  _incomplete: boolean          // true when this row's fetch partially failed
}
```

### 8.7 Tree building, filtering, mock data

- `inferParentUuids(projects)` runs before `buildTree(projects)`; siblings sort
  alphabetically; parent rows aggregate descendant counts.
- `applyFilters()` always operates on `allProjects`, never on a previous result.
  Parent rows are auto-included when a child matches.
- `generateMockProjects()` uses `makeLCG(seed)` (Q6) for deterministic output.
  Do **not** replace this with `Math.random()`.

### 8.8 Validation mirroring

Field validation rules exist in two places: `lib/validate.js` (authority) and the
frontend (immediate feedback). **They must be changed together in the same commit.**
The frontend never performs uniqueness checks — those are backend-only, via
`POST /auth/check-availability` fired on blur and again on submit.

### 8.9 Performance conventions

- `_nameLower` — computed once per project on load; reuse for every search.
- Search input debounced at `SEARCH_DEBOUNCE_MS` (200 ms), minimum 2 characters.
- `inferSuffix(name, version)` strips a trailing version by character scan, not
  regex (P3).

### 8.10 CSS conventions

- Theme driven by CSS custom properties on `:root`, overridden under
  `[data-theme="light"]`.
- Accent colour `--accent: #6366f1`. Severity colours are variables
  (`--critical`, `--high`, …).
- Never hard-code a colour hex inside a component rule.
- Responsive breakpoints: 1200 px → 900 px → 768 px.

### 8.11 Utility helpers (do not duplicate)

| Helper | Location | Purpose |
|---|---|---|
| `apiFetch(path, opts)` | frontend | Authenticated backend call — use for all backend routes |
| `makeLCG(seed)` | frontend | Seeded PRNG |
| `pillFor(n, level)` | frontend | Severity badge HTML |
| `showToast(text, type)` | frontend | Notification pop-up |
| `showConfirm(title, msg, ok, cancel)` | frontend | Promise-based confirm dialog |
| `openModal(id)` / `closeModal(id)` | frontend | Modal show/hide |
| `escHtml(s)` | frontend | Escape before `innerHTML` interpolation |
| `inferSuffix(name, ver)` | frontend | Strip version from name |
| `query(sql, params)` / `tx(fn)` | server | All database access |
| `makeSemaphore(limit)` | server | Promise concurrency limit |
| `sleep(ms)` | server | Promise delay |
| `dtGetWithRetry(...)` | server | Resilient DT API fetch |
| `log(level, msg, meta)` | server | Structured logger |
| `hashPassword` / `verifyPassword` | server | scrypt wrappers |
| `mintToken` / `hashToken` | server | Session token helpers |
| `encryptSecret` / `decryptSecret` | server | AES-256-GCM wrappers |
| `calcNextRun(schedule)` | server | Pure function: next fire time |
| `collectReportData(...)` | server | Shared collection core for manual and scheduled reports |
| `sendEmail(mailCfg, ...)` | server | Deliver report via nodemailer |

---

## 9. Infrastructure

### 9.1 nginx config template

`dashboard/nginx.conf.template` uses `envsubst` placeholders (`${VAR_NAME}`).

- `/auth/*`, `/profile` and `/violation-cache/*` → `dt-violation-cache:3001`.
- SPA routing: `try_files $uri $uri/ /index.html`; `login.html` served directly.
- There is **no `/api/*` block and no `/dt-config` block**. DependencyTrack is
  per-user, reached through `/violation-cache/dt/`; forwarding `/api/*` to one
  shared instance would defeat both the per-user connection and §7.6.

### 9.2 docker-compose.yml conventions

- Service names: `dt-dashboard`, `dt-violation-cache`, `dt-postgres`.
- All services declare a `healthcheck` — do not remove. Convention:
  `interval: 30s`, `timeout: 5s`, `retries: 3`; `start_period` reflects boot time.
- `restart: unless-stopped`, `json-file` logging with `max-file: "5"`.
- `dt-violation-cache` depends on `dt-postgres` with `condition: service_healthy`.
- **Bind mounts only. Never a named volume.** `install.sh` runs
  `docker compose down -v` unconditionally on uninstall, which would destroy a named
  volume without warning. `./violation-cache/pgdata` and `./violation-cache/data`
  are bind mounts for exactly this reason.
- Expose `DT_DASHBOARD_PORT` and `POSTGRES_PORT` only.

### 9.3 Dockerfile

Every new backend directory needs an explicit `COPY`. The image copies named paths
only — a new directory that is not listed is silently missing at runtime.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY db/ ./db/
COPY lib/ ./lib/
COPY routes/ ./routes/
RUN mkdir -p /data
EXPOSE 3001
CMD ["node", "server.js"]
```

### 9.4 Installer

- `install.sh` creates `/data/admin-credentials.json` from `SCA_ADMIN_USER` /
  `SCA_ADMIN_PASSWORD` (defaults `admin` / `ScaAdmin@dt8624`), hashed, mode `0600`.
- It generates `POSTGRES_PASSWORD` and `SECRET_ENCRYPTION_KEY` when absent.
- It no longer prompts for or writes any DT connection value.
- The uninstall confirmation must name every container and data directory it
  destroys. Update it whenever a service or bind mount is added.

---

## 10. Testing

### 10.1 Test runner

```bash
node --test violation-cache/server.test.js
node --test violation-cache/dashboard.test.js

# opt-in database tier
TEST_DATABASE_URL=postgres://… node --test violation-cache/db.test.js
```

No npm test script is defined. The default run must stay offline: it requires no
database, no Docker and no network.

### 10.2 Three tiers

| Tier | File | Requirement |
|---|---|---|
| Pure unit | `server.test.js`, `dashboard.test.js` | Always runs. No I/O beyond temp files. |
| Database integration | `db.test.js` | Skipped unless `TEST_DATABASE_URL` is set. |
| Route / authorisation | `server.test.js` | Always runs, with a stubbed data layer. |

### 10.3 Conventions

- **Do not import `server.js`** in a test — it would start the HTTP server.
  Duplicate the helper under test, or re-implement it taking its dependencies as
  parameters. This convention is unchanged.
- Modules under `lib/` that perform no I/O at require time **may** be imported
  directly. This is the preferred approach for new pure helpers.
- Use `node:assert/strict` and `node:test` (`test`, `describe`, `beforeEach`, `afterEach`).
- Temp files go under `os.tmpdir()` and are cleaned in `afterEach`.
- Mock HTTP request streams with `Readable` from `node:stream`.
- Integration tests create their own schema via the migration runner and drop it
  afterwards. They never assume pre-existing data.

### 10.4 What to test

- `.env` parsing edge cases: CRLF, quoted values, comments, missing `=`, duplicates.
- Every validation rule, including boundary lengths and rejected characters.
- Password hashing round-trip, and rejection of a tampered hash.
- Token minting and hashing; encryption round-trip and auth-tag failure.
- `calcNextRun` for all three frequencies.
- **Database tier:** migrations apply and are idempotent; the single-live-session
  index rejects a second session; cascade deletion removes all owned rows;
  chunked byte round-trips are identical; `SKIP LOCKED` claims each row once.
- **Authorisation:** every route rejects a missing or invalid token with 401;
  cross-user access returns 404; the profile endpoint ignores login ID and email.
- Do **not** write tests that require a live DT API.

---

## 11. Error Handling

### 11.1 Backend

- Typed error objects: `{ code: 'SYMBOLIC_NAME', cause: originalError }`.
- Status codes:

| Code | Meaning |
|---|---|
| 400 | Malformed request or failed field validation |
| 401 | Missing, invalid, expired or revoked session |
| 403 | Authenticated but not permitted (administrator-only routes) |
| 404 | Not found — **also used for another user's resource** |
| 409 | Conflict: job already running, or an active session exists at login |
| 429 | Rate limited, or a per-user quota reached |
| 500 | Internal error |

- Error responses always use `jsonReply(res, status, { error: '...' })`, plus a
  stable `code` where the frontend must branch on it (`SESSION_EXISTS`,
  `INVALID_SESSION`, `INVALID_CREDENTIALS`).
- Authentication failures must not reveal which factor was wrong, or whether an
  account exists.
- Wrap async route handlers in `try/catch` replying 500.
- Never let an unhandled rejection crash the process.

### 11.2 Frontend

- `showToast(message, 'error')` for user-visible errors.
- Mark per-project failures with `_incomplete: true` and surface a banner.
- Never swallow errors silently — at minimum log them to the console.
- Graceful degradation: with no DT connection configured, show mock data and a
  clear "demo data" notice.

---

## 12. Security

- **Authentication is mandatory on every backend route.** New routes are
  authenticated by default; a public route must be listed explicitly and justified.
- Secrets never appear in responses or logs (§6.5, §7.6).
- Parameterised SQL only (§5.1).
- `crypto.timingSafeEqual` for all credential and token comparisons.
- Brute-force protection: five failures per `(login_id, ip)` triggers a
  fifteen-minute lockout; every attempt is written to `login_audit`.
- The availability-check endpoint is rate limited and never identifies the owner of
  an existing identifier.
- `readBody()` enforces a 64 KB default limit. Overrides are per route and must be
  justified (256 KB config, 5 MB report generation).
- CORS stays open (`Access-Control-Allow-Origin: *`) for the documented
  iframe-embedding model. This is acceptable **only because** bearer-token
  authentication now gates the data behind it. Do not remove one without the other.
- `escHtml()` before interpolating any user-supplied text into `innerHTML`.

---

## 13. Performance by Design

The service must not degrade as users are added. These are requirements, not
aspirations, and each is verifiable.

- **No N-times-per-user upstream work.** Users sharing a DT connection share one
  cache build (§7.5).
- **No per-request database write.** `last_seen_at` and job progress are throttled.
- **No unbounded in-memory accumulation.** Paged fetches stream and discard; report
  bytes are chunked at 4 MB.
- **No blocking crypto on the event loop.** Async `scrypt` only.
- **No sequential scans on a hot path.** Every hot query is index-backed, evidenced
  by `EXPLAIN (ANALYZE, BUFFERS)` attached to the PR that introduces it.
- **No unbounded table growth.** Sessions are swept; audit and run history are
  retained 90 days.
- **Bounded concurrency everywhere.** Pool 15, scheduler 5, report fetches 5,
  violation fetches 3.

---

## 14. Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `DT_DASHBOARD_PORT` | compose / nginx | External port for the dashboard |
| `POSTGRES_USER` | compose / server | Database role (default `dtdash`) |
| `POSTGRES_PASSWORD` | compose / server | Database password (generated at install) |
| `POSTGRES_DB` | compose / server | Database name (default `dtdash`) |
| `POSTGRES_HOST` | server | Database host (default `dt-postgres`) |
| `POSTGRES_PORT` | compose | Host port exposed for external DB tooling (default 5432) |
| `SECRET_ENCRYPTION_KEY` | server | AES-256-GCM key for stored secrets (generated at install) |
| `SCA_ADMIN_USER` | install.sh | Administrator login ID (default `admin`) |
| `SCA_ADMIN_PASSWORD` | install.sh | Administrator password (default `ScaAdmin@dt8624`) |
| `SESSION_ABSOLUTE_HOURS` | server | Absolute session lifetime (default 8) |
| `SESSION_IDLE_HOURS` | server | Idle session lifetime (default 2) |
| `VIOLATION_CACHE_TTL_HOURS` | server | Cache expiry in hours (default 24) |
| `PORT` | server | Cache service listen port (default 3001) |
| `REPORT_CONCURRENCY` | server | Max parallel project fetches (default 5) |
| `VIOLATION_CONCURRENCY` | server | Max parallel violation fetches (default 3) |
| `LOG_FORMAT` | server | `text` (default) or `json` |
| `TEST_DATABASE_URL` | tests | Enables the database integration tier |

`DT_API_INTERNAL_URL`, `DT_API_KEY` and `DT_FRONTEND_URL` are **no longer read at
request time**. They survive in `.env` only so an installation upgrading from the
single-tenant build can seed its existing accounts once at first boot, guarded by a
`system_state` marker. A fresh install leaves them blank.

---

## 15. Git & Branch Workflow

- One pull request per migration phase. Do not combine phases.
- Branch naming: `claude/<phase>-<short-topic>`, e.g. `claude/phase0-db-foundations`.
- Each phase branches from `main` after the previous phase has merged. If the
  previous phase is still in review, stack on its branch and say so in the PR.
- Commit messages: imperative mood, concise first line, no emoji, body explains why.
- Do not push directly to `main`/`master`.
- Always `git push -u origin <branch>`.
- Do not commit generated binaries, `.env`, `pgdata/`, or `admin-credentials.json`.

---

## 16. Adding New Features — Checklist

Before opening a pull request:

**Dependencies and standards**
- [ ] No new npm package (approved: `exceljs`, `nodemailer`, `pg`).
- [ ] `npm ls --omit=dev` and `npm audit --omit=dev` recorded if dependencies changed.
- [ ] This file updated if a convention changed.

**Database**
- [ ] All access through `db/pool.js`; every query parameterised.
- [ ] Multi-row writes wrapped in `tx()`.
- [ ] New migration is append-only, numbered, idempotent, and comments its indexes.
- [ ] No `SELECT *` on a table containing `bytea`.

**Authentication and isolation**
- [ ] New routes are authenticated; any public route justified in the PR.
- [ ] Every query scoped by `user_id`; cross-user access returns 404.
- [ ] No per-user state in module scope.
- [ ] No secret in a response body or a log line.
- [ ] Quotas enforced per user.

**Backend**
- [ ] Routes follow the early-return `if` pattern.
- [ ] New paginated fetches use `dtGetWithRetry` + semaphore.
- [ ] `log()` used for all output; no bare `console.log`.
- [ ] Errors use `jsonReply(res, status, { error, code })`.

**Frontend**
- [ ] Backend calls go through `apiFetch()`, never bare `fetch()`.
- [ ] New handlers window-exported from the IIFE.
- [ ] New colours use CSS custom properties.
- [ ] Validation changes applied to `lib/validate.js` and the frontend together.
- [ ] User-supplied text passed through `escHtml()` before `innerHTML`.

**Verification**
- [ ] Tests added for new pure helpers; database tier updated for schema changes.
- [ ] Full default test run green.
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` attached for any new hot-path query.
- [ ] `.env.example` updated for new environment variables.
- [ ] `docs/` updated if user-visible behaviour changed.
