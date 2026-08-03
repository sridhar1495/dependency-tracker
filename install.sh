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
#   --uninstall | -u    Remove containers and the network. KEEPS all data on disk
#                       (database, administrator credentials, .env) and keeps images
#   --all       | -a    Remove containers, the network and images, AND DELETE the
#                       data directories. Every user, setting and report is destroyed
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
# Two distinct levels, because "I am done with this container" and "erase every
# account, report and setting" are very different intentions:
#
#   --uninstall  containers + network. All data directories are KEPT, so
#                re-running install.sh brings the same database back.
#   --all        the above, plus images, plus the data directories themselves.
#                This is irreversible.
#
# `docker compose down -v` is deliberately NOT used at the plain --uninstall
# level: -v removes volumes, and the intent there is that nothing on disk is
# lost. The data directories are bind mounts (CLAUDE.md §9.2), so they survive
# either way, but the flag would still say the opposite of what we mean.
do_uninstall() {
  local remove_all="$1"

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

  # Named explicitly so the banner can never drift from what is actually removed.
  local pgdata_dir="$SCRIPT_DIR/violation-cache/pgdata"
  local data_dir="$SCRIPT_DIR/violation-cache/data"

  echo ""
  echo -e "  ${BOLD}Containers${RESET} : dt-dashboard, dt-violation-cache, dt-postgres"
  echo -e "  ${BOLD}Network${RESET}    : dependency-track"
  echo ""

  if [[ "$remove_all" == "true" ]]; then
    echo -e "  ${RED}${BOLD}FULL UNINSTALL — the following will be PERMANENTLY DELETED:${RESET}"
    echo -e "    ${RED}•${RESET} ${pgdata_dir}"
    echo -e "      ${BOLD}the database: every user account, setting, schedule and report${RESET}"
    echo -e "    ${RED}•${RESET} ${data_dir}"
    echo -e "      the administrator credentials file"
    echo -e "    ${RED}•${RESET} Images: nginx:alpine, postgres:16-alpine, and the built backend image"
    echo ""
    echo -e "  ${BOLD}Kept:${RESET} ./.env — it still holds POSTGRES_PASSWORD and SECRET_ENCRYPTION_KEY,"
    echo -e "  which a fresh install will reuse. Delete it yourself if you want a clean slate."
    echo ""
    if [[ "$NON_INTERACTIVE" == "false" ]]; then
      echo -e "  ${YELLOW}This cannot be undone.${RESET} Type ${BOLD}DELETE${RESET} to confirm, or anything else to abort."
      read -rp "  > " _confirm
      if [[ "$_confirm" != "DELETE" ]]; then
        info "Aborted. Nothing was removed."
        exit 0
      fi
    else
      warn "--non-interactive --all: deleting all data without confirmation."
    fi
  else
    echo -e "  ${GREEN}${BOLD}Your data is KEPT:${RESET}"
    echo -e "    ${GREEN}•${RESET} ${pgdata_dir}"
    echo -e "      the database: users, settings, schedules and reports"
    echo -e "    ${GREEN}•${RESET} ${data_dir}"
    echo -e "      the administrator credentials file"
    echo -e "    ${GREEN}•${RESET} ./.env"
    echo -e "  Re-running ./install.sh restores the service with all of it intact."
    echo ""
    echo -e "  Docker images are kept too. To remove everything including the data, run:"
    echo -e "    ${BOLD}./install.sh --all${RESET}"
    echo ""
    if [[ "$NON_INTERACTIVE" == "false" ]]; then
      read -rp "  Remove the containers and network? [y/N]: " _confirm
      if [[ "$_confirm" != "y" && "$_confirm" != "Y" ]]; then
        info "Aborted."
        exit 0
      fi
    fi
  fi

  local down_flags=()
  if [[ "$remove_all" == "true" ]]; then
    # -v only matters if a future service ever declares an anonymous volume;
    # at the full level removing it is what the operator asked for.
    down_flags+=(-v --rmi all)
  fi

  info "Stopping and removing containers and the network…"
  $COMPOSE_CMD -f "$SCRIPT_DIR/docker-compose.yml" "${env_args[@]}" down "${down_flags[@]}" \
    || warn "docker compose down reported errors — some resources may already be removed"

  if [[ "$remove_all" == "true" ]]; then
    # ${VAR:?} refuses to expand when the variable is empty, so a bug that blanked
    # SCRIPT_DIR can never turn this into `rm -rf /violation-cache/pgdata`.
    info "Deleting data directories…"
    rm -rf "${SCRIPT_DIR:?}/violation-cache/pgdata"
    rm -rf "${SCRIPT_DIR:?}/violation-cache/data"
    success "Data directories deleted"
  fi

  echo ""
  success "Uninstall complete."
  echo ""
  if [[ "$remove_all" == "true" ]]; then
    echo -e "  Containers, network, images and all data have been removed."
    echo -e "  ./.env was kept; delete it manually to discard the generated secrets too."
  else
    echo -e "  Containers and the network have been removed. Images and data were kept."
    echo -e "  Bring it back with: ${BOLD}./install.sh${RESET}"
  fi
  echo ""
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NON_INTERACTIVE=false
SKIP_DOCKER_CHECK=false
UNINSTALL=false
REMOVE_ALL=false

for arg in "$@"; do
  case $arg in
    --non-interactive)   NON_INTERACTIVE=true ;;
    --skip-docker-check) SKIP_DOCKER_CHECK=true ;;
    --uninstall|-u)      UNINSTALL=true ;;
    --all|-a)            UNINSTALL=true; REMOVE_ALL=true ;;
    --help)
      sed -n '2,19p' "$0"; exit 0 ;;
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
  do_uninstall "$REMOVE_ALL"
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

# Node.js is OPTIONAL. It is only used to hash the administrator password, and
# the installer falls back to a container when it is missing or too old. Report
# it so the chosen path is visible rather than surprising.
if command -v node &>/dev/null; then
  _probe_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$_probe_major" =~ ^[0-9]+$ ]] && [[ "$_probe_major" -ge 18 ]]; then
    success "Node.js (optional): $(node -v) — will be used to hash the admin password"
  else
    info "Node.js (optional): $(node -v 2>/dev/null || echo 'unknown') is older than v18 — a container will be used instead"
  fi
else
  info "Node.js (optional): not installed — a container will be used to hash the admin password"
fi
unset _probe_major

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

  # The DependencyTrack connection is NOT asked for here any more. It belongs to
  # each account and is entered in the dashboard after signing in, encrypted at
  # rest with SECRET_ENCRYPTION_KEY (CLAUDE.md §5.6, §7.6).

  # ── Database credentials ──────────────────────────────────────────────
  # Always asked. PostgreSQL reads POSTGRES_USER, POSTGRES_PASSWORD and
  # POSTGRES_DB only when it initialises its data directory, so on a rebuild
  # a changed answer would not reach the running cluster and the service would
  # then fail to connect. Rather than skipping the questions — which leaves an
  # operator wondering why they were never asked — the prompts are always shown
  # and a value that cannot take effect is challenged before it is written.
  _pg_existing=false
  if [[ -d "$SCRIPT_DIR/violation-cache/pgdata" ]] && [[ -n "$(ls -A "$SCRIPT_DIR/violation-cache/pgdata" 2>/dev/null)" ]]; then
    _pg_existing=true
    echo ""
    info "An existing database was found at ./violation-cache/pgdata."
    info "  Its credentials were fixed when it was first created. You can review them"
    info "  below; changing one needs the database to be recreated, which erases it."
  fi

  _pg_user_before="${POSTGRES_USER:-dtdash}"
  _pg_db_before="${POSTGRES_DB:-dtdash}"

  read -rp "  PostgreSQL username          [${_pg_user_before}]: " _in
  [[ -n "$_in" ]] && POSTGRES_USER="$_in"
  POSTGRES_USER="${POSTGRES_USER:-dtdash}"

  read -rsp "  PostgreSQL password          [$([[ -n "${POSTGRES_PASSWORD:-}" ]] && echo 'keep current' || echo 'generate a strong one')]: " _in
  echo ""
  if [[ -n "$_in" ]]; then
    _pg_pass_new="$(printf '%s' "$_in" | tr -d '\000-\037\177')"
  fi

  read -rp "  PostgreSQL database name     [${_pg_db_before}]: " _in
  [[ -n "$_in" ]] && POSTGRES_DB="$_in"
  POSTGRES_DB="${POSTGRES_DB:-dtdash}"

  if [[ "$_pg_existing" == "true" ]]; then
    # Only challenge answers that actually differ — pressing Enter through the
    # prompts must stay silent and change nothing.
    _pg_changed=()
    [[ "$POSTGRES_USER" != "$_pg_user_before" ]] && _pg_changed+=("username")
    [[ "$POSTGRES_DB"   != "$_pg_db_before"   ]] && _pg_changed+=("database name")
    [[ -n "${_pg_pass_new:-}" && "${_pg_pass_new}" != "${POSTGRES_PASSWORD:-}" ]] && _pg_changed+=("password")

    if (( ${#_pg_changed[@]} > 0 )); then
      echo ""
      warn "You changed the PostgreSQL ${_pg_changed[*]}, but a database already exists."
      warn "PostgreSQL only reads these when it creates its data directory, so the running"
      warn "database would keep its old values and the service would fail to connect."
      echo ""
      echo -e "  To actually change them you must delete ${BOLD}./violation-cache/pgdata${RESET},"
      echo -e "  which ${BOLD}permanently erases every account, setting and report${RESET}."
      echo ""
      read -rp "  Write the new values anyway? [y/N]: " _in
      if [[ "$_in" == "y" || "$_in" == "Y" ]]; then
        warn "Writing them. The service will not start until ./violation-cache/pgdata is deleted."
        [[ -n "${_pg_pass_new:-}" ]] && POSTGRES_PASSWORD="$_pg_pass_new"
      else
        POSTGRES_USER="$_pg_user_before"
        POSTGRES_DB="$_pg_db_before"
        _pg_pass_new=""
        info "Keeping the existing database credentials."
      fi
    else
      [[ -n "${_pg_pass_new:-}" ]] && POSTGRES_PASSWORD="$_pg_pass_new"
    fi
  else
    if [[ -n "${_pg_pass_new:-}" ]]; then
      POSTGRES_PASSWORD="$_pg_pass_new"
      _pg_pass_source="chosen during installation"
    fi
  fi
  unset _pg_pass_new

  # Write back (overwrite only the keys we manage). Any legacy DT_* values
  # already in the file are left untouched so an upgrade can still seed them.
  grep -v "^DT_DASHBOARD_PORT=\|^VIOLATION_CACHE_TTL_HOURS=\|^POSTGRES_USER=\|^POSTGRES_DB=" \
    "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
  printf 'DT_DASHBOARD_PORT=%s\nVIOLATION_CACHE_TTL_HOURS=%s\nPOSTGRES_USER=%s\nPOSTGRES_DB=%s\n' \
    "${DT_DASHBOARD_PORT:-3000}" \
    "${VIOLATION_CACHE_TTL_HOURS:-24}" \
    "${POSTGRES_USER:-dtdash}" \
    "${POSTGRES_DB:-dtdash}" >> "$ENV_FILE"

  # A password typed at the prompt above is written here, not left in the shell.
  if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
    grep -v "^POSTGRES_PASSWORD=" "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
    printf 'POSTGRES_PASSWORD=%s\n' "${POSTGRES_PASSWORD}" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE" 2>/dev/null || true
  fi

  success ".env saved"
fi

# ─── Database credentials ────────────────────────────────────────────────────
# Generated once and never rotated automatically: changing POSTGRES_PASSWORD
# after the data directory exists would leave the service unable to connect,
# because PostgreSQL only reads POSTGRES_PASSWORD when it initialises the
# cluster on first start.
_pg_pass_source="${_pg_pass_source:-already in .env}"
if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  _pg_pass_source="generated by the installer"
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

# Read the real login ID out of any existing file rather than guessing from the
# environment, so the summary cannot report a name nobody can sign in with.
_admin_existing_user=""
if [[ -f "$ADMIN_CREDS_FILE" ]]; then
  _admin_existing_user="$(sed -n 's/.*"loginId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ADMIN_CREDS_FILE" | head -1)"
  _admin_existing_user="${_admin_existing_user:-${SCA_ADMIN_USER:-admin}}"
fi

# Unlike the database credentials, the administrator one can be changed safely
# at any time: it lives in a single file, and recreating it touches no user
# account, setting or report. So an existing file is an offer to reset, not a
# reason to skip the question.
_admin_reset=false
if [[ -f "$ADMIN_CREDS_FILE" ]]; then
  if [[ "$NON_INTERACTIVE" == "false" ]]; then
    echo ""
    info "An administrator account already exists: ${BOLD}${_admin_existing_user}${RESET}"
    info "  Resetting it only replaces this one credential — user accounts, settings"
    info "  and reports are not affected."
    read -rp "  Reset the administrator login ID and password? [y/N]: " _in
    [[ "$_in" == "y" || "$_in" == "Y" ]] && _admin_reset=true
  fi
  if [[ "$_admin_reset" == "false" ]]; then
    info "Keeping the existing administrator credentials."
    _admin_user="$_admin_existing_user"
  fi
fi

if [[ -f "$ADMIN_CREDS_FILE" && "$_admin_reset" == "false" ]]; then
  : # keeping what is already there
else
  step "$([[ "$_admin_reset" == "true" ]] && echo "Resetting the administrator account" || echo "Creating the administrator account")"

  _admin_user="${_admin_existing_user:-${SCA_ADMIN_USER:-admin}}"
  _admin_pass="${SCA_ADMIN_PASSWORD:-}"

  if [[ "$NON_INTERACTIVE" == "false" && -z "$_admin_pass" ]]; then
    read -rp "  Administrator login ID       [${_admin_user}]: " _in
    [[ -n "$_in" ]] && _admin_user="$_in"
    read -rsp "  Administrator password       [use default]: " _in
    echo ""
    [[ -n "$_in" ]] && _admin_pass="$(printf '%s' "$_in" | tr -d '\000-\037\177')"
  fi

  _admin_pass_source="chosen during installation"
  if [[ -z "$_admin_pass" ]]; then
    _admin_pass="ScaAdmin@dt8624"
    _admin_pass_source="the documented default"
    warn "Using the default administrator password. Change it after signing in."
  fi
  # Kept for the summary below so the operator is told once what to record. It
  # is never written anywhere except the scrypt hash in the credentials file.
  _admin_pass_shown="$_admin_pass"

  mkdir -p "$ADMIN_CREDS_DIR"

  # Hash with the SAME scrypt parameters the service uses, by calling the
  # service's own module — so the installer can never drift from it.
  #
  # CRYPTO_MODULE is an absolute path: a relative require() would resolve against
  # the caller's working directory, so the installer would only work when run
  # from the repository root.
  #
  # Docker is this installer's only hard prerequisite, so a Node.js runtime on
  # the host must stay optional. We use the host's Node when it is new enough
  # because it avoids an image pull, and otherwise run the identical script
  # inside node:22-alpine — the same base image the service itself uses.
  _hash_script='
    const { hashPassword } = require(process.env.CRYPTO_MODULE);
    hashPassword(process.env.ADMIN_PASS).then(h => {
      process.stdout.write(JSON.stringify({
        loginId: process.env.ADMIN_USER,
        passwordHash: h,
        createdAt: new Date().toISOString(),
      }, null, 2));
    }).catch(e => { console.error(e.message); process.exit(1); });
  '

  _node_major=0
  if command -v node &>/dev/null; then
    _node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [[ "$_node_major" =~ ^[0-9]+$ ]] || _node_major=0
  fi

  # `2>&1 >file` sends stderr to the command substitution and stdout to the file,
  # so a real error message is captured instead of being thrown away.
  _hash_err=""
  _hash_ok=true
  if [[ "$_node_major" -ge 18 ]]; then
    info "Hashing the administrator password (host Node.js v${_node_major})…"
    _hash_err="$(ADMIN_USER="$_admin_user" ADMIN_PASS="$_admin_pass" \
        CRYPTO_MODULE="$SCRIPT_DIR/violation-cache/lib/crypto" \
        node -e "$_hash_script" 2>&1 >"${ADMIN_CREDS_FILE}.tmp")" || _hash_ok=false
  else
    if command -v node &>/dev/null; then
      info "Host Node.js is v${_node_major}; version 18+ is required. Using a container instead…"
    else
      info "Node.js is not installed on this host — hashing inside a container instead…"
    fi
    _hash_err="$(docker run --rm \
        -e ADMIN_USER="$_admin_user" \
        -e ADMIN_PASS="$_admin_pass" \
        -e CRYPTO_MODULE=/app/lib/crypto \
        -v "$SCRIPT_DIR/violation-cache:/app:ro" \
        -w /app node:22-alpine \
        node -e "$_hash_script" 2>&1 >"${ADMIN_CREDS_FILE}.tmp")" || _hash_ok=false
  fi

  # A command can exit 0 and still produce nothing usable, so check the output.
  if [[ "$_hash_ok" == "true" ]] && ! grep -q '"passwordHash"' "${ADMIN_CREDS_FILE}.tmp" 2>/dev/null; then
    _hash_ok=false
    [[ -z "$_hash_err" ]] && _hash_err="the command produced no credentials output"
  fi

  if [[ "$_hash_ok" != "true" ]]; then
    rm -f "${ADMIN_CREDS_FILE}.tmp"
    error "Could not create the administrator credentials file."
    [[ -n "$_hash_err" ]] && error "Reason: ${_hash_err}"
    echo ""
    echo -e "  The installer hashes the administrator password using the service's own"
    echo -e "  crypto module. It tries the host's Node.js (18+) first and falls back to"
    echo -e "  running ${BOLD}node:22-alpine${RESET} in Docker."
    echo ""
    echo -e "  Things to check:"
    echo -e "    • Docker can pull images:   ${BOLD}docker run --rm node:22-alpine node -v${RESET}"
    echo -e "    • The module exists:        ${BOLD}ls $SCRIPT_DIR/violation-cache/lib/crypto.js${RESET}"
    echo -e "    • The data directory is writable: ${BOLD}ls -ld $ADMIN_CREDS_DIR${RESET}"
    echo ""
    echo -e "  Everything else installed correctly. You can re-run ${BOLD}./install.sh${RESET} once"
    echo -e "  this is resolved; administrator login stays disabled until the file exists,"
    echo -e "  but normal user accounts work regardless."
    exit 1
  fi

  mv "${ADMIN_CREDS_FILE}.tmp" "$ADMIN_CREDS_FILE"
  chmod 600 "$ADMIN_CREDS_FILE"
  unset _admin_pass
  if [[ "$_admin_reset" == "true" ]]; then
    success "Administrator account reset: ${_admin_user}"
  else
    success "Administrator account created: ${_admin_user}"
  fi
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
echo -e "  ${BOLD}DependencyTrack${RESET} → configured per user, in ⚙ Settings after signing in"
echo ""
# ─── Credentials the operator must record ────────────────────────────────────
# Shown once, here, because there is nowhere to look them up later: the
# administrator password exists only as a scrypt hash, and printing them at the
# end of a successful install is the only point at which both are known.
echo -e "${BOLD}${CYAN}  ┌─ Credentials — record these now ──────────────────────────────┐${RESET}"
echo ""
echo -e "  ${BOLD}Administrator (dashboard sign-in, tick \"Administrator login\")${RESET}"
echo -e "    Username : ${BOLD}${_admin_user:-${SCA_ADMIN_USER:-admin}}${RESET}"
if [[ -n "${_admin_pass_shown:-}" ]]; then
  echo -e "    Password : ${BOLD}${_admin_pass_shown}${RESET}   (${_admin_pass_source})"
else
  echo -e "    Password : ${YELLOW}unchanged — the credentials file already existed${RESET}"
fi
echo ""
echo -e "  ${BOLD}PostgreSQL (external tools: pgAdmin, DBeaver, psql)${RESET}"
echo -e "    Host     : ${BOLD}localhost:${POSTGRES_PORT:-5432}${RESET}"
echo -e "    Database : ${BOLD}${POSTGRES_DB:-dtdash}${RESET}"
echo -e "    Username : ${BOLD}${POSTGRES_USER:-dtdash}${RESET}"
echo -e "    Password : ${BOLD}${POSTGRES_PASSWORD}${RESET}   (${_pg_pass_source:-already in .env})"
echo ""
echo -e "${BOLD}${CYAN}  └───────────────────────────────────────────────────────────────┘${RESET}"
echo ""
echo -e "  ${BOLD}Where to find these later${RESET}"
echo -e "    • PostgreSQL username, password and database:"
echo -e "        ${BOLD}grep ^POSTGRES_ ${ENV_FILE}${RESET}"
echo -e "    • Administrator username:"
echo -e "        ${BOLD}grep loginId ${ADMIN_CREDS_FILE}${RESET}"
echo -e "    • Administrator ${BOLD}password${RESET}: ${YELLOW}nowhere — only its scrypt hash is stored.${RESET}"
echo -e "        Forgotten it? Delete ${BOLD}${ADMIN_CREDS_FILE}${RESET} and re-run this installer;"
echo -e "        user accounts and all data are untouched by that."
echo ""
echo -e "  ${YELLOW}${BOLD}Back up ${ENV_FILE}.${RESET} It holds SECRET_ENCRYPTION_KEY, without which every"
echo -e "  stored DependencyTrack API key and SMTP password becomes unreadable."
echo ""
echo -e "  ${BOLD}Next steps${RESET}"
echo -e "    1. Open the dashboard and ${BOLD}create an account${RESET}, or sign in as the administrator above."
echo -e "    2. Open ${BOLD}⚙ Settings${RESET} and enter your DependencyTrack URL and API key."
echo -e "       The key is encrypted at rest and is never sent back to the browser."
echo ""
if [[ -n "${DT_API_KEY:-}" ]]; then
  echo -e "  ${YELLOW}A legacy DT_API_KEY was found in .env.${RESET}"
  echo -e "  It will be copied onto existing accounts once, at first start, and then ignored."
  echo -e "  You can remove it from .env afterwards."
  echo ""
fi
echo -e "  ${BOLD}Docs:${RESET}  ./docs/INSTALLATION.md"
echo ""
success "Done!"
