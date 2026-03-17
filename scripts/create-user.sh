#!/usr/bin/env bash
# =============================================================================
# Dependency-Track — Create a Managed User
# =============================================================================
# Usage:
#   ./scripts/create-user.sh [OPTIONS]
#
# Options:
#   -u, --username   <name>       New username  (required)
#   -p, --password   <pass>       New user password (required)
#   -e, --email      <email>      Email address
#   -f, --fullname   <name>       Full display name
#   -t, --team       <team>       Team name to assign user to (default: none)
#   --admin-user     <name>       Admin username (default: $DT_ADMIN_USER or admin)
#   --admin-pass     <pass>       Admin password (default: $DT_ADMIN_PASS)
#   --api-url        <url>        API base URL (default: $DT_API_URL or http://localhost:8081)
#   --force-change                Require user to change password at next login
#   --help                        Show this help
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$SCRIPT_DIR/.env" ]] && { set -a; source "$SCRIPT_DIR/.env"; set +a; }

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RESET='\033[0m'
info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
die()     { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }

NEW_USERNAME=""
NEW_PASSWORD=""
NEW_EMAIL=""
NEW_FULLNAME=""
TEAM_NAME=""
ADMIN_USER="${DT_ADMIN_USER:-admin}"
ADMIN_PASS="${DT_ADMIN_PASS:-admin}"
API_URL="${DT_API_URL:-http://localhost:8081}"
FORCE_CHANGE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -u|--username)    NEW_USERNAME="$2"; shift 2 ;;
    -p|--password)    NEW_PASSWORD="$2"; shift 2 ;;
    -e|--email)       NEW_EMAIL="$2"; shift 2 ;;
    -f|--fullname)    NEW_FULLNAME="$2"; shift 2 ;;
    -t|--team)        TEAM_NAME="$2"; shift 2 ;;
    --admin-user)     ADMIN_USER="$2"; shift 2 ;;
    --admin-pass)     ADMIN_PASS="$2"; shift 2 ;;
    --api-url)        API_URL="$2"; shift 2 ;;
    --force-change)   FORCE_CHANGE=true; shift ;;
    --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ── Interactive mode if required fields are missing ──────────────────────────
if [[ -z "$NEW_USERNAME" ]]; then
  read -rp "Username: " NEW_USERNAME
fi
[[ -z "$NEW_USERNAME" ]] && die "Username is required"

if [[ -z "$NEW_PASSWORD" ]]; then
  read -rsp "Password: " NEW_PASSWORD; echo ""
fi
[[ -z "$NEW_PASSWORD" ]] && die "Password is required"

if [[ -z "$NEW_EMAIL" ]]; then
  read -rp "Email (optional): " NEW_EMAIL
fi
if [[ -z "$NEW_FULLNAME" ]]; then
  read -rp "Full name (optional): " NEW_FULLNAME
fi

# ── Authenticate & get API key ───────────────────────────────────────────────
info "Authenticating as ${ADMIN_USER}…"
TOKEN=$(curl -sf \
  -X POST "${API_URL}/api/v1/user/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=${ADMIN_USER}" \
  --data-urlencode "password=${ADMIN_PASS}" 2>/dev/null) || die "Authentication failed. Check admin credentials."

[[ -z "$TOKEN" ]] && die "Authentication returned empty token."
success "Authenticated"

# ── Create the user ──────────────────────────────────────────────────────────
info "Creating user '${NEW_USERNAME}'…"

PAYLOAD=$(jq -n \
  --arg u  "$NEW_USERNAME" \
  --arg p  "$NEW_PASSWORD" \
  --arg e  "$NEW_EMAIL" \
  --arg fn "$NEW_FULLNAME" \
  --argjson fc "$FORCE_CHANGE" \
  '{
    username:            $u,
    newPassword:         $p,
    confirmPassword:     $p,
    email:               $e,
    fullname:            $fn,
    forcePasswordChange: $fc,
    nonExpiryPassword:   true,
    suspended:           false
  }')

HTTP_STATUS=$(curl -s -o /tmp/dt_user_response.json -w "%{http_code}" \
  -X PUT "${API_URL}/api/v1/user/managed" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

if [[ "$HTTP_STATUS" == "201" ]]; then
  success "User '${NEW_USERNAME}' created successfully"
elif [[ "$HTTP_STATUS" == "409" ]]; then
  die "User '${NEW_USERNAME}' already exists"
else
  error_msg=$(jq -r '.message // empty' /tmp/dt_user_response.json 2>/dev/null || cat /tmp/dt_user_response.json)
  die "Failed to create user (HTTP $HTTP_STATUS): $error_msg"
fi

# ── Assign to team (optional) ────────────────────────────────────────────────
if [[ -n "$TEAM_NAME" ]]; then
  info "Looking up team '${TEAM_NAME}'…"
  TEAMS_JSON=$(curl -sf \
    -H "Authorization: Bearer ${TOKEN}" \
    "${API_URL}/api/v1/team" 2>/dev/null)

  TEAM_UUID=$(echo "$TEAMS_JSON" | jq -r --arg tn "$TEAM_NAME" \
    '.[] | select(.name == $tn) | .uuid' 2>/dev/null || echo "")

  if [[ -z "$TEAM_UUID" ]]; then
    warn "Team '${TEAM_NAME}' not found. User created but not assigned to a team."
  else
    info "Assigning user to team '${TEAM_NAME}' (${TEAM_UUID})…"
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "${API_URL}/api/v1/team/${TEAM_UUID}/member" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "\"${NEW_USERNAME}\"")
    if [[ "$HTTP_STATUS" == "200" ]]; then
      success "User assigned to team '${TEAM_NAME}'"
    else
      warn "Could not assign user to team (HTTP $HTTP_STATUS)"
    fi
  fi
fi

echo ""
success "User '${NEW_USERNAME}' is ready."
echo "  Login URL: ${API_URL/8081/8080}  (use the DependencyTrack UI port)"
