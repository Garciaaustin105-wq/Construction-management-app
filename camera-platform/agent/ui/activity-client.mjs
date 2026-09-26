// agent/ui/activity-client.mjs
//
// Client logic for the Activity page (agent/ui/activity.html,
// ACTIVITY-PAGE-SPEC.md). Polls GET /activity?range=&tz=&camera= and draws
// headline tiles, the person and vehicle bar charts (agent/ui/activity-
// charts.mjs), the explainer and coverage lines, and wires the camera
// filter, the 24h/7d toggle and the Review deep link.
//
// Same discipline as agent/ui/system-client.mjs: every dependency (the
// document, fetch, the timers, the browser's own time zone) arrives through
// `opts`, never read off a bare global inside an exported function, so a
// harness can drive this without a browser. Nothing here ever sets
// innerHTML -- every node is built with createElement/createTextNode or
// (for the charts) activity-charts.mjs's vnodeToDom, matching this whole
// *-client.mjs family's own house rule.
//
// House rule this file is written against, same as the contracts and charts
// it draws from: a blank is not a zero. "available: false" (no events.db at
// all yet) hides the charts and tiles behind a quiet dim note, never a wall
// of zeroes; a busiest hour of `null` reads "not yet measured", never "--";
// and every count on this page is a "sighting", the word the spec insists
// on -- this file never prints "people", "customers" or "visitors".

import {
  vnodeToDom, buildSightingsSection, wireBarChartHover, safeLabel, localTimeUtc,
} from "./activity-charts.mjs";
import { CHART_COLORS_DARK } from "./health-charts.mjs";

const POLL_MS = 60_000;
const SMALL_MULTIPLES_MODE = "small-multiples";

function byId(doc, id) {
  return typeof doc.getElementById === "function" ? doc.getElementById(id) : null;
}

function clearChildren(el) {
  if (!el) return;
  if (typeof el.replaceChildren === "function") {
    el.replaceChildren();
    return;
  }
  while (el.firstChild) el.removeChild(el.firstChild);
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function two(n) {
  return String(n).padStart(2, "0");
}

/** "HH:MM–HH:MM" (both local) for an hour-shaped bucket's own edges -- the
 *  busiest-hour tile and the small per-bucket captions both want this, not
 *  just the single start time localTimeUtc alone gives a line chart. */
function timeRange(startUtc, endUtc) {
  return `${localTimeUtc(startUtc)}–${localTimeUtc(endUtc)}`;
}

/** "Sep 24" (local), for the 7d chart's day axis and coverage line -- never
 *  reusing localTimeUtc's "HH:MM" for a day-granularity value. */
function localDateUtc(utc) {
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return String(utc);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dateLabelFor(range) {
  return range === "7d" ? localDateUtc : localTimeUtc;
}

/* ── headline tiles ──────────────────────────────────────────────────── */

function tile(doc, label, value, tone) {
  const fig = doc.createElement("div");
  fig.className = "act-tile" + (tone ? " " + tone : "");
  const v = doc.createElement("div");
  v.className = "act-tile-value";
  v.textContent = value;
  const l = doc.createElement("div");
  l.className = "act-tile-label";
  l.textContent = label;
  fig.appendChild(v);
  fig.appendChild(l);
  return fig;
}

/** Renders the three headline tiles (ACTIVITY-PAGE-SPEC.md: "total person
 *  sightings; total vehicle sightings; the busiest hour ... with 'of watched
 *  hours' noted"). A `busiestHour` of null is a real measurement -- "no
 *  bucket was ever actually watched" (contracts/activity.ts's own doc
 *  comment) -- and reads "not yet measured", never a bare "--" or a 0. */
export function renderTiles(doc, envelope) {
  const el = byId(doc, "tiles");
  if (!el) return;
  clearChildren(el);
  const totals = (envelope.totals && typeof envelope.totals === "object") ? envelope.totals : { person: 0, vehicle: 0 };
  el.appendChild(tile(doc, "person sightings", String(totals.person ?? 0)));
  el.appendChild(tile(doc, "vehicle sightings", String(totals.vehicle ?? 0)));
  const bh = envelope.busiestHour;
  if (bh) {
    el.appendChild(tile(doc, "busiest hour (of watched hours)", `${timeRange(bh.startUtc, bh.endUtc)} · ${bh.total}`));
  } else {
    el.appendChild(tile(doc, "busiest hour", "not yet measured", "dim"));
  }
}

/* ── explainer + coverage lines ──────────────────────────────────────── */

export const EXPLAINER_TEXT = "A sighting is one continuous stretch of someone (or a vehicle) in view. "
  + "The same person passing twice counts twice.";

/** "Counts go back to <countsFromUtc> - as far as this NVR keeps video."
 *  (ACTIVITY-PAGE-SPEC.md, verbatim wording). `countsFromUtc: null` (no
 *  events at all yet, or events.db unavailable) gets its own honest line,
 *  never a coverage claim this page cannot back up. */
export function renderCoverage(doc, envelope) {
  const el = byId(doc, "coverage");
  if (!el) return;
  if (!envelope.available) {
    el.textContent = "";
    return;
  }
  if (typeof envelope.countsFromUtc === "string") {
    const at = new Date(envelope.countsFromUtc);
    const when = Number.isNaN(at.getTime())
      ? envelope.countsFromUtc
      : `${localDateUtc(envelope.countsFromUtc)} ${localTimeUtc(envelope.countsFromUtc)}`;
    el.textContent = `Counts go back to ${when} — as far as this NVR keeps video.`;
  } else {
    el.textContent = "No events recorded on this NVR yet.";
  }
}

/* ── unavailable / error states ──────────────────────────────────────── */

function setHidden(doc, id, hidden) {
  const el = byId(doc, id);
  if (el) el.hidden = hidden;
}

function setText(doc, id, text) {
  const el = byId(doc, id);
  if (el) el.textContent = text;
}

/* ── charts ───────────────────────────────────────────────────────────── */

/** Mounts one bar chart's vnode tree and wires its hover layer -- same split
 *  as system-client.mjs's appendChart: the pure vnode build never touches a
 *  DOM, wiring runs once, right after the real element exists. Skipped (not
 *  an error) when the fake DOM a harness supplies has no querySelector --
 *  that harness is proving what got rendered, not live pointer events. */
function appendChart(doc, container, chart) {
  const el = vnodeToDom(doc, chart.vnode);
  container.appendChild(el);
  if (typeof el.querySelector === "function") {
    wireBarChartHover(doc, el);
  }
  return el;
}

function mountSection(doc, containerEl, section) {
  clearChildren(containerEl);
  if (section.charts.length === 0) return;
  if (section.mode === SMALL_MULTIPLES_MODE) {
    const grid = doc.createElement("div");
    grid.className = "act-small-multiples";
    for (const chart of section.charts) appendChart(doc, grid, chart);
    containerEl.appendChild(grid);
  } else {
    appendChart(doc, containerEl, section.charts[0]);
  }
}

/** The Review deep link (ACTIVITY-PAGE-SPEC.md: "clicking a bar opens Review
 *  at that camera and hour" -- "/review?camera=<id>&at=<ISO>"). Delegated
 *  from the container (one listener, not one per bar, so re-rendering the
 *  chart on every poll never leaks listeners). Only a bar carrying a real
 *  camera id navigates -- a combined "all cameras" bar (which activity-
 *  charts.mjs's buildSightingsSection never actually produces, but a future
 *  caller might) has no single camera to open Review on and is silently
 *  ignored rather than guessed at.
 */
export function wireBarClickThrough(doc, containerEl, navigate) {
  if (!containerEl || typeof containerEl.addEventListener !== "function") return;
  containerEl.addEventListener("click", (ev) => {
    const target = typeof ev.target?.closest === "function" ? ev.target.closest(".act-bar") : null;
    if (!target || typeof target.getAttribute !== "function") return;
    const cameraId = target.getAttribute("data-camera-id");
    const atUtc = target.getAttribute("data-t");
    if (!cameraId || !atUtc) return;
    const q = new URLSearchParams({ camera: cameraId, at: atUtc });
    navigate("/review?" + q.toString());
  });
}

/* ── the whole page, one poll at a time ──────────────────────────────── */

function perCameraFromEnvelope(envelope, cameraNames) {
  return (Array.isArray(envelope.perCamera) ? envelope.perCamera : []).map((c) => ({
    cameraId: c.cameraId,
    name: cameraNames.get(c.cameraId) ?? c.cameraId,
    buckets: Array.isArray(c.buckets) ? c.buckets : [],
  }));
}

/** Renders one full GET /activity envelope: tiles, both chart sections and
 *  the coverage line. `cameraNames`: Map<cameraId, displayName>, from the
 *  camera list this page already loaded (so a bar's tooltip/legend/deep
 *  link shows a name, not a bare id, wherever one is configured). */
export function renderActivity(doc, envelope, colors, range, cameraNames) {
  setHidden(doc, "unavailable", envelope.available !== false);
  setHidden(doc, "activityBody", envelope.available === false);
  if (envelope.available === false) {
    return;
  }
  renderTiles(doc, envelope);
  renderCoverage(doc, envelope);

  const perCamera = perCameraFromEnvelope(envelope, cameraNames ?? new Map());
  const dateLabel = dateLabelFor(range);
  const personSection = buildSightingsSection({
    kind: "person", unitLabel: "sightings", title: "Person sightings", perCamera, colors, dateLabel,
  });
  const vehicleSection = buildSightingsSection({
    kind: "vehicle", unitLabel: "sightings", title: "Vehicle sightings", perCamera, colors, dateLabel,
  });

  const personEl = byId(doc, "personCharts");
  if (personEl) mountSection(doc, personEl, personSection);
  const vehicleEl = byId(doc, "vehicleCharts");
  if (vehicleEl) mountSection(doc, vehicleEl, vehicleSection);
}

function browserTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** Populates the camera <select> from GET /cameras, same shape review.html's
 *  own loadCameras() already reads (`[{cameraId, name}]`). Returns the
 *  cameraId -> name Map every chart/tooltip/table on this page reads names
 *  from, so a page that could not reach /cameras at all still shows bare ids
 *  rather than crashing -- a Map that stays empty, not an error. */
export async function loadCameraOptions(doc, fetchFn) {
  const select = byId(doc, "camera");
  const names = new Map();
  let body;
  try {
    const res = await fetchFn("/cameras");
    body = await res.json();
  } catch {
    return names;
  }
  if (!Array.isArray(body)) return names;
  if (select) {
    clearChildren(select);
    const all = doc.createElement("option");
    all.value = "";
    all.textContent = "All cameras";
    select.appendChild(all);
  }
  for (const cam of body) {
    if (typeof cam !== "object" || cam === null || typeof cam.cameraId !== "string") continue;
    const name = (typeof cam.name === "string" && cam.name !== "") ? cam.name : cam.cameraId;
    names.set(cam.cameraId, name);
    if (select) {
      const o = doc.createElement("option");
      o.value = cam.cameraId;
      o.textContent = name;
      select.appendChild(o);
    }
  }
  return names;
}

/** Wires the whole page and starts polling. Every dependency arrives via
 *  `opts` (doc, fetchFn, navigate, the timers, tz) so a harness can drive
 *  this without a browser -- matching system-client.mjs's startSystemPage/
 *  startHistorySection shape exactly. */
export function startActivityPage(opts) {
  const o = (opts && typeof opts === "object") ? opts : {};
  const doc = o.doc;
  const fetchFn = o.fetchFn;
  const colors = o.colors;
  const navigate = typeof o.navigate === "function" ? o.navigate : () => {};
  const tz = typeof o.tz === "string" && o.tz !== "" ? o.tz : browserTz();
  const intervalMs = isNum(o.intervalMs) && o.intervalMs > 0 ? o.intervalMs : POLL_MS;
  const setIntervalFn = typeof o.setIntervalFn === "function"
    ? o.setIntervalFn
    : (typeof setInterval === "function" ? setInterval : null);
  const clearIntervalFn = typeof o.clearIntervalFn === "function"
    ? o.clearIntervalFn
    : (typeof clearInterval === "function" ? clearInterval : null);

  let range = "24h";
  let camera = "";
  let cameraNames = new Map();
  let timer = null;

  async function poll() {
    if (typeof fetchFn !== "function") return;
    const q = new URLSearchParams({ range, tz });
    if (camera !== "") q.set("camera", camera);
    let body;
    let reached = true;
    try {
      const res = await fetchFn("/activity?" + q.toString());
      body = await res.json();
      if (!res.ok || body?.ok === false) {
        setHidden(doc, "pageError", false);
        setText(doc, "pageError", typeof body?.message === "string" ? body.message : "The recorder refused that request.");
        setHidden(doc, "activityBody", true);
        setHidden(doc, "unavailable", true);
        return;
      }
    } catch {
      reached = false;
    }
    if (!reached) {
      setHidden(doc, "pageError", false);
      setText(doc, "pageError", "Cannot reach the recorder.");
      setHidden(doc, "activityBody", true);
      setHidden(doc, "unavailable", true);
      return;
    }
    setHidden(doc, "pageError", true);
    renderActivity(doc, body, colors, range, cameraNames);
  }

  function setRange(nextRange) {
    if (nextRange !== "24h" && nextRange !== "7d") return;
    range = nextRange;
    const buttons = typeof doc.querySelectorAll === "function" ? doc.querySelectorAll(".act-range-btn") : [];
    for (const btn of buttons) {
      if (typeof btn.setAttribute === "function") {
        btn.setAttribute("aria-pressed", btn.getAttribute("data-range") === range ? "true" : "false");
      }
    }
    poll();
  }

  const rangeButtons = typeof doc.querySelectorAll === "function" ? doc.querySelectorAll(".act-range-btn") : [];
  for (const btn of rangeButtons) {
    if (typeof btn.addEventListener === "function") {
      btn.addEventListener("click", () => setRange(btn.getAttribute ? btn.getAttribute("data-range") : null));
    }
  }

  const cameraSelect = byId(doc, "camera");
  if (cameraSelect && typeof cameraSelect.addEventListener === "function") {
    cameraSelect.addEventListener("change", () => {
      camera = cameraSelect.value || "";
      poll();
    });
  }

  for (const id of ["personCharts", "vehicleCharts"]) {
    wireBarClickThrough(doc, byId(doc, id), navigate);
  }

  const ready = (async () => {
    cameraNames = await loadCameraOptions(doc, fetchFn);
    await poll();
  })();
  if (setIntervalFn) {
    timer = setIntervalFn(poll, intervalMs);
  }

  return {
    ready,
    poll,
    setRange,
    getRange: () => range,
    stop: function () {
      if (timer !== null && typeof clearIntervalFn === "function") clearIntervalFn(timer);
      timer = null;
    },
  };
}

export { safeLabel };

// Browser bootstrap. Found 2026-09-26, before the page ever ran on a box:
// without it the real Activity page drew its chrome and never fetched a
// thing - every harness drives startActivityPage directly, so none noticed.
// Runs only when the real page is in the DOM; a harness importing this
// module has no side effects. Pinned to the dark palette like every other
// page on this NVR (activity.html sets data-theme="dark" to match).
if (typeof document !== "undefined" &&
    typeof document.getElementById === "function" &&
    document.getElementById("activityBody")) {
  startActivityPage({
    doc: document,
    fetchFn: function (url, init) {
      return fetch(url, init);
    },
    colors: CHART_COLORS_DARK,
    navigate: function (url) {
      window.location.assign(url);
    },
  });
}
