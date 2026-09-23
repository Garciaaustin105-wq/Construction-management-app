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
 *
 * KNOWN OBJECTS (the second half): a person hidden - one who walked in and
 * stood on the known spot, or one who started there and walked off and stayed
 * hidden; a store that cannot be trusted still hiding people, or being
 * overwritten; a re-aimed camera still hiding at the old spot; a reset by hand
 * undone by the detector; a box with no known objects behaving any
 * differently than before; a camera address, user or password in a log line
 * or a file.
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, readFile, stat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDetect } from "../agent/detect-service.mjs";
import { openEventsDb } from "../agent/events-db.mjs";
import { createKnownObjectsStore, cameraFingerprint } from "../agent/known-objects.mjs";
import { MERGE_GAP_MS } from "../dist/detection.js";
import { resetKnownObject, answerKnownObject } from "../dist/knownObjects.js";
import { check, eq, close, report } from "./_assert.mjs";

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

// Bench 2026-09-19: the permissive detector's weak guesses (a 0.35 "vehicle",
// a 0.67 "person" the size of the whole frame) were all stored, cluttering
// the timeline. The worker stays permissive so the clip library can measure
// what a floor would miss; STORING has a floor, set per box in detect.json.
await check("THE FEARED ONE: detections under the storing floor never become events; the floor is 0.5 unless detect.json says otherwise", async () => {
  const { stateDir, workers, svc } = await run({ detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }] } });
  try {
    const w = workers[0];
    w.say({ type: "frame", atUtc: at(0), detections: [
      { kind: "vehicle", confidence: 0.35, box: { x: 0.6, y: 0.5, w: 0.08, h: 0.1 } },
      { kind: "person", confidence: 0.49, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 } },
      { kind: "person", confidence: 0.5, box: { x: 0.5, y: 0.1, w: 0.2, h: 0.4 } },
    ] });
    await settle();
    const db = openEventsDb(path.join(stateDir, "events.db"));
    const rows = db.all();
    eq(rows.map((r) => [r.kind, r.bestConfidence]), [["person", 0.5]], "only the 0.5 person stored (at the floor counts)");
    db.close();
    await svc.writeHealth();
    const health = JSON.parse(await readFile(path.join(stateDir, "detect-health.json"), "utf8"));
    eq(health.minConfidence, 0.5, "the floor is reported, so nobody wonders why a weak sighting is missing");
  } finally {
    await svc.stop();
  }
});

await check("a lower storing floor in detect.json is honoured; a floor that is not a number in 0..1 refuses to start", async () => {
  const { stateDir, workers, svc } = await run({ detect: { capacityFps: 10, minConfidence: 0.3, cameras: [{ cameraId: "cam-1" }] } });
  try {
    workers[0].say({ type: "frame", atUtc: at(0), detections: [{ kind: "person", confidence: 0.35, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 } }] });
    await settle();
    const db = openEventsDb(path.join(stateDir, "events.db"));
    eq(db.all().length, 1, "0.35 stored under a 0.3 floor");
    db.close();
  } finally {
    await svc.stop();
  }
  for (const bad of ["high", 1.5, -0.1, null]) {
    const sd = await site({ detect: { capacityFps: 10, minConfidence: bad, cameras: [{ cameraId: "cam-1" }] } });
    let threw = null;
    try { await startDetect({ stateDir: sd, spawnFn: fakeWorkers().spawnFn, log: () => {} }); } catch (err) { threw = err; }
    if (!threw) throw new Error(`minConfidence ${JSON.stringify(bad)}: started anyway`);
    if (!/minConfidence/.test(threw.message)) throw new Error(`the refusal should name the setting: ${threw.message}`);
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

check("THE FEARED ONE: the installed detector never outranks recording, and is off until it is set up", () => {
  const install = readFileSync(path.join(import.meta.dirname, "..", "setup", "install.sh"), "utf8").replaceAll("\r\n", "\n");
  const i = install.indexOf("/etc/systemd/system/camplat-detect.service");
  if (i < 0) throw new Error("install.sh does not install the detector unit");
  const body = install.indexOf("<<UNIT", i) + "<<UNIT".length;   // the unit itself starts after the heredoc marker
  const unit = install.slice(body, install.indexOf(String.fromCharCode(10) + "UNIT", body));
  for (const [line, why] of [["Nice=10", "runs below the recorder"], ["CPUWeight=30", "gets less CPU than the recorder"],
    ["User=$RUN_USER", "runs as the service user"], ["ConditionPathExists=$STATE_DIR/detect.json", "does nothing until detection is configured"]]) {
    if (!unit.includes(line)) throw new Error(`the detector unit is missing ${line} (${why})`);
  }
  const enables = install.split("\n").filter((l) => /^\s*systemctl enable/.test(l))   // a comment saying how to enable it is not enabling it.join(" ");
  eq(/camplat-detect/.test(enables), false, "and install.sh never enables it: it needs a measured capacity, a model and its Python first");
});

// ---------------- motion gating (detect.json's optional motionGate) ----------------

await check("THE FEARED ONE: no motionGate in detect.json - the worker args are byte-for-byte what they were, no --gate", async () => {
  const { workers, svc } = await run({ detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }] } });
  try {
    const a = workers[0].args;
    eq(a.length, 9, "exactly the five existing flags (workerPath + 4 pairs), nothing appended");
    eq([a[1], a[3], a[5], a[7]], ["--camera", "--url", "--fps", "--model"], "the same four flags, in the same order");
    if (a.some((x) => String(x).startsWith("--gate") || String(x) === "--track-floor")) {
      throw new Error("a gate flag leaked in with the gate off");
    }
  } finally {
    await svc.stop();
  }
});

await check("motionGate enabled with no threshold or keepaliveMs: --gate --track-floor <minConfidence>, nothing more", async () => {
  const { workers, svc } = await run({ detect: { capacityFps: 10, minConfidence: 0.4, cameras: [{ cameraId: "cam-1" }], motionGate: { enabled: true } } });
  try {
    const a = workers[0].args;
    const i = a.indexOf("--gate");
    if (i < 0) throw new Error("--gate missing");
    eq(a.slice(i), ["--gate", "--track-floor", "0.4"], "the gate flags, in order, and nothing after them");
  } finally {
    await svc.stop();
  }
});

await check("motionGate enabled with threshold and keepaliveMs: both appended in protocol order", async () => {
  const { workers, svc } = await run({
    detect: { capacityFps: 10, minConfidence: 0.5, cameras: [{ cameraId: "cam-1" }], motionGate: { enabled: true, threshold: 0.02, keepaliveMs: 15000 } },
  });
  try {
    const a = workers[0].args;
    const i = a.indexOf("--gate");
    eq(a.slice(i), ["--gate", "--track-floor", "0.5", "--gate-threshold", "0.02", "--gate-keepalive-ms", "15000"], "gate, track-floor, threshold, keepalive, in that order");
  } finally {
    await svc.stop();
  }
});

await check("motionGate enabled with threshold only, or keepaliveMs only: the missing one is simply not passed", async () => {
  {
    const { workers, svc } = await run({ detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }], motionGate: { enabled: true, threshold: 0.1 } } });
    try {
      const a = workers[0].args;
      eq(a.slice(a.indexOf("--gate")), ["--gate", "--track-floor", "0.5", "--gate-threshold", "0.1"], "threshold only");
    } finally { await svc.stop(); }
  }
  {
    const { workers, svc } = await run({ detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }], motionGate: { enabled: true, keepaliveMs: 20000 } } });
    try {
      const a = workers[0].args;
      eq(a.slice(a.indexOf("--gate")), ["--gate", "--track-floor", "0.5", "--gate-keepalive-ms", "20000"], "keepaliveMs only");
    } finally { await svc.stop(); }
  }
});

await check("motionGate: enabled false is off, args unchanged, same as absent - and health does not report its settings", async () => {
  const { stateDir, workers, svc } = await run({ detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }], motionGate: { enabled: false, threshold: 0.3, keepaliveMs: 9000 } } });
  try {
    if (workers[0].args.includes("--gate")) throw new Error("enabled:false still gated");
    await svc.writeHealth();
    const health = JSON.parse(await readFile(path.join(stateDir, "detect-health.json"), "utf8"));
    eq(health.motionGate, { enabled: false, threshold: null, keepaliveMs: null }, "off reports no threshold, not one it is not running");
    eq(health.cameras.find((c) => c.cameraId === "cam-1").gate, null, "and no per-camera gate figures");
  } finally {
    await svc.stop();
  }
});

await check("THE FEARED ONE: every way motionGate can be malformed refuses to start and names the field", async () => {
  for (const [motionGate, why] of [
    [{ enabled: "yes" }, "enabled not a boolean"],
    [{ enabled: true, threshold: 0 }, "threshold not > 0"],
    [{ enabled: true, threshold: 1 }, "threshold not < 1"],
    [{ enabled: true, threshold: 1.5 }, "threshold past 1"],
    [{ enabled: true, threshold: "0.1" }, "threshold not a number"],
    [{ enabled: true, keepaliveMs: 999 }, "keepaliveMs under 1000"],
    [{ enabled: true, keepaliveMs: 600001 }, "keepaliveMs over 600000"],
    [{ enabled: true, keepaliveMs: 5000.5 }, "keepaliveMs not an integer"],
    [{ enabled: true, keepaliveMs: "5000" }, "keepaliveMs not a number"],
    [{ enabled: true, extra: 1 }, "an unknown key"],
    [true, "motionGate itself not an object"],
    [[], "motionGate is an array"],
  ]) {
    const sd = await site({ detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }], motionGate } });
    let threw = null;
    try { await startDetect({ stateDir: sd, spawnFn: fakeWorkers().spawnFn, log: () => {} }); } catch (err) { threw = err; }
    if (!threw) throw new Error(`${why}: started anyway`);
    if (!/motionGate/.test(threw.message)) throw new Error(`${why}: the refusal should name motionGate: ${threw.message}`);
  }
});

await check("a gate line updates detect-health.json's per-camera gate figures, and does not count as invalid", async () => {
  const { stateDir, workers, svc, setClock } = await run({
    detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }], motionGate: { enabled: true, threshold: 0.02 } },
  });
  try {
    const w = workers[0];
    setClock(0);
    await svc.writeHealth();
    let health = JSON.parse(await readFile(path.join(stateDir, "detect-health.json"), "utf8"));
    eq(health.motionGate, { enabled: true, threshold: 0.02, keepaliveMs: null }, "the config is reported");
    let c1 = health.cameras.find((c) => c.cameraId === "cam-1");
    eq(c1.gate, { lastWindow: null, sinceStart: null }, "before any gate line: null fields, never zeros");

    setClock(60_000);
    w.say({ type: "gate", windowS: 60, frames: 300, looked: 9, reasons: { first: 1, motion: 6, keepalive: 2 } });
    await settle();
    eq(svc.cameras().find((c) => c.cameraId === "cam-1").invalidLines, 0, "a valid gate line is not an invalid line");
    await svc.writeHealth();
    health = JSON.parse(await readFile(path.join(stateDir, "detect-health.json"), "utf8"));
    c1 = health.cameras.find((c) => c.cameraId === "cam-1");
    eq(c1.gate.lastWindow, { atUtc: at(60_000), windowS: 60, frames: 300, looked: 9, share: 0.03, reasons: { first: 1, motion: 6, keepalive: 2 } }, "the last window");
    eq(c1.gate.sinceStart, { frames: 300, looked: 9, share: 0.03 }, "running totals since the worker started");

    setClock(120_000);
    w.say({ type: "gate", windowS: 60, frames: 300, looked: 3, reasons: { motion: 3 } });
    await settle();
    await svc.writeHealth();
    health = JSON.parse(await readFile(path.join(stateDir, "detect-health.json"), "utf8"));
    c1 = health.cameras.find((c) => c.cameraId === "cam-1");
    eq(c1.gate.lastWindow.looked, 3, "the last window replaces, it does not add");
    eq(c1.gate.sinceStart, { frames: 600, looked: 12, share: 12 / 600 }, "sinceStart accumulates across gate lines");
  } finally {
    await svc.stop();
  }
});

await check("a BAD gate line IS counted as invalid, and does not disturb the figures already recorded", async () => {
  const { stateDir, workers, svc, setClock } = await run({
    detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }], motionGate: { enabled: true } },
  });
  try {
    const w = workers[0];
    setClock(0);
    w.say({ type: "gate", windowS: 60, frames: 300, looked: 9, reasons: { motion: 9 } });
    await settle();
    w.say({ type: "gate", windowS: 60, frames: 300, looked: 500, reasons: { motion: 500 } }); // looked > frames
    w.say({ type: "gate", windowS: 60, frames: 300, looked: 5, reasons: { motion: 4 } }); // sum short of looked
    await settle();
    eq(svc.cameras().find((c) => c.cameraId === "cam-1").invalidLines, 2, "both bad lines counted");
    await svc.writeHealth();
    const health = JSON.parse(await readFile(path.join(stateDir, "detect-health.json"), "utf8"));
    const c1 = health.cameras.find((c) => c.cameraId === "cam-1");
    eq(c1.gate.sinceStart, { frames: 300, looked: 9, share: 0.03 }, "unchanged: the bad lines never touched it");
  } finally {
    await svc.stop();
  }
});

await check("a respawned worker starts its gate figures over, not carried from the one before it", async () => {
  const { workers, svc, setClock } = await run({
    detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }], motionGate: { enabled: true } },
  });
  try {
    setClock(0);
    workers[0].say({ type: "gate", windowS: 60, frames: 300, looked: 30, reasons: { motion: 30 } });
    await settle();
    workers[0].emit("exit", 1);
    await settle(80);
    eq(workers.length, 2, "restarted");
    eq(svc.cameras().find((c) => c.cameraId === "cam-1").gate, { lastWindow: null, sinceStart: null }, "the new worker's gate figures start clean");
  } finally {
    await svc.stop();
  }
});

// Bench 2026-09-20: with the camera unplugged the worker exited at once, and
// the SERVICE exited with it ("Deactivated successfully"), because every
// timer was unref()'d and nothing else was pending; systemd restarted it every
// 10 s. The recorder rides out a dead camera; the detector must too.
await check("THE FEARED ONE: the daemon stays up while its only camera is down, and stops cleanly on SIGTERM", async () => {
  const stateDir = await site({ detect: { capacityFps: 10, cameras: [{ cameraId: "cam-1" }] } });
  const dying = path.join(stateDir, "dying-worker.mjs");
  const NL = String.fromCharCode(10);
  await writeFile(dying, 'process.stdout.write(JSON.stringify({ type: "error", message: "camera unreachable" }) + String.fromCharCode(10)); process.exit(2);' + NL);
  const daemon = spawn(process.execPath, [path.join(import.meta.dirname, "..", "agent", "detect-service.mjs")], {
    env: { ...process.env, CAMPLAT_STATE_DIR: stateDir, CAMPLAT_DETECT_PYTHON: process.execPath, CAMPLAT_DETECT_WORKER: dying },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  daemon.stdout.on("data", (d) => { out += d; });
  daemon.stderr.on("data", (d) => { out += d; });
  let exited = null;
  let signal = null;
  let ended = false;
  daemon.on("exit", (code, sig) => { exited = code; signal = sig; ended = true; });
  await settle(3000);
  eq(ended, false, `still running after 3 s of a worker that dies at once (output: ${out.slice(-300)})`);
  eq((out.match(/detect worker exited/g) ?? []).length >= 2, true, "and it has been retrying the worker");
  daemon.kill("SIGTERM");
  await settle(1500);
  eq(ended, true, "SIGTERM: gone");
  // Windows has no signals: kill() ends the process outright, code null. Only
  // Linux (the appliance) can show the clean exit 0 the shutdown handler gives.
  if (process.platform !== "win32") eq(exited, 0, "SIGTERM: stopped cleanly");
  else eq(signal, "SIGTERM", "SIGTERM: terminated (Windows cannot show a clean exit)");
});

// ---------------- known objects ----------------

// A login nobody else uses, so a leak of it cannot hide among other words.
const KUSER = "kn0wn-user";
const KPASS = "Kn0wn-pw-77";
const KNOWN_CAMERAS = [
  { cameraId: "cam-1", url: `rtsp://${KUSER}:${KPASS}@10.9.8.1:554/main`, substreamUrl: `rtsp://${KUSER}:${KPASS}@10.9.8.1:554/sub` },
  { cameraId: "cam-2", host: "10.9.8.2", vendor: "hikvision" },
];
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const knownFile = (stateDir) => path.join(stateDir, "known-objects.json");

// This evening's real person events from the bench camera (2026-09-22), as
// stored: U = the furled patio umbrella by the fence, 17 events in 25 minutes;
// P = the two real people at the gate. [tag, first, last, confidence, x, y, w, h].
const EVENING = [
  ["U", "2026-09-22T21:55:07.748Z", "2026-09-22T21:55:07.748Z", 0.6226, 0.69768, 0.36345, 0.09393, 0.42538],
  ["U", "2026-09-22T21:56:59.379Z", "2026-09-22T21:56:59.379Z", 0.5047, 0.69773, 0.36596, 0.08889, 0.41594],
  ["U", "2026-09-22T22:01:52.974Z", "2026-09-22T22:01:52.974Z", 0.5123, 0.69909, 0.36571, 0.08833, 0.43438],
  ["P", "2026-09-22T22:03:18.756Z", "2026-09-22T22:03:22.960Z", 0.9259, 0.18121, 0.59159, 0.18379, 0.40399],
  ["U", "2026-09-22T22:05:02.386Z", "2026-09-22T22:05:02.386Z", 0.5341, 0.69785, 0.36701, 0.09931, 0.42035],
  ["U", "2026-09-22T22:05:18.590Z", "2026-09-22T22:05:25.379Z", 0.6479, 0.69783, 0.36372, 0.08986, 0.40962],
  ["U", "2026-09-22T22:06:00.379Z", "2026-09-22T22:06:00.379Z", 0.5901, 0.69961, 0.36481, 0.07954, 0.41503],
  ["U", "2026-09-22T22:07:05.161Z", "2026-09-22T22:07:14.559Z", 0.7988, 0.69979, 0.36473, 0.08178, 0.41967],
  ["U", "2026-09-22T22:07:33.954Z", "2026-09-22T22:07:36.562Z", 0.6457, 0.7002, 0.36623, 0.08032, 0.41702],
  ["U", "2026-09-22T22:07:49.149Z", "2026-09-22T22:08:03.400Z", 0.6743, 0.69975, 0.36437, 0.09332, 0.41222],
  ["U", "2026-09-22T22:08:22.198Z", "2026-09-22T22:08:28.393Z", 0.7623, 0.70121, 0.36325, 0.07917, 0.43076],
  ["U", "2026-09-22T22:08:47.989Z", "2026-09-22T22:11:29.956Z", 0.7881, 0.69939, 0.36584, 0.08819, 0.41676],
  ["U", "2026-09-22T22:12:04.606Z", "2026-09-22T22:12:07.800Z", 0.5668, 0.70037, 0.36335, 0.08832, 0.41729],
  ["U", "2026-09-22T22:12:22.001Z", "2026-09-22T22:12:22.001Z", 0.5589, 0.69792, 0.3626, 0.09173, 0.42515],
  ["U", "2026-09-22T22:12:41.995Z", "2026-09-22T22:13:29.988Z", 0.7684, 0.6976, 0.36341, 0.09171, 0.43008],
  ["U", "2026-09-22T22:13:59.381Z", "2026-09-22T22:14:05.775Z", 0.6638, 0.69782, 0.36306, 0.0853, 0.42685],
  ["U", "2026-09-22T22:16:38.396Z", "2026-09-22T22:16:38.396Z", 0.5169, 0.69589, 0.36153, 0.08744, 0.44704],
  ["U", "2026-09-22T22:20:31.210Z", "2026-09-22T22:20:31.210Z", 0.5817, 0.69874, 0.36382, 0.08386, 0.42189],
  ["P", "2026-09-22T22:26:52.780Z", "2026-09-22T22:27:00.976Z", 0.9214, 0.23881, 0.67734, 0.13168, 0.31926],
];
const UMBRELLA_BOX = { x: 0.69874, y: 0.36382, w: 0.08386, h: 0.42189 };   // its last row's box
const GATE_BOX = { x: 0.18121, y: 0.59159, w: 0.18379, h: 0.40399 };      // the 6:03 PM person's
const CAM2_BOX = { x: 0.3, y: 0.3, w: 0.1, h: 0.3 };

/** A site for the known-objects checks; rewrites the config of an existing one. */
async function knownSite({ stateDir, cameras = KNOWN_CAMERAS, credentials = { username: KUSER, password: KPASS } } = {}) {
  const dir = stateDir ?? await mkdtemp(path.join(tmpdir(), "camplat-known-svc-"));
  const store = await mkdtemp(path.join(tmpdir(), "camplat-known-svc-store-"));
  await writeFile(path.join(dir, "config.json"), JSON.stringify({ siteId: "t", storeRoots: [store], segmentSeconds: 60, credentials, cameras }));
  await writeFile(path.join(dir, "detect.json"), JSON.stringify({ capacityFps: 10, cameras: [{ cameraId: "cam-1" }, { cameraId: "cam-2" }] }));
  return dir;
}

/** An active known object on this camera, learned under the camera's fingerprint in `cameras`. */
function objectOn(cameraId, box, atMs, cameras = KNOWN_CAMERAS) {
  return {
    id: `${cameraId}:person:${atMs}`, cameraId, kind: "person", box: { ...box },
    state: "active", lapsedAtUtc: null, lapseReason: null,
    learnedAtUtc: iso(atMs), firstSeenUtc: iso(atMs - 3 * HOUR), lastSeenUtc: iso(atMs),
    lastMatchedUtc: null, members: 3, matched: 0, confidenceMax: 0.8,
    sampleEventId: "seed-1", memberEventIds: ["seed-1", "seed-2", "seed-3"],
    cameraFingerprint: cameraFingerprint(cameras.find((c) => c.cameraId === cameraId)), answer: null,
  };
}
const storeText = (objects) => `${JSON.stringify({ version: 1, objects }, null, 2)}\n`;
const seed = (stateDir, objects) => writeFile(knownFile(stateDir), storeText(objects));
const storedObjects = async (stateDir) => JSON.parse(await readFile(knownFile(stateDir), "utf8")).objects;
async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

// Every log line of every known-objects run, and every state dir, for the
// leak check at the end.
const knownLogs = [];
const knownDirs = [];

async function knownRun(stateDir, startMs, extra = {}) {
  knownDirs.push(stateDir);
  const { workers, spawnFn } = fakeWorkers();
  const logs = [];
  let clock = startMs;
  const svc = await startDetect({
    stateDir, spawnFn, now: () => new Date(clock), tickMs: 1_000_000_000, healthMs: 1_000_000_000,
    knownPassMs: 1_000_000_000, knownFlushMs: 1_000_000_000, restartMs: { first: 40, max: 200 }, killAfterMs: 100,
    log: (level, msg, more) => { const line = JSON.stringify({ level, msg, ...more }); logs.push(line); knownLogs.push(line); },
    ...extra,
  });
  const worker = (cameraId) => workers.find((w) => cameraOf(w) === cameraId);
  const sighting = (cameraId, t, box, conf) => {
    clock = t;
    worker(cameraId).say({ type: "frame", atUtc: iso(t), detections: [{ kind: "person", confidence: conf, box }] });
  };
  return {
    svc, logs, stateDir, worker, sighting,
    setClock: (ms) => { clock = ms; },
    // One still event: a sighting a second from firstMs to lastMs at one box.
    play: (cameraId, { firstMs, lastMs = firstMs, box, conf = 0.7 }) => {
      for (let t = firstMs; ; t = Math.min(t + 1000, lastMs)) {
        sighting(cameraId, t, box, conf);
        if (t >= lastMs) break;
      }
    },
    // Every open event finished: the clock past the merge gap, then a tick.
    finish: (ms) => { clock = ms; svc.tick(); },
    rows: () => {
      const db = openEventsDb(path.join(stateDir, "events.db"));
      try { return db.all(); } finally { db.close(); }
    },
    health: async () => {
      await svc.writeHealth();
      return JSON.parse(await readFile(path.join(stateDir, "detect-health.json"), "utf8"));
    },
  };
}

await check("THIS EVENING, END TO END: 17 umbrella events in 25 minutes teach nothing; two hours on they do, all 34 are hidden, and the two people at the gate are not", async () => {
  const stateDir = await knownSite();
  const k = await knownRun(stateDir, Date.parse("2026-09-22T21:50:00.000Z"));
  try {
    const playRow = ([, first, last, conf, x, y, w, h], shift = 0) =>
      k.play("cam-1", { firstMs: Date.parse(first) + shift, lastMs: Date.parse(last) + shift, box: { x, y, w, h }, conf });
    for (const row of EVENING) playRow(row);
    k.finish(Date.parse("2026-09-22T22:30:00.000Z"));
    await k.svc.knownPass();
    let rows = k.rows();
    eq(rows.length, 19, "the 19 events, stored as the bench stored them");
    eq(rows.map((r) => r.travel), rows.map(() => 0), "each one's travel measured and stored: 0, a still box");
    eq(rows.every((r) => r.suppressedBy === null), true, "25 minutes of it: nothing hidden");
    eq(await exists(knownFile(stateDir)), false, "nothing learned, so no known-objects file");
    const firstPass = (await k.health()).knownObjects.lastPass;
    eq([firstPass.considered, firstPass.learned, firstPass.rejected.too_brief], [19, 0, 17],
      "and detect-health.json says why (rule 16): the umbrella's 17 events were too brief");

    for (const row of EVENING.filter((r) => r[0] === "U")) playRow(row, 2 * HOUR);
    k.finish(Date.parse("2026-09-23T00:30:00.000Z"));
    await k.svc.knownPass();
    const [o, ...others] = await storedObjects(stateDir);
    eq(others.length, 0, "one object learned");
    eq([o.cameraId, o.kind, o.state, o.members, o.memberEventIds.length, o.matched], ["cam-1", "person", "active", 34, 34, 0], "from all 34 umbrella events");
    close(o.box.h, 0.42, 0.01, "the umbrella's box: about 42% of the frame's height");
    rows = k.rows();
    const umbrella = rows.filter((r) => r.bestBox.x > 0.6);
    const people = rows.filter((r) => r.bestBox.x < 0.3);
    eq([umbrella.length, people.length], [34, 2], "34 umbrella rows, 2 people");
    eq(umbrella.every((r) => r.suppressedBy === o.id), true, "every umbrella row hidden behind it - flagged, still stored");
    eq(people.map((r) => r.suppressedBy), [null, null], "the two people at the gate (6:03 and 6:26 PM): shown");
    const learnedLine = k.logs.find((l) => l.includes("known object learned"));
    if (!learnedLine) throw new Error("the learning was not logged");
    const said = JSON.parse(learnedLine);
    eq([said.cameraId, said.kind, said.members, said.hidden, said.spanMinutes], ["cam-1", "person", 34, 34, 145], "one line: camera, kind, members, how many hidden, span");

    // It comes back: hidden while open, counted once when it finishes.
    k.play("cam-1", { firstMs: Date.parse("2026-09-23T00:40:00.000Z"), lastMs: Date.parse("2026-09-23T00:40:03.000Z"), box: { x: 0.69768, y: 0.36345, w: 0.09393, h: 0.42538 }, conf: 0.6 });
    eq(k.rows().find((r) => !r.finished)?.suppressedBy, o.id, "a new sighting on the spot: hidden while still open");
    // And a person at the gate while it is known.
    k.play("cam-1", { firstMs: Date.parse("2026-09-23T00:45:00.000Z"), lastMs: Date.parse("2026-09-23T00:45:04.000Z"), box: GATE_BOX, conf: 0.93 });
    k.finish(Date.parse("2026-09-23T00:46:00.000Z"));
    rows = k.rows();
    eq(rows.length, 38, "both stored");
    eq(rows.at(-2).suppressedBy, o.id, "the umbrella's new event: hidden when finished too");
    eq(rows.at(-1).suppressedBy, null, "the person at the gate: shown");
    await k.svc.knownFlush();
    const [after] = await storedObjects(stateDir);
    eq([after.matched, after.lastMatchedUtc, after.lastSeenUtc], [1, "2026-09-23T00:45:00.000Z", "2026-09-23T00:40:03.000Z"],
      "counted once (one finished event, not one per sighting), and its seen range widened to it");
    const health = await k.health();
    eq(health.knownObjects, {
      active: 1, lapsed: 0, problem: null, learnProblem: null, saveProblem: null,
      // The two real people at the gate scored 0.92 and 0.93: refused by the
      // 0.85 ceiling before they could even count as too few.
      lastPass: { atUtc: "2026-09-23T00:30:00.000Z", considered: 36, learned: 1, rejected: { above_ceiling: 2 }, truncated: false },
    }, "health: one active object, nothing wrong, and the last pass's numbers");
    eq(health.cameras.find((c) => c.cameraId === "cam-1").knownObjects, { active: 1, hiddenSinceStart: 1 }, "cam-1: one object, one event hidden since start");
    eq(health.cameras.find((c) => c.cameraId === "cam-2").knownObjects, { active: 0, hiddenSinceStart: 0 }, "cam-2: none");
  } finally {
    await k.svc.stop();
  }
});

await check("THE FEARED ONE: an event that starts on the known spot and walks off is shown again at its next update (and the very first frame is already matched)", async () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const stateDir = await knownSite();
  const o = objectOn("cam-1", UMBRELLA_BOX, T - HOUR);
  await seed(stateDir, [o]);
  const k = await knownRun(stateDir, T);
  try {
    const openRow = () => k.rows().find((r) => !r.finished);
    // The first frame any worker sends: the store was read before it started.
    k.sighting("cam-1", T + 1000, UMBRELLA_BOX, 0.8);
    eq(openRow().suppressedBy, o.id, "on the spot, not yet moved: hidden - from the very first frame");
    for (let i = 1; i <= 6; i += 1) {
      k.sighting("cam-1", T + 1000 + i * 200, { ...UMBRELLA_BOX, x: UMBRELLA_BOX.x - 0.05 * i }, 0.7);
    }
    const row = openRow();
    eq(row.travel >= 0.5, true, `it travelled: ${row.travel} box diagonals`);
    eq(row.bestBox, UMBRELLA_BOX, "(its best box is still exactly the known spot: travel is what shows it)");
    eq(row.suppressedBy, null, "shown again the moment it had travelled");
    k.finish(T + 60_000);
    eq(k.rows().map((r) => [r.finished, r.suppressedBy]), [[true, null]], "and still shown once finished");
    await k.svc.knownFlush();
    eq((await storedObjects(stateDir))[0].matched, 0, "never counted as a match");
    eq((await k.health()).cameras.find((c) => c.cameraId === "cam-1").knownObjects.hiddenSinceStart, 0, "nor as hidden");
  } finally {
    await k.svc.stop();
  }
});

await check("THE FEARED ONE: THE STILL PERSON WHO WALKED IN - one who walks up and stands exactly on the known spot is never hidden, not for one update", async () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const stateDir = await knownSite();
  const o = objectOn("cam-1", UMBRELLA_BOX, T - HOUR);
  await seed(stateDir, [o]);
  const k = await knownRun(stateDir, T);
  try {
    let t = T + 1000;
    const seen = [];
    for (let i = 6; i >= 0; i -= 1) {       // walks in from the left, a step a frame
      k.sighting("cam-1", t, { ...UMBRELLA_BOX, x: UMBRELLA_BOX.x - 0.05 * i }, 0.8);
      seen.push(k.rows()[0].suppressedBy);
      t += 200;
    }
    for (let i = 0; i < 20; i += 1) {       // and stands on the spot, sure of itself
      k.sighting("cam-1", t, UMBRELLA_BOX, 0.92);
      seen.push(k.rows()[0].suppressedBy);
      t += 200;
    }
    eq(k.rows()[0].bestBox, UMBRELLA_BOX, "its best box is exactly the known object's");
    eq(seen.every((s) => s === null), true, `shown at every one of its ${seen.length} updates`);
    k.finish(t + 60_000);
    eq(k.rows()[0].suppressedBy, null, "and when it finished");
  } finally {
    await k.svc.stop();
  }
});

await check("THE FEARED ONE: a store that cannot be trusted hides nothing, is said once, and is never overwritten", async () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const stateDir = await knownSite();
  // A good object exactly where the next event will be - in a file one
  // hand-edit away from valid, so it is refused whole.
  const text = `${JSON.stringify({ version: 1, objects: [objectOn("cam-1", UMBRELLA_BOX, T - HOUR)], note: "edited by hand" }, null, 2)}\n`;
  await writeFile(knownFile(stateDir), text);
  const k = await knownRun(stateDir, T);
  try {
    k.play("cam-1", { firstMs: T + 60_000, lastMs: T + 63_000, box: UMBRELLA_BOX, conf: 0.6 });
    eq(k.rows().map((r) => r.suppressedBy), [null], "still, on the spot it would have matched: shown");
    k.finish(T + 120_000);
    for (let i = 0; i < 3; i += 1) {
      await k.svc.knownPass();
      await k.svc.knownFlush();
    }
    eq(await readFile(knownFile(stateDir), "utf8"), text, "not overwritten, after three passes and three writes");
    const health = await k.health();
    if (!/failed its check/.test(health.knownObjects.problem ?? "")) throw new Error(`health should report the problem: ${health.knownObjects.problem}`);
    eq([health.knownObjects.active, health.cameras.find((c) => c.cameraId === "cam-1").knownObjects.active], [0, 0], "and no object active");
    eq(k.logs.filter((l) => l.includes("cannot be trusted")).length, 1, "said once, not on every pass");
  } finally {
    await k.svc.stop();
  }
  eq(await readFile(knownFile(stateDir), "utf8"), text, "not even by stop()");
});

await check("THE FEARED ONE: a store that goes bad while running stops hiding at the next read, is not overwritten by the counts waiting to be written, and hiding resumes when it is fixed", async () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const stateDir = await knownSite();
  const o = objectOn("cam-1", UMBRELLA_BOX, T - HOUR);
  await seed(stateDir, [o]);
  const k = await knownRun(stateDir, T);
  try {
    k.play("cam-1", { firstMs: T + 60_000, box: UMBRELLA_BOX, conf: 0.6 });
    k.finish(T + 120_000);
    eq(k.rows().map((r) => r.suppressedBy), [o.id], "hidden while the file is good (and a count now waits to be written)");
    const broken = storeText([o]).slice(0, 120);
    await writeFile(knownFile(stateDir), broken);
    await k.svc.knownFlush();
    eq(await readFile(knownFile(stateDir), "utf8"), broken, "the waiting count was not written over the broken file");
    k.play("cam-1", { firstMs: T + 180_000, box: UMBRELLA_BOX, conf: 0.6 });
    k.finish(T + 240_000);
    eq(k.rows().map((r) => r.suppressedBy), [o.id, null], "the next one on the spot: shown");
    await seed(stateDir, [o]);
    await k.svc.knownFlush();
    if (!k.logs.some((l) => l.includes("can be read again"))) throw new Error("the recovery was not said");
    k.play("cam-1", { firstMs: T + 300_000, box: UMBRELLA_BOX, conf: 0.6 });
    k.finish(T + 360_000);
    eq(k.rows().map((r) => r.suppressedBy), [o.id, null, o.id], "fixed: hidden again");
  } finally {
    await k.svc.stop();
  }
});

await check("THE FEARED ONE: a camera whose connection settings changed has its objects lapsed at the next start; a new password is not a change", async () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const stateDir = await knownSite();
  const o1 = objectOn("cam-1", UMBRELLA_BOX, T - HOUR);
  const o2 = objectOn("cam-2", CAM2_BOX, T - HOUR);
  await seed(stateDir, [o1, o2]);

  // The site login and the camera's own password both change.
  const NEWPASS = "Rotated-pw-88";
  const rotated = KNOWN_CAMERAS.map((c) => (c.url ? { ...c, url: c.url.replace(KPASS, NEWPASS), substreamUrl: c.substreamUrl.replace(KPASS, NEWPASS) } : c));
  await knownSite({ stateDir, cameras: rotated, credentials: { username: KUSER, password: NEWPASS } });
  let k = await knownRun(stateDir, T);
  try {
    k.play("cam-1", { firstMs: T + 60_000, box: UMBRELLA_BOX, conf: 0.6 });
    k.play("cam-2", { firstMs: T + 60_000, box: CAM2_BOX, conf: 0.6 });
    k.finish(T + 120_000);
    eq(k.rows().map((r) => r.suppressedBy), [o1.id, o2.id], "passwords changed: both cameras still hide at their spots");
  } finally {
    await k.svc.stop();
  }
  eq((await storedObjects(stateDir)).map((o) => o.state), ["active", "active"], "and nothing lapsed");

  // Now cam-1's substream address points somewhere else.
  const moved = rotated.map((c) => (c.cameraId === "cam-1" ? { ...c, substreamUrl: c.substreamUrl.replace("/sub", "/Streaming/Channels/202") } : c));
  await knownSite({ stateDir, cameras: moved, credentials: { username: KUSER, password: NEWPASS } });
  k = await knownRun(stateDir, T + 2 * 60_000);
  try {
    const [s1, s2] = await storedObjects(stateDir);
    eq([s1.state, s1.lapseReason, s1.lapsedAtUtc], ["lapsed", "camera_changed", iso(T + 2 * 60_000)], "cam-1's object lapsed at the start");
    eq(s2.state, "active", "cam-2's untouched");
    k.play("cam-1", { firstMs: T + 3 * 60_000, box: UMBRELLA_BOX, conf: 0.6 });
    k.play("cam-2", { firstMs: T + 3 * 60_000, box: CAM2_BOX, conf: 0.6 });
    k.finish(T + 4 * 60_000);
    eq(k.rows().slice(-2).map((r) => [r.cameraId, r.suppressedBy]), [["cam-1", null], ["cam-2", o2.id]], "cam-1 shows what is on the old spot; cam-2 still hides");
    const lapsedLine = k.logs.find((l) => l.includes("known object lapsed"));
    if (!lapsedLine) throw new Error("the lapse was not logged");
    eq([JSON.parse(lapsedLine).cameraId, JSON.parse(lapsedLine).reason], ["cam-1", "camera_changed"], "logged with its camera and reason");
    eq((await k.health()).knownObjects.lapsed, 1, "health counts it");
  } finally {
    await k.svc.stop();
  }
});

await check("THE FEARED ONE: a reset by hand (camctl) is not undone - the detector stops hiding at its next read and shows what it hid in between", async () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const stateDir = await knownSite();
  const o = objectOn("cam-1", UMBRELLA_BOX, T - HOUR);
  await seed(stateDir, [o]);
  const k = await knownRun(stateDir, T);
  try {
    k.play("cam-1", { firstMs: T + 60_000, box: UMBRELLA_BOX, conf: 0.6 });
    k.finish(T + 120_000);
    // What camctl known-objects --reset does, from another process.
    const store = createKnownObjectsStore({ stateDir });
    eq((await store.update((objects) => objects.map((x) => resetKnownObject(x, iso(T + 130_000))))).ok, true, "camctl's reset written");
    const db = openEventsDb(path.join(stateDir, "events.db"));
    eq(db.clearSuppressed(o.id), 1, "camctl shows its events again");
    db.close();
    // Before the detector has read the file again, one more comes.
    k.play("cam-1", { firstMs: T + 140_000, box: UMBRELLA_BOX, conf: 0.6 });
    k.finish(T + 200_000);
    eq(k.rows().map((r) => r.suppressedBy), [null, o.id], "(the one in between was hidden: the detector had not read it yet)");
    await k.svc.knownFlush();
    eq(k.rows().map((r) => r.suppressedBy), [null, null], "read: the one in between is shown too");
    k.play("cam-1", { firstMs: T + 260_000, box: UMBRELLA_BOX, conf: 0.6 });
    k.finish(T + 320_000);
    eq(k.rows().map((r) => r.suppressedBy), [null, null, null], "and nothing new is hidden");
    const [after] = await storedObjects(stateDir);
    eq([after.state, after.lapseReason, after.matched], ["lapsed", "reset_by_hand", 0], "the reset stands, and no match was counted on a reset object");
    if (!k.logs.some((l) => l.includes("reset by hand"))) throw new Error("the reset was not logged");
  } finally {
    await k.svc.stop();
  }
});

await check("an owner's answer written by the API server survives the detector's next write of its match counts", async () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const stateDir = await knownSite();
  const o = objectOn("cam-1", UMBRELLA_BOX, T - HOUR);
  await seed(stateDir, [o]);
  const k = await knownRun(stateDir, T);
  try {
    k.play("cam-1", { firstMs: T + 60_000, box: UMBRELLA_BOX, conf: 0.6 });
    k.finish(T + 120_000);
    await createKnownObjectsStore({ stateDir }).update((objects) =>
      objects.map((x) => answerKnownObject(x, { belongs: true, by: "austin" }, iso(T + 125_000))));
    await k.svc.knownFlush();
    const [after] = await storedObjects(stateDir);
    eq(after.answer, { belongs: true, atUtc: iso(T + 125_000), by: "austin" }, "the answer is still there");
    eq(after.matched, 1, "and the match was counted");
    eq(after.state, "active", "and an answer changes nothing about hiding");
  } finally {
    await k.svc.stop();
  }
});

await check("a pass that cannot learn (an unreadable stored event) says so in detect-health.json, and objects already known go on hiding", async () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const stateDir = await knownSite();
  const o = objectOn("cam-1", UMBRELLA_BOX, T - HOUR);
  await seed(stateDir, [o]);
  const db = openEventsDb(path.join(stateDir, "events.db"));
  db.upsert({ id: "bad-1", event: {
    cameraId: "cam-1", kind: "person", firstUtc: iso(T - HOUR), lastUtc: iso(T - HOUR), count: 1, bestConfidence: 0.6,
    bestBox: { x: 0.95, y: 0.1, w: 0.2, h: 0.2 }, bestUtc: iso(T - HOUR), travel: 0 } }, true);   // runs off the frame
  db.close();
  const k = await knownRun(stateDir, T);
  try {
    const firstProblem = (await k.health()).knownObjects.learnProblem;
    // An older event arrives: the bad row's place in the list moves, and with
    // it the words of the problem - still the same problem, still said once.
    const more = openEventsDb(path.join(stateDir, "events.db"));
    more.upsert({ id: "older-1", event: {
      cameraId: "cam-2", kind: "person", firstUtc: iso(T - 2 * HOUR), lastUtc: iso(T - 2 * HOUR), count: 1, bestConfidence: 0.6,
      bestBox: CAM2_BOX, bestUtc: iso(T - 2 * HOUR), travel: 0 } }, true);
    more.close();
    await k.svc.knownPass();
    await k.svc.knownPass();
    const health = await k.health();
    if (!/learning failed/.test(health.knownObjects.learnProblem ?? "")) throw new Error(`health should say learning failed: ${JSON.stringify(health.knownObjects)}`);
    if (health.knownObjects.learnProblem === firstProblem) throw new Error("(the problem's words were meant to change here, and did not)");
    eq([health.knownObjects.problem, health.knownObjects.active], [null, 1], "the store itself is fine, and its object active");
    eq([health.knownObjects.lastPass.considered, health.knownObjects.lastPass.rejected], [null, null], "nothing considered is not zero refused: both null");
    eq(k.logs.filter((l) => l.includes("nothing could be learned")).length, 1, "said once over three passes");
    k.play("cam-1", { firstMs: T + 60_000, box: UMBRELLA_BOX, conf: 0.6 });
    eq(k.rows().find((r) => r.id !== "bad-1" && r.id !== "older-1").suppressedBy, o.id, "the known object still hides");
  } finally {
    await k.svc.stop();
  }
});

await check("THE FEARED ONE: an object learned but not saved (the disk refused) hides nothing; the next pass saves it and hides its events", async () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const stateDir = await knownSite();
  // Three still events on one spot over three hours, stored before the start.
  const db = openEventsDb(path.join(stateDir, "events.db"));
  for (const [i, h] of [[1, 4], [2, 3], [3, 1]]) {
    const t = T - h * HOUR;
    db.upsert({ id: `still-${i}`, event: {
      cameraId: "cam-1", kind: "person", firstUtc: iso(t), lastUtc: iso(t + 5000), count: 5, bestConfidence: 0.6,
      bestBox: UMBRELLA_BOX, bestUtc: iso(t), travel: 0.01 } }, true);
  }
  db.close();
  let refuse = true;
  const store = createKnownObjectsStore({
    stateDir,
    renameFn: async (from, to) => {
      if (refuse) { const err = new Error("i/o"); err.code = "EIO"; throw err; }
      return rename(from, to);
    },
  });
  const k = await knownRun(stateDir, T, { knownObjectsStore: store });
  try {
    let health = await k.health();
    if (!/EIO/.test(health.knownObjects.saveProblem ?? "")) throw new Error(`health should say the write failed: ${JSON.stringify(health.knownObjects)}`);
    eq(health.knownObjects.active, 0, "learned but not saved: not active");
    eq(await exists(knownFile(stateDir)), false, "no file");
    eq(k.rows().map((r) => r.suppressedBy), [null, null, null], "its events not hidden");
    k.play("cam-1", { firstMs: T + 60_000, box: UMBRELLA_BOX, conf: 0.6 });
    eq(k.rows().at(-1).suppressedBy, null, "and nothing new hidden behind it");
    k.finish(T + 120_000);
    refuse = false;
    await k.svc.knownPass();
    health = await k.health();
    eq([health.knownObjects.saveProblem, health.knownObjects.active], [null, 1], "saved now, and active");
    const [o] = await storedObjects(stateDir);
    eq(k.rows().filter((r) => r.id.startsWith("still-")).map((r) => r.suppressedBy), [o.id, o.id, o.id], "its members hidden");
  } finally {
    await k.svc.stop();
  }
});

await check("THE FEARED ONE: with no known objects nothing changes - no file appears, nothing is hidden, and events carry their travel", async () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const stateDir = await knownSite();
  const k = await knownRun(stateDir, T);
  try {
    k.play("cam-1", { firstMs: T + 1000, lastMs: T + 4000, box: UMBRELLA_BOX, conf: 0.6 });
    for (let i = 0; i < 10; i += 1) k.sighting("cam-2", T + 10_000 + i * 200, { ...CAM2_BOX, x: 0.1 + 0.05 * i }, 0.8);
    k.finish(T + 60_000);
    await k.svc.knownPass();
    await k.svc.knownFlush();
    const rows = k.rows();
    eq(rows.map((r) => r.suppressedBy), [null, null], "nothing hidden");
    eq(rows[0].travel, 0, "the still one: travel 0");
    eq(rows[1].travel > 1, true, `the walker: travel ${rows[1].travel}`);
    const health = await k.health();
    eq(health.knownObjects, {
      active: 0, lapsed: 0, problem: null, learnProblem: null, saveProblem: null,
      lastPass: { atUtc: iso(T + 60_000), considered: 2, learned: 0, rejected: { moved: 1, too_few: 1 }, truncated: false },
    }, "health: no objects, nothing wrong, and why nothing was learned");
    eq(health.cameras.map((c) => c.knownObjects), [{ active: 0, hiddenSinceStart: 0 }, { active: 0, hiddenSinceStart: 0 }], "per camera: none");
  } finally {
    await k.svc.stop();
  }
  eq(await exists(knownFile(stateDir)), false, "and no known-objects file, even after stop()");
});

await check("THE FEARED ONE: no known-objects log line, detect-health.json or known-objects.json holds a camera address, its user name or its password", async () => {
  if (knownDirs.length < 10) throw new Error(`too few runs to check: ${knownDirs.length}`);
  const texts = [...knownLogs];
  for (const dir of new Set(knownDirs)) {
    for (const name of ["detect-health.json", "known-objects.json"]) {
      try { texts.push(await readFile(path.join(dir, name), "utf8")); } catch { /* not every run leaves both */ }
    }
  }
  const all = texts.join("\n");
  for (const secret of ["rtsp://", KUSER, KPASS, "Rotated-pw-88", "10.9.8."]) {
    if (all.includes(secret)) throw new Error(`found ${secret} in: ${texts.find((t) => t.includes(secret)).slice(0, 300)}`);
  }
  // Not vacuous: every kind of line the known-objects code writes was made above.
  for (const said of ["known object learned", "known object lapsed", "reset by hand", "cannot be trusted", "can be read again", "nothing could be learned", "could not be saved"]) {
    if (!all.includes(said)) throw new Error(`the lines checked should include "${said}"`);
  }
});

report("detect service");
