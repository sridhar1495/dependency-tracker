# Dependency-Track — Risk Dashboard

A **portfolio-level risk dashboard** for [DependencyTrack](https://dependencytrack.org/) that displays hierarchical project security and policy violation data in a single filterable view.

> **This project is a dashboard only.** It connects to an existing DependencyTrack instance — it does not include or install DependencyTrack itself.

---

## Quick Start

```bash
git clone <repo-url> dependency-tracker
cd dependency-tracker
chmod +x install.sh
./install.sh
```

The installer prompts for your DependencyTrack API URL and (optionally) an API key, then starts the dashboard at **http://localhost:3000**.

---

## What's Included

| Component | Description |
|-----------|-------------|
| `dashboard/index.html` | Single-file SPA dashboard (zero npm dependencies) |
| `dashboard/nginx.conf.template` | nginx config with API proxy and violation-cache proxy |
| `violation-cache/server.js` | Node.js service that pre-fetches policy violations server-side |
| `violation-cache/Dockerfile` | Builds the cache service image |
| `docker-compose.yml` | Defines `dt-dashboard` (nginx) and `dt-violation-cache` |
| `install.sh` | Interactive installer |
| `.env.example` | Environment variable reference |

---

## Docker Stack

| Container | Image | Purpose |
|-----------|-------|---------|
| `dt-dashboard` | `nginx:alpine` | Serves the dashboard SPA; proxies `/api/*` to your DT instance |
| `dt-violation-cache` | Built locally | Fetches and caches policy violations server-side |

---

## Installer Options

```bash
./install.sh [OPTIONS]
```

| Flag | Description |
|------|-------------|
| _(none)_ | Interactive install — prompts for all settings |
| `--non-interactive` | Skip prompts, use `.env` values / defaults |
| `--skip-docker-check` | Skip Docker version validation |
| `--uninstall` / `-u` | Remove containers and network (keep images) |
| `--all` / `-a` | Remove containers, network, and images |
| `--help` | Show usage |

---

## Configuration

Copy `.env.example` to `.env` and set:

| Variable | Description |
|----------|-------------|
| `DT_API_INTERNAL_URL` | Your DependencyTrack API URL (nginx proxy target) |
| `DT_API_KEY` | API key for auto-connect and server-side violation fetch |
| `DT_FRONTEND_URL` | DT web UI URL for clickable project links (optional) |
| `DT_DASHBOARD_PORT` | Host port for the dashboard (default `3000`) |
| `VIOLATION_CACHE_TTL_HOURS` | Hours before violation cache auto-expires (default `24`) |

---

## Tech Stack

- **Dashboard**: HTML5, CSS3, Vanilla JS (ES2020+), Fetch API
- **Violation cache**: Node.js 18 (zero npm dependencies), built-in `http`/`https`
- **Infrastructure**: nginx:alpine, Docker Compose

---

## Docs

- [Installation Guide](docs/INSTALLATION.md)
- [Dashboard Integration Guide](docs/DASHBOARD_INTEGRATION.md)
