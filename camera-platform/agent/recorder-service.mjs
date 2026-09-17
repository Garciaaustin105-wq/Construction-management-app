/**
 * The daemon. Wires the tested pieces into something systemd can keep alive.
 *
 * Order matters on boot: recover BEFORE recording. Starting the recorders first
 * would have ffmpeg creating new files in `.inprogress/` while recovery is still
 * deciding what the old ones were, and the partial from the last power cut would
 * be indistinguishable from the segment being written right now.
 */
import { readFile, writeFile, rename, statfs, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { openIndex } from "./segindex.mjs";
import { scanDisk, applyRecovery, applyEviction, ensureCameraDirs, quarantineUsage, INPROGRESS } from "./segstore.mjs";
import { createCameraRecorder } from "./recorder.mjs";
import { planEvictionScalable } from "./evict.mjs";
import { DEFAULT_PATHS, indexPathFor, assignCamerasToDrives, checkStoreRoot } from "./config.mjs";
import { planRecovery } from "../dist/recovery.js";
import { bytesToFreeFor } from "../dist/eviction.js";
import { computeRetentionDays, usableBytesFromRaw } from "../dist/retention.js";
import { buildRtspUrl, redactRtspUrl, urlForPath } from "../dist/rtsp.js";
import { parseRtspUrl } from "../dist/cameraSource.js";
import { parseCameraFile } from "../dist/cameraEdit.js";

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
    { vendor: camera.vendor ?? "generic", ip: camera.host, channel: camera.channel ?? 1, stream: camera.stream ?? "main" },
    credentials,
  );
  if (built.kind !== "ok") return { kind: "unresolved", reason: built.message };
  return { kind: "ok", url: built.url, origin: "discovered" };
}

/** Cameras edited on the Cameras page; see contracts/cameraEdit.ts. */
export const CAMERAS_FILE = "cameras.json";

/**
 * cameras.json: { kind: "absent" } | { kind: "ok", cameras, login } |
 * { kind: "broken", reason }. Broken is refused whole, never half-read; the
 * caller keeps config.json's cameras and reports the reason.
 */
export async function readCameraFile(stateDir) {
  const raw = await readFile(path.join(stateDir, CAMERAS_FILE), "utf8").catch((err) => (err.code === "ENOENT" ? null : { error: err.code ?? err.message }));
  if (raw === null) return { kind: "absent" };
  if (typeof raw !== "string") return { kind: "broken", reason: `unreadable: ${raw.error}` };
  const parsed = parseCameraFile(raw);
  return parsed.ok ? { kind: "ok", cameras: parsed.cameras, login: parsed.login } : { kind: "broken", reason: parsed.reason };
}

export async function loadConfig(stateDir) {
  const file = path.join(stateDir, "config.json");
  const raw = await readFile(file, "utf8").catch((err) => { if (err.code === "ENOENT") return null; throw new Error(`cannot read ${file}: ${err.code ?? err.message}`); });
  if (raw === null) throw new Error(`no config at ${file} — the appliance has not been commissioned`);
  let config;
  try { config = JSON.parse(raw); } catch (err) { throw new Error(`${file} is not valid JSON: ${err.message}`); }
  // A broken cameras.json keeps recording what config.json lists rather than
  // nothing; the problem is carried out so the Cameras page can show it.
  const overlay = await readCameraFile(stateDir);
  const cameras = overlay.kind === "ok" ? overlay.cameras : config.cameras;
  if (!Array.isArray(cameras) || cameras.length === 0) {
    throw new Error("config has no cameras");
  }
  return {
    siteId: config.siteId ?? "unknown-site",
    cameras,
    credentials: (overlay.kind === "ok" ? overlay.login : null) ?? config.credentials ?? { username: "", password: "" },
    camerasSource: overlay.kind === "ok" ? CAMERAS_FILE : "config.json",
    camerasFileProblem: overlay.kind === "broken" ? overlay.reason : null,
    // The login set on the Cameras page, kept apart so saving writes back only that one.
    camerasLogin: overlay.kind === "ok" ? overlay.login : null,
    storeRoots: config.storeRoots ?? DEFAULT_PATHS.storeRoots,
    segmentSeconds: config.segmentSeconds ?? 60,
    retentionTargetDays: config.retentionTargetDays ?? 30,
    allowUnmountedStores: config.allowUnmountedStores === true,
  };
}

/** Free space per store root, so eviction knows how hard to work. */
async function diskUsage(root) {
  const s = await statfs(root);
  const total = s.blocks * s.bsize;
  return { total, free: s.bavail * s.bsize, used: total - s.bavail * s.bsize };
}

export async function runRecovery(index, storeRoots, { dryRun = false } = {}) {
  const summary = { confirmed: 0, corrected: 0, partials: 0, adopted: 0, dropped: 0, quarantined: 0, quarantineFailed: 0, lost: 0 };
  const boundary = new Date().toISOString();

  const scans = [];
  for (const root of storeRoots) {
    const scan = await scanDisk(root);
    scans.push([...scan.sealed, ...scan.inProgress]);
  }
  for (let i = 0; i < storeRoots.length; i++) {
    const root = storeRoots[i];
    const onDisk = scans[i];
    const indexed = index.all().filter((s) => onDisk.some((f) => f.path === s.path) || (i === 0 && !scans.some(arr => arr.some(f => f.path === s.path))));
    const plan = planRecovery(indexed, onDisk, boundary);
    if (dryRun) {
      // Report only: no file moves, no index writes, no gaps.
      for (const key of Object.keys(plan.summary)) summary[key] += plan.summary[key];
      continue;
    }

    const applied = await applyRecovery(root, plan);
    // Every file this drive holds is on this drive: fills in rows indexed
    // before segments recorded it, and corrects any that were wrong.
    index.assignRoot(root, onDisk.map((f) => f.path));

    const writes = [];
    for (const action of plan.actions) {
      if (action.kind === "correct_size") writes.push({ ...action.segment, bytes: action.actualBytes, root });
      if (action.kind === "seal_partial") {
        writes.push({
          ...action.segment,
          state: "partial",
          bytes: action.actualBytes,
          endUtc: action.estimatedEndUtc,
          root,
        });
      }
    }
    for (const orphan of applied.adopted) {
      writes.push({
        cameraId: orphan.cameraId, startUtc: orphan.startUtc, endUtc: null, path: orphan.path,
        bytes: orphan.bytes, state: "sealed", hold: false, pendingUpload: false, bitrateKbps: null, root,
      });
    }
    if (writes.length > 0) index.putMany(writes);

    const removals = plan.actions.filter((a) => a.kind === "lost").map((a) => a.segment.path);
    if (removals.length > 0) index.removeMany(removals);
    for (const gap of plan.gaps) index.addGap(gap);

    for (const key of Object.keys(plan.summary)) summary[key] += plan.summary[key];
    summary.quarantined -= applied.failed.length;
    summary.quarantineFailed += applied.failed.length;
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

    const plan = planEvictionScalable(index, toFree, { root });
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

/**
 * Report what recovery WOULD do right now, changing nothing.
 *
 * Two refusals, so the numbers are never misleading: with no index nothing has
 * recorded here (and openIndex would create one, hiding a wrong state dir),
 * and with a refused store root any count is a lie, because the missing drive
 * hides its files and its footage would be written off as lost.
 */
export async function audit({ stateDir = DEFAULT_PATHS.stateDir, storeCheck } = {}) {
  const config = await loadConfig(stateDir);
  const indexFile = indexPathFor(stateDir);
  try {
    await stat(indexFile);
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`no index at ${indexFile}: nothing has recorded here, or the state directory is wrong`);
    throw err;
  }
  const checkRoot = storeCheck ?? ((root) => checkStoreRoot(root, config.allowUnmountedStores ? { requireMount: false } : {}));
  const refusedRoots = [];
  for (const root of config.storeRoots) {
    const verdict = await checkRoot(root);
    if (!verdict.ok) refusedRoots.push({ root, reason: verdict.reason });
  }
  const disks = [];
  for (const root of config.storeRoots) {
    disks.push({ root, quarantine: refusedRoots.some((r) => r.root === root) ? null : await quarantineUsage(root).catch(() => null) });
  }
  if (refusedRoots.length > 0) {
    return { summary: null, refusedRoots, disks };
  }
  const index = openIndex(indexFile);
  try {
    return { summary: await runRecovery(index, config.storeRoots, { dryRun: true }), refusedRoots, disks };
  } finally {
    index.close();
  }
}

export async function start({ stateDir = DEFAULT_PATHS.stateDir, spawnFn, storeCheck, now = () => new Date() } = {}) {
  const startedUtc = now().toISOString();
  const config = await loadConfig(stateDir);
  await mkdir(stateDir, { recursive: true });
  const index = openIndex(indexPathFor(stateDir));
  log("info", "starting", { siteId: config.siteId, cameras: config.cameras.length });

  const checkRoot = storeCheck ?? ((root) => checkStoreRoot(root, config.allowUnmountedStores ? { requireMount: false } : {}));
  const storeRoots = [];
  const refusedRoots = [];
  for (const root of config.storeRoots) {
    const verdict = await checkRoot(root);
    if (verdict.ok) {
      storeRoots.push(root);
    } else {
      refusedRoots.push({ root, reason: verdict.reason });
      log("error", "store root refused", { root, reason: verdict.reason });
    }
  }
  if (storeRoots.length === 0) {
    index.close();
    throw new Error(`no usable recording drive: ${refusedRoots.map((r) => r.reason).join("; ")}`);
  }
  // Recover before a single recorder starts — see the note at the top.
  // A refused drive hides its files, so recovery would write them off as lost.
  let recovered;
  if (refusedRoots.length === 0) {
    recovered = await runRecovery(index, storeRoots);
    log("info", "recovery complete", recovered);
  } else {
    recovered = { skipped: true, reason: "a recording drive is not available" };
    log("warn", "recovery skipped", { refused: refusedRoots.map((r) => r.root) });
  }

  const assignment = assignCamerasToDrives(config.cameras.map((c) => c.cameraId), storeRoots.length);
  const recorders = [];
  const unresolved = [];
  // The box clock when each camera last sealed a segment. Not the segment's own
  // time: a camera with a wrong clock still reports whether it is recording (L14).
  const lastSealed = new Map(config.cameras.map((c) => [c.cameraId, null]));

  for (const camera of config.cameras) {
    const resolved = resolveCameraUrl(camera, config.credentials);
    if (resolved.kind !== "ok") {
      unresolved.push({ cameraId: camera.cameraId, reason: resolved.reason });
      log("error", "camera unresolved", { cameraId: camera.cameraId, reason: resolved.reason });
      continue;
    }
    const root = storeRoots[assignment.get(camera.cameraId) ?? 0];
    await ensureCameraDirs(root, camera.cameraId);

    const recorder = createCameraRecorder({
      root,
      cameraId: camera.cameraId,
      url: resolved.url,
      index,
      segmentSeconds: config.segmentSeconds,
      bitrateKbps: typeof camera.bitrateKbps === "number" ? camera.bitrateKbps : null,
      audio: camera.audio === true, // legally gated: off unless the site config turns it on
      spawnFn,
      onEvent: (e) => {
        if (e.kind === "sealed") lastSealed.set(e.cameraId, now().toISOString());
        if (e.kind === "stderr") return;
        const level = e.kind === "spawn_failed" || e.kind === "seal_failed" ? "error"
          : e.kind === "exited" || e.kind === "stop_killed" || e.kind === "audio_dropped" ? "warn" : "info";
        log(level, e.kind, { cameraId: e.cameraId, count: e.count, code: e.code, file: e.file, error: e.error });
      },
    });
    await recorder.start();
    recorders.push({ cameraId: camera.cameraId, root, recorder });
  }

  const evictionTimer = setInterval(() => {
    runEviction(index, storeRoots, log).catch((err) => log("error", "eviction failed", { err: err.message }));
  }, EVICTION_INTERVAL_MS);

  // Read by `camctl alerts` (contracts/alerts.ts HealthSnapshot), a separate process.
  const writeHealth = async () => {
    const disks = [];
    for (const root of storeRoots) {
      const usage = await diskUsage(root).catch(() => null);
      if (usage) disks.push({ root, ...usage, quarantine: await quarantineUsage(root).catch(() => null) });
    }
    const retention = computeRetentionDays(
      currentRetention(index, config.cameras),
      disks.reduce((sum, d) => sum + d.total, 0) * RING_FILL,
    );
    const health = {
      siteId: config.siteId,
      atUtc: now().toISOString(),
      startedUtc,
      cameras: recorders.length,
      cameraIds: config.cameras.map((c) => c.cameraId),
      unresolved,
      storeRoots: config.storeRoots,
      refusedRoots: refusedRoots.map((r) => r.root),
      lastSealedUtc: Object.fromEntries(lastSealed),
      segments: index.count(),
      disks,
      // A refusal is reported as one. An appliance that cannot compute its own
      // retention should say so, not print a number it guessed.
      retentionDays: retention.kind === "ok" ? retention.days : null,
      retentionRefused: retention.kind === "refused" ? retention.message : null,
    };
    // Written aside and renamed, so the alerts reader never sees half a file.
    const file = path.join(stateDir, "health.json");
    await writeFile(`${file}.tmp`, JSON.stringify(health, null, 2))
      .then(() => rename(`${file}.tmp`, file))
      .catch((err) => log("error", "health write failed", { err: err.message }));
  };
  const healthTimer = setInterval(writeHealth, HEALTH_INTERVAL_MS);

  const stop = async () => {
    clearInterval(evictionTimer);
    clearInterval(healthTimer);
    await Promise.all(recorders.map((r) => r.recorder.stop()));
    index.close();
    log("info", "stopped", {});
  };

  return { stop, recorders, index, config, unresolved, recovered, refusedRoots, writeHealth };
}

// Only run when executed directly, so tests can import the pieces.
if (process.argv[1] && process.argv[1].endsWith("recorder-service.mjs")) {
  const stateDir = process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  // The Cameras page writes cameras.json; the recorder applies it by stopping
  // cleanly and letting systemd (Restart=always) start it on the new list.
  // Taken before start(), so an edit landing during start-up is not missed.
  const camerasPath = path.join(stateDir, CAMERAS_FILE);
  const signature = () => stat(camerasPath).then((s) => `${s.mtimeMs}:${s.size}`, (err) => (err.code === "ENOENT" ? "absent" : "unreadable"));
  const startedWith = await signature();
  const handle = await start({ stateDir });
  let stopping = false;
  const stopAndExit = () => {
    if (stopping) return;
    stopping = true;
    handle.stop().finally(() => process.exit(0));
  };
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stopAndExit);
  const reloadTimer = setInterval(async () => {
    if (stopping || (await signature()) === startedWith) return;
    clearInterval(reloadTimer);
    log("info", "camera list changed, restarting to apply it", {});
    stopAndExit();
  }, 5000);
}
