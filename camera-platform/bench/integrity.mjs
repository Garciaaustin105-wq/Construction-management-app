#!/usr/bin/env node
// integrity.mjs <start-epoch-s> <end-epoch-s> <store-root> [...]
// Did each camera record the whole window? Measurements, then one RESULT line.
//
// Run it at least ~90 s AFTER the window ends: a segment still in .inprogress
// is not sealed, and counting its absence as a hole would blame the recorder
// for a file it has not finished writing.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const start = Number(process.argv[2]);
const end = Number(process.argv[3]);
const roots = process.argv.slice(4);
if (!(start > 0) || !(end > start) || roots.length === 0) {
  console.error("usage: node integrity.mjs <start-epoch-s> <end-epoch-s> <store-root> [...]");
  process.exit(2);
}
const windowS = end - start;

// Cameras can span two drives, so segments are merged by camera name.
const cams = new Map();
for (const root of roots) {
  let entries = [];
  try { entries = readdirSync(root); } catch (e) { console.error(`skipped ${root}: ${e.message}`); continue; }
  for (const cam of entries) {
    const dir = join(root, cam);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    if (!cams.has(cam)) cams.set(cam, []);
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)\.mp4$/.exec(f);
      if (m) cams.get(cam).push({ path: join(dir, f), startS: Number(m[1]) / 1000 });
    }
  }
}

// Gap events, from the recorder's own log. The field is "msg"; matching the
// raw line means a renamed field cannot silently turn every gap into zero.
const gapEvents = new Map();
let journalNote = "";
try {
  const out = execFileSync("journalctl", ["-u", "camplat-recorder", "--since", `@${start}`, "--until", `@${end}`,
    "--no-pager", "-o", "cat"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const line of out.split("\n")) {
    if (!line.includes("gap_recorded")) continue;
    let id = null;
    try { id = JSON.parse(line).cameraId ?? null; } catch { /* not JSON */ }
    const key = id ?? "(unparsed)";
    gapEvents.set(key, (gapEvents.get(key) ?? 0) + 1);
  }
} catch (e) {
  journalNote = `journalctl failed: ${e.message.split("\n")[0]}`;
}

const rows = [];
for (const [cam, segs] of [...cams.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
  const probed = [];
  let unreadable = 0;
  for (const s of segs) {
    // Only segments that could overlap the window. A segment is at most one
    // segment length long (60 s on this recorder; 65 s allows slack), so one
    // that started earlier cannot cover the window's first second -- and an
    // unreadable file from before the window must not be blamed on it.
    if (s.startS >= end || s.startS <= start - 65) continue;
    try {
      // Packets, not decoded frames: one H.264 packet is one frame, and this
      // reads the file without decoding 1440p video.
      const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_packets,r_frame_rate", "-show_entries", "format=duration", "-of", "json", s.path],
        { encoding: "utf8", timeout: 60000 }));
      const dur = Number(j.format?.duration);
      const [num, den] = String(j.streams?.[0]?.r_frame_rate ?? "0/1").split("/").map(Number);
      if (!(dur > 0)) throw new Error("no duration");
      probed.push({ startS: s.startS, endS: s.startS + dur, dur, packets: Number(j.streams?.[0]?.nb_read_packets ?? 0),
        fps: den ? num / den : 0 });
    } catch {
      unreadable++;
    }
  }
  // Clip each segment to the window, then measure what is covered.
  const inWin = probed.filter((p) => p.endS > start && p.startS < end).sort((a, b) => a.startS - b.startS);
  let covered = 0, largestGap = 0, cursor = start, packets = 0, expected = 0;
  for (const p of inWin) {
    const a = Math.max(p.startS, start), b = Math.min(p.endS, end);
    if (a > cursor) largestGap = Math.max(largestGap, a - cursor);
    if (b > cursor) { covered += b - Math.max(a, cursor); cursor = b; }
    packets += p.packets; expected += p.dur * p.fps;
  }
  largestGap = Math.max(largestGap, end - cursor);
  rows.push({
    camera: cam,
    segments: inWin.length,
    coverage_pct: Number((covered / windowS * 100).toFixed(1)),
    largest_gap_s: Number(largestGap.toFixed(1)),
    frame_ratio: expected > 0 ? Number((packets / expected).toFixed(3)) : 0,
    gap_events: gapEvents.get(cam) ?? 0,
    unreadable,
  });
}

console.log("camera        segs  coverage%  largest_gap_s  frame_ratio  gap_events  unreadable");
for (const r of rows) {
  console.log(`${r.camera.padEnd(13)} ${String(r.segments).padStart(4)}  ${String(r.coverage_pct).padStart(9)}  ` +
    `${String(r.largest_gap_s).padStart(13)}  ${String(r.frame_ratio).padStart(11)}  ${String(r.gap_events).padStart(10)}  ${String(r.unreadable).padStart(10)}`);
}
if (gapEvents.has("(unparsed)")) console.log(`gap events on lines that did not parse: ${gapEvents.get("(unparsed)")}`);
if (journalNote) console.log(journalNote);
writeFileSync("integrity.json", JSON.stringify({ start, end, windowS, rows, journalNote }, null, 2));

const holes = rows.filter((r) => r.coverage_pct < 98 || r.gap_events > 0 || r.unreadable > 0).map((r) => r.camera);
console.log(holes.length === 0 ? "RESULT: every camera recorded the whole window"
  : `RESULT: cameras with holes: ${holes.join(", ")}`);
