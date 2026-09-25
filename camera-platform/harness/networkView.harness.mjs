/** The Network page's merge. The failures feared are the ones the spec names
 *  by name: a counter that resets or wraps read as a negative rate, an
 *  incomplete ARP row treated as a device, a camera whose IP never made it
 *  into the neighbour table, two discovery replies claiming one IP, an OUI
 *  this box's list does not know, and a box with no OUI list at all. Every
 *  one of those must come back as a stated reason, never a zero, a blank, or
 *  a guess. */
import {
  parseIpNeighJson,
  parseProcNetArp,
  parseIpRouteDefaultJson,
  parseProcNetRouteGateway,
  counterRate,
  parseOuiText,
  makerForMac,
  normaliseSadpReply,
  normaliseWsDiscoveryReply,
  detectIpCollisions,
  detectMacChange,
  buildNetworkView,
} from "../dist/networkView.js";
import { check, same, close, report } from "./_assert.mjs";

console.log("networkView");

// ---------------------------------------------------------------------------
// Neighbour table
// ---------------------------------------------------------------------------

check("ip -j neigh: a reachable entry is kept, its MAC normalised", () => {
  const json = JSON.stringify([
    { dst: "192.168.1.10", dev: "eth0", lladdr: "AA-BB-CC-DD-EE-FF", state: ["REACHABLE"] },
  ]);
  const result = parseIpNeighJson(json);
  same(result.kind, "measured", "kind");
  same(result.value, [{ ip: "192.168.1.10", mac: "aa:bb:cc:dd:ee:ff", iface: "eth0", state: "REACHABLE" }], "entry");
});

check("THE FEARED ONE: ip -j neigh drops FAILED, INCOMPLETE, and an all-zero MAC", () => {
  const json = JSON.stringify([
    { dst: "192.168.1.11", dev: "eth0", state: ["FAILED"] },
    { dst: "192.168.1.12", dev: "eth0", state: ["INCOMPLETE"] },
    { dst: "192.168.1.13", dev: "eth0", lladdr: "00:00:00:00:00:00", state: ["STALE"] },
    { dst: "192.168.1.14", dev: "eth0", lladdr: "11:22:33:44:55:66", state: ["STALE"] },
  ]);
  const result = parseIpNeighJson(json);
  same(result.value.map((e) => e.ip), ["192.168.1.14"], "only the resolved one survives");
});

check("ip -j neigh: unparseable JSON and a non-array are both unmeasured, never thrown", () => {
  same(parseIpNeighJson("not json").kind, "unmeasured", "garbage");
  same(parseIpNeighJson('{"not":"an array"}').kind, "unmeasured", "object, not array");
});

check("THE FEARED ONE: /proc/net/arp drops an incomplete row (flags 0x0, all-zero MAC)", () => {
  const text = [
    "IP address       HW type     Flags       HW address            Mask     Device",
    "192.168.1.1      0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0",
    "192.168.1.5      0x1         0x0         00:00:00:00:00:00     *        eth0",
  ].join("\n");
  const result = parseProcNetArp(text);
  same(result.kind, "measured", "kind");
  same(result.value, [{ ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:ff", iface: "eth0", state: "REACHABLE" }], "only the complete row");
});

check("/proc/net/arp: an empty table is unmeasured with a reason, not an empty measured list masquerading as nothing to see", () => {
  same(parseProcNetArp("").kind, "unmeasured", "empty file");
  same(parseProcNetArp("header only\n").kind, "measured", "header with no data rows is a real, empty measurement");
  same(parseProcNetArp("header only\n").value, [], "no rows");
});

// ---------------------------------------------------------------------------
// Default gateway
// ---------------------------------------------------------------------------

check("ip -j route show default: the gateway address is read straight off", () => {
  const json = JSON.stringify([{ dst: "default", gateway: "192.168.1.1", dev: "eth0" }]);
  same(parseIpRouteDefaultJson(json), { kind: "measured", value: "192.168.1.1" }, "gateway");
});

check("ip -j route show default: no route, or a route with no gateway, is unmeasured", () => {
  same(parseIpRouteDefaultJson("[]").kind, "unmeasured", "no route");
  same(parseIpRouteDefaultJson(JSON.stringify([{ dst: "default", dev: "eth0" }])).kind, "unmeasured", "no gateway field");
});

check("THE FEARED ONE: /proc/net/route's little-endian hex is NOT read digit-for-digit", () => {
  // 0101A8C0 read backwards byte-by-byte is C0.A8.01.01 = 192.168.1.1.
  // A naive left-to-right read would wrongly give 01.01.168.192.
  const text = [
    "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    "eth0\t0001A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
  ].join("\n");
  same(parseProcNetRouteGateway(text), { kind: "measured", value: "192.168.1.1" }, "byte-reversed");
});

check("/proc/net/route: a non-gateway default (flags missing the gateway bit) is unmeasured", () => {
  const text = [
    "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0",
  ].join("\n");
  same(parseProcNetRouteGateway(text).kind, "unmeasured", "no gateway bit");
});

// ---------------------------------------------------------------------------
// Counter rates: the wrap/reset failure
// ---------------------------------------------------------------------------

check("counterRate: two ordinary samples a minute apart give Mb/s", () => {
  const prev = { atUtc: "2026-09-23T00:00:00.000Z", bytes: 0 };
  const next = { atUtc: "2026-09-23T00:01:00.000Z", bytes: 7_500_000 }; // 60,000,000 bits / 60s = 1 Mb/s
  const r = counterRate(prev, next);
  same(r.kind, "ok", "kind");
  close(r.mbps, 1, 0.001, "mbps");
});

check("THE FEARED ONE: a smaller second reading is 'counter reset', never a negative rate", () => {
  const prev = { atUtc: "2026-09-23T00:00:00.000Z", bytes: 4_294_000_000 };
  const next = { atUtc: "2026-09-23T00:01:00.000Z", bytes: 1_000 }; // wrapped past a 32-bit counter
  const r = counterRate(prev, next);
  same(r.kind, "counter_reset", "kind, not ok");
  same(typeof r.mbps, "undefined", "no numeric mbps field at all on a reset");
});

check("counterRate: a single sample so far, or a non-positive interval, is unavailable", () => {
  same(counterRate(null, { atUtc: "2026-09-23T00:00:00.000Z", bytes: 0 }).kind, "unavailable", "first sample ever");
  const same_ts = { atUtc: "2026-09-23T00:00:00.000Z", bytes: 0 };
  same(counterRate(same_ts, { atUtc: "2026-09-23T00:00:00.000Z", bytes: 100 }).kind, "unavailable", "zero interval");
});

check("counterRate: an UNCHANGED byte count is a real zero (idle link), never a counter reset", () => {
  // The reset guard is `next.bytes < prev.bytes` -- strictly less than. Two
  // consecutive samples with the identical count (very plausible overnight
  // on a camera-only segment) must fall through to a measured 0 Mb/s, not
  // into the reset branch: `<=` here would be the inverse of build rule 5 --
  // a real zero reported as a fabricated "the interface reset" verdict.
  const prev = { atUtc: "2026-09-23T00:00:00.000Z", bytes: 5_000_000 };
  const next = { atUtc: "2026-09-23T00:01:00.000Z", bytes: 5_000_000 };
  const r = counterRate(prev, next);
  same(r, { kind: "ok", mbps: 0 }, "unchanged bytes -> ok, 0 Mb/s");
});

// ---------------------------------------------------------------------------
// OUI list
// ---------------------------------------------------------------------------

const OUI_TEXT = [
  "OUI/MA-L                                                     Organization",
  "company_id                    Organization",
  "",
  "00-40-8C   (hex)\t\tAXIS COMMUNICATIONS AB",
  "00408C     (base 16)\t\tAXIS COMMUNICATIONS AB",
  "\t\t\tLidingovagen 5",
  "",
  "44-19-B6   (hex)\t\tHangzhou Hikvision Digital Technology Co.,Ltd.",
  "4419B6     (base 16)\t\tHangzhou Hikvision Digital Technology Co.,Ltd.",
].join("\n");

check("parseOuiText: reads the (hex) lines and normalises the prefix", () => {
  const lookup = parseOuiText(OUI_TEXT);
  same(lookup.get("00:40:8c"), "AXIS COMMUNICATIONS AB", "axis");
  same(lookup.get("44:19:b6"), "Hangzhou Hikvision Digital Technology Co.,Ltd.", "hikvision");
  same(lookup.size, 2, "the (base 16) duplicate lines are not double-counted");
});

check("THE FEARED ONE: an OUI not in this box's list is 'unknown_oui', never a guessed vendor", () => {
  const lookup = parseOuiText(OUI_TEXT);
  const result = makerForMac("de:ad:be:ef:00:01", lookup);
  same(result.kind, "unknown_oui", "kind");
  same(result.reason.includes("de:ad:be"), true, "names the prefix that was not found");
});

check("THE FEARED ONE: no OUI list on this box is 'no maker list on this box' for every MAC, never a guess", () => {
  const result = makerForMac("44:19:b6:00:00:01", null);
  same(result, { kind: "no_list", reason: "no maker list on this box" }, "no list");
});

check("makerForMac: a known OUI resolves through either MAC punctuation style", () => {
  const lookup = parseOuiText(OUI_TEXT);
  same(makerForMac("44-19-B6-AA-BB-CC", lookup).maker, "Hangzhou Hikvision Digital Technology Co.,Ltd.", "dashes");
  same(makerForMac("4419b6aabbcc", lookup).maker, "Hangzhou Hikvision Digital Technology Co.,Ltd.", "bare hex");
});

// ---------------------------------------------------------------------------
// Discovery replies and same-IP-different-MAC
// ---------------------------------------------------------------------------

check("normaliseSadpReply and normaliseWsDiscoveryReply carry each protocol's own shape", () => {
  const sadp = normaliseSadpReply(
    { mac: "44-19-B6-AA-BB-CC", ip: "192.168.1.20", model: "DS-2CD2143", serial: "SN123", firmware: "V5.5.0" },
    "2026-09-23T00:00:00.000Z",
  );
  same(sadp, {
    source: "sadp", atUtc: "2026-09-23T00:00:00.000Z", ip: "192.168.1.20",
    mac: "44:19:b6:aa:bb:cc", model: "DS-2CD2143", firmware: "V5.5.0", serial: "SN123",
  }, "sadp");

  const wsd = normaliseWsDiscoveryReply(
    { ip: "192.168.1.21", xaddrs: ["http://192.168.1.21/onvif/device_service"], hardware: "Model X" },
    "2026-09-23T00:00:01.000Z",
  );
  same(wsd, {
    source: "wsdiscovery", atUtc: "2026-09-23T00:00:01.000Z", ip: "192.168.1.21",
    mac: null, model: "Model X", firmware: null, serial: null,
  }, "wsdiscovery: no MAC, no firmware -- ONVIF's scopes do not carry either");
});

check("THE FEARED ONE: two replies in one run claiming the same IP with different MACs are both kept, never merged", () => {
  const a = normaliseSadpReply({ mac: "aa:aa:aa:aa:aa:aa", ip: "192.168.1.30", model: "m1", serial: null, firmware: null }, "2026-09-23T00:00:00.000Z");
  const b = normaliseSadpReply({ mac: "bb:bb:bb:bb:bb:bb", ip: "192.168.1.30", model: "m2", serial: null, firmware: null }, "2026-09-23T00:00:01.000Z");
  const c = normaliseWsDiscoveryReply({ ip: "192.168.1.31", xaddrs: [] }, "2026-09-23T00:00:02.000Z"); // no MAC: cannot collide
  const collisions = detectIpCollisions([a, b, c]);
  same(collisions.length, 1, "exactly one IP in collision");
  same(collisions[0].ip, "192.168.1.30", "which one");
  same(collisions[0].macs.sort(), ["aa:aa:aa:aa:aa:aa", "bb:bb:bb:bb:bb:bb"], "both MACs named");
  same(collisions[0].replies.length, 2, "both replies kept");
});

check("detectIpCollisions: one MAC per IP, or an IP with no MAC at all, is not a collision", () => {
  const a = normaliseSadpReply({ mac: "aa:aa:aa:aa:aa:aa", ip: "192.168.1.40", model: null, serial: null, firmware: null }, "2026-09-23T00:00:00.000Z");
  const b = normaliseWsDiscoveryReply({ ip: "192.168.1.40", xaddrs: [] }, "2026-09-23T00:00:01.000Z"); // same IP, no MAC to compare
  same(detectIpCollisions([a, b]), [], "no collision");
});

// ---------------------------------------------------------------------------
// MAC history / change detection
// ---------------------------------------------------------------------------

check("detectMacChange: no history for this IP is 'first_seen', not 'changed'", () => {
  same(detectMacChange("192.168.1.50", "aa:aa:aa:aa:aa:aa", [], "2026-09-23T00:00:00.000Z"), { kind: "first_seen" }, "first seen");
});

check("detectMacChange: the same MAC as history is 'unchanged'", () => {
  const history = [{ ip: "192.168.1.50", mac: "aa:aa:aa:aa:aa:aa", firstSeenUtc: "2026-09-01T00:00:00.000Z", lastSeenUtc: "2026-09-22T00:00:00.000Z" }];
  same(detectMacChange("192.168.1.50", "aa:aa:aa:aa:aa:aa", history, "2026-09-23T00:00:00.000Z"), { kind: "unchanged" }, "unchanged");
});

check("THE FEARED ONE: a different MAC than the most recent history entry is reported as a measurement, not a verdict", () => {
  const history = [
    { ip: "192.168.1.50", mac: "aa:aa:aa:aa:aa:aa", firstSeenUtc: "2026-09-01T00:00:00.000Z", lastSeenUtc: "2026-09-10T00:00:00.000Z" },
    { ip: "192.168.1.50", mac: "bb:bb:bb:bb:bb:bb", firstSeenUtc: "2026-09-11T00:00:00.000Z", lastSeenUtc: "2026-09-22T00:00:00.000Z" },
  ];
  const result = detectMacChange("192.168.1.50", "cc:cc:cc:cc:cc:cc", history, "2026-09-23T00:00:00.000Z");
  same(result, {
    kind: "changed", from: "bb:bb:bb:bb:bb:bb", to: "cc:cc:cc:cc:cc:cc",
    note: "MAC for 192.168.1.50 changed from bb:bb:bb:bb:bb:bb to cc:cc:cc:cc:cc:cc at 2026-09-23T00:00:00.000Z",
  }, "compares against the LATEST history entry, not the first");
});

// ---------------------------------------------------------------------------
// The full merge
// ---------------------------------------------------------------------------

const AT = "2026-09-23T12:00:00.000Z";

function baseInput(overrides = {}) {
  return {
    atUtc: AT,
    cameras: [],
    neighbours: [],
    discovery: [],
    probes: new Map(),
    recording: new Map(),
    macHistory: [],
    ouiLookup: parseOuiText(OUI_TEXT),
    ...overrides,
  };
}

check("buildNetworkView: a fully-measured camera carries every field as a value", () => {
  const view = buildNetworkView(baseInput({
    cameras: [{ cameraId: "cam-1", name: "Front door", host: "192.168.1.20" }],
    neighbours: [{ ip: "192.168.1.20", mac: "44:19:b6:aa:bb:cc", iface: "eth0", state: "REACHABLE" }],
    discovery: [normaliseSadpReply(
      { mac: "44:19:b6:aa:bb:cc", ip: "192.168.1.20", model: "DS-2CD2143", serial: "SN1", firmware: "V5.5.0" },
      "2026-09-23T11:59:00.000Z",
    )],
    probes: new Map([["cam-1", { lastAnsweredUtc: "2026-09-23T11:59:50.000Z", rttMs: 12, consecutiveMisses: 0 }]]),
    recording: new Map([["cam-1", { lastSealedUtc: "2026-09-23T11:59:55.000Z", measuredKbps: 2100, fps: 15 }]]),
  }));
  const row = view.cameras[0];
  same(row.ip, { kind: "measured", value: "192.168.1.20" }, "ip");
  same(row.mac, { kind: "measured", value: "44:19:b6:aa:bb:cc" }, "mac");
  same(row.maker, { kind: "known", maker: "Hangzhou Hikvision Digital Technology Co.,Ltd." }, "maker");
  same(row.model, { kind: "measured", value: "DS-2CD2143" }, "model");
  same(row.firmware, { kind: "measured", value: "V5.5.0" }, "firmware");
  same(row.serial, { kind: "measured", value: "SN1" }, "serial");
  same(row.lastAnsweredUtc, { kind: "measured", value: "2026-09-23T11:59:50.000Z" }, "lastAnswered");
  same(row.rttMs, { kind: "measured", value: 12 }, "rtt");
  same(row.lastSealedUtc, { kind: "measured", value: "2026-09-23T11:59:55.000Z" }, "lastSealed");
  same(row.measuredKbps, { kind: "measured", value: 2100 }, "measuredKbps");
  same(row.fps, { kind: "measured", value: 15 }, "fps");
  same(row.macChange, { kind: "first_seen" }, "macChange: no history yet");
});

check("THE FEARED ONE: a camera whose IP is absent from the neighbour table carries a reason at every field that depends on it, never a blank", () => {
  const view = buildNetworkView(baseInput({
    cameras: [{ cameraId: "cam-2", name: "Back gate", host: "192.168.1.99" }],
    probes: new Map([["cam-2", { lastAnsweredUtc: null, rttMs: null, consecutiveMisses: 4 }]]),
  }));
  const row = view.cameras[0];
  same(row.ip, { kind: "measured", value: "192.168.1.99" }, "ip is still known -- it's configured");
  same(row.mac, { kind: "unmeasured", reason: "not in this NVR's neighbour table" }, "THE spec's own words");
  same(row.maker.kind, "unknown_oui", "no MAC means no maker");
  same(row.maker.reason, "no MAC to look up", "why");
  same(row.model, { kind: "unmeasured", reason: "not reported" }, "no discovery reply either");
  same(row.lastAnsweredUtc, { kind: "unmeasured", reason: "no answer yet" }, "never answered");
  same(row.consecutiveMisses, 4, "the miss count is a real number, not folded into the reason");
  same(row.lastSealedUtc, { kind: "unmeasured", reason: "no sealed segment yet" }, "no recording fact given");
  same(row.measuredKbps, { kind: "unmeasured", reason: "not measured" }, "bitrate");
  same(row.fps, { kind: "unmeasured", reason: "not measured" }, "fps: no reusable measurement was supplied");
});

check("THE FEARED ONE: a camera never connected to reads 'not checked', never '0 misses' (a blank is not a zero)", () => {
  const view = buildNetworkView(baseInput({
    cameras: [
      { cameraId: "cam-new", name: "Just added", host: "192.168.1.70" },
      { cameraId: "cam-nohost", name: "No address", host: null },
    ],
    probes: new Map(),
  }));
  const [fresh, nohost] = view.cameras;
  same(fresh.consecutiveMisses, null, "no probe yet: no miss count at all, not 0");
  same(fresh.lastAnsweredUtc, { kind: "unmeasured", reason: "not checked yet" }, "says it has not been tried");
  same(fresh.rttMs, { kind: "unmeasured", reason: "not checked yet" }, "same for the round trip");
  same(nohost.consecutiveMisses, null, "no address: never probed, not 0 misses");
  same(nohost.lastAnsweredUtc, { kind: "unmeasured", reason: "not checked: no address for this camera" }, "and says why");
});

check("buildNetworkView: an unconfigured host is 'no host configured', not an empty string", () => {
  const view = buildNetworkView(baseInput({ cameras: [{ cameraId: "cam-3", name: "Spare", host: null }] }));
  same(view.cameras[0].ip, { kind: "unmeasured", reason: "no host configured" }, "ip");
  same(view.cameras[0].mac, { kind: "unmeasured", reason: "no IP to look up" }, "mac follows from no ip");
});

check("buildNetworkView: a camera's own MAC change against history surfaces on its row", () => {
  const view = buildNetworkView(baseInput({
    cameras: [{ cameraId: "cam-4", name: "Loading dock", host: "192.168.1.50" }],
    neighbours: [{ ip: "192.168.1.50", mac: "cc:cc:cc:cc:cc:cc", iface: "eth0", state: "REACHABLE" }],
    macHistory: [{ ip: "192.168.1.50", mac: "bb:bb:bb:bb:bb:bb", firstSeenUtc: "2026-09-01T00:00:00.000Z", lastSeenUtc: "2026-09-22T00:00:00.000Z" }],
  }));
  same(view.cameras[0].macChange, {
    kind: "changed", from: "bb:bb:bb:bb:bb:bb", to: "cc:cc:cc:cc:cc:cc",
    note: `MAC for 192.168.1.50 changed from bb:bb:bb:bb:bb:bb to cc:cc:cc:cc:cc:cc at ${AT}`,
  }, "a swapped camera or a shared address -- a measurement either way");
});

check("buildNetworkView: an unrelated neighbour becomes an 'other device', a configured camera's own IP does not", () => {
  const view = buildNetworkView(baseInput({
    cameras: [{ cameraId: "cam-5", name: "Camera", host: "192.168.1.20" }],
    neighbours: [
      { ip: "192.168.1.20", mac: "44:19:b6:aa:bb:cc", iface: "eth0", state: "REACHABLE" },
      { ip: "192.168.1.21", mac: "00:40:8c:11:22:33", iface: "eth0", state: "STALE" },
    ],
  }));
  same(view.otherDevices.length, 1, "only the non-camera neighbour");
  same(view.otherDevices[0], {
    ip: "192.168.1.21", mac: { kind: "measured", value: "00:40:8c:11:22:33" },
    maker: { kind: "known", maker: "AXIS COMMUNICATIONS AB" },
    iface: { kind: "measured", value: "eth0" }, state: { kind: "measured", value: "STALE" },
    model: { kind: "unmeasured", reason: "no discovery reply for this device" },
    firmware: { kind: "unmeasured", reason: "no discovery reply for this device" },
  }, "other device row");
});

check("buildNetworkView: ipCollisions from a discovery run are surfaced on the whole view", () => {
  const view = buildNetworkView(baseInput({
    discovery: [
      normaliseSadpReply({ mac: "aa:aa:aa:aa:aa:aa", ip: "192.168.1.60", model: null, serial: null, firmware: null }, AT),
      normaliseSadpReply({ mac: "bb:bb:bb:bb:bb:bb", ip: "192.168.1.60", model: null, serial: null, firmware: null }, AT),
    ],
  }));
  same(view.ipCollisions.length, 1, "one collision");
  same(view.ipCollisions[0].ip, "192.168.1.60", "the shared IP");
});

report("networkView");
