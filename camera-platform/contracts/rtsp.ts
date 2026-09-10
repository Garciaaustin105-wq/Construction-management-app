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

export interface PathCandidate {
  path: string;
  /** True when the vendor documents this path; false when it is a convention. */
  documented: boolean;
  note: string;
}

/**
 * Ordered paths to TRY for a vendor, most likely first. **The single source of
 * truth for stream paths** — `buildRtspUrl` returns the first entry.
 *
 * WHY a list rather than one template: some vendors document that the path
 * differs between models — AVYCON says so explicitly. A lone template would be
 * a guess dressed as a fact. Trying an ordered list and recording which one
 * streamed turns that guess into a measurement.
 *
 * WHY it is the only list: a separate per-vendor template table existed here
 * briefly, and the Axis sub-stream path drifted out of step with this one
 * within an hour. A harness caught it. Two sources of truth for the same fact
 * is how that happens, so now there is one.
 *
 * Entries with `documented: false` are conventions, not promises, and
 * `buildRtspUrl` refuses to return one as though it were the answer.
 */
export function candidatePaths(vendor: Vendor, stream: StreamKind, channel = 1): PathCandidate[] {
  const sub = stream === "sub";
  switch (vendor) {
    case "hikvision":
      return [
        { path: `/Streaming/Channels/${channel}${sub ? "02" : "01"}`, documented: true, note: "Hikvision CCS encoding" },
        { path: `/h264/ch${channel}/${sub ? "sub" : "main"}/av_stream`, documented: false, note: "older Hikvision firmware" },
      ];
    case "avycon":
      return [
        { path: `/profile${sub ? "2" : "1"}`, documented: true, note: "AVYCON documented pattern" },
        { path: `/profile${sub ? "3" : "2"}`, documented: false, note: "some models number profiles from 2" },
        { path: `/live/ch${sub ? "1" : "0"}`, documented: false, note: "common ODM convention" },
        { path: `/ch0${sub ? "_1" : "_0"}.h264`, documented: false, note: "common ODM convention" },
      ];
    case "axis":
      return [{
        path: `/axis-media/media.amp?camera=${channel}${sub ? "&resolution=640x360" : ""}`,
        documented: true,
        note: "Axis VAPIX",
      }];
    case "hanwha":
      return [{ path: `/profile${sub ? "2" : "1"}/media.smp`, documented: true, note: "Hanwha SUNAPI" }];
    case "avigilon":
      return [{
        path: `/media/video${channel}${sub ? "?stream=secondary" : ""}`,
        documented: true,
        note: "Avigilon",
      }];
    case "generic":
      return [
        { path: "/profile1", documented: false, note: "trial" },
        { path: "/live/ch0", documented: false, note: "trial" },
        { path: "/stream1", documented: false, note: "trial" },
        { path: "/video1", documented: false, note: "trial" },
        { path: "/11", documented: false, note: "trial" },
        { path: "/cam/realmonitor?channel=1&subtype=0", documented: false, note: "trial" },
      ];
  }
}

/** Assemble a URL for a specific path: a playable form and a redacted form. */
export function urlForPath(
  ip: string,
  path: string,
  credentials: RtspCredentials,
  port = DEFAULT_RTSP_PORT,
): { url: string; redacted: string } {
  const user = encodeURIComponent(credentials.username);
  const pass = encodeURIComponent(credentials.password);
  const authority = `${ip}:${port}`;
  return {
    url: `rtsp://${user}:${pass}@${authority}${path}`,
    redacted: `rtsp://${user}:***@${authority}${path}`,
  };
}

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

  const [first] = candidatePaths(target.vendor, target.stream, target.channel);
  if (first === undefined || !first.documented) {
    return {
      kind: "unsupported",
      vendor: target.vendor,
      message:
        `no documented RTSP path for vendor "${target.vendor}" — ` +
        "probe candidatePaths() and record what streamed, rather than guessing",
    };
  }

  const { url, redacted } = urlForPath(
    target.ip,
    first.path,
    credentials,
    target.port ?? DEFAULT_RTSP_PORT,
  );
  return { kind: "ok", url, redacted };
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
