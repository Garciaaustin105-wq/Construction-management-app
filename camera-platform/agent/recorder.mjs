/**
 * Per-camera recording supervision.
 *
 * ffmpeg does the muxing; this owns the lifecycle — spawn, watch for completed
 * segments, seal them into the index, restart on exit, and record a gap for the
 * time the camera was down.
 *
 * Two ffmpeg choices here are load-bearing:
 *
 *   `-c copy`  — never transcode. Stream-copy is the difference between 16
 *   cameras on a mini PC and four. The only decoding we do anywhere is the
 *   substream, for detection.
 *
 *   `-movflags +frag_keyframe+empty_moov` — write FRAGMENTED mp4. A plain MP4
 *   keeps its index (`moov`) at the end of the file, so one truncated by a power
 *   cut is unplayable in its entirety. A fragmented one stays playable up to the
 *   last complete fragment. This single flag is the difference between losing
 *   the last minute and losing the last minute *plus* everything before it in
 *   that segment.
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ensureCameraDirs, sealSegment, INPROGRESS } from "./segstore.mjs";
import { wipPattern, wipCompare, wipStartMs } from "./wipNames.mjs";
import { redactRtspUrl } from "../dist/rtsp.js";

/**
 * Args for the DETECTION substream — decoded, unlike the recording path.
 *
 * `-hwaccel vaapi` matters specifically on the N100. Decoding 8–12 substreams in
 * software costs most of a core on a 4-core 6W part; on the iGPU it is close to
 * free, and those cores stay available to the 16 recording processes. The N100's
 * UHD graphics handles H.264 and H.265 including 10-bit.
 *
 * Falls back to software decode when there is no render node — a missing
 * /dev/dri is a degraded box, not a broken one.
 */
export function detectionArgs(url, { fps = 5, width = 640, height = 360, hwaccel = true } = {}) {
  const accel = hwaccel
    ? ["-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128", "-hwaccel_output_format", "vaapi"]
    : [];
  const scale = hwaccel
    ? ["-vf", `scale_vaapi=w=${width}:h=${height},hwdownload,format=nv12`]
    : ["-vf", `scale=${width}:${height}`];
  return [
    "-nostdin", "-hide_banner", "-loglevel", "warning",
    ...accel,
    "-rtsp_transport", "tcp",
    "-i", url,
    "-an",
    ...scale,
    "-r", String(fps),
    "-f", "rawvideo", "-pix_fmt", "nv12", "-",
  ];
}

export function ffmpegArgs(url, outputPattern, segmentSeconds = 60) {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "warning",
    "-rtsp_transport", "tcp",          // UDP drops packets on a loaded network
    "-i", url,
    "-c", "copy",                      // never transcode
    "-an",                             // audio off by default — see the legal gate
    "-f", "segment",
    "-segment_time", String(segmentSeconds),
    "-segment_atclocktime", "1",       // align to wall clock, so timelines line up
    "-segment_format", "mp4",
    "-segment_format_options", "movflags=+frag_keyframe+empty_moov+default_base_moof",
    "-reset_timestamps", "1",
    "-strftime", "1",
    // Spinning disks hate small scattered writes, and eight ffmpeg processes
    // per spindle each dribbling packets is exactly that. Buffering into larger
    // writes keeps the platter doing sequential work.
    "-flush_packets", "0",
    "-max_muxing_queue_size", "1024",
    outputPattern,                     // .../<cameraId>/.inprogress/<wip pattern>
  ];
}

const defaultSpawn = (cmd, args) => spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });

/**
 * Supervise one camera.
 *
 * `spawnFn` is injectable so the whole seal/index/evict/recover loop can be
 * exercised against a fake segment producer, with no ffmpeg and no camera.
 */
export function createCameraRecorder({
  root,
  cameraId,
  url,
  index,
  segmentSeconds = 60,
  pollMs = 1000,
  bitrateKbps = null,
  spawnFn = defaultSpawn,
  onEvent = () => {},
  stopTimeoutMs = 10_000,
}) {
  let child = null;
  // Whether the current ffmpeg has gone, and a promise settled when it does.
  let childGone = true;
  let childDone = Promise.resolve();
  let timer = null;
  let stopped = false;
  let lastSeenOpen = null;
  let downSince = null;

  async function sealCompleted() {
    const wipDir = path.join(root, cameraId, INPROGRESS);
    let files;
    try {
      files = (await readdir(wipDir)).filter((f) => f.endsWith(".mp4"));
    } catch {
      return;
    }
    if (files.length === 0) return;

    // Names carry their start time (%s epoch seconds on the appliance; the
    // bench format on Windows — see wipNames.mjs), so sort by parsed time.
    files.sort((a, b) => wipCompare(path.basename(a, ".mp4"), path.basename(b, ".mp4")));

    // The newest file is still being written. Everything before it is complete.
    const open = files[files.length - 1];
    const complete = files.slice(0, -1);

    const sealed = [];
    for (const file of complete) {
      try {
        const result = await sealSegment(root, cameraId, file);
        sealed.push({
          cameraId,
          startUtc: new Date(result.startMs).toISOString(),
          endUtc: new Date(result.startMs + segmentSeconds * 1000).toISOString(),
          path: result.path,
          bytes: result.bytes,
          state: "sealed",
          hold: false,
          pendingUpload: false,
          bitrateKbps,
        });
      } catch (err) {
        onEvent({ kind: "seal_failed", cameraId, file, error: err.message });
      }
    }
    if (sealed.length > 0) {
      index.putMany(sealed);
      onEvent({ kind: "sealed", cameraId, count: sealed.length, segments: sealed });
    }

    // Record the open one so a crash leaves the index knowing it existed.
    if (open !== lastSeenOpen) {
      const startMs = wipStartMs(path.basename(open, ".mp4"));
      index.put({
        cameraId,
        startUtc: new Date(startMs).toISOString(),
        endUtc: null,
        path: `${cameraId}/${INPROGRESS}/${open}`,
        bytes: null,          // unknown while being written — NOT zero
        state: "open",
        hold: false,
        pendingUpload: false,
        bitrateKbps,
      });
      lastSeenOpen = open;
      onEvent({ kind: "opened", cameraId, path: open });
    }
  }

  function launch() {
    if (stopped) return;
    const outputPattern = path.join(root, cameraId, INPROGRESS, wipPattern());
    child = spawnFn("ffmpeg", ffmpegArgs(url, outputPattern, segmentSeconds));
    const spawned = child;
    childGone = false;
    childDone = new Promise((resolve) => {
      spawned?.once?.("exit", () => {
        childGone = true;
        resolve();
      });
      spawned?.on?.("error", () => {
        if (spawned.pid === undefined) {
          childGone = true;
          resolve();
        }
      });
    });
    onEvent({ kind: "started", cameraId, url: redactRtspUrl(url) });

    if (downSince !== null) {
      index.addGap({
        cameraId,
        startUtc: new Date(downSince).toISOString(),
        endUtc: new Date().toISOString(),
        reason: "camera_offline",
      });
      onEvent({ kind: "gap_recorded", cameraId, fromUtc: new Date(downSince).toISOString() });
      downSince = null;
    }

    child?.stderr?.on("data", (d) => onEvent({ kind: "stderr", cameraId, text: redactRtspUrl(String(d)) }));

    let handled = false;
    const wentDown = (event) => {
      if (stopped || handled) return;
      handled = true;
      downSince = Date.now();
      onEvent(event);
      // A camera that drops comes back. Restart, and the gap is recorded above
      // when it does — a reboot loop should still leave an honest timeline.
      setTimeout(launch, 2000);
    };
    child?.on?.("error", (err) => wentDown({ kind: "spawn_failed", cameraId, error: redactRtspUrl(String(err?.message ?? err)) }));
    child?.once?.("exit", (code) => wentDown({ kind: "exited", cameraId, code }));
  }

  return {
    start() {
      stopped = false;
      return ensureCameraDirs(root, cameraId).then(() => {
        launch();
        timer = setInterval(() => { sealCompleted().catch(() => {}); }, pollMs);
      });
    },
    async poll() { await sealCompleted(); },
    // systemd waits TimeoutStopSec (30s) after SIGTERM; returning before ffmpeg
    // exits cuts the newest segment mid-write on every stop.
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (child && !childGone) {
        try { child.kill?.("SIGTERM"); } catch { /* already gone */ }
        let killTimer;
        const timedOut = await Promise.race([
          childDone.then(() => false),
          new Promise((resolve) => { killTimer = setTimeout(() => resolve(true), stopTimeoutMs); }),
        ]);
        clearTimeout(killTimer);
        if (timedOut) {
          try { child.kill?.("SIGKILL"); } catch { /* already gone */ }
          onEvent({ kind: "stop_killed", cameraId, waitedMs: stopTimeoutMs });
        }
      }
      await sealCompleted().catch(() => {});
    },
  };
}
