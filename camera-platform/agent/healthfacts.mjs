// agent/healthfacts.mjs
//
// The measuring half of the system page. It asks SQLite and the filesystem
// what is actually true, and hands plain numbers to siteHealth() in
// ../dist/siteHealth.js, which decides what they mean. Nothing here renders a
// verdict and nothing there touches a disk.
//
// THREE THINGS THIS FILE IS CAREFUL ABOUT:
//
// 1. A camera in the config with no rows in the index is not an error and not
//    a zero-bitrate camera. It is a camera we have measured nothing about, and
//    it must come back with nulls so the retention estimate refuses instead of
//    quietly reading high.
//
// 2. Bitrate is a MEDIAN of the sealed segments, never a mean. One corrupt
//    segment with a wild byte count would drag a mean far enough to move the
//    retention figure by days (build rule 14).
//
// 3. A store root that is not its own mount point is reported as unmounted,
//    however much free space it claims. Recording into the empty directory
//    where a disk should have been fills the root filesystem, reports the root
//    filesystem's comfortable free figure while it happens, and ends with an
//    appliance that will not boot.

import { stat, statfs, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// The ONLY way an unresolved reason reaches this file's output. resolveCameraUrl's
// raw reason can echo the configured url, and that url carries the camera
// password — cameraView is the audited place where it gets scrubbed, and a
// second scrubber here would be a second thing to get wrong.
import { cameraView } from '../dist/cameraView.js';
import { DAY_MS, PROJECTION_WINDOW_MS } from '../dist/footageHeld.js';
import { RECORDING_FILE, readRecordingFile } from '../dist/recordingSettings.js';
import { RING_FILL } from './config.mjs';

/** How stale health.json may be before the recorder is presumed not running. */
export const RECORDER_STALE_AFTER_MS = 90_000; // three 30s health writes

/**
 * Per-camera measurements, keyed by cameraId, for every camera id given.
 * Cameras with no rows come back as zeros and nulls, never omitted: a camera
 * missing from the page is a camera nobody checks.
 *
 * `index` is an openIndex() handle; only its `db` is used, read-only.
 */
export function cameraFacts(index, cameraIds) {
  const byCamera = new Map();
  for (const cameraId of cameraIds) {
    byCamera.set(cameraId, {
      segments: 0,
      bytes: 0,
      lastSealedUtc: null,
      openSegments: 0,
      measuredKbps: null,
    });
  }

  // One pass for the counts. 'partial' is deliberately counted as neither
  // sealed nor open: its end time is not trustworthy, so it must not be able
  // to make a dead camera look recently alive.
  const rows = index.db
    .prepare(
      `SELECT camera_id,
              SUM(CASE WHEN state = 'sealed' THEN 1 ELSE 0 END) AS sealed_n,
              SUM(CASE WHEN state = 'open'   THEN 1 ELSE 0 END) AS open_n,
              COALESCE(SUM(bytes), 0) AS total_bytes,
              MAX(CASE WHEN state = 'sealed' THEN end_ms END) AS last_end
         FROM segments
        GROUP BY camera_id`,
    )
    .all();

  for (const row of rows) {
    const fact = byCamera.get(row.camera_id);
    if (fact === undefined) continue; // a camera removed from config; not our business here
    fact.segments = Number(row.sealed_n ?? 0);
    fact.openSegments = Number(row.open_n ?? 0);
    fact.bytes = Number(row.total_bytes ?? 0);
    fact.lastSealedUtc =
      row.last_end === null || row.last_end === undefined
        ? null
        : new Date(Number(row.last_end)).toISOString();
  }

  // A second pass for the bitrates, sorted so the median is a lookup. Only
  // sealed rows with a MEASURED bitrate take part — a null here means the
  // probe failed, and a failed probe is not 0 kbps.
  const samples = index.db
    .prepare(
      `SELECT camera_id, bitrate_kbps
         FROM segments
        WHERE state = 'sealed' AND bitrate_kbps IS NOT NULL
        ORDER BY camera_id, bitrate_kbps`,
    )
    .all();

  const perCamera = new Map();
  for (const s of samples) {
    const list = perCamera.get(s.camera_id);
    if (list === undefined) perCamera.set(s.camera_id, [Number(s.bitrate_kbps)]);
    else list.push(Number(s.bitrate_kbps));
  }
  for (const [cameraId, sorted] of perCamera) {
    const fact = byCamera.get(cameraId);
    if (fact === undefined) continue;
    fact.measuredKbps = median(sorted);
  }

  return byCamera;
}

/** Median of an already-sorted, non-empty array of numbers. */
function median(sorted) {
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Sealed, evictable footage grouped by camera and drive, for contracts/
 * footageHeld.ts. One row per (camera, root) the index has ever written.
 *
 * Held and pending-upload segments are left out on purpose: eviction cannot
 * touch either one, so they are not rolling footage that footageHeld() can
 * reason about — a held clip does not free up when the ring needs room, and
 * a pending upload is leaving the drive regardless of what retention says.
 * Their bytes are still real, though, so they must still be counted against
 * the drive; they land in siteHealth's per-store `otherBytes` instead of here.
 *
 * A camera that was removed from config.json still has rows: its footage is
 * still sitting on the drive and still needs to be reported (build rule 16:
 * say what is there), even though nobody asks how long IT keeps footage.
 *
 * `index` is an openIndex() handle; only its `db` is used, read-only.
 */
export function footageFacts(index, nowMs) {
  const windowStartMs = nowMs - PROJECTION_WINDOW_MS;
  const rows = index.db
    .prepare(
      `SELECT camera_id,
              root,
              COUNT(*) AS segments,
              COALESCE(SUM(bytes), 0) AS bytes,
              MIN(start_ms) AS oldest_ms,
              -- A segment whose length was never measured (a recovered
              -- orphan, or one ffprobe could not read) has no end_ms. Its
              -- start is still a floor for "newest"; without the COALESCE a
              -- group of only such segments reads as newest = 0 and can pick
              -- the wrong drive as the one the camera records to now.
              MAX(COALESCE(end_ms, start_ms)) AS newest_ms,
              COALESCE(SUM(end_ms - start_ms), 0) AS recorded_ms,
              -- The rate is bytes over time, so a segment counts in both or in
              -- neither: its bytes without its duration would inflate it.
              COALESCE(SUM(CASE WHEN start_ms >= ? AND end_ms IS NOT NULL THEN bytes END), 0) AS window_bytes,
              COALESCE(SUM(CASE WHEN start_ms >= ? AND end_ms IS NOT NULL THEN end_ms - start_ms END), 0) AS window_recorded_ms
         FROM segments
        WHERE state = 'sealed' AND COALESCE(hold, 0) = 0 AND COALESCE(pending_upload, 0) = 0
        GROUP BY camera_id, root`,
    )
    .all(windowStartMs, windowStartMs);

  return rows.map((r) => ({
    cameraId: r.camera_id,
    root: r.root ?? null,
    segments: Number(r.segments),
    bytes: Number(r.bytes),
    oldestMs: Number(r.oldest_ms),
    newestMs: Number(r.newest_ms),
    recordedMs: Number(r.recorded_ms),
    windowBytes: Number(r.window_bytes),
    windowRecordedMs: Number(r.window_recorded_ms),
  }));
}

/**
 * What one store root really is. Never throws: a root that cannot be examined
 * is reported as unmounted and unmeasured, which is the truth, rather than
 * taking the health endpoint down with it.
 */
export async function storeFact(root) {
  const unknown = { root, mounted: false, totalBytes: null, freeBytes: null };
  let self;
  try {
    self = await stat(root);
  } catch {
    return unknown; // missing entirely
  }
  if (!self.isDirectory()) return unknown;

  // The mount test: a mount point sits on a different device from its parent.
  // A root whose disk failed to mount is an ordinary directory on the root
  // filesystem, and shares its parent's device.
  let mounted = false;
  try {
    const parent = await stat(dirname(root));
    mounted = self.dev !== parent.dev;
  } catch {
    mounted = false;
  }

  let totalBytes = null;
  let freeBytes = null;
  try {
    const fs = await statfs(root);
    const blockSize = Number(fs.bsize);
    totalBytes = Number(fs.blocks) * blockSize;
    // bavail, not bfree: the reserved blocks are not ours to record into, and
    // counting them inflates retention by roughly 5% on ext4.
    freeBytes = Number(fs.bavail) * blockSize;
  } catch {
    /* leave both null — unmeasured, not zero */
  }

  return { root, mounted, totalBytes, freeBytes };
}

/**
 * Whether the recorder is alive, from the health.json it rewrites every 30s.
 * The API server is a different process and cannot see the recorder directly,
 * so liveness is "it wrote recently", not "a file exists" — a stale file from
 * a recorder that died on Tuesday must not read as running.
 *
 * Returns true, false, or null when the file cannot be read or understood at
 * all. Null is not false: "I could not tell" and "it is stopped" are different
 * things to put in front of an installer.
 */
export async function recorderRunning(healthFile, nowMs, staleAfterMs = RECORDER_STALE_AFTER_MS) {
  let text;
  try {
    text = await readFile(healthFile, 'utf8');
  } catch (err) {
    // Never written at all is a real answer: the recorder has not run.
    return err.code === 'ENOENT' ? false : null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const atUtc = parsed?.atUtc;
  if (typeof atUtc !== 'string') return null;
  const atMs = Date.parse(atUtc);
  if (!Number.isFinite(atMs)) return null;
  return nowMs - atMs <= staleAfterMs;
}

/**
 * The Recording page's keep-for limit (recording.json), in milliseconds, or
 * null when there is none. `stateDir` is the directory recording.json lives
 * in, the same directory runAgeEviction (recorder-service.mjs) reads it from.
 *
 * ENOENT (never set) and a broken file (unreadable, not JSON, invalid) both
 * come back from readRecordingFile() with maxDays: null — runAgeEviction
 * applies no age limit in either case, so this must not show one either: a
 * limit the recorder is not enforcing must not appear as the reason footage
 * is kept.
 */
export async function keepForLimitMs(stateDir) {
  let text;
  try {
    text = await readFile(join(stateDir, RECORDING_FILE), 'utf8');
  } catch (err) {
    text = err.code === 'ENOENT' ? null : undefined;
  }
  const { settings } = readRecordingFile(text);
  return typeof settings.maxDays === 'number' ? settings.maxDays * DAY_MS : null;
}

/**
 * Everything siteHealth() needs, measured. `resolveOne(cam)` is passed in
 * rather than imported so this file never has to hold a credential resolver;
 * it returns resolveCameraUrl's { kind, reason? }.
 */
export async function gatherHealthFacts({ config, index, healthFile, now, resolveOne }) {
  const at = now();
  const cameraIds = config.cameras.map((c) => c.cameraId);
  const facts = cameraFacts(index, cameraIds);

  const cameras = config.cameras.map((cam) => {
    const measured = facts.get(cam.cameraId);
    const view = cameraView(cam, resolveOne(cam), measured?.measuredKbps ?? null);
    return {
      cameraId: cam.cameraId,
      resolved: view.resolved,
      unresolvedReason: view.unresolvedReason,
      measuredKbps: measured?.measuredKbps ?? null,
      segments: measured?.segments ?? 0,
      bytes: measured?.bytes ?? 0,
      lastSealedUtc: measured?.lastSealedUtc ?? null,
      openSegments: measured?.openSegments ?? 0,
    };
  });

  const stores = await Promise.all(config.storeRoots.map((root) => storeFact(root)));

  return {
    siteId: config.siteId,
    atUtc: at.toISOString(),
    cameras,
    stores,
    recorderRunning: await recorderRunning(healthFile, at.getTime()),
    footage: footageFacts(index, at.getTime()),
    ringFill: RING_FILL,
    // health.json lives in the state dir, and so does recording.json.
    maxAgeMs: await keepForLimitMs(dirname(healthFile)),
  };
}
