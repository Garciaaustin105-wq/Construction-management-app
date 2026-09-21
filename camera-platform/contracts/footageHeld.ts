/**
 * How much footage each camera holds, and how long it will keep it — from
 * what is on the drives, never from what a camera was asked to send.
 *
 * Pure: no I/O, no clock. The caller measures (index rows, statfs) and passes
 * the moment; this decides what those measurements can honestly be said to
 * mean.
 *
 * WHY THIS EXISTS. On 2026-09-21 the laptop NVR held 4.1 hours of main stream
 * and nobody knew. Three different retention numbers were in the code and
 * each was wrong in its own way:
 *   - health.json read the CONFIGURED bitrate (null) and refused, which raised
 *     a "retention unknown" alarm that never cleared;
 *   - the System page divided the RAW size of every drive, pooled, by a median
 *     bitrate: about 10.6 h against a true 4.1, because the main stream sat
 *     alone on a 6 GB drive and the pooled figure lent it the other drive;
 *   - the median itself described the time of day the ring happened to hold:
 *     that camera writes 5.40 Mbps all night under infrared and 1.4-3.3 Mbps
 *     by day, and four hours of afternoon measure the afternoon.
 *
 * WHAT IT DOES INSTEAD, per drive, because a camera is pinned to one drive and
 * eviction runs per drive:
 *   - the drive is full and nothing but configured cameras' footage is on it:
 *     what is held IS what is kept. Basis "measured".
 *   - still filling, with a full day of unbroken history for every camera on
 *     it: the room left for footage divided by the bytes those cameras really
 *     wrote in that day. Basis "projected", and labelled as an estimate.
 *   - still filling and no full day to measure: the footage held so far is a
 *     floor. Basis "at_least". This is a measurement, not a refusal, and it is
 *     not an alarm.
 *   - the keep-for limit (Recording page) deletes before the space runs out:
 *     basis "age_limit".
 * It refuses only when nothing true can be said: a camera with no footage, a
 * drive that did not report its size.
 *
 * It never throws. It feeds a health endpoint and a 30-second health file,
 * and a retention calculation that takes either down tells nobody anything.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** A write rate is only measured over a whole day. Anything shorter measures
 *  the time of day: 5.40 Mbps under infrared against 1.4-3.3 by daylight on
 *  the bench camera, so four afternoon hours would promise twice the room. */
export const PROJECTION_WINDOW_MS = DAY_MS;

/** The day a rate is taken from must be this complete. A camera that was
 *  offline for the night hours would otherwise report its cheap daytime rate
 *  as its whole-day rate, and the projection would read long. */
export const MIN_WINDOW_COVERAGE = 0.95;

/** A drive counts as full once its use reaches this fraction of the ring.
 *  Eviction runs every five minutes and frees back to exactly the ring, so
 *  right after a run use sits at the ring and between runs just over it. */
export const CYCLING_TOLERANCE = 0.03;

/**
 * One group of SEALED segments from the index, for one camera on one drive.
 * Segments under a hold or awaiting upload are not in these counts: eviction
 * cannot touch them, so they are not rolling footage, and their bytes show up
 * in the drive's `otherBytes` instead.
 */
export interface FootageRow {
  cameraId: string;
  /** The drive the files are on. Null for rows written before segments
   *  recorded their drive: those count towards the camera, not a drive. */
  root: string | null;
  segments: number;
  bytes: number;
  /** Earliest start_ms in the group. */
  oldestMs: number;
  /** Latest end_ms in the group. */
  newestMs: number;
  /** Sum of (end_ms - start_ms): time actually on disk, holes excluded. */
  recordedMs: number;
  /** Bytes of segments that START at or after nowMs - PROJECTION_WINDOW_MS. */
  windowBytes: number;
  /** Sum of (end_ms - start_ms) for those same segments. */
  windowRecordedMs: number;
}

/** A drive as statfs saw it. Null is "not measured", never zero. */
export interface StoreSpace {
  root: string;
  totalBytes: number | null;
  /** total - available-to-us: the same definition eviction uses. */
  usedBytes: number | null;
}

export interface FootageInput {
  nowMs: number;
  /** The cameras in the config. Footage from any other camera still takes up
   *  room, and is reported, but is not asked how long it keeps. */
  cameraIds: readonly string[];
  footage: readonly FootageRow[];
  stores: readonly StoreSpace[];
  /** The recorder's RING_FILL: eviction keeps each drive at this fraction. */
  ringFill: number;
  /** The Recording page's keep-for limit in ms, or null when there is none. */
  maxAgeMs: number | null;
}

export type KeepBasis = "measured" | "projected" | "age_limit" | "at_least";

export type CameraRefusal = "nothing_held" | "drive_unknown" | "store_unmeasured";

export type CameraKeeps =
  | { ok: true; hours: number; basis: KeepBasis; note: string }
  | { ok: false; reason: CameraRefusal; message: string };

export interface CameraFootage {
  cameraId: string;
  /** The drive it records to now: the one holding its newest footage. */
  root: string | null;
  /** How far back its footage goes, and how long ago that is. */
  heldFromUtc: string | null;
  heldHours: number | null;
  /** Hours actually on disk. Less than heldHours when there are holes. */
  recordedHours: number;
  bytes: number;
  /** Bytes in rows that never recorded their drive (rule 16: said, not hidden). */
  unattributedBytes: number;
  /** What the drive space alone allows, ignoring the keep-for limit. The
   *  Recording page needs this to warn, while a new limit is being typed,
   *  that the drives would fill first. */
  space: CameraKeeps;
  /** What is actually kept: the space, or the keep-for limit if it is shorter. */
  keeps: CameraKeeps;
}

export interface StoreFootage {
  root: string;
  totalBytes: number | null;
  usedBytes: number | null;
  /** totalBytes * ringFill: where eviction holds the drive. */
  ringBytes: number | null;
  /** Evictable footage on this drive, from every camera. */
  rollingBytes: number;
  /** Everything used that is not rolling footage: filesystem overhead, held
   *  and pending segments, clip-library links, quarantine. Null if unmeasured. */
  otherBytes: number | null;
  /** Rolling bytes from cameras no longer in the config. They are deleted
   *  first, being oldest, and until they are gone the drive is not steady. */
  foreignBytes: number;
  /** True when those leftovers are the oldest footage on the drive, so they
   *  are what eviction deletes next. False when a configured camera's own
   *  footage is older: the leftovers then just take up room. */
  foreignClearedFirst: boolean;
  /** Whether eviction is deleting the oldest footage to make room. */
  full: boolean | null;
  /** Oldest rolling footage on the drive. */
  oldestUtc: string | null;
  /** Configured cameras recording to this drive now. */
  cameraIds: string[];
  /** Bytes a day those cameras write, from the last full day. */
  bytesPerDay: number | null;
  /** Hours of footage the drive will hold once full, at that rate. */
  projectedHours: number | null;
  /** Why there is no projection, in words. Null when there is one. */
  noProjection: string | null;
}

export type FootageSummary =
  | {
      kind: "ok";
      /** The least any configured camera keeps. */
      hours: number;
      basis: KeepBasis;
      limitingCameraId: string;
      /** The least any camera's drive space allows, ignoring the limit. */
      spaceHours: number;
      spaceBasis: KeepBasis;
      cameras: CameraFootage[];
      stores: StoreFootage[];
    }
  | {
      kind: "unknown";
      reason: "no_cameras" | "cameras_unknown" | "bad_input";
      message: string;
      unknownCameraIds: string[];
      cameras: CameraFootage[];
      stores: StoreFootage[];
    };

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isNumOrNull = (x: unknown): x is number | null => x === null || isNum(x);
const iso = (ms: number) => new Date(ms).toISOString();

function badInput(message: string): FootageSummary {
  return { kind: "unknown", reason: "bad_input", message, unknownCameraIds: [], cameras: [], stores: [] };
}

function rowProblem(r: unknown): string | null {
  if (!isObj(r)) return "a footage row is not an object";
  if (typeof r.cameraId !== "string" || r.cameraId === "") return "a footage row has no cameraId";
  if (r.root !== null && typeof r.root !== "string") return `footage row for ${r.cameraId} has an unreadable root`;
  for (const k of ["segments", "bytes", "oldestMs", "newestMs", "recordedMs", "windowBytes", "windowRecordedMs"]) {
    const v = r[k];
    if (!isNum(v) || v < 0) return `footage row for ${r.cameraId} has an unreadable ${k}`;
  }
  return null;
}

const hoursText = (h: number) => (h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

/**
 * Decide what the measurements say about how long footage is kept.
 * See the file comment for the four bases and the two refusals.
 */
export function footageHeld(input: unknown): FootageSummary {
  if (!isObj(input)) return badInput("footageHeld needs an input object");
  const { nowMs, cameraIds, footage, stores, ringFill, maxAgeMs } = input;
  if (!isNum(nowMs)) return badInput("nowMs is not a number");
  if (!Array.isArray(cameraIds) || cameraIds.some((c) => typeof c !== "string")) {
    return badInput("cameraIds must be a list of camera ids");
  }
  if (!Array.isArray(footage)) return badInput("footage must be a list of rows");
  for (const r of footage) {
    const p = rowProblem(r);
    if (p !== null) return badInput(p);
  }
  if (!Array.isArray(stores)) return badInput("stores must be a list");
  for (const s of stores) {
    if (!isObj(s) || typeof s.root !== "string" || !isNumOrNull(s.totalBytes) || !isNumOrNull(s.usedBytes)) {
      return badInput("a store is not { root, totalBytes, usedBytes }");
    }
  }
  if (!isNum(ringFill) || ringFill <= 0 || ringFill > 1) return badInput("ringFill must be in (0, 1]");
  if (!(maxAgeMs === null || (isNum(maxAgeMs) && maxAgeMs > 0))) {
    return badInput("maxAgeMs must be null or a positive number of milliseconds");
  }

  const rows = footage as FootageRow[];
  const configured = new Set(cameraIds as string[]);
  const windowStartMs = nowMs - PROJECTION_WINDOW_MS;

  // Each configured camera: its rows, where it records now, how far back it goes.
  const rowsOf = new Map<string, FootageRow[]>();
  for (const r of rows) {
    const list = rowsOf.get(r.cameraId);
    if (list === undefined) rowsOf.set(r.cameraId, [r]);
    else list.push(r);
  }
  const currentRootOf = new Map<string, string | null>();
  for (const id of configured) {
    let newest: FootageRow | null = null;
    for (const r of rowsOf.get(id) ?? []) {
      if (r.segments > 0 && (newest === null || r.newestMs > newest.newestMs)) newest = r;
    }
    currentRootOf.set(id, newest === null ? null : newest.root);
  }

  // Each drive: what is on it, whether it is full, what it would hold.
  const storeOut: StoreFootage[] = [];
  const storeByRoot = new Map<string, StoreFootage>();
  for (const s of stores as StoreSpace[]) {
    const onDrive = rows.filter((r) => r.root === s.root && r.segments > 0);
    const rollingBytes = onDrive.reduce((sum, r) => sum + r.bytes, 0);
    const foreignBytes = onDrive.filter((r) => !configured.has(r.cameraId)).reduce((sum, r) => sum + r.bytes, 0);
    const measured = s.totalBytes !== null && s.usedBytes !== null && s.totalBytes > 0;
    const ringBytes = measured ? (s.totalBytes as number) * ringFill : null;
    const otherBytes = measured ? Math.max(0, (s.usedBytes as number) - rollingBytes) : null;
    const full = measured ? (s.usedBytes as number) >= (ringBytes as number) * (1 - CYCLING_TOLERANCE) : null;
    const oldestMs = onDrive.length === 0 ? null : Math.min(...onDrive.map((r) => r.oldestMs));
    // Eviction is oldest-first across the drive, so leftovers from removed
    // cameras are only "cleared first" when they are the oldest thing on it.
    const oldestRow = onDrive.reduce<FootageRow | null>((a, r) => (a === null || r.oldestMs < a.oldestMs ? r : a), null);
    const foreignClearedFirst = foreignBytes > 0 && oldestRow !== null && !configured.has(oldestRow.cameraId);
    const here = [...configured].filter((id) => currentRootOf.get(id) === s.root);

    // The projection: every camera recording here must have a whole, nearly
    // unbroken day behind it, or the rate describes part of a day.
    let bytesPerDay: number | null = null;
    let projectedHours: number | null = null;
    let noProjection: string | null = null;
    if (!measured) {
      noProjection = "the drive did not report its size";
    } else if (here.length === 0) {
      noProjection = "no configured camera records to this drive";
    } else {
      let total = 0;
      for (const id of here) {
        // Only this drive's rows. A camera moved here an hour ago has a day of
        // history on its OLD drive, and that day says nothing about this one:
        // borrowing it is the pooling this file exists to stop.
        const mine = (rowsOf.get(id) ?? []).filter((r) => r.root === s.root);
        const oldest = Math.min(...mine.map((r) => r.oldestMs));
        const winBytes = mine.reduce((sum, r) => sum + r.windowBytes, 0);
        const winMs = mine.reduce((sum, r) => sum + r.windowRecordedMs, 0);
        if (oldest > windowStartMs) {
          noProjection = `${id} has ${hoursText((nowMs - oldest) / HOUR_MS)} of history, and a rate needs a full day: ` +
            "night and day record at very different rates";
          break;
        }
        if (winMs < MIN_WINDOW_COVERAGE * PROJECTION_WINDOW_MS) {
          noProjection = `${id} is missing ${hoursText((PROJECTION_WINDOW_MS - winMs) / HOUR_MS)} of the last day, ` +
            "so a rate taken from it would read low";
          break;
        }
        if (winBytes <= 0) {
          noProjection = `${id} wrote nothing measurable in the last day`;
          break;
        }
        total += (winBytes / winMs) * DAY_MS;
      }
      if (noProjection === null) {
        const room = (ringBytes as number) - (otherBytes as number);
        if (room <= 0) {
          noProjection = "other use already fills the room eviction leaves for footage";
        } else {
          bytesPerDay = total;
          projectedHours = (room / total) * 24;
        }
      }
    }

    const out: StoreFootage = {
      root: s.root,
      totalBytes: s.totalBytes,
      usedBytes: s.usedBytes,
      ringBytes,
      rollingBytes,
      otherBytes,
      foreignBytes,
      foreignClearedFirst,
      full,
      oldestUtc: oldestMs === null ? null : iso(oldestMs),
      cameraIds: here,
      bytesPerDay,
      projectedHours,
      noProjection,
    };
    storeOut.push(out);
    storeByRoot.set(s.root, out);
  }

  // Each configured camera: what it holds, and what it keeps.
  const cameraOut: CameraFootage[] = [];
  for (const id of cameraIds as string[]) {
    const mine = (rowsOf.get(id) ?? []).filter((r) => r.segments > 0);
    const bytes = mine.reduce((sum, r) => sum + r.bytes, 0);
    const recordedMs = mine.reduce((sum, r) => sum + r.recordedMs, 0);
    const unattributedBytes = mine.filter((r) => r.root === null).reduce((sum, r) => sum + r.bytes, 0);
    const oldestMs = mine.length === 0 ? null : Math.min(...mine.map((r) => r.oldestMs));
    const heldHours = oldestMs === null ? null : Math.max(0, (nowMs - oldestMs) / HOUR_MS);
    const root = currentRootOf.get(id) ?? null;

    const { space, keeps } = keepsFor(id, root, heldHours, storeByRoot, nowMs, maxAgeMs as number | null);
    cameraOut.push({
      cameraId: id,
      root,
      heldFromUtc: oldestMs === null ? null : iso(oldestMs),
      heldHours,
      recordedHours: recordedMs / HOUR_MS,
      bytes,
      unattributedBytes,
      space,
      keeps,
    });
  }

  if (cameraOut.length === 0) {
    return {
      kind: "unknown",
      reason: "no_cameras",
      message: "no cameras are configured, so there is nothing to keep",
      unknownCameraIds: [],
      cameras: cameraOut,
      stores: storeOut,
    };
  }
  const refused = cameraOut.filter((c) => !c.keeps.ok);
  if (refused.length > 0) {
    return {
      kind: "unknown",
      reason: "cameras_unknown",
      message: refused
        .map((c) => `${c.cameraId}: ${(c.keeps as { message: string }).message}`)
        .join("; "),
      unknownCameraIds: refused.map((c) => c.cameraId),
      cameras: cameraOut,
      stores: storeOut,
    };
  }
  let limiting = cameraOut[0] as CameraFootage;
  for (const c of cameraOut) {
    if ((c.keeps as { hours: number }).hours < (limiting.keeps as { hours: number }).hours) limiting = c;
  }
  let tightest = cameraOut[0] as CameraFootage;
  for (const c of cameraOut) {
    if ((c.space as { hours: number }).hours < (tightest.space as { hours: number }).hours) tightest = c;
  }
  const k = limiting.keeps as { hours: number; basis: KeepBasis };
  const sp = tightest.space as { hours: number; basis: KeepBasis };
  return {
    kind: "ok",
    hours: k.hours,
    basis: k.basis,
    limitingCameraId: limiting.cameraId,
    spaceHours: sp.hours,
    spaceBasis: sp.basis,
    cameras: cameraOut,
    stores: storeOut,
  };
}

function keepsFor(
  id: string,
  root: string | null,
  heldHours: number | null,
  storeByRoot: Map<string, StoreFootage>,
  nowMs: number,
  maxAgeMs: number | null,
): { space: CameraKeeps; keeps: CameraKeeps } {
  const refuse = (reason: CameraRefusal, message: string) => {
    const r: CameraKeeps = { ok: false, reason, message };
    return { space: r, keeps: r };
  };
  if (heldHours === null) return refuse("nothing_held", "no recorded footage in the index yet");
  if (root === null) return refuse("drive_unknown", "its footage does not say which drive it is on");
  const store = storeByRoot.get(root);
  if (store === undefined) return refuse("drive_unknown", `it records to ${root}, which is not a configured drive`);
  if (store.full === null) return refuse("store_unmeasured", `its drive ${root} did not report its size`);

  // What the space alone allows.
  let space: { hours: number; basis: KeepBasis; note: string };
  if (store.full && store.foreignBytes === 0 && store.oldestUtc !== null) {
    const horizon = (nowMs - Date.parse(store.oldestUtc)) / HOUR_MS;
    space = {
      hours: horizon,
      basis: "measured",
      note: "the drive is full: footage older than this is deleted to make room",
    };
  } else if (store.projectedHours !== null) {
    space = {
      hours: store.projectedHours,
      basis: "projected",
      note: store.foreignClearedFirst
        ? "estimate from the last full day; footage from cameras no longer configured is being cleared first"
        : store.foreignBytes > 0
          ? "estimate from the last full day; footage from cameras no longer configured still takes up room on this drive"
          : "estimate: the drive's room divided by the last full day's recording",
    };
  } else {
    space = {
      hours: heldHours,
      basis: "at_least",
      note: `at least this much: ${store.noProjection ?? "the drive is still filling"}`,
    };
  }

  const spaceKeeps: CameraKeeps = { ok: true, ...space };
  if (maxAgeMs === null) return { space: spaceKeeps, keeps: spaceKeeps };
  const limitHours = maxAgeMs / HOUR_MS;
  const limit = {
    ok: true as const,
    hours: limitHours,
    basis: "age_limit" as const,
    note: `the keep-for limit deletes footage older than ${hoursText(limitHours)}`,
  };
  // A floor below the limit says nothing about which comes first; a floor at
  // or above it means the limit is already what deletes.
  if (space.basis === "at_least") return { space: spaceKeeps, keeps: space.hours >= limitHours ? limit : spaceKeeps };
  return { space: spaceKeeps, keeps: space.hours <= limitHours ? spaceKeeps : limit };
}
