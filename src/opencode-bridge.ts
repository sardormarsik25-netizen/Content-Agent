/**
 * Bridge to the OpenCode CLI.
 *
 * This is the ONLY place that talks to the model. The Content Agent is
 * executed by OpenCode as a dedicated custom agent
 * (`.opencode/agents/content-agent.md`) running on a free model.
 *
 * The bridge never fabricates content: if OpenCode is missing, errors out or
 * times out, the caller receives a ContentAgentError with a clear message.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ContentAgentError } from "./types.ts";
import type { BridgeResult } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Project root = parent of `src/` (works for `src/` and `dist/` layouts). */
export const PROJECT_ROOT = resolve(HERE, "..");

export interface BridgeOptions {
  /** Message sent to the agent. */
  prompt: string;
  /** Model id in `provider/model` form. */
  model?: string;
  /** OpenCode agent name (the markdown agent file's basename). */
  agent: string;
  /** Working directory for the OpenCode run. Defaults to the project root. */
  workdir?: string;
  /** Hard timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra CLI args. */
  extraArgs?: string[];
  /** Maximum number of retries for transient failures. */
  maxRetries?: number;
  /** Base delay for retry backoff in ms. */
  retryDelayMs?: number;
}

export interface ResolvedBinary {
  command: string;
  args: string[];
  source: string;
}

const DEFAULT_MODEL = "opencode/nemotron-3-ultra-free";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * Locate the OpenCode executable without relying on shell resolution.
 *
 * `opencode` on Windows is an npm shim (`.cmd`/`.ps1`) that Node refuses to
 * spawn without a shell, so the native binary inside the npm package is
 * preferred and the shim is only a last resort.
 */
export function resolveOpenCodeBinary(): ResolvedBinary {
  const override = process.env.OPENCODE_BIN?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new ContentAgentError(
        "OPENCODE_NOT_FOUND",
        `OPENCODE_BIN points at a path that does not exist: ${override}`,
      );
    }
    return { command: override, args: [], source: "OPENCODE_BIN" };
  }

  const candidates: Array<{ path: string; source: string }> = [];
  const npmRoots = [
    process.env.npm_config_prefix,
    process.env.APPDATA ? join(process.env.APPDATA, "npm") : undefined,
    join(homedir(), "AppData", "Roaming", "npm"),
    process.env.HOME ? join(process.env.HOME, ".npm-global") : undefined,
    "/usr/local",
    "/opt/homebrew",
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  for (const root of npmRoots) {
    if (process.platform === "win32" && process.arch === "x64") {
      candidates.push({
        path: join(root, "node_modules", "opencode-ai", "node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
        source: "native npm package",
      });
    }
    candidates.push({
      path: join(root, "node_modules", "opencode-ai", "bin", "opencode.exe"),
      source: "npm package",
    });
    candidates.push({
      path: join(root, "node_modules", "opencode-ai", "bin", "opencode"),
      source: "npm package",
    });
  }

  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      return { command: candidate.path, args: [], source: candidate.source };
    }
  }

  // Last resort: the PATH shim. Spawned through a shell so Windows .cmd
  // wrappers work.
  const shim = process.platform === "win32" ? "opencode.cmd" : "opencode";
  return { command: shim, args: [], source: "PATH" };
}

/** Run the OpenCode agent and return the assistant text. */
export async function runAgent(options: BridgeOptions): Promise<BridgeResult> {
  const binary = resolveOpenCodeBinary();
  const workdir = options.workdir ?? PROJECT_ROOT;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const argv = [
    ...binary.args,
    "run",
    "--model",
    model,
    "--agent",
    options.agent,
    "--format",
    "json",
    ...(options.extraArgs ?? []),
    options.prompt,
  ];

  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter
      const delay = retryDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const result = await spawnCliWithTimeout(binary.command, argv, workdir, timeoutMs, model);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry on certain fatal errors
      if (error instanceof ContentAgentError) {
        if (
          error.code === "OPENCODE_NOT_FOUND" ||
          error.code === "OPENCODE_SPAWN_FAILED" ||
          error.code === "EMPTY_MODEL_OUTPUT"
        ) {
          throw error;
        }
      }
      
      // Log retry attempt
      if (attempt < maxRetries) {
        console.warn(`OpenCode attempt ${attempt + 1} failed, retrying...`, lastError.message);
      }
    }
  }

  // All retries exhausted
  throw new ContentAgentError(
    "OPENCODE_MAX_RETRIES_EXCEEDED",
    `OpenCode failed after ${maxRetries + 1} attempts.`,
    lastError?.message,
  );
}

/** Spawn the CLI and collect stdout/stderr with a hard timeout. */
async function spawnCliWithTimeout(
  command: string,
  argv: string[],
  workdir: string,
  timeoutMs: number,
  model: string,
): Promise<BridgeResult> {
  const started = Date.now();
  const { stdout, stderr, code } = await spawnCli(command, argv, workdir, timeoutMs);

  if (code !== 0) {
    throw new ContentAgentError(
      "OPENCODE_FAILED",
      `OpenCode exited with code ${code}.`,
      sanitize(stderr) || sanitize(stdout) || undefined,
    );
  }

  const text = collectAssistantText(stdout);
  if (!text.trim()) {
    throw new ContentAgentError(
      "EMPTY_MODEL_OUTPUT",
      "OpenCode produced no assistant text.",
      sanitize(stderr) || undefined,
    );
  }

  return {
    text,
    sessionId: collectSessionId(stdout),
    model,
    durationMs: Date.now() - started,
  };
}

/** Spawn the CLI and collect stdout/stderr with a hard timeout. */
function spawnCli(
  command: string,
  argv: string[],
  workdir: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    let child;
    try {
      child = spawn(command, argv, {
        cwd: workdir,
        shell: needsShell,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          BOT_TOKEN: undefined,
          XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? join(PROJECT_ROOT, "store", "opencode-data"),
          XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? join(PROJECT_ROOT, "store", "opencode-state"),
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(PROJECT_ROOT, "store", "opencode-cache"),
          NO_COLOR: "1",
        },
      });
    } catch (error) {
      rejectPromise(
        new ContentAgentError(
          "OPENCODE_SPAWN_FAILED",
          `Could not start OpenCode: ${(error as Error).message}`,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    let killTimeoutId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
    };

    const forceKill = () => {
      if (child && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch { }
      }
    };

    const settle = (value: { stdout: string; stderr: string; code: number } | Error, isError: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      forceKill();
      if (isError) rejectPromise(value); else resolvePromise(value);
    };

    timeoutId = setTimeout(() => {
      if (settled) return;
      const error = new ContentAgentError(
        "OPENCODE_TIMEOUT",
        `OpenCode did not finish within ${Math.round(timeoutMs / 1000)}s.`,
        "The model provider may be unreachable or overloaded. Check network connectivity and provider status.",
      );
      // Give the process a brief moment to exit gracefully after SIGTERM
      killTimeoutId = setTimeout(forceKill, 2000);
      killTimeoutId.unref?.();
      try { child.kill("SIGTERM"); } catch { }
      settle(error, true);
    }, timeoutMs);
    timeoutId.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      // A completed response can arrive before OpenCode finishes shutting down.
      const events = stdout.slice(0, stdout.lastIndexOf("\n") + 1).trimEnd();
      try {
        const lastEvent = JSON.parse(events.slice(events.lastIndexOf("\n") + 1));
        if (lastEvent.type === "step_finish" && lastEvent.part?.reason === "stop" && collectAssistantText(events).trim()) {
          settle({ stdout: events, stderr, code: 0 }, false);
        }
      } catch {
        // Ignore partial lines and non-JSON CLI output.
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: Error) => {
      settle(
        new ContentAgentError(
          "OPENCODE_SPAWN_FAILED",
          `Could not start OpenCode (${command}): ${error.message}`,
          "Install it with `npm i -g opencode-ai@latest` or set OPENCODE_BIN.",
        ),
        true,
      );
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settle({ stdout, stderr, code: code ?? 0 }, false);
    });
  });
}

/** Concatenate every text part of the OpenCode JSON event stream. */
export function collectAssistantText(stdout: string): string {
  const chunks: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    const part = record.part as Record<string, unknown> | undefined;
    if (!part || part.type !== "text") continue;
    const text = part.text;
    if (typeof text === "string") chunks.push(text);
  }
  return chunks.join("");
}

/** Read the session id out of the event stream (useful for debugging). */
export function collectSessionId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof event.sessionID === "string") return event.sessionID;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Strip ANSI escapes and collapse noise from CLI output. */
export function sanitize(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .trim();
}

/** Default home directory of the Hermes user (used to locate the profile). */
export function defaultHermesHome(): string {
  return (
    process.env.HERMES_HOME ||
    (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "hermes")
      : join(homedir(), ".hermes"))
  );
}
