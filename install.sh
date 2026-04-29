#!/usr/bin/env bash
# cctm-agent installer for macOS/Linux.
# One-liner: curl -fsSL https://raw.githubusercontent.com/zotabros/cctm-agent/main/install.sh | bash
set -u

PKG="@zotabros/cctm-agent"
GIT_SRC="github:zotabros/cctm-agent"
RED=$'\033[0;31m'; YEL=$'\033[0;33m'; GRN=$'\033[0;32m'; DIM=$'\033[2m'; BLD=$'\033[1m'; RST=$'\033[0m'

log()  { printf "%s\n" "$*"; }
info() { printf "%s==>%s %s\n" "$BLD" "$RST" "$*"; }
warn() { printf "%s!%s  %s\n" "$YEL" "$RST" "$*"; }
err()  { printf "%sx%s  %s\n" "$RED" "$RST" "$*" 1>&2; }
ok()   { printf "%s✓%s  %s\n" "$GRN" "$RST" "$*"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    case "$1" in
      node|npm) log "    Install Node.js 20+ from https://nodejs.org/ then re-run." ;;
    esac
    exit 1
  fi
}

require_cmd node
require_cmd npm

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  err "Node.js >= 20 required (found $(node -v 2>/dev/null || echo unknown))."
  exit 1
fi

NPM_ROOT=$(npm root -g 2>/dev/null || true)
if [ -z "${NPM_ROOT:-}" ] || [ ! -d "$NPM_ROOT" ]; then
  err "Could not resolve global npm root via 'npm root -g'."
  exit 1
fi

SCOPE_DIR="$NPM_ROOT/@zotabros"
TARGET_DIR="$SCOPE_DIR/cctm-agent"

cleanup_stale() {
  if [ ! -d "$SCOPE_DIR" ]; then return 0; fi
  # Remove stale staging dirs left by failed installs (.cctm-agent-XXXXXX).
  local stale_count
  stale_count=$(find "$SCOPE_DIR" -maxdepth 1 -type d -name '.cctm-agent-*' 2>/dev/null | wc -l | tr -d ' ')
  if [ "${stale_count:-0}" -gt 0 ]; then
    info "Removing $stale_count stale staging dir(s)…"
    find "$SCOPE_DIR" -maxdepth 1 -type d -name '.cctm-agent-*' -exec rm -rf {} + 2>/dev/null || true
  fi
}

uninstall_existing() {
  if [ -d "$TARGET_DIR" ] || command -v cctm-agent >/dev/null 2>&1; then
    info "Removing existing $PKG installation…"
    npm uninstall -g "$PKG" >/dev/null 2>&1 || true
    if [ -d "$TARGET_DIR" ]; then
      rm -rf "$TARGET_DIR" 2>/dev/null || {
        warn "Could not remove $TARGET_DIR without elevated permissions; retrying with sudo."
        sudo rm -rf "$TARGET_DIR" || { err "Failed to remove $TARGET_DIR"; exit 1; }
      }
    fi
  fi
}

run_install() {
  local src="$1"
  info "Installing from: $src"
  if npm install -g "$src"; then
    return 0
  fi
  return 1
}

main() {
  log ""
  info "${BLD}Installing cctm-agent${RST}"
  log "${DIM}Global node_modules: $NPM_ROOT${RST}"
  log ""

  cleanup_stale
  uninstall_existing
  cleanup_stale

  if run_install "$PKG"; then
    ok "Installed from npm registry."
  else
    warn "npm registry install failed. Trying GitHub source…"
    cleanup_stale
    if run_install "$GIT_SRC"; then
      ok "Installed from GitHub source."
    else
      log ""
      err "Install failed from npm registry and GitHub."
      log "    Try manually:"
      log "      ${BLD}rm -rf \"$SCOPE_DIR\"${RST}"
      log "      ${BLD}npm cache clean --force${RST}"
      log "      ${BLD}npm install -g $PKG${RST}"
      log "    If the error mentions EACCES, your global node_modules requires sudo,"
      log "    or switch to a user-owned Node via nvm/fnm/volta."
      exit 1
    fi
  fi

  if ! command -v cctm-agent >/dev/null 2>&1; then
    warn "Installed but 'cctm-agent' is not on PATH."
    log "    Bin location: $(npm bin -g 2>/dev/null || echo unknown)"
    log "    Add it to PATH, then run: cctm-agent --help"
    exit 0
  fi

  log ""
  ok "Done. Next steps:"
  log "    ${BLD}cctm-agent init${RST}      # configure machine token + server"
  log "    ${BLD}cctm-agent start${RST}     # start the watcher"
  log ""
}

main "$@"
