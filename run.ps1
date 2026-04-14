$pythonw = "$PSScriptRoot\\.venv\\Scripts\\pythonw.exe"
$python = "$PSScriptRoot\\.venv\\Scripts\\python.exe"
$exe = "$PSScriptRoot\\dist\\YMLocalOverride\\YMLocalOverride.exe"

if (Test-Path $pythonw) {
  Start-Process $pythonw -ArgumentList '-m','app.product_launcher' -WorkingDirectory $PSScriptRoot
} elseif (Test-Path $python) {
  Start-Process $python -ArgumentList '-m','app.product_launcher' -WorkingDirectory $PSScriptRoot
} elseif (Test-Path $exe) {
  Start-Process $exe
} else {
  Write-Error "Neither local Python launcher nor packaged executable was found."
  exit 1
}
