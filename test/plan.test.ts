import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  normalizeVideoPlan,
  parseAspect,
  readVideoPlan,
} from "../src/plan-validator.ts";
import type { VideoPlanInput } from "../src/video-types.ts";

const ROOT = process.cwd();

test("parseAspect understands common aliases", () => {
  assert.equal(parseAspect("reels"), "9:16");
  assert.equal(parseAspect("YouTube"), "16:9");
  assert.equal(parseAspect("square"), "1:1");
  assert.equal(parseAspect("1080x1920"), "9:16");
  assert.equal(parseAspect(undefined), "9:16");
  assert.throws(() => parseAspect("4:3"), /Unsupported aspect ratio/);
});

test("minimal music plan gets safe defaults", () => {
  const plan = normalizeVideoPlan({
    title: "Test",
    scenes: [{ headline: "Salom" }],
  });
  assert.equal(plan.mode, "music");
  assert.equal(plan.aspect, "9:16");
  assert.equal(plan.width, 1080);
  assert.equal(plan.height, 1920);
  assert.equal(plan.fps, 30);
  assert.equal(plan.voice.voice, "uz-UZ-MadinaNeural");
  assert.equal(plan.music.mood, "uplifting");
  assert.equal(plan.music.enabled, true);
  assert.equal(plan.subtitles.enabled, false);
  assert.equal(plan.scenes[0].duration, 6);
});

test("narrated mode requires narration", () => {
  assert.throws(
    () => normalizeVideoPlan({ mode: "narrated", scenes: [{ headline: "X" }] }),
    /requires narration/,
  );
});

test("invalid modes and styles are rejected, not silently guessed", () => {
  assert.throws(
    () => normalizeVideoPlan({ mode: "cinema", scenes: [{ headline: "X" }] }),
    /Unsupported mode/,
  );
  assert.throws(
    () =>
      normalizeVideoPlan({
        scenes: [{ headline: "X", style: "explosion" }],
      }),
    /Unsupported visual style/,
  );
});

test("scenes must be a non-empty array and image paths must exist", () => {
  assert.throws(() => normalizeVideoPlan({ scenes: [] }), /non-empty "scenes"/);
  assert.throws(
    () =>
      normalizeVideoPlan(
        { scenes: [{ headline: "X", image: "missing.png" }] },
        { baseDir: ROOT },
      ),
    /missing image/,
  );
});

test("scene aliases and palette normalization", () => {
  const plan = normalizeVideoPlan({
    title: "Aliases",
    shots: [
      {
        title: "Sarlavha",
        subtitle: "Kichik matn",
        narration: "Bitta gap.",
        colors: "#fff, #000",
      },
    ],
  });
  assert.equal(plan.scenes.length, 1);
  assert.equal(plan.scenes[0].headline, "Sarlavha");
  assert.equal(plan.scenes[0].subheadline, "Kichik matn");
  assert.deepEqual(plan.scenes[0].palette, ["#ffffff", "#000000", "#000000"]);
});

test("music durations are distributed to the requested length", () => {
  const plan = normalizeVideoPlan({
    mode: "music",
    duration_seconds: 9,
    scenes: [{ headline: "A" }, { headline: "B" }, { headline: "C" }],
  });
  const total = plan.scenes.reduce((sum, scene) => sum + (scene.duration ?? 0), 0);
  assert.equal(Math.round(total * 100) / 100, 9);
});

test("silent mode forces music off", () => {
  const plan = normalizeVideoPlan({
    mode: "silent",
    scenes: [{ headline: "A", duration: 3 }],
    music: { enabled: true, mood: "calm" },
  });
  assert.equal(plan.music.enabled, false);
});

test("bundled example plans are valid", () => {
  const files = ["ai-uz-15s.json", "football-music.json", "images-ad.json"];
  for (const file of files) {
    const plan = readVideoPlan(join(ROOT, "examples", file));
    assert.ok(plan.scenes.length >= 1, file);
    assert.equal(plan.fps, 30, file);
  }
  const narrated = readVideoPlan(join(ROOT, "examples", "ai-uz-15s.json"));
  assert.equal(narrated.mode, "narrated");
  assert.equal(narrated.voice.voice, "uz-UZ-MadinaNeural");
  assert.ok(narrated.scenes.every((scene) => scene.narration.length > 0));
});

test("the documented schema example stays valid", () => {
  const example: VideoPlanInput = {
    title: "Schema",
    language: "uz",
    mode: "narrated",
    scenes: [{ narration: "Salom dunyo.", headline: "Salom" }],
  };
  const plan = normalizeVideoPlan(example);
  assert.equal(plan.mode, "narrated");
  assert.equal(plan.subtitles.enabled, true);
});
