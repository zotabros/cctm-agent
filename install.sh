#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

C_RESET='\033[0m'
C_DIM='\033[2m'
C_BOLD='\033[1m'
C_OK='\033[32m'
C_WARN='\033[33m'
C_ERR='\033[31m'
C_ACC='\033[38;5;208m'

log()  { printf "${C_ACC}▸${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_OK}✓${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}!${C_RESET} %s\n" "$*"; }
die()  { printf "${C_ERR}✗${C_RESET} %s\n" "$*" >&2; exit 1; }
ask()  { local q="$1" def="${2:-}" ans; read -rp "  $q ${def:+[$def] }" ans; echo "${ans:-$def}"; }

banner() {
  printf "${C_BOLD}\n"
  cat <<'EOF'
  ┌─────────────────────────────────────────┐
  │   CCTokenManager — Install              │
  │   Claude Code token usage analytics     │
  └─────────────────────────────────────────┘
EOF
  printf "${C_RESET}\n"
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

confirm() {
  local q="$1" ans
  read -rp "  $q [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "mac" ;;
    Linux)
      if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        echo "linux:$ID"
      else
        echo "linux:unknown"
      fi
      ;;
    *) echo "unknown" ;;
  esac
}

install_brew() {
  warn "Homebrew not found (recommended for Mac installs)"
  confirm "Install Homebrew now (official script, will require sudo)?" || return 1
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  have_cmd brew
}

install_curl() {
  warn "curl not found"
  local os; os="$(detect_os)"
  case "$os" in
    mac) have_cmd brew || install_brew || die "Need brew to install curl."; brew install curl ;;
    linux:ubuntu|linux:debian|linux:pop) sudo apt-get update && sudo apt-get install -y curl ;;
    linux:fedora|linux:rhel|linux:centos) sudo dnf -y install curl ;;
    linux:arch|linux:manjaro) sudo pacman -Sy --noconfirm curl ;;
    *) die "Install curl manually for OS: $os" ;;
  esac
}

install_git() {
  warn "git not found"
  confirm "Install git now?" || die "git required — abort."
  local os; os="$(detect_os)"
  case "$os" in
    mac) have_cmd brew || install_brew || die "Need brew."; brew install git ;;
    linux:ubuntu|linux:debian|linux:pop) sudo apt-get update && sudo apt-get install -y git ;;
    linux:fedora|linux:rhel|linux:centos) sudo dnf -y install git ;;
    linux:arch|linux:manjaro) sudo pacman -Sy --noconfirm git ;;
    *) die "Install git manually for OS: $os" ;;
  esac
}

install_openssl() {
  warn "openssl not found"
  confirm "Install openssl now?" || die "openssl required — abort."
  local os; os="$(detect_os)"
  case "$os" in
    mac) have_cmd brew || install_brew || die "Need brew."; brew install openssl@3 ;;
    linux:ubuntu|linux:debian|linux:pop) sudo apt-get update && sudo apt-get install -y openssl ;;
    linux:fedora|linux:rhel|linux:centos) sudo dnf -y install openssl ;;
    linux:arch|linux:manjaro) sudo pacman -Sy --noconfirm openssl ;;
    *) die "Install openssl manually." ;;
  esac
}

install_node() {
  warn "Node.js not found (need 20+)"
  confirm "Install Node 20 LTS now?" || die "Node required — abort."
  local os; os="$(detect_os)"
  case "$os" in
    mac)
      have_cmd brew || install_brew || die "Need brew to install Node."
      brew install node@20
      brew link --overwrite --force node@20 || true
      ;;
    linux:ubuntu|linux:debian|linux:pop)
      have_cmd curl || install_curl
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
    linux:fedora|linux:rhel|linux:centos)
      have_cmd curl || install_curl
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo dnf -y install nodejs
      ;;
    linux:arch|linux:manjaro)
      sudo pacman -Sy --noconfirm nodejs npm
      ;;
    *)
      printf "  Auto-install not supported. Manual: https://nodejs.org/en/download\n"
      die "Install Node 20+ and re-run."
      ;;
  esac
  have_cmd node || die "Node install appeared to succeed but binary not found in PATH."
  ok "Node installed: $(node -v)"
}

install_pnpm() {
  warn "pnpm not found"
  confirm "Install pnpm globally via npm now?" || die "pnpm required — abort."
  if have_cmd npm; then
    npm i -g pnpm
  elif have_cmd corepack; then
    corepack enable && corepack prepare pnpm@latest --activate
  else
    die "Neither npm nor corepack available — install Node properly first."
  fi
  ok "pnpm installed: $(pnpm -v)"
}

install_docker() {
  warn "Docker not found"
  local os; os="$(detect_os)"
  case "$os" in
    mac)
      printf "  Docker Desktop for Mac is required.\n"
      if have_cmd brew; then
        confirm "Install Docker Desktop via Homebrew (brew install --cask docker)?" || die "Docker required — abort."
        brew install --cask docker
        warn "Docker Desktop installed. You must launch it once manually so the daemon starts:"
        printf "    open -a Docker\n"
        printf "  After Docker shows 'Engine running' in the menu bar, re-run this installer.\n"
        exit 0
      else
        printf "  Homebrew not found. Manual download: https://www.docker.com/products/docker-desktop\n"
        die "Install Docker Desktop and re-run."
      fi
      ;;
    linux:ubuntu|linux:debian|linux:pop)
      confirm "Install Docker Engine via official get.docker.com script (sudo required)?" || die "Docker required — abort."
      curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
      sudo sh /tmp/get-docker.sh
      sudo usermod -aG docker "$USER" || true
      warn "Added $USER to 'docker' group — log out and back in (or 'newgrp docker') to apply, then re-run."
      exit 0
      ;;
    linux:fedora|linux:rhel|linux:centos)
      confirm "Install Docker Engine via dnf (sudo required)?" || die "Docker required — abort."
      sudo dnf -y install dnf-plugins-core
      sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
      sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      sudo systemctl enable --now docker
      sudo usermod -aG docker "$USER" || true
      warn "Re-login (or 'newgrp docker') to use docker without sudo, then re-run."
      exit 0
      ;;
    linux:arch|linux:manjaro)
      confirm "Install Docker via pacman (sudo required)?" || die "Docker required — abort."
      sudo pacman -Sy --noconfirm docker docker-compose
      sudo systemctl enable --now docker
      sudo usermod -aG docker "$USER" || true
      warn "Re-login to use docker without sudo, then re-run."
      exit 0
      ;;
    *)
      printf "  Auto-install not supported for OS: %s\n" "$os"
      printf "  See https://docs.docker.com/engine/install/\n"
      die "Install Docker manually and re-run."
      ;;
  esac
}

ensure_docker_running() {
  if docker info >/dev/null 2>&1; then return; fi
  warn "Docker installed but daemon is not running."
  local os; os="$(detect_os)"
  case "$os" in
    mac)
      confirm "Launch Docker Desktop now?" || die "Start Docker manually then re-run."
      open -a Docker || die "Failed to launch Docker Desktop."
      log "Waiting for Docker daemon (up to 60s)"
      for i in {1..60}; do
        docker info >/dev/null 2>&1 && { ok "Docker daemon ready"; return; }
        sleep 1
      done
      die "Docker did not start in time."
      ;;
    linux:*)
      confirm "Start docker service via systemctl (sudo)?" || die "Start it manually then re-run."
      sudo systemctl start docker
      sleep 2
      docker info >/dev/null 2>&1 || die "Docker still not responding."
      ok "Docker daemon ready"
      ;;
    *) die "Cannot auto-start Docker on this OS." ;;
  esac
}

check_prereqs() {
  log "Checking prerequisites"

  have_cmd curl || install_curl
  have_cmd git || install_git

  have_cmd node || install_node
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$node_major" -lt 20 ]]; then
    warn "Node $(node -v) is too old (need 20+)"
    confirm "Upgrade Node now?" || die "Node 20+ required — abort."
    install_node
  fi

  have_cmd pnpm || install_pnpm

  have_cmd docker || install_docker
  ensure_docker_running

  if ! docker compose version >/dev/null 2>&1; then
    die "docker compose v2 plugin missing — upgrade Docker."
  fi

  have_cmd openssl || install_openssl
  have_cmd python3 || warn "python3 not found — .env secret patching may fail. Install python3 if step 'Setting up .env' errors out."

  ok "All prerequisites OK"
}

gen_secret() { openssl rand -base64 32 | tr -d '\n='; }

port_in_use() {
  local p="$1"
  lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
}

find_free_port() {
  local start="$1" p="$1"
  while port_in_use "$p"; do
    p=$((p+1))
    [[ "$p" -gt $((start+50)) ]] && { echo "$start"; return; }
  done
  echo "$p"
}

set_env_var() {
  local key="$1" val="$2" file=".env"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
      sed -i '' "s|^${key}=.*|${key}=${val}|" "$file"
    else
      sed -i "s|^${key}=.*|${key}=${val}|" "$file"
    fi
  else
    echo "${key}=${val}" >> "$file"
  fi
}

setup_env() {
  log "Setting up .env"
  if [[ ! -f .env ]]; then
    [[ -f .env.example ]] || die ".env.example missing — repo incomplete."
    cp .env.example .env
    ok ".env created from .env.example"
  else
    warn ".env exists — only filling missing/placeholder values (preserving real secrets)"
  fi

  local pg_port web_port
  if port_in_use 5432; then
    pg_port="$(find_free_port 5433)"
    warn "Port 5432 in use (likely native Postgres). Using ${pg_port} for Docker postgres."
  else
    pg_port=5432
  fi
  if port_in_use 3000; then
    web_port="$(find_free_port 3001)"
    warn "Port 3000 in use. Using ${web_port} for web."
  else
    web_port=3000
  fi
  set_env_var "POSTGRES_HOST_PORT" "$pg_port"
  set_env_var "WEB_HOST_PORT" "$web_port"
  set_env_var "DATABASE_URL" "postgresql://cctm:cctm@localhost:${pg_port}/cctm?schema=public"
  set_env_var "NEXTAUTH_URL" "http://localhost:${web_port}"

  local cur_ns cur_cs
  cur_ns="$(grep -E '^NEXTAUTH_SECRET=' .env | cut -d= -f2-)"
  cur_cs="$(grep -E '^CRON_SECRET=' .env | cut -d= -f2-)"
  if [[ -z "$cur_ns" || "$cur_ns" =~ replace-me ]]; then
    set_env_var "NEXTAUTH_SECRET" "$(gen_secret)"
  fi
  if [[ -z "$cur_cs" || "$cur_cs" =~ replace-me ]]; then
    set_env_var "CRON_SECRET" "$(gen_secret)"
  fi
  ok ".env ready (postgres host port: ${pg_port})"
}

install_deps() {
  log "Installing pnpm workspace dependencies (this may take 1-2 min)"
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  ok "Dependencies installed"
}

verify_db_credentials() {
  local url
  url="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")"
  if docker compose exec -T postgres pg_isready -U cctm -d cctm >/dev/null 2>&1; then
    if docker compose exec -T postgres psql -U cctm -d cctm -c 'SELECT 1' >/dev/null 2>&1; then
      ok "Postgres credentials verified"
      return 0
    fi
  fi
  return 1
}

reset_postgres_volume() {
  warn "Postgres volume has stale credentials (from a previous install with different password)."
  warn "Postgres only initializes POSTGRES_USER/PASSWORD on FIRST boot of an empty volume."
  if confirm "Reset Postgres volume now? (DELETES all DB data)"; then
    docker compose down postgres 2>/dev/null || true
    docker volume rm cctokenmanager_cctm-pgdata 2>/dev/null || \
      docker volume rm "$(basename "$ROOT_DIR")_cctm-pgdata" 2>/dev/null || \
      docker compose down -v
    ok "Volume removed — re-creating fresh"
    docker compose up -d postgres
    for i in {1..30}; do
      docker compose ps postgres --format json 2>/dev/null | grep -q '"Health":"healthy"' && return 0
      sleep 1
    done
    die "Postgres still not healthy after reset."
  else
    die "Cannot proceed without working DB credentials. Manually reset: docker compose down -v"
  fi
}

start_postgres() {
  log "Starting Postgres container"
  docker compose up -d postgres
  log "Waiting for Postgres healthcheck"
  for i in {1..30}; do
    if docker compose ps postgres --format json 2>/dev/null | grep -q '"Health":"healthy"'; then
      ok "Postgres healthy"
      break
    fi
    sleep 1
    [[ "$i" == 30 ]] && warn "Postgres not healthy after 30s"
  done
  verify_db_credentials || reset_postgres_volume
}

ensure_init_migration() {
  local init_dir="prisma/migrations/20260101000000_init"
  if [[ -f "$init_dir/migration.sql" ]]; then return; fi
  log "Generating initial schema migration"
  mkdir -p "$init_dir"
  pnpm prisma migrate diff \
    --from-empty \
    --to-schema-datamodel prisma/schema.prisma \
    --script > "$init_dir/migration.sql"
  if [[ ! -f prisma/migrations/migration_lock.toml ]]; then
    echo 'provider = "postgresql"' > prisma/migrations/migration_lock.toml
  fi
  ok "Init migration generated"
}

run_migrations() {
  log "Running Prisma migrations"
  pnpm prisma generate >/dev/null
  ensure_init_migration
  if ! pnpm prisma migrate deploy 2>&1 | tee /tmp/cctm-migrate.log; then
    if grep -q "P1010" /tmp/cctm-migrate.log; then
      reset_postgres_volume
      pnpm prisma migrate deploy
    else
      die "Migration failed — see output above."
    fi
  fi
  ok "Schema applied"
}

seed_data() {
  local ans
  ans="$(ask "Seed demo data (30d, 150 sessions)? [y/N]" "N")"
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    log "Seeding demo data"
    pnpm db:seed
    ok "Demo data seeded — login: demo@cctm.local / demo1234"
  else
    warn "Skipped seed — register a new user at /register"
  fi
}

build_or_dev() {
  local ans
  ans="$(ask "Run mode? (1) docker compose up web   (2) pnpm dev (local)" "1")"
  case "$ans" in
    1)
      log "Building and starting web container"
      docker compose up -d --build web
      local port; port="$(grep -E '^WEB_HOST_PORT=' .env | cut -d= -f2- || echo 3000)"
      ok "Web running at http://localhost:${port}"
      printf "${C_DIM}  Tail logs: ./scripts/server.sh logs${C_RESET}\n"
      ;;
    2)
      log "Starting dev server (Ctrl+C to stop)"
      exec pnpm dev
      ;;
    *) die "Unknown choice: $ans" ;;
  esac
}

print_next_steps() {
  local port; port="$(grep -E '^WEB_HOST_PORT=' .env | cut -d= -f2- || echo 3000)"
  cat <<EOF

${C_BOLD}Done.${C_RESET}

  ${C_DIM}Open${C_RESET}      http://localhost:${port}
  ${C_DIM}Server${C_RESET}    ./scripts/server.sh {start|stop|restart|logs|status}
  ${C_DIM}Refresh${C_RESET}   curl -X POST -H "Authorization: Bearer \$CRON_SECRET" \\
              http://localhost:${port}/api/cron/refresh-usage-daily
  ${C_DIM}Collector${C_RESET} npx -y @cctm/collector init --server <URL> --token <TOKEN> --label <LABEL>

EOF
}

main() {
  banner
  check_prereqs
  setup_env
  install_deps
  start_postgres
  run_migrations
  seed_data
  build_or_dev
  print_next_steps
}

main "$@"
