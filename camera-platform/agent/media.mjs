/**
 * ffprobe and ffmpeg. All spawning lives here; all interpretation lives in
 * ../contracts/ffprobe.ts, so the parsing is tested without ffmpeg installed.
 */
import { spawn } from "node:child_process";
import { stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFfprobeJson, bitrateFromCapture } from "../dist/ffprobe.js";
import { redactRtspUrl } from "../dist/rtsp.js";

function run(command, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function toolVersion(tool) {
  const { code, stdout } = await run(tool, ["-version"], { timeoutMs: 10_000 });
  if (code !== 0) return null;
  return stdout.split("\n")[0]?.trim() ?? null;
}

/**
 * Probe an RTSP URL for codec, resolution, fps and — if the source reports it —
 * bitrate. TCP transport is forced: RTSP over UDP drops packets on a loaded
 * network and under-reports everything downstream of it.
 */
export async function probeStream(url, { timeoutMs = 20_000 } = {}) {
  const { code, stdout, stderr } = await run("ffprobe", [
    "-v", "error",
    "-rtsp_transport", "tcp",
    "-print_format", "json",
    "-show_streams", "-show_format",
    url,
  ], { timeoutMs });

  if (code !== 0) {
    return { kind: "unusable", reason: `ffprobe exited ${code}: ${redactRtspUrl(stderr.trim()).slice(0, 300)}` };
  }
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { kind: "unusable", reason: "ffprobe output was not JSON" };
  }
  return parseFfprobeJson(json);
}

/**
 * Measure real bitrate by capturing for a fixed interval and weighing the file.
 *
 * WHY this exists: ffprobe usually reports no bit_rate for RTSP, and a camera's
 * *configured* bitrate is a setting rather than a measurement. On a smart-codec
 * camera watching an empty corridor the two differ by several times, and it is
 * the measurement that sizes the disk.
 */
export async function measureBitrate(url, { seconds = 30 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "camplat-"));
  const out = path.join(dir, "sample.mp4");
  try {
    const { code, stderr } = await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", url,
      "-t", String(seconds),
      "-c", "copy",
      "-y", out,
    ], { timeoutMs: (seconds + 30) * 1000 });

    let bytes = 0;
    try { bytes = (await stat(out)).size; } catch { bytes = 0; }

    if (bytes === 0) {
      return { kind: "refused", reason: `capture wrote nothing (ffmpeg exited ${code}): ${redactRtspUrl(stderr.trim()).slice(0, 300)}` };
    }
    return { ...bitrateFromCapture(bytes, seconds), bytes, seconds };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
