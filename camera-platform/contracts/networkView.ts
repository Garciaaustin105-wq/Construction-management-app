/**
 * The Network page's one screen, built from measurements — never a scan.
 *
 * Pure. No fs, no socket, no clock of its own: every neighbour table, route
 * table, counter snapshot, discovery reply, probe result and history file is
 * handed in already read. agent/network-facts.mjs does the reading; this file
 * only parses what Linux hands back and merges it with the configured estate.
 *
 * THE FEARED FAILURE, twice over:
 *  - a camera's `rtsp://user:pass@host/...` reaching this page. The merge only
 *    ever takes `host` off a configured camera (contracts/cameraView.ts is the
 *    module that resolves a full URL; this one never sees it), so there is no
 *    credential in scope to leak in the first place.
 *  - a blank standing in for a zero. A gap here is not "0 Mb/s", "0 misses" or
 *    "" for a MAC — it is a reason, so the page can say why rather than lie by
 *    omission (build rule 5).
 *
 * Linux-only sources (`ip -j neigh`, `/proc/net/arp`, `/proc/net/route`,
 * `/sys/class/net` counters, an IEEE OUI file) are ALL optional inputs here:
 * a caller running on a Windows dev box passes nulls and empty strings, and
 * every function below answers with a reason rather than throwing. That is
 * what lets this harness run on Windows (build rule 20).
 */

// ---------------------------------------------------------------------------
// A value this page could not measure carries the reason on it. Never a zero,
// never an empty string standing in for "unknown" (build rule 5).
// ---------------------------------------------------------------------------

export type Measured<T> = { kind: "measured"; value: T } | { kind: "unmeasured"; reason: string };

function measured<T>(value: T): Measured<T> {
  return { kind: "measured", value };
}
function unmeasured<T>(reason: string): Measured<T> {
  return { kind: "unmeasured", reason };
}

// ---------------------------------------------------------------------------
// Neighbour table: `ip -j neigh` and /proc/net/arp.
//
// Both name the same thing Linux calls a neighbour: an IP on this box's LAN
// segments paired with the MAC ARP (or NDP) last resolved for it. An entry
// that never resolved is not a device we have seen — it is a probe that got
// no answer — so both parsers drop it rather than reporting a MAC of zeros.
// ---------------------------------------------------------------------------

export interface NeighbourEntry {
  ip: string;
  /** Normalised lowercase, colon-separated — matches contracts/camera.ts normaliseMac. */
  mac: string;
  iface: string;
  /** The kernel's word for it: REACHABLE, STALE, DELAY, PROBE, PERMANENT, NOARP, ... */
  state: string;
}

const ALL_ZERO_MAC = "00:00:00:00:00:00";
const INCOMPLETE_STATES = new Set(["FAILED", "INCOMPLETE"]);

/** `AA:BB:CC:DD:EE:FF` / `aa-bb-cc-dd-ee-ff` / `aabbccddeeff` → `aa:bb:cc:dd:ee:ff`,
 *  or null for anything that is not six hex bytes (never thrown — a malformed
 *  lladdr on one row must not take the whole neighbour table down). */
function tryNormaliseMac(raw: string): string | null {
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return null;
  return (hex.match(/.{2}/g) as string[]).join(":");
}

function isUsableNeighbour(mac: string | null, state: string): mac is string {
  if (mac === null || mac === ALL_ZERO_MAC) return false;
  if (INCOMPLETE_STATES.has(state.toUpperCase())) return false;
  return true;
}

/**
 * `ip -j neigh` gives one JSON array, each entry shaped like
 * `{"dst":"192.168.1.5","dev":"eth0","lladdr":"aa:bb:...","state":["REACHABLE"]}`.
 * `state` is itself an array of flags; an entry with no `lladdr` at all — the
 * normal shape for a FAILED or INCOMPLETE probe — is dropped, same as one
 * whose state names FAILED or INCOMPLETE outright.
 *
 * Malformed JSON, or anything that is not an array, is "unavailable" rather
 * than thrown: a truncated read of a live table is a fact about the moment,
 * not a bug in this parser.
 */
export function parseIpNeighJson(json: string): Measured<NeighbourEntry[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return unmeasured(`ip -j neigh gave unparseable JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    return unmeasured("ip -j neigh gave JSON that was not an array");
  }
  const out: NeighbourEntry[] = [];
  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const ip = typeof r["dst"] === "string" ? r["dst"] : null;
    const iface = typeof r["dev"] === "string" ? r["dev"] : null;
    const states = Array.isArray(r["state"]) ? (r["state"] as unknown[]) : [];
    const state = states.find((s): s is string => typeof s === "string") ?? "";
    const lladdr = typeof r["lladdr"] === "string" ? r["lladdr"] : null;
    if (ip === null || iface === null) continue;
    const mac = lladdr === null ? null : tryNormaliseMac(lladdr);
    if (!isUsableNeighbour(mac, state)) continue;
    out.push({ ip, mac, iface, state });
  }
  return measured(out);
}

/**
 * /proc/net/arp is a fixed-width text table:
 * ```
 * IP address       HW type     Flags       HW address            Mask     Device
 * 192.168.1.1      0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0
 * 192.168.1.5      0x1         0x0         00:00:00:00:00:00     *        eth0
 * ```
 * Flags is a bitmask; ATF_COM (0x2) is the only bit meaning "resolved" — a row
 * with it unset (0x0, "incomplete") is a probe that got no answer, and is
 * dropped exactly like an INCOMPLETE row from `ip neigh` above. There is no
 * finer-grained state than that in this file, so every kept row reports
 * "REACHABLE": true where /proc/net/arp cannot distinguish STALE from fresh.
 */
export function parseProcNetArp(text: string): Measured<NeighbourEntry[]> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return unmeasured("/proc/net/arp was empty");
  const out: NeighbourEntry[] = [];
  // First line is the header; skip it.
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    const [ip, , flagsHex, hwAddress, , device] = cols;
    if (ip === undefined || flagsHex === undefined || hwAddress === undefined || device === undefined) continue;
    const flags = Number.parseInt(flagsHex, 16);
    if (!Number.isFinite(flags) || (flags & 0x2) === 0) continue; // ATF_COM unset: incomplete
    const mac = tryNormaliseMac(hwAddress);
    if (!isUsableNeighbour(mac, "REACHABLE")) continue;
    out.push({ ip, mac, iface: device, state: "REACHABLE" });
  }
  return measured(out);
}

// ---------------------------------------------------------------------------
// Default gateway: `ip -j route show default` and /proc/net/route.
// ---------------------------------------------------------------------------

export type GatewayResult = Measured<string>; // the value is the gateway's IPv4 address

/**
 * `ip -j route show default` gives an array such as
 * `[{"dst":"default","gateway":"192.168.1.1","dev":"eth0", ...}]`. The first
 * entry that names a gateway wins; a default route with no gateway at all
 * (an unusual, directly-attached default) reports why rather than a made-up
 * address.
 */
export function parseIpRouteDefaultJson(json: string): GatewayResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return unmeasured(`ip -j route show default gave unparseable JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return unmeasured("no default route reported");
  }
  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    const gateway = (row as Record<string, unknown>)["gateway"];
    if (typeof gateway === "string" && gateway !== "") return measured(gateway);
  }
  return unmeasured("default route has no gateway address");
}

/** One IPv4 octet, MSB first, for turning /proc/net/route's little-endian hex
 *  back into a normal dotted address. */
function ipv4FromLittleEndianHex(hex: string): string | null {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
  const bytes = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)];
  return bytes.map((b) => Number.parseInt(b, 16)).join(".");
}

/**
 * /proc/net/route is tab/space-separated text:
 * ```
 * Iface   Destination Gateway     Flags   RefCnt  Use Metric  Mask        MTU Window  IRTT
 * eth0    00000000    0101A8C0    0003    0       0   0       00000000    0   0       0
 * ```
 * Destination `00000000` is the default route. Gateway is 32 bits of
 * little-endian hex — `0101A8C0` reads back to front as `C0.A8.01.01`, i.e.
 * `192.168.1.1` — NOT the digit-for-digit `01.01.A8.C0` a naive read would
 * give. Flags bit 0x2 (RTF_GATEWAY) must be set, and a gateway of all zeros
 * is a directly-attached default with no next hop to report.
 */
export function parseProcNetRouteGateway(text: string): GatewayResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return unmeasured("/proc/net/route was empty");
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    const [, destination, gatewayHex, flagsHex] = cols;
    if (destination === undefined || gatewayHex === undefined || flagsHex === undefined) continue;
    if (destination.toLowerCase() !== "00000000") continue;
    const flags = Number.parseInt(flagsHex, 16);
    if (!Number.isFinite(flags) || (flags & 0x2) === 0) continue; // RTF_GATEWAY unset
    const gateway = ipv4FromLittleEndianHex(gatewayHex);
    if (gateway === null || gateway === "0.0.0.0") continue;
    return measured(gateway);
  }
  return unmeasured("no default route reported");
}

// ---------------------------------------------------------------------------
// Interface counters: /sys/class/net/<iface>/statistics/{rx,tx}_bytes,
// sampled twice a minute apart, turned into a rate.
//
// THE FAILURE FEARED HERE: a counter that resets (interface flap, driver
// reload, a 32-bit counter wrapping past 4294967295) makes the second reading
// SMALLER than the first. Subtracting anyway gives a large negative number
// that a careless display renders as a negative bandwidth — plausible-looking
// and wrong. This reports "counter reset" instead of a number; it does not
// try to guess the true rate across the reset, because there is no way to.
// ---------------------------------------------------------------------------

export interface CounterSample {
  atUtc: string;
  /** Cumulative bytes since boot, as the kernel counts them. */
  bytes: number;
}

export type RateResult =
  | { kind: "ok"; mbps: number }
  | { kind: "counter_reset"; reason: string }
  | { kind: "unavailable"; reason: string };

/**
 * `prev` is the sample from the previous minute (or null, meaning this is the
 * first sample this box has ever taken for the interface — there is nothing
 * to subtract from yet). `next` is the current one.
 */
export function counterRate(prev: CounterSample | null, next: CounterSample): RateResult {
  if (prev === null) return { kind: "unavailable", reason: "only one sample so far; measuring since it was taken" };

  const prevMs = Date.parse(prev.atUtc);
  const nextMs = Date.parse(next.atUtc);
  if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs)) {
    return { kind: "unavailable", reason: "a sample's timestamp did not parse" };
  }
  const deltaSeconds = (nextMs - prevMs) / 1000;
  if (deltaSeconds <= 0) {
    return { kind: "unavailable", reason: `samples ${deltaSeconds}s apart; need a positive interval` };
  }

  if (next.bytes < prev.bytes) {
    return {
      kind: "counter_reset",
      reason: `counter went from ${prev.bytes} to ${next.bytes} bytes; the interface reset or its counter wrapped`,
    };
  }

  const deltaBytes = next.bytes - prev.bytes;
  const mbps = (deltaBytes * 8) / deltaSeconds / 1_000_000;
  return { kind: "ok", mbps };
}

// ---------------------------------------------------------------------------
// IEEE OUI list: /usr/share/ieee-data/oui.txt or /usr/share/misc/oui.txt.
//
// No list on the box is a fact about the box, not a reason to guess: every
// lookup against a null table answers "no maker list on this box", never a
// vendor name pulled from contracts/camera.ts's small hardcoded set (that
// list exists for a different job — a coarse guess when nothing else is
// known — and mixing the two would make an unverified guess look as solid as
// a name read off a real registry).
// ---------------------------------------------------------------------------

/** OUI prefix (`aa:bb:cc`, lowercase) → manufacturer name. */
export type OuiLookup = ReadonlyMap<string, string>;

const OUI_LINE = /^([0-9A-Fa-f]{2})-([0-9A-Fa-f]{2})-([0-9A-Fa-f]{2})\s+\(hex\)\s*\t*\s*(.+?)\s*$/;

/**
 * The IEEE registry's text format repeats every prefix twice, once as
 * `XX-XX-XX   (hex)\t\tVendor` and once as `XXXXXX     (base 16)\t\tVendor`.
 * Only the `(hex)` line is parsed — the `(base 16)` line names the identical
 * vendor for the identical prefix, so parsing both would do nothing but
 * duplicate work. A line that matches neither pattern is skipped rather than
 * failing the whole file: this list is thousands of lines of vendor-submitted
 * text, and one malformed row must not blank out every camera's maker.
 */
export function parseOuiText(text: string): OuiLookup {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = OUI_LINE.exec(line);
    if (match === null) continue;
    const [, a, b, c, vendor] = match as unknown as [string, string, string, string, string];
    const prefix = `${a}:${b}:${c}`.toLowerCase();
    out.set(prefix, vendor);
  }
  return out;
}

export type MakerResult =
  | { kind: "known"; maker: string }
  | { kind: "unknown_oui"; reason: string }
  | { kind: "no_list"; reason: string };

/**
 * `lookup` is null exactly when neither oui.txt path exists on this box —
 * "no maker list on this box" is then the honest answer for every MAC, never
 * a guess from contracts/camera.ts's short hardcoded vendor set.
 */
export function makerForMac(mac: string, lookup: OuiLookup | null): MakerResult {
  if (lookup === null) return { kind: "no_list", reason: "no maker list on this box" };
  const normalised = tryNormaliseMac(mac);
  const prefix = normalised === null ? mac.toLowerCase().slice(0, 8) : normalised.slice(0, 8);
  const maker = lookup.get(prefix);
  if (maker === undefined) {
    return { kind: "unknown_oui", reason: `${prefix} is not in this box's maker list` };
  }
  return { kind: "known", maker };
}

// ---------------------------------------------------------------------------
// Discovery replies: agent/sadp.mjs and agent/wsdiscovery.mjs's own shapes,
// normalised to one type so the merge below does not care which protocol
// answered.
// ---------------------------------------------------------------------------

/** As discoverSadp() resolves one entry (contracts has no import on agent/ —
 *  this mirrors the shape by hand, deliberately, so this file stays free of
 *  I/O). */
export interface SadpReply {
  mac: string | null;
  ip: string | null;
  model: string | null;
  serial: string | null;
  firmware: string | null;
}

/** As discoverOnvif() resolves one entry. WS-Discovery's scopes carry a
 *  vendor "hardware" string and no firmware or serial at all. */
export interface WsDiscoveryReply {
  ip: string;
  xaddrs: string[];
  name?: string;
  hardware?: string;
  location?: string;
}

export interface DiscoveryReply {
  source: "sadp" | "wsdiscovery";
  /** When this reply was received — the caller's clock, not this file's. */
  atUtc: string;
  ip: string | null;
  mac: string | null;
  model: string | null;
  firmware: string | null;
  serial: string | null;
}

export function normaliseSadpReply(raw: SadpReply, atUtc: string): DiscoveryReply {
  return {
    source: "sadp",
    atUtc,
    ip: raw.ip,
    mac: raw.mac === null ? null : tryNormaliseMac(raw.mac),
    model: raw.model,
    firmware: raw.firmware,
    serial: raw.serial,
  };
}

export function normaliseWsDiscoveryReply(raw: WsDiscoveryReply, atUtc: string): DiscoveryReply {
  return {
    source: "wsdiscovery",
    atUtc,
    ip: raw.ip,
    mac: null, // WS-Discovery's probe match carries no MAC; only SADP does.
    model: raw.hardware ?? null,
    firmware: null, // not carried by ONVIF's discovery scopes
    serial: null,
  };
}

/**
 * "Two devices on one IP": within a single discovery run, more than one
 * reply naming the same IP but a different (non-null) MAC. This is a
 * measurement — two things answered for one address — never collapsed into
 * one row, because collapsing it is exactly how a spoofed or cloned camera
 * would go unnoticed.
 */
export interface IpCollision {
  ip: string;
  macs: string[];
  replies: DiscoveryReply[];
}

export function detectIpCollisions(replies: readonly DiscoveryReply[]): IpCollision[] {
  const byIp = new Map<string, DiscoveryReply[]>();
  for (const r of replies) {
    if (r.ip === null) continue;
    const list = byIp.get(r.ip);
    if (list === undefined) byIp.set(r.ip, [r]);
    else list.push(r);
  }
  const out: IpCollision[] = [];
  for (const [ip, group] of byIp) {
    const macs = [...new Set(group.map((r) => r.mac).filter((m): m is string => m !== null))];
    if (macs.length > 1) out.push({ ip, macs, replies: group });
  }
  return out;
}

// ---------------------------------------------------------------------------
// MAC history and change detection: <stateDir>/network-macs.json, kept by the
// I/O layer as { ip, mac, firstSeenUtc, lastSeenUtc }[]. This file only reads
// it; writing it back (tmp then rename) is agent/network-facts.mjs's job.
// ---------------------------------------------------------------------------

export interface MacHistoryEntry {
  ip: string;
  mac: string;
  firstSeenUtc: string;
  lastSeenUtc: string;
}

export type MacChangeResult =
  | { kind: "unchanged" }
  | { kind: "first_seen" }
  | { kind: "changed"; from: string; to: string; note: string };

/**
 * Compare the MAC currently seen for `ip` against its most recent history
 * entry. `history` need not be pre-filtered to this IP.
 *
 * "changed" carries a MEASUREMENT, not a verdict — the same ambiguity
 * contracts/camera.ts's matchIdentity names: it could be a swapped camera or
 * two devices sharing one address, and this file does not choose between
 * them (build rule 11).
 */
export function detectMacChange(ip: string, currentMac: string, history: readonly MacHistoryEntry[], atUtc: string): MacChangeResult {
  let latest: MacHistoryEntry | null = null;
  for (const entry of history) {
    if (entry.ip !== ip) continue;
    if (latest === null || Date.parse(entry.lastSeenUtc) > Date.parse(latest.lastSeenUtc)) latest = entry;
  }
  if (latest === null) return { kind: "first_seen" };
  if (latest.mac === currentMac) return { kind: "unchanged" };
  return {
    kind: "changed",
    from: latest.mac,
    to: currentMac,
    note: `MAC for ${ip} changed from ${latest.mac} to ${currentMac} at ${atUtc}`,
  };
}

// ---------------------------------------------------------------------------
// The merge: configured cameras + neighbour table + discovery + probes +
// recording facts + MAC history + OUI list → camera rows and other-device
// rows.
// ---------------------------------------------------------------------------

/** config.json's `cameras`, trimmed to what this page is allowed to show —
 *  never the full contracts/cameraView.ts CameraConfigEntry, which carries a
 *  url that can hold a password. */
export interface ConfiguredCameraInput {
  cameraId: string;
  name: string | null;
  /** The bare host from config — never a resolved URL. Null when unconfigured. */
  host: string | null;
}

export interface ProbeInput {
  lastAnsweredUtc: string | null;
  rttMs: number | null;
  consecutiveMisses: number;
}

export interface RecordingFactInput {
  lastSealedUtc: string | null;
  measuredKbps: number | null;
  /** Only when some other reusable measurement supplies it; otherwise null. */
  fps: number | null;
}

export interface CameraRow {
  cameraId: string;
  name: string | null;
  ip: Measured<string>;
  mac: Measured<string>;
  maker: MakerResult;
  model: Measured<string>;
  firmware: Measured<string>;
  serial: Measured<string>;
  lastAnsweredUtc: Measured<string>;
  rttMs: Measured<number>;
  /** Null when the camera was never connected to (lastAnsweredUtc says why). */
  consecutiveMisses: number | null;
  lastSealedUtc: Measured<string>;
  measuredKbps: Measured<number>;
  fps: Measured<number>;
  macChange: MacChangeResult;
}

export interface OtherDeviceRow {
  ip: string;
  mac: Measured<string>;
  maker: MakerResult;
  iface: Measured<string>;
  state: Measured<string>;
  model: Measured<string>;
  firmware: Measured<string>;
}

export interface NetworkViewInput {
  atUtc: string;
  cameras: readonly ConfiguredCameraInput[];
  neighbours: readonly NeighbourEntry[];
  discovery: readonly DiscoveryReply[];
  /** Keyed by cameraId. A camera missing here has never been probed. */
  probes: ReadonlyMap<string, ProbeInput>;
  /** Keyed by cameraId. */
  recording: ReadonlyMap<string, RecordingFactInput>;
  macHistory: readonly MacHistoryEntry[];
  ouiLookup: OuiLookup | null;
}

export interface NetworkView {
  atUtc: string;
  cameras: CameraRow[];
  otherDevices: OtherDeviceRow[];
  ipCollisions: IpCollision[];
}

function latestDiscoveryFor(ip: string | null, mac: string | null, discovery: readonly DiscoveryReply[]): DiscoveryReply | null {
  let best: DiscoveryReply | null = null;
  for (const reply of discovery) {
    const matches = (ip !== null && reply.ip === ip) || (mac !== null && reply.mac === mac);
    if (!matches) continue;
    if (best === null || Date.parse(reply.atUtc) > Date.parse(best.atUtc)) best = reply;
  }
  return best;
}

/**
 * Build the whole page's row data from already-gathered facts.
 *
 * Order of the merge, per camera:
 *  1. ip: the configured host, or "unmeasured" ("no host configured") — never
 *     the resolved stream URL's host (that can differ per-channel and is
 *     contracts/cameraView.ts's business, not this page's).
 *  2. mac: from the neighbour table entry whose ip matches, or "not in this
 *     NVR's neighbour table" when ip itself is measured but absent from the
 *     table, or "no IP to look up" when ip could not even be measured.
 *  3. maker: makerForMac() of the mac just found; "no MAC to look up" when
 *     there was no mac.
 *  4. model / firmware / serial: from the latest discovery reply matching ip
 *     or mac; "not reported" otherwise.
 *  5. probe fields, recording fields: straight from the input maps, each
 *     null value turned into its own reason.
 *  6. macChange: detectMacChange() against history, only when a mac was
 *     actually measured (a camera with no MAC to compare has nothing to
 *     compare).
 *
 * Other devices are every neighbour entry whose IP is not any configured
 * camera's host, plus every discovery reply whose IP AND mac (when it has
 * one) are not any configured camera's — each discovery reply becomes its
 * own row rather than being collapsed onto a matching neighbour entry by IP,
 * because two replies can share an IP with different MACs (an IpCollision)
 * and neither is more authoritative than the other.
 */
export function buildNetworkView(input: NetworkViewInput): NetworkView {
  const neighbourByIp = new Map<string, NeighbourEntry>();
  for (const n of input.neighbours) neighbourByIp.set(n.ip, n);

  const configuredHosts = new Set(
    input.cameras.map((c) => c.host).filter((h): h is string => h !== null),
  );

  const cameras: CameraRow[] = input.cameras.map((camera) => {
    const ip: Measured<string> = camera.host === null ? unmeasured("no host configured") : measured(camera.host);

    let mac: Measured<string>;
    if (ip.kind === "unmeasured") {
      mac = unmeasured("no IP to look up");
    } else {
      const neighbour = neighbourByIp.get(ip.value);
      mac = neighbour === undefined ? unmeasured("not in this NVR's neighbour table") : measured(neighbour.mac);
    }

    const maker: MakerResult = mac.kind === "measured" ? makerForMac(mac.value, input.ouiLookup)
      : { kind: "unknown_oui", reason: "no MAC to look up" };

    const discoveryReply = latestDiscoveryFor(
      ip.kind === "measured" ? ip.value : null,
      mac.kind === "measured" ? mac.value : null,
      input.discovery,
    );
    const model: Measured<string> = discoveryReply?.model != null ? measured(discoveryReply.model) : unmeasured("not reported");
    const firmware: Measured<string> = discoveryReply?.firmware != null ? measured(discoveryReply.firmware) : unmeasured("not reported");
    const serial: Measured<string> = discoveryReply?.serial != null ? measured(discoveryReply.serial) : unmeasured("not reported");

    // No probe entry means this camera was never connected to at all - not
    // "answered 0 times out of 0" (rule 5: a blank is not a zero). The sampler
    // skips a camera it cannot place on the LAN, and every camera is unprobed
    // until the first tick; the reason says which.
    const probe = input.probes.get(camera.cameraId) ?? null;
    const notChecked = ip.kind === "measured" ? "not checked yet" : "not checked: no address for this camera";
    const lastAnsweredUtc: Measured<string> =
      probe === null ? unmeasured(notChecked)
        : probe.lastAnsweredUtc != null ? measured(probe.lastAnsweredUtc) : unmeasured("no answer yet");
    const rttMs: Measured<number> =
      probe === null ? unmeasured(notChecked)
        : probe.rttMs != null ? measured(probe.rttMs) : unmeasured("no answer yet");
    const consecutiveMisses: number | null = probe === null ? null : probe.consecutiveMisses;

    const recording = input.recording.get(camera.cameraId) ?? null;
    const lastSealedUtc: Measured<string> =
      recording?.lastSealedUtc != null ? measured(recording.lastSealedUtc) : unmeasured("no sealed segment yet");
    const measuredKbps: Measured<number> =
      recording?.measuredKbps != null ? measured(recording.measuredKbps) : unmeasured("not measured");
    const fps: Measured<number> = recording?.fps != null ? measured(recording.fps) : unmeasured("not measured");

    const macChange: MacChangeResult =
      mac.kind === "measured" && ip.kind === "measured"
        ? detectMacChange(ip.value, mac.value, input.macHistory, input.atUtc)
        : { kind: "unchanged" };

    return {
      cameraId: camera.cameraId,
      name: camera.name,
      ip,
      mac,
      maker,
      model,
      firmware,
      serial,
      lastAnsweredUtc,
      rttMs,
      consecutiveMisses,
      lastSealedUtc,
      measuredKbps,
      fps,
      macChange,
    };
  });

  const otherDevices: OtherDeviceRow[] = [];
  for (const n of input.neighbours) {
    if (configuredHosts.has(n.ip)) continue;
    otherDevices.push({
      ip: n.ip,
      mac: measured(n.mac),
      maker: makerForMac(n.mac, input.ouiLookup),
      iface: measured(n.iface),
      state: measured(n.state),
      model: unmeasured("no discovery reply for this device"),
      firmware: unmeasured("no discovery reply for this device"),
    });
  }
  for (const reply of input.discovery) {
    if (reply.ip !== null && configuredHosts.has(reply.ip)) continue;
    if (reply.mac !== null && input.cameras.some((c) => {
      const n = c.host === null ? undefined : neighbourByIp.get(c.host);
      return n?.mac === reply.mac;
    })) continue;
    otherDevices.push({
      ip: reply.ip ?? "unknown",
      mac: reply.mac !== null ? measured(reply.mac) : unmeasured("not carried by this discovery protocol"),
      maker: reply.mac !== null ? makerForMac(reply.mac, input.ouiLookup) : { kind: "unknown_oui", reason: "no MAC to look up" },
      iface: unmeasured("not in the neighbour table"),
      state: unmeasured("not in the neighbour table"),
      model: reply.model !== null ? measured(reply.model) : unmeasured("not reported"),
      firmware: reply.firmware !== null ? measured(reply.firmware) : unmeasured("not reported"),
    });
  }

  return {
    atUtc: input.atUtc,
    cameras,
    otherDevices,
    ipCollisions: detectIpCollisions(input.discovery),
  };
}
