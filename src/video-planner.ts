/**
 * Standalone planning through OpenCode + Big Pickle.
 *
 * This path exists for CLI use. Inside Hermes Agent the Hermes model writes the
 * plan itself (see the installed SKILL.md) and only the deterministic renderer
 * runs here — so the finished feature does not depend on OpenCode being logged in.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent } from "./opencode-bridge.ts";
import { parseVideoPlan, normalizeVideoPlan } from "./plan-validator.ts";
import { extractJsonObject } from "./schema.ts";
import { ContentAgentError } from "./types.ts";
import type { NormalizedPlan } from "./video-types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");

export interface PlanRequestOptions {
  request: string;
  language?: string;
  aspect?: string;
  duration?: number;
  mode?: string;
  voice?: string;
  images?: string[];
  model: string;
  agent: string;
  timeoutMs: number;
}

function promptTemplate(): string {
  try {
    return readFileSync(join(PROJECT_ROOT, "prompts", "video-plan.md"), "utf8");
  } catch {
    return "Return a JSON video plan with title, language, mode, aspect_ratio, scenes[] and optional voice/music/subtitles.";
  }
}

export async function generateVideoPlan(
  options: PlanRequestOptions,
): Promise<NormalizedPlan> {
  const lines: string[] = [];
  lines.push(promptTemplate());
  lines.push("");
  lines.push("## This request");
  lines.push("");
  lines.push(`Request: ${options.request}`);
  if (options.language) lines.push(`Language override: ${options.language}`);
  if (options.aspect) lines.push(`Aspect override: ${options.aspect}`);
  if (options.duration) lines.push(`Target duration: ${options.duration} seconds`);
  if (options.mode) lines.push(`Mode override: ${options.mode}`);
  if (options.voice) lines.push(`Voice override: ${options.voice}`);
  if (options.images?.length) {
    lines.push("");
    lines.push("The user supplied these existing images. Use them in the scenes; do not invent other paths:");
    for (const image of options.images) lines.push(`- ${image}`);
  }
  lines.push("");
  lines.push("Return the final JSON object now.");

  let result;
  try {
    result = await runAgent({
      prompt: lines.join("\n"),
      model: options.model,
      agent: options.agent,
      timeoutMs: options.timeoutMs,
      workdir: PROJECT_ROOT,
    });
  } catch (error) {
    throw new ContentAgentError(
      "PLANNER_FAILED",
      "OpenCode could not produce a video plan.",
      `${(error as Error).message}\n` +
        "Inside Hermes, write the plan JSON yourself and run `video --plan <file>` instead. " +
        "For the standalone path, make sure OpenCode is installed and authenticated.",
    );
  }

  const raw = extractJsonObject(result.text);
  const plan = normalizeVideoPlan(raw, {
    baseDir: PROJECT_ROOT,
    source: `OpenCode (${options.model})`,
  });

  if (options.images?.length) {
    // The model may assign images unevenly or omit them. Make the assignment
    // deterministic and guaranteed for every supplied image.
    plan.scenes.forEach((scene, index) => {
      scene.image = options.images![index % options.images!.length];
    });
  }

  return plan;
}

export function parsePlanText(text: string, source = "stdin"): NormalizedPlan {
  return parseVideoPlan(text, { baseDir: process.cwd(), source });
}
