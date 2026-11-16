#!/usr/bin/env python3
"""Edge Neural TTS helper with word-boundary timings.

Called by the TypeScript voice module. Reads UTF-8 text from a file (avoids
Windows argv encoding issues), writes an MP3 and a JSON sidecar with the exact
word timings used for subtitles.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path


async def synthesize(args: argparse.Namespace) -> dict:
    import edge_tts

    text = Path(args.text_file).read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("Narration text is empty.")

    communicate = edge_tts.Communicate(
        text,
        args.voice,
        rate=args.rate,
        pitch=args.pitch,
        volume=args.volume,
    )

    audio = bytearray()
    words: list[dict] = []
    async for chunk in communicate.stream():
        kind = chunk.get("type")
        if kind == "audio":
            audio.extend(chunk["data"])
        elif kind == "WordBoundary":
            offset = float(chunk.get("offset", 0)) / 10_000.0
            duration = float(chunk.get("duration", 0)) / 10_000.0
            words.append(
                {
                    "text": str(chunk.get("text", "")).strip(),
                    "start_ms": round(offset, 1),
                    "end_ms": round(offset + duration, 1),
                }
            )

    if not audio:
        raise RuntimeError("Edge TTS returned no audio. Check the voice id and network access.")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(bytes(audio))

    if not words:
        # Some voices omit boundary events. The TypeScript side falls back to
        # proportional timing from the text length.
        words = []

    sidecar = {
        "voice": args.voice,
        "rate": args.rate,
        "pitch": args.pitch,
        "text": text,
        "words": words,
        "bytes": len(audio),
    }
    Path(str(out) + ".json").write_text(json.dumps(sidecar, ensure_ascii=False, indent=2), encoding="utf-8")
    return sidecar


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--voice", default="uz-UZ-MadinaNeural")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    parser.add_argument("--volume", default="+0%")
    args = parser.parse_args()

    try:
        result = asyncio.run(synthesize(args))
    except Exception as error:  # noqa: BLE001 - the CLI must surface the real reason
        print(f"TTS_ERROR: {type(error).__name__}: {error}", file=sys.stderr)
        return 2

    print(json.dumps({"ok": True, "bytes": result["bytes"], "words": len(result["words"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
