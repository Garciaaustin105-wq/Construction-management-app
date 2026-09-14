/**
 * camctl load: what does this box do with N cameras recording at once?
 *
 * Plays a recorded file into N copies of the real recorder, through the
 * recorder's own ffmpeg arguments, sealing and indexing as in production.
 * There is no RTSP server and no network, so it measures CPU, disks and the
 * index, not N real network sources (LINUX-BUILD-PLAN.md D5).
 *
 * It reports measurements. It never says how many cameras are "fine".
 */
import { readdir, stat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { openIndex } from "./segindex.mjs";
import { createCameraRecorder } from "./recorder.mjs";

/** A camera that wrote less than this share of the source's bytes fell behind. */
export const BEHIND_FRACTION = 0.9;

/** it turns the recorder's camera arguments into a looped file read in real time. */
export function fileSourceArgs(args, sourceFile) {
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-rtsp_transport") {
      i++;
      continue;
    }
    filtered.push(args[i]);
  }
  const iIdx = filtered.indexOf("-i");
  if (iIdx === -1) throw new Error("no -i in ffmpeg args");
  filtered.splice(iIdx, 2, "-re", "-stream_loop", "-1", "-i", sourceFile);
  return filtered;
}

export function cpuBusyFraction(before, after) {
  if (before.length !== after.length) return null;
  let total = 0;
  let idleDelta = 0;
  for (let i = 0; i < before.length; i++) {
    const b = before[i].times;
    const a = after[i].times;
    total += (a.user - b.user) + (a.nice - b.nice) + (a.sys - b.sys) + (a.idle - b.idle) + (a.irq - b.irq);
    idleDelta += a.idle - b.idle;
  }
  if (total <= 0) return null;
  return (total - idleDelta) / total;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (n % 2 === 1) ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Measurements only; a blank stays null rather than becoming zero. */
export function summarizeLoad({ cameras, seconds, sourceKbps = null, perCamera, cpuSamples = [] }) {
  const bytes = perCamera.map((c) => c.bytes);
  const expectedBytesPerCamera = sourceKbps === null ? null : Math.round(sourceKbps * 1000 / 8 * seconds);
  const cpu = cpuSamples.filter((x) => x !== null);
  return {
    cameras,
    seconds,
    sourceKbps,
    perCamera,
    expectedBytesPerCamera,
    medianBytes: median(bytes),
    minBytes: perCamera.length === 0 ? null : Math.min(...bytes),
    totalMBps: bytes.reduce((sum, b) => sum + b, 0) / 1e6 / seconds,
    segments: perCamera.reduce((sum, c) => sum + c.segments, 0),
    behind: expectedBytesPerCamera === null ? null : perCamera.filter((c) => c.bytes < expectedBytesPerCamera * BEHIND_FRACTION).map((c) => c.cameraId),
    exits: perCamera.reduce((sum, c) => sum + c.exits, 0),
    camerasWithExits: perCamera.filter((c) => c.exits > 0).map((c) => c.cameraId),
    cpuMedianPct: cpu.length === 0 ? null : Math.round(median(cpu) * 1000) / 10,
    cpuMaxPct: cpu.length === 0 ? null : Math.round(Math.max(...cpu) * 1000) / 10
  };
}

/** The load report: every number carries its unit, and what was not measured says so. */
export function formatLoadReport(summary) {
  const MB = (bytes) => (bytes / 1e6).toFixed(1);
  const label = (name) => name.padEnd(15);
  const medianText = summary.medianBytes === null ? "not measured" : `${MB(summary.medianBytes)} MB`;
  const lowestText = summary.minBytes === null ? "not measured" : `${MB(summary.minBytes)} MB`;
  const expectedText = summary.expectedBytesPerCamera === null
    ? "not measured (pass --kbps, the measured bitrate of the source)"
    : `${MB(summary.expectedBytesPerCamera)} MB per camera at ${summary.sourceKbps} kbps`;
  const behindText = summary.behind === null
    ? "not measured"
    : summary.behind.length === 0 ? "none below 90% of expected" : `${summary.behind.length} below 90% of expected: ${summary.behind.join(", ")}`;
  const exitText = summary.exits === 0 ? "none" : `${summary.exits} (${summary.camerasWithExits.join(", ")})`;
  const cpuText = summary.cpuMedianPct === null ? "not measured" : `median ${summary.cpuMedianPct}%, max ${summary.cpuMaxPct}% (all cores)`;
  return [
    `${label("cameras")}${summary.cameras}`,
    `${label("run")}${summary.seconds} s`,
    `${label("written")}${summary.totalMBps.toFixed(2)} MB/s total`,
    `${label("per camera")}median ${medianText}, lowest ${lowestText}`,
    `${label("expected")}${expectedText}`,
    `${label("behind")}${behindText}`,
    `${label("ffmpeg exits")}${exitText}`,
    `${label("cpu busy")}${cpuText}`,
    `${label("segments")}${summary.segments} files`
  ].join("\n");
}

export async function runLoad({
  target,
  source,
  cameras,
  seconds,
  segmentSeconds = 10,
  sourceKbps = null,
  sampleMs = 1000,
  spawnFn = (cmd, args) => spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] }),
  cpusFn = cpus,
  keep = false,
}) {
  if (typeof source !== "string" || source.length === 0) throw new Error("runLoad: source must be a non-empty string");
  if (!Number.isInteger(cameras) || cameras < 1) throw new Error("runLoad: cameras must be an integer >= 1");
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("runLoad: seconds must be a finite number > 0");
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) throw new Error("runLoad: segmentSeconds must be a finite number > 0");
  const runDir = path.join(target, `.loadtest-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-load-"));
  const index = openIndex(path.join(stateDir, "index.db"));
  let sampler = null;
  try {
    const records = [];
    for (let i = 0; i < cameras; i++) {
      const cameraId = `load-${String(i + 1).padStart(2, "0")}`;
      const exits = { count: 0 };
      const onEvent = (e) => {
        if (e.kind === "exited" || e.kind === "spawn_failed") exits.count++;
      };
      records.push({
        cameraId,
        exits,
        recorder: createCameraRecorder({
          root: runDir,
          cameraId,
          url: `rtsp://load.invalid/${cameraId}`,
          index,
          segmentSeconds,
          bitrateKbps: sourceKbps,
          spawnFn: (cmd, args) => spawnFn(cmd, fileSourceArgs(args, source)),
          onEvent,
        }),
      });
    }
    const recorders = records.map((rec) => rec.recorder);
    let prev = cpusFn();
    const cpuSamples = [];
    sampler = setInterval(() => {
      const next = cpusFn();
      cpuSamples.push(cpuBusyFraction(prev, next));
      prev = next;
    }, sampleMs);
    await Promise.all(recorders.map((r) => r.start()));
    await new Promise((r) => setTimeout(r, seconds * 1000));
    clearInterval(sampler);
    const finalNext = cpusFn();
    cpuSamples.push(cpuBusyFraction(prev, finalNext));
    prev = finalNext;
    await Promise.all(recorders.map((r) => r.stop()));
    const perCamera = [];
    for (const rec of records) {
      const dir = path.join(runDir, rec.cameraId);
      let names = [];
      try {
        names = await readdir(dir, { recursive: true });
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      let bytes = 0;
      let segments = 0;
      for (const name of names) {
        const st = await stat(path.join(dir, name));
        if (!st.isFile()) continue;
        bytes += st.size;
        if (name.endsWith(".mp4")) segments++;
      }
      perCamera.push({ cameraId: rec.cameraId, bytes, segments, exits: rec.exits.count });
    }
    return summarizeLoad({ cameras, seconds, sourceKbps, perCamera, cpuSamples });
  } finally {
    if (sampler !== null) clearInterval(sampler);
    try {
      index.close();
    } catch {
      // closing twice must not break cleanup
    }
    // only the run's own directory is ever deleted, never the target
    if (!keep) await rm(runDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}
