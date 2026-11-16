/**
 * Markdown rendering.
 *
 * Hermes shows the user Markdown, so every structured result is rendered into
 * a readable document. The JSON stays available for programmatic use.
 */

import type { CalendarEntry, ContentCalendar, ContentPiece } from "./types.ts";

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function bullets(values: string[] | undefined, fallback = ""): string {
  if (!values || values.length === 0) return fallback;
  return values.map((value) => `- ${value}`).join("\n");
}

/** Render a single content piece as Markdown. */
export function renderContentPiece(piece: ContentPiece): string {
  const lines: string[] = [];
  lines.push(`## ${piece.headline_or_hook}`);
  lines.push("");
  lines.push(`- **Platform:** ${piece.platform}`);
  lines.push(`- **Objective:** ${piece.objective}`);
  lines.push(`- **Target audience:** ${piece.target_audience}`);
  lines.push(`- **Format:** ${piece.content_format}`);
  if (piece.language) lines.push(`- **Language:** ${piece.language}`);
  lines.push("");
  lines.push("### Content");
  lines.push("");
  lines.push(piece.main_content);
  lines.push("");
  lines.push("### Call to action");
  lines.push("");
  lines.push(piece.call_to_action);

  if (piece.hashtags?.length) {
    lines.push("");
    lines.push("### Hashtags");
    lines.push("");
    lines.push(piece.hashtags.map((tag) => `#${tag}`).join(" "));
  }

  if (piece.visual_or_video_suggestions?.length) {
    lines.push("");
    lines.push("### Visual / video suggestions");
    lines.push("");
    lines.push(bullets(piece.visual_or_video_suggestions));
  }

  if (piece.verified_facts?.length) {
    lines.push("");
    lines.push("### Verified facts used");
    lines.push("");
    lines.push(bullets(piece.verified_facts));
  }

  if (piece.creative_suggestions?.length) {
    lines.push("");
    lines.push("### Creative suggestions (need your confirmation)");
    lines.push("");
    lines.push(bullets(piece.creative_suggestions));
  }

  return lines.join("\n");
}

/** Render one calendar row as a Markdown table row. */
function renderCalendarRow(entry: CalendarEntry): string {
  return `| ${escapeCell(entry.date)} | ${escapeCell(entry.platform)} | ${escapeCell(
    entry.topic,
  )} | ${escapeCell(entry.content_format)} | ${escapeCell(
    entry.caption_or_script_idea,
  )} | ${escapeCell(entry.marketing_objective)} | ${escapeCell(entry.call_to_action)} |`;
}

/** Render a whole calendar as a Markdown document with a table. */
export function renderContentCalendar(calendar: ContentCalendar): string {
  const lines: string[] = [];
  lines.push(`## Content calendar — ${calendar.period}`);
  lines.push("");
  lines.push(`- **Period:** ${calendar.start_date} → ${calendar.end_date}`);
  lines.push(`- **Objective:** ${calendar.objective}`);
  if (calendar.language) lines.push(`- **Language:** ${calendar.language}`);
  lines.push(`- **Entries:** ${calendar.entries.length}`);
  lines.push("");
  lines.push(
    "| Date | Platform | Topic | Format | Caption / script idea | Objective | Call to action |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of calendar.entries) lines.push(renderCalendarRow(entry));

  const withHashtags = calendar.entries.filter((entry) => entry.hashtags?.length);
  if (withHashtags.length) {
    lines.push("");
    lines.push("### Hashtag plan");
    lines.push("");
    for (const entry of withHashtags) {
      lines.push(
        `- **${entry.date}** — ${(entry.hashtags ?? []).map((tag) => `#${tag}`).join(" ")}`,
      );
    }
  }

  return lines.join("\n");
}

/** Render the "needs input" state as Markdown. */
export function renderNeedsInput(questions: string[], missing?: string[]): string {
  const lines: string[] = [];
  lines.push("## Content Agent needs a bit more information");
  lines.push("");
  lines.push("I did not invent anything. Please answer these to continue:");
  lines.push("");
  for (const question of questions) lines.push(`1. ${question}`);
  if (missing?.length) {
    lines.push("");
    lines.push(`Missing fields: \`${missing.join("`, `")}\``);
  }
  return lines.join("\n");
}
