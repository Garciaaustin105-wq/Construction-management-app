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
import { sweep } from "./sweep.mjs";
import { discoverSadp } from "./sadp.mjs";
import { discoverOnvif } from "./wsdiscovery.mjs";
import { probeStream, measureBitrate } from "./media.mjs";
import { buildRtspUrl, redactRtspUrl, candidatePaths, urlForPath } from "../dist/rtsp.js";
import { vendorFromMac, normaliseMac } from "../dist/camera.js";
import { computeRetentionDays, requiredBytesForDays, usableBytesFromRaw, TERABYTE } from "../dist/retention.js";

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
  if (!cidr) { console.error("usage: camctl discover <cidr> [--raw-dir DIR]"); process.exit(2); }

  console.log(`sweeping ${cidr} for open 554/80 ...`);
  const hosts = await sweep(cidr, [554, 80], {
    onHost: (h) => console.log(`  found ${h.ip}  ports ${h.openPorts.join(",")}`),
  });

  console.log(`\nSADP inquiry (Hikvision, answers with ONVIF disabled) ...`);
  const rawDir = flag("raw-dir");
  const sadp = await discoverSadp({ rawDir }).catch((e) => {
    console.log(`  SADP failed: ${e.message}`);
    return [];
  });
  for (const d of sadp) {
    console.log(`  ${d.ip ?? d.from}  ${d.mac ?? "?"}  ${d.model ?? "?"}  fw ${d.firmware ?? "?"}  sn ${d.serial ?? "?"}`);
  }
  if (rawDir) console.log(`  raw SADP responses written to ${rawDir}`);

  console.log(`\nONVIF WS-Discovery ...`);
  const onvif = await discoverOnvif().catch((e) => {
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

const commands = { preflight: cmdPreflight, discover: cmdDiscover, probe: cmdProbe, size: cmdSize };
const handler = commands[command];
if (!handler) {
  console.log(`camctl <command>

  preflight                     check ffmpeg/ffprobe and permissions
  discover <cidr> [--raw-dir D] sweep + SADP + ONVIF; D captures raw SADP replies
  probe <ip> [options]          codec, resolution, MEASURED bitrate, retention
  size [options]                disk sizing table for a store

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

example:
  node agent/camctl.mjs size --cameras 16 --kbps 3000,4000,6000
  node agent/camctl.mjs discover 192.168.1.0/24 --raw-dir ./sadp-raw
  node agent/camctl.mjs probe 192.168.1.64 --user admin --pass '...' --cameras 23 --disk-tb 16`);
  process.exit(command ? 2 : 0);
}
handler().catch((err) => { console.error(redactRtspUrl(String(err?.stack ?? err))); process.exit(1); });
