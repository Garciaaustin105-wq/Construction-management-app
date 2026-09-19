import type { CameraResolution } from "./cameraView.js";

/**
 * The quality of a live stream.
 */
export type LiveQuality = "mainstream" | "substream";

/**
 * Reasons why a live negotiation can be refused.
 */
export type LiveRefusalReason =
  | "unknown_camera" // cameraId not in config
  | "unresolved_camera" // resolveCameraUrl returned {kind:"unresolved"}
  | "substream_unavailable" // no manual substreamUrl, and the vendor has no derivation
  | "camera_busy" // per-camera concurrent-live cap already held
  | "stream_limit" // appliance-wide concurrent-live cap held
  | "viewer_limit"; // appliance-wide viewer concurrency cap held

/**
 * Result of a live negotiation.
 */
export type LiveNegotiation =
  | { kind: "ok"; cameraId: string; quality: LiveQuality; mode: "ws-fmp4"; streamId: string; shared: boolean }
  | { kind: "refused"; reason: LiveRefusalReason; detail: string };

/**
 * Negotiates a live stream request.
 *
 * The decision order is load-bearing; the first matching rule is returned.
 * Refusal details are short human sentences and never contain URLs or
 * credentials.
 *
 * @param input - Negotiation parameters
 * @returns LiveNegotiation
 */
export function negotiateLive(input: {
  cameraId: string; // the id the CALLER resolved; echoed verbatim on ok
  cameraExists: boolean; // the CALLER does the config lookup; this contract never searches
  quality: LiveQuality; // the CALLER validates the query string; this contract
  // assumes a valid quality and never parses one
  resolution: CameraResolution; // from resolveCameraUrl — unresolved -> refused
  substreamUrl: string | null; // manual override from config, verbatim when present
  vendorDerivesSubstream: boolean; // true only for vendors with a known substream path rule
  sourceRunning: boolean; // a source for this camera+quality already runs
  sourcesForCamera: number; // sources already running for this camera
  sourcesTotal: number; // sources already running appliance-wide
  viewersTotal: number; // live viewers already connected appliance-wide
  maxSourcesPerCamera: number; // default 2
  maxSources: number; // default 32
  maxViewers: number; // default 128
  streamId: string; // caller-generated (crypto.randomUUID), echoed when ok
}): LiveNegotiation {
  const {
    cameraId,
    cameraExists,
    quality,
    resolution,
    substreamUrl,
    vendorDerivesSubstream,
    sourceRunning,
    sourcesForCamera,
    sourcesTotal,
    viewersTotal,
    maxSourcesPerCamera,
    maxSources,
    maxViewers,
    streamId,
  } = input;

  // 1. Unknown camera
  if (!cameraExists) {
    return {
      kind: "refused",
      reason: "unknown_camera",
      detail: "no camera with that id in this site's config",
    };
  }

  // 2. Unresolved camera URL
  if (resolution.kind === "unresolved") {
    return {
      kind: "refused",
      reason: "unresolved_camera",
      detail: "camera URL could not be resolved",
    };
  }

  // 3. Substream unavailable
  if (quality === "substream" && substreamUrl === null && !vendorDerivesSubstream) {
    return {
      kind: "refused",
      reason: "substream_unavailable",
      detail: "substream not available for this camera",
    };
  }

  // 4. Camera busy — only when a new source is needed (sourceRunning is false)
  if (!sourceRunning && sourcesForCamera >= maxSourcesPerCamera) {
    return {
      kind: "refused",
      reason: "camera_busy",
      detail: "camera is already at its maximum concurrent live streams",
    };
  }

  // 5. Stream limit reached — only when a new source is needed
  if (!sourceRunning && sourcesTotal >= maxSources) {
    return {
      kind: "refused",
      reason: "stream_limit",
      detail: "maximum concurrent live streams reached",
    };
  }

  // 6. Viewer limit — applies to both new and shared sources
  if (viewersTotal >= maxViewers) {
    return {
      kind: "refused",
      reason: "viewer_limit",
      detail: "maximum live viewers reached",
    };
  }

  // 7. All checks passed
  return {
    kind: "ok",
    cameraId,
    quality,
    mode: "ws-fmp4",
    streamId,
    shared: sourceRunning,
  };
}

/**
 * Returns the ffmpeg command arguments for live muxing.
 *
 * The returned array contains the arguments *after* the URL; the caller
 * prepends `"ffmpeg"`. The command uses `-c copy` only.
 *
 * `-probesize`/`-analyzeduration` are capped because the default probe samples
 * up to five seconds of input before muxing, and a copy mux has nothing to
 * analyze beyond the H.264 parameter sets that arrive in the first packets —
 * the camera-side keyframe interval bounds the rest. Measured on the bench
 * 2026-09-13: live time-to-first-frame 1.65–2.0 s uncapped, 1.2 s capped.
 *
 * `+default_base_moof` is load-bearing for MSE: without it ffmpeg writes each
 * tfhd with an absolute base_data_offset, which the MSE ISOBMFF byte stream
 * spec FORBIDS (movie-fragment-relative addressing). Chrome reproduces this
 * as the first moof+mdat append failing with `Failure parsing MP4: TFHD
 * base-data-offset not allowed by MSE` -> decode error -> every later append
 * throwing InvalidStateError. Found on the bench 2026-09-14.
 *
 * @param url - The RTSP or other stream URL
 * @returns string[] - ffmpeg ARGV
 */
export function liveFfmpegArgs(url: string): string[] {
  return [
    "-rtsp_transport",
    "tcp",
    // Socket I/O timeout, microseconds: the recorder's value (agent/recorder.mjs
    // RTSP_TIMEOUT_US; the harness keeps them equal). Without it an ffmpeg
    // reading a camera that has gone away blocks for good, and ffmpeg honours
    // SIGTERM only between reads: bench 2026-09-19 left 4 such orphans, each
    // holding a camera session, after one unplug.
    "-timeout",
    "10000000",
    "-probesize",
    "500000",
    "-analyzeduration",
    "500000",
    "-i",
    url,
    // Video is still never transcoded. Audio must be, because a camera speaks
    // G.711/G.726 and the mp4 muxer will not carry those -- ffmpeg fails the
    // whole mux, so a copied microphone takes the picture down with it.
    // AAC at 32k is voice-grade and costs a fraction of a video transcode.
    // The trailing ? on the audio map keeps mic-less cameras working.
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "32k",
    "-f",
    "mp4",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-fflags",
    "+nobuffer",
    "-flags",
    "low_delay",
    "pipe:1",
  ];
}