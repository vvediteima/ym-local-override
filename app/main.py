from __future__ import annotations

import argparse
import sys
from pathlib import Path

import uvicorn

from app.server import create_app


def resolve_paths() -> tuple[Path, Path, Path]:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        resource_root = Path(sys._MEIPASS)
        runtime_root = Path(sys.executable).resolve().parent
        app_root = runtime_root.parent.parent if runtime_root.parent.name.lower() == "dist" else runtime_root
        return runtime_root, resource_root, app_root

    project_root = Path(__file__).resolve().parent.parent
    return project_root, project_root, project_root


def main() -> None:
    parser = argparse.ArgumentParser(description="YM Local Override Helper")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9876)
    args = parser.parse_args()

    _runtime_root, resource_root, app_root = resolve_paths()
    app = create_app(app_root, static_dir=resource_root / "static")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
