import { siteHealth, DEFAULT_SILENT_AFTER_SECONDS } from "../dist/siteHealth.js";
import { check, same, report } from "./_assert.mjs";

console.log("siteHealth");

const AT = "2026-09-15T12:00:00.000Z";

function cam(cameraId, over = {}) {
  return {
    cameraId,
    resolved: true,
    unresolvedReason: null,
    measuredKbps: 200,
    segments: 10,
    bytes: 1_000_000,
    lastSealedUtc: "2026-09-15T11:59:30.000Z", // 30s ago
    openSegments: 1,
    ...over,
  };
}

function store(root, over = {}) {
  return {
    root,
    mounted: true,
    totalBytes: 6_000_000_000,
    freeBytes: 3_000_000_000,
    ...over,
  };
}

function input(over = {}) {
  return {
    siteId: "site-1",
    atUtc: AT,
    cameras: [cam("cam1-main")],
    stores: [store("/srv/camplat/disk0")],
    recorderRunning: true,
    ...over,
  };
}

// ---------------------------------------------------------------- the happy
// path exists only so the failures below mean something.
check("a measured, recording, half-full site is ok", () => {
  const h = siteHealth(input());
  same(h.status, "ok", "status");
  same(h.ok, true, "ok flag");
  same(h.cameras[0].state, "recording", "camera state");
  same(h.stores[0].state, "ok", "store state");
  same(h.totals.recording, 1, "one recording");
});

// ------------------------------------------------- THE FAILURE THAT STARTED
// IT: a camera that stopped sending days ago used to look exactly like a
// healthy one, because the old /health only counted rows.
check("a camera silent for an hour is degraded, not ok", () => {
  const h = siteHealth(input({
    cameras: [cam("cam1-main", { lastSealedUtc: "2026-09-15T11:00:00.000Z" })],
  }));
  same(h.cameras[0].state, "silent", "state");
  same(h.cameras[0].status, "degraded", "camera status");
  same(h.status, "degraded", "site status follows the worst part");
  same(h.ok, false, "ok is EARNED -- a silent camera is not ok");
  same(h.totals.silent, 1, "counted as silent");
  same(h.totals.recording, 0, "and NOT as recording");
  same(Math.round(h.cameras[0].secondsSinceSealed), 3600, "seconds since sealed");
});

check("the silence threshold is a boundary, not a vibe", () => {
  const justInside = siteHealth(input({
    cameras: [cam("c", { lastSealedUtc: "2026-09-15T11:57:00.000Z" })], // exactly 180s
  }));
  same(justInside.cameras[0].state, "recording", "exactly at the threshold is still recording");
  const justOutside = siteHealth(input({
    cameras: [cam("c", { lastSealedUtc: "2026-09-15T11:56:59.000Z" })], // 181s
  }));
  same(justOutside.cameras[0].state, "silent", "one second past it is silent");
  same(DEFAULT_SILENT_AFTER_SECONDS, 180, "default is three 60s segments");
});

check("a shorter threshold can be asked for, and is obeyed", () => {
  const h = siteHealth(
    input({ cameras: [cam("c", { lastSealedUtc: "2026-09-15T11:59:00.000Z" })] }), // 60s
    { silentAfterSeconds: 30 },
  );
  same(h.cameras[0].state, "silent", "60s silence with a 30s threshold");
});

// ------------------------------------------------------------- never vs dead
check("a brand new camera is unknown, not down and not ok", () => {
  const h = siteHealth(input({
    cameras: [cam("new", { lastSealedUtc: null, segments: 0, bytes: 0, measuredKbps: null })],
  }));
  same(h.cameras[0].state, "never_recorded", "state");
  same(h.cameras[0].status, "unknown", "a thing not yet proven is not green");
  same(h.status, "unknown", "site inherits it");
  same(h.ok, false, "and ok is false");
});

check("an unresolved camera is down and says why", () => {
  const h = siteHealth(input({
    cameras: [cam("bad", { resolved: false, unresolvedReason: "no password for host 10.0.0.9" })],
  }));
  same(h.cameras[0].state, "unresolved", "state");
  same(h.cameras[0].status, "down", "status");
  same(h.cameras[0].detail, "no password for host 10.0.0.9", "the reason survives to the screen");
  same(h.totals.unresolved, 1, "counted");
  same(h.status, "down", "site is down");
});

// ------------------------------------------------ THE UNMOUNTED STORE TRAP:
// recording into an unmounted mountpoint fills the root filesystem and reports
// a perfectly comfortable free figure while doing it.
check("an unmounted store is down even when it reports plenty of room", () => {
  const h = siteHealth(input({
    stores: [store("/srv/camplat/disk1", { mounted: false, totalBytes: 500_000_000_000, freeBytes: 490_000_000_000 })],
  }));
  same(h.stores[0].state, "unmounted", "state");
  same(h.stores[0].status, "down", "98% free changes nothing: it is not the disk we think it is");
  same(h.status, "down", "site is down");
});

check("no stores at all is down, never a quiet ok", () => {
  same(siteHealth(input({ stores: [] })).status, "down", "status");
});

check("disk fullness crosses at the documented fractions", () => {
  const at = (used, total = 100) =>
    siteHealth(input({ stores: [store("/d", { totalBytes: total, freeBytes: total - used })] })).stores[0];
  same(at(50).state, "ok", "half full");
  same(at(85).state, "filling", "85% is eviction territory, still healthy");
  same(at(94).state, "filling", "just under full");
  same(at(95).state, "full", "95% is full");
  same(at(85).status, "ok", "filling is expected on a working NVR, not a fault");
  same(at(95).status, "degraded", "full is a fault");
});

check("an unmeasurable store is unknown, and used bytes stay null -- not zero", () => {
  const h = siteHealth(input({
    stores: [store("/d", { totalBytes: null, freeBytes: null })],
  }));
  same(h.stores[0].state, "unmeasured", "state");
  same(h.stores[0].usedBytes, null, "used bytes unknown");
  same(h.stores[0].usedFraction, null, "fraction unknown, NOT 0 (an empty gauge reads as empty disk)");
  same(h.status, "unknown", "site status");
});

check("a zero-byte total does not become a divide-by-zero fraction", () => {
  const h = siteHealth(input({ stores: [store("/d", { totalBytes: 0, freeBytes: 0 })] }));
  same(h.stores[0].usedFraction, null, "no NaN, no Infinity, just unknown");
  same(h.stores[0].state, "unmeasured", "state");
});

// ------------------------------------------------------------------ retention
check("retention refuses when any camera is unmeasured, and names it", () => {
  const h = siteHealth(input({
    cameras: [cam("cam1-main"), cam("cam2-sub", { measuredKbps: null })],
  }));
  same(h.retention.kind, "unknown", "refused");
  same(h.retention.reason, "unmeasured_cameras", "reason");
  same(h.retention.unmeasuredCameraIds, ["cam2-sub"], "which camera");
  same(h.totals.camerasUnmeasured, 1, "counted");
  same(h.totals.measuredKbps, 200, "an unmeasured camera adds NOTHING, it does not add 0 kbps");
});

check("retention refuses when a mounted store did not report its size", () => {
  const h = siteHealth(input({
    stores: [store("/d0"), store("/d1", { totalBytes: null, freeBytes: null })],
  }));
  same(h.retention.kind, "unknown", "refused");
  same(h.retention.reason, "unmeasured_stores", "a part-measured total would read low and be believed");
});

check("retention is computed from measured cameras and mounted stores only", () => {
  // 200 kbps = 25000 bytes/s. 6e9 bytes / 25000 = 240000s = 2.777... days.
  const h = siteHealth(input());
  same(h.retention.kind, "ok", "computed");
  same(h.retention.totalKbps, 200, "total kbps");
  same(h.retention.camerasCounted, 1, "cameras counted");
  if (!(h.retention.days > 2.7 && h.retention.days < 2.8)) {
    throw new Error(`expected ~2.78 days, got ${h.retention.days}`);
  }
});

check("an unmounted store's capacity is not counted toward retention", () => {
  const withGhost = siteHealth(input({
    stores: [store("/d0"), store("/ghost", { mounted: false, totalBytes: 600_000_000_000 })],
  }));
  const alone = siteHealth(input());
  same(withGhost.retention.days, alone.retention.days, "a disk that is not there stores nothing");
});

// -------------------------------------------------------------- the recorder
check("a stopped recorder is down; an unknown one is unknown", () => {
  same(siteHealth(input({ recorderRunning: false })).status, "down", "stopped");
  same(siteHealth(input({ recorderRunning: null })).status, "unknown", "unknown");
  same(siteHealth(input({ recorderRunning: null })).recorderRunning, null, "reported as null, not false");
});

// --------------------------------------------------------------- arithmetic
check("totals add up across cameras", () => {
  const h = siteHealth(input({
    cameras: [
      cam("a", { segments: 3, bytes: 100, measuredKbps: 150 }),
      cam("b", { segments: 4, bytes: 250, measuredKbps: 350 }),
    ],
  }));
  same(h.totals.cameras, 2, "cameras");
  same(h.totals.segments, 7, "segments");
  same(h.totals.bytes, 350, "bytes");
  same(h.totals.measuredKbps, 500, "kbps");
});

check("the worst part wins, whatever order the parts arrive in", () => {
  const bad = cam("bad", { resolved: false });
  const good = cam("good");
  same(siteHealth(input({ cameras: [bad, good] })).status, "down", "bad first");
  same(siteHealth(input({ cameras: [good, bad] })).status, "down", "bad last");
});

check("an unreadable timestamp is unknown, never a huge silence", () => {
  const h = siteHealth(input({ cameras: [cam("c", { lastSealedUtc: "not a date" })] }));
  same(h.cameras[0].secondsSinceSealed, null, "no NaN reaching the screen");
  same(h.cameras[0].status, "unknown", "status");
});

check("no cameras at all: nothing crashes, retention refuses", () => {
  const h = siteHealth(input({ cameras: [] }));
  same(h.totals.cameras, 0, "count");
  same(h.retention.kind, "unknown", "no cameras means undefined retention, not infinite");
  same(h.retention.reason, "no_cameras", "reason");
});

check("the input is not mutated", () => {
  const i = input({ cameras: [cam("a"), cam("b")], stores: [store("/d0"), store("/d1")] });
  const before = JSON.stringify(i);
  siteHealth(i);
  same(JSON.stringify(i), before, "caller's object untouched");
});

report("siteHealth");
