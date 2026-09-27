/**
 * Appearance of the day (APPEARANCE-OF-DAY-SPEC.md, MANAGER-RULES-SPEC.md
 * build 3), wired into the REAL agent/detect-service.mjs (driven against a
 * FAKE worker, same shape as harness/occupancyRun.harness.mjs's own checks)
 * AND the REAL agent/api-server.mjs (same shape as harness/
 * managerRulesApi.harness.mjs's own evaluator checks). NOT added to
 * harness/run-all.mjs — run directly: node harness/appearanceOfDay.harness.mjs.
 *
 * THE FEARED FAILURES:
 * - learning counting a sighting from the SECOND hour toward the FIRST
 *   hour's own 20-signature minimum;
 * - appearance-today.json surviving past the local day it was learned for,
 *   or a stale-dated file surviving a fresh start;
 * - the switch off still launching a worker with --appearance, or leaving
 *   appearance-today.json or a manager-match sighting behind;
 * - a person who does NOT match today's manager getting a manager-match row
 *   anyway;
 * - "Manager leaves"/"Manager returns" firing on a departure that was
 *   cancelled (a desk sighting too soon), or with the wrong wording;
 * - GET /appearance/status ever echoing a signature, even one that leaked
 *   into detect-health.json by a bug upstream.
 *
 * NO FACE RECOGNITION ANYWHERE IN THIS FILE: every "signature" below is a
 * flat 145-number array this file invents by hand (a one-hot histogram plus
 * an aspect ratio) — never a pixel, a crop, or anything derived from one.
 */
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { startDetect } from "../agent/detect-service.mjs";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { indexPathFor } from "../agent/config.mjs";
import { openOccupancyDb } from "../agent/occupancy-db.mjs";
import { MIN_SIGNATURES_TO_LEARN } from "../dist/appearance.js";
import { check, eq, report } from "./_assert.mjs";

console.log("appearance of the day");

// ---------------------------------------------------------------- shared fixtures

/** A 145-number signature nothing here ever calls a "face": a one-hot
 *  histogram in each region (`bin`) plus a fixed aspect ratio. Two different
 *  bins are as dissimilar as two signatures can be (disjoint histograms ->
 *  a Bhattacharyya coefficient of exactly 0, so similarity() is exactly 0%);
 *  the SAME bin is a perfect match (100%) — a clean, deterministic contrast
 *  for wiring-level checks, never meant to stand in for detector/
 *  appearance.py's own math (harness/appearanceSignature.harness.mjs's job). */
function signature(bin) {
  const arr = new Array(145).fill(0);
  arr[bin] = 1;
  arr[72 + bin] = 1;
  arr[144] = 0.4;
  return arr;
}
const MANAGER_SIG = signature(0);
const OTHER_PERSON_SIG = signature(5);

const DESK_AREA = { id: "desk-1", cameraId: "cam-1", name: "Manager's desk", role: "managerDesk", points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] };
/** Ground point (0.15, 0.3): inside DESK_AREA. */
const DESK_BOX = { x: 0.1, y: 0.1, w: 0.1, h: 0.2 };

function fakeWorkers() {
  const workers = [];
  const calls = [];
  const spawnFn = (_python, args) => {
    calls.push(args);
    const w = new EventEmitter();
    w.stdout = new EventEmitter();
    w.stderr = new EventEmitter();
    w.kill = () => { queueMicrotask(() => w.emit("exit", null)); return true; };
    w.say = (obj) => w.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
    workers.push(w);
    return w;
  };
  return { workers, calls, spawnFn };
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function siteStateDir({ cameraIds = ["cam-1"] } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-appear-"));
  const store = await mkdtemp(path.join(tmpdir(), "camplat-appear-store-"));
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

async function writeAreas(stateDir, areas) {
  await writeFile(path.join(stateDir, "areas.json"), JSON.stringify({ version: 1, areas: [DESK_AREA, ...areas.filter((a) => a.id !== DESK_AREA.id)] }));
}

/** Open, every day, all day, in UTC — this suite is about the WIRING, not
 *  open-hours arithmetic (contracts/alertRules.ts's own harness owns that). */
const OPEN_ALL_WEEK = { timeZone: "UTC", weekly: [0, 1, 2, 3, 4, 5, 6].map(() => [{ open: 0, close: 1440 }]), closedDates: [] };

async function writeSite(stateDir, { appearanceOfDay, openHours, updatedUtc }) {
  await writeFile(path.join(stateDir, "site.json"), JSON.stringify({
    version: 1, displayName: null, timeZone: null, siteType: null,
    features: { appearanceOfDay },
    openHours, appearanceMatchPercent: 80,
    updatedUtc, updatedBy: "tech",
  }));
}

function openOcc(stateDir) {
  return openOccupancyDb(path.join(stateDir, "occupancy.db"));
}
async function managerMatchRows(stateDir, areaId) {
  let db;
  try { db = openOcc(stateDir); } catch { return []; } // never opened at all: no rows
  try { return db.managerMatchesForArea(areaId); } finally { db.close(); }
}
async function readAppearanceTodayFile(stateDir) {
  try {
    return JSON.parse(await readFile(path.join(stateDir, "appearance-today.json"), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** writeAppearanceTodayFile (agent/detect-service.mjs) deliberately fires the
 *  actual disk write (tmp then rename) without the frame path ever awaiting
 *  it — the in-memory copy (`svc.appearanceToday()`) is authoritative the
 *  instant learning succeeds, and the file catches up on its own chain.
 *  A caller that wants the FILE (not just the in-memory copy) polls for it,
 *  the same bounded-retry style already used below for the api-server
 *  evaluator's own eventual write to rules.db. */
async function waitForAppearanceTodayFile(stateDir, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    const file = await readAppearanceTodayFile(stateDir);
    if (file !== null) return file;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

// Local midnight UTC — OPEN_ALL_WEEK opens at minute 0 every day, so
// firstManagerWindowsToday's own "earliest interval of the day" is exactly
// local midnight, and the first-hour window is exactly [T0, T0 + 1h), the
// second [T0, T0 + 2h).
const T0 = Date.parse("2026-09-28T00:00:00.000Z");
const at = (ms) => new Date(ms).toISOString();

async function runDetect({ cameraIds = ["cam-1"], nowMs = T0 } = {}) {
  const stateDir = await siteStateDir({ cameraIds });
  const { workers, calls, spawnFn } = fakeWorkers();
  let clock = nowMs;
  const svc = await startDetect({
    stateDir, spawnFn, now: () => new Date(clock), tickMs: 1_000_000, healthMs: 1_000_000,
    aiSettingsReloadMs: 1_000_000, occupancyReloadMs: 1_000_000, appearanceReloadMs: 1_000_000,
    restartMs: { first: 20, max: 100 }, killAfterMs: 100,
    log: () => {},
  });
  return { stateDir, workers, calls, svc, setClock: (ms) => { clock = ms; } };
}

/** `managerDeskArea()` (agent/detect-service.mjs) reads the SAME `areasFile`
 *  the occupancy section already maintains — reused deliberately, not a
 *  second areas reader — so a real re-read of areas.json needs
 *  `reloadOccupancyConfig()`, not `reloadAppearanceConfig()` (which only
 *  touches site.json/appearance-today.json). Both are called here. */
async function enableAppearance(stateDir, svc, { openHours = OPEN_ALL_WEEK, areas = [] } = {}) {
  await writeAreas(stateDir, areas);
  await writeSite(stateDir, { appearanceOfDay: true, openHours, updatedUtc: at(T0) });
  await svc.reloadOccupancyConfig();
  await svc.reloadAppearanceConfig();
}

/** Say one desk frame at `atMs`, carrying `sig` on a person at DESK_BOX, on
 *  the CURRENT (latest) worker — a switch flip restarts the worker, so every
 *  caller re-reads `workers.at(-1)` rather than holding an old reference. */
function sayDeskFrame(workers, atMs, sig) {
  workers.at(-1).say({ type: "frame", atUtc: at(atMs), detections: [{ kind: "person", confidence: 0.9, box: DESK_BOX, appearance: sig }] });
}

// ================================================================== detect-service wiring

await check("REQUIRED: the switch off launches the worker WITHOUT --appearance, and writes no appearance-today.json", async () => {
  const { stateDir, calls, svc } = await runDetect();
  try {
    await settle();
    eq(calls.length, 1, "one worker launched");
    eq(calls[0].includes("--appearance"), false, "no --appearance flag while the switch is off");
    eq(await readAppearanceTodayFile(stateDir), null, "no file at all while the switch is off");
  } finally {
    await svc.stop();
  }
});

await check("REQUIRED: turning the switch ON restarts the worker, now WITH --appearance", async () => {
  const { stateDir, calls, svc } = await runDetect();
  try {
    await settle();
    eq(calls.length, 1);
    await enableAppearance(stateDir, svc);
    await settle();
    eq(calls.length, 2, "the running worker was restarted for the switch change, not left running stale");
    eq(calls[1].includes("--appearance"), true, "the NEW launch carries --appearance");
  } finally {
    await svc.stop();
  }
});

await check("REQUIRED: turning the switch back OFF restarts the worker without --appearance, wipes today's file and its manager-match rows", async () => {
  const { stateDir, workers, calls, svc, setClock } = await runDetect();
  try {
    await settle();
    await enableAppearance(stateDir, svc);
    await settle();
    let atMs = T0;
    for (let i = 0; i < MIN_SIGNATURES_TO_LEARN; i += 1) {
      setClock(atMs);
      sayDeskFrame(workers, atMs, MANAGER_SIG);
      await settle(5);
      atMs += 9_000;
    }
    const learned = await waitForAppearanceTodayFile(stateDir);
    eq(learned !== null, true, "learned today's manager first, so there is a real file to wipe");
    eq(svc.appearanceToday() !== null, true);

    // A match, written while the switch was on, so there is a manager-match
    // row to prove gets wiped too.
    setClock(atMs);
    sayDeskFrame(workers, atMs, MANAGER_SIG);
    await settle();
    eq((await managerMatchRows(stateDir, DESK_AREA.id)).length > 0, true, "at least one manager-match row exists before the switch flips off");

    await writeSite(stateDir, { appearanceOfDay: false, openHours: OPEN_ALL_WEEK, updatedUtc: at(atMs) });
    await svc.reloadAppearanceConfig();
    await settle();

    eq(calls.length, 3, "restarted again for the switch turning off");
    eq(calls[2].includes("--appearance"), false, "the new launch carries NO --appearance");
    eq(await readAppearanceTodayFile(stateDir), null, "appearance-today.json is gone");
    eq(svc.appearanceToday(), null, "this process's own in-memory copy is cleared too");
    eq(await managerMatchRows(stateDir, DESK_AREA.id), [], "every manager-match row is gone with it");
  } finally {
    await svc.stop();
  }
});

await check("FEARED: learning counts ONLY sightings from the first open hour — extra sightings after the boundary never complete the minimum", async () => {
  const { stateDir, workers, svc, setClock } = await runDetect();
  try {
    await enableAppearance(stateDir, svc);
    await settle();
    // MIN_SIGNATURES_TO_LEARN - 1 sightings, all comfortably inside the
    // first hour (spaced 9 s apart — under advanceFold's 10 s MERGE_GAP_MS,
    // so they fold into one continuous event).
    let atMs = T0;
    for (let i = 0; i < MIN_SIGNATURES_TO_LEARN - 1; i += 1) {
      setClock(atMs);
      sayDeskFrame(workers, atMs, MANAGER_SIG);
      atMs += 9_000;
    }
    await settle();
    eq(await readAppearanceTodayFile(stateDir), null, `only ${MIN_SIGNATURES_TO_LEARN - 1} sightings before the boundary: not learned yet`);

    // Several MORE sightings of the SAME manager, all AFTER the one-hour
    // boundary (still inside the two-hour window, so they would count
    // toward a rare SECOND manager's own 30-minute test — just never
    // toward the primary's first-hour minimum).
    let lateAtMs = T0 + 61 * 60_000;
    for (let i = 0; i < 5; i += 1) {
      setClock(lateAtMs);
      sayDeskFrame(workers, lateAtMs, MANAGER_SIG);
      lateAtMs += 9_000;
    }
    await settle();
    eq(await readAppearanceTodayFile(stateDir), null, "sightings from the SECOND hour never push the first hour's own count over the minimum");
  } finally {
    await svc.stop();
  }
});

await check("REQUIRED: appearance-today.json is deleted at local midnight, and on a start whose file's date is already stale", async () => {
  const { stateDir, workers, svc, setClock } = await runDetect();
  try {
    await enableAppearance(stateDir, svc);
    await settle();
    let atMs = T0;
    for (let i = 0; i < MIN_SIGNATURES_TO_LEARN; i += 1) {
      setClock(atMs);
      sayDeskFrame(workers, atMs, MANAGER_SIG);
      await settle(5);
      atMs += 9_000;
    }
    eq((await waitForAppearanceTodayFile(stateDir)) !== null, true, "precondition: learned today");
    eq(svc.appearanceToday() !== null, true);

    // Local midnight: advance the clock into the next UTC day and re-check.
    setClock(T0 + 25 * 60 * 60_000); // 2026-09-29T01:00:00Z — a new UTC date
    await svc.reloadAppearanceConfig();
    eq(await readAppearanceTodayFile(stateDir), null, "wiped at local midnight");
    eq(svc.appearanceToday(), null);
  } finally {
    await svc.stop();
  }

  // A stale-dated file already on disk, found by a FRESH start.
  const stateDir2 = await siteStateDir();
  await writeAreas(stateDir2, []);
  await writeSite(stateDir2, { appearanceOfDay: true, openHours: OPEN_ALL_WEEK, updatedUtc: at(T0) });
  await writeFile(path.join(stateDir2, "appearance-today.json"), JSON.stringify({
    version: 1, date: "2020-01-01", primary: MANAGER_SIG, secondary: null, learnedAtUtc: "2020-01-01T09:00:00.000Z",
  }));
  const svc2 = await runFreshDetectAt(stateDir2, T0);
  try {
    await settle();
    eq(await readAppearanceTodayFile(stateDir2), null, "a stale-dated file is deleted before the first worker even starts");
    eq(svc2.appearanceToday(), null);
  } finally {
    await svc2.stop();
  }
});

/** Start detect-service against an EXISTING stateDir (config/detect.json
 *  already written), at a fixed clock — used by the stale-start check above,
 *  where the site is already fully set up before the service ever runs. */
async function runFreshDetectAt(stateDir, nowMs) {
  const { spawnFn } = fakeWorkers();
  return startDetect({
    stateDir, spawnFn, now: () => new Date(nowMs), tickMs: 1_000_000, healthMs: 1_000_000,
    aiSettingsReloadMs: 1_000_000, occupancyReloadMs: 1_000_000, appearanceReloadMs: 1_000_000,
    restartMs: { first: 20, max: 100 }, killAfterMs: 100,
    log: () => {},
  });
}

await check("REQUIRED: a person matching today's manager is written to occupancy.db's manager-match table; a different person is not", async () => {
  const { stateDir, workers, svc, setClock } = await runDetect();
  try {
    await enableAppearance(stateDir, svc);
    await settle();
    let atMs = T0;
    for (let i = 0; i < MIN_SIGNATURES_TO_LEARN; i += 1) {
      setClock(atMs);
      sayDeskFrame(workers, atMs, MANAGER_SIG);
      await settle(5);
      atMs += 9_000;
    }
    eq((await waitForAppearanceTodayFile(stateDir)) !== null, true, "precondition: learned");

    // A DIFFERENT person at the same spot: never a match (disjoint signature).
    atMs += 20_000;
    setClock(atMs);
    sayDeskFrame(workers, atMs, OTHER_PERSON_SIG);
    await settle();
    const beforeMatch = await managerMatchRows(stateDir, DESK_AREA.id);

    // The SAME manager, seen again: a match, at 100%.
    atMs += 20_000;
    setClock(atMs);
    sayDeskFrame(workers, atMs, MANAGER_SIG);
    await settle();
    const afterMatch = await managerMatchRows(stateDir, DESK_AREA.id);

    eq(afterMatch.length, beforeMatch.length + 1, "exactly one new row, from the matching person only");
    const row = afterMatch.at(-1);
    eq(row.which, "primary");
    eq(row.similarityPercent, 100, "an identical signature is a perfect match");
  } finally {
    await svc.stop();
  }
});

// ================================================================== api-server wiring: the two templates, and /appearance/status

const CAM_PW = "appear-api-s3cret";
async function startApiServer(stateDir, overrides = {}) {
  const config = {
    siteId: "bench",
    storeRoots: [join(stateDir, "disk0")],
    credentials: { username: "svc", password: "svc-pw" },
    cameras: [{ cameraId: "cam-1", name: "Front", url: `rtsp://admin:${CAM_PW}@10.0.0.9:554/main` }],
  };
  await writeFile(join(stateDir, "config.json"), JSON.stringify(config));
  const index = openIndex(indexPathFor(stateDir));
  const audits = [];
  const auth = {
    principalOf: () => ({ kind: "user", username: "tech", role: "installer" }),
    handle: async () => false,
    audit: (event, _req, fields) => audits.push({ event, ...fields }),
  };
  const server = createApiServer({ stateDir, config, index, auth, eventRetentionIntervalMs: 10 * 60_000, ...overrides });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, index };
}
const send = async (base, method, pathname, body) => {
  const res = await fetch(base + pathname, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, json };
};

await check("REQUIRED: 'Manager leaves' and 'Manager returns' fire with identity-free, percentage wording, from real manager-match sightings", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-appear-api-"));
  // A fixed `now`, well after both sightings below (createApiServer's own
  // default `now` is the real wall clock — the evaluator's own gates
  // (`gateAtMs > nowMs`) would otherwise never let a firing dated on a FIXED
  // day in this fixture ever be "confirmed as of now", the same fixed-clock
  // discipline every other harness that drives createApiServer already
  // keeps (harness/recordingSettings.harness.mjs, harness/driveRoot.harness.mjs, …).
  const T1 = Date.parse("2026-09-28T13:00:00.000Z");
  const { server, base } = await startApiServer(stateDir, {
    managerRulesIntervalMs: 20,
    now: () => new Date(T1 + 20 * 60_000),
  });
  try {
    const onResp = await send(base, "POST", "/site-settings", { features: { managerRules: true } });
    eq(onResp.status, 200);
    await send(base, "POST", "/open-hours", { openHours: OPEN_ALL_WEEK });

    const deskResp = await send(base, "POST", "/areas", { ...DESK_AREA });
    eq(deskResp.status, 200, JSON.stringify(deskResp.json));
    const DOOR_AREA = { id: "door-1", cameraId: "cam-1", name: "Back door", points: [[0.5, 0], [1, 0], [1, 1], [0.5, 1]] };
    const doorResp = await send(base, "POST", "/areas", { ...DOOR_AREA });
    eq(doorResp.status, 200, JSON.stringify(doorResp.json));

    const leavesResp = await send(base, "POST", "/rules", {
      name: "Manager leaves", enabled: true, template: "manager_leaves",
      cameraId: "cam-1", areaId: DOOR_AREA.id, kind: "person",
      condition: { type: "manager_leaves", awayMinutes: 5 }, when: "open_hours",
      notify: { alert: true, report: true, cooldownMinutes: 0 },
    });
    eq(leavesResp.status, 200, JSON.stringify(leavesResp.json));
    const returnsResp = await send(base, "POST", "/rules", {
      name: "Manager returns", enabled: true, template: "manager_returns",
      cameraId: "cam-1", areaId: DOOR_AREA.id, kind: "person",
      condition: { type: "manager_returns", awayMinutes: 5 }, when: "open_hours",
      notify: { alert: false, report: true, cooldownMinutes: 0 },
    });
    eq(returnsResp.status, 200, JSON.stringify(returnsResp.json));

    const occ = openOccupancyDb(join(stateDir, "occupancy.db"));
    occ.insertManagerMatch({ areaId: DOOR_AREA.id, cameraId: "cam-1", atMs: T1, which: "primary", similarityPercent: 90 });
    occ.insertManagerMatch({ areaId: DESK_AREA.id, cameraId: "cam-1", atMs: T1 + 10 * 60_000, which: "primary", similarityPercent: 85 });
    occ.close();

    const day = "2026-09-28";
    let group = null;
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      const r = await send(base, "GET", `/reports?day=${day}`);
      const leaves = r.json.groups.find((g) => g.firings.some((f) => f.what === "manager_leaves"));
      const returns = r.json.groups.find((g) => g.firings.some((f) => f.what === "manager_returns"));
      if (leaves && returns) { group = { leaves, returns }; break; }
    }
    if (group === null) throw new Error("neither firing appeared within the poll window");

    const leaveText = group.leaves.firings.find((f) => f.what === "manager_leaves").text;
    eq(leaveText.includes("Person matching today's manager (90%)"), true, leaveText);
    eq(leaveText.includes("Back door"), true, leaveText);
    eq(/[0-9]{1,2}:[0-9]{2}/.test(leaveText), true, "a clock label");

    const returnText = group.returns.firings.find((f) => f.what === "manager_returns").text;
    eq(returnText.includes("Person matching today's manager (85%)"), true, returnText);
    eq(returnText.includes("Manager's desk"), true, returnText);
    eq(returnText.includes("(10 min)"), true, returnText);
  } finally {
    server.closeManagerRulesEvaluator();
    await new Promise((r) => setTimeout(r, 100));
    server.closeOccupancy();
    server.closeRules();
    await new Promise((r) => server.close(r));
  }
});

await check("REQUIRED: GET /appearance/status reports learned/why/sample-count/second-manager, and NEVER a signature — even one that leaked upstream", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-appear-status-"));
  const { server, base } = await startApiServer(stateDir);
  try {
    const none = await send(base, "GET", "/appearance/status");
    eq(none.status, 200);
    eq(none.json.enabled, false);
    eq(none.json.reason, "the detector is not running, or has not reported yet");

    // "switch off"
    await writeFile(join(stateDir, "detect-health.json"), JSON.stringify({
      cameras: [], appearance: { enabled: false, learnedToday: false, learnedAtUtc: null, hasSecondary: false, sampleCount: null, minSignaturesToLearn: 20, reason: "switch off" },
    }));
    const off = await send(base, "GET", "/appearance/status");
    eq(off.json.enabled, false);
    eq(off.json.reason, "switch off");

    // "open hours not set"
    await writeFile(join(stateDir, "detect-health.json"), JSON.stringify({
      cameras: [], appearance: { enabled: true, learnedToday: false, learnedAtUtc: null, hasSecondary: false, sampleCount: null, minSignaturesToLearn: 20, reason: "open hours not set" },
    }));
    eq((await send(base, "GET", "/appearance/status")).json.reason, "open hours not set");

    // "no manager's desk area"
    await writeFile(join(stateDir, "detect-health.json"), JSON.stringify({
      cameras: [], appearance: { enabled: true, learnedToday: false, learnedAtUtc: null, hasSecondary: false, sampleCount: null, minSignaturesToLearn: 20, reason: "no manager's desk area" },
    }));
    eq((await send(base, "GET", "/appearance/status")).json.reason, "no manager's desk area");

    // "not enough sightings yet: 7 of 20"
    await writeFile(join(stateDir, "detect-health.json"), JSON.stringify({
      cameras: [], appearance: { enabled: true, learnedToday: false, learnedAtUtc: null, hasSecondary: false, sampleCount: 7, minSignaturesToLearn: 20, reason: "not enough sightings yet: 7 of 20" },
    }));
    const partial = await send(base, "GET", "/appearance/status");
    eq(partial.json.reason, "not enough sightings yet: 7 of 20");
    eq(partial.json.sampleCount, 7);

    // Learned, with a second manager — AND an adversarial leak: this is
    // exactly the payload a bug in detect-service could produce, and this
    // route must still never forward `primary`/`secondary`/`signature`.
    await writeFile(join(stateDir, "detect-health.json"), JSON.stringify({
      cameras: [],
      appearance: {
        enabled: true, learnedToday: true, learnedAtUtc: "2026-09-28T09:05:00.000Z",
        hasSecondary: true, sampleCount: null, minSignaturesToLearn: 20, reason: null,
        primary: MANAGER_SIG, secondary: OTHER_PERSON_SIG, signature: "should never appear",
      },
    }));
    const learned = await send(base, "GET", "/appearance/status");
    eq(learned.json.enabled, true);
    eq(learned.json.learnedToday, true);
    eq(learned.json.learnedAtUtc, "2026-09-28T09:05:00.000Z");
    eq(learned.json.hasSecondary, true);
    eq(learned.json.reason, null);
    eq(Object.keys(learned.json).sort(), ["enabled", "hasSecondary", "learnedAtUtc", "learnedToday", "minSignaturesToLearn", "ok", "reason", "sampleCount"], "the whitelist, and nothing else");
    eq("primary" in learned.json, false, "THE FEARED ONE: the signature never rides along");
    eq("secondary" in learned.json, false);
    eq("signature" in learned.json, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

report("appearance of the day");
