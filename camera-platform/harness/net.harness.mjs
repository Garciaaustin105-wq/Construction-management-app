/** CIDR arithmetic. The failure feared: a typo pointing a sweep at a /8. */
import { parseCidr, expandCidr, parseIpv4, formatIpv4, chooseDiscoveryInterface } from "../dist/net.js";
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

// L12: on a two-NIC box the kernel picks the multicast interface from the
// routing table, likely the store LAN, and discovery on the camera network
// finds nothing. Shaped like os.networkInterfaces().
const twoNics = {
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
  enp1s0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", internal: false },
    { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false }],
  enp2s0: [{ address: "10.20.0.1", netmask: "255.255.252.0", family: "IPv4", internal: false }],
};

check("THE FEARED ONE: with no --iface, the camera network's own card is chosen, not whichever the kernel likes", () => {
  const c = chooseDiscoveryInterface(twoNics, { cidr: "10.20.1.0/24" });
  eq(c.kind, "chosen", "kind");
  eq([c.name, c.address, c.broadcast, c.source], ["enp2s0", "10.20.0.1", "10.20.3.255", "cidr"], "the camera NIC, its subnet broadcast");
});

check("--iface by name or by address picks that card and wins over the network", () => {
  const byName = chooseDiscoveryInterface(twoNics, { iface: "enp1s0", cidr: "10.20.1.0/24" });
  eq([byName.kind, byName.address, byName.broadcast, byName.source], ["chosen", "192.168.1.20", "192.168.1.255", "iface"], "by name");
  const byAddr = chooseDiscoveryInterface(twoNics, { iface: "10.20.0.1" });
  eq([byAddr.kind, byAddr.name, byAddr.source], ["chosen", "enp2s0", "iface"], "by address");
});

check("THE FEARED ONE: an --iface that is not on this machine is refused, not ignored", () => {
  const unknown = chooseDiscoveryInterface(twoNics, { iface: "eth9" });
  eq(unknown.kind, "refused", "unknown name");
  eq(unknown.reason.includes("enp2s0"), true, `names the cards there are: ${unknown.reason}`);
  eq(chooseDiscoveryInterface(twoNics, { iface: "10.99.0.1" }).kind, "refused", "address not on this machine");
  eq(chooseDiscoveryInterface({ wg0: [{ address: "fe80::2", netmask: "ffff::", family: "IPv6", internal: false }] }, { iface: "wg0" }).kind, "refused", "a card with no IPv4");
});

check("a card with two IPv4 addresses is refused by name: which one faces the cameras is not a guess", () => {
  const aliased = { enp2s0: [
    { address: "10.20.0.1", netmask: "255.255.255.0", family: "IPv4", internal: false },
    { address: "192.168.0.1", netmask: "255.255.255.0", family: "IPv4", internal: false },
  ] };
  const r = chooseDiscoveryInterface(aliased, { iface: "enp2s0" });
  eq(r.kind, "refused", "kind");
  eq(r.reason.includes("10.20.0.1") && r.reason.includes("192.168.0.1"), true, `lists both: ${r.reason}`);
});

check("two cards on the scanned network is refused; no card on it says the kernel will pick", () => {
  const both = { a: [{ address: "10.20.0.1", netmask: "255.255.0.0", family: "IPv4", internal: false }],
    b: [{ address: "10.20.5.1", netmask: "255.255.0.0", family: "IPv4", internal: false }] };
  eq(chooseDiscoveryInterface(both, { cidr: "10.20.1.0/24" }).kind, "refused", "ambiguous");
  const none = chooseDiscoveryInterface(twoNics, { cidr: "172.16.0.0/24" });
  eq(none.kind, "unchosen", "no card on that network");
  eq(none.reason.includes("--iface"), true, `says what to do: ${none.reason}`);
  eq(chooseDiscoveryInterface(twoNics, {}).kind, "unchosen", "nothing to go on");
  eq(chooseDiscoveryInterface({ lo: twoNics.lo }, { cidr: "127.0.0.0/24" }).kind, "unchosen", "loopback never faces cameras");
});

report("net");
