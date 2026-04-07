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
# Remove containers and network (keep images and violation-cache/data/)
./install.sh --uninstall

# Remove containers, network, AND Docker images
./install.sh --all
```

The `violation-cache/data/` directory is **not** removed — delete manually if needed:

```bash
rm -f violation-cache/data/violation-cache.json
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
