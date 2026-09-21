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
const { formatBytes, formatKbps, formatDuration, formatHours, localWhen, retentionText, renderHealth, startSystemPage } = client;

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

// Two cameras, two drives, two different bases -- the actual shape of the
// 2026-09-21 laptop NVR that this contract was written for: cam1-main is a
// floor (its drive is still filling, no full day behind it yet), cam2-sub is
// an estimate (a full day's rate on a drive that also still holds a foreign
// camera's leftovers, being cleared first).
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
    {
      cameraId: "cam2-sub", state: "recording", status: "ok", detail: "sealed 9s ago",
      measuredKbps: 210, segments: 50, bytes: 90000000,
      lastSealedUtc: "2026-09-16T01:02:05.000Z", secondsSinceSealed: 8.638, openSegments: 1,
    },
  ],
  stores: [
    {
      root: "/srv/camplat/disk0", state: "ok", status: "ok",
      totalBytes: 6375342080, freeBytes: 6038941696, usedBytes: 336400384,
      usedFraction: 0.0527,
    },
    {
      root: "/srv/camplat/disk1", state: "full", status: "degraded",
      totalBytes: 4000000000, freeBytes: 90000000, usedBytes: 3910000000,
      usedFraction: 0.9775,
    },
  ],
  totals: {
    cameras: 2, recording: 2, unresolved: 0, silent: 0,
    segments: 126, bytes: 202801325, measuredKbps: 381, camerasUnmeasured: 0,
  },
  retention: {
    kind: "ok",
    hours: 4.3,
    days: 4.3 / 24,
    basis: "at_least",
    limitingCameraId: "cam1-main",
    spaceHours: 4.3,
    spaceBasis: "at_least",
    totalKbps: 381,
    camerasCounted: 2,
    cameras: [
      {
        cameraId: "cam1-main", root: "/srv/camplat/disk0",
        heldFromUtc: "2026-09-15T20:44:00.000Z", heldHours: 4.3, recordedHours: 4.28,
        bytes: 112801325, unattributedBytes: 0,
        space: { ok: true, hours: 4.3, basis: "at_least", note: "at least this much: the drive is still filling" },
        keeps: { ok: true, hours: 4.3, basis: "at_least", note: "at least this much: the drive is still filling" },
      },
      {
        cameraId: "cam2-sub", root: "/srv/camplat/disk1",
        heldFromUtc: "2026-09-11T19:00:00.000Z", heldHours: 105.4, recordedHours: 105.1,
        bytes: 90000000, unattributedBytes: 0,
        space: {
          ok: true, hours: 105.4, basis: "projected",
          note: "estimate from the last full day; footage from cameras no longer configured is being cleared first",
        },
        keeps: {
          ok: true, hours: 105.4, basis: "projected",
          note: "estimate from the last full day; footage from cameras no longer configured is being cleared first",
        },
      },
    ],
    stores: [
      {
        root: "/srv/camplat/disk0", totalBytes: 6375342080, usedBytes: 336400384,
        ringBytes: 5737807872, rollingBytes: 112801325, otherBytes: 0, foreignBytes: 0,
        full: false, oldestUtc: "2026-09-15T20:44:00.000Z", cameraIds: ["cam1-main"],
        bytesPerDay: null, projectedHours: null,
        noProjection: "cam1-main has 4.3 h of history, and a rate needs a full day: night and day record at very different rates",
      },
      {
        root: "/srv/camplat/disk1", totalBytes: 4000000000, usedBytes: 3910000000,
        ringBytes: 3600000000, rollingBytes: 140000000, otherBytes: 40000000, foreignBytes: 50000000,
        full: true, oldestUtc: "2026-09-11T19:00:00.000Z", cameraIds: ["cam2-sub"],
        bytesPerDay: 20520547, projectedHours: 105.4, noProjection: null,
      },
    ],
  },
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
  // cam-never has sealed nothing, so footageHeld refuses it outright: no
  // held-from line is even honest to print. cam-silent DOES have footage
  // (real bytes, a real oldest segment) but its drive never reported a
  // size, so it is refused too, for a different, drive-side reason -- the
  // pairing this harness needs to prove a refused camera never shows a
  // fabricated "0 hours" even when it has a real, non-zero held-from time.
  retention: {
    kind: "unknown", reason: "cameras_unknown",
    message: "cam-never: no recorded footage in the index yet",
    unmeasuredCameraIds: ["cam-never"],
    cameras: [
      {
        cameraId: "cam-never", root: null, heldFromUtc: null, heldHours: null,
        recordedHours: 0, bytes: 0, unattributedBytes: 0,
        space: { ok: false, reason: "nothing_held", message: "no recorded footage in the index yet" },
        keeps: { ok: false, reason: "nothing_held", message: "no recorded footage in the index yet" },
      },
      {
        cameraId: "cam-silent", root: "/srv/camplat/disk9",
        heldFromUtc: "2026-09-11T08:00:00.000Z", heldHours: 4.0, recordedHours: 3.9,
        bytes: 300, unattributedBytes: 0,
        space: { ok: false, reason: "store_unmeasured", message: "its drive /srv/camplat/disk9 did not report its size" },
        keeps: { ok: false, reason: "store_unmeasured", message: "its drive /srv/camplat/disk9 did not report its size" },
      },
    ],
    stores: [
      {
        root: "/srv/camplat/disk9", totalBytes: null, usedBytes: null,
        ringBytes: null, rollingBytes: 300, otherBytes: null, foreignBytes: 0,
        full: null, oldestUtc: "2026-09-11T08:00:00.000Z", cameraIds: ["cam-silent"],
        bytesPerDay: null, projectedHours: null, noProjection: "the drive did not report its size",
      },
    ],
  },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/* ── one RetentionSummary per basis, straight off the task's own examples ──── */

const RETENTION_AT_LEAST = {
  kind: "ok", hours: 4.3, days: 4.3 / 24, basis: "at_least",
  limitingCameraId: "cam1-main", spaceHours: 4.3, spaceBasis: "at_least",
  cameras: [], stores: [], totalKbps: 171, camerasCounted: 1,
};
const RETENTION_PROJECTED = {
  kind: "ok", hours: 31.6, days: 31.6 / 24, basis: "projected",
  limitingCameraId: "cam2-sub", spaceHours: 31.6, spaceBasis: "projected",
  cameras: [], stores: [], totalKbps: 210, camerasCounted: 1,
};
const RETENTION_MEASURED = {
  kind: "ok", hours: 4.1, days: 4.1 / 24, basis: "measured",
  limitingCameraId: "cam1-main", spaceHours: 4.1, spaceBasis: "measured",
  cameras: [], stores: [], totalKbps: 171, camerasCounted: 1,
};
// Kept under 48 h on purpose: at or above 48, formatHours switches to days
// and a keep-for limit of exactly one day (24 h) would never reach the days
// branch at all -- see the formatHours check below for that boundary.
const RETENTION_AGE_LIMIT = {
  kind: "ok", hours: 30, days: 30 / 24, basis: "age_limit",
  limitingCameraId: "cam1-main", spaceHours: 40, spaceBasis: "at_least",
  cameras: [], stores: [], totalKbps: 171, camerasCounted: 1,
};
// An older server that predates contracts/footageHeld.ts: no hours, no
// basis, no per-camera or per-store detail at all -- just the number a
// pre-2026-09-21 build actually sent.
const RETENTION_OLD_SHAPE = { kind: "ok", days: 5.178153086419753, totalKbps: 171, camerasCounted: 1 };

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

check("formatHours switches to days at 48h, so one plain day still reads in hours", () => {
  eq(formatHours(null), "not measured", "null");
  eq(formatHours(4.3), "4.3 hours", "under 48");
  eq(formatHours(24), "24.0 hours", "a whole day is still hours -- that is the point of the 48h cutover");
  eq(formatHours(47.9), "47.9 hours", "just under the cutover");
  eq(formatHours(48), "2.0 days", "at the cutover, days");
  eq(formatHours(105.4), "4.4 days", "well past it");
});

check("retention refuses out loud rather than printing a number", () => {
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

check('an at_least retention always says "at least", never just the number', () => {
  const text = retentionText(RETENTION_AT_LEAST);
  if (!text.includes("at least")) {
    throw new Error(`a floor must say "at least", got: ${text}`);
  }
  eq(text, "at least 4.3 hours", "prefix plus the plain hours");
});

check("a projected retention is labelled an estimate", () => {
  const text = retentionText(RETENTION_PROJECTED);
  if (!text.includes("estimate")) {
    throw new Error(`a modelled figure must say "estimate", got: ${text}`);
  }
  eq(text, "31.6 hours (estimate)", "projected suffix");
});

check("a measured retention says measured", () => {
  const text = retentionText(RETENTION_MEASURED);
  if (!text.includes("measured")) {
    throw new Error(`a full-drive figure must say "measured", got: ${text}`);
  }
  eq(text, "4.1 hours (measured)", "measured suffix");
});

check("an age-limit retention says so, and an old server's {days} shape still renders", () => {
  eq(retentionText(RETENTION_AGE_LIMIT), "30.0 hours (keep-for limit)", "keep-for limit suffix");
  // No hours field at all -- the shape siteHealth() sent before
  // contracts/footageHeld.ts existed. Must not fall through to "not measured".
  eq(retentionText(RETENTION_OLD_SHAPE), "5.2 days", "the pre-existing {kind,days} shape is unaffected");
});

/* ── rendering ────────────────────────────────────────────────────────────── */

check("a healthy site reads healthy, and says the site's own name", () => {
  const doc = freshDom();
  renderHealth(doc, HEALTHY);
  eq(textOf(doc.byId.overall), "OK", "the verdict chip");
  if (!textOf(doc.byId.cameras).includes("171 kbps")) {
    throw new Error(`the measured bitrate must be on screen, got: ${textOf(doc.byId.cameras)}`);
  }
  if (!textOf(doc.byId.totals).includes("at least 4.3 hours")) {
    throw new Error(`retention must be in the totals, got: ${textOf(doc.byId.totals)}`);
  }
});

check("a camera's own retention line names its basis, not just a number", () => {
  const doc = freshDom();
  renderHealth(doc, HEALTHY);
  const cameras = textOf(doc.byId.cameras);
  if (!cameras.includes("footage back to")) {
    throw new Error(`the held-from line must be on screen, got: ${cameras}`);
  }
  if (!cameras.includes("at least 4.3 hours")) {
    throw new Error(`cam1-main's floor must say "at least", got: ${cameras}`);
  }
  if (!cameras.includes("4.4 days (estimate)")) {
    throw new Error(`cam2-sub's projection must say "estimate", got: ${cameras}`);
  }
});

check("a refused camera shows why, and never invents a 0-hour reading", () => {
  const doc = freshDom();
  renderHealth(doc, UNKNOWNS);
  const cameras = textOf(doc.byId.cameras);
  if (!cameras.includes("no recorded footage in the index yet")) {
    throw new Error(`cam-never's refusal sentence must be on screen, got: ${cameras}`);
  }
  if (!cameras.includes("its drive /srv/camplat/disk9 did not report its size")) {
    throw new Error(`cam-silent's refusal sentence must be on screen, got: ${cameras}`);
  }
  // cam-silent DOES have a real, non-zero held-from time -- that line must
  // still show it, refusal or not.
  if (!cameras.includes("footage back to")) {
    throw new Error(`cam-silent's real held-from time must still print, got: ${cameras}`);
  }
  // Anchored so a real "4.0 hours" (cam-silent's actual held time) can never
  // false-positive on its own trailing zero -- only a standalone 0 counts.
  if (/(?<![0-9.])0(?:\.0)?\s*hours?\b/.test(cameras)) {
    throw new Error(`a refused camera must never show a 0-hour reading, got: ${cameras}`);
  }
});

check("a store's fill state and any foreign leftovers are said in words, not a bar", () => {
  const doc = freshDom();
  renderHealth(doc, HEALTHY);
  const stores = textOf(doc.byId.stores);
  if (!stores.includes("still filling")) {
    throw new Error(`disk0, not full, must say so, got: ${stores}`);
  }
  if (!stores.includes("full") || !stores.includes("deleted to make room")) {
    throw new Error(`disk1, full, must say so, got: ${stores}`);
  }
  if (!stores.includes("cameras no longer configured")) {
    throw new Error(`disk1's foreign bytes must be named, got: ${stores}`);
  }

  const unmeasured = freshDom();
  renderHealth(unmeasured, UNKNOWNS);
  const unmeasuredStores = textOf(unmeasured.byId.stores);
  if (unmeasuredStores.includes("still filling") || unmeasuredStores.includes("deleted to make room")) {
    throw new Error(`a store whose fill state is unmeasured (full: null) must say neither, got: ${unmeasuredStores}`);
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

check("footage from before today carries its day, so it never reads as this morning", () => {
  // Built from local times so the check means the same in any time zone.
  const sundayMorning = new Date(2026, 8, 20, 11, 30).toISOString();
  eq(localWhen(sundayMorning, 27.5), "Sun 20 Sep 11:30", "27.5 hours back from Monday 15:00 is Sunday");
  const thisNoon = new Date(2026, 8, 21, 12, 7).toISOString();
  eq(localWhen(thisNoon, 3), "12:07", "the same day keeps the short form");
  eq(localWhen(thisNoon, null), "Mon 21 Sep 12:07", "with no hours to place it, the day is shown rather than assumed");
  eq(localWhen("not a time", 3), "not a time", "an unreadable time is echoed, never 'Invalid Date'");
});

report("system page");
