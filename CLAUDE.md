# Codebase Instructions for AI Assistants

This document captures the architecture, conventions, and design decisions of the
**dependency-tracker** project. Every AI-assisted change must follow these rules.

---

## 1. Project Overview

A two-container Docker stack that adds a hierarchical dashboard and violation-cache
service on top of an existing [OWASP DependencyTrack](https://dependencytrack.org/)
(DT) deployment.

```
docker-compose.yml
├── dt-dashboard          nginx:alpine — serves dashboard/index.html; reverse-proxies /api/* to DT
└── dt-violation-cache    node:22-alpine — caches violation counts; generates Excel reports
```

---

## 2. Repository Layout

```
dependency-tracker/
├── dashboard/
│   ├── index.html              # Single-file SPA (HTML + CSS + JS, ~3 000 lines)
│   └── nginx.conf.template     # nginx config with envsubst placeholders
├── violation-cache/
│   ├── server.js               # Node.js HTTP service (~1 400 lines)
│   ├── server.test.js          # Unit tests for server helpers (~1 600 lines)
│   ├── dashboard.test.js       # Unit tests for dashboard helpers (~800 lines)
│   ├── package.json            # One dependency: exceljs
│   └── Dockerfile
├── docs/
│   ├── INSTALLATION.md
│   └── DASHBOARD_INTEGRATION.md
├── install.sh                  # Bash installer / uninstaller
├── docker-compose.yml
└── .env.example
```

---

## 3. Technology Choices — Do Not Change Without Discussion

| Layer | Choice | Reason |
|---|---|---|
| Backend HTTP server | Node.js built-in `http`/`https` | Zero external dependencies |
| Excel generation | `exceljs` ^4.4.0 | Permitted external npm package |
| Email delivery | `nodemailer` ^6.10.1 | Permitted external npm package (MIT license) |
| Frontend | Vanilla HTML5 / CSS3 / ES2020+ (no framework) | Zero build step, instant load, no npm |
| Frontend PRNG | Linear congruential generator (hand-rolled) | Deterministic mock data, no import |
| Container | `node:22-alpine` + `nginx:alpine` | Minimal image size |
| Test runner | Node.js built-in `node:test` | No test-framework install required |

**Hard rules:**
- Do **not** add npm packages other than `exceljs` and `nodemailer`.
- Do **not** introduce a frontend framework (React, Vue, Svelte, etc.) or bundler.
- Do **not** add a database; file-based persistence (`/data/*.json`) is intentional.
- Do **not** add a web framework (Express, Fastify, Koa). Use the raw `http` module.

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
| Short loop variables | single letter or 2-char abbreviation | `i`, `p`, `ck` (category key), `sk` (severity key) |
| DT = DependencyTrack | always abbreviate in code comments | `// fetch from DT API` |

### 4.4 Section Dividers

Use the dash-banner style to separate logical sections inside a file:

```javascript
// ── Logging ──────────────────────────────────────────────────────────
```

### 4.5 Decision Markers

Inline comments use lettered prefixes to trace design decisions:

- **Q-numbers** — design/architecture rationale (e.g., `// Q4: tuneable constants at top of file`)
- **P-numbers** — performance optimisations (e.g., `// P4: pre-computed lowercase for search`)
- **O-numbers** — observability notes (e.g., `// O3: JSON log format for log aggregators`)

When adding new logic that involves a non-obvious trade-off, add a new Q/P/O comment.

---

## 5. Backend Service (`violation-cache/server.js`)

### 5.1 File Structure Order

Follow this top-to-bottom order:

1. Tuneable constants (`PAGE_SIZE`, `RETRY_*`, concurrency limits)
2. HTTP keep-alive agents (`http.Agent` / `https.Agent`)
3. `.env` helpers (`parseEnvFile`, `patchEnvFile`, `getEffectiveConfig`)
4. Low-level HTTP fetch helpers (`dtGet`, `dtGetWithRetry`)
5. Cache I/O helpers (read, write, `getStatus`)
6. `runJob()` — violation cache build
7. Report job helpers (semaphore, registry, workbook builder)
8. `runReportJob()` — Excel report build
9. HTTP server and route handlers
10. Startup / boot sequence

### 5.2 HTTP Fetch Helpers

All DT API calls go through `dtGetWithRetry()`:

- 3 attempts maximum.
- Delays: 2 s → 4 s → 8 s (exponential backoff).
- Only retry on network errors and 5xx responses; surface 4xx immediately.

Do **not** add new ad-hoc `fetch`/`https.get` calls outside this helper.

### 5.3 Concurrent Pipelines

The violation cache builds via 9 independent parallel pipelines:
3 risk types (`ops`, `lic`, `secpolicy`) × 3 violation states (`FAIL`, `WARN`, `INFO`).

Pattern:
1. **Phase 1** — fire all pipelines in parallel to get page counts (accurate progress).
2. **Phase 2** — fetch pages 2+ with a `makeSemaphore` to limit concurrent requests.

Preserve this two-phase structure for any new paginated fetch logic.

### 5.4 Semaphore

`makeSemaphore(limit)` is the single concurrency-limiting primitive. Use it whenever
spawning multiple async tasks that hit the external DT API.

```javascript
const sem = makeSemaphore(5);
await sem(() => doWork());
```

### 5.5 File Persistence

| File | Purpose |
|---|---|
| `/data/violation-cache.json` | Cached violation counts with `generatedAt`/`expiresAt` |
| `/data/reports/registry.json` | Report job list (persisted across restarts) |
| `/data/reports/<id>.xlsx` | Generated Excel reports |
| `/data/app-config.json` | User-configurable settings (maxReports, mail, schedule) |
| `/data/scheduled-reports/<id>.xlsx` | Ephemeral Excel files — deleted after email is sent |

**Atomic writes:** always write to a `.tmp` file then `fs.rename()`. Never write
directly to the target path.

```javascript
await fs.promises.writeFile(tmpPath, data);
await fs.promises.rename(tmpPath, targetPath);
```

### 5.6 Logging

Use the `log(level, message, meta)` helper exclusively. Do not use `console.log`
directly.

```javascript
log('info',  'Cache built', { projectCount: 42 });
log('warn',  'Partial failure', { failed: 3 });
log('error', 'Job crashed', { err: e.message });
```

Output format is controlled by `LOG_FORMAT` env variable (`text` or `json`).

### 5.7 HTTP Route Pattern

Each route is a plain `if/else if` block keyed on `method + url`:

```javascript
if (method === 'GET' && path === '/violation-cache/status') {
  jsonReply(res, 200, getStatus());
} else if (...) {
  ...
} else {
  jsonReply(res, 404, { error: 'Not found' });
}
```

Routes must not block the event loop. Long work always runs in a background closure
and returns a job-id immediately (fire-and-forget + polling pattern).

### 5.8 Report Jobs

- Maximum 10 active entries in the registry (completed + in-progress).
- Status transitions: `pending` → `running` → `completed` | `failed`.
- Every transition must call `saveRegistry()`.
- Cancellation uses a `cancelFlag` object (`{ cancelled: false }`) passed by
  reference into `runReportJob()`. Set `cancelFlag.cancelled = true` to stop.
- A 30-minute watchdog resets stale `running` jobs to `failed` on startup.

### 5.9 `.env` Handling

- Parse `.env` with `parseEnvFile()` before every job (not cached in process memory)
  so that UI-updated keys take effect without restart.
- Patch `.env` with `patchEnvFile()` when the `/violation-cache/config` endpoint
  receives a new key. This function must preserve all existing lines verbatim and
  normalise CRLF to LF (Q7).

### 5.10 App Config (`app-config.json`)

User-configurable settings are stored separately from the DT connection `.env`:

- `loadConfig()` reads `/data/app-config.json`, deep-merging with `DEFAULT_CONFIG`.
  Always call `loadConfig()` at the top of any function that needs these values —
  never cache the result in a module-level variable.
- `saveConfig(cfg)` writes atomically via `.tmp` → `rename`.
- `sanitiseConfigForClient(cfg)` masks `smtp.pass` to `'••••••••'` before sending
  to the browser. Never return the raw password in any HTTP response.
- `deepMerge(target, source)` recursively merges objects. Arrays are replaced (not
  concatenated). This ensures new DEFAULT_CONFIG keys are always present even in
  configs saved before a new field was added.

**Schema of `app-config.json`:**

```javascript
{
  maxReports: 10,           // combined ceiling for completed + in-progress report jobs
  mail: {
    enabled: false,         // master switch — all email sending disabled when false
    smtp: { host, port, secure, user, pass },
    from: '',               // envelope From address
    to:   [],               // array of To addresses
    cc:   [],               // array of CC addresses (optional)
    subject: '',            // optional; has a hardcoded default
    body:    '',            // optional body text
  },
  schedule: {
    enabled:             false,
    frequency:           'daily',     // 'daily' | 'weekly' | 'monthly'
    hour:                9,           // 0–23, server local time
    weekDays:            [1],         // 0=Sun..6=Sat; used when frequency='weekly'
    monthDay:            1,           // 1–28; used when frequency='monthly' (capped at 28)
    projectUuids:        [],          // UUIDs stored when user clicks "Schedule Reports"
    riskTypes:           ['security', 'license', 'operational'],
    lastRun:             null,        // ISO8601 timestamp updated after each run
    lastRunStatus:       null,        // 'success' | 'failed'
    lastRunError:        null,        // human-readable error string on failure
    nextRun:             null,        // ISO8601 set by armScheduler()
    failureNotification: null,        // set on failure; cleared when frontend ACKs
  }
}
```

### 5.11 Scheduler

The scheduler is a `setTimeout`-based loop — no cron library required.

- `calcNextRun(schedule)` is a pure function that computes the next fire time from
  the current wall clock. It is the single source of truth for timing logic.
  - `daily`: next occurrence of `schedule.hour` (if already past today, tomorrow)
  - `weekly`: scans next 8 days for a matching `weekDays` entry
  - `monthly`: `schedule.monthDay` capped at 28; rolls to next month if already past
- `armScheduler()` clears any pending timer, calls `calcNextRun`, writes `nextRun`
  to config, then sets a `setTimeout` for that many milliseconds.
- `runScheduledJob()` is called by the timer, sets `_schedulerRunning = true` for
  overlap protection, collects data via `collectReportData()`, builds the workbook,
  emails it, deletes the scheduled-reports file, and updates `lastRun` / `lastRunStatus`.
- Re-arm is always called from `armScheduler()` after `runScheduledJob()` completes.
- On failure: the error is written to `schedule.failureNotification` so the dashboard
  can show a toast on the next page load. The frontend ACKs via `POST /violation-cache/schedule/ack-notification`.

### 5.12 Email (`nodemailer`)

- `sendEmail(mailCfg, attachPath, attachName, overrides)` creates a transporter
  using `mailCfg.smtp`, sends with the configured from/to/cc/subject/body, and
  attaches the Excel file at `attachPath`.
- Use `overrides` to send failure-alert emails with a different subject/body.
- The `POST /violation-cache/config/test-email` route sends a test email without
  an attachment to verify SMTP connectivity.
- The SMTP password placeholder `'••••••••'` (sent by the frontend when the password
  field was not changed) must be detected in the POST handler and discarded so the
  real stored password is not overwritten.

---

## 6. Frontend Dashboard (`dashboard/index.html`)

### 6.1 Single-File Architecture

All code lives in one HTML file. Do **not** split into multiple JS/CSS files — the
no-build-step constraint requires this.

Structure inside the file:

```
<style>   — CSS custom properties + all rules
<body>    — semantic HTML (header, main, modals)
<script>  — IIFE wrapping all state and logic
```

### 6.2 IIFE + Window Exports

All JavaScript is wrapped in an immediately-invoked function expression to avoid
polluting the global scope. `onclick=""` handlers in HTML call functions exposed
through `window.*` exports at the bottom of the IIFE.

```javascript
(function () {
  // ... all state and functions ...

  window.toggleTheme   = toggleTheme;
  window.applyFilters  = applyFilters;
  // etc.
})();
```

### 6.3 State Management

Flat, module-scoped globals (no reactive framework):

| Variable | Type | Role |
|---|---|---|
| `allProjects` | `Project[]` | Single source of truth |
| `filtered` | `Project[]` | Current filter result |
| `treeRoots` | `TreeNode[]` | Rendered hierarchy |
| `nodeMap` | `Map<uuid, TreeNode>` | Fast UUID lookup |
| `expandedUuids` | `Set<uuid>` | Open group rows |
| `selectedVersions` | `Set<string>` | Multi-select filter |
| `summaryTotals` | object | Computed once after load |
| `flatView` | boolean | Hierarchy vs flat toggle |
| `selectedProjectUuids` | `Set<uuid>` | Checkbox-selected for report |
| `_configPanelDirty` | boolean | Unsaved changes in config panel |
| `_appConfig` | object\|null | Last fetched app-config from server |

Never mutate `allProjects` after initial load. Derive everything else from it.

### 6.4 Data Model

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

### 6.5 Tree Building Rules

- `buildTree(projects)` converts the flat `allProjects` array into a hierarchy using
  `parentUuid` links.
- `inferParentUuids(projects)` runs before `buildTree` to assign `parentUuid` when
  DT doesn't supply it (name-match fallback).
- Siblings are sorted alphabetically.
- Aggregate parent rows show summed risk counts from all descendants.

### 6.6 Filtering

`applyFilters()` always operates on `allProjects` (never on a previous filter result).

Active filters:

| Filter | Logic |
|---|---|
| Text search | substring, case-insensitive, min 2 chars, uses `_nameLower` |
| Risk level | `has-critical`, `has-high`, etc. |
| Category | security / operations / license / secpolicy |
| Tags | AND logic (all selected tags must be present) |
| Versions | OR logic (any selected version matches) |
| Level | exact hierarchy depth |
| Latest-only | `isLatest === true` + full ancestor chain is shown |

Auto-include parent rows when a child matches (to maintain hierarchy context).

### 6.7 Mock Data Generator

`generateMockProjects()` uses `makeLCG(seed)` (Q6) so that the same seed always
produces the same mock data. Do **not** replace this with `Math.random()`.

### 6.8 Performance Conventions

- `_nameLower` — computed once per project on data load; reuse for every search.
- Search input is debounced at `SEARCH_DEBOUNCE_MS` (200 ms).
- `throttle(fn, ms)` for high-frequency UI events (window resize, etc.).
- `inferSuffix(name, version)` strips trailing version using char-level scan, not
  regex (P3).

### 6.9 CSS Conventions

- Theme is driven by CSS custom properties defined on `:root` (dark) and overridden
  inside `.light` class on `<body>`.
- Severity colours are defined as variables: `--color-critical`, `--color-high`, etc.
- Accent colour: `--accent: #6366f1` (indigo-500).
- Do not hard-code colour hex values inside component rules; always use a variable.
- Responsive breakpoints: 1200 px → 900 px → 768 px.

### 6.10 Utility Helpers (do not duplicate)

| Helper | Location | Purpose |
|---|---|---|
| `makeLCG(seed)` | dashboard | Seeded PRNG |
| `pillFor(n, level)` | dashboard | Severity badge HTML |
| `toast(text, level)` | dashboard | Notification pop-up |
| `throttle(fn, ms)` | dashboard | Rate-limit wrapper |
| `inferSuffix(name, ver)` | dashboard | Strip version from name |
| `openConfigPanel()` | dashboard | Open left-side config overlay |
| `closeConfigPanel(force)` | dashboard | Close overlay; prompts if dirty |
| `scheduleReports()` | dashboard | Save selected UUIDs and schedule |
| `makeSemaphore(limit)` | server | Promise concurrency limit |
| `sleep(ms)` | server | Promise delay |
| `dtGetWithRetry(...)` | server | Resilient DT API fetch |
| `log(level, msg, meta)` | server | Structured logger |
| `deepMerge(target, source)` | server | Recursive object merge (preserves defaults) |
| `loadConfig()` | server | Read app-config.json merged with defaults |
| `saveConfig(cfg)` | server | Atomically write app-config.json |
| `sanitiseConfigForClient(cfg)` | server | Mask smtp.pass before HTTP response |
| `calcNextRun(schedule)` | server | Pure function: compute next fire time |
| `armScheduler()` | server | Set up (or re-arm) the scheduled-report timer |
| `collectReportData(...)` | server | Shared data-collection core for both manual and scheduled reports |
| `sendEmail(mailCfg, ...)` | server | Deliver Excel report via nodemailer |

---

## 7. Infrastructure

### 7.1 nginx Config Template

`dashboard/nginx.conf.template` uses `envsubst` placeholders (`${VAR_NAME}`).

Key routing decisions:
- `/api/*` → DT API server (upstream resolved at request time — not at startup — to
  tolerate startup ordering).
- `/violation-cache/*` → `dt-violation-cache:3001`.
- `/dt-config` — inline JSON block exposing proxy target and optional API key.
- SPA routing: `try_files $uri $uri/ /index.html`.

### 7.2 docker-compose.yml Conventions

- Service names: `dt-dashboard`, `dt-violation-cache`.
- Expose only the port declared in `.env` (`DT_DASHBOARD_PORT`).
- Both services declare `healthcheck` — do not remove.
- The `.env` file is **bind-mounted** into `dt-violation-cache` so config updates
  survive without a restart.
- Volume `violation-cache-data` persists `/data` between restarts.

### 7.3 Dockerfile

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
RUN mkdir -p /data
EXPOSE 3001
CMD ["node", "server.js"]
```

Do not add a package-lock.json copy step before `npm install` unless you intend to
lock versions (currently not locked in production image).

---

## 8. Testing

### 8.1 Test Runner

```bash
node --test violation-cache/server.test.js
node --test violation-cache/dashboard.test.js
```

No npm test script is defined. Run directly with `node --test`.

### 8.2 Test File Conventions

- Tests for `server.js` helpers live in `server.test.js`.
- Tests for `dashboard/index.html` JS helpers live in `dashboard.test.js`.
- **Do not import `server.js`** inside `server.test.js` — doing so would start the
  HTTP server. Duplicate the helper functions under test instead.
- Use `node:assert/strict` for all assertions.
- Use `node:test` (`test()`, `describe()`, `beforeEach()`, `afterEach()`).
- Create temp files with a helper that tracks paths for cleanup in `afterEach`.
- Mock HTTP request streams with `Readable` from `node:stream`.

### 8.3 What to Test

- All `.env` parsing edge cases: CRLF, quoted values, comment lines, missing `=`,
  duplicate keys.
- PRNG: seed determinism, output range, edge seed values.
- Pure utility functions: `inferSuffix`, `pillFor`, `truncateUrl`.
- App config helpers: `deepMerge` (nested merge, array replace, no mutation),
  `loadConfig`/`saveConfig` round-trips, `sanitiseConfigForClient` (password masking).
- `calcNextRun` for all three frequencies: result is always in the future, correct
  day/hour, within expected range.
- Do **not** write integration tests that require a live DT API or Docker.

---

## 9. Error Handling

### 9.1 Backend

- Return typed error objects: `{ code: 'SYMBOLIC_NAME', cause: originalError }`.
- HTTP status codes: 400 (bad request), 401 (missing/invalid key), 409 (conflict —
  job already running), 429 (rate limit), 500 (internal).
- Wrap async route handlers with a top-level `try/catch` that replies `500`.
- Never let an unhandled rejection crash the process; attach to the job's `failed`
  state instead.

### 9.2 Frontend

- Use `toast(message, 'error')` for user-visible errors.
- Mark per-project failures with `_incomplete: true`; surface a banner warning.
- Never swallow errors silently — at minimum `log` them in the browser console.
- Graceful degradation: if the DT API is unreachable, show mock data with a clear
  "using demo data" notice.

---

## 10. Security Considerations

- The API key is stored in browser `localStorage` (`dt_api_key`) and sent as an
  `X-Api-Key` header. Do not log it verbatim — redact to `****` in log output.
- CORS is globally open (`Access-Control-Allow-Origin: *`) — this is intentional for
  the private-network deployment model. Do not tighten it without understanding the
  iframe-embedding use case.
- `readBody()` enforces a 64 KB limit on request bodies. Do not raise this without
  justification.
- The `.env` file is bind-mounted read/write. `patchEnvFile()` must validate that
  the supplied API key contains no shell-injection characters before writing.

---

## 11. Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `DT_DASHBOARD_PORT` | compose / nginx | External port for the dashboard |
| `DT_API_INTERNAL_URL` | nginx / server | DT API base URL (container-internal) |
| `DT_API_KEY` | nginx / server | DT API key |
| `DT_FRONTEND_URL` | nginx | DT UI URL for deep links |
| `VIOLATION_CACHE_TTL_HOURS` | server | Cache expiry in hours (default 24) |
| `PORT` | server | Cache service listen port (default 3001) |
| `REPORT_CONCURRENCY` | server | Max parallel project fetches in reports (default 5) |
| `VIOLATION_CONCURRENCY` | server | Max parallel violation fetches per project (default 3) |
| `LOG_FORMAT` | server | `text` (default) or `json` |

---

## 12. Git & Branch Workflow

- Active development branch: `claude/loving-goodall-Ig9hm`.
- Commit messages: imperative mood, concise first line, no emoji.
- Do not push directly to `main`/`master`.
- Always `git push -u origin <branch>`.

---

## 13. Adding New Features — Checklist

Before opening a PR with new functionality:

- [ ] No new npm packages introduced (or explicitly approved — currently `exceljs` and `nodemailer`).
- [ ] Backend: new routes follow the `if/else if` routing pattern.
- [ ] Backend: any new paginated fetch uses `dtGetWithRetry` + semaphore.
- [ ] Backend: file writes are atomic (write-tmp → rename).
- [ ] Backend: `sanitiseConfigForClient()` used before returning any config object.
- [ ] Backend: SMTP password placeholder `'••••••••'` detected and discarded in config POST handler.
- [ ] Frontend: state stays in module-scoped globals; no external state library.
- [ ] Frontend: new HTML event handlers are window-exported from the IIFE.
- [ ] Frontend: new colours use CSS custom properties, not hard-coded hex.
- [ ] Frontend: config panel always reads from `loadConfigFromServer()` on open.
- [ ] Tests added for any new pure helper functions.
- [ ] `log()` used for all server-side output (not bare `console.log`).
- [ ] Error responses use `jsonReply(res, <status>, { error: '...' })`.
- [ ] `.env.example` updated if new environment variables are introduced.
- [ ] `docs/` updated if user-visible behaviour changes.
