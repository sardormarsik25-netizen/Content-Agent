"""Render a validated Remotion composition, with explicit local media and a checked audio mix."""
import base64
import json
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, build_opener
from uuid import uuid4

from .advertising import NoRedirect
from .video_audio import FLAGS, mix, verify_voice
from .video_contract import COMPOSITIONS, validate
from .product_research import verified_image

MAX_IMAGE = 8_000_000


def image_bytes(source, root, workspace, is_background=False):
    url = urlsplit(source) if source.startswith(("https://", "http://")) else None
    if url:
        approved = (
            (url.netloc == "images.ctfassets.net" and url.path.startswith("/hnk2vsx53n6l/"))
            or url.netloc == "images.unsplash.com"
        )
        if is_background or url.scheme != "https" or not approved:
            raise ValueError("Use a local image or an HTTPS image URL from the approved On or Unsplash CDN")
        try:
            with build_opener(NoRedirect()).open(Request(source), timeout=12) as response:
                if response.headers.get_content_type() not in ("image/jpeg", "image/png", "image/webp"):
                    raise ValueError("Remote asset is not a supported image")
                return response.read(MAX_IMAGE + 1)
        except OSError as error:
            raise ValueError("Approved image could not be downloaded; attach the image locally") from error
    if is_background and not re.fullmatch(r"[\w.-]+\.(?:png|jpe?g|webp)", source, re.I):
        raise ValueError("background must be a filename in Remotion public")
    if not is_background and not Path(source).is_absolute():
        raise ValueError("Local images need an absolute path")
    path = ((root / "public" / source) if is_background else Path(source)).resolve()
    allowed = (root / "public",) if is_background else (workspace / "assets", workspace.parent / "image_cache")
    if not path.is_absolute() or not any(path.is_relative_to(base.resolve()) for base in allowed) or not path.is_file():
        raise ValueError("Image file missing or outside the approved asset folder; use asset_library or attach it")
    with path.open("rb") as resource:
        return resource.read(MAX_IMAGE + 1)


def resolve_scenes(plan, root, workspace, frames):
    images = {}
    scenes = []
    for index, (scene, count) in enumerate(zip(plan["scenes"], frames), 1):
        props = {key: scene[key] for key in ("title", "subtitle", "role", "motion", "overlay") if key in scene}
        props["frames"] = count
        for key in ("image", "asset_path", "background", "verified_asset_id"):
            if key not in scene:
                continue
            cache_key = (key, scene[key])
            try:
                if cache_key not in images:
                    if key == "asset_path" and not Path(scene[key]).is_absolute():
                        raise ValueError("asset_path must be a local absolute path")
                    data = (verified_image(workspace, scene[key], plan["product"], plan["purpose"])
                            if key == "verified_asset_id"
                            else image_bytes(scene[key], root, workspace, key == "background"))
                    if not data or len(data) > MAX_IMAGE:
                        raise ValueError("Image is empty or exceeds 8 MB")
                    if data.startswith(b"\x89PNG\r\n\x1a\n"):
                        kind = "png"
                    elif data.startswith(b"\xff\xd8\xff"):
                        kind = "jpeg"
                    elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
                        kind = "webp"
                    else:
                        raise ValueError("Image data must be PNG, JPEG or WebP")
                    images[cache_key] = f"data:image/{kind};base64,{base64.b64encode(data).decode('ascii')}"
                props["image"] = list(images).index(cache_key)
            except (OSError, ValueError) as error:
                detail = str(error) if isinstance(error, ValueError) else "Could not read the local image"
                raise ValueError(f"Scene {index}: {detail}") from error
        scenes.append(props)
    return scenes, list(images.values())


def render(plan, node, root, browser, ffmpeg, tts_script, workspace, providers=()):
    frames = validate(plan)
    scenes, images = resolve_scenes(plan, root, workspace, frames)
    output_dir = workspace / "videos"
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / f"content-agent-{uuid4().hex}.mp4"
    composition = COMPOSITIONS[plan["composition"]]
    with tempfile.TemporaryDirectory(dir=output_dir, ignore_cleanup_errors=True) as working:
        temp = Path(working)
        mix_path, voice_windows, narration_skipped = mix(plan, frames, temp, ffmpeg, tts_script, workspace, providers)
        props = temp / "props.json"
        props.write_text(json.dumps({"scenes": scenes, "images": images, "accent": plan.get("accent", "#6ee7b7"),
                                     "frames": sum(frames)}, ensure_ascii=False), encoding="utf-8")
        stills = temp / "frames"
        result = subprocess.run(
            [node, str(root / "node_modules/@remotion/cli/remotion-cli.js"), "render",
             "src/AdvertisingVideo.tsx", composition, str(stills), "--props", str(props), "--sequence",
             "--image-format=jpeg", "--concurrency=2", "--log=error", "--browser-executable", browser],
            cwd=root, capture_output=True, timeout=900, creationflags=FLAGS,
        )
        if result.returncode:
            raise ValueError("Remotion could not render the selected composition or decode its images")
        files = sorted(stills.glob("*.jpeg"))
        if len(files) != sum(frames):
            raise ValueError("Remotion did not produce every frame")
        for index, still in enumerate(files):
            still.rename(stills / f"encode-{index:05d}.jpeg")
        staging = temp / "final.mp4"
        result = subprocess.run(
            [ffmpeg, "-v", "error", "-framerate", "30", "-i", str(stills / "encode-%05d.jpeg"),
             "-i", str(mix_path), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(staging)],
            capture_output=True, timeout=180, creationflags=FLAGS,
        )
        if result.returncode:
            raise ValueError("FFmpeg could not encode the video and its audio mix")
        verify_voice(ffmpeg, staging, mix_path, voice_windows)
        staging.replace(destination)
    return {"video_path": destination.as_posix(), "composition": composition,
            "image_scenes": sum("image" in scene for scene in scenes), "voiceover": voice_windows, "narration_skipped": narration_skipped,
            "music": "provided" if plan.get("music_path") else plan.get("music", "pulse"),
            "sfx_scenes": sum(scene.get("sfx", "none") != "none" for scene in plan["scenes"])}
