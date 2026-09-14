/** Real ffmpeg, no camera and no network. Every other suite fakes ffmpeg, so
 *  nothing proved the recorder's own output arguments work on the ffmpeg a box
 *  actually has. The failures feared: an option this build rejects, segments
 *  ffprobe cannot read, packets lost at a segment boundary, and filenames whose
 *  start time cannot be read back (Linux `%s` vs Windows, see wipNames.mjs).
 *
 *  Only the input changes: `-rtsp_transport` is RTSP-only, and a local file
 *  read at native rate (`-re`) stands in for the camera. Skips, loudly, when
 *  ffmpeg or ffprobe is missing. */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegArgs } from "../agent/recorder.mjs";
import { INPROGRESS } from "../agent/segstore.mjs";
import { wipPattern, wipStartMs } from "../agent/wipNames.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("real ffmpeg");

const have = (tool) => spawnSync(tool, ["-version"], { stdio: "ignore" }).status === 0;
if (!have("ffmpeg") || !have("ffprobe")) {
  console.log("  SKIPPED: ffmpeg or ffprobe is not on PATH — nothing was measured");
  process.exit(0);
}

const probe = (file, extra) => {
  const r = spawnSync("ffprobe", ["-v", "error", ...extra, "-of", "json", file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${path.basename(file)}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
};
const packetCount = (file) => Number(probe(file, ["-select_streams", "v:0", "-count_packets", "-show_entries", "stream=codec_name,nb_read_packets"]).streams[0].nb_read_packets);

const work = await mkdtemp(path.join(tmpdir(), "camplat-realffmpeg-"));
try {
  // A camera sends H.264 or H.265; the recorder copies it. Encode a short clip
  // with a keyframe every second so 2 s segments have somewhere to split.
  const src = path.join(work, "source.mp4");
  let codec = null;
  for (const [encoder, name] of [["libx264", "h264"], ["mpeg4", "mpeg4"]]) {
    const r = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
      "-t", "7", "-c:v", encoder, "-g", "10", "-pix_fmt", "yuv420p", "-y", src], { encoding: "utf8" });
    if (r.status === 0) { codec = name; break; }
  }
  if (codec === null) throw new Error("this ffmpeg could not encode a test clip with libx264 or mpeg4");
  console.log(`  source: 7 s ${codec} test pattern`);
  const sourcePackets = packetCount(src);

  const wipDir = path.join(work, "cam-1", INPROGRESS);
  await mkdir(wipDir, { recursive: true });
  const args = ffmpegArgs("rtsp://unused.invalid/stream", path.join(wipDir, wipPattern()), 2);
  const transport = args.indexOf("-rtsp_transport");
  args.splice(transport, 2);
  const input = args.indexOf("-i");
  args.splice(input, 2, "-re", "-i", src);

  const startedMs = Date.now();
  const run = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 60_000 });
  const endedMs = Date.now();
  const files = (await readdir(wipDir)).sort();

  await check("THE FEARED ONE: the recorder's own arguments run on this ffmpeg and write readable segments", () => {
    eq(run.status, 0, `ffmpeg exit (stderr: ${String(run.stderr).trim().slice(0, 300)})`);
    eq(files.length >= 3, true, `at least three segments from 7 s at 2 s each, got ${files.length}`);
    for (const f of files) {
      const s = probe(path.join(wipDir, f), ["-select_streams", "v:0", "-show_entries", "stream=codec_name"]).streams[0];
      eq(s.codec_name, codec, `${f} codec`);
    }
  });

  await check("THE FEARED ONE: no packet is lost at a segment boundary", () => {
    const total = files.reduce((sum, f) => sum + packetCount(path.join(wipDir, f)), 0);
    eq(total, sourcePackets, "packets across all segments vs the source");
  });

  await check("every segment starts on a keyframe, so review can seek into it", () => {
    eq(files.length >= 3, true, `segments to check, got ${files.length}`);
    for (const f of files) {
      const first = probe(path.join(wipDir, f), ["-select_streams", "v:0", "-read_intervals", "%+#1", "-show_entries", "packet=flags"]).packets[0];
      eq(first.flags.startsWith("K"), true, `${f} first packet flags ${first.flags}`);
    }
  });

  await check("THE FEARED ONE: this ffmpeg names segments so their start time reads back", () => {
    eq(files.length >= 3, true, `segments to check, got ${files.length}`);
    for (const f of files) {
      const t = wipStartMs(path.basename(f, ".mp4")); // as recorder.mjs and segstore.mjs call it
      eq(Number.isFinite(t), true, `${f} parses to a start time`);
      eq(t >= startedMs - 5_000 && t <= endedMs + 5_000, true, `${f} starts within the run (${new Date(t).toISOString()})`);
    }
  });

  // D6: a G.711 camera with audio on. Copied into mp4 this wrote nothing at all.
  // Not paced with -re, so wall-clock cutting makes one segment; that is enough.
  const g711 = path.join(work, "source-g711.mkv");
  const made = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", src, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
    "-t", "7", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_mulaw", "-ar", "8000", "-ac", "1", "-y", g711], { encoding: "utf8" });
  const audioRun = async (input, name) => {
    const dir = path.join(work, name, INPROGRESS);
    await mkdir(dir, { recursive: true });
    const a = ffmpegArgs("rtsp://unused.invalid/stream", path.join(dir, wipPattern()), 2, { audio: true });
    a.splice(a.indexOf("-rtsp_transport"), 2);
    a.splice(a.indexOf("-i"), 2, "-i", input);
    const r = spawnSync("ffmpeg", a, { encoding: "utf8", timeout: 60_000 });
    return { r, dir, files: (await readdir(dir)).sort() };
  };

  await check("THE FEARED ONE: with audio on, a G.711 camera records video and AAC audio", async () => {
    eq(made.status, 0, `G.711 source (stderr: ${String(made.stderr).trim().slice(0, 200)})`);
    const { r, dir, files: out } = await audioRun(g711, "cam-g711");
    eq(r.status, 0, `ffmpeg exit (stderr: ${String(r.stderr).trim().slice(0, 300)})`);
    eq(out.length >= 1, true, `segments written, got ${out.length}`);
    const video = out.reduce((n, f) => n + packetCount(path.join(dir, f)), 0);
    eq(video, packetCount(g711), "every video packet");
    const audio = probe(path.join(dir, out[0]), ["-select_streams", "a:0", "-show_entries", "stream=codec_name"]).streams[0];
    eq(audio?.codec_name, "aac", "audio stored as AAC");
  });

  await check("with audio on, a camera with no audio track still records", async () => {
    const { r, dir, files: out } = await audioRun(src, "cam-silent");
    eq(r.status, 0, `ffmpeg exit (stderr: ${String(r.stderr).trim().slice(0, 300)})`);
    eq(out.reduce((n, f) => n + packetCount(path.join(dir, f)), 0), sourcePackets, "every video packet");
  });
} finally {
  await rm(work, { recursive: true, force: true });
}

report("real ffmpeg");
