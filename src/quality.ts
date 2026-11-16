/**
 * Output validation. A render is only reported as successful when the file
 * contains a real video stream, the expected audio stream, the requested size,
 * and decodes without errors.
 */

import { mediaDurationSeconds, ffprobe } from "./media-tools.ts";
import { decodeCheck } from "./video-renderer.ts";
import { ContentAgentError } from "./types.ts";
import type { NormalizedPlan } from "./video-types.ts";

export interface QualityReport {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  decodeWarnings: string[];
}

export async function validateOutput(
  path: string,
  plan: NormalizedPlan,
  expectAudio: boolean,
): Promise<QualityReport> {
  const probe = await ffprobe(path);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const duration = mediaDurationSeconds(probe);

  if (!video) {
    throw new ContentAgentError("QUALITY_CHECK_FAILED", `No video stream in ${path}.`);
  }
  if (expectAudio && !audio) {
    throw new ContentAgentError(
      "QUALITY_CHECK_FAILED",
      "The render has no audio stream although narration/music was requested.",
    );
  }
  if (!expectAudio && audio) {
    throw new ContentAgentError(
      "QUALITY_CHECK_FAILED",
      "A silent video was requested, but the output contains an audio stream.",
    );
  }
  if (duration < 0.9) {
    throw new ContentAgentError(
      "QUALITY_CHECK_FAILED",
      `The output is too short to be usable (${duration.toFixed(2)}s).`,
    );
  }
  if (video.width !== plan.width || video.height !== plan.height) {
    throw new ContentAgentError(
      "QUALITY_CHECK_FAILED",
      `Expected ${plan.width}x${plan.height}, received ${video.width}x${video.height}.`,
    );
  }

  const decodeWarnings = await decodeCheck(path);
  return {
    durationSeconds: duration,
    width: video.width ?? plan.width,
    height: video.height ?? plan.height,
    videoCodec: video.codec_name ?? "unknown",
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    decodeWarnings,
  };
}
