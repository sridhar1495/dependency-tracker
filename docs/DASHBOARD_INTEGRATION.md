# Custom Risk Dashboard — Integration Guide

## Table of Contents
1. [Overview](#1-overview)
2. [Dashboard Features](#2-dashboard-features)
3. [Switching from Mock Data to Live Data](#3-switching-from-mock-data-to-live-data)
4. [Generating an API Key](#4-generating-an-api-key)
5. [Data Mapping Reference](#5-data-mapping-reference)
6. [Customising the Dashboard](#6-customising-the-dashboard)
7. [Embedding in Another Application](#7-embedding-in-another-application)
8. [Automation — Auto-refresh](#8-automation--auto-refresh)
9. [Exporting Data](#9-exporting-data)

---

## 1. Overview

The custom risk dashboard is a **standalone, single-file HTML application**
served by an Nginx container on port `3000`. It provides:

- A sortable, filterable **risk matrix table** for all your projects
- **KPI summary cards** for total Critical, High, Medium, Low counts
- **Two data modes**:
  - **Mock mode** (default) — 56 synthetic projects for immediate preview
  - **Live mode** — pulls real data from your DependencyTrack API

The dashboard communicates with the DependencyTrack API through the Nginx
reverse proxy (`/api/*` → `http://dtrack-apiserver:8080/api/*`), which
eliminates CORS issues.

---

## 2. Dashboard Features

### Risk Matrix Table

Each row represents one project. Columns are:

| Column Group    | Levels                                        |
|-----------------|-----------------------------------------------|
| Security Risk   | Critical · High · Medium · Low                |
| Operational Risk | Critical · High · Medium · Low               |
| License Risk    | Critical · High · Medium · Low                |

**Total: 12 data columns** (3 categories × 4 severity levels).

### Colour coding

| Level    | Colour |
|----------|--------|
| Critical | Red    |
| High     | Orange |
| Medium   | Yellow |
| Low      | Blue   |
| Zero (—) | Grey   |

### Sorting

Click any column header to sort by that value. Click again to reverse.
- Default sort: project name A–Z
- Numeric columns: highest values first when clicking

### Filtering

- **Search box** — filter by project name (substring match)
- **Risk level filter** — show only projects with a specific severity level
- **Category filter** — narrow to Security, Operational, or License risks

---

## 3. Switching from Mock Data to Live Data

### Method A — UI (easiest)

1. Open http://localhost:3000
2. Click the **"⚙ Connect Live API"** button (top right)
3. Enter:
   - **API Base URL**: `http://localhost:8081` (default, or your server address)
   - **API Key**: your DependencyTrack API key (see [Section 4](#4-generating-an-api-key))
4. Click **Connect**

The dashboard will fetch all projects and their current metrics in real time.

### Method B — Browser localStorage (persistent)

Open your browser's DevTools console and run:

```javascript
// Set credentials (persisted across page refreshes)
localStorage.setItem('dt_api_url', 'http://localhost:8081');
localStorage.setItem('dt_api_key', 'odt_xxxxxxxxxxxxxxxxxx');
location.reload();
```

To add auto-load support, edit `dashboard/index.html` and add to the `// ── Init ──` section:

```javascript
// Auto-load live data if credentials are stored
const savedUrl = localStorage.getItem('dt_api_url');
const savedKey = localStorage.getItem('dt_api_key');
if (savedUrl && savedKey) {
  document.getElementById('apiUrlInput').value = savedUrl;
  document.getElementById('apiKeyInput').value = savedKey;
  apiUrl = savedUrl;
  apiKey = savedKey;
  connectLiveApi();
} else {
  loadMockData();
}
```

### Method C — Environment variable (server-side pre-configuration)

Edit `docker-compose.yml` to inject the API key into the Nginx container as a
rendered config:

```yaml
dt-dashboard:
  environment:
    DT_API_KEY: "${DT_API_KEY}"
    DT_API_URL: "http://dtrack-apiserver:8080"
```

Then add a startup script to inject these values into `index.html` using `envsubst`.

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

# List teams and their keys
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:8081/api/v1/team | jq '.[].apiKeys'

# The key looks like: odt_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Minimum required permissions for the dashboard

The dashboard only **reads** data, so create a dedicated read-only team:

| Permission        | Required? |
|-------------------|-----------|
| `VIEW_PORTFOLIO`  | ✅ Yes    |
| `VIEW_VULNERABILITY` | ✅ Yes |
| All others        | ❌ No     |

---

## 5. Data Mapping Reference

The dashboard maps DependencyTrack API responses to the three risk categories:

### Security Risk

Source: `GET /api/v1/metrics/project/{uuid}/current`

| Dashboard Column | API Field     |
|------------------|---------------|
| Critical         | `critical`    |
| High             | `high`        |
| Medium           | `medium`      |
| Low              | `low`         |

### Operational Risk

Source: same metrics endpoint

| Dashboard Column | API Field       | Description                              |
|------------------|-----------------|------------------------------------------|
| Critical         | _(none currently)_ | Reserved for policy critical violations |
| High             | `unassigned`    | Components with unassigned vulnerabilities |
| Medium           | `suppressed`    | Suppressed findings (audit required)     |
| Low              | _(none)_        | —                                        |

> **Note**: The operational risk column is intentionally flexible. Edit the
> `connectLiveApi()` function in `dashboard/index.html` to map fields that
> match your organisation's risk definition.

### License Risk

Source: same metrics endpoint

| Dashboard Column | API Field              | Description                        |
|------------------|------------------------|------------------------------------|
| Critical         | `policyViolationsFail` | FAIL policy violations             |
| High             | `policyViolationsWarn` | WARN policy violations             |
| Medium           | `policyViolationsInfo` | INFO policy violations             |
| Low              | _(none)_               | —                                  |

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

## 6. Customising the Dashboard

### Change the number of projects displayed

The mock data generates exactly **56 projects** by default (matching the 56-item
`names` array in `dashboard/index.html`). To add or remove mock projects:

1. Edit `dashboard/index.html`
2. Find the `names` array in `generateMockProjects()`
3. Add or remove entries

### Add a new risk column

To add an "Unassigned" column to the Operational category:

1. Change `const LEVELS = ['critical','high','medium','low'];` to include `'unassigned'`
2. Update the `operationalRisk` mapping in `connectLiveApi()` to populate `unassigned`
3. The table will automatically render the new column

### Change risk category names

Edit the `CAT_LABELS` constant:

```javascript
const CAT_LABELS = {
  security:   'Vulnerabilities',   // rename Security → Vulnerabilities
  operations: 'Compliance',        // rename Operational → Compliance
  license:    'Licensing',
};
```

### Theming

All colours are CSS custom properties at the top of the `<style>` block.
To switch to a light theme, change:

```css
:root {
  --bg:      #ffffff;
  --surface: #f8fafc;
  --text:    #1e293b;
  ...
}
```

---

## 7. Embedding in Another Application

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

To serve the dashboard without Docker:

```bash
# Python (for local testing)
cd dashboard && python3 -m http.server 3000

# Node.js / npx serve
npx serve dashboard -p 3000
```

---

## 8. Automation — Auto-refresh

The dashboard has a manual **↻ Refresh** button. To enable **auto-refresh**,
add this to the `// ── Init ──` section of `dashboard/index.html`:

```javascript
// Auto-refresh every 5 minutes in live mode
setInterval(() => {
  if (liveMode) refreshData();
}, 5 * 60 * 1000);
```

---

## 9. Exporting Data

### Export current table view as CSV

Add a button and this function to `dashboard/index.html`:

```javascript
function exportCSV() {
  const headers = ['Project','Version',
    'Sec-Critical','Sec-High','Sec-Medium','Sec-Low',
    'Ops-Critical','Ops-High','Ops-Medium','Ops-Low',
    'Lic-Critical','Lic-High','Lic-Medium','Lic-Low'];

  const rows = filtered.map(p => [
    p.name, p.version,
    p.security.critical, p.security.high, p.security.medium, p.security.low,
    p.operations.critical, p.operations.high, p.operations.medium, p.operations.low,
    p.license.critical, p.license.high, p.license.medium, p.license.low
  ]);

  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `risk-dashboard-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}
```

### Export via DependencyTrack API

```bash
# Export all project metrics as JSON
curl -s -H "X-Api-Key: $DT_API_KEY" \
  "http://localhost:8081/api/v1/metrics/project/current?pageSize=500" \
  | jq '[.[] | {
      project: .project.name,
      version: .project.version,
      critical, high, medium, low,
      policyViolationsFail, policyViolationsWarn
    }]' > risk-report.json
```
