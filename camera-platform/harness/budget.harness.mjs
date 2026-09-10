/** Bitrate budgeting on dual 8 TB. The failure feared: a camera drifting above
 *  its share, unnoticed, until someone asks for day 28 and it is gone. */
import { computePerCameraBudget, checkAgainstBudget, withRingHeadroom } from "../dist/budget.js";
import { usableBytesFromRaw, TERABYTE } from "../dist/retention.js";
import { check, eq, close, throws, report } from "./_assert.mjs";

console.log("budget");

// The actual build: 2x 8 TB raw, 10% filesystem overhead, 85% ring fill.
const USABLE = withRingHeadroom(usableBytesFromRaw(16 * TERABYTE), 0.85);
const budget = computePerCameraBudget(30, USABLE, 16);
const cams = (kbps) => Array.from({ length: 16 }, (_, i) => ({ cameraId: `cam-${i + 1}`, bitrateKbps: kbps }));

check("dual 8 TB gives every camera about 2.35 Mbps for a 30-day target", () => {
  eq(budget.kind, "ok", "kind");
  close(budget.perCameraKbps, 2353, 20, "per-camera kbps");
  close(budget.totalKbps, 37654, 300, "fleet kbps");
});

check("4MP @ 15 fps sits well inside the budget", () => {
  const r = checkAgainstBudget(cams(1300), budget);
  eq(r.kind, "ok", "kind");
  eq(r.over.length, 0, "nobody over");
  if (r.utilisation > 0.6) throw new Error(`expected plenty of room, utilisation ${r.utilisation}`);
  close(r.projectedDays, 54, 2, "projected days");
});

check("4MP @ 30 fps still holds 30 days, with less room", () => {
  const r = checkAgainstBudget(cams(2000), budget);
  eq(r.over.length, 0, "still within the per-camera share");
  if (r.projectedDays < 30) throw new Error(`projected ${r.projectedDays} days`);
  close(r.projectedDays, 35, 2, "projected days");
});

check("THE FEARED ONE: CBR at 4 Mbps breaks the 30-day promise, and says so", () => {
  const r = checkAgainstBudget(cams(4000), budget);
  eq(r.kind, "ok", "still a measurement, not an error");
  eq(r.over.length, 16, "every camera over its share");
  if (r.projectedDays >= 30) throw new Error("should not reach 30 days");
  close(r.projectedDays, 17.6, 1, "projected days");
  if (r.utilisation <= 1) throw new Error("utilisation must exceed 1");
});

check("THE FEARED ONE: one drifting camera is found by name and ranked", () => {
  const mixed = [...cams(1300).slice(0, 15), { cameraId: "cam-gate", bitrateKbps: 6000 }];
  const r = checkAgainstBudget(mixed, budget);
  eq(r.over.length, 1, "exactly one over");
  eq(r.over[0].cameraId, "cam-gate", "named");
  close(r.over[0].ratio, 2.55, 0.05, "using 255% of its share");
  if (r.projectedDays < 30) throw new Error("fleet still holds 30 days despite the outlier");
});

check("over-budget cameras are ranked worst first", () => {
  const mixed = [
    { cameraId: "mild", bitrateKbps: 2500 },
    { cameraId: "worst", bitrateKbps: 8000 },
    { cameraId: "middling", bitrateKbps: 4000 },
    ...cams(1000).slice(0, 13),
  ];
  const r = checkAgainstBudget(mixed, budget);
  eq(r.over.map((o) => o.cameraId), ["worst", "middling", "mild"], "ranked by ratio");
});

check("a camera over its share does NOT by itself mean the target is missed", () => {
  const mixed = [...cams(1000).slice(0, 15), { cameraId: "busy", bitrateKbps: 5000 }];
  const r = checkAgainstBudget(mixed, budget);
  if (r.over.length !== 1) throw new Error("expected one over");
  if (r.projectedDays < 30) throw new Error("others are under, so the fleet is fine");
  if (r.utilisation >= 1) throw new Error("fleet utilisation should still be under 1");
});

check("THE FEARED ONE: an unmeasured camera refuses the projection", () => {
  const mixed = [...cams(1300).slice(0, 15), { cameraId: "cam-new", bitrateKbps: null }];
  const r = checkAgainstBudget(mixed, budget);
  eq(r.kind, "refused", "refused rather than a reassuring wrong number");
  eq(r.unmeasured, ["cam-new"], "named");
});

check("nonsense inputs are refused", () => {
  eq(computePerCameraBudget(0, USABLE, 16).kind, "refused", "zero days");
  eq(computePerCameraBudget(30, 0, 16).kind, "refused", "no disk");
  eq(computePerCameraBudget(30, USABLE, 0).kind, "refused", "no cameras");
  eq(computePerCameraBudget(30, USABLE, 1.5).kind, "refused", "fractional cameras");
  eq(checkAgainstBudget([], budget).kind, "refused", "empty fleet");
  eq(checkAgainstBudget(cams(0), budget).kind, "refused", "all-zero bitrate is a fault");
});

check("ring headroom is explicit and bounded", () => {
  close(withRingHeadroom(100, 0.85), 85, 1e-9, "85%");
  close(withRingHeadroom(100, 1), 100, 1e-9, "full is allowed but not the default");
  throws(() => withRingHeadroom(100, 0), "zero");
  throws(() => withRingHeadroom(100, 1.2), "over 1");
});

check("halving the target doubles the per-camera budget", () => {
  const b15 = computePerCameraBudget(15, USABLE, 16);
  close(b15.perCameraKbps / budget.perCameraKbps, 2, 1e-9, "ratio");
});

report("budget");
