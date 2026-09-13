/** Export planning. The failures feared: an export across an outage that lists
 *  no gap, so it plays as unbroken footage; the segment still being written
 *  handed out as if sealed; a null size counted as zero; an archive past ZIP32
 *  limits planned anyway; and a range boundary that pulls in a neighbour. */
import { planExport, EXPORT_OVERHEAD_BYTES } from "../dist/exportPlan.js";
import { ZIP32_MAX, ZIP32_MAX_ENTRIES } from "../dist/zipStore.js";
import { check, eq, same, throws, report } from "./_assert.mjs";

console.log("exportPlan");

const CAM = "cam-1";
const S = 1_000;
const M = 60_000;
const H = (h, m = 0, s = 0) => Date.UTC(2026, 8, 11, h, m, s);
const NOW = new Date(H(15)).toISOString();
const iso = (ms) => new Date(ms).toISOString();
const BYTES = 15_000_000;

function seg(startMs, opts = {}) {
  const open = opts.open === true;
  return {
    cameraId: opts.cameraId ?? CAM,
    startUtc: iso(startMs),
    endUtc: open ? null : iso(opts.endMs ?? startMs + M),
    path: open ? `${CAM}/.inprogress/${startMs}.mp4` : `${CAM}/${startMs}.mp4`,
    bytes: open ? null : ("bytes" in opts ? opts.bytes : BYTES),
    state: open ? "open" : "sealed",
    bitrateKbps: 2000,
  };
}
const run = (fromMs, count) => Array.from({ length: count }, (_, i) => seg(fromMs + i * M));
const range = (a, b) => ({ startUtc: iso(a), endUtc: iso(b) });
const nameOf = (ms) => `${CAM}/${iso(ms).replace(/:/g, "-")}.mp4`;
const file = (startMs, endMs = startMs + M, bytes = BYTES) => ({
  segmentId: `${CAM}.${startMs}`, path: `${CAM}/${startMs}.mp4`, name: nameOf(startMs),
  startUtc: iso(startMs), endUtc: iso(endMs), bytes,
});

// 14:00-14:10 recorded | 14:10-14:12 camera_offline (logged) | 14:12-14:20 recorded
// | 14:20-14:30 nobody logged it | 14:30-now the open segment.
const SEGMENTS = [...run(H(14, 0), 10), ...run(H(14, 12), 8), seg(H(14, 30), { open: true })];
const GAPS = [{ cameraId: CAM, startUtc: iso(H(14, 10)), endUtc: iso(H(14, 12)), reason: "camera_offline" }];
const plan = (r, segments = SEGMENTS, gaps = GAPS, now = NOW) => planExport(CAM, segments, gaps, r, now);

function refused(result, code, what) {
  same(Object.keys(result).sort(), ["code", "message", "ok", "status"], `${what}: refusal keys`);
  same([result.ok, result.status, result.code], [false, 422, code], what);
  if (typeof result.message !== "string" || result.message.length === 0) throw new Error(`${what}: no message`);
  if (result.message.includes(".mp4") || result.message.includes("inprogress")) {
    throw new Error(`${what}: a storage path in the message: ${result.message}`);
  }
}

check("whole files: a range inside three segments delivers all three, untrimmed", () => {
  const p = plan(range(H(14, 5, 30), H(14, 7, 10)));
  same(Object.keys(p).sort(),
    ["cameraId", "delivered", "files", "gapSeconds", "gaps", "ok", "recordedSeconds", "requested", "totalBytes"], "plan keys");
  same(p.files, [file(H(14, 5)), file(H(14, 6)), file(H(14, 7))], "files");
  same(p.requested, range(H(14, 5, 30), H(14, 7, 10)), "requested");
  same(p.delivered, range(H(14, 5), H(14, 8)), "delivered is wider");
  same([p.ok, p.cameraId, p.gaps, p.recordedSeconds, p.gapSeconds, p.totalBytes],
    [true, CAM, [], 100, 0, 3 * BYTES], "the rest");
});

check("THE FEARED ONE: a range across the outage lists the gap, and no file spans it", () => {
  const p = plan(range(H(14, 9), H(14, 13)));
  same(p.files, [file(H(14, 9)), file(H(14, 12))], "two separate files either side");
  same(p.gaps, [{ startUtc: iso(H(14, 10)), endUtc: iso(H(14, 12)), reason: "camera_offline", source: "logged" }], "the gap, with its reason");
  same([p.recordedSeconds, p.gapSeconds], [120, 120], "seconds");
  same(p.delivered, range(H(14, 9), H(14, 13)), "delivered");
});

check("THE FEARED ONE: a hole nobody logged is still listed, as unknown and inferred", () => {
  const p = plan(range(H(14, 19), H(14, 25)));
  same(p.files, [file(H(14, 19))], "files");
  same(p.gaps, [{ startUtc: iso(H(14, 20)), endUtc: iso(H(14, 25)), reason: "unknown", source: "inferred" }], "gaps");
  same([p.recordedSeconds, p.gapSeconds], [60, 300], "seconds");
});

check("gaps at the edges of the requested range are listed even outside what is delivered", () => {
  const p = plan(range(H(13, 50), H(14, 2)));
  same(p.files, [file(H(14, 0)), file(H(14, 1))], "files");
  same(p.gaps, [{ startUtc: iso(H(13, 50)), endUtc: iso(H(14, 0)), reason: "unknown", source: "inferred" }], "leading gap");
  same(p.delivered, range(H(14, 0), H(14, 2)), "delivered");
});

check("a range of nothing but gap is refused, not an empty archive", () => {
  refused(plan(range(H(14, 10, 30), H(14, 11, 30))), "export_nothing_recorded", "inside the outage");
  refused(plan(range(H(14, 0), H(14, 30)), [], []), "export_nothing_recorded", "no segments at all");
});

check("THE FEARED ONE: a range reaching the open segment is refused, naming where to stop", () => {
  const r = plan(range(H(14, 29), H(14, 31)));
  refused(r, "export_reaches_recording", "into the open segment");
  if (!r.message.includes(iso(H(14, 30)))) throw new Error(`message does not name ${iso(H(14, 30))}: ${r.message}`);
  refused(plan(range(H(14, 45), H(15))), "export_reaches_recording", "wholly inside it");
});

check("half-open: a range ending exactly at a segment's start, or starting exactly at its end, excludes it", () => {
  // 14:20-14:30: the 14:19 file ends at 14:20, the open one starts at 14:30. Neither is in.
  refused(plan(range(H(14, 20), H(14, 30))), "export_nothing_recorded", "both boundaries");
  const p = plan(range(H(14, 6), H(14, 8)));
  same(p.files.map((f) => f.startUtc), [iso(H(14, 6)), iso(H(14, 7))], "14:05 ends at the start, 14:08 starts at the end");
});

check("refusal order: open beats nothing-recorded and unknown size", () => {
  const segments = [seg(H(14, 0), { bytes: null }), seg(H(14, 1), { open: true })];
  refused(plan(range(H(14, 0), H(14, 2)), segments, []), "export_reaches_recording", "open + null bytes");
});

check("THE FEARED ONE: a sealed segment of unknown size is refused, never counted as 0", () => {
  const segments = [seg(H(14, 0)), seg(H(14, 1), { bytes: null }), seg(H(14, 2))];
  refused(plan(range(H(14, 0), H(14, 3)), segments, []), "export_size_unknown", "null bytes");
  refused(plan(range(H(14, 0), H(14, 3)), [seg(H(14, 0), { bytes: -1 })], []), "export_size_unknown", "negative");
  refused(plan(range(H(14, 0), H(14, 3)), [seg(H(14, 0), { bytes: 1.5 })], []), "export_size_unknown", "fractional");
  const outside = plan(range(H(14, 2), H(14, 3)), segments, []);
  same(outside.files, [file(H(14, 2))], "a null-size segment outside the range does not block the export");
  const zero = plan(range(H(14, 0), H(14, 1)), [seg(H(14, 0), { bytes: 0 })], []);
  same([zero.ok, zero.totalBytes], [true, 0], "zero is a measured size");
});

check("THE FEARED ONE: past ZIP32's size limit is refused; exactly at it is planned", () => {
  const limit = ZIP32_MAX - EXPORT_OVERHEAD_BYTES;
  const half = Math.floor(limit / 2);
  const at = [seg(H(14, 0), { bytes: half }), seg(H(14, 1), { bytes: limit - half })];
  const ok = plan(range(H(14, 0), H(14, 2)), at, []);
  same([ok.ok, ok.totalBytes], [true, limit], "exactly the limit");
  const over = [seg(H(14, 0), { bytes: half }), seg(H(14, 1), { bytes: limit - half + 1 })];
  refused(plan(range(H(14, 0), H(14, 2)), over, []), "export_too_large", "one byte over");
});

check("THE FEARED ONE: past ZIP32's entry limit (files + manifest) is refused; exactly at it is planned", () => {
  const base = H(1);
  const many = (n) => Array.from({ length: n }, (_, i) => seg(base + i * S, { endMs: base + (i + 1) * S, bytes: 1 }));
  const fits = ZIP32_MAX_ENTRIES - 1;
  const later = iso(base + 20 * 3_600_000);   // 65536 one-second files run past the fixture's NOW
  const ok = plan(range(base, base + fits * S), many(fits), [], later);
  same([ok.ok, ok.files.length], [true, fits], "65534 files + manifest = 65535 entries");
  refused(plan(range(base, base + (fits + 1) * S), many(fits + 1), [], later), "export_too_large", "65535 files");
});

check("unsorted input: files come out sorted, and the input is not mutated", () => {
  const segments = [seg(H(14, 2)), seg(H(14, 0)), seg(H(14, 1))];
  const before = JSON.stringify(segments);
  const p = plan(range(H(14, 0), H(14, 3)), segments, []);
  same(p.files, [file(H(14, 0)), file(H(14, 1)), file(H(14, 2))], "sorted");
  eq(JSON.stringify(segments), before, "input untouched");
});

check("delivered ends at the LATEST file end, not the last file's", () => {
  const segments = [seg(H(14, 0), { endMs: H(14, 5) }), seg(H(14, 1), { endMs: H(14, 2) })];
  const p = plan(range(H(14, 0), H(14, 3)), segments, []);
  same(p.files, [file(H(14, 0), H(14, 5)), file(H(14, 1), H(14, 2))], "both files, own extents");
  same(p.delivered, range(H(14, 0), H(14, 5)), "delivered");
});

check("names and times are normalised to toUtc form, whatever the index or caller wrote", () => {
  const s = { ...seg(H(14, 0)), startUtc: "2026-09-11T14:00:00Z", endUtc: "2026-09-11T14:01:00Z" };
  const p = plan({ startUtc: "2026-09-11T14:00:00Z", endUtc: "2026-09-11T14:01:00Z" }, [s], []);
  same(p.files, [file(H(14, 0))], "file");
  same(p.requested, range(H(14, 0), H(14, 1)), "requested");
  eq(p.files[0].name, "cam-1/2026-09-11T14-00-00.000Z.mp4", "entry name");
});

check("coverage's refusals propagate", () => {
  throws(() => plan(range(H(14, 0), H(14, 5)), [...run(H(14, 0), 5), seg(H(14, 5), { cameraId: "cam-2" })], []), "foreign camera");
  throws(() => plan(range(H(14, 50), H(15, 10))), "range past now");
  throws(() => plan(range(H(14, 5), H(14, 5))), "zero-length range");
});

report("exportPlan");
