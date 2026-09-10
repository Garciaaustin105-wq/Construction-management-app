/** CIDR arithmetic. The failure feared: a typo pointing a sweep at a /8. */
import { parseCidr, expandCidr, parseIpv4, formatIpv4 } from "../dist/net.js";
import { check, eq, throws, report } from "./_assert.mjs";

console.log("net");

check("a /24 has 254 usable hosts, network and broadcast excluded", () => {
  const c = parseCidr("192.168.100.0/24");
  eq(c.hostCount, 254, "hosts");
  const hosts = expandCidr("192.168.100.0/24");
  eq(hosts.length, 254, "expanded");
  eq(hosts[0], "192.168.100.1", "first");
  eq(hosts[253], "192.168.100.254", "last");
});

check("a host address inside the range still yields its network", () => {
  eq(parseCidr("192.168.100.57/24").networkAddress, "192.168.100.0", "network");
});

check("THE FEARED ONE: a /8 is refused, not attempted", () => {
  throws(() => expandCidr("10.0.0.0/8"), "/8");
  try { expandCidr("10.0.0.0/8"); } catch (e) {
    if (!e.message.includes("narrow the range")) throw new Error("refusal must say what to do");
  }
});

check("a /16 is at the limit and allowed", () => {
  eq(expandCidr("172.16.0.0/16").length, 65534, "hosts");
});

check("a /32 is a single host", () => {
  eq(expandCidr("192.168.1.5/32"), ["192.168.1.5"], "single");
});

check("a /31 is a two-host point-to-point link", () => {
  eq(expandCidr("192.168.1.4/31"), ["192.168.1.4", "192.168.1.5"], "pair");
});

check("malformed input is refused, not coerced", () => {
  throws(() => parseCidr("192.168.1.0"), "no prefix");
  throws(() => parseCidr("192.168.1.0/33"), "prefix too large");
  throws(() => parseCidr("192.168.1.0/x"), "non-numeric prefix");
  throws(() => parseIpv4("192.168.1"), "too few octets");
  throws(() => parseIpv4("192.168.1.256"), "octet out of range");
  throws(() => parseIpv4("192.168.1.a"), "non-numeric octet");
});

check("ipv4 round-trips including the high bit", () => {
  for (const ip of ["0.0.0.0", "192.168.100.1", "255.255.255.255", "10.0.0.1"]) {
    eq(formatIpv4(parseIpv4(ip)), ip, ip);
  }
});

report("net");
