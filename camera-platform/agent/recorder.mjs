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
import { ensureCameraDirs, sealSegment, hasVideoBoxes, quarantineFile, INPROGRESS } from "./segstore.mjs";
import { wipPattern, wipCompare, wipStartMs } from "./wipNames.mjs";
import { measureSealedSegment } from "./media.mjs";
import { redactRtspUrl } from "../dist/rtsp.js";

/**
 * How long ffmpeg waits on a camera's socket before giving up, in
 * MICROSECONDS -- ffmpeg's unit for the RTSP `-timeout` option.
 *
 * Without it, a connection that dies without a reset (the box sleeping and
 * waking, a camera rebooting, a cable pulled and replugged) leaves ffmpeg
 * blocked on a read forever: it never exits, so nothing restarts it and no gap
 * is recorded -- recording stops and the log says nothing. With it, the read
 * fails, ffmpeg exits, and the recorder logs the gap and reconnects.
 * 10 s is far longer than any live camera goes quiet, and far shorter than a
 * 60 s segment. Proven on ffmpeg 6.1.1 and 9.0.1 (FIELD-NOTES, 2026-09-18).
 *
 * Needs ffmpeg 5.0 or later. Before 5.0, `-timeout` on an RTSP input was the
 * LISTEN timeout for acting as a server -- a different thing -- and the socket
 * timeout was `-stimeout`. Debian 12 ships 5.1 and Ubuntu 24.04 ships 6.1.
 */
export const RTSP_TIMEOUT_US = 10_000_000;

/**
 * ffmpeg exit codes that mean the camera could not be reached: 256 minus the
 * errno. 143 EHOSTUNREACH, 145 ECONNREFUSED, 146 ETIMEDOUT (measured on the
 * bench laptop, FIELD-NOTES 2026-09-18); 144 EHOSTDOWN, 152 ECONNRESET,
 * 155 ENETUNREACH (from the errno table). The camera is down, not its audio.
 */
export const NETWORK_EXIT_CODES = new Set([143, 144, 145, 146, 152, 155]);

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
    "-timeout", String(RTSP_TIMEOUT_US),
    "-i", url,
    "-an",
    ...scale,
    "-r", String(fps),
    "-f", "rawvideo", "-pix_fmt", "nv12", "-",
  ];
}

export function ffmpegArgs(url, outputPattern, segmentSeconds = 60, { audio = false } = {}) {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "warning",
    "-rtsp_transport", "tcp",          // UDP drops packets on a loaded network
    "-timeout", String(RTSP_TIMEOUT_US), // a silent camera fails in 10 s, never hangs forever
    "-i", url,
    // Video is never transcoded in either branch.
    ...(audio
      // audio on: converted to AAC because mp4 cannot hold G.711/G.726/G.722;
      // the trailing ? on the audio map lets a camera with no audio track still record
      ? ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "32k"]
      // audio off by default because of the legal gate; never transcode
      : ["-c", "copy", "-an"]),
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
  audio = false,
  restartDelayMs = 2000,
  audioProbeMs = 30_000,
  measureFn = measureSealedSegment, // injectable: the harness has no real video
}) {
  let child = null;
  let audioActive = audio;   // whether the next ffmpeg records audio
  let audioFailures = 0;     // consecutive quick failures with audio on
  let audioTrial = false;    // the current run is the video-only trial
  let launchedAt = 0;        // when the current run was spawned
  // Whether the current ffmpeg has gone, and a promise settled when it does.
  let childGone = true;
  let childDone = Promise.resolve();
  let timer = null;
  let stopped = false;
  let lastSeenOpen = null;
  let downSince = null;
  let audioDropped = false;  // audio was dropped and the next audio run is a retry
  let stuckRestart = false;  // the current run is being killed on purpose by restartStuck
  let downReason = "camera_offline";
  // One outage is one gap row: added on the first relaunch, stretched on each
  // retry, closed when video flows again (a new segment file) or the recorder
  // stops. Bench 2026-09-19: one row per retry made a one-minute unplug a
  // dozen gaps, with the seconds of each failed try covered by none of them.
  let outageGapId = null;
  // The file being written when the outage began. Its measured end, once it
  // is sealed, is where video really stopped: the outage is noticed only
  // when the socket times out, ~10 s later (bench 2026-09-19).
  let openAtDrop = null;

  function recordOutage(endMs) {
    const endUtc = new Date(Math.max(endMs, downSince)).toISOString();
    if (outageGapId === null) {
      outageGapId = index.addGap({ cameraId, startUtc: new Date(downSince).toISOString(), endUtc, reason: downReason });
      onEvent({ kind: "gap_recorded", cameraId, fromUtc: new Date(downSince).toISOString() });
    } else {
      index.extendGap(outageGapId, endUtc);
    }
  }

  function endOutage(endMs) {
    if (downSince === null) return;
    recordOutage(endMs);
    onEvent({ kind: "gap_closed", cameraId, fromUtc: new Date(downSince).toISOString(), toUtc: new Date(Math.max(endMs, downSince)).toISOString() });
    downSince = null;
    downReason = "camera_offline";
    outageGapId = null;
    openAtDrop = null;
  }

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
      // A restart's stub holds no video (FIELD-NOTES 2026-09-18, finding 4):
      // set it aside rather than index a clip that will not play.
      if (!(await hasVideoBoxes(path.join(wipDir, file)))) {
        try {
          await quarantineFile(root, `${cameraId}/${INPROGRESS}/${file}`);
          onEvent({ kind: "empty_segment", cameraId, file });
        } catch (err) {
          onEvent({ kind: "seal_failed", cameraId, file, error: `quarantine failed: ${err.message}` });
        }
        continue;
      }

      try {
        const result = await sealSegment(root, cameraId, file);
        const measured = await measureFn(path.join(root, result.path), result.bytes);
        let endUtc = null;
        let measuredBitrateKbps = bitrateKbps;
        if (measured.seconds !== null) {
          endUtc = new Date(result.startMs + Math.round(measured.seconds * 1000)).toISOString();
          measuredBitrateKbps = measured.bitrateKbps;
        } else {
          onEvent({ kind: "duration_unmeasured", cameraId, path: result.path });
        }
        // The dropped file's measured end is where the outage really began.
        // No measurement, no move: the gap keeps the time the drop was noticed.
        if (endUtc !== null && file === openAtDrop && outageGapId !== null) {
          index.pullGapStart(outageGapId, endUtc);
        }
        sealed.push({
          cameraId,
          startUtc: new Date(result.startMs).toISOString(),
          endUtc,
          path: result.path,
          bytes: result.bytes,
          state: "sealed",
          hold: false,
          pendingUpload: false,
          bitrateKbps: measuredBitrateKbps,
          root,
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
        root,
      });
      lastSeenOpen = open;
      onEvent({ kind: "opened", cameraId, path: open });
      // A new file means video flows again: the outage ends where it starts.
      endOutage(startMs);
    }
  }

  function launch() {
    if (stopped) return;
    const outputPattern = path.join(root, cameraId, INPROGRESS, wipPattern());
    child = spawnFn("ffmpeg", ffmpegArgs(url, outputPattern, segmentSeconds, { audio: audioActive }));
    const spawned = child;
    launchedAt = Date.now();
    // A video-only trial still running when the probe fires means the camera
    // records fine without audio: say so, and keep recording video only.
    if (audioTrial) {
      const probe = setTimeout(() => {
        if (!stopped && child === spawned && !childGone && audioTrial) {
          audioTrial = false;
          audioDropped = true;
          onEvent({ kind: "audio_dropped", cameraId, reason: "ffmpeg failed twice with audio on and records without it; recording video only, and trying audio again when the camera next reconnects" });
        }
      }, audioProbeMs);
      probe?.unref?.();
    }
    // Audio was dropped and this run is trying it again: still up after the
    // probe means audio works again, so say so.
    if (audioActive && audioDropped) {
      const restoreProbe = setTimeout(() => {
        if (!stopped && child === spawned && !childGone && audioActive && audioDropped) {
          audioDropped = false;
          onEvent({ kind: "audio_restored", cameraId });
        }
      }, audioProbeMs);
      restoreProbe?.unref?.();
    }
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

    // Still down: the outage's gap runs at least to this try. It is closed
    // only when this run actually writes video (sealCompleted).
    if (downSince !== null) recordOutage(Date.now());

    child?.stderr?.on("data", (d) => onEvent({ kind: "stderr", cameraId, text: redactRtspUrl(String(d)) }));

    let handled = false;
    const wentDown = (event) => {
      if (stopped || handled) return;
      handled = true;
      onEvent(event);
      if (stuckRestart) {
        // Killed on purpose: says nothing about the camera or its audio. downSince
        // and downReason were set by restartStuck.
        stuckRestart = false;
      } else {
        // The first failure starts the outage; later retries continue it.
        if (downSince === null) {
          downSince = Date.now();
          downReason = "camera_offline";
          openAtDrop = lastSeenOpen;
        }
        const ranMs = Date.now() - launchedAt;
        const unreachable = event.kind === "exited" && NETWORK_EXIT_CODES.has(event.code);
        if (audioTrial) {
          // The video-only trial died fast too: the camera is down, not its
          // audio. Put audio back on and start counting afresh.
          audioTrial = false;
          audioActive = true;
          audioFailures = 0;
        } else if (!audioActive && audio) {
          // Audio was dropped and this video-only run has ended: the camera is
          // reconnecting, so try audio again. A camera whose audio still breaks
          // ffmpeg fails twice and drops it again.
          audioActive = true;
          audioFailures = 0;
        } else if (audioActive && !unreachable) {
          if (ranMs < audioProbeMs) {
            audioFailures += 1;
            if (audioFailures >= 2) {
              audioActive = false;
              audioTrial = true;
              audioFailures = 0;
            }
          } else {
            audioFailures = 0;
          }
        }
      }
      // A camera that drops comes back. Restart, and the gap is recorded above
      // when it does — a reboot loop should still leave an honest timeline.
      setTimeout(launch, restartDelayMs);
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
      // Still down at stop: the gap runs to now. Recovery covers the time
      // the service itself is off.
      endOutage(Date.now());
    },
    // A run that is up but writing nothing (the alert says the camera is not
    // recording). Kill it and let the normal restart relaunch it. The gap runs
    // from the later of the last sealed segment and this run's start: before
    // that, the timeline already says what happened. Reason "unknown": nothing
    // here knows why the stream stalled.
    async restartStuck({ sinceUtc = null } = {}) {
      if (stopped || !child || childGone) return false;
      const sinceMs = typeof sinceUtc === "string" ? Date.parse(sinceUtc) : NaN;
      const fromMs = Number.isFinite(sinceMs) ? Math.max(sinceMs, launchedAt) : launchedAt;
      stuckRestart = true;
      // An outage already open (the alert fired while the camera was down)
      // keeps its own start and reason.
      if (downSince === null) {
        downSince = fromMs;
        downReason = "unknown";
      }
      onEvent({ kind: "restarted_stuck", cameraId, sinceUtc: new Date(fromMs).toISOString() });
      const running = child;
      try { running.kill?.("SIGTERM"); } catch { /* already gone */ }
      let killTimer;
      const timedOut = await Promise.race([
        childDone.then(() => false),
        new Promise((resolve) => { killTimer = setTimeout(() => resolve(true), stopTimeoutMs); }),
      ]);
      clearTimeout(killTimer);
      if (timedOut && child === running) {
        try { running.kill?.("SIGKILL"); } catch { /* already gone */ }
        onEvent({ kind: "stop_killed", cameraId, waitedMs: stopTimeoutMs });
      }
      return true;
    },
  };
}
