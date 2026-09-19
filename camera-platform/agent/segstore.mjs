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
import { readdir, stat, rename, unlink, mkdir, rm, open } from "node:fs/promises";
import path from "node:path";
import { wipStartMs } from "./wipNames.mjs";

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
            // The start time is read from the name here, where its format is
            // known (wipNames.mjs); NaN when it cannot be, and recovery then
            // quarantines the file rather than guessing a time.
            inProgress.push({ path: `${cameraId}/${INPROGRESS}/${wip}`, bytes: info.size, cameraId, wipStartMs: wipStartMs(wip) });
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
 * In-progress names carry their start time — ffmpeg's `%s` epoch seconds on the
 * Linux appliance, the bench format on Windows (see wipNames.mjs). The index
 * keys on milliseconds, so the rename is also the unit conversion. Doing it
 * here, once, is why nothing downstream has to remember which unit a filename
 * carries.
 */
export async function sealSegment(root, cameraId, wipFilename) {
  const startMs = wipStartMs(path.basename(wipFilename, ".mp4"));
  if (!Number.isSafeInteger(startMs) || startMs <= 0) {
    throw new Error(`in-progress filename is not a start time: ${wipFilename}`);
  }
  const from = path.join(root, cameraId, INPROGRESS, wipFilename);
  const relative = segmentPathFor(cameraId, startMs);
  const to = path.join(root, relative);

  const taken = await stat(to).then(() => true, (err) => { if (err.code === "ENOENT") return false; throw err; });
  if (taken) {
    const name = `${cameraId}_${Date.now()}_${wipFilename}`;
    await mkdir(path.join(root, QUARANTINE), { recursive: true });
    await rename(from, path.join(root, QUARANTINE, name));
    const err = new Error(`a sealed segment already exists at ${relative}; the new recording was set aside as ${QUARANTINE}/${name}`);
    err.code = "SEAL_COLLISION";
    throw err;
  }
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
  const empty = [];
  const sealedPartials = [];
  const failed = [];

  for (const action of plan.actions) {
    switch (action.kind) {
      case "drop_empty":
        await unlink(path.join(root, action.file.path)).catch(() => {});
        dropped.push(action.file.path);
        break;
      case "quarantine": {
        try {
          const target = await quarantineFile(root, action.file.path);
          quarantined.push({ path: action.file.path, reason: action.reason, movedTo: target });
        } catch (err) {
          failed.push({ path: action.file.path, reason: action.reason, error: String(err?.message ?? err) });
        }
        break;
      }
      case "adopt_orphan":
      case "seal_partial": {
        // A restart's stub holds no video: set it aside instead of indexing a
        // clip that will not play. It never becomes a partial or an orphan.
        const rel = action.kind === "adopt_orphan" ? action.file.path : action.segment.path;
        if (!(await hasVideoBoxes(path.join(root, rel)))) {
          try {
            const target = await quarantineFile(root, rel);
            empty.push({ path: rel, kind: action.kind, reason: "holds no video (a restart's stub)", movedTo: target });
          } catch (err) {
            failed.push({ path: rel, reason: "holds no video", error: String(err?.message ?? err) });
          }
          break;
        }
        if (action.kind === "adopt_orphan") {
          adopted.push({ path: action.file.path, cameraId: action.cameraId, startUtc: action.startUtc, bytes: action.file.bytes, inProgress: action.inProgress });
        } else {
          sealedPartials.push({ segment: action.segment, actualBytes: action.actualBytes, estimatedEndUtc: action.estimatedEndUtc });
        }
        break;
      }
      default:
        break;   // confirm / correct_size / lost are index-only
    }
  }

  return { adopted, dropped, quarantined, sealedPartials, empty, failed };
}

export async function ensureCameraDirs(root, cameraId) {
  await mkdir(path.join(root, cameraId, INPROGRESS), { recursive: true });
}

/** Returns { files, bytes } measuring quarantine usage. */
export async function quarantineUsage(root) {
  const dir = path.join(root, QUARANTINE);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return { files: 0, bytes: 0 };
    throw err;
  }
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.isFile()) {
      files += 1;
      const statInfo = await stat(path.join(dir, entry.name));
      bytes += statInfo.size;
    }
  }
  return { files, bytes };
}

/**
 * Whether a segment file holds any media, decided by its box structure and
 * never by its size (FIELD-NOTES 2026-09-18, finding 4: a restart leaves a
 * 28-byte `ftyp` stub per camera, and another ffmpeg writes other sizes).
 *
 * Empty (false): shorter than one box header, or an MP4 that starts with
 * `ftyp` and has no `moov`, `moof` or `mdat` box. Anything else is kept
 * (true): a file that does not start with `ftyp` is not ours to call empty,
 * a malformed box size is not evidence of emptiness, and an unreadable file
 * is left for someone to look at.
 */
export async function hasVideoBoxes(absolutePath) {
  let fd;
  try {
    fd = await open(absolutePath, "r");
    const { size } = await fd.stat();
    if (size < 8) return false;
    const head = Buffer.alloc(16);
    let offset = 0;
    let first = true;
    while (offset + 8 <= size) {
      const { bytesRead } = await fd.read(head, 0, 16, offset);
      if (bytesRead < 8) break;
      const size32 = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (first && type !== "ftyp") return true;
      first = false;
      if (type === "moov" || type === "moof" || type === "mdat") return true;
      let boxSize;
      if (size32 === 1) {
        if (bytesRead < 16) break;
        boxSize = Number(head.readBigUInt64BE(8));
      } else if (size32 === 0) {
        boxSize = size - offset;
      } else {
        boxSize = size32;
      }
      if (boxSize < 8) return true;
      offset += boxSize;
    }
    return false;
  } catch {
    return true;
  } finally {
    await fd?.close().catch(() => {});
  }
}

/**
 * Move `relPath` (relative to `root`) into the root's quarantine, never
 * reusing a name: the same path can be quarantined again later, and rename
 * would replace what was set aside before. Returns where it went.
 */
export async function quarantineFile(root, relPath) {
  const flat = relPath.replace(/[\\/]/g, "_");
  let target = path.join(root, QUARANTINE, `${Date.now()}_${flat}`);
  for (let n = 1; await stat(target).then(() => true, () => false); n++) {
    target = path.join(root, QUARANTINE, `${Date.now()}_${n}_${flat}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await rename(path.join(root, relPath), target);
  return target;
}

export async function removeStore(root) {
  await rm(root, { recursive: true, force: true });
}
