#!/usr/bin/env python3
"""Print the Edge TTS voice catalogue as JSON (optionally filtered by language)."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys


async def main_async(language: str | None) -> list[dict]:
    import edge_tts

    voices = await edge_tts.list_voices()
    result = []
    for voice in voices:
        locale = str(voice.get("Locale", ""))
        if language and not locale.lower().startswith(language.lower()):
            continue
        result.append(
            {
                "name": voice.get("ShortName", ""),
                "locale": locale,
                "gender": voice.get("Gender", ""),
                "tags": voice.get("VoiceTag", {}),
            }
        )
    result.sort(key=lambda item: item["name"])
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--language", default="")
    args = parser.parse_args()
    try:
        voices = asyncio.run(main_async(args.language or None))
    except Exception as error:  # noqa: BLE001
        print(f"VOICE_LIST_ERROR: {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    print(json.dumps(voices, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
