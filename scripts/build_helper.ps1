$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root ".venv\\Scripts\\python.exe"

if (-not (Test-Path $python)) {
  Write-Error "Virtual environment not found: $python"
  exit 1
}

Set-Location $root
& $python -m PyInstaller `
  --noconfirm `
  --clean `
  --name YMLocalOverrideHelper `
  --onedir `
  --add-data "static;static" `
  app\main.py
