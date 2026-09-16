/**
 * The system page's client, run without a browser. A fake DOM is enough,
 * because nothing this page does is about pixels: it is about whether a
 * missing number is allowed to look like a small one.
 *
 * The failures tested (build rule 19), in the order they would bite an
 * installer standing in front of the box:
 *
 *   - an unmeasured bitrate drawn as "0 kbps", which reads as a camera sending
 *     nothing when in truth nobody has looked yet;
 *   - an unmeasured disk drawn as an empty bar, which reads as an empty disk
 *     when in truth it may be full;
 *   - a retention figure printed for a site whose cameras were never measured,
 *     which is the number the installer quotes to the customer;
 *   - a camera that has never recorded shown as "0s ago";
 *   - one failed poll blanking the page, which reads as the NVR dying;
 *   - a camera name out of a config file turning into markup.
 *
 * The fake DOM's innerHTML setter throws on purpose. Escaping a name is a
 * thing to get right every time; not building HTML at all is a thing to get
 * right once.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { check, eq, same, report } from "./_assert.mjs";

const client = await import(
  pathToFileURL(join(process.cwd(), "agent/ui/system-client.mjs")).href
);
const { formatBytes, formatKbps, formatDuration, retentionText, renderHealth, startSystemPage } = client;

console.log("system page");

/* ── the smallest DOM this page's contract allows ─────────────────────────── */

class FakeEl {
  constructor(tag, id = null) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.className = "";
    this.hidden = false;
    this.title = "";
    this.attrs = {};
    this._text = "";
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] ?? null; }
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
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...cs) { this.textContent = ""; this.append(...cs); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener() {}
  // A camera name comes out of a config file an installer typed. Building
  // markup from it is how a stray "<" empties the page, so the page may not.
  set innerHTML(_) { throw new Error("the page must not use innerHTML"); }
  get innerHTML() { return ""; }
  /** Every element in this subtree, self included -- how the checks look inside. */
  descendants() {
    return this.children.flatMap((c) => (c.descendants ? [c, ...c.descendants()] : [c]));
  }
}
const textNode = (s) => { const t = new FakeEl("#text"); t._text = s; return t; };

const PAGE_IDS = ["overall", "asOf", "totals", "recorder", "cameras", "stores", "pollError"];

function freshDom() {
  const byId = {};
  for (const id of PAGE_IDS) byId[id] = new FakeEl(id === "cameras" ? "tbody" : "div", id);
  byId.pollError.hidden = true;
  return {
    byId,
    getElementById: (id) => byId[id] ?? null,
    createElement: (tag) => new FakeEl(tag),
    createTextNode: textNode,
  };
}

/** The text of one element plus everything under it, whitespace flattened. */
const textOf = (el) => el.textContent.replace(/\s+/g, " ").trim();

/* ── a healthy site, and the wreck ────────────────────────────────────────── */

const HEALTHY = {
  ok: true,
  status: "ok",
  siteId: "bench-laptop",
  atUtc: "2026-09-16T01:02:13.638Z",
  recorderRunning: true,
  cameras: [
    {
      cameraId: "cam1-main", state: "recording", status: "ok", detail: "sealed 13s ago",
      measuredKbps: 171, segments: 76, bytes: 112801325,
      lastSealedUtc: "2026-09-16T01:02:01.065Z", secondsSinceSealed: 12.573, openSegments: 1,
    },
  ],
  stores: [
    {
      root: "/srv/camplat/disk0", state: "ok", status: "ok",
      totalBytes: 6375342080, freeBytes: 6038941696, usedBytes: 336400384,
      usedFraction: 0.0527,
    },
  ],
  totals: {
    cameras: 1, recording: 1, unresolved: 0, silent: 0,
    segments: 76, bytes: 112801325, measuredKbps: 171, camerasUnmeasured: 0,
  },
  retention: { kind: "ok", days: 5.178153086419753, totalKbps: 171, camerasCounted: 1 },
};

/** The same shape with every "we do not know" in it at once. */
const UNKNOWNS = {
  ok: false,
  status: "down",
  siteId: "carwash-01",
  atUtc: "2026-09-11T12:00:00.000Z",
  recorderRunning: null,
  cameras: [
    {
      cameraId: "cam-never", state: "never_recorded", status: "unknown", detail: "no segments yet",
      measuredKbps: null, segments: 0, bytes: 0,
      lastSealedUtc: null, secondsSinceSealed: null, openSegments: 0,
    },
    {
      cameraId: "cam-silent", state: "silent", status: "degraded", detail: "nothing sealed for 1h 54m",
      measuredKbps: 0, segments: 3, bytes: 300,
      lastSealedUtc: "2026-09-11T10:06:00.000Z", secondsSinceSealed: 6840, openSegments: 0,
    },
  ],
  stores: [
    {
      root: "/srv/camplat/disk9", state: "unmeasured", status: "unknown",
      totalBytes: null, freeBytes: null, usedBytes: null, usedFraction: null,
    },
  ],
  totals: {
    cameras: 2, recording: 0, unresolved: 0, silent: 1,
    segments: 3, bytes: 300, measuredKbps: 0, camerasUnmeasured: 1,
  },
  retention: {
    kind: "unknown", reason: "unmeasured_cameras",
    message: "cannot say: one camera has never been measured",
    unmeasuredCameraIds: ["cam-never"],
  },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/* ── the formatters ───────────────────────────────────────────────────────── */

check("a missing size says so, and a measured nothing is still a zero", () => {
  eq(formatBytes(null), "not measured", "null");
  eq(formatBytes(0), "0 B", "a real measurement of nothing keeps its unit");
  eq(formatBytes(999), "999 B", "under a kilobyte");
  eq(formatBytes(112801325), "112.8 MB", "megabytes");
  eq(formatBytes(6375342080), "6.4 GB", "gigabytes");
});

check("a missing bitrate never reads as a camera sending nothing", () => {
  eq(formatKbps(null), "not measured", "null");
  eq(formatKbps(0), "0 kbps", "0 is a measurement: this camera is sending nothing");
  if (formatKbps(null) === formatKbps(0)) {
    throw new Error("unmeasured and zero must not render the same -- that is the whole point");
  }
  eq(formatKbps(171), "171 kbps", "kbps");
  eq(formatKbps(1200), "1.2 Mbps", "megabits carry their own unit");
});

check("a camera that never recorded is never 0 seconds ago", () => {
  eq(formatDuration(null), "never", "null");
  eq(formatDuration(45), "45s", "seconds");
  eq(formatDuration(90), "1m 30s", "minutes and seconds");
  eq(formatDuration(6840), "1h 54m", "hours and minutes");
  eq(formatDuration(172800), "2d 0h", "whole days still print the hours field");
});

check("retention refuses out loud rather than printing a number", () => {
  eq(retentionText(HEALTHY.retention), "5.2 days", "one decimal and the word days");
  const refused = retentionText(UNKNOWNS.retention);
  if (/\d+(\.\d+)?\s*day/.test(refused)) {
    throw new Error(`a refusal must not contain a number of days, got: ${refused}`);
  }
  if (!refused.includes(UNKNOWNS.retention.message)) {
    throw new Error(`the refusal must say why, got: ${refused}`);
  }
  if (!refused.includes("cam-never")) {
    throw new Error(`the refusal must name the camera to go and look at, got: ${refused}`);
  }
});

/* ── rendering ────────────────────────────────────────────────────────────── */

check("a healthy site reads healthy, and says the site's own name", () => {
  const doc = freshDom();
  renderHealth(doc, HEALTHY);
  eq(textOf(doc.byId.overall), "OK", "the verdict chip");
  if (!textOf(doc.byId.cameras).includes("171 kbps")) {
    throw new Error(`the measured bitrate must be on screen, got: ${textOf(doc.byId.cameras)}`);
  }
  if (!textOf(doc.byId.totals).includes("5.2 days")) {
    throw new Error(`retention must be in the totals, got: ${textOf(doc.byId.totals)}`);
  }
});

check("a down site is never painted with the green word", () => {
  const doc = freshDom();
  renderHealth(doc, UNKNOWNS);
  eq(textOf(doc.byId.overall), "DOWN", "the verdict chip follows status, not ok");
});

check("nothing unknown is ever drawn as a zero", () => {
  const doc = freshDom();
  renderHealth(doc, UNKNOWNS);

  const cameras = textOf(doc.byId.cameras);
  if (!cameras.includes("not measured")) {
    throw new Error(`the unmeasured camera must say so, got: ${cameras}`);
  }
  if (!cameras.includes("never")) {
    throw new Error(`a camera that never sealed must say "never", got: ${cameras}`);
  }
  // cam-silent measured a real 0, and that is a different fact.
  if (!cameras.includes("0 kbps")) {
    throw new Error(`a measured 0 must still print as 0 kbps, got: ${cameras}`);
  }

  const stores = textOf(doc.byId.stores);
  if (!stores.includes("not measured")) {
    throw new Error(`an unmeasured store must say so, got: ${stores}`);
  }
  if (/\b0(\.0)?\s*%/.test(stores)) {
    throw new Error(`an unmeasured store must not report a percentage, got: ${stores}`);
  }
});

check("an unmeasured disk draws no bar at all -- an empty bar reads as empty disk", () => {
  const measured = freshDom();
  renderHealth(measured, HEALTHY);
  const barsWhenKnown = measured.byId.stores.descendants()
    .filter((el) => typeof el.style.width === "string" && el.style.width !== "");
  if (barsWhenKnown.length === 0) {
    throw new Error("a measured store must draw a bar, or the gauge is decoration");
  }

  const unmeasured = freshDom();
  renderHealth(unmeasured, UNKNOWNS);
  const barsWhenUnknown = unmeasured.byId.stores.descendants()
    .filter((el) => typeof el.style.width === "string" && el.style.width !== "");
  if (barsWhenUnknown.length !== 0) {
    throw new Error(
      `an unmeasured store drew ${barsWhenUnknown.length} bar(s) at width ` +
      `${barsWhenUnknown.map((b) => b.style.width).join(", ")} -- a 0% bar is a lie`,
    );
  }
});

check("a stopped recorder and an unknown one are not the same sentence", () => {
  const stopped = freshDom();
  renderHealth(stopped, { ...clone(HEALTHY), recorderRunning: false });
  const unknown = freshDom();
  renderHealth(unknown, { ...clone(HEALTHY), recorderRunning: null });
  const a = textOf(stopped.byId.recorder);
  const b = textOf(unknown.byId.recorder);
  if (a === b) throw new Error(`"stopped" and "unknown" rendered identically: ${a}`);
  if (!b.toLowerCase().includes("unknown")) {
    throw new Error(`an unreadable health file must say unknown, got: ${b}`);
  }
});

check("a camera name is text, never markup", () => {
  const doc = freshDom();
  const health = clone(HEALTHY);
  health.cameras[0].cameraId = '<img src=x onerror="boom">';
  renderHealth(doc, health); // the fake DOM throws if innerHTML is touched
  if (!textOf(doc.byId.cameras).includes('<img src=x onerror="boom">')) {
    throw new Error("the name must survive as literal text");
  }
});

check("an empty site renders an empty page, not an exception", () => {
  const doc = freshDom();
  renderHealth(doc, {
    ...clone(HEALTHY),
    cameras: [], stores: [],
    totals: { cameras: 0, recording: 0, unresolved: 0, silent: 0, segments: 0, bytes: 0, measuredKbps: 0, camerasUnmeasured: 0 },
    retention: { kind: "unknown", reason: "no_cameras", message: "no cameras configured", unmeasuredCameraIds: [] },
  });
  eq(doc.byId.cameras.children.length, 0, "no camera rows");
  eq(doc.byId.stores.children.length, 0, "no store rows");
});

check("rendering twice leaves one copy of everything", () => {
  const doc = freshDom();
  renderHealth(doc, HEALTHY);
  const after1 = doc.byId.cameras.children.length;
  renderHealth(doc, HEALTHY);
  eq(doc.byId.cameras.children.length, after1, "camera rows are replaced, not appended");
  renderHealth(doc, UNKNOWNS);
  eq(doc.byId.cameras.children.length, 2, "and the new answer replaces the old one entirely");
});

check("the page does not rewrite what the server said", () => {
  const doc = freshDom();
  const health = clone(HEALTHY);
  renderHealth(doc, health);
  same(health, HEALTHY, "input untouched");
});

/* ── polling ──────────────────────────────────────────────────────────────── */

function fakeTimers() {
  const ticks = [];
  return {
    ticks,
    setIntervalFn: (fn, ms) => { ticks.push({ fn, ms }); return ticks.length; },
    clearIntervalFn: (h) => { ticks[h - 1] = null; },
  };
}
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

await check("the first poll draws the answer, and asks the one endpoint", async () => {
  const doc = freshDom();
  const t = fakeTimers();
  const asked = [];
  const page = startSystemPage({
    doc,
    fetchFn: async (url) => { asked.push(url); return jsonResponse(HEALTHY); },
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  await page.ready;
  eq(asked, ["/health"], "exactly one endpoint, exactly once");
  eq(textOf(doc.byId.overall), "OK", "drawn");
  eq(doc.byId.pollError.hidden, true, "no error to show");
  page.stop();
});

await check("one failed poll leaves the last good answer on screen", async () => {
  const doc = freshDom();
  const t = fakeTimers();
  let broken = false;
  const page = startSystemPage({
    doc,
    fetchFn: async () => {
      if (broken) throw new Error("connection refused");
      return jsonResponse(HEALTHY);
    },
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  await page.ready;
  const drawn = textOf(doc.byId.cameras);

  broken = true;
  await page.poll();
  eq(doc.byId.pollError.hidden, false, "the failure is visible");
  if (textOf(doc.byId.pollError).trim() === "") {
    throw new Error("the error line must say something");
  }
  eq(textOf(doc.byId.cameras), drawn, "the last good answer is still there");
  eq(textOf(doc.byId.overall), "OK", "and the page did not invent a verdict of its own");

  broken = false;
  await page.poll();
  eq(doc.byId.pollError.hidden, true, "a good poll clears the warning");
  page.stop();
});

await check("a 500 and a body that is not JSON are both failures, not blanks", async () => {
  for (const [what, fetchFn] of [
    ["a 500", async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ["bad JSON", async () => ({ ok: true, status: 200, json: async () => { throw new Error("Unexpected token <"); } })],
  ]) {
    const doc = freshDom();
    const t = fakeTimers();
    const page = startSystemPage({ doc, fetchFn, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
    await page.ready;
    eq(doc.byId.pollError.hidden, false, `${what} is reported`);
    eq(textOf(doc.byId.overall), "", `${what} leaves the verdict blank rather than green`);
    page.stop();
  }
});

await check("stop() stops it", async () => {
  const doc = freshDom();
  const t = fakeTimers();
  let calls = 0;
  const page = startSystemPage({
    doc,
    fetchFn: async () => { calls++; return jsonResponse(HEALTHY); },
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  await page.ready;
  eq(calls, 1, "one poll so far");
  const tick = t.ticks[0];
  if (!tick) throw new Error("the page never set an interval, so it polls once and stops");
  eq(tick.ms, 5000, "five seconds");
  page.stop();
  eq(t.ticks[0], null, "the interval is cleared");
});

report("system page");
