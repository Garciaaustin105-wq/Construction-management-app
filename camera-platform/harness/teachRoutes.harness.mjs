/**
 * GET /teach-moments and GET /still (TEACH-LIST-SPEC.md piece 3), against a
 * real HTTP server, a real segment index and a real events.db, on a temp
 * state dir -- proposeTeachMoments' own correctness is teachCandidates's
 * harness to prove; this one proves the ROUTE: the real routeAccess table
 * (not a stub), that /teach-moments assembles gate-windows + events + the
 * clip library + the segment index correctly from disk, and that /still
 * refuses every kind of unrecorded moment and only ever cuts a SEALED one --
 * main stream first when it has one, the camera's own recording otherwise.
 */
import { mkdtemp, writeFile, mkdir, rm, readdir, utimes, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { openEventsDb } from "../agent/events-db.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("teach routes");

const ms = (iso) => Date.parse(iso);
const now = () => new Date("2026-09-20T14:00:00Z");

const stateDir = await mkdtemp(join(tmpdir(), "camplat-teach-routes-"));
const disk0 = join(stateDir, "disk0");
await mkdir(disk0, { recursive: true });

// cam-1 stands alone. cam-2-sub / cam-2-main share a host with no url, so
// cameraGroups.ts's own channel-derivation (host-only -> channel 1) groups
// them into one device -- the same mechanism /still's main-stream lookup
// reuses, not a second one invented for this test.
const config = {
  siteId: "teach-01",
  storeRoots: [disk0],
  segmentSeconds: 60,
  credentials: { username: "svc", password: "p@ss" },
  cameras: [
    { cameraId: "cam-1", url: "rtsp://admin:hunter2@10.0.0.5:8554/live" },
    { cameraId: "cam-2-sub", host: "10.0.0.9", vendor: "generic", stream: "sub" },
    { cameraId: "cam-2-main", host: "10.0.0.9", vendor: "generic", stream: "main" },
  ],
};

const index = openIndex(join(stateDir, "index.db"));
const seg = (cameraId, startIso, endIso, path, state = "sealed") => ({
  cameraId, startUtc: startIso, endUtc: endIso, path, bytes: state === "open" ? null : 100,
  state, hold: false, pendingUpload: false, bitrateKbps: null,
});

// cam-1: a sealed minute for /still's happy path, a real gap after it, and a
// still-open segment for the "not sealed yet" refusal.
index.put(seg("cam-1", "2026-09-20T10:00:00Z", "2026-09-20T10:01:00Z", "cam-1/rec.mp4"));
index.put(seg("cam-1", "2026-09-20T13:59:00Z", null, "cam-1/open.mp4", "open"));
// cam-1: covers the two adjacent motion-only minutes at the start of the day
// AND the person event's padded span below, for /teach-moments.
index.put(seg("cam-1", "2026-09-20T00:00:00Z", "2026-09-20T00:06:00Z", "cam-1/day-start.mp4"));

// cam-2: T_A sub has footage, main does not; T_B main has footage, sub does
// not; T_C neither has footage.
index.put(seg("cam-2-sub", "2026-09-20T09:00:00Z", "2026-09-20T09:01:00Z", "cam-2-sub/a.mp4"));
index.put(seg("cam-2-main", "2026-09-20T09:05:00Z", "2026-09-20T09:06:00Z", "cam-2-main/b.mp4"));

const eventsDb = openEventsDb(join(stateDir, "events.db"));
eventsDb.upsert({
  id: "p1",
  event: {
    cameraId: "cam-1", kind: "person",
    // Away from the two motion minutes (0 and 1) on purpose: an event here
    // must not strip minute 1 out of the moved_nothing_stored merge below.
    firstUtc: "2026-09-20T00:05:00.000Z", lastUtc: "2026-09-20T00:05:04.000Z",
    count: 3, bestConfidence: 0.71,
    bestBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, bestUtc: "2026-09-20T00:05:02.000Z",
  },
}, true);
eventsDb.close();

// The gate's own bookkeeping, exactly the file layout agent/detect-service.mjs
// writes (piece 1): one file per UTC day, every camera's minutes.
const gateDir = join(stateDir, "gate-windows");
await mkdir(gateDir, { recursive: true });
const gateLines = [
  { cameraId: "cam-1", atUtc: "2026-09-20T00:00:00.000Z", windowS: 60, frames: 20, looked: 10, reasons: { motion: 10 } },
  { cameraId: "cam-1", atUtc: "2026-09-20T00:01:00.000Z", windowS: 60, frames: 20, looked: 10, reasons: { motion: 10 } },
  // a torn last line, as a crash mid-append would leave one: must not fail the request
  '{"cameraId":"cam-1","atUtc":"2026-09-20T00:02',
]
  .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
  .join("\n") + "\n";
await writeFile(join(gateDir, "2026-09-20.jsonl"), gateLines);

// These are only for the auth stub, never a signed-out check's own asserter
// (routeAccess.harness.mjs already proves the table's decision itself).
const installerAuth = {
  principalOf: () => ({ kind: "user", username: "tech", role: "installer" }),
  handle: async () => false,
  audit: () => {},
};
const anonAuth = {
  principalOf: () => ({ kind: "anonymous" }),
  handle: async () => false,
  audit: () => {},
};

const STILL_BYTES = Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 5, 0xff, 0xd9]);
const spawnCalls = [];
function fakeSpawn(cmd, args) {
  spawnCalls.push({ cmd, args });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const tmpPath = args[args.length - 1];
  queueMicrotask(async () => {
    try {
      await writeFile(tmpPath, STILL_BYTES);
      child.emit("close", 0);
    } catch (err) {
      child.emit("error", err);
    }
  });
  return child;
}

const server = createApiServer({ stateDir, config, index, now, auth: installerAuth, spawnFn: fakeSpawn });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const fetchJson = async (path) => {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON, e.g. a JPEG */ }
  return { res, json, text };
};

const pathExists = async (p) => {
  try { await stat(p); return true; } catch { return false; }
};

async function until(fn, what, limitMs = 3000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > limitMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * index.getByKey stubbed for exactly one (cameraId, startMs), everything
 * else delegated to the real index unchanged -- so forCamera()/gapsFor()
 * (what resolveStillSource's resolvePlayback call sees) keep saying "sealed"
 * while getByKey's own re-fetch (what cutStill checks second) says "open".
 * Simulates the race cutStill's defense-in-depth guards against: nothing in
 * a synchronous request can actually produce this today, so this is the only
 * way to exercise that second check at all.
 */
function indexWithStaleOpenRow(realIndex, cameraId, startMs) {
  return new Proxy(realIndex, {
    get(target, prop) {
      if (prop === "getByKey") {
        return (camera, ms) => {
          const row = target.getByKey(camera, ms);
          if (row && camera === cameraId && ms === startMs) return { ...row, state: "open" };
          return row;
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/* ---------------- real table, not a stub ---------------- */

await check("FEARED: both routes are gated through the REAL routeAccess table, not bypassed", async () => {
  const anonServer = createApiServer({ stateDir, config, index, now, auth: anonAuth, spawnFn: fakeSpawn });
  await new Promise((resolve) => anonServer.listen(0, "127.0.0.1", resolve));
  const anonBase = `http://127.0.0.1:${anonServer.address().port}`;
  for (const path of ["/teach-moments?camera=cam-1&day=2026-09-20", "/still?camera=cam-1&at=2026-09-20T10:00:30Z"]) {
    const res = await fetch(`${anonBase}${path}`);
    eq(res.status, 401, `signed out: ${path}`);
  }
  // createApiServer opens its OWN events.db handle (for eventCrops) even
  // though this suite already has one: leaving it open holds the WAL file
  // against the rm() at the end of this harness (EBUSY on Windows).
  anonServer.closeEvents();
  anonServer.closeEventCrops();
  anonServer.closeStillsCleanup();
  await new Promise((resolve) => anonServer.close(resolve));
});

/* ---------------- /teach-moments ---------------- */

await check("GET /teach-moments assembles gate-windows, events, footage and the (empty) library from the state dir", async () => {
  const { res, json } = await fetchJson("/teach-moments?camera=cam-1&day=2026-09-20");
  eq(res.status, 200, "status");
  eq(json.ok, true, "ok");
  eq(json.cameraId, "cam-1", "cameraId echoed");
  eq(json.dayStartUtc, "2026-09-20T00:00:00.000Z", "the UTC day, from parseDay");
  eq(json.dayEndUtc, "2026-09-21T00:00:00.000Z", "the UTC day, from parseDay");

  const moved = json.moments.filter((m) => m.kind === "moved_nothing_stored");
  eq(moved.length, 1, "the two adjacent motion minutes merged into one moment");
  eq(moved[0].startUtc, "2026-09-20T00:00:00.000Z", "span start");
  eq(moved[0].endUtc, "2026-09-20T00:02:00.000Z", "span end");
  eq(moved[0].evidence.frames, 40, "frames summed across the merge");
  eq(moved[0].evidence.motionLooks, 20, "motion looks summed across the merge");

  const person = json.moments.filter((m) => m.kind === "person_stored");
  eq(person.length, 1, "the event in events.db reached the contract");
  eq(person[0].evidence.bestConfidence, 0.71, "the event's own fields, not re-derived");
  eq(person[0].evidence.hidden, false, "not suppressed");

  eq(json.notes.some((n) => n.includes("838 of 840 minute(s) had no gate data")), true,
    "now() clips the day at 14:00 (840 minutes); 2 of them had gate data, 838 did not -- the torn last line never registers as a third");

  eq(json.library, { clipCount: 0, personCount: 0, vehicleCount: 0, emptyMinutes: 0, personsStillNeeded: 20, emptyMinutesStillNeeded: 60, skipped: 0 },
    "no clip-library.json on disk yet -- clipProgress's own totals for an empty library, reused as-is");
});

await check("GET /teach-moments validates its own query before touching disk", async () => {
  for (const [q, code] of [
    ["camera=../etc&day=2026-09-20", "bad_camera_id"],
    ["camera=cam-1", "bad_day"],
    ["camera=cam-1&day=2026-13-40", "bad_day"],
  ]) {
    const { res, json } = await fetchJson(`/teach-moments?${q}`);
    eq(res.status, 400, q);
    eq(json.code, code, q);
    eq(json.ok, false, q);
  }
});

await check("GET /teach-moments on a day with no gate-windows file at all answers 200, not a 500", async () => {
  const { res, json } = await fetchJson("/teach-moments?camera=cam-1&day=2026-01-01");
  eq(res.status, 200, "a missing file is an ordinary day with no gate data, not a fault");
  eq(json.ok, true);
  eq(json.moments.filter((m) => m.kind === "moved_nothing_stored" || m.kind === "quiet").length, 0, "nothing without gate data");
});

/* ---------------- /still: refuses every unrecorded moment ---------------- */

await check("FEARED: /still refuses a gap, an open (not sealed) segment, and the future -- never guesses", async () => {
  const cases = [
    ["camera=cam-1&at=2026-09-20T10:05:00Z", 404, "footage_gone", "a real gap"],
    ["camera=cam-1&at=2026-09-20T13:59:30Z", 404, "segment_open", "still being written, not sealed"],
    ["camera=cam-1&at=2026-09-20T14:00:00Z", 404, "still_in_future", "at or after now"],
    ["camera=..%2fetc&at=2026-09-20T10:00:30Z", 400, "bad_camera_id", "a hostile camera id"],
    ["camera=cam-1&at=not-a-time", 400, "bad_instant", "an unparsable instant"],
  ];
  for (const [q, status, code, label] of cases) {
    const before = spawnCalls.length;
    const { res, json } = await fetchJson(`/still?${q}`);
    eq(res.status, status, label);
    eq(json.code, code, label);
    eq(json.ok, false, label);
    eq(spawnCalls.length, before, `${label}: ffmpeg was never reached`);
  }
});

/* ---------------- /still: cuts a sealed frame, caches it ---------------- */

await check("THE ROUTE ITSELF: a sealed moment is cut, streamed and cached -- the second request never spawns ffmpeg again", async () => {
  const before = spawnCalls.length;
  const res1 = await fetch(`${base}/still?camera=cam-1&at=2026-09-20T10:00:30Z`);
  eq(res1.status, 200, "status");
  eq(res1.headers.get("content-type"), "image/jpeg", "content type");
  eq(res1.headers.get("cache-control"), "private, max-age=86400", "a past moment never changes");
  const body1 = Buffer.from(await res1.arrayBuffer());
  eq(body1.equals(STILL_BYTES), true, "the exact bytes the cutter wrote");
  eq(spawnCalls.length, before + 1, "one ffmpeg call");

  const res2 = await fetch(`${base}/still?camera=cam-1&at=2026-09-20T10:00:30Z`);
  eq(res2.status, 200, "cached: status");
  const body2 = Buffer.from(await res2.arrayBuffer());
  eq(body2.equals(STILL_BYTES), true, "cached: same bytes");
  eq(spawnCalls.length, before + 1, "cached: no second ffmpeg call");
});

/* ---------------- /still: main stream if recorded, else the camera's own ---------------- */

await check('"main stream if recorded, else the camera\'s own recording": prefers the main sibling when IT has a sealed segment', async () => {
  const before = spawnCalls.length;
  const res = await fetch(`${base}/still?camera=cam-2-sub&at=2026-09-20T09:05:30Z`);
  eq(res.status, 200, "cam-2-sub has no footage here, but its main sibling does");
  eq(spawnCalls.length, before + 1, "one cut");
  eq(spawnCalls[spawnCalls.length - 1].args.some((a) => typeof a === "string" && a.includes("cam-2-main")), true,
    "cut from the MAIN stream's file");
});

await check("falls back to the camera's own recording when the main sibling has none", async () => {
  const before = spawnCalls.length;
  const res = await fetch(`${base}/still?camera=cam-2-sub&at=2026-09-20T09:00:30Z`);
  eq(res.status, 200, "cam-2-sub's own footage, main has nothing at this instant");
  eq(spawnCalls.length, before + 1, "one cut");
  eq(spawnCalls[spawnCalls.length - 1].args.some((a) => typeof a === "string" && a.includes("cam-2-sub")), true,
    "cut from the camera's OWN stream's file");
});

await check("refuses with the requested camera's own reason when neither stream has footage", async () => {
  const { res, json } = await fetchJson("/still?camera=cam-2-sub&at=2026-09-20T09:10:00Z");
  eq(res.status, 404, "neither stream has anything here");
  eq(json.code, "footage_gone", "cam-2-sub's own gap, not main's");
});

/* ---------------- /still: a fresh open row beats a stale sealed snapshot ---------------- */

await check("FEARED: cutStill re-checks row.state after its re-fetch -- a segment gone stale between resolvePlayback and getByKey is still refused, like /segments/:id and event-crop.mjs do", async () => {
  // A moment /still has not cut before in this suite (everything else in
  // this file's cam-1 10:00 minute is already cached by an earlier check,
  // which would answer from the cache without ever reaching cutStill).
  const at = "2026-09-20T00:00:30Z";
  const raceIndex = indexWithStaleOpenRow(index, "cam-1", Date.parse("2026-09-20T00:00:00Z"));
  const raceServer = createApiServer({ stateDir, config, index: raceIndex, now, auth: installerAuth, spawnFn: fakeSpawn });
  try {
    await new Promise((resolve) => raceServer.listen(0, "127.0.0.1", resolve));
    const raceBase = `http://127.0.0.1:${raceServer.address().port}`;
    const before = spawnCalls.length;
    const res = await fetch(`${raceBase}/still?camera=cam-1&at=${at}`);
    const json = await res.json();
    eq(res.status, 404, "refused, not served half-written");
    eq(json.code, "segment_open", "the same code the resolution-kind check uses");
    eq(spawnCalls.length, before, "ffmpeg was never reached");
  } finally {
    raceServer.closeStillsCleanup();
    raceServer.closeEvents();
    raceServer.closeEventCrops();
    await new Promise((resolve) => raceServer.close(resolve));
  }
});

/* ---------------- /still's cache directory: swept of old files, at startup and daily ---------------- */

await check("FEARED: GET /still's cache grows one file per moment forever unless something ages it out -- 7-day-old files are swept at startup, a fresh one is not", async () => {
  const stillsDir = join(stateDir, "stills");
  await mkdir(stillsDir, { recursive: true });
  const oldPath = join(stillsDir, "old-cam__1.jpg");
  const freshPath = join(stillsDir, "fresh-cam__2.jpg");
  await writeFile(oldPath, "old");
  await writeFile(freshPath, "fresh");
  const eightDaysAgo = new Date(now().getTime() - 8 * 24 * 60 * 60 * 1000);
  await utimes(oldPath, eightDaysAgo, eightDaysAgo);
  // freshPath keeps the mtime writeFile just gave it: "now", well inside 7 days.

  // A NEW server against this SAME state dir, so its own startup sweep (not
  // the daily timer, which would take 24h) is what this check proves.
  const sweepServer = createApiServer({ stateDir, config, index, now, auth: installerAuth, spawnFn: fakeSpawn });
  try {
    await new Promise((resolve) => sweepServer.listen(0, "127.0.0.1", resolve));
    await until(async () => !(await pathExists(oldPath)), "the 7-day-old still to be swept");
    eq(await pathExists(freshPath), true, "a file under 7 days old survives the startup sweep");
  } finally {
    sweepServer.closeStillsCleanup();
    sweepServer.closeEvents();
    sweepServer.closeEventCrops();
    await new Promise((resolve) => sweepServer.close(resolve));
  }
});

server.close();
server.closeEvents();
server.closeEventCrops();
server.closeStillsCleanup();
index.close();
await rm(stateDir, { recursive: true, force: true });
report("teach routes");
