// agent/ui/network-client.mjs
//
// Client logic for the Network page (agent/ui/network.html), NETWORK-PAGE-SPEC.md
// Shape item 4. Polls GET /network and draws interfaces, connection checks,
// cameras, other devices and the "Look for cameras" button, plus a 60-minute
// rate strip per interface drawn as inline SVG (no library).
//
// contracts/networkView.ts's own handoff note: every optional/unmeasurable
// field the server sends is a Measured<T> or a *Result union carrying a
// `reason` string, and this page renders `.reason` verbatim rather than
// inventing its own copy (build rule 5: a blank is not a zero; rule 10:
// refuse rather than guess).
//
// THE FEARED FAILURE this file is written against: a camera's resolved
// `rtsp://user:pass@host/...` reaching the screen. It cannot happen by
// construction here, not by scrubbing strings -- every row renderer below
// reads a fixed, named set of fields off the row objects the server sent
// (contracts/networkView.ts's CameraRow/OtherDeviceRow) and nothing else, so
// an extra property tacked onto a row (by a bug upstream, or a hostile
// fixture) is never even looked at, let alone printed. See the harness for
// the fixture that proves it.
//
// Same house rule as agent/ui/system-client.mjs: no innerHTML anywhere. A
// camera name or model string came out of a config file or a discovery reply
// on the wire, not something this page may trust as markup.

const NOT_MEASURED = "not measured";
const SVG_NS = "http://www.w3.org/2000/svg";
const STRIP_WIDTH = 300;
const STRIP_HEIGHT = 36;
// Mirrors network-facts.mjs's DISCOVER_MIN_GAP_MS. Duplicated, not imported --
// this file has no import of server code, the same boundary every other
// *-client.mjs in this directory keeps (see agent/api-server.mjs's UI_FILES).
const DISCOVER_COOLDOWN_MS = 60_000;

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function byId(doc, id) {
  if (doc && typeof doc.getElementById === "function") {
    return doc.getElementById(id);
  }
  return null;
}

function clearChildren(el) {
  if (!el) {
    return;
  }
  if (typeof el.replaceChildren === "function") {
    el.replaceChildren();
  } else {
    el.textContent = "";
  }
}

const two = (n) => String(n).padStart(2, "0");

/** Local wall-clock "HH:MM" for a UTC ISO string. Same convention as every
 *  other page in this family (system-client.mjs, review.html). */
export function localTime(utc) {
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) {
    return String(utc);
  }
  return two(d.getHours()) + ":" + two(d.getMinutes());
}

/* ── Measured<T> and the *Result unions: read the value, or the reason ──── */

/** A Measured<T> -> formatFn(value), or its own reason verbatim. Anything
 *  else that is not the expected shape reads as "not measured", never blank. */
function measuredOrReason(m, formatFn) {
  if (!m || typeof m !== "object") {
    return NOT_MEASURED;
  }
  if (m.kind === "measured") {
    return formatFn ? formatFn(m.value) : String(m.value);
  }
  return typeof m.reason === "string" && m.reason ? m.reason : NOT_MEASURED;
}

/** MakerResult: {kind:"known",maker} | {kind:"unknown_oui"|"no_list",reason}. */
function makerText(maker) {
  if (!maker || typeof maker !== "object") {
    return NOT_MEASURED;
  }
  if (maker.kind === "known" && typeof maker.maker === "string") {
    return maker.maker;
  }
  return typeof maker.reason === "string" && maker.reason ? maker.reason : "unknown";
}

/** MacChangeResult. Only "changed" carries anything worth a line -- its own
 *  `note` IS the sentence the spec asks for ("MAC for <ip> changed from A to
 *  B at T"), never re-composed here. */
function macChangeText(macChange) {
  if (!macChange || typeof macChange !== "object") {
    return NOT_MEASURED;
  }
  if (macChange.kind === "changed" && typeof macChange.note === "string" && macChange.note) {
    return macChange.note;
  }
  if (macChange.kind === "first_seen") {
    return "first seen";
  }
  if (macChange.kind === "unchanged") {
    return "unchanged";
  }
  return NOT_MEASURED;
}

/** A ping/DNS/internet CheckResult: {kind:"answered",ms[,address]} |
 *  {kind:"no_answer",withinMs[,reason]} | {kind:"unmeasured",reason}. The
 *  words around the numbers are this page's; the reason text itself, when
 *  there is one, is the server's own and is never paraphrased. */
function checkText(c) {
  if (!c || typeof c !== "object") {
    return NOT_MEASURED;
  }
  if (c.kind === "answered") {
    const base = isNum(c.ms) ? `answered in ${c.ms} ms` : "answered";
    return typeof c.address === "string" && c.address ? `${base} (resolved to ${c.address})` : base;
  }
  if (c.kind === "no_answer") {
    const base = isNum(c.withinMs) ? `no answer within ${c.withinMs} ms` : "no answer";
    return typeof c.reason === "string" && c.reason ? `${base} (${c.reason})` : base;
  }
  if (c.kind === "unmeasured") {
    return typeof c.reason === "string" && c.reason ? c.reason : NOT_MEASURED;
  }
  return NOT_MEASURED;
}

/** checkClockSync's own shape: {kind:"measured",value:boolean} |
 *  {kind:"unmeasured",reason} -- "measured", not "answered": true/false is
 *  the fact itself, not a round trip. */
function clockText(c) {
  if (!c || typeof c !== "object") {
    return NOT_MEASURED;
  }
  if (c.kind === "measured") {
    return c.value === true ? "synchronised" : "not synchronised";
  }
  if (c.kind === "unmeasured") {
    return typeof c.reason === "string" && c.reason ? c.reason : NOT_MEASURED;
  }
  return NOT_MEASURED;
}

/** rxNowMbps/txNowMbps: RateResult, optionally with a `direction` tag this
 *  page does not need (the column it is in already says which). */
function rateNowText(r) {
  if (!r || typeof r !== "object") {
    return NOT_MEASURED;
  }
  if (r.kind === "ok") {
    return isNum(r.mbps) ? `${r.mbps.toFixed(2)} Mb/s` : NOT_MEASURED;
  }
  if (r.kind === "counter_reset" || r.kind === "unavailable") {
    return typeof r.reason === "string" && r.reason ? r.reason : NOT_MEASURED;
  }
  return NOT_MEASURED;
}

function kbpsText(n) {
  if (!isNum(n)) {
    return NOT_MEASURED;
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + " Mbps";
  }
  return n + " kbps";
}

/* ── the 60-minute rate strip: raw byte counters -> per-minute Mb/s ──────── */

/**
 * `samples` is agent/network-facts.mjs's own rxHistory/txHistory: up to 60
 * CounterSample ({atUtc, bytes}) taken a minute apart, oldest first. Returns
 * one point per consecutive pair -- N samples give N-1 rates, never N, since
 * a rate needs two readings.
 *
 * Mirrors contracts/networkView.ts's counterRate() by hand rather than
 * importing it: this file has no import of compiled contract output, the
 * same boundary every *-client.mjs in this directory keeps (server code
 * reaches the browser only through the small, purpose-built .mts modules
 * agent/api-server.mjs serves under UI_CONTRACTS, and this page needs none of
 * those). A counter that goes backwards (an interface flap, a 32-bit wrap) is
 * reported as a reason, not a negative rate -- the exact failure counterRate
 * itself exists to catch.
 */
export function historyToRatePoints(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const points = [];
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const next = list[i];
    if (!prev || !next || !isNum(prev.bytes) || !isNum(next.bytes)) {
      points.push({ atUtc: next && next.atUtc, mbps: null, reason: "a sample was missing" });
      continue;
    }
    const prevMs = Date.parse(prev.atUtc);
    const nextMs = Date.parse(next.atUtc);
    if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs)) {
      points.push({ atUtc: next.atUtc, mbps: null, reason: "a sample's timestamp did not parse" });
      continue;
    }
    const deltaSeconds = (nextMs - prevMs) / 1000;
    if (deltaSeconds <= 0) {
      points.push({ atUtc: next.atUtc, mbps: null, reason: `samples ${deltaSeconds}s apart` });
      continue;
    }
    if (next.bytes < prev.bytes) {
      points.push({
        atUtc: next.atUtc, mbps: null,
        reason: `counter went from ${prev.bytes} to ${next.bytes} bytes; the interface reset or wrapped`,
      });
      continue;
    }
    const deltaBytes = next.bytes - prev.bytes;
    points.push({ atUtc: next.atUtc, mbps: (deltaBytes * 8) / deltaSeconds / 1_000_000, reason: null });
  }
  return points;
}

/** A point's own timestamp in ms, or null when it did not parse -- never NaN
 *  compared against anything, the same discipline counterRate/historyToRatePoints
 *  already keep for a sample's atUtc. */
function pointMs(p) {
  const ms = Date.parse(p && p.atUtc);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One coloured polyline per run of consecutive measured points: a gap (a
 * missing sample, an unparseable timestamp, or a counter reset) breaks the
 * line rather than being interpolated across as if the rate in between were
 * known (build rule 5).
 *
 * `minMs`/`maxMs` are a SHARED time axis -- the oldest and newest timestamp
 * across both rx and tx combined, computed once by the caller -- so a point
 * is placed by how long ago it actually was, not by its position within its
 * OWN array. Placing by array index (the previous approach) silently assumed
 * rx and tx were sampled at the same times and had the same length; a
 * transient read failure on only one counter direction on some ticks (rx and
 * tx are two independent /sys reads that can fail independently) breaks that
 * assumption, and index-based placement would then draw "now" for rx and
 * "now" for tx at two very different x positions on the same strip.
 */
function appendRatePolyline(doc, svg, points, minMs, maxMs, max, color) {
  let segment = [];
  const flush = () => {
    if (segment.length >= 2) {
      const poly = doc.createElementNS(SVG_NS, "polyline");
      poly.setAttribute("points", segment.map(([x, y]) => `${x},${y}`).join(" "));
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", color);
      poly.setAttribute("stroke-width", "1.5");
      svg.appendChild(poly);
    }
    segment = [];
  };
  const span = maxMs - minMs;
  for (const p of points) {
    const ms = pointMs(p);
    if (ms === null || !isNum(p.mbps)) {
      flush();
      continue;
    }
    const x = span > 0 ? ((ms - minMs) / span) * STRIP_WIDTH : STRIP_WIDTH;
    const y = STRIP_HEIGHT - Math.max(0, Math.min(1, p.mbps / max)) * STRIP_HEIGHT;
    segment.push([x, y]);
  }
  flush();
}

/**
 * The interface's 60-minute rx/tx strip, as one inline <svg> -- no charting
 * library, per the spec. Fewer than two samples in either direction means
 * there is nothing to draw a line between yet, so this returns a plain
 * "not enough samples yet" line instead of an empty or misleading graphic.
 */
export function buildRateStripSvg(doc, rxHistory, txHistory) {
  const rxPoints = historyToRatePoints(rxHistory);
  const txPoints = historyToRatePoints(txHistory);
  const slots = Math.max(rxPoints.length, txPoints.length);
  if (slots < 2) {
    const note = doc.createElement("div");
    note.className = "dim note";
    note.textContent = "not enough samples yet for a rate strip";
    return note;
  }
  const allPoints = [...rxPoints, ...txPoints];
  const times = allPoints.map(pointMs).filter(isNum);
  // The shared time axis both series are placed against -- see
  // appendRatePolyline's own note on why this must be real time, not index.
  const minMs = times.length > 0 ? Math.min(...times) : 0;
  const maxMs = times.length > 0 ? Math.max(...times) : 0;
  const values = allPoints.map((p) => p.mbps).filter(isNum);
  const max = values.length > 0 ? Math.max(...values, 0.001) : 0.001;
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "stripSvg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "receive (blue) and transmit (orange) rate over the last hour");
  appendRatePolyline(doc, svg, rxPoints, minMs, maxMs, max, "#64b5f6"); // rx
  appendRatePolyline(doc, svg, txPoints, minMs, maxMs, max, "#ffb74d"); // tx
  return svg;
}

/* ── rendering: one function per DOM piece, all textContent/DOM calls ───── */

function appendKv(doc, container, label, value, tone) {
  const span = doc.createElement("span");
  const k = doc.createElement("span");
  k.className = "k";
  k.textContent = label + ":";
  span.appendChild(k);
  span.appendChild(doc.createTextNode(" " + value));
  if (tone) {
    span.className = tone;
  }
  container.appendChild(span);
}

function addressesText(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  if (list.length === 0) {
    return "no IPv4 address";
  }
  return list
    .map((a) => {
      const addr = (a && typeof a.address === "string") ? a.address : "unknown";
      if (a && isNum(a.cidr)) {
        return `${addr}/${a.cidr}`;
      }
      if (a && typeof a.netmask === "string" && a.netmask) {
        return `${addr} (mask ${a.netmask})`;
      }
      return addr;
    })
    .join(", ");
}

function macOfAddresses(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  const withMac = list.find((a) => a && typeof a.mac === "string" && a.mac);
  return withMac ? withMac.mac : "not reported";
}

function interfaceCard(doc, iface) {
  const card = doc.createElement("div");
  card.className = "card";

  const head = doc.createElement("div");
  head.className = "card-head";
  const name = doc.createElement("span");
  name.textContent = (typeof iface.name === "string" && iface.name) ? iface.name : "unknown interface";
  head.appendChild(name);
  const state = doc.createElement("span");
  const stateText = measuredOrReason(iface.operState);
  state.textContent = stateText;
  state.className = stateText === "up" ? "good" : (stateText === "down" ? "bad" : "dim");
  head.appendChild(state);
  card.appendChild(head);

  const kv = doc.createElement("div");
  kv.className = "kv";
  appendKv(doc, kv, "IPv4", addressesText(iface.addresses));
  appendKv(doc, kv, "MAC", macOfAddresses(iface.addresses));
  appendKv(doc, kv, "Speed", measuredOrReason(iface.speedMbps, (v) => `${v} Mb/s`));
  appendKv(doc, kv, "Duplex", measuredOrReason(iface.duplex));
  const camIds = Array.isArray(iface.camerasOnThisInterface) ? iface.camerasOnThisInterface : [];
  appendKv(doc, kv, "Cameras here", camIds.length > 0 ? camIds.join(", ") : "none");
  card.appendChild(kv);

  const rateNow = doc.createElement("div");
  rateNow.className = "kv";
  appendKv(doc, rateNow, "RX now", rateNowText(iface.rxNowMbps));
  appendKv(doc, rateNow, "TX now", rateNowText(iface.txNowMbps));
  const errors = iface.errorsSinceSamplingBegan || {};
  const drops = iface.dropsSinceSamplingBegan || {};
  appendKv(doc, rateNow, "RX errors", measuredOrReason(errors.rx));
  appendKv(doc, rateNow, "TX errors", measuredOrReason(errors.tx));
  appendKv(doc, rateNow, "RX drops", measuredOrReason(drops.rx));
  appendKv(doc, rateNow, "TX drops", measuredOrReason(drops.tx));
  card.appendChild(rateNow);

  card.appendChild(buildRateStripSvg(doc, iface.rxHistory, iface.txHistory));
  return card;
}

/** Interfaces (spec section 1): one card per network card, never a table --
 *  a card's own fields do not line up in columns the way a camera row does. */
export function renderInterfaces(doc, container, interfaces) {
  clearChildren(container);
  const list = Array.isArray(interfaces) ? interfaces : [];
  if (list.length === 0) {
    const p = doc.createElement("div");
    p.className = "dim";
    p.textContent = "no network interfaces found";
    container.appendChild(p);
    return;
  }
  for (const iface of list) {
    container.appendChild(interfaceCard(doc, (iface && typeof iface === "object") ? iface : {}));
  }
}

/** Connection checks (spec section 2): one line per check, never a verdict
 *  beyond "answered in N ms" / "no answer within N ms" (the words checkText
 *  and clockText already keep to). */
export function renderConnectionChecks(doc, container, checks) {
  clearChildren(container);
  const c = (checks && typeof checks === "object") ? checks : null;
  if (!c) {
    const p = doc.createElement("div");
    p.className = "dim";
    p.textContent = NOT_MEASURED;
    container.appendChild(p);
    return;
  }
  const internet = (c.internet && typeof c.internet === "object") ? c.internet : {};
  const rows = [
    ["Gateway address", measuredOrReason(c.gateway)],
    ["Gateway", checkText(c.gatewayCheck)],
    ["DNS", checkText(c.dns)],
    ["Internet (Cloudflare)", checkText(internet.cloudflare)],
    ["Internet (Google)", checkText(internet.google)],
    ["Clock", clockText(c.clock)],
    ["Cloud", checkText(c.cloud)],
  ];
  for (const [label, value] of rows) {
    const row = doc.createElement("div");
    row.className = "kv";
    appendKv(doc, row, label, value);
    container.appendChild(row);
  }
}

function tdEl(doc, label, text, tone) {
  const cell = doc.createElement("td");
  if (typeof cell.setAttribute === "function") {
    cell.setAttribute("data-label", label);
  }
  cell.textContent = text;
  if (tone) {
    cell.className = tone;
  }
  return cell;
}

/** "Last-answered time, round-trip ms, and 'no answer since' with the count
 *  of consecutive misses" (spec section 3). lastAnsweredUtc is the last time
 *  it DID answer -- with any misses at all, that time is what "no answer
 *  since" measures from. */
function answeringText(cam) {
  const misses = isNum(cam.consecutiveMisses) ? cam.consecutiveMisses : 0;
  const missSuffix = misses > 0 ? `, ${misses} consecutive miss${misses === 1 ? "" : "es"}` : "";
  if (cam.lastAnsweredUtc && cam.lastAnsweredUtc.kind === "measured") {
    const when = localTime(cam.lastAnsweredUtc.value);
    const rtt = measuredOrReason(cam.rttMs, (v) => `${v} ms`);
    return misses > 0
      ? `no answer since ${when} (last answered in ${rtt}${missSuffix})`
      : `answered at ${when} (${rtt})`;
  }
  const reason = measuredOrReason(cam.lastAnsweredUtc);
  return reason + missSuffix;
}

function cameraRow(doc, cam) {
  const tr = doc.createElement("tr");
  const label = (typeof cam.name === "string" && cam.name)
    ? cam.name
    : ((typeof cam.cameraId === "string" && cam.cameraId) ? cam.cameraId : "unknown camera");
  const macChange = macChangeText(cam.macChange);
  const cells = [
    ["Camera", label, ""],
    ["IP", measuredOrReason(cam.ip), ""],
    ["Answering", answeringText(cam), isNum(cam.consecutiveMisses) && cam.consecutiveMisses > 0 ? "warn" : ""],
    ["Recording", measuredOrReason(cam.lastSealedUtc, localTime), ""],
    ["Bitrate", measuredOrReason(cam.measuredKbps, kbpsText), ""],
    ["FPS", measuredOrReason(cam.fps, (v) => `${v} fps`), ""],
    ["MAC", measuredOrReason(cam.mac), ""],
    ["Maker", makerText(cam.maker), ""],
    ["Model", measuredOrReason(cam.model), ""],
    ["Firmware", measuredOrReason(cam.firmware), ""],
    ["Serial", measuredOrReason(cam.serial), ""],
    ["MAC history", macChange, macChange !== "unchanged" && macChange !== "first seen" && macChange !== NOT_MEASURED ? "warn" : "dim"],
  ];
  for (const [colLabel, text, tone] of cells) {
    tr.appendChild(tdEl(doc, colLabel, text, tone));
  }
  return tr;
}

function otherDeviceRow(doc, dev) {
  const tr = doc.createElement("tr");
  const cells = [
    ["IP", (typeof dev.ip === "string" && dev.ip) ? dev.ip : "unknown"],
    ["MAC", measuredOrReason(dev.mac)],
    ["Maker", makerText(dev.maker)],
    ["Interface", measuredOrReason(dev.iface)],
    ["State", measuredOrReason(dev.state)],
    ["Model", measuredOrReason(dev.model)],
    ["Firmware", measuredOrReason(dev.firmware)],
  ];
  for (const [label, text] of cells) {
    tr.appendChild(tdEl(doc, label, text));
  }
  return tr;
}

/** "Two devices on one IP" (spec section 5): each IpCollision is its own
 *  measurement, never averaged or collapsed onto one row (build rule 18). */
function renderIpCollisions(doc, container, collisions) {
  clearChildren(container);
  const list = Array.isArray(collisions) ? collisions : [];
  if (list.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const h = doc.createElement("h2");
  h.textContent = "Two devices answering on one IP";
  container.appendChild(h);
  for (const col of list) {
    const row = doc.createElement("div");
    row.className = "card warn";
    const macs = Array.isArray(col.macs) ? col.macs.join(", ") : "unknown MACs";
    const count = Array.isArray(col.replies) ? col.replies.length : 0;
    row.textContent = `${col.ip}: seen with ${macs} (${count} repl${count === 1 ? "y" : "ies"})`;
    container.appendChild(row);
  }
}

/** How long is left before "Look for cameras" may run again: the server's
 *  own cooldown (network-facts.mjs's DISCOVER_MIN_GAP_MS), read off the last
 *  completed run's time rather than tracked separately by this page -- a
 *  page freshly loaded mid-cooldown shows the same countdown a page that
 *  triggered the run would. */
export function cooldownRemainingMs(discovery, nowMs, cooldownMs = DISCOVER_COOLDOWN_MS) {
  if (!discovery || typeof discovery.atUtc !== "string") {
    return 0;
  }
  const at = Date.parse(discovery.atUtc);
  if (!Number.isFinite(at) || !isNum(nowMs)) {
    return 0;
  }
  return Math.max(0, cooldownMs - (nowMs - at));
}

function renderDiscoverStatus(doc, discovery, nowMs) {
  const btn = byId(doc, "discoverBtn");
  const status = byId(doc, "discoverStatus");
  if (!status && !btn) {
    return;
  }
  const remaining = cooldownRemainingMs(discovery, nowMs);
  if (btn) {
    btn.disabled = remaining > 0;
  }
  const last = (discovery && typeof discovery.atUtc === "string")
    ? `last checked ${localTime(discovery.atUtc)}`
    : "never checked";
  if (status) {
    status.textContent = remaining > 0
      ? `${last} — available again in ${Math.ceil(remaining / 1000)}s`
      : last;
  }
}

function showPollError(doc, message) {
  const el = byId(doc, "pollError");
  if (el) {
    el.textContent = message;
    el.hidden = false;
  }
}

function hidePollError(doc) {
  const el = byId(doc, "pollError");
  if (el) {
    el.hidden = true;
  }
}

/**
 * Fills the whole page from a GET /network body. Never throws on a missing
 * or malformed field: anything not shaped as expected renders as "not
 * measured" or an empty section, the same discipline system-client.mjs's
 * renderHealth keeps for /health.
 */
export function renderNetwork(doc, view, nowMs) {
  const v = (view && typeof view === "object") ? view : {};
  const at = isNum(nowMs) ? nowMs : Date.now();

  const since = byId(doc, "measuredSince");
  if (since) {
    since.textContent = (typeof v.measuredSinceUtc === "string")
      ? `measured since ${localTime(v.measuredSinceUtc)}`
      : "measured since unknown";
  }

  const ifacesEl = byId(doc, "interfaces");
  if (ifacesEl) {
    renderInterfaces(doc, ifacesEl, v.interfaces);
  }

  const checksEl = byId(doc, "connectionChecks");
  if (checksEl) {
    renderConnectionChecks(doc, checksEl, v.connectionChecks);
  }

  const camerasEl = byId(doc, "cameras");
  if (camerasEl) {
    clearChildren(camerasEl);
    for (const entry of Array.isArray(v.cameras) ? v.cameras : []) {
      camerasEl.appendChild(cameraRow(doc, (entry && typeof entry === "object") ? entry : {}));
    }
  }

  const otherEl = byId(doc, "otherDevices");
  if (otherEl) {
    clearChildren(otherEl);
    for (const entry of Array.isArray(v.otherDevices) ? v.otherDevices : []) {
      otherEl.appendChild(otherDeviceRow(doc, (entry && typeof entry === "object") ? entry : {}));
    }
  }

  const collisionsEl = byId(doc, "ipCollisions");
  if (collisionsEl) {
    renderIpCollisions(doc, collisionsEl, v.ipCollisions);
  }

  renderDiscoverStatus(doc, v.discovery ?? null, at);
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Polls GET /network, renders it, and wires the "Look for cameras" button to
 * POST /network/discover. Every dependency arrives via opts so a harness can
 * drive this without a browser -- same shape as system-client.mjs's
 * startSystemPage.
 */
export function startNetworkPage(opts) {
  const o = (opts && typeof opts === "object") ? opts : {};
  const doc = o.doc;
  const fetchFn = o.fetchFn;
  const nowFn = typeof o.nowFn === "function" ? o.nowFn : () => Date.now();
  const intervalMs = isNum(o.intervalMs) && o.intervalMs > 0 ? o.intervalMs : 5000;
  const setIntervalFn = typeof o.setIntervalFn === "function"
    ? o.setIntervalFn
    : (typeof setInterval === "function" ? setInterval : null);
  const clearIntervalFn = typeof o.clearIntervalFn === "function"
    ? o.clearIntervalFn
    : (typeof clearInterval === "function" ? clearInterval : null);

  let timer = null;
  let haveData = false;

  async function poll() {
    try {
      if (typeof fetchFn !== "function") {
        throw new Error("no fetch function");
      }
      const res = await fetchFn("/network");
      const code = (res && isNum(res.status)) ? res.status : null;
      const failed = !res
        || (typeof res.ok === "boolean" && !res.ok)
        || (code !== null && (code < 200 || code > 299));
      if (failed) {
        throw new Error("HTTP " + (code !== null ? code : "request failed"));
      }
      const view = await res.json();
      renderNetwork(doc, view, nowFn());
      haveData = true;
      hidePollError(doc);
    } catch (err) {
      const reason = (err && typeof err.message === "string" && err.message) ? err.message : "unknown error";
      const suffix = haveData ? "showing last good data" : "no data received yet";
      showPollError(doc, "network poll failed: " + reason + " (" + suffix + ")");
    }
  }

  /** "Look for cameras": at most once per 60s, enforced by the server, not
   *  guessed here. A 429 shows the server's own message; any other failure
   *  says so in words. Either way the page re-polls /network afterwards, so
   *  a successful run's newly-seen devices appear without a second click --
   *  and a failed one still refreshes the cooldown display from the truth,
   *  rather than this page tracking its own copy of it. */
  async function discover() {
    const message = byId(doc, "discoverMessage");
    const btn = byId(doc, "discoverBtn");
    if (btn) {
      btn.disabled = true;
    }
    if (message) {
      message.textContent = "looking for cameras…";
    }
    try {
      if (typeof fetchFn !== "function") {
        throw new Error("no fetch function");
      }
      const res = await fetchFn("/network/discover", { method: "POST" });
      const body = await safeJson(res);
      if (res && res.status === 429) {
        if (message) {
          message.textContent = (body && typeof body.message === "string" && body.message)
            ? body.message
            : "discovery already ran recently";
        }
      } else if (!res || (typeof res.ok === "boolean" && !res.ok)) {
        if (message) {
          message.textContent = "could not run discovery";
        }
      } else {
        const count = (body && Array.isArray(body.replies)) ? body.replies.length : null;
        if (message) {
          message.textContent = count !== null
            ? `found ${count} repl${count === 1 ? "y" : "ies"}`
            : "discovery ran";
        }
      }
    } catch {
      if (message) {
        message.textContent = "could not reach the recorder";
      }
    }
    await poll();
  }

  const btn = byId(doc, "discoverBtn");
  if (btn && typeof btn.addEventListener === "function") {
    btn.addEventListener("click", () => {
      discover();
    });
  }

  const ready = poll();
  if (setIntervalFn) {
    timer = setIntervalFn(poll, intervalMs);
  }

  return {
    ready,
    poll,
    discover,
    stop: function () {
      if (timer !== null && typeof clearIntervalFn === "function") {
        clearIntervalFn(timer);
      }
      timer = null;
    },
  };
}

// Browser bootstrap. Runs only when the real Network page is in the DOM; a
// harness importing this module for its exported functions injects its own
// doc and fetch via startNetworkPage's opts instead, so importing has no
// side effects there.
if (typeof document !== "undefined" &&
    typeof document.getElementById === "function" &&
    document.getElementById("interfaces")) {
  startNetworkPage({
    doc: document,
    fetchFn: function (url, init) {
      return fetch(url, init);
    },
  });
}
