/** Review page pure module (A3 slice 2, REVIEW-UI-SPEC.md section 1). The
 *  failures feared: a gap drawn too thin to see (so the strip says "recorded"
 *  over a hole), today's future drawn as a gap, a URL built from unchecked
 *  response text, and the storage path reaching the page. */
// localizeNoticeLines (below) reads the system's local time, exactly as the
// browser it runs in would — like the page's own localTime, it takes no zone
// argument. Pinned here, before any Date is built, the same way
// reviewPage.harness.mjs pins it for the same reason: a machine in another
// zone must see the same "9/22, 5:55 PM" this suite asserts.
process.env.TZ = "America/New_York";
import {
  layoutCoverage, fractionToInstant, instantToFraction, describeGap, planPlayback,
  formatBytes, planExportOffer, monthCalendar, timeOptions, rangeAround, friendlyProblem,
  clipProgress, recordedDays, eventMarkers, hiddenNote, localizeNoticeLines, answerSummary,
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

check("layout: a nodata run carries through as a nodata bar", () => {
  const out = layoutCoverage(body([
    run("nodata", DAY_START, "2026-09-11T06:00:00.000Z"),
    run("recorded", "2026-09-11T06:00:00.000Z", DAY_END),
  ]));
  eq(out.bars.map((b) => [b.kind, b.left, b.width, b.widened, b.gapReason, b.gapSource]),
    [["nodata", 0, 0.25, false, null, null], ["recorded", 0.25, 0.75, false, null, null]],
    "nodata geometry, never widened, no gap fields");
});

check("THE FEARED ONE: a narrow nodata run is never widened; a narrow gap beside it still is", () => {
  // Same 30 s width on both, so the only thing that can explain a difference
  // is the kind — nodata is never-held time, not a failure, and must not be
  // dressed up as one just because it happens to be thin.
  const out = layoutCoverage(body([
    run("nodata", DAY_START, "2026-09-11T00:00:30.000Z"),
    run("recorded", "2026-09-11T00:00:30.000Z", "2026-09-11T10:00:00.000Z"),
    run("gap", "2026-09-11T10:00:00.000Z", "2026-09-11T10:00:30.000Z"),
    run("recorded", "2026-09-11T10:00:30.000Z", DAY_END),
  ]));
  const nodataBar = out.bars[0];
  const gapBar = out.bars[2];
  eq([nodataBar.kind, nodataBar.width, nodataBar.widened],
    ["nodata", 30_000 / 86_400_000, false], "nodata keeps its true, sub-minimum width");
  eq([gapBar.kind, gapBar.width, gapBar.widened],
    ["gap", 0.004, true], "the same-width gap is still widened to visible");
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

await check("formatBytes always carries its unit and never reads 1000.0", () => {
  for (const [n, want] of [
    [0, "0 B"], [999, "999 B"], [1000, "1.0 KB"], [1500, "1.5 KB"], [999949, "999.9 KB"],
    [999950, "1.0 MB"], [66064951, "66.1 MB"], [999949999, "999.9 MB"], [999950000, "1.00 GB"],
    [4294967295, "4.29 GB"],
  ]) eq(formatBytes(n), want, `${n}`);
  for (const bad of [-1, 1.5, NaN, Infinity, "5", null, undefined, 2 ** 53, {}]) {
    eq(formatBytes(bad), null, `refused: ${String(bad)}`);
  }
});

const planBody = (over = {}) => ({
  ok: true, cameraId: "cam-1",
  requested: { startUtc: "2026-09-11T10:00:30.000Z", endUtc: "2026-09-11T10:04:30.000Z" },
  delivered: { startUtc: "2026-09-11T10:00:00.000Z", endUtc: "2026-09-11T10:05:00.000Z" },
  fileCount: 3, totalBytes: 2200, recordedSeconds: 120, gapSeconds: 120,
  gaps: [{ startUtc: "2026-09-11T10:02:00.000Z", endUtc: "2026-09-11T10:04:00.000Z", reason: "camera_offline", source: "logged" }],
  ...over,
});
const unreadable = { action: "error", code: "bad_response", message: "the recorder sent something unreadable" };

await check("planExportOffer turns a plan into an offer with the size in words", () => {
  eq(planExportOffer(planBody()), {
    action: "offer", fileCount: 3, totalBytes: 2200, size: "2.2 KB",
    deliveredStartUtc: "2026-09-11T10:00:00.000Z", deliveredEndUtc: "2026-09-11T10:05:00.000Z", gapCount: 1,
  }, "the offer, keys in order");
  eq(planExportOffer(planBody({ gaps: [] })).gapCount, 0, "no gaps");
});

await check("THE FEARED ONE: a storage path in the body never reaches the offer", () => {
  const offer = planExportOffer(planBody({ path: "/srv/disk0/cam-1/1.mp4", files: [{ path: "/srv/x.mp4" }] }));
  eq(JSON.stringify(offer).includes("/srv"), false, "nothing copied past the named fields");
  eq(Object.keys(offer), ["action", "fileCount", "totalBytes", "size", "deliveredStartUtc", "deliveredEndUtc", "gapCount"], "exactly the named keys");
});

await check("planExportOffer passes refusals through and refuses what it cannot trust", () => {
  eq(planExportOffer({ ok: false, code: "export_too_large", message: "too big" }),
    { action: "error", code: "export_too_large", message: "too big" }, "a refusal, copied");
  eq(planExportOffer({ ok: false, code: 7, message: "m" }), { action: "error", code: "bad_response", message: "m" }, "code falls back alone");
  eq(planExportOffer({ ok: false, code: "c" }), { action: "error", code: "c", message: "the recorder sent something unreadable" }, "message falls back alone");
  for (const [what, body] of [
    ["null", null], ["an array", [planBody()]], ["a string", "ok"], ["ok 'true'", planBody({ ok: "true" })],
    ["no files", planBody({ fileCount: 0 })], ["fractional count", planBody({ fileCount: 1.5 })],
    ["count as text", planBody({ fileCount: "3" })], ["blank bytes", planBody({ totalBytes: null })],
    ["negative bytes", planBody({ totalBytes: -1 })], ["no delivered", planBody({ delivered: null })],
    ["delivered array", planBody({ delivered: [] })],
    ["delivered unparsable", planBody({ delivered: { startUtc: "soon", endUtc: "2026-09-11T10:05:00.000Z" } })],
    ["delivered inverted", planBody({ delivered: { startUtc: "2026-09-11T10:05:00.000Z", endUtc: "2026-09-11T10:00:00.000Z" } })],
    ["delivered empty", planBody({ delivered: { startUtc: "2026-09-11T10:05:00.000Z", endUtc: "2026-09-11T10:05:00.000Z" } })],
    ["gaps missing", planBody({ gaps: undefined })], ["gaps object", planBody({ gaps: {} })],
  ]) eq(planExportOffer(body), unreadable, what);
});

/* ── the friendly Review page: a calendar, time dropdowns, Save video and
 *    Teach the AI. The failures feared here: a calendar that drops the 31st or
 *    shifts a day across a time zone, a dropdown that hides the last quarter
 *    hour of a day, a length chip that asks the recorder for footage from the
 *    future, and a refusal shown to the user in the recorder's own jargon. ─── */

const NY = "America/New_York";
const SEP_START = "2026-09-11T04:00:00.000Z"; // local midnight, America/New_York
const SEP_END = "2026-09-12T04:00:00.000Z";

// === monthCalendar ===

await check("calendar: a month is a Sunday-first grid with the recorded days marked", () => {
  const cal = monthCalendar(2026, 9, ["2026-09-01", "2026-09-11", "2026-09-30"]);
  eq(Object.keys(cal), ["year", "month", "label", "weeks"], "keys in order");
  eq(cal.label, "September 2026", "label in plain words");
  eq(cal.weeks.every((w) => Array.isArray(w) && w.length === 7), true, "every week has seven cells");
  eq(cal.weeks[0][0], null, "the 1st is a Tuesday, so Sunday is blank");
  eq(cal.weeks[0][1], null, "and Monday is blank");
  eq(cal.weeks[0][2], { day: "2026-09-01", dayOfMonth: 1, recorded: true }, "the 1st, recorded");
  eq(Object.keys(cal.weeks[0][2]), ["day", "dayOfMonth", "recorded"], "cell keys in order");
  eq(cal.weeks[0][3], { day: "2026-09-02", dayOfMonth: 2, recorded: false }, "the 2nd, nothing recorded");
});

await check("THE FEARED ONE: no day of the month is dropped off the grid", () => {
  for (const [y, m, days] of [[2026, 9, 30], [2026, 1, 31], [2026, 2, 28], [2024, 2, 29],
    [2026, 12, 31], [2026, 8, 31], [2026, 11, 30]]) {
    const cells = monthCalendar(y, m, []).weeks.flat().filter((c) => c !== null);
    eq(cells.length, days, `${y}-${m} has ${days} days`);
    eq(cells[0].dayOfMonth, 1, `${y}-${m} starts at 1`);
    eq(cells.at(-1).dayOfMonth, days, `${y}-${m} ends at ${days}`);
    eq(cells.at(-1).day, `${y}-${String(m).padStart(2, "0")}-${days}`, `${y}-${m} last day string`);
  }
});

await check("calendar: February 2026 is exactly four weeks, with no padding at all", () => {
  const cal = monthCalendar(2026, 2, []);
  eq(cal.weeks.length, 4, "four rows");
  eq(cal.weeks.flat().filter((c) => c === null).length, 0, "no blanks");
  eq(cal.weeks[0][0].day, "2026-02-01", "the 1st is a Sunday");
});

await check("calendar: the recorded list is matched as whole day strings, never parsed", () => {
  const cal = monthCalendar(2026, 9, ["2026-09-11", "2026-9-12", "2026-09-13T00:00:00Z", "2026-10-01", 11, null, {}]);
  const on = cal.weeks.flat().filter((c) => c !== null && c.recorded).map((c) => c.day);
  eq(on, ["2026-09-11"], "only the exact day string counts");
});

await check("calendar: refusals are values, never throws", () => {
  for (const [what, args] of [
    ["month 0", [2026, 0, []]], ["month 13", [2026, 13, []]], ["month text", [2026, "9", []]],
    ["month fractional", [2026, 9.5, []]], ["year text", ["2026", 9, []]], ["year fractional", [2026.5, 9, []]],
    ["year too small", [1969, 9, []]], ["year too large", [10000, 9, []]],
    ["recordedDays missing", [2026, 9, undefined]], ["recordedDays object", [2026, 9, {}]],
    ["recordedDays string", [2026, 9, "2026-09-11"]], ["nothing", []],
  ]) eq(isError(monthCalendar(...args)), true, what);
});

// === timeOptions ===

const optRuns = [run("recorded", "2026-09-11T08:00:00Z", "2026-09-11T12:00:00Z")];

await check("times: a whole day of quarter hours, plus the end of the day", () => {
  const { options } = timeOptions(optRuns, SEP_START, SEP_END, 15, NY);
  eq(options.length, 97, "96 quarter hours and the end of the day");
  eq(Object.keys(options[0]), ["value", "hhmm", "label", "recorded"], "keys in order");
  eq(options[0], { value: SEP_START, hhmm: "00:00", label: "12:00 AM", recorded: false }, "the first option");
  eq(options[1].hhmm, "00:15", "a quarter hour later");
  eq(options[1].label, "12:15 AM", "and it reads as one");
  eq(options[96], { value: SEP_END, hhmm: "24:00", label: "Midnight (end of day)", recorded: false }, "the last option is the end of the day");
});

await check("THE FEARED ONE: the last quarter hour of the day is reachable", () => {
  const { options } = timeOptions(optRuns, SEP_START, SEP_END, 15, NY);
  eq(options.at(-2).hhmm, "23:45", "11:45 PM is offered");
  eq(options.at(-2).label, "11:45 PM", "in plain words");
  eq(options.at(-1).value, SEP_END, "and the end of the day after it, as an instant");
});

await check("times: only the instants inside a recorded run say recorded", () => {
  const { options } = timeOptions(optRuns, SEP_START, SEP_END, 15, NY);
  const byHhmm = Object.fromEntries(options.map((o) => [o.hhmm, o.recorded]));
  eq(byHhmm["04:00"], true, "08:00Z is 4 AM local, inside the run");
  eq(byHhmm["07:45"], true, "the last quarter hour inside it");
  eq(byHhmm["08:00"], false, "12:00Z is the run's end: half-open, so not recorded");
  eq(byHhmm["03:45"], false, "just before it starts");
  eq(options.filter((o) => o.recorded).length, 16, "four hours of quarter hours");
});

await check("times: a gap run is not a recording", () => {
  const { options } = timeOptions([run("gap", "2026-09-11T08:00:00Z", "2026-09-11T12:00:00Z")], SEP_START, SEP_END, 15, NY);
  eq(options.some((o) => o.recorded), false, "nothing is offered as recorded");
});

await check("times: the end-of-day option reads the last instant of the day, not the next day", () => {
  const all = [run("recorded", SEP_START, SEP_END)];
  const { options } = timeOptions(all, SEP_START, SEP_END, 60, NY);
  eq(options.at(-1).recorded, true, "recorded right up to midnight");
  eq(options.length, 25, "24 hours and the end of the day");
});

await check("THE FEARED ONE: a 25 hour fall-back day offers all 25 hours", () => {
  const start = "2026-11-01T04:00:00.000Z";
  const end = "2026-11-02T05:00:00.000Z";
  const { options } = timeOptions([], start, end, 60, NY);
  eq(options.length, 26, "25 hours and the end of the day");
  const oneAm = options.filter((o) => o.label === "1:00 AM");
  eq(oneAm.length, 2, "1 AM happens twice and both are offered");
  eq(oneAm[0].value, "2026-11-01T05:00:00.000Z", "the first 1 AM is an instant of its own");
  eq(oneAm[1].value, "2026-11-01T06:00:00.000Z", "and so is the second");
});

await check("times: a 23 hour spring-forward day skips the hour that does not exist", () => {
  const { options } = timeOptions([], "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 60, NY);
  eq(options.length, 24, "23 hours and the end of the day");
  eq(options.some((o) => o.label === "2:00 AM"), false, "2 AM never happens that day");
});

await check("times: labels are plain ASCII, so they render the same everywhere", () => {
  const { options } = timeOptions(optRuns, SEP_START, SEP_END, 15, NY);
  for (const o of options) {
    eq(/^[ -~]+$/.test(o.label), true, `ASCII label: ${JSON.stringify(o.label)}`);
    eq(/^([01][0-9]|2[0-4]):[0-5][0-9]$/.test(o.hhmm), true, `hhmm: ${o.hhmm}`);
  }
});

await check("times: refusals are values, never throws", () => {
  for (const [what, args] of [
    ["no day start", [[], "soon", SEP_END, 15, NY]],
    ["no day end", [[], SEP_START, "later", 15, NY]],
    ["inverted day", [[], SEP_END, SEP_START, 15, NY]],
    ["empty day", [[], SEP_START, SEP_START, 15, NY]],
    ["step 0", [[], SEP_START, SEP_END, 0, NY]],
    ["step negative", [[], SEP_START, SEP_END, -15, NY]],
    ["step fractional", [[], SEP_START, SEP_END, 1.5, NY]],
    ["step too large", [[], SEP_START, SEP_END, 721, NY]],
    ["step as text", [[], SEP_START, SEP_END, "15", NY]],
    ["runs not an array", [{}, SEP_START, SEP_END, 15, NY]],
    ["zone missing", [[], SEP_START, SEP_END, 15, undefined]],
    ["zone not a zone", [[], SEP_START, SEP_END, 15, "Mars/Olympus"]],
    ["nothing", []],
  ]) eq(isError(timeOptions(...args)), true, what);
});

await check("times: a run it cannot read is ignored, not guessed at", () => {
  const { options } = timeOptions([null, "recorded", { kind: "recorded" },
    { kind: "recorded", startUtc: "soon", endUtc: "2026-09-11T12:00:00Z" },
    run("recorded", "2026-09-11T08:00:00Z", "2026-09-11T09:00:00Z")], SEP_START, SEP_END, 60, NY);
  eq(options.filter((o) => o.recorded).length, 1, "only the run that reads as a run counts");
});

// === rangeAround ===

const NOW = "2026-09-11T12:00:00.000Z";

await check("moment: a length chip centres the window on what is being watched", () => {
  const r = rangeAround("2026-09-11T10:00:00Z", 5, NOW, SEP_START, SEP_END);
  eq(Object.keys(r), ["startUtc", "endUtc", "lengthMin", "clamped"], "keys in order");
  eq(r, { startUtc: "2026-09-11T09:57:30.000Z", endUtc: "2026-09-11T10:02:30.000Z", lengthMin: 5, clamped: false }, "five minutes around it");
});

await check("THE FEARED ONE: a window is never asked for footage from the future", () => {
  const r = rangeAround("2026-09-11T11:59:00Z", 60, NOW, SEP_START, SEP_END);
  eq(r.endUtc, NOW, "it stops at now");
  eq(r.startUtc, "2026-09-11T11:00:00.000Z", "and keeps its length by shifting back");
  eq(r.lengthMin, 60, "a full hour, all of it in the past");
  eq(r.clamped, true, "and it says it moved");
});

await check("THE FEARED ONE: a window never runs into the day before or after", () => {
  const early = rangeAround("2026-09-11T04:01:00Z", 60, NOW, SEP_START, SEP_END);
  eq(early.startUtc, SEP_START, "the day's first instant");
  eq(early.endUtc, "2026-09-11T05:00:00.000Z", "an hour of it");
  eq(early.clamped, true, "moved");
  const yesterday = rangeAround("2026-09-10T20:00:00Z", 5, "2026-09-12T00:00:00Z", "2026-09-10T04:00:00.000Z", "2026-09-11T04:00:00.000Z");
  eq(yesterday.endUtc, "2026-09-10T20:02:30.000Z", "a past day is not clipped to now");
});

await check("moment: a window longer than the day it can have takes what there is", () => {
  const r = rangeAround("2026-09-11T05:00:00Z", 60, "2026-09-11T04:30:00.000Z", SEP_START, SEP_END);
  eq(r, { startUtc: SEP_START, endUtc: "2026-09-11T04:30:00.000Z", lengthMin: 30, clamped: true }, "half an hour is all there is");
});

await check("moment: a moment outside the day is pulled into it rather than refused", () => {
  const after = rangeAround("2026-09-11T20:00:00Z", 5, NOW, SEP_START, SEP_END);
  eq(after.endUtc, NOW, "later than now: the window ends at now");
  eq(after.startUtc, "2026-09-11T11:55:00.000Z", "and holds its length");
});

await check("moment: refusals are values, never throws", () => {
  for (const [what, args] of [
    ["moment does not parse", ["soon", 5, NOW, SEP_START, SEP_END]],
    ["length 0", ["2026-09-11T10:00:00Z", 0, NOW, SEP_START, SEP_END]],
    ["length negative", ["2026-09-11T10:00:00Z", -5, NOW, SEP_START, SEP_END]],
    ["length as text", ["2026-09-11T10:00:00Z", "5", NOW, SEP_START, SEP_END]],
    ["length infinite", ["2026-09-11T10:00:00Z", Infinity, NOW, SEP_START, SEP_END]],
    ["now does not parse", ["2026-09-11T10:00:00Z", 5, "now", SEP_START, SEP_END]],
    ["day inverted", ["2026-09-11T10:00:00Z", 5, NOW, SEP_END, SEP_START]],
    ["the day has not started", ["2026-09-11T10:00:00Z", 5, "2026-09-11T03:00:00Z", SEP_START, SEP_END]],
    ["nothing", []],
  ]) eq(isError(rangeAround(...args)), true, what);
});

// === friendlyProblem ===

await check("problems: the recorder's codes are said in plain words", () => {
  eq(friendlyProblem("export_too_large", "range exceeds limit"),
    "That is more video than one download can hold. Pick a shorter length.", "too large");
  eq(friendlyProblem("export_nothing_recorded", "no segments"), "Nothing was recorded in that stretch.", "nothing recorded");
  eq(friendlyProblem("export_reaches_recording", "open segment"),
    "That stretch runs into footage still being recorded. Pick a time that has finished.", "reaches the open segment");
  eq(friendlyProblem("window_in_future", "the window starts at 2026-09-17T00:00:00.000Z, which is not before now"),
    "That day has not happened yet.", "a future day");
  eq(friendlyProblem("window_too_large", "3628800 seconds"), "That is too long a stretch to ask for at once.", "too long");
  eq(friendlyProblem("inverted_window", "end is not after start"), "Pick an end time after the start time.", "inverted");
  eq(friendlyProblem("no_such_camera", "cam-9"), "That camera is not set up on this recorder.", "unknown camera");
  eq(friendlyProblem("bad_camera_id", "Invalid camera id"), "That camera is not set up on this recorder.", "and a bad id reads the same");
  eq(friendlyProblem("no_cameras", "none configured"), "No cameras are set up on this recorder yet.", "no cameras");
  eq(friendlyProblem("forbidden", "role"), "This account is not allowed to do that.", "forbidden");
  eq(friendlyProblem("bad_response", "unreadable"), "The recorder sent something this page could not read.", "bad response");
  eq(friendlyProblem("unreachable", ""), "Cannot reach the recorder.", "unreachable");
});

await check("THE FEARED ONE: a code it does not know is reported, never guessed at", () => {
  eq(friendlyProblem("solar_flare", "the sun did it"),
    "Something went wrong: the sun did it (solar_flare).", "an unknown code keeps both");
  eq(friendlyProblem("solar_flare", ""), "Something went wrong (solar_flare).", "no message to add");
  eq(friendlyProblem("solar_flare", 7), "Something went wrong (solar_flare).", "a message that is not text is left out");
  eq(friendlyProblem("", ""), "Something went wrong.", "nothing to say at all");
  eq(friendlyProblem(null, null), "Something went wrong.", "nothing at all");
  eq(friendlyProblem("constructor", ""), "Something went wrong (constructor).", "a prototype key is not a code");
});

await check("problems: what it says is plain ASCII and bounded in length", () => {
  const long = friendlyProblem("solar_flare", "x".repeat(5000));
  eq(long.length <= 240, true, `bounded, got ${long.length}`);
  eq(/^[ -~]+$/.test(long), true, "ASCII");
  eq(friendlyProblem("x y", "a\nb\tc"), "Something went wrong: a b c (x y).", "control characters become spaces");
});

// === clipProgress ===

const clip = (startUtc, endUtc, scenes, expected = []) => ({
  id: "c" + startUtc, cameraId: "cam-1", startUtc, endUtc, scenes, expected,
});
const expected = (kind, count) => ({ kind, fromUtc: "2026-09-11T10:00:00Z", toUtc: "2026-09-11T10:01:00Z", count });

await check("teaching: what has been taught so far, and what is still short", () => {
  const p = clipProgress({ version: 1, clips: [
    clip("2026-09-11T10:00:00Z", "2026-09-11T10:05:00Z", ["person"], [expected("person", 3)]),
    clip("2026-09-11T11:00:00Z", "2026-09-11T11:30:00Z", ["empty", "night"]),
    clip("2026-09-11T12:00:00Z", "2026-09-11T12:02:00Z", ["vehicle"], [expected("vehicle", 2), expected("person", 1)]),
  ] });
  eq(Object.keys(p), ["clipCount", "personCount", "vehicleCount", "emptyMinutes",
    "personsStillNeeded", "emptyMinutesStillNeeded", "skipped"], "keys in order");
  eq(p.clipCount, 3, "three clips");
  eq(p.personCount, 4, "four people expected across them");
  eq(p.vehicleCount, 2, "two vehicles");
  eq(p.emptyMinutes, 30, "half an hour of empty scene");
  eq(p.personsStillNeeded, 16, "20 is the gate, so 16 short");
  eq(p.emptyMinutesStillNeeded, 30, "an hour is the gate, so 30 minutes short");
  eq(p.skipped, 0, "nothing skipped");
});

await check("teaching: the gates stop at zero, they never go negative", () => {
  const p = clipProgress({ version: 1, clips: [
    clip("2026-09-11T10:00:00Z", "2026-09-11T12:00:00Z", ["empty", "person"], [expected("person", 25)]),
  ] });
  eq(p.personsStillNeeded, 0, "enough people");
  eq(p.emptyMinutesStillNeeded, 0, "enough empty footage");
  eq(p.emptyMinutes, 120, "two hours of it");
});

await check("THE FEARED ONE: a clip it cannot read is counted as skipped, not as zero", () => {
  const p = clipProgress({ version: 1, clips: [
    clip("2026-09-11T10:00:00Z", "2026-09-11T10:30:00Z", ["empty"]),
    null, "a clip", { id: "x" },
    clip("soon", "2026-09-11T10:30:00Z", ["empty"]),
    clip("2026-09-11T10:30:00Z", "2026-09-11T10:00:00Z", ["empty"]),
    clip("2026-09-11T13:00:00Z", "2026-09-11T13:10:00Z", "empty"),
    clip("2026-09-11T14:00:00Z", "2026-09-11T14:10:00Z", ["person"], [{ kind: "person", count: 1.5 }]),
    clip("2026-09-11T15:00:00Z", "2026-09-11T15:10:00Z", ["person"], "two"),
  ] });
  eq(p.clipCount, 1, "one clip could be counted");
  eq(p.skipped, 8, "and eight could not");
  eq(p.emptyMinutes, 30, "only the readable one counts");
  eq(p.personCount, 0, "nothing is assumed about the rest");
});

await check("teaching: partial minutes are counted, then floored once at the end", () => {
  const p = clipProgress({ version: 1, clips: [
    clip("2026-09-11T10:00:00Z", "2026-09-11T10:00:40Z", ["empty"]),
    clip("2026-09-11T11:00:00Z", "2026-09-11T11:00:40Z", ["empty"]),
  ] });
  eq(p.emptyMinutes, 1, "40 s twice is a minute and a third, floored to 1");
});

await check("teaching: refusals are values, never throws", () => {
  for (const [what, v] of [["null", null], ["a string", "library"], ["an array", []],
    ["no clips", { version: 1 }], ["clips as an object", { version: 1, clips: {} }],
    ["nothing", undefined]]) eq(isError(clipProgress(v)), true, what);
});

// === recordedDays ===

await check("month: which local days have footage, for the calendar's dots", () => {
  eq(recordedDays([run("recorded", "2026-09-11T08:00:00Z", "2026-09-11T09:00:00Z")], NY),
    { days: ["2026-09-11"] }, "one day");
  eq(recordedDays([run("recorded", "2026-09-12T02:00:00Z", "2026-09-12T06:00:00Z")], NY),
    { days: ["2026-09-11", "2026-09-12"] }, "10 PM to 2 AM names both local days");
  eq(recordedDays([run("recorded", "2026-09-12T04:00:00.000Z", "2026-09-13T04:00:00.000Z")], NY),
    { days: ["2026-09-12"] }, "exactly one local day, half-open");
  eq(recordedDays([run("recorded", "2026-09-11T08:00:00Z", "2026-09-11T09:00:00Z"),
    run("recorded", "2026-09-11T10:00:00Z", "2026-09-11T11:00:00Z")], NY),
    { days: ["2026-09-11"] }, "no duplicates");
  eq(recordedDays([run("gap", "2026-09-11T08:00:00Z", "2026-09-11T09:00:00Z")], NY), { days: [] }, "a gap is not footage");
});

await check("THE FEARED ONE: a month-long run is walked in days, not in milliseconds", () => {
  const { days } = recordedDays([run("recorded", "2026-08-15T12:00:00Z", "2026-09-20T12:00:00Z")], NY);
  eq(days.length, 37, "36 days of footage touch 37 local days");
  eq(days[0], "2026-08-15", "the first");
  eq(days.at(-1), "2026-09-20", "the last");
});

await check("month: a run it cannot read is ignored, and refusals are values", () => {
  eq(recordedDays([null, "recorded", { kind: "recorded" },
    { kind: "recorded", startUtc: "soon", endUtc: "2026-09-11T12:00:00Z" },
    run("recorded", "2026-09-11T10:00:00Z", "2026-09-11T09:00:00Z"),
    run("recorded", "2026-09-11T08:00:00Z", "2026-09-11T09:00:00Z")], NY),
    { days: ["2026-09-11"] }, "only what reads as a run counts");
  for (const [what, args] of [["runs not an array", [{}, NY]], ["not a zone", [[], "Mars/Olympus"]],
    ["no zone", [[], undefined]], ["nothing", []]]) eq(isError(recordedDays(...args)), true, what);
});

/* ── known objects (D: KNOWN-OBJECTS-SPEC.md) ─────────────────────────────
 * The failures feared here: a mark that only LOOKS unsuppressed because the
 * field it should carry is missing rather than null; a wrong plural on the
 * hidden count; a notice's UTC instant either left unconverted or converted
 * to garbage; and an owner's answer read from a shape close to but not
 * exactly the one contracts/knownObjects.ts actually produces. ────────────── */

// === eventMarkers: suppressedBy passthrough ===

await check("markers: suppressedBy is always present, never merely absent", () => {
  const events = [
    { id: "e1", cameraId: "cam-1", kind: "person", firstUtc: "2026-09-22T22:00:00Z", lastUtc: "2026-09-22T22:00:04Z", suppressedBy: "cam-1:person:1758000000000" },
    { id: "e2", cameraId: "cam-1", kind: "person", firstUtc: "2026-09-22T22:05:00Z", lastUtc: "2026-09-22T22:05:04Z", suppressedBy: null },
    { id: "e3", cameraId: "cam-1", kind: "person", firstUtc: "2026-09-22T22:10:00Z", lastUtc: "2026-09-22T22:10:04Z" },
  ];
  const { markers } = eventMarkers(events, "2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z", null);
  eq(markers.map((m) => m.suppressedBy), ["cam-1:person:1758000000000", null, null],
    "set, cleared, and never-set events read the same way: a string or null, never undefined");
});

// === hiddenNote ===

await check("hiddenNote: a plain count, singular and plural, nothing for zero or bad input", () => {
  eq(hiddenNote(1), "1 hidden - known object", "one");
  eq(hiddenNote(3), "3 hidden - known objects", "several");
  eq(hiddenNote(0), null, "THE FEARED ONE: zero hidden says nothing, rather than an empty-looking row");
  for (const bad of [-1, 1.5, NaN, Infinity, "3", null, undefined, {}]) {
    eq(hiddenNote(bad), null, `refused: ${String(bad)}`);
  }
});

// === localizeNoticeLines ===

await check("localizeNoticeLines: every UTC instant in a line becomes the viewer's local time", () => {
  const lines = [
    "Seen as a person 34 times at the same spot, never moving, from 2026-09-22T21:55:07.748Z to 2026-09-23T00:20:31.210Z.",
    "Highest score as a person: 0.80.",
  ];
  const out = localizeNoticeLines(lines);
  eq(out[0], "Seen as a person 34 times at the same spot, never moving, from 9/22, 5:55 PM to 9/22, 8:20 PM.",
    `converted: ${out[0]}`);
  eq(out[1], "Highest score as a person: 0.80.", "a line with no instant in it is unchanged");
});

await check("localizeNoticeLines: midnight and noon read as 12, not 0; refusals are values", () => {
  eq(localizeNoticeLines(["at 2026-09-22T04:00:00.000Z"])[0], "at 9/22, 12:00 AM", "midnight local");
  eq(localizeNoticeLines(["at 2026-09-22T16:00:00.000Z"])[0], "at 9/22, 12:00 PM", "noon local");
  eq(localizeNoticeLines([7, null, undefined])[0], "", "a non-string line becomes empty, not thrown");
  eq(localizeNoticeLines([7, null, undefined]).length, 3, "one output per input line, in order");
  eq(localizeNoticeLines(null), [], "not an array at all: nothing, never a throw");
  eq(localizeNoticeLines("a string"), [], "a bare string is not a list of lines");
});

// === answerSummary ===

await check("answerSummary: plain words, never the two verdicts a click would have shown", () => {
  const belongs = answerSummary({ belongs: true, atUtc: "2026-09-23T01:10:00.000Z", by: "tech" });
  eq(belongs, "tech said it belongs there, 9/22, 9:10 PM.", belongs);
  const not = answerSummary({ belongs: false, atUtc: "2026-09-23T01:10:00.000Z", by: "austin" });
  eq(not, "austin said it should not be there, 9/22, 9:10 PM.", not);
  eq(/umbrella|false|fake/i.test(belongs + not), false, "no verdict word sneaks in either way");
});

await check("answerSummary: no answer yet, or one that cannot be trusted, is null", () => {
  for (const bad of [
    null, undefined, "answered", 7, [],
    { belongs: true, atUtc: "2026-09-23T01:10:00.000Z", by: "" },
    { belongs: "yes", atUtc: "2026-09-23T01:10:00.000Z", by: "tech" },
    { belongs: true, atUtc: "soon", by: "tech" },
    { belongs: true, by: "tech" },
    { atUtc: "2026-09-23T01:10:00.000Z", by: "tech" },
  ]) eq(answerSummary(bad), null, `refused: ${JSON.stringify(bad) ?? String(bad)}`);
});

report("reviewClient");
