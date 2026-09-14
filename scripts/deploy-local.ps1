#!/usr/bin/env pwsh
# WPDock — Local deploy script
# Builds extension, packages VSIX, installs into VS Code

Set-Location $PSScriptRoot\..

$npmCmd = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }
$codeCmd = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'code.cmd' } else { 'code' }
$vsceCli = Join-Path (Get-Location) "node_modules/@vscode/vsce/vsce"

Write-Host "`n[1/4] Packing WP agent plugin..." -ForegroundColor Cyan
node scripts/pack-agent.js
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED" -ForegroundColor Red; exit 1 }

Write-Host "[2/4] Bundling extension with esbuild..." -ForegroundColor Cyan
node scripts/build-extension.js
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED" -ForegroundColor Red; exit 1 }

Write-Host "[3/4] Building WebView UI..." -ForegroundColor Cyan
Set-Location webview-ui
& $npmCmd run build --silent
Set-Location ..
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED" -ForegroundColor Red; exit 1 }

Write-Host "[4/4] Packaging and installing VSIX..." -ForegroundColor Cyan

# Remove all old VSIX files before packaging a fresh one
$oldVsix = Get-ChildItem "*.vsix" -ErrorAction SilentlyContinue
foreach ($f in $oldVsix) {
  Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
  Write-Host "  Removed old VSIX: $($f.Name)" -ForegroundColor DarkGray
}

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$rawVersion = [string]$pkg.version
$localVersion = [regex]::Match($rawVersion, '^\d+\.\d+\.\d+').Value
if ([string]::IsNullOrWhiteSpace($localVersion)) {
  Write-Host "Invalid base version in package.json: $rawVersion" -ForegroundColor Red
  exit 1
}

# Remove old wpdock extension folders to prevent accumulation
$extensionsDir = if ($IsWindows -or $env:OS -eq 'Windows_NT') { Join-Path $env:USERPROFILE ".vscode\extensions" } else { Join-Path $HOME ".vscode/extensions" }
$oldExtDirs = Get-ChildItem $extensionsDir -Directory -Filter "wpdock.wpdock-*" -ErrorAction SilentlyContinue
foreach ($d in $oldExtDirs) {
  Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "  Removed old extension: $($d.Name)" -ForegroundColor DarkGray
}

Write-Host "Packaging version: $localVersion" -ForegroundColor DarkGray
node $vsceCli package $localVersion --no-dependencies --allow-missing-repository
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED" -ForegroundColor Red; exit 1 }

$vsix = Get-ChildItem "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) {
  Write-Host "No .vsix file found" -ForegroundColor Red; exit 1
}

Write-Host "Installing $($vsix.Name) directly into extensions folder..." -ForegroundColor DarkCyan

$extensionDir = Join-Path $extensionsDir "wpdock.wpdock-$localVersion"

# Extract VSIX (it's a ZIP) to a temp folder, then move extension/ subfolder
$tempExtract = Join-Path $env:TEMP ("wpdock-extract-" + $PID)
if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
New-Item -ItemType Directory -Path $tempExtract | Out-Null

try {
  # Rename to .zip for Expand-Archive
  $zipPath = Join-Path $env:TEMP ("wpdock-" + $PID + ".zip")
  Copy-Item $vsix.FullName $zipPath -Force
  Expand-Archive -Path $zipPath -DestinationPath $tempExtract -Force
  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

  $innerExtension = Join-Path $tempExtract "extension"
  if (-not (Test-Path $innerExtension)) {
    Write-Host "Unexpected VSIX structure - 'extension/' folder not found." -ForegroundColor Red
    exit 1
  }

  # Copy files into the target extension directory
  if (-not (Test-Path $extensionDir)) {
    New-Item -ItemType Directory -Path $extensionDir | Out-Null
  }
  Copy-Item -Path "$innerExtension\*" -Destination $extensionDir -Recurse -Force
  Write-Host "`nInstalled to: $extensionDir" -ForegroundColor Green
}
finally {
  Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
}

# Trigger reload window
Write-Host "Reloading VS Code window..." -ForegroundColor DarkGray
& $codeCmd --reuse-window --command workbench.action.reloadWindow 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host "VS Code window reloaded." -ForegroundColor Green
}
else {
  Write-Host "Run 'Developer: Reload Window' manually (Ctrl+Shift+P)." -ForegroundColor Yellow
}
