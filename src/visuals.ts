/**
 * Scene poster generation.
 *
 * Every scene gets a real 1080p-class still frame: user photos are used as-is
 * (with a readable scrim), and generated scenes are composed as HTML/CSS and
 * rasterised by the Chromium build that ships with Hermes. The renderer then
 * adds camera motion to those stills. This is image animation, not an AI video
 * model, and the report says so explicitly.
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { ensureDir, ffprobe, resolveChromium, runChecked } from "./media-tools.ts";
import { ContentAgentError } from "./types.ts";
import type { NormalizedPlan, NormalizedScene, SceneVisual } from "./video-types.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contrastColor(background: string): string {
  const hex = background.replace("#", "");
  if (hex.length !== 6) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#08111f" : "#ffffff";
}

function sceneDecor(style: NormalizedScene["style"], palette: string[]): string {
  const [, accent, accent2] = palette;
  switch (style) {
    case "grid":
      return `
        <div class="grid"></div>
        <div class="glow glow-a"></div>`;
    case "spotlight":
      return `
        <div class="cone"></div>
        <div class="ring"></div>
        <div class="glow glow-b"></div>`;
    case "stripes":
      return `
        <div class="stripes"></div>
        <div class="glow glow-a"></div>`;
    case "minimal":
      return `
        <div class="frame"></div>
        <div class="glow glow-c"></div>`;
    default:
      return `
        <div class="blob blob-a"></div>
        <div class="blob blob-b"></div>
        <div class="blob blob-c"></div>
        <div class="glow glow-a"></div>`;
  }
}

export function buildSceneHtml(
  scene: NormalizedScene,
  plan: NormalizedPlan,
  imageFile: string | null,
): string {
  const { width: w, height: h } = plan;
  const [bg, accent, accent2] = scene.palette;
  const pad = Math.round(Math.min(w * 0.075, h * 0.075));
  const h1 = Math.round(Math.min(w * 0.11, h * 0.075));
  const subtitle = Math.round(h1 * 0.34);
  const kicker = Math.round(h1 * 0.22);
  const textColor = contrastColor(bg);
  const maxHeadlineHeight = Math.round(h * 0.36);
  const bottom = Math.round(h * (plan.aspect === "9:16" ? 0.14 : 0.1));
  const progress = Math.round(((scene.index + 1) / plan.scenes.length) * 100);
  const hasText = Boolean(scene.headline || scene.subheadline || scene.kicker);
  const photo = imageFile
    ? `<img class="photo ${scene.imageFit === "contain" ? "photo-blur" : ""}" src="${escapeHtml(imageFile)}" alt="">
       ${scene.imageFit === "contain" ? `<img class="photo photo-contain" src="${escapeHtml(imageFile)}" alt="">` : ""}
       <div class="scrim"></div>`
    : "";

  return `<!doctype html>
<html lang="${escapeHtml(plan.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${w}, initial-scale=1">
<title>${escapeHtml(plan.title)} — ${scene.index + 1}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: ${bg}; }
  body {
    font-family: "Segoe UI", "Segoe UI Variable Display", "Inter", "Arial", sans-serif;
    color: ${textColor};
    -webkit-font-smoothing: antialiased;
  }
  .bg {
    position: absolute; inset: 0;
    background:
      radial-gradient(120% 80% at 78% 12%, ${accent}44 0%, transparent 56%),
      radial-gradient(90% 70% at 12% 88%, ${accent2}38 0%, transparent 62%),
      linear-gradient(165deg, ${bg} 0%, #01030a 100%);
  }
  .glow { position: absolute; border-radius: 50%; filter: blur(90px); opacity: .6; mix-blend-mode: screen; }
  .glow-a { width: 62%; height: 44%; left: -12%; top: 6%; background: ${accent}; }
  .glow-b { width: 70%; height: 46%; right: -18%; bottom: 4%; background: ${accent2}; }
  .glow-c { width: 55%; height: 38%; right: 8%; top: 18%; background: ${accent}; opacity: .38; }
  .blob { position: absolute; border-radius: 50%; filter: blur(60px); opacity: .5; mix-blend-mode: screen; }
  .blob-a { width: 55%; height: 30%; left: 6%; top: 12%; background: ${accent}; }
  .blob-b { width: 62%; height: 34%; right: -10%; top: 44%; background: ${accent2}; opacity: .42; }
  .blob-c { width: 44%; height: 24%; left: 18%; bottom: 8%; background: ${accent}; opacity: .3; }
  .grid {
    position: absolute; inset: -10%;
    background-image:
      linear-gradient(rgba(255,255,255,.11) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.11) 1px, transparent 1px);
    background-size: ${Math.round(w * 0.085)}px ${Math.round(w * 0.085)}px;
    transform: perspective(${Math.round(w * 1.6)}px) rotateX(58deg) translateY(24%);
    transform-origin: 50% 88%;
    mask-image: linear-gradient(180deg, transparent 12%, #000 62%, transparent 100%);
    opacity: .55;
  }
  .stripes {
    position: absolute; inset: -20%;
    background: repeating-linear-gradient(118deg, transparent 0 ${Math.round(w * 0.055)}px, ${accent}22 ${Math.round(w * 0.055)}px ${Math.round(w * 0.07)}px);
    transform: rotate(-4deg);
  }
  .cone {
    position: absolute; left: 50%; top: -18%; width: 78%; height: 92%;
    transform: translateX(-50%);
    background: linear-gradient(180deg, ${accent}66 0%, ${accent2}22 48%, transparent 78%);
    clip-path: polygon(36% 0, 64% 0, 100% 100%, 0 100%);
    filter: blur(26px);
    opacity: .8;
  }
  .ring {
    position: absolute; width: 58%; aspect-ratio: 1; right: -14%; top: 18%;
    border: 2px solid ${accent2}66; border-radius: 50%;
    box-shadow: 0 0 90px ${accent2}33 inset;
  }
  .frame {
    position: absolute; inset: ${Math.round(pad * 0.5)}px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: ${Math.round(pad * 0.28)}px;
  }
  .photo {
    position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
    filter: brightness(.58) saturate(1.08) contrast(1.04);
  }
  .photo-blur { filter: brightness(.38) saturate(1.1) blur(26px); transform: scale(1.12); }
  .photo-contain { object-fit: contain; filter: none; }
  .scrim {
    position: absolute; inset: 0;
    background:
      linear-gradient(180deg, rgba(2,4,10,.38) 0%, rgba(2,4,10,.06) 36%, rgba(2,4,10,.22) 62%, rgba(2,4,10,.9) 100%),
      linear-gradient(90deg, rgba(2,4,10,.45) 0%, transparent 62%);
  }
  .content {
    position: absolute; z-index: 5; left: ${pad}px; right: ${pad}px; bottom: ${bottom}px;
    display: flex; flex-direction: column; gap: ${Math.round(h1 * 0.22)}px;
  }
  .content.no-text { display: none; }
  .kicker {
    display: inline-flex; align-items: center; gap: ${Math.round(kicker * 0.5)}px;
    font-size: ${kicker}px; letter-spacing: .22em; text-transform: uppercase; font-weight: 700;
    color: ${accent2};
  }
  .kicker::before {
    content: ""; width: ${Math.round(kicker * 2.6)}px; height: 3px; background: ${accent2};
    box-shadow: 0 0 18px ${accent2};
  }
  h1 {
    margin: 0; font-size: ${h1}px; line-height: .98; letter-spacing: -.042em; font-weight: 800;
    max-height: ${maxHeadlineHeight}px; overflow: hidden; overflow-wrap: anywhere;
    text-wrap: balance;
    text-shadow: 0 12px 40px rgba(0,0,0,.45);
  }
  p {
    margin: 0; font-size: ${subtitle}px; line-height: 1.28; font-weight: 450;
    color: rgba(255,255,255,.82); max-width: 92%; overflow-wrap: anywhere;
    text-shadow: 0 6px 24px rgba(0,0,0,.5);
  }
  .footer {
    position: absolute; z-index: 6; top: ${pad}px; left: ${pad}px; right: ${pad}px;
    display: flex; align-items: center; justify-content: space-between; gap: ${pad}px;
    font-size: ${Math.round(kicker * 0.85)}px; letter-spacing: .18em; text-transform: uppercase;
    color: rgba(255,255,255,.62); font-weight: 600;
  }
  .track { flex: 1; height: 3px; background: rgba(255,255,255,.16); border-radius: 99px; overflow: hidden; }
  .track span { display: block; height: 100%; width: ${progress}%; background: linear-gradient(90deg, ${accent}, ${accent2}); }
  .counter { font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
</head>
<body>
  <div class="bg"></div>
  ${sceneDecor(scene.style, scene.palette)}
  ${photo}
  <div class="footer">
    <div>${escapeHtml(scene.kicker || plan.title).slice(0, 42)}</div>
    <div class="track"><span></span></div>
    <div class="counter">${String(scene.index + 1).padStart(2, "0")} / ${String(plan.scenes.length).padStart(2, "0")}</div>
  </div>
  <div class="content ${hasText ? "" : "no-text"}">
    ${scene.kicker ? `<div class="kicker">${escapeHtml(scene.kicker)}</div>` : ""}
    ${scene.headline ? `<h1>${escapeHtml(scene.headline)}</h1>` : ""}
    ${scene.subheadline ? `<p>${escapeHtml(scene.subheadline)}</p>` : ""}
  </div>
  <script>
    (function () {
      const h = document.querySelector("h1");
      if (h) {
        const max = innerHeight * ${plan.aspect === "9:16" ? "0.36" : "0.34"};
        let size = parseFloat(getComputedStyle(h).fontSize);
        while (h.getBoundingClientRect().height > max && size > 34) {
          size -= 3;
          h.style.fontSize = size + "px";
        }
      }
      const p = document.querySelector("p");
      if (p) {
        const max = innerHeight * 0.12;
        let size = parseFloat(getComputedStyle(p).fontSize);
        while (p.getBoundingClientRect().height > max && size > 20) {
          size -= 2;
          p.style.fontSize = size + "px";
        }
      }
    })();
  </script>
</body>
</html>`;
}

async function screenshot(htmlPath: string, pngPath: string, width: number, height: number): Promise<void> {
  const chromium = resolveChromium();
  await runChecked(
    chromium.command,
    [
      ...chromium.args,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--force-device-scale-factor=1",
      "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=2000",
      `--window-size=${width},${height}`,
      `--screenshot=${pngPath}`,
      htmlPath,
    ],
    { timeoutMs: 120_000, allowFailure: false },
  );
}

export interface RenderVisualOptions {
  plan: NormalizedPlan;
  workDir: string;
}

export async function renderSceneVisual(
  scene: NormalizedScene,
  options: RenderVisualOptions,
): Promise<SceneVisual> {
  const { plan, workDir } = options;
  const cacheDir = ensureDir(join(workDir, "cache"));
  const assetsDir = ensureDir(join(workDir, "assets"));
  const stem = `scene-${String(scene.index + 1).padStart(2, "0")}`;
  const htmlPath = join(cacheDir, `${stem}.html`);
  const pngPath = join(assetsDir, `${stem}.png`);

  let imageFile: string | null = null;
  let source: SceneVisual["source"] = "generated";
  if (scene.image) {
    const ext = extname(scene.image).toLowerCase() || ".png";
    const copyName = `${stem}-source${ext}`;
    copyFileSync(scene.image, join(cacheDir, copyName));
    imageFile = copyName;
    source = "user-image";
  }

  const html = buildSceneHtml(scene, plan, imageFile);
  writeFileSync(htmlPath, html, "utf8");

  try {
    await screenshot(htmlPath, pngPath, plan.width, plan.height);
  } catch (error) {
    throw new ContentAgentError(
      "VISUAL_RENDER_FAILED",
      `Could not rasterise scene ${scene.index + 1} with Chromium.`,
      `${(error as Error).message}\nHTML: ${htmlPath}`,
    );
  }

  const probe = await ffprobe(pngPath);
  const stream = probe.streams.find((item) => item.codec_type === "video" || item.width);
  if (!stream?.width || !stream.height) {
    throw new ContentAgentError(
      "INVALID_VISUAL",
      `Chromium did not produce a usable image for scene ${scene.index + 1}: ${pngPath}`,
    );
  }
  const pngBytes = readFileSync(pngPath).length;
  if (pngBytes < 5_000) {
    throw new ContentAgentError(
      "INVALID_VISUAL",
      `The rendered scene image is suspiciously small (${pngBytes} bytes): ${pngPath}`,
    );
  }

  return { index: scene.index, image: pngPath, source };
}
