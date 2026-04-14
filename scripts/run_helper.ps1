$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root ".venv\\Scripts\\python.exe"

if (-not (Test-Path $python)) {
  Write-Error "Virtual environment not found: $python"
  exit 1
}

Set-Location $root
& $python -m app.main --host 127.0.0.1 --port 9876
