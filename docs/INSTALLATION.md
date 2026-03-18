# Dependency-Track CE — Installation Guide

## Table of Contents
1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Quick Install — Full Stack](#3-quick-install--full-stack)
4. [Quick Install — Dashboard Only](#4-quick-install--dashboard-only)
5. [Manual Installation](#5-manual-installation)
6. [Configuration Reference](#6-configuration-reference)
7. [Verifying Your Installation](#7-verifying-your-installation)
8. [Accessing the Applications](#8-accessing-the-applications)
9. [Managing the Stack](#9-managing-the-stack)
10. [Upgrading](#10-upgrading)
11. [Uninstall](#11-uninstall)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Overview

This installer deploys **OWASP Dependency-Track Community Edition** using Docker
Compose. Two install modes are available:

### Full Stack

| Container        | Role                                        | Default Port |
|------------------|---------------------------------------------|-------------|
| `dt-postgres`    | PostgreSQL 15 database                      | internal    |
| `dt-apiserver`   | DependencyTrack REST API & analysis engine  | 8081        |
| `dt-frontend`    | DependencyTrack web UI (Vue.js)             | 8080        |
| `dt-dashboard`   | Custom risk dashboard (Nginx + static HTML) | 3000        |

### Dashboard Only (`--dashboard-only`)

Deploys only the `dt-dashboard` container (Nginx). Use this when DependencyTrack
is already running on another host or in an existing deployment and you only want
to add the custom risk dashboard UI.

---

## 2. Prerequisites

| Requirement | Minimum Version | Check Command                          |
|-------------|-----------------|----------------------------------------|
| Docker      | 20.10.0         | `docker version`                       |
| Docker Compose | Plugin ≥ 2 or standalone ≥ 1.29 | `docker compose version` |
| curl        | any             | `curl --version`                       |
| jq          | any             | `jq --version`                         |
| Free RAM    | 4 GB (8 GB recommended for full stack) | `free -h`         |
| Free disk   | 10 GB (full stack) / 200 MB (dashboard only) | `df -h .`  |

> **Dashboard-only mode** needs only Docker, curl, and Docker Compose — `jq` is
> only required for the admin bootstrap steps of a full install.

### Installing Docker (Ubuntu / Debian)

```bash
# Add Docker's official GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/docker.gpg

# Add repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow running docker without sudo (log out and back in after this)
sudo usermod -aG docker $USER
```

### Installing jq

```bash
# Ubuntu / Debian
sudo apt-get install -y jq

# macOS
brew install jq
```

---

## 3. Quick Install — Full Stack

```bash
# 1. Clone the repository (or download a release archive)
git clone <your-repo-url> dependency-tracker
cd dependency-tracker

# 2. Make the installer executable
chmod +x install.sh scripts/*.sh

# 3. Run the installer (interactive)
./install.sh
```

The installer will:
- ✅ Validate all prerequisites
- ✅ Walk you through port and password configuration
- ✅ Write your settings to `.env`
- ✅ Pull all four Docker images
- ✅ Start all containers
- ✅ Wait for the API server to be ready (up to 15 minutes on first run — the NVD database download can be slow)
- ✅ Change the default admin password
- ✅ Retrieve and save the admin API key to `.env`
- ✅ Print access URLs

### Non-interactive install

For CI/CD or automated deployments, pre-populate `.env` and pass the flag:

```bash
cp .env.example .env
# Edit .env with your values, then:
./install.sh --non-interactive
```

---

## 4. Quick Install — Dashboard Only

Use this when DependencyTrack is already running elsewhere and you only want
to deploy the custom risk dashboard.

```bash
./install.sh --dashboard-only
```

The installer will prompt for:

1. **Custom Dashboard port** — default `3000`
2. **DependencyTrack API URL (nginx proxy target)** — where the dashboard's
   Nginx will proxy `/api/*` requests to.
   - Same Docker network (default): `http://dtrack-apiserver:8080`
   - External instance: `http://10.121.163.69:8081` (your DT host/port)

Only the `dt-dashboard` (Nginx) container is pulled and started. DependencyTrack
containers are not touched.

### Non-interactive dashboard-only install

```bash
# Pre-set values in .env, then:
./install.sh --dashboard-only --non-interactive
```

Required `.env` values for dashboard-only:

```dotenv
DT_DASHBOARD_PORT=3000
DT_API_INTERNAL_URL=http://10.121.163.69:8081   # your existing DT API
```

---

## 5. Manual Installation

If you prefer to run each step yourself:

### Step 5.1 — Copy and edit the environment file

```bash
cp .env.example .env
```

Edit `.env` with your preferred editor:

```bash
nano .env        # or: vim .env / code .env
```

Key values to change:
- `POSTGRES_PASSWORD` — strong database password
- `DT_ADMIN_PASS` — admin console password
- Ports if defaults (8080/8081/3000) clash with existing services

### Step 5.2 — Pull Docker images

```bash
# Full stack
docker compose --env-file .env pull

# Dashboard only
docker compose --env-file .env pull dt-dashboard
```

### Step 5.3 — Start the stack

```bash
# Full stack
docker compose --env-file .env up -d

# Dashboard only (--no-deps skips dtrack-apiserver and postgres)
docker compose --env-file .env up -d --no-deps dt-dashboard
```

### Step 5.4 — Monitor startup (full stack only)

The API server can take **2–15 minutes** on first launch because it:
- Runs Liquibase database migrations
- Downloads vulnerability databases (NVD, GitHub Advisories, OSS Index)

```bash
# Follow API server logs
docker logs -f dt-apiserver

# Or check health status
docker compose ps
```

### Step 5.5 — Change the default admin password

Browse to `http://localhost:8080` → log in as `admin` / `admin`
→ you will be prompted to set a new password.

---

## 6. Configuration Reference

All configuration is done via the `.env` file.

| Variable              | Default                   | Description                                          |
|-----------------------|---------------------------|------------------------------------------------------|
| `DT_VERSION`          | `latest`                  | DependencyTrack Docker image tag (e.g. `4.11.4`)     |
| `DT_HOST`             | `localhost`               | Hostname/IP shown in the installer summary           |
| `DT_FRONTEND_PORT`    | `8080`                    | Port for the DependencyTrack web UI                  |
| `DT_API_PORT`         | `8081`                    | Port for the DependencyTrack REST API                |
| `DT_DASHBOARD_PORT`   | `3000`                    | Port for the custom risk dashboard                   |
| `DT_API_URL`          | `http://localhost:8081`   | API base URL used by helper scripts (upload-sbom, etc.) |
| `DT_API_INTERNAL_URL` | `http://dtrack-apiserver:8080` | Where the dashboard's Nginx proxies `/api/*` to. Override for external DT instances. |
| `DT_API_KEY`          | _(auto-populated)_        | Written by install.sh after first login              |
| `DT_ADMIN_USER`       | `admin`                   | Initial admin username                               |
| `DT_ADMIN_PASS`       | `admin`                   | Initial admin password — **change immediately!**     |
| `POSTGRES_DB`         | `dtrack`                  | Database name                                        |
| `POSTGRES_USER`       | `dtrack`                  | Database user                                        |
| `POSTGRES_PASSWORD`   | `dtrack_password_change_me` | **Change this before deploying!**                  |

### Advanced API Server Options

The API server is configured via environment variables in `docker-compose.yml`.
Common overrides (add to the `dtrack-apiserver` → `environment` block):

```yaml
ALPINE_METRICS_ENABLED: "true"            # Enable Prometheus /metrics endpoint
ALPINE_CORS_ENABLED: "true"               # Allow cross-origin requests
ALPINE_CORS_ALLOW_ORIGIN: "*"
```

See the full reference at:
https://docs.dependencytrack.org/getting-started/configuration/

---

## 7. Verifying Your Installation

```bash
# Check all containers are running
docker compose ps

# API version endpoint
curl -s http://localhost:8081/api/version | jq .

# Expected response:
# {
#   "application": "Dependency-Track",
#   "version": "4.x.x",
#   ...
# }

# Check database connectivity
docker exec dt-postgres psql -U dtrack -c "SELECT version();"
```

---

## 8. Accessing the Applications

| Application           | URL                              | Default Credentials   |
|-----------------------|----------------------------------|-----------------------|
| DependencyTrack UI    | http://localhost:8080            | admin / *(your pass)* |
| DependencyTrack API   | http://localhost:8081/api/version | API key required      |
| Custom Risk Dashboard | http://localhost:3000            | No auth required      |
| API Swagger Docs      | http://localhost:8081/api/swagger.json | —              |

---

## 9. Managing the Stack

```bash
# Stop all containers (data is preserved)
docker compose down

# Start again
docker compose --env-file .env up -d

# Restart a single service
docker compose restart dtrack-apiserver

# Restart only the dashboard (e.g. after changing DT_API_INTERNAL_URL)
docker compose --env-file .env up -d --no-deps dt-dashboard

# View logs
docker logs dt-apiserver -f
docker logs dt-frontend -f
docker logs dt-dashboard -f

# View resource usage
docker stats
```

---

## 10. Upgrading

```bash
# 1. Back up data volumes
docker run --rm -v dependency-tracker_dependency-track-data:/data \
  -v $(pwd):/backup alpine tar czf /backup/dt-data-backup.tar.gz -C / data
docker run --rm -v dependency-tracker_postgres-data:/data \
  -v $(pwd):/backup alpine tar czf /backup/dt-db-backup.tar.gz -C / data

# 2. Pull new images
docker compose pull

# 3. Recreate containers
docker compose up -d --force-recreate
```

To pin to a specific version, set `DT_VERSION=4.11.4` in `.env`.

---

## 11. Uninstall

```bash
# Remove containers, volumes, and networks (keeps Docker images)
./install.sh --uninstall

# Also remove Docker images
./install.sh --all
```

Or manually:

```bash
# Stop and remove containers + networks (data volumes are preserved)
docker compose down

# PERMANENT: also remove all data volumes
docker compose down -v
docker volume rm dependency-tracker_dependency-track-data dependency-tracker_postgres-data
```

---

## 12. Troubleshooting

### API server won't start

```bash
docker logs dt-apiserver --tail 50
```

**Common causes:**
- Not enough RAM → increase Docker Desktop memory allocation to ≥ 6 GB
- Database connection failed → ensure `dt-postgres` is healthy: `docker compose ps`
- Port conflict → change `DT_API_PORT` in `.env`

### Cannot connect to API from scripts

```bash
# Test connectivity
curl -v http://localhost:8081/api/version
```

If Docker Desktop / WSL is used, `localhost` may need to be `host.docker.internal`.

### Password change fails

Log in directly via the UI at `http://localhost:8080`.
The default credentials are `admin` / `admin`.
You will be forced to change the password on first login.

### Dashboard shows "proxy target not reachable"

The "⚙ Connect API" modal shows the proxy target status. If it says not reachable:

1. Check `DT_API_INTERNAL_URL` in `.env` — it must be the address Nginx inside
   the Docker container can reach, **not** the browser-facing address.
2. For same-Docker-network installs: `http://dtrack-apiserver:8080`
3. For external DT: `http://<host-ip>:<port>` — use the host IP, not `localhost`
4. Restart the dashboard container after any `.env` change:
   ```bash
   docker compose --env-file .env up -d --no-deps dt-dashboard
   ```

### Dashboard shows "projects.map is not a function"

The DependencyTrack API returned an unexpected response shape (e.g. `{}` when
no projects exist yet). The dashboard handles this gracefully — it shows
"Connected — no projects found. Upload an SBOM to get started."
If you still see the error, check your API key has `VIEW_PORTFOLIO` permission.

### Vulnerability database not updating

```bash
docker logs dt-apiserver | grep -i "nvd\|download\|mirror"
```

The initial NVD download can take 30–60 minutes. The API server health check
allows up to 15 minutes (`start_period: 600s`) before marking the container
unhealthy — this is normal on first run.
