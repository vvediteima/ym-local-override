from __future__ import annotations

import json
import mimetypes
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen


@dataclass
class ReplacementEntry:
    track_id: str
    title: str | None
    artist: str | None
    stored_name: str
    original_name: str
    content_type: str

    def to_dict(self) -> dict[str, str | None]:
        return {
            "track_id": self.track_id,
            "title": self.title,
            "artist": self.artist,
            "stored_name": self.stored_name,
            "original_name": self.original_name,
            "content_type": self.content_type,
        }


@dataclass
class DownloadedAudio:
    original_name: str
    content_type: str


def guess_audio_content_type(*names: str, fallback: str = "audio/mpeg") -> str:
    explicit_map = {
        ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".oga": "audio/ogg",
        ".opus": "audio/ogg",
        ".wav": "audio/wav",
        ".webm": "audio/webm",
    }

    for name in names:
        if not name:
            continue

        suffix = Path(name).suffix.lower()
        if suffix in explicit_map:
            return explicit_map[suffix]

        guessed, _encoding = mimetypes.guess_type(name)
        if guessed and guessed.startswith("audio/"):
            return guessed

    return fallback


def guess_extension_from_content_type(content_type: str, fallback: str = ".mp3") -> str:
    content_map = {
        "audio/flac": ".flac",
        "audio/mp4": ".m4a",
        "audio/mpeg": ".mp3",
        "audio/ogg": ".ogg",
        "audio/wav": ".wav",
        "audio/webm": ".webm",
    }
    return content_map.get((content_type or "").split(";")[0].strip().lower(), fallback)


def repair_serialized_audio_file(file_path: Path) -> bool:
    raw = file_path.read_bytes()
    if not raw:
        return False

    allowed_bytes = {9, 10, 13, 32, 44, 45}
    allowed_bytes.update(range(ord("0"), ord("9") + 1))
    if any(byte not in allowed_bytes for byte in raw[: min(len(raw), 4096)]):
        return False

    text = raw.decode("utf-8", errors="ignore").strip()
    if text.count(",") < 8:
        return False

    parts = [item.strip() for item in text.split(",") if item.strip()]
    if len(parts) < 16:
        return False

    try:
        values = [int(item) for item in parts]
    except ValueError:
        return False

    if any(value < 0 or value > 255 for value in values):
        return False

    file_path.write_bytes(bytes(values))
    return True


def download_remote_audio(url: str, destination: Path, max_bytes: int = 250 * 1024 * 1024) -> DownloadedAudio:
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Supported URL schemes are http and https only.")

    request = Request(
        url,
        headers={
            "User-Agent": "YM-Local-Override/1.0",
            "Accept": "audio/*,application/octet-stream;q=0.9,*/*;q=0.1",
        },
    )

    with urlopen(request, timeout=30) as response, destination.open("wb") as output:
        content_type = response.headers.get_content_type() or "application/octet-stream"
        content_length = response.headers.get("Content-Length")
        if content_length:
            try:
                if int(content_length) > max_bytes:
                    raise ValueError("The remote audio file is too large.")
            except ValueError as error:
                if str(error) == "The remote audio file is too large.":
                    raise

        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("The remote audio file is too large.")
            output.write(chunk)

    if destination.stat().st_size == 0:
        raise ValueError("Downloaded file is empty.")

    raw_name = Path(unquote(parsed.path)).name or "remote-audio"
    content_type = guess_audio_content_type(raw_name, fallback=content_type)
    if not raw_name or "." not in raw_name:
        raw_name = f"remote-audio{guess_extension_from_content_type(content_type)}"

    looks_like_audio = content_type.startswith("audio/") or guess_audio_content_type(raw_name, fallback="").startswith("audio/")
    if not looks_like_audio:
        raise ValueError("The URL does not look like a direct audio file.")

    repair_serialized_audio_file(destination)
    return DownloadedAudio(original_name=raw_name, content_type=content_type)


class ConfigStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.data_dir = root / "data"
        self.uploads_dir = self.data_dir / "uploads"
        self.replacements_file = self.data_dir / "replacements.json"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.uploads_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> dict[str, ReplacementEntry]:
        if not self.replacements_file.exists():
            return {}

        raw = json.loads(self.replacements_file.read_text(encoding="utf-8"))
        entries: dict[str, ReplacementEntry] = {}
        updated = False
        for track_id, payload in raw.get("replacements", {}).items():
            stored_name = payload.get("stored_name")
            if not stored_name:
                continue

            file_path = self.uploads_dir / stored_name
            if not file_path.exists():
                continue

            if repair_serialized_audio_file(file_path):
                updated = True

            content_type = payload.get("content_type") or ""
            if not content_type or content_type == "application/octet-stream":
                content_type = guess_audio_content_type(
                    payload.get("original_name", ""),
                    stored_name,
                )
                payload["content_type"] = content_type
                updated = True

            entries[track_id] = ReplacementEntry(
                track_id=track_id,
                title=payload.get("title"),
                artist=payload.get("artist"),
                stored_name=stored_name,
                original_name=payload.get("original_name", stored_name),
                content_type=content_type or "audio/mpeg",
            )

        if updated:
            self.replacements_file.write_text(
                json.dumps(raw, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

        return entries

    def save(self, replacements: dict[str, ReplacementEntry]) -> None:
        payload = {
            "replacements": {
                track_id: entry.to_dict()
                for track_id, entry in sorted(replacements.items(), key=lambda item: item[0])
            }
        }
        self.replacements_file.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def store_upload(self, track_id: str, filename: str, source_path: Path) -> str:
        safe_ext = Path(filename).suffix or ".mp3"
        stored_name = f"{track_id}_{uuid.uuid4().hex}{safe_ext}"
        destination = self.uploads_dir / stored_name
        shutil.copy2(source_path, destination)
        return stored_name
