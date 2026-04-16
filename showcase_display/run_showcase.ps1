$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$backendScript = Join-Path $scriptDir "backend\app.py"
$repoVenvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"

if (Test-Path $repoVenvPython) {
    $python = $repoVenvPython
} else {
    $python = "python"
}

Write-Host "Starting Showcase Display..."
Write-Host "Backend: $backendScript"
Write-Host "Open:    http://127.0.0.1:8020"
Write-Host ""

& $python $backendScript
