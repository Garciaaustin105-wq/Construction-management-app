/**
 * Local HTTPS names for NVRs (CLOUD-SLICE4-SPEC.md, "local HTTPS names").
 * Gives each NVR its own HTTPS name that points at its LAN address, so the
 * cloud-served website and app can reach it on the local network (the Plex
 * `*.plex.direct` pattern) -- browsers block a cloud HTTPS page from calling
 * plain http on the LAN. Pure: no fs, no clock of its own (the caller
 * supplies `nowMs` to `certRenewalDue`), no network, no DNS.
 *
 * See cloud/CLOUD-SLICE4-SPEC.md for the full contract, and
 * cloud/harness/localName.harness.mjs for the checks it must pass.
 */

/** Why `localHostname` refused to build a name. Checked in this order --
 *  the first that applies is the one returned:
 *  1. `"bad_ip"` -- `lanIp` is not a syntactically valid IPv4 dotted-quad:
 *     not exactly four dot-separated groups, a group that is not all
 *     decimal digits, a group whose decimal value is outside 0-255, or a
 *     group with a leading zero (more than one digit and starting with
 *     `0`, e.g. `"010"`). Other parsers read `010` as octal 8, so a name
 *     minted as private here could resolve somewhere public; refused
 *     rather than guessed (build rule 10). A lone `"0"` is fine.
 *     `localHostname` and `parseLocalHostname` share ONE dotted-quad
 *     parser and ONE private-range check (module-level helpers), so one
 *     set of boundary tests protects both directions.
 *  2. `"not_private_ip"` -- `lanIp` parses as IPv4 but is not inside
 *     10.0.0.0-10.255.255.255, 172.16.0.0-172.31.255.255 (both ends
 *     inclusive) or 192.168.0.0-192.168.255.255.
 *  3. `"bad_device_id"` -- `deviceId`, lowercased, is not 16 to 32
 *     characters long or contains any character outside `a-z2-7` (base32,
 *     RFC 4648's alphabet without `0`, `1`, `8`, `9`).
 *  4. `"bad_zone"` -- `zone` is empty, starts or ends with `.`, contains an
 *     empty label (two dots in a row), or any label contains a character
 *     other than `a-z`, `A-Z`, `0-9` or `-`, or a label starts or ends with
 *     `-`.
 *  5. `"too_long"` -- checked only once the name would otherwise be built:
 *     any of its three labels (the dashed IP, the lowercased `deviceId`, or
 *     any single label inside `zone`) exceeds 63 characters, or the full
 *     assembled hostname exceeds 253 characters. */
export type LocalHostnameReason = "not_private_ip" | "bad_ip" | "bad_device_id" | "bad_zone" | "too_long";

/** `localHostname`'s result. */
export type LocalHostnameResult = { ok: true; hostname: string } | { ok: false; reason: LocalHostnameReason };

// One dotted-quad group: all decimal digits, value 0-255, and not a
// multi-digit group starting with "0" ("010", "001", "01" -- other parsers
// read those as octal); else `null`. A lone "0" is fine.
const parseGroup = (group: string): number | null => {
  if (!/^[0-9]+$/.test(group)) return null;
  if (group.length > 1 && group.startsWith("0")) return null;
  const value = Number(group);
  return value <= 255 ? value : null;
};

// The one syntactic IPv4 dotted-quad parser shared by `localHostname` and
// `parseLocalHostname`: four dot-separated groups -> their octets, else
// `null`.
const parseDottedQuad = (text: string): [number, number, number, number] | null => {
  const groups = text.split(".");
  if (groups.length !== 4) return null;
  const a = parseGroup(groups[0] ?? "");
  const b = parseGroup(groups[1] ?? "");
  const c = parseGroup(groups[2] ?? "");
  const d = parseGroup(groups[3] ?? "");
  if (a === null || b === null || c === null || d === null) return null;
  return [a, b, c, d];
};

// The one private-range check shared by `localHostname` and
// `parseLocalHostname`: 10/8, 172.16/12 (both ends inclusive) and
// 192.168/16.
const isPrivateIpv4 = (octets: readonly number[]): boolean => {
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
};

/**
 * Build the HTTPS name for one NVR's LAN address. Pure and total; never
 * throws.
 *
 * Contract:
 * - Validate in the order documented on `LocalHostnameReason`; the first
 *   problem found is the one returned, and no later check runs.
 * - Once every check passes, the hostname is
 *   `${lanIp with every "." replaced by "-"}.${deviceId.toLowerCase()}.${zone}`,
 *   for example `localHostname("ABCDEFGH234567AB", "192.168.1.50",
 *   "nvr.example.com")` builds `"192-168-1-50.abcdefgh234567ab.nvr.example.com"`.
 * - Returns `{ ok: true, hostname }` on success, `{ ok: false, reason }`
 *   otherwise.
 */
export function localHostname(deviceId: string, lanIp: string, zone: string): LocalHostnameResult {
  // (1) bad_ip -- not a syntactic IPv4 dotted-quad.
  const octets = parseDottedQuad(lanIp);
  if (octets === null) return { ok: false, reason: "bad_ip" };

  // (2) not_private_ip -- 10/8, 172.16/12 or 192.168/16, bounds inclusive.
  if (!isPrivateIpv4(octets)) return { ok: false, reason: "not_private_ip" };

  // (3) bad_device_id -- lowercased, 16-32 characters of a-z2-7.
  const lowerId = deviceId.toLowerCase();
  if (lowerId.length < 16 || lowerId.length > 32 || !/^[a-z2-7]+$/.test(lowerId)) {
    return { ok: false, reason: "bad_device_id" };
  }

  // (4) bad_zone -- empty zone, leading/trailing dot, an empty label, a
  // character outside [A-Za-z0-9-], or a label starting/ending with '-'.
  const zoneLabels = zone.split(".");
  for (const label of zoneLabels) {
    if (label === "" || !/^[A-Za-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
      return { ok: false, reason: "bad_zone" };
    }
  }

  // (5) too_long -- every label <= 63 characters, whole name <= 253.
  const ipLabel = lanIp.replaceAll(".", "-");
  if (ipLabel.length > 63 || lowerId.length > 63) return { ok: false, reason: "too_long" };
  for (const label of zoneLabels) {
    if (label.length > 63) return { ok: false, reason: "too_long" };
  }
  const hostname = `${ipLabel}.${lowerId}.${zone}`;
  if (hostname.length > 253) return { ok: false, reason: "too_long" };

  return { ok: true, hostname };
}

/** Why `parseLocalHostname` could not recover `lanIp` and `deviceId` from a
 *  hostname. Checked in this order:
 *  1. `"zone_mismatch"` -- `hostname`, split on `.`, does not have exactly
 *     two more labels than `zone` split on `.`, OR its trailing labels
 *     (however many `zone` has) do not match `zone`'s labels exactly,
 *     case-sensitively. This is also what a hostname with the wrong shape
 *     entirely (too few labels to possibly hold an IP label and a device-id
 *     label in front of the zone) reports -- there is no separate
 *     "malformed" reason.
 *  2. `"bad_ip"` -- once the zone suffix is confirmed, the first remaining
 *     label, with every `-` replaced by `.`, is not a syntactically valid
 *     IPv4 dotted-quad (same rule as `LocalHostnameReason`'s `"bad_ip"`).
 *  3. `"not_private_ip"` -- that address parses but is not private (same
 *     ranges as `LocalHostnameReason`'s `"not_private_ip"`).
 *  4. `"bad_device_id"` -- the second remaining label is not 16 to 32
 *     characters of `a-z2-7`. (`localHostname` always lowercases before
 *     building, so this label is expected already-lowercase; a parse does
 *     not lowercase it again before checking.) */
export type ParseLocalHostnameReason = "zone_mismatch" | "bad_ip" | "not_private_ip" | "bad_device_id";

/** `parseLocalHostname`'s result. */
export type ParseLocalHostnameResult =
  | { ok: true; lanIp: string; deviceId: string }
  | { ok: false; reason: ParseLocalHostnameReason };

/**
 * The inverse of `localHostname`: recover the LAN IP and device id encoded
 * in one of its hostnames. Pure and total; never throws.
 *
 * Contract:
 * - Validate in the order documented on `ParseLocalHostnameReason`; the
 *   first problem found is the one returned.
 * - On success, `lanIp` is the dashed label with `-` replaced back to `.`,
 *   and `deviceId` is the device-id label, unchanged (no case conversion).
 * - Round trip: for any `deviceId`, `lanIp` and `zone` for which
 *   `localHostname` returns `{ ok: true, hostname }`,
 *   `parseLocalHostname(hostname, zone)` returns
 *   `{ ok: true, lanIp, deviceId: deviceId.toLowerCase() }`.
 */
export function parseLocalHostname(hostname: string, zone: string): ParseLocalHostnameResult {
  // 16-32 characters of a-z2-7, checked as-is (no case folding).
  const isDeviceIdShape = (label: string): boolean => /^[a-z2-7]{16,32}$/.test(label);

  const labels = hostname.split(".");
  const zoneLabels = zone.split(".");
  if (labels.length !== zoneLabels.length + 2) {
    return { ok: false, reason: "zone_mismatch" };
  }
  const zoneStart = labels.length - zoneLabels.length;
  for (let i = 0; i < zoneLabels.length; i++) {
    if (labels[zoneStart + i] !== zoneLabels[i]) {
      return { ok: false, reason: "zone_mismatch" };
    }
  }
  const ipLabel = labels[0];
  const deviceIdLabel = labels[1];
  if (ipLabel === undefined || deviceIdLabel === undefined) {
    return { ok: false, reason: "zone_mismatch" };
  }
  const lanIp = ipLabel.replaceAll("-", ".");
  const octets = parseDottedQuad(lanIp);
  if (octets === null) {
    return { ok: false, reason: "bad_ip" };
  }
  if (!isPrivateIpv4(octets)) {
    return { ok: false, reason: "not_private_ip" };
  }
  if (!isDeviceIdShape(deviceIdLabel)) {
    return { ok: false, reason: "bad_device_id" };
  }
  return { ok: true, lanIp, deviceId: deviceIdLabel };
}

/** How long before a certificate's expiry it counts as due for renewal:
 *  30 days, in milliseconds. */
export const CERT_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a certificate expiring at `notAfterMs` should be renewed now,
 * given the current time `nowMs`. Pure and total; never throws.
 *
 * Contract:
 * - `true` when `notAfterMs - nowMs <= CERT_RENEWAL_WINDOW_MS` -- due
 *   exactly at 30 days out, and at every point closer to or past expiry.
 * - `false` when strictly more than 30 days remain.
 * - `true` when `notAfterMs` or `nowMs` is not a finite number (`NaN`,
 *   `Infinity` or `-Infinity`) -- renew rather than trust a garbage
 *   timestamp (build rule 10: refuse/fail safe rather than guess).
 */
export function certRenewalDue(notAfterMs: number, nowMs: number): boolean {
  return !isFinite(notAfterMs) || !isFinite(nowMs) || (notAfterMs - nowMs <= CERT_RENEWAL_WINDOW_MS);
}
