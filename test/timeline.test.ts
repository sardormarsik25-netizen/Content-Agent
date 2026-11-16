import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { readVideoPlan } from "../src/plan-validator.ts";
import type { SceneVoice } from "../src/video-types.ts";
import { computeTiming } from "../src/video-pipeline.ts";

const ROOT = process.cwd();

test("music-only timeline lands on the requested duration", () => {
  const plan = readVideoPlan(join(ROOT, "examples", "football-music.json"));
  const timings = computeTiming(plan, new Map(), []);
  const total = timings[timings.length - 1].start + timings[timings.length - 1].duration;
  assert.ok(Math.abs(total - 12) < 0.01, `expected 12s, got ${total}`);
  assert.ok(timings.every((timing, index) => index === 0 || timing.start > timings[index - 1].start));
});

test("image ad timeline matches nine seconds", () => {
  const plan = readVideoPlan(join(ROOT, "examples", "images-ad.json"));
  const timings = computeTiming(plan, new Map(), []);
  const total = timings[timings.length - 1].start + timings[timings.length - 1].duration;
  assert.ok(Math.abs(total - 9) < 0.01, `expected 9s, got ${total}`);
});

test("narrated timing follows the voice, not the target", () => {
  const plan = readVideoPlan(join(ROOT, "examples", "ai-uz-15s.json"));
  const voices = new Map<number, SceneVoice>();
  for (const scene of plan.scenes) {
    voices.set(scene.index, {
      index: scene.index,
      file: "voice.mp3",
      words: [],
      durationMs: 3000,
    });
  }
  const warnings: string[] = [];
  const timings = computeTiming(plan, voices, warnings);
  assert.equal(timings.length, plan.scenes.length);
  // 3s voice + 0.8s breathing room = 3.8s per scene, minus three overlaps.
  const total = timings[timings.length - 1].start + timings[timings.length - 1].duration;
  assert.ok(Math.abs(total - (3.8 * 4 - 0.45 * 3)) < 0.01, `unexpected ${total}`);
  assert.equal(warnings.length, 0);
});

test("large narration overruns produce an honest warning", () => {
  const plan = readVideoPlan(join(ROOT, "examples", "ai-uz-15s.json"));
  const voices = new Map<number, SceneVoice>();
  for (const scene of plan.scenes) {
    voices.set(scene.index, {
      index: scene.index,
      file: "voice.mp3",
      words: [],
      durationMs: 9000,
    });
  }
  const warnings: string[] = [];
  computeTiming(plan, voices, warnings);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /So'ralgan davomiylik/);
});

test("a single scene has no transition overlap", () => {
  const plan = readVideoPlan(join(ROOT, "examples", "images-ad.json"));
  const single = { ...plan, scenes: [plan.scenes[0]] };
  const timings = computeTiming(single, new Map(), []);
  assert.equal(timings[0].start, 0);
  assert.ok(timings[0].duration >= 5);
});
