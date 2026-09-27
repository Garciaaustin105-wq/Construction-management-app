// cloud/harness/fleet.harness.mjs — cloud/contracts/fleet.ts
//
// FEARED: "never" reported as "offline" (a blank is not a zero); a
// never-recorded camera silently missing from `silent`; a boundary age that
// falls on the wrong side of 2.5x or 10x the check-in interval.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { fleetStatus, summarizeHealth, fleetRow } from "../dist/cloud/contracts/fleet.js";

console.log("fleet");

const INTERVAL_MS = 60000; // 1 minute, an arbitrary but realistic check-in interval
const NOW_MS = Date.parse("2026-09-27T00:00:00.000Z");

// ---- fleetStatus ----

check("fleetStatus: never seen is \"never\", not \"offline\"", () => {
  eq(fleetStatus(null, NOW_MS, INTERVAL_MS), "never");
});

check("fleetStatus: a future timestamp (negative age) is online", () => {
  eq(fleetStatus(NOW_MS + 1000, NOW_MS, INTERVAL_MS), "online");
});

check("fleetStatus: exactly 2.5x the interval is still online", () => {
  eq(fleetStatus(NOW_MS - 2.5 * INTERVAL_MS, NOW_MS, INTERVAL_MS), "online");
});

check("fleetStatus: 1 ms past 2.5x the interval is late", () => {
  eq(fleetStatus(NOW_MS - 2.5 * INTERVAL_MS - 1, NOW_MS, INTERVAL_MS), "late");
});

check("fleetStatus: exactly 10x the interval is still late", () => {
  eq(fleetStatus(NOW_MS - 10 * INTERVAL_MS, NOW_MS, INTERVAL_MS), "late");
});

check("fleetStatus: 1 ms past 10x the interval is offline", () => {
  eq(fleetStatus(NOW_MS - 10 * INTERVAL_MS - 1, NOW_MS, INTERVAL_MS), "offline");
});

check("fleetStatus: age 0 is online", () => {
  eq(fleetStatus(NOW_MS, NOW_MS, INTERVAL_MS), "online");
});

// ---- summarizeHealth ----

function health(overrides = {}) {
  return {
    version: "abc123",
    uptimeSec: 7200,
    cameras: [],
    drives: [],
    footageHeld: { hours: null, basis: null, refusedReason: null },
    detector: { capacityFps: null, minConfidence: null, motionGateEnabled: null },
    knownObjects: { active: null, lapsed: null },
    lastSealedUtc: null,
    ...overrides,
  };
}

const camera = (id, lastSealedUtc, recording = true) => ({
  cameraId: id,
  recording,
  detecting: null,
  gateShare: null,
  lastSealedUtc,
});

check("summarizeHealth: null footageHeldHours and lastSealedUtc stay null", () => {
  const r = summarizeHealth(health(), NOW_MS);
  eq(r.footageHeldHours, null);
  eq(r.lastSealedUtc, null);
});

check("summarizeHealth: footageHeldHours and lastSealedUtc pass through unchanged", () => {
  const r = summarizeHealth(
    health({
      footageHeld: { hours: 5.5, basis: "segments", refusedReason: null },
      lastSealedUtc: "2026-09-26T23:00:00.000Z",
    }),
    NOW_MS,
  );
  eq(r.footageHeldHours, 5.5);
  eq(r.lastSealedUtc, "2026-09-26T23:00:00.000Z");
});

check("FEARED: a never-recorded camera is listed in both silent and neverRecorded", () => {
  const h = health({ cameras: [camera("cam-1", null, null)] });
  const r = summarizeHealth(h, NOW_MS);
  same(r.cameras.silent, ["cam-1"]);
  same(r.cameras.neverRecorded, ["cam-1"]);
});

check("a camera sealed within the last 10 minutes is not silent", () => {
  const recent = new Date(NOW_MS - 5 * 60 * 1000).toISOString(); // 5 min ago
  const h = health({ cameras: [camera("cam-fresh", recent)] });
  const r = summarizeHealth(h, NOW_MS);
  same(r.cameras.silent, []);
  same(r.cameras.neverRecorded, []);
});

check("a camera sealed more than 10 minutes ago is silent but not neverRecorded", () => {
  const stale = new Date(NOW_MS - 11 * 60 * 1000).toISOString(); // 11 min ago
  const h = health({ cameras: [camera("cam-stale", stale)] });
  const r = summarizeHealth(h, NOW_MS);
  same(r.cameras.silent, ["cam-stale"]);
  same(r.cameras.neverRecorded, []);
});

check("a camera sealed at exactly 10 minutes ago is not silent (boundary is exclusive)", () => {
  const boundary = new Date(NOW_MS - 10 * 60 * 1000).toISOString();
  const h = health({ cameras: [camera("cam-boundary", boundary)] });
  const r = summarizeHealth(h, NOW_MS);
  same(r.cameras.silent, []);
});

check("cameras.total and cameras.recording count correctly, recording===null is not counted", () => {
  const h = health({
    cameras: [
      camera("cam-a", new Date(NOW_MS).toISOString(), true),
      camera("cam-b", null, false),
      camera("cam-c", null, null),
    ],
  });
  const r = summarizeHealth(h, NOW_MS);
  eq(r.cameras.total, 3);
  eq(r.cameras.recording, 1);
});

check("drives.total counts drives; drives.problems is [] given today's CheckinDriveFact shape", () => {
  const h = health({ drives: [{ index: 0, fillFraction: 0.9 }, { index: 1, fillFraction: null }] });
  const r = summarizeHealth(h, NOW_MS);
  eq(r.drives.total, 2);
  same(r.drives.problems, []);
});

check("version and uptimeSec pass through unchanged", () => {
  const r = summarizeHealth(health({ version: "release-42", uptimeSec: 123456 }), NOW_MS);
  eq(r.version, "release-42");
  eq(r.uptimeSec, 123456);
});

// ---- fleetRow ----

const device = (deviceId, state) => ({ deviceId, state });

check("fleetRow: no lastAccepted means never, null lastSeenUtc, null health", () => {
  const r = fleetRow(device("dev-1", "claimed"), null, NOW_MS, INTERVAL_MS);
  same(r, {
    deviceId: "dev-1",
    state: "claimed",
    status: "never",
    lastSeenUtc: null,
    health: null,
  });
});

check("fleetRow: lastAccepted fills status, lastSeenUtc and health together", () => {
  const sentAtUtc = new Date(NOW_MS - 2 * INTERVAL_MS).toISOString(); // well within online
  const payload = {
    checkinVersion: 1,
    deviceId: "dev-1",
    seq: 5,
    sentAtUtc,
    health: health({ cameras: [camera("cam-1", null, null)] }),
  };
  const lastAccepted = { atMs: Date.parse(sentAtUtc), payload };
  const r = fleetRow(device("dev-1", "claimed"), lastAccepted, NOW_MS, INTERVAL_MS);
  eq(r.deviceId, "dev-1");
  eq(r.state, "claimed");
  eq(r.status, "online");
  eq(r.lastSeenUtc, sentAtUtc);
  same(r.health, summarizeHealth(payload.health, NOW_MS));
});

check("fleetRow: an old lastAccepted reports offline, not never", () => {
  const sentAtUtc = new Date(NOW_MS - 20 * INTERVAL_MS).toISOString();
  const payload = { checkinVersion: 1, deviceId: "dev-1", seq: 9, sentAtUtc, health: health() };
  const lastAccepted = { atMs: Date.parse(sentAtUtc), payload };
  const r = fleetRow(device("dev-1", "claimed"), lastAccepted, NOW_MS, INTERVAL_MS);
  eq(r.status, "offline");
  if (r.health === null) throw new Error("a device that has checked in before must still report its last health, even offline");
});

report("fleet");
