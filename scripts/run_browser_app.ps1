$root = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $root "ym-extension"
$profilePath = Join-Path $root ".runtime\\product-profile"

$candidates = @(
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "$env:LOCALAPPDATA\\Yandex\\YandexBrowser\\Application\\browser.exe"
)

$browserPath = $null
foreach ($candidate in $candidates) {
  if (Test-Path $candidate) {
    $browserPath = $candidate
    break
  }
}

if (-not $browserPath) {
  Write-Error "No supported Chromium browser found. Install Edge, Chrome, Brave, or Yandex Browser."
  exit 1
}

if (-not (Test-Path $extensionPath)) {
  Write-Error "Extension folder not found: $extensionPath"
  exit 1
}

Write-Host "Launching with browser: $browserPath" -ForegroundColor Yellow
Write-Host "This uses a separate product profile, so login is stored inside the app profile." -ForegroundColor Yellow

New-Item -ItemType Directory -Force $profilePath | Out-Null

Start-Process $browserPath @(
  "--user-data-dir=$profilePath",
  "--disable-extensions-except=$extensionPath",
  "--load-extension=$extensionPath",
  "--app=https://music.yandex.ru/"
)
