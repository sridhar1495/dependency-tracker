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
- **Project hyperlinks** — when the DT Frontend URL is configured, project names
  link directly to that project in the DependencyTrack UI
- **Two data modes**:
  - **Mock mode** (default) — a realistic hierarchical project tree for immediate preview
  - **Live mode** — pulls real data from your DependencyTrack API

The dashboard communicates with the DependencyTrack API through the Nginx
reverse proxy (`/api/*` → `DT_API_INTERNAL_URL/api/*`), which eliminates CORS
issues. The browser never makes a direct request to DependencyTrack.

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

**Leaf rows:** project rows with no children. Always show their own data.

### Risk Matrix Columns

| Column            | Description                                              |
|-------------------|----------------------------------------------------------|
| Project / Version | Project name with version badge and tag chips            |
| Lvl               | Hierarchy depth (1 = top-level group, 2 = child, …)     |
| Security Risk     | Critical · High · Medium · Low vulnerability counts      |
| Operational Risk  | Critical · High · Medium · Low operational risk counts   |
| License Risk      | Critical · High · Medium · Low policy violation counts   |

**Total: 13 columns** — 1 project name + 1 level + 3 categories × 4 severity levels.

### Colour coding

| Level    | Colour |
|----------|--------|
| Critical | Red    |
| High     | Orange |
| Medium   | Yellow |
| Low      | Blue   |
| Zero (—) | Grey   |

### Expand / Collapse

- Click the **▶** or **▼** triangle on any group row to toggle that group.
- Click **▼ Expand All** to open every group in the tree.
- Click **▶ Collapse All** to fold every group (top-level groups then show their
  fully aggregated portfolio totals).

### Project Hyperlinks

When a **DT Frontend URL** is configured in the Connect modal (see
[Section 3](#3-switching-from-mock-data-to-live-data)), every project name
becomes a clickable link that opens the project directly in the DependencyTrack
UI (`<DT_FRONTEND_URL>/#/projects/<uuid>`).

### Tags

Project tags are fetched from the DependencyTrack API and displayed as purple
chips on each row. The **Tags** multi-select filter shows all unique tags across
all loaded projects; selecting multiple tags narrows to projects that have
**all** of the selected tags.

### Sorting

Click any column header to sort by that value. Click again to reverse.
- Default sort: project name A–Z
- Numeric columns: highest values first when clicking
- Sort is applied within each sibling group, preserving the tree hierarchy.

### Filtering

| Filter | Type | Behaviour |
|--------|------|-----------|
| Search box | Text input | Substring match on project name |
| Risk level | Single-select | Show only projects with a specific severity level |
| Category | Single-select | Narrow to Security, Operational, or License category |
| Level | Multi-select dropdown | Show only projects at selected hierarchy depths |
| Tags | Multi-select dropdown | Show only projects that have ALL selected tags |

All filters combine with AND logic. When a filter matches a child project, its
ancestor group rows are automatically shown so the tree context is preserved.

### KPI Cards

The six summary cards above the table always reflect **all loaded projects**
(not the current filter), giving a stable portfolio-level baseline.

---

## 3. Switching from Mock Data to Live Data

### Method A — UI (easiest)

1. Open http://localhost:3000
2. Click the **"⚙ Connect API"** button (top right)
3. The modal shows the **proxy target status** — confirm DependencyTrack is reachable
4. Enter your **API Key** (see [Section 4](#4-generating-an-api-key))
5. *(Optional)* Enter the **DependencyTrack Frontend URL** to enable project
   hyperlinks (e.g. `http://10.121.163.69:8080`)
6. Click **Connect**

The dashboard fetches all projects (`GET /api/v1/project?pageSize=500`) and their
current metrics (`GET /api/v1/metrics/project/{uuid}/current`) in real time. It
handles all three response shapes the DependencyTrack API may return:

- `{ "values": [...] }` — paginated envelope (newer DT versions)
- `[...]` — bare array (older DT versions)
- `{}` — empty object when no projects exist yet (shows a friendly message)

### Method B — Browser localStorage (persistent across refreshes)

Open your browser's DevTools console and run:

```javascript
// Store credentials
localStorage.setItem('dt_api_key', 'odt_xxxxxxxxxxxxxxxxxx');

// To auto-connect on load, add to the // ── Init ── section of index.html:
const savedKey = localStorage.getItem('dt_api_key');
if (savedKey) {
  document.getElementById('apiKeyInput').value = savedKey;
  apiKey = savedKey;
  connectLiveApi();
} else {
  loadMockData();
}
```

### Method C — Pre-configure the proxy target

The proxy target (`DT_API_INTERNAL_URL`) is a **server-side** setting — the browser
always calls `/api/*` on the same origin (the Nginx container), which then proxies
the request to DependencyTrack. To point the dashboard at a different DT instance:

1. Edit `.env`:
   ```dotenv
   DT_API_INTERNAL_URL=http://10.121.163.69:8081
   ```
2. Restart the dashboard container:
   ```bash
   docker compose --env-file .env up -d --no-deps dt-dashboard
   ```

The "⚙ Connect API" modal will now show the new proxy target automatically.

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

The dashboard maps DependencyTrack API responses to the three risk categories.

### Project fields

Source: `GET /api/v1/project?pageSize=500&pageNumber=1`

| Dashboard Field | API Field          | Notes                                       |
|-----------------|--------------------|---------------------------------------------|
| Project name    | `name`             |                                             |
| Version         | `version`          |                                             |
| Hierarchy level | `parent.uuid`      | Computed by walking up the parent chain     |
| Tags            | `tags[].name`      | DT returns `[{name:"..."}, ...]`; flattened |

### Security Risk

Source: `GET /api/v1/metrics/project/{uuid}/current`

| Dashboard Column | API Field  |
|------------------|------------|
| Critical         | `critical` |
| High             | `high`     |
| Medium           | `medium`   |
| Low              | `low`      |

### Operational Risk

Source: same metrics endpoint

| Dashboard Column | API Field     | Description                                |
|------------------|---------------|--------------------------------------------|
| Critical         | _(none)_      | Reserved                                   |
| High             | `unassigned`  | Components with unassigned vulnerabilities |
| Medium           | `suppressed`  | Suppressed findings (audit required)       |
| Low              | _(none)_      | —                                          |

> Edit `connectLiveApi()` in `dashboard/index.html` to remap these to match
> your organisation's operational risk definition.

### License Risk

Source: same metrics endpoint

| Dashboard Column | API Field              | Description              |
|------------------|------------------------|--------------------------|
| Critical         | `policyViolationsFail` | FAIL policy violations   |
| High             | `policyViolationsWarn` | WARN policy violations   |
| Medium           | `policyViolationsInfo` | INFO policy violations   |
| Low              | _(none)_               | —                        |

### Full API response shape

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
  "policyViolationsFail": 1,
  "policyViolationsWarn": 4,
  "policyViolationsInfo": 0,
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

```
Project, Version, Level, Tags, Type,
Sec Critical, Sec High, Sec Medium, Sec Low,
Ops Critical, Ops High, Ops Medium, Ops Low,
Lic Critical, Lic High, Lic Medium, Lic Low
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

### Add a new risk column

To add a column (e.g. "Unassigned" in the Operational category):

1. Change `const LEVELS = ['critical','high','medium','low'];` to add `'unassigned'`
2. Update the `ops` mapping in `connectLiveApi()` to populate `unassigned`
3. The table renders the new column automatically

### Change risk category names

Edit the `CAT_LABELS` constant:

```javascript
const CAT_LABELS = {
  security:   'Vulnerabilities',
  operations: 'Compliance',
  license:    'Licensing',
};
```

> Note: `CAT_LABELS` is available for custom rendering — the column group
> headers currently use inline strings in the HTML `<th>` elements.

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
  and call the API directly (edit `connectLiveApi()` to use a direct URL)

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
