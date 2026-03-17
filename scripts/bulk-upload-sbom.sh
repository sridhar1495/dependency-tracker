#!/usr/bin/env bash
# =============================================================================
# Dependency-Track — Bulk SBOM Upload
# =============================================================================
# Scans a directory for SBOM files and uploads each one.
#
# Usage:
#   ./scripts/bulk-upload-sbom.sh --dir <sbom-dir> [OPTIONS]
#
# Options:
#   -d, --dir     <path>   Directory containing SBOM files (required)
#   --pattern     <glob>   File glob pattern (default: *.json)
#   --tags        <t1,t2>  Tags to apply to all projects
#   --dry-run              Print files that would be uploaded without uploading
#   --help                 Show this help
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/../.env" ]] && { set -a; source "$SCRIPT_DIR/../.env"; set +a; }

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RESET='\033[0m'
info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
die()     { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }

SBOM_DIR=""
PATTERN="*.json"
TAGS=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -d|--dir)     SBOM_DIR="$2"; shift 2 ;;
    --pattern)    PATTERN="$2"; shift 2 ;;
    --tags)       TAGS="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=true; shift ;;
    --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -z "$SBOM_DIR" ]] && { read -rp "SBOM directory: " SBOM_DIR; }
[[ -d "$SBOM_DIR" ]] || die "Directory not found: $SBOM_DIR"

UPLOAD_SCRIPT="$SCRIPT_DIR/upload-sbom.sh"
[[ -f "$UPLOAD_SCRIPT" ]] || die "upload-sbom.sh not found at $UPLOAD_SCRIPT"

PASSED=0; FAILED=0; SKIPPED=0
mapfile -t FILES < <(find "$SBOM_DIR" -maxdepth 2 -name "$PATTERN" -type f | sort)

if [[ ${#FILES[@]} -eq 0 ]]; then
  warn "No files matching '$PATTERN' found in $SBOM_DIR"
  exit 0
fi

info "Found ${#FILES[@]} SBOM file(s)"

for FILE in "${FILES[@]}"; do
  echo ""
  info "── Processing: $(basename "$FILE") ──"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would upload: $FILE"
    (( SKIPPED++ )) || true
    continue
  fi

  EXTRA_ARGS=()
  [[ -n "$TAGS" ]] && EXTRA_ARGS+=(--tags "$TAGS")

  if bash "$UPLOAD_SCRIPT" --file "$FILE" "${EXTRA_ARGS[@]}"; then
    (( PASSED++ )) || true
  else
    warn "Upload failed for: $FILE"
    (( FAILED++ )) || true
  fi
done

echo ""
echo "────────────────────────────────"
echo -e "  ${GREEN}Uploaded:${RESET}  $PASSED"
[[ $FAILED -gt 0 ]] && echo -e "  ${RED}Failed:${RESET}    $FAILED"
[[ $SKIPPED -gt 0 ]] && echo -e "  ${YELLOW}Skipped:${RESET}   $SKIPPED"
echo "────────────────────────────────"
[[ $FAILED -eq 0 ]] && success "All uploads complete" || warn "Some uploads failed. Check output above."
