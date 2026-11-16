/**
 * Shared type contracts for the Content Agent.
 *
 * Everything here is runtime-agnostic: no Node, no OpenCode, no Hermes imports.
 * The same contracts are used by the prompt builders, the validators and the
 * Markdown renderers so a change in one place fails loudly in the others.
 */

export const PLATFORMS = [
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
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const LANGUAGES = ["uz", "ru", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const CONTENT_FORMATS = [
  "post",
  "carousel",
  "story",
  "reel-script",
  "short-script",
  "long-form",
  "article",
  "thread",
] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export const OBJECTIVES = [
  "awareness",
  "engagement",
  "traffic",
  "conversion",
  "education",
  "retention",
  "community",
] as const;
export type MarketingObjective = (typeof OBJECTIVES)[number];

/** A single validated request coming from Hermes (or any other caller). */
export interface ContentRequest {
  /** Platform the content is written for. */
  platform: Platform;
  /** What the content must achieve. */
  objective: MarketingObjective;
  /** Who the content is written for. */
  audience: string;
  /** Structural format of the deliverable. */
  format: ContentFormat;
  /** The topic / brief / product / service the content is about. */
  topic: string;
  /** Output language. */
  language: Language;
  /** Optional tone override, e.g. "playful", "expert", "urgent". */
  tone?: string;
  /** Optional extra instructions from the caller. */
  notes?: string;
  /** Optional call to action the content must use. */
  callToAction?: string;
  /** Optional brand profile id (defaults to the active profile). */
  brandProfile?: string;
}

/** Calendar entry input — one row per planned publication. */
export interface CalendarRequest {
  /** Period covered by the calendar. */
  period: "daily" | "weekly" | "monthly";
  /** ISO date (YYYY-MM-DD) the period starts on. */
  startDate: string;
  /** Number of days to plan. */
  days: number;
  /** Platforms to distribute across. */
  platforms: Platform[];
  /** Objective that dominates the calendar. */
  objective: MarketingObjective;
  /** The business / product / theme the calendar is built around. */
  topic: string;
  /** Optional per-day content pillars. */
  pillars?: string[];
  language: Language;
  tone?: string;
  notes?: string;
  brandProfile?: string;
}

/**
 * The structured shape the Content Agent must return for a single content
 * piece. Field names are intentionally snake_case so the JSON is stable and
 * easy to validate.
 */
export interface ContentPiece {
  platform: string;
  objective: string;
  target_audience: string;
  content_format: string;
  headline_or_hook: string;
  main_content: string;
  call_to_action: string;
  hashtags?: string[];
  visual_or_video_suggestions?: string[];
  /** Explicit marker that a fact was supplied by the user, not invented. */
  verified_facts?: string[];
  /** Ideas the model proposed that must be confirmed by the user first. */
  creative_suggestions?: string[];
  /** Language actually produced. */
  language?: string;
}

/** One row of a content calendar. */
export interface CalendarEntry {
  date: string;
  platform: string;
  topic: string;
  content_format: string;
  caption_or_script_idea: string;
  marketing_objective: string;
  call_to_action: string;
  hashtags?: string[];
}

/** A whole calendar. */
export interface ContentCalendar {
  period: string;
  start_date: string;
  end_date: string;
  objective: string;
  language?: string;
  entries: CalendarEntry[];
}

/**
 * Envelope every model answer is wrapped in.
 *
 * `status: "needs_input"` is the escape hatch for missing essential
 * information: the agent asks instead of inventing facts.
 */
export type ContentEnvelope<T> =
  | { status: "ok"; content: T }
  | { status: "needs_input"; questions: string[]; missing?: string[] };

/** Persistent brand identity used to steer every generated asset. */
export interface BrandProfile {
  id: string;
  brand_name: string;
  /** Free-form description of the product / service. */
  product_description?: string;
  audience?: string;
  tone?: string[];
  /** Marketing goals the content should serve. */
  goals?: string[];
  /** Facts that are verified and may be stated as facts. */
  verified_facts?: string[];
  /** Claims that are NOT verified — the agent must never state them as facts. */
  prohibited_claims?: string[];
  /** Products / services with details, prices etc. Left empty unless supplied. */
  offers?: Array<{
    name: string;
    description?: string;
    price?: string;
    currency?: string;
  }>;
  /** Usual call to action. */
  default_cta?: string;
  /** Hashtag pool. */
  hashtags?: string[];
  language?: Language;
  /** Free-form notes. */
  notes?: string;
}

/** Result of a bridge call. */
export interface BridgeResult {
  /** Raw assistant text produced by the model. */
  text: string;
  /** Session id reported by OpenCode, useful for debugging. */
  sessionId?: string;
  /** Model actually used. */
  model?: string;
  /** Wall clock duration in milliseconds. */
  durationMs: number;
}

/** Structured, user-facing error. */
export class ContentAgentError extends Error {
  readonly code: string;
  readonly details?: string;

  constructor(code: string, message: string, details?: string) {
    super(message);
    this.name = "ContentAgentError";
    this.code = code;
    this.details = details;
  }
}
