# Dependency-Track CE — Docker Installer & Custom Dashboard

A complete **Docker-based installer** for
[OWASP Dependency-Track Community Edition](https://dependencytrack.org/) with:

- One-command installation with interactive configuration
- **Dashboard-only** mode for connecting to an existing DependencyTrack instance
- User creation scripts
- SBOM project upload scripts (single & bulk) with large-file support
- A custom **risk matrix dashboard** with hierarchy filtering, tag filtering, and CSV export

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
│   ├── index.html               # Custom risk matrix dashboard
│   └── nginx.conf.template      # Nginx config with API proxy (envsubst rendered)
│
└── docs/
    ├── INSTALLATION.md          # Full installation & configuration guide
    ├── USER_MANAGEMENT.md       # User/team/permission management
    ├── SBOM_PROJECTS.md         # SBOM generation & project upload guide
    └── DASHBOARD_INTEGRATION.md # Connecting the dashboard to live data
```

---

## Stack

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
- **Hierarchy tree** — parent/child groups with expand/collapse; infers hierarchy from project names when DT API omits `parent` field
- **Collapsed groups show aggregated totals** for all descendants
- **Hierarchy level column** — depth in the parent/child tree (Level 1 = top-level group, Level 2 = child, …)
- **Project hyperlinks** — set a DT Frontend URL in the Connect modal to make project names clickable links into the DependencyTrack UI
- **Tag chips** — project tags displayed inline; tag multi-select filter in the toolbar
- **Level multi-select filter** — show only projects at specific hierarchy depths
- **Risk level filter** — show only projects with a specific severity level
- **Category filter** — narrow to Security, Operational, or License risks
- **KPI summary cards** — update live with every filter change; clickable to set the risk filter
- **Search box** — substring match on project name
- **CSV export** — all filtered rows with full column names: `Security Critical`, `Operational Fail`, `License Warn`, etc.
- **Sortable columns** — click any column header; click again to reverse
- **Auto-refresh** — configurable interval (30 s / 1 min / 5 min), live mode only

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
