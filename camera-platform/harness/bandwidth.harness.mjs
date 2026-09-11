/** Uplink budgeting. The failure feared: the third viewer being refused, or
 *  worse, everyone's video AND the alert-clip upload stuttering together. */
import { allocateBandwidth, capacityAt, PROFILE_KBPS } from "../dist/bandwidth.js";
import { check, eq, throws, report } from "./_assert.mjs";

console.log("bandwidth");

// OpenEye recommends 5 Mbps site upload. Typical commercial cable is 10-20.
const CABLE = 15_000;   // kbps measured
const req = (n, desired, viewerId = "v1") =>
  Array.from({ length: n }, (_, i) => ({ cameraId: `cam-${i + 1}`, viewerId, desired }));

check("one viewer on 16 substreams fits comfortably", () => {
  const plan = allocateBandwidth(req(16, "sub"), CABLE);
  eq(plan.anyDegraded, false, "nobody degraded");
  eq(plan.usedKbps, 16 * 400, "full substream quality");
});

check("THE FEARED ONE: a third viewer degrades everyone rather than being refused", () => {
  const three = [...req(16, "sub", "v1"), ...req(16, "sub", "v2"), ...req(16, "sub", "v3")];
  const plan = allocateBandwidth(three, CABLE);
  eq(plan.refused.length, 0, "nobody locked out");
  eq(plan.allocations.length, 48, "all 48 streams served");
  eq(plan.anyDegraded, true, "everyone stepped down instead");
  if (plan.usedKbps > plan.budgetKbps) throw new Error("allocation exceeded the budget");
});

check("degradation is uniform — not first-come-first-served", () => {
  const three = [...req(16, "sub", "v1"), ...req(16, "sub", "v2"), ...req(16, "sub", "v3")];
  const plan = allocateBandwidth(three, CABLE);
  const profiles = new Set(plan.allocations.map((a) => a.granted));
  eq(profiles.size, 1, "every viewer gets the same profile, whoever connected first");
});

check("THE FEARED ONE: the upload reserve is never spent on viewers", () => {
  const many = [...req(16, "main", "v1"), ...req(16, "main", "v2"), ...req(16, "main", "v3")];
  const plan = allocateBandwidth(many, CABLE, { reservedKbps: 1000 });
  const ceiling = CABLE * 0.7 - 1000;
  if (plan.usedKbps > ceiling) {
    throw new Error(`viewers took ${plan.usedKbps} of a ${ceiling} ceiling — the alert clip has no room`);
  }
});

check("a spotlight main stream is honoured when there is room", () => {
  const mixed = [...req(15, "sub"), { cameraId: "cam-16", viewerId: "v1", desired: "main" }];
  const plan = allocateBandwidth(mixed, CABLE);
  const spotlight = plan.allocations.find((a) => a.cameraId === "cam-16");
  eq(spotlight.granted, "main", "full quality on the camera being studied");
  eq(spotlight.degraded, false, "not degraded");
});

check("on a thin link everything falls back to snapshots rather than failing", () => {
  const plan = allocateBandwidth(req(16, "sub"), 2000);   // 2 Mbps site
  eq(plan.refused.length, 0, "still nobody refused");
  eq(plan.allocations.every((a) => a.granted === "snapshot"), true, "stills, not stutter");
  eq(plan.usedKbps, 0, "snapshots cost nothing on the uplink");
});

check("a viewer never gets MORE than they asked for", () => {
  const plan = allocateBandwidth(req(2, "low"), 100_000);   // huge uplink
  eq(plan.allocations.every((a) => a.granted === "low"), true, "asked for low, got low");
  eq(plan.anyDegraded, false, "not degraded");
});

check("capacity tells an operator what their link actually supports", () => {
  eq(capacityAt("main", CABLE), 3, "three main streams on 15 Mbps");
  eq(capacityAt("sub", CABLE), 23, "twenty-three substreams");
  eq(capacityAt("main", 5000), 1, "OpenEye's recommended 5 Mbps carries one 4MP stream");
  eq(capacityAt("sub", 5000), 6, "or six substreams");
  eq(capacityAt("snapshot", 1000), Infinity, "snapshots are unbounded");
});

check("the profile ladder is ordered and the reserve is respected at the floor", () => {
  if (!(PROFILE_KBPS.main > PROFILE_KBPS.sub && PROFILE_KBPS.sub > PROFILE_KBPS.low)) {
    throw new Error("ladder must descend");
  }
  eq(PROFILE_KBPS.snapshot, 0, "a snapshot is not a stream");
});

check("nonsense inputs are refused", () => {
  throws(() => allocateBandwidth(req(1, "sub"), 0), "zero uplink");
  throws(() => allocateBandwidth(req(1, "sub"), -1), "negative uplink");
  throws(() => allocateBandwidth(req(1, "sub"), CABLE, { usableFraction: 0 }), "zero fraction");
  throws(() => allocateBandwidth(req(1, "sub"), CABLE, { usableFraction: 1.5 }), "fraction over 1");
});

check("no viewers means no usage, not an error", () => {
  const plan = allocateBandwidth([], CABLE);
  eq(plan.usedKbps, 0, "nothing used");
  eq(plan.anyDegraded, false, "nothing degraded");
});

report("bandwidth");
