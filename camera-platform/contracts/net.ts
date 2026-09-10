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
