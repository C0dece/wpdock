#!/usr/bin/env pwsh
# WPDock — one-command local smoke flow:
# 1) build + package + install extension
# 2) reload VS Code window
# 3) start test site via command URI

param(
  [string]$SiteName = "test1"
)

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\.."

Write-Host "`n[1/6] Packing WP agent plugin..." -ForegroundColor Cyan
node scripts/pack-agent.js
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: pack-agent" -ForegroundColor Red
  exit 1
}

Write-Host "[2/6] Compiling extension + webview..." -ForegroundColor Cyan
npm.cmd run compile
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: compile" -ForegroundColor Red
  exit 1
}

Write-Host "[3/6] Packaging VSIX..." -ForegroundColor Cyan
cmd /c ".\\node_modules\\.bin\\vsce.cmd package --no-dependencies --allow-missing-repository"
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: vsce package" -ForegroundColor Red
  exit 1
}

$vsix = Get-ChildItem "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) {
  Write-Host "FAILED: no .vsix produced" -ForegroundColor Red
  exit 1
}

Write-Host "[4/6] Installing VSIX..." -ForegroundColor Cyan
code --install-extension $vsix.FullName --force
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: code --install-extension" -ForegroundColor Red
  exit 1
}

$sitesPath = Join-Path $env:APPDATA "Code\User\globalStorage\wpdock.wpdock\sites.json"
if (-not (Test-Path $sitesPath)) {
  Write-Host "FAILED: sites.json not found at $sitesPath" -ForegroundColor Red
  Write-Host "Create a site first in WPDock, then run this command again." -ForegroundColor Yellow
  exit 1
}

$sites = Get-Content $sitesPath -Raw | ConvertFrom-Json
if (-not $sites -or $sites.Count -eq 0) {
  Write-Host "FAILED: no local sites found in WPDock" -ForegroundColor Red
  exit 1
}

$site = $sites | Where-Object { $_.name -eq $SiteName } | Select-Object -First 1
if (-not $site) {
  $site = $sites | Select-Object -First 1
  Write-Host "Site '$SiteName' not found. Using '$($site.name)' instead." -ForegroundColor Yellow
}

Write-Host "[5/6] Reloading VS Code window..." -ForegroundColor Cyan
Start-Process "vscode://command/workbench.action.reloadWindow"

Write-Host "[6/6] Starting site '$($site.name)'..." -ForegroundColor Cyan
$argsJson = ConvertTo-Json @(@{ siteId = $site.id; label = $site.name }) -Compress
$encoded = [System.Uri]::EscapeDataString($argsJson)
Start-Process "vscode://command/wpdock.startSite?$encoded"

Write-Host "Opening site URL..." -ForegroundColor Cyan
$targetUrl = if ($site.domain) { "https://$($site.domain)" } else { "http://localhost:$($site.port)" }
Start-Process $targetUrl

Write-Host "`nSmoke flow completed for site '$($site.name)'" -ForegroundColor Green
Write-Host "If the site is still starting, wait a few seconds and refresh the browser." -ForegroundColor Yellow
