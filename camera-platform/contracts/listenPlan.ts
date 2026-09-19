/**
 * Which addresses the web server listens on.
 *
 * The web pages must never be reachable from the camera network (a compromised
 * camera attacking the recorder). Wildcards are refused. Loopback is always
 * included for the box's own HDMI display, even when the spec leaves it out.
 * Addresses that are not yet available (card not up, not a default route) wait
 * until rescan.
 */

export const DEFAULT_LISTEN = ["loopback", "default-route", "tailscale"] as const;

/**
 * A network interface address from os.networkInterfaces().
 */
export interface NicAddress {
  address: string;
  family: "IPv4" | "IPv6" | 4 | 6;
  internal: boolean;
  netmask?: string;
  scopeid?: number;
  cidr?: string | null;
}

/**
 * The shape of os.networkInterfaces(): a map of interface name to array of addresses.
 */
export type Interfaces = Record<string, NicAddress[] | undefined>;

/**
 * A planned listen address: the resolved address, its interface, and the spec entry that produced it.
 */
export interface ListenAddress {
  address: string;
  family: 4 | 6;
  iface: string;
  from: string;
}

/**
 * A spec entry that is refused or waiting.
 */
export interface StatusEntry {
  entry: string;
  reason: string;
}

/**
 * The result of planning which addresses to listen on.
 */
export interface ListenPlan {
  listen: ListenAddress[];
  waiting: StatusEntry[];
  refused: StatusEntry[];
}

/**
 * Validate an IPv4 address with a strict dotted-quad check.
 */
function isValidIPv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  return parts.every(part => {
    const num = parseInt(part, 10);
    return num >= 0 && num <= 255 && part === num.toString();
  });
}

/**
 * Validate an IPv6 address with a basic check (good enough to reject garbage).
 */
function isValidIPv6(addr: string): boolean {
  // Basic IPv6 validation: should contain colons, optionally :: notation
  if (!addr.includes(':')) return false;
  // Check for invalid characters
  return /^[0-9a-fA-F:]+$/.test(addr);
}

/**
 * Check if an address is link-local (not usable without a scope).
 */
function isLinkLocal(addr: string, family: "IPv4" | "IPv6" | 4 | 6): boolean {
  // IPv6 fe80::/10
  if ((family === "IPv6" || family === 6) && /^fe80:/i.test(addr)) return true;
  // IPv4 169.254.0.0/16
  if ((family === "IPv4" || family === 4) && /^169\.254\./.test(addr)) return true;
  return false;
}

/**
 * Check if an address is loopback (::1 should not be used; only 127.0.0.1).
 */
function isLoopbackIPv6(addr: string): boolean {
  return addr === '::1';
}

/**
 * Normalize the family field to 4 or 6.
 */
function normalizeFamily(family: "IPv4" | "IPv6" | 4 | 6): 4 | 6 {
  if (family === "IPv4" || family === 4) return 4;
  if (family === "IPv6" || family === 6) return 6;
  return 4; // fallback
}

/**
 * Get usable addresses from an interface: skip link-local, ::1, and internal (except loopback).
 */
function usableAddresses(iface: string, addrs: NicAddress[] | undefined): NicAddress[] {
  if (!addrs) return [];
  return addrs.filter(addr => {
    // Skip link-local
    if (isLinkLocal(addr.address, addr.family)) return false;
    // Skip ::1 (only 127.0.0.1 is loopback)
    if (isLoopbackIPv6(addr.address)) return false;
    // Skip other internal addresses (but 127.0.0.1 is internal, and will be added explicitly)
    if (addr.internal && addr.address !== '127.0.0.1') return false;
    return true;
  });
}

/**
 * Parse /proc/net/route and return the interfaces that have a default route with the UP flag.
 * Format: tab-separated, first line is header, columns: Iface, Destination, Gateway, Flags, ...
 * Default route: Destination "00000000" and Mask "00000000" with Flags containing the UP flag (0x0001).
 */
export function defaultRouteInterfacesFrom(procNetRoute: string): string[] {
  const lines = procNetRoute.trim().split('\n');
  if (lines.length === 0 || !lines[0]) return [];

  // Parse header to find column indices
  const header = lines[0]!.split('\t');
  const ifaceIdx = header.indexOf('Iface');
  const destIdx = header.indexOf('Destination');
  const flagsIdx = header.indexOf('Flags');
  const maskIdx = header.indexOf('Mask');

  if (ifaceIdx === -1 || destIdx === -1 || flagsIdx === -1 || maskIdx === -1) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.split('\t');
    if (parts.length <= Math.max(ifaceIdx, destIdx, flagsIdx, maskIdx)) continue;

    const dest = parts[destIdx]?.trim();
    const mask = parts[maskIdx]?.trim();
    const flags = parts[flagsIdx]?.trim();
    const iface = parts[ifaceIdx]?.trim();

    if (dest === '00000000' && mask === '00000000' && flags) {
      // Check if UP flag (0x0001) is set
      const flagNum = parseInt(flags, 16);
      if ((flagNum & 0x0001) && iface && !seen.has(iface)) {
        seen.add(iface);
        result.push(iface);
      }
    }
  }

  return result;
}

/**
 * Plan which addresses to listen on based on the spec.
 */
export function planListeners(i: {
  spec: readonly string[] | null;
  interfaces: Interfaces;
  defaultRouteInterfaces: readonly string[];
  cameraInterfaces: readonly string[];
}): ListenPlan {
  const spec = (i.spec ?? []).map(s => s.trim()).filter(s => s.length > 0);
  const ifaces = i.interfaces;
  const defaultRoutes = i.defaultRouteInterfaces;
  const cameraIfacesSet = new Set(i.cameraInterfaces);

  // Use default if spec is empty or null
  const entries = spec.length === 0 ? [...DEFAULT_LISTEN] : spec;

  const listen: ListenAddress[] = [];
  const waiting: StatusEntry[] = [];
  const refused: StatusEntry[] = [];
  const seen = new Set<string>();

  // Helper to add a listen address
  const addListen = (addr: string, family: 4 | 6, iface: string, from: string) => {
    if (!seen.has(addr)) {
      seen.add(addr);
      listen.push({ address: addr, family, iface, from });
    }
  };

  // Loopback is always added first (127.0.0.1), but not ::1
  let loopbackIfaceName = 'lo';
  let hasLoopback = false;
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (addrs?.some(a => a.address === '127.0.0.1')) {
      loopbackIfaceName = name;
      hasLoopback = true;
      break;
    }
  }
  if (!hasLoopback) {
    loopbackIfaceName = 'lo';
  }
  addListen('127.0.0.1', 4, loopbackIfaceName, 'loopback');

  // Process spec entries
  for (const entry of entries) {
    if (entry === 'loopback') {
      // Already added above, skip
      continue;
    }

    if (entry === 'default-route') {
      // Every default-route card except a camera card. A camera card with a
      // default route is skipped and reported, and never costs the store LAN:
      // /proc/net/route order must not decide whether managers can connect.
      let added = false;
      const cameraRoutes: string[] = [];
      for (const ifaceName of defaultRoutes) {
        if (cameraIfacesSet.has(ifaceName)) {
          cameraRoutes.push(ifaceName);
          continue;
        }
        for (const addr of usableAddresses(ifaceName, ifaces[ifaceName])) {
          addListen(addr.address, normalizeFamily(addr.family), ifaceName, entry);
          added = true;
        }
      }
      if (cameraRoutes.length > 0) {
        refused.push({
          entry,
          reason: `the camera network (${cameraRoutes.join(', ')}) has a default route, so it is not listened on; check CAMPLAT_CAMERA_INTERFACES or the camera network's gateway`,
        });
      } else if (!added) {
        waiting.push({ entry, reason: 'no default route found' });
      }
      continue;
    }

    if (entry === 'tailscale') {
      // Add addresses from tailscale0, tailscale1, etc.
      let added = false;
      for (const [ifaceName, addrs] of Object.entries(ifaces)) {
        if (/^tailscale\d*$/.test(ifaceName)) {
          const usable = usableAddresses(ifaceName, addrs);
          for (const addr of usable) {
            const fam = normalizeFamily(addr.family);
            addListen(addr.address, fam, ifaceName, entry);
            added = true;
          }
        }
      }
      if (!added) {
        waiting.push({ entry, reason: 'no Tailscale interface found' });
      }
      continue;
    }

    if (entry.startsWith('if:')) {
      const ifaceName = entry.slice(3);
      if (!ifaceName) {
        refused.push({ entry, reason: 'empty interface name after if:' });
        continue;
      }
      if (cameraIfacesSet.has(ifaceName)) {
        refused.push({ entry, reason: `the card ${ifaceName} is the camera network` });
        continue;
      }
      const addrs = usableAddresses(ifaceName, ifaces[ifaceName]);
      if (addrs.length === 0) {
        waiting.push({ entry, reason: `interface ${ifaceName} not found or has no usable addresses` });
        continue;
      }
      for (const addr of addrs) {
        const fam = normalizeFamily(addr.family);
        addListen(addr.address, fam, ifaceName, entry);
      }
      continue;
    }

    // Try as a wildcard
    if (['0.0.0.0', '::', '[::]', '*'].includes(entry)) {
      refused.push({
        entry,
        reason: `${entry} listens on every network card, including the camera network; name the cards instead`,
      });
      continue;
    }

    // Try as a literal address
    const isIPv4 = entry.includes('.');
    const isIPv6 = entry.includes(':');

    if ((isIPv4 && isLinkLocal(entry, 4)) || (isIPv6 && isLinkLocal(entry, 6))) {
      refused.push({ entry, reason: `${entry} is link-local and cannot be listened on without a scope; name the card instead` });
      continue;
    }

    if (!isIPv4 && !isIPv6) {
      // Unknown word
      refused.push({
        entry,
        reason: `unknown entry; use loopback, default-route, tailscale, if:<name>, or an address`,
      });
      continue;
    }

    if (isIPv4) {
      if (!isValidIPv4(entry)) {
        refused.push({ entry, reason: 'invalid IPv4 address' });
        continue;
      }
      if (cameraIfacesSet.has(entry)) {
        refused.push({ entry, reason: `the address ${entry} is on the camera network` });
        continue;
      }
      // Find which interface has this address
      let found = false;
      for (const [ifaceName, addrs] of Object.entries(ifaces)) {
        if (addrs?.some(a => a.address === entry)) {
          if (cameraIfacesSet.has(ifaceName)) {
            refused.push({ entry, reason: `the address ${entry} is on the camera network` });
            found = true;
            break;
          }
          addListen(entry, 4, ifaceName, entry);
          found = true;
          break;
        }
      }
      if (!found) {
        waiting.push({ entry, reason: `address ${entry} not found on any interface` });
      }
      continue;
    }

    if (isIPv6) {
      if (!isValidIPv6(entry)) {
        refused.push({ entry, reason: 'invalid IPv6 address' });
        continue;
      }
      // Find which interface has this address
      let found = false;
      for (const [ifaceName, addrs] of Object.entries(ifaces)) {
        if (addrs?.some(a => a.address === entry)) {
          if (cameraIfacesSet.has(ifaceName)) {
            refused.push({ entry, reason: `the address ${entry} is on the camera network` });
            found = true;
            break;
          }
          addListen(entry, 6, ifaceName, entry);
          found = true;
          break;
        }
      }
      if (!found) {
        waiting.push({ entry, reason: `address ${entry} not found on any interface` });
      }
      continue;
    }
  }

  return { listen, waiting, refused };
}
