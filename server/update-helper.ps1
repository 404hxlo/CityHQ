# Puts a new version of CityHQ in place. CityHQ copies this script out of its own folder and runs it
# just before it closes, because its files can't be replaced while it runs. The game server is never
# touched. If the new version doesn't start within two minutes, the old one is put back.
param(
  [Parameter(Mandatory)] [int] $WaitPid,
  [Parameter(Mandatory)] [string] $Install,
  [Parameter(Mandatory)] [string] $New,
  [Parameter(Mandatory)] [string] $ExeName,
  [Parameter(Mandatory)] [string] $Marker,
  [Parameter(Mandatory)] [string] $Log,
  [string] $ArgsB64 = ''
)
$ErrorActionPreference = 'Stop'
function Say([string] $message) {
  try { Add-Content -LiteralPath $Log -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $message) -Encoding UTF8 } catch {}
}

# The window's own command-line options (a test copy's data folder, for example), each quoted if needed.
$launchArgs = @()
if ($ArgsB64) {
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64)) | ConvertFrom-Json
  $launchArgs = @($decoded | Where-Object { $_ } | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
}
function Start-CityHQ([string] $folder) {
  $exe = Join-Path $folder 'CityHQ.exe'
  if (-not (Test-Path -LiteralPath $exe)) { $exe = Join-Path $folder $ExeName }
  if ($launchArgs.Count) { Start-Process -FilePath $exe -ArgumentList $launchArgs -WorkingDirectory $folder | Out-Null }
  else { Start-Process -FilePath $exe -WorkingDirectory $folder | Out-Null }
}
function Get-Running([string] $folder) {
  $prefix = $folder.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -Filter "Name='$ExeName' OR Name='CityHQ.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}
function Wait-Closed([string] $folder, [int] $seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Running $folder).Count -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 500 }
  return -not (Get-Running $folder).Count
}

Say "Updating CityHQ in $Install"
try { Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction SilentlyContinue } catch {}
if (-not (Wait-Closed $Install 60)) {
  Say 'CityHQ did not close within two minutes, so nothing was changed.'
  exit 1
}

$old = "$Install.old"
if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }

# Swap whole folders, so no file from the old version is left behind. Something holding the folder open
# (an Explorer window on it, say) can stop the rename for a moment, so try for a while.
$swapped = $false
for ($i = 0; $i -lt 30 -and -not $swapped; $i++) {
  try { Rename-Item -LiteralPath $Install -NewName (Split-Path $old -Leaf); $swapped = $true }
  catch { Start-Sleep -Seconds 1 }
}
if ($swapped) {
  try { Move-Item -LiteralPath $New -Destination $Install }
  catch {
    Say "Could not move the new version into place: $($_.Exception.Message). Putting the old one back."
    Rename-Item -LiteralPath $old -NewName (Split-Path $Install -Leaf)
    Start-CityHQ $Install
    exit 1
  }
} else {
  # The folder stayed in use: copy the new files over the old ones instead (nothing can be put back).
  Say 'The folder was in use, so the new files are copied over the old ones.'
  & robocopy.exe $New $Install /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Say "Copying the new version failed (robocopy $LASTEXITCODE)." }
}

if (Test-Path -LiteralPath $Marker) { Remove-Item -LiteralPath $Marker -Force }
$env:QBC_UPDATE_MARKER = $Marker
Start-CityHQ $Install

# The new version writes the marker once it is up. Without it, go back to the version that worked.
$until = (Get-Date).AddMinutes(2)
while (-not (Test-Path -LiteralPath $Marker) -and (Get-Date) -lt $until) { Start-Sleep -Seconds 1 }
if (Test-Path -LiteralPath $Marker) {
  Say 'The new version started.'
  if ($swapped) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
} elseif ($swapped) {
  Say 'The new version did not start within two minutes. Putting the old version back.'
  Get-Running $Install | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  [void](Wait-Closed $Install 30)
  $failed = "$Install.failed"
  if (Test-Path -LiteralPath $failed) { Remove-Item -LiteralPath $failed -Recurse -Force -ErrorAction SilentlyContinue }
  Rename-Item -LiteralPath $Install -NewName (Split-Path $failed -Leaf)
  Rename-Item -LiteralPath $old -NewName (Split-Path $Install -Leaf)
  Remove-Item Env:\QBC_UPDATE_MARKER
  Start-CityHQ $Install
} else {
  Say 'The new version did not report that it started. It was copied over the old one, so check that CityHQ opens.'
}
$staging = Split-Path $New -Parent
if ((Test-Path -LiteralPath $staging) -and -not (Get-ChildItem -LiteralPath $staging -Force)) { Remove-Item -LiteralPath $staging -Force }
