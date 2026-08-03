#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
# =============================================================================
# Dependency-Track Risk Dashboard — Installer
# =============================================================================
# Usage:
#   ./install.sh [OPTIONS]
#
# Options:
#   --non-interactive   Skip all prompts and use defaults / .env values
#   --skip-docker-check Skip Docker version validation
#   --uninstall | -u    Remove containers, volumes, and networks (keep images)
#   --all       | -a    Remove containers, volumes, networks, AND images
#   --help              Show this help
# =============================================================================

set -euo pipefail

# ─── Colors & helpers ────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
step()    { echo -e "\n${BOLD}${CYAN}━━━ $* ━━━${RESET}"; }
die()     { error "$*"; exit 1; }

# ─── Retry helper ─────────────────────────────────────────────────────────────
# retry <max_attempts> <initial_delay_seconds> <command...>
# Retries the command with exponential backoff on failure.
retry() {
  local max="$1" delay="$2"; shift 2
  local attempt=1
  until "$@"; do
    if (( attempt >= max )); then
      error "Command failed after $max attempt(s): $*"
      return 1
    fi
    warn "Attempt $attempt/$max failed — retrying in ${delay}s…"
    sleep "$delay"
    delay=$(( delay * 2 ))
    (( attempt++ ))
  done
}

# ─── Uninstall helper ────────────────────────────────────────────────────────
do_uninstall() {
  local remove_images="$1"

  step "Uninstalling Risk Dashboard"

  if ! command -v docker &>/dev/null; then
    die "docker is required but not found"
  fi

  if docker compose version &>/dev/null; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
  else
    die "Docker Compose not found. Install from https://docs.docker.com/compose/install/"
  fi

  local env_args=()
  [[ -f "$SCRIPT_DIR/.env" ]] && env_args=(--env-file "$SCRIPT_DIR/.env")

  echo ""
  echo -e "  ${BOLD}The following will be permanently removed:${RESET}"
  echo -e "    • Containers : dt-dashboard, dt-violation-cache, dt-postgres"
  echo -e "    • Network    : dependency-track"
  echo -e "    • Volumes    : any Docker-managed volumes for these services"
  if [[ "$remove_images" == "true" ]]; then
    echo -e "    • Images     : nginx:alpine, postgres:16-alpine, dt-violation-cache (built image)"
  fi
  echo ""
  echo -e "  ${BOLD}The following are bind mounts and are KEPT on disk:${RESET}"
  echo -e "    • ./violation-cache/pgdata  ${BOLD}(database — all users, settings and reports)${RESET}"
  echo -e "    • ./violation-cache/data    (violation cache, report files, app config)"
  echo -e "    • ./.env                    (configuration, including the DB password)"
  echo -e "  Delete them manually if you intend to discard all data."
  echo ""

  if [[ "$NON_INTERACTIVE" == "false" ]]; then
    read -rp "  Are you sure? This cannot be undone. [y/N]: " _confirm
    if [[ "$_confirm" != "y" && "$_confirm" != "Y" ]]; then
      info "Aborted."
      exit 0
    fi
  fi

  local down_flags=(-v)
  [[ "$remove_images" == "true" ]] && down_flags+=(--rmi all)

  info "Stopping and removing containers, volumes, and networks…"
  $COMPOSE_CMD -f "$SCRIPT_DIR/docker-compose.yml" "${env_args[@]}" down "${down_flags[@]}" \
    || warn "docker compose down reported errors — some resources may already be removed"

  echo ""
  success "Uninstall complete."
  echo ""
  if [[ "$remove_images" == "true" ]]; then
    echo -e "  All containers, networks, and images have been removed."
  else
    echo -e "  All containers and networks have been removed."
    echo -e "  Docker images were kept. To also remove images, run:"
    echo -e "    ${BOLD}./install.sh --all${RESET}"
  fi
  echo ""
  echo -e "  ${YELLOW}Database files were NOT deleted.${RESET}"
  echo -e "  To discard all users, settings and reports as well:"
  echo -e "    ${BOLD}rm -rf ./violation-cache/pgdata ./violation-cache/data${RESET}"
  echo ""
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NON_INTERACTIVE=false
SKIP_DOCKER_CHECK=false
UNINSTALL=false
REMOVE_IMAGES=false

for arg in "$@"; do
  case $arg in
    --non-interactive)   NON_INTERACTIVE=true ;;
    --skip-docker-check) SKIP_DOCKER_CHECK=true ;;
    --uninstall|-u)      UNINSTALL=true ;;
    --all|-a)            UNINSTALL=true; REMOVE_IMAGES=true ;;
    --help)
      sed -n '2,16p' "$0"; exit 0 ;;
    *)
      warn "Unknown option: $arg (ignored)" ;;
  esac
done

# ─── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
cat <<'BANNER'
  +------------------------------------------------------------+
  |                                                            |
  |   Risk Dashboard  --  Docker Installer                     |
  |   Dependency-Track custom risk view + violation cache      |
  |                                                            |
  +------------------------------------------------------------+
BANNER
echo -e "${RESET}"
echo ""

# ─── Uninstall dispatch ──────────────────────────────────────────────────────
if [[ "$UNINSTALL" == "true" ]]; then
  do_uninstall "$REMOVE_IMAGES"
  exit 0
fi

# ─── Step 1 — Prerequisites ──────────────────────────────────────────────────
step "Step 1 — Checking Prerequisites"

check_command() {
  if ! command -v "$1" &>/dev/null; then
    die "$1 is required but not installed. $2"
  fi
  success "$1 found: $(command -v "$1")"
}

check_command docker "Install from https://docs.docker.com/get-docker/"

if [[ "$SKIP_DOCKER_CHECK" == "false" ]]; then
  DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "0.0.0")
  REQUIRED_DOCKER="20.10.0"
  if [[ "$(printf '%s\n' "$REQUIRED_DOCKER" "$DOCKER_VERSION" | sort -V | head -n1)" != "$REQUIRED_DOCKER" ]]; then
    die "Docker >= $REQUIRED_DOCKER required. Found: $DOCKER_VERSION"
  fi
  success "Docker version: $DOCKER_VERSION"
fi

if docker compose version &>/dev/null; then
  COMPOSE_CMD="docker compose"
  success "Docker Compose plugin: $(docker compose version --short)"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_CMD="docker-compose"
  success "docker-compose: $(docker-compose --version)"
else
  die "Docker Compose not found. Install from https://docs.docker.com/compose/install/"
fi

# ─── Step 2 — Configuration ──────────────────────────────────────────────────
step "Step 2 — Configuration"

ENV_FILE="$SCRIPT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  info "No .env file found. Creating from .env.example…"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  success "Created $ENV_FILE"
fi

# Load existing env
set -a; source "$ENV_FILE"; set +a

if [[ "$NON_INTERACTIVE" == "false" ]]; then
  echo ""
  echo -e "${BOLD}Configure the dashboard (press Enter to keep current value):${RESET}"
  echo ""

  read -rp "  Dashboard port               [${DT_DASHBOARD_PORT:-3000}]: " _in
  [[ -n "$_in" ]] && DT_DASHBOARD_PORT="$_in"

  _default_api="${DT_API_INTERNAL_URL:-http://dtrack-apiserver:8080}"
  read -rp "  DependencyTrack API URL      [${_default_api}]: " _in
  [[ -n "$_in" ]] && DT_API_INTERNAL_URL="$_in" || DT_API_INTERNAL_URL="$_default_api"

  DT_FRONTEND_URL="${DT_FRONTEND_URL:-}"
  read -rp "  Configure DT URL for project links? [y/N]: " _in
  if [[ "$_in" == "y" || "$_in" == "Y" || "$_in" == "yes" ]]; then
    read -rp "  DT Frontend URL              [${DT_FRONTEND_URL:-}]: " _in
    [[ -n "$_in" ]] && DT_FRONTEND_URL="$_in"
  fi

  DT_API_KEY="${DT_API_KEY:-}"
  read -rsp "  DependencyTrack API key      [${DT_API_KEY:+(set)}]: " _in
  echo ""
  # Strip control characters (newlines, carriage returns, etc.) from the key
  if [[ -n "$_in" ]]; then
    DT_API_KEY="$(printf '%s' "$_in" | tr -d '\000-\037\177')"
  fi

  # O4: Validate API key against DependencyTrack before saving
  if [[ -n "$DT_API_KEY" && -n "$DT_API_INTERNAL_URL" ]]; then
    info "Validating API key against DependencyTrack…"
    _api_test_url="${DT_API_INTERNAL_URL%/}/api/v1/project?pageSize=1"
    _http_status=$(curl -sk -o /dev/null -w "%{http_code}" \
      -H "X-Api-Key: ${DT_API_KEY}" "$_api_test_url" 2>/dev/null || echo "000")
    if [[ "$_http_status" == "200" ]]; then
      success "API key validated (HTTP 200)"
    elif [[ "$_http_status" == "401" || "$_http_status" == "403" ]]; then
      warn "API key validation failed (HTTP ${_http_status}) — key may be incorrect or lack VIEW_PORTFOLIO permission"
      warn "Continuing anyway; you can update DT_API_KEY in .env after installation"
    elif [[ "$_http_status" == "000" ]]; then
      warn "Could not reach DT API at ${DT_API_INTERNAL_URL} — skipping key validation"
      warn "Ensure DT_API_INTERNAL_URL is reachable from this host, or update .env after install"
    else
      warn "Unexpected HTTP ${_http_status} from DT API — continuing without validation"
    fi
  fi

  # Write back (overwrite only the keys we manage)
  grep -v "^DT_DASHBOARD_PORT=\|^DT_API_INTERNAL_URL=\|^DT_FRONTEND_URL=\|^DT_API_KEY=\|^VIOLATION_CACHE_TTL_HOURS=" \
    "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
  printf 'DT_DASHBOARD_PORT=%s\nDT_API_INTERNAL_URL=%s\nDT_FRONTEND_URL=%s\nDT_API_KEY=%s\nVIOLATION_CACHE_TTL_HOURS=%s\n' \
    "${DT_DASHBOARD_PORT:-3000}" \
    "${DT_API_INTERNAL_URL}" \
    "${DT_FRONTEND_URL:-}" \
    "${DT_API_KEY:-}" \
    "${VIOLATION_CACHE_TTL_HOURS:-24}" >> "$ENV_FILE"

  success ".env saved"
fi

# ─── Database credentials ────────────────────────────────────────────────────
# Generated once and never rotated automatically: changing POSTGRES_PASSWORD
# after the data directory exists would leave the service unable to connect,
# because PostgreSQL only reads POSTGRES_PASSWORD when it initialises the
# cluster on first start.
if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  info "Generating a PostgreSQL password…"
  if command -v openssl &>/dev/null; then
    _pg_pass="$(openssl rand -base64 32 | tr -d '/+=\n' | cut -c1-32)"
  else
    _pg_pass="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  grep -v "^POSTGRES_PASSWORD=" "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
  printf 'POSTGRES_PASSWORD=%s\n' "$_pg_pass" >> "$ENV_FILE"
  unset _pg_pass
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  success "POSTGRES_PASSWORD generated and saved to .env"
else
  info "POSTGRES_PASSWORD already set — leaving it unchanged"
fi

# ─── Secret encryption key ───────────────────────────────────────────────────
# Protects DT API keys and SMTP passwords at rest (AES-256-GCM). Losing or
# rotating it makes every stored secret undecryptable, so it is generated once
# and never replaced automatically.
if [[ -z "${SECRET_ENCRYPTION_KEY:-}" ]]; then
  info "Generating a secret encryption key…"
  if command -v openssl &>/dev/null; then
    _enc_key="$(openssl rand -hex 32)"
  else
    _enc_key="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  grep -v "^SECRET_ENCRYPTION_KEY=" "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
  printf 'SECRET_ENCRYPTION_KEY=%s\n' "$_enc_key" >> "$ENV_FILE"
  unset _enc_key
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  success "SECRET_ENCRYPTION_KEY generated and saved to .env"
  warn "Back up .env — losing this key makes stored API keys and SMTP passwords unrecoverable."
else
  info "SECRET_ENCRYPTION_KEY already set — leaving it unchanged"
fi

# ─── Administrator account ───────────────────────────────────────────────────
# The administrator is authenticated against this file, never against the
# database, so a database user cannot impersonate it. The service never creates
# the file itself: if it is missing, administrator login is simply disabled.
ADMIN_CREDS_DIR="$SCRIPT_DIR/violation-cache/data"
ADMIN_CREDS_FILE="$ADMIN_CREDS_DIR/admin-credentials.json"

if [[ -f "$ADMIN_CREDS_FILE" ]]; then
  info "Administrator credentials already exist — leaving them unchanged"
  info "  To reset: delete $ADMIN_CREDS_FILE and re-run this installer"
else
  step "Creating the administrator account"

  _admin_user="${SCA_ADMIN_USER:-admin}"
  _admin_pass="${SCA_ADMIN_PASSWORD:-}"

  if [[ "$NON_INTERACTIVE" == "false" && -z "$_admin_pass" ]]; then
    read -rp "  Administrator login ID       [${_admin_user}]: " _in
    [[ -n "$_in" ]] && _admin_user="$_in"
    read -rsp "  Administrator password       [use default]: " _in
    echo ""
    [[ -n "$_in" ]] && _admin_pass="$(printf '%s' "$_in" | tr -d '\000-\037\177')"
  fi

  if [[ -z "$_admin_pass" ]]; then
    _admin_pass="ScaAdmin@dt8624"
    warn "Using the default administrator password. Change it after signing in."
  fi

  mkdir -p "$ADMIN_CREDS_DIR"

  # Hashed with the same scrypt parameters the service uses, by calling the
  # service's own module — so the installer can never drift from it.
  if ! ADMIN_USER="$_admin_user" ADMIN_PASS="$_admin_pass" \
       node -e '
         const { hashPassword } = require("./violation-cache/lib/crypto");
         hashPassword(process.env.ADMIN_PASS).then(h => {
           process.stdout.write(JSON.stringify({
             loginId: process.env.ADMIN_USER,
             passwordHash: h,
             createdAt: new Date().toISOString(),
           }, null, 2));
         }).catch(e => { console.error(e.message); process.exit(1); });
       ' > "${ADMIN_CREDS_FILE}.tmp" 2>/dev/null; then
    rm -f "${ADMIN_CREDS_FILE}.tmp"
    die "Could not create administrator credentials. Node.js 18+ must be installed to run the installer."
  fi

  mv "${ADMIN_CREDS_FILE}.tmp" "$ADMIN_CREDS_FILE"
  chmod 600 "$ADMIN_CREDS_FILE"
  unset _admin_pass
  success "Administrator account created: ${_admin_user}"
  info "  Stored at $ADMIN_CREDS_FILE (mode 0600, password hashed with scrypt)"
fi

# Re-load finalized env
set -a; source "$ENV_FILE"; set +a

# ─── Step 3 — Pull base images ───────────────────────────────────────────────
step "Step 3 — Pulling Base Images"
retry 4 2 \
  $COMPOSE_CMD -f "$SCRIPT_DIR/docker-compose.yml" --env-file "$ENV_FILE" \
    pull dt-dashboard dt-postgres
success "nginx:alpine and postgres:16-alpine pulled"

# ─── Step 4 — Build violation cache service ───────────────────────────────────
step "Step 4 — Building Violation Cache Service"
retry 3 5 \
  $COMPOSE_CMD -f "$SCRIPT_DIR/docker-compose.yml" --env-file "$ENV_FILE" \
    build dt-violation-cache
success "Violation cache image built"

# ─── Step 5 — Start services ─────────────────────────────────────────────────
# --no-deps is deliberately NOT used: dt-violation-cache declares a health-gated
# dependency on dt-postgres, and it must not start before migrations can run.
step "Step 5 — Starting Services"
retry 3 5 \
  $COMPOSE_CMD -f "$SCRIPT_DIR/docker-compose.yml" --env-file "$ENV_FILE" \
    up -d dt-postgres dt-dashboard dt-violation-cache
success "Containers started"

info "Waiting for the database to accept connections…"
_db_ready=false
for _i in $(seq 1 30); do
  if $COMPOSE_CMD -f "$SCRIPT_DIR/docker-compose.yml" --env-file "$ENV_FILE" \
       exec -T dt-postgres pg_isready -U "${POSTGRES_USER:-dtdash}" &>/dev/null; then
    _db_ready=true; break
  fi
  sleep 2
done
if [[ "$_db_ready" == "true" ]]; then
  success "Database ready — schema migrations run automatically at service start"
else
  warn "Database did not report ready within 60s. Check: docker logs dt-postgres"
fi

# ─── Step 6 — Summary ────────────────────────────────────────────────────────
step "Installation Complete!"
echo ""
echo -e "  ${BOLD}Risk Dashboard${RESET}  → http://localhost:${DT_DASHBOARD_PORT:-3000}"
echo -e "  ${BOLD}Proxying to${RESET}     → ${DT_API_INTERNAL_URL:-http://dtrack-apiserver:8080}"
echo ""
if [[ -z "${DT_API_KEY:-}" ]]; then
  echo -e "  ${YELLOW}No API key configured.${RESET}"
  echo -e "  Open the dashboard and click ${BOLD}⚙ Connect API${RESET} to enter your key."
  echo -e "  Or add ${BOLD}DT_API_KEY=<your-key>${RESET} to .env and run:"
  echo -e "    docker compose restart dt-dashboard dt-violation-cache"
else
  echo -e "  ${GREEN}API key configured — dashboard will auto-connect on open.${RESET}"
fi
echo ""
echo -e "  ${BOLD}Docs:${RESET}  ./docs/INSTALLATION.md"
echo ""
success "Done!"
