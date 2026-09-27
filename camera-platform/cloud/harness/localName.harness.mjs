// cloud/harness/localName.harness.mjs — cloud/contracts/localName.ts
//
// FEARED: a "private" check that lets a public IP address through onto a
// name the app will trust as LAN-local (SSRF-shaped risk once this name is
// ever used to fetch anything); a device id or zone that slips past its
// charset check and ends up embedded in a hostname a certificate gets
// issued for; an off-by-one at the 172.16/12 edges or at the 63/253 length
// limits; and a renewal check that trusts a garbage timestamp instead of
// renewing.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { localHostname, parseLocalHostname, certRenewalDue } from "../dist/cloud/contracts/localName.js";

console.log("localName");

// ---- Fixtures. Every expected value below is written out literally per
// build rule (compute expected values by hand, never by calling the code
// under test).

const DEVICE_ID_UPPER = "ABCDEFGH234567AB"; // 16 chars, base32 [a-z2-7] once lowercased
const DEVICE_ID_LOWER = "abcdefgh234567ab";
const ZONE = "nvr.example.com";

// ---- localHostname: success shape, uppercase folding ----

check("localHostname: builds the dashed-ip.deviceid.zone hostname and lowercases the device id", () => {
  same(localHostname(DEVICE_ID_UPPER, "192.168.1.50", ZONE), {
    ok: true,
    hostname: "192-168-1-50.abcdefgh234567ab.nvr.example.com",
  });
  // already-lowercase input is unaffected
  same(localHostname(DEVICE_ID_LOWER, "192.168.1.50", ZONE), {
    ok: true,
    hostname: "192-168-1-50.abcdefgh234567ab.nvr.example.com",
  });
});

// ---- private-range checks ----

check("localHostname: a public IP is refused as not_private_ip -- 8.8.8.8, 172.32.0.1, 192.169.0.1", () => {
  same(localHostname(DEVICE_ID_UPPER, "8.8.8.8", ZONE), { ok: false, reason: "not_private_ip" });
  same(localHostname(DEVICE_ID_UPPER, "172.32.0.1", ZONE), { ok: false, reason: "not_private_ip" });
  same(localHostname(DEVICE_ID_UPPER, "192.169.0.1", ZONE), { ok: false, reason: "not_private_ip" });
});

check("localHostname: the 172.16/12 edges -- 172.16.0.0 and 172.31.255.255 are both ok", () => {
  same(localHostname(DEVICE_ID_UPPER, "172.16.0.0", ZONE), {
    ok: true,
    hostname: "172-16-0-0.abcdefgh234567ab.nvr.example.com",
  });
  same(localHostname(DEVICE_ID_UPPER, "172.31.255.255", ZONE), {
    ok: true,
    hostname: "172-31-255-255.abcdefgh234567ab.nvr.example.com",
  });
  // one tick outside either edge is refused
  same(localHostname(DEVICE_ID_UPPER, "172.15.255.255", ZONE), { ok: false, reason: "not_private_ip" });
  same(localHostname(DEVICE_ID_UPPER, "172.32.0.0", ZONE), { ok: false, reason: "not_private_ip" });
});

check("localHostname: 10/8 and 192.168/16 are private", () => {
  same(localHostname(DEVICE_ID_UPPER, "10.0.0.0", ZONE), {
    ok: true,
    hostname: "10-0-0-0.abcdefgh234567ab.nvr.example.com",
  });
  same(localHostname(DEVICE_ID_UPPER, "10.255.255.255", ZONE), {
    ok: true,
    hostname: "10-255-255-255.abcdefgh234567ab.nvr.example.com",
  });
  same(localHostname(DEVICE_ID_UPPER, "192.168.255.255", ZONE), {
    ok: true,
    hostname: "192-168-255-255.abcdefgh234567ab.nvr.example.com",
  });
});

check("localHostname: a malformed address is bad_ip, not not_private_ip", () => {
  same(localHostname(DEVICE_ID_UPPER, "192.168.1", ZONE), { ok: false, reason: "bad_ip" });
  same(localHostname(DEVICE_ID_UPPER, "192.168.1.999", ZONE), { ok: false, reason: "bad_ip" });
  same(localHostname(DEVICE_ID_UPPER, "not-an-ip", ZONE), { ok: false, reason: "bad_ip" });
});

// ---- device id checks ----

check("localHostname: bad_device_id for the wrong length or an out-of-alphabet character", () => {
  same(localHostname("abcdefg234567ab", "192.168.1.50", ZONE), { ok: false, reason: "bad_device_id" }); // 15 chars, one short
  same(localHostname("a".repeat(33), "192.168.1.50", ZONE), { ok: false, reason: "bad_device_id" }); // 33 chars, one over the 32 max
  same(localHostname("abcdefgh01234567", "192.168.1.50", ZONE), { ok: false, reason: "bad_device_id" }); // contains 0 and 1, outside a-z2-7
});

check("localHostname: 32 characters (the maximum) is accepted", () => {
  const maxId = "abcdefghijklmnopqrstuvwxyz234567"; // 26 letters + digits 2-7 = 32 chars
  eq(maxId.length, 32, "fixture sanity");
  same(localHostname(maxId, "192.168.1.50", ZONE), {
    ok: true,
    hostname: "192-168-1-50.abcdefghijklmnopqrstuvwxyz234567.nvr.example.com",
  });
});

// ---- zone checks ----

check("localHostname: bad_zone for empty, leading dot, doubled dot, bad char and leading hyphen", () => {
  same(localHostname(DEVICE_ID_UPPER, "192.168.1.50", ""), { ok: false, reason: "bad_zone" });
  same(localHostname(DEVICE_ID_UPPER, "192.168.1.50", ".nvr.example.com"), { ok: false, reason: "bad_zone" });
  same(localHostname(DEVICE_ID_UPPER, "192.168.1.50", "nvr..example.com"), { ok: false, reason: "bad_zone" });
  same(localHostname(DEVICE_ID_UPPER, "192.168.1.50", "nvr_example.com"), { ok: false, reason: "bad_zone" });
  same(localHostname(DEVICE_ID_UPPER, "192.168.1.50", "-nvr.example.com"), { ok: false, reason: "bad_zone" });
});

// ---- length limits ----

check("localHostname: a single zone label over 63 characters is too_long even when the total is short", () => {
  const label63 = "e".repeat(63);
  const label64 = "e".repeat(64);
  same(localHostname(DEVICE_ID_UPPER, "192.168.1.50", label63), {
    ok: true,
    hostname: `192-168-1-50.abcdefgh234567ab.${label63}`,
  });
  same(localHostname(DEVICE_ID_UPPER, "192.168.1.50", label64), { ok: false, reason: "too_long" });
});

check("localHostname: total hostname length is ok at exactly 253 and too_long at 254", () => {
  const maxId = "abcdefghijklmnopqrstuvwxyz234567"; // 32 chars
  // ipLabel(12) + "." + maxId(32) + "." = 46 chars of fixed prefix.
  const zone253 = Array(4).fill("d".repeat(51)).join("."); // 51*4 + 3 dots = 207 -> total 253
  const zone254 = ["d".repeat(52), "d".repeat(51), "d".repeat(51), "d".repeat(51)].join("."); // 205 + 3 = 208 -> total 254
  eq(zone253.length, 207, "fixture sanity: zone253");
  eq(zone254.length, 208, "fixture sanity: zone254");
  const okResult = localHostname(maxId, "192.168.1.50", zone253);
  same(okResult, { ok: true, hostname: `192-168-1-50.${maxId}.${zone253}` });
  eq(okResult.ok ? okResult.hostname.length : -1, 253, "fixture sanity: total is 253");
  same(localHostname(maxId, "192.168.1.50", zone254), { ok: false, reason: "too_long" });
});

// ---- parseLocalHostname: round trip ----

check("parseLocalHostname: round-trips what localHostname built, lowercasing the device id", () => {
  const built = localHostname(DEVICE_ID_UPPER, "192.168.1.50", ZONE);
  eq(built.ok, true, "fixture sanity: build succeeded");
  same(parseLocalHostname(built.hostname, ZONE), { ok: true, lanIp: "192.168.1.50", deviceId: DEVICE_ID_LOWER });
});

check("parseLocalHostname: a zone mismatch, both wrong suffix and wrong label count", () => {
  const hostname = "192-168-1-50.abcdefgh234567ab.nvr.example.com";
  same(parseLocalHostname(hostname, "other.zone.com"), { ok: false, reason: "zone_mismatch" });
  same(parseLocalHostname("abcdefgh234567ab.nvr.example.com", ZONE), { ok: false, reason: "zone_mismatch" });
});

check("parseLocalHostname: bad_ip when the dashed label does not decode to a dotted-quad", () => {
  same(parseLocalHostname(`not-an-ip-label.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "bad_ip" });
});

check("parseLocalHostname: not_private_ip when the decoded address is public", () => {
  same(parseLocalHostname(`8-8-8-8.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "not_private_ip" });
});

check("parseLocalHostname: bad_device_id when the device-id label is the wrong shape", () => {
  same(parseLocalHostname(`192-168-1-50.ab.${ZONE}`, ZONE), { ok: false, reason: "bad_device_id" });
});

// ---- certRenewalDue ----

const THIRTY_DAYS_MS = 2592000000; // 30 * 24 * 60 * 60 * 1000, computed by hand

check("certRenewalDue: exactly 30 days out is due", () => {
  same(certRenewalDue(THIRTY_DAYS_MS, 0), true);
});

check("certRenewalDue: one millisecond past 30 days out is not yet due", () => {
  same(certRenewalDue(THIRTY_DAYS_MS + 1, 0), false);
});

check("certRenewalDue: already past expiry is due", () => {
  same(certRenewalDue(1000, 5000), true);
});

check("certRenewalDue: a non-finite input is always due", () => {
  same(certRenewalDue(NaN, 0), true);
  same(certRenewalDue(Infinity, 0), true);
  same(certRenewalDue(1000, -Infinity), true);
  same(certRenewalDue(1000, NaN), true);
});

// ---- NEW RULE: a dotted-quad group with a leading zero is bad_ip ----
// (contract updated 2026-09-27; code not yet changed -- these are expected
// to FAIL until localHostname's and parseLocalHostname's group parsers
// reject a multi-digit group starting with "0". A lone "0" group is fine.)

check("localHostname: a leading-zero octet is bad_ip, not accepted as octal-looking decimal", () => {
  same(localHostname(DEVICE_ID_UPPER, "010.0.0.1", ZONE), { ok: false, reason: "bad_ip" });
  same(localHostname(DEVICE_ID_UPPER, "192.168.001.001", ZONE), { ok: false, reason: "bad_ip" });
  same(localHostname(DEVICE_ID_UPPER, "10.0.0.01", ZONE), { ok: false, reason: "bad_ip" });
});

check("localHostname: a lone \"0\" octet is not a leading zero -- still accepted", () => {
  same(localHostname(DEVICE_ID_UPPER, "10.0.0.1", ZONE), {
    ok: true,
    hostname: "10-0-0-1.abcdefgh234567ab.nvr.example.com",
  });
  same(localHostname(DEVICE_ID_UPPER, "192.168.0.0", ZONE), {
    ok: true,
    hostname: "192-168-0-0.abcdefgh234567ab.nvr.example.com",
  });
});

check("parseLocalHostname: a leading-zero octet in the dashed ip label is bad_ip", () => {
  same(parseLocalHostname(`010-0-0-1.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "bad_ip" });
  same(parseLocalHostname(`192-168-001-001.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "bad_ip" });
  same(parseLocalHostname(`10-0-0-01.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "bad_ip" });
});

check("parseLocalHostname: a lone \"0\" octet in the dashed ip label is not a leading zero -- still accepted", () => {
  same(parseLocalHostname(`10-0-0-1.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), {
    ok: true,
    lanIp: "10.0.0.1",
    deviceId: DEVICE_ID_LOWER,
  });
});

// ---- MUTATION GUARD: parseLocalHostname's own private-range check, at
// every boundary, built as hostnames by hand (never via localHostname) --
// this is a separate implementation from localHostname's and the round-trip
// test never reaches its boundaries independently. Kills widening
// "second <= 31" to "<= 32" in parseLocalHostname only. ----

check("parseLocalHostname: 10/8 boundary -- 10.0.0.0 and 10.255.255.255 ok, 9.255.255.255 and 11.0.0.0 not_private_ip", () => {
  same(parseLocalHostname(`10-0-0-0.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), {
    ok: true,
    lanIp: "10.0.0.0",
    deviceId: DEVICE_ID_LOWER,
  });
  same(parseLocalHostname(`10-255-255-255.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), {
    ok: true,
    lanIp: "10.255.255.255",
    deviceId: DEVICE_ID_LOWER,
  });
  same(parseLocalHostname(`9-255-255-255.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "not_private_ip" });
  same(parseLocalHostname(`11-0-0-0.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "not_private_ip" });
});

check("parseLocalHostname: 172.16/12 boundary -- 172.16.0.0 and 172.31.255.255 ok, 172.15.255.255 and 172.32.0.0 not_private_ip", () => {
  same(parseLocalHostname(`172-16-0-0.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), {
    ok: true,
    lanIp: "172.16.0.0",
    deviceId: DEVICE_ID_LOWER,
  });
  same(parseLocalHostname(`172-31-255-255.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), {
    ok: true,
    lanIp: "172.31.255.255",
    deviceId: DEVICE_ID_LOWER,
  });
  same(parseLocalHostname(`172-15-255-255.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "not_private_ip" });
  same(parseLocalHostname(`172-32-0-0.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "not_private_ip" });
});

check("parseLocalHostname: 192.168/16 boundary -- 192.168.0.0 and 192.168.255.255 ok, 192.167.255.255 and 192.169.0.0 not_private_ip", () => {
  same(parseLocalHostname(`192-168-0-0.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), {
    ok: true,
    lanIp: "192.168.0.0",
    deviceId: DEVICE_ID_LOWER,
  });
  same(parseLocalHostname(`192-168-255-255.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), {
    ok: true,
    lanIp: "192.168.255.255",
    deviceId: DEVICE_ID_LOWER,
  });
  same(parseLocalHostname(`192-167-255-255.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "not_private_ip" });
  same(parseLocalHostname(`192-169-0-0.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "not_private_ip" });
});

// ---- MUTATION GUARD: the 192.168.0.x lower edge in the FORWARD direction
// too (only .1.x and .255.x were spot-checked before). ----

check("localHostname: the 192.168.0.x lower edge -- 192.168.0.0 and 192.168.0.1 are both ok", () => {
  same(localHostname(DEVICE_ID_UPPER, "192.168.0.0", ZONE), {
    ok: true,
    hostname: "192-168-0-0.abcdefgh234567ab.nvr.example.com",
  });
  same(localHostname(DEVICE_ID_UPPER, "192.168.0.1", ZONE), {
    ok: true,
    hostname: "192-168-0-1.abcdefgh234567ab.nvr.example.com",
  });
});

// ---- MUTATION GUARD: more than four and fewer than four dot-groups are
// bad_ip in both directions. Kills a group-count guard relaxed to
// "< 4" / ">= 4". ----

check("localHostname: five or three dot-groups are bad_ip, not truncated/extended to a dotted-quad", () => {
  same(localHostname(DEVICE_ID_UPPER, "10.0.0.1.5", ZONE), { ok: false, reason: "bad_ip" });
  same(localHostname(DEVICE_ID_UPPER, "10.0.1", ZONE), { ok: false, reason: "bad_ip" });
});

check("parseLocalHostname: five or three dot-groups (once dashes are undone) are bad_ip", () => {
  same(parseLocalHostname(`10-0-0-1-5.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "bad_ip" });
  same(parseLocalHostname(`10-0-1.${DEVICE_ID_LOWER}.${ZONE}`, ZONE), { ok: false, reason: "bad_ip" });
});

report("localName");
