/**
 * IPv4 and CIDR arithmetic for subnet sweeps.
 *
 * Pure so the sweep range can be checked without opening a socket. A camera
 * subnet is typically a /24, but an appliance pointed at a /8 by a typo would
 * try 16 million hosts — so expansion is bounded and refuses rather than
 * quietly starting a scan that never finishes.
 */

export class CidrError extends Error {}

const MAX_SWEEP_HOSTS = 65_536;

export function parseIpv4(ip: string): number {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) throw new CidrError(`not an IPv4 address: ${JSON.stringify(ip)}`);
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new CidrError(`not an IPv4 address: ${JSON.stringify(ip)}`);
    const octet = Number(part);
    if (octet > 255) throw new CidrError(`octet out of range in ${JSON.stringify(ip)}`);
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function formatIpv4(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xff_ff_ff_ff) {
    throw new CidrError(`not a valid IPv4 integer: ${value}`);
  }
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export interface Cidr {
  networkAddress: string;
  prefixLength: number;
  hostCount: number;
}

export function parseCidr(cidr: string): Cidr {
  const [ipPart, prefixPart] = cidr.trim().split("/");
  if (ipPart === undefined || prefixPart === undefined) {
    throw new CidrError(`expected a.b.c.d/nn, got ${JSON.stringify(cidr)}`);
  }
  if (!/^\d{1,2}$/.test(prefixPart)) {
    throw new CidrError(`prefix length is not a number in ${JSON.stringify(cidr)}`);
  }
  const prefixLength = Number(prefixPart);
  if (prefixLength < 0 || prefixLength > 32) {
    throw new CidrError(`prefix length must be 0..32, got /${prefixLength}`);
  }
  const ip = parseIpv4(ipPart);
  const mask = prefixLength === 0 ? 0 : (0xff_ff_ff_ff << (32 - prefixLength)) >>> 0;
  const networkValue = (ip & mask) >>> 0;
  // A /31 and /32 have no network/broadcast pair to exclude.
  const total = 2 ** (32 - prefixLength);
  const hostCount = prefixLength >= 31 ? total : Math.max(0, total - 2);
  return { networkAddress: formatIpv4(networkValue), prefixLength, hostCount };
}

/**
 * Usable host addresses in a CIDR, excluding network and broadcast.
 * Refuses anything larger than MAX_SWEEP_HOSTS — a sweep that big is a typo.
 */
export function expandCidr(cidr: string): string[] {
  const parsed = parseCidr(cidr);
  if (parsed.hostCount > MAX_SWEEP_HOSTS) {
    throw new CidrError(
      `${cidr} covers ${parsed.hostCount} hosts, above the ${MAX_SWEEP_HOSTS} sweep limit; ` +
        "narrow the range rather than scanning a network this size",
    );
  }
  const network = parseIpv4(parsed.networkAddress);
  const first = parsed.prefixLength >= 31 ? network : network + 1;
  const out: string[] = [];
  for (let i = 0; i < parsed.hostCount; i++) out.push(formatIpv4(first + i));
  return out;
}

export interface NetInterfaceAddress { address: string; netmask: string; family: string | number; internal: boolean; }
export type NetInterfaces = Record<string, NetInterfaceAddress[] | undefined>;
export interface DiscoveryCandidate { name: string; address: string; netmask: string; broadcast: string; }

/** The IPv4 addresses discovery could send from: loopback and IPv6 are never candidates. */
export function discoveryCandidates(interfaces: NetInterfaces): DiscoveryCandidate[] {
  const out: DiscoveryCandidate[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if ((entry.family !== "IPv4" && entry.family !== 4) || entry.internal) continue;
      const mask = parseIpv4(entry.netmask);
      const broadcast = formatIpv4(((parseIpv4(entry.address) & mask) | (~mask >>> 0)) >>> 0);
      out.push({ name, address: entry.address, netmask: entry.netmask, broadcast });
    }
  }
  return out;
}

export type DiscoveryInterface =
  | ({ kind: "chosen"; source: "iface" | "cidr" } & DiscoveryCandidate)
  | { kind: "refused"; reason: string }
  | { kind: "unchosen"; reason: string };

/**
 * The local IPv4 address camera discovery should send from.
 *
 * Camera discovery joins multicast groups. With no interface named, the kernel
 * picks one from the routing table; on a box with two network cards that is
 * likely the store LAN, and discovery on the camera network silently finds
 * nothing. This picks the address discovery should use, and refuses rather
 * than guesses when a wrong card would look plausible.
 */
export function chooseDiscoveryInterface(interfaces: NetInterfaces, options: { iface?: string; cidr?: string }): DiscoveryInterface {
  const candidates = discoveryCandidates(interfaces);
  const iface = (options.iface ?? "").trim();
  if (iface !== "") {
    if (/^[0-9.]+$/.test(iface)) {
      const match = candidates.find((c) => c.address === iface);
      if (match === undefined) {
        return { kind: "refused", reason: `no network card here has the address ${iface}` };
      }
      return { kind: "chosen", source: "iface", ...match };
    }
    if (!(iface in interfaces)) {
      const names = [...new Set(candidates.map((c) => c.name))].join(", ");
      return { kind: "refused", reason: `no network card named ${iface}; this machine has: ${names}` };
    }
    const mine = candidates.filter((c) => c.name === iface);
    const only = mine[0];
    if (only === undefined) {
      return { kind: "refused", reason: `${iface} has no IPv4 address to discover from` };
    }
    if (mine.length > 1) {
      const list = mine.map((c) => c.address).join(", ");
      return {
        kind: "refused",
        reason: `${iface} has more than one IPv4 address (${list}); pass the address that faces the cameras instead`,
      };
    }
    return { kind: "chosen", source: "iface", ...only };
  }
  if (options.cidr) {
    const network = parseIpv4(parseCidr(options.cidr).networkAddress);
    const matches = candidates.filter((c) => {
      const mask = parseIpv4(c.netmask);
      return ((network & mask) >>> 0) === ((parseIpv4(c.address) & mask) >>> 0);
    });
    const only = matches[0];
    if (only !== undefined && matches.length === 1) {
      return { kind: "chosen", source: "cidr", ...only };
    }
    if (matches.length > 1) {
      const list = matches.map((c) => `${c.name} ${c.address}`).join(", ");
      return {
        kind: "refused",
        reason: `more than one network card is on ${options.cidr} (${list}); pass --iface to say which faces the cameras`,
      };
    }
    return {
      kind: "unchosen",
      reason: `no network card is on ${options.cidr}; the kernel will pick one, which on a box with two cards may be the wrong one: pass --iface`,
    };
  }
  return { kind: "unchosen", reason: "no --iface and no network to match; the kernel will pick the card" };
}
