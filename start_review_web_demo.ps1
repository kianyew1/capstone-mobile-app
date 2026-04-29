$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$frontendDir = Join-Path $repoRoot "ecg-review-web"
$backendTarget = "https://capstone-mobile-app.onrender.com"
$frontendUrl = "http://127.0.0.1:5173"

function Require-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command '$name' was not found on PATH."
  }
}

Require-Command "node"
Require-Command "npm"

if (-not (Test-Path $frontendDir)) {
  throw "Could not find ecg-review-web at '$frontendDir'."
}

Write-Host ""
Write-Host "PulseSense demo review web launcher"
Write-Host "Repo root: $repoRoot"
Write-Host "Frontend:  $frontendDir"
Write-Host "Backend:   $backendTarget"
Write-Host "URL:       $frontendUrl"
Write-Host ""

Push-Location $frontendDir
try {
  if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
    Write-Host "Installing frontend dependencies with npm install..."
    npm install
  }

  $env:VITE_BACKEND_URL = $backendTarget

  Write-Host ""
  Write-Host "Starting ecg-review-web..."
  Write-Host "Open $frontendUrl in a browser after the dev server is ready."
  Write-Host "Press Ctrl+C in this window to stop the server."
  Write-Host ""

  npm run dev -- --host=127.0.0.1 --port=5173
}
finally {
  Pop-Location
}
