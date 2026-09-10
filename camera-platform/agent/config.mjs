/**
 * Layout for the reference build: Intel N100 6-bay board, 16 GB DDR5,
 * 128 GB NVMe for the OS, 2× Seagate SkyHawk 8 TB for recording.
 *
 * The separation below is not tidiness — it is the difference between the disks
 * doing one job each and fighting each other.
 */
import path from "node:path";

export const REFERENCE_BUILD = {
  cpu: "Intel N100",
  cameras: 16,
  recordingDrives: 2,
  driveModel: "Seagate SkyHawk 8TB",
};

/**
 * THE INDEX LIVES ON THE NVMe, NEVER ON A RECORDING DRIVE.
 *
 * It takes thousands of small transactional writes an hour. A spinning disk
 * serving those while also absorbing 5 MB/s of sequential video has to seek
 * between the two, which costs both — the index gets slow and the video stream
 * fragments. On the NVMe the index is free and the platters stay sequential.
 *
 * This was wrong in the first cut: the index was created inside the store root,
 * which is exactly on the drive it must avoid.
 */
export const DEFAULT_PATHS = {
  /** OS NVMe. Index, config, logs. */
  stateDir: "/var/lib/camplat",
  /** Recording drives, one per spindle. Cameras are assigned whole to a drive. */
  storeRoots: ["/srv/camplat/disk0", "/srv/camplat/disk1"],
};

export function indexPathFor(stateDir = DEFAULT_PATHS.stateDir) {
  return path.join(stateDir, "index.db");
}

/**
 * Assign cameras to drives, whole.
 *
 * Striping would mean one drive failure loses every camera's history. Assigned,
 * it loses the cameras on that spindle and leaves the rest completely intact —
 * an investigation with half the cameras is still an investigation.
 *
 * Contiguous blocks rather than round-robin, so physically adjacent cameras tend
 * to share a drive and a failure takes out one area rather than every other
 * camera across the site.
 */
export function assignCamerasToDrives(cameraIds, driveCount) {
  if (driveCount < 1) throw new RangeError(`driveCount must be >= 1, got ${driveCount}`);
  const perDrive = Math.ceil(cameraIds.length / driveCount);
  const assignment = new Map();
  for (const [i, cameraId] of cameraIds.entries()) {
    assignment.set(cameraId, Math.min(Math.floor(i / perDrive), driveCount - 1));
  }
  return assignment;
}

/**
 * Mount options for XFS on a surveillance ring buffer.
 *
 * `allocsize=64m` — the killer for this workload. Without it XFS allocates in
 * small extents as each of 8 concurrent ffmpeg writers dribbles data in, and the
 * files interleave into thousands of fragments across the platter. Months later
 * playback seeks constantly. A large speculative allocation keeps each segment
 * close to contiguous.
 *
 * `noatime` — every read would otherwise write. Pointless here.
 * `logbsize=256k` — fewer, larger journal writes.
 */
export const XFS_MOUNT_OPTIONS = "defaults,noatime,nodiratime,allocsize=64m,logbsize=256k";

/** Node heap cap. The rest of RAM is far more useful as page cache absorbing
 *  write bursts than as headroom a recorder will never use. */
export const NODE_MAX_OLD_SPACE_MB = 512;
