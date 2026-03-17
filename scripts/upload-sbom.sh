#!/usr/bin/env bash
# =============================================================================
# Dependency-Track — Upload SBOM & Auto-Create Project
# =============================================================================
# Usage:
#   ./scripts/upload-sbom.sh [OPTIONS] <sbom-file>
#
# Supported SBOM formats:
#   - CycloneDX JSON  (.json)
#   - CycloneDX XML   (.xml)
#   - SPDX JSON       (.spdx.json)
#
# Options:
#   -f, --file        <path>   Path to SBOM file (required, or last positional arg)
#   -n, --project     <name>   Project name (auto-detected from SBOM if omitted)
#   -v, --version     <ver>    Project version (auto-detected from SBOM if omitted)
#   --parent          <uuid>   Parent project UUID (optional)
#   --tags            <t1,t2>  Comma-separated tags to apply
#   --admin-user      <name>   Admin username
#   --admin-pass      <pass>   Admin password
#   --api-url         <url>    API base URL
#   --auto-create             Auto-create project if it doesn't exist (default: true)
#   --help                    Show this help
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$SCRIPT_DIR/.env" ]] && { set -a; source "$SCRIPT_DIR/.env"; set +a; }

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
die()     { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }

SBOM_FILE=""
PROJECT_NAME=""
PROJECT_VERSION=""
PARENT_UUID=""
TAGS=""
ADMIN_USER="${DT_ADMIN_USER:-admin}"
ADMIN_PASS="${DT_ADMIN_PASS:-admin}"
API_URL="${DT_API_URL:-http://localhost:8081}"
AUTO_CREATE=true

while [[ $# -gt 0 ]]; do
  case $1 in
    -f|--file)        SBOM_FILE="$2"; shift 2 ;;
    -n|--project)     PROJECT_NAME="$2"; shift 2 ;;
    -v|--version)     PROJECT_VERSION="$2"; shift 2 ;;
    --parent)         PARENT_UUID="$2"; shift 2 ;;
    --tags)           TAGS="$2"; shift 2 ;;
    --admin-user)     ADMIN_USER="$2"; shift 2 ;;
    --admin-pass)     ADMIN_PASS="$2"; shift 2 ;;
    --api-url)        API_URL="$2"; shift 2 ;;
    --no-auto-create) AUTO_CREATE=false; shift ;;
    --help) sed -n '2,22p' "$0"; exit 0 ;;
    -*) die "Unknown option: $1" ;;
    *)  SBOM_FILE="$1"; shift ;;
  esac
done

[[ -z "$SBOM_FILE" ]] && { read -rp "Path to SBOM file: " SBOM_FILE; }
[[ -z "$SBOM_FILE" ]] && die "SBOM file path is required"
[[ -f "$SBOM_FILE" ]] || die "File not found: $SBOM_FILE"

# ── Detect format ─────────────────────────────────────────────────────────────
FILENAME="$(basename "$SBOM_FILE")"
case "$FILENAME" in
  *.spdx.json) BOM_FORMAT="SPDX" ;;
  *.json)      BOM_FORMAT="CycloneDX" ;;
  *.xml)       BOM_FORMAT="CycloneDX" ;;
  *)           warn "Unknown extension — assuming CycloneDX"; BOM_FORMAT="CycloneDX" ;;
esac
info "Detected format: $BOM_FORMAT  ($FILENAME)"

# ── Auto-detect project name/version from CycloneDX JSON ────────────────────
if [[ "$BOM_FORMAT" == "CycloneDX" && "$FILENAME" == *.json ]]; then
  if [[ -z "$PROJECT_NAME" ]]; then
    PROJECT_NAME=$(jq -r '.metadata.component.name // empty' "$SBOM_FILE" 2>/dev/null || echo "")
    [[ -n "$PROJECT_NAME" ]] && info "Auto-detected project name: $PROJECT_NAME"
  fi
  if [[ -z "$PROJECT_VERSION" ]]; then
    PROJECT_VERSION=$(jq -r '.metadata.component.version // empty' "$SBOM_FILE" 2>/dev/null || echo "")
    [[ -n "$PROJECT_VERSION" ]] && info "Auto-detected version: $PROJECT_VERSION"
  fi
fi

# ── Interactive fallback ──────────────────────────────────────────────────────
if [[ -z "$PROJECT_NAME" ]]; then
  read -rp "Project name: " PROJECT_NAME
fi
[[ -z "$PROJECT_NAME" ]] && die "Project name is required"

if [[ -z "$PROJECT_VERSION" ]]; then
  read -rp "Project version [1.0.0]: " PROJECT_VERSION
  PROJECT_VERSION="${PROJECT_VERSION:-1.0.0}"
fi

# ── Authenticate ─────────────────────────────────────────────────────────────
info "Authenticating as ${ADMIN_USER}…"
TOKEN=$(curl -sf \
  -X POST "${API_URL}/api/v1/user/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=${ADMIN_USER}" \
  --data-urlencode "password=${ADMIN_PASS}" 2>/dev/null) || die "Authentication failed"
success "Authenticated"

# ── Ensure project exists ─────────────────────────────────────────────────────
info "Looking up project '${PROJECT_NAME}' v${PROJECT_VERSION}…"
PROJECTS_JSON=$(curl -sf \
  -H "Authorization: Bearer ${TOKEN}" \
  "${API_URL}/api/v1/project?name=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$PROJECT_NAME")&version=${PROJECT_VERSION}" \
  2>/dev/null || echo "[]")

PROJECT_UUID=$(echo "$PROJECTS_JSON" | jq -r '.[0].uuid // empty' 2>/dev/null || echo "")

if [[ -z "$PROJECT_UUID" ]]; then
  if [[ "$AUTO_CREATE" == "true" ]]; then
    info "Project not found — creating '${PROJECT_NAME}' v${PROJECT_VERSION}…"
    PROJ_PAYLOAD=$(jq -n \
      --arg n "$PROJECT_NAME" \
      --arg v "$PROJECT_VERSION" \
      --arg pu "$PARENT_UUID" \
      '{ name: $n, version: $v } | if $pu != "" then . + {parent: {uuid: $pu}} else . end')

    HTTP_STATUS=$(curl -s -o /tmp/dt_proj_response.json -w "%{http_code}" \
      -X PUT "${API_URL}/api/v1/project" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$PROJ_PAYLOAD")

    if [[ "$HTTP_STATUS" == "201" ]]; then
      PROJECT_UUID=$(jq -r '.uuid' /tmp/dt_proj_response.json)
      success "Project created: $PROJECT_UUID"
    else
      die "Failed to create project (HTTP $HTTP_STATUS)"
    fi
  else
    die "Project not found and --no-auto-create is set"
  fi
else
  success "Project found: $PROJECT_UUID"
fi

# ── Apply tags (optional) ─────────────────────────────────────────────────────
if [[ -n "$TAGS" ]]; then
  info "Applying tags: $TAGS"
  IFS=',' read -ra TAG_ARR <<< "$TAGS"
  TAGS_JSON=$(printf '%s\n' "${TAG_ARR[@]}" | jq -R '{name:.}' | jq -s '.')
  curl -sf \
    -X PATCH "${API_URL}/api/v1/project/${PROJECT_UUID}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"tags\": $TAGS_JSON}" -o /dev/null || warn "Could not apply tags"
  success "Tags applied"
fi

# ── Upload SBOM ───────────────────────────────────────────────────────────────
info "Uploading SBOM to project ${PROJECT_UUID}…"
ENCODED_BOM=$(base64 -w0 < "$SBOM_FILE")

UPLOAD_PAYLOAD=$(jq -n \
  --arg pu "$PROJECT_UUID" \
  --arg bom "$ENCODED_BOM" \
  '{ projectUuid: $pu, bom: $bom }')

HTTP_STATUS=$(curl -s -o /tmp/dt_bom_response.json -w "%{http_code}" \
  -X PUT "${API_URL}/api/v1/bom" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$UPLOAD_PAYLOAD")

if [[ "$HTTP_STATUS" == "200" ]]; then
  TOKEN_RESP=$(jq -r '.token // empty' /tmp/dt_bom_response.json 2>/dev/null || echo "")
  success "SBOM uploaded! Processing token: ${TOKEN_RESP:-n/a}"
  echo ""
  echo -e "  ${CYAN}Track analysis:${RESET} ${API_URL}/api/v1/bom/token/${TOKEN_RESP}"
  echo -e "  ${CYAN}Project UI:${RESET}     http://localhost:${DT_FRONTEND_PORT:-8080}/#/projects/${PROJECT_UUID}"
else
  error_msg=$(jq -r '.message // empty' /tmp/dt_bom_response.json 2>/dev/null || cat /tmp/dt_bom_response.json)
  die "SBOM upload failed (HTTP $HTTP_STATUS): $error_msg"
fi

# ── Poll processing status ────────────────────────────────────────────────────
if [[ -n "${TOKEN_RESP:-}" ]]; then
  info "Waiting for analysis to complete…"
  MAX_WAIT=120; WAITED=0; INTERVAL=5
  until [[ "$(curl -sf \
    -H "Authorization: Bearer ${TOKEN}" \
    "${API_URL}/api/v1/bom/token/${TOKEN_RESP}" 2>/dev/null \
    | jq -r '.processing' 2>/dev/null)" == "false" ]]; do
    if (( WAITED >= MAX_WAIT )); then
      warn "Analysis still in progress after ${MAX_WAIT}s. Check the UI."
      break
    fi
    echo -ne "  Processing… ${WAITED}s\r"
    sleep "$INTERVAL"; WAITED=$(( WAITED + INTERVAL ))
  done
  echo ""
  success "Analysis complete for '${PROJECT_NAME}' v${PROJECT_VERSION}"
fi
