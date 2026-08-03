# Custom Risk Dashboard — Integration Guide

## Table of Contents
1. [Overview](#1-overview)
2. [Dashboard Features](#2-dashboard-features)
3. [Connecting to Live Data](#3-connecting-to-live-data)
4. [Generating an API Key](#4-generating-an-api-key)
5. [Violation Cache](#5-violation-cache)
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
- On page load: if no cache row exists for your connection, a rebuild starts automatically.
  `pg_try_advisory_lock` elects exactly one builder, so simultaneous visitors trigger
  one crawl between them, not one each
- On page load: if cache is stale, the old data is shown immediately while a rebuild runs in the background
- The banner **↻ Refresh** button triggers a violation-only rebuild without re-fetching projects

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
3. Choose which risk categories to include (Security, License, Operational) and confirm.
4. A background job is started. Monitor progress in **📥 Reports** (top-right button).
5. When the report is `completed`, click **↓ Download** to save the Excel file.

### Report limits

The maximum number of active reports (completed + in-progress) is configurable in **⚙ Settings → Max Report Downloads** (default: 10). When the limit is reached, new reports cannot be created until old ones are cleared.

### Report endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /violation-cache/report/generate` | POST | Start a report job; returns `{id}` |
| `GET /violation-cache/report/list` | GET | List all jobs with status and progress |
| `GET /violation-cache/report/:id/download` | GET | Stream the completed Excel file |
| `DELETE /violation-cache/report/:id` | DELETE | Delete job and file |
| `POST /violation-cache/report/:id/cancel` | POST | Request cancellation of a running job |

---

## 9. Email & Scheduled Reports

Automatic email delivery of Excel reports on a recurring schedule.

### Setup

1. Open **⚙ Settings**
2. Enable **Email & Scheduled Reports** (toggle at the top of that section)
3. Fill in SMTP credentials:
   - **Host** — your SMTP server (e.g. `smtp.gmail.com`)
   - **Port** — typically `587` (STARTTLS) or `465` (TLS)
   - **TLS** — check for port 465 connections
   - **Username / Password** — SMTP credentials (password is stored server-side, never returned to the browser)
4. Fill in **From**, **To**, and optionally **CC**, **Subject**, **Body**
5. Click **Send Test Email** to verify connectivity
6. Configure the **Schedule**:
   - Enable the schedule toggle
   - Choose **Daily**, **Weekly**, or **Monthly**
   - Set the **hour** (0–23, server local time)
   - For weekly: select which day(s) of the week
   - For monthly: choose a day (1–28)
   - Select which **risk categories** to include in scheduled reports
7. Click **Save**
8. Back in the main dashboard, select the projects to schedule (checkbox or all visible), then click **📅 Schedule Reports** in the toolbar

### Schedule status

While the config panel is open with the schedule section enabled, the **Last run** and **Next run** times are displayed:

- **Last run** — timestamp and success/failure status of the most recent scheduled run
- **Next run** — the upcoming fire time (computed from the server's local clock)

### Failure notifications

If a scheduled run fails (SMTP error, DT API unreachable, etc.), an error message is stored server-side. On your next page load, a toast notification shows the failure. Acknowledgement is sent automatically so the toast appears only once.

### Cancelling a schedule

Open **⚙ Settings**, scroll to the Schedule section, and click **Cancel Schedule**. This stops future scheduled runs but does not delete previously delivered reports.

### Scheduled report endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /violation-cache/config` | GET | Returns sanitised config (SMTP password masked) |
| `POST /violation-cache/config` | POST | Save `{ config: {...} }` or `{ apiKey: "..." }` |
| `POST /violation-cache/config/test-email` | POST | Send a test email using current SMTP config |
| `GET /violation-cache/schedule/status` | GET | Current schedule state including last/next run |
| `DELETE /violation-cache/schedule` | DELETE | Cancel the active schedule |
| `POST /violation-cache/schedule/ack-notification` | POST | Clear pending failure notification |

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
