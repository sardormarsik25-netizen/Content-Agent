import hashlib
import json
import re
import shutil
import sqlite3
import subprocess
import sys
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request
from pathlib import Path
from uuid import uuid4


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download_product_image(url, folder):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc != "images.ctfassets.net"
            or not parsed.path.startswith("/hnk2vsx53n6l/")):
        raise ValueError("Use an image URL from the official On product page")
    with build_opener(NoRedirect()).open(Request(url), timeout=15) as response:
        suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(
            response.headers.get_content_type())
        data = response.read(8_000_001)
    if not suffix or not data or len(data) > 8_000_000:
        raise ValueError("Unsupported product image or image exceeds 8 MB")
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / (hashlib.sha256(data).hexdigest() + suffix)
    target.write_bytes(data)
    return target.as_posix()


def text(payload, key, limit=1000):
    value = payload.get(key, "")
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"Invalid {key}")
    return value.strip()


def run(action, payload, root, ffprobe, workspace):
    if action in ("brief_parser", "product_lookup"):
        fields = ("subject", "category", "audience", "platform", "offer") if action == "brief_parser" else (
            "subject", "source_url", "model", "price", "features", "image_urls")
        result = {key: text(payload, key, 4000) for key in fields}
        required = ("subject", "category") if action == "brief_parser" else ("subject", "source_url")
        result["missing"] = [key for key in required if not result[key]]
        return result

    brand = text(payload, "brand", 100)
    brand_key = hashlib.sha256(brand.casefold().encode()).hexdigest()[:24]
    if action in ("asset_library", "content_memory") and not brand:
        raise ValueError("Provide a brand or product name")
    folder = workspace / "assets" / brand_key

    if action == "asset_library":
        url = text(payload, "url", 4096)
        if url:
            return {"asset_path": download_product_image(url, folder), "brand": brand}
        if not text(payload, "path"):
            return {"assets": [p.as_posix() for p in sorted(folder.glob("*")) if p.is_file()]}
        source = Path(text(payload, "path")).resolve(strict=True)
        roots = (workspace.resolve(), (workspace.parent / "image_cache").resolve(),
                 (workspace.parent / "audio_cache").resolve(),
                 (workspace.parent / "document_cache").resolve())
        allowed = {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".wav", ".mp3", ".ogg", ".m4a"}
        if not any(source.is_relative_to(path) for path in roots) or not source.is_file():
            raise ValueError("Use a file from this Hermes profile's attachments or workspace")
        if source.suffix.lower() not in allowed or source.stat().st_size > 100 * 1024 * 1024:
            raise ValueError("Unsupported file type or file exceeds 100 MB")
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{uuid4().hex}{source.suffix.lower()}"
        shutil.copyfile(source, target)
        return {"asset_path": target.as_posix(), "brand": brand}

    if action == "content_memory":
        note = text(payload, "note", 16000)
        vault = Path("C:/Users/user/Documents/Obsidian Vault/30-PROJECTS/Content Agent")
        workspace.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(workspace / "content.db") as db:
            db.execute("CREATE TABLE IF NOT EXISTS brand_memory (brand_key TEXT, brand TEXT, note TEXT, PRIMARY KEY(brand_key,note))")
            if note:
                db.execute("INSERT OR IGNORE INTO brand_memory VALUES (?, ?, ?)", (brand_key, brand, note))
            rows = [r[0] for r in db.execute("SELECT note FROM brand_memory WHERE brand_key=? ORDER BY rowid", (brand_key,))]
        if note:
            vault.mkdir(parents=True, exist_ok=True)
            target = vault / f"Brand {brand_key}.md"
            temporary = target.with_suffix(f".{uuid4().hex}.tmp")
            temporary.write_text("# " + brand + "\n\n" + "\n\n---\n\n".join(rows), encoding="utf-8")
            temporary.replace(target)
        return {"brand": brand, "notes": rows, "saved": bool(note)}

    if action == "video_check":
        video = Path(text(payload, "path")).resolve(strict=True)
        if not video.is_relative_to(workspace.resolve()) or video.suffix.lower() != ".mp4":
            raise ValueError("Use a rendered MP4 from this Hermes workspace")
        probe = subprocess.run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video)],
                               check=True, capture_output=True, timeout=30)
        data = json.loads(probe.stdout)
        stream = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
        width, height = (stream["width"], stream["height"]) if stream else (0, 0)
        duration = float(data["format"]["duration"])
        expected = payload.get("seconds")
        audio = any(s["codec_type"] == "audio" for s in data["streams"])
        valid = bool(height and width * 16 == height * 9 and audio and 0 < duration <= 60.1)
        if type(expected) in (float, int):
            valid = valid and abs(duration - expected) <= 0.25
        return {"ok": valid, "width": width, "height": height, "seconds": duration, "audio": audio}

    narration = text(payload, "text", 4000)
    voice = text(payload, "voice", 60) or "uz-UZ-MadinaNeural"
    if not narration or not re.fullmatch(r"[A-Za-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural", voice):
        raise ValueError("Provide narration and a valid Edge Neural voice")
    target = workspace / "voice" / uuid4().hex
    target.mkdir(parents=True)
    source = target / "narration.txt"
    source.write_text(narration, encoding="utf-8")
    audio = target / "voice.mp3"
    subprocess.run([sys.executable, str(root / "python/tts_edge.py"), "--text-file", str(source),
                    "--out", str(audio), "--voice", voice], check=True, capture_output=True, timeout=90)
    timing = Path(str(audio) + ".json")
    return {"audio_path": audio.as_posix(), "timing_path": timing.as_posix()}
