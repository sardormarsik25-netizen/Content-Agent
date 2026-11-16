/**
 * Discovery and execution of the external binaries the video pipeline needs.
 *
 * Nothing is assumed to be on PATH. Hermes ships FFmpeg and Chromium inside its
 * own tools directory, so those bundled copies are preferred and every lookup
 * can be overridden with an environment variable.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";

import { ContentAgentError } from "./types.ts";

export function defaultHermesHome(): string {
  return (
    process.env.HERMES_HOME ||
    (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "hermes")
      : join(homedir(), ".hermes"))
  );
}

export interface Binary {
  command: string;
  args: string[];
  source: string;
}

function canExecute(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathCandidates(binaryName: string): string[] {
  const names =
    process.platform === "win32"
      ? [`${binaryName}.exe`, `${binaryName}.cmd`, binaryName]
      : [binaryName];
  const roots = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return roots.flatMap((root) => names.map((name) => join(root, name)));
}

function hermesToolDirs(prefix: string): string[] {
  const tools = join(defaultHermesHome(), "tools");
  try {
    return readdirSync(tools)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse()
      .map((name) => join(tools, name));
  } catch {
    return [];
  }
}

export function resolveFfmpeg(): Binary {
  const override = process.env.FFMPEG_PATH?.trim();
  if (override) {
    if (!canExecute(override)) {
      throw new ContentAgentError(
        "FFMPEG_NOT_FOUND",
        `FFMPEG_PATH points at a file that does not exist: ${override}`,
      );
    }
    return { command: override, args: [], source: "FFMPEG_PATH" };
  }

  const bundled = hermesToolDirs("ffmpeg-")
    .map((dir) =>
      process.platform === "win32"
        ? join(dir, "bin", "ffmpeg.exe")
        : join(dir, "bin", "ffmpeg"),
    )
    .find(canExecute);
  if (bundled) return { command: bundled, args: [], source: "hermes-tools" };

  const fromPath = pathCandidates("ffmpeg").find(canExecute);
  if (fromPath) return { command: fromPath, args: [], source: "PATH" };

  throw new ContentAgentError(
    "FFMPEG_NOT_FOUND",
    "FFmpeg was not found. Hermes normally bundles it under <HERMES_HOME>/tools/ffmpeg-*/bin. " +
      "Install FFmpeg or set FFMPEG_PATH to the executable.",
  );
}

export function resolveFfprobe(): Binary {
  const override = process.env.FFPROBE_PATH?.trim();
  if (override) {
    if (!canExecute(override)) {
      throw new ContentAgentError(
        "FFPROBE_NOT_FOUND",
        `FFPROBE_PATH points at a file that does not exist: ${override}`,
      );
    }
    return { command: override, args: [], source: "FFPROBE_PATH" };
  }

  const ffmpeg = resolveFfmpeg();
  const sibling =
    process.platform === "win32"
      ? join(dirname(ffmpeg.command), "ffprobe.exe")
      : join(dirname(ffmpeg.command), "ffprobe");
  if (canExecute(sibling)) return { command: sibling, args: [], source: `${ffmpeg.source} (sibling)` };

  const fromPath = pathCandidates("ffprobe").find(canExecute);
  if (fromPath) return { command: fromPath, args: [], source: "PATH" };

  throw new ContentAgentError(
    "FFPROBE_NOT_FOUND",
    "ffprobe was not found next to FFmpeg. Set FFPROBE_PATH to the executable.",
  );
}

export function resolveChromium(): Binary {
  const override = process.env.CHROME_PATH?.trim() || process.env.CHROMIUM_PATH?.trim();
  if (override) {
    if (!canExecute(override)) {
      throw new ContentAgentError(
        "CHROMIUM_NOT_FOUND",
        `CHROME_PATH points at a file that does not exist: ${override}`,
      );
    }
    return { command: override, args: [], source: "CHROME_PATH" };
  }

  const relative: string[] =
    process.platform === "win32"
      ? [join("chrome-win64", "chrome.exe"), join("chrome-win", "chrome.exe")]
      : process.platform === "darwin"
        ? [join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")]
        : [join("chrome-linux", "chrome")];

  for (const dir of hermesToolDirs("chromium-")) {
    for (const rel of relative) {
      const candidate = join(dir, rel);
      if (canExecute(candidate)) return { command: candidate, args: [], source: "hermes-tools" };
    }
  }

  const standard =
    process.platform === "win32"
      ? [
          join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];

  const browser = standard.find(canExecute);
  if (browser) return { command: browser, args: [], source: "installed browser" };

  for (const name of ["chrome", "chromium", "msedge"]) {
    const candidate = pathCandidates(name).find(canExecute);
    if (candidate) return { command: candidate, args: [], source: "PATH" };
  }

  throw new ContentAgentError(
    "CHROMIUM_NOT_FOUND",
    "No Chromium/Chrome executable was found. Hermes bundles Chromium under " +
      "<HERMES_HOME>/tools/chromium-*/ — set CHROME_PATH if yours lives elsewhere.",
  );
}

export function resolvePython(): Binary {
  const override = process.env.CONTENT_AGENT_PYTHON?.trim();
  if (override) {
    return { command: override, args: [], source: "CONTENT_AGENT_PYTHON" };
  }
  return {
    command: process.platform === "win32" ? "python" : "python3",
    args: [],
    source: "PATH",
  };
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
  allowFailure?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Spawn a process without a shell and capture UTF-8 output. */
export function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(options.env ?? {}), NO_COLOR: "1" },
      });
    } catch (error) {
      rejectPromise(
        new ContentAgentError(
          "SPAWN_FAILED",
          `Could not start ${command}: ${(error as Error).message}`,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 600_000;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(
        new ContentAgentError(
          "PROCESS_TIMEOUT",
          `${command} did not finish within ${Math.round(timeoutMs / 1000)}s.`,
          tail(stderr),
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(
        new ContentAgentError(
          "SPAWN_FAILED",
          `Could not start ${command}: ${error.message}`,
          "Install the tool or point the matching *_PATH environment variable at it.",
        ),
      );
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: RunResult = {
        code: code ?? 0,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      };
      if (result.code !== 0 && !options.allowFailure) {
        rejectPromise(
          new ContentAgentError(
            "PROCESS_FAILED",
            `${command} exited with code ${result.code}.`,
            tail(stderr) || tail(stdout),
          ),
        );
        return;
      }
      resolvePromise(result);
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input, "utf8");
    } else {
      child.stdin?.end();
    }
  });
}

/** Run a process and throw with a useful stderr tail when it fails. */
export async function runChecked(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runProcess(command, args, options);
}

function tail(text: string, max = 2000): string {
  const clean = text.trim();
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

export interface MediaStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  channels?: number;
  sample_rate?: string;
}

export interface ProbeResult {
  format: {
    duration?: string;
    size?: string;
    format_name?: string;
  };
  streams: MediaStream[];
}

export async function ffprobe(path: string): Promise<ProbeResult> {
  const probe = resolveFfprobe();
  const result = await runChecked(
    probe.command,
    [...probe.args, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { timeoutMs: 60_000 },
  );
  try {
    return JSON.parse(result.stdout) as ProbeResult;
  } catch (error) {
    throw new ContentAgentError(
      "INVALID_MEDIA",
      `ffprobe returned unreadable JSON for ${path}: ${(error as Error).message}`,
      tail(result.stdout) || tail(result.stderr),
    );
  }
}

export function mediaDurationSeconds(probe: ProbeResult): number {
  const value = Number(probe.format.duration ?? probe.streams.find((s) => s.duration)?.duration);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function ensureAudioFile(path: string): Promise<number> {
  const probe = await ffprobe(path);
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const duration = mediaDurationSeconds(probe);
  if (!audio || duration <= 0) {
    throw new ContentAgentError(
      "INVALID_AUDIO",
      `The generated audio is not usable: ${path}`,
      "Expected a decodable audio stream with a positive duration.",
    );
  }
  return duration;
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function slugify(value: string, fallback = "video"): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[‘’ʻ'`]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return (ascii || fallback).slice(0, 48);
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export function isImageFile(path: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp", ".avif", ".bmp"].includes(extname(path).toLowerCase());
}

export function resolveUserPath(input: string, baseDir: string): string {
  const expanded = input.replace(/^~(?=$|[\\/])/, homedir());
  return resolve(baseDir, expanded);
}

export function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
