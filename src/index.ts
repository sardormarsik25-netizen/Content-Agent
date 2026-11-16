#!/usr/bin/env node
/**
 * Content Agent CLI — the bridge Hermes Agent calls.
 *
 * Usage:
 *   content-agent post     --request '<json>' [--json] [--save]
 *   content-agent calendar --request '<json>' [--json] [--save]
 *   content-agent doctor
 *   content-agent profile  show | set '<json>'
 *
 * The request may also be piped in:  echo '<json>' | content-agent post --request -
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureProfileFile, loadBrandProfile, saveBrandProfile } from "./brand-profile.ts";
import { generateContent } from "./content-generator.ts";
import { generateCalendar } from "./content-calendar.ts";
import { PROJECT_ROOT, resolveOpenCodeBinary } from "./opencode-bridge.ts";
import { renderContentCalendar, renderContentPiece, renderNeedsInput } from "./render.ts";
import { ContentAgentError, LANGUAGES } from "./types.ts";
import { runVideoCli, videoCommands } from "./video-cli.ts";
import type {
  CalendarRequest,
  ContentRequest,
  Platform,
} from "./types.ts";

const DEFAULT_MODEL = process.env.CONTENT_AGENT_MODEL?.trim() || "opencode/big-pickle";
const DEFAULT_AGENT = process.env.CONTENT_AGENT_AGENT?.trim() || "content-agent";
const DEFAULT_TIMEOUT = Number(process.env.CONTENT_AGENT_TIMEOUT_MS ?? 300_000);
const OUTPUT_DIR = join(PROJECT_ROOT, "outputs");

interface Flags {
  request?: string;
  json: boolean;
  save: boolean;
  timeout: number;
  model: string;
  agent: string;
}

function parseFlags(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const flags: Flags = {
    json: false,
    save: false,
    timeout: DEFAULT_TIMEOUT,
    model: DEFAULT_MODEL,
    agent: DEFAULT_AGENT,
  };
  const positional: string[] = [];
  let command = "";

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [key, inlineValue] = arg.slice(2).split("=", 2);
      const next = () =>
        inlineValue !== undefined ? inlineValue : argv[++index];
      switch (key) {
        case "request":
          flags.request = next();
          break;
        case "json":
          flags.json = true;
          break;
        case "save":
          flags.save = true;
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
        default:
          throw new ContentAgentError(
            "UNKNOWN_FLAG",
            `Unknown flag "--${key}". Run "content-agent doctor" for usage.`,
          );
      }
      continue;
    }
    if (!command) {
      command = arg;
      continue;
    }
    positional.push(arg);
  }

  return { command, positional, flags };
}

function readRequestPayload(flags: Flags): string {
  const source = flags.request;
  if (!source) {
    throw new ContentAgentError(
      "MISSING_REQUEST",
      'Missing "--request". Pass a JSON object, or "-" to read it from stdin.',
    );
  }
  if (source === "-") {
    try {
      return readFileSync(0, "utf8");
    } catch (error) {
      throw new ContentAgentError(
        "MISSING_REQUEST",
        `Could not read the request from stdin: ${(error as Error).message}`,
      );
    }
  }
  return source;
}

function parseJson(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ContentAgentError(
      "INVALID_REQUEST",
      `The ${label} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ContentAgentError("INVALID_REQUEST", `The ${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

const PLATFORM_VALUES: Platform[] = [
  "telegram",
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube-shorts",
  "x",
  "blog",
  "email",
  "other",
];

function normalizeContentRequest(raw: Record<string, unknown>): ContentRequest {
  const platform = String(raw.platform ?? "").trim().toLowerCase();
  if (!platform) {
    throw new ContentAgentError("INVALID_REQUEST", 'The request is missing "platform".');
  }
  if (!PLATFORM_VALUES.includes(platform as Platform)) {
    throw new ContentAgentError(
      "INVALID_REQUEST",
      `Unsupported platform "${platform}". Supported: ${PLATFORM_VALUES.join(", ")}.`,
    );
  }

  const language = String(raw.language ?? "uz").trim().toLowerCase();
  if (!LANGUAGES.includes(language as (typeof LANGUAGES)[number])) {
    throw new ContentAgentError(
      "INVALID_REQUEST",
      `Unsupported language "${language}". Supported: uz, ru, en.`,
    );
  }

  const topic = String(raw.topic ?? "").trim();
  if (!topic) {
    throw new ContentAgentError(
      "INVALID_REQUEST",
      'The request is missing "topic" (the product, service or subject).',
    );
  }

  return {
    platform: platform as Platform,
    objective: (String(raw.objective ?? "engagement").trim() || "engagement") as ContentRequest["objective"],
    audience: String(raw.audience ?? "").trim() || "the brand's target audience",
    format: (String(raw.format ?? "post").trim() || "post") as ContentRequest["format"],
    topic,
    language: language as ContentRequest["language"],
    tone: raw.tone ? String(raw.tone) : undefined,
    notes: raw.notes ? String(raw.notes) : undefined,
    callToAction: raw.call_to_action ? String(raw.call_to_action) : undefined,
    brandProfile: raw.brand_profile ? String(raw.brand_profile) : undefined,
  };
}

function normalizeCalendarRequest(raw: Record<string, unknown>): CalendarRequest {
  const period = String(raw.period ?? "weekly").trim().toLowerCase();
  if (!["daily", "weekly", "monthly"].includes(period)) {
    throw new ContentAgentError(
      "INVALID_REQUEST",
      `Unsupported period "${period}". Supported: daily, weekly, monthly.`,
    );
  }

  const days = Number(raw.days ?? 7);
  if (!Number.isFinite(days) || days < 1 || days > 90) {
    throw new ContentAgentError(
      "INVALID_REQUEST",
      `"days" must be a number between 1 and 90, received "${raw.days}".`,
    );
  }

  const platforms = Array.isArray(raw.platforms)
    ? (raw.platforms as unknown[])
        .map((value) => String(value).trim().toLowerCase())
        .filter((value): value is Platform =>
          PLATFORM_VALUES.includes(value as Platform),
        )
    : [];
  if (platforms.length === 0) {
    throw new ContentAgentError(
      "INVALID_REQUEST",
      'The request is missing "platforms" (at least one supported platform).',
    );
  }

  const topic = String(raw.topic ?? "").trim();
  if (!topic) {
    throw new ContentAgentError(
      "INVALID_REQUEST",
      'The request is missing "topic" (the business, product or theme).',
    );
  }

  const language = String(raw.language ?? "uz").trim().toLowerCase();
  if (!LANGUAGES.includes(language as (typeof LANGUAGES)[number])) {
    throw new ContentAgentError(
      "INVALID_REQUEST",
      `Unsupported language "${language}". Supported: uz, ru, en.`,
    );
  }

  return {
    period: period as CalendarRequest["period"],
    startDate: String(raw.start_date ?? new Date().toISOString().slice(0, 10)).trim(),
    days,
    platforms,
    objective: (String(raw.objective ?? "engagement").trim() ||
      "engagement") as CalendarRequest["objective"],
    topic,
    pillars: Array.isArray(raw.pillars)
      ? (raw.pillars as unknown[]).map((value) => String(value))
      : undefined,
    language: language as CalendarRequest["language"],
    tone: raw.tone ? String(raw.tone) : undefined,
    notes: raw.notes ? String(raw.notes) : undefined,
    brandProfile: raw.brand_profile ? String(raw.brand_profile) : undefined,
  };
}

function saveOutput(name: string, markdown: string, json: string): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(OUTPUT_DIR, `${stamp}-${name}`);
  writeFileSync(`${base}.md`, markdown, "utf8");
  writeFileSync(`${base}.json`, json, "utf8");
  return base;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Content Agent — Hermes Agent bridge",
      "",
      "Commands:",
      "  video     --plan <file|->      Render a real video from a JSON plan",
      '  video     --request "..."      Plan with OpenCode, then render',
      "  voices                         List Edge Neural TTS voices",
      "  music-test                     Generate a test score",
      "  post      --request '<json>'   Generate a single content piece",
      "  calendar  --request '<json>'   Generate a content calendar",
      "  doctor                         Check the bridge, media tools and profile",
      "  profile show                    Print the active brand profile",
      "  profile set '<json>'            Update the active brand profile",
      "",
      "Flags:",
      "  --request <json|->   Request payload (use - to read stdin)",
      "  --json               Print the raw JSON envelope instead of Markdown",
      "  --save               Also write the result to outputs/",
      "  --model <id>         Override the model (default: " + DEFAULT_MODEL + ")",
      "  --agent <name>       Override the OpenCode agent (default: " + DEFAULT_AGENT + ")",
      "  --timeout <ms>       Model timeout in milliseconds (default: " + DEFAULT_TIMEOUT + ")",
      "",
    ].join("\n"),
  );
}

async function commandDoctor(): Promise<number> {
  const lines: string[] = [];
  lines.push("# Content Agent — doctor");
  lines.push("");
  lines.push(`- Project root: \`${PROJECT_ROOT}\``);
  lines.push(`- Model: \`${DEFAULT_MODEL}\``);
  lines.push(`- OpenCode agent: \`${DEFAULT_AGENT}\``);
  lines.push(`- Timeout: ${DEFAULT_TIMEOUT} ms`);
  lines.push(`- Node: ${process.version}`);

  try {
    const binary = resolveOpenCodeBinary();
    lines.push(`- OpenCode binary: \`${binary.command}\` (${binary.source})`);
  } catch (error) {
    lines.push(`- OpenCode binary: **NOT FOUND** — ${(error as Error).message}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return 1;
  }

  const agentFile = join(PROJECT_ROOT, ".opencode", "agents", `${DEFAULT_AGENT}.md`);
  const promptFile = join(PROJECT_ROOT, "prompts", "content-agent.md");
  lines.push(`- Agent definition: \`${agentFile}\` (${agentFileExists(agentFile) ? "found" : "MISSING"})`);
  lines.push(`- System prompt: \`${promptFile}\` (${promptFileExists(promptFile) ? "found" : "MISSING"})`);

  const profilePath = ensureProfileFile();
  try {
    const profile = loadBrandProfile(profilePath);
    lines.push(`- Brand profile: \`${profilePath}\` (brand: "${profile.brand_name || "not set"}")`);
  } catch (error) {
    lines.push(`- Brand profile: **ERROR** — ${(error as Error).message}`);
  }

  lines.push("");
  lines.push("Run a live check with: `content-agent post --request '{...}'`.");
  process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write("\n");
  return runVideoCli(["doctor-video"]);
}

function agentFileExists(path: string): boolean {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

function promptFileExists(path: string): boolean {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const rawCommand = process.argv[2];
  if (rawCommand && videoCommands.includes(rawCommand)) {
    return runVideoCli(process.argv.slice(2));
  }

  const { command, positional, flags } = parseFlags(process.argv.slice(2));

  if (!command || command === "help" || command === "--help") {
    printUsage();
    return 0;
  }

  switch (command) {
    case "doctor":
      return commandDoctor();

    case "profile": {
      const action = positional[0] ?? "show";
      if (action === "show") {
        const profile = loadBrandProfile();
        process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
        return 0;
      }
      if (action === "set") {
        const payload = positional[1];
        if (!payload) {
          throw new ContentAgentError(
            "INVALID_REQUEST",
            'Usage: content-agent profile set \'{"brand_name":"..."}\'',
          );
        }
        const current = loadBrandProfile();
        const update = parseJson(payload, "profile update");
        const merged = { ...current, ...update } as typeof current;
        saveBrandProfile(merged);
        process.stdout.write(
          `Profile updated: ${ensureProfileFile()}\n`,
        );
        return 0;
      }
      throw new ContentAgentError(
        "UNKNOWN_COMMAND",
        `Unknown profile action "${action}". Use "show" or "set".`,
      );
    }

    case "post": {
      const payload = parseJson(readRequestPayload(flags), "request");
      const request = normalizeContentRequest(payload);
      const result = await generateContent(request, {
        model: flags.model,
        agent: flags.agent,
        timeoutMs: flags.timeout,
        extraContext: payload.raw_request
          ? String(payload.raw_request)
          : undefined,
      });

      const json = JSON.stringify(result.envelope, null, 2);
      if (flags.save) {
        const base = saveOutput("post", result.markdown, json);
        process.stdout.write(`${result.markdown}\n\n_Saved: ${base}.md_\n`);
      } else {
        process.stdout.write(`${flags.json ? json : result.markdown}\n`);
      }
      return 0;
    }

    case "calendar": {
      const payload = parseJson(readRequestPayload(flags), "request");
      const request = normalizeCalendarRequest(payload);
      const result = await generateCalendar(request, {
        model: flags.model,
        agent: flags.agent,
        timeoutMs: flags.timeout,
        extraContext: payload.raw_request
          ? String(payload.raw_request)
          : undefined,
      });

      const json = JSON.stringify(result.envelope, null, 2);
      if (flags.save) {
        const base = saveOutput("calendar", result.markdown, json);
        process.stdout.write(`${result.markdown}\n\n_Saved: ${base}.md_\n`);
      } else {
        process.stdout.write(`${flags.json ? json : result.markdown}\n`);
      }
      return 0;
    }

    default:
      throw new ContentAgentError(
        "UNKNOWN_COMMAND",
        `Unknown command "${command}". Run "content-agent help".`,
      );
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ContentAgentError) {
      process.stderr.write(
        `CONTENT_AGENT_ERROR [${error.code}]: ${error.message}\n${
          error.details ? `\n${error.details}\n` : ""
        }`,
      );
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`CONTENT_AGENT_ERROR [UNEXPECTED]: ${message}\n`);
    if (process.env.CONTENT_AGENT_DEBUG === "1" && error instanceof Error) {
      process.stderr.write(`${error.stack ?? ""}\n`);
    }
    process.exitCode = 1;
  });
