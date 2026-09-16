/**
 * What the installer sees when they ask "is this NVR actually working?".
 *
 * THE FEARED FAILURE: a green page over a dead recorder. The old /health said
 * `ok: true` as long as the HTTP server could answer, so a camera that stopped
 * sending frames three days ago, a store root that never mounted, and a disk
 * at 99% all looked identical to a healthy site. Someone finds out when they
 * go looking for footage that was never written.
 *
 * So this file derives a status from MEASURED facts and carries every number
 * it used, next to its unit, so the page can show the working. Where a fact is
 * missing it says "unknown" and never "zero": a camera whose bitrate has not
 * been measured does not contribute 0 kbps to a retention estimate, and an
 * unmounted store does not contribute 0 free bytes to a disk gauge. A blank is
 * not a zero (build rule 5), and a wrong retention figure looks completely
 * normal on screen.
 *
 * The thresholds are arguments with documented defaults, not magic numbers
 * buried in a comparison, because a site with 5-minute segments needs a
 * different silence threshold than one with 60-second segments.
 *
 * Pure. No fs, no clock, no SQLite -- the caller measures, this decides.
 */

import { computeRetentionDays } from "./retention.js";
import { MS_PER_SECOND } from "./time.js";

/** A camera as the recorder and the index actually observed it. */
export interface CameraHealthInput {
  cameraId: string;
  /** False when the URL could not be built at all (bad host, missing password). */
  resolved: boolean;
  unresolvedReason: string | null;
  /**
   * Measured kilobits per second from sealed segments. Null means NOT
   * MEASURED -- a new camera, or one whose every probe failed. Never
   * substitute the configured bitrate here: the configured number is a
   * request, and cameras ignore requests.
   */
  measuredKbps: number | null;
  /** Sealed segments in the index for this camera. */
  segments: number;
  /** Bytes those sealed segments occupy. */
  bytes: number;
  /** When the newest sealed segment ENDED, or null if nothing is sealed yet. */
  lastSealedUtc: string | null;
  /** Segments still being written. Normally 1 for a recording camera. */
  openSegments: number;
}

/** A store root as the filesystem actually reports it. */
export interface StoreHealthInput {
  root: string;
  /**
   * False when the path is missing, or is a bare directory where a disk was
   * expected. Recording to an unmounted mountpoint fills the root filesystem
   * and looks like it is working right up until the appliance stops booting.
   */
  mounted: boolean;
  /** Null when it could not be measured -- not 0. */
  totalBytes: number | null;
  freeBytes: number | null;
}

export interface SiteHealthInput {
  siteId: string;
  /** The moment this snapshot describes. */
  atUtc: string;
  cameras: readonly CameraHealthInput[];
  stores: readonly StoreHealthInput[];
  /** Whether the recorder process reports itself as running, or null if unknown. */
  recorderRunning: boolean | null;
}

export interface SiteHealthOptions {
  /**
   * A camera with nothing sealed for this long is silent. The default is
   * three 60-second segments: one late seal is normal, three is not.
   */
  silentAfterSeconds?: number;
  /** Fraction of a store at which eviction starts; above it, "filling". */
  fillingAtFraction?: number;
  /** Fraction at which a store is effectively out of room. */
  fullAtFraction?: number;
}

export const DEFAULT_SILENT_AFTER_SECONDS = 180;
export const DEFAULT_FILLING_AT_FRACTION = 0.85;
export const DEFAULT_FULL_AT_FRACTION = 0.95;

/**
 * Ordered worst-last. "unknown" sits above "ok" because a thing we could not
 * measure must not be painted the same green as a thing we measured and found
 * healthy.
 */
export type HealthStatus = "ok" | "unknown" | "degraded" | "down";

const STATUS_RANK: Record<HealthStatus, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  down: 3,
};

export type CameraHealthState =
  /** Sealing segments recently. */
  | "recording"
  /** Sealed something once, but not lately. */
  | "silent"
  /** Has never sealed anything: newly added, or never worked. */
  | "never_recorded"
  /** No usable URL. The recorder is not even trying. */
  | "unresolved";

export interface CameraHealth {
  cameraId: string;
  state: CameraHealthState;
  status: HealthStatus;
  /** Why this state, in words a person can act on. */
  detail: string;
  measuredKbps: number | null;
  segments: number;
  bytes: number;
  lastSealedUtc: string | null;
  /** Seconds since the last seal, or null when nothing has ever sealed. */
  secondsSinceSealed: number | null;
  openSegments: number;
}

export type StoreHealthState = "ok" | "filling" | "full" | "unmounted" | "unmeasured";

export interface StoreHealth {
  root: string;
  state: StoreHealthState;
  status: HealthStatus;
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  /** 0..1, or null when it could not be measured. Not defaulted to 0. */
  usedFraction: number | null;
}

export type RetentionSummary =
  | { kind: "ok"; days: number; totalKbps: number; camerasCounted: number }
  | {
      kind: "unknown";
      /** What is missing, so the page can say so instead of showing a dash. */
      reason:
        | "unmeasured_cameras"
        | "unmeasured_stores"
        | "no_cameras"
        | "no_usable_bytes"
        | "zero_bitrate";
      message: string;
      unmeasuredCameraIds: string[];
    };

export interface SiteHealth {
  ok: boolean;
  status: HealthStatus;
  siteId: string;
  atUtc: string;
  recorderRunning: boolean | null;
  cameras: CameraHealth[];
  stores: StoreHealth[];
  totals: {
    cameras: number;
    recording: number;
    unresolved: number;
    silent: number;
    segments: number;
    bytes: number;
    /** Sum of measured bitrates only. Unmeasured cameras are excluded, and
     *  counted separately, rather than quietly adding nothing. */
    measuredKbps: number;
    camerasUnmeasured: number;
  };
  retention: RetentionSummary;
}

const worst = (a: HealthStatus, b: HealthStatus): HealthStatus =>
  STATUS_RANK[b] > STATUS_RANK[a] ? b : a;

function parseMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function cameraHealth(
  camera: CameraHealthInput,
  atMs: number | null,
  silentAfterSeconds: number,
): CameraHealth {
  const sealedMs = camera.lastSealedUtc === null ? null : parseMs(camera.lastSealedUtc);
  const secondsSinceSealed =
    atMs === null || sealedMs === null ? null : (atMs - sealedMs) / MS_PER_SECOND;

  let state: CameraHealthState;
  let status: HealthStatus;
  let detail: string;

  if (!camera.resolved) {
    state = "unresolved";
    status = "down";
    detail = camera.unresolvedReason ?? "no usable stream URL";
  } else if (camera.lastSealedUtc === null) {
    state = "never_recorded";
    // Not "down": a camera added a minute ago has not failed yet. It is a
    // thing we cannot vouch for, which is exactly what unknown means.
    status = "unknown";
    detail = "no sealed segment yet";
  } else if (secondsSinceSealed === null) {
    state = "silent";
    status = "unknown";
    detail = "last seal time is unreadable";
  } else if (secondsSinceSealed > silentAfterSeconds) {
    state = "silent";
    status = "degraded";
    detail = `nothing sealed for ${Math.round(secondsSinceSealed)}s`;
  } else {
    state = "recording";
    status = "ok";
    detail = `sealed ${Math.round(secondsSinceSealed)}s ago`;
  }

  return {
    cameraId: camera.cameraId,
    state,
    status,
    detail,
    measuredKbps: camera.measuredKbps,
    segments: camera.segments,
    bytes: camera.bytes,
    lastSealedUtc: camera.lastSealedUtc,
    secondsSinceSealed,
    openSegments: camera.openSegments,
  };
}

function storeHealth(
  store: StoreHealthInput,
  fillingAt: number,
  fullAt: number,
): StoreHealth {
  const total = store.totalBytes;
  const free = store.freeBytes;
  const measured = total !== null && free !== null && total > 0;
  const usedBytes = measured ? total - free : null;
  const usedFraction = measured && usedBytes !== null ? usedBytes / total : null;

  let state: StoreHealthState;
  let status: HealthStatus;

  if (!store.mounted) {
    // Checked first and on its own: an unmounted root can still report the
    // root filesystem's comfortable 40% and look perfectly fine.
    state = "unmounted";
    status = "down";
  } else if (usedFraction === null) {
    state = "unmeasured";
    status = "unknown";
  } else if (usedFraction >= fullAt) {
    state = "full";
    status = "degraded";
  } else if (usedFraction >= fillingAt) {
    state = "filling";
    status = "ok";
  } else {
    state = "ok";
    status = "ok";
  }

  return {
    root: store.root,
    state,
    status,
    totalBytes: total,
    freeBytes: free,
    usedBytes,
    usedFraction,
  };
}

/**
 * Fold measurements into one snapshot. Returns a value for every field it can
 * measure and an explicit unknown for every field it cannot; it never throws,
 * because a health endpoint that 500s tells an operator nothing at all.
 */
export function siteHealth(
  input: SiteHealthInput,
  options: SiteHealthOptions = {},
): SiteHealth {
  const silentAfterSeconds = options.silentAfterSeconds ?? DEFAULT_SILENT_AFTER_SECONDS;
  const fillingAt = options.fillingAtFraction ?? DEFAULT_FILLING_AT_FRACTION;
  const fullAt = options.fullAtFraction ?? DEFAULT_FULL_AT_FRACTION;

  const atMs = parseMs(input.atUtc);

  const cameras = input.cameras.map((c) => cameraHealth(c, atMs, silentAfterSeconds));
  const stores = input.stores.map((s) => storeHealth(s, fillingAt, fullAt));

  let segments = 0;
  let bytes = 0;
  let measuredKbps = 0;
  let camerasUnmeasured = 0;
  let recording = 0;
  let unresolved = 0;
  let silent = 0;
  for (const c of cameras) {
    segments += c.segments;
    bytes += c.bytes;
    if (c.measuredKbps === null) camerasUnmeasured++;
    else measuredKbps += c.measuredKbps;
    if (c.state === "recording") recording++;
    if (c.state === "unresolved") unresolved++;
    if (c.state === "silent") silent++;
  }

  // Retention needs the WHOLE store, not the part we happened to measure. If
  // any mounted root's size is unknown the total is unknown, and a retention
  // figure computed from a partial total would read low and be believed.
  const mounted = stores.filter((s) => s.state !== "unmounted");
  const anyStoreUnmeasured = mounted.some((s) => s.totalBytes === null);
  let usableBytes = 0;
  for (const s of mounted) usableBytes += s.totalBytes ?? 0;

  const retention: RetentionSummary = anyStoreUnmeasured
    ? {
        kind: "unknown",
        reason: "unmeasured_stores",
        message: "a mounted store did not report its size; retention is unknowable",
        unmeasuredCameraIds: [],
      }
    : toRetentionSummary(
        computeRetentionDays(
          cameras.map((c) => ({ cameraId: c.cameraId, bitrateKbps: c.measuredKbps })),
          usableBytes,
        ),
      );

  let status: HealthStatus = "ok";
  for (const c of cameras) status = worst(status, c.status);
  for (const s of stores) status = worst(status, s.status);
  if (input.recorderRunning === false) status = worst(status, "down");
  if (input.recorderRunning === null) status = worst(status, "unknown");
  if (input.stores.length === 0) status = worst(status, "down");

  return {
    // `ok` stays in the envelope for older clients, but it now means what a
    // reader assumes it means: nothing is wrong. Green is earned, not default.
    ok: status === "ok",
    status,
    siteId: input.siteId,
    atUtc: input.atUtc,
    recorderRunning: input.recorderRunning,
    cameras,
    stores,
    totals: {
      cameras: cameras.length,
      recording,
      unresolved,
      silent,
      segments,
      bytes,
      measuredKbps,
      camerasUnmeasured,
    },
    retention,
  };
}

function toRetentionSummary(estimate: ReturnType<typeof computeRetentionDays>): RetentionSummary {
  if (estimate.kind === "ok") {
    return {
      kind: "ok",
      days: estimate.days,
      totalKbps: estimate.totalKbps,
      camerasCounted: estimate.camerasCounted,
    };
  }
  return {
    kind: "unknown",
    reason: estimate.reason,
    message: estimate.message,
    unmeasuredCameraIds: estimate.unmeasuredCameraIds,
  };
}
