/**
 * Which addresses the web server listens on (contracts/listenPlan.ts).
 *
 * THE FEARED FAILURES: the web pages reachable from the camera network (a
 * compromised camera attacking the recorder); a wildcard bind doing that
 * silently; a TV on the box's own HDMI showing a blank page because loopback
 * was left out; a manager's browser on the store LAN refused because the
 * server only listens on the Tailscale address (FIELD-NOTES 2026-09-18,
 * finding 3); a card that is not up yet crashing the server.
 */
import { planListeners, defaultRouteInterfacesFrom, DEFAULT_LISTEN } from "../dist/listenPlan.js";
import { check, eq, report } from "./_assert.mjs";

console.log("listen plan");

const v4 = (address, extra = {}) => ({ address, family: "IPv4", internal: false, netmask: "255.255.255.0", ...extra });
const v6 = (address, extra = {}) => ({ address, family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::", scopeid: 0, ...extra });

// A two-card NVR: enp1s0 is the store LAN (default route), enp2s0 the
// isolated camera network, plus Tailscale and loopback.
const box = {
  lo: [v4("127.0.0.1", { internal: true, netmask: "255.0.0.0" }), v6("::1", { internal: true })],
  enp1s0: [v4("192.168.10.20"), v6("fe80::1", { scopeid: 2 }), v6("2001:db8::20")],
  enp2s0: [v4("192.168.1.50"), v6("fe80::2", { scopeid: 3 })],
  tailscale0: [v4("100.104.228.7"), v6("fd7a:115c:a1e0::1")],
};
const plan = (spec, extra = {}) => planListeners({
  spec,
  interfaces: box,
  defaultRouteInterfaces: ["enp1s0"],
  cameraInterfaces: ["enp2s0"],
  ...extra,
});
const addrs = (p) => p.listen.map((l) => l.address);

check("the default is loopback, the default-route card and Tailscale", () => {
  eq([...DEFAULT_LISTEN], ["loopback", "default-route", "tailscale"], "DEFAULT_LISTEN");
  const p = plan(null);
  eq(addrs(p), ["127.0.0.1", "192.168.10.20", "2001:db8::20", "100.104.228.7", "fd7a:115c:a1e0::1"], "addresses, loopback first");
  eq(p.refused, [], "nothing refused");
  eq(p.waiting, [], "nothing waiting");
  eq(plan([]).listen, p.listen, "an empty list means the default too");
});

check("THE FEARED ONE: the camera network is never listened on, even when named", () => {
  for (const spec of [null, ["if:enp2s0"], ["192.168.1.50"], ["loopback", "if:enp2s0", "tailscale"]]) {
    const p = plan(spec);
    if (addrs(p).includes("192.168.1.50")) throw new Error(`listened on the camera network for ${JSON.stringify(spec)}`);
  }
  const named = plan(["if:enp2s0"]);
  eq(named.refused.length, 1, "naming the camera card is refused");
  eq(named.refused[0].entry, "if:enp2s0", "the entry is named");
  if (!/camera/i.test(named.refused[0].reason)) throw new Error(`the reason should say it is the camera network: ${named.refused[0].reason}`);
  const byAddress = plan(["192.168.1.50"]);
  eq(byAddress.refused.map((r) => r.entry), ["192.168.1.50"], "an address on the camera card is refused too");
});

check("THE FEARED ONE: a wildcard is refused, never turned into every card", () => {
  for (const w of ["0.0.0.0", "::", "[::]", "*"]) {
    const p = plan([w]);
    eq(addrs(p), ["127.0.0.1"], `${w} adds nothing but loopback`);
    eq(p.refused.map((r) => r.entry), [w], `${w} is refused`);
    if (!/camera/i.test(p.refused[0].reason)) throw new Error(`the wildcard reason should say why (the camera network): ${p.refused[0].reason}`);
  }
});

check("THE FEARED ONE: loopback is always there, so a wall on the box's own HDMI never goes blank", () => {
  eq(addrs(plan(["tailscale"]))[0], "127.0.0.1", "added when the list leaves it out");
  eq(addrs(plan(["100.104.228.7"])), ["127.0.0.1", "100.104.228.7"], "the old Tailscale-only setting keeps loopback");
  eq(addrs(plan(["loopback", "127.0.0.1"])), ["127.0.0.1"], "and is never listed twice");
  const noLo = plan(null, { interfaces: { enp1s0: box.enp1s0 } });
  eq(addrs(noLo)[0], "127.0.0.1", "even when the interface list does not show it");
});

check("THE FEARED ONE: the camera network carrying the default route is refused, not listened on", () => {
  const p = plan(["default-route"], { defaultRouteInterfaces: ["enp2s0"] });
  eq(addrs(p), ["127.0.0.1"], "nothing but loopback");
  eq(p.refused.map((r) => r.entry), ["default-route"], "refused");
  if (!/camera/i.test(p.refused[0].reason)) throw new Error(`should say the camera card has the default route: ${p.refused[0].reason}`);
});

check("THE FEARED ONE: a camera card that also has a default route never costs the store LAN, whatever the route order", () => {
  for (const order of [["enp2s0", "enp1s0"], ["enp1s0", "enp2s0"]]) {
    const p = plan(["default-route"], { defaultRouteInterfaces: order });
    eq(addrs(p), ["127.0.0.1", "192.168.10.20", "2001:db8::20"], `store LAN kept for ${order}`);
    eq(p.refused.map((r) => r.entry), ["default-route"], `the camera card's default route is reported for ${order}`);
    if (!/enp2s0/.test(p.refused[0].reason)) throw new Error(`the refusal should name the card: ${p.refused[0].reason}`);
  }
});

check("a link-local address named outright is refused, not retried forever", () => {
  eq(plan(["fe80::1"]).refused.map((r) => r.entry), ["fe80::1"], "IPv6 link-local");
  eq(plan(["169.254.3.4"]).refused.map((r) => r.entry), ["169.254.3.4"], "IPv4 link-local");
});

check("a card that is not up yet waits; it never crashes and never counts as refused", () => {
  const p = plan(["tailscale", "if:wlan0", "10.9.9.9"], { interfaces: { lo: box.lo, enp1s0: box.enp1s0 } });
  eq(addrs(p), ["127.0.0.1"], "only loopback now");
  eq(p.refused, [], "nothing refused");
  eq(p.waiting.map((w) => w.entry), ["tailscale", "if:wlan0", "10.9.9.9"], "all three waiting, in order");
  const noRoute = plan(["default-route"], { defaultRouteInterfaces: [] });
  eq(noRoute.waiting.map((w) => w.entry), ["default-route"], "no default route yet: waiting");
});

check("link-local addresses are skipped: they cannot be bound without a scope", () => {
  const all = addrs(plan(null));
  for (const a of all) if (/^fe80:/i.test(a) || /^169\.254\./.test(a)) throw new Error(`listened on link-local ${a}`);
  const onlyLinkLocal = plan(["if:eth9"], { interfaces: { ...box, eth9: [v4("169.254.3.4"), v6("fe80::9", { scopeid: 9 })] } });
  eq(onlyLinkLocal.listen.length, 1, "only loopback");
  eq(onlyLinkLocal.waiting.map((w) => w.entry), ["if:eth9"], "a card with only link-local addresses waits");
});

check("node's older numeric family (4/6) reads the same as IPv4/IPv6", () => {
  const numeric = { lo: box.lo, enp1s0: [{ address: "192.168.10.20", family: 4, internal: false }] };
  eq(addrs(plan(["default-route"], { interfaces: numeric })), ["127.0.0.1", "192.168.10.20"], "numeric family");
  const fam = plan(["default-route"], { interfaces: numeric }).listen[1].family;
  eq(fam, 4, "family normalised to 4");
});

check("each address says where it came from, and an unknown word is refused with the valid ones", () => {
  const p = plan(["if:enp1s0", "tailscale", "bogus"]);
  eq(p.listen.find((l) => l.address === "192.168.10.20")?.iface, "enp1s0", "card name");
  eq(p.listen.find((l) => l.address === "192.168.10.20")?.from, "if:enp1s0", "entry");
  eq(p.listen.find((l) => l.address === "127.0.0.1")?.from, "loopback", "loopback");
  eq(p.refused.map((r) => r.entry), ["bogus"], "bogus refused");
  for (const word of ["loopback", "default-route", "tailscale", "if:"]) {
    if (!p.refused[0].reason.includes(word)) throw new Error(`the refusal should list ${word}: ${p.refused[0].reason}`);
  }
});

check("an address on no card at all waits (it may be coming); a malformed one is refused", () => {
  eq(plan(["10.0.0.99"]).waiting.map((w) => w.entry), ["10.0.0.99"], "unknown address waits");
  eq(plan(["300.1.1.1"]).refused.map((r) => r.entry), ["300.1.1.1"], "impossible address refused");
  eq(plan(["if:"]).refused.map((r) => r.entry), ["if:"], "an empty card name is refused");
});

check("the default route is read from /proc/net/route, header and all", () => {
  const route = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "enp1s0\t00000000\t010AA8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
    "enp1s0\t000AA8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0",
    "enp2s0\t0001A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
    "wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0",
    "",
  ].join("\n");
  eq(defaultRouteInterfacesFrom(route), ["enp1s0", "wlan0"], "both default routes, in order, once each");
  eq(defaultRouteInterfacesFrom(""), [], "empty file");
  eq(defaultRouteInterfacesFrom("garbage\nno tabs here"), [], "garbage");
  const down = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\nenp1s0\t00000000\t010AA8C0\t0002\t0\t0\t100\t00000000";
  eq(defaultRouteInterfacesFrom(down), [], "a route without the UP flag (0x1) does not count");
});

report("listen plan");
