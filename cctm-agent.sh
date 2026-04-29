#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

C_RESET='\033[0m'; C_DIM='\033[2m'; C_BOLD='\033[1m'
C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_ACC='\033[38;5;208m'
log()  { printf "${C_ACC}▸${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}✓${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}!${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}✗${C_RESET} %s\n" "$*" >&2; exit 1; }
ask()  { local q="$1" def="${2:-}" ans; read -rp "  $q ${def:+[$def] }" ans; echo "${ans:-$def}"; }
confirm() { local q="$1" ans; read -rp "  $q [y/N] " ans; [[ "$ans" =~ ^[Yy]$ ]]; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

CONFIG_DIR="$HOME/.config/cctm"
LOG_DIR="$HOME/Library/Logs/cctm"
[[ "$(uname -s)" != "Darwin" ]] && LOG_DIR="$HOME/.local/state/cctm/logs"
PID_FILE="$CONFIG_DIR/collector.pid"
PLIST_PATH="$HOME/Library/LaunchAgents/com.cctm.collector.plist"
SYSTEMD_PATH="$HOME/.config/systemd/user/cctm-collector.service"

usage() {
  cat <<EOF
CCTokenManager — Collector control

Usage: $(basename "$0") <command>

Commands:
  install           Build, configure (interactive), install as background service
  configure         Re-run interactive config (server URL, token, label)
  start             Start collector in background (PID file)
  stop              Stop collector
  restart           Stop then start
  status            Show collector status + last seen
  logs              Tail collector logs
  backfill          Re-upload all historical JSONL events (idempotent)
  service-install   Install as system service (launchd/systemd) — auto-start at login
  service-uninstall Uninstall background service
  run-foreground    Run in current terminal (debug)
  uninstall         Remove config + service (keeps logs)
EOF
}

resolve_node() {
  if have_cmd node; then echo "$(command -v node)"; return; fi
  die "Node not found in PATH."
}

ensure_built() {
  local dist="$ROOT_DIR/packages/collector/dist/index.js"
  if [[ ! -f "$dist" ]]; then
    log "Building collector"
    pnpm --filter @cctm/collector build
  fi
  echo "$dist"
}

detect_os_label() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *)      echo "unknown" ;;
  esac
}

read_password() {
  local prompt="$1" pw
  read -rsp "  $prompt: " pw
  echo >&2
  echo "$pw"
}

open_url() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

pair_with_server() {
  local server="$1" label_hint="$2" os="$3"
  local resp http_code tmp_body payload
  printf "  ${C_DIM}Requesting device code from %s${C_RESET}\n" "$server" >&2

  payload="$(python3 -c "import json,sys; print(json.dumps({'os':sys.argv[1],'label':sys.argv[2]}))" "$os" "$label_hint")"
  tmp_body="$(mktemp)"
  http_code="$(curl -sS -o "$tmp_body" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    --data "$payload" \
    "${server}/api/devices/code" || echo "000")"
  resp="$(cat "$tmp_body")"
  rm -f "$tmp_body"

  if [[ "$http_code" != "200" ]]; then
    [[ "$http_code" == "000" ]] && die "Cannot reach server $server — is it running?"
    die "Failed to request device code (HTTP $http_code): $resp"
  fi

  local device_code user_code verification_uri verification_uri_complete interval expires_in
  device_code="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['device_code'])" "$resp")"
  user_code="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['user_code'])" "$resp")"
  verification_uri="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['verification_uri'])" "$resp")"
  verification_uri_complete="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['verification_uri_complete'])" "$resp")"
  interval="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['interval'])" "$resp")"
  expires_in="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['expires_in'])" "$resp")"

  printf "\n" >&2
  printf "  ${C_BOLD}Open this URL in your browser to authorize:${C_RESET}\n" >&2
  printf "    %s\n" "$verification_uri" >&2
  printf "  ${C_BOLD}Enter code:${C_RESET} ${C_OK}%s${C_RESET}\n" "$user_code" >&2
  printf "  ${C_DIM}Or open the pre-filled link:${C_RESET}\n" >&2
  printf "    %s\n\n" "$verification_uri_complete" >&2
  open_url "$verification_uri_complete"

  printf "  ${C_DIM}Waiting for approval (expires in %ss)…${C_RESET}\n" "$expires_in" >&2

  local poll_payload deadline
  poll_payload="$(python3 -c "import json,sys; print(json.dumps({'device_code':sys.argv[1]}))" "$device_code")"
  deadline=$(( $(date +%s) + expires_in ))

  while :; do
    [[ $(date +%s) -ge $deadline ]] && die "Device code expired before approval."
    sleep "$interval"
    tmp_body="$(mktemp)"
    http_code="$(curl -sS -o "$tmp_body" -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' \
      --data "$poll_payload" \
      "${server}/api/devices/token" || echo "000")"
    resp="$(cat "$tmp_body")"
    rm -f "$tmp_body"

    case "$http_code" in
      200)
        local token machine_label
        token="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['token'])" "$resp")"
        machine_label="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('label') or '')" "$resp")"
        printf "${C_OK}✓${C_RESET} Device approved as '%s'.\n" "$machine_label" >&2
        # export label so caller can pick it up
        printf "%s\t%s" "$token" "$machine_label"
        return 0
        ;;
      425) ;; # authorization_pending — keep polling
      403) die "Request was denied in the browser." ;;
      410) die "Device code expired. Re-run configure to retry." ;;
      404) die "Device code invalid (server lost record)." ;;
      000) die "Lost connection to $server while polling." ;;
      *)   die "Polling failed (HTTP $http_code): $resp" ;;
    esac
  done
}

cmd_configure() {
  mkdir -p "$CONFIG_DIR"
  local existing_server="" existing_label="" existing_token=""
  if [[ -f "$CONFIG_DIR/config.json" ]]; then
    existing_server="$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('serverUrl', c.get('server','')))" "$CONFIG_DIR/config.json" 2>/dev/null || true)"
    existing_label="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('label',''))" "$CONFIG_DIR/config.json" 2>/dev/null || true)"
    existing_token="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('token',''))" "$CONFIG_DIR/config.json" 2>/dev/null || true)"
    warn "Existing config found — press Enter to keep current values."
  fi

  local server label os mode token label_hint
  server="$(ask "Server URL" "${existing_server:-http://localhost:3002}")"
  server="${server%/}"
  label_hint="${existing_label:-$(hostname -s)}"
  os="$(detect_os_label)"

  if [[ -n "$existing_token" ]]; then
    if confirm "Re-pair with server (browser approval + new token), or keep existing token?"; then
      mode="pair"
    else
      token="$existing_token"
      label="$existing_label"
      mode="keep"
    fi
  else
    printf "  ${C_BOLD}How to obtain machine token?${C_RESET}\n"
    printf "    1) Browser approval (recommended — no password in terminal)\n"
    printf "    2) Manual paste (from Settings → Machines → New machine)\n"
    local choice
    choice="$(ask "Choice" "1")"
    case "$choice" in
      1) mode="pair" ;;
      2) mode="manual" ;;
      *) die "Invalid choice." ;;
    esac
  fi

  case "$mode" in
    pair)
      local pair_out
      pair_out="$(pair_with_server "$server" "$label_hint" "$os")"
      token="${pair_out%%$'\t'*}"
      label="${pair_out#*$'\t'}"
      [[ -z "$label" ]] && label="$label_hint"
      ;;
    manual)
      label="$(ask "Machine label" "$label_hint")"
      printf "  Open %s/settings/machines/new in browser → create machine → copy token.\n" "$server"
      token="$(ask "Machine token")"
      [[ -z "$token" ]] && die "Token required."
      ;;
    keep) ;;
  esac

  python3 - "$server" "$label" "$token" "$os" "$CONFIG_DIR/config.json" <<'PY'
import json, sys, pathlib
server, label, token, os_label, path = sys.argv[1:6]
pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
pathlib.Path(path).write_text(json.dumps({
    "serverUrl": server.rstrip("/"),
    "label": label,
    "os": os_label,
    "token": token,
}, indent=2))
PY
  chmod 600 "$CONFIG_DIR/config.json"
  ok "Config written: $CONFIG_DIR/config.json"

  # Offer back-fill on fresh pair (skip when keeping existing token)
  if [[ "$mode" == "pair" ]]; then
    local jsonl_count
    jsonl_count="$(find "$HOME/.claude/projects" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "${jsonl_count:-0}" -gt 0 ]]; then
      printf "\n  ${C_BOLD}Found %s existing JSONL file(s) under ~/.claude/projects${C_RESET}\n" "$jsonl_count"
      if confirm "Back-fill historical usage to the server now?"; then
        cmd_backfill --yes
      else
        printf "  ${C_DIM}Skip — you can run '%s backfill' later.${C_RESET}\n" "$(basename "$0")"
      fi
    fi
  fi
}

verify_config() {
  [[ -f "$CONFIG_DIR/config.json" ]] || die "Not configured. Run: $0 configure"
}

verify_server_reachable() {
  local server; server="$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('serverUrl', c.get('server','')))" "$CONFIG_DIR/config.json")"
  if curl -sf -o /dev/null -m 5 "$server"; then
    ok "Server reachable: $server"
  else
    warn "Server $server not responding — start it with: ./scripts/server.sh start"
  fi
}

cmd_start() {
  verify_config
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    warn "Already running (pid $(cat "$PID_FILE"))"
    return
  fi
  local node_bin dist
  node_bin="$(resolve_node)"
  dist="$(ensure_built)"
  mkdir -p "$LOG_DIR"
  nohup "$node_bin" "$dist" run >"$LOG_DIR/collector.log" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    ok "Collector started (pid $(cat "$PID_FILE"))"
    printf "  ${C_DIM}Logs: $0 logs${C_RESET}\n"
  else
    die "Failed to start. Check: $0 logs"
  fi
}

cmd_stop() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")"
    rm -f "$PID_FILE"
    ok "Stopped"
  else
    warn "Not running"
    rm -f "$PID_FILE" 2>/dev/null || true
  fi
}

cmd_restart() { cmd_stop; cmd_start; }

cmd_backfill() {
  local skip_confirm="${1:-}"
  if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
    die "No config — run: $(basename "$0") configure first."
  fi
  ensure_built
  local total
  total="$(find "$HOME/.claude/projects" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$total" == "0" ]]; then
    warn "No JSONL files found under ~/.claude/projects — nothing to back-fill."
    return 0
  fi
  if [[ "$skip_confirm" != "--yes" ]]; then
    printf "  ${C_BOLD}Back-fill historical usage from %s JSONL file(s)${C_RESET}\n" "$total"
    printf "  ${C_DIM}Server dedupes by (session, timestamp, role) — safe to replay.${C_RESET}\n"
    if ! confirm "Walk all JSONL files and upload now?"; then
      return 0
    fi
  fi

  local NODE_BIN DIST
  NODE_BIN="$(resolve_node)"
  DIST="$(ensure_built)"
  printf "  ${C_DIM}Running one-shot backfill (this may take a few minutes)…${C_RESET}\n"
  "$NODE_BIN" "$DIST" backfill
}

cmd_status() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    ok "Running (pid $(cat "$PID_FILE"))"
  else
    warn "Not running"
  fi
  if [[ -f "$CONFIG_DIR/config.json" ]]; then
    printf "  Config: $CONFIG_DIR/config.json\n"
    python3 -c "import json; c=json.load(open('$CONFIG_DIR/config.json')); s=c.get('serverUrl', c.get('server','?')); print(f'  Server: {s}\n  Label:  {c[\"label\"]}\n  Token:  {c[\"token\"][:8]}…')" 2>/dev/null || true
  fi
  if [[ -f "$CONFIG_DIR/state.json" ]]; then
    local files
    files="$(python3 -c "import json; print(len(json.load(open('$CONFIG_DIR/state.json'))))" 2>/dev/null || echo 0)"
    printf "  Tracked files: %s\n" "$files"
  fi
  if [[ -f "$CONFIG_DIR/queue.jsonl" ]]; then
    local q; q="$(wc -l < "$CONFIG_DIR/queue.jsonl" | tr -d ' ')"
    [[ "$q" -gt 0 ]] && warn "$q events stuck in retry queue"
  fi
}

cmd_logs() {
  local f="$LOG_DIR/collector.log"
  [[ -f "$f" ]] || die "No log file yet at $f"
  tail -f -n 200 "$f"
}

cmd_run_foreground() {
  verify_config
  local node_bin dist
  node_bin="$(resolve_node)"
  dist="$(ensure_built)"
  exec "$node_bin" "$dist" run
}

install_launchd() {
  local node_bin dist
  node_bin="$(resolve_node)"
  dist="$(ensure_built)"
  mkdir -p "$LOG_DIR" "$(dirname "$PLIST_PATH")"
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cctm.collector</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node_bin}</string>
    <string>${dist}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/collector.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/collector.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>$(dirname "$node_bin"):/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
EOF
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  ok "launchd service installed: $PLIST_PATH"
  printf "  ${C_DIM}Auto-starts at login. Manage: launchctl {load,unload} $PLIST_PATH${C_RESET}\n"
}

uninstall_launchd() {
  if [[ -f "$PLIST_PATH" ]]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    ok "launchd service removed"
  else
    warn "No launchd service installed"
  fi
}

install_systemd() {
  local node_bin dist
  node_bin="$(resolve_node)"
  dist="$(ensure_built)"
  mkdir -p "$LOG_DIR" "$(dirname "$SYSTEMD_PATH")"
  cat > "$SYSTEMD_PATH" <<EOF
[Unit]
Description=CCTokenManager Collector
After=network-online.target

[Service]
Type=simple
ExecStart=${node_bin} ${dist} run
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_DIR}/collector.log
StandardError=append:${LOG_DIR}/collector.err

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now cctm-collector.service
  ok "systemd user service installed and started"
  printf "  ${C_DIM}Manage: systemctl --user {status,restart,stop} cctm-collector${C_RESET}\n"
  printf "  ${C_DIM}Survive logout: sudo loginctl enable-linger \$USER${C_RESET}\n"
}

uninstall_systemd() {
  if [[ -f "$SYSTEMD_PATH" ]]; then
    systemctl --user disable --now cctm-collector.service 2>/dev/null || true
    rm -f "$SYSTEMD_PATH"
    systemctl --user daemon-reload
    ok "systemd service removed"
  else
    warn "No systemd service installed"
  fi
}

cmd_service_install() {
  verify_config
  case "$(uname -s)" in
    Darwin) install_launchd ;;
    Linux)  install_systemd ;;
    *) die "Unsupported OS for auto-service. Use: $0 start" ;;
  esac
}

cmd_service_uninstall() {
  case "$(uname -s)" in
    Darwin) uninstall_launchd ;;
    Linux)  uninstall_systemd ;;
    *) die "Unsupported OS." ;;
  esac
}

cmd_install() {
  log "Checking prerequisites"
  have_cmd node || die "Node not installed. See server install: ./scripts/install.sh"
  have_cmd pnpm || die "pnpm not installed."
  have_cmd python3 || die "python3 required for config."
  ok "Prereqs OK"

  log "Installing dependencies"
  pnpm install --filter @cctm/collector --filter @cctm/shared 2>&1 | tail -3
  ensure_built >/dev/null
  ok "Collector built"

  cmd_configure
  verify_server_reachable
  if confirm "Install as background service (auto-start at login)?"; then
    cmd_service_install
  else
    if confirm "Start collector now (foreground PID)?"; then
      cmd_start
    fi
  fi
  printf "\n${C_BOLD}Done.${C_RESET} Manage with: $0 {start|stop|status|logs}\n"
}

cmd_uninstall() {
  cmd_service_uninstall 2>/dev/null || true
  cmd_stop 2>/dev/null || true
  if confirm "Delete config at $CONFIG_DIR/config.json?"; then
    rm -f "$CONFIG_DIR/config.json"
    ok "Config removed"
  fi
  warn "Logs kept at $LOG_DIR (delete manually if needed)"
}

case "${1:-}" in
  install)            cmd_install ;;
  configure)          cmd_configure ;;
  start)              cmd_start ;;
  stop)               cmd_stop ;;
  restart)            cmd_restart ;;
  status)             cmd_status ;;
  backfill)           shift; cmd_backfill "$@" ;;
  logs)               cmd_logs ;;
  service-install)    cmd_service_install ;;
  service-uninstall)  cmd_service_uninstall ;;
  run-foreground)     cmd_run_foreground ;;
  uninstall)          cmd_uninstall ;;
  ""|-h|--help)       usage ;;
  *) echo "Unknown: $1" >&2; usage; exit 1 ;;
esac
