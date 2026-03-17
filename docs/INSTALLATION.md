# Dependency-Track CE — Installation Guide

## Table of Contents
1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Quick Install (Recommended)](#3-quick-install-recommended)
4. [Manual Installation](#4-manual-installation)
5. [Configuration Reference](#5-configuration-reference)
6. [Verifying Your Installation](#6-verifying-your-installation)
7. [Accessing the Applications](#7-accessing-the-applications)
8. [Managing the Stack](#8-managing-the-stack)
9. [Upgrading](#9-upgrading)
10. [Uninstall](#10-uninstall)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Overview

This installer deploys **OWASP Dependency-Track Community Edition** using Docker
Compose. The stack includes:

| Container        | Role                                        | Default Port |
|------------------|---------------------------------------------|-------------|
| `dt-postgres`    | PostgreSQL 15 database                      | internal    |
| `dt-apiserver`   | DependencyTrack REST API & analysis engine  | 8081        |
| `dt-frontend`    | DependencyTrack web UI (Vue.js)             | 8080        |
| `dt-dashboard`   | Custom risk dashboard (Nginx + static HTML) | 3000        |

**DependencyTrack** is an intelligent Software Composition Analysis (SCA)
platform that allows organisations to continuously identify and reduce risk from
the use of third-party and open source components. See
[docs.dependencytrack.org](https://docs.dependencytrack.org) for upstream docs.

---

## 2. Prerequisites

| Requirement | Minimum Version | Check Command                          |
|-------------|-----------------|----------------------------------------|
| Docker      | 20.10.0         | `docker version`                       |
| Docker Compose | Plugin ≥ 2 or standalone ≥ 1.29 | `docker compose version` |
| curl        | any             | `curl --version`                       |
| jq          | any             | `jq --version`                         |
| Free RAM    | 4 GB (8 GB recommended) | `free -h`                    |
| Free disk   | 10 GB           | `df -h .`                              |

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

## 3. Quick Install (Recommended)

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
- ✅ Pull Docker images
- ✅ Start all containers
- ✅ Wait for the API server to be ready (up to 3 minutes)
- ✅ Change the default admin password
- ✅ Print access URLs

### Non-interactive install

For CI/CD or automated deployments, pre-populate `.env` and pass the flag:

```bash
cp .env.example .env
# Edit .env with your values, then:
./install.sh --non-interactive
```

---

## 4. Manual Installation

If you prefer to run each step yourself:

### Step 4.1 — Copy and edit the environment file

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

### Step 4.2 — Pull Docker images

```bash
docker compose --env-file .env pull
```

### Step 4.3 — Start the stack

```bash
docker compose --env-file .env up -d
```

### Step 4.4 — Monitor startup

The API server can take **2–5 minutes** on first launch because it:
- Runs Liquibase database migrations
- Downloads vulnerability databases (NVD, GitHub Advisories, OSS Index)

```bash
# Follow API server logs
docker logs -f dt-apiserver

# Or check health status
docker compose ps
```

Wait until you see:
```
INFO  o.d.c.tasks.LdapSyncTask - Synchronization complete
INFO  o.dependencytrack.common.ManagedHttpClientFactory - ...
```

### Step 4.5 — Change the default admin password

Browse to `http://localhost:8080` → log in as `admin` / `admin`
→ you will be prompted to set a new password.

---

## 5. Configuration Reference

All configuration is done via the `.env` file.

| Variable              | Default                   | Description                                          |
|-----------------------|---------------------------|------------------------------------------------------|
| `DT_VERSION`          | `latest`                  | DependencyTrack Docker image tag (e.g. `4.11.4`)     |
| `DT_FRONTEND_PORT`    | `8080`                    | Port for the web UI                                  |
| `DT_API_PORT`         | `8081`                    | Port for the REST API                                |
| `DT_DASHBOARD_PORT`   | `3000`                    | Port for the custom risk dashboard                   |
| `POSTGRES_DB`         | `dtrack`                  | Database name                                        |
| `POSTGRES_USER`       | `dtrack`                  | Database user                                        |
| `POSTGRES_PASSWORD`   | `dtrack_password_change_me` | **Change this before deploying!**                  |
| `DT_ADMIN_USER`       | `admin`                   | Initial admin username                               |
| `DT_ADMIN_PASS`       | `admin`                   | Initial admin password — **change immediately!**     |
| `DT_API_URL`          | `http://localhost:8081`   | API base URL used by helper scripts                  |
| `DT_API_KEY`          | _(auto-populated)_        | Written by install.sh after first login              |

### Advanced API Server Options

The API server is configured via environment variables in `docker-compose.yml`.
Common overrides (add to the `dtrack-apiserver` → `environment` block):

```yaml
# Increase memory (default limit is 12g)
# Reduce if you have less RAM:
ALPINE_METRICS_ENABLED: "true"            # Enable Prometheus /metrics endpoint
ALPINE_CORS_ENABLED: "true"               # Allow cross-origin requests
ALPINE_CORS_ALLOW_ORIGIN: "*"
```

See the full reference at:
https://docs.dependencytrack.org/getting-started/configuration/

---

## 6. Verifying Your Installation

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

## 7. Accessing the Applications

| Application           | URL                              | Default Credentials   |
|-----------------------|----------------------------------|-----------------------|
| DependencyTrack UI    | http://localhost:8080            | admin / *(your pass)* |
| DependencyTrack API   | http://localhost:8081/api/version | API key required      |
| Custom Risk Dashboard | http://localhost:3000            | No auth required      |
| API Swagger Docs      | http://localhost:8081/api/swagger.json | —              |

---

## 8. Managing the Stack

```bash
# Stop all containers (data is preserved)
docker compose down

# Start again
docker compose --env-file .env up -d

# Restart a single service
docker compose restart dtrack-apiserver

# View logs
docker logs dt-apiserver -f
docker logs dt-frontend -f
docker logs dt-dashboard -f

# View resource usage
docker stats
```

---

## 9. Upgrading

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

## 10. Uninstall

```bash
# Stop and remove containers + networks (data volumes are preserved)
docker compose down

# PERMANENT: also remove all data volumes
docker compose down -v
docker volume rm dependency-tracker_dependency-track-data dependency-tracker_postgres-data
```

---

## 11. Troubleshooting

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

### Dashboard shows CORS errors

The Nginx reverse proxy in `dt-dashboard` proxies `/api/*` to the API server,
avoiding CORS issues. If you run the dashboard outside Docker, you need to either:
1. Enable CORS in the API server (`ALPINE_CORS_ENABLED: "true"`)
2. Or set the API URL to the direct API server address in the dashboard modal

### Vulnerability database not updating

```bash
docker exec dt-apiserver wget -qO- http://localhost:8080/api/v1/vulnerability/source/NVD \
  -H "X-Api-Key: <your-key>"
```

The initial NVD download can take 30–60 minutes. Check:
```bash
docker logs dt-apiserver | grep -i "nvd\|download\|mirror"
```
