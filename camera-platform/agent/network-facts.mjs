// agent/network-facts.mjs
//
// I/O for the Network page (NETWORK-PAGE-SPEC.md). Every external source is
// injectable: `ip`/`/proc`/`/sys` reads, the two execFile calls (ping,
// timedatectl), the DNS lookup, the TCP connects, the OUI file, and the two
// existing discovery protocols. The pure merge and every text parser live in
// contracts/networkView.ts (compiled to ../dist/networkView.js); this file's
// only job is to fetch what that file expects to be handed already read
// (build rules 1-2 — contract, then this I/O layer, then the UI).
//
// LINUX-ONLY, ALWAYS: `ip`, `/proc/net/arp`, `/proc/net/route`,
// `/sys/class/net/*`, `ping`, `timedatectl` and the IEEE OUI file. None of
// them exist on the Windows box this harness runs on (build rule 20), so
// every one of them is gated on `platform === 'linux'` and answers "not
// available on this system" — never a throw, never a zero standing in for a
// measurement that was never taken.
//
// THE FEARED FAILURE, same one contracts/networkView.ts names: a camera's
// `rtsp://user:pass@host/...` reaching a response body or a log line. This
// file never imports resolveCameraUrl or cameraView's full CameraConfigEntry
// handling — it only ever pulls the bare `host` (and, for the RTSP probe, the
// `port`) out of a camera's configured `url` or `host` field via
// contracts/cameraSource.ts's parseRtspUrl, and never reads that parse
// result's `username` or `password` fields at all.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as readFileCb, readdir as readdirCb, writeFile, rename, mkdir } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import dns from 'node:dns';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import {
  parseIpNeighJson,
  parseProcNetArp,
  parseIpRouteDefaultJson,
  parseProcNetRouteGateway,
  parseOuiText,
  normaliseSadpReply,
  normaliseWsDiscoveryReply,
  buildNetworkView,
  counterRate,
} from '../dist/networkView.js';
import { parseIpv4, CidrError } from '../dist/net.js';
import { parseRtspUrl } from '../dist/cameraSource.js';
import { cameraFacts } from './healthfacts.mjs';

const execFileAsync = promisify(execFileCb);
const dnsLookupAsync = promisify(dns.lookup);

const NOT_ON_THIS_SYSTEM = 'not available on this system';
const isLinux = (platform) => platform === 'linux';

/** MAC history: <stateDir>/network-macs.json, tmp then rename. */
export const NETWORK_MACS_FILE = 'network-macs.json';

/** Samplers (agent/api-server.mjs owns starting these; see startNetworkFacts). */
export const COUNTER_SAMPLE_INTERVAL_MS = 60_000;
export const COUNTER_SAMPLE_HISTORY = 60; // one hour at one sample a minute
export const CAMERA_PROBE_INTERVAL_MS = 60_000;
export const CAMERA_PROBE_TIMEOUT_MS = 2_000;
export const CONNECTION_CHECK_INTERVAL_MS = 5 * 60_000;
export const CONNECTION_CHECK_MIN_GAP_MS = 30_000; // "at most once per 30s" on request
export const DISCOVER_MIN_GAP_MS = 60_000; // the button, "at most once per 60s"

// The internet check's two fixed destinations (spec: "TCP connect to 1.1.1.1:443
// and 8.8.8.8:443"). Named, not just addressed, so a log line reads as
// "internet.cloudflare" rather than a bare IP nobody remembers the reason for.
const INTERNET_TARGETS = [
  { name: 'cloudflare', host: '1.1.1.1', port: 443 },
  { name: 'google', host: '8.8.8.8', port: 443 },
];

// "one fixed name" (spec). Cloudflare's own canonical hostname for 1.1.1.1 —
// a DNS failure and an internet-check failure then point at genuinely
// different things instead of both being "some Cloudflare address didn't
// answer".
const DEFAULT_DNS_CHECK_NAME = 'one.one.one.one';

const OUI_PATHS = ['/usr/share/ieee-data/oui.txt', '/usr/share/misc/oui.txt'];

// ---------------------------------------------------------------------------
// Configured cameras -> the trimmed shape contracts/networkView.ts will take.
// Never the full CameraConfigEntry: that type's `url` can carry a password.
// ---------------------------------------------------------------------------

/**
 * The bare host a camera is configured at — from its `url` when it has one
 * (parsed, credentials discarded unread), else its `host`. Null when neither
 * is set or the url does not parse: a camera network-facts cannot place on
 * the LAN at all, same as cameraView.ts's own "no host configured" case.
 */
export function hostFromCamera(camera) {
  if (typeof camera.url === 'string' && camera.url.trim() !== '') {
    const parsed = parseRtspUrl(camera.url);
    return parsed.kind === 'ok' ? parsed.host : null;
  }
  if (typeof camera.host === 'string' && camera.host.trim() !== '') return camera.host;
  return null;
}

/** The RTSP port to probe: from a configured url when it has one, else the
 *  vendor-agnostic default every camera answers RTSP on unless told otherwise. */
export function rtspPortFromCamera(camera) {
  if (typeof camera.url === 'string' && camera.url.trim() !== '') {
    const parsed = parseRtspUrl(camera.url);
    if (parsed.kind === 'ok') return parsed.port;
  }
  return 554;
}

/** config.cameras -> contracts/networkView.ts's ConfiguredCameraInput[]. */
export function configuredCamerasFor(config) {
  return config.cameras.map((c) => ({
    cameraId: c.cameraId,
    name: c.name ?? null,
    host: hostFromCamera(c),
  }));
}

// ---------------------------------------------------------------------------
// Neighbour table and default gateway: `ip -j ...` first, `/proc/net/...`
// when `ip` is not on this box. Both Linux-only (build rule 20).
// ---------------------------------------------------------------------------

async function runIp(execFileFn, args) {
  const { stdout } = await execFileFn('ip', args, { timeout: 5_000 });
  return stdout;
}

/**
 * The neighbour table, unwrapped to a plain array (never Measured<...>): a
 * table this box could not read is reported to the page as an empty one, and
 * every camera's own "not in this NVR's neighbour table" reason still fires —
 * there is no separate "the whole table was unreadable" case to invent.
 */
export async function readNeighbours({ platform = process.platform, execFileFn = execFileAsync, readFileFn = readFileCb } = {}) {
  if (!isLinux(platform)) return [];
  try {
    const json = await runIp(execFileFn, ['-j', 'neigh']);
    const result = parseIpNeighJson(json);
    if (result.kind === 'measured') return result.value;
  } catch {
    // `ip` missing, or it failed outright — fall back to /proc/net/arp below.
  }
  try {
    const text = await readFileFn('/proc/net/arp', 'utf8');
    const result = parseProcNetArp(text);
    return result.kind === 'measured' ? result.value : [];
  } catch {
    return [];
  }
}

/** The default gateway's address, as a Measured<string> — used for the ping
 *  check, not fed into buildNetworkView (the contract has no use for it). */
export async function readDefaultGateway({ platform = process.platform, execFileFn = execFileAsync, readFileFn = readFileCb } = {}) {
  if (!isLinux(platform)) return { kind: 'unmeasured', reason: NOT_ON_THIS_SYSTEM };
  try {
    const json = await runIp(execFileFn, ['-j', 'route', 'show', 'default']);
    const result = parseIpRouteDefaultJson(json);
    if (result.kind === 'measured') return result;
  } catch {
    // fall back below
  }
  try {
    const text = await readFileFn('/proc/net/route', 'utf8');
    return parseProcNetRouteGateway(text);
  } catch (err) {
    return { kind: 'unmeasured', reason: `could not read /proc/net/route: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// The IEEE OUI list. Linux-only; null (never an empty map) when neither path
// exists, so makerForMac answers "no maker list on this box" for every MAC
// rather than "unknown_oui" for all of them (contracts/net.ts's own distinction).
// ---------------------------------------------------------------------------

export async function readOuiLookup({ platform = process.platform, readFileFn = readFileCb, paths = OUI_PATHS } = {}) {
  if (!isLinux(platform)) return null;
  for (const p of paths) {
    try {
      const text = await readFileFn(p, 'utf8');
      return parseOuiText(text);
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connection checks: a measured value and a time, never a verdict beyond
// "answered in N ms" or "no answer within N ms" (spec section 2).
// ---------------------------------------------------------------------------

export function withinMsResult(ms) {
  return { kind: 'no_answer', withinMs: ms };
}

/**
 * One ICMP echo to the gateway, via `ping` (execFile, no shell). The gateway
 * string is validated with contracts/net.ts's parseIpv4 BEFORE it ever
 * becomes an execFile argument (hard rule) — anything that is not a plain
 * IPv4 address is refused here, never handed to a child process.
 */
export async function pingGateway(gateway, { platform = process.platform, execFileFn = execFileAsync, timeoutMs = 2_000 } = {}) {
  if (gateway === null || gateway === undefined) {
    return { kind: 'unmeasured', reason: 'no gateway to ping' };
  }
  try {
    parseIpv4(gateway);
  } catch (err) {
    if (err instanceof CidrError) {
      return { kind: 'unmeasured', reason: `gateway ${JSON.stringify(gateway)} is not an IPv4 address; refusing to ping it` };
    }
    throw err;
  }
  if (!isLinux(platform)) return { kind: 'unmeasured', reason: NOT_ON_THIS_SYSTEM };
  const started = Date.now();
  try {
    await execFileFn('ping', ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), gateway], {
      timeout: timeoutMs + 500,
    });
    return { kind: 'answered', ms: Date.now() - started };
  } catch (err) {
    return { ...withinMsResult(timeoutMs), reason: err.killed ? 'timed out' : String(err.message ?? err) };
  }
}

/** `dns.lookup` of one fixed name. Not Linux-only — Node's own resolver works
 *  on Windows too, and the harness runs there. */
export async function checkDns(hostname = DEFAULT_DNS_CHECK_NAME, { dnsLookupFn = dnsLookupAsync, timeoutMs = 2_000 } = {}) {
  const started = Date.now();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const raced = await Promise.race([dnsLookupFn(hostname).then((r) => ({ timedOut: false, result: r })), timeout]);
    if (raced.timedOut) return { ...withinMsResult(timeoutMs), reason: 'timed out' };
    const address = typeof raced.result === 'string' ? raced.result : raced.result?.address ?? null;
    return { kind: 'answered', ms: Date.now() - started, address };
  } catch (err) {
    return { ...withinMsResult(timeoutMs), reason: String(err.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** A bare TCP connect, no protocol spoken: used for both the internet check
 *  (1.1.1.1:443, 8.8.8.8:443) and each camera's RTSP-port probe. */
export function tcpConnectCheck(host, port, { timeoutMs = 2_000, connectFn = (h, p) => netConnect({ host: h, port: p }) } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    try {
      socket = connectFn(host, port);
    } catch (err) {
      finish({ ...withinMsResult(timeoutMs), reason: String(err.message ?? err) });
      return;
    }
    socket.setTimeout?.(timeoutMs);
    socket.once('connect', () => finish({ kind: 'answered', ms: Date.now() - started }));
    socket.once('timeout', () => finish({ ...withinMsResult(timeoutMs), reason: 'timed out' }));
    socket.once('error', (err) => finish({ ...withinMsResult(timeoutMs), reason: String(err.message ?? err) }));
  });
}

/** `timedatectl show -p NTPSynchronized --value`. Linux-only. */
export async function checkClockSync({ platform = process.platform, execFileFn = execFileAsync } = {}) {
  if (!isLinux(platform)) return { kind: 'unmeasured', reason: NOT_ON_THIS_SYSTEM };
  try {
    const { stdout } = await execFileFn('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 5_000 });
    const value = stdout.trim();
    if (value === 'yes') return { kind: 'measured', value: true };
    if (value === 'no') return { kind: 'measured', value: false };
    return { kind: 'unmeasured', reason: `timedatectl gave unexpected output: ${JSON.stringify(value)}` };
  } catch (err) {
    return { kind: 'unmeasured', reason: `timedatectl failed: ${String(err.message ?? err)}` };
  }
}

/** CLOUD-B1-SPEC.md does not exist yet — this is the whole answer until it does. */
export function cloudCheck() {
  return { kind: 'unmeasured', reason: 'no cloud service configured' };
}

// ---------------------------------------------------------------------------
// Discovery: agent/sadp.mjs and agent/wsdiscovery.mjs, run exactly as
// `camctl discover` does, then normalised through the same contract functions
// as everything else so the merge never has to know which protocol answered.
// ---------------------------------------------------------------------------

/**
 * Run SADP and WS-Discovery once, normalising each raw reply the moment it
 * is received (its `onRaw` callback fires per UDP packet, before the
 * protocol's own collect-for-waitMs loop finishes) — the contract's atUtc
 * is stamped from THIS wall clock, matching what "Look for cameras" is
 * actually a measurement of, not the instant the whole run finished.
 */
export async function runCameraDiscovery({
  discoverSadpFn,
  discoverOnvifFn,
  interfaceAddress = null,
  broadcast = null,
  now = () => new Date(),
} = {}) {
  const sadpAtByFrom = new Map();
  const wsdAtByFrom = new Map();
  const sadpRaw = await discoverSadpFn({
    ...(interfaceAddress !== null ? { interfaceAddress } : {}),
    ...(broadcast !== null ? { broadcast } : {}),
    onRaw: ({ from }) => {
      if (!sadpAtByFrom.has(from)) sadpAtByFrom.set(from, now().toISOString());
    },
  });
  const wsdRaw = await discoverOnvifFn({
    ...(interfaceAddress !== null ? { interfaceAddress } : {}),
    onRaw: ({ from }) => {
      if (!wsdAtByFrom.has(from)) wsdAtByFrom.set(from, now().toISOString());
    },
  });
  const fallbackAtUtc = now().toISOString();
  return [
    ...sadpRaw.map((r) => normaliseSadpReply(r, sadpAtByFrom.get(r.from) ?? fallbackAtUtc)),
    ...wsdRaw.map((r) => normaliseWsDiscoveryReply(r, wsdAtByFrom.get(r.ip) ?? fallbackAtUtc)),
  ];
}

// ---------------------------------------------------------------------------
// MAC history: <stateDir>/network-macs.json. Read whole, written tmp then
// rename (the same pattern as agent/event-retention.mjs's own state file and
// agent/known-objects.mjs's store) — this file owns the write; the read side
// contracts/networkView.ts's detectMacChange takes is a plain array it hands in.
// ---------------------------------------------------------------------------

/** A corrupt or absent history file is an empty history, not an error: the
 *  page still works, it just has nothing to compare against yet (every
 *  camera reads as "first_seen" until this file has something written). */
export async function readMacHistory(stateDir, { readFileFn = readFileCb } = {}) {
  let text;
  try {
    text = await readFileFn(join(stateDir, NETWORK_MACS_FILE), 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e) =>
      e !== null &&
      typeof e === 'object' &&
      typeof e.ip === 'string' &&
      typeof e.mac === 'string' &&
      typeof e.firstSeenUtc === 'string' &&
      typeof e.lastSeenUtc === 'string',
  );
}

export async function writeMacHistory(stateDir, entries, { writeFileFn = writeFile, renameFn = rename, mkdirFn = mkdir } = {}) {
  await mkdirFn(stateDir, { recursive: true });
  const file = join(stateDir, NETWORK_MACS_FILE);
  const tmp = `${file}.tmp`;
  await writeFileFn(tmp, JSON.stringify(entries, null, 2) + '\n');
  await renameFn(tmp, file);
}

/**
 * Fold this pass's measured (ip, mac) pairs into the history: a pair already
 * the most recent entry for its ip is left alone but for its lastSeenUtc; a
 * new mac for an ip already seen is APPENDED (detectMacChange needs the old
 * entry still there to report what it changed from); an ip never seen before
 * gets its first entry. Returns { history, changed } — changed is false when
 * nothing needed writing, so a quiet page does not rewrite the file every pass.
 */
export function updateMacHistory(history, observed, atUtc) {
  const byIp = new Map();
  for (const entry of history) {
    const list = byIp.get(entry.ip);
    if (list === undefined) byIp.set(entry.ip, [entry]);
    else list.push(entry);
  }
  let changed = false;
  for (const { ip, mac } of observed) {
    const entries = byIp.get(ip) ?? [];
    let latest = null;
    for (const e of entries) {
      if (latest === null || Date.parse(e.lastSeenUtc) > Date.parse(latest.lastSeenUtc)) latest = e;
    }
    if (latest === null) {
      byIp.set(ip, [...entries, { ip, mac, firstSeenUtc: atUtc, lastSeenUtc: atUtc }]);
      changed = true;
    } else if (latest.mac === mac) {
      if (latest.lastSeenUtc !== atUtc) {
        latest.lastSeenUtc = atUtc;
        changed = true;
      }
    } else {
      byIp.set(ip, [...entries, { ip, mac, firstSeenUtc: atUtc, lastSeenUtc: atUtc }]);
      changed = true;
    }
  }
  const out = [];
  for (const list of byIp.values()) out.push(...list);
  return { history: out, changed };
}

// ---------------------------------------------------------------------------
// Interfaces (spec section 1). Not part of contracts/networkView.ts's
// NetworkView — that contract merges the CAMERA estate; the interface list is
// a straight read of /sys/class/net, reported with the same Measured<T>
// discipline by hand (the contract exports the TYPE, not its private
// constructors).
// ---------------------------------------------------------------------------

const SYS_CLASS_NET = '/sys/class/net';

async function readSysText(readFileFn, iface, relPath) {
  try {
    return (await readFileFn(join(SYS_CLASS_NET, iface, relPath), 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readSysCounter(readFileFn, iface, relPath) {
  const text = await readSysText(readFileFn, iface, relPath);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Interface names under /sys/class/net, loopback excluded. Linux-only. */
export async function listInterfaceNames({ platform = process.platform, readdirFn = readdirCb } = {}) {
  if (!isLinux(platform)) return [];
  try {
    return (await readdirFn(SYS_CLASS_NET)).filter((n) => n !== 'lo');
  } catch {
    return [];
  }
}

/**
 * One interface's link state, negotiated speed/duplex and error/drop
 * counters (everything BUT the rx/tx rate, which needs two samples a minute
 * apart — see sampleCounters below). Every field not on this system is its
 * own reason, never folded into one blanket "unavailable" for the interface.
 */
export async function readInterfaceStatics(iface, { platform = process.platform, readFileFn = readFileCb } = {}) {
  if (!isLinux(platform)) {
    const unavailable = { kind: 'unmeasured', reason: NOT_ON_THIS_SYSTEM };
    return { name: iface, operState: unavailable, speedMbps: unavailable, duplex: unavailable, errors: null, drops: null };
  }
  const operstate = await readSysText(readFileFn, iface, 'operstate');
  const speedRaw = await readSysText(readFileFn, iface, 'speed');
  const duplexRaw = await readSysText(readFileFn, iface, 'duplex');
  const speedNum = speedRaw === null ? null : Number(speedRaw);
  return {
    name: iface,
    operState: operstate === null ? { kind: 'unmeasured', reason: 'could not read operstate' } : { kind: 'measured', value: operstate },
    // A driver reports speed -1 when it has none to give (commonly: link down).
    speedMbps:
      speedNum === null || !Number.isFinite(speedNum) || speedNum < 0
        ? { kind: 'unmeasured', reason: speedRaw === null ? 'could not read speed' : 'no negotiated speed reported (link may be down)' }
        : { kind: 'measured', value: speedNum },
    duplex:
      duplexRaw === null || duplexRaw === 'unknown'
        ? { kind: 'unmeasured', reason: duplexRaw === null ? 'could not read duplex' : 'duplex not reported' }
        : { kind: 'measured', value: duplexRaw },
    errors: {
      rx: await readSysCounter(readFileFn, iface, 'statistics/rx_errors'),
      tx: await readSysCounter(readFileFn, iface, 'statistics/tx_errors'),
    },
    drops: {
      rx: await readSysCounter(readFileFn, iface, 'statistics/rx_dropped'),
      tx: await readSysCounter(readFileFn, iface, 'statistics/tx_dropped'),
    },
  };
}

/** One rx/tx byte-counter snapshot, for counterRate() to diff against the
 *  previous minute's. Null (not zero) when this system has no such file. */
export async function readCounterSample(iface, atUtc, { platform = process.platform, readFileFn = readFileCb } = {}) {
  if (!isLinux(platform)) return { rx: null, tx: null };
  return {
    rx: await readSysCounter(readFileFn, iface, 'statistics/rx_bytes').then((b) => (b === null ? null : { atUtc, bytes: b })),
    tx: await readSysCounter(readFileFn, iface, 'statistics/tx_bytes').then((b) => (b === null ? null : { atUtc, bytes: b })),
  };
}

/**
 * A count "since the page's sampling began" (spec section 1): `current` minus
 * whatever `baseline` was when the sampler first read this interface. Never
 * negative — a smaller current than baseline means the kernel's own counter
 * reset underneath the sampler (an interface flap, same failure counterRate
 * guards against for bytes), and that is reported as its own reason rather
 * than a made-up count.
 */
function sinceSamplingBegan(current, baseline) {
  if (current === null) return { kind: 'unmeasured', reason: 'could not read this counter' };
  if (baseline === null) return { kind: 'unmeasured', reason: 'not read at sampling start' };
  if (current < baseline) return { kind: 'unmeasured', reason: `counter went from ${baseline} to ${current}; the interface reset` };
  return { kind: 'measured', value: current - baseline };
}

/** True IPv4 subnet test: does `address` fall inside iface's address/netmask? */
function inSameSubnet(address, ifaceAddress, netmask) {
  try {
    const mask = parseIpv4(netmask);
    return (parseIpv4(address) & mask) >>> 0 === (parseIpv4(ifaceAddress) & mask) >>> 0;
  } catch {
    return false;
  }
}

/** Which configured cameras (by id) sit on this interface's IPv4 subnet — the
 *  spec's "mark which card the cameras are on". Cameras with no measured
 *  host are silently excluded, not counted as a miss for the interface. */
export function camerasOnInterface(cameras, ifaceAddress, netmask) {
  return cameras.filter((c) => c.host !== null && inSameSubnet(c.host, ifaceAddress, netmask)).map((c) => c.cameraId);
}

// ---------------------------------------------------------------------------
// The one entry point agent/api-server.mjs uses: samplers plus a per-request
// snapshot builder. Every timer follows event-retention.mjs's own pattern —
// run once immediately, unref()'d, cleared by the returned close hook.
// ---------------------------------------------------------------------------

/**
 * `deps` carries every injectable source; every field has a real production
 * default and the harness overrides all of them with fakes that record their
 * own destinations. `config`, `index` and `stateDir` are required; `now`
 * defaults to the wall clock like every other agent/ file's samplers.
 */
export function startNetworkFacts({
  config,
  index,
  stateDir,
  now = () => new Date(),
  interfacesOf = networkInterfaces,
  execFileFn = execFileAsync,
  readFileFn = readFileCb,
  readdirFn = readdirCb,
  dnsLookupFn = dnsLookupAsync,
  connectFn = undefined, // undefined -> tcpConnectCheck's own real-socket default
  discoverSadpFn,
  discoverOnvifFn,
  interfaceAddress = null,
  broadcast = null,
  dnsCheckName = DEFAULT_DNS_CHECK_NAME,
  platform = process.platform,
  counterIntervalMs = COUNTER_SAMPLE_INTERVAL_MS,
  probeIntervalMs = CAMERA_PROBE_INTERVAL_MS,
  connectionCheckIntervalMs = CONNECTION_CHECK_INTERVAL_MS,
  log = () => {},
}) {
  const cameras = configuredCamerasFor(config);

  // --- in-memory state the timers fill in and gatherView() reads back ---
  const counterHistory = new Map(); // iface -> { rx: CounterSample[], tx: CounterSample[] }
  const latestStatics = new Map(); // iface -> readInterfaceStatics() result, refreshed every tick
  const errorDropBaseline = new Map(); // iface -> { rx, tx } as first read at sampler start, for each of errors/drops
  const cameraProbes = new Map(); // cameraId -> ProbeInput
  let connectionChecks = null; // { atUtc, gateway: {...}, dns, internet, clock, cloud }
  let discoveryCache = null; // { atUtc, replies }
  let discoverInFlight = null; // the in-progress runCameraDiscovery() promise, or null
  let macHistory = []; // filled by ensureMacHistoryLoaded()
  let macHistoryLoaded = false;
  const samplerStartedAtUtc = now().toISOString();

  async function ensureMacHistoryLoaded() {
    if (!macHistoryLoaded) {
      macHistory = await readMacHistory(stateDir, { readFileFn });
      macHistoryLoaded = true;
    }
  }

  // --- rate limiters: "at most once per 30s" (on-request checks) and "at
  // most once per 60s" (the discover button) ---
  let lastConnectionCheckRunMs = null;
  let lastDiscoverRunMs = null;

  async function refreshConnectionChecks() {
    const atUtc = now().toISOString();
    const gateway = await readDefaultGateway({ platform, execFileFn, readFileFn });
    const gatewayCheck = await pingGateway(gateway.kind === 'measured' ? gateway.value : null, { platform, execFileFn });
    const dnsResult = await checkDns(dnsCheckName, { dnsLookupFn });
    const internet = {};
    for (const target of INTERNET_TARGETS) {
      internet[target.name] = await tcpConnectCheck(target.host, target.port, connectFn !== undefined ? { connectFn } : {});
    }
    const clock = await checkClockSync({ platform, execFileFn });
    connectionChecks = { atUtc, gateway, gatewayCheck, dns: dnsResult, internet, clock, cloud: cloudCheck() };
    lastConnectionCheckRunMs = now().getTime();
    return connectionChecks;
  }

  /** Called on GET /network: reuses the cached checks unless 30s have passed. */
  async function connectionChecksForRequest() {
    if (connectionChecks === null) await initialConnectionChecks;
    const nowMs = now().getTime();
    if (connectionChecks !== null && lastConnectionCheckRunMs !== null && nowMs - lastConnectionCheckRunMs < CONNECTION_CHECK_MIN_GAP_MS) {
      return connectionChecks;
    }
    return refreshConnectionChecks();
  }

  async function runCounterSample() {
    const atUtc = now().toISOString();
    const ifaceNames = await listInterfaceNames({ platform, readdirFn });
    for (const iface of ifaceNames) {
      const sample = await readCounterSample(iface, atUtc, { platform, readFileFn });
      const history = counterHistory.get(iface) ?? { rx: [], tx: [] };
      if (sample.rx !== null) {
        history.rx.push(sample.rx);
        if (history.rx.length > COUNTER_SAMPLE_HISTORY) history.rx.shift();
      }
      if (sample.tx !== null) {
        history.tx.push(sample.tx);
        if (history.tx.length > COUNTER_SAMPLE_HISTORY) history.tx.shift();
      }
      counterHistory.set(iface, history);

      const statics = await readInterfaceStatics(iface, { platform, readFileFn });
      latestStatics.set(iface, statics);
      if (!errorDropBaseline.has(iface)) {
        errorDropBaseline.set(iface, {
          rxErrors: statics.errors?.rx ?? null,
          txErrors: statics.errors?.tx ?? null,
          rxDropped: statics.drops?.rx ?? null,
          txDropped: statics.drops?.tx ?? null,
        });
      }
    }
  }

  async function runCameraProbes() {
    const atUtc = now().toISOString();
    for (const camera of config.cameras) {
      const host = hostFromCamera(camera);
      if (host === null) continue;
      const port = rtspPortFromCamera(camera);
      const result = await tcpConnectCheck(host, port, {
        timeoutMs: CAMERA_PROBE_TIMEOUT_MS,
        ...(connectFn !== undefined ? { connectFn } : {}),
      });
      const previous = cameraProbes.get(camera.cameraId) ?? { lastAnsweredUtc: null, rttMs: null, consecutiveMisses: 0 };
      if (result.kind === 'answered') {
        cameraProbes.set(camera.cameraId, { lastAnsweredUtc: atUtc, rttMs: result.ms, consecutiveMisses: 0 });
      } else {
        cameraProbes.set(camera.cameraId, {
          lastAnsweredUtc: previous.lastAnsweredUtc,
          rttMs: null,
          consecutiveMisses: previous.consecutiveMisses + 1,
        });
      }
    }
  }

  // Once at start, then on their own schedules — the same pattern as
  // agent/event-retention.mjs's own timer in agent/api-server.mjs. Errors from
  // an injected fake must never crash the sampler loop, only skip that tick.
  const safely = (fn) => () => {
    fn().catch((err) => log('error', 'network sampler tick failed', { error: String(err?.message ?? err) }));
  };
  // Kept so a request arriving before the first tick lands can await it
  // instead of reading empty maps and reporting a false "unmeasured".
  const initialCounterSample = runCounterSample().catch((err) => {
    log('error', 'network sampler: first counter sample failed', { error: String(err?.message ?? err) });
  });
  const initialCameraProbes = runCameraProbes().catch((err) => {
    log('error', 'network sampler: first camera probe pass failed', { error: String(err?.message ?? err) });
  });
  const initialConnectionChecks = refreshConnectionChecks().catch((err) => {
    log('error', 'network sampler: first connection check pass failed', { error: String(err?.message ?? err) });
  });
  const counterTimer = setInterval(safely(runCounterSample), counterIntervalMs);
  const probeTimer = setInterval(safely(runCameraProbes), probeIntervalMs);
  const connectionTimer = setInterval(safely(refreshConnectionChecks), connectionCheckIntervalMs);
  counterTimer.unref?.();
  probeTimer.unref?.();
  connectionTimer.unref?.();

  /**
   * POST /network/discover. Throttled to once per 60s; a throttled call
   * returns the CACHED result rather than running the multicast again.
   *
   * THE FEARED FAILURE this in-flight guard closes: `discoveryCache` stays
   * null for the whole first run (SADP/WS-Discovery each take seconds), so
   * gating the throttle on `discoveryCache !== null` let any number of
   * concurrent POSTs that land before that first run finishes each start
   * their own multicast round -- two browser tabs, a double-click before the
   * button's client-side disable takes effect, or a naive retry all multiply
   * the "at most once per 60s" traffic the spec and the file's own "No
   * scanning" rule bound. `discoverInFlight` is set synchronously, before
   * this function ever awaits, so a concurrent call sees it on its very next
   * line and shares the one run already under way instead of starting a
   * second.
   */
  async function runDiscoverNow() {
    if (discoverInFlight !== null) {
      const cache = await discoverInFlight;
      const elapsedMs = now().getTime() - (lastDiscoverRunMs ?? now().getTime());
      return { throttled: true, retryAfterMs: Math.max(0, DISCOVER_MIN_GAP_MS - elapsedMs), cache };
    }
    const nowMs = now().getTime();
    if (discoveryCache !== null && lastDiscoverRunMs !== null && nowMs - lastDiscoverRunMs < DISCOVER_MIN_GAP_MS) {
      return { throttled: true, retryAfterMs: DISCOVER_MIN_GAP_MS - (nowMs - lastDiscoverRunMs), cache: discoveryCache };
    }
    lastDiscoverRunMs = nowMs; // set before any await, so a racing call sees it immediately
    discoverInFlight = (async () => {
      const replies = await runCameraDiscovery({ discoverSadpFn, discoverOnvifFn, interfaceAddress, broadcast, now });
      discoveryCache = { atUtc: now().toISOString(), replies };
      return discoveryCache;
    })();
    try {
      const cache = await discoverInFlight;
      return { throttled: false, cache };
    } finally {
      discoverInFlight = null;
    }
  }

  /** GET /network's whole body. */
  async function gatherView() {
    await ensureMacHistoryLoaded();
    // A request arriving before the sampler's own first tick lands must not
    // see empty maps and report every camera as never-probed and every
    // interface as never-sampled when a measurement is only a moment away.
    await Promise.all([initialCounterSample, initialCameraProbes]);
    const atUtc = now().toISOString();
    const neighbours = await readNeighbours({ platform, execFileFn, readFileFn });
    const ouiLookup = await readOuiLookup({ platform, readFileFn });
    const facts = cameraFacts(index, cameras.map((c) => c.cameraId));
    const recording = new Map();
    for (const camera of cameras) {
      const f = facts.get(camera.cameraId);
      recording.set(camera.cameraId, {
        lastSealedUtc: f?.lastSealedUtc ?? null,
        measuredKbps: f?.measuredKbps ?? null,
        // Not measured anywhere reusable on a running box today (spec section 3).
        fps: null,
      });
    }
    const discovery = discoveryCache?.replies ?? [];
    const view = buildNetworkView({
      atUtc,
      cameras,
      neighbours,
      discovery,
      probes: cameraProbes,
      recording,
      macHistory,
      ouiLookup,
    });

    // Fold this pass's (ip, mac) observations back into history and persist
    // only when something actually changed (build rule: tmp then rename).
    const observed = view.cameras
      .filter((c) => c.ip.kind === 'measured' && c.mac.kind === 'measured')
      .map((c) => ({ ip: c.ip.value, mac: c.mac.value }));
    const { history: updatedHistory, changed } = updateMacHistory(macHistory, observed, atUtc);
    if (changed) {
      macHistory = updatedHistory;
      await writeMacHistory(stateDir, macHistory).catch((err) => {
        log('error', 'network-facts: could not write network-macs.json', { error: String(err?.message ?? err) });
      });
    }

    const checks = await connectionChecksForRequest();

    const ifaceNames = await listInterfaceNames({ platform, readdirFn });
    const osIfaces = interfacesOf();
    const interfaces = [];
    for (const name of ifaceNames.length > 0 ? ifaceNames : Object.keys(osIfaces)) {
      // The sampler's own last read, not a fresh one: interface facts are as
      // fresh as the last 60s tick, matching "measured since" transparency
      // rather than doing a second, per-request filesystem read that could
      // disagree with the counters the rate graph is built from.
      const statics = latestStatics.get(name) ?? {
        name,
        operState: { kind: 'unmeasured', reason: 'not sampled yet' },
        speedMbps: { kind: 'unmeasured', reason: 'not sampled yet' },
        duplex: { kind: 'unmeasured', reason: 'not sampled yet' },
        errors: null,
        drops: null,
      };
      const baseline = errorDropBaseline.get(name) ?? { rxErrors: null, txErrors: null, rxDropped: null, txDropped: null };
      const addresses = (osIfaces[name] ?? []).filter((a) => a.family === 'IPv4' || a.family === 4);
      const history = counterHistory.get(name) ?? { rx: [], tx: [] };
      const rxSamples = history.rx;
      const txSamples = history.tx;
      const rxNow = rxSamples.length >= 2 ? { direction: 'rx', ...describeRate(rxSamples) } : { kind: 'unavailable', reason: 'fewer than two samples so far' };
      const txNow = txSamples.length >= 2 ? { direction: 'tx', ...describeRate(txSamples) } : { kind: 'unavailable', reason: 'fewer than two samples so far' };
      interfaces.push({
        name,
        addresses: addresses.map((a) => ({ address: a.address, netmask: a.netmask, cidr: a.cidr ?? null, mac: a.mac ?? null })),
        operState: statics.operState,
        speedMbps: statics.speedMbps,
        duplex: statics.duplex,
        rxNowMbps: rxNow,
        txNowMbps: txNow,
        rxHistory: rxSamples,
        txHistory: txSamples,
        errorsSinceSamplingBegan: {
          rx: sinceSamplingBegan(statics.errors?.rx ?? null, baseline.rxErrors),
          tx: sinceSamplingBegan(statics.errors?.tx ?? null, baseline.txErrors),
        },
        dropsSinceSamplingBegan: {
          rx: sinceSamplingBegan(statics.drops?.rx ?? null, baseline.rxDropped),
          tx: sinceSamplingBegan(statics.drops?.tx ?? null, baseline.txDropped),
        },
        camerasOnThisInterface: addresses.flatMap((a) => camerasOnInterface(cameras, a.address, a.netmask)),
      });
    }

    return {
      ok: true,
      atUtc,
      measuredSinceUtc: samplerStartedAtUtc,
      interfaces,
      connectionChecks: checks,
      cameras: view.cameras,
      otherDevices: view.otherDevices,
      ipCollisions: view.ipCollisions,
      discovery: discoveryCache === null ? null : { atUtc: discoveryCache.atUtc },
    };
  }

  /**
   * This pass's rx/tx rates, straight from the counter history this sampler
   * already keeps in memory -- no I/O, no side effect. agent/health-history.mjs's
   * own 60s tick (HEALTH-HISTORY-SPEC.md) calls this instead of reading the
   * same /sys/class/net counter files a second time whenever the Network page
   * is also enabled, so the two features' numbers agree and neither doubles
   * the other's sysfs reads. An interface with fewer than two readings yet
   * (this sampler's own first tick) is simply absent from the map, not a zero
   * rate — the same "no previous sample" gate describeRate already applies to
   * every /network response.
   */
  function interfaceRates() {
    const rates = new Map();
    for (const [name, history] of counterHistory) {
      if (history.rx.length < 2 && history.tx.length < 2) continue;
      const rx = history.rx.length >= 2 ? describeRate(history.rx) : null;
      const tx = history.tx.length >= 2 ? describeRate(history.tx) : null;
      rates.set(name, {
        rxMbps: rx !== null && rx.kind === 'ok' ? rx.mbps : null,
        txMbps: tx !== null && tx.kind === 'ok' ? tx.mbps : null,
      });
    }
    return rates;
  }

  function close() {
    clearInterval(counterTimer);
    clearInterval(probeTimer);
    clearInterval(connectionTimer);
  }

  return { gatherView, runDiscoverNow, interfaceRates, close };
}

function describeRate(samples) {
  const prev = samples[samples.length - 2];
  const next = samples[samples.length - 1];
  return counterRate(prev, next);
}
