# Custom Risk Dashboard — Integration Guide

## Table of Contents
1. [Overview](#1-overview)
2. [Dashboard Features](#2-dashboard-features)
3. [Switching from Mock Data to Live Data](#3-switching-from-mock-data-to-live-data)
4. [Generating an API Key](#4-generating-an-api-key)
5. [Data Mapping Reference](#5-data-mapping-reference)
6. [Filtering and Exporting](#6-filtering-and-exporting)
7. [Customising the Dashboard](#7-customising-the-dashboard)
8. [Embedding in Another Application](#8-embedding-in-another-application)
9. [Auto-refresh](#9-auto-refresh)

---

## 1. Overview

> **Screenshots:** Place dashboard screenshots in `docs/images/` and reference
> them below. Suggested captures: full dashboard view, KPI cards area, filter row
> with ★ Latest Only active, tree with a collapsed group, Connect API modal.
> Example reference: `![Dashboard overview](images/dashboard-overview.png)`

The custom risk dashboard is a **standalone, single-file HTML application**
served by an Nginx container on port `3000`. It provides:

- A filterable **hierarchical tree view** mirroring the DependencyTrack
  parent/child project structure
- **Expand/collapse** per group row — each row always shows its own API-returned
  counts; collapsing a group hides its children but does not change the parent's numbers
- **Single Expand All / Collapse All toggle button** (right side of the filter row)
  that dynamically switches label based on the current state of the tree
- **Auto-refresh** toggle (in the top bar) with selectable interval (30 s / 1 min / 5 min)
- **Tag filtering** — filter by project tags with a multi-select dropdown
- **Level filtering** — filter by hierarchy depth with a single-select dropdown (like Category)
- **CSV export** — exports all matching projects regardless of fold state, with a
  Type column (Group / Project). The **Export CSV** button is right-aligned in the filter row.
- **KPI summary cards** for total Critical, High, Medium, Low counts — computed
  once at load from root-level projects only; fixed for the lifetime of the data
  load regardless of which filters or tiles are active
- **Project hyperlinks** — when the DT Frontend URL is set in the Connect modal,
  project names link directly to that project in the DependencyTrack UI
- **Two data modes**:
  - **Mock mode** (default) — a realistic hierarchical project tree for immediate preview
  - **Live mode** — pulls real data from your DependencyTrack API

### How network calls work

The dashboard communicates with the DependencyTrack API in one of two ways:

| Mode | When | How |
|------|------|-----|
| **Nginx proxy** (default) | DT API URL field left blank | Browser calls `/api/*` on the dashboard origin; Nginx forwards to `DT_API_INTERNAL_URL` — no CORS |
| **Direct** | DT API URL filled in the Connect modal | Browser calls the URL you typed directly — requires CORS or same-origin |

The `DT_API_INTERNAL_URL` env var (set at deploy time) controls only the Nginx
proxy target. It is separate from the URL you type in the UI.

---

## 2. Dashboard Features

### Hierarchical Tree View

Projects are fetched using a **BFS (breadth-first) traversal** of the
DependencyTrack project hierarchy:

1. Root projects are fetched first using `GET /api/v1/project?onlyRoot=true`
2. For each root, children are fetched via `GET /api/v1/project/{uuid}/children`
3. Each level of children is batched 10 at a time, and the process repeats until
   no further children exist at any level
4. Each child has its `parent.uuid` stamped during fetch, guaranteeing accurate
   hierarchy regardless of DependencyTrack version

This produces a fully accurate multi-level tree displayed as:

```
▶ RET                               (collapsed group — shows its own API-returned counts)
▼ FreshX Suite                      (expanded group — shows its own API-returned counts)
    ▶ FreshX-BE                     (collapsed sub-group — shows its own API-returned counts)
    ▼ FreshX.BE.Containers          (expanded sub-group — shows its own API-returned counts)
          FreshX-BE v1.4.1          (leaf project)
          FreshX-BE v1.3.0          (leaf project)
```

**Group rows (▶ / ▼):** rows that have children. Every row — whether a group or leaf —
displays the counts **exactly as returned by the DependencyTrack API** for that project.
No child-aggregation is performed in the dashboard. Expanding or collapsing a group
only shows/hides children; it does not alter any displayed number.

**Leaf rows:** project rows with no children. Show their own API-returned data.

### Risk Matrix Columns

| Column              | Sub-columns                              | Source                              |
|---------------------|------------------------------------------|-------------------------------------|
| Project / Version   | —                                        | `name`, `version`, `tags`           |
| Lvl                 | —                                        | Computed from parent chain depth    |
| Latest              | —                                        | `isLatest` field from DT API; shown as a disabled checked checkbox when `true`, blank when `false` |
| Security Risk       | Critical · High · Medium · Low · Unassigned | DT vulnerability CVSS severities |
| Operational Risk    | Fail · Warn · Info                       | `policyViolationsOperational*`      |
| License Risk        | Fail · Warn · Info                       | `policyViolationsLicense*`          |

**Total: 14 columns** — 1 project name + 1 level + 1 latest + 5 security + 3 operational + 3 license.

### Colour coding

| Level / Severity | Colour |
|------------------|--------|
| Critical / Fail  | Red    |
| High / Warn      | Orange |
| Medium / Info    | Yellow |
| Low / Unassigned | Blue   |
| Zero (—)         | Grey   |

For Operational and License columns, DependencyTrack uses **Fail / Warn / Info**
severity levels (matching policy violation levels). These are displayed in red /
orange / yellow respectively, consistent with Critical / High / Medium.

> **Note:** Operational and License counts come from the DependencyTrack **Policy
> Engine**. They will always be zero until you configure policies in DependencyTrack
> (Administration → Policy Management). This is expected behaviour — vulnerability
> scanning alone does not produce policy violations.

### Expand / Collapse

- Click the **▶** or **▼** triangle on any group row to toggle that group.
- A single **▼ Expand All** / **▶ Collapse All** button, **right-aligned** in the
  filter row, performs bulk expand/collapse. The label automatically switches based
  on whether all groups are currently expanded.
- Expanding or collapsing a group does **not** change any displayed counts — every
  row always shows its own API-returned data regardless of tree state.

### Project Hyperlinks

Set the **DT Frontend URL** in the "⚙ Connect API" modal to enable clickable
project links. Each project name becomes an anchor that opens
`<DT_FRONTEND_URL>/#/projects/<uuid>` in a new tab.

> **Important:** The DT Frontend URL is the URL users open in their browser to
> reach the DependencyTrack web UI (typically port `8080`) — this is **different**
> from the API URL (typically port `8081`). The value is saved in browser
> `localStorage` so it persists across sessions.

### Tags

Project tags are fetched from the DependencyTrack API and displayed as chips on
each row. When a project has multiple tags:

- The **first tag** is shown inline as a chip
- A **`+N more`** badge appears next to it; hovering the badge reveals a tooltip
  showing all remaining tags

The **Tags** multi-select filter shows all unique tags across all loaded projects;
selecting multiple tags narrows to projects that have **all** of the selected tags.

### KPI Cards

The summary cards above the table show **fixed totals computed once** immediately
after data loads. Applying filters or clicking a tile does not change the numbers —
only the active-highlight border updates to show which filter is selected.

Totals are derived from **root-level projects only** (projects with no parent in
the dataset). This prevents double-counting: if DependencyTrack reports parent=7,
child-a=5, child-b=2, the card shows 7 — not 14.

- **Projects** — `allProjects.length`: total project count returned by the API.
  The sub-text "N with risks" is also fixed at load time.
- **Critical** = Security Critical + Operational Fail + License Fail
- **High** = Security High + Operational Warn + License Warn
- **Medium** = Security Medium + Operational Info + License Info
- **Low** = Security Low + Security Unassigned
- **Clean** = Projects − risky (both fixed at load time)

Cards are clickable — clicking sets the risk-level filter on the table (which
narrows the rows) but does not alter the card values themselves.

### Filtering

| Filter | Type | Behaviour |
|--------|------|-----------|
| Search box | Text input | Substring match on project name |
| Risk level | Single-select | Show projects whose own API-returned data contains the selected severity |
| Category | Single-select | Narrow to Security, Operational, or License category |
| Level | Single-select | Show only projects at the selected hierarchy depth |
| Tags | Multi-select dropdown | Show only projects that have ALL selected tags |
| ★ Latest Only | Toggle button | Show only projects marked `isLatest = true` in DependencyTrack, plus their full ancestor chain up to the root |

All filters combine with AND logic. When a filter matches a child project, its
ancestor group rows are automatically shown so the tree context is preserved.

The **★ Latest Only** toggle is applied after all other filters: it first narrows
the working set to `isLatest = true` projects that also pass all other filters,
then re-adds every ancestor of those projects (even if the ancestor would not
have passed the other filters) so the tree hierarchy is always intact.

> **Note:** The sibling order within each group is alphabetical (A–Z), set once
> when the tree is built. There are no sortable column headers.

---

## 3. Switching from Mock Data to Live Data

### Method A — Installer (recommended for new installs)

When you run `./install.sh` (full stack) or `./install.sh --dashboard-only`, the
installer prompts for an API key and writes it to `.env` as `DT_API_KEY`.
Docker Compose passes this to the dashboard container, so the dashboard
**auto-connects and loads live data on first open** — no UI steps needed.

If the auto-fetch fails during a full install, the installer falls back to an
interactive prompt so you can paste the key manually.

### Method B — UI

1. Open http://localhost:3000
2. Click the **"⚙ Connect API"** button (top right)
3. The modal shows the **proxy target status** — confirm DependencyTrack is reachable
4. *(Optional)* Enter the **DT API URL** if you want the browser to call DependencyTrack
   directly (leave blank to route all calls through the Nginx proxy)
5. *(Optional)* Enter the **DT Frontend URL** to enable project hyperlinks
   (e.g. `http://localhost:8080` or `https://dtrack.company.com`)
6. Enter your **API Key** (see [Section 4](#4-generating-an-api-key))
7. Click **Connect**

The dashboard fetches projects using a **BFS traversal**:

1. `GET /api/v1/project?onlyRoot=true` — fetches all root-level projects
2. `GET /api/v1/project/{uuid}/children` — fetches children for each project,
   repeated level by level until no children remain
3. `GET /api/v1/metrics/project/{uuid}/current` — fetches metrics for any
   project whose metrics are not embedded in the project response

Each API call handles pagination automatically using `X-Total-Count` headers
and supports all three response shapes DependencyTrack may return:

- `{ "values": [...] }` — paginated envelope (newer DT versions)
- `[...]` — bare array (older DT versions)
- `{}` — empty object when no projects exist yet (shows a friendly message)

### Connect modal fields explained

| Field | Required | Description |
|-------|----------|-------------|
| DT API URL | No | The URL the **browser** uses to reach the DT API. Leave blank to route via the Nginx proxy (recommended for Docker deployments). If `DT_API_INTERNAL_URL` is set to a browser-reachable address, it is pre-filled automatically. |
| DT Frontend URL | No | The URL users open to access the DependencyTrack web UI. Used only for project hyperlinks. Must be browser-accessible. Example: `http://localhost:8080`. Saved in `localStorage`. |
| API Key | Yes | Your DependencyTrack API key (masked as password). |

### Method C — Pre-configure the proxy target

The proxy target (`DT_API_INTERNAL_URL`) is a **server-side** setting — the
browser always calls `/api/*` on the dashboard origin, and Nginx forwards it.
To point the dashboard at a different DT instance:

1. Edit `.env`:
   ```dotenv
   DT_API_INTERNAL_URL=http://10.121.163.69:8081
   ```
2. Restart the dashboard container:
   ```bash
   docker compose --env-file .env up -d --no-deps dt-dashboard
   ```

The "⚙ Connect API" modal will now show the new proxy target URL automatically.

---

## 4. Generating an API Key

API keys are associated with **Teams** in DependencyTrack.

### Via UI

1. Log in to http://localhost:8080 as `admin`
2. Go to **Administration → Access Management → Teams**
3. Click **Automation** (or any team you want to use)
4. Scroll to the **API Keys** section
5. Click **+ Generate API Key**
6. **Copy the key immediately** — it cannot be retrieved again

### Via command line

```bash
# Get an auth token
TOKEN=$(curl -sf \
  -X POST http://localhost:8081/api/v1/user/login \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=admin" \
  --data-urlencode "password=<your-admin-password>")

# List teams and extract the first key
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:8081/api/v1/team | jq -r '.[0].apiKeys[0].key'

# The key looks like: odt_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Minimum required permissions for the dashboard

The dashboard only **reads** data. Create a dedicated read-only team:

| Permission           | Required? |
|----------------------|-----------|
| `VIEW_PORTFOLIO`     | ✅ Yes    |
| `VIEW_VULNERABILITY` | ✅ Yes    |
| All others           | ❌ No     |

---

## 5. Data Mapping Reference

The dashboard maps DependencyTrack API responses to three risk categories.

### API Endpoints Used

| Section | Endpoint | Purpose |
|---------|----------|---------|
| Hierarchy (roots) | `GET /api/v1/project?onlyRoot=true` | Fetch all root-level projects (paginated) |
| Hierarchy (children) | `GET /api/v1/project/{uuid}/children` | Fetch children for each project (paginated) |
| Metrics | `GET /api/v1/metrics/project/{uuid}/current` | Per-project risk metrics (fallback when not embedded) |
| Config | `GET /dt-config` | Reads `DT_API_INTERNAL_URL` to pre-fill the API URL field |

### Project fields

Source: `GET /api/v1/project?onlyRoot=true` and `GET /api/v1/project/{uuid}/children`

| Dashboard Field | API Field          | Notes                                         |
|-----------------|--------------------|-----------------------------------------------|
| Project name    | `name`             |                                               |
| Version         | `version`          |                                               |
| Hierarchy level | `parent.uuid`      | Stamped during BFS fetch; guaranteed accurate |
| Tags            | `tags[].name`      | DT returns `[{name:"..."}, ...]`; flattened   |
| Latest          | `isLatest`         | `true` when DependencyTrack marks this as the latest version of the project |

### Security Risk

Maps to DependencyTrack **vulnerability CVSS severity** counts.

| Dashboard Column | API Field    | Description                          |
|------------------|--------------|--------------------------------------|
| Critical         | `critical`   | Vulnerabilities with CVSS ≥ 9.0      |
| High             | `high`       | Vulnerabilities with CVSS 7.0–8.9    |
| Medium           | `medium`     | Vulnerabilities with CVSS 4.0–6.9    |
| Low              | `low`        | Vulnerabilities with CVSS 0.1–3.9    |
| Unassigned       | `unassigned` | Vulnerabilities with no CVSS score   |

### Operational Risk

Maps to DependencyTrack **operational policy violation** levels.

> Requires policies configured in DependencyTrack (Administration → Policy
> Management). Values are always 0 until policies are set up.

| Dashboard Column | API Field                           | Description                     |
|------------------|-------------------------------------|---------------------------------|
| Fail             | `policyViolationsOperationalFail`   | Highest-severity operational violations |
| Warn             | `policyViolationsOperationalWarn`   | Warning-level operational violations    |
| Info             | `policyViolationsOperationalInfo`   | Informational operational violations    |

### License Risk

Maps to DependencyTrack **license policy violation** levels.

> Requires policies configured in DependencyTrack (Administration → Policy
> Management). Values are always 0 until policies are set up.

| Dashboard Column | API Field                      | Description                        |
|------------------|--------------------------------|------------------------------------|
| Fail             | `policyViolationsLicenseFail`  | Highest-severity license violations |
| Warn             | `policyViolationsLicenseWarn`  | Warning-level license violations    |
| Info             | `policyViolationsLicenseInfo`  | Informational license violations    |

### What is not mapped (not available in DependencyTrack)

| Black Duck field  | DT equivalent | Status   |
|-------------------|---------------|----------|
| Version Risk      | —             | Not available — DT does not track component version freshness |
| Activity Risk     | —             | Not available — DT does not track component activity metrics |
| Policy violation severities (Blocker / Critical / Major / Minor / Trivial) | Fail / Warn / Info | DT uses a 3-level system; not a 1:1 mapping |

### Full embedded metrics API response shape

```json
{
  "critical": 2,
  "high": 8,
  "medium": 14,
  "low": 23,
  "unassigned": 3,
  "suppressed": 1,
  "vulnerabilities": 47,
  "components": 158,
  "policyViolationsTotal": 5,
  "policyViolationsFail": 1,
  "policyViolationsWarn": 4,
  "policyViolationsInfo": 0,
  "policyViolationsSecurityFail": 0,
  "policyViolationsSecurityWarn": 1,
  "policyViolationsSecurityInfo": 0,
  "policyViolationsLicenseFail": 1,
  "policyViolationsLicenseWarn": 2,
  "policyViolationsLicenseInfo": 0,
  "policyViolationsOperationalFail": 0,
  "policyViolationsOperationalWarn": 1,
  "policyViolationsOperationalInfo": 0,
  "firstOccurrence": 1710000000000,
  "lastOccurrence": 1710086400000
}
```

---

## 6. Filtering and Exporting

### Using the Level filter

1. Click the **Level** dropdown in the filter row (behaves like the Category dropdown)
2. The dropdown lists all hierarchy depths that exist in the loaded data
3. Select a level (e.g. "Level 3") — the table narrows to projects at that depth
   (ancestor groups are shown automatically to preserve tree context)
4. Select **All levels** to reset

### Using the Tag multi-select

1. Click the **Tags** button in the toolbar
2. A dropdown shows all unique tags from all loaded projects
3. Check one or more tags (e.g. "production", "critical-service")
4. Only projects that have **all** selected tags are shown (AND logic)
5. Click **Clear** to reset

### Exporting filtered rows to CSV

1. Apply any combination of filters (search, risk level, category, level, tags)
2. Click **↓ Export CSV**
3. The browser downloads `dependency-track-YYYY-MM-DD.csv`

The CSV always exports **all matching projects regardless of fold state** — if a
group is collapsed but its children match the active filters, the children appear
in the CSV. A **Type** column identifies each row as `Group` or `Project`.

CSV column layout:

```
Project, Version, Level, Tags, Type, Latest,
Security Critical, Security High, Security Medium, Security Low, Security Unassigned,
Operational Fail, Operational Warn, Operational Info,
License Fail, License Warn, License Info
```

The **Latest** column contains `Yes` for projects where `isLatest = true`, and blank otherwise.

Tags are semicolon-separated within the Tags cell. All values are
double-quote-escaped (RFC 4180 compliant).

---

## 7. Customising the Dashboard

### Mock data

The mock data generates a realistic hierarchical project tree (not a flat list).
The tree is defined in `generateMockProjects()` in `dashboard/index.html`.
Edit the `rawTree` array to add, remove, or restructure the mock hierarchy.

Each leaf entry has:
```javascript
{ name: 'my-service', version: '1.2.3', tags: ['java', 'production'] }
```

Each group entry has:
```javascript
{ name: 'My Group', children: [ /* nested entries */ ] }
```

### Risk data structure

Each project object in the dashboard has:

```javascript
{
  uuid:       'string',
  name:       'string',
  version:    'string',
  parentUuid: 'string | null',
  level:      1,            // hierarchy depth (1 = root)
  isLatest:   true,         // from DT's isLatest field; false for group/intermediate nodes
  tags:       ['string'],
  security: {
    critical: 0, high: 0, medium: 0, low: 0, unassigned: 0
  },
  operations: {
    fail: 0, warn: 0, info: 0     // policyViolationsOperational*
  },
  license: {
    fail: 0, warn: 0, info: 0     // policyViolationsLicense*
  }
}
```

These values come directly from the DependencyTrack API and are displayed
as-is in every table row (parent or leaf). No in-code child aggregation is done.

### Theming

All colours are CSS custom properties at the top of the `<style>` block.
To switch to a light theme, change:

```css
:root {
  --bg:      #ffffff;
  --surface: #f8fafc;
  --text:    #1e293b;
}
```

---

## 8. Embedding in Another Application

The dashboard is a **self-contained HTML file** — it can be embedded as an
`<iframe>` or served from any static file host:

```html
<!-- Embed in an existing portal -->
<iframe
  src="http://localhost:3000"
  width="100%"
  height="800px"
  frameborder="0"
  title="Dependency Risk Dashboard">
</iframe>
```

To serve the dashboard without Docker (note: `/api/*` proxy won't work without Nginx):

```bash
# Python (for local testing with mock data only)
cd dashboard && python3 -m http.server 3000

# Node.js / npx serve
npx serve dashboard -p 3000
```

For live data without Docker, you need to either:
- Run your own Nginx with an equivalent proxy config
- Or enable CORS on the DependencyTrack API server (`ALPINE_CORS_ENABLED: "true"`)
  and fill in the DT API URL in the Connect modal (direct browser → DT API calls)

---

## 9. Auto-refresh

The dashboard includes a built-in **auto-refresh** control in the **top bar**
(next to the ⚙ Connect API and ↻ Refresh buttons). Auto-refresh only runs in
**live mode** (when connected to the DependencyTrack API).

### Using auto-refresh

1. Connect to the API (see [Section 3](#3-switching-from-mock-data-to-live-data))
2. Click **↺ Auto: Off** in the top bar — the button turns green and displays
   **↺ Auto: On**
3. An interval selector appears next to the button — choose **30 sec**, **1 min**,
   or **5 min**
4. The dashboard refreshes all project data and metrics at the selected interval
5. Click **↺ Auto: On** again to stop

The manual **↻ Refresh** button is always available regardless of auto-refresh state.
