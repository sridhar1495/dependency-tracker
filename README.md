# Dependency-Track CE — Docker Installer & Custom Dashboard

A complete **Docker-based installer** for
[OWASP Dependency-Track Community Edition](https://dependencytrack.org/) with:

- One-command installation
- User creation scripts
- SBOM project upload scripts (single & bulk)
- A custom **risk matrix dashboard** for portfolio-level visibility

---

## Quick Start

```bash
# 1. Clone
git clone <repo-url> dependency-tracker
cd dependency-tracker

# 2. Make scripts executable
chmod +x install.sh scripts/*.sh

# 3. Install (interactive — guides you through all settings)
./install.sh
```

After ~3 minutes, open:

| Application            | URL                        |
|------------------------|----------------------------|
| DependencyTrack UI     | http://localhost:8080      |
| DependencyTrack API    | http://localhost:8081      |
| Custom Risk Dashboard  | http://localhost:3000      |

Default login: `admin` / *(password set during install)*

---

## What's Included

```
dependency-tracker/
├── install.sh                   # Automated installer
├── docker-compose.yml           # Full stack definition
├── .env.example                 # Configuration template
│
├── scripts/
│   ├── create-user.sh           # Add managed users
│   ├── upload-sbom.sh           # Upload single SBOM → auto-create project
│   └── bulk-upload-sbom.sh      # Batch upload all SBOMs in a directory
│
├── dashboard/
│   ├── index.html               # Custom risk matrix dashboard (56 projects)
│   └── nginx.conf               # Nginx config with API proxy
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

Full guide: [docs/SBOM_PROJECTS.md](docs/SBOM_PROJECTS.md)

---

## Custom Risk Dashboard

The dashboard at **http://localhost:3000** shows all projects in a risk matrix:

- **56 rows** (one per project) with mock data by default
- **12 data columns**: Security x Operational x License, each with Critical / High / Medium / Low
- Sortable columns, search box, and risk-level filters
- **Live data mode**: click "Connect Live API" and enter your API key

```
┌──────────────────────┬──────────────────────┬──────────────────────┬────────────────────┐
│ Project              │    Security Risk      │   Operational Risk   │    License Risk    │
│                      │ Crit  High  Med  Low  │ Crit  High  Med  Low │ Crit High Med Low  │
├──────────────────────┼──────────────────────┼──────────────────────┼────────────────────┤
│ payment-service v2.3 │  2     8    14   23   │  0     3     1    0  │  1    4    0    0  │
│ auth-gateway v1.5    │  0     2     5   12   │  0     1     0    0  │  0    1    0    0  │
│ ... (56 rows total)  │  ...                  │  ...                 │  ...               │
└──────────────────────┴──────────────────────┴──────────────────────┴────────────────────┘
```

Dashboard integration guide: [docs/DASHBOARD_INTEGRATION.md](docs/DASHBOARD_INTEGRATION.md)

---

## Documentation

| Guide                                                  | Description                              |
|--------------------------------------------------------|------------------------------------------|
| [Installation](docs/INSTALLATION.md)                   | Full install, config, upgrade, troubleshoot |
| [User Management](docs/USER_MANAGEMENT.md)             | Users, teams, permissions, API keys      |
| [SBOM & Projects](docs/SBOM_PROJECTS.md)               | Generate SBOMs, upload, CI/CD            |
| [Dashboard Integration](docs/DASHBOARD_INTEGRATION.md) | Connect live data, customise, export     |

---

## License

MIT — see [LICENSE](LICENSE)
