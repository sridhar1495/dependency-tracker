# Installation Guide — Dependency-Track Risk Dashboard

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Quick Install](#3-quick-install)
4. [Non-interactive Install](#4-non-interactive-install)
5. [Configuration Reference](#5-configuration-reference)
6. [Updating](#6-updating)
7. [Uninstalling](#7-uninstalling)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Overview

This project deploys two containers:

| Container | Image | Purpose |
|-----------|-------|---------|
| `dt-dashboard` | `nginx:alpine` | Serves the single-file dashboard SPA and proxies `/api/*` to your DependencyTrack instance |
| `dt-violation-cache` | Built from `./violation-cache` | Fetches policy violations from DT server-side and caches them so the browser never streams large violation payloads |

**DependencyTrack itself is not included.** You need an existing DependencyTrack instance running somewhere (same host, remote server, or cloud). Point `DT_API_INTERNAL_URL` at its API and the dashboard will connect.

---

## 2. Prerequisites

| Tool | Minimum version | Check |
|------|----------------|-------|
| Docker | 20.10 | `docker version` |
| Docker Compose | Plugin ≥ 2 or standalone ≥ 1.29 | `docker compose version` |

No other tools are required.

---

## 3. Quick Install

```bash
git clone <repo-url> dependency-tracker
cd dependency-tracker
chmod +x install.sh
./install.sh
```

The installer prompts for:

| Prompt | Default | Description |
|--------|---------|-------------|
| Dashboard port | `3000` | Port exposed on the host machine |
| DependencyTrack API URL | `http://dtrack-apiserver:8080` | nginx proxy target — where `/api/*` requests are forwarded |
| DT Frontend URL | _(blank)_ | DT web UI URL for clickable project links (optional) |
| DT API key | _(blank)_ | Pre-configures auto-connect on page open (optional) |
| Violation cache TTL | `24` | Hours before the violation cache auto-expires |

After the prompts the installer:
1. Pulls `nginx:alpine`
2. Builds the violation cache image
3. Starts both containers

Open **http://localhost:3000** (or your chosen port). If an API key was configured, the dashboard connects automatically. Otherwise click **⚙ Connect API** and enter your key.

---

## 4. Non-interactive Install

Populate `.env` before running:

```bash
cp .env.example .env
# Edit .env with your values
./install.sh --non-interactive
```

Minimum `.env` for auto-connect:

```dotenv
DT_API_INTERNAL_URL=https://dtrack.company.com
DT_API_KEY=odt_your_api_key_here
```

---

## 5. Configuration Reference

All values live in `.env`. After changing any value, apply with:

```bash
docker compose --env-file .env up -d
```

| Variable | Default | Description |
|----------|---------|-------------|
| `DT_DASHBOARD_PORT` | `3000` | Host port for the dashboard |
| `DT_API_INTERNAL_URL` | `http://dtrack-apiserver:8080` | nginx proxy target (DT API URL reachable from within the container network) |
| `DT_API_KEY` | _(blank)_ | Pre-configured API key. Exposed to the browser via `/dt-config` — restrict to internal networks |
| `DT_FRONTEND_URL` | _(blank)_ | DT web UI URL for project hyperlinks (e.g. `https://dtrack.company.com`) |
| `VIOLATION_CACHE_TTL_HOURS` | `24` | Hours the violation cache file is valid before auto-rebuild |
| `POSTGRES_USER` | `dtdash` | Database role |
| `POSTGRES_PASSWORD` | _(generated)_ | Database password. `install.sh` generates one when absent. **Changing it after first start will break the connection** — PostgreSQL only reads it when initialising the cluster |
| `POSTGRES_DB` | `dtdash` | Database name |
| `POSTGRES_PORT` | `5432` | Host port the database is published on, for external DB tooling |
| `SESSION_ABSOLUTE_HOURS` | `8` | Absolute session lifetime (enforced from phase 2) |
| `SESSION_IDLE_HOURS` | `2` | Idle session lifetime (enforced from phase 2) |
| `LOG_FORMAT` | `text` | `text` or `json` for structured output |

### Database

The stack includes a `dt-postgres` container as the system of record for users,
per-user settings and reports. Two things follow from that:

- **`dt-violation-cache` will not start until the database is healthy.** Schema
  migrations run before the HTTP listener opens, so the service refuses to serve
  requests against an un-migrated database. If it exits at boot, check
  `docker logs dt-postgres` first.
- **The data directory is a bind mount at `./violation-cache/pgdata`**, not a
  named Docker volume. This is deliberate: `./install.sh --uninstall` runs
  `docker compose down -v`, which would destroy a named volume without warning.
  A bind mount survives, and the uninstaller tells you the path to remove if you
  really do want the data gone.

Connect external tooling with:

```bash
psql -h localhost -p ${POSTGRES_PORT:-5432} -U dtdash dtdash
```

### Changing the violation cache TTL after installation

The TTL is not set during installation — the default is 24 hours. To change it:

```bash
# Edit .env
VIOLATION_CACHE_TTL_HOURS=12

# Apply the change
docker compose --env-file .env restart dt-violation-cache
```

The new TTL takes effect for the next cache build. A rebuild can be triggered immediately with:

```bash
curl -X POST http://localhost:3000/violation-cache/refresh
```

### Generating an API key in DependencyTrack

The dashboard only reads data. Create a dedicated read-only team and key:

1. Log in to your DependencyTrack UI
2. Go to **Administration → Access Management → Teams**
3. Click **Automation** (or create a new team)
4. Assign permissions: `VIEW_PORTFOLIO` and `VIEW_VULNERABILITY` only
5. Scroll to **API Keys** → click **+ Generate API Key**
6. Copy the key — it cannot be retrieved again

### Pointing at an external DependencyTrack

```dotenv
# .env
DT_API_INTERNAL_URL=https://dtrack.company.com
DT_API_KEY=odt_your_read_only_key
DT_FRONTEND_URL=https://dtrack.company.com
```

```bash
docker compose --env-file .env up -d
```

The nginx proxy forwards all `/api/*` requests to the URL above.
No CORS configuration is needed on the DT server since all calls originate from nginx, not the browser.

---

## 6. Updating

```bash
docker compose --env-file .env pull dt-dashboard
docker compose --env-file .env build dt-violation-cache
docker compose --env-file .env up -d
```

---

## 7. Uninstalling

```bash
# Remove containers and network (keep images and all data on disk)
./install.sh --uninstall

# Remove containers, network, AND Docker images
./install.sh --all
```

Both commands remove the `dt-dashboard`, `dt-violation-cache` and `dt-postgres`
containers and the `dependency-track` network.

**Your data is kept.** These are bind mounts on the host and are never deleted by
the uninstaller:

| Path | Contents |
|------|----------|
| `./violation-cache/pgdata` | The database — all users, settings and reports |
| `./violation-cache/data` | Violation cache, generated report files, app config |
| `./.env` | Configuration, including the database password |

To discard everything, remove them explicitly after uninstalling:

```bash
rm -rf violation-cache/pgdata violation-cache/data
```

---

## 8. Troubleshooting

### Dashboard shows mock data / won't connect

- Confirm the DT API is reachable from inside the container:
  ```bash
  docker exec dt-dashboard wget -qO- http://dtrack-apiserver:8080/api/version
  ```
- Check nginx logs: `docker logs dt-dashboard`

### Violation counts show zero / "cache service unreachable"

- Check the cache service: `docker logs dt-violation-cache`
- Confirm the API key is set: `docker exec dt-violation-cache printenv DT_API_KEY`
- Check status: `curl http://localhost:3000/violation-cache/status`
- Trigger rebuild: `curl -X POST http://localhost:3000/violation-cache/refresh`

### Port conflict

```dotenv
# .env
DT_DASHBOARD_PORT=3001
```

```bash
docker compose --env-file .env up -d
```
