# cctm-agent installer for Windows (PowerShell).
# One-liner: irm https://raw.githubusercontent.com/zotabros/cctm-agent/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'
$Pkg    = '@zotabros/cctm-agent'
$GitSrc = 'github:zotabros/cctm-agent'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!  $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "x  $m" -ForegroundColor Red }
function Ok($m)   { Write-Host "✓  $m" -ForegroundColor Green }

function Require-Cmd($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Err "Missing required command: $name"
    if ($name -in @('node','npm')) {
      Write-Host "    Install Node.js 20+ from https://nodejs.org/ then re-run."
    }
    exit 1
  }
}

Require-Cmd node
Require-Cmd npm

$nodeMajor = (& node -p "process.versions.node.split('.')[0]") -as [int]
if ($nodeMajor -lt 20) {
  Err "Node.js >= 20 required (found $(& node -v))."
  exit 1
}

$npmRoot = (& npm root -g).Trim()
if (-not $npmRoot -or -not (Test-Path $npmRoot)) {
  Err "Could not resolve global npm root via 'npm root -g'."
  exit 1
}

$scopeDir  = Join-Path $npmRoot '@zotabros'
$targetDir = Join-Path $scopeDir 'cctm-agent'

function Cleanup-Stale {
  if (-not (Test-Path $scopeDir)) { return }
  $stale = Get-ChildItem -Path $scopeDir -Directory -Filter '.cctm-agent-*' -ErrorAction SilentlyContinue
  if ($stale.Count -gt 0) {
    Info "Removing $($stale.Count) stale staging dir(s)…"
    $stale | ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
  }
}

function Uninstall-Existing {
  $hasBin = [bool](Get-Command cctm-agent -ErrorAction SilentlyContinue)
  if ((Test-Path $targetDir) -or $hasBin) {
    Info "Removing existing $Pkg installation…"
    & npm uninstall -g $Pkg 2>$null | Out-Null
    if (Test-Path $targetDir) {
      try { Remove-Item -Recurse -Force $targetDir }
      catch { Err "Failed to remove $targetDir: $_"; exit 1 }
    }
  }
}

function Try-Install($src) {
  Info "Installing from: $src"
  & npm install -g $src
  return ($LASTEXITCODE -eq 0)
}

Write-Host ""
Info "Installing cctm-agent"
Write-Host "Global node_modules: $npmRoot" -ForegroundColor DarkGray
Write-Host ""

Cleanup-Stale
Uninstall-Existing
Cleanup-Stale

$installed = Try-Install $Pkg
if (-not $installed) {
  Warn "npm registry install failed. Trying GitHub source…"
  Cleanup-Stale
  $installed = Try-Install $GitSrc
}

if (-not $installed) {
  Write-Host ""
  Err "Install failed from both GitHub and npm registry."
  Write-Host "    Try manually:"
  Write-Host "      Remove-Item -Recurse -Force `"$scopeDir`""
  Write-Host "      npm cache clean --force"
  Write-Host "      npm install -g $Pkg"
  exit 1
}

Ok "Installed."

if (-not (Get-Command cctm-agent -ErrorAction SilentlyContinue)) {
  Warn "Installed but 'cctm-agent' is not on PATH."
  Write-Host "    Bin location: $(& npm bin -g)"
  exit 0
}

Write-Host ""
Ok "Done. Next steps:"
Write-Host "    cctm-agent             # open interactive menu (setup, start, stop, …)"
Write-Host ""
