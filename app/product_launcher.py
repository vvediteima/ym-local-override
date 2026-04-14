from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


HELPER_PORT = 9876
MUSIC_URL = "https://music.yandex.ru/"
REMOTE_DEBUG_PORT = 9777


def resolve_paths() -> tuple[Path, Path, Path]:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        resource_root = Path(sys._MEIPASS)
        runtime_root = Path(sys.executable).resolve().parent
        app_root = runtime_root.parent.parent if runtime_root.parent.name.lower() == "dist" else runtime_root
        return runtime_root, resource_root, app_root

    project_root = Path(__file__).resolve().parent.parent
    return project_root, project_root, project_root


def is_helper_online(port: int = HELPER_PORT) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=1.5) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError):
        return False


def wait_for_helper(port: int = HELPER_PORT, timeout_seconds: float = 20.0) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if is_helper_online(port):
            return True
        time.sleep(0.4)
    return False


def start_helper(runtime_root: Path, resource_root: Path, app_root: Path) -> None:
    if is_helper_online():
        return

    creation_flags = 0
    if sys.platform.startswith("win"):
        creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS

    pythonw_exe = runtime_root / ".venv" / "Scripts" / "pythonw.exe"
    python_exe = runtime_root / ".venv" / "Scripts" / "python.exe"
    python_runner = pythonw_exe if pythonw_exe.exists() else python_exe
    if python_runner.exists():
        subprocess.Popen(
            [str(python_runner), "-m", "app.main", "--host", "127.0.0.1", "--port", str(HELPER_PORT)],
            cwd=str(runtime_root),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=creation_flags,
        )
        return

    helper_exe_candidates = [
        app_root / "dist" / "YMLocalOverrideHelper" / "YMLocalOverrideHelper.exe",
        runtime_root / "dist" / "YMLocalOverrideHelper" / "YMLocalOverrideHelper.exe",
        resource_root / "dist" / "YMLocalOverrideHelper" / "YMLocalOverrideHelper.exe",
    ]

    for helper_exe in helper_exe_candidates:
        if helper_exe.exists():
            subprocess.Popen(
                [str(helper_exe)],
                cwd=str(runtime_root),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                creationflags=creation_flags,
            )
            return

    raise RuntimeError("Helper executable or local Python environment was not found.")


def find_browser_executable() -> Path:
    candidates = [
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"),
        Path(r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"),
        Path(r"C:\Users\%USERNAME%\AppData\Local\Yandex\YandexBrowser\Application\browser.exe"),
    ]
    for candidate in candidates:
        candidate = Path(str(candidate).replace("%USERNAME%", Path.home().name))
        if candidate.exists():
            return candidate
    raise RuntimeError("No supported Chromium browser was found. Install Edge, Chrome, Brave, or Yandex Browser.")


def read_extension_version(extension_dir: Path) -> str:
    manifest_path = extension_dir / "manifest.json"
    if not manifest_path.exists():
        return "dev"

    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        version = str(payload.get("version", "dev")).strip()
        safe_version = "".join(char if char.isalnum() else "_" for char in version)
        return safe_version or "dev"
    except (OSError, json.JSONDecodeError):
        return "dev"


def launch_browser(runtime_root: Path, resource_root: Path, app_root: Path) -> None:
    browser_exe = find_browser_executable()
    extension_dir_candidates = [
        app_root / "ym-extension",
        resource_root / "ym-extension",
    ]
    source_extension_dir = next((path for path in extension_dir_candidates if path.exists()), extension_dir_candidates[-1])
    extension_version = read_extension_version(source_extension_dir)
    profile_dir = app_root / ".runtime" / "product-profile"
    loaded_extension_dir = app_root / ".runtime" / f"loaded-extension-{extension_version}-{int(time.time())}"
    profile_dir.mkdir(parents=True, exist_ok=True)
    for stale_dir in (app_root / ".runtime").glob("loaded-extension*"):
        if stale_dir == loaded_extension_dir:
            continue
        if stale_dir.is_dir():
            shutil.rmtree(stale_dir, ignore_errors=True)
    if loaded_extension_dir.exists():
        shutil.rmtree(loaded_extension_dir, ignore_errors=True)
    shutil.copytree(source_extension_dir, loaded_extension_dir)

    subprocess.Popen(
        [
            str(browser_exe),
            f"--user-data-dir={profile_dir}",
            f"--disable-extensions-except={loaded_extension_dir}",
            f"--load-extension={loaded_extension_dir}",
            f"--remote-debugging-port={REMOTE_DEBUG_PORT}",
            "--remote-allow-origins=*",
            f"--app={MUSIC_URL}",
        ],
        cwd=str(runtime_root),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Launch YM Local Override product mode.")
    parser.add_argument("--manager", action="store_true", help="Open helper manager in the default browser.")
    parser.add_argument("--no-browser", action="store_true", help="Start helper only.")
    args = parser.parse_args()

    runtime_root, resource_root, app_root = resolve_paths()
    start_helper(runtime_root, resource_root, app_root)
    if not wait_for_helper():
        raise RuntimeError("Helper did not become ready in time.")

    if args.manager:
        webbrowser.open(f"http://127.0.0.1:{HELPER_PORT}/")

    if not args.no_browser:
        launch_browser(runtime_root, resource_root, app_root)


if __name__ == "__main__":
    main()
