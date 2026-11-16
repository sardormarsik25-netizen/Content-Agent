/**
 * Runtime validation for the structured payloads the Content Agent returns.
 *
 * The model is asked to answer with a single JSON object. It sometimes wraps
 * it in prose or a fenced block, so parsing is tolerant; validation is not.
 * Every failure raises a ContentAgentError with an actionable message.
 */

import { ContentAgentError } from "./types.ts";
import type {
  CalendarEntry,
  ContentCalendar,
  ContentEnvelope,
  ContentPiece,
} from "./types.ts";

/** Extract the first balanced JSON object from a model answer. */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text);

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
    const scanned = scanBalanced(candidate);
    if (scanned !== undefined) {
      const inner = tryParse(scanned);
      if (inner !== undefined) return inner;
    }
  }

  throw new ContentAgentError(
    "INVALID_MODEL_OUTPUT",
    "The model did not return a JSON object.",
    truncate(raw, 600),
  );
}

function tryParse(text: string): unknown {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Return the first `{...}` block that parses as JSON, ignoring surrounding prose. */
function scanBalanced(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContentAgentError(
      "INVALID_MODEL_OUTPUT",
      `Expected ${label} to be a JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string, label: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new ContentAgentError(
    "INVALID_MODEL_OUTPUT",
    `Missing or empty required field "${field}" in ${label}.`,
  );
}

function asOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const parts = value
      .split(/[\s,]+/)
      .map((p) => p.replace(/^[#\s]+/, "").trim())
      .filter(Boolean);
    return parts.length ? parts : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((v) => typeof v === "string" || typeof v === "number")
      .map((v) => String(v).replace(/^[#\s]+/, "").trim())
      .filter(Boolean);
    return parts.length ? parts : undefined;
  }
  throw new ContentAgentError(
    "INVALID_MODEL_OUTPUT",
    `Field "${field}" must be a string or an array of strings.`,
  );
}

/** Validate and normalise a single content piece. */
export function validateContentPiece(value: unknown): ContentPiece {  const raw = asRecord(value, "the content piece");
  const piece: ContentPiece = {
    platform: asString(raw.platform, "platform", "the content piece"),
    objective: asString(raw.objective, "objective", "the content piece"),
    target_audience: asString(
      raw.target_audience,
      "target_audience",
      "the content piece",
    ),
    content_format: asString(
      raw.content_format,
      "content_format",
      "the content piece",
    ),
    headline_or_hook: asString(
      raw.headline_or_hook,
      "headline_or_hook",
      "the content piece",
    ),
    main_content: asString(raw.main_content, "main_content", "the content piece"),
    call_to_action: asString(
      raw.call_to_action,
      "call_to_action",
      "the content piece",
    ),
  };

  const hashtags = asOptionalStringArray(raw.hashtags, "hashtags");
  if (hashtags) piece.hashtags = hashtags;

  const visuals = asOptionalStringArray(
    raw.visual_or_video_suggestions,
    "visual_or_video_suggestions",
  );
  if (visuals) piece.visual_or_video_suggestions = visuals;

  const facts = asOptionalStringArray(raw.verified_facts, "verified_facts");
  if (facts) piece.verified_facts = facts;

  const suggestions = asOptionalStringArray(
    raw.creative_suggestions,
    "creative_suggestions",
  );
  if (suggestions) piece.creative_suggestions = suggestions;

  if (typeof raw.language === "string" && raw.language.trim()) {
    piece.language = raw.language.trim();
  }

  return piece;
}

/** Validate and normalise one calendar row. */
export function validateCalendarEntry(value: unknown, index: number): CalendarEntry {
  const label = `calendar entry #${index + 1}`;
  const raw = asRecord(value, label);
  const entry: CalendarEntry = {
    date: asString(raw.date, "date", label),
    platform: asString(raw.platform, "platform", label),
    topic: asString(raw.topic, "topic", label),
    content_format: asString(raw.content_format, "content_format", label),
    caption_or_script_idea: asString(
      raw.caption_or_script_idea,
      "caption_or_script_idea",
      label,
    ),
    marketing_objective: asString(
      raw.marketing_objective,
      "marketing_objective",
      label,
    ),
    call_to_action: asString(raw.call_to_action, "call_to_action", label),
  };
  const hashtags = asOptionalStringArray(raw.hashtags, "hashtags");
  if (hashtags) entry.hashtags = hashtags;
  return entry;
}

/** Validate and normalise a whole calendar. */
export function validateContentCalendar(value: unknown): ContentCalendar {
  const raw = asRecord(value, "the content calendar");
  if (!Array.isArray(raw.entries)) {
    throw new ContentAgentError(
      "INVALID_MODEL_OUTPUT",
      'Missing required field "entries" in the content calendar.',
    );
  }
  if (raw.entries.length === 0) {
    throw new ContentAgentError(
      "INVALID_MODEL_OUTPUT",
      "The content calendar contains no entries.",
    );
  }

  const calendar: ContentCalendar = {
    period: asString(raw.period, "period", "the content calendar"),
    start_date: asString(raw.start_date, "start_date", "the content calendar"),
    end_date: asString(raw.end_date, "end_date", "the content calendar"),
    objective: asString(raw.objective, "objective", "the content calendar"),
    entries: raw.entries.map((entry, index) => validateCalendarEntry(entry, index)),
  };
  if (typeof raw.language === "string" && raw.language.trim()) {
    calendar.language = raw.language.trim();
  }
  return calendar;
}

/**
 * Validate the envelope the model wraps every answer in.
 *
 * `contentValidator` is applied to the payload of an `ok` envelope.
 */
export function validateEnvelope<T>(
  value: unknown,
  contentValidator: (payload: unknown) => T,
  label: string,
): ContentEnvelope<T> {
  const raw = asRecord(value, label);
  const status = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";

  if (status === "needs_input") {
    const questions = asOptionalStringArray(raw.questions, "questions");
    if (!questions || questions.length === 0) {
      throw new ContentAgentError(
        "INVALID_MODEL_OUTPUT",
        'A "needs_input" answer must contain at least one question.',
      );
    }
    const missing = asOptionalStringArray(raw.missing, "missing");
    return missing
      ? { status: "needs_input", questions, missing }
      : { status: "needs_input", questions };
  }

  if (status && status !== "ok") {
    throw new ContentAgentError(
      "INVALID_MODEL_OUTPUT",
      `Unknown status "${status}" in the ${label}. Expected "ok" or "needs_input".`,
    );
  }

  const payload = raw.content !== undefined ? raw.content : raw;
  return { status: "ok", content: contentValidator(payload) };
}
