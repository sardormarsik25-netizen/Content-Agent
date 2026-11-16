# Content Agent — AI Content Creation Skill for Hermes

## Overview

This skill adds a complete AI-powered content creation pipeline to Hermes Agent.
It produces real rendered MP4 videos, social-media posts, content calendars and
brand profiles — all without external API keys.

**Capabilities**

- **Video (3 modes)**
  1. **Narrated explainer** — Edge Neural TTS voice-over, auto-subtitles, Ken Burns
     motion on generated HTML/CSS posters.
  2. **Music-only modern video** — procedural royalty-free score (numpy), visual
     rhythm edits.
  3. **From user images** — your photos + overlay headlines, motion, music.
- **Social posts** — single posts for Telegram/Instagram/LinkedIn with brand voice.
- **Content calendar** — 7–30 day plans with pillars, platforms, objectives.
- **Brand profiles** — persistent JSON config used by all generators.

**Honesty guarantees**

- No AI text-to-video / image-to-video provider is used. Motion is camera
  animation on still frames (Ken Burns). The report says so explicitly.
- Voice is Microsoft Edge Neural TTS (free, no key). Music is original numpy
  synthesis. User-supplied assets are respected.
- If a feature needs an unavailable provider, the tool returns a clear message
  instead of hallucinating.

## Installation

```bash
# From the project directory
content-agent doctor          # verifies FFmpeg, Chromium, Python, edge-tts
content-agent video --plan examples/ai-uz-15s.json   # test render
```

Then copy the whole folder to your Hermes skills directory:

```bash
$dest = "$env:LOCALAPPDATA\hermes\skills\creative\content-agent"
Copy-Item -Recurse . $dest
```

Hermes will discover it automatically (`hermes skills list`).

## Commands (CLI)

All commands are available through the `content-agent` entry point that ships
with the skill.

```
content-agent video --plan <file|-> [--out <dir>] [--json]
content-agent video --request "..." [--language uz] [--duration 15] [--aspect 9:16] [--mode narrated|music|silent] [--voice <id>] [--image <path>...] [--out <dir>] [--json]
content-agent voices [--language uz] [--json]
content-agent music-test [--mood cinematic|energetic|uplifting|calm] [--duration 10] [--out <dir>]
content-agent post --request '<json>' [--json] [--save]
content-agent calendar --request '<json>' [--json] [--save]
content-agent profile show
content-agent profile set '<json>'
content-agent doctor
content-agent doctor-video
```

### Video plan JSON (recommended)

```json
{
  "title": "Sun'iy intellekt — 15 soniya",
  "language": "uz",
  "mode": "narrated",
  "aspect_ratio": "9:16",
  "duration_seconds": 15,
  "voice": { "provider": "edge", "voice": "uz-UZ-MadinaNeural", "rate": "+20%" },
  "music": { "enabled": true, "mood": "cinematic", "volume_db": -22 },
  "subtitles": { "enabled": true, "burn_in": true },
  "scenes": [
    {
      "narration": "Sun'iy intellekt hayotimizga kirib keldi.",
      "headline": "Sun'iy intellekt",
      "subheadline": "Yangi imkoniyatlar davri",
      "kicker": "AI",
      "palette": ["#050816", "#2563eb", "#22d3ee"],
      "style": "aurora",
      "motion": "zoom-in",
      "transition": "fade"
    }
  ]
}
```

Required fields: `scenes[]` (non-empty). Everything else has safe defaults.

## Hermes Agent invocation

Inside Hermes, call the skill like any other:

```
/skill content-agent video --plan plan.json
/skill content-agent voices --language uz
/skill content-agent calendar --request '{"topic":"AI","days":7,"platforms":["telegram"],"language":"uz","objective":"engagement"}'
```

The skill writes outputs under `outputs/<timestamp>-<slug>/` and returns a
Markdown summary with paths to the MP4, SRT, manifest.json and report.md.

## Requirements (bundled with Hermes)

- FFmpeg 9 (Hermes tools) — `ffmpeg`, `ffprobe`
- Chromium headless (Hermes tools) — screenshot rendering
- Python 3.12+ with `edge-tts>=7.3` and `numpy`
- Windows fonts: Segoe UI (fallback Arial)

All binaries are resolved automatically from the Hermes installation; no
separate install needed.

## Output structure

```
outputs/2026-10-23_09-11-09-zamonaviy-futbol/
├── assets/                 # source PNG frames (1080p)
├── cache/                  # HTML posters
├── audio/                  # narration MP3s, music WAV, mix
├── clips/                  # per-scene MP4 clips
├── base-video.mp4          # concatenated video before audio
├── subtitles.srt           # SRT file
├── subtitles.ass           # ASS file (burned in when burn_in=true)
├── plan.json               # normalized plan used for the run
├── manifest.json           # machine-readable result with all paths
└── report.md               # human-readable report with provider notes
```

## Telegram Bot Integration

The skill includes a full-featured Telegram bot (`content-agent bot`) that uses
the same video pipeline.

### Features

1. **Commands**
   - `/video <mavzu> [davomiylik] [rejim] [aspekt] [til]` — video yaratib yuboradi
   - `/calendar <mavzu> [kunlar]` — haftalik reja
   - `/voices` — ovozlar ro'yxati
   - `/music` — test musiqasi
   - **Rasm yuboring** → avtomatik reklama videosiga aylantiradi (3 sahna, overlay matn, musiqa)

2. **Admin** (`ADMIN_ID` env)
   - `/post_calendar` — kanalga haftalik reja yuborish (`CHANNEL_ID` env kerak)

### Environment variables

```bash
BOT_TOKEN=123456:ABC-DEF...        # BotFather dan olingan token (majburiy)
CHANNEL_ID=-1001234567890          # Kanal ID (admin posting uchun)
ADMIN_ID=123456789                 # Sizning Telegram user ID (admin uchun)
```

### Ishga tushirish

```bash
# Loyiha papkasida
$env:BOT_TOKEN="..."; $env:CHANNEL_ID="-100..."; $env:ADMIN_ID="..."
content-agent bot
```

Bot `grammy` kutubxonasi va `dotenv` ishlatadi; `package.json` da ularning o'rnatilishi kerak.

```bash
node --test test/plan.test.ts test/subtitles.test.ts test/timeline.test.ts
```

## License

MIT — free to use, modify, distribute.