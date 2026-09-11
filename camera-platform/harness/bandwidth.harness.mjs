/** Uplink budgeting. The failure feared: the third viewer being refused, or
 *  worse, everyone's video AND the alert-clip upload stuttering together. */
import { allocateBandwidth, capacityAt, PROFILE_KBPS, MOBILE_TILES_PER_PAGE, DESKTOP_TILES } from "../dist/bandwidth.js";
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

check("THE FEARED ONE: a stream the viewer upgraded survives while the grid drops", () => {
  // A guard watching 16 tiles taps one to HD because they are reading a plate,
  // while two other people are also on the site.
  const plan = allocateBandwidth([
    { cameraId: "cam-gate", viewerId: "v1", desired: "main", pinned: true },
    ...req(15, "sub", "v1"),
    ...req(16, "sub", "v2"),
    ...req(16, "sub", "v3"),
  ], CABLE);

  const spotlight = plan.allocations.find((a) => a.cameraId === "cam-gate" && a.viewerId === "v1");
  eq(spotlight.granted, "main", "the deliberately chosen quality holds");
  eq(spotlight.degraded, false, "not degraded");
  eq(plan.anyDegraded, true, "the passive tiles absorbed it instead");
  if (plan.usedKbps > plan.budgetKbps) throw new Error("over budget");
});

check("pinning cannot conjure bandwidth — pinned degrades when pinned alone will not fit", () => {
  const plan = allocateBandwidth(
    Array.from({ length: 10 }, (_, i) => ({ cameraId: `c${i}`, viewerId: "v1", desired: "main", pinned: true })),
    CABLE,
  );
  eq(plan.allocations.every((a) => a.degraded), true, "ten HD streams do not fit, so they step down");
  if (plan.usedKbps > plan.budgetKbps) throw new Error("over budget");
});

check("passive tiles fall to snapshots rather than starving the pinned stream", () => {
  const plan = allocateBandwidth([
    { cameraId: "cam-1", viewerId: "v1", desired: "main", pinned: true },
    ...req(40, "sub", "v2"),
  ], 6000);
  const pinnedOne = plan.allocations.find((a) => a.cameraId === "cam-1" && a.pinned !== false && a.viewerId === "v1");
  eq(pinnedOne.granted, "main", "pinned held");
  eq(plan.allocations.filter((a) => a.viewerId === "v2").every((a) => a.granted === "snapshot"), true,
     "the rest became stills");
});

check("two viewers pinning different cameras share what is available", () => {
  const plan = allocateBandwidth([
    { cameraId: "cam-a", viewerId: "v1", desired: "main", pinned: true },
    { cameraId: "cam-b", viewerId: "v2", desired: "main", pinned: true },
    ...req(16, "sub", "v3"),
  ], CABLE);
  const pins = plan.allocations.filter((a) => a.cameraId === "cam-a" || a.cameraId === "cam-b");
  eq(pins.length, 2, "both pins present");
  eq(new Set(pins.map((p) => p.granted)).size, 1, "both pins treated equally");
});

check("phone viewers: three fit undegraded on 15 Mbps, four is the edge", () => {
  eq(MOBILE_TILES_PER_PAGE, 6, "six up, swipe for the rest");
  const phones = (n) => Array.from({ length: n }, (_, v) => req(MOBILE_TILES_PER_PAGE, "sub", `v${v}`)).flat();
  eq(allocateBandwidth(phones(3), CABLE).anyDegraded, false, "three phones fit");
  eq(allocateBandwidth(phones(4), CABLE).anyDegraded, true, "four tips it over");
});

check("a desktop viewer costs 2.7x a phone viewer — the real source of contention", () => {
  eq(DESKTOP_TILES, 16, "desktop shows the whole store");
  const desktop = allocateBandwidth(req(DESKTOP_TILES, "sub", "ceo"), CABLE);
  const phone = allocateBandwidth(req(MOBILE_TILES_PER_PAGE, "sub", "mgr"), CABLE);
  eq(desktop.usedKbps / phone.usedKbps, DESKTOP_TILES / MOBILE_TILES_PER_PAGE, "ratio");
  eq(desktop.anyDegraded, false, "one desktop viewer alone is fine");
});

check("the realistic mix: CEO on desktop plus two managers on phones", () => {
  const plan = allocateBandwidth([
    ...req(DESKTOP_TILES, "sub", "ceo"),
    ...req(MOBILE_TILES_PER_PAGE, "sub", "mgr1"),
    ...req(MOBILE_TILES_PER_PAGE, "sub", "mgr2"),
  ], CABLE);
  eq(plan.refused.length, 0, "nobody locked out");
  if (plan.usedKbps > plan.budgetKbps) throw new Error("over budget");
});

check("6-up mobile tolerates viewers that 16-up desktop does not", () => {
  const sixUp = allocateBandwidth([...req(6, "sub", "v1"), ...req(6, "sub", "v2"), ...req(6, "sub", "v3")], CABLE);
  const sixteenUp = allocateBandwidth([...req(16, "sub", "v1"), ...req(16, "sub", "v2"), ...req(16, "sub", "v3")], CABLE);
  eq(sixUp.anyDegraded, false, "three viewers at 6-up: nobody degraded");
  eq(sixteenUp.anyDegraded, true, "three viewers at 16-up: everyone degraded");
});

check("a phone page plus a pinned full-screen fits easily", () => {
  const plan = allocateBandwidth([
    { cameraId: "cam-gate", viewerId: "v1", desired: "main", pinned: true },
    ...req(MOBILE_TILES_PER_PAGE, "sub", "v1"),
  ], CABLE);
  eq(plan.anyDegraded, false, "grid and spotlight both at full quality");
});

check("capacity in phone pages, not raw streams — the number an operator cares about", () => {
  eq(Math.floor(capacityAt("sub", CABLE) / MOBILE_TILES_PER_PAGE), 3, "15 Mbps carries 3 phone pages");
  eq(Math.floor(capacityAt("sub", 5000) / MOBILE_TILES_PER_PAGE), 1, "OpenEye's recommended 5 Mbps carries one");
});

report("bandwidth");
