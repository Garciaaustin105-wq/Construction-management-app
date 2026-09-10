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
import { buildRtspUrl, redactRtspUrl } from "../dist/rtsp.js";
import { vendorFromMac, normaliseMac } from "../dist/camera.js";
import { computeRetentionDays, usableBytesFromRaw, TERABYTE } from "../dist/retention.js";

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

  const built = buildRtspUrl({ vendor, ip, channel: Number(flag("channel", "1")), stream: flag("stream", "main") }, creds);
  if (built.kind !== "ok") { console.error(built.message); process.exit(1); }
  console.log(`probing ${built.redacted}`);

  const probe = await probeStream(built.url);
  if (probe.kind !== "ok") { console.error(`unusable: ${probe.reason}`); process.exit(1); }

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

const commands = { preflight: cmdPreflight, discover: cmdDiscover, probe: cmdProbe };
const handler = commands[command];
if (!handler) {
  console.log(`camctl <command>

  preflight                     check ffmpeg/ffprobe and permissions
  discover <cidr> [--raw-dir D] sweep + SADP + ONVIF; D captures raw SADP replies
  probe <ip> [options]          codec, resolution, MEASURED bitrate, retention

probe options:
  --user U --pass P             or CAMPLAT_USER / CAMPLAT_PASS
  --vendor hikvision|axis|hanwha|avigilon
  --channel N   --stream main|sub
  --seconds N                   measurement window (default 30, minimum 20)
  --cameras N   --disk-tb N     retention projection

example:
  node agent/camctl.mjs discover 192.168.1.0/24 --raw-dir ./sadp-raw
  node agent/camctl.mjs probe 192.168.1.64 --user admin --pass '...' --cameras 23 --disk-tb 16`);
  process.exit(command ? 2 : 0);
}
handler().catch((err) => { console.error(redactRtspUrl(String(err?.stack ?? err))); process.exit(1); });
