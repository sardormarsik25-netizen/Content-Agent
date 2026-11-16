import assert from "node:assert/strict";
import test from "node:test";

import {
  alignNarration,
  buildAss,
  buildSrt,
  cuesFromText,
  cuesFromWords,
} from "../src/subtitles.ts";
import type { WordTiming } from "../src/video-types.ts";

function words(items: string[], step = 300): WordTiming[] {
  return items.map((text, index) => ({
    text,
    startMs: index * step,
    endMs: index * step + step * 0.8,
  }));
}

test("word cues are grouped and offset for a scene", () => {
  const narration = "Sun'iy intellekt hayotimizning bir qismiga aylandi va u tez rivojlanmoqda.";
  const tokens = narration.split(" ");
  const cues = cuesFromWords(words(tokens), {
    width: 1080,
    height: 1920,
    offsetMs: 500,
  });
  assert.ok(cues.length >= 2);
  assert.equal(cues[0].startMs, 500);
  assert.ok(cues.every((cue) => cue.text.length > 0));
  assert.ok(cues.every((cue, index) => index === 0 || cue.startMs >= cues[index - 1].startMs));
  assert.ok(cues.every((cue) => cue.endMs > cue.startMs));
});

test("a sentence break flushes the cue once it has substance", () => {
  const cues = cuesFromWords(words(["Bu", "birinchi", "gap.", "Ikkinchi", "gap."]), {
    width: 1080,
    height: 1920,
  });
  assert.equal(cues[0].text, "Bu birinchi gap.");
  assert.equal(cues[1].text, "Ikkinchi gap.");
});

test("fallback text cues cover the audio duration proportionally", () => {
  const cues = cuesFromText("Bir ikki uch to'rt besh olti yetti", 7000, {
    width: 1080,
    height: 1920,
    offsetMs: 250,
  });
  assert.equal(cues[0].startMs, 250);
  assert.equal(cues[cues.length - 1].endMs, 7250);
});

test("alignNarration restores original spelling and punctuation", () => {
  const aligned = alignNarration("Sun'iy intellekt.", words(["sun'iy", "intellekt"]));
  assert.equal(aligned[0].text, "Sun'iy");
  assert.equal(aligned[1].text, "intellekt.");
});

test("alignNarration leaves mismatched boundaries untouched", () => {
  const input = words(["boshqa", "matn"]);
  assert.deepEqual(alignNarration("Sun'iy intellekt.", input), input);
});

test("SRT and ASS are well formed", () => {
  const cues = cuesFromWords(words(["Salom", "dunyo."]), {
    width: 1080,
    height: 1920,
  });
  const srt = buildSrt(cues);
  assert.match(srt, /^1\r?\n00:00:00,000 --> /);
  assert.match(srt, /Salom dunyo\./);

  const ass = buildAss(cues, 1080, 1920);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,/);
  assert.match(ass, /Salom dunyo\./);
});
