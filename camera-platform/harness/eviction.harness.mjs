/** The ring buffer. The failures feared: deleting evidence under hold, and
 *  deleting the only copy of an incident before its cloud copy is confirmed. */
import { planEviction, bytesToFreeFor } from "../dist/eviction.js";
import { check, eq, throws, report } from "./_assert.mjs";

console.log("eviction");
const seg = (id, startUtc, bytes, extra = {}) => ({
  cameraId: "cam-1", startUtc, endUtc: null, path: `cam-1/${id}.mp4`,
  bytes, state: "sealed", hold: false, pendingUpload: false, bitrateKbps: 2000, ...extra,
});
const MB = 1_000_000;

check("evicts oldest first, not newest", () => {
  const plan = planEviction([
    seg("c", "2026-09-10T03:00:00.000Z", 10 * MB),
    seg("a", "2026-09-10T01:00:00.000Z", 10 * MB),
    seg("b", "2026-09-10T02:00:00.000Z", 10 * MB),
  ], 15 * MB);
  eq(plan.kind, "ok", "kind");
  eq(plan.evict.map((e) => e.segment.path), ["cam-1/a.mp4", "cam-1/b.mp4"], "oldest two");
});

check("THE FEARED ONE: a segment under evidence hold is never evicted", () => {
  const plan = planEviction([
    seg("held", "2026-09-01T00:00:00.000Z", 50 * MB, { hold: true }),
    seg("new", "2026-09-10T00:00:00.000Z", 10 * MB),
  ], 30 * MB);
  const evicted = plan.evict.map((e) => e.segment.path);
  if (evicted.includes("cam-1/held.mp4")) throw new Error("evidence under hold was deleted");
  eq(plan.kind, "insufficient", "refuses rather than reaching into the hold");
  eq(plan.shortfallBytes, 20 * MB, "shortfall reported");
});

check("THE FEARED ONE: an incident awaiting its cloud copy is never evicted", () => {
  const plan = planEviction([
    seg("incident", "2026-09-01T00:00:00.000Z", 50 * MB, { pendingUpload: true }),
    seg("routine", "2026-09-10T00:00:00.000Z", 10 * MB),
  ], 30 * MB);
  if (plan.evict.some((e) => e.segment.pendingUpload)) {
    throw new Error("deleted the only copy of an incident clip");
  }
  eq(plan.kind, "insufficient", "kind");
  eq(plan.blocked.find((b) => b.reason === "pending_upload") !== undefined, true, "reason named");
});

check("the segment being written right now is never evicted", () => {
  const plan = planEviction([seg("open", "2026-09-10T00:00:00.000Z", 5 * MB, { state: "open" })], 1 * MB);
  eq(plan.evict.length, 0, "nothing evicted");
  eq(plan.blocked[0].reason, "open", "reason");
});

check("a segment of unknown size is blocked, not assumed to be zero or huge", () => {
  const plan = planEviction([seg("mystery", "2026-09-01T00:00:00.000Z", null)], 1 * MB);
  eq(plan.evict.length, 0, "nothing evicted");
  eq(plan.blocked[0].reason, "unknown_size", "reason");
});

check("stops as soon as enough is freed — does not over-delete", () => {
  const plan = planEviction([
    seg("a", "2026-09-10T01:00:00.000Z", 10 * MB),
    seg("b", "2026-09-10T02:00:00.000Z", 10 * MB),
    seg("c", "2026-09-10T03:00:00.000Z", 10 * MB),
  ], 5 * MB);
  eq(plan.evict.length, 1, "one segment is enough");
  eq(plan.bytesFreed, 10 * MB, "freed");
});

check("an insufficient plan still frees what it can", () => {
  const plan = planEviction([
    seg("held", "2026-09-01T00:00:00.000Z", 100 * MB, { hold: true }),
    seg("free", "2026-09-10T00:00:00.000Z", 10 * MB),
  ], 50 * MB);
  eq(plan.kind, "insufficient", "kind");
  eq(plan.bytesFreed, 10 * MB, "freed what it could");
  if (!plan.message.includes("under hold")) throw new Error("message must explain the block");
});

check("nothing to free is a no-op, not an error", () => {
  eq(planEviction([seg("a", "2026-09-10T01:00:00.000Z", 10 * MB)], 0).evict.length, 0, "zero");
  eq(planEviction([seg("a", "2026-09-10T01:00:00.000Z", 10 * MB)], -5).evict.length, 0, "negative");
});

check("an empty disk cannot free anything and says so", () => {
  const plan = planEviction([], 10 * MB);
  eq(plan.kind, "insufficient", "kind");
  eq(plan.shortfallBytes, 10 * MB, "shortfall");
});

check("bytesToFreeFor leaves headroom rather than filling to the brim", () => {
  eq(bytesToFreeFor(100 * MB, 100 * MB, 0.05), 5 * MB, "5% headroom");
  eq(bytesToFreeFor(50 * MB, 100 * MB, 0.05), 0, "under budget frees nothing");
  throws(() => bytesToFreeFor(1, 1, 1), "headroom of 1 is refused");
});

report("eviction");
