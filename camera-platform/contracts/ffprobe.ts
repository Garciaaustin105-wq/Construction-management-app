/**
 * Parsing ffprobe output into measured stream facts.
 *
 * Pure, so it can be tested against recorded fixtures without ffmpeg installed.
 * The spawning lives in the agent; this is only the interpretation.
 *
 * THE IMPORTANT ONE: ffprobe frequently reports no `bit_rate` for an RTSP
 * source, because there is no container header to read it from. When that
 * happens this returns `bitrateKbps: null` — which makes `computeRetentionDays`
 * refuse, which is correct. The agent must then measure the bitrate by capturing
 * for a fixed interval and weighing the result. A camera's *configured* bitrate
 * is a setting; what it actually emits on a busy corridor is a measurement, and
 * only the measurement sizes a disk.
 */

import type { Codec } from "./segment.js";

export interface MeasuredStream {
  codec: Codec;
  width: number;
  height: number;
  fps: number | null;
  /** Null when ffprobe could not report it — the agent must measure. */
  bitrateKbps: number | null;
  /** Whether the source carries audio. Audio is legally gated, so the console
   *  must know it exists even when we do not record it. */
  hasAudio: boolean;
}

export type ProbeResult =
  | { kind: "ok"; stream: MeasuredStream }
  | { kind: "unusable"; reason: string };

/** ffprobe frame rates arrive as "20/1", sometimes "0/0" when unknown. */
export function parseFrameRate(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d+)\/(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (denominator === 0) return null;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/** ffprobe emits numbers as strings, and "N/A" for unknown. */
function parseNumeric(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "N/A") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function mapCodec(name: unknown): Codec | null {
  if (typeof name !== "string") return null;
  switch (name.toLowerCase()) {
    case "h264":
    case "avc":
      return "h264";
    case "hevc":
    case "h265":
      return "h265";
    default:
      return null;
  }
}

export function parseFfprobeJson(json: unknown): ProbeResult {
  if (typeof json !== "object" || json === null) {
    return { kind: "unusable", reason: "ffprobe produced no parseable JSON object" };
  }
  const root = json as Record<string, unknown>;
  const streams = root["streams"];
  if (!Array.isArray(streams) || streams.length === 0) {
    return { kind: "unusable", reason: "ffprobe reported no streams — the URL did not open" };
  }

  const entries = streams.filter(
    (s): s is Record<string, unknown> => typeof s === "object" && s !== null,
  );
  const video = entries.find((s) => s["codec_type"] === "video");
  if (video === undefined) {
    return { kind: "unusable", reason: "no video stream on this URL" };
  }

  const codec = mapCodec(video["codec_name"]);
  if (codec === null) {
    return {
      kind: "unusable",
      reason:
        `unsupported video codec ${JSON.stringify(video["codec_name"])} — ` +
        "only h264 and h265 can be stream-copied without transcoding",
    };
  }

  const width = parseNumeric(video["width"]);
  const height = parseNumeric(video["height"]);
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { kind: "unusable", reason: "ffprobe reported no usable frame dimensions" };
  }

  // Stream bit_rate first; fall back to the format-level figure. Both are
  // routinely absent for RTSP, and null is the honest answer when they are.
  const format =
    typeof root["format"] === "object" && root["format"] !== null
      ? (root["format"] as Record<string, unknown>)
      : {};
  const bitsPerSecond = parseNumeric(video["bit_rate"]) ?? parseNumeric(format["bit_rate"]);

  return {
    kind: "ok",
    stream: {
      codec,
      width,
      height,
      fps: parseFrameRate(video["avg_frame_rate"]) ?? parseFrameRate(video["r_frame_rate"]),
      bitrateKbps: bitsPerSecond === null ? null : Math.round(bitsPerSecond / 1000),
      hasAudio: entries.some((s) => s["codec_type"] === "audio"),
    },
  };
}

/**
 * Bitrate measured by capturing for a known interval — the figure that sizes a
 * disk. Refuses on a too-short sample: a two-second capture of a static
 * corridor reports a fraction of what the same camera emits when someone walks
 * through it.
 */
export function bitrateFromCapture(
  bytesWritten: number,
  seconds: number,
  minimumSeconds = 20,
): { kind: "ok"; bitrateKbps: number } | { kind: "refused"; reason: string } {
  if (!Number.isFinite(seconds) || seconds < minimumSeconds) {
    return {
      kind: "refused",
      reason:
        `sampled only ${seconds}s; at least ${minimumSeconds}s is needed before a ` +
        "variable-bitrate camera's output means anything",
    };
  }
  if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) {
    return { kind: "refused", reason: "capture wrote no bytes — the stream did not open" };
  }
  return { kind: "ok", bitrateKbps: Math.round((bytesWritten * 8) / seconds / 1000) };
}
