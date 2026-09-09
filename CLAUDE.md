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
| 4 | Per-user DT connection | **Merged** |
| 5 | Per-user settings, mail, multi-tenant scheduler | **Merged** |
| 6 | Reports in the database | **Merged** |
| 7 | Shared violation cache | **Merged** |
| 8 | Installer, infrastructure, documentation | **In review** |
| 9 | Administration panel (separate screen) | **In review** |
| 10 | Performance validation | **In review** |

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

**Milestone M3 = phases 8–10**, also delivered as one pull request. It ships the
installer's two-level uninstall, continuous integration, the read-only
administration panel, and the performance evidence in `docs/PERFORMANCE.md`.
After M3 the migration is complete and the phase table above is history.

---

## 2. Repository Layout

```
dependency-tracker/
├── dashboard/
│   ├── index.html              # Single-file dashboard SPA
│   ├── login.html              # Single-file login/register/set-password page
│   ├── admin.html              # Single-file administration screen
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
│   │   ├── dt-connections.js user-settings.js app-settings.js mail-settings.js
│   │   ├── disk.js             # Filesystem headroom and database size
│   │   ├── reports-db.js caches.js snapshots.js schedules.js scheduler.js
│   │   ├── dt-fetch.js excel.js cwe.js mail.js reports.js violation-cache.js
│   │   ├── dependency-path-cache.js dependency-paths.js   # §6.3a — direct/transitive resolution
│   │   └── branding.js image.js   # title + sign-in background
│   ├── routes/                 # auth.js profile.js admin.js dt-proxy.js config.js reports.js schedule.js cache.js branding.js dependency-paths.js
│   ├── package.json            # Dependencies: exceljs, nodemailer, pg
│   ├── Dockerfile
│   ├── e2e/                    # End-to-end harness — see e2e/README.md
│   │   ├── stack.js            # Boots the assembled product and tears it down
│   │   ├── dt-stub.js smtp-stub.js web-proxy.js
│   │   └── client.js           # Request helpers + the Playwright resolver
│   ├── server.test.js          # Unit + route tests for server helpers
│   ├── dashboard.test.js       # Unit tests for dashboard helpers
│   ├── db.test.js              # DB integration tier (opt-in)  [phase 1]
│   ├── e2e.test.js             # End-to-end tier (opt-in)
│   └── installer.test.js       # install.sh uninstall contract  [phase 8]
├── docs/
│   ├── PERFORMANCE.md          # Query plans and load evidence  [phase 10]
│   ├── perf-check.js           # Reproduces that evidence
│   └── auth-smoke-test.sh
├── .github/workflows/ci.yml    # Offline, database and audit jobs  [phase 8]
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
| Filesystem headroom | Built-in `fs.statfs` | One syscall, zero dependencies |
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

Highest numbers currently in use: **Q31, P20, O5, S34**. When adding logic with a
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
| `app_settings` | Service-wide settings the administrator owns (singleton row) |
| `user_settings` | Per-user report and schedule limits — `NULL` means "follow the global default" |
| `mail_settings` | Per-user SMTP connection **and default recipients** |
| `schedules`, `schedule_projects`, `schedule_runs` | Scheduled reports, **any number per user** (migration 009). `report_name` `NULL` means "generate one"; `name` is the label in the settings list and a different field. `schedule_runs.schedule_id` is `ON DELETE SET NULL` so cancelling never erases the record that it ran. `to_addrs`/`cc_addrs`/`subject`/`body` are delivery overrides — `NULL` means "use the account's" (migrations 010, 011). An empty `cc_addrs` means "copy nobody"; an empty `to_addrs` is refused |
| `reports`, `report_file_chunks` | Report metadata and file bytes |
| `violation_caches` | Shared violation cache, keyed by connection fingerprint |
| `risk_snapshots` | One row per connection per day, written when a violation-cache build completes; the history behind the trend view (migration 012). Keyed by fingerprint for the same reason the cache is, so accounts sharing a connection share one series. Stores the severity counts and the policy counts **separately** — "critical" means two different things in this product and a schema that accretes history must not decide which one a graph plots. **No foreign key to `violation_caches`**: a cache row is a 24-hour artefact that housekeeping deletes as a matter of routine, and a cascade would let that destroy a year of measurements |
| `dependency_paths` | One row per connection per project, the cached result of walking that project's DependencyTrack dependency graph (migration 013) — see §6.3a. Keyed by `(fingerprint, project_uuid)` for the same sharing reason as every other cache here. Holds only the expensive, opt-in half (the graph walk); the cheap Direct/Transitive classification is never stored — see §6.3a for why |
| `branding_assets` | The administrator's sign-in background. Bytes live here, **not** on `app_settings`, because the administration listing cross-joins that table |
| `schema_migrations` | Migration ledger |

### 5.6 What remains on disk

Only `/data/admin-credentials.json` (mode `0600`), created by `install.sh`.
Nothing else — the administrator's uploaded sign-in background included. It is a
`bytea` in `branding_assets`, not a file, because a file would need a bind mount
that the two-level uninstall would then have to reason about, and because the
database is already the system of record for everything else the administrator
owns. The `.env` file holds infrastructure configuration only — never DT
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

**DependencyTrack serves its version at `/api/version`, not `/api/v1/version`,
and that path is unauthenticated.** The connection test therefore probes
`/api/v1/project?pageSize=1`, the endpoint the dashboard itself depends on:
one call that proves the URL is a DT API root, the key is accepted, and the key
carries `VIEW_PORTFOLIO`. The version is fetched separately and tolerated to
fail — it is a nicety, never part of the verdict. A probe of a path that does
not exist returned 404 on every healthy connection, and the stub answered it
anyway, so nothing caught it. Stubs must mirror the upstream's real routing.

### 6.3 Concurrent pipelines

The violation cache builds via 9 parallel pipelines: 3 risk types
(`ops`, `lic`, `secpolicy`) × 3 states (`FAIL`, `WARN`, `INFO`).

1. **Phase 1** — fire all pipelines in parallel to get page counts (accurate progress).
2. **Phase 2** — fetch pages 2+ with a `makeSemaphore` to limit concurrency.

Preserve this two-phase structure for any new paginated fetch logic.

**A build must always be able to end.** `violation_caches.status = 'building'` is
written when a crawl starts and cleared only by `storeResult` or `markFailed`, so
a builder that dies without running its `finally` leaves the row asserting a
build nobody is running — and that shuts every door: the dashboard adopts the
phantom build and polls it forever, and `POST /refresh` answers 409 because a
build is supposedly already in progress. Two mechanisms keep it recoverable, and
neither may be removed without replacing it:

- **`caches.failOrphanedBuilds()` at boot**, beside `reportsDb.failOrphaned()`.
  It runs before the listener starts, so every `building` row belongs to a dead
  process by construction. Rows are marked failed, not rebuilt: kicking them off
  here would crawl DT once per stranded fingerprint at every start-up.
- **`updated_at` as a heartbeat.** The build touches the row only while its page
  count is advancing, so silence is meaningful. `deriveStatus` reports a build
  quiet for longer than `VIOLATION_JOB_STALL_MINUTES` as `'stalled'`, which the
  status route treats as "restart it". A false positive is harmless — `_building`
  and the advisory lock still refuse a second concurrent crawl.

**The watchdog measures silence, not elapsed time.** It is not a cap on how long
a refetch may take: a large portfolio that keeps advancing runs to completion
however long that needs. Only a build that has not finished a single page within
the stall window is stopped. Do not reintroduce an absolute deadline — the flat
30-minute one it replaced killed healthy crawls for having a lot of data and
discarded every page they had already fetched.

**A completed build also records the day's risk snapshot** (Q22, migration 012).
This is the only moment the service holds a complete, self-consistent picture of
a portfolio: the violation counts have just been crawled and the severity counts
are one paged request away, so capturing anywhere else would mean either a
second full crawl or a snapshot stitched from two different instants.

Three properties are load-bearing:

- **It runs after `storeResult`, and it never throws.** The cache row is already
  `ready`, so a failure here costs a missing point on a graph and nothing more.
  Turning a successful build into a failed one because the history could not be
  written is a strictly worse trade for every user who is not looking at the
  graph.
- **The watchdog is stopped before it, explicitly.** Left running, it would read
  the snapshot's own project crawl as silence and log "build stalled" against a
  build that has in fact just succeeded. `clearInterval` is idempotent, so the
  `finally` still covers every other path.
- **The crawl asks for `onlyRoot=true&excludeInactive=true`.** Those two
  parameters are the entire agreement between the graph and the KPI tiles above
  it: the tiles sum DependencyTrack's active root projects, because a parent's
  numbers already carry its descendants'. Summing every project instead
  double-counts, and the graph would then contradict the cards on the same
  screen.

### 6.3a Dependency-path resolution

Answers a release-engineer question the vulnerability dialog's Origin column
exists for: is a finding's component a **direct** dependency (blocks the
release) or **transitive** (goes to the security SME's backlog)? Two tiers, at
two very different costs:

- **Direct or transitive — always live, never cached.** One DT call
  (`GET /api/v1/project/{uuid}`, whose `directDependencies` field is a JSON
  **string**, parsed twice) is cheap enough to make on every dialog open. The
  badge must never lag behind what DependencyTrack currently reports, so
  nothing about this half is stored — see `getDirectDependencies()` in
  `lib/dependency-paths.js`.
- **The path behind a Transitive tag — opt-in, expensive, cached.** Verifying
  *how* a transitive component is reachable means walking
  `GET /api/v1/component/project/{uuid}/dependencyGraph/{componentUuid}`
  outward from the project's direct dependencies — potentially dozens of calls
  for one project. This is the dialog's "Show full dependency paths" toggle,
  off by default, and its result is what `dependency_paths` (migration 013)
  caches, shared by fingerprint like every other cache in this schema (§7.5).

**Q25: the two halves are split into two modules for the same reason
`caches.js`/`violation-cache.js` are** (§2): `lib/dependency-path-cache.js`
holds row CRUD, job status and the advisory lock; `lib/dependency-paths.js`
holds the walk and calls the cache module through the imported reference. A
same-file bare call cannot be swapped out by a test — `runJob` calling
`acquireBuildLock` directly, in one early version of this code, meant no test
could replace it without a real PostgreSQL, which `server.test.js` may not use
(§10.2). Routes import both modules, exactly as `routes/cache.js` already
imports both `cache` and `caches`.

**Q26: the walk is scoped to what the dialog is actually showing, not the
project's whole graph.** `POST /violation-cache/dependency-paths/:id` takes an
optional `{ targets: string[] }` body — componentKeys the caller needs a path
for — and `walkGraph` stops as soon as every one of them is settled (reached
transitively, or found to already be direct) instead of discovering the rest
of the project regardless of whether anything needs it. A project can carry
hundreds of components while a dialog shows a few dozen open findings; walking
to all of them for a fraction that matters is real, measured DependencyTrack
load for work nobody asked for (§13) — this is what a production installation
surfaced: 208 components resolved to explain 40 displayed rows. The field
being **omitted** is what keeps the exhaustive walk (the shape a future
full-graph caller still wants); an **empty array** is a real instruction
("nothing to resolve") and must not silently fall back to a full walk — the
three layers that carry `targets` (the route's `parseTargets`, `runJob`'s
`scopedTargets`, `walkGraph`'s `targetSet`) all treat `null` and `[]`
differently for exactly this reason. `runJob` also re-filters a requested
target against the live direct-dependency set before walking — defensive
against a caller's list going stale between its own Tier-1 read and this POST,
though the frontend already excludes these itself — and skips the lock and
every DT call outright when a ready cache already covers every requested
target. The frontend computes its target list from `_vulnShownFindings` minus
`_vulnDirectKeys`; when that difference is empty — every row the dialog shows
is Direct — it does not call `POST` at all, because a flat, manifest-built
SBOM (below) can legitimately leave nothing transitive to resolve, and a walk
that completes with nothing to show reads as broken rather than as correct.

**Q27: a component reached from more than one direct dependency gets one
chain per root, not a single chain plus a flag.** The walk keeps
`rootsReaching`/`parentByRoot` maps (`lib/dependency-paths.js`) instead of a
single `parent`, so a shared low-level package reachable from three direct
dependencies gets three chains — `paths[key] = { chains: [...] }` — each the
shortest route from its own root. This replaced an earlier `multiple: true`
flag that told an engineer more routes existed without saying what they were;
showing the first occurrence of each root's route directly is more useful and
still bounded, because the number of *roots* reaching a component is the
project's own direct-dependency count, not the combinatorial number of routes
through the graph. What is still deliberately not built: enumerating every
route *within* one root's own branch (a diamond nested inside a diamond) —
that is the genuinely combinatorial case, and it stays one shortest chain per
root, with no count of how many more exist inside it. `MAX_ROOTS_PER_COMPONENT`
(8) caps how many roots one component keeps regardless — a component reachable
from dozens of direct dependencies is realistic (a common logging library,
say), and past the cap the extra roots are silently dropped, not counted;
exact "+N more" reporting was deliberately deferred rather than built now.

**A component the walk never reaches is not an error.** A flat, manifest-built
SBOM is the ordinary case, not an edge case — see the design note above
`walkGraph` for what this project's own sampling of a real DependencyTrack
instance found: Maven components sit at one hop with no further graph
recorded, while a container's OS-package layer goes several levels deep,
because that is what the SBOM generator that produced them actually captured.
The dialog says "no path recorded" plainly instead of inventing a chain.

**Staleness is a live comparison, not a stored state.** The graph's *shape*
only changes when a new BOM is imported — a new CVE against an already-known
component moves nothing in the tree — so the cache is keyed to
`project.lastBomImport`, which the route already has in hand from the same
call that fetches the direct set. A row built against an older import is still
served (something to verify beats nothing while a re-walk has not been asked
for) but flagged `stale: true`.

**Q29: a manual refetch is the same walk, asked to stop trusting the cache.**
`runJob(conn, projectUuid, targets, force)`'s fourth parameter skips exactly
one thing — the "already covered by the cached walk" short-circuit above —
and nothing else: `force` never touches `_building`, the advisory lock, or
the route's "already building" 409 check, because a build already running is
still the same build whether or not the new request asked to force one.
`POST /violation-cache/dependency-paths/:id` accepts `{ targets?, force? }`
for exactly this reason — the dialog's "↻ Refetch paths" button (`dashboard/
index.html`, next to the toggle) always sends `force: true` alongside its own
`transitiveTargets()`, for when a user suspects the cache and DependencyTrack
have diverged (a BOM landed after the walk ran and the automatic `stale`
flag has not yet caught up, or the result simply looks wrong) and does not
want to wait for the next natural cause of a re-walk. The button is shown
only once there is something to doubt — `renderVulnRows()` hides it unless
the toggle is checked, `_depPathStatus === 'ready'`, *and* `transitiveTargets()`
is non-empty. That third condition is not optional: a project whose shown
findings are all Direct has nothing a re-walk could possibly change, the same
reasoning `onVulnDepPathToggle()` already uses to skip the `POST` in the first
place — offering "Refetch paths" there would just be a button that does
nothing. A click clears `_depPathStatus` and re-renders before the request
even lands, so stale chains and the button itself disappear immediately
rather than sitting on screen through the round trip. It shares
`_depPathReqSeq` and `startDepPathPoll` with the toggle, so a superseded
refetch (the dialog closed, or the toggle unchecked, mid-request) is handled
the identical way.

**Q30: a filter that empties the table is not the same "nothing to show" as
a table that started empty.** `openVulnDialog()`/`onVulnViewTypeChange()`
already show `#vulnDialogStatus` and never unhide the table at all when the
fetch itself returned zero rows — that case was always handled. What was not:
the Origin filter (Both/Direct/Transitive) is applied locally, inside
`renderVulnRows()`, and can filter every row away on its own — a project
whose findings are all Direct, say, with Transitive selected — leaving a
visible table with headers and a blank body, which reads as broken rather
than as a deliberate zero-match result. `#vulnEmptyState`, inside
`#vulnDialogTableWrap`, is what `renderVulnRows()` shows instead, gated on
`source.length > 0 && html === ''` specifically so it can never also fire for
the already-handled case above — `source.length === 0` leaves it hidden, and
the two messages never stack.

**Q31: the status line's place in the markup decides what it reads as
"above."** `#vulnDialogStatus` carries "Loading…" and every "no data" message
for whichever table is about to render, but nothing about its own position
in the DOM tied it to the table — it used to sit above the dependency-path
toggle row (`#vulnDepPathToggleWrap`), which `onVulnViewTypeChange()` never
touches when switching views. Switching to License after Security's Tier 1
had already unhidden the toggle row meant the "Loading…" text appeared above
a checkbox and button that had nothing to do with License's own load, with
the eventual table rendering only below both. The status line now sits
between the toggle row and `#vulnDialogTableWrap` — after the persistent
controls, immediately above the content it describes — so a loading or empty
message always renders exactly where the table it is about is going to
appear, and the toggle row stays visually fixed above both regardless of
which view is loading.

**Bounded the same way the snapshot crawl is** (§6.3): `MAX_GRAPH_NODES`
caps how many components one walk will ever discover, so a toggle click cannot
become an unbounded fetch loop, and `WALK_CONCURRENCY` limits how many
`dependencyGraph` calls run at once.

This module is also what a future license-risk dialog reuses unchanged:
`getDirectDependencies` takes a project, never a finding, so "is this
component direct or transitive" does not depend on why the caller is asking.

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
- **`reports.reportFilename()` is the only rule for what a report is called**,
  shared by the manual and scheduled paths so the two cannot disagree. An empty
  name keeps the generated `<prefix>_<timestamp>.xlsx` form; a supplied one is
  used as given, with `.xlsx` added if absent. The name is decided and stored
  when the row is created, not at completion, so the row and the stored file
  always agree and the list can show the intended name while the job runs.
- **`lib/cwe.js` owns the CWE cell, and both sheets call it.** The CWE column on
  `SV_Vulnerability Findings` and the CWE half of the `SV_CWE Summary` key are
  the same string by construction — computed apart, they drift, and the summary
  then splits one vulnerability across two rows. The summary is keyed on
  (vulnerability, CWE cell), so a finding mapped to several weaknesses stays on
  one row and the counts still reconcile with the findings sheet.
- **The CWE summary adds no upstream call.** `cwes` and `vulnId` are already in
  the `/api/v1/finding` response, and the reference links are derived from the
  identifier — an unrecognised prefix yields an empty cell, never a guessed URL.
  A test asserts `collectReportData` touches no endpoint but `/api/v1/finding`.
- **A report name is validated, not sanitised.** It becomes a filename and
  travels in a `Content-Disposition` header, so `validate.validateReportName()`
  refuses what would break either — quotes, path separators, control characters
  — rather than silently rewriting what the user typed.
- **The quota is the only thing standing between a user and a report.** Two
  further prompts once lived in the frontend: one when a job was already
  running, one when a report had already been generated that day. Neither
  protected anything the quota does not, and re-asking for a second report on
  the same day second-guessed a deliberate action. Do not reintroduce a
  pre-flight that is not enforced server-side.
- A 30-minute watchdog fails stale `running` jobs; a startup sweep does the same
  for jobs orphaned by a restart.

### 6.8 Scheduler

- `calcNextRun(schedule, now)` is a pure function and the single source of truth
  for timing. Do not duplicate its logic. `now` defaults to the current instant
  and exists so tests can pin a weekday instead of asserting invariants.
  - `daily`: next occurrence of `hour:minute` (tomorrow if already past)
  - `weekly`: scans days 0–7 for a matching `weekDays` entry, skipping any
    candidate that is not still ahead
  - `monthly`: `monthDay` capped at 28; rolls to next month if already past
- **The schedule is stored as a UTC instant, and `calcNextRun` reads it with
  `getUTC*` accessors only** (Q19). It used to build candidates from the
  server's local calendar, which made the container's `TZ` an invisible input
  to every schedule in the system — a base image that shipped one set would
  move everybody's delivery time with nothing in the diff to show for it. The
  Dockerfile pins `TZ=UTC` so log lines and `toLocaleString()` agree with the
  stored values, but nothing depends on it any more.
  **Timezones exist in exactly one place: the browser.** `index.html` shows a
  local wall clock and converts the `(hour, minute, weekDays)` and
  `(hour, minute, monthDay)` tuples on the way in and out — with real `Date`
  arithmetic, never modular arithmetic on the hour, because an offset can be a
  half hour (India is UTC+05:30, Nepal +05:45) and can move the *day*. The
  picker re-reads what was stored after a save rather than showing what was
  typed, so a month day clamped at the 1/28 boundary is visible instead of
  drifting on each reload. `schedules.minute` exists for exactly this
  (migration 008): an hour-only field cannot express 09:00 in India.
- **Weekly fires today when today qualifies and its time has not passed** (Q20).
  The scan used to start at tomorrow, so a Wednesday schedule saved on a
  Wednesday morning waited a full week — the one case a user is certain to be
  watching, because they have just set it up. Starting at day 0 is safe only
  because of the `candidate <= now` guard; do not remove one without the other.
- Scheduling is driven by **one poller** that ticks every 60 seconds and claims due
  rows with `FOR UPDATE SKIP LOCKED`. Never create one timer per user.
- **The tick fills a worker pool; it does not await a batch** (P20). It used to
  claim N due schedules and `await Promise.all` on all of them before claiming
  again, so one slow report idled every other slot — five claimed, four done in
  two minutes, one taking thirty, and the service ran at a fifth of capacity for
  twenty-eight minutes with work queued behind it. `fill()` now starts jobs
  without awaiting them and each job refills its own slot from its `finally`, so
  a freed slot is reused in milliseconds rather than at the next minute
  boundary. Do not reintroduce an `await` over the started jobs: that single
  keyword is the whole defect.
- `_running` and `_claiming` are process-global mutable state, which §7.5
  normally forbids. They describe **this process's capacity**, not a principal's
  data; the per-user guarantee still lives in the database, in `claimOne`'s
  `NOT EXISTS` clause, which is what keeps it correct across restarts and
  replicas.
- **How many run at once is `SCHEDULER_CONCURRENCY`** (default 5), read through
  `scheduler.configure()` at boot rather than as a constant. The number that
  matters is DependencyTrack's, not this service's: total upstream load is
  `SCHEDULER_CONCURRENCY × REPORT_CONCURRENCY`, so raising it past DT's knee
  buys 5xx responses and retries rather than throughput, and peak memory scales
  with it because each report builds its workbook in memory.
- Per-schedule overlap protection is the `running_since` column, not a process
  variable.
- **A user owns any number of schedules, and at most one of them runs at a
  time.** That guarantee used to be free — `running_since` sat on a row that was
  itself unique per user — and is not free since migration 009. `claimOne()`
  keeps it with a `NOT EXISTS` clause over the same user's rows; without it an
  account with five schedules due at 09:00 would open five parallel crawls
  against its single DependencyTrack connection, which is the N-times-per-user
  upstream work §13 forbids. `claimDue(limit)` therefore issues **one statement
  per claim**: each has to commit before the next runs, or two schedules of one
  user would both pass that check in the same snapshot.
- **Cancelling a schedule deletes it.** The settings list holds what is live,
  not disabled husks; `schedule_projects` cascades with it and `schedule_runs`
  does not. `POST /schedules/:id/disable` still exists for stopping one without
  discarding the definition.
- **The number of schedules is a quota, shaped exactly like the report limit**
  (§7.5): `app_settings.default_max_schedules` with a nullable
  `user_settings.max_schedules` override, resolved in `userSettings.get()` and
  nowhere else, enforced on create with 429 `QUOTA_REACHED`. Being over it
  blocks; it never deletes a schedule.
- **Only the addressing and the covering note are per schedule.**
  `mail_settings` keeps the SMTP host, port, TLS, credentials and From address,
  because they describe one mail server the account authenticates to —
  duplicating them per schedule would mean re-entering a password to change a
  recipient. `schedules.to_addrs`, `cc_addrs`, `subject` and `body` override the
  account defaults, merged in `scheduler.applyScheduleRecipients()` and nowhere
  else. `NULL` means "inherit". The body is `mailBody` on the wire, because the
  route handler's own variable for the request payload is already `body`.
- **`to_addrs` and `cc_addrs` are deliberately not symmetric.** An empty
  `to_addrs` would mean "send to nobody", which is a silent outage rather than a
  configuration, so the database refuses it — with `cardinality()`, not
  `array_length()`, which returns `NULL` for an empty array and so passes a
  `CHECK` that meant to reject it. An empty `cc_addrs` is the opposite: a real
  instruction, and the only way to say "copy nobody".
- **CC has three states and each is reachable** (migration 011): `NULL` inherits
  the account list, `[]` copies nobody, a populated array overrides. All three
  existed in the schema after migration 010 and none of the middle one was
  reachable — `schedules.normalise()` folded an empty list into `NULL` on the
  way in and the route's `forClient()` used `||` to fold it back on the way out.
  The wire carries `ccEnabled` alongside `cc` because JSON cannot otherwise
  distinguish "copy nobody" from "inherit"; omitting the flag keeps the old
  meaning, so an older caller is unaffected.
  This **retired an implicit rule**: overriding `To` used to drop the account's
  `CC` silently, which was the least-bad default while "copy nobody" could not
  be expressed. With a visible switch, dropping CC behind the user's back while
  the switch reads "on" is the surprising behaviour, not the safe one. Migration
  011 writes `cc_addrs = '{}'` into exactly the rows that relied on the old rule
  (`to_addrs` overridden, `cc_addrs` NULL), so no existing schedule changes
  where its mail goes.
- **A manual run does not move the timetable.** `POST /schedules/:id/run-now`
  takes the same claim the poller takes — so Send now waits its turn rather
  than opening a second crawl — and `nextRunAfter()` preserves `next_run_at`.
  Recomputing it would push a Monday 09:00 schedule a week every time somebody
  tested it. A paused schedule can still be sent by hand; that is most of the
  point of pausing rather than cancelling.
- **Run totals are over the retention window, not all time.** `schedule_runs` is
  swept at 90 days, so `runStats()` returns `retentionDays` alongside the counts
  and the screen says "in the last 90 days". An unqualified total would shrink
  every month with nothing to explain it.
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

- **Minimum 12 characters, maximum 128, no spaces — and no complexity rule.**
  That is the whole policy, deliberately: current NIST and OWASP guidance is
  that a longer minimum beats character-class requirements, which mostly produce
  `Passw0rd!`. It lives in `lib/validate.js` and is mirrored in all three pages
  (§8.8); the four copies change in one commit or not at all. Existing passwords
  are hashed and keep working — only a new one or a change has to clear it.
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
- **"Live" has exactly one definition, and it lives in `sessions.liveClause()`:
  not revoked, inside the absolute expiry, *and* inside the idle window.** Every
  query that asks the question builds its `WHERE` from it. When the token path
  honoured the idle window and the login conflict check did not, a browser that
  had simply been closed for longer than the idle window was reported back to
  its own owner as "you are already signed in on another device".
- **A session that can no longer authenticate must not keep the slot.** The
  partial index tests `revoked_at` alone and knows nothing about expiry, so a
  dead row blocks the next sign-in until the sweeper deletes it days later.
  `issueSession` calls `sessions.retireNotLive()` on every sign-in — not only a
  forced one — which is what lets somebody sign back in after being away. It
  revokes only sessions that are already dead; ending a live one is
  force-disconnect, and the user has to be asked first.

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
- The administrator nevertheless has a **reserved data identity** — a fixed
  `users` row seeded by migration 004, id `00000000-0000-4000-8000-000000000001`,
  login `__administrator__`. It holds their own DependencyTrack connection,
  quota, mail settings and schedule so those flow through the ordinary per-user
  routes rather than a parallel set. It is **not an account**: nothing
  authenticates against it, its stored hash can never verify, its login ID is in
  `ALWAYS_RESERVED`, and it is excluded from the administration listing, the
  account count and the account detail view.
- The administrator's session row still has `user_id IS NULL` — the
  `sessions_principal_shape` constraint requires it. The reserved id is attached
  to the **resolved principal** in `auth.resolveToken`, not to the session.
- Profile editing and account deletion remain closed to the administrator: their
  name and password live in the credentials file, not the database. That is also
  why the reserved row cannot have its password reset — `adminResetPassword`
  excludes it explicitly, so there is never a second, silent way to authenticate
  as the administrator.
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
- **Quotas are enforced per user** (report limits, schedule counts, storage),
  never as a global counter. Who *chooses* the number changed in migration 005 — the administrator
  sets it, globally or for one account — but it is still counted and applied per
  user, and one account can never consume another's allowance.
  `user_settings.max_reports IS NULL` means "follow `app_settings`"; a value is
  an administrator's override. That distinction cannot be encoded as a number:
  a stored 10 is indistinguishable from an unset 10, so raising the default
  would silently skip everyone sitting on the old one. Resolution happens in
  `userSettings.get()` and nowhere else.
- **Being over a limit blocks, it never deletes.** `trimToLimit()` was removed
  with migration 005. It was defensible while each user chose their own number;
  the same call from a global change would destroy reports across many accounts
  at once. Do not reintroduce a trim without deciding that question again.
- **Shared caches are keyed by a fingerprint**, never by user, so that users with
  identical upstream credentials share one build. Single-builder election uses
  `pg_try_advisory_lock`.

### 7.6 Administration writes

Administration was read-only by design. It is not any more, and what it may do is
a **closed list of three**, not a general-purpose account editor:

| Route | Effect |
|---|---|
| `PUT /admin/settings` | The default report and schedule limits every non-overridden account follows |
| `PUT /admin/users/:loginId/settings` | One account's limits; `null` returns either to the default |
| `POST /admin/users/:loginId/password` | Reset one account's password |
| `PUT /admin/branding` | The application title; empty restores the built-in default |
| `POST /admin/branding/background` | Upload the sign-in background |
| `DELETE /admin/branding/background` | Restore the animated background |

Everything else about an account stays readable only. A test asserts exactly
these **six** are handled and every other method/path combination is not — a
blanket ban that had to be deleted would have stopped protecting anything, so
the allow-list is the contract and adding a seventh means editing it in a
diff somebody reads.

The schedule limit rides on the two settings routes that already existed rather
than adding a seventh — it is the same kind of decision about the same rows,
made by the same principal. That is what the allow-list is for: a new capability
has to justify a new entry, and this one did not need one.

The list went from three to six when customisation landed, and the three
additions were weighed rather than waved through: they change how the product
*looks*, never what an account is or what it may reach, and none of them reads
another principal's data. That is the bar a seventh has to clear too.

**S29 — the password reset is the most privileged thing in the service**, because
the administrator chooses a value that authenticates as somebody else. Three
things bound it, and none may be removed on its own:

- The account's sessions are revoked and its cached token evicted, so the person
  is signed out rather than silently followed.
- `users.must_change_password` is set, and dispatch then refuses every route
  except `/auth/set-password`, `/auth/logout` and `/auth/me`. The password the
  administrator typed can only ever be spent replacing itself — it never becomes
  a working credential for that user's DependencyTrack connection or reports.
- Every reset is written to `login_audit`, **in the same transaction as the
  password change**. Writing it afterwards meant a failure there left the
  password already replaced while the caller was told the reset had failed.

`/auth/set-password` deliberately does not ask for the current password: the user
does not know it, and the bearer token minted from it seconds earlier is the
proof of possession. Clearing the flag evicts the cached principal, so the same
session continues straight into the dashboard rather than bouncing for up to a
minute.

### 7.7 Secrets at rest

- DT API keys and SMTP passwords are encrypted with AES-256-GCM using
  `SECRET_ENCRYPTION_KEY`, with a per-record nonce and the auth tag stored alongside.
- A decryption failure surfaces to the user as "re-enter your API key". It must
  never crash a request or be logged with the ciphertext.
- **The DT API key is never returned in any HTTP response.** The UI is told only
  whether a key is configured.

---

## 8. Frontend

### 8.1 Three single-file pages

The dashboard is `index.html`, the login/registration/set-password page is
`login.html`, and administration is `admin.html`. Each is a self-contained HTML
file with inline `<style>` and a single `<script>`.

**The schedule editor is a drill-down inside the settings panel, not a dialog.**
Clicking a schedule replaces the panel's body and the header grows a Back
button. One schedule is open at a time by construction — a list of expandable
rows lets somebody edit three at once and lose two of them — and Back, Cancel
and closing the whole panel all pass through `confirmDiscardSchedule()`, so
there is no way out that silently drops what was typed. `_schedDirty` is
cleared *after* the fields are populated, never before: every write above fires
an `oninput` handler, so resetting it first leaves a freshly opened editor
claiming unsaved changes.

**The CC switch is the only way to say "copy nobody".** A blank CC field with
the switch on means "inherit the account's list", which is a different
instruction, so turning the switch off *clears and disables* the field rather
than leaving addresses visible under a control that says they are unused. The
placeholder states which of the two is in force, and the settings list marks a
schedule that copies nobody so it does not look identical to one that inherits.

**The panel has one footer, and its buttons dispatch on the open view.**
`savePanel()` and `cancelPanel()` branch on `_schedEditorOpen`; only the primary
button's label changes, so it always says which of the two things it is about to
save. A second footer per view is what shipped first, and it put two Save
buttons and two Cancel buttons on screen together — with the Cancel belonging to
Settings closing the whole panel from inside a schedule. **Inside the editor,
Cancel is one step back to the list**, never a dismissal: `cancelPanel()` calls
`closeScheduleEditor(false)`, and only the list's Cancel reaches
`closeConfigPanel()`.

**The drill-down's handlers mark the drill-down dirty.** `onSchedFreqChange()`
and `onSchedTimeChange()` call `markSchedDirty()`. They called
`markConfigDirty()` while the schedule form still lived in the settings panel,
and both halves of that were wrong after the split: `openScheduleEditor()` ends
by calling `onSchedFreqChange()`, so merely opening a schedule claimed Settings
had unsaved changes, while a changed frequency or send time set no flag at all
and Cancel discarded it without asking.

Administration was a slide-in panel while it did one read-only thing. It became a
page when it grew a master/detail split and service configuration: a panel that
has to host both is a page wearing the wrong clothes, and `index.html` was
already ~4,400 lines. **The old panel was deleted, not hidden** — a dead second
implementation is one that gets rendered by accident.

**Do not split either file into separate JS/CSS assets** — the no-build-step
constraint requires this. Adding a *page* is allowed; splitting a *page* is not.

```
<style>   — CSS custom properties + all rules
<body>    — semantic HTML (header, main, modals)
<script>  — IIFE wrapping all state and logic
```

**The application title is administrator-configurable, and its default is
repeated in all three pages.** They cannot `require()` `branding.DEFAULT_TITLE`,
so a test asserts the four copies still agree. This matters because before the
feature there were *five* different names in the product — three `<title>` tags,
a login heading and a footer that read "Internal Security Dashboard". The logo
mark is derived from the title (up to three initials) rather than a fixed glyph,
so a renamed installation does not keep wearing the old product's badge.

`login.html` and `admin.html` reuse the same CSS custom properties and form
classes as `index.html` so the three are visually identical. Duplicating a small
amount of CSS between them is accepted and preferred over introducing a shared
asset. A test asserts every custom property is present in all three, so they
cannot drift apart silently.

**The risk trend is a panel in `index.html`, not a page, and its charts are
hand-rolled inline SVG.** §3 caps the dependency list at three packages and
there is no build step to tree-shake a charting library, so the scales, the
paths and the axes are ~250 lines here. Being small is what makes them
testable: every helper is pure and `dashboard.test.js` extracts them from the
page's own source rather than copying them.

Four rules the panel must keep:

- **An unrefreshed day carries the previous reading, and the drawing says so**
  (Q23). This reverses the rule that shipped first, deliberately: breaking the
  line at every gap was the literally truthful picture, and it read to most
  people as "the tool stopped working" — a worse misreading than the one it
  avoided. Carrying forward *on its own* would be worse still, because a flat
  line across four days is a claim that the portfolio held steady and nobody
  measured that. So four things travel together and none may be removed alone:
  the bridging stroke is **dashed**, the span is **shaded with a hard edge**,
  a carried day gets **no data marker**, and the tooltip **names the day the
  number came from**. Continuous to read, impossible to quote as a measurement.
  `trendValues()` still returns `null` for an uncaptured day and the path
  helpers still break at `null` — that is what makes the solid overlay stop at
  the gap and let the dashes show through. Days *before* the first reading stay
  empty: there is nothing to carry, and extending the earliest value backwards
  across a year would be invention rather than inference. The header's
  "5 of 7 days recorded" is now the only unqualified statement of how much was
  actually measured, so it stays.
- **The default metric is the one the cards show.** "Critical" means two things
  in this product — pure CVE severity, and that plus the operational, licence
  and security-policy failures. The panel sits directly above the cards, so its
  default must be their arithmetic or the screen contradicts itself; the other
  reading is one dropdown away, which is what storing both components in
  `risk_snapshots` bought. A test asserts `trendValues('total')` still matches
  `computeSummaryTotals()` term for term.
- **`renderTrend()` returns early while the panel is collapsed.** `clientWidth`
  of a hidden element is zero, and the charts are sized from a measurement — so
  rendering while shut caches every SVG at padding width until the next resize.
- **Colours are custom properties inside the SVG**, never hex literals. An SVG
  `fill="var(--critical)"` re-resolves on a theme switch exactly as a div's
  background does, so the charts follow the theme with no JavaScript at all. A
  hex in an SVG attribute is precisely where that mistake hides from a CSS
  review, so a test forbids one in `TREND_LEVELS`.

**The findings dialog is an icon on the row, not a column.** A 👁 button sits
inside the existing project-name `<td>`, before the tree toggle, on any leaf
row `hasVulnerabilities()` **or** `hasLicenseRisk()` says is nonzero — never on
a group row, which has no DependencyTrack project of its own to query. A
project clean on CVEs but failing a license policy still gets the icon; one
clean on both gets none. Three rules govern the security half of it:

- **Q24: it mirrors `lib/reports.js`'s finding query byte for byte**, not the
  cleaner-looking `/api/v1/finding/project/{uuid}` path endpoint. The report's
  query is proven in production against real DependencyTrack installations;
  the path endpoint is not, and there is no live instance in this repository
  to validate it against. Matching the report's filters exactly also means the
  dialog and a generated report can never disagree about what counts as an
  open finding — both hide suppressed and triaged-away findings the same way,
  because it is the same request.
- **The CWE cell duplicates `lib/cwe.js` by hand**, the same trade-off §8.8
  already accepts for password validation: there is no build step to
  `require()` a server module from the browser. A test reads `lib/cwe.js`'s
  real source and asserts the two produce identical output.
- **The fetch is bounded at `CONFIG.VULN_MAX_ROWS`**, worst-severity-first, so a
  project with an unusually large number of findings cannot turn a click into
  an unbounded fetch loop — the same reasoning as the snapshot crawl's page
  ceiling. A `_vulnReqSeq` guard (the same pattern `_trendReqSeq` uses) stops a
  superseded click's response from landing in a dialog the user has since
  closed or reopened for a different project.

**The Origin column (Direct/Transitive) is always on; the path behind it is
opt-in.** Every row gets its badge the moment the dialog renders — one extra
`GET /violation-cache/dependency-paths/:id` call, resolved via
`loadVulnOrigins()` alongside the findings fetch, never gating the table on
whether it comes back. "Show full dependency paths" is a separate toggle
(`onVulnDepPathToggle()`) because the chain behind a Transitive tag is the
expensive half — see §6.3a. `componentKeyOf()` mirrors
`lib/dependency-paths.js`'s `componentKey()` by hand, the same duplication
class as the CWE helpers above; a cross-file test asserts the two agree.

- **`renderVulnRows()` is the only place a row is drawn.** Both the initial
  findings render and a toggle click re-render through it, reading
  `_vulnDirectKeys`/`_depPathStatus`/`_depPathPaths` fresh each time, so the
  table can never show one row's badge computed against a different project's
  data. A Transitive finding with a resolved chain draws as **two** `<tr>`s —
  the finding row (`vulnRowHtml()` or `vulnLicenseRowHtml()`, whichever view
  is showing), immediately followed by a full-width detail row from
  `vulnDepPathRowHtml()` — never squeezed into the Origin cell itself.
  `.vuln-table` is `table-layout: fixed` with widths declared once on the
  header cells (§8.10) specifically so that an appearing, changing, or
  disappearing detail row can never resize the other columns — before this,
  checking the toggle visibly reflowed the whole table on every render.
- **A cache hit skips the network entirely.** `loadVulnOrigins()`'s single GET
  already returns whatever the cached walk currently knows, so if `status` is
  already `'ready'` — because another user resolved this project's paths, or
  this one did earlier in the same dialog session — checking the toggle
  renders instantly from what is already in hand; `onVulnDepPathToggle()` only
  issues the `POST` that starts a walk when there is nothing to show yet.
- **`_depPathReqSeq` guards the poll independently of `_vulnReqSeq`.** Opening
  a new project, or unchecking then rechecking the toggle, must invalidate
  whatever the previous poll was waiting on without disturbing an
  already-rendered findings table. `closeModal('vulnDialog')` stops the poll
  outright, the same way it already stops the reports modal's.

**Q28: one dialog, two independent tables, picked by a dropdown — not two
dialogs, and not one table with mixed rows.** `#vulnViewType` selects Security
Violations or License Risk; `#vulnOriginFilter` (Both/Direct/Transitive) is a
second, purely local dropdown that filters whichever table is showing, with no
network call — it is applied inside `renderVulnRows()` itself, and it never
excludes a row before Tier 1 has classified it (`origin === null` passes
through unfiltered, the same "never guess a badge" rule `vulnOriginFor()`
already follows). The title stays one generic word — "🔎 Findings —", not
"Vulnerabilities" or "License Risk" — regardless of which table is open, so
the project name/version (`.vuln-dialog-project-tag`, accent-coloured) carries
its own visual weight instead of relying on a type-specific heading next to it.

- **Security is fetched eagerly on open; License is fetched lazily, once,
  the first time the dropdown reaches it.** `_vulnShownLicense` stays `null`
  until then and is never reset back to `null` for the rest of the dialog
  session, so flipping the dropdown back and forth after that first fetch is
  free — the same "no network call for a local control" rule the origin
  filter follows. `vulnLicenseQuery()` mirrors `lib/reports.js`'s
  `streamViolationsForProject()` (`riskType=LICENSE`) byte for byte, the same
  Q24 reasoning as `vulnFindingsQuery()` — DT's `project={uuid}` filter is
  silently ignored on some versions, so both search by project name and
  filter the response by exact uuid match afterwards.
- **License Risk sorts FAIL, then WARN, then INFO — the same worst-first
  convention Security's `sortFindingsBySeverity()` already gives its own
  table.** DT's license-violation search has no severity ordering of its
  own, so `_vulnShownLicense` arrived in whatever order the page came back
  in until `sortLicenseByState()` (`LICENSE_STATE_ORDER`, mirroring
  `VULN_SEVERITY_ORDER`'s shape) sorted it at the same point
  `onVulnViewTypeChange()` stores the fetch, before it is ever rendered — so
  a re-render from the origin filter or the toggle never has to re-sort, and
  the two tables read consistently regardless of which one is open.
- **The colspan a Transitive row's path detail spans follows the view
  type — `VULN_TABLE_COLS[_vulnViewType]`, not a number hard-coded to one
  table.** Security has eight columns, License has six (Component, Current,
  License, Policy, State, Origin); the `<thead>` itself is populated from
  `VULN_TABLE_HEAD[_vulnViewType]` for the same reason, rather than being
  static markup that would freeze on whichever view happened to be first.
- **`transitiveTargets()` is the union of both tables' components, not just
  the one currently showing.** Tier 2 is cached per project (§6.3a), not per
  view, so a walk that already covers the Security view's transitive
  components should not be thrown away just because License also needs a
  couple more — `runJob`'s `storeResult` **overwrites** the stored `paths`
  with exactly what it was asked for, so asking for a narrower set on a
  second walk would silently lose the first one's results. `_vulnShownLicense`
  being `null` (not yet fetched) simply drops out of the union rather than
  being treated as "known to need nothing."
- **The toggle's own "already ready" fast path checks target coverage, not
  just status.** `onVulnDepPathToggle()` used to trust a `_depPathStatus ===
  'ready'` flag on its own; switching to License after an earlier walk can
  enlarge `transitiveTargets()` with components that walk was never asked
  about, and a stale-but-locally-`'ready'` status would otherwise skip
  straight to rendering "no path recorded" for them. The fast path now also
  requires `targets.every(t => t in _depPathPaths)` — which is also what
  makes it safe for `onVulnViewTypeChange()` to simply call
  `onVulnDepPathToggle()` again when License finishes loading and the toggle
  is already checked, rather than duplicating its walk-starting logic.

Adding a page needs no nginx change: `try_files` serves a real file before the
SPA fallback is considered.

### 8.2 IIFE + window exports

All JavaScript is wrapped in an IIFE. `onclick=""` handlers call functions exposed
through `window.*` exports at the bottom of the IIFE. Any new handler must be added
to that export block or it will silently fail.

### 8.3 Backend calls go through `apiFetch()`

Every call to `/violation-cache/*` uses the `apiFetch(path, opts)` wrapper, which:

1. attaches the `Authorization: Bearer` header,
2. redirects to `login.html` when no token is present,
3. clears the token and redirects on any 401.

**Never call `fetch()` directly against a backend route**, with exactly one
documented exception: `/branding`, which `login.html` must read *before* any token
exists. `apiFetch` would redirect to the sign-in page from the sign-in page.
Everything else goes through the wrapper — DependencyTrack included, reached via
`DT_PROXY` (`/violation-cache/dt/…`) on the same backend, which attaches the
signed-in user's API key server-side. The browser holds no DependencyTrack
credentials at all.

### 8.4 Auth gate

**The gate runs in `<head>`, before the body is parsed.** It used to run at the end
of the script block, which meant the browser painted the whole dashboard, *then*
awaited `/auth/me`, and only then redirected — so every signed-out visitor saw a
dashboard flash, and an interrupted network left them staring at empty chrome with
no explanation and no way out.

Three layers, and none may be removed on its own:

- A **synchronous** token check in `<head>`. No token is decidable without a round
  trip, so that case never paints at all and `location.replace()` (not `href`)
  keeps it out of the back history.
- **`<html class="booting">`**, set by that same script, hides everything except
  `#bootGate`. A token that turns out to be expired cannot be judged
  synchronously, so the shell stays hidden until `/auth/me` answers. The class is
  removed *after* the check, never before — a test asserts that ordering, because
  reversing it puts the flash straight back.
- An **`AbortController` deadline** on the check. Without it an unreachable
  backend leaves the gate spinning forever, which is the same dead end as before,
  just prettier. The failure renders inside the gate with Retry and Sign in.

`index.html` validates the session before any data loading, theme initialisation or
rendering. An unauthenticated visitor never sees dashboard chrome.

`admin.html` goes further: being signed in is not enough, the principal must be
the administrator. An ordinary user reaching that URL is sent to the dashboard
rather than shown a screen whose every request would 403.

A session with `mustChangePassword` set is authenticated but may reach nothing
else, so `apiFetch` treats a 403 carrying `PASSWORD_CHANGE_REQUIRED` as "go and
choose a password" — without it the dashboard fills with identical error toasts
as each call fails in turn.

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
| `_cacheBuilding` | boolean | A violation-cache build is in flight for this connection |
| `_cacheWatchTimer` | number \| null | Slow poll that notices builds started by other users |
| `_trendSeries` | object \| null | Last `/risk-series` envelope; server-side history, independent of `allProjects` |
| `_trendReqSeq` | number | Monotonic request id — only the newest response may render |
| `_trendView` | object | How this viewer likes the panel; persisted under one `localStorage` key |

`_cacheBuilding` is never assigned directly — every write goes through
`setCacheBuilding()`, which also disables the toolbar's ↻ Refresh. The toolbar
button lives outside the banner's HTML and so is not re-rendered when the banner
is; left to itself it stayed clickable through a build, beside a banner control
that was visibly disabled. It is disabled rather than removed because it is not
the same control: ↻ Refresh reloads the project hierarchy as well, and nothing
else picks up a newly added project without a full page reload.

Never mutate `allProjects` after initial load. Derive everything else from it.

**The trend panel derives from nothing on this list.** It is server-side history
keyed by connection, so a filter, a search or a hierarchy reload leaves it
alone — and a completed refetch must explicitly call `loadTrend()`, because the
build writes today's snapshot on its way out and the series in hand is one point
stale the moment the banner turns green. `_trendReqSeq` exists because the
period control is a dropdown: choosing "year" then "week" fires two requests, and
the year's larger payload can easily land second.

**A refetch must re-run `applyFilters()`, not replay `currentMatchSet`.** The
risk and category filters are computed *from* violation counts, so a match set
built while those counts were still zero is stale the moment new data lands;
and `renderTree` ignores `flatView`, so replaying it flipped the flat list back
to a tree. `applyFilters()` re-reads the controls, so the user's choices survive
and are correct against the data that just arrived.

**Controls that act on the table are disabled until there is a table.** They
are listed once in `TABLE_CONTROL_IDS` and switched by `setTableControlsEnabled()`
— closed during bootstrap, opened at the end of `afterLoad()`. Left live, a
filter chosen while the banner still said "Connecting…" applied to nothing and
was then overwritten by the first render.

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
  _dataWarn:   string | null    // why this row's numbers may be incomplete, or null
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
- The violation cache is shared by connection fingerprint, so the refetch control
  is disabled for **every** dashboard on that connection while a build runs, not
  just the one that started it. A slow idle watch (`CACHE_WATCH_MS`) notices a
  build somebody else began; the fast poll (`CACHE_POLL_MS`) takes over while it
  runs and renders immediately rather than after a full interval.

### 8.10 CSS conventions

- Theme driven by CSS custom properties on `:root`, overridden under
  `[data-theme="light"]`.
- **Side panels slide in from the right** (`right: 0`, `translateX(100%)` when
  closed), so a panel appears beside the toolbar button that opens it. Settings,
  Profile and Administration all use this one pattern.
- The login page's animated background is pure CSS — transforms and opacity
  only, so the compositor runs it off the main thread. It must stay decorative:
  `aria-hidden`, behind a `z-index`, and disabled under
  `@media (prefers-reduced-motion: reduce)`.
- **Chart geometry is measured, and a measured chart needs a debounced redraw.**
  The trend SVGs are built at a pixel width read from the container, so
  `onTrendResize()` re-renders on resize — debounced at 150 ms, because a window
  drag fires continuously and rebuilding four SVGs per frame is exactly the work
  §13 forbids. How many date labels fit is derived from the plot width too
  (`trendLabelCapacity`) rather than being a constant: the same seven days have
  room for seven dates on the combined chart and for two in a small multiple.
- Accent colour `--accent: #6366f1`. Severity colours are variables
  (`--critical`, `--high`, …).
- Never hard-code a colour hex inside a component rule.
- Responsive breakpoints: 1200 px → 900 px → 768 px. `login.html` adds 640 px
  (the name pair stacks) and **height** breakpoints at 720 px and 560 px.
  Browser zoom shrinks the CSS viewport, and it shortens it before it narrows
  it, so a page with only width breakpoints hides its own buttons when zoomed.
- **A multi-row table header sticks per cell, not per row.** `thead tr {
  position: sticky; top: 0 }` puts every row at the same offset, so the later
  one paints over the first and the group captions vanish on scroll. Stick the
  `th` cells and give the second row `top: var(--th-group-h)`, a custom property
  `syncStickyHeader()` keeps equal to the first row's measured height — it moves
  with font size, zoom and the breakpoints, so it cannot be a constant.
- **Never put `overflow: hidden` on `body`.** A decorative layer that overflows
  clips itself inside a `position: fixed` wrapper. Centre a card taller than the
  viewport with `margin: auto`, not `align-items: center` — the latter overflows
  equally in both directions and the part above the top edge cannot be reached.
- **`index.html` declares `[hidden] { display: none !important; }`, and it is
  load-bearing.** The browser's own `[hidden] { display: none }` lives in the
  user-agent stylesheet, so *any* author rule that sets `display` on the same
  element beats it. `.btn` is `inline-flex` and `.cfg-panel-footer` is `flex`,
  so `el.hidden = true` silently did nothing to either: both panel footers
  rendered at once, and a schedule that did not exist yet offered "Cancel this
  schedule". Prefer `el.hidden` over `style.display` — but only because this
  rule makes the attribute mean what it says.
- **A flex `gap` reaches children, not grandchildren.** `.cfg-panel-body` spaced
  the `.cfg-section`s until the drill-down wrapped them in `#cfgMainView` /
  `#cfgSchedView`, after which every section sat flush against the next. Both
  views carry `.cfg-view` with the same column gap; a test asserts the two
  numbers still match, because a wrapper introduced later is exactly how this
  recurs.
- **A table whose row content varies needs `table-layout: fixed`, not auto.**
  `.vuln-table` (§8.1) used to size its columns from content, so the
  dependency-path toggle — which adds or removes a chain — visibly resized
  every other column on each click. Fixed layout with widths declared once on
  the header cells makes every row, including a `colspan`'d detail row, honour
  the same geometry regardless of what it holds.
- **A reused component's own class can still lose a specificity fight inside
  a new container.** `.modal label { display: block; ... }` (§8.1's findings
  dialog) has specificity `(0,1,1)` — one class, one element — against
  `.cfg-inline-toggle`'s bare `(0,1,0)`, so the toggle row's label silently
  fell back to a full-width block the moment it was reused inside `.modal`,
  pushing its next sibling (the "↻ Refetch paths" button) onto its own line
  underneath instead of beside it — a bug specificity math predicts and a
  glance at source order does not, since `.cfg-inline-toggle` is declared
  later in the file. `.dep-path-toggle-row .cfg-inline-toggle { display:
  inline-flex; }` restores it at equal specificity, scoped to this row so it
  does not reopen the same collision for a `.cfg-inline-toggle` that actually
  wants a bare label's block layout elsewhere.

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
| `trendValues(point, metric)` | frontend | Fold a stored day into the four plotted numbers; `null` for a gap |
| `trendNiceCeil(max)` | frontend | Round axis ceiling; never 0, because every y divides by it |
| `trendCarry(rows)` | frontend | Carry the last reading over unrefreshed days; flags which positions were inherited |
| `trendLinePath` / `trendAreaPath` | frontend | SVG paths that break at `null` — what lets the solid overlay reveal the dashed bridge |
| `hasVulnerabilities(node)` / `hasLicenseRisk(node)` / `vulnEyeIconHtml(node, isGroup)` | frontend | Gate (on either finding type) and render the 👁 icon on a leaf row |
| `vulnFindingsQuery(name, version, page)` | frontend | The finding-search query, mirroring `lib/reports.js`'s `fetchAllFindings()` (Q24) |
| `vulnLicenseQuery(name, page)` | frontend | The license-violation search query, mirroring `lib/reports.js`'s `streamViolationsForProject()` (Q24, Q28) |
| `sortFindingsBySeverity(findings)` | frontend | Worst severity, then highest CVSS, first |
| `sortLicenseByState(violations)` | frontend | FAIL, then WARN, then INFO — License Risk's equivalent of `sortFindingsBySeverity` |
| `componentKeyOf(c)` | frontend | Component identity: purl, or group/name/version — mirrors `lib/dependency-paths.js`'s `componentKey()` |
| `vulnRowHtml(finding, origin)` / `vulnLicenseRowHtml(violation, origin)` | frontend | One `<tr>` for a Security or License row, each with its own column set |
| `vulnOriginCellHtml(origin)` / `vulnOriginFor(finding, showPaths)` | frontend | Render and compute a row's Direct/Transitive badge — takes either finding type, since origin is a component property |
| `vulnDepPathRowHtml(origin)` | frontend | The full-width path detail row; its `colspan` follows `VULN_TABLE_COLS[_vulnViewType]` (Q28) |
| `transitiveTargets()` | frontend | The union of both tables' transitive components, so a walk never loses coverage when the view switches (Q28) |
| `query(sql, params)` / `tx(fn)` | server | All database access |
| `makeSemaphore(limit)` | server | Promise concurrency limit |
| `sleep(ms)` | server | Promise delay |
| `dtGetWithRetry(...)` | server | Resilient DT API fetch |
| `log(level, msg, meta)` | server | Structured logger |
| `hashPassword` / `verifyPassword` | server | scrypt wrappers |
| `mintToken` / `hashToken` | server | Session token helpers |
| `encryptSecret` / `decryptSecret` | server | AES-256-GCM wrappers |
| `calcNextRun(schedule, now)` | server | Pure function: next fire time, in UTC |
| `snapshots.summarise(projects, map)` | server | Pure fold of one day's risk totals |
| `snapshots.series(fp, days)` | server | Dense daily history; a gap is `captured: false`, never carried forward |
| `dependencyPaths.getDirectDependencies(url, key, uuid)` | server | Live, uncached Tier-1 direct-dependency set (§6.3a) |
| `dependencyPaths.walkGraph(...)` / `.runJob(conn, uuid)` | server | The cached Tier-2 graph walk and its job orchestration |
| `dependencyPathCache.getMeta` / `.deriveStatus` / `.acquireBuildLock` | server | Row CRUD and the advisory lock behind the walk — the pair split for the reason `caches.js`/`violation-cache.js` are (§6.3a) |
| `collectReportData(...)` | server | Shared collection core for manual and scheduled reports |
| `sendEmail(mailCfg, ...)` | server | Deliver report via nodemailer |

---

## 9. Infrastructure

### 9.1 nginx config template

`dashboard/nginx.conf.template` uses `envsubst` placeholders (`${VAR_NAME}`).

- `/auth/*`, `/profile` and `/violation-cache/*` → `dt-violation-cache:3001`.
- **`client_max_body_size 6m`.** The report route deliberately accepts a 5 MB
  body for a large project selection (§12); nginx's 1 MB default rejected it
  here first, with nginx's own HTML 413 rather than the JSON the dashboard can
  explain.
- **`nosniff` and `Referrer-Policy` are repeated in every location that sets
  `Cache-Control`.** nginx does not merge `add_header`: a block declaring one of
  its own replaces the whole inherited set, so a header defined only at server
  level silently disappears from exactly the responses that carry data.
  `X-Frame-Options` is deliberately absent — the dashboard is documented as
  iframe-embeddable, which is also why CORS is open (§12).
- SPA routing: `try_files $uri $uri/ /index.html`; `login.html` served directly.
- There is **no `/api/*` block and no `/dt-config` block**. DependencyTrack is
  per-user, reached through `/violation-cache/dt/`; forwarding `/api/*` to one
  shared instance would defeat both the per-user connection and §7.7.

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

The image installs from the committed lock file with `npm ci`, not `npm install`,
so it contains exactly the dependency tree that was tested and audited.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
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

**Uninstall has two levels, and the difference is data:**

| Flag | Containers and network | Images | `pgdata/`, `data/` | Confirmation |
|---|---|---|---|---|
| `--uninstall` / `-u` | removed | kept | **kept** | `y/N` |
| `--all` / `-a` | removed | removed | **deleted** | type `DELETE` |

- `docker compose down -v` is used only at the `--all` level. At the plain level
  nothing on disk may be discarded, and the flag would say the opposite.
- The banner must name every container and every directory, and must state
  plainly whether the data survives. Update it whenever a service or bind mount
  is added.
- `.env` is kept at both levels: it holds `SECRET_ENCRYPTION_KEY`, and deleting
  it silently is a much worse failure than leaving it.
- Deletions use `${SCRIPT_DIR:?}` so an empty variable cannot turn a cleanup
  into an `rm -rf` of the wrong path.
- Re-running the installer asks every question again, with the current values as
  defaults. A PostgreSQL credential that differs from the existing cluster's is
  challenged before it is written, because PostgreSQL reads those only at data
  directory initialisation and the service would then fail to connect. The
  administrator credential has no such constraint and is simply offered as a
  reset. **Skipping a prompt is not an option** — an operator who is never asked
  cannot tell the difference between "not supported" and "broken".
- `installer.test.js` pins all of this. It runs offline against a throwaway copy
  with a stub `docker` on `PATH`, driven through a pty because bash shows a
  `read -p` prompt only on a terminal — over a pipe a test cannot tell "asked
  and answered" from "never asked".
- **Anything the Dockerfile `COPY`s must not be listed in `.dockerignore`.** The
  build fails with `failed to compute cache key: ... not found`, which names the
  file but not the reason. `installer.test.js` checks the two files against each
  other statically, so this is caught without building an image.

---

## 10. Testing

### 10.1 Test runner

```bash
node --test violation-cache/server.test.js
node --test violation-cache/dashboard.test.js
node --test violation-cache/installer.test.js

# opt-in database tier
TEST_DATABASE_URL=postgres://… node --test violation-cache/db.test.js

# opt-in end-to-end tier — boots the product; DESTROYS that database
TEST_DATABASE_URL=postgres://… node --test violation-cache/e2e.test.js
```

No npm test script is defined. The default run must stay offline: it requires no
database, no Docker and no network. CI runs the offline tiers on every push and
the database tier against a `postgres:16-alpine` service container
(`.github/workflows/ci.yml`).

### 10.2 Four tiers

| Tier | File | Requirement |
|---|---|---|
| Pure unit | `server.test.js`, `dashboard.test.js` | Always runs. No I/O beyond temp files. |
| Route / authorisation | `server.test.js` | Always runs, with a stubbed data layer. |
| Installer | `installer.test.js` | Always runs. Executes `install.sh` in a temp copy with a stub `docker`. |
| Database integration | `db.test.js` | Skipped unless `TEST_DATABASE_URL` is set. |
| End-to-end | `e2e.test.js` | Skipped unless `TEST_DATABASE_URL` is set. Boots the real `server.js`, a real database and the real pages; stubs only DependencyTrack and SMTP. Its browser section skips again unless Playwright resolves. |

`docs/perf-check.js` is **not** a test tier: it seeds tens of thousands of rows,
which no test may do. It is run by hand before a release and its output lives in
`docs/PERFORMANCE.md`.

### 10.3 Continuous integration — `.github/workflows/ci.yml`

Nobody runs it locally; **GitHub Actions** runs it on every push to any branch
and on every pull request, and reports each job as a check on the PR. Nothing in
it is bespoke — it runs the same commands listed in §10.1.

| Job | What it runs | Why it is separate |
|---|---|---|
| `offline` | `server.test.js`, `dashboard.test.js`, `installer.test.js`, `bash -n install.sh` | Needs no database, no Docker, no network. Keeping it its own job is what proves that tier really is offline: if someone adds a hidden dependency on a database, this job fails while the others pass. |
| `database` | `db.test.js` against a `postgres:16-alpine` **service container** | The opt-in tier. Migrations, the partial indexes, cascade deletes, `SKIP LOCKED` and chunked byte round-trips can only be checked against a real PostgreSQL. |
| `e2e` | `e2e.test.js` against a `postgres:16-alpine` service container, with Playwright installed `--no-save` | The assembled product. It is the only job that would notice a change that is correct in every unit and wrong once the layers are joined up — a recipient merge that never reaches `RCPT TO`, a chart that contradicts the card above it, a route that decrypts a secret it has no use for. Playwright is installed here rather than depended on, so §3's three-package cap holds. |
| `audit` | `npm ls --omit=dev`, `npm audit --omit=dev` | Recorded, `continue-on-error`. Deliberately does not fail the build — see below. |

**Why the audit job does not gate merges.** One advisory has no non-destructive
fix: `uuid < 11.1.1`, reachable only through `exceljs`, whose only offered remedy
is a major downgrade. `exceljs` calls `uuid.v4()` with no buffer argument and the
advisory covers v3/v5/v6 with a caller-supplied buffer, so it is not reachable
here. A red X nobody can clear teaches people to ignore red X's. The output stays
in the log, and §3 still requires it in the description of any dependency change.

**Current scope.** Correctness and isolation, from the unit up to the assembled
product in a browser. It does not build the Docker image, does not deploy, and
does not run `docs/perf-check.js`.

**Known gap, and how it is covered.** Because CI never builds the image, a
Dockerfile that cannot build is not caught by running it — that is exactly how
`COPY package-lock.json` shipped while `.dockerignore` still excluded the file.
`installer.test.js` therefore checks the Dockerfile and `.dockerignore` against
each other **statically**, which catches that whole class offline. Adding a real
`docker build` job is the obvious next step and would make the static check
redundant.

**Future scope**, in the order it is worth doing:

1. A `docker build` job, replacing the static Dockerfile check with the real thing.
2. A release job that runs `docs/perf-check.js` and fails on a query plan
   regression — the harness already exits non-zero for that.
3. Publishing the built image to a registry on a tag.

Running the browser checks in CI was on this list and is now the `e2e` job.

### 10.4 Conventions

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
- **The end-to-end tier runs `server.js` as a child process**, for the same
  reason the others may not import it, and because that is what the container
  does. Everything else it needs — the DependencyTrack stub, the SMTP stub, the
  nginx-equivalent — runs in-process: they are a few dozen lines each, so
  spawning them would buy nothing and cost port files, orphan processes and
  flakiness. Its ports are assigned by the OS, never hard-coded, so a run cannot
  collide with a developer's stack or a parallel CI job.
- **A test earns the end-to-end tier only if it needs the layers joined up.**
  "Does the merge produce the right recipient list" is `server.test.js`; "do
  those addresses reach `RCPT TO`" is `e2e.test.js`. Anything provable with a
  stub belongs in the offline tier, which runs in two seconds and needs nothing.

### 10.5 What to test

- `.env` parsing edge cases: CRLF, quoted values, comments, missing `=`, duplicates.
- Every validation rule, including boundary lengths and rejected characters.
- Password hashing round-trip, and rejection of a tampered hash.
- Token minting and hashing; encryption round-trip and auth-tag failure.
- The scheduler pool: the tick returns while reports are still building, the
  ceiling is never exceeded, a finished job refills its own slot without another
  tick, and a report that never finishes does not stop the other slots cycling.
  The first of those is raced against a deadline rather than simply awaited —
  under the batch design it hangs, and a test that hangs burns a CI timeout
  instead of naming the defect.
- `calcNextRun` for all three frequencies, including a weekly schedule that
  fires today and one whose time has already passed, and that the answer does
  not move when `process.env.TZ` does.
- The dashboard's UTC↔local schedule converters, round-tripped across whole-hour,
  half-hour and 45-minute offsets and both extremes, plus the cross-layer check
  that what the picker stores is the local time the scheduler fires at. They are
  extracted from `index.html` rather than copied, so the test cannot pass against
  a version of the code the page no longer contains.
- **Database tier:** migrations apply to an **empty** schema and are idempotent;
  the single-live-session index rejects a second session; cascade deletion
  removes all owned rows; chunked byte round-trips are identical; `SKIP LOCKED`
  claims each row once, and one user's several schedules claim one at a time.
  `resetSchema()` drops the schema rather than the ledger — dropping only the
  ledger made the suite replay the shipped directory over its own output, which
  is a stronger promise than §5.3's and one no deployment needs.
- Per-schedule recipients: an override replaces the account list, a blank field
  clears back to it, an empty `to_addrs` is refused by the database, and the
  merge is checked against a real SMTP conversation so the assertion is about
  which addresses reach `RCPT TO` rather than which object was built.
- Risk snapshots: the fold sums the same projects for both halves and never
  yields `NaN` from a missing upstream metric; a day nobody refreshed comes back
  `captured: false` rather than as the previous day carried forward; the upsert
  overwrites within a day instead of adding a row; the retention sweep keeps
  what is inside the window. Two of these need a real PostgreSQL and are worth
  the tier on their own — that the history survives `caches.sweepOrphaned()`
  deleting the cache row beside it, and that the day still reads back as a
  string when `process.env.TZ` moves, which is what a plain `SELECT day` would
  break.
- The trend charts: the fold against the KPI formula (a cross-layer check — the
  tile arithmetic is read out of `index.html` too, so changing one without the
  other fails); a gap folding to `null` rather than zero; `trendNiceCeil(0)`
  returning a usable axis rather than a page of `NaN` for a clean portfolio; and
  a single captured day landing in the middle of the plot rather than at
  `Infinity`. Every helper is extracted from the page, not copied.
- Carrying forward (Q23) needs all four of its signals tested together, because
  each one alone is what stops a carried number reading as a measured one: the
  carried position is flagged, it draws no marker, the bridge is dashed while
  the measured overlay still breaks, the band is emitted *after* the series so a
  stacked fill cannot hide it, and the tooltip scans back to name the day the
  number came from. A leading gap must stay empty rather than back-filling the
  first reading into a year of history nobody recorded.
- Dependency-path resolution (§6.3a): the walk's shortest-chain reconstruction
  against a diamond graph (one component reachable from two direct
  dependencies gets two chains, one per root — Q27 — and everything downstream
  of it inherits both roots too); the `MAX_ROOTS_PER_COMPONENT` cap on a
  widely shared component; a component the walk never reaches has no path
  entry at all; the node ceiling stops an unbounded upstream chain; the stall
  watchdog and heartbeat, raced
  against a shrunk `configure({stallMs})` window rather than the real fifteen
  minutes, the same technique the violation-cache watchdog tests already use.
  The database tier pins the job-status machine (`building` → `stalled` →
  rebuildable; a heartbeat cannot resurrect an already-finished row) and that
  `sweepOrphaned()` leaves a still-configured connection's walk alone. The
  frontend's Origin badge is tested by feeding `vulnOriginFor()` a sandboxed
  `_vulnDirectKeys`/`_depPathStatus`/`_depPathPaths` rather than driving real
  DOM state, and `componentKeyOf()` is checked against `lib/dependency-
  paths.js`'s real `componentKey()` via `require()`, not a sandboxed re-load —
  that module pulls in other `lib/` modules at load time, unlike `lib/cwe.js`,
  so it needs a real `require()` rather than a `new Function()` sandbox with
  no resolver.
- License risk (Q28, §8.1): `vulnLicenseQuery()` checked against
  `streamViolationsForProject()`'s own source the same way `vulnFindingsQuery()`
  is checked against `fetchAllFindings()`'s — sliced to that function
  specifically, since both functions in `lib/reports.js` name their query
  array `baseQs` and a plain regex would otherwise silently grab the wrong
  one; `vulnLicenseRowHtml()`'s license-name precedence (resolved name →
  license id → the raw policy-condition value → an em dash, never blank);
  `vulnDepPathRowHtml()`'s colspan following `_vulnViewType`; `renderVulnRows()`
  never excluding a row via the origin filter before Tier 1 has classified it;
  `transitiveTargets()`'s union across both tables, including that a
  not-yet-fetched License view is excluded rather than treated as empty.
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
- Mark a row whose numbers may be incomplete with `_dataWarn` — a sentence
  saying why, which `renderTree` turns into the ⚠ beside the name. It is set for
  one case today: a project whose `metrics` the API did not embed. Violation
  counts arriving later are covered by the banner instead, which says
  "⏳ Refetching violations…" while they are still zero.
- Never swallow errors silently — at minimum log them to the console.
- Graceful degradation: with no DT connection configured, show mock data and a
  clear "demo data" notice.

---

## 12. Security

- **Authentication is mandatory on every backend route.** New routes are
  authenticated by default; a public route must be listed explicitly and justified.
  The list is `/auth/register`, `/auth/check-availability`, `/auth/login`,
  `/branding` and `/branding/background` (**S32**), which the sign-in page needs
  before a token exists, and `/healthz` (**S33**). Branding on a sign-in screen is public by construction:
  anyone who can reach the page can already see it. They return the title and the
  image and nothing else — no account, no setting, no count.
  **`/healthz` returns `{"status":"ok"}` and nothing else** — no account, no
  setting, no count, no version, so it discloses exactly what a closed port
  would. It is answered in `server.js` before route dispatch rather than in a
  route module, because a liveness probe that fails when the application is
  unwell cannot tell "unwell" from "gone". The compose healthcheck used to point
  at `/violation-cache/status`, which stopped being public when phase 2 made
  every route private — `wget` exits non-zero on a 401, so the container
  reported unhealthy for its whole life while working perfectly.
- Secrets never appear in responses or logs (§6.5, §7.7).
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
- **The CSV export neutralises formula-leading values.** A cell whose text starts
  `=`, `+`, `-` or `@` is prefixed with an apostrophe, which Excel treats as
  text and does not display. Quoting alone does not stop this: Excel evaluates a
  quoted cell too, and project names reach the export from SBOM metadata rather
  than from the operator. The xlsx path needs no equivalent — `exceljs` writes
  string cells, which Excel does not evaluate.
- **The DependencyTrack URL is a deliberate outbound trust boundary.** A signed-in
  account chooses it, and the service then fetches it — that is the product's
  whole job, and DependencyTrack normally lives on an internal host, so blocking
  private ranges would break the common install. What bounds it instead: the
  proxy forwards **GET only**, under **`/api/v1/` only**, using the key of the
  account that owns the connection, and the response is returned to that same
  account. Anyone who can reach this is already authenticated and could point a
  browser at the same host. Do not add a private-range block without deciding
  that question again — an env opt-out would be required for it to be usable.

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
  retained 90 days; daily risk snapshots are swept at `SNAPSHOT_RETENTION_DAYS`
  (default 400), and the table is bounded at that times the number of distinct
  connections.
- **Bounded concurrency everywhere.** Pool 15, scheduler 5
  (`SCHEDULER_CONCURRENCY`), report fetches 5, violation fetches 3.
- **No idle capacity while work is queued.** The scheduler's slots are refilled
  by the job that frees them, not by the next poll (§6.8).

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
| `VIOLATION_JOB_STALL_MINUTES` | server | Silence after which a refetch is presumed wedged (default 15) |
| `SNAPSHOT_RETENTION_DAYS` | server | Days of daily risk history kept for the trend view (default 400 — a year plus five weeks, so the year window never truncates) |
| `PORT` | server | Cache service listen port (default 3001) |
| `REPORT_CONCURRENCY` | server | Max parallel project fetches (default 5) |
| `SCHEDULER_CONCURRENCY` | server | Scheduled reports building at once, across all accounts (default 5). One account's own schedules always run one at a time regardless. Upstream load is this × `REPORT_CONCURRENCY` |
| `VIOLATION_CONCURRENCY` | server | Max parallel violation fetches (default 3) |
| `LOG_FORMAT` | server | `text` (default) or `json` |
| `TEST_DATABASE_URL` | tests | Enables the database integration tier |

Neither the report limit nor the schedule limit is an environment variable. It is service configuration
the administrator owns at runtime, held in `app_settings` and edited from the
administration screen — an operator should not have to restart a container to
change a quota.

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
