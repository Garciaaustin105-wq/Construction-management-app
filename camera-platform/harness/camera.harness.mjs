/** Camera identity. The failure feared: keying on IP, so a DHCP change
 *  re-onboards the estate and generates thousands of false alerts. */
import { normaliseMac, identityKey, matchIdentity, reconcile, vendorFromMac }
  from "../dist/camera.js";
import { check, eq, throws, report } from "./_assert.mjs";

console.log("camera identity");
const id = (mac, serial = null) => ({ mac, serial });
const known = [{
  cameraId: "cam-14", identity: id("44:19:b6:aa:bb:cc", "DS2CD-0001"),
  lastKnownIp: "192.168.100.14", name: "Corridor B", zone: "building-2",
}];

check("MAC normalises from every common form", () => {
  const want = "aa:bb:cc:dd:ee:ff";
  eq(normaliseMac("AA:BB:CC:DD:EE:FF"), want, "colons upper");
  eq(normaliseMac("aa-bb-cc-dd-ee-ff"), want, "dashes");
  eq(normaliseMac("aabbccddeeff"), want, "bare hex");
  eq(normaliseMac("AA.BB.CC.DD.EE.FF"), want, "dots");
});

check("a malformed MAC is refused, not truncated into a wrong identity", () => {
  throws(() => normaliseMac("aa:bb:cc"), "too short");
  throws(() => normaliseMac("not-a-mac"), "garbage");
  throws(() => normaliseMac(""), "empty");
});

check("THE FEARED ONE: a known camera at a NEW IP is still the same camera", () => {
  const r = reconcile({
    identity: id("44:19:b6:aa:bb:cc", "DS2CD-0001"),
    ip: "192.168.100.207", vendor: "hikvision", model: "DS-2CD2086G2-I",
    firmware: "V5.7.3", source: "sadp", discoveredAtUtc: "2026-09-10T08:00:00.000Z",
  }, known);
  eq(r.kind, "known", "recognised despite the IP change");
  eq(r.camera.cameraId, "cam-14", "same camera");
  eq(r.ipChanged, true, "flagged so the record updates silently");
});

check("a genuinely new camera is reported as new", () => {
  const r = reconcile({
    identity: id("4c:bd:8f:11:22:33", "DS2CD-9999"),
    ip: "192.168.100.51", vendor: "hikvision", model: null,
    firmware: null, source: "arp_probe", discoveredAtUtc: "2026-09-10T08:00:00.000Z",
  }, known);
  eq(r.kind, "new", "kind");
});

check("same MAC, no serials — matched on MAC alone", () => {
  eq(matchIdentity(id("44:19:b6:aa:bb:cc"), id("44:19:b6:aa:bb:cc")),
     { kind: "same", confidence: "mac_only" });
});

check("same MAC and serial is an exact match", () => {
  eq(matchIdentity(id("44:19:b6:aa:bb:cc", "S1"), id("44:19:b6:aa:bb:cc", "S1")),
     { kind: "same", confidence: "exact" });
});

check("same MAC, DIFFERENT serials is ambiguous — never forced to yes or no", () => {
  const m = matchIdentity(id("44:19:b6:aa:bb:cc", "S1"), id("44:19:b6:aa:bb:cc", "S2"));
  eq(m.kind, "ambiguous", "kind");
});

check("same serial on two MACs is ambiguous, not a silent mismatch", () => {
  const m = matchIdentity(id("44:19:b6:aa:bb:cc", "S1"), id("4c:bd:8f:11:22:33", "S1"));
  eq(m.kind, "ambiguous", "kind");
});

check("reconcile surfaces ambiguity for a human instead of picking", () => {
  const r = reconcile({
    identity: id("44:19:b6:aa:bb:cc", "DIFFERENT-SERIAL"),
    ip: "192.168.100.14", vendor: "hikvision", model: null, firmware: null,
    source: "sadp", discoveredAtUtc: "2026-09-10T08:00:00.000Z",
  }, known);
  eq(r.kind, "ambiguous", "kind");
});

check("identityKey is stable across MAC formatting", () => {
  eq(identityKey(id("AA-BB-CC-DD-EE-FF", "S1")), identityKey(id("aa:bb:cc:dd:ee:ff", "S1")));
});

check("identityKey separates two cameras behind one MAC when serials differ", () => {
  if (identityKey(id("aa:bb:cc:dd:ee:ff", "S1")) === identityKey(id("aa:bb:cc:dd:ee:ff", "S2"))) {
    throw new Error("two distinct cameras collapsed to one key");
  }
});

check("vendor from OUI, and no guess when unknown", () => {
  eq(vendorFromMac("44:19:b6:00:00:01"), "hikvision", "hikvision OUI");
  eq(vendorFromMac("00:40:8c:00:00:01"), "axis", "axis OUI");
  eq(vendorFromMac("de:ad:be:ef:00:01"), "generic", "unknown OUI is generic, not a guess");
});

report("camera identity");
