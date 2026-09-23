/**
 * Events retention planning (contracts/eventRetention.ts). Pure: no I/O, no
 * real events.db, no real index — see eventRetentionRun.harness.mjs for that.
 *
 * THE FEARED FAILURE: an event deleted while any of its video remains. Every
 * check here is either that failure directly, or a boundary that would slide
 * into it a millisecond off.
 */
import { planEventRetention, EVENT_RETENTION_MARGIN_MS } from "../dist/eventRetention.js";
import { check, eq, report } from "./_assert.mjs";

console.log("eventRetention");

const T0 = Date.parse("2026-09-23T00:00:00.000Z");
const cam = (cameraId, events) => ({ cameraId, events });

check("the margin is what the spec names", () => {
  eq(EVENT_RETENTION_MARGIN_MS, 5000, "5 s covers a 1 s-precision segment name and a late arrival stamp");
});

check("a camera with footage prunes at footageFromMs minus the margin", () => {
  const plan = planEventRetention({
    cameras: [cam("cam1", 10)],
    footageFromMs: { cam1: T0 },
  });
  eq(plan.prune, [{ cameraId: "cam1", beforeMs: T0 - 5000 }], "the threshold, not the raw footage start");
  eq(plan.keep, [], "nothing kept whole");
});

check("THE FEARED ONE: an event just outside the margin (older) is where the threshold cuts", () => {
  const plan = planEventRetention({ cameras: [cam("cam1", 1)], footageFromMs: { cam1: T0 } });
  const beforeMs = plan.prune[0].beforeMs;
  // The contract only computes the threshold; whether last_ms < beforeMs is
  // the I/O layer's job (deleteEndedBefore). Here the boundary itself is
  // checked: it sits exactly marginMs before the footage, not at it and not
  // a margin further.
  eq(beforeMs, T0 - EVENT_RETENTION_MARGIN_MS, "just outside the margin: deleted");
  eq(beforeMs + EVENT_RETENTION_MARGIN_MS, T0, "just inside the margin (at footageFromMs itself): kept, since last_ms < beforeMs is false at the footage start");
});

check("straddling: the threshold is always strictly before the footage start, never at or after it", () => {
  // An event that straddles the oldest video has last_ms >= footageFromMs,
  // which is always >= beforeMs (beforeMs = footageFromMs - marginMs, and
  // marginMs is never negative below), so it can never be deleted by this
  // plan's threshold alone.
  for (const marginMs of [0, 1, 5000, 3_600_000]) {
    const plan = planEventRetention({ cameras: [cam("cam1", 1)], footageFromMs: { cam1: T0 }, marginMs });
    eq(plan.prune[0].beforeMs <= T0, true, `margin ${marginMs}: threshold never after the footage start`);
  }
});

check("a camera with no footage in the index is kept whole, and says why", () => {
  const plan = planEventRetention({ cameras: [cam("cam1", 42)], footageFromMs: { cam1: null } });
  eq(plan.prune, [], "nothing pruned");
  eq(plan.keep, [{ cameraId: "cam1", events: 42, reason: "no_footage_in_index" }], "kept, with a reason and its count");
});

check("a camera missing from footageFromMs entirely is the same as null: kept, not zero", () => {
  const plan = planEventRetention({ cameras: [cam("cam1", 3)], footageFromMs: {} });
  eq(plan.keep, [{ cameraId: "cam1", events: 3, reason: "no_footage_in_index" }], "THE FEARED ONE: absent is not footage starting at the epoch");
});

check("NaN and a negative horizon count as missing, never as a real instant", () => {
  for (const bad of [NaN, -1, -1000]) {
    const plan = planEventRetention({ cameras: [cam("cam1", 5)], footageFromMs: { cam1: bad } });
    eq(plan.keep, [{ cameraId: "cam1", events: 5, reason: "no_footage_in_index" }], `footageFromMs ${bad}: treated as missing`);
    eq(plan.prune, [], `footageFromMs ${bad}: nothing pruned`);
  }
});

check("THE FEARED ONE: a zero horizon is a REAL instant (the epoch), never mistaken for missing", () => {
  // The spec is explicit: "a non-finite or negative footageFromMs counts as
  // missing, never 0" - a naive falsy check (`if (!footageMs)`) would treat
  // 0 as missing too, which would keep every event of a camera whose index
  // legitimately answered "recording since the epoch" forever.
  const zero = planEventRetention({ cameras: [cam("cam1", 5)], footageFromMs: { cam1: 0 } });
  eq(zero.keep, [], "0 is not treated as missing");
  eq(zero.prune, [{ cameraId: "cam1", beforeMs: 0 - EVENT_RETENTION_MARGIN_MS }], "and is planned against, like any other real horizon");
});

check("Infinity is refused as a horizon too - not a footage start that outlives everything", () => {
  const plan = planEventRetention({ cameras: [cam("cam1", 1)], footageFromMs: { cam1: Infinity } });
  eq(plan.keep, [{ cameraId: "cam1", events: 1, reason: "no_footage_in_index" }], "kept, not pruned against an unusable threshold");
});

check("an empty camera list plans nothing, not an error", () => {
  eq(planEventRetention({ cameras: [], footageFromMs: {} }), { prune: [], keep: [] }, "nothing to do");
});

check("several cameras are decided independently: one's footage never lends its horizon to another", () => {
  const plan = planEventRetention({
    cameras: [cam("cam1", 5), cam("cam2", 7), cam("cam3", 9)],
    footageFromMs: { cam1: T0, cam2: null, cam3: T0 - 1_000_000 },
  });
  eq(plan.prune.map((p) => p.cameraId).sort(), ["cam1", "cam3"], "the two with footage");
  eq(plan.prune.find((p) => p.cameraId === "cam1").beforeMs, T0 - 5000, "cam1's own threshold");
  eq(plan.prune.find((p) => p.cameraId === "cam3").beforeMs, T0 - 1_000_000 - 5000, "cam3's own, unrelated threshold");
  eq(plan.keep, [{ cameraId: "cam2", events: 7, reason: "no_footage_in_index" }], "only cam2, which alone has no footage");
});

check("a Map works exactly as a plain record does", () => {
  const asMap = planEventRetention({ cameras: [cam("cam1", 2), cam("cam2", 3)], footageFromMs: new Map([["cam1", T0], ["cam2", null]]) });
  const asRecord = planEventRetention({ cameras: [cam("cam1", 2), cam("cam2", 3)], footageFromMs: { cam1: T0, cam2: null } });
  eq(asMap, asRecord, "the same plan either way");
});

check("marginMs defaults to EVENT_RETENTION_MARGIN_MS but can be overridden", () => {
  const withDefault = planEventRetention({ cameras: [cam("cam1", 1)], footageFromMs: { cam1: T0 } });
  const explicit = planEventRetention({ cameras: [cam("cam1", 1)], footageFromMs: { cam1: T0 }, marginMs: EVENT_RETENTION_MARGIN_MS });
  eq(withDefault, explicit, "same result");
  const zeroMargin = planEventRetention({ cameras: [cam("cam1", 1)], footageFromMs: { cam1: T0 }, marginMs: 0 });
  eq(zeroMargin.prune[0].beforeMs, T0, "a caller asking for no margin gets none");
});

report("eventRetention");
