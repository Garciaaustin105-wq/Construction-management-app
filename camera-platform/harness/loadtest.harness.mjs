// camctl load: plays a file into N real recorders. Fake ffmpeg here; the real
// one is exercised in realFfmpeg.harness.mjs.
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegArgs } from "../agent/recorder.mjs";
import { fileSourceArgs, cpuBusyFraction, median, summarizeLoad, formatLoadReport, runLoad } from "../agent/loadtest.mjs";
import { check, eq, report } from "./_assert.mjs";

const URL = "rtsp://u:p@10.0.0.5:554/profile1";

check("the source file replaces the camera, read in real time and looped", () => {
  const original = ffmpegArgs(URL, "/out/%s.mp4", 10);
  const before = original.join(" ");
  const a = fileSourceArgs(original, "/src.mp4");
  eq(original.join(" "), before, "input array not mutated");
  const s = a.join(" ");
  if (s.includes("rtsp://") || s.includes(":p@")) throw new Error(`camera URL left in: ${s}`);
  if (a.includes("-rtsp_transport")) throw new Error("-rtsp_transport is RTSP-only");
  if (!s.includes("-re -stream_loop -1 -i /src.mp4")) throw new Error(`no looped real-time input: ${s}`);
  const tail = (x, at) => x.slice(x.indexOf(at) + 2).join(" ");
  eq(tail(a, "-i"), tail(original, "-i"), "everything after the input is the recorder's own");
  if (!fileSourceArgs(ffmpegArgs(URL, "/o/%s.mp4", 10, { audio: true }), "/s.mp4").join(" ").includes("-c:a aac")) {
    throw new Error("audio arguments dropped");
  }
});

check("args with no input are refused, not guessed", () => {
  let threw = false;
  try { fileSourceArgs(["-f", "segment", "/o/%s.mp4"], "/s.mp4"); } catch { threw = true; }
  eq(threw, true, "throws");
});

check("median: odd, even, empty", () => {
  eq(median([3, 1, 2]), 2, "odd");
  eq(median([4, 1, 3, 2]), 2.5, "even");
  eq(median([]), null, "empty is null, not zero");
});

check("cpu busy is measured across all cores, and nothing measured is null", () => {
  const t = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  eq(cpuBusyFraction([t(100, 100), t(100, 100)], [t(150, 150), t(200, 100)]), 150 / 200, "two cores");
  eq(cpuBusyFraction([t(1, 1)], [t(1, 1)]), null, "no time passed");
  eq(cpuBusyFraction([t(1, 1)], [t(2, 2), t(2, 2)]), null, "core count changed");
});

const cams = (n, bytes) => Array.from({ length: n }, (_, i) => ({ cameraId: `load-${String(i + 1).padStart(2, "0")}`, bytes, segments: 2, exits: 0 }));

check("THE FEARED ONE: a camera that falls behind is named, not averaged away", () => {
  const perCamera = cams(16, 1_250_000);
  perCamera[6].bytes = 900_000;
  const s = summarizeLoad({ cameras: 16, seconds: 10, sourceKbps: 1000, perCamera, cpuSamples: [0.2, 0.5, 0.3] });
  eq(s.expectedBytesPerCamera, 1_250_000, "1000 kbps for 10 s");
  eq(JSON.stringify(s.behind), JSON.stringify(["load-07"]), "the slow camera");
  eq(s.medianBytes, 1_250_000, "median");
  eq(s.minBytes, 900_000, "lowest");
  eq(s.cpuMedianPct, 30, "median cpu");
  eq(s.cpuMaxPct, 50, "max cpu");
  eq(s.segments, 32, "segments");
  if (!formatLoadReport(s).includes("load-07")) throw new Error("report hides the slow camera");
});

check("THE FEARED ONE: no source bitrate means not measured, never 'none behind'", () => {
  const s = summarizeLoad({ cameras: 2, seconds: 10, perCamera: cams(2, 1000), cpuSamples: [] });
  eq(s.expectedBytesPerCamera, null, "expected");
  eq(s.behind, null, "behind");
  eq(s.cpuMedianPct, null, "cpu");
  const r = formatLoadReport(s);
  const line = r.split("\n").find((l) => l.startsWith("behind"));
  if (!line || !line.includes("not measured")) throw new Error(`behind line: ${line}`);
  if (!r.split("\n").find((l) => l.startsWith("cpu")).includes("not measured")) throw new Error("cpu line");
});

check("ffmpeg exits are counted and named", () => {
  const perCamera = cams(3, 1000);
  perCamera[2].exits = 2;
  const s = summarizeLoad({ cameras: 3, seconds: 1, perCamera });
  eq(s.exits, 2, "exits");
  eq(JSON.stringify(s.camerasWithExits), JSON.stringify(["load-03"]), "who");
});

check("every number in the report carries its unit", () => {
  const r = formatLoadReport(summarizeLoad({ cameras: 2, seconds: 10, sourceKbps: 2000, perCamera: cams(2, 2_500_000), cpuSamples: [0.25] }));
  for (const unit of [" MB/s", " s", " MB", " kbps", "%"]) if (!r.includes(unit)) throw new Error(`missing ${unit}:\n${r}`);
});

// Fake ffmpeg: writes one wip file on spawn, exits when killed.
function fakeSpawn(spawned, bytes) {
  return (cmd, args) => {
    spawned.push(args);
    const child = new EventEmitter();
    child.pid = 1000 + spawned.length;
    child.stderr = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit("exit", 0)); return true; };
    const dir = path.dirname(args[args.length - 1]);
    mkdir(dir, { recursive: true }).then(() => writeFile(path.join(dir, `${1_757_500_000 + spawned.length}.mp4`), Buffer.alloc(bytes)));
    return child;
  };
}
const fakeCpus = () => [{ times: { user: Date.now(), nice: 0, sys: 0, idle: Date.now(), irq: 0 } }];

await check("THE FEARED ONE: a load run deletes only its own directory", async () => {
  const target = await mkdtemp(path.join(tmpdir(), "camplat-load-target-"));
  await writeFile(path.join(target, "keep.mp4"), "x");
  await mkdir(path.join(target, "cam-real"), { recursive: true });
  await writeFile(path.join(target, "cam-real", "1757000000.mp4"), "y");
  const spawned = [];
  const s = await runLoad({ target, source: "/src.mp4", cameras: 3, seconds: 0.3, sampleMs: 50, spawnFn: fakeSpawn(spawned, 5000), cpusFn: fakeCpus });
  eq(JSON.stringify((await readdir(target)).sort()), JSON.stringify(["cam-real", "keep.mp4"]), "target after");
  eq(JSON.stringify(await readdir(path.join(target, "cam-real"))), JSON.stringify(["1757000000.mp4"]), "real recordings untouched");
  eq(s.cameras, 3, "cameras");
  eq(spawned.length, 3, "one ffmpeg per camera");
  for (const a of spawned) {
    if (!a.includes("-stream_loop") || !a.includes("/src.mp4") || a.join(" ").includes("rtsp://")) throw new Error(`args: ${a.join(" ")}`);
  }
  eq(s.perCamera.every((c) => c.bytes >= 5000), true, `bytes per camera: ${s.perCamera.map((c) => c.bytes)}`);
  eq(s.exits, 0, "a stop is not an exit");
});

await check("keep leaves the run's recordings for inspection", async () => {
  const target = await mkdtemp(path.join(tmpdir(), "camplat-load-keep-"));
  await runLoad({ target, source: "/src.mp4", cameras: 1, seconds: 0.2, sampleMs: 50, spawnFn: fakeSpawn([], 100), cpusFn: fakeCpus, keep: true });
  const left = await readdir(target);
  eq(left.length === 1 && left[0].startsWith(".loadtest-"), true, `left: ${left}`);
});

await check("nonsense is refused before anything is written", async () => {
  const target = await mkdtemp(path.join(tmpdir(), "camplat-load-bad-"));
  for (const bad of [{ cameras: 0, seconds: 1, source: "/s.mp4" }, { cameras: 2, seconds: 0, source: "/s.mp4" }, { cameras: 2, seconds: 1 }, { cameras: 1.5, seconds: 1, source: "/s.mp4" }]) {
    let threw = false;
    try { await runLoad({ target, spawnFn: fakeSpawn([], 1), cpusFn: fakeCpus, ...bad }); } catch { threw = true; }
    eq(threw, true, `refused ${JSON.stringify(bad)}`);
  }
  eq((await readdir(target)).length, 0, "nothing written");
});

report("load test");
