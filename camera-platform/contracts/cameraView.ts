/**
 * What `GET /cameras` says about a camera — and, more to the point, what it
 * never says.
 *
 * The config holds stream URLs that routinely carry the camera's password
 * (`rtsp://admin:hunter2@10.0.0.5/...`), and some vendors put it in the path
 * instead (`/user=admin&password=hunter2&channel=1`). A camera list is the
 * first thing a client fetches and the most likely to be pasted into a ticket.
 * So the view is built from named fields only: no URL, no path, no username, no
 * password, and an unresolved reason scrubbed of anything the URL carried.
 */

import { parseRtspUrl } from "./cameraSource.js";
import type { Vendor } from "./camera.js";

/** One entry of config.json's `cameras`, as agent/recorder-service.mjs reads it. */
export interface CameraConfigEntry {
  cameraId: string;
  name?: string | null;
  url?: string | null;
  host?: string | null;
  vendor?: Vendor | null;
  channel?: number | null;
  bitrateKbps?: number | null;
}

/** resolveCameraUrl's result. `url` carries credentials and must not reach the view. */
export type CameraResolution =
  | { kind: "ok"; origin: "manual_url" | "discovered"; url: string }
  | { kind: "unresolved"; reason: string };

export interface CameraView {
  cameraId: string;
  name: string | null;
  vendor: Vendor | null;
  /** From the configured url's host when there is a url, else the configured host. */
  host: string | null;
  /** From the configured url; null for a host-configured camera, meaning the vendor default. */
  port: number | null;
  channel: number | null;
  /** How the stream URL was arrived at; null when it was not. */
  origin: "manual_url" | "discovered" | null;
  resolved: boolean;
  unresolvedReason: string | null;
  bitrateKbps: number | null;
}

/**
 * Build the public view of one configured camera.
 *
 * - name, vendor, channel, bitrateKbps: copied when present, else null. Never
 *   defaulted — a blank channel is not channel 1 and a blank bitrate is not 0.
 * - host and port: when `camera.url` is a non-blank string, from
 *   parseRtspUrl(camera.url) (whose port is 554 when the url states none); both
 *   null if it does not parse. Otherwise host is `camera.host` (null if blank)
 *   and port is null. Never derived from `resolution.url`.
 * - origin and resolved: from `resolution`; origin is null when unresolved.
 * - unresolvedReason: null when resolved. Otherwise the reason, with every
 *   occurrence of the configured url, then of the url's password as
 *   parseRtspUrl returns it, then of encodeURIComponent of that password,
 *   replaced by "***" — in that order, so an echoed url goes whole rather than
 *   leaving its username behind. Plain string replacement, not a RegExp built
 *   from the password: passwords contain `$`, `.` and `*`.
 *   A password shorter than 3 characters is not scrubbed as a substring (it
 *   would mangle ordinary words); the url itself still is.
 */
export function cameraView(camera: CameraConfigEntry, resolution: CameraResolution): CameraView {
  const name = camera.name ?? null;
  const vendor = camera.vendor ?? null;
  const channel = camera.channel ?? null;
  const bitrateKbps = camera.bitrateKbps ?? null;

  // The configured url is the only place host and port come from when there is
  // one — an unparseable url is a camera we cannot describe, not a reason to
  // fall back to `host` and report a pairing the recorder will never use.
  const url = typeof camera.url === "string" && camera.url.trim() !== "" ? camera.url : null;
  let host: string | null = null;
  let port: number | null = null;
  let password: string | null = null;
  if (url !== null) {
    const parsed = parseRtspUrl(url);
    if (parsed.kind === "ok") {
      host = parsed.host;
      port = parsed.port;
      password = parsed.password;
    }
  } else if (typeof camera.host === "string" && camera.host.trim() !== "") {
    host = camera.host;
  }

  let unresolvedReason: string | null = null;
  if (resolution.kind === "unresolved") {
    let reason = resolution.reason;
    // split/join, not RegExp: a password may contain $, . and *.
    if (url !== null) reason = reason.split(url).join("***");
    if (password !== null && password.length >= 3) {
      reason = reason.split(password).join("***");
      reason = reason.split(encodeURIComponent(password)).join("***");
    }
    unresolvedReason = reason;
  }

  return {
    cameraId: camera.cameraId,
    name,
    vendor,
    host,
    port,
    channel,
    origin: resolution.kind === "ok" ? resolution.origin : null,
    resolved: resolution.kind === "ok",
    unresolvedReason,
    bitrateKbps,
  };
}
