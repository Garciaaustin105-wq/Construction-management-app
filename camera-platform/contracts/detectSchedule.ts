/**
 * How much of the detector each camera gets, and which frames it may skip.
 * AI-PLAN.md stage D1. Pure: no I/O, no clock, no globals.
 *
 * THE FEARED FAILURES, both of which look like a working detector:
 *
 * - **Silent starvation.** Sixteen cameras and one chip. Run them all "as fast
 *   as possible" and the quickest-decoding cameras take most of the chip while
 *   others get almost none. A person walks past camera 9 at 0.2 fps and is
 *   never seen, while the alert rule on camera 9 sits there enabled and green.
 *   An unwatched camera must never look like a watched one.
 *
 * - **Analysing the past.** A detector that queues frames when it falls behind
 *   keeps reporting perfectly, just later and later. An after-hours alert four
 *   minutes late is not late, it is useless. Frames are dropped to stay live,
 *   never queued.
 *
 * DETECT-SPEC.md holds the reasoning; this file holds the arithmetic.
 */

import type { EpochMs } from "./time.js";

/** A camera an alert rule is currently watching degrades last — `bandwidth.ts`'s
 *  `pinned`, for the same reason: the one someone deliberately cares about
 *  should not be the one that quietly drops. */
export type DetectPriority = "normal" | "armed";

export const DETECT_PRIORITIES: readonly DetectPriority[] =
  Object.freeze(["normal", "armed"]);

/** AI-PLAN's working figure: 16 cameras at 5 fps is about 80 detector fps. */
export const DEFAULT_TARGET_FPS = 5;

/**
 * Below one frame a second, whether a person crossing the frame is seen is
 * luck — they are in it for a second or two. A camera that cannot be given
 * this much is not being watched, and the plan refuses rather than scheduling
 * it at 0.3 fps and calling it covered.
 */
export const MIN_USEFUL_FPS = 1;

/** Above this, a request is a configuration mistake rather than an intention. */
export const MAX_TARGET_FPS = 30;

/** A frame older than this is discarded unanalysed. See "analysing the past". */
export const MAX_FRAME_LAG_MS = 2000;

export interface DetectCamera {
  cameraId: string;
  /** Frames a second this camera should get when there is room.
   *  Defaults to DEFAULT_TARGET_FPS. */
  targetFps?: number;
  /** Defaults to "normal". */
  priority?: DetectPriority;
}

export interface DetectAssignment {
  cameraId: string;
  priority: DetectPriority;
  targetFps: number;
  grantedFps: number;
  /**
   * Exactly 1000 / grantedFps, and deliberately not rounded: at 3 fps,
   * rounding 333.33ms into a timer drifts a frame every few seconds, so over
   * an hour the box runs a different frame count than the plan promised.
   * Pace by comparing timestamps (see shouldProcessFrame), not by setInterval.
   */
  intervalMs: number;
  degraded: boolean;
}

export type DetectRefusalCode =
  | "no_cameras"
  | "bad_camera"
  | "duplicate_camera"
  | "unmeasured_capacity"
  | "bad_capacity"
  | "over_capacity";

export interface DetectRefusal {
  ok: false;
  code: DetectRefusalCode;
  message: string;
  /** Only on "over_capacity": how many cameras this box can actually watch at
   *  MIN_USEFUL_FPS. The installer's decision — fewer cameras on detection, or
   *  the AI NVR rather than the Standard — needs the number, not a verdict. */
  watchableCameras?: number;
}

export interface DetectSchedule {
  ok: true;
  assignments: DetectAssignment[];
  capacityFps: number;
  /** Sum of grantedFps. Never above capacityFps — see roundFps. */
  usedFps: number;
  /** True when any camera got less than it asked for. */
  degraded: boolean;
}

export type DetectPlan = DetectSchedule | DetectRefusal;

/**
 * Floored to 3 decimals, downwards, so a plan can never add up to more chip
 * than the box has. The epsilon absorbs float error, so a share that is really
 * 1 does not floor to 0.999 and trip the MIN_USEFUL_FPS check.
 */
function roundFps(fps: number): number {
  return Math.floor(fps * 1000 + 1e-6) / 1000;
}

/** A camera's request plus what it ends up being given. */
interface Wanted {
  cameraId: string;
  targetFps: number;
  priority: DetectPriority;
  grantedFps: number;
}

/**
 * Max-min fair share of `budgetFps` among `group`, written onto each record.
 *
 * 1. Walk the group in ascending target order, tracking how much budget and
 *    how many cameras are left.
 * 2. A camera whose target is at or below the current even share (remaining /
 *    left) takes only its target; the surplus stays for the others.
 * 3. Otherwise it takes the even share — and because the targets ascend, every
 *    camera after it takes the same share, so they all end up level.
 */
function shareAmong(group: readonly Wanted[], budgetFps: number): void {
  const order = [...group].sort((a, b) => a.targetFps - b.targetFps);
  let remaining = budgetFps;
  let left = order.length;
  for (const camera of order) {
    const evenShare = remaining / left;
    const take = camera.targetFps <= evenShare ? camera.targetFps : evenShare;
    camera.grantedFps = take;
    remaining -= take;
    left -= 1;
  }
}

const refuse = (
  code: DetectRefusalCode,
  message: string,
  extra: { watchableCameras?: number } = {}
): DetectRefusal => ({ ok: false, code, message, ...extra });

/**
 * Share the detector across cameras, or refuse and say why.
 *
 * 1. `cameras` must be a non-empty array, else "no_cameras".
 * 2. Each entry must be a non-null object (not an array) with a non-empty
 *    string cameraId, an optional targetFps that is finite and between
 *    MIN_USEFUL_FPS and MAX_TARGET_FPS inclusive, and an optional priority
 *    from DETECT_PRIORITIES — else "bad_camera", naming the camera.
 *    A cameraId seen twice is "duplicate_camera".
 * 3. `capacityFps` null is "unmeasured_capacity" — the plan does NOT assume a
 *    figure. AI-PLAN records measured throughput as still to verify, and
 *    budget.ts and retention.ts already refuse on an unmeasured input for the
 *    same reason (build rule 5). Not finite or not above zero is "bad_capacity".
 * 4. If every camera at MIN_USEFUL_FPS would not fit, refuse "over_capacity"
 *    with watchableCameras = floor(capacityFps / MIN_USEFUL_FPS).
 * 5. If the targets all fit, everyone gets its target.
 * 6. Otherwise, with no armed cameras, all share by fairShare.
 * 7. Otherwise the armed cameras hold their targets and the normals share what
 *    is left — unless that would put a normal below MIN_USEFUL_FPS, in which
 *    case the normals go to MIN_USEFUL_FPS and the armed cameras share the
 *    rest. Step 4 guarantees that rest covers them.
 * 8. Granted rates are floored by roundFps; assignments come back in the
 *    caller's original camera order.
 */
export function planDetectSchedule(
  cameras: readonly DetectCamera[],
  capacityFps: number | null
): DetectPlan {
  if (!Array.isArray(cameras) || cameras.length === 0) {
    return refuse("no_cameras", "no cameras were given to schedule");
  }

  const seen = new Set<string>();
  const wanted: Wanted[] = [];
  for (const camera of cameras) {
    if (camera === null || typeof camera !== "object" || Array.isArray(camera)) {
      return refuse("bad_camera", "a camera is not an object");
    }
    const { cameraId } = camera;
    if (typeof cameraId !== "string" || cameraId.length === 0) {
      return refuse("bad_camera", "a camera has no cameraId");
    }
    if (seen.has(cameraId)) {
      return refuse("duplicate_camera", `${cameraId} is listed more than once`);
    }
    seen.add(cameraId);

    const targetFps = camera.targetFps === undefined ? DEFAULT_TARGET_FPS : camera.targetFps;
    if (
      typeof targetFps !== "number" ||
      !Number.isFinite(targetFps) ||
      targetFps < MIN_USEFUL_FPS ||
      targetFps > MAX_TARGET_FPS
    ) {
      return refuse(
        "bad_camera",
        `${cameraId}: targetFps must be a number from ${MIN_USEFUL_FPS} to ${MAX_TARGET_FPS}`
      );
    }

    const priority = camera.priority === undefined ? "normal" : camera.priority;
    if (priority !== "normal" && priority !== "armed") {
      return refuse("bad_camera", `${cameraId}: priority must be "normal" or "armed"`);
    }

    wanted.push({ cameraId, targetFps, priority, grantedFps: 0 });
  }

  if (capacityFps === null) {
    return refuse(
      "unmeasured_capacity",
      "detector throughput has never been measured on this box, so no schedule can be planned"
    );
  }
  if (typeof capacityFps !== "number" || !Number.isFinite(capacityFps) || capacityFps <= 0) {
    return refuse("bad_capacity", "capacityFps must be a number above zero, or null if unmeasured");
  }

  const floorTotal = wanted.length * MIN_USEFUL_FPS;
  if (floorTotal > capacityFps) {
    return refuse(
      "over_capacity",
      `${wanted.length} cameras need ${floorTotal} fps at the ${MIN_USEFUL_FPS} fps floor, and this box measured ${capacityFps}`,
      { watchableCameras: Math.floor(capacityFps / MIN_USEFUL_FPS) }
    );
  }

  const targetTotal = wanted.reduce((sum, c) => sum + c.targetFps, 0);

  if (targetTotal <= capacityFps) {
    for (const camera of wanted) camera.grantedFps = camera.targetFps;
  } else {
    const armed = wanted.filter((c) => c.priority === "armed");
    const normal = wanted.filter((c) => c.priority === "normal");

    if (armed.length === 0) {
      shareAmong(wanted, capacityFps);
    } else {
      const armedTarget = armed.reduce((sum, c) => sum + c.targetFps, 0);
      const leftForNormal = capacityFps - armedTarget;
      if (normal.length > 0 && leftForNormal >= normal.length * MIN_USEFUL_FPS) {
        for (const camera of armed) camera.grantedFps = camera.targetFps;
        shareAmong(normal, leftForNormal);
      } else {
        for (const camera of normal) camera.grantedFps = MIN_USEFUL_FPS;
        shareAmong(armed, capacityFps - normal.length * MIN_USEFUL_FPS);
      }
    }
  }

  const assignments: DetectAssignment[] = wanted.map((camera) => {
    const grantedFps = roundFps(camera.grantedFps);
    return {
      cameraId: camera.cameraId,
      priority: camera.priority,
      targetFps: camera.targetFps,
      grantedFps,
      intervalMs: 1000 / grantedFps,
      degraded: grantedFps + 1e-9 < camera.targetFps,
    };
  });

  return {
    ok: true,
    assignments,
    capacityFps,
    usedFps: roundFps(assignments.reduce((sum, a) => sum + a.grantedFps, 0)),
    degraded: assignments.some((a) => a.degraded),
  };
}

/**
 * Why a frame was or was not analysed. A reason rather than a bare boolean
 * because the service counts these: `too_soon` is the schedule working, while
 * a rising `stale` count is the box overloaded — a health fact worth showing,
 * not a detail to swallow.
 */
export type FrameOutcome = "due" | "too_soon" | "stale";

export interface FrameDecision {
  process: boolean;
  reason: FrameOutcome;
  /** How far behind real time this frame was, in ms. Negative means the
   *  camera's clock is ahead of ours. */
  lagMs: number;
  /**
   * The cursor to keep and pass back as `dueAtMs` next time.
   *
   * This exists because the obvious alternative — remembering the last frame
   * ANALYSED — quietly quantises the rate to the source's frame rate. A camera
   * planned at 7 fps, fed by a 30 fps substream, would land on every 5th frame
   * and run at 6. The plan promises 7, the box delivers 6, and nothing reports
   * the difference: silent starvation on a smaller scale.
   */
  nextDueAtMs: EpochMs | null;
}

export interface FrameQuestion {
  frameAtMs: EpochMs;
  /** When this camera's next frame is due. null before its first frame. */
  dueAtMs: EpochMs | null;
  /** From the camera's DetectAssignment. Fractional is expected. */
  intervalMs: number;
  nowMs: EpochMs;
  /** Defaults to MAX_FRAME_LAG_MS. */
  maxLagMs?: number;
}

/**
 * Decide whether to analyse one frame. Epoch milliseconds rather than ISO
 * strings on purpose: this runs about eighty times a second across the box,
 * and parsing a timestamp per frame is a cost with no reader.
 *
 * 1. lagMs = nowMs - frameAtMs.
 * 2. lagMs > maxLagMs: "stale", do not process, cursor unchanged — even for
 *    the first frame. A frame from the FUTURE (negative lag) is clock skew
 *    between the camera and the box, not lag, and is never stale: treating it
 *    so would blind a camera whose clock runs fast.
 * 3. dueAtMs null: "due", and the cursor starts at frameAtMs + intervalMs.
 * 4. frameAtMs >= dueAtMs (within 1e-9): "due". The cursor advances by exactly
 *    one interval, so a fractional rate stays exact over an hour — UNLESS that
 *    would still leave it at or behind this frame, which means the stream
 *    stalled and owes more frames than it can deliver. Then it resets to
 *    frameAtMs + intervalMs, so recovery is a return to the planned rate
 *    rather than a burst working through a backlog nobody wants analysed.
 * 5. Otherwise "too_soon", cursor unchanged. An out-of-order frame lands here
 *    and is skipped.
 */
export function shouldProcessFrame(question: FrameQuestion): FrameDecision {
  const { frameAtMs, dueAtMs, intervalMs, nowMs } = question;
  const maxLagMs = question.maxLagMs === undefined ? MAX_FRAME_LAG_MS : question.maxLagMs;
  const lagMs = nowMs - frameAtMs;

  if (lagMs > maxLagMs) {
    return { process: false, reason: "stale", lagMs, nextDueAtMs: dueAtMs };
  }
  if (dueAtMs === null) {
    return { process: true, reason: "due", lagMs, nextDueAtMs: frameAtMs + intervalMs };
  }
  if (frameAtMs + 1e-9 >= dueAtMs) {
    const advanced = dueAtMs + intervalMs;
    const nextDueAtMs = advanced > frameAtMs ? advanced : frameAtMs + intervalMs;
    return { process: true, reason: "due", lagMs, nextDueAtMs };
  }
  return { process: false, reason: "too_soon", lagMs, nextDueAtMs: dueAtMs };
}
