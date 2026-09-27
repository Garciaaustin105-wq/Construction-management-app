/**
 * Manager rules' occupancy, wired into the REAL detect-service.mjs, driven
 * against a FAKE worker - same shape as harness/detectService.harness.mjs's
 * own checks, focused on the occupancy piece: MANAGER-RULES-SPEC.md
 * section 2's "Tests that matter" for Occupancy, plus the switch and the
 * failure paths this service's own job description names.
 *
 * THE FEARED FAILURES:
 * - a passer-by (a few seconds inside an area) counted as `present`;
 * - a seated person's brief dropout, or a still-scene gap under 120 s, read
 *   as `absent` rather than left alone;
 * - a still scene with no frames for 120 s read as `absent` instead of
 *   `not_watching`;
 * - a known-object car's EVENTS being hidden also hiding it from occupancy,
 *   which must never consult known objects at all;
 * - a settings-hidden detection (kind off, or outside a watch zone) counted
 *   as occupancy evidence;
 * - the switch off writing even one row;
 * - occupancy.db failing to open or write taking detection down with it.
 */
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { startDetect } from "../agent/detect-service.mjs";
import { openEventsDb } from "../agent/events-db.mjs";
import { openOccupancyDb } from "../agent/occupancy-db.mjs";
import { MERGE_GAP_MS } from "../dist/detection.js";
import { NOT_WATCHING_GAP_MS, ABSENT_HYSTERESIS_MS } from "../dist/zoneOccupancy.js";
import { wholeCameraAreaId } from "../dist/managerRules.js";
import { check, eq, report } from "./_assert.mjs";

console.log("occupancy run");

const T0 = Date.parse("2026-09-26T12:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();

async function site({ cameraIds = ["cam-1"] } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-occ-"));
  const store = await mkdtemp(path.join(tmpdir(), "camplat-occ-store-"));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
    siteId: "t", storeRoots: [store], segmentSeconds: 60,
    credentials: { username: "admin", password: "s3cret-pw" },
    cameras: cameraIds.map((cameraId, i) => ({
      cameraId,
      url: `rtsp://admin:s3cret-pw@10.0.0.${i + 1}:554/main`,
      substreamUrl: `rtsp://admin:s3cret-pw@10.0.0.${i + 1}:554/sub`,
    })),
  }));
  await writeFile(path.join(stateDir, "detect.json"), JSON.stringify({
    capacityFps: 20, cameras: cameraIds.map((cameraId) => ({ cameraId })),
  }));
  return stateDir;
}

function fakeWorkers() {
  const workers = [];
  const spawnFn = () => {
    const w = new EventEmitter();
    w.stdout = new EventEmitter();
    w.stderr = new EventEmitter();
    w.kill = () => { queueMicrotask(() => w.emit("exit", null)); return true; };
    w.say = (obj) => w.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
    workers.push(w);
    return w;
  };
  return { workers, spawnFn };
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function run({ cameraIds = ["cam-1"] } = {}) {
  const stateDir = await site({ cameraIds });
  const { workers, spawnFn } = fakeWorkers();
  let clock = T0;
  const svc = await startDetect({
    stateDir, spawnFn, now: () => new Date(clock), tickMs: 1_000_000, healthMs: 1_000_000,
    aiSettingsReloadMs: 1_000_000, occupancyReloadMs: 1_000_000,
    restartMs: { first: 40, max: 200 }, killAfterMs: 100,
    log: () => {},
  });
  return { stateDir, workers, svc, setClock: (ms) => { clock = T0 + ms; } };
}

/** One area on cam-1 covering the left half of the frame. */
const AREA = { id: "a1", cameraId: "cam-1", name: "Desk", points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] };
const INSIDE_BOX = { x: 0.1, y: 0.1, w: 0.1, h: 0.2 }; // ground point (0.15, 0.3): inside AREA
const OUTSIDE_BOX = { x: 0.7, y: 0.1, w: 0.1, h: 0.2 }; // ground point (0.75, 0.3): outside AREA
// Only the top ~60% of the box is inside AREA's left half (x in [0,0.5]):
// x=0.3, w=0.4 -> spans 0.3..0.7, half of the box's width sits inside.
// Chosen to match areas.harness.mjs's own "40%/60%" style coverage check.
const SEATED_BOX = { x: 0.3, y: 0.1, w: 0.4, h: 0.2 };

async function writeAreas(stateDir, areas) {
  await writeFile(path.join(stateDir, "areas.json"), JSON.stringify({ version: 1, areas }));
}
async function writeSite(stateDir, features) {
  await writeFile(path.join(stateDir, "site.json"), JSON.stringify({
    version: 1, displayName: null, timeZone: null, siteType: null, features,
    updatedUtc: at(0), updatedBy: "tech",
  }));
}
async function enableOccupancy(stateDir, svc, areas = [AREA]) {
  await writeAreas(stateDir, areas);
  await writeSite(stateDir, { managerRules: true });
  await svc.reloadOccupancyConfig();
}

function openOcc(stateDir) {
  return openOccupancyDb(path.join(stateDir, "occupancy.db"));
}
async function rowsFor(stateDir, areaId, kind) {
  let db;
  try {
    db = openOcc(stateDir);
  } catch {
    return []; // never opened at all: no rows, exactly as "no rows" means.
  }
  try {
    return db.transitionsFor(areaId, kind);
  } finally {
    db.close();
  }
}

await check("REQUIRED: the switch off - no areas.json even written - writes NO rows, whatever the frames say", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    setClock(30_000);
    await svc.tick();
    const rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.length, 0, "no areas.json, switch never turned on: nothing written");
  } finally {
    await svc.stop();
  }
});

await check("REQUIRED: the switch off, even WITH areas.json on file, writes NO rows", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    await writeAreas(stateDir, [AREA]); // areas exist, but managerRules is not on
    await svc.reloadOccupancyConfig();
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    setClock(30_000);
    await svc.tick();
    const rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.length, 0, "areas exist, but the switch is off: still nothing written");
  } finally {
    await svc.stop();
  }
});

await check("FEARED: a passer-by under 10 s never becomes present", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    await enableOccupancy(stateDir, svc);
    // Two frames, 5 s apart (well under the 10 s MERGE_GAP_MS presence
    // hysteresis), both with the person inside the area, then gone.
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(5_000), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(9_000), detections: [] }); // walked off
    await settle();
    const rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.length, 0, "never reached the 10 s presence threshold: no transition at all");
  } finally {
    await svc.stop();
  }
});

await check("REQUIRED: presence spanning 10 s DOES flip to present, written to occupancy.db with the right area/camera/kind", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    await enableOccupancy(stateDir, svc);
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    const rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.length, 1, "one transition, into present");
    eq(rows[0], { state: "present", atMs: T0 + MERGE_GAP_MS });
    const db = openOcc(stateDir);
    try {
      // Two rows total, deliberately: the drawn area's own transition, PLUS
      // the whole-camera synthetic tracker's (build gap 1) -- the SAME
      // person is visible evidence for both keys at once. Counting both
      // rather than filtering one away proves neither one silently ate the
      // other's write.
      const all = db.all();
      eq(all.length, 2, "the area's own row and the whole-camera row, not one or three");
      const byArea = all.filter((r) => r.areaId === AREA.id);
      const byWhole = all.filter((r) => r.areaId === wholeCameraAreaId("cam-1"));
      eq(byArea.length, 1);
      eq([byArea[0].areaId, byArea[0].cameraId, byArea[0].kind], [AREA.id, "cam-1", "person"], "the right (area, camera, kind)");
      eq(byWhole.length, 1);
      eq([byWhole[0].cameraId, byWhole[0].kind, byWhole[0].state], ["cam-1", "person", "present"], "the whole-camera tracker saw the same person");
    } finally {
      db.close();
    }
  } finally {
    await svc.stop();
  }
});

/* ------------------------------------------------------------------ */
/* Build gap 1: whole-camera occupancy (MANAGER-RULES-SPEC.md section 1's */
/* "a rule may also use whole camera") -- a site with the switch on but   */
/* NO areas drawn at all must still get a whole-camera tracker per kind,  */
/* fed the SAME evidence, the SAME hysteresis, and the SAME gap/          */
/* schedule-closed ticks a drawn area gets.                               */
/* ------------------------------------------------------------------ */

await check("REQUIRED: whole-camera occupancy runs even with zero areas drawn, keyed whole:<cameraId>", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    await enableOccupancy(stateDir, svc, []); // no drawn areas at all
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: OUTSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: OUTSIDE_BOX }] });
    await settle();
    // OUTSIDE_BOX would never satisfy any drawn area, but the whole-camera
    // tracker asks nothing about position -- "any visible detection of that
    // kind anywhere in frame" (MANAGER-RULES-SPEC.md section 1).
    const rows = await rowsFor(stateDir, wholeCameraAreaId("cam-1"), "person");
    eq(rows.length, 1, "one transition, into present, for the whole-camera tracker alone");
    eq(rows[0], { state: "present", atMs: T0 + MERGE_GAP_MS });
    const db = openOcc(stateDir);
    try {
      eq(db.all().length, 1, "no drawn area exists, so this is the only row written");
    } finally {
      db.close();
    }
  } finally {
    await svc.stop();
  }
});

await check("REQUIRED: a whole-camera not_watching never produces enters or leaves -- the gap tick reaches the whole-camera tracker too", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    await enableOccupancy(stateDir, svc, []); // no drawn areas
    // Real presence evidence first (INITIAL_OCCUPANCY_STATE is itself
    // not_watching -- a gap tick with no prior real frame is a no-op, per
    // advanceOccupancy's own idempotence, so this test needs a real
    // present-to-not_watching edge to prove anything at all).
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: OUTSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: OUTSIDE_BOX }] });
    await settle(); // present, lastFrameAtMs = T0 + MERGE_GAP_MS
    // No more frames at all (the gate is holding a still scene) - only the
    // tick advances, exactly as harness's own "still scene" check above
    // does for a drawn area, fed to the whole-camera tracker instead -- the
    // writer-side half of build gap 1's "a whole-camera not_watching never
    // produces enters or leaves" (the evaluator-side half, over a real
    // transition stream, lives in harness/managerRulesApi.harness.mjs).
    setClock(MERGE_GAP_MS + NOT_WATCHING_GAP_MS + 1);
    await svc.tick();
    const rows = await rowsFor(stateDir, wholeCameraAreaId("cam-1"), "person");
    eq(rows.map((r) => r.state), ["present", "not_watching"], "not_watching, never absent, written from the tick, not a frame");
  } finally {
    await svc.stop();
  }
});

await check("FEARED: a 20 s dropout of a seated person never becomes absent (the person hysteresis is 30 s)", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    await enableOccupancy(stateDir, svc);
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle(); // now present
    // 20 s of absence evidence - short of the 30 s person threshold.
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS + 20_000), detections: [] });
    await settle();
    const rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.length, 1, "still just the one transition, into present - the dropout never flipped it to absent");
    eq(rows[0].state, "present");
  } finally {
    await svc.stop();
  }
});

await check("REQUIRED: absence spanning the full person threshold DOES flip present to absent", async () => {
  const { stateDir, workers, svc } = await run();
  try {
    await enableOccupancy(stateDir, svc);
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle(); // present
    const goneAt = MERGE_GAP_MS + 1_000;
    workers[0].say({ type: "frame", atUtc: at(goneAt), detections: [] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(goneAt + ABSENT_HYSTERESIS_MS.person), detections: [] });
    await settle();
    const rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.map((r) => r.state), ["present", "absent"]);
  } finally {
    await svc.stop();
  }
});

await check("FEARED: a still scene with no frames for 120 s becomes not_watching, never absent - fed from the existing 1 s tick", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    await enableOccupancy(stateDir, svc);
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle(); // present, lastFrameAtMs = T0 + MERGE_GAP_MS
    // No more frames at all (the gate is holding a still scene) - only the
    // tick advances, exactly as a gated-still camera would behave.
    setClock(MERGE_GAP_MS + NOT_WATCHING_GAP_MS + 1);
    await svc.tick();
    const rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.map((r) => r.state), ["present", "not_watching"], "not_watching, never absent, and written from the tick, not a frame");
  } finally {
    await svc.stop();
  }
});

await check("REQUIRED: the schedule closing is fed as scheduleClosed on the very next frame, forcing not_watching at once", async () => {
  const { stateDir, workers, svc } = await run();
  try {
    await enableOccupancy(stateDir, svc);
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle(); // present
    await writeFile(path.join(stateDir, "camera-ai.json"), JSON.stringify({
      version: 1,
      cameras: { "cam-1": { zones: [], schedule: { timeZone: "UTC", weekly: [[], [], [], [], [], [], []], closedDates: [] }, minConfidence: null, kinds: { person: true, vehicle: true }, updatedUtc: at(0), updatedBy: "tech" } },
    }));
    await svc.reloadAiSettings();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS + 1_000), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    const rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.map((r) => r.state), ["present", "not_watching"], "closed at once - no 30 s absence hysteresis needed");
  } finally {
    await svc.stop();
  }
});

await check("REQUIRED: a car that is a known object still shows PRESENT in its spot (occupancy never consults known objects)", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  const VEHICLE_AREA = { ...AREA, id: "a-veh", name: "Manager parking spot" };
  try {
    await enableOccupancy(stateDir, svc, [VEHICLE_AREA]);
    // A vehicle that never moves for hours - exactly the shape that would be
    // learned as a known object and have its EVENTS hidden. Occupancy must
    // not care: it reads raw frames only.
    for (let i = 0; i < 8; i += 1) {
      workers[0].say({ type: "frame", atUtc: at(i * 20 * 60_000), detections: [{ kind: "vehicle", confidence: 0.9, box: INSIDE_BOX }] });
      await settle();
    }
    const rows = await rowsFor(stateDir, VEHICLE_AREA.id, "vehicle");
    eq(rows.length, 1, "one transition: into present, and it stays present the whole time");
    eq(rows[0].state, "present");
    // Confirm events.db really did hide nothing special here (not the point
    // of this check, but proves the two systems are truly independent: the
    // car's events are ordinary, unsuppressed sightings, and occupancy is
    // present regardless of whatever known-objects does or does not do).
    const db = openEventsDb(path.join(stateDir, "events.db"));
    eq(db.all().length > 0, true, "the vehicle's events exist independently of occupancy");
    db.close();
  } finally {
    await svc.stop();
  }
});

await check("FEARED: a seated person with only ~60% of the box inside the area still counts (boxInsideArea's coverage test, not just the ground point)", async () => {
  const { stateDir, workers, svc } = await run();
  try {
    await enableOccupancy(stateDir, svc);
    // SEATED_BOX's ground point (x+w/2=0.5, y+h=0.3) sits exactly on AREA's
    // right edge - inclusive - but this check is about the coverage path
    // mattering too: most of the box (x in 0.3..0.5 out of 0.3..0.7) is
    // inside the left half.
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: SEATED_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: SEATED_BOX }] });
    await settle();
    const rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.map((r) => r.state), ["present"], "counted as inside");
  } finally {
    await svc.stop();
  }
});

await check("FEARED: a settings-hidden detection (kind switched off) is NOT evidence - the area stays not_watching, never present", async () => {
  const { stateDir, workers, svc } = await run();
  try {
    await enableOccupancy(stateDir, svc);
    await writeFile(path.join(stateDir, "camera-ai.json"), JSON.stringify({
      version: 1,
      cameras: { "cam-1": { zones: [], schedule: null, minConfidence: null, kinds: { person: false, vehicle: true }, updatedUtc: at(0), updatedBy: "tech" } },
    }));
    await svc.reloadAiSettings();
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(2 * MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    const rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.length, 0, "person detections exist every frame, but this camera's kind switch hides them: never evidence, no transition");
    // events.db, meanwhile, DOES store them (hidden behind settings:kind) -
    // proving the detections really were there, and it is occupancy alone
    // that must ignore them.
    const db = openEventsDb(path.join(stateDir, "events.db"));
    eq(db.all().some((r) => r.suppressedBy === "settings:kind"), true);
    db.close();
  } finally {
    await svc.stop();
  }
});

await check("FEARED: a settings-hidden detection (outside the watch zone) is NOT evidence either - the SAME box inside the zone is", async () => {
  const { stateDir, workers, svc } = await run();
  try {
    await enableOccupancy(stateDir, svc);
    // A watch zone covering only the RIGHT half of the frame - AREA (the
    // occupancy polygon) is the LEFT half, so a person standing in AREA is
    // outside this camera's own watch zone and therefore settings-hidden.
    const RIGHT_HALF_ZONE = { id: "z1", mode: "watch", points: [[0.5, 0], [1, 0], [1, 1], [0.5, 1]] };
    await writeFile(path.join(stateDir, "camera-ai.json"), JSON.stringify({
      version: 1,
      cameras: { "cam-1": { zones: [RIGHT_HALF_ZONE], schedule: null, minConfidence: null, kinds: { person: true, vehicle: true }, updatedUtc: at(0), updatedBy: "tech" } },
    }));
    await svc.reloadAiSettings();
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    let rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.length, 0, "outside the watch zone: settings-hidden, never evidence for the area inside it");

    // Now put the SAME area inside the watch zone (widen it to the whole
    // frame) - the same shape of evidence now counts.
    const WHOLE_FRAME_ZONE = { id: "z1", mode: "watch", points: [[0, 0], [1, 0], [1, 1], [0, 1]] };
    await writeFile(path.join(stateDir, "camera-ai.json"), JSON.stringify({
      version: 1,
      cameras: { "cam-1": { zones: [WHOLE_FRAME_ZONE], schedule: null, minConfidence: null, kinds: { person: true, vehicle: true }, updatedUtc: at(0), updatedBy: "tech" } },
    }));
    await svc.reloadAiSettings();
    workers[0].say({ type: "frame", atUtc: at(2 * MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(3 * MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    rows = await rowsFor(stateDir, AREA.id, "person");
    eq(rows.map((r) => r.state), ["present"], "same box, now visible: counted");
  } finally {
    await svc.stop();
  }
});

await check("REQUIRED: a DB write failure does not stop detection - occupancy.db cannot even be opened (a directory sits at its path)", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    await mkdir(path.join(stateDir, "occupancy.db")); // occupancy.db's own path is a directory: opening it as a file throws
    await enableOccupancy(stateDir, svc);
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    workers[0].say({ type: "frame", atUtc: at(MERGE_GAP_MS), detections: [{ kind: "person", confidence: 0.9, box: INSIDE_BOX }] });
    await settle();
    setClock(2 * MERGE_GAP_MS + 1_000);
    await svc.tick();
    // Detection itself is unaffected: events.db still gets the person's
    // event, finished after the gap, exactly as it would with no occupancy
    // feature running at all.
    const db = openEventsDb(path.join(stateDir, "events.db"));
    const rows = db.all();
    eq(rows.length, 1, "the event is stored and finished despite occupancy.db being unusable");
    eq(rows[0].finished, true);
    db.close();
  } finally {
    await svc.stop();
  }
});

report("occupancy run");
