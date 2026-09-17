// harness/detectSchedule.harness.mjs — contracts/detectSchedule.ts
//
// FEARED: a camera scheduled so low it is not really watched, while its alert
// rule sits there green; a schedule planned on a throughput nobody measured;
// a plan that adds up to more chip than the box has; a detector that analyses
// frames from four minutes ago and calls them an alert; a fractional rate that
// quietly becomes a slower whole one.

import { check, eq, same, close, report } from "./_assert.mjs";
import {
  DEFAULT_TARGET_FPS, MIN_USEFUL_FPS, MAX_TARGET_FPS, MAX_FRAME_LAG_MS,
  DETECT_PRIORITIES, planDetectSchedule, shouldProcessFrame,
} from "../dist/detectSchedule.js";

console.log("detectSchedule");

const cams = (n, targetFps, priority) =>
  Array.from({ length: n }, (_, i) => {
    const c = { cameraId: `cam${i + 1}` };
    if (targetFps !== undefined) c.targetFps = targetFps;
    if (priority !== undefined) c.priority = priority;
    return c;
  });
const granted = (plan) => plan.assignments.map((a) => a.grantedFps);
const byId = (plan, id) => plan.assignments.find((a) => a.cameraId === id);

check("constants", () => {
  eq(DEFAULT_TARGET_FPS, 5);
  eq(MIN_USEFUL_FPS, 1);
  eq(MAX_TARGET_FPS, 30);
  eq(MAX_FRAME_LAG_MS, 2000);
  eq([...DETECT_PRIORITIES], ["normal", "armed"]);
});

// ---------------------------------------------------------------- refusals

check("THE FEARED ONE: an unmeasured chip is refused, never assumed", () => {
  const plan = planDetectSchedule(cams(16), null);
  eq(plan.ok, false);
  eq(plan.code, "unmeasured_capacity");
  // The refusal has to say what was missing, not just fail.
  eq(/measured/.test(plan.message), true);
});

check("capacity that is not a positive number is refused", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "80"]) {
    const plan = planDetectSchedule(cams(2), bad);
    eq(plan.ok, false, `capacity ${String(bad)}`);
    eq(plan.code, "bad_capacity", `capacity ${String(bad)}`);
  }
});

check("no cameras is refused", () => {
  eq(planDetectSchedule([], 80).code, "no_cameras");
  eq(planDetectSchedule(null, 80).code, "no_cameras");
});

check("a camera listed twice is refused, not silently merged", () => {
  const plan = planDetectSchedule(
    [{ cameraId: "gate" }, { cameraId: "gate" }], 80);
  eq(plan.ok, false);
  eq(plan.code, "duplicate_camera");
  eq(/gate/.test(plan.message), true);
});

check("a malformed camera is refused, naming it where it can", () => {
  const bad = [
    [null, "not an object"],
    [[], "an array"],
    [{}, "no id"],
    [{ cameraId: "" }, "empty id"],
    [{ cameraId: "c", targetFps: 0.5 }, "below the floor"],
    [{ cameraId: "c", targetFps: 31 }, "above the ceiling"],
    [{ cameraId: "c", targetFps: "5" }, "a string rate"],
    [{ cameraId: "c", targetFps: Number.NaN }, "NaN"],
    [{ cameraId: "c", priority: "urgent" }, "unknown priority"],
  ];
  for (const [camera, what] of bad) {
    const plan = planDetectSchedule([camera], 80);
    eq(plan.ok, false, what);
    eq(plan.code === "bad_camera" || plan.code === "duplicate_camera", true, what);
  }
});

check("THE FEARED ONE: too many cameras refuses AND says how many fit", () => {
  // 17 cameras cannot all reach 1 fps on a 16 fps box.
  const plan = planDetectSchedule(cams(17), 16);
  eq(plan.ok, false);
  eq(plan.code, "over_capacity");
  eq(plan.watchableCameras, 16);
});

check("the floor is a cliff, not a slope", () => {
  // Exactly at the floor is a plan; a hair under it is a refusal. The point of
  // MIN_USEFUL_FPS is that there is no "nearly watched".
  const exact = planDetectSchedule(cams(16), 16);
  eq(exact.ok, true);
  eq(granted(exact).every((f) => f === 1), true);
  eq(planDetectSchedule(cams(16), 15.999).code, "over_capacity");
});

// ------------------------------------------------------------ the happy path

check("when everything fits, everything gets what it asked for", () => {
  const plan = planDetectSchedule(cams(16), 80);
  eq(plan.ok, true);
  eq(plan.degraded, false);
  eq(granted(plan).every((f) => f === 5), true);
  eq(plan.usedFps, 80);
  eq(plan.assignments.every((a) => a.degraded === false), true);
});

check("targetFps defaults to 5, and the interval is exactly 1000/fps", () => {
  const plan = planDetectSchedule([{ cameraId: "a" }, { cameraId: "b", targetFps: 3 }], 80);
  eq(byId(plan, "a").targetFps, 5);
  eq(byId(plan, "a").intervalMs, 200);
  close(byId(plan, "b").intervalMs, 333.3333333, 1e-6);
});

check("assignments come back in the caller's order, not sorted", () => {
  const plan = planDetectSchedule(
    [{ cameraId: "z", targetFps: 2 }, { cameraId: "a", targetFps: 9 }, { cameraId: "m", targetFps: 5 }],
    80);
  eq(plan.assignments.map((a) => a.cameraId), ["z", "a", "m"]);
});

// ------------------------------------------------------------- degradation

check("THE FEARED ONE: under pressure nobody is dropped and nobody starves", () => {
  // 16 cameras, a chip that can only do 40 fps. Every camera must still be
  // watched: the failure is 12 cameras at 5 and 4 at nothing.
  const plan = planDetectSchedule(cams(16), 40);
  eq(plan.ok, true);
  eq(plan.assignments.length, 16);
  eq(plan.degraded, true);
  eq(granted(plan).every((f) => f === 2.5), true);
  eq(granted(plan).every((f) => f >= MIN_USEFUL_FPS), true);
});

check("THE FEARED ONE: a plan never adds up to more chip than the box has", () => {
  // Awkward divisions are where a rounded-up share overcommits the chip.
  for (const [n, capacityFps] of [[3, 10], [7, 10], [16, 40], [13, 41.7], [9, 20.0001], [11, 11]]) {
    const plan = planDetectSchedule(cams(n), capacityFps);
    eq(plan.ok, true, `${n} cameras on ${capacityFps}`);
    const total = plan.assignments.reduce((sum, a) => sum + a.grantedFps, 0);
    eq(total <= capacityFps + 1e-9, true, `${n} cameras on ${capacityFps}: ${total} > ${capacityFps}`);
    eq(plan.assignments.every((a) => a.grantedFps >= MIN_USEFUL_FPS), true,
      `${n} cameras on ${capacityFps}: someone fell under the floor`);
  }
});

check("a camera asking for less than its share does not hoard the surplus", () => {
  // Max-min fairness: the modest camera takes 2, and the other two split the
  // remaining 10 rather than being held to 4 each.
  const plan = planDetectSchedule(
    [{ cameraId: "modest", targetFps: 2 }, { cameraId: "a", targetFps: 8 }, { cameraId: "b", targetFps: 8 }],
    12);
  eq(byId(plan, "modest").grantedFps, 2);
  eq(byId(plan, "modest").degraded, false);
  eq(byId(plan, "a").grantedFps, 5);
  eq(byId(plan, "b").grantedFps, 5);
});

check("an armed camera holds its rate while the normals give way", () => {
  const plan = planDetectSchedule(
    [{ cameraId: "gate", priority: "armed" }, ...cams(5).map((c) => ({ ...c }))],
    15);
  eq(byId(plan, "gate").grantedFps, 5);
  eq(byId(plan, "gate").degraded, false);
  eq(byId(plan, "cam1").grantedFps, 2);
  eq(plan.degraded, true);
});

check("armed gives way too, but only once the normals are on the floor", () => {
  // Two armed at 5 and five normals: 12 fps cannot hold both. The normals go
  // to the floor (5 fps between them) and the armed pair share the other 7.
  const plan = planDetectSchedule(
    [{ cameraId: "gate", priority: "armed" }, { cameraId: "dock", priority: "armed" }, ...cams(5)],
    12);
  eq(plan.ok, true);
  eq(byId(plan, "cam1").grantedFps, 1);
  eq(byId(plan, "gate").grantedFps, 3.5);
  eq(byId(plan, "dock").grantedFps, 3.5);
  eq(byId(plan, "gate").degraded, true);
});

check("armed alone still degrades rather than refusing", () => {
  const plan = planDetectSchedule(cams(4, 5, "armed"), 10);
  eq(plan.ok, true);
  eq(granted(plan).every((f) => f === 2.5), true);
});

// ------------------------------------------------------ frame pacing

const ask = (o) => shouldProcessFrame({ nowMs: o.frameAtMs, ...o });

check("the first frame is always due", () => {
  const d = ask({ frameAtMs: 1000, dueAtMs: null, intervalMs: 200 });
  eq(d.process, true);
  eq(d.reason, "due");
  eq(d.nextDueAtMs, 1200);
});

check("a frame inside the interval is too soon, and the cursor does not move", () => {
  const d = ask({ frameAtMs: 1100, dueAtMs: 1200, intervalMs: 200 });
  eq(d.process, false);
  eq(d.reason, "too_soon");
  eq(d.nextDueAtMs, 1200);
});

check("a frame exactly on the interval is due", () => {
  eq(ask({ frameAtMs: 1200, dueAtMs: 1200, intervalMs: 200 }).process, true);
});

check("an out-of-order frame is skipped, not analysed", () => {
  const d = ask({ frameAtMs: 900, dueAtMs: 1200, intervalMs: 200 });
  eq(d.process, false);
  eq(d.reason, "too_soon");
});

check("THE FEARED ONE: a stale frame is dropped, never analysed late", () => {
  // The intruder left three minutes ago. Analysing this frame produces an
  // alert with an honest-looking timestamp and no value whatsoever.
  const d = shouldProcessFrame({
    frameAtMs: 1000, dueAtMs: 1000, intervalMs: 200, nowMs: 1000 + 180_000,
  });
  eq(d.process, false);
  eq(d.reason, "stale");
  eq(d.lagMs, 180_000);
  eq(d.nextDueAtMs, 1000);
});

check("THE FEARED ONE: even the very first frame can be stale", () => {
  // Otherwise a camera that reconnects after an outage replays old footage as
  // if it were happening now.
  const d = shouldProcessFrame({
    frameAtMs: 1000, dueAtMs: null, intervalMs: 200, nowMs: 1000 + 10_000,
  });
  eq(d.process, false);
  eq(d.reason, "stale");
  eq(d.nextDueAtMs, null);
});

check("THE FEARED ONE: a camera whose clock runs fast is not blinded", () => {
  // A frame from the future is clock skew, not lag. Calling it stale would
  // silently stop watching that camera entirely.
  const d = shouldProcessFrame({
    frameAtMs: 5000, dueAtMs: null, intervalMs: 200, nowMs: 1000,
  });
  eq(d.process, true);
  eq(d.reason, "due");
  eq(d.lagMs, -4000);
});

check("the lag ceiling is exclusive, and overridable", () => {
  eq(shouldProcessFrame({ frameAtMs: 0, dueAtMs: null, intervalMs: 200, nowMs: MAX_FRAME_LAG_MS }).process, true);
  eq(shouldProcessFrame({ frameAtMs: 0, dueAtMs: null, intervalMs: 200, nowMs: MAX_FRAME_LAG_MS + 1 }).reason, "stale");
  eq(shouldProcessFrame({ frameAtMs: 0, dueAtMs: null, intervalMs: 200, nowMs: 500, maxLagMs: 100 }).reason, "stale");
});

check("THE FEARED ONE: a fractional rate stays fractional over an hour", () => {
  // 7 fps out of a 30 fps substream. Remembering the last frame ANALYSED would
  // lock onto every 5th frame and deliver 6 fps for an hour — the plan says 7,
  // the box does 6, and nothing reports the gap.
  const intervalMs = 1000 / 7;
  const frameGapMs = 1000 / 30;
  let dueAtMs = null;
  let processed = 0;
  const frames = 30 * 3600;
  for (let k = 0; k < frames; k++) {
    const frameAtMs = k * frameGapMs;
    const d = shouldProcessFrame({ frameAtMs, dueAtMs, intervalMs, nowMs: frameAtMs });
    if (d.process) processed++;
    dueAtMs = d.nextDueAtMs;
  }
  // 7 fps for an hour, within one frame of the boundary.
  close(processed, 7 * 3600, 1, "frames analysed in an hour");
});

check("recovery after a stall returns to the rate, it does not burst", () => {
  // The stream was dead for a minute. The cursor owes 300 frames at 5 fps; a
  // catch-up burst would analyse a minute of stale footage at full speed.
  const intervalMs = 200;
  const d = shouldProcessFrame({
    frameAtMs: 60_000, dueAtMs: 200, intervalMs, nowMs: 60_000,
  });
  eq(d.process, true);
  eq(d.nextDueAtMs, 60_200);
});

check("a schedule's interval feeds the pacer unchanged", () => {
  // The two halves have to compose: whatever planDetectSchedule granted is
  // what the pacer runs at.
  const plan = planDetectSchedule(cams(3, 5), 10);
  const { intervalMs, grantedFps } = plan.assignments[0];
  eq(grantedFps, 3.333);
  let dueAtMs = null;
  let processed = 0;
  for (let k = 0; k < 30 * 600; k++) {
    const frameAtMs = k * (1000 / 30);
    const d = shouldProcessFrame({ frameAtMs, dueAtMs, intervalMs, nowMs: frameAtMs });
    if (d.process) processed++;
    dueAtMs = d.nextDueAtMs;
  }
  close(processed / 600, grantedFps, 0.01, "measured fps over ten minutes");
});

report("detectSchedule");
