/**
 * Subtitle generation.
 *
 * Edge TTS emits word boundaries, so cues are built from real speech timing.
 * When a voice omits boundaries, timing falls back to a proportional split of
 * the measured audio duration. Both SRT (deliverable) and ASS (burn-in) are
 * written.
 */

import type { SubtitleCue, WordTiming } from "./video-types.ts";

const SENTENCE_END = /[.!?…]$/;

function normalizeWord(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’ʻ'`´]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, "")
    .trim();
}

/** Prefer the original narration spelling (with punctuation) when possible. */
export function alignNarration(narration: string, words: WordTiming[]): WordTiming[] {
  const tokens = narration.split(/\s+/).filter(Boolean);
  if (tokens.length !== words.length) return words;
  const normalizedTokens = tokens.map(normalizeWord);
  const normalizedWords = words.map((word) => normalizeWord(word.text));
  const matches = normalizedTokens.every((token, index) => token === normalizedWords[index]);
  if (!matches) return words;
  return words.map((word, index) => ({ ...word, text: tokens[index] }));
}

export interface CueOptions {
  width: number;
  height: number;
  /** Extra offset added to every cue (used for scene start times). */
  offsetMs?: number;
}

export function cuesFromWords(words: WordTiming[], options: CueOptions): SubtitleCue[] {
  const fontSize = Math.max(24, Math.round(options.height * 0.028));
  const charsPerLine = Math.max(16, Math.floor((options.width * 0.86) / (fontSize * 0.52)));
  const maxChars = charsPerLine * 2;
  const maxDuration = 4.5;
  const offset = options.offsetMs ?? 0;

  const cues: SubtitleCue[] = [];
  let current: WordTiming[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const start = current[0].startMs + offset;
    const end = Math.max(current[current.length - 1].endMs + offset, start + 350);
    cues.push({
      startMs: start,
      endMs: end,
      text: current.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim(),
    });
    current = [];
    currentChars = 0;
  };

  for (const word of words) {
    const clean = word.text.trim();
    if (!clean) continue;
    const length = clean.length + (current.length > 0 ? 1 : 0);
    const wouldOverflow = currentChars + length > maxChars;
    const wouldRunLong =
      current.length > 0 && word.endMs - current[0].startMs > maxDuration * 1000;
    if (current.length > 0 && (wouldOverflow || wouldRunLong)) flush();
    current.push({ ...word, text: clean });
    currentChars += length;
    if (SENTENCE_END.test(clean) && (currentChars >= 16 || current.length >= 5)) flush();
  }
  flush();
  return cues;
}

/** Fallback when the voice provider returns no word boundaries. */
export function cuesFromText(
  narration: string,
  durationMs: number,
  options: CueOptions,
): SubtitleCue[] {
  const fontSize = Math.max(24, Math.round(options.height * 0.028));
  const charsPerLine = Math.max(16, Math.floor((options.width * 0.86) / (fontSize * 0.52)));
  const maxChars = charsPerLine * 2;
  const tokens = narration.split(/\s+/).filter(Boolean);
  const offset = options.offsetMs ?? 0;

  const groups: string[][] = [];
  let group: string[] = [];
  let length = 0;
  for (const token of tokens) {
    const add = token.length + (group.length > 0 ? 1 : 0);
    if (group.length > 0 && length + add > maxChars) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(token);
    length += add;
  }
  if (group.length > 0) groups.push(group);

  const totalChars = Math.max(1, tokens.join(" ").length);
  let cursor = 0;
  return groups.map((words) => {
    const text = words.join(" ");
    const share = text.length / totalChars;
    const start = cursor;
    const end = cursor + share * durationMs;
    cursor = end;
    return {
      startMs: start + offset,
      endMs: end + offset,
      text,
    };
  });
}

function srtTime(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds,
  ).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function buildSrt(cues: SubtitleCue[]): string {
  return `${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`,
    )
    .join("\n")}\n`;
}

function assTime(ms: number): string {
  const value = Math.max(0, Math.round(ms / 10) * 10);
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const centis = Math.floor((value % 1000) / 10);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(
    centis,
  ).padStart(2, "0")}`;
}

function escapeAss(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N")
    .trim();
}

export function buildAss(cues: SubtitleCue[], width: number, height: number): string {
  const fontSize = Math.max(24, Math.round(height * 0.028));
  const marginV = Math.round(height * 0.09);
  const marginH = Math.round(width * 0.075);
  const outline = Math.max(2, Math.round(fontSize * 0.075));
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Segoe UI,${fontSize},&H00FFFFFF,&H000000FF,&H00101014,&H96000000,-1,0,0,0,100,100,0,0,1,${outline},1,2,${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  const events = cues.map(
    (cue) =>
      `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Default,,0,0,0,,${escapeAss(cue.text)}`,
  );
  return `${header}\n${events.join("\n")}\n`;
}
