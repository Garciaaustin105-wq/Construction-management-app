/** The export manifest. The failures feared: a manifest that lists a file as
 *  complete when fewer (or more) bytes were sent; a storage path leaking into
 *  a file handed to someone outside; gaps dropped; and text the stream cannot
 *  write one byte per character. */
import {
  planExport, exportManifest, ExportManifestError,
  MANIFEST_FORMAT, MANIFEST_NOTE, MANIFEST_ENTRY_NAME,
} from "../dist/exportPlan.js";
import { check, eq, same, throws, report } from "./_assert.mjs";

console.log("exportManifest");

const CAM = "cam-1";
const M = 60_000;
const H = (h, m = 0, s = 0) => Date.UTC(2026, 8, 11, h, m, s);
const iso = (ms) => new Date(ms).toISOString();
const NOW = iso(H(15));
const GEN = iso(H(15, 1, 2));

const seg = (startMs, bytes) => ({
  cameraId: CAM, startUtc: iso(startMs), endUtc: iso(startMs + M),
  path: `${CAM}/${startMs}.mp4`, bytes, state: "sealed", bitrateKbps: 2000,
});
// 14:09 recorded | 14:10-14:12 camera_offline | 14:12 recorded
const PLAN = planExport(
  CAM,
  [seg(H(14, 9), 1000), seg(H(14, 12), 2500)],
  [{ cameraId: CAM, startUtc: iso(H(14, 10)), endUtc: iso(H(14, 12)), reason: "camera_offline" }],
  { startUtc: iso(H(14, 9, 30)), endUtc: iso(H(14, 12, 30)) },
  NOW,
);
if (PLAN.ok !== true) throw new Error(`fixture plan refused: ${PLAN.message}`);
const HASH_A = "a".repeat(64);
const HASH_B = "0123456789abcdef".repeat(4);
const SENT = [
  { name: "cam-1/2026-09-11T14-09-00.000Z.mp4", bytes: 1000, sha256: HASH_A },
  { name: "cam-1/2026-09-11T14-12-00.000Z.mp4", bytes: 2500, sha256: HASH_B },
];
const build = (sent = SENT, siteId = "carwash-01", gen = GEN, plan = PLAN) => exportManifest(plan, sent, siteId, gen);

function refusedWith(fn, what) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (err === null) throw new Error(`${what}: expected ExportManifestError, nothing thrown`);
  if (!(err instanceof ExportManifestError)) {
    throw new Error(`${what}: expected ExportManifestError, got ${err?.constructor?.name}: ${err?.message}`);
  }
  for (const f of PLAN.files) {
    if (err.message.includes(f.path)) throw new Error(`${what}: a storage path in the message: ${err.message}`);
  }
  return err;
}

check("constants", () => {
  same([MANIFEST_ENTRY_NAME, MANIFEST_FORMAT], ["manifest.json", "camera-export/1"], "names");
  if (typeof MANIFEST_NOTE !== "string" || MANIFEST_NOTE.length < 40) throw new Error("note missing");
});

check("exact text: key order, two-space indent, one trailing newline", () => {
  const expected = JSON.stringify({
    format: "camera-export/1",
    siteId: "carwash-01",
    cameraId: CAM,
    generatedAtUtc: GEN,
    requested: { startUtc: iso(H(14, 9, 30)), endUtc: iso(H(14, 12, 30)) },
    delivered: { startUtc: iso(H(14, 9)), endUtc: iso(H(14, 13)) },
    recordedSeconds: 60,
    gapSeconds: 120,
    totalBytes: 3500,
    note: MANIFEST_NOTE,
    files: [
      { name: SENT[0].name, startUtc: iso(H(14, 9)), endUtc: iso(H(14, 10)), bytes: 1000, sha256: HASH_A },
      { name: SENT[1].name, startUtc: iso(H(14, 12)), endUtc: iso(H(14, 13)), bytes: 2500, sha256: HASH_B },
    ],
    gaps: [{ startUtc: iso(H(14, 10)), endUtc: iso(H(14, 12)), reason: "camera_offline", source: "logged" }],
  }, null, 2) + "\n";
  eq(build(), expected, "manifest text");
});

check("THE FEARED ONE: a file one byte short, or one byte long, is refused", () => {
  refusedWith(() => build([SENT[0], { ...SENT[1], bytes: 2499 }]), "short");
  refusedWith(() => build([{ ...SENT[0], bytes: 1001 }, SENT[1]]), "long");
  const e = refusedWith(() => build([SENT[0], { ...SENT[1], bytes: 0 }]), "empty");
  if (!e.message.includes(SENT[1].name)) throw new Error(`message does not name the entry: ${e.message}`);
});

check("THE FEARED ONE: a file missing, extra, or out of order is refused", () => {
  refusedWith(() => build([SENT[0]]), "missing last");
  refusedWith(() => build([]), "none sent");
  refusedWith(() => build([...SENT, { ...SENT[1], name: "cam-1/x.mp4" }]), "extra");
  refusedWith(() => build([SENT[1], SENT[0]]), "swapped");
});

check("a hash that is not 64 lowercase hex characters is refused", () => {
  refusedWith(() => build([{ ...SENT[0], sha256: HASH_A.toUpperCase() }, SENT[1]]), "uppercase");
  refusedWith(() => build([{ ...SENT[0], sha256: HASH_A.slice(1) }, SENT[1]]), "63 chars");
  refusedWith(() => build([{ ...SENT[0], sha256: "g".repeat(64) }, SENT[1]]), "not hex");
  refusedWith(() => build([{ ...SENT[0], sha256: undefined }, SENT[1]]), "absent");
});

check("THE FEARED ONE: no storage path reaches the manifest, even if sent carries one", () => {
  const text = build(SENT.map((s) => ({ ...s, path: "/mnt/disk0/cam-1/secret.mp4", segmentId: "x" })));
  for (const f of PLAN.files) {
    if (text.includes(f.path)) throw new Error(`plan path ${f.path} in manifest`);
  }
  for (const bad of ["/mnt", "secret", '"path"', '"segmentId"']) {
    if (text.includes(bad)) throw new Error(`${bad} in manifest`);
  }
});

check("every plan gap is listed, in order; no gaps is an empty array", () => {
  const two = planExport(
    CAM, [seg(H(14, 0), 1), seg(H(14, 5), 2)],
    [{ cameraId: CAM, startUtc: iso(H(14, 1)), endUtc: iso(H(14, 3)), reason: "camera_offline" }],
    { startUtc: iso(H(14, 0)), endUtc: iso(H(14, 6)) }, NOW,
  );
  const sent = two.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: HASH_A }));
  const m = JSON.parse(build(sent, "carwash-01", GEN, two));
  same(m.gaps, two.gaps, "gaps");
  eq(m.gaps.length, 2, "the logged gap and the unlogged hole after it");
  const none = planExport(CAM, [seg(H(14, 0), 7)], [], { startUtc: iso(H(14, 0)), endUtc: iso(H(14, 1)) }, NOW);
  const m0 = JSON.parse(build([{ name: none.files[0].name, bytes: 7, sha256: HASH_A }], "carwash-01", GEN, none));
  same(m0.gaps, [], "no gaps");
});

check("generatedAtUtc is normalised; a malformed one throws", () => {
  const m = JSON.parse(build(SENT, "carwash-01", "2026-09-11T15:01:02Z"));
  eq(m.generatedAtUtc, GEN, "normalised");
  throws(() => build(SENT, "carwash-01", "yesterday"), "malformed");
});

check("siteId: empty is refused; non-ASCII is refused, never written as multi-byte", () => {
  refusedWith(() => build(SENT, ""), "empty");
  refusedWith(() => build(SENT, "café-01"), "non-ASCII");
  // A control character is escaped by JSON.stringify, so it is ASCII text and allowed.
  eq(JSON.parse(build(SENT, "a\tb")).siteId, "a\tb", "escaped tab round-trips");
});

check("the plan and sent are not mutated", () => {
  const p = JSON.stringify(PLAN);
  const s = JSON.stringify(SENT);
  build();
  eq(JSON.stringify(PLAN), p, "plan");
  eq(JSON.stringify(SENT), s, "sent");
});

report("exportManifest");
