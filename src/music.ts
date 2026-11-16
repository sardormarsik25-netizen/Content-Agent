/**
 * Background music.
 *
 * The default provider is a small procedural composer that writes an original
 * score with numpy — no samples, no third-party licences, no API key. Users can
 * also point the plan at their own licensed track (music.path).
 */

import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureAudioFile, ensureDir, resolvePython, runProcess } from "./media-tools.ts";
import type { MusicMood } from "./video-types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON_DIR = join(resolve(HERE, ".."), "python");

export interface MusicResult {
  file: string;
  durationMs: number;
  source: "generated" | "user-provided";
  licence: string;
}

export async function generateMusic(options: {
  mood: MusicMood;
  durationSeconds: number;
  workDir: string;
}): Promise<MusicResult> {
  const dir = ensureDir(join(options.workDir, "audio"));
  const file = join(dir, "music.wav");
  const duration = Math.max(1, Math.ceil(options.durationSeconds * 10) / 10);
  const python = resolvePython();
  const result = await runProcess(
    python.command,
    [
      ...python.args,
      join(PYTHON_DIR, "make_music.py"),
      "--mood",
      options.mood,
      "--duration",
      String(duration),
      "--out",
      file,
    ],
    { timeoutMs: 180_000 },
  );

  const seconds = await ensureAudioFile(file);
  return {
    file,
    durationMs: Math.round(seconds * 1000),
    source: "generated",
    licence: "algorithmically generated original score (no third-party samples)",
  };
}

export async function validateUserMusic(path: string): Promise<MusicResult> {
  const seconds = await ensureAudioFile(path);
  return {
    file: path,
    durationMs: Math.round(seconds * 1000),
    source: "user-provided",
    licence: "user-provided — the user is responsible for the rights",
  };
}

// Keep the import used even when only the type is needed in some builds.
void runProcess;
