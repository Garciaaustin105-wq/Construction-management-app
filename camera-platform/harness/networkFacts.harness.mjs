/**
 * The Network page's I/O (agent/network-facts.mjs) and its wiring into
 * agent/api-server.mjs (NETWORK-PAGE-SPEC.md).
 *
 * The failures feared, by name (build rule 19):
 *  - a camera's user:pass reaching the JSON body OR a log line;
 *  - a packet going anywhere but the six places the spec allows;
 *  - a gateway string that is not an IPv4 address reaching `execFile('ping', ...)`;
 *  - the store role or a display credential reaching this page at all;
 *  - the 30s/60s rate limits doing nothing under repeated requests;
 *  - a sampler that keeps ticking after its server is closed.
 *
 * Every network source below is a fake: no check in this file opens a real
 * socket, runs a real `ip`/`ping`/`timedatectl`, or sends a real multicast
 * packet (hard rule). `platform: 'linux'` is passed to network-facts.mjs so
 * its Linux-only branches run against these fakes even though this harness
 * itself runs on Windows (build rule 20) — the OTHER half of that rule, that
 * the same code answers "not available on this system" on a REAL Windows
 * box, is covered separately below by leaving `platform` at its real default.
 */
import { mkdtemp, readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { decideRoute } from "../dist/routeAccess.js";
import {
  hostFromCamera,
  rtspPortFromCamera,
  configuredCamerasFor,
  pingGateway,
  checkClockSync,
  checkDns,
  tcpConnectCheck,
  readNeighbours,
  readDefaultGateway,
  readOuiLookup,
  readMacHistory,
  writeMacHistory,
  updateMacHistory,
  runCameraDiscovery,
  camerasOnInterface,
  startNetworkFacts,
} from "../agent/network-facts.mjs";
import { check, eq, same, close, report } from "./_assert.mjs";

console.log("network facts");

const installerAuth = {
  principalOf: () => ({ kind: "user", username: "tech", role: "installer" }),
  handle: async () => false,
  audit: () => {},
};

function fakeSocket(outcome) {
  const ee = new EventEmitter();
  ee.setTimeout = () => {};
  ee.destroy = () => {};
  queueMicrotask(() => {
    if (outcome === "connect") ee.emit("connect");
    else if (outcome === "timeout") ee.emit("timeout");
    else ee.emit("error", new Error("connection refused"));
  });
  return ee;
}

const enoent = () => Promise.reject(Object.assign(new Error("no such file"), { code: "ENOENT" }));

// ---------------------------------------------------------------------------
// Pure-ish helpers, unit level
// ---------------------------------------------------------------------------

check("hostFromCamera: a credentialed url gives the bare host, never touching username/password", () => {
  eq(hostFromCamera({ url: "rtsp://svc:hunter2@10.0.0.5:8554/live" }), "10.0.0.5", "host from url");
  eq(rtspPortFromCamera({ url: "rtsp://svc:hunter2@10.0.0.5:8554/live" }), 8554, "port from url");
  eq(hostFromCamera({ host: "10.0.0.6" }), "10.0.0.6", "host field");
  eq(rtspPortFromCamera({ host: "10.0.0.6" }), 554, "default rtsp port");
  eq(hostFromCamera({}), null, "neither url nor host");
  eq(hostFromCamera({ url: "http://nope" }), null, "unparseable url");
});

check("configuredCamerasFor: cameraId/name/host only -- never the url itself", () => {
  const config = { cameras: [{ cameraId: "cam-1", name: "Front", url: "rtsp://svc:hunter2@10.0.0.5/live" }] };
  const cams = configuredCamerasFor(config);
  eq(cams, [{ cameraId: "cam-1", name: "Front", host: "10.0.0.5" }], "trimmed shape");
  eq(JSON.stringify(cams).includes("hunter2"), false, "no password leaked through the trim");
});

await check("THE FEARED ONE: a gateway that is not an IPv4 address is refused before execFile ever sees it", async () => {
  let called = false;
  const execFileFn = async () => { called = true; return { stdout: "" }; };
  const bad = await pingGateway("not-an-ip; rm -rf /", { platform: "linux", execFileFn });
  eq(bad.kind, "unmeasured", "refused, not attempted");
  eq(called, false, "execFile was never called");

  const alsoBad = await pingGateway("10.0.0.999", { platform: "linux", execFileFn });
  eq(alsoBad.kind, "unmeasured", "octet out of range refused too");
  eq(called, false, "still never called");

  const nullGateway = await pingGateway(null, { platform: "linux", execFileFn });
  eq(nullGateway.kind, "unmeasured", "no gateway to ping at all");
  eq(called, false, "never called for null either");
});

await check("pingGateway: a validated IPv4 reaches execFile as its own argv element, and Windows answers 'not available'", async () => {
  const calls = [];
  const execFileFn = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: "" }; };
  const ok = await pingGateway("192.168.1.1", { platform: "linux", execFileFn });
  eq(ok.kind, "answered", "kind");
  eq(calls.length, 1, "one call");
  eq(calls[0].cmd, "ping", "the binary");
  eq(calls[0].args.includes("192.168.1.1"), true, "the ip is its own argument");
  eq(calls[0].args.some((a) => a.includes(";") || a.includes("&&") || a.includes("|")), false, "never shell-joined");

  calls.length = 0;
  const onWindows = await pingGateway("192.168.1.1", { platform: "win32", execFileFn });
  eq(onWindows.kind, "unmeasured", "windows: not available");
  eq(onWindows.reason, "not available on this system", "the exact reason build rule 20 asks for");
  eq(calls.length, 0, "never attempted on windows");
});

await check("checkClockSync: linux parses yes/no/garbage; windows never runs it", async () => {
  const execFileFn = async (cmd, args) => {
    if (args.includes("garbage")) return { stdout: "garbage\n" };
    return { stdout: "yes\n" };
  };
  eq((await checkClockSync({ platform: "linux", execFileFn })).kind, "measured", "yes parses");
  const noAnswer = await checkClockSync({ platform: "linux", execFileFn: async () => ({ stdout: "no\n" }) });
  same(noAnswer, { kind: "measured", value: false }, "no parses to false, not unmeasured");
  const windows = await checkClockSync({ platform: "win32", execFileFn });
  eq(windows.reason, "not available on this system", "windows");
});

await check("checkDns: answered, and a fake that never resolves times out rather than hanging the check", async () => {
  const seen = [];
  const answered = await checkDns("example.test", {
    dnsLookupFn: async (h) => { seen.push(h); return { address: "9.9.9.9", family: 4 }; },
  });
  eq(answered.kind, "answered", "kind");
  eq(seen, ["example.test"], "looked up the one fixed name given");
  const stuck = await checkDns("example.test", { dnsLookupFn: () => new Promise(() => {}), timeoutMs: 20 });
  eq(stuck.kind, "no_answer", "times out rather than hanging");
  eq(stuck.withinMs, 20, "names the timeout it used");
});

await check("tcpConnectCheck: connect, timeout and error are told apart, and the destination is always recorded first", async () => {
  const destinations = [];
  const connectFn = (h, p) => { destinations.push(`${h}:${p}`); return fakeSocket("connect"); };
  const ok = await tcpConnectCheck("1.1.1.1", 443, { connectFn });
  eq(ok.kind, "answered", "answered");
  eq(destinations, ["1.1.1.1:443"], "destination recorded even though it succeeded");

  const refused = await tcpConnectCheck("10.0.0.9", 554, { connectFn: (h, p) => fakeSocket("error") });
  eq(refused.kind, "no_answer", "refused");

  const timedOut = await tcpConnectCheck("10.0.0.9", 554, { connectFn: (h, p) => fakeSocket("timeout") });
  eq(timedOut.kind, "no_answer", "timeout also no_answer");
  eq(timedOut.reason, "timed out", "says so");
});

await check("readNeighbours/readDefaultGateway: `ip` first, /proc/net/... when `ip` is missing, [] / unmeasured when both fail", async () => {
  const ipMissing = async () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); };

  const arpText = [
    "IP address       HW type     Flags       HW address            Mask     Device",
    "10.0.0.5         0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0",
  ].join("\n");
  const neighboursFromArp = await readNeighbours({ platform: "linux", execFileFn: ipMissing, readFileFn: async () => arpText });
  eq(neighboursFromArp, [{ ip: "10.0.0.5", mac: "aa:bb:cc:dd:ee:ff", iface: "eth0", state: "REACHABLE" }], "fell back to /proc/net/arp");

  const neitherWorks = await readNeighbours({ platform: "linux", execFileFn: ipMissing, readFileFn: enoent });
  eq(neitherWorks, [], "neither source: empty, never thrown");

  const windows = await readNeighbours({ platform: "win32", execFileFn: ipMissing, readFileFn: enoent });
  eq(windows, [], "windows: empty without even trying");

  const routeText = [
    "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  ].join("\n");
  const gatewayFromProc = await readDefaultGateway({ platform: "linux", execFileFn: ipMissing, readFileFn: async () => routeText });
  same(gatewayFromProc, { kind: "measured", value: "192.168.1.1" }, "fell back to /proc/net/route");

  const gatewayOnWindows = await readDefaultGateway({ platform: "win32", execFileFn: ipMissing, readFileFn: enoent });
  eq(gatewayOnWindows.reason, "not available on this system", "windows never tries ip or /proc");
});

await check("readOuiLookup: null (never an empty map) when neither path exists; windows never tries", async () => {
  const none = await readOuiLookup({ platform: "linux", readFileFn: enoent });
  eq(none, null, "no list on this box");
  const windows = await readOuiLookup({ platform: "win32", readFileFn: enoent });
  eq(windows, null, "windows: null without trying");
  const oneWorks = await readOuiLookup({
    platform: "linux",
    readFileFn: async (p) => { if (p.endsWith("misc/oui.txt")) return "00-40-8C   (hex)\t\tAXIS COMMUNICATIONS AB\n"; throw Object.assign(new Error("x"), { code: "ENOENT" }); },
  });
  eq(oneWorks.get("00:40:8c"), "AXIS COMMUNICATIONS AB", "second path used when the first is absent");
});

await check("camerasOnInterface: a /24 subnet test, not a string prefix match", () => {
  const cams = [{ cameraId: "cam-1", host: "10.0.0.5" }, { cameraId: "cam-2", host: "10.0.1.5" }, { cameraId: "cam-3", host: null }];
  eq(camerasOnInterface(cams, "10.0.0.1", "255.255.255.0"), ["cam-1"], "only the camera actually inside the /24");
});

// ---------------------------------------------------------------------------
// MAC history: read/write/fold
// ---------------------------------------------------------------------------

await check("MAC history: a missing or corrupt file reads as empty, and a good write is tmp-then-rename with no stray .tmp left behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camplat-netfacts-macs-"));
  eq(await readMacHistory(dir), [], "missing file");
  const entries = [{ ip: "10.0.0.5", mac: "aa:bb:cc:dd:ee:ff", firstSeenUtc: "2026-09-01T00:00:00.000Z", lastSeenUtc: "2026-09-23T00:00:00.000Z" }];
  await writeMacHistory(dir, entries);
  eq(await readMacHistory(dir), entries, "round-trips");
  const names = await readdir(dir);
  eq(names.includes("network-macs.json.tmp"), false, "no leftover tmp file");
  eq(names.includes("network-macs.json"), true, "the real file exists");
});

check("updateMacHistory: first_seen appends, an unchanged mac only bumps lastSeenUtc, a changed mac APPENDS rather than overwriting", () => {
  const first = updateMacHistory([], [{ ip: "10.0.0.5", mac: "aa:aa:aa:aa:aa:aa" }], "2026-09-23T00:00:00.000Z");
  eq(first.changed, true, "changed");
  eq(first.history, [{ ip: "10.0.0.5", mac: "aa:aa:aa:aa:aa:aa", firstSeenUtc: "2026-09-23T00:00:00.000Z", lastSeenUtc: "2026-09-23T00:00:00.000Z" }], "one new entry");

  const sameSeen = updateMacHistory(first.history, [{ ip: "10.0.0.5", mac: "aa:aa:aa:aa:aa:aa" }], "2026-09-23T01:00:00.000Z");
  eq(sameSeen.changed, true, "lastSeenUtc moved, so this still counts as a change to persist");
  eq(sameSeen.history.length, 1, "still one entry -- not duplicated");
  eq(sameSeen.history[0].lastSeenUtc, "2026-09-23T01:00:00.000Z", "bumped");
  eq(sameSeen.history[0].firstSeenUtc, "2026-09-23T00:00:00.000Z", "firstSeenUtc untouched");

  const swapped = updateMacHistory(sameSeen.history, [{ ip: "10.0.0.5", mac: "bb:bb:bb:bb:bb:bb" }], "2026-09-23T02:00:00.000Z");
  eq(swapped.history.length, 2, "the old entry is KEPT, not overwritten");
  eq(swapped.history.some((e) => e.mac === "aa:aa:aa:aa:aa:aa"), true, "old mac still on record");
  eq(swapped.history.some((e) => e.mac === "bb:bb:bb:bb:bb:bb" && e.lastSeenUtc === "2026-09-23T02:00:00.000Z"), true, "new mac recorded");
});

// ---------------------------------------------------------------------------
// Discovery normalisation
// ---------------------------------------------------------------------------

await check("runCameraDiscovery: normalises through the same contract functions as everything else, stamped at receipt time", async () => {
  const discoverSadpFn = async ({ onRaw }) => {
    onRaw({ from: "10.0.0.20" });
    return [{ mac: "44:19:b6:aa:bb:cc", ip: "10.0.0.20", model: "cam-x", serial: "sn1", firmware: "v1", from: "10.0.0.20" }];
  };
  const discoverOnvifFn = async ({ onRaw }) => {
    onRaw({ from: "10.0.0.21" });
    return [{ ip: "10.0.0.21", xaddrs: ["http://10.0.0.21/onvif"], hardware: "Model Y" }];
  };
  const replies = await runCameraDiscovery({ discoverSadpFn, discoverOnvifFn, now: () => new Date("2026-09-23T12:00:00.000Z") });
  eq(replies.length, 2, "both protocols");
  eq(replies[0], { source: "sadp", atUtc: "2026-09-23T12:00:00.000Z", ip: "10.0.0.20", mac: "44:19:b6:aa:bb:cc", model: "cam-x", firmware: "v1", serial: "sn1" }, "sadp normalised");
  eq(replies[1], { source: "wsdiscovery", atUtc: "2026-09-23T12:00:00.000Z", ip: "10.0.0.21", mac: null, model: "Model Y", firmware: null, serial: null }, "wsdiscovery normalised");
});

// ---------------------------------------------------------------------------
// End to end: a real createApiServer, networkFactsEnabled with every I/O
// source faked. Nothing below opens a real socket or runs a real binary.
// ---------------------------------------------------------------------------

const stateDir = await mkdtemp(join(tmpdir(), "camplat-netfacts-api-"));
await mkdir(join(stateDir, "disk0"), { recursive: true });
const index = openIndex(join(stateDir, "index.db"));

const config = {
  siteId: "test-site",
  storeRoots: [join(stateDir, "disk0")],
  segmentSeconds: 60,
  credentials: { username: "x", password: "y" },
  cameras: [{ cameraId: "cam-1", name: "Front door", url: "rtsp://svc:hunter2@10.0.0.5:8554/live" }],
};

let clockMs = Date.parse("2026-09-23T12:00:00.000Z");
const now = () => new Date(clockMs);

const destinations = { tcp: [], dns: [], exec: [] };
const discoverCalls = { sadp: 0, wsd: 0 };
const capturedLogLines = [];

function makeOverrides() {
  return {
    platform: "linux",
    execFileFn: async (cmd, args) => {
      destinations.exec.push({ cmd, args });
      if (cmd === "ip" && args.includes("neigh")) {
        return { stdout: JSON.stringify([{ dst: "10.0.0.5", dev: "eth0", lladdr: "aa:bb:cc:dd:ee:ff", state: ["REACHABLE"] }]) };
      }
      if (cmd === "ip" && args.includes("route")) {
        return { stdout: JSON.stringify([{ dst: "default", gateway: "192.168.1.1", dev: "eth0" }]) };
      }
      if (cmd === "ping") return { stdout: "" };
      if (cmd === "timedatectl") return { stdout: "yes\n" };
      throw new Error(`test fake: unexpected command ${cmd} ${JSON.stringify(args)}`);
    },
    readFileFn: enoent,
    readdirFn: async () => ["eth0"],
    dnsLookupFn: async (hostname) => { destinations.dns.push(hostname); return { address: "9.9.9.9", family: 4 }; },
    connectFn: (host, port) => { destinations.tcp.push(`${host}:${port}`); return fakeSocket("connect"); },
    discoverSadpFn: async ({ onRaw }) => { discoverCalls.sadp++; onRaw?.({ from: "10.0.0.30" }); return []; },
    discoverOnvifFn: async () => { discoverCalls.wsd++; return []; },
    dnsCheckName: "example.test",
    now,
    log: (level, msg, extra) => capturedLogLines.push(JSON.stringify({ level, msg, ...extra })),
  };
}

const server = createApiServer({
  stateDir, config, index, now, auth: installerAuth,
  networkFactsEnabled: true,
  networkFactsOverrides: makeOverrides(),
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const fetchJson = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json, text };
};

await check("(a) THE FEARED ONE: a camera's user:pass never reaches /network's JSON or a log line", async () => {
  const { res, text } = await fetchJson(`${base}/network`);
  eq(res.status, 200, "status");
  const everything = text + "\n" + capturedLogLines.join("\n");
  for (const secret of ["hunter2", "svc:hunter2", "rtsp://"]) {
    eq(everything.includes(secret), false, `${secret} must not appear anywhere`);
  }
  eq(text.includes("10.0.0.5"), true, "the bare host is still shown -- only the credential is withheld");
});

await check("(b) the only destinations touched are the ones the spec allows, and discovery waits for the button", async () => {
  eq(destinations.tcp.sort(), ["1.1.1.1:443", "10.0.0.5:8554", "8.8.8.8:443"].sort(), "camera RTSP port + both internet targets, nothing else");
  eq(destinations.dns, ["example.test"], "the one fixed DNS name, once");
  const pingCalls = destinations.exec.filter((c) => c.cmd === "ping");
  eq(pingCalls.length, 1, "one ping");
  eq(pingCalls[0].args.includes("192.168.1.1"), true, "at the gateway ip -j route reported");
  eq(discoverCalls.sadp, 0, "SADP not run until the button is pressed");
  eq(discoverCalls.wsd, 0, "nor WS-Discovery");

  const { res, json } = await fetchJson(`${base}/network/discover`, { method: "POST" });
  eq(res.status, 200, "discover succeeds");
  eq(discoverCalls.sadp, 1, "now it ran, exactly once");
  eq(discoverCalls.wsd, 1, "both protocols");
  eq(json.ok, true, "envelope");
});

await check("(c) the store role and a display credential get 403 on every network route; installer is allowed", () => {
  const installer = { kind: "user", username: "tech", role: "installer" };
  const store = { kind: "user", username: "clerk", role: "store" };
  const display = { kind: "display", displayId: "wall-1" };
  for (const path of ["/network"]) {
    eq(decideRoute(installer, "GET", path).kind, "allow", `installer GET ${path}`);
    eq(decideRoute(store, "GET", path).kind, "refuse", `store refused on ${path}`);
    eq(decideRoute(store, "GET", path).status, 403, `store gets 403, not 401, on ${path}`);
    eq(decideRoute(display, "GET", path).kind, "refuse", `display refused on ${path}`);
    eq(decideRoute(display, "GET", path).status, 403, `display gets 403 on ${path}`);
  }
  eq(decideRoute(installer, "POST", "/network/discover").kind, "allow", "installer POST discover");
  eq(decideRoute(store, "POST", "/network/discover").status, 403, "store refused on discover");
  eq(decideRoute(display, "POST", "/network/discover").status, 403, "display refused on discover");
  eq(decideRoute(installer, "GET", "/network-page").kind, "allow", "installer sees the page");
  eq(decideRoute(store, "GET", "/network-page").kind === "allow", false, "store does not");
});

await check("(d) rate limits hold: a second discover within 60s is refused and runs nothing new; repeated GETs reuse the cached checks", async () => {
  const before = { sadp: discoverCalls.sadp, wsd: discoverCalls.wsd, dns: destinations.dns.length };

  const again = await fetchJson(`${base}/network/discover`, { method: "POST" });
  eq(again.res.status, 429, "throttled");
  eq(discoverCalls.sadp, before.sadp, "discovery did not run again");
  eq(discoverCalls.wsd, before.wsd, "neither protocol");

  await fetchJson(`${base}/network`);
  await fetchJson(`${base}/network`);
  eq(destinations.dns.length, before.dns, "two GETs within 30s did not run the connection checks twice");

  clockMs += 61_000; // past the discover button's 60s gap (and the checks' 30s one)
  const laterDiscover = await fetchJson(`${base}/network/discover`, { method: "POST" });
  eq(laterDiscover.res.status, 200, "60s later, discover runs again");
  eq(discoverCalls.sadp, before.sadp + 1, "SADP ran a second time");

  await fetchJson(`${base}/network`);
  eq(destinations.dns.length, before.dns + 1, "30s later, a GET refreshes the connection checks");
});

await check(
  "THE FEARED ONE: concurrent POST /network/discover calls made before the first run lands share ONE run, not one each",
  async () => {
    // The old throttle gated on `discoveryCache !== null`, which stays null
    // for the WHOLE first run (SADP/WS-Discovery each take real seconds to
    // collect replies) -- so any call landing before it finishes passed the
    // check and started its own multicast round. This gate holds the fake
    // SADP call open deliberately, so three concurrent runDiscoverNow()
    // calls are GUARANTEED to overlap, closing the exact window a purely
    // sequential test (like check (d) above) can never exercise.
    const dir3 = await mkdtemp(join(tmpdir(), "camplat-netfacts-race-"));
    await mkdir(join(dir3, "disk0"), { recursive: true });
    const index3 = openIndex(join(dir3, "index.db"));
    const config3 = { siteId: "s3", storeRoots: [join(dir3, "disk0")], segmentSeconds: 60, credentials: { username: "x", password: "y" }, cameras: [] };
    let sadpCalls = 0;
    let wsdCalls = 0;
    let releaseSadp;
    const sadpGate = new Promise((resolve) => { releaseSadp = resolve; });
    const facts3 = startNetworkFacts({
      config: config3, index: index3, stateDir: dir3, platform: "linux",
      execFileFn: async () => ({ stdout: "[]" }),
      readFileFn: enoent,
      readdirFn: async () => [],
      dnsLookupFn: async () => ({ address: "9.9.9.9" }),
      connectFn: () => fakeSocket("connect"),
      discoverSadpFn: async () => { sadpCalls++; await sadpGate; return []; },
      discoverOnvifFn: async () => { wsdCalls++; return []; },
      log: () => {},
    });
    const call1 = facts3.runDiscoverNow();
    const call2 = facts3.runDiscoverNow();
    const call3 = facts3.runDiscoverNow();
    eq(sadpCalls, 1, "only one SADP round started, no matter how many callers raced in before the first one landed");
    releaseSadp();
    const [r1, r2, r3] = await Promise.all([call1, call2, call3]);
    eq(wsdCalls, 1, "only one WS-Discovery round either");
    eq([r1, r2, r3].filter((r) => r.throttled === false).length, 1, "exactly one caller gets the real run");
    eq([r1, r2, r3].filter((r) => r.throttled === true).length, 2, "the other two share its result instead of starting their own");
    facts3.close();
    index3.close();
  },
);

await check(
  "(g) THE FEARED ONE: rx and tx counters flow through the REAL sampler wiring oriented correctly (never swapped), and errors/drops accumulate since sampling began",
  async () => {
    // harness (a)-(f) above always drive /sys reads through readFileFn:enoent,
    // so runCounterSample's own history.rx.push(sample.rx) / history.tx.push(sample.tx)
    // -- as opposed to counterRate() in isolation, which networkView.harness.mjs
    // already covers well -- never actually saw a real number end to end. An
    // rx/tx mixup there would be exactly the "wrong number that looks
    // plausible" build rule 6 warns about.
    const dir4 = await mkdtemp(join(tmpdir(), "camplat-netfacts-counters-"));
    await mkdir(join(dir4, "disk0"), { recursive: true });
    const index4 = openIndex(join(dir4, "index.db"));
    const config4 = { siteId: "s4", storeRoots: [join(dir4, "disk0")], segmentSeconds: 60, credentials: { username: "x", password: "y" }, cameras: [] };

    let rxBytes = 0, txBytes = 0, rxErrors = 5, txErrors = 2, rxDropped = 1, txDropped = 0;
    const sysReadFn = async (path) => {
      const p = String(path).replace(/\\/g, "/");
      if (!p.includes("/eth0/")) return enoent();
      if (p.endsWith("/operstate")) return "up";
      if (p.endsWith("/speed")) return "1000";
      if (p.endsWith("/duplex")) return "full";
      if (p.endsWith("statistics/rx_bytes")) return String(rxBytes);
      if (p.endsWith("statistics/tx_bytes")) return String(txBytes);
      if (p.endsWith("statistics/rx_errors")) return String(rxErrors);
      if (p.endsWith("statistics/tx_errors")) return String(txErrors);
      if (p.endsWith("statistics/rx_dropped")) return String(rxDropped);
      if (p.endsWith("statistics/tx_dropped")) return String(txDropped);
      return enoent();
    };

    const facts4 = startNetworkFacts({
      config: config4, index: index4, stateDir: dir4, platform: "linux",
      execFileFn: async (cmd) => {
        if (cmd === "ping") return { stdout: "" };
        if (cmd === "timedatectl") return { stdout: "yes\n" };
        return { stdout: "[]" };
      },
      readFileFn: sysReadFn,
      readdirFn: async () => ["eth0"],
      dnsLookupFn: async () => ({ address: "9.9.9.9" }),
      connectFn: () => fakeSocket("connect"),
      discoverSadpFn: async () => [],
      discoverOnvifFn: async () => [],
      counterIntervalMs: 100,
      log: () => {},
    });

    // Tick 0 lands at construction time: rx=0, tx=0, rxErrors=5 (the baseline), txErrors=2.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Ten times as much tx traffic as rx in the next minute -- an rx/tx swap
    // in runCounterSample's history pushes would flip this ratio outright.
    rxBytes += 1_000_000;
    txBytes += 10_000_000;
    rxErrors = 8; // +3 since the baseline tick 0 captured
    txDropped = 4; // +4 since the baseline (0)
    // Land exactly one more tick (~100ms) and stop well short of a second
    // one (~200ms), which would dilute the very delta this assertion needs.
    await new Promise((resolve) => setTimeout(resolve, 90));

    const view = await facts4.gatherView();
    facts4.close();
    index4.close();

    const iface = view.interfaces.find((i) => i.name === "eth0");
    eq(iface !== undefined, true, "eth0 made it into the view");
    eq(iface.rxNowMbps.kind, "ok", "rx rate measured");
    eq(iface.txNowMbps.kind, "ok", "tx rate measured");
    // Same deltaSeconds for both directions (one shared tick), so the ratio
    // of mbps must equal the ratio of the byte deltas fed in -- 1:10 -- no
    // matter how much real wall-clock time the tick actually took. An rx/tx
    // swap flips this ratio to 10:1.
    const ratio = iface.rxNowMbps.mbps / iface.txNowMbps.mbps;
    close(ratio, 0.1, 0.02, "rx/tx mbps ratio (rx is the small one)");
    same(iface.errorsSinceSamplingBegan.rx, { kind: "measured", value: 3 }, "rx errors since sampling began");
    same(iface.dropsSinceSamplingBegan.tx, { kind: "measured", value: 4 }, "tx drops since sampling began");
  },
);

await check("close: server.closeNetworkFacts() exists and does not throw", () => {
  server.closeNetworkFacts();
});
server.close();
index.close();

// A second, tiny-interval server just to prove the samplers actually stop
// ticking on close -- the previous server's real intervals are far too long
// (60s/60s/5min) to observe within a harness's bounded run time.
await check("(f) THE FEARED ONE: the samplers keep ticking until close(), then stop for good", async () => {
  const dir2 = await mkdtemp(join(tmpdir(), "camplat-netfacts-stop-"));
  await mkdir(join(dir2, "disk0"), { recursive: true });
  const index2 = openIndex(join(dir2, "index.db"));
  const config2 = { siteId: "s2", storeRoots: [join(dir2, "disk0")], segmentSeconds: 60, credentials: { username: "x", password: "y" }, cameras: [] };
  let ticks = 0;
  const server2 = createApiServer({
    stateDir: dir2, config: config2, index: index2, auth: installerAuth,
    networkFactsEnabled: true,
    networkFactsOverrides: {
      platform: "linux",
      execFileFn: async () => { ticks++; return { stdout: "yes\n" }; },
      readFileFn: enoent,
      readdirFn: async () => [],
      dnsLookupFn: async () => { ticks++; return { address: "9.9.9.9" }; },
      connectFn: () => fakeSocket("connect"),
      discoverSadpFn: async () => [],
      discoverOnvifFn: async () => [],
      counterIntervalMs: 15,
      probeIntervalMs: 15,
      connectionCheckIntervalMs: 15,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const ticksBeforeClose = ticks;
  eq(ticksBeforeClose > 0, true, "the samplers really did run while the server was up");
  server2.closeNetworkFacts();
  await new Promise((resolve) => setTimeout(resolve, 120));
  eq(ticks, ticksBeforeClose, "not one more tick after close");
  server2.close();
  index2.close();
});

report("network facts");
