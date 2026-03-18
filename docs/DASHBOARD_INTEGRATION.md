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

The custom risk dashboard is a **standalone, single-file HTML application**
served by an Nginx container on port `3000`. It provides:

- A sortable, filterable **hierarchical tree view** mirroring the DependencyTrack
  parent/child project structure
- **Expand/collapse** per group row — collapsed groups show **aggregated totals**
  for all descendants
- **Open All / Collapse All** buttons for bulk expand/collapse
- **Auto-refresh** toggle with selectable interval (30 s / 1 min / 5 min)
- **Tag filtering** — filter by project tags with a multi-select dropdown
- **Level filtering** — filter by hierarchy depth with a multi-select dropdown
- **CSV export** — exports all matching projects regardless of fold state, with a
  Type column (Group / Project)
- **KPI summary cards** for total Critical, High, Medium, Low counts
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

Projects are displayed in a parent/child tree that mirrors DependencyTrack's
project hierarchy. Each node shows its risk data inline.

```
▶ RET                               (collapsed group — shows aggregated totals)
▼ FreshX Suite                      (expanded group)
    ▶ FreshX-BE                     (collapsed sub-group)
    ▼ FreshX.BE.Containers          (expanded sub-group)
          FreshX-BE v1.4.1          (leaf project)
          FreshX-BE v1.3.0          (leaf project)
```

**Group rows (▶ / ▼):** rows that have children. When collapsed (▶), the row
displays the **sum of all descendant risk counts**. When expanded (▼), the row
shows only its own direct risk data and its children are listed below it.

**Hierarchy inference:** DependencyTrack's project list API does not always return
a `parent` field. The dashboard uses two strategies to infer the hierarchy:

1. **Exact name match** — a versioned project `name=foo version=1.2` is matched to
   an unversioned project with `name=foo`.
2. **Name-suffix match** — a project `name=foo-1.2 version=1.2` is matched to a
   parent named `foo`.

**Leaf rows:** project rows with no children. Always show their own data.

### Risk Matrix Columns

| Column              | Sub-columns                              | Source                              |
|---------------------|------------------------------------------|-------------------------------------|
| Project / Version   | —                                        | `name`, `version`, `tags`           |
| Lvl                 | —                                        | Computed from parent chain depth    |
| Security Risk       | Critical · High · Medium · Low · Unassigned | DT vulnerability CVSS severities |
| Operational Risk    | Fail · Warn · Info                       | `policyViolationsOperational*`      |
| License Risk        | Fail · Warn · Info                       | `policyViolationsLicense*`          |

**Total: 13 columns** — 1 project name + 1 level + 5 security + 3 operational + 3 license.

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

### Expand / Collapse

- Click the **▶** or **▼** triangle on any group row to toggle that group.
- Click **▼ Expand All** to open every group in the tree.
- Click **▶ Collapse All** to fold every group (top-level groups then show their
  fully aggregated portfolio totals).

### Project Hyperlinks

Set the **DT Frontend URL** in the "⚙ Connect API" modal to enable clickable
project links. Each project name becomes an anchor that opens
`<DT_FRONTEND_URL>/#/projects/<uuid>` in a new tab.

> **Important:** The DT Frontend URL is the URL users open in their browser to
> reach the DependencyTrack web UI (typically port `8080`) — this is **different**
> from the API URL (typically port `8081`). The value is saved in browser
> `localStorage` so it persists across sessions.

### Tags

Project tags are fetched from the DependencyTrack API and displayed as purple
chips on each row. The **Tags** multi-select filter shows all unique tags across
all loaded projects; selecting multiple tags narrows to projects that have
**all** of the selected tags.

### KPI Cards

The six summary cards above the table reflect the **currently filtered** project
set, so totals update as you apply filters.

- **Critical** = Security Critical + Operational Fail + License Fail
- **High** = Security High + Operational Warn + License Warn
- **Medium** = Security Medium + Operational Info + License Info
- **Low** = Security Low + Security Unassigned

Cards are clickable — clicking a card applies the matching risk-level filter.

### Sorting

Click any column header to sort by that value. Click again to reverse.
- Default sort: project name A–Z
- Numeric columns: highest values first when clicking
- Sort is applied within each sibling group, preserving the tree hierarchy.

### Filtering

| Filter | Type | Behaviour |
|--------|------|-----------|
| Search box | Text input | Substring match on project name |
| Risk level | Single-select | Show projects with the selected severity level |
| Category | Single-select | Narrow to Security, Operational, or License category |
| Level | Multi-select dropdown | Show only projects at selected hierarchy depths |
| Tags | Multi-select dropdown | Show only projects that have ALL selected tags |

All filters combine with AND logic. When a filter matches a child project, its
ancestor group rows are automatically shown so the tree context is preserved.

---

## 3. Switching from Mock Data to Live Data

### Method A — UI (easiest)

1. Open http://localhost:3000
2. Click the **"⚙ Connect API"** button (top right)
3. The modal shows the **proxy target status** — confirm DependencyTrack is reachable
4. *(Optional)* Enter the **DT API URL** if you want the browser to call DependencyTrack
   directly (leave blank to route all calls through the Nginx proxy)
5. *(Optional)* Enter the **DT Frontend URL** to enable project hyperlinks
   (e.g. `http://localhost:8080` or `https://dtrack.company.com`)
6. Enter your **API Key** (see [Section 4](#4-generating-an-api-key))
7. Click **Connect**

The dashboard fetches all projects (`GET /api/v1/project?pageSize=500`) and their
current metrics in batches of 20. It handles all three response shapes the
DependencyTrack API may return:

- `{ "values": [...] }` — paginated envelope (newer DT versions)
- `[...]` — bare array (older DT versions)
- `{}` — empty object when no projects exist yet (shows a friendly message)

### Connect modal fields explained

| Field | Required | Description |
|-------|----------|-------------|
| DT API URL | No | The URL the **browser** uses to reach the DT API. Leave blank to route via the Nginx proxy (recommended for Docker deployments). If `DT_API_INTERNAL_URL` is set to a browser-reachable address, it is pre-filled automatically. |
| DT Frontend URL | No | The URL users open to access the DependencyTrack web UI. Used only for project hyperlinks. Must be browser-accessible. Example: `http://localhost:8080`. Saved in `localStorage`. |
| API Key | Yes | Your DependencyTrack API key (masked as password). |

### Method B — Pre-configure the proxy target

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
Data comes from the `metrics` object embedded in the project list response
(`GET /api/v1/project`), falling back to the per-project metrics endpoint
(`GET /api/v1/metrics/project/{uuid}/current`) when the embedded object is absent.

### Project fields

Source: `GET /api/v1/project?pageSize=500&pageNumber=1`

| Dashboard Field | API Field          | Notes                                         |
|-----------------|--------------------|-----------------------------------------------|
| Project name    | `name`             |                                               |
| Version         | `version`          |                                               |
| Hierarchy level | `parent.uuid`      | Computed by walking up the parent chain; also inferred from name patterns when `parent` is absent |
| Tags            | `tags[].name`      | DT returns `[{name:"..."}, ...]`; flattened   |

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

| Dashboard Column | API Field                           | Description                     |
|------------------|-------------------------------------|---------------------------------|
| Fail             | `policyViolationsOperationalFail`   | Highest-severity operational violations |
| Warn             | `policyViolationsOperationalWarn`   | Warning-level operational violations    |
| Info             | `policyViolationsOperationalInfo`   | Informational operational violations    |

### License Risk

Maps to DependencyTrack **license policy violation** levels.

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

### Using the Level multi-select

1. Click the **Level** button in the toolbar
2. A dropdown shows all hierarchy depths that exist in the loaded data
3. Check one or more levels (e.g. "Level 3", "Level 4")
4. The table immediately narrows to matching rows (ancestor groups are shown
   automatically to preserve tree context)
5. Click **Clear** to reset, or uncheck to deselect individual levels

The badge on the button shows how many levels are currently selected.

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
Project, Version, Level, Tags, Type,
Security Critical, Security High, Security Medium, Security Low, Security Unassigned,
Operational Fail, Operational Warn, Operational Info,
License Fail, License Warn, License Info
```

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

The dashboard includes a built-in **auto-refresh** control in the toolbar.
Auto-refresh only runs in **live mode** (when connected to the DependencyTrack API).

### Using auto-refresh

1. Connect to the API (see [Section 3](#3-switching-from-mock-data-to-live-data))
2. Click **↺ Auto: Off** in the top toolbar — the button turns green and displays
   **↺ Auto: On**
3. An interval selector appears next to the button — choose **30 sec**, **1 min**,
   or **5 min**
4. The dashboard refreshes all project data and metrics at the selected interval
5. Click **↺ Auto: On** again to stop

The manual **↻ Refresh** button is always available regardless of auto-refresh state.
