/** Crash reconciliation — the Phase 1 exit criterion in test form: pull the
 *  power and lose nothing but the outage seconds, with a correct gap. */
import { planRecovery, parseSegmentPath, segmentPath, estimateEndUtc } from "../dist/recovery.js";
import { check, eq, close, report } from "./_assert.mjs";

console.log("recovery");
const BOUNDARY = "2026-09-10T04:00:00.000Z";
// `??` would coalesce an explicit null back to the default — which is the exact
// blank-is-not-a-zero bug these contracts exist to prevent, and it silently made
// the "no measured bitrate" case test nothing at all. Presence, not nullishness.
const pick = (opts, key, fallback) => (key in opts ? opts[key] : fallback);
const seg = (startUtc, opts = {}) => ({
  cameraId: "cam-1", startUtc, endUtc: pick(opts, "endUtc", null),
  path: pick(opts, "path", segmentPath("cam-1", startUtc)),
  bytes: pick(opts, "bytes", 15_000_000), state: pick(opts, "state", "sealed"),
  hold: false, pendingUpload: false, bitrateKbps: pick(opts, "bitrateKbps", 2000),
});
const file = (path, bytes) => ({ path, bytes });

check("index and disk agree — confirmed, no gap", () => {
  const s = seg("2026-09-10T03:00:00.000Z", { endUtc: "2026-09-10T03:01:00.000Z" });
  const plan = planRecovery([s], [file(s.path, 15_000_000)], BOUNDARY);
  eq(plan.summary.confirmed, 1, "confirmed");
  eq(plan.gaps.length, 0, "no gaps");
});

check("THE FEARED ONE: power cut mid-write seals the partial and gaps the rest", () => {
  const s = seg("2026-09-10T03:00:00.000Z", { state: "open", bytes: null });
  // 15,000,000 bytes at 2000 kbps is exactly 60 seconds of video.
  const plan = planRecovery([s], [file(s.path, 15_000_000)], BOUNDARY);
  eq(plan.summary.partials, 1, "one partial");
  const action = plan.actions.find((a) => a.kind === "seal_partial");
  eq(action.estimatedEndUtc, "2026-09-10T03:01:00.000Z", "end estimated from bytes and bitrate");
  eq(action.needsMediaValidation, true, "flagged as an estimate needing a real probe");
  eq(plan.gaps.length, 1, "one gap");
  eq(plan.gaps[0].startUtc, "2026-09-10T03:01:00.000Z", "gap starts where recording stopped");
  eq(plan.gaps[0].endUtc, BOUNDARY, "gap runs to the scan");
  eq(plan.gaps[0].reason, "appliance_offline", "reason");
});

check("a partial with no measured bitrate refuses to invent an end time", () => {
  const s = seg("2026-09-10T03:00:00.000Z", { state: "open", bytes: null, bitrateKbps: null });
  const plan = planRecovery([s], [file(s.path, 15_000_000)], BOUNDARY);
  const action = plan.actions.find((a) => a.kind === "seal_partial");
  eq(action.estimatedEndUtc, null, "no invented timestamp");
  eq(plan.gaps[0].startUtc, "2026-09-10T03:00:00.000Z", "whole span is unknown, and says so");
});

check("THE FEARED ONE: an orphan file is adopted, never deleted", () => {
  const plan = planRecovery([], [file("cam-1/1757473200000.mp4", 12_000_000)], BOUNDARY);
  eq(plan.summary.adopted, 1, "adopted");
  eq(plan.summary.dropped, 0, "nothing dropped");
  const action = plan.actions.find((a) => a.kind === "adopt_orphan");
  eq(action.cameraId, "cam-1", "camera recovered from the path");
});

check("THE FEARED ONE: an unrecognised file is quarantined, not deleted", () => {
  const plan = planRecovery([], [file("cam-1/something-else.dat", 500)], BOUNDARY);
  eq(plan.summary.quarantined, 1, "quarantined");
  eq(plan.summary.dropped, 0, "not deleted — we do not delete what we do not understand");
});

check("a zero-byte file is dropped — created but never written to", () => {
  const plan = planRecovery([], [file("cam-1/1757473200000.mp4", 0)], BOUNDARY);
  eq(plan.summary.dropped, 1, "dropped");
  eq(plan.summary.adopted, 0, "not adopted as footage");
});

check("a file the index expects but disk lacks becomes a gap", () => {
  const s = seg("2026-09-10T02:00:00.000Z", { endUtc: "2026-09-10T02:01:00.000Z" });
  const plan = planRecovery([s], [], BOUNDARY);
  eq(plan.summary.lost, 1, "lost");
  eq(plan.gaps.length, 1, "gap raised");
  eq(plan.gaps[0].startUtc, "2026-09-10T02:00:00.000Z", "gap covers the segment");
  eq(plan.gaps[0].endUtc, "2026-09-10T02:01:00.000Z", "not silently extended");
});

check("byte mismatch trusts the disk, not the index", () => {
  const s = seg("2026-09-10T03:00:00.000Z", { bytes: 50_000_000 });
  const plan = planRecovery([s], [file(s.path, 12_000_000)], BOUNDARY);
  eq(plan.summary.corrected, 1, "corrected");
  const action = plan.actions.find((a) => a.kind === "correct_size");
  eq(action.actualBytes, 12_000_000, "disk wins");
});

check("a realistic crash: confirmed + partial + orphan + junk, all handled", () => {
  const ok = seg("2026-09-10T03:00:00.000Z", { endUtc: "2026-09-10T03:01:00.000Z" });
  const open = seg("2026-09-10T03:01:00.000Z", { state: "open", bytes: null,
    path: segmentPath("cam-1", "2026-09-10T03:01:00.000Z") });
  const plan = planRecovery([ok, open], [
    file(ok.path, 15_000_000),
    file(open.path, 7_500_000),
    file("cam-1/1757476800000.mp4", 9_000_000),
    file("cam-1/.ffmpeg-tmp", 0),
  ], BOUNDARY);
  eq(plan.summary, { confirmed: 1, corrected: 0, partials: 1, adopted: 1, dropped: 1, quarantined: 0, lost: 0 }, "summary");
});

check("path round-trips, and a bad path is refused rather than guessed", () => {
  const p = segmentPath("cam-7", "2026-09-10T03:00:00.000Z");
  const parsed = parseSegmentPath(p);
  eq(parsed.kind, "ok", "kind");
  eq(parsed.cameraId, "cam-7", "camera");
  eq(parsed.startUtc, "2026-09-10T03:00:00.000Z", "start");
  eq(parseSegmentPath("nope.mp4").kind, "unparseable", "no camera dir");
  eq(parseSegmentPath("cam-1/abc.mp4").kind, "unparseable", "non-numeric");
  eq(parseSegmentPath("cam-1/0.mp4").kind, "unparseable", "implausible epoch");
});

check("estimateEndUtc is arithmetic, not a guess, and refuses without a bitrate", () => {
  eq(estimateEndUtc("2026-09-10T00:00:00.000Z", 15_000_000, 2000), "2026-09-10T00:01:00.000Z");
  eq(estimateEndUtc("2026-09-10T00:00:00.000Z", 15_000_000, null), null, "no bitrate, no estimate");
  eq(estimateEndUtc("2026-09-10T00:00:00.000Z", 0, 2000), null, "no bytes, no estimate");
});

report("recovery");
