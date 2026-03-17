#!/usr/bin/env bash
# =============================================================================
# Dependency-Track Community Edition — Automated Installer
# =============================================================================
# Usage:
#   ./install.sh [OPTIONS]
#
# Options:
#   --non-interactive   Skip all prompts and use defaults / .env values
#   --skip-docker-check Skip Docker version validation
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
# Example: retry 4 2 docker compose pull
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
    delay=$(( delay * 2 ))   # exponential backoff: 2 → 4 → 8 → 16 s
    (( attempt++ ))
  done
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NON_INTERACTIVE=false
SKIP_DOCKER_CHECK=false

for arg in "$@"; do
  case $arg in
    --non-interactive) NON_INTERACTIVE=true ;;
    --skip-docker-check) SKIP_DOCKER_CHECK=true ;;
    --help)
      sed -n '2,18p' "$0"; exit 0 ;;
  esac
done

# ─── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
cat <<'BANNER'
  ____                 _____               _
 |  _ \  ___ _ __   |_   _| __ __ _  ___| | __
 | | | |/ _ \ '_ \    | || '__/ _` |/ __| |/ /
 | |_| |  __/ |_) |   | || | | (_| | (__|   <
 |____/ \___| .__/    |_||_|  \__,_|\___|_|\_\
            |_|
   Community Edition — Docker Installer
BANNER
echo -e "${RESET}"
echo -e "  ${BOLD}Repository:${RESET} https://github.com/DependencyTrack/dependency-track"
echo -e "  ${BOLD}Docs:${RESET}       https://docs.dependencytrack.org"
echo ""

# ─── Step 1 — Prerequisites ──────────────────────────────────────────────────
step "Step 1 — Checking Prerequisites"

check_command() {
  if ! command -v "$1" &>/dev/null; then
    die "$1 is required but not installed. $2"
  fi
  success "$1 found: $(command -v "$1")"
}

check_command docker  "Install from https://docs.docker.com/get-docker/"
check_command curl    "Install with: sudo apt install curl / brew install curl"
check_command jq      "Install with: sudo apt install jq / brew install jq"

if [[ "$SKIP_DOCKER_CHECK" == "false" ]]; then
  DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "0.0.0")
  REQUIRED_DOCKER="20.10.0"
  if [[ "$(printf '%s\n' "$REQUIRED_DOCKER" "$DOCKER_VERSION" | sort -V | head -n1)" != "$REQUIRED_DOCKER" ]]; then
    die "Docker >= $REQUIRED_DOCKER required. Found: $DOCKER_VERSION"
  fi
  success "Docker version: $DOCKER_VERSION"
fi

# Docker Compose (plugin or standalone)
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
  echo -e "${BOLD}Configure your installation (press Enter to keep current value):${RESET}"
  echo ""

  # Host (used as browser-side API URL — must be reachable from the user's browser)
  _default_host="${DT_HOST:-localhost}"
  read -rp "  Server hostname or IP        [${_default_host}]: " _in
  [[ -n "$_in" ]] && DT_HOST="$_in" || DT_HOST="$_default_host"

  # Ports
  read -rp "  DependencyTrack UI port      [${DT_FRONTEND_PORT:-8080}]: " _in
  [[ -n "$_in" ]] && DT_FRONTEND_PORT="$_in"

  read -rp "  DependencyTrack API port     [${DT_API_PORT:-8081}]: " _in
  [[ -n "$_in" ]] && DT_API_PORT="$_in"

  read -rp "  Custom Dashboard port        [${DT_DASHBOARD_PORT:-3000}]: " _in
  [[ -n "$_in" ]] && DT_DASHBOARD_PORT="$_in"

  # Database password
  read -rsp "  PostgreSQL password          [${POSTGRES_PASSWORD:-dtrack_password_change_me}]: " _in
  echo ""
  [[ -n "$_in" ]] && POSTGRES_PASSWORD="$_in"

  # Admin credentials
  read -rp "  DependencyTrack admin user   [${DT_ADMIN_USER:-admin}]: " _in
  [[ -n "$_in" ]] && DT_ADMIN_USER="$_in"

  read -rsp "  DependencyTrack admin pass   [${DT_ADMIN_PASS:-admin}]: " _in
  echo ""
  [[ -n "$_in" ]] && DT_ADMIN_PASS="$_in"

  # Write back
  cat > "$ENV_FILE" <<ENVFILE
DT_VERSION=${DT_VERSION:-latest}
DT_HOST=${DT_HOST:-localhost}
DT_FRONTEND_PORT=${DT_FRONTEND_PORT:-8080}
DT_API_PORT=${DT_API_PORT:-8081}
DT_DASHBOARD_PORT=${DT_DASHBOARD_PORT:-3000}
POSTGRES_DB=${POSTGRES_DB:-dtrack}
POSTGRES_USER=${POSTGRES_USER:-dtrack}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
DT_ADMIN_USER=${DT_ADMIN_USER:-admin}
DT_ADMIN_PASS=${DT_ADMIN_PASS}
DT_API_URL=http://localhost:${DT_API_PORT:-8081}
ENVFILE
  success ".env saved"
fi

# Re-load finalized env
set -a; source "$ENV_FILE"; set +a

# ─── Step 3 — Pull images ────────────────────────────────────────────────────
step "Step 3 — Pulling Docker Images"
# Retry up to 4 times with exponential backoff (2 s, 4 s, 8 s) for network blips.
retry 4 2 \
  $COMPOSE_CMD -f "$SCRIPT_DIR/docker-compose.yml" --env-file "$ENV_FILE" pull
success "Images pulled"

# ─── Step 4 — Start services ─────────────────────────────────────────────────
step "Step 4 — Starting Services"
# Retry up to 3 times in case the Docker daemon returns a transient error.
retry 3 5 \
  $COMPOSE_CMD -f "$SCRIPT_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d
success "Containers started"

# ─── Step 5 — Wait for API server ────────────────────────────────────────────
step "Step 5 — Waiting for DependencyTrack API Server"
API_URL="${DT_API_URL:-http://localhost:8081}"
# First-run NVD database download can take 5–15 min; allow up to 15 min total.
MAX_WAIT=900
WAITED=0
INTERVAL=15

info "API URL: $API_URL  (timeout: ${MAX_WAIT}s — first run may take up to 15 min)"
until curl -sf "${API_URL}/api/version" -o /dev/null 2>/dev/null; do
  if (( WAITED >= MAX_WAIT )); then
    error "API server did not respond within ${MAX_WAIT}s"
    warn "Check logs: docker logs dt-apiserver"
    die "Installation aborted — is the container still running? (docker ps)"
  fi
  echo -ne "  Waiting… ${WAITED}s / ${MAX_WAIT}s\r"
  sleep "$INTERVAL"
  WAITED=$(( WAITED + INTERVAL ))
done
echo ""
success "API server is up!"

# ─── Step 6 — Change default admin password ──────────────────────────────────
step "Step 6 — Bootstrapping Admin Account"

ADMIN_USER="${DT_ADMIN_USER:-admin}"
ADMIN_PASS="${DT_ADMIN_PASS:-admin}"
DEFAULT_PASS="admin"

info "Attempting to change default admin password…"
# Retry up to 4 times (2 s, 4 s, 8 s) — the API may still be settling.
_change_pass() {
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${API_URL}/api/v1/user/forceChangePassword" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "username=${ADMIN_USER}" \
    --data-urlencode "password=${DEFAULT_PASS}" \
    --data-urlencode "newPassword=${ADMIN_PASS}" \
    --data-urlencode "confirmPassword=${ADMIN_PASS}" 2>/dev/null || echo "000")
  # Treat 200 (changed) and 401 (already changed) as success for retry purposes
  [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "401" ]]
}
if retry 4 2 _change_pass; then
  if [[ "$HTTP_STATUS" == "200" ]]; then
    success "Admin password updated"
  else
    warn "Password already changed (HTTP 401) — continuing"
  fi
else
  warn "Password change returned HTTP $HTTP_STATUS — update manually in the UI"
fi

# ─── Step 7 — Validate API Key ───────────────────────────────────────────────
step "Step 7 — Verifying API Key"

# Retry fetching the API key up to 4 times — auth may lag slightly after a
# password change.
API_KEY=""
_fetch_key() {
  API_KEY=$(curl -sf \
    -u "${ADMIN_USER}:${ADMIN_PASS}" \
    "${API_URL}/api/v1/team" 2>/dev/null \
    | jq -r '.[0].apiKeys[0].key // empty' 2>/dev/null || echo "")
  [[ -n "$API_KEY" ]]
}
if retry 4 2 _fetch_key; then
  grep -v "^DT_API_KEY=" "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
  echo "DT_API_KEY=${API_KEY}" >> "$ENV_FILE"
  success "API key saved to .env"
else
  warn "Could not retrieve API key automatically. Log in to the UI and create one manually."
fi

# ─── Step 8 — Print Summary ──────────────────────────────────────────────────
step "Installation Complete!"
echo ""
echo -e "  ${BOLD}DependencyTrack UI${RESET}      → http://localhost:${DT_FRONTEND_PORT:-8080}"
echo -e "  ${BOLD}DependencyTrack API${RESET}     → ${API_URL}/api/version"
echo -e "  ${BOLD}Custom Dashboard${RESET}        → http://localhost:${DT_DASHBOARD_PORT:-3000}"
echo ""
echo -e "  ${BOLD}Admin login${RESET}             → ${ADMIN_USER} / [password set during install]"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo -e "    1. Open http://localhost:${DT_FRONTEND_PORT:-8080} and confirm login"
echo -e "    2. Create additional users:  ./scripts/create-user.sh --help"
echo -e "    3. Add projects via SBOM:    ./scripts/upload-sbom.sh --help"
echo -e "    4. View risk dashboard:      http://localhost:${DT_DASHBOARD_PORT:-3000}"
echo -e "    5. Full docs:                ./docs/INSTALLATION.md"
echo ""
success "Done! Enjoy Dependency-Track CE."
