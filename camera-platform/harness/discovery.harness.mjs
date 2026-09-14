/** SADP and WS-Discovery response parsing, against realistic fixtures.
 *  The failure feared: a field the parser silently drops, so a camera onboards
 *  with no serial and its identity degrades to MAC-only without anyone noticing. */
import dgram from "node:dgram";
import { parseSadpResponse, discoverSadp } from "../agent/sadp.mjs";
import { parseXAddrs, parseScopes, discoverOnvif } from "../agent/wsdiscovery.mjs";
import { normaliseMac, vendorFromMac } from "../dist/camera.js";
import { check, eq, report } from "./_assert.mjs";

console.log("discovery parsers");

const SADP_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<ProbeMatch>
<Uuid>4C4B6F3A-0000-0000-0000-000000000000</Uuid>
<Types>inquiry</Types>
<DeviceType>DS-2CD2086G2-I</DeviceType>
<DeviceDescription>IPCamera</DeviceDescription>
<DeviceSN>DS-2CD2086G2-I20210101AAWR123456789</DeviceSN>
<CommandPort>8000</CommandPort>
<HttpPort>80</HttpPort>
<MAC>44-19-b6-aa-bb-cc</MAC>
<IPv4Address>192.168.1.64</IPv4Address>
<IPv4Gateway>192.168.1.1</IPv4Gateway>
<SoftwareVersion>V5.7.3build 210706</SoftwareVersion>
<BootTime>2026-09-01 08:00:00</BootTime>
<Activated>true</Activated>
</ProbeMatch>`;

check("SADP yields the fields camera identity needs", () => {
  const d = parseSadpResponse(SADP_FIXTURE);
  eq(d.ip, "192.168.1.64", "ip");
  eq(d.mac, "44-19-b6-aa-bb-cc", "mac, raw form");
  eq(d.serial, "DS-2CD2086G2-I20210101AAWR123456789", "serial");
  eq(d.firmware, "V5.7.3build 210706", "firmware");
  eq(d.activated, "true", "activated");
});

check("the SADP MAC normalises and identifies the vendor", () => {
  const d = parseSadpResponse(SADP_FIXTURE);
  eq(normaliseMac(d.mac), "44:19:b6:aa:bb:cc", "normalised");
  eq(vendorFromMac(d.mac), "hikvision", "vendor from OUI");
});

check("firmware v5.7.3 is past v5.5.0 — ONVIF is off by default, SADP still answered", () => {
  const d = parseSadpResponse(SADP_FIXTURE);
  const [major, minor] = d.firmware.replace(/^V/, "").split(".").map(Number);
  if (!(major > 5 || (major === 5 && minor >= 5))) {
    throw new Error("fixture no longer exercises the ONVIF-disabled case");
  }
});

check("DeviceDescription is preferred, DeviceType is the fallback", () => {
  eq(parseSadpResponse(SADP_FIXTURE).model, "IPCamera", "description wins");
  const noDesc = SADP_FIXTURE.replace(/<DeviceDescription>[^<]*<\/DeviceDescription>/, "");
  eq(parseSadpResponse(noDesc).model, "DS-2CD2086G2-I", "falls back to type");
});

check("a response with neither MAC nor IP is rejected, not half-parsed", () => {
  eq(parseSadpResponse("<ProbeMatch><Types>inquiry</Types></ProbeMatch>"), null, "null");
  eq(parseSadpResponse("garbage"), null, "null");
});

check("a partial response still yields what it has, nulls for the rest", () => {
  const d = parseSadpResponse("<ProbeMatch><IPv4Address>10.0.0.9</IPv4Address></ProbeMatch>");
  eq(d.ip, "10.0.0.9", "ip");
  eq(d.mac, null, "mac null, not empty string");
  eq(d.serial, null, "serial null");
});

const WSD_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope">
<SOAP-ENV:Body><d:ProbeMatches xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<d:ProbeMatch>
<d:Scopes>onvif://www.onvif.org/name/Corridor_B onvif://www.onvif.org/hardware/DS-2CD2086G2-I onvif://www.onvif.org/location/Building_2</d:Scopes>
<d:XAddrs>http://192.168.1.64/onvif/device_service http://[fe80::1]/onvif/device_service</d:XAddrs>
</d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

check("WS-Discovery yields every service address", () => {
  const addrs = parseXAddrs(WSD_FIXTURE);
  eq(addrs.length, 2, "two addresses");
  eq(addrs[0], "http://192.168.1.64/onvif/device_service", "first");
});

check("ONVIF scopes decode into name, hardware and location", () => {
  const scopes = parseScopes(WSD_FIXTURE);
  eq(scopes.name, "Corridor B", "underscores become spaces");
  eq(scopes.hardware, "DS-2CD2086G2-I", "hardware");
  eq(scopes.location, "Building 2", "location");
});

check("a probe match with no XAddrs yields nothing, not a broken entry", () => {
  eq(parseXAddrs("<d:ProbeMatch></d:ProbeMatch>"), [], "empty");
  eq(parseScopes("<d:ProbeMatch></d:ProbeMatch>"), {}, "empty");
});

// L12: which card discovery sends from. Fake sockets only: these checks send
// no packet. A real socket opened here is itself a failure, so a discovery
// function that ignores `createSocket` cannot reach the network from a harness.
const realCreateSocket = dgram.createSocket;
dgram.createSocket = () => { throw new Error("harness: a real socket was opened; discovery must use the injected createSocket"); };

function fakeSocket({ refuseMembership = false } = {}) {
  const calls = [];
  const listeners = new Map();
  const socket = {
    calls,
    on(event, fn) { listeners.set(event, fn); return socket; },
    once(event, fn) { listeners.set(event, fn); return socket; },
    bind(port, cb) { calls.push(["bind", port]); setImmediate(cb); },
    setBroadcast(on) { calls.push(["setBroadcast", on]); },
    addMembership(group, iface) {
      calls.push(["addMembership", group, iface]);
      if (refuseMembership) throw Object.assign(new Error("addMembership EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" });
    },
    setMulticastInterface(address) { calls.push(["setMulticastInterface", address]); },
    send(buf, port, host, cb) { calls.push(["send", port, host]); setImmediate(() => cb?.(null)); },
    close() { calls.push(["close"]); },
  };
  return socket;
}
const sent = (s) => s.calls.filter((c) => c[0] === "send").map((c) => c[2]);
const firstIndex = (s, name) => s.calls.findIndex((c) => c[0] === name);

await check("THE FEARED ONE: SADP with a chosen card joins, sends and broadcasts on that card only", async () => {
  const s = fakeSocket();
  await discoverSadp({ waitMs: 0, interfaceAddress: "10.20.0.1", broadcast: "10.20.3.255", createSocket: () => s });
  const joins = s.calls.filter((c) => c[0] === "addMembership");
  eq(joins.map((c) => c[1]).sort(), ["239.255.255.230", "239.255.255.250"], "both groups joined");
  eq(joins.every((c) => c[2] === "10.20.0.1"), true, `each join names the card: ${JSON.stringify(joins)}`);
  const pick = firstIndex(s, "setMulticastInterface");
  eq(pick >= 0 && pick < firstIndex(s, "send"), true, "multicast interface set before the first send");
  eq(s.calls[pick][1], "10.20.0.1", "the chosen address");
  eq(sent(s).sort(), ["10.20.3.255", "239.255.255.230", "239.255.255.250"], "subnet broadcast, never 255.255.255.255 out of every card");
});

await check("SADP with no card chosen behaves as before: the kernel picks", async () => {
  const s = fakeSocket();
  await discoverSadp({ waitMs: 0, createSocket: () => s });
  eq(s.calls.filter((c) => c[0] === "addMembership").every((c) => c[2] === undefined), true, "joins name no card");
  eq(firstIndex(s, "setMulticastInterface"), -1, "no multicast interface set");
  eq(sent(s).includes("255.255.255.255"), true, "limited broadcast as before");
});

await check("THE FEARED ONE: a chosen card that cannot join is an error, not an empty result", async () => {
  const s = fakeSocket({ refuseMembership: true });
  let err = null;
  await discoverSadp({ waitMs: 0, interfaceAddress: "10.20.0.1", broadcast: "10.20.3.255", createSocket: () => s }).catch((e) => { err = e; });
  eq(err !== null && String(err.message).includes("10.20.0.1"), true, `rejects naming the card: ${err?.message}`);
  eq(sent(s), [], "nothing sent");
  eq(s.calls.some((c) => c[0] === "close"), true, "socket closed");
  const loose = fakeSocket({ refuseMembership: true });
  await discoverSadp({ waitMs: 0, createSocket: () => loose });
  eq(sent(loose).length > 0, true, "with no card chosen a failed join is still tolerated, as before");
});

await check("THE FEARED ONE: WS-Discovery with a chosen card joins and sends on that card", async () => {
  const s = fakeSocket();
  await discoverOnvif({ waitMs: 0, interfaceAddress: "10.20.0.1", createSocket: () => s });
  eq(s.calls.filter((c) => c[0] === "addMembership"), [["addMembership", "239.255.255.250", "10.20.0.1"]], "join names the card");
  const pick = firstIndex(s, "setMulticastInterface");
  eq(pick >= 0 && pick < firstIndex(s, "send") && s.calls[pick][1] === "10.20.0.1", true, "interface set before the send");
  eq(sent(s), ["239.255.255.250"], "probe to the group");
  const bare = fakeSocket();
  await discoverOnvif({ waitMs: 0, createSocket: () => bare });
  eq([firstIndex(bare, "setMulticastInterface"), bare.calls.find((c) => c[0] === "addMembership")[2]], [-1, undefined], "no card chosen: as before");
});

await check("a chosen card WS-Discovery cannot join on is an error", async () => {
  const s = fakeSocket({ refuseMembership: true });
  let err = null;
  await discoverOnvif({ waitMs: 0, interfaceAddress: "10.20.0.1", createSocket: () => s }).catch((e) => { err = e; });
  eq(err !== null && String(err.message).includes("10.20.0.1"), true, `rejects naming the card: ${err?.message}`);
  eq([sent(s), s.calls.some((c) => c[0] === "close")], [[], true], "nothing sent, socket closed");
});

dgram.createSocket = realCreateSocket;

report("discovery parsers");
