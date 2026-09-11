/**
 * How a camera's stream URL was arrived at.
 *
 * **A human must always be able to type a camera in by hand and have it work.**
 * Discovery is a convenience that usually saves time; it is never the only path.
 *
 * This is a scar from watching a competitor get it wrong. Spot.ai auto-connects
 * cameras and offers no manual route, so the day discovery fails — an unusual
 * firmware, a non-standard port, a camera behind a router, a model whose path
 * nobody has seen before — the installer is simply stuck, standing at a site
 * with a working camera and no way to add it.
 *
 * So every automatic mechanism here has a manual override, and the manual path
 * is not a hidden "advanced" escape hatch: it is a first-class way to add a
 * camera, tested exactly as hard as the automatic one.
 */

import type { Vendor } from "./camera.js";
import type { StreamKind } from "./rtsp.js";

export type SourceOrigin =
  /** Discovery found it and a vendor template supplied the path. */
  | "discovered"
  /** A human typed the whole URL. Always permitted, never second-class. */
  | "manual_url"
  /** A human gave the parts — host, port, path, credentials. */
  | "manual_parts"
  /** Discovered, then a human corrected something the template got wrong. */
  | "overridden";

export interface CameraSource {
  cameraId: string;
  origin: SourceOrigin;
  host: string;
  port: number;
  path: string;
  vendor: Vendor;
  stream: StreamKind;
  /** Set when a human overrode a template, so the console can show what changed. */
  overrodeTemplatePath?: string;
}

export class CameraSourceError extends Error {}

export type ParsedRtsp =
  | {
      kind: "ok";
      host: string;
      port: number;
      path: string;
      username: string | null;
      /** Present only if the URL carried one. Never logged. */
      password: string | null;
    }
  | { kind: "invalid"; reason: string };

/**
 * Parse a pasted RTSP URL.
 *
 * Deliberately permissive about what it accepts and precise about what it
 * rejects: an installer pasting a URL from a camera's own web interface should
 * not have to care about our opinions, but should get a clear reason when the
 * thing genuinely cannot work.
 */
export function parseRtspUrl(raw: string): ParsedRtsp {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { kind: "invalid", reason: "empty" };
  }
  const trimmed = raw.trim();

  // Parsed by hand rather than with `URL`, which is a runtime global this module
  // deliberately cannot see — the contracts compile with `"types": []` so that
  // reaching for a host API breaks the build rather than the purity guarantee.
  //   rtsp://[user[:pass]@]host[:port][/path][?query]
  const match =
    /^(rtsps?):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/?#]+)(?::(\d+))?([^?#]*)(\?[^#]*)?/i.exec(trimmed);
  if (match === null) {
    // Distinguish the two failures, because they need different fixes: a wrong
    // scheme is usually someone pasting the camera's web page instead of its
    // stream, and saying so is faster than letting them wonder.
    return /^rtsps?:\/\//i.test(trimmed)
      ? { kind: "invalid", reason: "could not parse host and path" }
      : { kind: "invalid", reason: "must begin rtsp:// or rtsps:// — this looks like a web address, not a stream" };
  }

  const rawUser = match[2];
  const rawPass = match[3];
  const host = match[4];
  const rawPort = match[5];
  const rawPath = match[6];
  const rawQuery = match[7];

  if (host === undefined || host === "") {
    return { kind: "invalid", reason: "no host" };
  }

  const port = rawPort === undefined || rawPort === "" ? 554 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { kind: "invalid", reason: `port out of range: ${rawPort}` };
  }

  // A bare host with no path is usually a mistake, but some cameras do serve a
  // default stream at "/". Accept it and let the probe judge — refusing here
  // would be us deciding we know the camera better than the installer standing
  // in front of it.
  const path = (rawPath === undefined || rawPath === "" ? "/" : rawPath) + (rawQuery ?? "");

  const decode = (value: string | undefined): string | null => {
    if (value === undefined || value === "") return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;   // a stray % is the installer's, not ours to reject
    }
  };

  return { kind: "ok", host, port, path, username: decode(rawUser), password: decode(rawPass) };
}

/** A camera added by hand. Never rejected for failing to match a known vendor. */
export function manualSource(
  cameraId: string,
  parsed: Extract<ParsedRtsp, { kind: "ok" }>,
  stream: StreamKind = "main",
): CameraSource {
  return {
    cameraId,
    origin: "manual_url",
    host: parsed.host,
    port: parsed.port,
    path: parsed.path,
    vendor: "generic",
    stream,
  };
}

/**
 * Record that a human corrected a discovered camera.
 *
 * Keeping the template's original path matters: when three sites all override
 * the same vendor the same way, that is the candidate list being wrong, and
 * somebody should fix it centrally rather than every installer fixing it again.
 */
export function overrideSource(
  discovered: CameraSource,
  newPath: string,
): CameraSource {
  if (newPath.trim() === "") {
    throw new CameraSourceError("an override path cannot be empty");
  }
  return {
    ...discovered,
    origin: "overridden",
    path: newPath,
    overrodeTemplatePath: discovered.path,
  };
}

/** True when nothing automatic was trusted — used to flag sites worth a look. */
export function wasManual(source: CameraSource): boolean {
  return source.origin === "manual_url" || source.origin === "manual_parts" || source.origin === "overridden";
}
