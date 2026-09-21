/**
 * How long each camera keeps footage, from what is on the drives
 * (contracts/footageHeld.ts).
 *
 * WHY. On 2026-09-21 the laptop NVR held 4.1 hours of main stream and nothing
 * said so. health.json refused ("no measured bitrate") because it read the
 * CONFIGURED bitrate, and raised an alarm that never cleared. The System page
 * pooled the raw size of both drives against a median bitrate and showed
 * about 10.6 hours. The numbers below are that box's, measured that day.
 *
 * THE FEARED FAILURES, each a number that would look right:
 * - pooling drives, so a camera alone on a small drive borrows the other one;
 * - projecting from part of a day: the bench camera writes 5.40 Mbps all
 *   night under infrared and 1.4-3.3 by day, so four afternoon hours promise
 *   twice the room there really is;
 * - projecting from a day with holes, which reads the same way;
 * - calling a drive "full, so what is held is what is kept" while it is still
 *   deleting footage from cameras that were removed, which are oldest;
 * - a camera with nothing, or a drive that did not answer, shown as 0.
 */
import {
  footageHeld, PROJECTION_WINDOW_MS, MIN_WINDOW_COVERAGE, CYCLING_TOLERANCE, DAY_MS, HOUR_MS,
} from "../dist/footageHeld.js";
import { check, eq, report } from "./_assert.mjs";

console.log("footageHeld");

const H = HOUR_MS;
const NOW = Date.parse("2026-09-21T19:36:00.000Z"); // 15:36 EDT, when it was measured
const near = (got, want, tol, what) => eq(Math.abs(got - want) <= tol, true, `${what}: ${got} vs ${want}`);

/** A group of sealed segments. Defaults: 4 h of history, all of it inside the window. */
const row = (cameraId, root, o = {}) => ({
  cameraId, root, segments: 240, bytes: 1e9,
  oldestMs: NOW - 4 * H, newestMs: NOW - 30_000, recordedMs: 4 * H,
  windowBytes: 1e9, windowRecordedMs: 4 * H, ...o,
});
/** A camera with a whole, unbroken day behind it that wrote `perDay` bytes in it. */
const fullDay = (cameraId, root, perDay, o = {}) => row(cameraId, root, {
  bytes: perDay * 1.25, oldestMs: NOW - 30 * H, recordedMs: 30 * H,
  windowBytes: perDay, windowRecordedMs: 24 * H, ...o,
});
const input = (o) => ({ nowMs: NOW, ringFill: 0.85, maxAgeMs: null, ...o });
const cam = (out, id) => out.cameras.find((c) => c.cameraId === id);
const store = (out, root) => out.stores.find((s) => s.root === root);

// The bench, 2026-09-21 15:36 EDT, before disk0 was grown.
const DISK = 6_375_342_080;
const BENCH = input({
  cameraIds: ["cam1-main", "cam2-sub"],
  stores: [
    { root: "/srv/camplat/disk0", totalBytes: DISK, usedBytes: 5_495_869_440 },
    { root: "/srv/camplat/disk1", totalBytes: DISK, usedBytes: 5_413_814_272 },
  ],
  footage: [
    row("cam1-main", "/srv/camplat/disk0", {
      bytes: 4.83e9, oldestMs: NOW - 4.117 * H, recordedMs: 4.117 * H,
      windowBytes: 4.83e9, windowRecordedMs: 4.117 * H,
    }),
    fullDay("cam2-sub", "/srv/camplat/disk1", 1.015e9, { bytes: 1.98e9, oldestMs: NOW - 65.6 * H }),
    // Half an hour each from the 16-camera load test on 2026-09-18. Those
    // cameras are no longer configured; their footage is still on disk1.
    ...[9, 10, 11, 12, 13, 14, 15, 16].map((n) => row(`cam${n}`, "/srv/camplat/disk1", {
      bytes: 0.4e9, oldestMs: NOW - 70 * H, newestMs: NOW - 69.5 * H, recordedMs: 0.5 * H,
      windowBytes: 0, windowRecordedMs: 0,
    })),
  ],
});

check("a rate is only taken from a whole, nearly unbroken day", () => {
  eq(PROJECTION_WINDOW_MS, DAY_MS, "a day, because night and day record differently");
  eq(MIN_WINDOW_COVERAGE >= 0.9, true, "and nearly all of it recorded");
  eq(CYCLING_TOLERANCE > 0 && CYCLING_TOLERANCE <= 0.05, true, "full means at the ring, give or take one eviction pass");
});

check("THE POOLED ONE: a camera alone on a small full drive keeps what that drive holds", () => {
  const out = footageHeld(BENCH);
  eq(out.kind, "ok", "answers");
  const main = cam(out, "cam1-main");
  eq(main.keeps.basis, "measured", "disk0 is full: what is held is what is kept");
  near(main.keeps.hours, 4.117, 0.01, "4.1 hours, as measured on the box");
  eq(main.keeps.hours < 5, true, "not the 10.6 the System page showed by pooling both drives");
  near(out.hours, 4.117, 0.01, "and the site keeps only as long as its worst camera");
  eq(out.limitingCameraId, "cam1-main", "which it names");
});

check("THE AFTERNOON ONE: part of a day is a floor, never a projection", () => {
  // disk0 just after it was grown to 64 GB: 4.9 hours of afternoon footage.
  // Projected from those hours it would claim about 49 hours of room; the
  // night stream runs at twice the rate, so the truth is nearer 31.
  const out = footageHeld(input({
    cameraIds: ["cam1-main"],
    stores: [{ root: "/d0", totalBytes: 64e9, usedBytes: 6.53e9 }],
    footage: [row("cam1-main", "/d0", {
      bytes: 5.4e9, oldestMs: NOW - 4.9 * H, recordedMs: 4.9 * H, windowBytes: 5.4e9, windowRecordedMs: 4.9 * H,
    })],
  }));
  const main = cam(out, "cam1-main");
  eq(main.keeps.ok, true, "this is not a refusal: something true can be said");
  eq(main.keeps.basis, "at_least", "it is a floor");
  near(main.keeps.hours, 4.9, 0.01, "the hours actually held");
  eq(store(out, "/d0").projectedHours, null, "no projection is made");
  eq(/full day/.test(store(out, "/d0").noProjection), true, `and it says why: ${store(out, "/d0").noProjection}`);
  eq(out.kind, "ok", "and it is not reported as unknown, which would raise an alarm");
});

check("a whole day of history projects from the bytes really written", () => {
  // 40.47 GB is what disk0 freed in the 23.9 h before 2026-09-21 16:09: a
  // real day of the bench main stream. On 64 GB at a ring of 0.85, with
  // 1.1 GB of other use: (54.4 - 1.1) / 40.47 * 24 = 31.6 hours.
  const out = footageHeld(input({
    cameraIds: ["cam1-main"],
    stores: [{ root: "/d0", totalBytes: 64e9, usedBytes: 50.6e9 + 1.1e9 }],
    footage: [fullDay("cam1-main", "/d0", 40.47e9, { bytes: 50.6e9 })],
  }));
  const main = cam(out, "cam1-main");
  eq(main.keeps.basis, "projected", "projected, and labelled so");
  near(main.keeps.hours, ((64e9 * 0.85 - 1.1e9) / 40.47e9) * 24, 0.01, "room over a day's bytes");
  near(main.keeps.hours, 31.6, 0.05, "about 31.6 hours");
  near(store(out, "/d0").bytesPerDay, 40.47e9, 1, "the day's bytes are reported with the estimate");
});

check("THE HOLES ONE: a day with the night missing is not a day", () => {
  const out = footageHeld(input({
    cameraIds: ["cam1-main"],
    stores: [{ root: "/d0", totalBytes: 64e9, usedBytes: 30e9 }],
    footage: [fullDay("cam1-main", "/d0", 20e9, { windowRecordedMs: 21 * H })],
  }));
  eq(cam(out, "cam1-main").keeps.basis, "at_least", "no projection from a broken day");
  eq(/missing/.test(store(out, "/d0").noProjection), true, `says so: ${store(out, "/d0").noProjection}`);
});

check("THE FOREIGN ONE: a full drive still clearing removed cameras is not steady", () => {
  // disk1 is full, but its oldest footage belongs to the load-test cameras,
  // 70 hours old. Reading that as "cam2-sub keeps 70 h" would be measuring the
  // leftovers. The projection is used instead, and the leftovers are named.
  const out = footageHeld(BENCH);
  const sub = cam(out, "cam2-sub");
  const d1 = store(out, "/srv/camplat/disk1");
  eq(d1.full, true, "disk1 is full");
  eq(sub.keeps.basis, "projected", "so its horizon is not taken as a measurement");
  near(d1.foreignBytes, 3.2e9, 1, "3.2 GB from cameras no longer configured, reported");
  eq(/no longer configured/.test(sub.keeps.note), true, `and explained: ${sub.keeps.note}`);
  eq(d1.cameraIds, ["cam2-sub"], "only configured cameras are asked what they keep");
});

check("two cameras on one drive share it: the projection uses both rates", () => {
  const out = footageHeld(input({
    cameraIds: ["a", "b"],
    stores: [{ root: "/d", totalBytes: 100e9, usedBytes: 40e9 }],
    footage: [fullDay("a", "/d", 10e9, { bytes: 20e9 }), fullDay("b", "/d", 30e9, { bytes: 20e9 })],
  }));
  near(store(out, "/d").bytesPerDay, 40e9, 1, "10 + 30 GB a day");
  near(cam(out, "a").keeps.hours, (85e9 / 40e9) * 24, 0.01, "a keeps what the shared drive keeps");
  eq(cam(out, "a").keeps.hours, cam(out, "b").keeps.hours, "and so does b: eviction is oldest-first across the drive");
});

check("one camera without a full day stops the projection for its whole drive", () => {
  const out = footageHeld(input({
    cameraIds: ["a", "new"],
    stores: [{ root: "/d", totalBytes: 100e9, usedBytes: 40e9 }],
    footage: [fullDay("a", "/d", 10e9), row("new", "/d")],
  }));
  eq(store(out, "/d").projectedHours, null, "a rate that leaves out the new camera would read long");
  eq(cam(out, "a").keeps.basis, "at_least", "so a falls back to its floor");
});

check("the keep-for limit wins when it deletes first, and only then", () => {
  const limit = 24 * H;
  const projected = input({
    cameraIds: ["cam1-main"], maxAgeMs: limit,
    stores: [{ root: "/d0", totalBytes: 64e9, usedBytes: 51.7e9 }],
    footage: [fullDay("cam1-main", "/d0", 40.47e9, { bytes: 50.6e9 })],
  });
  const a = cam(footageHeld(projected), "cam1-main").keeps;
  eq(a.basis, "age_limit", "31.6 h of room, a 24 h limit: the limit deletes");
  eq(a.hours, 24, "24 hours");

  const measured = cam(footageHeld({ ...BENCH, maxAgeMs: limit }), "cam1-main").keeps;
  eq(measured.basis, "measured", "4.1 h of room under a 24 h limit: the space deletes");

  const floorBelow = cam(footageHeld(input({
    cameraIds: ["c"], maxAgeMs: limit,
    stores: [{ root: "/d", totalBytes: 64e9, usedBytes: 6e9 }], footage: [row("c", "/d")],
  })), "c").keeps;
  eq(floorBelow.basis, "at_least", "a 4 h floor under a 24 h limit says nothing about which comes first");

  const floorAbove = cam(footageHeld(input({
    cameraIds: ["c"], maxAgeMs: limit,
    stores: [{ root: "/d", totalBytes: 640e9, usedBytes: 60e9 }],
    footage: [row("c", "/d", { oldestMs: NOW - 30 * H, windowRecordedMs: 20 * H })],
  })), "c").keeps;
  eq(floorAbove.basis, "age_limit", "30 h already held under a 24 h limit: the limit is what deletes");
});

check("the space figure ignores the limit, so a new limit can be judged against it", () => {
  // The Recording page warns "the drives fill before this limit" while a new
  // limit is being typed. It needs what the space allows on its own; folding
  // the current limit in would compare the new limit with the old one.
  const out = footageHeld(input({
    cameraIds: ["cam1-main"], maxAgeMs: 24 * H,
    stores: [{ root: "/d0", totalBytes: 64e9, usedBytes: 51.7e9 }],
    footage: [fullDay("cam1-main", "/d0", 40.47e9, { bytes: 50.6e9 })],
  }));
  eq(out.hours, 24, "kept: the 24 h limit");
  eq(out.basis, "age_limit", "because the limit deletes first");
  near(out.spaceHours, 31.6, 0.05, "while the space alone would allow 31.6 h");
  eq(out.spaceBasis, "projected", "an estimate");
  eq(cam(out, "cam1-main").space.basis, "projected", "and each camera carries both");
});

check("other use on the drive shrinks the room: held segments, clip links, the filesystem", () => {
  const base = input({
    cameraIds: ["a"], stores: [{ root: "/d", totalBytes: 100e9, usedBytes: 30e9 }],
    footage: [fullDay("a", "/d", 10e9, { bytes: 30e9 })],
  });
  const clean = cam(footageHeld(base), "a").keeps.hours;
  const crowded = cam(footageHeld({ ...base, stores: [{ root: "/d", totalBytes: 100e9, usedBytes: 50e9 }] }), "a").keeps.hours;
  near(clean - crowded, (20e9 / 10e9) * 24, 0.01, "20 GB of other use costs two days");
});

check("BLANK IS NOT ZERO: nothing held, or a drive that did not answer, is said in words", () => {
  const nothing = footageHeld(input({
    cameraIds: ["a", "b"], stores: [{ root: "/d", totalBytes: 100e9, usedBytes: 10e9 }],
    footage: [fullDay("a", "/d", 5e9)],
  }));
  eq(nothing.kind, "unknown", "one camera with no footage makes the site unknown");
  eq(nothing.unknownCameraIds, ["b"], "and names it");
  eq(cam(nothing, "b").keeps.reason, "nothing_held", "for that reason");
  eq("hours" in cam(nothing, "b").keeps, false, "with no hours at all, not zero");
  eq(cam(nothing, "a").keeps.ok, true, "the other camera is still reported");

  const deaf = footageHeld(input({
    cameraIds: ["a"], stores: [{ root: "/d", totalBytes: null, usedBytes: null }], footage: [fullDay("a", "/d", 5e9)],
  }));
  eq(cam(deaf, "a").keeps.reason, "store_unmeasured", "a drive with no size is not an empty drive");
  eq(store(deaf, "/d").ringBytes, null, "and its figures stay null");

  const lost = footageHeld(input({
    cameraIds: ["a"], stores: [{ root: "/d", totalBytes: 100e9, usedBytes: 10e9 }], footage: [fullDay("a", "/gone", 5e9)],
  }));
  eq(cam(lost, "a").keeps.reason, "drive_unknown", "footage on a drive that is not configured");

  const legacy = footageHeld(input({
    cameraIds: ["a"], stores: [{ root: "/d", totalBytes: 100e9, usedBytes: 10e9 }], footage: [fullDay("a", null, 5e9)],
  }));
  eq(cam(legacy, "a").keeps.reason, "drive_unknown", "rows that never recorded their drive");
  eq(cam(legacy, "a").unattributedBytes > 0, true, "and their bytes are reported, not dropped");
});

check("a camera moved to another drive keeps what its NEW drive keeps", () => {
  const out = footageHeld(input({
    cameraIds: ["a"],
    stores: [
      { root: "/old", totalBytes: 100e9, usedBytes: 20e9 },
      { root: "/new", totalBytes: 100e9, usedBytes: 5e9 },
    ],
    footage: [
      row("a", "/old", { oldestMs: NOW - 50 * H, newestMs: NOW - 3 * H, windowBytes: 0, windowRecordedMs: 0 }),
      row("a", "/new", { oldestMs: NOW - 3 * H, recordedMs: 3 * H }),
    ],
  }));
  eq(cam(out, "a").root, "/new", "it records to the drive holding its newest footage");
  near(cam(out, "a").heldHours, 50, 0.01, "but its old footage is still viewable, so it reaches back 50 h");
});

check("THE MOVED ONE: a day on the OLD drive is not a day on the new one", () => {
  // Found in review: the projection took every row the camera had, from any
  // drive, so a camera moved an hour ago borrowed 23 hours of its old drive's
  // history and the new, nearly empty drive promised about 8 days. That is
  // the pooling bug again, inside the code written to end it. The old row
  // here carries REAL window bytes, which the check above zeroes.
  const out = footageHeld(input({
    cameraIds: ["a"],
    stores: [
      { root: "/old", totalBytes: 100e9, usedBytes: 40e9 },
      { root: "/new", totalBytes: 100e9, usedBytes: 5e9 },
    ],
    footage: [
      row("a", "/old", {
        bytes: 9.6e9, oldestMs: NOW - 25 * H, newestMs: NOW - 1 * H, recordedMs: 24 * H,
        windowBytes: 9.6e9, windowRecordedMs: 23 * H,
      }),
      row("a", "/new", { bytes: 0.4e9, oldestMs: NOW - 1 * H, recordedMs: 1 * H, windowBytes: 0.4e9, windowRecordedMs: 1 * H }),
    ],
  }));
  eq(store(out, "/new").projectedHours, null, "one hour on the new drive is not enough to project from");
  eq(cam(out, "a").keeps.basis, "at_least", "so the camera gets a floor");
  eq(store(out, "/new").bytesPerDay, null, "and no rate is borrowed from /old");
});

check("leftovers are only 'cleared first' when they are the oldest thing on the drive", () => {
  // Found in review: the note said so whenever any leftover footage existed,
  // even when a configured camera's own footage was older and would go first.
  const make = (foreignAgeH) => footageHeld(input({
    cameraIds: ["a"],
    stores: [{ root: "/d", totalBytes: 100e9, usedBytes: 85e9 }],
    footage: [
      fullDay("a", "/d", 6e9, { bytes: 50e9, oldestMs: NOW - 200 * H }),
      row("gone", "/d", { bytes: 1e9, oldestMs: NOW - foreignAgeH * H, newestMs: NOW - (foreignAgeH - 1) * H, windowBytes: 0, windowRecordedMs: 0 }),
    ],
  }));
  const newer = make(5);
  eq(store(newer, "/d").foreignClearedFirst, false, "5 h old leftovers are newer than a's 200 h");
  eq(/cleared first/.test(cam(newer, "a").keeps.note), false, `so the note does not claim it: ${cam(newer, "a").keeps.note}`);
  eq(/still takes up room/.test(cam(newer, "a").keeps.note), true, "it says they take up room instead");
  const older = make(300);
  eq(store(older, "/d").foreignClearedFirst, true, "300 h old leftovers are the oldest");
  eq(/cleared first/.test(cam(older, "a").keeps.note), true, "and then the note says so");
});

check("THE CONFIG ONE: nothing a camera was asked to send can move the answer", () => {
  // The old health.json path read config.cameras[].bitrateKbps. There is no
  // such input here; a row that carries one anyway changes nothing.
  const plain = footageHeld(BENCH);
  const dressed = footageHeld({ ...BENCH, footage: BENCH.footage.map((r) => ({ ...r, bitrateKbps: 8000 })) });
  eq(dressed.hours, plain.hours, "identical");
});

check("it states measurements and their basis, never a verdict", () => {
  const out = footageHeld(BENCH);
  for (const k of ["status", "ok", "healthy", "tone", "alert"]) eq(k in out, false, `no ${k} on the summary`);
});

check("it never throws, whatever it is handed", () => {
  const rubbish = [null, undefined, 0, "x", [], {}, { nowMs: NOW },
    { ...BENCH, nowMs: NaN }, { ...BENCH, cameraIds: "cam1" }, { ...BENCH, footage: [null] },
    { ...BENCH, footage: [{ ...BENCH.footage[0], bytes: -1 }] }, { ...BENCH, stores: [{ root: 5 }] },
    { ...BENCH, ringFill: 0 }, { ...BENCH, ringFill: 1.5 }, { ...BENCH, maxAgeMs: -5 }, Object.create(null)];
  for (const [i, bad] of rubbish.entries()) {
    let out;
    let threw = false;
    try { out = footageHeld(bad); } catch { threw = true; }
    eq(threw, false, `survived rubbish #${i}`);
    eq(out?.kind, "unknown", `and answered unknown for #${i}`);
  }
  eq(footageHeld(null).reason, "bad_input", "saying the input was unreadable");
});

report("footageHeld");
