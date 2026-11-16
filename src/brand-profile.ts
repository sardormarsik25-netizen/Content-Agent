/**
 * Brand profile storage.
 *
 * The active profile lives in `config/brand-profile.json` and is created from
 * `config/brand-profile.example.json` on first use. Profiles are the ONLY
 * source of brand facts; the agent never invents prices, statistics or
 * testimonials, and anything it proposes creatively is reported separately.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ContentAgentError } from "./types.ts";
import type { BrandProfile } from "./types.ts";
import { PROJECT_ROOT } from "./opencode-bridge.ts";

export const CONFIG_DIR = join(PROJECT_ROOT, "config");
export const EXAMPLE_PATH = join(CONFIG_DIR, "brand-profile.example.json");
export const PROFILE_PATH = join(CONFIG_DIR, "brand-profile.json");

/** A neutral starting point used when no profile exists yet. */
export const EMPTY_PROFILE: BrandProfile = {
  id: "default",
  brand_name: "",
  product_description: "",
  audience: "",
  tone: [],
  goals: [],
  verified_facts: [],
  prohibited_claims: [],
  offers: [],
  default_cta: "",
  hashtags: [],
  language: "uz",
  notes:
    "Fill this file in with real brand information. Leave a field empty to let the agent ask for it instead of guessing.",
};

/** Ensure `config/brand-profile.json` exists; seed it from the example. */
export function ensureProfileFile(): string {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(PROFILE_PATH)) {
    if (existsSync(EXAMPLE_PATH)) {
      copyFileSync(EXAMPLE_PATH, PROFILE_PATH);
    } else {
      writeFileSync(PROFILE_PATH, `${JSON.stringify(EMPTY_PROFILE, null, 2)}\n`, "utf8");
    }
  }
  return PROFILE_PATH;
}

/** Read the active brand profile. */
export function loadBrandProfile(path: string = PROFILE_PATH): BrandProfile {
  const target = existsSync(path) ? path : ensureProfileFile();
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (error) {
    throw new ContentAgentError(
      "PROFILE_UNREADABLE",
      `Could not read the brand profile at ${target}: ${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ContentAgentError(
      "PROFILE_INVALID",
      `The brand profile at ${target} is not valid JSON: ${(error as Error).message}`,
      "Fix the file by hand or delete it to regenerate the default profile.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ContentAgentError(
      "PROFILE_INVALID",
      `The brand profile at ${target} must be a JSON object.`,
    );
  }

  return normalizeProfile(parsed as Partial<BrandProfile>);
}

/** Write the active brand profile, preserving unrelated keys. */
export function saveBrandProfile(profile: BrandProfile, path: string = PROFILE_PATH): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

/** Coerce a parsed profile into the expected shape without losing data. */
export function normalizeProfile(input: Partial<BrandProfile>): BrandProfile {
  const strings = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  const stringList = (value: unknown): string[] => {
    if (typeof value === "string") {
      return value
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (Array.isArray(value)) {
      return value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return [];
  };

  const offers = Array.isArray(input.offers)
    ? input.offers
        .filter((offer) => offer && typeof offer.name === "string")
        .map((offer) => ({
          name: offer.name,
          description: strings(offer.description),
          price: strings(offer.price),
          currency: strings(offer.currency),
        }))
    : [];

  return {
    id: strings(input.id) ?? "default",
    brand_name: strings(input.brand_name) ?? "",
    product_description: strings(input.product_description),
    audience: strings(input.audience),
    tone: stringList(input.tone),
    goals: stringList(input.goals),
    verified_facts: stringList(input.verified_facts),
    prohibited_claims: stringList(input.prohibited_claims),
    offers,
    default_cta: strings(input.default_cta),
    hashtags: stringList(input.hashtags),
    language: input.language,
    notes: strings(input.notes),
  };
}

/**
 * Facts the agent is allowed to state, plus the fields it still needs.
 *
 * Used by the prompt builder and by the "is the brief complete?" check.
 */
export function profileGaps(profile: BrandProfile): string[] {
  const gaps: string[] = [];
  if (!profile.brand_name) gaps.push("brand_name");
  if (!profile.product_description) gaps.push("product_description");
  if (!profile.audience) gaps.push("audience");
  return gaps;
}

/** Render the profile as the compact prompt block handed to the agent. */
export function renderProfileForPrompt(profile: BrandProfile): string {
  const lines: string[] = [];
  lines.push(`Brand name: ${profile.brand_name || "(not set)"}`);
  if (profile.product_description) {
    lines.push(`Product / service: ${profile.product_description}`);
  }
  if (profile.audience) lines.push(`Target audience: ${profile.audience}`);
  if (profile.tone?.length) lines.push(`Tone of voice: ${profile.tone.join(", ")}`);
  if (profile.goals?.length) lines.push(`Marketing goals: ${profile.goals.join(", ")}`);
  if (profile.default_cta) lines.push(`Default call to action: ${profile.default_cta}`);
  if (profile.language) lines.push(`Preferred language: ${profile.language}`);

  if (profile.verified_facts?.length) {
    lines.push("");
    lines.push("VERIFIED FACTS (safe to state as fact):");
    for (const fact of profile.verified_facts) lines.push(`- ${fact}`);
  }
  if (profile.prohibited_claims?.length) {
    lines.push("");
    lines.push("PROHIBITED CLAIMS (never state these, not even as a suggestion):");
    for (const claim of profile.prohibited_claims) lines.push(`- ${claim}`);
  }
  if (profile.offers?.length) {
    lines.push("");
    lines.push("OFFERS (only use the details listed here):");
    for (const offer of profile.offers) {
      const price = offer.price
        ? ` — ${offer.price}${offer.currency ? ` ${offer.currency}` : ""}`
        : " (no price supplied — do not invent one)";
      lines.push(`- ${offer.name}${price}${offer.description ? `: ${offer.description}` : ""}`);
    }
  }
  if (profile.hashtags?.length) {
    lines.push("");
    lines.push(`Hashtag pool: ${profile.hashtags.join(" ")}`);
  }
  if (profile.notes) {
    lines.push("");
    lines.push(`Notes: ${profile.notes}`);
  }
  return lines.join("\n");
}
