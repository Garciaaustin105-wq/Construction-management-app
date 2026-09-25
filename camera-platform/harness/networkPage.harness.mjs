/**
 * The Network page's client, run without a browser (NETWORK-PAGE-SPEC.md,
 * Shape item 4). A fake DOM is enough, because nothing here is about pixels:
 * it is about whether a missing measurement is allowed to look like a zero,
 * and whether a credential can ever reach the screen.
 *
 * The failures tested (build rule 19), roughly in the order they would bite:
 *
 *  - a credential leaking onto the page. Nothing in agent/network-facts.mjs's
 *    JSON body can carry one (contracts/networkView.ts only ever takes a
 *    camera's bare host), but this proves the CLIENT would not print one
 *    either if an extra field ever did show up on a row -- the render
 *    functions read a fixed, named set of fields and nothing else.
 *  - an unmeasured field drawn as blank, zero or "unknown" instead of the
 *    server's own reason.
 *  - a counter reset drawn as a negative or made-up rate on the strip.
 *  - the MAC-change note going missing or being re-worded instead of shown
 *    verbatim.
 *  - the "Look for cameras" button staying enabled inside its own cooldown,
 *    or a 429's message being swallowed.
 *  - the Network nav link showing up for an account that cannot open it.
 *  - a fixed-width CSS rule that would force a phone to scroll sideways.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { permissionsFor } from "../dist/access.js";
import { decideRoute } from "../dist/routeAccess.js";
import { check, eq, same, report } from "./_assert.mjs";

const client = await import(
  pathToFileURL(join(process.cwd(), "agent/ui/network-client.mjs")).href
);
const {
  localTime, historyToRatePoints, buildRateStripSvg, cooldownRemainingMs,
  renderInterfaces, renderConnectionChecks, renderNetwork, startNetworkPage,
} = client;

const { PAGE_NEEDS, hideRefusedLinks } = await import(
  pathToFileURL(join(process.cwd(), "agent/ui/session-bar.mjs")).href
);

console.log("network page");

/* ── the smallest DOM this page's contract allows ─────────────────────────── */

const SVG_NS = "http://www.w3.org/2000/svg";

class FakeEl {
  constructor(tag, id = null) {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.attrs = {};
    this._text = "";
    this._listeners = {};
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v); }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.children.push(c); return c;
  }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === "string" ? textNode(c) : c); }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i < 0) throw new Error("removeChild: not a child");
    this.children.splice(i, 1); c.parentNode = null; return c;
  }
  replaceChildren(...cs) { this.textContent = ""; this.append(...cs); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  dispatch(type) { for (const fn of this._listeners[type] ?? []) fn(); }
  // A camera name, a discovery reply's model string: text out of a config
  // file or the wire, never markup this page may build with. Same trap
  // system-client.mjs's own harness sets for the System page.
  set innerHTML(_) { throw new Error("the page must not use innerHTML"); }
  get innerHTML() { return ""; }
  descendants() {
    return this.children.flatMap((c) => (c.descendants ? [c, ...c.descendants()] : [c]));
  }
  querySelectorAll(selector) {
    if (selector !== "a[href]") throw new Error(`fake DOM only supports "a[href]", got ${selector}`);
    const out = [];
    const walk = (el) => {
      if (el.tagName === "A" && el.getAttribute("href") !== null) out.push(el);
      for (const c of el.children) walk(c);
    };
    walk(this);
    return out;
  }
}
const textNode = (s) => { const t = new FakeEl("#text"); t._text = s; return t; };

const PAGE_IDS = [
  "measuredSince", "interfaces", "connectionChecks", "cameras", "otherDevices",
  "ipCollisions", "discoverBtn", "discoverStatus", "discoverMessage", "pollError",
];

function freshDom() {
  const byId = {};
  for (const id of PAGE_IDS) {
    const tag = id === "cameras" || id === "otherDevices" ? "tbody" : (id === "discoverBtn" ? "button" : "div");
    byId[id] = new FakeEl(tag, id);
  }
  byId.pollError.hidden = true;
  byId.ipCollisions.hidden = true;
  return {
    byId,
    getElementById: (id) => byId[id] ?? null,
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (_ns, tag) => new FakeEl(tag),
    createTextNode: textNode,
  };
}

/** The text of one element plus everything under it, whitespace flattened. */
const textOf = (el) => el.textContent.replace(/\s+/g, " ").trim();

/* ── a fixture with every field, and every field missing, at once ────────── */

const NOW = "2026-09-23T01:10:00.000Z";
const NOW_MS = Date.parse(NOW);

const measured = (value) => ({ kind: "measured", value });
const unmeasured = (reason) => ({ kind: "unmeasured", reason });

// Counter samples one minute apart, oldest first -- exactly the shape
// agent/network-facts.mjs's rxHistory/txHistory keeps. One deliberate reset
// in the middle (bytes goes backwards) proves the strip breaks the line
// there instead of drawing a negative or invented rate across it.
function minuteSamples(startBytesPerMinute, count, resetAtIndex = -1) {
  const out = [];
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    if (i === resetAtIndex) bytes = 0; // the interface reset or its counter wrapped
    else bytes += startBytesPerMinute;
    out.push({ atUtc: new Date(Date.parse(NOW) - (count - i) * 60_000).toISOString(), bytes });
  }
  return out;
}

const FULL_INTERFACE = {
  name: "eth0",
  addresses: [{ address: "192.168.1.50", netmask: "255.255.255.0", cidr: 24, mac: "aa:bb:cc:dd:ee:01" }],
  operState: measured("up"),
  speedMbps: measured(1000),
  duplex: measured("full"),
  rxNowMbps: { direction: "rx", kind: "ok", mbps: 3.21 },
  txNowMbps: { direction: "tx", kind: "ok", mbps: 0.87 },
  rxHistory: minuteSamples(1_000_000, 6, 3), // a reset at index 3, two full samples either side
  txHistory: minuteSamples(500_000, 6),
  errorsSinceSamplingBegan: { rx: measured(0), tx: measured(2) },
  dropsSinceSamplingBegan: { rx: measured(0), tx: measured(0) },
  camerasOnThisInterface: ["cam-front"],
};

const EMPTY_INTERFACE = {
  name: "eth1",
  addresses: [],
  operState: unmeasured("could not read operstate"),
  speedMbps: unmeasured("no negotiated speed reported (link may be down)"),
  duplex: unmeasured("duplex not reported"),
  rxNowMbps: { kind: "unavailable", reason: "fewer than two samples so far" },
  txNowMbps: { kind: "unavailable", reason: "fewer than two samples so far" },
  rxHistory: [],
  txHistory: [],
  errorsSinceSamplingBegan: { rx: unmeasured("not read at sampling start"), tx: unmeasured("not read at sampling start") },
  dropsSinceSamplingBegan: { rx: unmeasured("not read at sampling start"), tx: unmeasured("not read at sampling start") },
  camerasOnThisInterface: [],
};

// A camera with every field measured, name/host/credentials never anywhere
// in scope. `configuredUrl` is the trap: a value this row's TYPE never
// carries (contracts/networkView.ts's CameraRow has no such field), planted
// here as if a bug upstream had forwarded the full config entry. The render
// code must never look at it.
const CAM_FULL = {
  cameraId: "cam-front",
  name: "Front door",
  configuredUrl: "rtsp://install:S3cr3tPass@192.168.1.50:554/ch1",
  ip: measured("192.168.1.50"),
  mac: measured("aa:bb:cc:dd:ee:01"),
  maker: { kind: "known", maker: "Hikvision" },
  model: measured("DS-2CD2143"),
  firmware: measured("V5.7.3"),
  serial: measured("SN123456"),
  lastAnsweredUtc: measured("2026-09-23T01:09:55.000Z"),
  rttMs: measured(12),
  consecutiveMisses: 0,
  lastSealedUtc: measured("2026-09-23T01:09:50.000Z"),
  measuredKbps: measured(2048),
  fps: measured(15),
  macChange: { kind: "unchanged" },
};

// Every field missing, per the spec's own fixture requirement, plus a
// MAC-change row (contracts/networkView.ts's MacChangeResult "changed").
const CAM_BLANK = {
  cameraId: "cam-blank",
  name: null,
  ip: unmeasured("no host configured"),
  mac: unmeasured("no IP to look up"),
  maker: { kind: "unknown_oui", reason: "no MAC to look up" },
  model: unmeasured("not reported"),
  firmware: unmeasured("not reported"),
  serial: unmeasured("not reported"),
  lastAnsweredUtc: unmeasured("no answer yet"),
  rttMs: unmeasured("no answer yet"),
  consecutiveMisses: 4,
  lastSealedUtc: unmeasured("no sealed segment yet"),
  measuredKbps: unmeasured("not measured"),
  fps: unmeasured("not measured"),
  macChange: {
    kind: "changed", from: "11:22:33:44:55:66", to: "aa:bb:cc:dd:ee:ff",
    note: "MAC for 192.168.1.51 changed from 11:22:33:44:55:66 to aa:bb:cc:dd:ee:ff at 2026-09-23T01:05:00.000Z",
  },
};

const OTHER_DEVICE = {
  ip: "192.168.1.77",
  mac: measured("bb:cc:dd:ee:ff:00"),
  maker: { kind: "no_list", reason: "no maker list on this box" },
  iface: measured("eth0"),
  state: measured("REACHABLE"),
  model: unmeasured("no discovery reply for this device"),
  firmware: unmeasured("no discovery reply for this device"),
};

const VIEW = {
  ok: true,
  atUtc: NOW,
  measuredSinceUtc: "2026-09-23T00:00:00.000Z",
  interfaces: [FULL_INTERFACE, EMPTY_INTERFACE],
  connectionChecks: {
    atUtc: NOW,
    gateway: measured("192.168.1.1"),
    gatewayCheck: { kind: "answered", ms: 4 },
    dns: { kind: "answered", ms: 18, address: "1.1.1.1" },
    internet: {
      cloudflare: { kind: "answered", ms: 9 },
      google: { kind: "no_answer", withinMs: 2000, reason: "timed out" },
    },
    clock: { kind: "measured", value: true },
    cloud: { kind: "unmeasured", reason: "no cloud service configured" },
  },
  cameras: [CAM_FULL, CAM_BLANK],
  otherDevices: [OTHER_DEVICE],
  ipCollisions: [
    { ip: "192.168.1.90", macs: ["aa:aa:aa:aa:aa:aa", "bb:bb:bb:bb:bb:bb"], replies: [{}, {}] },
  ],
  discovery: { atUtc: "2026-09-23T01:09:30.000Z" }, // 30s before NOW: still cooling down
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/* ── historyToRatePoints: the rate strip's own maths ──────────────────────── */

check("two samples give one rate; a reset breaks the line, never a negative rate", () => {
  const s = [
    { atUtc: "2026-09-23T01:00:00.000Z", bytes: 0 },
    { atUtc: "2026-09-23T01:01:00.000Z", bytes: 7_500_000 }, // 1 Mb/s over 60s
    { atUtc: "2026-09-23T01:02:00.000Z", bytes: 1_000 }, // went backwards: a reset
  ];
  const points = historyToRatePoints(s);
  eq(points.length, 2, "N samples give N-1 points");
  eq(Math.abs(points[0].mbps - 1) < 0.001, true, "7.5MB in 60s is 1 Mb/s");
  eq(points[1].mbps, null, "a counter reset is never a rate");
  if (!/reset|wrapped/.test(points[1].reason ?? "")) {
    throw new Error(`the reset must say so, got: ${points[1].reason}`);
  }
});

check("fewer than two samples gives no points at all", () => {
  eq(historyToRatePoints([]), []);
  eq(historyToRatePoints([{ atUtc: NOW, bytes: 5 }]), []);
});

check("historyToRatePoints: an UNCHANGED byte count is a real zero (idle link), never a counter reset", () => {
  // Mirrors contracts/networkView.ts's own counterRate() guard by hand (this
  // file has no import of compiled contract output -- see the module
  // header). `next.bytes < prev.bytes` is correct; `<=` would turn every
  // idle-interface sample into a fabricated "reset" instead of 0.00 Mb/s.
  const points = historyToRatePoints([
    { atUtc: "2026-09-23T01:00:00.000Z", bytes: 5_000_000 },
    { atUtc: "2026-09-23T01:01:00.000Z", bytes: 5_000_000 },
  ]);
  eq(points, [{ atUtc: "2026-09-23T01:01:00.000Z", mbps: 0, reason: null }], "unchanged bytes -> 0 Mb/s, not a reset");
});

check("cooldownRemainingMs: 0 before any run, positive mid-cooldown, 0 once it has elapsed", () => {
  eq(cooldownRemainingMs(null, NOW_MS), 0, "never run");
  const midCooldown = cooldownRemainingMs({ atUtc: "2026-09-23T01:09:30.000Z" }, NOW_MS);
  eq(midCooldown > 0 && midCooldown <= 30_000, true, `expected ~30000ms left, got ${midCooldown}`);
  eq(cooldownRemainingMs({ atUtc: "2026-09-23T00:00:00.000Z" }, NOW_MS), 0, "well past 60s");
});

/* ── the rate strip element itself ────────────────────────────────────────── */

check("the rate strip draws two polylines, and skips the reset rather than joining across it", () => {
  const doc = freshDom();
  const svg = buildRateStripSvg(doc, FULL_INTERFACE.rxHistory, FULL_INTERFACE.txHistory);
  eq(svg.tagName, "SVG", "an inline svg, not a canvas or an image");
  const polylines = svg.descendants().filter((el) => el.tagName === "POLYLINE");
  // rx has one reset among 6 samples (bytes rises, drops, rises again) -> two
  // separate runs of two points each, one on either side of the break, plus
  // tx's one unbroken run: three polylines in total, never one line drawn
  // straight through the reset.
  eq(polylines.length, 3, `expected 3 polyline segments (2 rx runs + 1 tx run), got ${polylines.length}`);
});

check("the strip aligns rx and tx by real TIME, not by each array's own index, when their histories differ in length", () => {
  // agent/network-facts.mjs's runCounterSample() pushes to history.rx and
  // history.tx INDEPENDENTLY -- "if (sample.rx !== null) history.rx.push(...)"
  // and a separate check for tx -- so a transient sysfs read failure on only
  // one direction on some earlier ticks leaves the two arrays at different
  // lengths even though their MOST RECENT sample is the same real instant.
  // Positioning a point by its own array index (rather than its timestamp)
  // would then draw "now" for rx and "now" for tx at very different x
  // positions on the same strip.
  const doc = freshDom();
  const NOW_TS = "2026-09-23T01:00:00.000Z";
  const minuteSamplesEndingNow = (count) => {
    const out = [];
    let bytes = 0;
    const nowMs = Date.parse(NOW_TS);
    for (let i = 0; i < count; i++) {
      bytes += 1_000_000;
      out.push({ atUtc: new Date(nowMs - (count - i) * 60_000).toISOString(), bytes });
    }
    return out;
  };
  // tx has a full ~60-minute history; rx only has its last ~10 minutes -- but
  // both were sampled up to and including the SAME latest tick.
  const txHistory = minuteSamplesEndingNow(60);
  const rxHistory = minuteSamplesEndingNow(10);

  const svg = buildRateStripSvg(doc, rxHistory, txHistory);
  const lastPointX = (color) => {
    const line = svg.descendants().find((el) => el.tagName === "POLYLINE" && el.getAttribute("stroke") === color);
    if (!line) throw new Error(`no polyline with stroke ${color}`);
    const pts = line.getAttribute("points").trim().split(/\s+/);
    return Number(pts[pts.length - 1].split(",")[0]);
  };
  const rxLastX = lastPointX("#64b5f6");
  const txLastX = lastPointX("#ffb74d");
  if (Math.abs(rxLastX - txLastX) > 0.5) {
    throw new Error(`rx's most recent sample (now) drew at x=${rxLastX}, tx's at x=${txLastX} -- the same real instant must land at the same x`);
  }
});

check("too few samples draws a note, not a misleading empty graph", () => {
  const doc = freshDom();
  const el = buildRateStripSvg(doc, EMPTY_INTERFACE.rxHistory, EMPTY_INTERFACE.txHistory);
  eq(el.tagName, "DIV", "no svg element at all");
  if (!textOf(el).toLowerCase().includes("not enough samples")) {
    throw new Error(`must say why there is no graph, got: ${textOf(el)}`);
  }
});

/* ── rendering the whole page ─────────────────────────────────────────────── */

check("a fully-measured interface reads its numbers, with units, and nothing unmeasured", () => {
  const doc = freshDom();
  renderInterfaces(doc, doc.byId.interfaces, [FULL_INTERFACE]);
  const text = textOf(doc.byId.interfaces);
  for (const expect of ["eth0", "up", "192.168.1.50/24", "1000 Mb/s", "full", "cam-front", "3.21 Mb/s", "0.87 Mb/s"]) {
    if (!text.includes(expect)) throw new Error(`expected "${expect}" in interface card, got: ${text}`);
  }
});

check("an interface with nothing measured says why for every field, never a blank or a zero", () => {
  const doc = freshDom();
  renderInterfaces(doc, doc.byId.interfaces, [EMPTY_INTERFACE]);
  const text = textOf(doc.byId.interfaces);
  for (const reason of [
    "no IPv4 address",
    "could not read operstate",
    "no negotiated speed reported (link may be down)",
    "duplex not reported",
    "fewer than two samples so far",
    "not read at sampling start",
  ]) {
    if (!text.includes(reason)) throw new Error(`expected reason "${reason}" verbatim, got: ${text}`);
  }
  if (!text.includes("none")) throw new Error(`no cameras on this interface must say "none", got: ${text}`);
});

check("connection checks render measurements and reasons, never a verdict word of their own", () => {
  const doc = freshDom();
  renderConnectionChecks(doc, doc.byId.connectionChecks, VIEW.connectionChecks);
  const text = textOf(doc.byId.connectionChecks);
  for (const expect of [
    "192.168.1.1", "answered in 4 ms", "answered in 18 ms (resolved to 1.1.1.1)",
    "answered in 9 ms", "no answer within 2000 ms (timed out)", "synchronised",
    "no cloud service configured",
  ]) {
    if (!text.includes(expect)) throw new Error(`expected "${expect}", got: ${text}`);
  }
});

check("the full page renders both cameras, other devices and the IP collision", () => {
  const doc = freshDom();
  renderNetwork(doc, VIEW, NOW_MS);
  // localTime is local wall-clock, deliberately (an installer reads the box's
  // own clock, not UTC) -- so the expectation is built the same way rather
  // than a hardcoded UTC-looking string that would only pass in one timezone.
  eq(textOf(doc.byId.measuredSince), `measured since ${localTime(VIEW.measuredSinceUtc)}`, "measured-since header, HH:MM");

  const cams = textOf(doc.byId.cameras);
  if (!cams.includes("Front door")) throw new Error(`camera name missing, got: ${cams}`);
  if (!cams.includes("2.0 Mbps")) throw new Error(`bitrate with its unit missing, got: ${cams}`);
  if (!cams.includes("15 fps")) throw new Error(`fps with its unit missing, got: ${cams}`);
  if (!cams.includes("Hikvision")) throw new Error(`maker missing, got: ${cams}`);

  // Every reason for the fully-blank camera, verbatim.
  for (const reason of [
    "no host configured", "no IP to look up", "no MAC to look up",
    "not reported", "no answer yet", "no sealed segment yet", "not measured",
  ]) {
    if (!cams.includes(reason)) throw new Error(`expected reason "${reason}" on the blank camera, got: ${cams}`);
  }
  if (!cams.includes("4 consecutive miss")) throw new Error(`consecutive misses missing, got: ${cams}`);

  // The MAC-change row: the contract's own sentence, unaltered.
  if (!cams.includes("MAC for 192.168.1.51 changed from 11:22:33:44:55:66 to aa:bb:cc:dd:ee:ff at 2026-09-23T01:05:00.000Z")) {
    throw new Error(`the MAC-change note must appear verbatim, got: ${cams}`);
  }

  const others = textOf(doc.byId.otherDevices);
  if (!others.includes("192.168.1.77")) throw new Error(`other device missing, got: ${others}`);
  if (!others.includes("no maker list on this box")) throw new Error(`maker reason missing, got: ${others}`);

  eq(doc.byId.ipCollisions.hidden, false, "a real collision must not be hidden");
  const collisions = textOf(doc.byId.ipCollisions);
  if (!collisions.includes("192.168.1.90") || !collisions.includes("aa:aa:aa:aa:aa:aa")) {
    throw new Error(`the IP collision must name the ip and both MACs, got: ${collisions}`);
  }
});

check("no ipCollisions hides the section instead of showing an empty list", () => {
  const doc = freshDom();
  renderNetwork(doc, { ...clone(VIEW), ipCollisions: [] }, NOW_MS);
  eq(doc.byId.ipCollisions.hidden, true, "nothing to say, so nothing shown");
});

check("rendering never touches the extra field a bug upstream might have forwarded", () => {
  const doc = freshDom();
  renderNetwork(doc, VIEW, NOW_MS); // the fake DOM throws if innerHTML is ever used
  const whole = textOf(doc.byId.cameras) + textOf(doc.byId.otherDevices) + textOf(doc.byId.interfaces);
  if (whole.includes("rtsp://")) {
    throw new Error(`a raw stream URL reached the page: ${whole}`);
  }
  if (whole.includes("S3cr3tPass")) {
    throw new Error(`a camera password reached the page: ${whole}`);
  }
});

check("the discover button and its cooldown: disabled and counting down mid-cooldown", () => {
  const doc = freshDom();
  renderNetwork(doc, VIEW, NOW_MS); // discovery.atUtc is 30s before NOW
  eq(doc.byId.discoverBtn.disabled, true, "still cooling down");
  if (!/available again in \d+s/.test(textOf(doc.byId.discoverStatus))) {
    throw new Error(`expected a countdown, got: ${textOf(doc.byId.discoverStatus)}`);
  }

  const later = freshDom();
  renderNetwork(later, VIEW, NOW_MS + 60_000); // a full minute after that run
  eq(later.byId.discoverBtn.disabled, false, "cooldown elapsed");
  if (!textOf(later.byId.discoverStatus).includes("last checked")) {
    throw new Error(`expected a last-checked time, got: ${textOf(later.byId.discoverStatus)}`);
  }

  const never = freshDom();
  renderNetwork(never, { ...clone(VIEW), discovery: null }, NOW_MS);
  eq(never.byId.discoverBtn.disabled, false, "never run yet: nothing to wait out");
  eq(textOf(never.byId.discoverStatus), "never checked");
});

check("nothing unknown is drawn as zero anywhere on the page", () => {
  const doc = freshDom();
  renderNetwork(doc, { ...clone(VIEW), interfaces: [EMPTY_INTERFACE], cameras: [CAM_BLANK], otherDevices: [] }, NOW_MS);
  const whole = textOf(doc.byId.interfaces) + textOf(doc.byId.cameras);
  // 4 consecutive misses is a real, non-zero count and must still show; the
  // anchor rules out only a BARE "0" standing in for something unmeasured.
  if (/(?<![0-9.])0(?:\.0)?\s*(mb\/s|kbps|mbps|ms|fps)\b/i.test(whole)) {
    throw new Error(`a fabricated zero measurement was drawn: ${whole}`);
  }
});

/* ── polling and the discover button, end to end ──────────────────────────── */

function fakeTimers() {
  const ticks = [];
  return {
    ticks,
    setIntervalFn: (fn, ms) => { ticks.push({ fn, ms }); return ticks.length; },
    clearIntervalFn: (h) => { ticks[h - 1] = null; },
  };
}
const jsonResponse = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });

await check("the first poll draws /network and asks nothing else", async () => {
  const doc = freshDom();
  const t = fakeTimers();
  const asked = [];
  const page = startNetworkPage({
    doc,
    fetchFn: async (url) => { asked.push(url); return jsonResponse(VIEW); },
    nowFn: () => NOW_MS,
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  await page.ready;
  eq(asked, ["/network"], "exactly one endpoint, exactly once");
  eq(doc.byId.pollError.hidden, true, "no error to show");
  if (!textOf(doc.byId.cameras).includes("Front door")) throw new Error("the page never drew the fixture");
  page.stop();
});

await check("one failed poll leaves the last good page on screen, and says why", async () => {
  const doc = freshDom();
  const t = fakeTimers();
  let broken = false;
  const page = startNetworkPage({
    doc,
    fetchFn: async () => { if (broken) throw new Error("connection refused"); return jsonResponse(VIEW); },
    nowFn: () => NOW_MS,
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  await page.ready;
  const drawn = textOf(doc.byId.cameras);
  broken = true;
  await page.poll();
  eq(doc.byId.pollError.hidden, false, "the failure is visible");
  eq(textOf(doc.byId.cameras), drawn, "the last good page is still there");
  page.stop();
});

await check('"Look for cameras" success re-polls and reports the count; a 429 shows the server\'s own message and never bypasses the cooldown', async () => {
  const doc = freshDom();
  const t = fakeTimers();
  const calls = [];
  let discoverStatus = 200;
  let discoverBody = { ok: true, atUtc: NOW, replies: [{}, {}, {}] };
  const page = startNetworkPage({
    doc,
    fetchFn: async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/network/discover") return jsonResponse(discoverBody, discoverStatus);
      return jsonResponse(VIEW);
    },
    nowFn: () => NOW_MS,
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  await page.ready;
  calls.length = 0;

  await page.discover();
  eq(calls.map((c) => c.url), ["/network/discover", "/network"], "discover, then a re-poll for the new devices");
  eq(calls[0].method, "POST");
  eq(textOf(doc.byId.discoverMessage), "found 3 replies");

  calls.length = 0;
  discoverStatus = 429;
  discoverBody = { ok: false, code: "rate_limited", message: "discovery already ran recently; try again in 41s", atUtc: NOW };
  await page.discover();
  eq(textOf(doc.byId.discoverMessage), "discovery already ran recently; try again in 41s", "the server's own message, verbatim");
  page.stop();
});

await check("clicking the button in the DOM runs the same discover() path", async () => {
  const doc = freshDom();
  const t = fakeTimers();
  const calls = [];
  const page = startNetworkPage({
    doc,
    fetchFn: async (url) => { calls.push(url); return url === "/network/discover" ? jsonResponse({ ok: true, atUtc: NOW, replies: [] }) : jsonResponse(VIEW); },
    nowFn: () => NOW_MS,
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  await page.ready;
  calls.length = 0;
  doc.byId.discoverBtn.dispatch("click");
  // The click handler is fire-and-forget from the listener's point of view;
  // give its promise a turn before asserting.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  if (!calls.includes("/network/discover")) throw new Error(`the click never reached the server, calls: ${calls}`);
  page.stop();
});

/* ── the nav link: visible for the role that may open it, hidden otherwise ── */

check("PAGE_NEEDS registers the Network page under network.view, the same permission the route table gates it with", () => {
  eq(PAGE_NEEDS["/network-page"], "network.view");
  eq(decideRoute({ kind: "user", username: "tech", role: "installer" }, "GET", "/network-page").kind, "allow");
  eq(decideRoute({ kind: "user", username: "clerk", role: "store" }, "GET", "/network-page").kind, "refuse");
});

check("the Network nav link stays visible for the installer role and is hidden for the store role", () => {
  const buildNav = () => {
    const root = new FakeEl("div");
    const network = new FakeEl("a"); network.setAttribute("href", "/network-page");
    const live = new FakeEl("a"); live.setAttribute("href", "/"); // no permission needed: never hidden
    root.appendChild(network);
    root.appendChild(live);
    return { root, network, live };
  };

  const installerNav = buildNav();
  hideRefusedLinks(installerNav.root, permissionsFor("installer"));
  eq(installerNav.network.hidden, false, "installer keeps the Network link");
  eq(installerNav.live.hidden, false, "an unrestricted link is never touched");

  const storeNav = buildNav();
  hideRefusedLinks(storeNav.root, permissionsFor("store"));
  eq(storeNav.network.hidden, true, "store never sees the Network link");
  eq(storeNav.live.hidden, false, "hiding one link must not hide another");
});

/* ── the CSS itself: no phone-width overflow trap ─────────────────────────── */

const NETWORK_HTML = readFileSync(join(process.cwd(), "agent/ui/network.html"), "utf8");

function styleBlockOf(html) {
  const m = /<style>([\s\S]*?)<\/style>/.exec(html);
  return m ? m[1] : "";
}

/** Removes every top-level @media {...} block: a fixed width INSIDE a media
 *  query is how a breakpoint is supposed to work and is not the trap this
 *  looks for. Handles one level of brace nesting, which is all this file's
 *  own stylesheet ever has. */
function stripMediaBlocks(css) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css.slice(i, i + 6) === "@media") {
      let j = css.indexOf("{", i);
      if (j === -1) break;
      let depth = 1;
      j++;
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
        j++;
      }
      i = j;
      continue;
    }
    out += css[i];
    i++;
  }
  return out;
}

/** `width` and `min-width` outside a media query, over 360px: either one can
 *  force a phone-width viewport to scroll sideways. `max-width` (a cap, never
 *  a floor) is deliberately not flagged -- the preceding-character class
 *  below excludes "-", so "max-width:960px" never matches as a bare "width". */
function findWideFixedWidths(css) {
  const rest = stripMediaBlocks(css);
  const re = /(^|[^a-zA-Z-])(min-width|width)\s*:\s*(\d+)px/g;
  const hits = [];
  let m;
  while ((m = re.exec(rest)) !== null) {
    const px = Number(m[3]);
    if (px > 360) hits.push(`${m[2]}:${px}px`);
  }
  return hits;
}

check("network.html has no fixed width over 360px outside a media query", () => {
  same(findWideFixedWidths(styleBlockOf(NETWORK_HTML)), [], "no phone-width overflow trap");
});

check("network.html declares a 16px gutter and a sub-640px collapse breakpoint", () => {
  const css = styleBlockOf(NETWORK_HTML);
  if (!/body\s*\{[^}]*padding\s*:\s*16px/.test(css)) throw new Error("expected a 16px body gutter");
  if (!/@media\s*\(max-width:\s*640px\)/.test(css)) throw new Error("expected a collapse breakpoint around 640px");
  if (!/\.data-table\s+thead\s*\{\s*display\s*:\s*none/.test(css)) throw new Error("expected the table header to be hidden when collapsed to cards");
});

report("network page");
