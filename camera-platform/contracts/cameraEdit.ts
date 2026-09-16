/**
 * Adding, editing and removing cameras from the Cameras page (installer only,
 * `camera.manage`). Pure: the API reads and writes the file, this decides.
 *
 * Where the edits live: `cameras.json` in the state dir, owned by the service
 * user. `config.json` stays root-owned and keeps the site, the drives and
 * retention; when `cameras.json` exists and parses, its cameras (and its
 * camera login, when it has one) replace config.json's. A broken
 * `cameras.json` is refused whole, never half-read.
 *
 * THE FEARED FAILURES:
 * - a camera password leaking back out: into GET, the audit log, or a stream
 *   address typed on the page (passwords go in the camera login, one place);
 * - the last camera removed, which leaves a recorder that refuses to start;
 * - two entries recording the same stream, doubling the disk it eats;
 * - a blank channel or stream quietly becoming channel 1 / main (rule 5);
 * - an edit dropping a setting the page does not show (e.g. `audio`).
 */

import { parseRtspUrl } from "./cameraSource.js";
import type { Vendor } from "./camera.js";
import type { StreamKind } from "./rtsp.js";

export const VENDORS: readonly Vendor[] = Object.freeze(["hikvision", "axis", "hanwha", "avigilon", "avycon", "generic"]);
export const MAX_CAMERAS = 64;
const MANAGED_KEYS = ["cameraId", "name", "host", "url", "vendor", "channel", "stream", "bitrateKbps"] as const;

/** One camera as stored. Keys the page does not manage are kept as they were. */
export interface EditableCamera {
  cameraId: string;
  name?: string | null;
  host?: string;
  url?: string;
  vendor?: Vendor;
  channel?: number;
  stream?: StreamKind;
  bitrateKbps?: number;
  [other: string]: unknown;
}

export interface CameraLogin {
  username: string;
  password: string;
}

export type EditRefusal = { ok: false; reason: string; field: string | null };
export type CameraCheck = { ok: true; camera: EditableCamera } | EditRefusal;
export type CamerasResult = { ok: true; cameras: EditableCamera[] } | EditRefusal;

const refuse = (reason: string, field: string | null = null): EditRefusal => ({ ok: false, reason, field });
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const CAMERA_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function validHost(host: string): boolean {
  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split(".");
    return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
  }
  return HOSTNAME.test(host);
}

/** Which physical stream an entry records, for spotting duplicates. */
function streamKey(c: EditableCamera): string {
  if (typeof c.url === "string") return "url:" + c.url;
  return `host:${String(c.host).toLowerCase()}|${String(c.channel)}|${String(c.stream ?? "main")}`;
}

/**
 * Validate one camera from the page. `others` are the cameras it must not
 * collide with (for an edit: every camera except the one being edited).
 *
 * Refusals, in this order (field in brackets):
 *  not_an_object; bad_camera_id [cameraId]; camera_id_taken [cameraId];
 *  bad_name [name] (a string of at most 60 characters without control
 *  characters, or null/absent; trimmed; blank becomes null);
 *  need_host_or_url [host]; both_host_and_url [url];
 *  with a url: bad_url [url] (parseRtspUrl), url_has_login [url] (a user or
 *  password in the address: it belongs in the camera login);
 *  with a host: bad_host [host], bad_vendor [vendor], generic_needs_url [url]
 *  (a generic brand has no documented path, so it records nothing by host),
 *  bad_channel [channel]
 *  (integer 1..256), bad_stream [stream] ("main" or "sub") — all required, no
 *  defaults;
 *  bad_bitrate [bitrateKbps] (absent/null, or an integer 64..20000);
 *  duplicate_stream [host or url]; too_many_cameras.
 * Accepted: a NEW object, managed keys in the order cameraId, name, then url
 * or host, vendor, channel, stream, then bitrateKbps when given.
 */
export function checkCamera(raw: unknown, others: readonly EditableCamera[]): CameraCheck {
  if (!isObject(raw)) return refuse("not_an_object");
  const id = raw.cameraId;
  if (typeof id !== "string" || !CAMERA_ID.test(id)) return refuse("bad_camera_id", "cameraId");
  if (others.some((c) => c.cameraId === id)) return refuse("camera_id_taken", "cameraId");

  let name: string | null = null;
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== "string" || CONTROL.test(raw.name) || raw.name.trim().length > 60) return refuse("bad_name", "name");
    name = raw.name.trim() === "" ? null : raw.name.trim();
  }

  const hasUrl = typeof raw.url === "string" && raw.url.trim() !== "";
  const hasHost = typeof raw.host === "string" && raw.host.trim() !== "";
  if (!hasUrl && !hasHost) return refuse("need_host_or_url", "host");
  if (hasUrl && hasHost) return refuse("both_host_and_url", "url");

  const camera: EditableCamera = { cameraId: id, name };
  if (hasUrl) {
    const url = (raw.url as string).trim();
    const parsed = parseRtspUrl(url);
    if (parsed.kind !== "ok") return refuse("bad_url", "url");
    if (parsed.username !== null || parsed.password !== null || /[?&;/](user|username|pass|password|pwd)=/i.test(url)) {
      return refuse("url_has_login", "url");
    }
    camera.url = url;
  } else {
    const host = (raw.host as string).trim();
    if (!validHost(host)) return refuse("bad_host", "host");
    if (typeof raw.vendor !== "string" || !VENDORS.includes(raw.vendor as Vendor)) return refuse("bad_vendor", "vendor");
    // No documented path for an unknown brand: the recorder cannot build one.
    if (raw.vendor === "generic") return refuse("generic_needs_url", "url");
    const ch = raw.channel;
    if (typeof ch !== "number" || !Number.isInteger(ch) || ch < 1 || ch > 256) return refuse("bad_channel", "channel");
    if (raw.stream !== "main" && raw.stream !== "sub") return refuse("bad_stream", "stream");
    camera.host = host;
    camera.vendor = raw.vendor as Vendor;
    camera.channel = ch;
    camera.stream = raw.stream;
  }

  const kbps = raw.bitrateKbps;
  if (kbps !== undefined && kbps !== null) {
    if (typeof kbps !== "number" || !Number.isInteger(kbps) || kbps < 64 || kbps > 20000) return refuse("bad_bitrate", "bitrateKbps");
    camera.bitrateKbps = kbps;
  }

  const key = streamKey(camera);
  if (others.some((c) => streamKey(c) === key)) return refuse("duplicate_stream", hasUrl ? "url" : "host");
  if (others.length + 1 > MAX_CAMERAS) return refuse("too_many_cameras");
  return { ok: true, camera };
}

/** Add a camera at the end. Refusals as checkCamera. */
export function addCamera(cameras: readonly EditableCamera[], raw: unknown): CamerasResult {
  const r = checkCamera(raw, cameras);
  if (!r.ok) return r;
  return { ok: true, cameras: [...cameras.map((c) => ({ ...c })), r.camera] };
}

/**
 * Replace one camera in place. no_such_camera [cameraId] when absent;
 * id_cannot_change [cameraId] when raw carries a different cameraId (the
 * recordings are filed under it). Keys the page does not manage (e.g. audio)
 * are kept from the old entry, after the managed ones.
 */
export function updateCamera(cameras: readonly EditableCamera[], cameraId: string, raw: unknown): CamerasResult {
  const at = cameras.findIndex((c) => c.cameraId === cameraId);
  if (at < 0) return refuse("no_such_camera", "cameraId");
  if (!isObject(raw)) return refuse("not_an_object");
  if (raw.cameraId !== undefined && raw.cameraId !== cameraId) return refuse("id_cannot_change", "cameraId");
  const others = cameras.filter((_, i) => i !== at);
  const r = checkCamera({ ...raw, cameraId }, others);
  if (!r.ok) return r;
  const old = cameras[at] as EditableCamera;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(old)) {
    if (!(MANAGED_KEYS as readonly string[]).includes(k)) kept[k] = v;
  }
  const next = cameras.map((c) => ({ ...c }));
  next[at] = { ...r.camera, ...kept };
  return { ok: true, cameras: next };
}

/** Remove one camera. no_such_camera; last_camera (the recorder needs one). */
export function removeCamera(cameras: readonly EditableCamera[], cameraId: string): CamerasResult {
  if (!cameras.some((c) => c.cameraId === cameraId)) return refuse("no_such_camera", "cameraId");
  if (cameras.length === 1) return refuse("last_camera", "cameraId");
  return { ok: true, cameras: cameras.filter((c) => c.cameraId !== cameraId).map((c) => ({ ...c })) };
}

/**
 * The camera login used for every camera configured by host. bad_username
 * (1..64 characters, no control characters, no ':' — it would split the
 * rtsp user:password pair); bad_password (1..128, no control characters).
 * Neither is trimmed: a password may start with a space.
 */
export function checkLogin(raw: unknown): { ok: true; login: CameraLogin } | EditRefusal {
  if (!isObject(raw)) return refuse("not_an_object");
  const { username, password } = raw;
  if (typeof username !== "string" || username.length < 1 || username.length > 64 || CONTROL.test(username) || username.includes(":")) {
    return refuse("bad_username", "username");
  }
  if (typeof password !== "string" || password.length < 1 || password.length > 128 || CONTROL.test(password)) {
    return refuse("bad_password", "password");
  }
  return { ok: true, login: { username, password } };
}

/** What the page may see of the login: never the password, not even its length. */
export function loginView(login: CameraLogin | null): { username: string | null; passwordSet: boolean } {
  if (login === null || login.username === "") return { username: null, passwordSet: false };
  return { username: login.username, passwordSet: login.password !== "" };
}

/** Names of the managed fields that differ, for the audit line. Never values. */
export function changedFields(before: EditableCamera, after: EditableCamera): string[] {
  return MANAGED_KEYS.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

/**
 * A camera from config.json, before the page ever saved one. Older entries
 * leave out vendor, channel and stream; the recorder has always filled them
 * with generic, 1 and main (resolveCameraUrl). Writing those same values down
 * keeps it recording the exact stream it records today — it is not a new
 * default. Url entries and entries with explicit values pass through as given.
 */
export function fromConfigCamera(c: EditableCamera): EditableCamera {
  const out: EditableCamera = { ...c };
  if (typeof c.host === "string" && c.host !== "" && !(typeof c.url === "string" && c.url !== "")) {
    if (out.vendor === undefined) out.vendor = "generic";
    if (out.channel === undefined) out.channel = 1;
    if (out.stream === undefined) out.stream = "main";
  }
  return out;
}

/**
 * The problem with each camera as the page would save it, in list order:
 * null when it saves as is, otherwise checkCamera's reason against the
 * cameras before it (e.g. url_has_login for a config.json address carrying a
 * password — the installer re-enters it without one before anything saves).
 */
export function cameraProblems(cameras: readonly EditableCamera[]): (string | null)[] {
  return cameras.map((c, i) => {
    const r = checkCamera(c, cameras.slice(0, i));
    return r.ok ? null : r.reason;
  });
}

export type CameraFile ={ ok: true; cameras: EditableCamera[]; login: CameraLogin | null } | { ok: false; reason: string };

/** The text written to cameras.json. */
export function cameraFileText(cameras: readonly EditableCamera[], login: CameraLogin | null): string {
  return JSON.stringify({ version: 1, cameras, login }, null, 2) + "\n";
}

/**
 * Read cameras.json. Refused whole: not_json; bad_version; no_cameras;
 * bad_camera (any entry failing checkCamera against the entries before it —
 * so a hand-edit that duplicates a stream is caught too); bad_login (login
 * present, not null, and failing checkLogin). Unmanaged keys on an entry are kept.
 */
export function parseCameraFile(text: string): CameraFile {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { ok: false, reason: "not_json" }; }
  if (!isObject(data) || data.version !== 1) return { ok: false, reason: "bad_version" };
  if (!Array.isArray(data.cameras) || data.cameras.length === 0) return { ok: false, reason: "no_cameras" };
  const cameras: EditableCamera[] = [];
  for (const entry of data.cameras) {
    const r = checkCamera(entry, cameras);
    if (!r.ok) return { ok: false, reason: "bad_camera" };
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (!(MANAGED_KEYS as readonly string[]).includes(k)) kept[k] = v;
    }
    cameras.push({ ...r.camera, ...kept });
  }
  let login: CameraLogin | null = null;
  if (data.login !== undefined && data.login !== null) {
    const l = checkLogin(data.login);
    if (!l.ok) return { ok: false, reason: "bad_login" };
    login = l.login;
  }
  return { ok: true, cameras, login };
}
