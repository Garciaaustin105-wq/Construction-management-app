/** ONVIF WS-Discovery — UDP 3702, 239.255.255.250. A published standard, unlike
 *  SADP. Finds cameras that already have ONVIF enabled, which for a Hikvision
 *  estate on firmware v5.5.0+ means the ones somebody turned it on for. */
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";

const WSD_PORT = 3702;
const WSD_GROUP = "239.255.255.250";

function probeEnvelope() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
 xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
 xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
 xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
 <e:Header>
  <w:MessageID>uuid:${randomUUID()}</w:MessageID>
  <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
  <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
 </e:Header>
 <e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`;
}

export function parseXAddrs(xml) {
  const match = /<[^>]*XAddrs[^>]*>([^<]*)</i.exec(xml);
  if (!match) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

export function parseScopes(xml) {
  const match = /<[^>]*Scopes[^>]*>([^<]*)</i.exec(xml);
  if (!match) return {};
  const out = {};
  for (const scope of match[1].trim().split(/\s+/)) {
    const m = /onvif:\/\/www\.onvif\.org\/(name|hardware|location)\/(.+)$/i.exec(scope);
    if (m) out[m[1].toLowerCase()] = decodeURIComponent(m[2]).replace(/_/g, " ");
  }
  return out;
}

export async function discoverOnvif({ waitMs = 4000, onRaw } = {}) {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const found = new Map();

  socket.on("message", (buffer, rinfo) => {
    const xml = buffer.toString("utf8");
    onRaw?.({ from: rinfo.address, bytes: buffer.length, text: xml });
    const xaddrs = parseXAddrs(xml);
    if (xaddrs.length === 0) return;
    found.set(rinfo.address, { ip: rinfo.address, xaddrs, ...parseScopes(xml) });
  });

  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, () => {
      try { socket.addMembership(WSD_GROUP); } catch { /* interface may not support it */ }
      resolve();
    });
  });

  socket.send(Buffer.from(probeEnvelope(), "utf8"), WSD_PORT, WSD_GROUP, () => {});
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  socket.close();
  return [...found.values()];
}
