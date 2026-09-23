#!/usr/bin/env node
/**
 * camctl — the field tool. Point it at a camera subnet and it tells you what is
 * there, what each camera is really streaming, and what that means for
 * retention.
 *
 * Every quantity it prints carries its unit, and anything it could not measure
 * prints as "not measured" rather than a plausible default.
 */
import { preflight } from "./preflight.mjs";
import { runLoad, formatLoadReport } from "./loadtest.mjs";
import { audit, loadConfig, cleanEmpty } from "./recorder-service.mjs";
import { runAlertsCheck, shouldRestartRecorder, transitionLogLine, RESTART_REQUEST, requestCameraRestarts } from "./alerts-run.mjs";
import { defaultThresholds } from "../dist/alerts.js";
import { DEFAULT_PATHS } from "./config.mjs";
import { runScore } from "./score-clips.mjs";
import { runGateCheck, DEFAULT_THREADS, MAX_HOURS, MAX_THREADS } from "./gate-check.mjs";
import { loadOrCreateIdentity } from "./device-identity.mjs";
import { composeCheckin, readCheckinState } from "./checkin.mjs";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { openEventsDb } from "./events-db.mjs";
import { createKnownObjectsStore } from "./known-objects.mjs";
import { resetKnownObject, knownObjectNotice } from "../dist/knownObjects.js";
import { sweep } from "./sweep.mjs";
import { discoverSadp } from "./sadp.mjs";
import { discoverOnvif } from "./wsdiscovery.mjs";
import { chooseDiscoveryInterface } from "../dist/net.js";
import { networkInterfaces } from "node:os";
import { probeStream, measureBitrate } from "./media.mjs";
import { buildRtspUrl, redactRtspUrl, candidatePaths, urlForPath } from "../dist/rtsp.js";
import { parseRtspUrl } from "../dist/cameraSource.js";
import { vendorFromMac, normaliseMac } from "../dist/camera.js";
import { computeRetentionDays, requiredBytesForDays, usableBytesFromRaw, TERABYTE } from "../dist/retention.js";
import { computePerCameraBudget, checkAgainstBudget, withRingHeadroom } from "../dist/budget.js";

const [, , command, ...args] = process.argv;

function flag(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

function credentials() {
  const username = flag("user") ?? process.env.CAMPLAT_USER;
  const password = flag("pass") ?? process.env.CAMPLAT_PASS;
  if (!username || !password) {
    console.error("credentials required: --user U --pass P, or CAMPLAT_USER / CAMPLAT_PASS");
    process.exit(2);
  }
  return { username, password };
}

async function cmdPreflight() {
  const { ok, checks } = await preflight();
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(24)} ${c.detail}`);
  console.log(ok ? "\npreflight passed" : "\npreflight FAILED");
  process.exit(ok ? 0 : 1);
}

async function cmdDiscover() {
  const cidr = args[0];
  if (!cidr) { console.error("usage: camctl discover <cidr> [--raw-dir DIR] [--iface NAME|ADDRESS]"); process.exit(2); }

  // Which card SADP and WS-Discovery use. Decided before the sweep, so a
  // mistyped --iface stops here rather than after a scan.
  const card = chooseDiscoveryInterface(networkInterfaces(), { iface: flag("iface") ?? undefined, cidr });
  if (card.kind === "refused") { console.error(`discover refused: ${card.reason}`); process.exit(2); }
  if (card.kind === "chosen") {
    console.log(`discovery card: ${card.name} ${card.address} (${card.source === "iface" ? "from --iface" : `the card on ${cidr}`})`);
  } else {
    console.log(`discovery card: not chosen: ${card.reason}`);
  }
  const pinned = card.kind === "chosen" ? { interfaceAddress: card.address } : {};

  console.log(`sweeping ${cidr} for open 554/80 ...`);
  const hosts = await sweep(cidr, [554, 80], {
    onHost: (h) => console.log(`  found ${h.ip}  ports ${h.openPorts.join(",")}`),
  });

  console.log(`\nSADP inquiry (Hikvision, answers with ONVIF disabled) ...`);
  const rawDir = flag("raw-dir");
  const sadp = await discoverSadp({ rawDir, ...pinned, ...(card.kind === "chosen" ? { broadcast: card.broadcast } : {}) }).catch((e) => {
    console.log(`  SADP failed: ${e.message}`);
    return [];
  });
  for (const d of sadp) {
    console.log(`  ${d.ip ?? d.from}  ${d.mac ?? "?"}  ${d.model ?? "?"}  fw ${d.firmware ?? "?"}  sn ${d.serial ?? "?"}`);
  }
  if (rawDir) console.log(`  raw SADP responses written to ${rawDir}`);

  console.log(`\nONVIF WS-Discovery ...`);
  const onvif = await discoverOnvif({ ...pinned }).catch((e) => {
    console.log(`  WS-Discovery failed: ${e.message}`);
    return [];
  });
  for (const d of onvif) console.log(`  ${d.ip}  ${d.name ?? "?"}  ${d.hardware ?? ""}`);

  // Merge: the sweep is the source of truth for existence, the protocols enrich.
  const byIp = new Map();
  for (const h of hosts) byIp.set(h.ip, { ip: h.ip, openPorts: h.openPorts });
  for (const d of sadp) {
    const ip = d.ip ?? d.from;
    const entry = byIp.get(ip) ?? { ip, openPorts: [] };
    let vendor = "generic";
    try { vendor = d.mac ? vendorFromMac(d.mac) : "generic"; } catch { vendor = "generic"; }
    byIp.set(ip, { ...entry, mac: d.mac ? normaliseMac(d.mac) : null, model: d.model, serial: d.serial, firmware: d.firmware, vendor, via: "sadp" });
  }
  for (const d of onvif) {
    const entry = byIp.get(d.ip) ?? { ip: d.ip, openPorts: [] };
    byIp.set(d.ip, { ...entry, onvif: true, name: d.name ?? entry.name });
  }

  const merged = [...byIp.values()];
  console.log(`\n${merged.length} device(s):`);
  console.log(JSON.stringify(merged, null, 2));
  console.log(`\nnext: camctl probe <ip> --user U --pass P --vendor hikvision`);
}

async function cmdProbe() {
  const ip = args[0];
  if (!ip) { console.error("usage: camctl probe <ip> [--vendor V] [--seconds N] --user U --pass P"); process.exit(2); }
  const creds = credentials();
  const vendor = flag("vendor", "hikvision");
  const seconds = Number(flag("seconds", "30"));

  const channel = Number(flag("channel", "1"));
  const stream = flag("stream", "main");
  const tryAll = args.includes("--try-all");

  // Level 3: a full URL, used exactly as given. This is the path that gets an
  // installer off site when everything clever has failed, so it second-guesses
  // nothing — not the port, not the path, not the credentials.
  if (/^rtsps?:\/\//i.test(ip)) {
    const parsed = parseRtspUrl(ip);
    if (parsed.kind !== "ok") { console.error(`not usable: ${parsed.reason}`); process.exit(2); }
    const url = parsed.username
      ? ip
      : urlForPath(parsed.host, parsed.path, creds, parsed.port).url;
    console.log(`probing ${redactRtspUrl(url)}  (verbatim — no template applied)`);
    const direct = await probeStream(url);
    if (direct.kind !== "ok") { console.error(`unusable: ${direct.reason}`); process.exit(1); }
    const s2 = direct.stream;
    console.log(`  codec ${s2.codec}  ${s2.width}x${s2.height}  ${s2.fps ?? "?"} fps  audio ${s2.hasAudio ? "PRESENT" : "none"}`);
    console.log(`\n  >>> working URL: ${redactRtspUrl(url)}`);
    console.log("      record it in FIELD-NOTES against the model — it belongs in candidatePaths().");
    return;
  }

  let built;
  let probe;

  if (tryAll) {
    // Some vendors — AVYCON documents this — use different paths per model.
    // Trying the ordered candidates and recording which streamed turns the
    // guess into a fact. Do this once per model, then reuse the answer.
    const candidates = candidatePaths(vendor, stream, channel);
    console.log(`trying ${candidates.length} candidate path(s) for ${vendor}:`);
    for (const candidate of candidates) {
      const attempt = urlForPath(ip, candidate.path, creds);
      process.stdout.write(`  ${candidate.path.padEnd(40)} ${candidate.documented ? "[documented]" : "[convention]"} ... `);
      const result = await probeStream(attempt.url, { timeoutMs: 12_000 });
      if (result.kind === "ok") {
        console.log("STREAMS");
        console.log(`\n  >>> working path for ${vendor}/${stream}: ${candidate.path}`);
        console.log(`      record this in FIELD-NOTES against the model — it is now a fact, not a guess.\n`);
        built = attempt;
        probe = result;
        break;
      }
      console.log("no");
    }
    if (!probe) {
      console.error(`\nnone of the candidate paths streamed. Check credentials, then read the\nRTSP path from the camera's own web interface and send it back so the\ncandidate list learns it.`);
      process.exit(1);
    }
  } else {
    built = buildRtspUrl({ vendor, ip, channel, stream }, creds);
    if (built.kind !== "ok") {
      console.error(built.message);
      console.error(`\ntry: camctl probe ${ip} --vendor ${vendor} --try-all ...`);
      process.exit(1);
    }
    console.log(`probing ${built.redacted}`);
    probe = await probeStream(built.url);
    if (probe.kind !== "ok") {
      console.error(`unusable: ${probe.reason}`);
      console.error(`\nthis vendor's path may vary by model — retry with --try-all`);
      process.exit(1);
    }
  }

  const s = probe.stream;
  console.log(`  codec        ${s.codec}`);
  console.log(`  resolution   ${s.width}x${s.height}`);
  console.log(`  fps          ${s.fps ?? "not reported"}`);
  console.log(`  audio        ${s.hasAudio ? "PRESENT — legally gated, off by default" : "none"}`);
  console.log(`  bitrate      ${s.bitrateKbps === null ? "not reported by RTSP — measuring" : `${s.bitrateKbps} kbps (reported)`}`);

  console.log(`\nmeasuring real bitrate over ${seconds}s ...`);
  const measured = await measureBitrate(built.url, { seconds });
  if (measured.kind !== "ok") { console.error(`  refused: ${measured.reason}`); process.exit(1); }
  console.log(`  measured     ${measured.bitrateKbps} kbps  (${measured.bytes} bytes in ${measured.seconds}s)`);
  if (s.bitrateKbps !== null && Math.abs(s.bitrateKbps - measured.bitrateKbps) / s.bitrateKbps > 0.25) {
    console.log(`  NOTE: reported and measured differ by more than 25% — trust the measurement.`);
  }

  const cameras = Number(flag("cameras", "1"));
  const rawTb = Number(flag("disk-tb", "16"));
  const est = computeRetentionDays(
    Array.from({ length: cameras }, (_, i) => ({ cameraId: `cam-${i + 1}`, bitrateKbps: measured.bitrateKbps })),
    usableBytesFromRaw(rawTb * TERABYTE),
  );
  console.log(`\nat this bitrate, ${cameras} camera(s) on ${rawTb} TB raw:`);
  console.log(est.kind === "ok" ? `  ${est.days.toFixed(1)} days retention` : `  refused: ${est.message}`);
}

async function cmdSize() {
  const cameras = Number(flag("cameras", "16"));
  const days = Number(flag("days", "30"));
  const rates = (flag("kbps", "2000,3000,4000,6000")).split(",").map(Number);
  const disks = (flag("disks-tb", "16,24,32,48,64")).split(",").map(Number);
  const cams = (kbps) => Array.from({ length: cameras }, (_, i) => ({ cameraId: `cam-${i + 1}`, bitrateKbps: kbps }));
  const tb = (bytes) => (bytes / TERABYTE).toFixed(1);

  console.log(`${cameras} cameras, ${days}-day target\n`);
  console.log("avg bitrate   GB/day/cam   fleet GB/day   disk needed");
  for (const kbps of rates) {
    const perCamDay = (kbps * 1000 * 86400) / 8 / 1e9;
    const need = requiredBytesForDays(cams(kbps), days);
    if (need.kind !== "ok") { console.log(`${kbps} kbps: refused — ${need.message}`); continue; }
    console.log(
      `${String(kbps / 1000 + " Mbps").padStart(9)}   ${perCamDay.toFixed(1).padStart(10)}   ${(perCamDay * cameras).toFixed(0).padStart(12)}   ${tb(need.bytes).padStart(7)} TB`,
    );
  }

  console.log(`\nRetention achieved, by raw disk (10% filesystem overhead):\n`);
  process.stdout.write("raw disk   usable ");
  for (const kbps of rates) process.stdout.write(String(kbps / 1000 + " Mbps").padStart(11));
  console.log();
  for (const raw of disks) {
    const usable = usableBytesFromRaw(raw * TERABYTE);
    process.stdout.write(`${String(raw + " TB").padEnd(10)} ${tb(usable).padStart(5)} TB`);
    for (const kbps of rates) {
      const r = computeRetentionDays(cams(kbps), usable);
      process.stdout.write((r.kind === "ok" ? `${r.days.toFixed(0)} days` : "refused").padStart(11));
    }
    console.log();
  }
  console.log(`\nEvery figure assumes the bitrate is MEASURED. Run \`camctl probe\` first —\na datasheet number is a setting, not a measurement.`);
}

async function cmdBudget() {
  const cameras = Number(flag("cameras", "16"));
  const days = Number(flag("days", "30"));
  const rawTb = Number(flag("disk-tb", "16"));
  const fill = Number(flag("fill", "0.85"));

  const usable = withRingHeadroom(usableBytesFromRaw(rawTb * TERABYTE), fill);
  const budget = computePerCameraBudget(days, usable, cameras);
  if (budget.kind !== "ok") { console.error(budget.reason); process.exit(1); }

  console.log(`${cameras} cameras, ${rawTb} TB raw, ${(fill * 100).toFixed(0)}% fill, ${days}-day target`);
  console.log(`usable ${(usable / TERABYTE).toFixed(1)} TB`);
  console.log(`\n  BUDGET: ${budget.perCameraKbps.toFixed(0)} kbps per camera  (${(budget.totalKbps / 1000).toFixed(1)} Mbps fleet)\n`);

  const measured = flag("kbps");
  if (!measured) {
    console.log("pass --kbps a,b,c to check candidate bitrates against it, or");
    console.log("--kbps <single> to model every camera at that rate.");
    return;
  }
  const rates = measured.split(",").map(Number);
  console.log("bitrate      utilisation   projected   verdict");
  for (const kbps of rates) {
    const cams = Array.from({ length: cameras }, (_, i) => ({ cameraId: `cam-${i + 1}`, bitrateKbps: kbps }));
    const r = checkAgainstBudget(cams, budget);
    if (r.kind !== "ok") { console.log(`${kbps} kbps: refused — ${r.reason}`); continue; }
    console.log(
      `${(kbps + " kbps").padStart(10)}   ${(r.utilisation * 100).toFixed(0).padStart(10)}%   ${(r.projectedDays.toFixed(1) + " d").padStart(9)}   ${r.projectedDays >= days ? "holds" : "MISSES"}`,
    );
  }
}

async function cmdBench() {
  const { open, rm, mkdir } = await import("node:fs/promises");
  const target = flag("path", "/srv/camplat/disk0");
  const writers = Number(flag("writers", "8"));      // cameras per spindle
  const seconds = Number(flag("seconds", "20"));
  const dir = `${target}/.bench`;

  await mkdir(dir, { recursive: true }).catch(() => {});
  console.log(`writing from ${writers} concurrent streams to ${target} for ${seconds}s`);
  console.log("(this is what 8 cameras on one spindle actually looks like)\n");

  const chunk = Buffer.alloc(256 * 1024, 0x5a);
  const deadline = Date.now() + seconds * 1000;
  let totalBytes = 0;

  const run = async (n) => {
    const handle = await open(`${dir}/w${n}.bin`, "w");
    let written = 0;
    try {
      while (Date.now() < deadline) {
        await handle.write(chunk);
        written += chunk.length;
      }
      await handle.sync();          // the number is meaningless without this
    } finally {
      await handle.close();
    }
    return written;
  };

  const started = Date.now();
  const results = await Promise.all(Array.from({ length: writers }, (_, i) => run(i)));
  const elapsed = (Date.now() - started) / 1000;
  totalBytes = results.reduce((a, b) => a + b, 0);
  await rm(dir, { recursive: true, force: true }).catch(() => {});

  const mbPerSec = totalBytes / 1e6 / elapsed;
  const needMbPerSec = (writers * 2500 * 1000) / 8 / 1e6;   // 8 cameras at 2.5 Mbps
  console.log(`  throughput   ${mbPerSec.toFixed(1)} MB/s across ${writers} writers`);
  console.log(`  required     ${needMbPerSec.toFixed(2)} MB/s for ${writers} cameras at 2.5 Mbps`);
  console.log(`  headroom     ${(mbPerSec / needMbPerSec).toFixed(0)}x`);
  console.log(
    mbPerSec > needMbPerSec * 4
      ? "\n  comfortable — recording is nowhere near this drive's limit"
      : "\n  MARGINAL — investigate before deploying; a drive this slow will drop frames under load",
  );
}

async function cmdLoad() {
  const source = flag("source");
  if (!source) { console.error("--source FILE required: a recording from the camera, e.g. a sealed segment"); process.exit(2); }
  const target = flag("path", "/srv/camplat/disk0");
  const cameras = Number(flag("cameras", "16"));
  const seconds = Number(flag("seconds", "300"));
  const segmentSeconds = Number(flag("segment-seconds", "60"));
  const kbps = flag("kbps") === null ? null : Number(flag("kbps"));
  const keep = args.includes("--keep");

  console.log(`playing ${source} into ${cameras} recorders on ${target} for ${seconds}s`);
  console.log("(no network and no camera: this measures CPU, disks and the index)\n");

  const summary = await runLoad({ target, source, cameras, seconds, segmentSeconds, sourceKbps: kbps, keep });
  console.log(formatLoadReport(summary));
  if (keep) console.log(`\n  recordings kept under ${target}/.loadtest-*`);
}

async function cmdAudit() {
  const stateDir = flag("state-dir") ?? process.env.CAMPLAT_STATE_DIR ?? undefined;
  const { summary, refusedRoots, disks } = await audit({ stateDir });
  console.log("audit — read-only: nothing is moved, deleted or written");
  console.log();
  for (const d of disks) {
    const q = d.quarantine;
    if (q) {
      console.log(`  ${d.root} quarantine: ${q.files} file(s), ${(q.bytes / 1e6).toFixed(1)} MB`);
    } else {
      console.log(`  ${d.root} quarantine: could not be read`);
    }
  }
  if (refusedRoots.length > 0) {
    for (const r of refusedRoots) console.log(`REFUSED ${r.root}: ${r.reason}`);
    console.log("no counts: a drive that is not mounted hides its files, and every segment on it would read as lost. Mount it and run audit again.");
    process.exit(1);
  } else {
    console.log();
    const rows = [
      ["confirmed", "segments confirmed on disk", "segment(s)"],
      ["corrected", "index rows corrected", "segment(s)"],
      ["partials", "partial segments (unsealed)", "segment(s)"],
      ["adopted", "files on disk the index lacks", "file(s)"],
      ["dropped", "unusable files that would be dropped", "file(s)"],
      ["quarantined", "files that would be quarantined", "file(s)"],
      ["lost", "LOST: indexed but missing on disk", "segment(s)"],
    ];
    for (const [key, label, unit] of rows) {
      console.log(`  ${label.padEnd(38)}${summary[key]} ${unit}`);
    }
    console.log("\nnote: while the recorder is running, the segment being written right now counts as a partial.");
    if (summary.lost > 0) process.exit(1);
  }
}

// Run by camplat-alerts.timer every 60 s, as the service user. It writes
// alerts.json and logs only changes. With --restart-stale it asks for a
// recorder restart by writing a request file; camplat-recorder-restart.path
// (root) acts on it, so this unprivileged process needs no polkit or sudo.
// It also writes one request per camera newly not recording; the recorder
// service reads those itself and restarts only that camera's ffmpeg.
async function cmdAlerts() {
  const stateDir = flag("state-dir") ?? process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  const config = await loadConfig(stateDir);
  const result = await runAlertsCheck({ stateDir, thresholds: defaultThresholds(config.segmentSeconds) });
  for (const reason of result.discarded) console.log(JSON.stringify({ level: "warn", msg: "previous alerts discarded", reason }));
  for (const t of result.transitions) console.log(transitionLogLine(t));
  if (args.includes("--restart-stale") && shouldRestartRecorder(result.transitions)) {
    await writeFile(path.join(stateDir, RESTART_REQUEST), `${result.checkedUtc}
`);
    console.log(JSON.stringify({ level: "warn", msg: "recorder restart requested", reason: "recorder_stale raised" }));
  }
  if (args.includes("--restart-stale")) {
    for (const id of await requestCameraRestarts(stateDir, result.transitions, result.checkedUtc)) {
      console.log(JSON.stringify({ level: "warn", msg: "camera restart requested", cameraId: id, reason: "camera_not_recording raised" }));
    }
  }
  if (process.stdout.isTTY) {
    for (const a of result.alerts) if (a.state !== "clear") console.log(`  ${a.state.padEnd(8)}${a.key}: ${a.value}`);
    console.log(`checked ${result.checkedUtc}: ${result.alerts.filter((a) => a.state === "raised").length} raised, ${result.alerts.filter((a) => a.state === "unknown").length} unknown`);
  }
}

// Segments indexed before 5052852 that hold no video (a restart's stub).
// Lists by default; --apply moves them to quarantine and drops their rows.
async function cmdCleanEmpty() {
  const stateDir = flag("state-dir") ?? process.env.CAMPLAT_STATE_DIR ?? undefined;
  const apply = args.includes("--apply");
  const r = await cleanEmpty({ stateDir, apply });
  for (const e of r.empty) console.log(`  ${e.cameraId.padEnd(14)}${e.startUtc}  ${String(e.bytes ?? "?").padStart(6)} bytes  ${e.path}`);
  console.log(`\nchecked ${r.checked} recording(s); ${r.empty.length} hold no video; ${r.missing} indexed but not on disk (left alone)`);
  if (apply) {
    console.log(`moved ${r.moved} to quarantine and removed their rows${r.failed.length ? `; ${r.failed.length} FAILED` : ""}`);
    for (const f of r.failed) console.log(`  failed: ${f.path}: ${f.error}`);
    if (r.failed.length > 0) process.exit(1);
  } else if (r.empty.length > 0) {
    console.log("nothing moved: run again with --apply to move these to quarantine");
  }
}

// Plays every "Teach the AI" clip back through the live detector, at the
// frame rate and confidence floor live uses, and scores it against the
// answer key (agent/score-clips.mjs). --fps N replays at N instead of the
// live rate, and the report labels it so. The service unit sets the venv
// python in CAMPLAT_DETECT_PYTHON; run by hand, the same venv is assumed.
async function cmdScore() {
  const stateDir = flag("state-dir") ?? process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  const config = await loadConfig(stateDir);
  const fpsFlag = flag("fps");
  const fpsByHand = fpsFlag === null ? null : Number(fpsFlag);
  if (fpsByHand !== null && !(fpsByHand > 0 && fpsByHand <= 30)) {
    console.error("--fps must be a number above 0 and at most 30");
    process.exitCode = 2;
    return;
  }
  const python = process.env.CAMPLAT_DETECT_PYTHON ?? "/opt/camplat-detect/venv/bin/python";
  const replayPath = fileURLToPath(new URL("../detector/replay.py", import.meta.url));
  const result = await runScore({ stateDir, config, python, replayPath, fpsByHand, progress: (m) => console.error(m) });
  if (result.refused) {
    console.log(`Refused: ${result.refused}`);
    process.exitCode = 1;
    return;
  }
  for (const line of result.lines) console.log(line);
  if (result.savedTo) console.log(`Saved: ${result.savedTo}`);
  if (result.saveError) console.log(`Not saved (the report above is complete): ${result.saveError}`);
}

// Replays the recorded substream with the model on every frame and the motion
// gate beside it, and reports who the gate would have missed
// (agent/gate-check.mjs). It measures only: no setting is changed. Every flag
// is checked before anything is read, and a bad one exits 2 rather than
// running an hour of replay on a guess.
async function cmdGateCheck() {
  const usage = "usage: camctl gate-check [--state-dir D] [--camera ID] [--from ISO --to ISO | --hours N] [--fps N] [--threads N] [--footage-camera ID]";
  const bad = (message) => {
    console.error(`${message}\n${usage}`);
    process.exitCode = 2;
  };
  const known = ["state-dir", "camera", "from", "to", "hours", "fps", "threads", "footage-camera"];
  const given = new Map();
  for (let i = 0; i < args.length; i += 2) {
    // Only an option's name is ever echoed back: a value typed in the wrong
    // place could be anything, a password included.
    if (!args[i].startsWith("--")) return bad("a value was given with no option before it");
    const name = args[i].slice(2);
    if (!known.includes(name)) return bad(`unknown option --${name.split("=")[0]}`);
    if (given.has(name)) return bad(`--${name} is given twice`);
    const value = args[i + 1];
    if (value === undefined || value === "" || value.startsWith("--")) return bad(`--${name} needs a value`);
    given.set(name, value);
  }
  const number = (name) => (given.has(name) ? Number(given.get(name)) : null);
  const hours = number("hours");
  if (hours !== null && !(hours > 0 && hours <= MAX_HOURS)) return bad(`--hours must be a number above 0 and at most ${MAX_HOURS}`);
  const threads = number("threads");
  if (threads !== null && !(Number.isInteger(threads) && threads >= 1 && threads <= MAX_THREADS)) {
    return bad(`--threads must be a whole number from 1 to ${MAX_THREADS}`);
  }
  const fpsByHand = number("fps");
  if (fpsByHand !== null && !(fpsByHand > 0 && fpsByHand <= 30)) return bad("--fps must be a number above 0 and at most 30");
  const fromUtc = given.get("from") ?? null;
  const toUtc = given.get("to") ?? null;
  if ((fromUtc === null) !== (toUtc === null)) return bad("--from and --to go together");
  if (fromUtc !== null) {
    if (hours !== null) return bad("give --from and --to, or --hours, not both");
    // A time with no zone would be read in the box's own zone, hours away
    // from what was meant, and the report would look right.
    const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
    const fromMs = Date.parse(fromUtc);
    const toMs = Date.parse(toUtc);
    if (!zoned.test(fromUtc) || !zoned.test(toUtc) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      return bad("--from and --to must be ISO times with a zone, e.g. 2026-09-21T03:00:00Z");
    }
    if (!(fromMs < toMs)) return bad("--from must be before --to");
    if (toMs - fromMs > MAX_HOURS * 3_600_000) return bad(`--from to --to must be at most ${MAX_HOURS} h`);
  }

  const stateDir = given.get("state-dir") ?? process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  let config;
  try {
    config = await loadConfig(stateDir);
  } catch (err) {
    // loadConfig names the file and, since 2026-09-22, where it broke and
    // nothing more. A JSON parser's own detail quotes a slice of the file, and
    // config.json holds the camera login, so anything after "is not valid
    // JSON" other than that line and column is still cut here.
    const message = String(err?.message ?? err)
      .replace(/(is not valid JSON)(?! at line \d+, column \d+$).*$/s, "$1")
      .replace(/rtsps?:\/\/\S*/gi, "[a camera address]");
    console.log(`Refused: ${message}`);
    process.exitCode = 1;
    return;
  }
  const python = process.env.CAMPLAT_DETECT_PYTHON ?? "/opt/camplat-detect/venv/bin/python";
  const replayPath = fileURLToPath(new URL("../detector/replay.py", import.meta.url));
  const run = await runGateCheck({
    stateDir, config, python, replayPath,
    cameraId: given.get("camera") ?? null,
    footageCameraId: given.get("footage-camera") ?? null,
    fromUtc, toUtc,
    hours: hours ?? 1,
    fpsByHand,
    threads: threads ?? DEFAULT_THREADS,
    progress: (m) => console.error(m),
  });
  if (run.refused) {
    console.log(`Refused: ${run.refused}`);
    process.exitCode = 1;
    return;
  }
  for (const [i, r] of run.results.entries()) {
    if (i > 0) console.log("");
    if (r.refused) {
      console.log(`Refused for ${r.cameraId}: ${r.refused}`);
      process.exitCode = 1;
      continue;
    }
    for (const line of r.lines) console.log(line);
    if (r.savedTo) console.log(`Saved: ${r.savedTo}`);
    if (r.saveError) console.log(`Not saved (the report above is complete): ${r.saveError}`);
  }
}

// Known objects (KNOWN-OBJECTS-SPEC.md): a recurring detection at one spot,
// suppressed automatically once it is learned — nobody clicks before it
// applies (Austin, 2026-09-20; overrides build rule 13 for this one feature).
// This command lists what has been learned, in the same measurement words
// the Review page shows (never a verdict — rule 11), and is the human
// override for the case a belt got wrong: --reset lapses an object by hand
// (reason "reset_by_hand") and un-hides the events it was hiding, the same
// way a re-aimed camera or 24 h of silence would on their own.
async function cmdKnownObjects() {
  const stateDir = flag("state-dir") ?? process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  const camera = flag("camera");
  const id = flag("id");
  const reset = args.includes("--reset");
  if (reset && id === null && camera === null) {
    console.error("usage: camctl known-objects --reset --id ID [--state-dir D]\n" +
      "       camctl known-objects --camera ID --reset [--state-dir D]");
    process.exitCode = 2;
    return;
  }

  const store = createKnownObjectsStore({ stateDir });
  const { objects, problem } = await store.load();
  if (problem !== null) {
    // A store that cannot be trusted is refused cleanly, the same as the API
    // route: neither one guesses at what a half-read file might have meant.
    console.log(`Refused: ${problem}`);
    process.exitCode = 1;
    return;
  }
  const inScope = camera === null ? objects : objects.filter((o) => o.cameraId === camera);

  if (!reset) {
    if (inScope.length === 0) {
      console.log(camera === null ? "no known objects" : `no known objects for ${camera}`);
      return;
    }
    for (const o of inScope) {
      console.log(`${o.id}  ${o.cameraId}  ${o.kind}  ${o.state}${o.state === "lapsed" ? ` (${o.lapseReason})` : ""}`);
      for (const line of knownObjectNotice(o)) console.log(`  ${line}`);
      console.log("");
    }
    return;
  }

  // --reset: one object by id, or every object of the given camera. Named
  // by id, it must exist at all (refused below if not); named by camera, an
  // empty scope is not an error, just nothing to do.
  const targets = id !== null ? inScope.filter((o) => o.id === id) : inScope;
  if (id !== null && targets.length === 0) {
    console.log(`Refused: no known object with id ${id}${camera !== null ? ` on camera ${camera}` : ""}`);
    process.exitCode = 1;
    return;
  }

  // Only the ACTIVE ones actually change: resetKnownObject leaves an
  // already-lapsed object exactly as it is (its first reason is the true
  // one), so a second reset of the same id is a fact worth saying, not an
  // error and not a claim that something just happened.
  const toReset = targets.filter((o) => o.state === "active");
  if (toReset.length === 0) {
    if (id !== null) {
      console.log(`${id} is already lapsed (${targets[0].lapseReason}); nothing to reset`);
    } else {
      console.log(camera === null ? "no active known objects to reset" : `no active known objects for ${camera} to reset`);
    }
    return;
  }

  const nowUtc = new Date().toISOString();
  const resetIds = new Set(toReset.map((o) => o.id));
  const result = await store.update((current) => current.map((o) => (resetIds.has(o.id) ? resetKnownObject(o, nowUtc) : o)));
  if (!result.ok) {
    console.log(`Refused: ${result.problem}`);
    process.exitCode = 1;
    return;
  }

  // Un-hide their events too: a reset that left the flag on would look
  // undone the moment the detector's next pass re-reads a store it never
  // itself rewrote (agent/known-objects.mjs's own note for this command).
  const eventsFile = path.join(stateDir, "events.db");
  const haveEvents = existsSync(eventsFile);
  let cleared = 0;
  if (haveEvents) {
    const db = openEventsDb(eventsFile);
    try {
      for (const objId of resetIds) cleared += db.clearSuppressed(objId);
    } finally {
      db.close();
    }
  }

  for (const o of toReset) console.log(`reset  ${o.id}  ${o.cameraId}  ${o.kind}`);
  console.log(`\n${toReset.length} known object(s) reset` +
    (haveEvents ? `; ${cleared} event(s) shown again` : "; no events database here — nothing to un-hide"));
}

// B1 phase-1 brief, piece 4. Shows the box's own cloud-checkin identity
// (agent/device-identity.mjs), creating it on first use -- never the
// private key, which that module never even returns to this function.
async function cmdIdentity() {
  const stateDir = flag("state-dir") ?? process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  const identity = await loadOrCreateIdentity(stateDir);
  if (identity.created) {
    console.log(`created a new device identity in ${stateDir}`);
    console.log();
  }
  console.log(`deviceId:     ${identity.deviceId}`);
  console.log(`createdAtUtc: ${identity.createdAtUtc}`);
  console.log(`publicKeyPem:`);
  console.log(identity.publicKeyPem.trim());
}

// B1 phase-1 brief, piece 4. --dry-run is the only mode this brief builds:
// it prints exactly the payload sendCheckin() would send next, and its
// signature, and sends nothing -- composeCheckin() itself does no network
// I/O, so there is nothing here that could accidentally send for real.
async function cmdCheckin() {
  const stateDir = flag("state-dir") ?? process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  if (!args.includes("--dry-run")) {
    console.error("usage: camctl checkin --dry-run [--state-dir D]\n" +
      "(only --dry-run is implemented here -- camctl never sends a check-in itself)");
    process.exitCode = 2;
    return;
  }
  const state = await readCheckinState(stateDir);
  if (state.kind === "corrupt") {
    console.log(`Refused: ${state.reason}`);
    process.exitCode = 1;
    return;
  }
  const seq = state.seq + 1;
  const composed = await composeCheckin({ stateDir, now: () => new Date(), seq });
  console.log(`dry run -- nothing sent. This is exactly what sendCheckin() would POST next (seq ${seq}):`);
  console.log();
  console.log(composed.canonicalText);
  console.log();
  console.log(`signature (base64): ${composed.signature}`);
  console.log(`deviceId:           ${composed.deviceId}`);
}

const commands = { score: cmdScore, "gate-check": cmdGateCheck,"clean-empty": cmdCleanEmpty, alerts: cmdAlerts, preflight: cmdPreflight, audit: cmdAudit, bench: cmdBench, load: cmdLoad, discover: cmdDiscover, probe: cmdProbe, size: cmdSize, budget: cmdBudget, "known-objects": cmdKnownObjects, identity: cmdIdentity, checkin: cmdCheckin };
const handler = commands[command];
if (!handler) {
  console.log(`camctl <command>

  preflight                     check ffmpeg/ffprobe and permissions
  audit [--state-dir D]         what recovery would do now; read-only (or CAMPLAT_STATE_DIR)
  clean-empty [--state-dir D]   list recordings that hold no video (a restart's stub)
              [--apply]         move them to quarantine and remove their rows
  alerts [--state-dir D]        check health.json, write alerts.json, log what changed
         [--restart-stale]      ask for a recorder restart when recorder_stale is raised, and restart cameras that stopped recording
  discover <cidr> [--raw-dir D] sweep + SADP + ONVIF; D captures raw SADP replies
                  [--iface NAME|ADDR]  the card facing the cameras; default: the card on <cidr>
  probe <ip> [options]          codec, resolution, MEASURED bitrate, retention
  probe <rtsp://...> [options]  same, but the URL is used verbatim — level 3,
                                for when path detection is what failed
  size [options]                disk sizing table for a store
  budget [options]              per-camera bitrate ceiling for a retention target
  score [--state-dir D]         play every Teach-the-AI clip through the live detector and score it
        [--fps N]               replay at N fps instead of the live rate (labelled in the report)
  gate-check [--state-dir D]    replay the recorded substream, the model on every frame and the gate beside it: who the gate would miss
             [--camera ID]      one camera the detector watches (default: every one)
             [--from ISO --to ISO | --hours N]  the footage to replay (default: the last 1 h recorded)
             [--fps N]          replay at N fps instead of the live rate (labelled in the report)
             [--threads N]      model threads, 1 to 8 (default 2)
             [--footage-camera ID]  replay this recording instead (labelled: not the live stream)
  bench [options]              concurrent write throughput of a recording drive
  load --source FILE [options]  N recorders playing a file at once: CPU, write rate, who fell behind
  known-objects [--state-dir D] [--camera ID]  list what has been learned, with its measurements
                --reset --id ID               lapse one object by hand and show its events again
                --camera ID --reset           lapse every active object of that camera
  identity [--state-dir D]      show this box's cloud check-in deviceId and public key (creating it on first use); never the private key
  checkin --dry-run [--state-dir D]  print the next signed check-in payload and its signature; sends nothing

probe options:
  --user U --pass P             or CAMPLAT_USER / CAMPLAT_PASS
  --vendor hikvision|avycon|axis|hanwha|avigilon
  --try-all                     try every known path for the vendor and report
                                which one streams (AVYCON paths vary by model)
  --channel N   --stream main|sub
  --seconds N                   measurement window (default 30, minimum 20)
  --cameras N   --disk-tb N     retention projection

size options:
  --cameras N   --days N        defaults 16 and 30
  --kbps a,b,c                  bitrates to tabulate (default 2000,3000,4000,6000)
  --disks-tb a,b,c              raw disk sizes (default 16,24,32,48,64)

bench options:
  --path DIR   --writers N (cameras per spindle)   --seconds N

load options:
  --path DIR (default /srv/camplat/disk0)   --cameras N (16)   --seconds N (300)
  --segment-seconds N (60)   --kbps N      the source's measured bitrate; without it nothing is judged behind
  --keep                        leave the recordings in DIR/.loadtest-* for inspection

budget options:
  --cameras N  --days N  --disk-tb N  --fill 0.85
  --kbps a,b,c                  check candidate bitrates against the ceiling

example:
  node agent/camctl.mjs budget --cameras 16 --disk-tb 16 --kbps 2000,2500,3000
  node agent/camctl.mjs size --cameras 16 --kbps 3000,4000,6000
  node agent/camctl.mjs discover 192.168.1.0/24 --raw-dir ./sadp-raw
  node agent/camctl.mjs probe 192.168.1.64 --user admin --pass '...' --cameras 23 --disk-tb 16`);
  process.exit(command ? 2 : 0);
}
handler().catch((err) => { console.error(redactRtspUrl(String(err?.stack ?? err))); process.exit(1); });
