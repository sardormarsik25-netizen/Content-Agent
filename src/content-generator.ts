/**
 * Single content piece generation.
 *
 * Builds the brief that is handed to the Content Agent (OpenCode), validates the
 * JSON envelope it returns and renders the result as Markdown.
 */

import { loadBrandProfile, renderProfileForPrompt } from "./brand-profile.ts";
import { runAgent } from "./opencode-bridge.ts";
import { extractJsonObject, validateContentPiece, validateEnvelope } from "./schema.ts";
import { renderContentPiece, renderNeedsInput } from "./render.ts";
import { ContentAgentError } from "./types.ts";
import type {
  BrandProfile,
  ContentEnvelope,
  ContentPiece,
  ContentRequest,
} from "./types.ts";

export interface GenerateOptions {
  /** Model id in `provider/model` form. */
  model: string;
  /** OpenCode agent name. */
  agent: string;
  /** Override the loaded brand profile. */
  profile?: BrandProfile;
  /** Timeout for the model call. */
  timeoutMs?: number;
  /** Extra context appended to the brief (e.g. the raw user message). */
  extraContext?: string;
}

export interface GenerateResult {
  envelope: ContentEnvelope<ContentPiece>;
  markdown: string;
  sessionId?: string;
  model: string;
  durationMs: number;
}

/** Human readable label for each platform, used in the brief. */
const PLATFORM_LABELS: Record<string, string> = {
  telegram: "Telegram (channel or group post)",
  instagram: "Instagram (feed post, story or carousel)",
  facebook: "Facebook (feed post)",
  linkedin: "LinkedIn (professional post)",
  tiktok: "TikTok (short video)",
  "youtube-shorts": "YouTube Shorts",
  x: "X / Twitter",
  blog: "Blog article",
  email: "Email newsletter",
  other: "social media",
};

const FORMAT_LABELS: Record<string, string> = {
  post: "single post",
  carousel: "carousel / swipeable slides",
  story: "story (vertical, ephemeral)",
  "reel-script": "Reel script (15-45 seconds)",
  "short-script": "Short video script (15-60 seconds)",
  "long-form": "long-form post",
  article: "article",
  thread: "thread (numbered posts)",
};

const LANGUAGE_LABELS: Record<string, string> = {
  uz: "Uzbek (Latin script)",
  ru: "Russian",
  en: "English",
};

/**
 * Build the brief that is sent to the Content Agent.
 *
 * Exported so it can be inspected and tested without calling the model.
 */
export function buildContentBrief(
  request: ContentRequest,
  profile: BrandProfile,
  extraContext?: string,
): string {
  const lines: string[] = [];

  lines.push("## Task");
  lines.push("");
  lines.push(
    `Write one ${FORMAT_LABELS[request.format] ?? request.format} for ${
      PLATFORM_LABELS[request.platform] ?? request.platform
    }.`,
  );
  lines.push("");
  lines.push("## Brief");
  lines.push("");
  lines.push(`- **Topic / product / service:** ${request.topic}`);
  lines.push(`- **Objective:** ${request.objective}`);
  lines.push(`- **Target audience:** ${request.audience}`);
  lines.push(`- **Platform:** ${request.platform}`);
  lines.push(`- **Content format:** ${request.format}`);
  lines.push(`- **Language:** ${LANGUAGE_LABELS[request.language] ?? request.language}`);
  if (request.tone) lines.push(`- **Tone:** ${request.tone}`);
  if (request.callToAction) lines.push(`- **Call to action to use:** ${request.callToAction}`);
  if (request.notes) lines.push(`- **Additional instructions:** ${request.notes}`);

  lines.push("");
  lines.push("## Brand profile");
  lines.push("");
  lines.push(renderProfileForPrompt(profile));

  lines.push("");
  lines.push("## Output");
  lines.push("");
  lines.push(
    "Answer with one JSON object only: `{\"status\":\"ok\",\"content\":{...}}` with the fields defined in your system prompt, or `{\"status\":\"needs_input\",\"questions\":[...]}` when something essential is missing.",
  );

  if (extraContext?.trim()) {
    lines.push("");
    lines.push("## Original user request");
    lines.push("");
    lines.push(extraContext.trim());
  }

  return lines.join("\n");
}

/** Generate a single content piece. */
export async function generateContent(
  request: ContentRequest,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const profile = options.profile ?? loadBrandProfile();
  const brief = buildContentBrief(request, profile, options.extraContext);

  const result = await runAgent({
    prompt: brief,
    model: options.model,
    agent: options.agent,
    timeoutMs: options.timeoutMs,
  });

  const payload = extractJsonObject(result.text);
  const envelope = validateEnvelope<ContentPiece>(
    payload,
    validateContentPiece,
    "the content piece",
  );

  const markdown =
    envelope.status === "ok"
      ? renderContentPiece(envelope.content)
      : renderNeedsInput(envelope.questions, envelope.missing);

  return {
    envelope,
    markdown,
    sessionId: result.sessionId,
    model: result.model,
    durationMs: result.durationMs,
  };
}
