# CCTM Collector installer for Windows (PowerShell).
# Registers a Scheduled Task that launches the collector at user logon
# and restarts on failure.
#
# Usage (PowerShell as the target user, NOT admin):
#   .\install-collector.ps1 -Server https://YOUR-HOST -Token YOUR_TOKEN -Label "windows-pc"
#
# After install, run once to seed config:
#   npx -y @cctm/collector init --server https://YOUR-HOST --token YOUR_TOKEN --label "windows-pc"

param(
  [Parameter(Mandatory=$true)] [string] $Server,
  [Parameter(Mandatory=$true)] [string] $Token,
  [Parameter(Mandatory=$true)] [string] $Label
)

$ErrorActionPreference = "Stop"

# 1. Initialise collector config (writes %USERPROFILE%\.config\cctm\config.json).
& npx -y "@cctm/collector" init --server $Server --token $Token --label $Label
if ($LASTEXITCODE -ne 0) { throw "collector init failed" }

# 2. Build scheduled task.
$taskName = "CCTM Collector"
$node = (Get-Command node).Source
$entry = "$env:APPDATA\npm\node_modules\@cctm\collector\dist\index.js"

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`" run"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force

Write-Host "Installed scheduled task '$taskName'. Start now with: Start-ScheduledTask -TaskName '$taskName'"
