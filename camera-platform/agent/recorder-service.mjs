/**
 * The daemon. Wires the tested pieces into something systemd can keep alive.
 *
 * Order matters on boot: recover BEFORE recording. Starting the recorders first
 * would have ffmpeg creating new files in `.inprogress/` while recovery is still
 * deciding what the old ones were, and the partial from the last power cut would
 * be indistinguishable from the segment being written right now.
 */
import { readFile, writeFile, statfs, mkdir } from "node:fs/promises";
import path from "node:path";
import { openIndex } from "./segindex.mjs";
import { scanDisk, applyRecovery, applyEviction, ensureCameraDirs, INPROGRESS } from "./segstore.mjs";
import { createCameraRecorder } from "./recorder.mjs";
import { planEvictionScalable } from "./evict.mjs";
import { DEFAULT_PATHS, indexPathFor, assignCamerasToDrives } from "./config.mjs";
import { planRecovery } from "../dist/recovery.js";
import { bytesToFreeFor } from "../dist/eviction.js";
import { computeRetentionDays, usableBytesFromRaw } from "../dist/retention.js";
import { buildRtspUrl, redactRtspUrl, urlForPath } from "../dist/rtsp.js";
import { parseRtspUrl } from "../dist/cameraSource.js";

const EVICTION_INTERVAL_MS = 5 * 60_000;
const HEALTH_INTERVAL_MS = 30_000;
const RING_FILL = 0.85;

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

/**
 * Resolve a configured camera to a playable URL.
 *
 * Three levels, as BUILD-PLAN requires: a verbatim URL wins outright, then a
 * vendor template, and a camera we cannot resolve is reported rather than
 * silently skipped — a camera missing from a site is exactly the thing nobody
 * notices until they need it.
 */
export function resolveCameraUrl(camera, credentials) {
  if (typeof camera.url === "string" && camera.url !== "") {
    const parsed = parseRtspUrl(camera.url);
    if (parsed.kind !== "ok") return { kind: "unresolved", reason: parsed.reason };
    // A URL carrying its own credentials is used exactly as given.
    const url = parsed.username !== null
      ? camera.url
      : urlForPath(parsed.host, parsed.path, credentials, parsed.port).url;
    return { kind: "ok", url, origin: "manual_url" };
  }
  if (typeof camera.host !== "string" || camera.host === "") {
    return { kind: "unresolved", reason: "camera has neither a url nor a host" };
  }
  const built = buildRtspUrl(
    { vendor: camera.vendor ?? "generic", ip: camera.host, channel: camera.channel ?? 1, stream: "main" },
    credentials,
  );
  if (built.kind !== "ok") return { kind: "unresolved", reason: built.message };
  return { kind: "ok", url: built.url, origin: "discovered" };
}

export async function loadConfig(stateDir) {
  const file = path.join(stateDir, "config.json");
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) throw new Error(`no config at ${file} — the appliance has not been commissioned`);
  const config = JSON.parse(raw);
  if (!Array.isArray(config.cameras) || config.cameras.length === 0) {
    throw new Error("config has no cameras");
  }
  return {
    siteId: config.siteId ?? "unknown-site",
    cameras: config.cameras,
    credentials: config.credentials ?? { username: "", password: "" },
    storeRoots: config.storeRoots ?? DEFAULT_PATHS.storeRoots,
    segmentSeconds: config.segmentSeconds ?? 60,
    retentionTargetDays: config.retentionTargetDays ?? 30,
  };
}

/** Free space per store root, so eviction knows how hard to work. */
async function diskUsage(root) {
  const s = await statfs(root);
  const total = s.blocks * s.bsize;
  return { total, free: s.bavail * s.bsize, used: total - s.bavail * s.bsize };
}

export async function runRecovery(index, storeRoots) {
  const summary = { confirmed: 0, corrected: 0, partials: 0, adopted: 0, dropped: 0, quarantined: 0, lost: 0 };
  const boundary = new Date().toISOString();

  for (const root of storeRoots) {
    const scan = await scanDisk(root);
    const onDisk = [...scan.sealed, ...scan.inProgress];
    const indexed = index.all().filter((s) => onDisk.some((f) => f.path === s.path) || s.path.startsWith(""));
    const plan = planRecovery(indexed, onDisk, boundary);

    const applied = await applyRecovery(root, plan);

    const writes = [];
    for (const action of plan.actions) {
      if (action.kind === "correct_size") writes.push({ ...action.segment, bytes: action.actualBytes });
      if (action.kind === "seal_partial") {
        writes.push({
          ...action.segment,
          state: "partial",
          bytes: action.actualBytes,
          endUtc: action.estimatedEndUtc,
        });
      }
    }
    for (const orphan of applied.adopted) {
      writes.push({
        cameraId: orphan.cameraId, startUtc: orphan.startUtc, endUtc: null, path: orphan.path,
        bytes: orphan.bytes, state: "sealed", hold: false, pendingUpload: false, bitrateKbps: null,
      });
    }
    if (writes.length > 0) index.putMany(writes);

    const removals = plan.actions.filter((a) => a.kind === "lost").map((a) => a.segment.path);
    if (removals.length > 0) index.removeMany(removals);
    for (const gap of plan.gaps) index.addGap(gap);

    for (const key of Object.keys(summary)) summary[key] += plan.summary[key];
  }
  return summary;
}

async function runEviction(index, storeRoots, log_) {
  for (const root of storeRoots) {
    const usage = await diskUsage(root).catch(() => null);
    if (usage === null) continue;
    const budget = usableBytesFromRaw(usage.total, 0) * RING_FILL;
    const toFree = bytesToFreeFor(usage.used, budget, 0);
    if (toFree <= 0) continue;

    const plan = planEvictionScalable(index, toFree);
    if (plan.evict.length === 0) {
      // Nothing evictable and still over budget: everything left is held,
      // pending upload, or open. That is an operator problem, not a bug, and it
      // must be visible rather than retried silently every five minutes.
      log_("warn", "over budget with nothing evictable", {
        root, toFree, blocked: plan.blocked?.length ?? 0,
      });
      continue;
    }
    const result = await applyEviction(root, plan);
    index.removeMany(result.deleted);
    log_("info", "evicted", { root, segments: result.deleted.length, bytesFreed: result.bytesFreed });
  }
}

function currentRetention(index, cameras) {
  const bitrates = cameras.map((c) => ({
    cameraId: c.cameraId,
    bitrateKbps: typeof c.bitrateKbps === "number" ? c.bitrateKbps : null,
  }));
  return bitrates;
}

export async function start({ stateDir = DEFAULT_PATHS.stateDir, spawnFn, now = () => new Date() } = {}) {
  const config = await loadConfig(stateDir);
  await mkdir(stateDir, { recursive: true });
  const index = openIndex(indexPathFor(stateDir));
  log("info", "starting", { siteId: config.siteId, cameras: config.cameras.length });

  // Recover before a single recorder starts — see the note at the top.
  const recovered = await runRecovery(index, config.storeRoots);
  log("info", "recovery complete", recovered);

  const assignment = assignCamerasToDrives(config.cameras.map((c) => c.cameraId), config.storeRoots.length);
  const recorders = [];
  const unresolved = [];

  for (const camera of config.cameras) {
    const resolved = resolveCameraUrl(camera, config.credentials);
    if (resolved.kind !== "ok") {
      unresolved.push({ cameraId: camera.cameraId, reason: resolved.reason });
      log("error", "camera unresolved", { cameraId: camera.cameraId, reason: resolved.reason });
      continue;
    }
    const root = config.storeRoots[assignment.get(camera.cameraId) ?? 0];
    await ensureCameraDirs(root, camera.cameraId);

    const recorder = createCameraRecorder({
      root,
      cameraId: camera.cameraId,
      url: resolved.url,
      index,
      segmentSeconds: config.segmentSeconds,
      bitrateKbps: typeof camera.bitrateKbps === "number" ? camera.bitrateKbps : null,
      spawnFn,
      onEvent: (e) => {
        if (e.kind === "sealed" || e.kind === "started" || e.kind === "exited" || e.kind === "gap_recorded") {
          log(e.kind === "exited" ? "warn" : "info", e.kind, { cameraId: e.cameraId, count: e.count, code: e.code });
        }
      },
    });
    await recorder.start();
    recorders.push({ cameraId: camera.cameraId, root, recorder });
  }

  const evictionTimer = setInterval(() => {
    runEviction(index, config.storeRoots, log).catch((err) => log("error", "eviction failed", { err: err.message }));
  }, EVICTION_INTERVAL_MS);

  const healthTimer = setInterval(async () => {
    const disks = [];
    for (const root of config.storeRoots) {
      const usage = await diskUsage(root).catch(() => null);
      if (usage) disks.push({ root, ...usage });
    }
    const retention = computeRetentionDays(
      currentRetention(index, config.cameras),
      disks.reduce((sum, d) => sum + d.total, 0) * RING_FILL,
    );
    const health = {
      siteId: config.siteId,
      atUtc: now().toISOString(),
      cameras: recorders.length,
      unresolved,
      segments: index.count(),
      disks,
      // A refusal is reported as one. An appliance that cannot compute its own
      // retention should say so, not print a number it guessed.
      retentionDays: retention.kind === "ok" ? retention.days : null,
      retentionRefused: retention.kind === "refused" ? retention.message : null,
    };
    await writeFile(path.join(stateDir, "health.json"), JSON.stringify(health, null, 2)).catch(() => {});
  }, HEALTH_INTERVAL_MS);

  const stop = async () => {
    clearInterval(evictionTimer);
    clearInterval(healthTimer);
    await Promise.all(recorders.map((r) => r.recorder.stop()));
    index.close();
    log("info", "stopped", {});
  };

  return { stop, recorders, index, config, unresolved, recovered };
}

// Only run when executed directly, so tests can import the pieces.
if (process.argv[1] && process.argv[1].endsWith("recorder-service.mjs")) {
  const handle = await start({ stateDir: process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => { handle.stop().finally(() => process.exit(0)); });
  }
}
