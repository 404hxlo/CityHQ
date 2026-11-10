<#
.SYNOPSIS
  Sets up a QBCore FiveM server and the CityHQ app on this PC.

.DESCRIPTION
  Everything goes into one folder. Nothing is installed into Windows, no services are created,
  and other FiveM servers or databases on the PC are left alone. Running it again continues
  where it stopped.

  It downloads FiveM's server (from fivem.net), MariaDB and Node.js (from their official sites),
  creates a private database that only this PC can reach, builds CityHQ, and then opens
  txAdmin so you can finish the setup there.
#>
[CmdletBinding()]
param(
  [string]$Root,
  [int]$GamePort = 30120,
  [int]$TxAdminPort = 40120,
  [int]$DatabasePort = 3308,
  [int]$AppPort = 40125,
  # Answer every question with its default.
  [switch]$Yes,
  # Don't start txAdmin at the end.
  [switch]$NoStart,
  [switch]$NoShortcuts
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$MariaDbVersion = '12.3.3'
$NodeVersion = '26.13.0'
$MariaDbZip = "mariadb-$MariaDbVersion-winx64.zip"
$NodeZip = "node-v$NodeVersion-win-x64.zip"
$MariaDbBase = "https://archive.mariadb.org/mariadb-$MariaDbVersion/winx64-packages"
$NodeBase = "https://nodejs.org/dist/v$NodeVersion"
$FiveMVersions = 'https://changelogs-live.fivem.net/api/changelog/versions/win32/server'
$Marker = '.setup-in-progress'
$Source = Split-Path -Parent $PSScriptRoot

function Say([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Note([string]$Text) { Write-Host "   $Text" }
function Warn([string]$Text) { Write-Host "   $Text" -ForegroundColor Yellow }
function Stop-Setup([string]$Text) { Write-Host "`nSetup stopped: $Text" -ForegroundColor Red; exit 1 }

function Test-PortFree([int]$Port) {
  $tcp = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  $udp = Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue
  return -not ($tcp -or $udp)
}

function Find-FreePort([string]$Name, [int]$Preferred, [int[]]$Taken) {
  for ($p = $Preferred; $p -lt $Preferred + 30; $p++) {
    if (($Taken -notcontains $p) -and (Test-PortFree $p)) {
      if ($p -ne $Preferred) { Warn "Port $Preferred is already in use on this PC, so the $Name will use $p instead." }
      return $p
    }
  }
  Stop-Setup "No free port found for the $Name near $Preferred."
}

function Get-File([string]$Url, [string]$Dest) {
  $part = "$Dest.part"
  & curl.exe --location --fail --retry 6 --retry-delay 3 --retry-all-errors --connect-timeout 30 --progress-bar --output $part $Url
  if ($LASTEXITCODE -ne 0) { Remove-Item $part -Force -ErrorAction SilentlyContinue; Stop-Setup "Could not download $Url. Check your internet connection and run setup again." }
  Move-Item -Force $part $Dest
}

function Test-Zip([string]$File) {
  if (-not (Test-Path $File)) { return $false }
  # Through cmd, so tar's messages can be thrown away without PowerShell treating them as errors.
  & cmd.exe /d /c "tar.exe -tf `"$File`" >nul 2>&1"
  return $LASTEXITCODE -eq 0
}

function Test-Sha256([string]$File, [string]$ListFile, [string]$Name) {
  $line = Get-Content $ListFile | Where-Object { $_ -match "\s\*?(\./)?$([regex]::Escape($Name))\s*$" } | Select-Object -First 1
  if (-not $line) { return $false }
  $expected = ($line -split '\s+')[0].ToLower()
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLower() -eq $expected
}

function Expand-Zip([string]$File, [string]$Dest) {
  New-Item -ItemType Directory -Force $Dest | Out-Null
  & tar.exe -xf $File -C $Dest
  if ($LASTEXITCODE -ne 0) { Stop-Setup "Could not unpack $(Split-Path -Leaf $File)." }
}

function Invoke-Checked([string]$What, [scriptblock]$Run) {
  & $Run
  if ($LASTEXITCODE -ne 0) { Stop-Setup "$What failed. Run setup again to retry; it continues where it stopped." }
}

function Wait-Port([int]$Port, [int]$Seconds) {
  for ($i = 0; $i -lt $Seconds * 2; $i++) {
    if (-not (Test-PortFree $Port)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# ---------------------------------------------------------------- checks
Write-Host 'CityHQ setup' -ForegroundColor Green
Write-Host 'This creates one folder holding a QBCore FiveM server, its own database and the CityHQ app.'

if (-not [Environment]::Is64BitOperatingSystem) { Stop-Setup 'This needs 64-bit Windows.' }
foreach ($tool in 'curl.exe', 'tar.exe', 'robocopy.exe') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-Setup "$tool is missing. It comes with Windows 10 (2018 or newer) and Windows 11." }
}
if (-not (Test-Path (Join-Path $Source 'package.json'))) { Stop-Setup "The app's files were not found next to this script. Extract the whole download first, then run Setup.cmd from it." }

if (-not $Root) {
  $default = 'C:\QBCore-Server'
  if (Test-Path 'D:\') { $default = 'D:\QBCore-Server' }
  if ($Yes) { $Root = $default }
  else {
    $answer = Read-Host "`nWhere should the server folder go? Press Enter for $default"
    if ($answer.Trim()) { $Root = $answer.Trim().Trim('"') } else { $Root = $default }
  }
}
$Root = [IO.Path]::GetFullPath($Root)
if ($Root -notmatch '^[A-Za-z]:\\[^\s]+$') { Stop-Setup "Choose a folder on a drive of this PC with no spaces in its path, such as C:\QBCore-Server. You entered: $Root" }
if (($Root -ieq $Source) -or $Root.StartsWith("$Source\", [StringComparison]::OrdinalIgnoreCase)) { Stop-Setup 'Choose a folder outside the download you are running setup from.' }

$resuming = Test-Path (Join-Path $Root $Marker)
if ((Test-Path $Root) -and -not $resuming) {
  if (Test-Path (Join-Path $Root 'server\FXServer.exe')) { Stop-Setup "$Root already holds a server. Choose another folder, or open CityHQ from that one." }
  if (Get-ChildItem -Force $Root | Select-Object -First 1) { Stop-Setup "$Root is not empty. Choose a new or empty folder so nothing of yours is overwritten." }
}

$drive = Get-PSDrive -Name $Root.Substring(0, 1) -ErrorAction SilentlyContinue
if (-not $drive) { Stop-Setup "Drive $($Root.Substring(0, 2)) does not exist." }
if ($drive.Free -lt 4GB) { Stop-Setup "Drive $($Root.Substring(0, 2)) has under 4 GB free. The server needs about 3 GB to start with." }

Say 'Checking ports'
if ($resuming -and (Test-Path (Join-Path $Root 'qbcontrol.json'))) {
  $saved = Get-Content (Join-Path $Root 'qbcontrol.json') -Raw | ConvertFrom-Json
  $GamePort = $saved.gamePort; $TxAdminPort = $saved.txAdminPort; $DatabasePort = $saved.databasePort; $AppPort = $saved.appPort
  Note 'Continuing an earlier setup with the ports it chose.'
} else {
  $GamePort = Find-FreePort 'game server' $GamePort @()
  $TxAdminPort = Find-FreePort 'txAdmin panel' $TxAdminPort @($GamePort)
  $DatabasePort = Find-FreePort 'database' $DatabasePort @($GamePort, $TxAdminPort)
  $AppPort = Find-FreePort 'CityHQ app' $AppPort @($GamePort, $TxAdminPort, $DatabasePort)
}
Note "Game server $GamePort, txAdmin $TxAdminPort, database $DatabasePort, app $AppPort"

$sacOn = $false
try { $sacOn = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction Stop).VerifiedAndReputablePolicyState -eq 1 } catch { }
if ($sacOn) {
  Warn 'Windows Smart App Control is ON on this PC. It blocks one of the files FiveM''s server needs,'
  Warn 'so the server will not start until you turn it off: Windows Security > App & browser control >'
  Warn 'Smart App Control settings > Off. Setup will install everything, but will not start the server.'
}

if (-not $Yes) {
  $go = Read-Host "`nInstall into $Root ? This downloads about 250 MB. Type Y to continue"
  if ($go -notmatch '^(y|yes)$') { Stop-Setup 'Nothing was changed.' }
}

# ---------------------------------------------------------------- folders
$Downloads = Join-Path $Root 'downloads'
New-Item -ItemType Directory -Force $Root, $Downloads, (Join-Path $Root 'logs'), (Join-Path $Root 'db'), (Join-Path $Root 'tools'), (Join-Path $Root 'txData') | Out-Null
Set-Content -LiteralPath (Join-Path $Root $Marker) -Value 'Setup has not finished. Run Setup.cmd again to continue.' -Encoding ascii
# Saved first, so the app and a later run of setup agree on the ports.
[ordered]@{ gamePort = $GamePort; txAdminPort = $TxAdminPort; databasePort = $DatabasePort; appPort = $AppPort } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root 'qbcontrol.json') -Encoding ascii

# ---------------------------------------------------------------- FiveM server
Say 'FiveM server'
$fxExe = Join-Path $Root 'server\FXServer.exe'
if (Test-Path $fxExe) { Note 'Already there.' }
else {
  $fxZip = Join-Path $Downloads 'server.zip'
  if (-not (Test-Zip $fxZip)) {
    $versions = (& curl.exe -sS --fail --retry 4 --retry-all-errors $FiveMVersions) | ConvertFrom-Json
    if (-not $versions.recommended_download) { Stop-Setup 'Could not read the list of FiveM server versions. Try again in a few minutes.' }
    if ($versions.recommended_download -notmatch '^https://runtime\.fivem\.net/') { Stop-Setup 'FiveM returned an unexpected download address, so nothing was downloaded.' }
    Note "Downloading the recommended build $($versions.recommended)..."
    Get-File $versions.recommended_download $fxZip
    if (-not (Test-Zip $fxZip)) { Remove-Item $fxZip -Force; Stop-Setup 'The FiveM server download was damaged. Run setup again.' }
  }
  Expand-Zip $fxZip (Join-Path $Root 'server')
  if (-not (Test-Path $fxExe)) { Stop-Setup 'FXServer.exe was not in the download.' }
  Note 'Installed.'
}

# ---------------------------------------------------------------- database
Say 'Private database (MariaDB)'
$dbHome = Join-Path $Root 'db\mariadb'
$dbData = Join-Path $Root 'db\data'
$dbIni = Join-Path $Root 'db\my.ini'
if (Test-Path (Join-Path $dbHome 'bin\mariadbd.exe')) { Note 'Already there.' }
else {
  $zip = Join-Path $Downloads $MariaDbZip
  $sums = Join-Path $Downloads 'mariadb-sha256sums.txt'
  if (-not (Test-Zip $zip)) { Note "Downloading MariaDB $MariaDbVersion..."; Get-File "$MariaDbBase/$MariaDbZip" $zip }
  Get-File "$MariaDbBase/sha256sums.txt" $sums
  if (-not (Test-Sha256 $zip $sums $MariaDbZip)) { Remove-Item $zip -Force; Stop-Setup 'The MariaDB download did not match its published checksum. Run setup again.' }
  $tmp = Join-Path $Root 'db\unpack'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Zip $zip $tmp
  Move-Item (Join-Path $tmp "mariadb-$MariaDbVersion-winx64") $dbHome
  Remove-Item $tmp -Recurse -Force
  Note 'Installed.'
}
$slashRoot = $Root.Replace('\', '/')
@"
[mysqld]
datadir=$slashRoot/db/data
port=$DatabasePort
bind-address=127.0.0.1
character-set-server=utf8mb4
collation-server=utf8mb4_general_ci
innodb_buffer_pool_size=256M
max_connections=100
log-error=$slashRoot/logs/mariadb.err

[client]
port=$DatabasePort
"@ | Set-Content -LiteralPath $dbIni -Encoding ascii
if (Test-Path (Join-Path $dbData 'mysql')) { Note 'Database files already created.' }
else {
  Note 'Creating the database files...'
  Invoke-Checked 'Creating the database' { & (Join-Path $dbHome 'bin\mariadb-install-db.exe') "--datadir=$dbData" | Out-Null }
}
Note 'Checking that it starts...'
$db = Start-Process -FilePath (Join-Path $dbHome 'bin\mariadbd.exe') -ArgumentList "`"--defaults-file=$dbIni`"" -WindowStyle Hidden -PassThru
if (-not (Wait-Port $DatabasePort 40)) { Stop-Setup "The database did not start. See $Root\logs\mariadb.err for the reason." }
$client = @("--host=127.0.0.1", "--port=$DatabasePort", '--user=root', '--skip-ssl')
$version = & (Join-Path $dbHome 'bin\mariadb.exe') @client --batch --skip-column-names '--execute=SELECT VERSION();'
if ($LASTEXITCODE -ne 0) { Stop-Setup 'The database started but did not answer.' }
Note "Working: $version, reachable only from this PC."
& (Join-Path $dbHome 'bin\mariadb-admin.exe') @client shutdown
$db.WaitForExit(30000) | Out-Null

# ---------------------------------------------------------------- Node.js (only used to build the app)
Say 'Node.js'
$nodeHome = Join-Path $Root 'tools\node'
if (Test-Path (Join-Path $nodeHome 'node.exe')) { Note 'Already there.' }
else {
  $zip = Join-Path $Downloads $NodeZip
  $sums = Join-Path $Downloads 'node-SHASUMS256.txt'
  if (-not (Test-Zip $zip)) { Note "Downloading Node.js $NodeVersion..."; Get-File "$NodeBase/$NodeZip" $zip }
  Get-File "$NodeBase/SHASUMS256.txt" $sums
  if (-not (Test-Sha256 $zip $sums $NodeZip)) { Remove-Item $zip -Force; Stop-Setup 'The Node.js download did not match its published checksum. Run setup again.' }
  $tmp = Join-Path $Root 'tools\unpack'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Zip $zip $tmp
  Move-Item (Join-Path $tmp "node-v$NodeVersion-win-x64") $nodeHome
  Remove-Item $tmp -Recurse -Force
  Note 'Installed.'
}

# ---------------------------------------------------------------- the app
Say 'CityHQ'
$appHome = Join-Path $Root 'control-app'
$appExe = Join-Path $appHome 'release\CityHQ-win32-x64\CityHQ.exe'
if (Test-Path $appExe) { Note 'Already built.' }
else {
  Note 'Copying the app...'
  & robocopy.exe $Source $appHome /E /XD node_modules release dist .git /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Stop-Setup 'Could not copy the app into the server folder.' }
  $env:Path = "$nodeHome;$env:Path"
  $buildLog = Join-Path $Root 'logs\setup-app-build.log'
  Push-Location $appHome
  try {
    # Through cmd with a relative log path, so the long build output stays off the screen.
    Note 'Downloading what the app is built from (a few minutes)...'
    & cmd.exe /d /c 'npm.cmd ci --no-audit --no-fund > ..\logs\setup-app-build.log 2>&1'
    if ($LASTEXITCODE -ne 0) { Stop-Setup "Downloading the app's parts failed. The details are in $buildLog. Run setup again to retry; it continues where it stopped." }
    Note 'Building the app...'
    & cmd.exe /d /c 'npm.cmd run package >> ..\logs\setup-app-build.log 2>&1'
    if ($LASTEXITCODE -ne 0) { Stop-Setup "Building the app failed. The details are in $buildLog. Run setup again to retry." }
  } finally { Pop-Location }
  if (-not (Test-Path $appExe)) { Stop-Setup 'The app was built but its program file is missing.' }
  Note 'Built.'
}

# ---------------------------------------------------------------- helper files
Say 'Finishing'
@"
@echo off
title QBCore Server (txAdmin)
cd /d "%~dp0"

rem Start the private QBCore database unless it is already running
netstat -ano | findstr /R /C:"127\.0\.0\.1:$DatabasePort .*LISTENING" >nul
if errorlevel 1 (
  start "QBCore Database" /MIN "%~dp0db\mariadb\bin\mariadbd.exe" --defaults-file="%~dp0db\my.ini"
)

set TXHOST_FXS_PORT=$GamePort
set TXHOST_TXA_PORT=$TxAdminPort
set TXHOST_DEFAULT_DBHOST=127.0.0.1
set TXHOST_DEFAULT_DBPORT=$DatabasePort
set TXHOST_DEFAULT_DBUSER=root

cd /d "%~dp0server"
FXServer.exe
pause
"@ | Set-Content -LiteralPath (Join-Path $Root 'Start-Server.bat') -Encoding ascii
Copy-Item (Join-Path $PSScriptRoot 'SERVER-FOLDER.md') (Join-Path $Root 'README.md') -Force

if (-not $NoShortcuts) {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($place in @($Root, [Environment]::GetFolderPath('Desktop'))) {
    $link = $shell.CreateShortcut((Join-Path $place 'CityHQ.lnk'))
    $link.TargetPath = $appExe
    $link.WorkingDirectory = Split-Path -Parent $appExe
    $link.Description = 'Manage your QBCore server'
    $link.Save()
  }
  Note 'Added a CityHQ shortcut to your desktop.'
}
Remove-Item -LiteralPath (Join-Path $Root $Marker) -Force

Write-Host "`nDone. Your server folder is $Root" -ForegroundColor Green
Write-Host @"

What happens next:
  1. txAdmin opens in your browser. A black window opens too: it shows a PIN that txAdmin asks for.
  2. In txAdmin, create your account, then pick Popular Recipes > QBCore Framework.
  3. When it asks about the database, use:
        Host 127.0.0.1    Port $DatabasePort    User root    Password (leave empty)
  4. When txAdmin says the server is running, close the black window.
  5. Open CityHQ from your desktop and press Start. Use it from then on.

  To play: open FiveM, press F8 and type   connect localhost:$GamePort
"@

if ($sacOn) {
  Warn 'Smart App Control is still on, so nothing was started. Turn it off (see above), then'
  Warn "double-click Start-Server.bat in $Root and open http://localhost:$TxAdminPort"
} elseif (-not $NoStart) {
  Start-Process -FilePath (Join-Path $Root 'Start-Server.bat') -WorkingDirectory $Root
  if (Wait-Port $TxAdminPort 60) { Start-Process "http://localhost:$TxAdminPort" }
  else { Warn "txAdmin has not opened yet. When the black window shows a PIN, open http://localhost:$TxAdminPort" }
}
