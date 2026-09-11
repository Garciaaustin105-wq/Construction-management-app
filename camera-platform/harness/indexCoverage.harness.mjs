/** Index rows to coverage and playback. The failures feared: a window with no
 *  recording returned as an empty list; two outages in one hole given one
 *  reason; a null-bytes segment dropped as if it were a gap; and a timeline
 *  that shows recording at an instant which playback then calls a gap. */
import { coverageFromIndex, runsAsSegments, resolvePlayback, SEAM_TOLERANCE_MS } from "../dist/indexCoverage.js";
import { buildReviewTimeline } from "../dist/timeline.js";
import { check, same, close, throws, report } from "./_assert.mjs";

console.log("indexCoverage");

const CAM = "cam-1";
const M = 60_000;
const NOW_MS = Date.UTC(2026, 8, 10, 12);
const NOW = new Date(NOW_MS).toISOString();
const B = NOW_MS - 3 * 86_400_000;      // three days ago — the exit criterion's age
const iso = (ms) => new Date(ms).toISOString();

function seg(startMs, opts = {}) {
  const open = opts.open === true;
  return {
    cameraId: opts.cameraId ?? CAM,
    startUtc: iso(startMs),
    endUtc: open ? null : iso(opts.endMs ?? startMs + M),
    path: open ? `${CAM}/.inprogress/${startMs / 1000}.mp4` : `${CAM}/${startMs}.mp4`,
    bytes: open ? null : ("bytes" in opts ? opts.bytes : 15_000_000),
    state: open ? "open" : "sealed",
    bitrateKbps: 2000,
  };
}
const run = (fromMs, count) => Array.from({ length: count }, (_, i) => seg(fromMs + i * M));
const gap = (fromMs, toMs, reason, cameraId = CAM) => ({ cameraId, startUtc: iso(fromMs), endUtc: iso(toMs), reason });
const range = (a, b) => ({ startUtc: iso(a), endUtc: iso(b) });
const rec = (a, b, segmentCount, includesOpen = false) =>
  ({ startUtc: iso(a), endUtc: iso(b), kind: "recorded", segmentCount, includesOpen, gapReason: null, gapSource: null });
const hole = (a, b, gapReason, gapSource) =>
  ({ startUtc: iso(a), endUtc: iso(b), kind: "gap", segmentCount: 0, includesOpen: false, gapReason, gapSource });
const ZERO = { camera_offline: 0, appliance_offline: 0, disk_full: 0, evicted_by_retention: 0, tampered: 0, unknown: 0 };

/** What must hold for ANY coverage, whatever the fixture. */
function invariants(cov, r, what) {
  const a = Date.parse(r.startUtc);
  const b = Date.parse(r.endUtc);
  if (!Array.isArray(cov.runs) || cov.runs.length === 0) throw new Error(`${what}: no runs — an empty 200`);
  same(cov.runs[0].startUtc, iso(a), `${what}: first run starts at the range start`);
  same(cov.runs[cov.runs.length - 1].endUtc, iso(b), `${what}: last run ends at the range end`);
  let recMs = 0;
  let gapMs = 0;
  cov.runs.forEach((x, i) => {
    const s = Date.parse(x.startUtc);
    const e = Date.parse(x.endUtc);
    if (!(e > s)) throw new Error(`${what}: run ${i} has no length`);
    if (i > 0) {
      const p = cov.runs[i - 1];
      same(x.startUtc, p.endUtc, `${what}: run ${i} starts where run ${i - 1} ended`);
      if (p.kind === "recorded" && x.kind === "recorded") throw new Error(`${what}: touching recorded runs not merged`);
      if (p.kind === "gap" && x.kind === "gap" && p.gapReason === x.gapReason && p.gapSource === x.gapSource) {
        throw new Error(`${what}: identical adjacent gaps not merged`);
      }
    }
    if (x.kind === "recorded") {
      recMs += e - s;
      if (x.gapReason !== null || x.gapSource !== null) throw new Error(`${what}: a recorded run with a gap reason`);
      if (!(x.segmentCount >= 1)) throw new Error(`${what}: a recorded run of no segments`);
    } else {
      gapMs += e - s;
      if (x.segmentCount !== 0 || x.includesOpen !== false) throw new Error(`${what}: a gap claiming segments`);
      if (x.gapSource === "inferred" && x.gapReason !== "unknown") {
        throw new Error(`${what}: an inferred gap was given a reason nobody logged: ${x.gapReason}`);
      }
      if (x.gapSource !== "inferred" && x.gapSource !== "logged") throw new Error(`${what}: gap source ${x.gapSource}`);
    }
  });
  close(cov.recordedSeconds, recMs / 1000, 1e-6, `${what}: recordedSeconds`);
  close(cov.gapSeconds, gapMs / 1000, 1e-6, `${what}: gapSeconds`);
  const byReason = Object.values(cov.gapSecondsByReason).reduce((s, v) => s + v, 0);
  close(byReason, cov.gapSeconds, 1e-6, `${what}: reasons sum to the gap total`);
  same(Object.keys(cov.gapSecondsByReason).sort(), Object.keys(ZERO).sort(), `${what}: every reason present`);
}

check("a fully recorded window is one recorded run", () => {
  const r = range(B, B + 10 * M);
  const cov = coverageFromIndex(CAM, run(B, 10), [], r, NOW);
  same(cov.runs, [rec(B, B + 10 * M, 10)], "runs");
  same([cov.recordedSeconds, cov.gapSeconds, cov.seamsBridged, cov.overlapsTruncated], [600, 0, 0, 0], "totals");
  same(cov.gapSecondsByReason, ZERO, "zero seconds of every reason — measured zeros");
  same([cov.cameraId, cov.range], [CAM, r], "echoes what it answered");
  invariants(cov, r, "full");
});

check("THE FEARED ONE: a window with no recording is a gap with a reason, not an empty list", () => {
  const r = range(B, B + 10 * M);
  const cov = coverageFromIndex(CAM, [], [], r, NOW);
  same(cov.runs, [hole(B, B + 10 * M, "unknown", "inferred")], "one inferred gap");
  same([cov.recordedSeconds, cov.gapSeconds, cov.gapSecondsByReason.unknown], [0, 600, 600], "totals");
  invariants(cov, r, "empty");

  const logged = coverageFromIndex(CAM, [], [gap(B - M, B + 20 * M, "disk_full")], r, NOW);
  same(logged.runs, [hole(B, B + 10 * M, "disk_full", "logged")], "the logged reason, clipped to the window");
});

check("THE FEARED ONE: a window straddling a logged gap shows the gap and its reason", () => {
  const segments = [...run(B, 5), ...run(B + 20 * M, 5)];
  const cov = coverageFromIndex(CAM, segments, [gap(B + 5 * M, B + 20 * M, "camera_offline")],
    range(B, B + 25 * M), NOW);
  same(cov.runs, [
    rec(B, B + 5 * M, 5),
    hole(B + 5 * M, B + 20 * M, "camera_offline", "logged"),
    rec(B + 20 * M, B + 25 * M, 5),
  ], "runs");
  same(cov.gapSecondsByReason.camera_offline, 900, "fifteen minutes offline");
});

check("THE FEARED ONE: two outages in one hole keep their own reasons", () => {
  const segments = [...run(B, 5), ...run(B + 15 * M, 5)];
  const gaps = [gap(B + 5 * M, B + 10 * M, "camera_offline"), gap(B + 12 * M, B + 15 * M, "disk_full")];
  const r = range(B, B + 20 * M);
  const cov = coverageFromIndex(CAM, segments, gaps, r, NOW);
  same(cov.runs, [
    rec(B, B + 5 * M, 5),
    hole(B + 5 * M, B + 10 * M, "camera_offline", "logged"),
    hole(B + 10 * M, B + 12 * M, "unknown", "inferred"),
    hole(B + 12 * M, B + 15 * M, "disk_full", "logged"),
    rec(B + 15 * M, B + 20 * M, 5),
  ], "an unlogged stretch between them is unknown, not borrowed from a neighbour");
  same([cov.gapSecondsByReason.camera_offline, cov.gapSecondsByReason.unknown, cov.gapSecondsByReason.disk_full],
    [300, 120, 180], "seconds by reason");
  invariants(cov, r, "two outages");
});

check("a logged gap never covers recorded time", () => {
  const segments = [...run(B, 5), ...run(B + 8 * M, 2)];
  const cov = coverageFromIndex(CAM, segments, [gap(B + 3 * M, B + 9 * M, "camera_offline")],
    range(B, B + 10 * M), NOW);
  same(cov.runs, [
    rec(B, B + 5 * M, 5),
    hole(B + 5 * M, B + 8 * M, "camera_offline", "logged"),
    rec(B + 8 * M, B + 10 * M, 2),
  ], "the recording wins where the log overlaps it");
});

check("overlapping logged gaps: the one that started earlier wins the overlap", () => {
  const segments = [...run(B, 5), ...run(B + 15 * M, 1)];
  const gaps = [gap(B + 8 * M, B + 15 * M, "disk_full"), gap(B + 5 * M, B + 12 * M, "camera_offline")];
  const cov = coverageFromIndex(CAM, segments, gaps, range(B, B + 16 * M), NOW);
  same(cov.runs.slice(1, 3), [
    hole(B + 5 * M, B + 12 * M, "camera_offline", "logged"),
    hole(B + 12 * M, B + 15 * M, "disk_full", "logged"),
  ], "earliest start first, regardless of the order supplied");
});

check("adjacent logged gaps with the same reason merge into one run", () => {
  const segments = [...run(B, 5), ...run(B + 12 * M, 1)];
  const gaps = [gap(B + 5 * M, B + 8 * M, "camera_offline"), gap(B + 8 * M, B + 12 * M, "camera_offline")];
  const cov = coverageFromIndex(CAM, segments, gaps, range(B, B + 13 * M), NOW);
  same(cov.runs[1], hole(B + 5 * M, B + 12 * M, "camera_offline", "logged"), "one band");
});

check("THE FEARED ONE: a segment whose bytes are null is still recording we hold", () => {
  const segments = [seg(B), seg(B + M, { bytes: null }), seg(B + 2 * M)];
  const cov = coverageFromIndex(CAM, segments, [], range(B, B + 3 * M), NOW);
  same(cov.runs, [rec(B, B + 3 * M, 3)], "not a gap, not skipped");
  const at = resolvePlayback(CAM, segments, [], iso(B + M + 10_000), NOW);
  same([at.kind, at.segmentId, at.offsetSeconds], ["segment", `${CAM}.${B + M}`, 10], "and it plays");
});

check("the open segment runs to now and says so", () => {
  const openStart = NOW_MS - 30_000;
  const segments = [...run(openStart - 5 * M, 5), seg(openStart, { open: true })];
  const r = range(NOW_MS - 10 * M, NOW_MS);
  const cov = coverageFromIndex(CAM, segments, [], r, NOW);
  same(cov.runs, [
    hole(NOW_MS - 10 * M, openStart - 5 * M, "unknown", "inferred"),
    rec(openStart - 5 * M, NOW_MS, 6, true),
  ], "recorded up to now, marked as still being written");
  invariants(cov, r, "open");
});

check("THE FEARED ONE: a range past now is refused — the caller clips first", () => {
  throws(() => coverageFromIndex(CAM, run(B, 1), [], range(NOW_MS - M, NOW_MS + 1), NOW), "ends after now");
});

check("a segment straddling the window edge is clipped, and still counted", () => {
  const cov = coverageFromIndex(CAM, run(B, 3), [], range(B + 30_000, B + 150_000), NOW);
  same(cov.runs, [rec(B + 30_000, B + 150_000, 3)], "clipped at both ends");
});

check("a seam of a second between segments is not an outage", () => {
  const segments = [seg(B), seg(B + M + 1_000), seg(B + 2 * M + 1_000)];
  const cov = coverageFromIndex(CAM, segments, [], range(B, B + 3 * M + 1_000), NOW);
  same(cov.runs, [rec(B, B + 3 * M + 1_000, 3)], "one run");
  same(cov.seamsBridged, 1, "counted, not absorbed silently");
});

check("the seam tolerance is a hard edge", () => {
  const at = (holeMs) => coverageFromIndex(CAM, [seg(B), seg(B + M + holeMs)], [],
    range(B, B + 2 * M + holeMs), NOW);
  same(at(SEAM_TOLERANCE_MS).runs.length, 1, "exactly the tolerance is a seam");
  const over = at(SEAM_TOLERANCE_MS + 1);
  same(over.runs[1], hole(B + M, B + M + SEAM_TOLERANCE_MS + 1, "unknown", "inferred"), "a millisecond more is a gap");
  same(over.seamsBridged, 0, "and not counted as a seam");
});

check("THE FEARED ONE: a logged gap inside a seam-sized hole is kept, not bridged", () => {
  const segments = [seg(B), seg(B + M + 2_000)];
  const cov = coverageFromIndex(CAM, segments, [gap(B + M, B + M + 2_000, "camera_offline")],
    range(B, B + 2 * M + 2_000), NOW);
  same(cov.runs[1], hole(B + M, B + M + 2_000, "camera_offline", "logged"), "the log is evidence; the seam is a guess");
  same(cov.seamsBridged, 0, "not bridged");
});

check("an overlap resolves to the later segment, whose start is measured", () => {
  // ffmpeg restarted 23 s into a segment: the first file is short but indexed as a full minute.
  const segments = [seg(B), seg(B + 23_000), seg(B + 23_000 + M)];
  const cov = coverageFromIndex(CAM, segments, [], range(B, B + 23_000 + 2 * M), NOW);
  same(cov.runs, [rec(B, B + 23_000 + 2 * M, 3)], "one run, no double-counted time");
  same(cov.overlapsTruncated, 1, "counted");
  close(cov.recordedSeconds, 143, 1e-9, "143 s, not 180");
  const at = resolvePlayback(CAM, segments, [], iso(B + 40_000), NOW);
  same([at.segmentId, at.offsetSeconds], [`${CAM}.${B + 23_000}`, 17], "the later file answers the overlap");
});

check("THE FEARED ONE: rows that cannot be true are refused, not smoothed over", () => {
  const r = range(B, B + 10 * M);
  const cases = {
    "a segment for another camera": [[seg(B, { cameraId: "cam-2" })], []],
    "a gap for another camera": [[seg(B)], [gap(B + M, B + 2 * M, "unknown", "cam-2")]],
    "a null end on a sealed segment": [[{ ...seg(B), endUtc: null }], []],
    "an end on an open segment": [[{ ...seg(B), state: "open" }], []],
    "a segment ending before it starts": [[seg(B, { endMs: B - 1 })], []],
    "a segment of no length": [[seg(B, { endMs: B })], []],
    "two open segments": [[seg(B, { open: true }), seg(B + M, { open: true })], []],
    "an open segment that is not the latest": [[seg(B, { open: true }), seg(B + M)], []],
    "an open segment starting in the future": [[seg(NOW_MS + 1, { open: true })], []],
    "two segments with one start": [[seg(B), { ...seg(B), path: `${CAM}/dup.mp4` }], []],
  };
  for (const [what, [segments, gaps]] of Object.entries(cases)) {
    throws(() => coverageFromIndex(CAM, segments, gaps, r, NOW), `coverage: ${what}`);
    throws(() => resolvePlayback(CAM, segments, gaps, iso(B + 30_000), NOW), `playback: ${what}`);
  }
  throws(() => coverageFromIndex(CAM, [], [], range(B + M, B), NOW), "an inverted range");
});

check("runsAsSegments feeds the review timeline without inventing bytes", () => {
  const segments = [...run(B, 5), ...run(B + 10 * M, 5)];
  const r = range(B, B + 15 * M);
  const cov = coverageFromIndex(CAM, segments, [gap(B + 5 * M, B + 10 * M, "tampered")], r, NOW);
  const spans = runsAsSegments(cov);
  same(spans.map((s) => [s.tier, s.startUtc, s.endUtc]), [
    ["edge", iso(B), iso(B + 5 * M)], ["gap", iso(B + 5 * M), iso(B + 10 * M)], ["edge", iso(B + 10 * M), iso(B + 15 * M)],
  ], "tiers and extents");
  same(spans[1].gapReason, "tampered", "the gap keeps its reason");
  if (spans[0].gapReason !== undefined) throw new Error("a recorded span carries a gap reason");
  for (const s of spans) {
    same([s.cameraId, s.key, s.bytes, s.codec, s.bitrateKbps], [CAM, null, null, null, null], `${s.tier} span fields`);
  }
  const timeline = buildReviewTimeline(CAM, spans, [], r, 3);
  same(timeline.buckets.map((b) => b.coverage), [1, 0, 1], "a blind third is drawn as blind");
});

check("EXIT CRITERION: play back a segment from three days ago", () => {
  const segments = [...run(B - 10 * M, 20), seg(NOW_MS - 20_000, { open: true })];
  const at = resolvePlayback(CAM, segments, [], iso(B + 30_500), NOW);
  same(at, {
    kind: "segment",
    cameraId: CAM,
    segmentId: `${CAM}.${B}`,
    path: `${CAM}/${B}.mp4`,
    segmentStartUtc: iso(B),
    segmentEndUtc: iso(B + M),
    offsetSeconds: 30.5,
  }, "the file, and where in it");
});

check("an instant exactly on a boundary belongs to the later segment", () => {
  const at = resolvePlayback(CAM, run(B, 3), [], iso(B + M), NOW);
  same([at.segmentId, at.offsetSeconds], [`${CAM}.${B + M}`, 0], "half-open intervals");
});

check("an instant in a gap says why, and where recording resumes", () => {
  const segments = [...run(B, 5), ...run(B + 20 * M, 5)];
  const gaps = [gap(B + 5 * M, B + 10 * M, "camera_offline")];
  same(resolvePlayback(CAM, segments, gaps, iso(B + 7 * M), NOW),
    { kind: "gap", cameraId: CAM, reason: "camera_offline", source: "logged", nextRecordedUtc: iso(B + 20 * M) },
    "logged");
  same(resolvePlayback(CAM, segments, gaps, iso(B + 15 * M), NOW),
    { kind: "gap", cameraId: CAM, reason: "unknown", source: "inferred", nextRecordedUtc: iso(B + 20 * M) },
    "unlogged");
  same(resolvePlayback(CAM, segments, gaps, iso(B - 60 * M), NOW).nextRecordedUtc, iso(B),
    "before anything we hold, recording resumes at the oldest segment");
  same(resolvePlayback(CAM, segments, gaps, iso(B + 30 * M), NOW).nextRecordedUtc, null,
    "after the last, nothing is known to resume");
  same(resolvePlayback(CAM, [], [], iso(B), NOW),
    { kind: "gap", cameraId: CAM, reason: "unknown", source: "inferred", nextRecordedUtc: null }, "no rows at all");
});

check("an instant in the open segment is refused for playback: it is still recording", () => {
  const openStart = NOW_MS - 20_000;
  same(resolvePlayback(CAM, [...run(openStart - M, 1), seg(openStart, { open: true })], [], iso(NOW_MS - 5_000), NOW),
    { kind: "recording", cameraId: CAM, segmentStartUtc: iso(openStart) }, "use live");
});

check("THE FEARED ONE: now and after is the future, not a gap", () => {
  same(resolvePlayback(CAM, run(B, 1), [], NOW, NOW), { kind: "future", cameraId: CAM, nowUtc: NOW }, "now");
  same(resolvePlayback(CAM, run(B, 1), [], iso(NOW_MS + 86_400_000), NOW).kind, "future", "tomorrow");
});

check("THE FEARED ONE: coverage and playback never disagree, over a sweep of windows", () => {
  // Every awkward case at once: a logged gap, an unlogged hole, a seam, an
  // overlap, a null-bytes segment and two outages sharing one hole.
  const segments = [
    ...run(B, 10),                                   // 0-10 min
    ...run(B + 20 * M, 5),                           // 20-25, after a logged outage
    seg(B + 30 * M), seg(B + 31 * M + 2_000),        // 30-32:02, a 2 s seam
    seg(B + 40 * M), seg(B + 40 * M + 23_000),       // an ffmpeg restart overlap
    seg(B + 41 * M + 23_000, { bytes: null }),       // size unknown
    ...run(B + 60 * M, 3),                           // 60-63, after two outages
  ];
  const gaps = [
    gap(B + 10 * M, B + 20 * M, "camera_offline"),
    gap(B + 45 * M, B + 50 * M, "appliance_offline"),
    gap(B + 52 * M, B + 60 * M, "disk_full"),
    gap(B + 9 * M, B + 11 * M, "tampered"),          // overlaps recorded time and another gap
  ];
  let windows = 0;
  for (let start = B - 5 * M; start < B + 64 * M; start += 37_000) {
    for (const length of [1_000, 90_000, 17 * M]) {
      const r = range(start, start + length);
      const cov = coverageFromIndex(CAM, segments, gaps, r, NOW);
      invariants(cov, r, `window at +${(start - B) / 1000}s for ${length / 1000}s`);
      for (const x of cov.runs) {
        const mid = iso((Date.parse(x.startUtc) + Date.parse(x.endUtc)) / 2);
        const at = resolvePlayback(CAM, segments, gaps, mid, NOW);
        if (x.kind === "recorded" && at.kind !== "segment") {
          throw new Error(`coverage shows recording at ${mid}; playback says ${at.kind}`);
        }
        if (x.kind === "gap" && (at.kind !== "gap" || at.reason !== x.gapReason || at.source !== x.gapSource)) {
          throw new Error(`coverage shows ${x.gapReason}/${x.gapSource} at ${mid}; playback says ${JSON.stringify(at)}`);
        }
      }
      windows++;
    }
  }
  if (windows < 300) throw new Error(`the sweep only covered ${windows} windows`);
});

report("indexCoverage");
