# Dependency-Track — Custom Risk Dashboard

A **Black Duck-style cumulative risk dashboard** for
[OWASP Dependency-Track Community Edition](https://dependencytrack.org/).

The core focus of this project is the **custom dashboard** — a portfolio-level risk
view that aggregates Security, Operational, and License risk counts across all your
projects in a single hierarchical report, similar to the executive summary views in
Black Duck. DependencyTrack provides the analysis engine; this dashboard gives you
the consolidated visibility on top of it.

Also included:

- One-command Docker installer (full stack or dashboard-only mode)
- User creation scripts
- SBOM project upload scripts (single & bulk) with large-file support

---

## Quick Start

```bash
# 1. Clone
git clone <repo-url> dependency-tracker
cd dependency-tracker

# 2. Make scripts executable
chmod +x install.sh scripts/*.sh

# 3. Full install — DependencyTrack + custom dashboard (interactive)
./install.sh

# — OR — deploy only the custom dashboard if DependencyTrack is already running
./install.sh --dashboard-only
```

After a full install (~3–15 minutes on first run), open:

| Application            | URL                        |
|------------------------|----------------------------|
| DependencyTrack UI     | http://localhost:8080      |
| DependencyTrack API    | http://localhost:8081      |
| Custom Risk Dashboard  | http://localhost:3000      |

Default login: `admin` / *(password set during install)*

---

## Installer Options

| Flag | Description |
|------|-------------|
| *(none)* | Interactive full install — DependencyTrack stack + dashboard |
| `--dashboard-only` | Deploy only the custom dashboard (nginx container). Prompts for dashboard port and the DependencyTrack API URL to proxy to. Use when DT is already running elsewhere. |
| `--non-interactive` | Skip all prompts, use `.env` values / defaults. Combine with `--dashboard-only` for automation. |
| `--skip-docker-check` | Skip Docker version validation |
| `--uninstall` / `-u` | Remove containers, volumes, and networks (keep images) |
| `--all` / `-a` | Remove containers, volumes, networks, **and** images |

---

## What's Included

```
dependency-tracker/
├── install.sh                   # Automated installer (full or dashboard-only)
├── docker-compose.yml           # Full stack definition
├── .env.example                 # Configuration template
│
├── scripts/
│   ├── create-user.sh           # Add managed users
│   ├── upload-sbom.sh           # Upload single SBOM → auto-create project
│   └── bulk-upload-sbom.sh      # Batch upload all SBOMs in a directory
│
├── dashboard/
│   ├── index.html               # Custom risk matrix dashboard (single-file app)
│   └── nginx.conf.template      # Nginx config with API proxy (envsubst rendered)
│
└── docs/
    ├── INSTALLATION.md          # Full installation & configuration guide
    ├── USER_MANAGEMENT.md       # User/team/permission management
    ├── SBOM_PROJECTS.md         # SBOM generation & project upload guide
    └── DASHBOARD_INTEGRATION.md # Connecting the dashboard to live data
```

---

## Technology Stack

### Dashboard (`dashboard/index.html`)

The dashboard is a **zero-dependency, single-file HTML application** — no npm, no
build step, no external libraries. Everything runs natively in the browser.

| Technology | Version / Notes | Purpose |
|------------|-----------------|---------|
| **HTML5** | Semantic markup | Structure |
| **CSS3** | Custom properties, Grid, Flexbox, `position: relative/absolute` | Layout & theming |
| **Vanilla JavaScript (ES2020+)** | `async/await`, optional chaining (`?.`), `Map`, `Set` | All application logic |
| **Fetch API** | Native browser | DependencyTrack REST API calls |
| **localStorage** | Native browser | Persist API URL and Frontend URL across sessions |
| **CSS Custom Properties** | `var(--bg)`, `var(--accent)`, etc. | Dark-theme colour tokens |

No frameworks (React, Vue, Angular), no bundler (Webpack, Vite), no package manager.

### Infrastructure

| Component | Technology | Image / Version | Purpose |
|-----------|-----------|-----------------|---------|
| **DT API Server** | OWASP DependencyTrack | `dependencytrack/apiserver` (latest) | SBOM analysis engine + REST API |
| **DT Frontend** | OWASP DependencyTrack | `dependencytrack/frontend` (latest) | Official DT web UI |
| **Database** | PostgreSQL | `postgres:15-alpine` | Persistent project/vulnerability storage |
| **Dashboard server** | Nginx | `nginx:alpine` | Serves `index.html` + proxies `/api/*` to DT |
| **Orchestration** | Docker Compose v2 | `docker compose` (plugin) | Multi-container lifecycle management |

### SBOM Format

| Standard | Supported formats |
|----------|------------------|
| **CycloneDX** | JSON (`.json`), XML (`.xml`) |
| **SPDX** | JSON (`.spdx.json`) — via DT native support |

### DependencyTrack REST API (consumed by dashboard)

All dashboard data comes from the DependencyTrack REST API v1:

| Endpoint | Used for |
|----------|----------|
| `GET /api/v1/project?onlyRoot=true` | Fetch root-level projects (BFS level 0) |
| `GET /api/v1/project/{uuid}/children` | Fetch direct children of a project (BFS levels 1…N) |
| `GET /api/v1/metrics/project/{uuid}/current` | Per-project risk metrics (security + policy violations) |
| `GET /dt-config` | Read proxy target URL for display in the Connect modal |

### Shell Scripts

| Tool | Used in |
|------|---------|
| **bash** (4+) | `install.sh`, all scripts |
| **curl** | DT API calls from scripts |
| **jq** | JSON parsing in scripts |
| **Docker CLI** | Container management in install script |
| **envsubst** | Template rendering for `nginx.conf` |

---

## Docker Stack

| Container        | Image                            | Purpose                     |
|------------------|----------------------------------|-----------------------------|
| `dt-postgres`    | `postgres:15-alpine`             | Persistent database         |
| `dt-apiserver`   | `dependencytrack/apiserver`      | Analysis engine + REST API  |
| `dt-frontend`    | `dependencytrack/frontend`       | Official web UI             |
| `dt-dashboard`   | `nginx:alpine` + custom HTML     | Custom risk dashboard       |

---

## User Management

```bash
# Create a user and assign to a team
./scripts/create-user.sh \
  --username alice \
  --password "S3cur3P@ss!" \
  --email alice@example.com \
  --team "Developers"

# Interactive mode
./scripts/create-user.sh
```

Full guide: [docs/USER_MANAGEMENT.md](docs/USER_MANAGEMENT.md)

---

## Adding Projects via SBOM

```bash
# Auto-detect project name from the SBOM metadata
./scripts/upload-sbom.sh --file ./target/bom.json

# Explicit name + version + tags
./scripts/upload-sbom.sh \
  --file    ./target/bom.json \
  --project "payment-service" \
  --version "2.3.1" \
  --tags    "java,pci-dss"

# Bulk upload an entire directory
./scripts/bulk-upload-sbom.sh --dir ./sboms/
```

The upload script uses **multipart form upload** (`POST /api/v1/bom`) so it
handles arbitrarily large SBOM files without hitting shell argument size limits.

Full guide: [docs/SBOM_PROJECTS.md](docs/SBOM_PROJECTS.md)

---

## Custom Risk Dashboard

The dashboard at **http://localhost:3000** shows all projects in a risk matrix.
It works with **mock data** out of the box (no DependencyTrack connection needed)
and switches to **live data** when you enter an API key.

### Features

- **Risk matrix table** — Security (Critical/High/Medium/Low/Unassigned), Operational (Fail/Warn/Info), License (Fail/Warn/Info) — 13 columns total
- **Hierarchical tree** — mirrors DependencyTrack parent/child structure; fetched top-down via BFS (`onlyRoot=true` → `/children` per level)
- **Always-aggregated rows** — every row (group or leaf) shows cumulative own + all descendants totals; collapsing hides children without changing the parent's displayed count
- **Hierarchy level column** — depth in the parent/child tree (Level 1 = root, Level 2 = child, …)
- **Project hyperlinks** — set a DT Frontend URL in the Connect modal to make project names clickable links into the DependencyTrack UI
- **Tag chips** — first tag shown inline; "+N more" badge with hover tooltip for additional tags
- **Level multi-select filter** — show only projects at specific hierarchy depths
- **Risk level filter** — filters by aggregated risk (parent shown if any descendant has the risk)
- **Category filter** — narrow to Security, Operational, or License risks
- **KPI summary cards** — always show API-sourced total count; risk totals aggregated from topmost visible nodes; clickable to set risk filter
- **Search box** — substring match on project name
- **CSV export** — all filtered rows with full column names
- **Sortable columns** — click any column header; click again to reverse
- **Single expand/collapse toggle** — dynamically switches between "Expand All" and "Collapse All"
- **Auto-refresh** — configurable interval (30 s / 1 min / 5 min) in the top bar, live mode only

```
┌─────────────────────┬─────┬──────────────────────────────┬─────────────────┬─────────────────┐
│ Project / Version   │ Lvl │       Security Risk           │ Operational Risk│  License Risk   │
│                     │     │ Crit  High  Med  Low  Unassn  │ Fail  Warn  Info│ Fail  Warn  Info│
├─────────────────────┼─────┼──────────────────────────────┼─────────────────┼─────────────────┤
│ FreshX Suite        │  1  │  5    18    35   55     8     │  2    12    25  │  1     8    15  │
│  FreshX-BE          │  2  │  2     8    14   20     3     │  0     5    10  │  0     3     6  │
│   FreshX-BE  v1.4.1 │  3  │  1     3     6    9     1     │  0     2     4  │  0     1     2  │
│   FreshX-BE  v1.5.0 │  3  │  0     2     4    7     0     │  0     1     2  │  0     0     1  │
└─────────────────────┴─────┴──────────────────────────────┴─────────────────┴─────────────────┘
```

Dashboard integration guide: [docs/DASHBOARD_INTEGRATION.md](docs/DASHBOARD_INTEGRATION.md)

---

## Documentation

| Guide                                                  | Description                              |
|--------------------------------------------------------|------------------------------------------|
| [Installation](docs/INSTALLATION.md)                   | Full install, config, upgrade, troubleshoot |
| [User Management](docs/USER_MANAGEMENT.md)             | Users, teams, permissions, API keys      |
| [SBOM & Projects](docs/SBOM_PROJECTS.md)               | Generate SBOMs, upload, CI/CD            |
| [Dashboard Integration](docs/DASHBOARD_INTEGRATION.md) | Connect live data, filter, export CSV    |

---

## License

MIT — see [LICENSE](LICENSE)
