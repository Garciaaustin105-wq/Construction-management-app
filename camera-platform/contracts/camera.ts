/**
 * Camera identity and discovery records.
 *
 * The rule this module exists to enforce: a camera's identity is its MAC
 * address and serial number, NEVER its IP. DHCP leases move, cameras reboot
 * onto new addresses, and a store's subnet can be renumbered wholesale. Key on
 * IP and the estate re-onboards itself every time anything changes.
 */

export type DiscoverySource = "sadp" | "onvif" | "arp_probe" | "manual";

export type Vendor = "hikvision" | "axis" | "hanwha" | "avigilon" | "generic";

export interface CameraIdentity {
  /** Normalised lowercase, colon-separated. */
  mac: string;
  /** Vendor serial, when discovery reported one. Null when unavailable. */
  serial: string | null;
}

export interface DiscoveredCamera {
  identity: CameraIdentity;
  ip: string;
  vendor: Vendor;
  model: string | null;
  firmware: string | null;
  source: DiscoverySource;
  discoveredAtUtc: string;
}

export interface KnownCamera {
  cameraId: string;
  identity: CameraIdentity;
  /** Last address we saw it at. Advisory only — never used for matching. */
  lastKnownIp: string | null;
  name: string;
  zone: string | null;
}

export class CameraIdentityError extends Error {}

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/** Accepts `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff`, `aabbccddeeff`. */
export function normaliseMac(raw: string): string {
  if (typeof raw !== "string") {
    throw new CameraIdentityError(`MAC must be a string, got ${typeof raw}`);
  }
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) {
    throw new CameraIdentityError(`not a MAC address: ${JSON.stringify(raw)}`);
  }
  const mac = (hex.match(/.{2}/g) as string[]).join(":");
  if (!MAC_RE.test(mac)) {
    throw new CameraIdentityError(`not a MAC address: ${JSON.stringify(raw)}`);
  }
  return mac;
}

/** Stable key for storage and lookup. Serial participates when known, so two
 *  cameras behind a MAC-cloning switch still separate. */
export function identityKey(identity: CameraIdentity): string {
  const mac = normaliseMac(identity.mac);
  return identity.serial ? `${mac}|${identity.serial}` : mac;
}

export type IdentityMatch =
  | { kind: "same"; confidence: "exact" | "mac_only" }
  | { kind: "different" }
  | { kind: "ambiguous"; reason: string };

/**
 * Do two identities refer to the same physical camera?
 *
 * Same MAC with conflicting serials is reported as `ambiguous`, not forced to a
 * yes or no — it means something upstream is wrong (a cloned MAC, a swapped
 * board, a bad discovery parse) and a human should look.
 */
export function matchIdentity(a: CameraIdentity, b: CameraIdentity): IdentityMatch {
  const macA = normaliseMac(a.mac);
  const macB = normaliseMac(b.mac);

  if (macA !== macB) {
    if (a.serial && b.serial && a.serial === b.serial) {
      return {
        kind: "ambiguous",
        reason: `serial ${a.serial} seen on two MACs (${macA}, ${macB}) — replaced board or bad parse`,
      };
    }
    return { kind: "different" };
  }

  if (a.serial && b.serial) {
    return a.serial === b.serial
      ? { kind: "same", confidence: "exact" }
      : { kind: "ambiguous", reason: `MAC ${macA} reports two serials (${a.serial}, ${b.serial})` };
  }

  return { kind: "same", confidence: "mac_only" };
}

export type Reconciliation =
  | { kind: "known"; camera: KnownCamera; ipChanged: boolean }
  | { kind: "new"; discovered: DiscoveredCamera }
  | { kind: "ambiguous"; discovered: DiscoveredCamera; reason: string };

/**
 * Match a freshly discovered camera against the known estate.
 *
 * A known camera at a new IP is `known` with `ipChanged` — it must update
 * silently. That happens constantly and must never generate an alert.
 */
export function reconcile(
  discovered: DiscoveredCamera,
  known: readonly KnownCamera[],
): Reconciliation {
  for (const candidate of known) {
    const match = matchIdentity(discovered.identity, candidate.identity);
    if (match.kind === "same") {
      return {
        kind: "known",
        camera: candidate,
        ipChanged: candidate.lastKnownIp !== discovered.ip,
      };
    }
    if (match.kind === "ambiguous") {
      return { kind: "ambiguous", discovered, reason: match.reason };
    }
  }
  return { kind: "new", discovered };
}

/** MAC OUI prefixes → vendor, for cameras that answer no discovery protocol.
 *  Not exhaustive; absence yields 'generic', never a guess. */
const OUI_VENDORS: ReadonlyArray<readonly [string, Vendor]> = [
  ["44:19:b6", "hikvision"],
  ["4c:bd:8f", "hikvision"],
  ["bc:ad:28", "hikvision"],
  ["c0:56:e3", "hikvision"],
  ["00:40:8c", "axis"],
  ["ac:cc:8e", "axis"],
  ["00:16:6c", "hanwha"],
  ["00:09:18", "hanwha"],
];

export function vendorFromMac(mac: string): Vendor {
  const normalised = normaliseMac(mac);
  const prefix = normalised.slice(0, 8);
  for (const [oui, vendor] of OUI_VENDORS) {
    if (oui === prefix) return vendor;
  }
  return "generic";
}
