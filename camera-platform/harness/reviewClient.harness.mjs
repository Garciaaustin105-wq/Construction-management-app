/** Review page pure module (A3 slice 2, REVIEW-UI-SPEC.md section 1). The
 *  failures feared: a gap drawn too thin to see (so the strip says "recorded"
 *  over a hole), today's future drawn as a gap, a URL built from unchecked
 *  response text, and the storage path reaching the page. */
import {
  layoutCoverage, fractionToInstant, instantToFraction, describeGap, planPlayback,
} from "../agent/ui/review-client.mjs";
import { check, eq, same, report } from "./_assert.mjs";

console.log("reviewClient");

const DAY_START = "2026-09-11T00:00:00.000Z";
const DAY_END = "2026-09-12T00:00:00.000Z";
const run = (kind, startUtc, endUtc, extra = {}) => ({
  startUtc, endUtc, kind,
  segmentCount: kind === "recorded" ? 1 : 0,
  includesOpen: false,
  gapReason: kind === "gap" ? "camera_offline" : null,
  gapSource: kind === "gap" ? "logged" : null,
  ...extra,
});
const body = (runs, effectiveEnd = DAY_END, requestedEnd = DAY_END) => ({
  ok: true, cameraId: "cam-1",
  requested: { startUtc: DAY_START, endUtc: requestedEnd },
  effective: { startUtc: DAY_START, endUtc: effectiveEnd },
  clippedToNow: effectiveEnd !== requestedEnd,
  buckets: 96, runs,
});
const isError = (v) => v !== null && typeof v === "object" && typeof v.error === "string"
  && Object.keys(v).length === 1;

// === layoutCoverage ===

check("layout: a whole recorded day is one full-width bar, keys in order", () => {
  const out = layoutCoverage(body([run("recorded", DAY_START, DAY_END)]));
  eq(out, { bars: [{
    kind: "recorded", startUtc: DAY_START, endUtc: DAY_END, left: 0, width: 1,
    widened: false, gapReason: null, gapSource: null,
  }] }, "bars");
});

check("layout: recorded / gap / recorded at true proportions", () => {
  const out = layoutCoverage(body([
    run("recorded", DAY_START, "2026-09-11T06:00:00.000Z"),
    run("gap", "2026-09-11T06:00:00.000Z", "2026-09-11T12:00:00.000Z", { gapReason: "disk_full", gapSource: "inferred" }),
    run("recorded", "2026-09-11T12:00:00.000Z", DAY_END),
  ]));
  eq(out.bars.map((b) => [b.kind, b.left, b.width, b.widened]),
    [["recorded", 0, 0.25, false], ["gap", 0.25, 0.25, false], ["recorded", 0.5, 0.5, false]], "geometry");
  eq([out.bars[1].gapReason, out.bars[1].gapSource], ["disk_full", "inferred"], "gap fields copied");
});

check("THE FEARED ONE: a 40 s outage in a 24 h strip is widened to visible", () => {
  const out = layoutCoverage(body([
    run("recorded", DAY_START, "2026-09-11T10:00:00.000Z"),
    run("gap", "2026-09-11T10:00:00.000Z", "2026-09-11T10:00:40.000Z"),
    run("recorded", "2026-09-11T10:00:40.000Z", DAY_END),
  ]));
  const gap = out.bars[1];
  eq([gap.kind, gap.width, gap.widened], ["gap", 0.004, true], "widened to the default minimum");
  eq(gap.left, 36_000_000 / 86_400_000, "left stays at its true start");
  eq([out.bars[0].widened, out.bars[2].widened], [false, false], "recorded bars never widen");
  eq(out.bars[2].width, (86_400_000 - 36_040_000) / 86_400_000, "the recording beside it keeps its true width");
});

check("layout: a custom minGapFraction, and a gap already wider is left alone", () => {
  const runs = [
    run("recorded", DAY_START, "2026-09-11T12:00:00.000Z"),
    run("gap", "2026-09-11T12:00:00.000Z", "2026-09-11T13:12:00.000Z"),   // 0.05 of the day
    run("recorded", "2026-09-11T13:12:00.000Z", DAY_END),
  ];
  eq([layoutCoverage(body(runs), 0.1).bars[1].width, layoutCoverage(body(runs), 0.1).bars[1].widened], [0.1, true], "0.1");
  eq([layoutCoverage(body(runs), 0.01).bars[1].width, layoutCoverage(body(runs), 0.01).bars[1].widened], [0.05, false], "0.01");
  eq(layoutCoverage(body(runs), 0).bars[1].widened, false, "0 widens nothing");
});

check("layout: a thin gap at the right edge is shifted left, not pushed off the strip", () => {
  const out = layoutCoverage(body([
    run("recorded", DAY_START, "2026-09-11T23:59:50.000Z"),
    run("gap", "2026-09-11T23:59:50.000Z", DAY_END),
  ]));
  const gap = out.bars[1];
  eq([gap.width, gap.left, gap.widened], [0.004, 1 - 0.004, true], "right edge");
});

check("THE FEARED ONE: today's tail after now is a future bar, not a gap", () => {
  const nowish = "2026-09-11T18:00:00.000Z";
  const out = layoutCoverage(body([run("recorded", DAY_START, nowish)], nowish, DAY_END));
  eq(out.bars.length, 2, "one run plus the future");
  eq(out.bars[0].width, 0.75, "recording is 3/4 of the REQUESTED day, not all of the effective one");
  eq(out.bars[1], {
    kind: "future", startUtc: nowish, endUtc: DAY_END, left: 0.75, width: 0.25,
    widened: false, gapReason: null, gapSource: null,
  }, "future bar");
});

check("layout: a thin future tail is never widened", () => {
  const nowish = "2026-09-11T23:59:59.000Z";
  const out = layoutCoverage(body([run("recorded", DAY_START, nowish)], nowish, DAY_END));
  eq([out.bars[1].kind, out.bars[1].widened, out.bars[1].width], ["future", false, 1 / 86400], "future");
});

check("layout: no future bar when the window is not clipped", () => {
  const out = layoutCoverage(body([run("recorded", DAY_START, DAY_END)]));
  eq(out.bars.some((b) => b.kind === "future"), false, "none");
});

check("layout: times are compared as instants, not strings", () => {
  // Same instants as the day, spelled without milliseconds.
  const out = layoutCoverage({
    ok: true,
    requested: { startUtc: "2026-09-11T00:00:00Z", endUtc: "2026-09-12T00:00:00.000Z" },
    effective: { startUtc: "2026-09-11T00:00:00.000Z", endUtc: "2026-09-12T00:00:00Z" },
    runs: [run("recorded", "2026-09-11T00:00:00Z", "2026-09-11T12:00:00Z"),
      run("gap", "2026-09-11T12:00:00.000Z", "2026-09-12T00:00:00Z")],
  });
  eq(out.bars.map((b) => b.width), [0.5, 0.5], "accepted");
  eq(out.bars[0].startUtc, "2026-09-11T00:00:00Z", "copied through as given");
});

check("THE FEARED ONE: runs that do not tile the effective range are refused", () => {
  const cases = {
    "hole between runs": [run("recorded", DAY_START, "2026-09-11T06:00:00.000Z"), run("recorded", "2026-09-11T07:00:00.000Z", DAY_END)],
    "overlap": [run("recorded", DAY_START, "2026-09-11T07:00:00.000Z"), run("gap", "2026-09-11T06:00:00.000Z", DAY_END)],
    "starts late": [run("recorded", "2026-09-11T01:00:00.000Z", DAY_END)],
    "ends early": [run("recorded", DAY_START, "2026-09-11T23:00:00.000Z")],
    "runs past the end": [run("recorded", DAY_START, "2026-09-12T01:00:00.000Z")],
    "unknown kind": [run("maybe", DAY_START, DAY_END)],
    "unparseable run time": [run("recorded", DAY_START, "yesterday")],
    "empty": [],
  };
  for (const [name, runs] of Object.entries(cases)) {
    eq(isError(layoutCoverage(body(runs))), true, name);
  }
});

check("layout: malformed bodies and ranges are refused as values", () => {
  const good = body([run("recorded", DAY_START, DAY_END)]);
  const bad = {
    "null": null,
    "string": "ok",
    "no requested": { ...good, requested: undefined },
    "no effective": { ...good, effective: undefined },
    "runs not an array": { ...good, runs: "all of it" },
    "requested backwards": { ...good, requested: { startUtc: DAY_END, endUtc: DAY_START } },
    "requested empty": { ...good, requested: { startUtc: DAY_START, endUtc: DAY_START } },
    "effective starts elsewhere": { ...good, effective: { startUtc: "2026-09-11T01:00:00.000Z", endUtc: DAY_END } },
    "effective past requested": { ...good, effective: { startUtc: DAY_START, endUtc: "2026-09-12T01:00:00.000Z" } },
    "effective empty": { ...good, effective: { startUtc: DAY_START, endUtc: DAY_START } },
    "unparseable requested": { ...good, requested: { startUtc: "soon", endUtc: DAY_END } },
  };
  for (const [name, b] of Object.entries(bad)) eq(isError(layoutCoverage(b)), true, name);
  for (const g of [-0.1, 1, 2, Number.NaN, Infinity, "0.1"]) {
    eq(isError(layoutCoverage(good, g)), true, `minGapFraction ${String(g)}`);
  }
});

check("layout: never throws on hostile input", () => {
  for (const b of [undefined, 0, [], { runs: [null] }, { requested: 5, effective: 5, runs: [1] },
    body([null]), body([{ kind: "gap" }])]) {
    eq(isError(layoutCoverage(b)), true, JSON.stringify(b) ?? "undefined");
  }
});

// === fractionToInstant ===

check("click: fractions map into the range, flooring to the millisecond", () => {
  same(fractionToInstant(0, DAY_START, DAY_END), { utc: DAY_START }, "0");
  same(fractionToInstant(0.5, DAY_START, DAY_END), { utc: "2026-09-11T12:00:00.000Z" }, "0.5");
  same(fractionToInstant(0.25, DAY_START, DAY_END), { utc: "2026-09-11T06:00:00.000Z" }, "0.25");
  same(fractionToInstant(1 / 3, "2026-09-11T00:00:00.000Z", "2026-09-11T00:00:00.010Z"),
    { utc: "2026-09-11T00:00:00.003Z" }, "floored, not rounded");
});

check("THE FEARED ONE: a click at the very right edge is inside the half-open range", () => {
  same(fractionToInstant(1, DAY_START, DAY_END), { utc: "2026-09-11T23:59:59.999Z" }, "end - 1 ms");
  same(fractionToInstant(0.9999999999999, DAY_START, DAY_END), { utc: "2026-09-11T23:59:59.999Z" }, "just under");
});

check("click: out-of-strip fractions clamp", () => {
  same(fractionToInstant(-0.3, DAY_START, DAY_END), { utc: DAY_START }, "left of the strip");
  same(fractionToInstant(7, DAY_START, DAY_END), { utc: "2026-09-11T23:59:59.999Z" }, "right of the strip");
});

check("click: refusals are values", () => {
  for (const f of [Number.NaN, Infinity, -Infinity, "0.5", null, undefined]) {
    eq(isError(fractionToInstant(f, DAY_START, DAY_END)), true, `fraction ${String(f)}`);
  }
  eq(isError(fractionToInstant(0.5, DAY_END, DAY_START)), true, "backwards range");
  eq(isError(fractionToInstant(0.5, DAY_START, DAY_START)), true, "empty range");
  eq(isError(fractionToInstant(0.5, "today", DAY_END)), true, "unparseable start");
  eq(isError(fractionToInstant(0.5, DAY_START, null)), true, "missing end");
});

// === instantToFraction ===

check("playhead: position within the range, both ends inclusive", () => {
  eq(instantToFraction(DAY_START, DAY_START, DAY_END), 0, "start");
  eq(instantToFraction("2026-09-11T18:00:00Z", DAY_START, DAY_END), 0.75, "18:00");
  eq(instantToFraction(DAY_END, DAY_START, DAY_END), 1, "end");
});

check("THE FEARED ONE: a playhead outside the day is hidden, not pinned to an edge", () => {
  eq(instantToFraction("2026-09-10T23:59:59.999Z", DAY_START, DAY_END), null, "before");
  eq(instantToFraction("2026-09-12T00:00:00.001Z", DAY_START, DAY_END), null, "after");
});

check("playhead: bad input is null, never NaN", () => {
  eq(instantToFraction("noon", DAY_START, DAY_END), null, "unparseable instant");
  eq(instantToFraction(undefined, DAY_START, DAY_END), null, "missing instant");
  eq(instantToFraction(DAY_START, DAY_START, DAY_START), null, "empty range");
  eq(instantToFraction(DAY_START, DAY_END, DAY_START), null, "backwards range");
  eq(instantToFraction(DAY_START, "x", DAY_END), null, "unparseable start");
});

// === describeGap ===

check("gap labels: every reason in plain words", () => {
  eq(describeGap("camera_offline", "logged"), "Camera offline", "camera_offline");
  eq(describeGap("appliance_offline", "logged"), "Recorder offline", "appliance_offline");
  eq(describeGap("disk_full", "logged"), "Not recorded: disk full", "disk_full");
  eq(describeGap("evicted_by_retention", "logged"), "Deleted by the retention policy", "evicted_by_retention");
  eq(describeGap("tampered", "logged"), "Tamper detected", "tampered");
  eq(describeGap("unknown", "logged"), "Not recorded: reason unknown", "unknown");
});

check("gap labels: an unlogged hole says so; anything unrecognised is 'reason unknown'", () => {
  eq(describeGap("unknown", "inferred"), "Not recorded: reason unknown (nothing was logged for this hole)", "inferred");
  eq(describeGap("camera_offline", "inferred"), "Camera offline (nothing was logged for this hole)", "inferred with a reason");
  eq(describeGap("solar_flare", "logged"), "Not recorded: reason unknown", "unrecognised");
  eq(describeGap(undefined, undefined), "Not recorded: reason unknown", "missing");
  eq(describeGap("constructor", null), "Not recorded: reason unknown", "a prototype key is not a reason");
  eq(describeGap("toString", "logged"), "Not recorded: reason unknown", "nor is toString");
});

check("gap labels: ASCII only", () => {
  for (const r of ["camera_offline", "appliance_offline", "disk_full", "evicted_by_retention", "tampered", "unknown"]) {
    for (const s of ["logged", "inferred"]) {
      eq(/^[\x20-\x7e]+$/.test(describeGap(r, s)), true, `${r}/${s}`);
    }
  }
});

// === planPlayback ===

const UNREADABLE = { action: "error", code: "bad_response", message: "the recorder sent something unreadable" };
const segmentBody = (resolution) => ({ ok: true, cameraId: "cam-1", at: "2026-09-11T10:00:30.000Z", resolution });
const SEGMENT = {
  kind: "segment", cameraId: "cam-1", segmentId: "cam-1.1789120800000",
  segmentStartUtc: "2026-09-11T10:00:00.000Z", segmentEndUtc: "2026-09-11T10:01:00.000Z", offsetSeconds: 30,
};

check("plan: a segment plays from its offset, keys in order", () => {
  eq(planPlayback(segmentBody(SEGMENT)), {
    action: "play", src: "/segments/cam-1.1789120800000", offsetSeconds: 30,
    segmentStartUtc: "2026-09-11T10:00:00.000Z", segmentEndUtc: "2026-09-11T10:01:00.000Z",
  }, "play");
  eq(planPlayback(segmentBody({ ...SEGMENT, offsetSeconds: 0 })).offsetSeconds, 0, "offset 0 is valid");
});

check("THE FEARED ONE: the storage path never reaches a play action", () => {
  const out = planPlayback(segmentBody({ ...SEGMENT, path: "cam-1/1789120800000.mp4" }));
  eq(out.action, "play", "still plays");
  eq(JSON.stringify(out).includes("mp4"), false, "no path anywhere in the action");
  eq(Object.keys(out), ["action", "src", "offsetSeconds", "segmentStartUtc", "segmentEndUtc"], "exact keys");
});

check("THE FEARED ONE: a segmentId that is not an id never becomes a URL", () => {
  for (const id of ["../../etc/passwd", "cam-1.1789120800000?x=1", "cam 1.5", "cam-1.01", "cam-1.",
    ".5", "cam-1.5/../6", "a".repeat(65) + ".5", "cam-1.-5", "cam-1.1e3", 42, null, undefined]) {
    eq(planPlayback(segmentBody({ ...SEGMENT, segmentId: id })), UNREADABLE, `segmentId ${JSON.stringify(id)}`);
  }
  eq(planPlayback(segmentBody({ ...SEGMENT, segmentId: "a".repeat(64) + ".0" })).action, "play", "64 chars and .0 are fine");
});

check("plan: a bad offset is unreadable, not a seek to NaN", () => {
  for (const o of [-1, Number.NaN, Infinity, "30", null, undefined]) {
    eq(planPlayback(segmentBody({ ...SEGMENT, offsetSeconds: o })), UNREADABLE, `offset ${String(o)}`);
  }
});

check("plan: a gap is labelled, with the next recording when known", () => {
  eq(planPlayback(segmentBody({ kind: "gap", cameraId: "cam-1", reason: "camera_offline", source: "logged",
    nextRecordedUtc: "2026-09-11T10:05:00.000Z" })),
  { action: "gap", label: "Camera offline", nextRecordedUtc: "2026-09-11T10:05:00.000Z" }, "gap");
  eq(planPlayback(segmentBody({ kind: "gap", cameraId: "cam-1", reason: "unknown", source: "inferred",
    nextRecordedUtc: null })),
  { action: "gap", label: "Not recorded: reason unknown (nothing was logged for this hole)", nextRecordedUtc: null }, "no next");
  eq(planPlayback(segmentBody({ kind: "gap", reason: "tampered", source: "logged", nextRecordedUtc: 12 })).nextRecordedUtc,
    null, "a non-string next is null");
});

check("plan: the open segment points at live; the future says so", () => {
  eq(planPlayback(segmentBody({ kind: "recording", cameraId: "cam-1", segmentStartUtc: "2026-09-11T11:58:00.000Z" })),
    { action: "live", segmentStartUtc: "2026-09-11T11:58:00.000Z" }, "live");
  eq(planPlayback(segmentBody({ kind: "future", cameraId: "cam-1", nowUtc: "2026-09-11T12:00:00.000Z" })),
    { action: "future", nowUtc: "2026-09-11T12:00:00.000Z" }, "future");
});

check("plan: a refusal envelope carries its code and message", () => {
  eq(planPlayback({ ok: false, code: "bad_instant", message: "at must be an ISO instant" }),
    { action: "error", code: "bad_instant", message: "at must be an ISO instant" }, "copied");
  eq(planPlayback({ ok: false, code: 404 }),
    { action: "error", code: "bad_response", message: "the recorder sent something unreadable" }, "non-strings replaced");
  eq(planPlayback({ ok: false, message: "only a message" }),
    { action: "error", code: "bad_response", message: "only a message" }, "each field on its own");
});

check("plan: anything else is unreadable, never thrown", () => {
  for (const b of [null, undefined, "ok", 7, [], {}, { ok: "true", resolution: SEGMENT }, { ok: true },
    { ok: true, resolution: null }, { ok: true, resolution: "segment" }, segmentBody({ kind: "rewind" }),
    segmentBody({})]) {
    eq(planPlayback(b), UNREADABLE, JSON.stringify(b) ?? "undefined");
  }
});

report("reviewClient");
