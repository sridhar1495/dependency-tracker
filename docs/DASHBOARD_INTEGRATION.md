# Custom Risk Dashboard — Integration Guide

## Table of Contents
1. [Overview](#1-overview)
2. [Dashboard Features](#2-dashboard-features)
3. [Connecting to Live Data](#3-connecting-to-live-data)
4. [Generating an API Key](#4-generating-an-api-key)
5. [Violation Cache](#5-violation-cache)
6. [Data Mapping Reference](#6-data-mapping-reference)
7. [Filtering and Exporting](#7-filtering-and-exporting)
8. [Customising the Dashboard](#8-customising-the-dashboard)
9. [Embedding in Another Application](#9-embedding-in-another-application)

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

| Mode | When | How |
|------|------|-----|
| **nginx proxy** (default) | DT API URL field left blank in Connect modal | Browser calls `/api/*` on the dashboard origin; nginx forwards to `DT_API_INTERNAL_URL` — no CORS needed |
| **Direct** | DT API URL filled in the Connect modal | Browser calls the URL directly — requires CORS enabled on DT or same-origin |

The `DT_API_INTERNAL_URL` env var (set at deploy time) controls only the nginx
proxy target. It is separate from any URL typed in the Connect modal UI.

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

Set the **DT Frontend URL** in the "⚙ Connect API" modal to enable clickable project links. Each project name becomes a link to `<DT_FRONTEND_URL>/#/projects/<uuid>`.

---

## 3. Connecting to Live Data

### Method A — Installer (recommended)

Run `./install.sh` and enter your API key when prompted. The installer writes `DT_API_KEY` to `.env` — the dashboard **auto-connects on first open**.

### Method B — UI

1. Open the dashboard (default: http://localhost:3000)
2. Click **⚙ Connect API**
3. *(Optional)* Enter the **DT API URL** if you want the browser to call DT directly (leave blank to use the nginx proxy)
4. *(Optional)* Enter the **DT Frontend URL** for project hyperlinks
5. Enter your **API Key** (see [Section 4](#4-generating-an-api-key))
6. Click **Connect**

### Method C — Pre-configure in `.env`

```dotenv
DT_API_INTERNAL_URL=https://dtrack.company.com
DT_API_KEY=odt_your_key
DT_FRONTEND_URL=https://dtrack.company.com
```

```bash
docker compose --env-file .env up -d
```

### Connect modal fields

| Field | Required | Description |
|-------|----------|-------------|
| DT API URL | No | URL the **browser** uses to reach DT API directly. Leave blank to route via nginx proxy (recommended). |
| DT Frontend URL | No | URL for the DT web UI. Used only for project hyperlinks. Saved in browser `localStorage`. |
| API Key | Yes | DependencyTrack API key (masked). |

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
| `/violation-cache/data` | GET | Full cached map `{generatedAt, expiresAt, map:{uuid:…}}` |
| `/violation-cache/refresh` | POST | Trigger a background rebuild (409 if already running) |

### Manual operations

```bash
# Check cache status
curl http://localhost:3000/violation-cache/status

# Trigger a rebuild
curl -X POST http://localhost:3000/violation-cache/refresh

# Clear the cache file (forces rebuild on next page load)
rm violation-cache/data/violation-cache.json
docker compose restart dt-violation-cache
```

### TTL and rebuild

- Default TTL: **24 hours** (configurable via `VIOLATION_CACHE_TTL_HOURS` in `.env`)
- On startup: if no cache file exists or TTL has expired, a rebuild starts automatically
- On page load: if cache is stale, the old data is shown immediately while a rebuild runs in the background
- The banner **↻ Refresh** button triggers a violation-only rebuild without re-fetching projects

---

## 6. Data Mapping Reference

### API Endpoints Used

| Section | Endpoint | Purpose |
|---------|----------|---------|
| Hierarchy (roots) | `GET /api/v1/project?onlyRoot=true` | All root-level projects (paginated) |
| Hierarchy (children) | `GET /api/v1/project/{uuid}/children` | Children per project (paginated) |
| Config | `GET /dt-config` | Reads `DT_API_INTERNAL_URL` + `DT_API_KEY` to pre-fill the Connect modal |
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

## 8. Customising the Dashboard

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

## 9. Embedding in Another Application

```html
<iframe
  src="http://localhost:3000"
  width="100%"
  height="800px"
  frameborder="0"
  title="Dependency Risk Dashboard">
</iframe>
```

To serve without Docker (mock data only — `/api/*` proxy requires nginx):

```bash
cd dashboard && python3 -m http.server 3000
# or
npx serve dashboard -p 3000
```

For live data without Docker, enable CORS on the DT API server
(`ALPINE_CORS_ENABLED: "true"`) and enter the DT API URL in the Connect modal.
