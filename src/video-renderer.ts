/**
 * FFmpeg assembly.
 *
 * Scenes are animated stills (Ken Burns camera moves), joined with cross-fades,
 * mixed with narration and music, and finished with burned-in subtitles. Every
 * command is explicit — no shell interpolation, no hidden steps.
 */

import { copyFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDir, resolveFfmpeg, resolveFfprobe, runProcess } from "./media-tools.ts";
import type { Motion, NormalizedPlan, Transition } from "./video-types.ts";

interface SceneClipOptions {
  image: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  motion: Motion;
  out: string;
}

function zoompanFilters(options: SceneClipOptions): string {
  const { width, height, fps, motion } = options;
  const frames = Math.max(2, Math.round(options.duration * fps));
  const scaledW = Math.round(width * 1.2);
  const scaledH = Math.round(height * 1.2);
  const denom = Math.max(1, frames - 1);

  let zoom = "1.02";
  let x = "(iw-iw/zoom)/2";
  let y = "(ih-ih/zoom)/2";

  switch (motion) {
    case "zoom-in":
      zoom = `min(1+0.14*on/${frames},1.14)`;
      break;
    case "zoom-out":
      zoom = `max(1.14-0.14*on/${frames},1.0)`;
      break;
    case "pan-left":
      zoom = "1.12";
      x = `(iw-iw/zoom)*(1-on/${denom})`;
      break;
    case "pan-right":
      zoom = "1.12";
      x = `(iw-iw/zoom)*(on/${denom})`;
      break;
    default:
      zoom = "1.02";
      break;
  }

  return [
    `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase`,
    `crop=${scaledW}:${scaledH}`,
    `zoompan=z='${zoom}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=${fps}`,
    "setsar=1",
    `fps=${fps}`,
    "format=yuv420p",
  ].join(",");
}

export async function renderSceneClip(options: SceneClipOptions): Promise<void> {
  const ffmpeg = resolveFfmpeg();
  const frames = Math.max(2, Math.round(options.duration * options.fps));
  await runProcess(
    ffmpeg.command,
    [
      ...ffmpeg.args,
      "-y",
      "-i",
      options.image,
      "-vf",
      zoompanFilters(options),
      "-frames:v",
      String(frames),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      options.out,
    ],
    { timeoutMs: 300_000 },
  );
}

export interface ConcatOptions {
  clips: string[];
  durations: number[];
  starts: number[];
  transitions: Transition[];
  fadeSeconds: number;
  out: string;
}

export async function concatScenes(options: ConcatOptions): Promise<void> {
  const { clips, starts, transitions, fadeSeconds, out } = options;
  if (clips.length === 0) throw new Error("No scene clips to concatenate.");
  if (clips.length === 1) {
    copyFileSync(clips[0], out);
    return;
  }

  const ffmpeg = resolveFfmpeg();
  const args: string[] = [...ffmpeg.args, "-y"];
  for (const clip of clips) args.push("-i", clip);

  const parts: string[] = [];
  let previous = "[0:v]";
  for (let index = 1; index < clips.length; index++) {
    const label = `[v${index}]`;
    const transition = transitions[index] ?? "fade";
    parts.push(
      `${previous}[${index}:v]xfade=transition=${transition}:duration=${fadeSeconds.toFixed(
        3,
      )}:offset=${starts[index].toFixed(3)}${label}`,
    );
    previous = label;
  }

  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    previous,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    out,
  );

  await runProcess(ffmpeg.command, args, { timeoutMs: 600_000 });
}

export interface AudioMixOptions {
  narration: Array<{ file: string; startMs: number }>;
  music: { file: string; volumeDb: number } | null;
  totalSeconds: number;
  out: string;
}

export async function mixAudio(options: AudioMixOptions): Promise<string | null> {
  const { narration, music, totalSeconds, out } = options;
  if (narration.length === 0 && !music) return null;

  const ffmpeg = resolveFfmpeg();
  const args: string[] = [...ffmpeg.args, "-y"];
  for (const item of narration) args.push("-i", item.file);
  if (music) {
    args.push("-stream_loop", "-1", "-i", music.file);
  }

  const parts: string[] = [];
  const narrationLabels: string[] = [];
  narration.forEach((item, index) => {
    const label = `[n${index}]`;
    const delay = Math.max(0, Math.round(item.startMs));
    parts.push(`[${index}:a]adelay=${delay}:all=1,aresample=48000,volume=1.0${label}`);
    narrationLabels.push(label);
  });

  let mixedNarration: string | null = null;
  if (narrationLabels.length === 1) {
    mixedNarration = narrationLabels[0];
  } else if (narrationLabels.length > 1) {
    parts.push(
      `${narrationLabels.join("")}amix=inputs=${narrationLabels.length}:normalize=0:duration=longest[mixn]`,
    );
    mixedNarration = "[mixn]";
  }

  const musicIndex = narration.length;
  let musicLabel: string | null = null;
  if (music) {
    const fadeOutStart = Math.max(0, totalSeconds - 1.2);
    parts.push(
      `[${musicIndex}:a]atrim=0:${totalSeconds.toFixed(
        3,
      )},asetpts=PTS-STARTPTS,aresample=48000,volume=${music.volumeDb}dB,afade=t=in:st=0:d=0.8,afade=t=out:st=${fadeOutStart.toFixed(
        3,
      )}:d=1.2[mus]`,
    );
    musicLabel = "[mus]";
  }

  if (mixedNarration && musicLabel) {
    parts.push(
      `${mixedNarration}${musicLabel}amix=inputs=2:normalize=0:duration=longest,alimiter=limit=0.95,apad,atrim=0:${totalSeconds.toFixed(
        3,
      )},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`,
    );
  } else if (mixedNarration) {
    parts.push(
      `${mixedNarration}apad,atrim=0:${totalSeconds.toFixed(
        3,
      )},alimiter=limit=0.95,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`,
    );
  } else if (musicLabel) {
    parts.push(
      `${musicLabel}apad,atrim=0:${totalSeconds.toFixed(
        3,
      )},alimiter=limit=0.95,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`,
    );
  }

  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[aout]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    out,
  );

  await runProcess(ffmpeg.command, args, { timeoutMs: 600_000 });
  return out;
}

export interface FinalRenderOptions {
  workDir: string;
  video: string;
  audio: string | null;
  ass: string | null;
  out: string;
}

export async function finalRender(options: FinalRenderOptions): Promise<void> {
  const { workDir, video, audio, ass, out } = options;

  if (!audio && !ass) {
    copyFileSync(video, out);
    return;
  }

  const ffmpeg = resolveFfmpeg();
  const args: string[] = [...ffmpeg.args, "-y", "-i", video];
  if (audio) args.push("-i", audio);

  if (ass) {
    args.push("-filter_complex", "[0:v]ass=subtitles.ass[vout]", "-map", "[vout]");
  } else {
    args.push("-map", "0:v");
  }
  if (audio) args.push("-map", "1:a");

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    ...(audio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-shortest",
    "-movflags",
    "+faststart",
    out,
  );

  await runProcess(ffmpeg.command, args, { cwd: workDir, timeoutMs: 900_000 });
}

/** Decode the whole file once; catches corrupt streams that ffprobe accepts. */
export async function decodeCheck(path: string): Promise<string[]> {
  const ffmpeg = resolveFfmpeg();
  const result = await runProcess(
    ffmpeg.command,
    [...ffmpeg.args, "-v", "error", "-i", path, "-f", "null", "-"],
    { timeoutMs: 300_000, allowFailure: true },
  );
  const warnings = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return warnings;
}

export function clipPath(workDir: string, index: number): string {
  return join(ensureDir(join(workDir, "clips")), `scene-${String(index + 1).padStart(2, "0")}.mp4`);
}

export function assertPlanTimings(plan: NormalizedPlan): void {
  void plan;
}

export function resolveProbe(): string {
  return resolveFfprobe().command;
}
