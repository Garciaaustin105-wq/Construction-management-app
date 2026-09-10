/**
 * Hikvision SADP discovery.
 *
 * SADP answers even when ONVIF is disabled, which since firmware v5.5.0 is the
 * default — so for a Hikvision estate this is the only protocol that reports
 * model, serial and firmware without touching each camera.
 *
 * HONESTY NOTE: SADP is reverse-engineered, not a published standard, and
 * sources disagree on the multicast group (239.255.255.230 vs 239.255.255.250,
 * both on UDP 37020). This probes BOTH and writes every raw response to disk.
 * Run it against a real camera and keep the raw capture — that is what turns
 * this from a best guess into a known quantity.
 */
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SADP_PORT = 37020;
const GROUPS = ["239.255.255.250", "239.255.255.230"];

function probePayload() {
  return `<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${randomUUID().toUpperCase()}</Uuid><Types>inquiry</Types></Probe>`;
}

/** Pull a tag's text out of a small XML document. Deliberately not a parser:
 *  SADP payloads are flat and a dependency is not worth it here. */
function tag(xml, name) {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(xml);
  return match ? match[1].trim() : null;
}

export function parseSadpResponse(text) {
  const mac = tag(text, "MAC");
  const ip = tag(text, "IPv4Address");
  if (!mac && !ip) return null;
  return {
    mac,
    ip,
    model: tag(text, "DeviceDescription") ?? tag(text, "DeviceType"),
    serial: tag(text, "DeviceSN"),
    firmware: tag(text, "SoftwareVersion"),
    bootTime: tag(text, "BootTime"),
    activated: tag(text, "Activated"),
  };
}

/**
 * Broadcast a SADP inquiry and collect replies.
 * `rawDir`, when given, receives one file per response — send those to whoever
 * is maintaining this parser if a camera reports fields it does not read.
 */
export async function discoverSadp({ waitMs = 4000, rawDir = null, onRaw } = {}) {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const responses = [];
  let rawCount = 0;

  socket.on("message", async (buffer, rinfo) => {
    const text = buffer.toString("utf8");
    onRaw?.({ from: rinfo.address, bytes: buffer.length, text });
    if (rawDir) {
      const file = path.join(rawDir, `sadp-${rinfo.address}-${rawCount++}.xml`);
      await writeFile(file, buffer).catch(() => {});
    }
    const parsed = parseSadpResponse(text);
    if (parsed) responses.push({ ...parsed, from: rinfo.address, rawBytes: buffer.length });
  });

  if (rawDir) await mkdir(rawDir, { recursive: true });

  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(SADP_PORT, () => {
      try { socket.setBroadcast(true); } catch { /* not fatal */ }
      for (const group of GROUPS) {
        try { socket.addMembership(group); } catch { /* interface may not support it */ }
      }
      resolve();
    });
  });

  const payload = Buffer.from(probePayload(), "utf8");
  for (const group of GROUPS) {
    socket.send(payload, SADP_PORT, group, () => {});
  }
  socket.send(payload, SADP_PORT, "255.255.255.255", () => {});

  await new Promise((resolve) => setTimeout(resolve, waitMs));
  socket.close();

  // Same camera can answer on both groups; collapse by MAC.
  const byMac = new Map();
  for (const r of responses) byMac.set(r.mac ?? r.ip, r);
  return [...byMac.values()];
}
