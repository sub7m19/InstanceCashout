<#
  Instance Cashout: one-time setup on the Windows VPS (the same one that runs BUFFSQUAD).

  Run in PowerShell as Administrator:
    Set-ExecutionPolicy -Scope Process Bypass -Force
    irm https://raw.githubusercontent.com/sub7m19/InstanceCashout/main/deploy/windows/setup.ps1 -OutFile $env:TEMP\instancecashout-setup.ps1
    & $env:TEMP\instancecashout-setup.ps1

  What it does (safe to run again; it skips what's already done):
    - Installs Python 3.13 and Git if they're missing (BUFFSQUAD's setup already did)
    - Puts the code in C:\instancecashout\app and its Python packages in C:\instancecashout\venv
    - Creates C:\instancecashout\instancecashout.env (settings: Discord login, cookie key) and
      keeps uploaded photos in C:\instancecashout\data\uploads (backups next to them),
      both readable only by Administrators and SYSTEM
    - Adds three scheduled tasks, all running as SYSTEM:
        InstanceCashout App     starts the website at boot
        InstanceCashout Deploy  every minute: pulls new code from GitHub, tests it, restarts
        InstanceCashout Backup  nightly photo backup at 4:30 AM

  The website only listens on 127.0.0.1:8001 (BUFFSQUAD has 8000). Visitors reach it
  through BUFFSQUAD's Cloudflare tunnel: add a public hostname for $Domain pointing at
  http://localhost:8001. No ports need to be opened in the firewall.
#>
param(
  [string]$Domain = "instance-cashout.buffsquad.net",
  [int]$Port = 8001,
  [string]$Repo = "https://github.com/sub7m19/InstanceCashout.git"
)

$ErrorActionPreference = "Stop"
$Root = "C:\instancecashout"
$App = "$Root\app"
$Venv = "$Root\venv"
$EnvFile = "$Root\instancecashout.env"  # main.py reads it from next to the app folder
$PythonExe = "C:\Program Files\Python313\python.exe"
$GitExe = "C:\Program Files\Git\cmd\git.exe"
$PythonVersion = "3.13.17"

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Done($text) { Write-Host "    $text" -ForegroundColor Green }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run PowerShell as Administrator (right-click > Run as administrator), then run this again." }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = "SilentlyContinue"  # makes downloads much faster in Windows PowerShell
$hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)

# 1. Python
Step "Python $PythonVersion"
if (Test-Path $PythonExe) {
  Done "Already installed"
} else {
  $installer = "$env:TEMP\python-$PythonVersion-amd64.exe"
  Invoke-WebRequest "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe" -OutFile $installer
  Start-Process $installer -ArgumentList "/quiet InstallAllUsers=1 PrependPath=1 Include_test=0" -Wait
  if (-not (Test-Path $PythonExe)) { throw "Python didn't install. Run $installer by hand, tick 'Install for all users', then run this script again." }
  Done "Installed"
}

# 2. Git
Step "Git"
if (Test-Path $GitExe) {
  Done "Already installed"
} else {
  if ($hasWinget) {
    winget install --id Git.Git --exact --silent --accept-source-agreements --accept-package-agreements | Out-Null
  }
  if (-not (Test-Path $GitExe)) {
    $release = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ "User-Agent" = "instancecashout-setup" }
    $asset = $release.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
    $installer = "$env:TEMP\$($asset.name)"
    Invoke-WebRequest $asset.browser_download_url -OutFile $installer
    Start-Process $installer -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP-" -Wait
  }
  if (-not (Test-Path $GitExe)) { throw "Git didn't install. Install it from https://git-scm.com/download/win, then run this script again." }
  Done "Installed"
}
$env:Path = "C:\Program Files\Git\cmd;C:\Program Files\Python313;" + $env:Path
# The scheduled tasks run git as SYSTEM, which Git otherwise refuses in a folder an admin created.
if (-not (& $GitExe config --system --get-all safe.directory | Where-Object { $_ -eq "C:/instancecashout/app" })) {
  & $GitExe config --system --add safe.directory "C:/instancecashout/app"
}

# 3. Code
Step "Code in $App"
New-Item -ItemType Directory -Force -Path $Root, "$Root\data", "$Root\data\uploads", "$Root\data\backups", "$Root\logs", "$Root\bin" | Out-Null
if (Test-Path "$App\.git") {
  & $GitExe -C $App fetch --quiet origin main
  & $GitExe -C $App reset --hard --quiet origin/main
  Done "Updated to the latest version"
} else {
  & $GitExe clone --quiet --branch main $Repo $App
  if ($LASTEXITCODE -ne 0) { throw "Couldn't download the code from $Repo" }
  Done "Downloaded"
}

# 4. Python packages
Step "Python packages"
if (-not (Test-Path "$Venv\Scripts\python.exe")) { & $PythonExe -m venv $Venv }
& "$Venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check --upgrade pip
& "$Venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r "$App\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw "Installing Python packages failed. Check the internet connection and run this again." }
Done "Installed"

# 5. Settings file and private folders
Step "Settings file $EnvFile"
if (Test-Path $EnvFile) {
  Done "Already exists, left as it is"
} else {
  # Signs the login cookie. A new one signs everyone out, which is harmless.
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $sessionSecret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  @"
# Instance Cashout settings. Restart after editing: C:\instancecashout\bin\restart.cmd
PUBLIC_URL=https://$Domain

# Discord app "Instance Cashout": https://discord.com/developers/applications > OAuth2.
# Redirect to add there: https://$Domain/auth/discord/callback
DISCORD_CLIENT_ID=1564455712044884038
DISCORD_CLIENT_SECRET=

# Discord user ids (comma-separated) that can open /admin.html and edit the buy list.
ADMIN_DISCORD_IDS=

# Live package tracking on the admin Orders tab. Leave a carrier blank to skip it.
# FedEx: developer.fedex.com project with Basic Integrated Visibility (production keys)
FEDEX_TRACK_API_KEY=
FEDEX_TRACK_SECRET=
# UPS: developer.ups.com app with a subscription tier (Tracking is included)
UPS_TRACK_CLIENT_ID=
UPS_TRACK_CLIENT_SECRET=
# USPS: needs USPS's tracking access agreement to track packages others ship to you
USPS_CLIENT_ID=
USPS_CLIENT_SECRET=

SESSION_SECRET=$sessionSecret
"@ | Set-Content -Path $EnvFile -Encoding ASCII
  Done "Created. Add the Discord client secret to it."
}
# Only Administrators and SYSTEM can read the settings, customers' photos and the backups.
icacls $EnvFile /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" | Out-Null
icacls "$Root\data" /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null
Done "Locked to Administrators and SYSTEM"

# 6. Start scripts and scheduled tasks
Step "Scheduled tasks"
$settings = @"
set HOST=127.0.0.1
set PORT=$Port
set UPLOAD_DIR=$Root\data\uploads
set BACKUP_DIR=$Root\data\backups
set LOG_DIR=$Root\logs
"@
@"
@echo off
$settings
cd /d $App
"$Venv\Scripts\python.exe" main.py >> "$Root\logs\crash.log" 2>&1
"@ | Set-Content "$Root\bin\run-app.cmd" -Encoding ASCII
@"
@echo off
$settings
cd /d $App
"$Venv\Scripts\python.exe" backup.py >> "$Root\logs\backup.log" 2>&1
"@ | Set-Content "$Root\bin\run-backup.cmd" -Encoding ASCII
@"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$App\deploy\windows\deploy.ps1" -Restart
"@ | Set-Content "$Root\bin\restart.cmd" -Encoding ASCII
Set-Content "$Root\bin\port.txt" -Value $Port -Encoding ASCII  # read by deploy.ps1

$system = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$forever = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$short = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "InstanceCashout App" -Force -Principal $system -Settings $forever `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) `
  -Action (New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Root\bin\run-app.cmd`"") `
  -Description "Instance Cashout website" | Out-Null
Register-ScheduledTask -TaskName "InstanceCashout Deploy" -Force -Principal $system -Settings $short `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)) `
  -Action (New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$App\deploy\windows\deploy.ps1`"") `
  -Description "Every minute: deploy new code from GitHub, and restart the app if it stopped" | Out-Null
Register-ScheduledTask -TaskName "InstanceCashout Backup" -Force -Principal $system -Settings $short `
  -Trigger (New-ScheduledTaskTrigger -Daily -At "4:30 AM") `
  -Action (New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Root\bin\run-backup.cmd`"") `
  -Description "Nightly Instance Cashout photo backup (keeps 14)" | Out-Null
Done "InstanceCashout App, InstanceCashout Deploy, InstanceCashout Backup"

# 7. Cloudflare tunnel
Step "Cloudflare tunnel"
if (Get-Service cloudflared -ErrorAction SilentlyContinue) {
  Done "BUFFSQUAD's tunnel is installed. Add the public hostname $Domain -> http://localhost:$Port in Cloudflare if you haven't."
} else {
  Write-Host "    No tunnel on this server yet. Set up BUFFSQUAD's first (its deploy\WINDOWS-VPS.md, part 3)." -ForegroundColor Yellow
}

# 8. Start
Step "Starting Instance Cashout"
Start-ScheduledTask -TaskName "InstanceCashout App"
$up = $false
for ($i = 0; $i -lt 30 -and -not $up; $i++) {
  Start-Sleep -Seconds 2
  try { $up = (Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 3).ok } catch { }
}
if ($up) { Done "Running on this server at http://127.0.0.1:$Port" } else { Write-Host "    Didn't answer yet. Check $Root\logs\app.log and $Root\logs\crash.log" -ForegroundColor Yellow }

Write-Host ""
Write-Host "Setup finished." -ForegroundColor Green
Write-Host "Next: put the Discord client secret in $EnvFile (notepad $EnvFile), then run $Root\bin\restart.cmd"
