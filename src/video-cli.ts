#!/usr/bin/env node
/**
 * Video commands for the Content Agent CLI.
 *
 *   content-agent video --plan <file|-> [--out <dir>] [--json]
 *   content-agent video --request "..." [--language uz] [--duration 15] ...
 *   content-agent voices [--language uz] [--json]
 *   content-agent music-test --mood cinematic --duration 10
 *   content-agent doctor-video
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultHermesHome,
  ensureDir,
  resolveChromium,
  resolveFfmpeg,
  resolveFfprobe,
  resolvePython,
  runProcess,
  timestamp,
} from "./media-tools.ts";
import { generateMusic } from "./music.ts";
import { parseVideoPlan, readVideoPlan } from "./plan-validator.ts";
import { resolveOpenCodeBinary } from "./opencode-bridge.ts";
import { ContentAgentError } from "./types.ts";
import { generateVideoPlan } from "./video-planner.ts";
import { produceVideo } from "./video-pipeline.ts";
import { listVoices } from "./voice.ts";
import type { NormalizedPlan } from "./video-types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const DEFAULT_MODEL = process.env.CONTENT_AGENT_MODEL?.trim() || "opencode/big-pickle";
const DEFAULT_AGENT = process.env.CONTENT_AGENT_AGENT?.trim() || "content-agent";
const DEFAULT_TIMEOUT = Number(process.env.CONTENT_AGENT_TIMEOUT_MS ?? 300_000);

interface Flags {
  plan?: string;
  request?: string;
  out?: string;
  json: boolean;
  language?: string;
  duration?: number;
  aspect?: string;
  mode?: string;
  voice?: string;
  images: string[];
  timeout: number;
  model: string;
  agent: string;
  mood: string;
  all: boolean;
}

function parse(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {
    json: false,
    images: [],
    timeout: DEFAULT_TIMEOUT,
    model: DEFAULT_MODEL,
    agent: DEFAULT_AGENT,
    mood: "cinematic",
    all: false,
  };
  let command = "";

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      const next = () => (inline !== undefined ? inline : argv[++index]);
      switch (key) {
        case "plan":
          flags.plan = next();
          break;
        case "request":
          flags.request = next();
          break;
        case "out":
          flags.out = next();
          break;
        case "json":
          flags.json = true;
          break;
        case "language":
          flags.language = next();
          break;
        case "duration":
          flags.duration = Number(next()) || undefined;
          break;
        case "aspect":
          flags.aspect = next();
          break;
        case "mode":
          flags.mode = next();
          break;
        case "voice":
          flags.voice = next();
          break;
        case "image":
          flags.images.push(next());
          break;
        case "timeout":
          flags.timeout = Number(next()) || DEFAULT_TIMEOUT;
          break;
        case "model":
          flags.model = next() || DEFAULT_MODEL;
          break;
        case "agent":
          flags.agent = next() || DEFAULT_AGENT;
          break;
        case "mood":
          flags.mood = next() || "cinematic";
          break;
        case "all":
          flags.all = true;
          break;
        default:
          throw new ContentAgentError("UNKNOWN_FLAG", `Unknown flag "--${key}".`);
      }
      continue;
    }
    if (!command) command = arg;
  }
  return { command, flags };
}

function printUsage(): void {
  process.stdout.write(
    [
      "Content Agent — video commands",
      "",
      "  video --plan <file|->        Render a JSON plan (recommended inside Hermes)",
      '  video --request "..."        Plan with OpenCode/Big Pickle, then render',
      "      --language uz|ru|en      Request language (request mode)",
      "      --duration 15            Target seconds (request mode)",
      "      --aspect 9:16|16:9|1:1   Output format (request mode)",
      "      --mode narrated|music|silent",
      "      --voice <edge-voice-id>",
      "      --image <path>           Attach a user image (repeatable)",
      "      --out <dir>              Parent output directory",
      "      --json                   Print the machine-readable result",
      "",
      "  voices [--language uz]       List Edge Neural voices",
      "  music-test [--mood calm]     Generate a royalty-free score to test audio",
      "  doctor-video                 Check FFmpeg, Chromium, Python, TTS, OpenCode",
      "",
    ].join("\n"),
  );
}

async function readPlan(flags: Flags): Promise<NormalizedPlan> {
  if (flags.plan) {
    if (flags.plan === "-") {
      const text = readFileSync(0, "utf8");
      return parseVideoPlan(text, { baseDir: process.cwd(), source: "stdin" });
    }
    return readVideoPlan(resolve(process.cwd(), flags.plan));
  }
  if (flags.request) {
    return generateVideoPlan({
      request: flags.request,
      language: flags.language,
      aspect: flags.aspect,
      duration: flags.duration,
      mode: flags.mode,
      voice: flags.voice,
      images: flags.images,
      model: flags.model,
      agent: flags.agent,
      timeoutMs: flags.timeout,
    });
  }
  throw new ContentAgentError(
    "MISSING_PLAN",
    'Pass a plan file with "--plan <file>" or a natural-language request with "--request \\"...\\"".',
  );
}

async function commandVideo(flags: Flags): Promise<number> {
  const plan = await readPlan(flags);
  const log = flags.json ? () => {} : (message: string) => process.stdout.write(`${message}\n`);
  const result = await produceVideo({ plan, outDir: flags.out, log });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  process.stdout.write("\n## Video tayyor\n\n");
  process.stdout.write(`- **Fayl:** \`${result.videoPath}\`\n`);
  process.stdout.write(
    `- **Davomiylik:** ${result.durationSeconds.toFixed(2)} s · ${result.width}x${result.height} @ ${result.fps}fps\n`,
  );
  process.stdout.write(`- **Rejim:** ${result.mode} · sahnalar: ${result.sceneCount}\n`);
  process.stdout.write(`- **Audio:** ${result.hasAudio ? "bor" : "yo'q"}\n`);
  if (result.srtPath) process.stdout.write(`- **Subtitr:** \`${result.srtPath}\`\n`);
  process.stdout.write(`- **Hisobot:** \`${result.reportPath}\`\n`);
  for (const note of result.providerNotes) process.stdout.write(`- ${note}\n`);
  if (result.warnings.length > 0) {
    process.stdout.write("\n### Ogohlantirishlar\n\n");
    for (const warning of result.warnings) process.stdout.write(`- ${warning}\n`);
  }
  return 0;
}

async function commandVoices(flags: Flags): Promise<number> {
  const wanted = flags.language
    ? [flags.language]
    : flags.all
      ? [""]
      : ["uz", "ru", "en"];
  const voices = [];
  for (const language of wanted) {
    voices.push(...(await listVoices(language || undefined)));
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(voices, null, 2)}\n`);
    return 0;
  }
  process.stdout.write("| Voice | Locale | Gender |\n| --- | --- | --- |\n");
  for (const voice of voices) {
    process.stdout.write(`| ${voice.name} | ${voice.locale} | ${voice.gender} |\n`);
  }
  return 0;
}

async function commandMusicTest(flags: Flags): Promise<number> {
  const duration = flags.duration ?? 10;
  const outDir = ensureDir(flags.out ?? join(PROJECT_ROOT, "outputs", `music-test-${timestamp()}`));
  const result = await generateMusic({
    mood: flags.mood as "cinematic" | "energetic" | "uplifting" | "calm",
    durationSeconds: duration,
    workDir: outDir,
  });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Music: ${result.file}\nLicence: ${result.licence}\n`);
  }
  return 0;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

async function commandDoctor(): Promise<number> {
  const lines: string[] = ["# Content Agent — video doctor", ""];
  let ok = true;

  try {
    const ffmpeg = resolveFfmpeg();
    const version = await runProcess(ffmpeg.command, ["-version"], { timeoutMs: 30_000 });
    lines.push(`- **FFmpeg:** ✓ \`${ffmpeg.command}\` (${ffmpeg.source}) — ${firstLine(version.stdout)}`);
  } catch (error) {
    ok = false;
    lines.push(`- **FFmpeg:** ✗ ${(error as Error).message}`);
  }

  try {
    const ffprobe = resolveFfprobe();
    lines.push(`- **ffprobe:** ✓ \`${ffprobe.command}\` (${ffprobe.source})`);
  } catch (error) {
    ok = false;
    lines.push(`- **ffprobe:** ✗ ${(error as Error).message}`);
  }

  try {
    const chromium = resolveChromium();
    const size = Math.round(statSync(chromium.command).size / 1024 / 1024);
    lines.push(
      `- **Chromium:** ✓ \`${chromium.command}\` (${chromium.source}, ${size} MiB) — headless screenshot verified separately`,
    );
  } catch (error) {
    ok = false;
    lines.push(`- **Chromium:** ✗ ${(error as Error).message}`);
  }

  try {
    const python = resolvePython();
    const check = await runProcess(
      python.command,
      [
        ...python.args,
        "-c",
        "import sys, importlib.metadata as m; print(sys.version.split()[0]); print(m.version('edge-tts')); print(m.version('numpy'))",
      ],
      { timeoutMs: 60_000 },
    );
    const [py, edge, numpy] = check.stdout.trim().split(/\r?\n/);
    lines.push(`- **Python:** ✓ ${py} · edge-tts ${edge} · numpy ${numpy}`);
  } catch (error) {
    ok = false;
    lines.push(`- **Python / edge-tts / numpy:** ✗ ${(error as Error).message}`);
  }

  const font = process.platform === "win32" ? join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "segoeui.ttf") : null;
  if (font) {
    lines.push(`- **Segoe UI font:** ${existsSync(font) ? "✓" : "⚠ topilmadi (Arial fallback ishlaydi)"}`);
  }

  try {
    const binary = resolveOpenCodeBinary();
    lines.push(`- **OpenCode:** ✓ \`${binary.command}\` (${binary.source}) — agent: ${DEFAULT_AGENT}, model: ${DEFAULT_MODEL}`);
  } catch (error) {
    lines.push(`- **OpenCode:** ⚠ ${(error as Error).message} (faqat --request rejimi uchun kerak)`);
  }

  // Bot dependencies check
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
    const hasGrammy = pkg.dependencies?.grammy && pkg.dependencies?.dotenv;
    lines.push(`- **Bot deps:** ${hasGrammy ? "✓ grammy + dotenv" : "⚠ npm install kerak"}`);
  } catch {
    lines.push("- **Bot deps:** ⚠ package.json topilmadi");
  }

  const skillPath = join(defaultHermesHome(), "skills", "creative", "content-agent");
  lines.push(
    `- **Hermes skill:** ${existsSync(skillPath) ? `✓ \`${skillPath}\`` : `⚠ o'rnatilmagan (\`${skillPath}\`)`}`,
  );

  try {
    ensureDir(join(PROJECT_ROOT, "outputs"));
    const stat = statSync(join(PROJECT_ROOT, "outputs"));
    lines.push(`- **Outputs:** ✓ \`${join(PROJECT_ROOT, "outputs")}\` (${stat.isDirectory() ? "writable dir" : "unknown"})`);
  } catch (error) {
    ok = false;
    lines.push(`- **Outputs:** ✗ ${(error as Error).message}`);
  }

  lines.push("");
  lines.push(ok ? "Asosiy vositalar tayyor." : "Ba'zi vositalar yetishmayapti — yuqoridagi xatolarni tuzating.");
  process.stdout.write(`${lines.join("\n")}\n`);
  return ok ? 0 : 1;
}

async function commandBot(flags: Flags): Promise<number> {
  if (!process.env.BOT_TOKEN) {
    process.stderr.write("❌ BOT_TOKEN environment variable talab qilinadi\n");
    return 1;
  }
  const { default: mod } = await import("./telegram-bot.ts");
  return 0;
}

export async function runVideoCli(argv: string[]): Promise<number> {
  const { command, flags } = parse(argv);
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return 0;
  }
  switch (command) {
    case "video":
      return commandVideo(flags);
    case "voices":
      return commandVoices(flags);
    case "music-test":
      return commandMusicTest(flags);
    case "doctor-video":
      return commandDoctor();
    case "bot":
      return commandBot(flags);
    default:
      throw new ContentAgentError(
        "UNKNOWN_COMMAND",
        `Unknown video command "${command}". Run "content-agent help".`,
      );
  }
}

export const videoCommands = ["video", "voices", "music-test", "doctor-video", "bot"];
