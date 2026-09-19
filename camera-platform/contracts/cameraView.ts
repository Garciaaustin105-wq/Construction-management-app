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
  /**
   * Which channel of the device at `host` this stream carries; used to tell
   * apart cameras that share one address; null when it cannot be told, never guessed.
   */
  sourceChannel: number | null;
  /** How the stream URL was arrived at; null when it was not. */
  origin: "manual_url" | "discovered" | null;
  resolved: boolean;
  unresolvedReason: string | null;
  /** What the camera was ASKED for, from config. A request, not an observation. */
  bitrateKbps: number | null;
  /**
   * What the camera actually sent, measured from its sealed segments. Null
   * means not measured yet — never the configured figure wearing a different
   * name. Kept as its own field on purpose: a camera quietly ignoring its
   * bitrate cap is the commonest reason a store fills early, and that is only
   * visible while the two numbers can still disagree on screen.
   */
  measuredKbps: number | null;
}

/** A channel the recorder accepts: rtsp.ts assertChannel, 1..99. */
function isRecorderChannel(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 99;
}

/**
 * Where each vendor's stream path says which channel it is -- the same paths
 * rtsp.ts candidatePaths builds. First match wins, and a match that names no
 * real channel is null rather than a reason to try the next pattern.
 */
const CHANNEL_IN_PATH: readonly { pattern: RegExp; channelOf: (n: number) => number }[] = [
  { pattern: /\/(?:ISAPI\/)?Streaming\/Channels\/(\d+)/i, channelOf: (n) => Math.floor(n / 100) }, // hikvision: 201 = ch 2 main
  { pattern: /\/h264\/ch(\d+)\//i, channelOf: (n) => n }, // older hikvision firmware
  { pattern: /[?&]channel=(\d+)/i, channelOf: (n) => n }, // dahua realmonitor
  { pattern: /[?&]camera=(\d+)/i, channelOf: (n) => n }, // axis media.amp
  { pattern: /\/media\/video(\d+)/i, channelOf: (n) => n }, // avigilon
];

function channelFromPath(path: string): number | null {
  for (const { pattern, channelOf } of CHANNEL_IN_PATH) {
    const match = pattern.exec(path);
    if (match === null) continue;
    const ch = channelOf(Number(match[1]));
    return isRecorderChannel(ch) ? ch : null;
  }
  return null;
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
 * - sourceChannel: which channel of the device at `host` this stream carries,
 *   used to tell apart cameras that share one address:
 *   a) if camera.channel is an integer in 1..99: that value;
 *   b) else if there is a configured url whose path matches a known pattern:
 *      the channel number from the path; if the vendor path is recognized,
 *      use it even if the pattern doesn't find a valid channel (null, never 1);
 *   c) else if there is no url and host is non-null: 1 — standalone cameras
 *      are channel 1, and that is what the recorder opens;
 *   d) else: null. Never guessed.
 * - origin and resolved: from `resolution`; origin is null when unresolved.
 * - unresolvedReason: null when resolved. Otherwise the reason, with every
 *   occurrence of the configured url, then of the url's password as
 *   parseRtspUrl returns it, then of encodeURIComponent of that password,
 *   replaced by "***" — in that order, so an echoed url goes whole rather than
 *   leaving its username behind. Plain string replacement, not a RegExp built
 *   from the password: passwords contain `$`, `.` and `*`.
 *   A password shorter than 3 characters is not scrubbed as a substring (it
 *   would mangle ordinary words); the url itself still is.
 * - measuredKbps: the caller's measurement, passed straight through, defaulting
 *   to null. It is never read from `camera`: config holds what was asked for,
 *   and blending a measurement with a request is how a store ends up full three
 *   weeks before the number on the screen says it should (build rule 17).
 */
export function cameraView(
  camera: CameraConfigEntry,
  resolution: CameraResolution,
  measuredKbps: number | null = null,
): CameraView {
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
  // Everything after host[:port], query included; parseRtspUrl has already
  // split the credentials off. Only a number is ever read out of it.
  let path: string | null = null;
  if (url !== null) {
    const parsed = parseRtspUrl(url);
    if (parsed.kind === "ok") {
      host = parsed.host;
      port = parsed.port;
      password = parsed.password;
      path = parsed.path;
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

  // Compute sourceChannel: which channel of the device at `host` this stream
  // carries. Used to tell apart cameras that share one address.
  // Which channel of the device at `host` this stream is. A configured channel
  // is the answer even when it is invalid: that is a config error to show, not
  // a gap for the path to paper over.
  let sourceChannel: number | null = null;
  if (channel !== null) {
    sourceChannel = isRecorderChannel(channel) ? channel : null;
  } else if (url !== null) {
    sourceChannel = path === null ? null : channelFromPath(path);
  } else if (host !== null) {
    sourceChannel = 1; // rtsp.ts: standalone cameras are channel 1, and that is what the recorder opens
  }

  return {
    cameraId: camera.cameraId,
    name,
    vendor,
    host,
    port,
    channel,
    sourceChannel,
    origin: resolution.kind === "ok" ? resolution.origin : null,
    resolved: resolution.kind === "ok",
    unresolvedReason,
    bitrateKbps,
    measuredKbps,
  };
}
