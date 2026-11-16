/**
 * Production pipeline:
 * plan -> visuals -> voice -> timing -> music -> subtitles -> clips -> render.
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDir, slugify, timestamp, writeJson } from "./media-tools.ts";
import { generateMusic, validateUserMusic } from "./music.ts";
import { validateOutput } from "./quality.ts";
import { alignNarration, buildAss, buildSrt, cuesFromText, cuesFromWords } from "./subtitles.ts";
import { ContentAgentError } from "./types.ts";
import { synthesizeAll } from "./voice.ts";
import {
  clipPath,
  concatScenes,
  finalRender,
  mixAudio,
  renderSceneClip,
} from "./video-renderer.ts";
import { renderSceneVisual } from "./visuals.ts";
import type {
  NormalizedPlan,
  SceneVoice,
  SubtitleCue,
  VideoResult,
} from "./video-types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const TRANSITION_SECONDS = 0.45;

export interface ProduceOptions {
  plan: NormalizedPlan;
  /** Parent directory for the run folder. Defaults to <project>/outputs. */
  outDir?: string;
  log?: (message: string) => void;
}

export interface SceneTiming {
  duration: number;
  start: number;
}

export function computeTiming(
  plan: NormalizedPlan,
  voices: Map<number, SceneVoice>,
  warnings: string[],
): SceneTiming[] {
  const scenes = plan.scenes;
  const fade = scenes.length > 1 ? TRANSITION_SECONDS : 0;

  const durations = scenes.map((scene) => {
    const voice = voices.get(scene.index);
    let duration: number;
    if (voice) {
      duration = Math.max(scene.duration ?? 0, voice.durationMs / 1000 + 0.8, 2.5);
    } else {
      duration = Math.max(scene.duration ?? (plan.mode === "narrated" ? 2.5 : 3.0), 1.4);
    }
    if (scenes.length > 1 && duration < fade + 0.5) {
      duration = fade + 0.5;
    }
    return duration;
  });

  // Without narration the plan's target length is authoritative: the visible
  // timeline is sum(clips) - overlaps, so scale the clips to land on target.
  if (plan.mode !== "narrated" && plan.targetDuration && durations.length > 0) {
    const overlap = fade * (durations.length - 1);
    const wanted = plan.targetDuration + overlap;
    const current = durations.reduce((sum, value) => sum + value, 0);
    if (current > 0) {
      const scale = wanted / current;
      for (let index = 0; index < durations.length; index++) {
        durations[index] = Math.max(fade + 0.5, durations[index] * scale);
      }
    }
  }

  for (let index = 0; index < durations.length; index++) {
    durations[index] = Math.round(durations[index] * 1000) / 1000;
  }

  const timings: SceneTiming[] = [];
  let cursor = 0;
  for (let index = 0; index < durations.length; index++) {
    timings.push({ duration: durations[index], start: Math.round(cursor * 1000) / 1000 });
    cursor += durations[index] - fade;
  }

  const total = Math.round(cursor * 1000) / 1000;
  if (plan.targetDuration && Math.abs(total - plan.targetDuration) / plan.targetDuration > 0.25) {
    warnings.push(
      `So'ralgan davomiylik ${plan.targetDuration.toFixed(1)}s, lekin tabiiy ovoz bilan ${total.toFixed(
        1,
      )}s chiqdi. Ovozni tezlashtirmaslik uchun haqiqiy davomiylik saqlandi.`,
    );
  }
  return timings;
}

function buildProviderNotes(
  plan: NormalizedPlan,
  musicSource: "generated" | "user-provided" | null,
  subtitlesBurned: boolean,
  visualSources: Set<string>,
): string[] {
  const notes: string[] = [];
  if (plan.mode === "narrated") {
    notes.push(
      `Ovoz: Microsoft Edge Neural TTS — \`${plan.voice.voice}\` (bepul, API kalitisiz).`,
    );
  } else if (plan.mode === "music") {
    notes.push("Ovoz: yo'q — faqat musiqa (foydalanuvchi so'roviga ko'ra).");
  } else {
    notes.push("Ovoz: yo'q — ovozsiz video (foydalanuvchi so'roviga ko'ra).");
  }
  notes.push(
    visualSources.has("user-image")
      ? "Vizual: foydalanuvchi rasmlari + HTML/CSS matn qatlami (Chromium bilan render)."
      : "Vizual: HTML/CSS sahnalar, Hermes tarkibidagi Chromium bilan 1080p rastrga aylantirildi.",
  );
  notes.push(
    "Harakat: Ken Burns kamera harakati (zoom/pan) — bu AI text-to-video yoki image-to-video modeli EMAS.",
  );
  if (musicSource === "generated") {
    notes.push("Musiqa: algoritmik yaratilgan original skor (numpy), uchinchi tomon sempllari yo'q.");
  } else if (musicSource === "user-provided") {
    notes.push("Musiqa: foydalanuvchi bergan fayl — huquqlar foydalanuvchi zimmasida.");
  } else {
    notes.push("Musiqa: ishlatilmadi.");
  }
  if (subtitlesBurned) {
    notes.push("Subtitr: Edge TTS word-boundary vaqtlari asosida ASS/libass bilan videoga kuydirildi.");
  } else if (plan.subtitles.enabled) {
    notes.push("Subtitr: SRT fayl yaratildi, lekin videoga kuydirilmadi.");
  }
  return notes;
}

export async function produceVideo(options: ProduceOptions): Promise<VideoResult> {
  const { plan } = options;
  const log = options.log ?? (() => {});
  const baseOut = resolve(options.outDir ?? join(PROJECT_ROOT, "outputs"));
  const runDir = ensureDir(join(baseOut, `${timestamp()}-${slugify(plan.title)}`));
  const warnings: string[] = [];

  log(`Rejim: ${plan.mode} · ${plan.aspect} · ${plan.width}x${plan.height} @ ${plan.fps}fps`);
  log(`Papka: ${runDir}`);

  writeJson(join(runDir, "plan.json"), plan);

  log("[1/7] Sahna rasmlari tayyorlanmoqda…");
  const visualSources = new Set<string>();
  const visuals = [];
  for (const scene of plan.scenes) {
    log(
      `  rasm ${scene.index + 1}/${plan.scenes.length}: ${
        scene.image ? "foydalanuvchi rasmi" : "generatsiya (HTML/Chromium)"
      }`,
    );
    const visual = await renderSceneVisual(scene, { plan, workDir: runDir });
    visualSources.add(visual.source);
    visuals.push(visual);
  }

  log("[2/7] Ovoz yozilmoqda…");
  let voices = new Map<number, SceneVoice>();
  if (plan.mode === "narrated") {
    voices = await synthesizeAll(plan, runDir, log);
  } else {
    log("  ovoz o'chirilgan (musiqa/ovozsiz rejim)");
  }

  log("[3/7] Vaqt va subtitrlar hisoblanmoqda…");
  const timings = computeTiming(plan, voices, warnings);
  const total = Math.round((timings[timings.length - 1].start + timings[timings.length - 1].duration) * 1000) / 1000;

  const cues: SubtitleCue[] = [];
  if (plan.subtitles.enabled) {
    for (const scene of plan.scenes) {
      const voice = voices.get(scene.index);
      if (!voice) continue;
      const offsetMs = (timings[scene.index].start + 0.08) * 1000;
      const aligned = alignNarration(scene.narration, voice.words);
      const sceneCues =
        aligned.length > 0
          ? cuesFromWords(aligned, { width: plan.width, height: plan.height, offsetMs })
          : cuesFromText(scene.narration, voice.durationMs, {
              width: plan.width,
              height: plan.height,
              offsetMs,
            });
      cues.push(...sceneCues);
    }
    if (cues.length === 0 && plan.subtitles.enabled) {
      warnings.push("Subtitr yoqilgan, lekin narratsiya matni topilmadi — subtitr yaratilmadi.");
    }
  }

  const srtPath = join(runDir, "subtitles.srt");
  const assPath = join(runDir, "subtitles.ass");
  if (cues.length > 0) {
    writeFileSync(srtPath, buildSrt(cues), "utf8");
    writeFileSync(assPath, buildAss(cues, plan.width, plan.height), "utf8");
  }

  log("[4/7] Musiqa…");
  let music: { file: string; volumeDb: number; source: "generated" | "user-provided"; licence: string } | null =
    null;
  if (plan.mode !== "silent" && plan.music.enabled) {
    if (plan.music.path) {
      const validated = await validateUserMusic(plan.music.path);
      music = { file: validated.file, volumeDb: plan.music.volumeDb, source: validated.source, licence: validated.licence };
      log("  foydalanuvchi musiqasi tekshirildi");
    } else {
      const generated = await generateMusic({
        mood: plan.music.mood,
        durationSeconds: total + 0.3,
        workDir: runDir,
      });
      music = {
        file: generated.file,
        volumeDb: plan.music.volumeDb,
        source: generated.source,
        licence: generated.licence,
      };
      log(`  ${plan.music.mood} musiqa yaratildi`);
    }
  } else if (plan.mode === "music" && !plan.music.enabled) {
    throw new ContentAgentError(
      "MUSIC_DISABLED",
      'Mode "music" requires music, but music.enabled is false.',
      'Enable music or use mode "silent" for an intentionally silent video.',
    );
  } else {
    log("  musiqa o'chirilgan");
  }

  log("[5/7] Sahna videolari render qilinmoqda…");
  const clips: string[] = [];
  for (let index = 0; index < plan.scenes.length; index++) {
    const scene = plan.scenes[index];
    const out = clipPath(runDir, index);
    log(`  klip ${index + 1}/${plan.scenes.length} (${timings[index].duration.toFixed(1)}s, ${scene.motion})`);
    await renderSceneClip({
      image: visuals[index].image,
      duration: timings[index].duration,
      fps: plan.fps,
      width: plan.width,
      height: plan.height,
      motion: scene.motion,
      out,
    });
    clips.push(out);
  }

  log("[6/7] Kliplar va audio birlashtirilmoqda…");
  const baseVideo = join(runDir, "base-video.mp4");
  await concatScenes({
    clips,
    durations: timings.map((timing) => timing.duration),
    starts: timings.map((timing) => timing.start),
    transitions: plan.scenes.map((scene) => scene.transition),
    fadeSeconds: plan.scenes.length > 1 ? TRANSITION_SECONDS : 0,
    out: baseVideo,
  });

  const narrationItems = plan.scenes
    .filter((scene) => voices.has(scene.index))
    .map((scene) => ({
      file: voices.get(scene.index)!.file,
      startMs: Math.round((timings[scene.index].start + 0.08) * 1000),
    }));

  const audioPath = join(runDir, "audio-mix.wav");
  const mixed = await mixAudio({
    narration: narrationItems,
    music: music ? { file: music.file, volumeDb: music.volumeDb } : null,
    totalSeconds: total,
    out: audioPath,
  });

  const burnSubtitles = plan.subtitles.enabled && plan.subtitles.burnIn && cues.length > 0;
  const finalVideo = join(runDir, `${slugify(plan.title)}.mp4`);
  log("[7/7] Yakuniy video va tekshiruv…");
  await finalRender({
    workDir: runDir,
    video: baseVideo,
    audio: mixed,
    ass: burnSubtitles ? assPath : null,
    out: finalVideo,
  });

  const quality = await validateOutput(finalVideo, plan, Boolean(mixed));
  if (quality.decodeWarnings.length > 0) {
    warnings.push(
      `FFmpeg decode tekshiruvida ${quality.decodeWarnings.length} ta ogohlantirish bor (fayl baribir o'qiladi).`,
    );
  }

  const narrationSeconds =
    Math.round(
      (Array.from(voices.values()).reduce((sum, voice) => sum + voice.durationMs, 0) / 1000) * 10,
    ) / 10;
  const providerNotes = buildProviderNotes(
    plan,
    music?.source ?? null,
    burnSubtitles,
    visualSources,
  );

  const result: VideoResult = {
    outputDir: runDir,
    planPath: join(runDir, "plan.json"),
    videoPath: finalVideo,
    srtPath: cues.length > 0 ? srtPath : null,
    manifestPath: join(runDir, "manifest.json"),
    reportPath: join(runDir, "report.md"),
    durationSeconds: Math.round(quality.durationSeconds * 100) / 100,
    width: quality.width,
    height: quality.height,
    fps: plan.fps,
    hasAudio: quality.hasAudio,
    hasSubtitles: cues.length > 0,
    mode: plan.mode,
    sceneCount: plan.scenes.length,
    narrationSeconds,
    musicSeconds: music ? Math.round((total + 0.3) * 10) / 10 : 0,
    warnings,
    providerNotes,
  };

  const manifest = {
    ...result,
    plan,
    quality,
    voice: plan.mode === "narrated" ? plan.voice : null,
    music: music
      ? { source: music.source, mood: plan.music.mood, volumeDb: music.volumeDb, licence: music.licence }
      : null,
    narrationFiles: Array.from(voices.values()).map((voice) => ({
      scene: voice.index + 1,
      file: voice.file,
      durationMs: voice.durationMs,
    })),
    createdAt: new Date().toISOString(),
  };
  writeJson(result.manifestPath, manifest);

  writeFileSync(
    result.reportPath,
    buildReport(result, plan, quality.videoCodec, quality.audioCodec),
    "utf8",
  );

  return result;
}

function buildReport(
  result: VideoResult,
  plan: NormalizedPlan,
  videoCodec: string,
  audioCodec: string | null,
): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title}`);
  lines.push("");
  lines.push("## Natija");
  lines.push("");
  lines.push(`- **Video fayl:** \`${result.videoPath}\``);
  lines.push(`- **Davomiylik:** ${result.durationSeconds.toFixed(2)} s`);
  lines.push(`- **O'lcham:** ${result.width}x${result.height} (${plan.aspect}) @ ${plan.fps}fps`);
  lines.push(`- **Rejim:** ${plan.mode}`);
  lines.push(`- **Sahnalar:** ${result.sceneCount}`);
  lines.push(`- **Video kodek:** ${videoCodec}`);
  lines.push(`- **Audio kodek:** ${audioCodec ?? "yo'q"}`);
  lines.push(`- **Subtitr:** ${result.hasSubtitles ? `\`${result.srtPath}\`` : "yo'q"}`);
  lines.push("");
  lines.push("## Ishlatilgan provayderlar");
  lines.push("");
  for (const note of result.providerNotes) lines.push(`- ${note}`);
  lines.push("");
  lines.push("## Sahnalar");
  lines.push("");
  for (const scene of plan.scenes) {
    lines.push(
      `### ${scene.index + 1}. ${scene.headline || "(matnsiz vizual)"} — ${scene.duration ?? "hisoblangan"}s`,
    );
    if (scene.narration) lines.push(`> ${scene.narration}`);
    lines.push("");
  }
  if (result.warnings.length > 0) {
    lines.push("## Ogohlantirishlar");
    lines.push("");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  lines.push("## Halollik eslatmasi");
  lines.push("");
  lines.push(
    "Bu build'da AI text-to-video / image-to-video provayderi ulanmagan. Video haqiqiy render qilingan, " +
      "lekin harakat statik rasmlar ustidagi kamera animatsiyasi (Ken Burns), generativ video emas. " +
      "Ovoz Edge Neural TTS, musiqa esa algoritmik sintez.",
  );
  lines.push("");
  return lines.join("\n");
}
