from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import (
    ConfigStore,
    ReplacementEntry,
    download_remote_audio,
    guess_audio_content_type,
    repair_serialized_audio_file,
)


class ImportUrlRequest(BaseModel):
    track_id: str
    source_url: str
    title: str | None = None
    artist: str | None = None


class ReplacementService:
    def __init__(self, runtime_root: Path) -> None:
        self.runtime_root = runtime_root
        self.store = ConfigStore(runtime_root)
        self.replacements = self.store.load()

    def list_items(self) -> list[dict[str, str | int | None]]:
        items: list[dict[str, str | int | None]] = []
        for entry in sorted(
            self.replacements.values(),
            key=lambda item: ((item.artist or ""), (item.title or ""), item.track_id),
        ):
            file_path = self.store.uploads_dir / entry.stored_name
            file_size = file_path.stat().st_size if file_path.exists() else 0
            items.append({**entry.to_dict(), "stream_url": f"/media/{entry.track_id}", "file_size": file_size})
        return items

    def resolve(self, track_id: str) -> dict[str, str | bool | None]:
        entry = self.replacements.get(track_id)
        if not entry:
            return {"active": False, "track_id": track_id}

        return {
            "active": True,
            "track_id": track_id,
            "title": entry.title,
            "artist": entry.artist,
            "stream_url": f"http://127.0.0.1:9876/media/{track_id}",
        }

    def _save_replacement(
        self,
        track_id: str,
        title: str | None,
        artist: str | None,
        source_path: Path,
        original_name: str,
        content_type: str,
    ) -> dict[str, str | int | None]:
        track_id = track_id.strip()
        if not track_id:
            raise HTTPException(status_code=400, detail="Track ID is required.")

        repair_serialized_audio_file(source_path)
        old_entry = self.replacements.get(track_id)
        if old_entry:
            old_path = self.store.uploads_dir / old_entry.stored_name
            if old_path.exists():
                old_path.unlink()

        stored_name = self.store.store_upload(track_id, original_name, source_path)
        entry = ReplacementEntry(
            track_id=track_id,
            title=(title or "").strip() or None,
            artist=(artist or "").strip() or None,
            stored_name=stored_name,
            original_name=original_name or stored_name,
            content_type=guess_audio_content_type(
                original_name or stored_name,
                stored_name,
                fallback=content_type or "audio/mpeg",
            ),
        )
        self.replacements[track_id] = entry
        self.store.save(self.replacements)
        stored_path = self.store.uploads_dir / stored_name
        return {
            **entry.to_dict(),
            "stream_url": f"/media/{entry.track_id}",
            "file_size": stored_path.stat().st_size if stored_path.exists() else 0,
        }

    def add_upload(
        self,
        track_id: str,
        title: str | None,
        artist: str | None,
        upload: UploadFile,
    ) -> dict[str, str | int | None]:
        suffix = Path(upload.filename or "track.mp3").suffix or ".mp3"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = Path(temp_file.name)
            while True:
                chunk = upload.file.read(1024 * 1024)
                if not chunk:
                    break
                temp_file.write(chunk)

        try:
            return self._save_replacement(
                track_id=track_id,
                title=title,
                artist=artist,
                source_path=temp_path,
                original_name=upload.filename or f"{track_id}{suffix}",
                content_type=upload.content_type or "audio/mpeg",
            )
        finally:
            if temp_path.exists():
                temp_path.unlink()

    def add_remote_url(
        self,
        track_id: str,
        title: str | None,
        artist: str | None,
        source_url: str,
    ) -> dict[str, str | int | None]:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".download") as temp_file:
            temp_path = Path(temp_file.name)

        try:
            try:
                downloaded = download_remote_audio(source_url, temp_path)
            except ValueError as error:
                raise HTTPException(status_code=400, detail=str(error)) from error
            except OSError as error:
                raise HTTPException(status_code=400, detail=f"Failed to download audio: {error}") from error

            return self._save_replacement(
                track_id=track_id,
                title=title,
                artist=artist,
                source_path=temp_path,
                original_name=downloaded.original_name,
                content_type=downloaded.content_type,
            )
        finally:
            if temp_path.exists():
                temp_path.unlink()

    def delete(self, track_id: str) -> None:
        entry = self.replacements.pop(track_id, None)
        if not entry:
            raise HTTPException(status_code=404, detail="Replacement not found.")

        file_path = self.store.uploads_dir / entry.stored_name
        if file_path.exists():
            file_path.unlink()
        self.store.save(self.replacements)

    def get_media_path(self, track_id: str) -> tuple[Path, ReplacementEntry]:
        entry = self.replacements.get(track_id)
        if not entry:
            raise HTTPException(status_code=404, detail="Replacement not found.")

        file_path = self.store.uploads_dir / entry.stored_name
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="Stored file is missing.")

        return file_path, entry


def create_app(runtime_root: Path, static_dir: Path | None = None) -> FastAPI:
    app = FastAPI(title="YM Local Override Helper")
    service = ReplacementService(runtime_root)
    static_dir = static_dir or runtime_root / "static"

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/", response_class=HTMLResponse)
    async def manager() -> HTMLResponse:
        html_path = static_dir / "manager.html"
        return HTMLResponse(html_path.read_text(encoding="utf-8"))

    @app.get("/api/status")
    async def status() -> dict[str, int | str]:
        return {
            "status": "ok",
            "replacement_count": len(service.replacements),
            "helper_url": "http://127.0.0.1:9876",
        }

    @app.get("/api/replacements")
    async def replacements() -> dict[str, list[dict[str, str | int | None]]]:
        return {"items": service.list_items()}

    @app.get("/api/resolve")
    async def resolve(track_id: str) -> dict[str, str | bool | None]:
        return service.resolve(track_id)

    @app.post("/api/replacements")
    async def upload_replacement(
        track_id: str = Form(...),
        title: str | None = Form(default=None),
        artist: str | None = Form(default=None),
        file: UploadFile = File(...),
    ) -> dict[str, str | int | None]:
        return service.add_upload(track_id=track_id, title=title, artist=artist, upload=file)

    @app.post("/api/replacements/import-url")
    async def import_replacement_from_url(payload: ImportUrlRequest) -> dict[str, str | int | None]:
        return service.add_remote_url(
            track_id=payload.track_id,
            title=payload.title,
            artist=payload.artist,
            source_url=payload.source_url,
        )

    @app.delete("/api/replacements/{track_id}")
    async def delete_replacement(track_id: str) -> dict[str, str]:
        service.delete(track_id)
        return {"status": "deleted", "track_id": track_id}

    @app.get("/media/{track_id}")
    async def media(track_id: str) -> FileResponse:
        file_path, entry = service.get_media_path(track_id)
        return FileResponse(
            path=file_path,
            filename=entry.original_name,
            media_type=entry.content_type or "audio/mpeg",
        )

    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    return app
