/**
 * Natural AI narration through Microsoft Edge Neural TTS.
 *
 * Edge TTS is free, needs no API key, and exposes Uzbek (uz-UZ-MadinaNeural /
 * uz-UZ-SardorNeural), Russian and English neural voices. It also emits word
 * boundaries, which the subtitle module turns into real timed cues.
 */

import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureAudioFile, ensureDir, resolvePython, runProcess } from "./media-tools.ts";
import { ContentAgentError } from "./types.ts";
import type { NormalizedPlan, SceneVoice, WordTiming } from "./video-types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const PYTHON_DIR = join(PROJECT_ROOT, "python");

export interface VoiceInfo {
  name: string;
  locale: string;
  gender: string;
}

export async function listVoices(language?: string): Promise<VoiceInfo[]> {
  const python = resolvePython();
  const result = await runProcess(
    python.command,
    [
      ...python.args,
      join(PYTHON_DIR, "list_voices.py"),
      ...(language ? ["--language", language] : []),
    ],
    { timeoutMs: 120_000 },
  );
  try {
    return JSON.parse(result.stdout) as VoiceInfo[];
  } catch (error) {
    throw new ContentAgentError(
      "VOICE_LIST_FAILED",
      "Could not read the Edge TTS voice list.",
      `${(error as Error).message}\n${result.stderr.slice(-800)}`,
    );
  }
}

export interface SynthesizeOptions {
  plan: NormalizedPlan;
  text: string;
  index: number;
  workDir: string;
}

export async function synthesizeScene(options: SynthesizeOptions): Promise<SceneVoice> {
  const { plan, text, index, workDir } = options;
  const dir = ensureDir(join(workDir, "audio"));
  const cacheDir = ensureDir(join(workDir, "cache"));
  const stem = `scene-${String(index + 1).padStart(2, "0")}`;
  const textFile = join(cacheDir, `${stem}.txt`);
  const audioFile = join(dir, `${stem}.mp3`);
  writeFileSync(textFile, text, "utf8");

  const python = resolvePython();
  const result = await runProcess(
    python.command,
    [
      ...python.args,
      join(PYTHON_DIR, "tts_edge.py"),
      "--text-file",
      textFile,
      "--out",
      audioFile,
      "--voice",
      plan.voice.voice,
      "--rate",
      plan.voice.rate,
      "--pitch",
      plan.voice.pitch,
      "--volume",
      plan.voice.volume,
    ],
    { timeoutMs: 180_000 },
  );

  let words: WordTiming[] = [];
  try {
    const sidecar = JSON.parse(readFileSync(`${audioFile}.json`, "utf8")) as { words?: WordTiming[] };
    words = Array.isArray(sidecar.words) ? sidecar.words : [];
  } catch {
    // No sidecar: subtitles will fall back to proportional timing.
  }

  const seconds = await ensureAudioFile(audioFile);
  if (result.stderr.trim()) {
    // Edge TTS occasionally logs harmless warnings; they are not a failure.
  }

  return {
    index,
    file: audioFile,
    words,
    durationMs: Math.round(seconds * 1000),
  };
}

export async function synthesizeAll(
  plan: NormalizedPlan,
  workDir: string,
  log: (message: string) => void,
): Promise<Map<number, SceneVoice>> {
  const result = new Map<number, SceneVoice>();
  const narrated = plan.scenes.filter((scene) => scene.narration.trim());
  let done = 0;
  for (const scene of narrated) {
    log(`  voice ${done + 1}/${narrated.length}: scene ${scene.index + 1} (${plan.voice.voice})`);
    const voice = await synthesizeScene({ plan, text: scene.narration, index: scene.index, workDir });
    if (voice.durationMs < 250) {
      throw new ContentAgentError(
        "VOICE_TOO_SHORT",
        `Narration for scene ${scene.index + 1} produced only ${voice.durationMs} ms of audio.`,
      );
    }
    result.set(scene.index, voice);
    done++;
  }
  return result;
}
