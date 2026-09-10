/**
 * The segment store on disk: scanning, sealing, eviction and recovery.
 *
 * Layout:
 *   <root>/<cameraId>/<epochMs>.mp4              sealed segments
 *   <root>/<cameraId>/.inprogress/<epochSec>.mp4 the segment being written now
 *   <root>/.quarantine/                          files we did not understand
 *
 * WHY `.inprogress/` is a directory rather than a flag in the index: after a
 * power cut the index may itself be stale, and a partial file that is only
 * identifiable by consulting the index is a partial you can lose. Here the
 * filesystem states it structurally — anything under `.inprogress/` was being
 * written when the process stopped, whatever the index believes.
 */
import { readdir, stat, rename, unlink, mkdir, rm } from "node:fs/promises";
import path from "node:path";

export const INPROGRESS = ".inprogress";
export const QUARANTINE = ".quarantine";

export function segmentPathFor(cameraId, startMs) {
  return `${cameraId}/${startMs}.mp4`;
}

/**
 * Walk the store. Returns paths RELATIVE to root so they match the index and
 * the recovery contract, which must not care where the store is mounted.
 */
export async function scanDisk(root) {
  const sealed = [];
  const inProgress = [];

  let cameraDirs;
  try {
    cameraDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return { sealed, inProgress };
  }

  for (const dir of cameraDirs) {
    if (!dir.isDirectory() || dir.name === QUARANTINE) continue;
    const cameraId = dir.name;
    const cameraPath = path.join(root, cameraId);

    let entries;
    try {
      entries = await readdir(cameraPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== INPROGRESS) continue;
        const wipPath = path.join(cameraPath, INPROGRESS);
        for (const wip of await readdir(wipPath).catch(() => [])) {
          const full = path.join(wipPath, wip);
          const info = await stat(full).catch(() => null);
          if (info?.isFile()) {
            inProgress.push({ path: `${cameraId}/${INPROGRESS}/${wip}`, bytes: info.size, cameraId });
          }
        }
        continue;
      }
      const info = await stat(path.join(cameraPath, entry.name)).catch(() => null);
      if (info?.isFile()) sealed.push({ path: `${cameraId}/${entry.name}`, bytes: info.size });
    }
  }

  sealed.sort((a, b) => a.path.localeCompare(b.path));
  inProgress.sort((a, b) => a.path.localeCompare(b.path));
  return { sealed, inProgress };
}

/**
 * Move a completed in-progress file to its sealed name.
 *
 * ffmpeg's segment muxer names by epoch SECONDS (`%s`); the index keys on
 * milliseconds, so the rename is also the unit conversion. Doing it here, once,
 * is why nothing downstream has to remember which unit a filename carries.
 */
export async function sealSegment(root, cameraId, wipFilename) {
  const epochSeconds = Number(path.basename(wipFilename, ".mp4"));
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) {
    throw new Error(`in-progress filename is not epoch seconds: ${wipFilename}`);
  }
  const startMs = epochSeconds * 1000;
  const from = path.join(root, cameraId, INPROGRESS, wipFilename);
  const relative = segmentPathFor(cameraId, startMs);
  const to = path.join(root, relative);

  await rename(from, to);
  const info = await stat(to);
  return { path: relative, bytes: info.size, startMs };
}

/** Delete the files an eviction plan chose. Reports what was actually freed —
 *  a file already gone is not an error, but it is not freed space either. */
export async function applyEviction(root, plan) {
  const deleted = [];
  let bytesFreed = 0;
  for (const candidate of plan.evict) {
    try {
      await unlink(path.join(root, candidate.segment.path));
      deleted.push(candidate.segment.path);
      bytesFreed += candidate.bytes;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      deleted.push(candidate.segment.path);   // index must still drop it
    }
  }
  return { deleted, bytesFreed };
}

/**
 * Carry out a recovery plan. Returns what changed so the index can be updated
 * in one transaction afterwards.
 *
 * Nothing unrecognised is deleted — quarantine moves it aside for a human.
 */
export async function applyRecovery(root, plan) {
  const adopted = [];
  const dropped = [];
  const quarantined = [];
  const sealedPartials = [];

  for (const action of plan.actions) {
    switch (action.kind) {
      case "drop_empty":
        await unlink(path.join(root, action.file.path)).catch(() => {});
        dropped.push(action.file.path);
        break;
      case "quarantine": {
        const target = path.join(root, QUARANTINE, action.file.path.replace(/\//g, "_"));
        await mkdir(path.dirname(target), { recursive: true });
        await rename(path.join(root, action.file.path), target).catch(() => {});
        quarantined.push({ path: action.file.path, reason: action.reason, movedTo: target });
        break;
      }
      case "adopt_orphan":
        adopted.push({ path: action.file.path, cameraId: action.cameraId, startUtc: action.startUtc, bytes: action.file.bytes });
        break;
      case "seal_partial":
        sealedPartials.push({ segment: action.segment, actualBytes: action.actualBytes, estimatedEndUtc: action.estimatedEndUtc });
        break;
      default:
        break;   // confirm / correct_size / lost are index-only
    }
  }

  return { adopted, dropped, quarantined, sealedPartials };
}

export async function ensureCameraDirs(root, cameraId) {
  await mkdir(path.join(root, cameraId, INPROGRESS), { recursive: true });
}

export async function removeStore(root) {
  await rm(root, { recursive: true, force: true });
}
