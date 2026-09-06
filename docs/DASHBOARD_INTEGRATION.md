# Custom Risk Dashboard — Integration Guide

## Table of Contents
1. [Overview](#1-overview)
2. [Dashboard Features](#2-dashboard-features)
3. [Connecting to Live Data](#3-connecting-to-live-data)
4. [Generating an API Key](#4-generating-an-api-key)
5. [Violation Cache](#5-violation-cache)
5a. [Customization (administrator)](#5a-customization-administrator)
6. [Data Mapping Reference](#6-data-mapping-reference)
7. [Filtering and Exporting](#7-filtering-and-exporting)
8. [Vulnerability Reports](#8-vulnerability-reports)
9. [Email & Scheduled Reports](#9-email--scheduled-reports)
10. [Customising the Dashboard](#10-customising-the-dashboard)
11. [Embedding in Another Application](#11-embedding-in-another-application)

---

## 1. Overview

The custom risk dashboard is a **standalone, single-file HTML application**
served by an nginx container on port `3000`. It provides:

- A filterable **hierarchical tree view** mirroring the DependencyTrack
  parent/child project structure
- **Expand/collapse** per group row — each row always shows its own API-returned
  counts; collapsing a group hides its children but does not change the parent's numbers
- **Single Expand All / Collapse All toggle button** that dynamically switches label
  based on the current state of the tree
- **Tag filtering** — filter by project tags with a multi-select dropdown
- **Level filtering** — filter by hierarchy depth
- **CSV export** — exports all matching projects regardless of fold state, with a
  Type column (Group / Project)
- **KPI summary cards** for total Critical, High, Medium, Low counts
- **Project hyperlinks** — when the DT Frontend URL is set, project names link
  directly to that project in the DependencyTrack UI
- **Two data modes**:
  - **Mock mode** (default) — a realistic hierarchical project tree for immediate preview
  - **Live mode** — pulls real data from your DependencyTrack API

### How network calls work

Every call the dashboard makes goes to its own origin with a
`Authorization: Bearer <session token>` header:

| Path | Handled by | Notes |
|------|-----------|-------|
| `/auth/*`, `/profile` | backend | Registration, sign-in, session, profile |
| `/violation-cache/*` | backend | Configuration, reports, schedule, cache |
| `/violation-cache/dt/api/v1/…` | backend → DependencyTrack | The backend attaches **your** stored API key and forwards the request |

The browser holds no DependencyTrack credentials: no `X-Api-Key` header is ever sent
and no key is kept in `localStorage`. CORS on DependencyTrack is irrelevant, because
the browser never talks to it.

---

## 2. Dashboard Features

### Hierarchical Tree View

Projects are fetched using a **BFS (breadth-first) traversal** of the
DependencyTrack project hierarchy:

1. Root projects via `GET /api/v1/project?onlyRoot=true`
2. Children via `GET /api/v1/project/{uuid}/children` — repeated level by level
3. Each level is batched in parallel until no further children remain

```
▶ Retail                            (collapsed group)
▼ Commerce Suite                    (expanded group)
    ▶ commerce-be                   (collapsed sub-group)
    ▼ Commerce.Containers           (expanded sub-group)
          commerce-be v1.4.1        (leaf project)
          commerce-be v1.3.0        (leaf project)
```

Every row — group or leaf — displays counts **exactly as returned by the DependencyTrack API**. No child-aggregation is performed in the dashboard.

### Risk Matrix Columns

| Column | Sub-columns | Source |
|--------|-------------|--------|
| Project / Version | — | `name`, `version`, `tags` |
| Lvl | — | Computed from parent chain depth |
| Latest | — | `isLatest` field from DT API |
| Security Risk | Critical · High · Medium · Low · Unassigned | DT vulnerability CVSS severities (embedded in project response) |
| Operational Risk | Fail · Warn · Info | Policy violations — from violation cache service |
| License Risk | Fail · Warn · Info | Policy violations — from violation cache service |

### Colour coding

| Severity | Colour |
|----------|--------|
| Critical / Fail | Red |
| High / Warn | Orange |
| Medium / Info | Yellow |
| Low / Unassigned | Blue |
| Zero (—) | Grey |

> **Note:** Operational and License counts come from the DependencyTrack **Policy Engine**. They will always be zero until you configure policies in DependencyTrack (Administration → Policy Management).

### KPI Cards

Summary cards show **fixed totals computed once** immediately after data loads:

- **Critical** = Security Critical + Operational Fail + License Fail
- **High** = Security High + Operational Warn + License Warn
- **Medium** = Security Medium + Operational Info + License Info
- **Low** = Security Low + Security Unassigned
- **Clean** = Projects with no risk across any category

Cards are clickable — clicking sets the risk-level filter on the table but does not change the card values.

### Project Hyperlinks

Set the **DT Frontend URL** in **⚙ Settings** to enable clickable project links. Each project name becomes a link to `<DT_FRONTEND_URL>/#/projects/<uuid>`.

---

## 3. Connecting to Live Data

The connection belongs to your account, so it is configured in the dashboard — not
in `.env` and not by the installer.

1. Open the dashboard (default: http://localhost:3000) and sign in
2. Click **⚙ Settings** in the top-right header
3. In the **Connection** section:
   - **DT API URL** — your DependencyTrack API server, e.g. `https://dtrack.company.com`
   - *(Optional)* **DT Frontend URL** — enables clickable project links
   - **API Key** — your DependencyTrack API key
4. Click **Test Connection** to check it, then **Connect**

The key is encrypted with `SECRET_ENCRYPTION_KEY` before it is written, and is never
returned in any response. The field shows blank on every later visit with a
"✓ API key configured" note; leave it blank to keep the stored key, or type a new one
to replace it.

Two users who enter the same URL and key share one violation-cache build, so adding
users does not multiply the load on DependencyTrack.

```bash
# Only needed after changing infrastructure settings in .env
docker compose --env-file .env up -d
```

### Settings panel — Connection fields

| Field | Required | Description |
|-------|----------|-------------|
| DT API URL | No | URL the **browser** uses to reach DT API directly. Leave blank to route via nginx proxy (recommended). |
| DT Frontend URL | No | URL for the DT web UI. Used only for project hyperlinks. Saved in browser `localStorage`. |
| API Key | Yes | DependencyTrack API key (masked). Persisted to the server `.env` file. |

---

## 4. Generating an API Key

API keys are associated with **Teams** in DependencyTrack.

### Via UI

1. Log in to your DependencyTrack UI as `admin`
2. Go to **Administration → Access Management → Teams**
3. Click **Automation** (or any team)
4. Scroll to **API Keys** → **+ Generate API Key**
5. Copy the key immediately — it cannot be retrieved again

### Minimum required permissions

The dashboard only reads data. Assign these permissions to the team:

| Permission | Required? |
|------------|-----------|
| `VIEW_PORTFOLIO` | ✅ Yes |
| `VIEW_VULNERABILITY` | ✅ Yes |
| All others | ❌ No |

---

## 5. Violation Cache

Policy violation counts (Operational and License columns) are served by the
**`dt-violation-cache`** service rather than fetched directly by the browser.

### Why a cache service?

The DependencyTrack `/api/v1/violation` endpoint returns full violation objects.
Fetching all violations in the browser on every page load transfers large payloads
and takes a long time. The cache service runs the fetch server-side, stores a
compact per-project count map in a JSON file, and serves only that file to the browser.

### Cache lifecycle

| Dashboard status | Meaning | What happens |
|-----------------|---------|--------------|
| ⏳ Building violation cache… | Job is running | Dashboard polls every 5 s; shows `X/Y pages` progress |
| Violations from cache (built Xh ago) | Cache is fresh | Counts load instantly on page open |
| ⚠ Violation cache expired (Xh old) — refreshing… | TTL passed | Stale counts shown immediately; background rebuild starts |
| ⚠ Violation cache service unreachable | Service not running | Operational/License columns show zero |

### Cache endpoints (available at `/violation-cache/`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/violation-cache/status` | GET | `{status, progress: {pagesDone, pagesTotal}}` |
| `/violation-cache/data` | GET | The cached map `{uuid: {ops, lic, secpolicy}}`, served gzipped. Build metadata comes from `/status` |
| `/violation-cache/refresh` | POST | Trigger a background rebuild (409 if already running) |

### Manual operations

All backend routes require a bearer token; the examples below assume `$TOKEN` holds
one (read it from `localStorage.dt_session_token` in the browser console).

```bash
# Check cache status
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/violation-cache/status

# Trigger a rebuild
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/violation-cache/refresh

# Discard every cached build (they rebuild on next page load)
docker exec dt-postgres psql -U dtdash -d dtdash -c 'DELETE FROM violation_caches;'
```

### TTL and rebuild

- Default TTL: **24 hours** (configurable via `VIOLATION_CACHE_TTL_HOURS` in `.env`)
- **There is no time limit on a refetch.** A large portfolio takes as long as it
  takes. What is bounded is *silence*: if a build does not finish a single page
  within `VIOLATION_JOB_STALL_MINUTES` (default 15) it is presumed wedged and
  stopped, with an error naming how far it got. Raise that value if your
  DependencyTrack can legitimately take longer than this to return one page.
- **A refetch interrupted by a restart recovers by itself.** The service marks
  builds orphaned by a restart as failed during boot, and a build that stops
  reporting progress is treated the same way once the stall window passes. Either
  way the next dashboard load starts a fresh crawl — there is nothing to clean up
  by hand, and no need to delete rows from `violation_caches`.
- **Your filters survive a refetch.** A search term, tag, risk level, category,
  Latest Only or Flat View chosen while a refetch is in flight is still applied
  when it finishes, and is re-evaluated against the counts that just arrived —
  so a "has failures" filter shows what actually has failures now, not what did
  before the data existed.
- **The filter controls are inert until the table has loaded.** On first open
  they stay disabled while the banner reads "Connecting…", because a filter
  applied to an empty table would be discarded by the first render.
- **The ↻ Refetch Violations button is disabled while a build is running**, and
  not only for the person who started it. The cache is shared by connection
  fingerprint, so everyone pointing at the same DependencyTrack instance sees the
  control greyed out with a progress count until that one build finishes. This is
  the visible half of the shared-cache design: without it, five people on one
  connection would each keep asking for a crawl the first of them is already
  waiting on. The server refuses the duplicates anyway — the advisory lock elects
  a single builder and a second request answers 409 — but a button that looks
  live and does nothing is worse than one that shows why it is inert.
- On page load: if no cache row exists for your connection, a rebuild starts automatically.
  `pg_try_advisory_lock` elects exactly one builder, so simultaneous visitors trigger
  one crawl between them, not one each
- On page load: if cache is stale, the old data is shown immediately while a rebuild runs in the background
- The banner **↻ Refresh** button triggers a violation-only rebuild without re-fetching projects

---

## 5a. Customization (administrator)

**🛡 Administration → Customization.** Both settings are service-wide: everyone
sees them, from the next page load onward.

### Application title

Appears in the browser tab, the sign-in card, the dashboard header and footer,
the administration header, the Excel workbook's *creator* property, and the
default subject and body of scheduled-report emails.

- Up to 60 characters. Control characters are refused; everything else that
  displays sensibly is allowed.
- **Leave it blank to restore the built-in default**,
  `Software Composition Analysis - Risk Dashboard`. There is no separate "use
  default" switch — an empty field *is* the default.
- The square logo mark beside it is derived from the title: up to three initials,
  so `Acme Supply Chain Portal` shows `ASC`. Nothing to upload or maintain.

### Sign-in background

By default the sign-in page shows an animated background — indigo for users,
amber for the administrator. Upload an image and **it replaces both** for
everyone; remove it and the animated pair returns.

| Rule | Value |
|---|---|
| Formats | PNG, JPEG, WebP |
| Maximum file size | 5 MB |
| Minimum resolution | 1280 × 720 |
| Maximum resolution | 5000 × 5000 |

- **SVG is not accepted.** It is XML that can carry script, and this image is
  served to visitors who have not signed in yet.
- The format is decided by the file's own bytes, not by its extension or the
  `Content-Type` a browser sends — renaming `logo.svg` to `logo.png` does not
  get it past the check.
- There is **no minimum file size**. A small file that is a real image at an
  acceptable resolution is fine.
- A resolution floor exists because the image is stretched to cover the page,
  and anything smaller renders visibly blurred.
- The image is stored in the database and served with a version stamp derived
  from its own content, so a browser downloads it **once** and re-reads it from
  cache on every later sign-in. Replacing the image changes the stamp and every
  browser picks up the new one.

Removing the background takes two clicks — the button asks for confirmation
before it acts, because it changes what every user sees.

### Administration endpoints

Administrator only; every other principal gets **403**. The screen itself is
`/admin.html`, which redirects an ordinary signed-in user back to the dashboard
rather than showing them a page whose every request would fail.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/overview` | GET | Service-wide totals: accounts, sessions, reports, storage, caches, schedules |
| `/admin/users` | GET | Every account with its counts and effective limits |
| `/admin/users/:loginId` | GET | One account's detail |
| `/admin/storage` | GET | Filesystem headroom and database size |
| `/admin/settings` | GET | The service-wide defaults |
| `/admin/settings` | PUT | Set the default report and/or schedule limits |
| `/admin/users/:loginId/settings` | PUT | One account's limits; `null` returns either to the default |
| `/admin/users/:loginId/password` | POST | Reset one account's password |
| `/admin/branding` | GET/PUT | Read or set the application title; empty restores the default |
| `/admin/branding/background` | POST/DELETE | Upload or remove the sign-in background |

**Those six writes are the complete list**, and deliberately so: a test asserts
exactly they are handled and that every other method/path combination is not, so
adding a seventh means editing an allow-list in a diff somebody reads
(CLAUDE.md §7.6).

Reading is bounded too. No administration route returns anybody's
DependencyTrack API key, SMTP password or report contents — presence is
reported, values never are.

**A password reset is the most privileged action in the service**, because the
administrator chooses a value that authenticates as somebody else. Three things
bound it: the account's sessions are revoked so the person is signed out rather
than silently followed; `must_change_password` is set, and dispatch then refuses
every route except `/auth/set-password`, `/auth/logout` and `/auth/me`, so the
typed password can only ever be spent replacing itself; and the reset is written
to `login_audit` in the same transaction as the password change.

### Public branding endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/branding` | GET | The application title and whether a background is set |
| `/branding/background` | GET | The background image bytes |

These two are **unauthenticated by design** — the sign-in page reads them before
a token exists, and branding on a sign-in screen is public by construction:
anyone who can reach the page can already see it. They return the title and the
image and nothing else: no account, no setting, no count.

---

## 6. Data Mapping Reference

### API Endpoints Used

| Section | Endpoint | Purpose |
|---------|----------|---------|
| Hierarchy (roots) | `GET /violation-cache/dt/api/v1/project?onlyRoot=true` | All root-level projects (paginated), proxied with your stored key |
| Hierarchy (children) | `GET /violation-cache/dt/api/v1/project/{uuid}/children` | Children per project (paginated) |
| Config | `GET /violation-cache/config` | Your connection (never the key), settings, mail and schedule |
| Violation cache | `GET /violation-cache/status` | Cache state and build progress |
| Violation cache | `GET /violation-cache/data` | Cached per-project violation counts |

### Project fields

| Dashboard Field | API Field | Notes |
|----------------|-----------|-------|
| Project name | `name` | |
| Version | `version` | |
| Hierarchy level | `parent.uuid` | Stamped during BFS fetch |
| Tags | `tags[].name` | Flattened to string array |
| Latest | `isLatest` | `true` when DT marks this as the latest version |

### Security Risk (from embedded project metrics)

| Dashboard Column | API Field | Description |
|----------------|-----------|-------------|
| Critical | `critical` | CVSS ≥ 9.0 |
| High | `high` | CVSS 7.0–8.9 |
| Medium | `medium` | CVSS 4.0–6.9 |
| Low | `low` | CVSS 0.1–3.9 |
| Unassigned | `unassigned` | No CVSS score |

### Operational & License Risk (from violation cache)

| Dashboard Column | Cache Field | Description |
|----------------|-------------|-------------|
| Operational Fail | `ops.fail` | Count of `riskType=OPERATIONAL&violationState=FAIL` violations |
| Operational Warn | `ops.warn` | Count of `riskType=OPERATIONAL&violationState=WARN` violations |
| Operational Info | `ops.info` | Count of `riskType=OPERATIONAL&violationState=INFO` violations |
| License Fail | `lic.fail` | Count of `riskType=LICENSE&violationState=FAIL` violations |
| License Warn | `lic.warn` | Count of `riskType=LICENSE&violationState=WARN` violations |
| License Info | `lic.info` | Count of `riskType=LICENSE&violationState=INFO` violations |

---

## 7. Filtering and Exporting

### Available filters

| Filter | Type | Behaviour |
|--------|------|-----------|
| Search box | Text | Substring match on project name |
| Risk level | Single-select | Projects whose own data contains the selected severity |
| Category | Single-select | Narrow to Security, Operational, or License |
| Level | Single-select | Projects at the selected hierarchy depth |
| Tags | Multi-select | Projects that have ALL selected tags (AND logic) |
| ★ Latest Only | Toggle | `isLatest = true` projects + their full ancestor chain |

All filters combine with AND logic. When a filter matches a child, its ancestor group rows are shown automatically.

### Exporting to CSV

1. Apply any filters
2. Click **↓ Export CSV**
3. Browser downloads `dependency-track-YYYY-MM-DD.csv`

CSV exports **all matching projects regardless of fold state**. Column layout:

```
Project, Version, Level, Tags, Type, Latest,
Security Critical, Security High, Security Medium, Security Low, Security Unassigned,
Operational Fail, Operational Warn, Operational Info,
License Fail, License Warn, License Info
```

---

## 8. Vulnerability Reports

### Generating a report

1. *(Optional)* Select specific projects using the checkboxes in the table. If no projects are checked, all currently visible projects are included.
2. Click **📋 Generate Report** in the toolbar.
3. Choose which risk categories to include (Security, License, Operational).
4. *(Optional)* Give the report a name. Leave it blank and one is generated —
   `vulnerability_report_<timestamp>.xlsx`, exactly as before the field existed.
5. A background job is started. Monitor progress in **📥 Reports** (top-right button).
   The name you chose is shown there while the job runs, not only when it finishes.
6. When the report is `completed`, click **↓ Download** to save the Excel file.

Nothing but the limit below stands in the way: generating a second report on the
same day, or while another is still running, needs no confirmation.

### Naming a report

A name may use letters, numbers, spaces and `. _ - ( )`. It becomes the
filename, so anything that would break it — quotes, slashes, control characters
— is refused rather than silently rewritten. `.xlsx` is added if you do not type
it. Up to 120 characters.

A **scheduled** report is named the same way, from **⚙ Settings → Schedule →
Report name**. That name is used on every run; clear the field to go back to the
generated `scheduled_report_<timestamp>.xlsx` form.

### What is in the workbook

A sheet is added only for the risk categories you selected.

| Risk category | Sheets |
|---|---|
| Security | `SV_Vulnerability Findings`, `SV_Project Summary`, `SV_Component Summary`, `SV_CWE Summary` |
| License | `LR_Violations`, `LR_Project Summary` |
| Operational | `OR_Violations`, `OR_Project Summary` |

**`SV_CWE Summary`** has one row per unique **vulnerability + CWE** pair taken
from `SV_Vulnerability Findings`: S.No, Vulnerability, CWE, Vulnerability Count,
Affected Projects, CVE Reference and CWE Reference. Rows run most-frequent
first.

Three things are worth knowing about how it counts:

- A finding DependencyTrack mapped to **several** CWEs stays on **one** row
  (`CWE-20, CWE-79`) rather than being counted once per weakness, so the
  Vulnerability Count column adds up to the number of rows in
  `SV_Vulnerability Findings`.
- A finding with **no** CWE mapping still gets a row, with the CWE cell blank —
  the summary accounts for every finding rather than dropping the unmapped ones.
- The reference columns are derived from the identifier itself
  (`nvd.nist.gov` for `CVE-…`, `github.com/advisories` for `GHSA-…`,
  `osv.dev` for `OSV-/GO-/PYSEC-/RUSTSEC-…`, `security.snyk.io` for `SNYK-…`,
  and `cwe.mitre.org` for the CWE). An identifier with no known advisory site —
  an internal vulnerability, for instance — leaves the cell blank rather than
  carrying a link that would 404.

This sheet costs **no additional DependencyTrack API call**: the CWE list and
the vulnerability id both arrive in the `/api/v1/finding` response the report
already fetches.

### Report limits

The maximum number of active reports (completed + in-progress) is set by your
administrator — globally, or for one account — from the 🛡 Administration
screen. **⚙ Settings** shows the number that applies to you but cannot change
it. When the limit is reached, new reports cannot be created until old ones are
deleted; nothing is ever deleted for you.

### Report endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /violation-cache/report/generate` | POST | Start a report job. Optional `reportName`; returns `{id, filename}` |
| `GET /violation-cache/report/list` | GET | List all jobs with status and progress |
| `GET /violation-cache/report/:id/download` | GET | Stream the completed Excel file |
| `DELETE /violation-cache/report/:id` | DELETE | Delete job and file |
| `POST /violation-cache/report/:id/cancel` | POST | Request cancellation of a running job |

---

## 9. Email & Scheduled Reports

### SMTP settings — TLS and the port

The **TLS** checkbox and the port must agree. Getting this wrong is the most
common failure, and the underlying error message is misleading:

| Port | TLS checkbox | What happens |
|---|---|---|
| 465 | **ticked** | Implicit TLS (SMTPS) — encrypted from the first byte |
| 25 or 587 | **clear** | Plaintext connect, then **STARTTLS** upgrade if the server offers it |

Clearing the checkbox on port 25 or 587 does **not** give up encryption — the
connection still upgrades via STARTTLS automatically. Tick it only for a port
that expects TLS immediately.

If you tick TLS against a plaintext port, the mail server answers with its
ordinary SMTP greeting, the TLS library tries to read that text as an encrypted
record, and reports `wrong version number`. That sounds like a TLS *version*
mismatch; it means "this is not TLS at all". The dashboard now translates it:

> mail.example.com:25 is not using TLS on this port. Clear the TLS checkbox —
> the connection still upgrades with STARTTLS if the server offers it.

Other failures are named the same way: an unresolvable host, a refused
connection, a timeout (usually a firewall), rejected credentials, an untrusted
internal certificate, and a rejected From/To address. The raw message is kept in
the response's `detail` field for anyone diagnosing it further.

**Authentication is optional.** Leave the username and password blank for an
internal relay that accepts mail without them — no authentication is attempted
at all, rather than an empty username being offered.

Automatic email delivery of Excel reports on a recurring schedule. **An account
may have several**, each with its own projects, timing, risk categories and
recipients — a weekly operational report to one team and a monthly licence
report to another.

### Account-level mail settings

These describe the one mail server your account signs in to, and are shared by
every schedule you own:

1. Open **⚙ Settings**
2. Enable **Email & Scheduled Reports**
3. Fill in the SMTP connection:
   - **Host** — your SMTP server (e.g. `smtp.gmail.com`)
   - **Port** — typically `587` (STARTTLS) or `465` (implicit TLS)
   - **TLS** — tick only for an implicit-TLS port, usually 465. On 587 leave it
     clear; the connection still upgrades with STARTTLS if the server offers it
   - **Username / Password** — optional. Leave both blank for an unauthenticated
     relay. The password is stored server-side and never returned to a browser
4. Fill in **From**, and the default **To**, **CC** and **Subject**
5. Click **Send Test Email** to verify the connection

### Creating a schedule

1. In the dashboard, select the projects you want (checkboxes, or leave none
   selected to take everything currently visible)
2. Click **📅 Schedule Reports** in the toolbar
3. The settings panel opens on the schedule editor. Set:
   - **Name** — how it appears in your list (optional)
   - **Frequency** — Daily, Weekly or Monthly
   - **Send at** — a time in **your own browser's timezone**. The line beneath
     shows what will be stored, e.g. `Stored as 03:30 UTC`
   - Days of the week, or a day of the month (1–28)
   - **Risk categories** to include
   - **Report file name** — optional; blank keeps the generated
     `scheduled_report_<timestamp>.xlsx` form
   - **Delivery** — To, CC and Subject for *this* schedule. Leave blank to use
     the account defaults; the placeholder shows what blank will actually use
4. **Save schedule**

### Timezones

The time you pick is **your browser's local time**, converted on the way in and
out. The container's clock is not an input: schedules are stored as UTC instants
and the scheduler reads them with UTC accessors only.

An offset can move the **day** as well as the clock — 06:00 UTC on Monday is
Sunday evening in Los Angeles — so the weekday set is converted with it. Offsets
are not always whole hours either (India is UTC+05:30, Nepal +05:45), which is
why the stored time carries minutes.

> A schedule is stored as a fixed UTC instant, so it shifts by an hour in local
> terms when daylight saving starts or ends. Regions without DST are unaffected.
> The hint under the picker always states what is really stored.

### Managing schedules

The Settings panel lists every schedule with its timing, project count,
recipients, next run and last result. From the list:

- **The toggle** pauses or resumes one immediately, with no save step. Pausing
  keeps everything and simply stops it firing.
- **Clicking a row** opens it for editing. One is open at a time; Back, Discard
  and closing the panel all ask before dropping unsaved changes.
- **Cancel All** removes every schedule you own.

Inside a schedule:

- **Send now** builds and sends immediately. It does **not** move the timetable
  — a Monday 09:00 schedule stays Monday 09:00 — and it waits if another of your
  reports is already running rather than starting a second one. It works on a
  paused schedule, which is most of the point of pausing rather than cancelling.
- **Runs** shows the totals and the last five runs, over the 90-day retention
  window. An unqualified total would shrink every month as old rows are swept,
  so the window is stated.
- **Cancel this schedule** deletes it. Its project selection goes with it; its
  run history does not, and reports it already delivered are untouched.

### How many run at once

One account's schedules **always run one at a time**, however many are due
together — five schedules at 09:00 never become five crawls against your one
DependencyTrack connection. Across accounts, `SCHEDULER_CONCURRENCY` (default 5)
reports build simultaneously.

### Quota

The number of schedules per account is set by the administrator, globally or per
account. Creating one past the limit is refused with `429 QUOTA_REACHED`; being
over a lowered limit blocks new ones but never deletes existing ones.

### Failure notifications

If a scheduled run fails (SMTP error, DependencyTrack unreachable), the message
is stored server-side. On your next page load a toast shows it, once per
schedule, and is acknowledged automatically. The failure also appears in that
schedule's run history, and an alert email goes to the From address.

### Scheduled report endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/violation-cache/config` | GET | Sanitised config: connection, settings, mail (password masked) and the schedule list |
| `/violation-cache/config` | POST | Save the connection, settings or mail. **Not** schedules — they have their own routes |
| `/violation-cache/config/test-email` | POST | Send a test email with the current SMTP settings |
| `/violation-cache/schedules` | GET | Every schedule you own, plus your quota |
| `/violation-cache/schedules` | POST | Create one. `429 QUOTA_REACHED` past the limit |
| `/violation-cache/schedules` | DELETE | Cancel all of them |
| `/violation-cache/schedules/:id` | GET | One schedule, with its project UUIDs |
| `/violation-cache/schedules/:id` | PUT | Edit one |
| `/violation-cache/schedules/:id` | DELETE | Cancel one |
| `/violation-cache/schedules/:id/arm` | POST | Arm or resume it; returns the next run time |
| `/violation-cache/schedules/:id/disable` | POST | Pause it, keeping the definition |
| `/violation-cache/schedules/:id/run-now` | POST | Send immediately. `409 ALREADY_RUNNING` if another of yours is building |
| `/violation-cache/schedules/:id/runs` | GET | Run totals and the most recent few |
| `/violation-cache/schedules/:id/ack-notification` | POST | Clear a displayed failure notice |

A schedule that is not yours returns **404, never 403** — a 403 would confirm it
exists.

### Recipients: what is per account and what is per schedule

| Account (`mail_settings`) | Schedule (`schedules`) |
|---|---|
| SMTP host, port, TLS | To |
| SMTP username, password | CC |
| From address | Subject |
| Default To, CC, Subject | |

Only the addressing is per schedule: duplicating the SMTP connection would mean
re-entering a password to change a recipient. A schedule field left blank is
`null`, meaning "use the account's" — which is **not** the same as an empty list,
and the database refuses an empty To because that would be a schedule addressed
to nobody. Overriding To also drops the account's CC, rather than copying people
who have nothing to do with that report.

### Security notes

- The SMTP password is stored AES-256-GCM encrypted in the `mail_settings` table,
  scoped to your account.
- The GET config endpoint always masks the password as `••••••••`.
- The POST config endpoint detects the `••••••••` placeholder and discards it (preserving the real stored password).
- To change the password, type a new value into the Password field and save.

---

## 10. Customising the Dashboard

### Mock data

Edit the `rawTree` array in `generateMockProjects()` inside `dashboard/index.html`:

```javascript
// Leaf entry
{ name: 'my-service', version: '1.2.3', tags: ['java', 'production'] }

// Group entry
{ name: 'My Group', children: [ /* nested entries */ ] }
```

### Project data structure

```javascript
{
  uuid:       'string',
  name:       'string',
  version:    'string',
  parentUuid: 'string | null',
  level:      1,              // hierarchy depth (1 = root)
  isLatest:   true,
  tags:       ['string'],
  security:   { critical: 0, high: 0, medium: 0, low: 0, unassigned: 0 },
  operations: { fail: 0, warn: 0, info: 0 },
  license:    { fail: 0, warn: 0, info: 0 }
}
```

### Theming

All colours are CSS custom properties at the top of the `<style>` block. Light mode overrides are in `[data-theme="light"]`. The theme preference is saved in `localStorage`.

---

## 11. Embedding in Another Application

```html
<iframe
  src="http://localhost:3000"
  width="100%"
  height="800px"
  frameborder="0"
  title="Dependency Risk Dashboard">
</iframe>
```

To serve the pages without Docker (demo data only — signing in and live data need
the backend and the database):

```bash
cd dashboard && python3 -m http.server 3000
# or
npx serve dashboard -p 3000
```

For live data without Docker, enable CORS on the DT API server
(`ALPINE_CORS_ENABLED: "true"`) and enter the DT API URL in the Connect modal.
