/**
 * Video production contracts.
 *
 * A plan is the only input the renderer needs. Hermes Agent (or OpenCode on
 * standalone runs) writes the plan as JSON; every field is validated before a
 * single frame is rendered, so a broken plan fails fast instead of producing a
 * broken video.
 */

export const VIDEO_MODES = ["narrated", "music", "silent"] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

export const MOTIONS = ["zoom-in", "zoom-out", "pan-left", "pan-right", "none"] as const;
export type Motion = (typeof MOTIONS)[number];

export const TRANSITIONS = [
  "fade",
  "dissolve",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
  "circleopen",
] as const;
export type Transition = (typeof TRANSITIONS)[number];

export const VISUAL_STYLES = ["aurora", "grid", "spotlight", "stripes", "minimal"] as const;
export type VisualStyle = (typeof VISUAL_STYLES)[number];

export const MUSIC_MOODS = ["uplifting", "cinematic", "energetic", "calm"] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];

export const ASPECTS = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
} as const;
export type AspectRatio = keyof typeof ASPECTS;

export const DEFAULT_VOICES: Record<string, string> = {
  uz: "uz-UZ-MadinaNeural",
  ru: "ru-RU-SvetlanaNeural",
  en: "en-US-AvaNeural",
};

export interface ScenePlan {
  /** Spoken narration for this scene. Empty/omitted for music-only scenes. */
  narration?: string;
  /** Fixed duration in seconds. When omitted for a narrated scene it is derived from the voice track. */
  duration?: number;
  /** Large on-screen headline. */
  headline?: string;
  /** Supporting on-screen line. */
  subheadline?: string;
  /** Small label above the headline. */
  kicker?: string;
  /** User-supplied image (absolute, or relative to the plan file). */
  image?: string;
  /** Camera move over the image. Defaults to a gentle zoom-in. */
  motion?: Motion;
  /** Transition INTO this scene. The first scene ignores it. */
  transition?: Transition;
  /** Two to four hex colours: background, primary accent, secondary accent. */
  palette?: string[];
  /** Generated poster style. */
  style?: VisualStyle;
  /** How a supplied image is fitted. Defaults to cover. */
  image_fit?: "cover" | "contain";
}

export interface VideoPlanInput {
  title?: string;
  topic?: string;
  language?: string;
  mode?: VideoMode;
  aspect_ratio?: AspectRatio | string;
  fps?: number;
  duration_seconds?: number;
  voice?: {
    provider?: string;
    voice?: string;
    rate?: string;
    pitch?: string;
    volume?: string;
  };
  music?: {
    enabled?: boolean;
    mood?: MusicMood | string;
    volume_db?: number;
    /** Optional licensed music file supplied by the user. */
    path?: string;
  };
  subtitles?: {
    enabled?: boolean;
    burn_in?: boolean;
  };
  scenes: ScenePlan[];
}

export interface NormalizedScene {
  index: number;
  narration: string;
  duration: number | null;
  headline: string;
  subheadline: string;
  kicker: string;
  image: string | null;
  imageFit: "cover" | "contain";
  motion: Motion;
  transition: Transition;
  palette: string[];
  style: VisualStyle;
}

export interface NormalizedPlan {
  title: string;
  language: string;
  mode: VideoMode;
  aspect: AspectRatio;
  width: number;
  height: number;
  fps: number;
  targetDuration: number | null;
  voice: {
    provider: "edge";
    voice: string;
    rate: string;
    pitch: string;
    volume: string;
  };
  music: {
    enabled: boolean;
    mood: MusicMood;
    volumeDb: number;
    path: string | null;
  };
  subtitles: {
    enabled: boolean;
    burnIn: boolean;
  };
  scenes: NormalizedScene[];
  source: string;
}

export interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SceneVoice {
  index: number;
  file: string;
  words: WordTiming[];
  durationMs: number;
}

export interface SceneVisual {
  index: number;
  image: string;
  source: "generated" | "user-image";
}

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface RenderedScene {
  index: number;
  clip: string;
  duration: number;
  startMs: number;
}

export interface VideoResult {
  outputDir: string;
  planPath: string;
  videoPath: string;
  srtPath: string | null;
  manifestPath: string;
  reportPath: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasSubtitles: boolean;
  mode: VideoMode;
  sceneCount: number;
  narrationSeconds: number;
  musicSeconds: number;
  warnings: string[];
  providerNotes: string[];
}
