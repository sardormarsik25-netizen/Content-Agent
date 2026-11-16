/**
 * Content calendar generation.
 *
 * Produces a day-by-day plan for Telegram, Instagram, Facebook, LinkedIn and
 * any other platform the brief asks for, rendered as a Markdown table.
 */

import { loadBrandProfile, renderProfileForPrompt } from "./brand-profile.ts";
import { runAgent } from "./opencode-bridge.ts";
import {
  extractJsonObject,
  validateContentCalendar,
  validateEnvelope,
} from "./schema.ts";
import { renderContentCalendar, renderNeedsInput } from "./render.ts";
import { ContentAgentError } from "./types.ts";
import type {
  BrandProfile,
  CalendarRequest,
  ContentCalendar,
  ContentEnvelope,
} from "./types.ts";

export interface CalendarOptions {
  model: string;
  agent: string;
  profile?: BrandProfile;
  timeoutMs?: number;
  extraContext?: string;
}

export interface CalendarResult {
  envelope: ContentEnvelope<ContentCalendar>;
  markdown: string;
  sessionId?: string;
  model: string;
  durationMs: number;
}

/** ISO date helper that never depends on the local timezone. */
function isoDate(base: Date, offsetDays: number): string {
  const date = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()),
  );
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function parseStartDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new ContentAgentError(
      "INVALID_REQUEST",
      `start_date must be an ISO date (YYYY-MM-DD), received "${value}".`,
    );
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** Build the calendar brief handed to the Content Agent. */
export function buildCalendarBrief(
  request: CalendarRequest,
  profile: BrandProfile,
  extraContext?: string,
): string {
  const start = parseStartDate(request.startDate);
  const end = isoDate(start, Math.max(request.days, 1) - 1);
  const lines: string[] = [];

  lines.push("## Task");
  lines.push("");
  lines.push(
    `Build a ${request.period} content calendar with exactly ${request.days} entries, one per day, starting on ${isoDate(
      start,
      0,
    )} and ending on ${end}.`,
  );
  lines.push("");
  lines.push("## Brief");
  lines.push("");
  lines.push(`- **Business / product / theme:** ${request.topic}`);
  lines.push(`- **Period:** ${request.period} (${request.days} days)`);
  lines.push(`- **Start date:** ${isoDate(start, 0)}`);
  lines.push(`- **End date:** ${end}`);
  lines.push(`- **Platforms:** ${request.platforms.join(", ")}`);
  lines.push(`- **Overall objective:** ${request.objective}`);
  lines.push(`- **Language:** ${request.language}`);
  if (request.tone) lines.push(`- **Tone:** ${request.tone}`);
  if (request.notes) lines.push(`- **Additional instructions:** ${request.notes}`);

  if (request.pillars?.length) {
    lines.push("");
    lines.push("Content pillars to distribute across the period:");
    for (const pillar of request.pillars) lines.push(`- ${pillar}`);
  }

  lines.push("");
  lines.push("## Brand profile");
  lines.push("");
  lines.push(renderProfileForPrompt(profile));

  lines.push("");
  lines.push("## Output");
  lines.push("");
  lines.push(
    "Answer with one JSON object only: `{\"status\":\"ok\",\"content\":{...}}` where content holds period, start_date, end_date, objective, language and an `entries` array with exactly the requested number of entries — or `{\"status\":\"needs_input\",\"questions\":[...]}` when something essential is missing.",
  );

  if (extraContext?.trim()) {
    lines.push("");
    lines.push("## Original user request");
    lines.push("");
    lines.push(extraContext.trim());
  }

  return lines.join("\n");
}

/** Generate a content calendar. */
export async function generateCalendar(
  request: CalendarRequest,
  options: CalendarOptions,
): Promise<CalendarResult> {
  const profile = options.profile ?? loadBrandProfile();
  const brief = buildCalendarBrief(request, profile, options.extraContext);

  const result = await runAgent({
    prompt: brief,
    model: options.model,
    agent: options.agent,
    timeoutMs: options.timeoutMs,
  });

  const payload = extractJsonObject(result.text);
  const envelope = validateEnvelope<ContentCalendar>(
    payload,
    validateContentCalendar,
    "the content calendar",
  );

  const markdown =
    envelope.status === "ok"
      ? renderContentCalendar(envelope.content)
      : renderNeedsInput(envelope.questions, envelope.missing);

  return {
    envelope,
    markdown,
    sessionId: result.sessionId,
    model: result.model,
    durationMs: result.durationMs,
  };
}
