/**
 * D1: camplat-detect, the detector service (agent/detect-service.mjs), run
 * against a FAKE worker: a child process that prints what the real Python
 * worker would. No model, no camera.
 *
 * THE FEARED FAILURES: the AI given the recording stream instead of the
 * substream; detection started with a made-up capacity, so cameras look
 * watched when the box cannot keep up; events written into the recording
 * index, where a busy detector could lock recording; a worker's error text
 * (it holds the camera URL, password included) reaching the log; a crashing
 * worker taking the service down, or restarting in a tight loop; a camera
 * whose worker produces nothing looking just as watched as one that works;
 * one person becoming a row per frame.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDetect } from "../agent/detect-service.mjs";
import { openEventsDb } from "../agent/events-db.mjs";
import { MERGE_GAP_MS } from "../dist/detection.js";
import { check, eq, report } from "./_assert.mjs";

console.log("detect service");

const SECRET = "s3cret-pw";
const T0 = Date.parse("2026-09-19T22:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();

async function site({ detect = { capacityFps: 20, cameras: [{ cameraId: "cam-1" }, { cameraId: "cam-2" }] }, cameras } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-detect-"));
  const store = await mkdtemp(path.join(tmpdir(), "camplat-detect-store-"));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
    siteId: "t", storeRoots: [store], segmentSeconds: 60,
    credentials: { username: "admin", password: SECRET },
    cameras: cameras ?? [
      { cameraId: "cam-1", url: `rtsp://admin:${SECRET}@10.0.0.1:554/main`, substreamUrl: `rtsp://admin:${SECRET}@10.0.0.1:554/sub` },
      { cameraId: "cam-2", host: "10.0.0.2", vendor: "hikvision" },
      { cameraId: "cam-3", url: `rtsp://admin:${SECRET}@10.0.0.3:554/only-main` },
    ],
  }));
  if (detect !== null) await writeFile(path.join(stateDir, "detect.json"), JSON.stringify(detect));
  return stateDir;
}

function fakeWorkers() {
  const workers = [];
  const spawnFn = (cmd, args) => {
    const w = new EventEmitter();
    w.stdout = new EventEmitter();
    w.stderr = new EventEmitter();
    w.args = args;
    w.signals = [];
    w.killed = false;
    w.kill = (sig = "SIGTERM") => { w.signals.push(sig); w.killed = true; queueMicrotask(() => w.emit("exit", null)); return true; };
    w.say = (obj) => w.stdout.emit("data", Buffer.from((typeof obj === "string" ? obj : JSON.stringify(obj)) + "\n"));
    workers.push(w);
    return w;
  };
  return { workers, spawnFn };
}
const urlOf = (w) => w.args[w.args.indexOf("--url") + 1];
const cameraOf = (w) => w.args[w.args.indexOf("--camera") + 1];
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function run(opts = {}) {
  const stateDir = await site(opts);
  const { workers, spawnFn } = fakeWorkers();
  const logs = [];
  let clock = T0;
  const svc = await startDetect({
    stateDir, spawnFn, now: () => new Date(clock), tickMs: 1_000_000, healthMs: 1_000_000,
    restartMs: { first: 40, max: 200 }, killAfterMs: 100,
    log: (level, msg, extra) => logs.push(JSON.stringify({ level, msg, ...extra })),
  });
  return { stateDir, workers, svc, logs, setClock: (ms) => { clock = T0 + ms; } };
}

await check("THE FEARED ONE: no detect.json, or a capacity nobody measured, and the service refuses to start", async () => {
  for (const [detect, why] of [[null, "no detect.json"], [{ capacityFps: null, cameras: [{ cameraId: "cam-1" }] }, "unmeasured"]]) {
    const stateDir = await site({ detect });
    let threw = null;
    try { await startDetect({ stateDir, spawnFn: fakeWorkers().spawnFn, log: () => {} }); } catch (err) { threw = err; }
    if (!threw) throw new Error(`${why}: started anyway`);
    if (why === "unmeasured" && !/measur/i.test(threw.message)) throw new Error(`the refusal should say the capacity was never measured: ${threw.message}`);
  }
});

await check("THE FEARED ONE: each worker gets its camera's SUBSTREAM; a camera with none is skipped and named, never given the recording stream", async () => {
  const { workers, svc, logs } = await run({ detect: { capacityFps: 30, cameras: [{ cameraId: "cam-1" }, { cameraId: "cam-2" }, { cameraId: "cam-3" }] } });
  try {
    eq(workers.map(cameraOf), ["cam-1", "cam-2"], "two workers: cam-3 has no substream");
    eq(urlOf(workers[0]).endsWith("/sub"), true, "cam-1: its configured substream");
    eq(/Channels\/102|sub/i.test(urlOf(workers[1])), true, `cam-2: the vendor's substream (${urlOf(workers[1]).replace(SECRET, "***")})`);
    if (workers.some((w) => urlOf(w).includes("only-main") || urlOf(w).endsWith("/main"))) throw new Error("a worker was given a recording stream");
    const skipped = svc.cameras().find((c) => c.cameraId === "cam-3");
    eq(skipped?.state, "no_substream", "cam-3 reported as not watched, with the reason");
    if (!logs.some((l) => l.includes("cam-3") && /substream/i.test(l))) throw new Error("the skip was not logged");
    eq(workers[0].args.includes("--fps"), true, "each worker is told its granted rate");
  } finally {
    await svc.stop();
  }
});

// Bench 2026-09-19: a camera address saved without a login is refused by the
// camera (401). The recorder adds the site login (resolveCameraUrl); a
// configured substream address must get the same, or detection never starts.
await check("THE FEARED ONE: a substream address saved without a login gets the site login, as the recorder does", async () => {
  const { workers, svc } = await run({
    detect: { capacityFps: 10, cameras: [{ cameraId: "cam-4" }] },
    cameras: [{ cameraId: "cam-4", url: "rtsp://10.0.0.4:554/main", substreamUrl: "rtsp://10.0.0.4:554/sub" }],
  });
  try {
    eq(workers.length, 1, "watched");
    eq(urlOf(workers[0]).includes(`admin:${SECRET}@10.0.0.4`), true, "the site login added");
    eq(urlOf(workers[0]).endsWith("/sub"), true, "still the substream");
  } finally {
    await svc.stop();
  }
});

await check("THE FEARED ONE: one person across many frames is ONE event row in events.db, finished after the gap", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    const w = workers[0];
    w.say({ type: "ready", model: "yolox_s" });
    for (let ms = 0; ms <= 3000; ms += 200) {
      setClock(ms);
      w.say({ type: "frame", atUtc: at(ms), detections: [{ kind: "person", confidence: 0.6, box: { x: 0.1, y: 0.2, w: 0.1, h: 0.3 } }] });
    }
    await settle();
    const db = openEventsDb(path.join(stateDir, "events.db"));
    let rows = db.all();
    eq(rows.length, 1, "one row while the person is in view");
    eq([rows[0].cameraId, rows[0].kind, rows[0].count, rows[0].finished], ["cam-1", "person", 16, false], "updated in place, still open");
    setClock(3000 + MERGE_GAP_MS + 1);
    await svc.tick();
    rows = db.all();
    eq([rows.length, rows[0].finished, rows[0].lastUtc], [1, true, at(3000)], "finished after the gap, ending at the last sighting");
    db.close();
  } finally {
    await svc.stop();
  }
});

await check("THE FEARED ONE: events never touch the recording index", async () => {
  const { stateDir, workers, svc } = await run();
  try {
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.9, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] });
    await settle();
    let indexExists = true;
    try { await stat(path.join(stateDir, "index.db")); } catch { indexExists = false; }
    eq(indexExists, false, "the detector never even opens the recording index");
    await stat(path.join(stateDir, "events.db"));
  } finally {
    await svc.stop();
  }
});

await check("THE FEARED ONE: a crashing worker restarts with backoff, and its words never put a password in the log", async () => {
  const { workers, svc, logs } = await run({ detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }] } });
  try {
    const first = workers[0];
    first.stderr.emit("data", Buffer.from(`Error opening input file rtsp://admin:${SECRET}@10.0.0.1:554/sub: No route to host\nauth ${SECRET} rejected\n`));
    first.say({ type: "error", message: `could not open rtsp://admin:${SECRET}@10.0.0.1:554/sub` });
    first.emit("exit", 1);
    await settle(80);
    eq(workers.length >= 2, true, "restarted");
    const second = workers[1];
    second.emit("exit", 1);
    await settle(20);
    eq(workers.length, 2, "backoff: not restarted again at once");
    await settle(150);
    eq(workers.length, 3, "restarted after the longer wait");
    const all = logs.join("\n");
    eq(all.includes(SECRET), false, "no password anywhere in the log");
    eq(all.includes("No route to host"), true, "while what went wrong is still there");
    eq(svc.cameras().find((c) => c.cameraId === "cam-1").restarts >= 2, true, "restarts counted");
  } finally {
    await svc.stop();
  }
});

await check("THE FEARED ONE: a camera with its OWN password (not the site's) never has it in the log either", async () => {
  const OWN = "cam0nly-pw";
  const { workers, svc, logs } = await run({
    detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }] },
    cameras: [{ cameraId: "cam-1", url: `rtsp://viewer:${OWN}@10.0.0.1:554/main`, substreamUrl: `rtsp://viewer:${OWN}@10.0.0.1:554/sub` }],
  });
  try {
    const w = workers[0];
    w.stderr.emit("data", Buffer.from(`auth for viewer/${OWN} rejected\n`));
    w.say({ type: "error", message: `login ${OWN} failed` });
    w.emit("exit", 1);
    await settle(20);
    const all = logs.join("\n");
    eq(all.includes(OWN), false, "the camera's own password is blanked, bare as well as inside a URL");
    eq(all.includes("rejected"), true, "while the rest of the message is kept");
  } finally {
    await svc.stop();
  }
});

await check("garbage from a worker is counted and ignored; the service keeps going", async () => {
  const { stateDir, workers, svc } = await run({ detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }] } });
  try {
    const w = workers[0];
    w.say("not json");
    w.say("x".repeat(70_000));
    w.stdout.emit("data", Buffer.from('{"type":"frame","atUtc":"' + at(0) + '","detections":[{"kind":"person","confidence":0.9,"box":{"x":0.1,"y":0.1,"w":0.2,"h":0.2}}]}'));
    w.stdout.emit("data", Buffer.from("\n")); // a line split across two chunks is still read whole
    await settle();
    eq(svc.cameras()[0].invalidLines, 2, "two invalid lines counted");
    const db = openEventsDb(path.join(stateDir, "events.db"));
    eq(db.all().length, 1, "the good line still made its event");
    db.close();
  } finally {
    await svc.stop();
  }
});

await check("THE FEARED ONE: a camera whose worker sends no frames never looks watched", async () => {
  const { stateDir, workers, svc, setClock } = await run();
  try {
    workers[0].say({ type: "frame", atUtc: at(0), detections: [] });
    setClock(500);
    await settle();
    await svc.writeHealth();
    const health = JSON.parse(await readFile(path.join(stateDir, "detect-health.json"), "utf8"));
    const c1 = health.cameras.find((c) => c.cameraId === "cam-1");
    const c2 = health.cameras.find((c) => c.cameraId === "cam-2");
    eq(c1.lastFrameUtc, at(0), "cam-1: its last frame");
    eq(c2.lastFrameUtc, null, "cam-2: no frame yet, and it says so (null, not a time)");
    eq(typeof c1.grantedFps, "number", "the rate each camera was granted");
    eq(health.capacityFps, 20, "and the measured capacity it came from");
  } finally {
    await svc.stop();
  }
});

await check("stop() ends every worker (SIGKILL if SIGTERM is ignored) and finishes open events", async () => {
  const { stateDir, workers, svc } = await run({ detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }] } });
  const w = workers[0];
  w.kill = (sig = "SIGTERM") => { w.signals.push(sig); if (sig === "SIGKILL") queueMicrotask(() => w.emit("exit", null)); return true; };
  w.say({ type: "frame", atUtc: at(0), detections: [{ kind: "vehicle", confidence: 0.7, box: { x: 0.4, y: 0.4, w: 0.3, h: 0.2 } }] });
  await settle();
  await svc.stop();
  eq(w.signals, ["SIGTERM", "SIGKILL"], "asked, then made");
  const db = openEventsDb(path.join(stateDir, "events.db"));
  eq(db.all().map((r) => r.finished), [true], "the open event was finished, ending at its last sighting");
  db.close();
});

report("detect service");
