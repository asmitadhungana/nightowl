# =============================================================================
# NightOwl v3 - Dev/Test Install Script (Windows)
#
# Windows sibling to scripts/install-dev.sh. Builds the daemon, packages it as
# nightowld.exe via @yao-pkg/pkg, then registers a Scheduled Task that runs at
# user logon (and repeats every minute as a watchdog). Defaults to --dry-run
# so the daemon fires warnings + toast notifications but DOES NOT actually
# shut down your machine - pass -Enforce to flip it.
#
# Usage (from ANY PowerShell - self-elevates if not admin):
#   .\scripts\install-dev.ps1                    # dry-run (safe)
#   .\scripts\install-dev.ps1 -Enforce           # actually shuts down on curfew
#   .\scripts\install-dev.ps1 -Uninstall
#
# If PowerShell's execution policy blocks the script:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-dev.ps1
#
# Why elevation: schtasks /Create needs admin to register the Scheduled Task
# reliably. The script triggers exactly one UAC prompt - the rest runs in
# the elevated child process.
# =============================================================================

[CmdletBinding()]
param(
    [switch]$Enforce,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$TaskName = 'NightOwlDaemon'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DaemonExe = Join-Path $RepoRoot 'packages\daemon\dist\nightowld.exe'
$DaemonDir = Split-Path -Parent $DaemonExe

function Info($msg)  { Write-Host "[OK] $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "[!]  $msg" -ForegroundColor Yellow }
function Die($msg)   { Write-Host "[X]  $msg" -ForegroundColor Red; exit 1 }

# ---------- Self-elevate if not admin ----------
# Friendly DX for developer friends running from a normal PowerShell: detect
# non-admin state, re-launch ourselves via UAC with the same parameters, and
# exit the original instance. -NoExit keeps the elevated window open so they
# can read the output. -ExecutionPolicy Bypass dodges policy on locked-down
# machines (the policy is scoped to the child process, not persisted).
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Host "[i]  Not running as Administrator - relaunching with UAC..." -ForegroundColor Cyan

    $argList = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    foreach ($key in $PSBoundParameters.Keys) {
        $val = $PSBoundParameters[$key]
        if ($val -is [switch] -and $val.IsPresent) {
            $argList += "-$key"
        } elseif ($val -isnot [switch]) {
            $argList += "-$key"
            $argList += "`"$val`""
        }
    }

    try {
        Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -ErrorAction Stop
    } catch {
        Die "UAC elevation was cancelled or denied. NightOwl install needs admin to register the Scheduled Task."
    }
    exit 0
}

# ---------- Uninstall ----------
if ($Uninstall) {
    Info "Uninstalling NightOwl dev task..."
    & schtasks /End /TN $TaskName 2>$null
    Start-Sleep -Milliseconds 500
    & taskkill /F /IM nightowld.exe 2>$null
    & schtasks /Delete /TN $TaskName /F 2>$null
    Info "Task deleted. The .exe is left in place at $DaemonExe for re-install."
    exit 0
}

# ---------- Pre-flight ----------
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Die "npm not found. Install Node 18+ first (https://nodejs.org)."
}

# ---------- Build .exe if missing ----------
if (-not (Test-Path $DaemonExe)) {
    Info "nightowld.exe not found - building..."
    Push-Location $RepoRoot
    try {
        # The build steps are run as the elevated admin. That's fine for dev
        # installs - we don't need to drop privs the way install-dev.sh does
        # (Windows admin context can still see user-scope npm caches).
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Die "npm install failed." }

        & npm run build
        if ($LASTEXITCODE -ne 0) { Die "Build (tsc) failed." }

        & npm run package:win -w packages/daemon
        if ($LASTEXITCODE -ne 0) { Die "pkg .exe build failed." }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path $DaemonExe)) { Die "Build claimed success but $DaemonExe is missing." }

Info "daemon:      $DaemonExe"

# ---------- Resolve target user ----------
# We want the task to run as the user who invoked sudo / Run-As-Administrator,
# not as Administrator itself. PowerShell's elevation runs in the admin context
# but the original user is recorded in the parent token.
# For most home machines, USERNAME + USERDOMAIN suffice.
$TargetUser = if ($env:USERDOMAIN) { "$($env:USERDOMAIN)\$($env:USERNAME)" } else { $env:USERNAME }
Info "user:        $TargetUser"

# ---------- Mode ----------
if ($Enforce) {
    $DryRunFlag = ''
    $ModeHuman  = 'ENFORCING (will actually shut down the computer on curfew!)'
    Warn "Running in ENFORCE mode. The daemon WILL halt your computer at curfew."
    $confirm = Read-Host "Type 'yes' to confirm"
    if ($confirm -ne 'yes') { Die "Aborted." }
} else {
    $DryRunFlag = '<Arguments>--dry-run</Arguments>'
    $ModeHuman  = 'DRY-RUN (warnings + notifications, no shutdown)'
}
Info "mode:        $ModeHuman"

# ---------- Generate task XML ----------
function HtmlEscape([string]$s) {
    $s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;'
}

$escUser = HtmlEscape $TargetUser
$escExe  = HtmlEscape $DaemonExe
$escDir  = HtmlEscape $DaemonDir

$TaskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>NightOwl curfew enforcement daemon (dev)</Description>
    <Author>NightOwl</Author>
    <URI>\$TaskName</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$escUser</UserId>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$escUser</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$escExe</Command>
      $DryRunFlag
      <WorkingDirectory>$escDir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$XmlPath = Join-Path $env:TEMP "NightOwlDaemon-dev-$([int][double]::Parse((Get-Date -UFormat %s))).xml"
# schtasks /XML requires UTF-16 LE with BOM.
[System.IO.File]::WriteAllText($XmlPath, $TaskXml, [System.Text.UnicodeEncoding]::new($false, $true))
Info "task XML:    $XmlPath"

# ---------- Register + start ----------
& schtasks /End /TN $TaskName 2>$null
& schtasks /Delete /TN $TaskName /F 2>$null

& schtasks /Create /XML $XmlPath /TN $TaskName /F
if ($LASTEXITCODE -ne 0) { Die "schtasks /Create failed." }

& schtasks /Run /TN $TaskName
if ($LASTEXITCODE -ne 0) { Warn "schtasks /Run returned non-zero - task may start at next logon instead." }

Remove-Item $XmlPath -Force -ErrorAction SilentlyContinue

Info "Daemon registered and started."

Write-Host ""
Write-Host "============== NEXT STEPS ==============" -ForegroundColor Cyan
Write-Host "1. Watch the log:    Get-Content `$env:PROGRAMDATA\NightOwl\nightowl.log -Wait -Tail 20"
Write-Host "2. Check it's alive: schtasks /Query /TN $TaskName /FO LIST"
Write-Host "3. Drop a test schedule into `$env:APPDATA\NightOwl\schedule.json"
Write-Host "4. To uninstall:     .\scripts\install-dev.ps1 -Uninstall"
Write-Host ""
Write-Host "Mode: $ModeHuman"
