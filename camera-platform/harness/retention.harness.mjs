/** Retention arithmetic. The failures feared: a silent default bitrate, and a
 *  camera quietly producing more than assumed. */
import { computeRetentionDays, requiredBytesForDays, usableBytesFromRaw, TERABYTE }
  from "../dist/retention.js";
import { check, eq, close, report } from "./_assert.mjs";

console.log("retention");
const cams = (n, kbps) =>
  Array.from({ length: n }, (_, i) => ({ cameraId: `cam-${i + 1}`, bitrateKbps: kbps }));

check("23 cameras @2 Mbps in 14.904 TB is exactly 30 days", () => {
  const r = computeRetentionDays(cams(23, 2000), 14_904_000_000_000);
  if (r.kind !== "ok") throw new Error(`refused: ${r.message}`);
  close(r.days, 30, 0.001, "days");
});

check("THE FEARED ONE: cameras really at 4 Mbps halve retention on the same disk", () => {
  const assumed = computeRetentionDays(cams(23, 2000), 14_904_000_000_000);
  const actual = computeRetentionDays(cams(23, 4000), 14_904_000_000_000);
  if (assumed.kind !== "ok" || actual.kind !== "ok") throw new Error("unexpected refusal");
  close(actual.days, 15, 0.001, "days at 4 Mbps");
  close(assumed.days / actual.days, 2, 0.001, "ratio");
});

check("refuses when ANY camera has no measured bitrate", () => {
  const mixed = [...cams(22, 2000), { cameraId: "cam-new", bitrateKbps: null }];
  const r = computeRetentionDays(mixed, 14_904_000_000_000);
  eq(r.kind, "refused", "kind");
  eq(r.reason, "unmeasured_cameras", "reason");
  eq(r.unmeasuredCameraIds, ["cam-new"], "named the camera");
});

check("a null bitrate is NOT treated as zero (which would inflate retention)", () => {
  const withNull = [...cams(1, 2000), { cameraId: "x", bitrateKbps: null }];
  const r = computeRetentionDays(withNull, TERABYTE);
  if (r.kind !== "refused") throw new Error("a blank was treated as a zero — the exact bug");
});

check("empty camera list is refused, not infinite retention", () => {
  const r = computeRetentionDays([], TERABYTE);
  eq(r.kind, "refused", "kind");
  eq(r.reason, "no_cameras", "reason");
});

check("zero or negative disk is refused", () => {
  eq(computeRetentionDays(cams(4, 2000), 0).kind, "refused", "zero");
  eq(computeRetentionDays(cams(4, 2000), -1).kind, "refused", "negative");
});

check("all-zero bitrate is a fault, not infinite retention", () => {
  const r = computeRetentionDays(cams(4, 0), TERABYTE);
  eq(r.kind, "refused", "kind");
  eq(r.reason, "zero_bitrate", "reason");
});

check("requiredBytesForDays inverts computeRetentionDays", () => {
  const sizing = requiredBytesForDays(cams(23, 2000), 30);
  if (sizing.kind !== "ok") throw new Error("refused");
  close(sizing.bytes, 14_904_000_000_000, 1_000_000, "bytes for 30 days");
  const back = computeRetentionDays(cams(23, 2000), sizing.bytes);
  if (back.kind !== "ok") throw new Error("refused");
  close(back.days, 30, 0.001, "round trip");
});

check("requiredBytesForDays propagates the refusal", () => {
  const r = requiredBytesForDays([{ cameraId: "a", bitrateKbps: null }], 30);
  eq(r.kind, "refused", "kind");
});

check("raw disk is not usable disk", () => {
  close(usableBytesFromRaw(16 * TERABYTE, 0.1), 14.4 * TERABYTE, 1e9, "usable");
});

report("retention");
