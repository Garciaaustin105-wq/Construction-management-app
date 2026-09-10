/**
 * RTSP URL templating.
 *
 * WHY templates rather than ONVIF discovery as the primary path: Hikvision has
 * shipped with ONVIF disabled by default since firmware v5.5.0, and enabling it
 * means creating a dedicated ONVIF user in each camera's web interface. Across
 * thousands of cameras that is a per-device touch. RTSP needs no ONVIF, and the
 * URL patterns are stable and documented — so templating is the onboarding path
 * and ONVIF is a convenience for cameras that already have it on.
 */

import type { Vendor } from "./camera.js";

export type StreamKind = "main" | "sub";

export interface RtspCredentials {
  username: string;
  password: string;
}

export interface RtspTarget {
  vendor: Vendor;
  ip: string;
  /** 1-based camera channel. Standalone cameras are channel 1. */
  channel: number;
  stream: StreamKind;
  port?: number;
}

export class RtspTemplateError extends Error {}

const DEFAULT_RTSP_PORT = 554;

/**
 * Path builders per vendor. Returning null means "we do not have a documented
 * pattern for this vendor" — the caller must fall back to ONVIF or ask a human,
 * rather than receive a plausible-looking guess that fails at 3am.
 */
const PATHS: Record<Vendor, (channel: number, stream: StreamKind) => string | null> = {
  // /Streaming/Channels/CCS — CC = channel, S = stream (1 main, 2 sub).
  // Channel 1 main is 101, channel 1 sub is 102, channel 2 is 201/202.
  hikvision: (channel, stream) =>
    `/Streaming/Channels/${channel}${stream === "main" ? "01" : "02"}`,
  axis: (channel, stream) =>
    `/axis-media/media.amp?camera=${channel}${stream === "sub" ? "&resolution=640x360" : ""}`,
  hanwha: (channel, stream) =>
    `/profile${stream === "main" ? "1" : "2"}/media.smp?channel=${channel}`,
  avigilon: (channel, stream) =>
    `/media/video${channel}${stream === "sub" ? "?stream=secondary" : ""}`,
  generic: () => null,
};

function assertChannel(channel: number): void {
  if (!Number.isInteger(channel) || channel < 1 || channel > 99) {
    throw new RtspTemplateError(
      `channel must be an integer in 1..99, got ${channel}; ` +
        "the Hikvision CCS encoding has no room for more",
    );
  }
}

export type RtspUrlResult =
  | { kind: "ok"; url: string; redacted: string }
  | { kind: "unsupported"; vendor: Vendor; message: string };

/**
 * Build a playable RTSP URL, plus a credential-free form for logs.
 *
 * WHY both: credentials in an RTSP URL are normal and unavoidable, and a URL
 * logged verbatim leaks a camera password into CloudWatch forever. Callers log
 * `redacted` and pass `url` only to the media stack.
 */
export function buildRtspUrl(
  target: RtspTarget,
  credentials: RtspCredentials,
): RtspUrlResult {
  assertChannel(target.channel);

  if (!target.ip || typeof target.ip !== "string") {
    throw new RtspTemplateError(`ip must be a non-empty string, got ${JSON.stringify(target.ip)}`);
  }
  if (!credentials.username) {
    throw new RtspTemplateError("username is required; anonymous RTSP is not a supported path");
  }

  const path = PATHS[target.vendor](target.channel, target.stream);
  if (path === null) {
    return {
      kind: "unsupported",
      vendor: target.vendor,
      message:
        `no documented RTSP path for vendor "${target.vendor}" — ` +
        "use ONVIF discovery or enter the URL manually rather than guessing",
    };
  }

  const port = target.port ?? DEFAULT_RTSP_PORT;
  const user = encodeURIComponent(credentials.username);
  const pass = encodeURIComponent(credentials.password);
  const authority = `${target.ip}:${port}`;

  return {
    kind: "ok",
    url: `rtsp://${user}:${pass}@${authority}${path}`,
    redacted: `rtsp://${user}:***@${authority}${path}`,
  };
}

/** Strip credentials from any RTSP URL before it reaches a log or the console. */
export function redactRtspUrl(url: string): string {
  return url.replace(/^(rtsps?:\/\/)([^:/@]+):([^@]*)@/i, "$1$2:***@");
}

/** Candidate URLs to try, in order, when adopting an unknown camera. */
export function candidateUrls(
  ip: string,
  vendor: Vendor,
  credentials: RtspCredentials,
): { main: RtspUrlResult; sub: RtspUrlResult } {
  return {
    main: buildRtspUrl({ vendor, ip, channel: 1, stream: "main" }, credentials),
    sub: buildRtspUrl({ vendor, ip, channel: 1, stream: "sub" }, credentials),
  };
}
