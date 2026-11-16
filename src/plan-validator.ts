/**
 * Video plan parsing and validation.
 *
 * The plan may come from Hermes Agent (preferred) or from OpenCode. Both are
 * language models, so the parser is tolerant about cosmetic aliases but strict
 * about the things that would otherwise produce an unusable video.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { fileExists, isImageFile, resolveUserPath } from "./media-tools.ts";
import { ContentAgentError } from "./types.ts";
import {
  ASPECTS,
  DEFAULT_VOICES,
  MOTIONS,
  MUSIC_MOODS,
  TRANSITIONS,
  VIDEO_MODES,
  VISUAL_STYLES,
} from "./video-types.ts";
import type {
  AspectRatio,
  Motion,
  MusicMood,
  NormalizedPlan,
  NormalizedScene,
  Transition,
  VideoMode,
  VideoPlanInput,
  VisualStyle,
} from "./video-types.ts";

const PALETTES: string[][] = [
  ["#050816", "#2563eb", "#22d3ee"],
  ["#0b0714", "#7c3aed", "#f472b6"],
  ["#06120c", "#059669", "#a3e635"],
  ["#160b05", "#ea580c", "#fbbf24"],
  ["#0a0f1e", "#0ea5e9", "#a78bfa"],
  ["#120a0a", "#dc2626", "#fb923c"],
];

const EXTRA_VOICES: Record<string, string> = {
  es: "es-ES-ElviraNeural",
  fr: "fr-FR-DeniseNeural",
  de: "de-DE-KatjaNeural",
  tr: "tr-TR-EmelNeural",
  ar: "ar-SA-ZariyahNeural",
  hi: "hi-IN-SwaraNeural",
  ja: "ja-JP-NanamiNeural",
  ko: "ko-KR-SunHiNeural",
  zh: "zh-CN-XiaoxiaoNeural",
  it: "it-IT-ElsaNeural",
  pt: "pt-BR-FranciscaNeural",
};

function fail(message: string, details?: string): never {
  throw new ContentAgentError("INVALID_VIDEO_PLAN", message, details);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeHex(value: string): string | null {
  const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const raw = match[1];
  const full = raw.length === 3 ? raw.split("").map((char) => char + char).join("") : raw;
  return `#${full.toLowerCase()}`;
}

function normalizePalette(value: unknown, seed: number): string[] {
  const list = Array.isArray(value)
    ? value.map((item) => text(item)).filter(Boolean)
    : text(value)
        .split(/[,\s]+/)
        .filter(Boolean);
  const colors = list.map(normalizeHex).filter((color): color is string => Boolean(color));
  if (colors.length === 0) return [...PALETTES[seed % PALETTES.length]];
  while (colors.length < 3) colors.push(colors[colors.length - 1]);
  return colors.slice(0, 4);
}

export function parseAspect(value: unknown): AspectRatio {
  const raw = text(value).toLowerCase().replace(/\s+/g, "");
  if (!raw) return "9:16";
  if (raw in ASPECTS) return raw as AspectRatio;
  if (["vertical", "portrait", "reel", "reels", "tiktok", "shorts", "story"].includes(raw)) return "9:16";
  if (["horizontal", "landscape", "youtube", "wide"].includes(raw)) return "16:9";
  if (["square", "feed"].includes(raw)) return "1:1";
  if (raw === "1080x1920") return "9:16";
  if (raw === "1920x1080") return "16:9";
  if (raw === "1080x1080") return "1:1";
  fail(`Unsupported aspect ratio "${text(value)}". Use 9:16, 16:9 or 1:1.`);
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
  label: string,
): T[number] {
  const raw = text(value).toLowerCase();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T[number];
  fail(`Unsupported ${label} "${text(value)}". Supported: ${allowed.join(", ")}.`);
}

function normalizeLanguage(value: unknown): string {
  const raw = text(value).toLowerCase() || "uz";
  const base = raw.split(/[-_]/)[0];
  return base;
}

function resolveVoice(language: string, requested: unknown): string {
  const explicit = text(requested);
  if (explicit) return explicit;
  const voice = DEFAULT_VOICES[language] ?? EXTRA_VOICES[language];
  if (!voice) {
    fail(
      `No default Edge TTS voice is configured for language "${language}".`,
      "Pass voice.voice explicitly, for example \"en-US-AvaNeural\".",
    );
  }
  return voice;
}

function normalizeScene(raw: unknown, index: number, baseDir: string): NormalizedScene {
  const scene = asRecord(raw, `scenes[${index}]`);
  const imageRaw = text(scene.image ?? scene.image_path);
  let image: string | null = null;
  if (imageRaw) {
    const resolved = resolveUserPath(imageRaw, baseDir);
    if (!fileExists(resolved)) {
      fail(`Scene ${index + 1} references a missing image: ${resolved}`);
    }
    if (!isImageFile(resolved)) {
      fail(`Scene ${index + 1} image is not a supported image file: ${resolved}`);
    }
    image = resolved;
  }

  const duration = number(scene.duration ?? scene.duration_seconds ?? scene.seconds);
  if (duration !== undefined && (duration < 0.5 || duration > 600)) {
    fail(`Scene ${index + 1} duration must be between 0.5 and 600 seconds.`);
  }

  return {
    index,
    narration: text(scene.narration ?? scene.voiceover ?? scene.script),
    duration: duration ?? null,
    headline: text(scene.headline ?? scene.title ?? scene.text),
    subheadline: text(scene.subheadline ?? scene.subtitle ?? scene.caption),
    kicker: text(scene.kicker ?? scene.label),
    image,
    imageFit: text(scene.image_fit).toLowerCase() === "contain" ? "contain" : "cover",
    motion: oneOf<typeof MOTIONS>(scene.motion, MOTIONS, image ? "zoom-in" : "zoom-in", "motion") as Motion,
    transition: oneOf<typeof TRANSITIONS>(
      scene.transition,
      TRANSITIONS,
      index === 0 ? "fade" : "dissolve",
      "transition",
    ) as Transition,
    palette: normalizePalette(scene.palette ?? scene.colors, index),
    style: oneOf<typeof VISUAL_STYLES>(scene.style, VISUAL_STYLES, "aurora", "visual style") as VisualStyle,
  };
}

export function normalizeVideoPlan(
  raw: unknown,
  options: { baseDir?: string; source?: string } = {},
): NormalizedPlan {
  const baseDir = options.baseDir ?? process.cwd();
  const plan = asRecord(raw, "The video plan");
  const rawScenes = plan.scenes ?? plan.shots;
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
    fail('The video plan requires a non-empty "scenes" array.');
  }
  if (rawScenes.length > 24) {
    fail("A video plan supports at most 24 scenes.");
  }

  const scenes = rawScenes.map((scene, index) => normalizeScene(scene, index, baseDir));
  const language = normalizeLanguage(plan.language);

  const hasNarration = scenes.some((scene) => scene.narration.length > 0);
  const requestedMode = text(plan.mode).toLowerCase();
  let mode: VideoMode;
  if (requestedMode) {
    mode = oneOf<typeof VIDEO_MODES>(requestedMode, VIDEO_MODES, "narrated", "mode") as VideoMode;
  } else {
    mode = hasNarration ? "narrated" : "music";
  }

  if (mode === "narrated" && !hasNarration) {
    fail(
      'Mode "narrated" requires narration text on at least one scene.',
      "Add narration, or use mode \"music\" / \"silent\".",
    );
  }

  const aspect = parseAspect(plan.aspect_ratio ?? plan.aspect);
  const size = ASPECTS[aspect];
  const fpsRaw = number(plan.fps) ?? 30;
  const fps = Math.round(Math.min(60, Math.max(24, fpsRaw)));

  const targetRaw = number(plan.duration_seconds ?? plan.duration);
  const targetDuration = targetRaw && targetRaw > 0 ? Math.min(900, targetRaw) : null;

  const music = asRecord(plan.music ?? {}, "music");
  const musicEnabled =
    mode === "silent" ? false : music.enabled === undefined ? true : Boolean(music.enabled);
  const mood = oneOf<typeof MUSIC_MOODS>(music.mood, MUSIC_MOODS, mode === "narrated" ? "cinematic" : "uplifting", "music mood") as MusicMood;
  const musicPathRaw = text(music.path ?? music.file);
  let musicPath: string | null = null;
  if (musicPathRaw) {
    musicPath = resolveUserPath(musicPathRaw, baseDir);
    if (!fileExists(musicPath)) fail(`Music file not found: ${musicPath}`);
  }
  const defaultMusicVolume = mode === "narrated" ? -22 : -8;
  const volumeDb = number(music.volume_db ?? music.volume) ?? defaultMusicVolume;

  const subtitles = asRecord(plan.subtitles ?? {}, "subtitles");
  const subtitlesEnabled =
    subtitles.enabled === undefined ? mode === "narrated" : Boolean(subtitles.enabled);
  const burnIn = subtitles.burn_in === undefined ? subtitlesEnabled : Boolean(subtitles.burn_in);

  const voice = asRecord(plan.voice ?? {}, "voice");
  const voiceProvider = text(voice.provider).toLowerCase();
  if (voiceProvider && voiceProvider !== "edge") {
    fail(
      `Unsupported voice provider "${text(voice.provider)}".`,
      "The installed build supports Edge Neural TTS (no API key). Set voice.provider to \"edge\" or omit it.",
    );
  }

  if (mode !== "narrated") {
    for (const scene of scenes) scene.narration = "";
  }

  // Music/silent videos have no voice track to derive their timing from, so
  // durations must be explicit or distributed across the requested length.
  if (mode !== "narrated") {
    const missing = scenes.filter((scene) => scene.duration === null);
    const totalKnown = scenes.reduce((sum, scene) => sum + (scene.duration ?? 0), 0);
    if (missing.length > 0) {
      const fallbackTotal = targetDuration ?? Math.max(6, scenes.length * 3);
      const remaining = Math.max(missing.length * 1.5, fallbackTotal - totalKnown);
      for (const scene of missing) scene.duration = remaining / missing.length;
    }
  }

  return {
    title: text(plan.title ?? plan.topic) || "Content video",
    language,
    mode,
    aspect,
    width: size.width,
    height: size.height,
    fps,
    targetDuration,
    voice: {
      provider: "edge",
      voice: resolveVoice(language, voice.voice ?? voice.voice_id ?? voice.id),
      rate: text(voice.rate) || "+0%",
      pitch: text(voice.pitch) || "+0Hz",
      volume: text(voice.volume) || "+0%",
    },
    music: {
      enabled: musicEnabled,
      mood,
      volumeDb,
      path: musicPath,
    },
    subtitles: {
      enabled: subtitlesEnabled,
      burnIn,
    },
    scenes,
    source: options.source ?? "inline plan",
  };
}

export function readVideoPlan(path: string, cwd = process.cwd()): NormalizedPlan {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`Could not read the plan file: ${path}`, (error as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`The plan file is not valid JSON: ${path}`, (error as Error).message);
  }
  return normalizeVideoPlan(parsed, { baseDir: dirname(path), source: path });
}

export function parseVideoPlan(
  raw: string,
  options: { baseDir?: string; source?: string } = {},
): NormalizedPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail("The plan is not valid JSON.", (error as Error).message);
  }
  return normalizeVideoPlan(parsed, options);
}

/** The JSON schema documented for Hermes Agent and OpenCode. */
export function planSchemaExample(): VideoPlanInput {
  return {
    title: "Sun'iy intellekt — 15 soniya",
    language: "uz",
    mode: "narrated",
    aspect_ratio: "9:16",
    duration_seconds: 15,
    voice: { provider: "edge", voice: "uz-UZ-MadinaNeural", rate: "+0%", pitch: "+0Hz" },
    music: { enabled: true, mood: "cinematic", volume_db: -22 },
    subtitles: { enabled: true, burn_in: true },
    scenes: [
      {
        narration: "Sun'iy intellekt hayotimizni jadallashtirmoqda.",
        headline: "Sun'iy intellekt",
        subheadline: "Yangi imkoniyatlar davri",
        kicker: "AI",
        palette: ["#050816", "#2563eb", "#22d3ee"],
        style: "aurora",
        motion: "zoom-in",
      },
      {
        narration: "U shifokorlarga tashxis qo'yishda yordam beradi.",
        headline: "Sog'liqni saqlash",
        subheadline: "Tezroq va aniqroq yordam",
        palette: ["#06120c", "#059669", "#a3e635"],
        style: "grid",
        motion: "pan-right",
      },
    ],
  };
}
