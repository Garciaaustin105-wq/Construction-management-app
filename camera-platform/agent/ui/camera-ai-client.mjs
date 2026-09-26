// agent/ui/camera-ai-client.mjs
//
// Client logic for the Cameras page's "AI settings" panel
// (CAMERA-AI-SETTINGS-SPEC.md): one panel per camera, holding the zone
// editor, the schedule, sensitivity and the person/vehicle kinds, wired to
// GET /camera-ai-settings and POST /camera-ai-settings/<cameraId>.
//
// Same discipline as agent/ui/activity-client.mjs and agent/ui/cameras-
// client.mjs: every dependency (the document, fetch, the clock) arrives
// through `opts`, never read off a bare global inside an exported function,
// so a harness can drive this without a browser. Nothing here ever sets
// innerHTML -- every node is built with createElement/createElementNS, and
// every piece of untrusted text (a camera's own name) is set with
// .textContent, never innerHTML (a name is data the installer typed, not
// markup this page should ever parse).
//
// Deliberately its OWN file, not folded into cameras-client.mjs: one owner
// per file (AGENTS.md build rule 3) -- cameras-client.mjs already owns the
// add/edit/remove camera form and the camera login form; this file owns only
// the AI settings panel, and reads its own camera list from GET
// /camera-settings rather than reaching into that other module's state.
//
// THE FEARED FAILURES this file is written against:
// - a blank read as a zero (build rule 5): "no zones" must stay "the whole
//   frame is watched" in the state this file builds, never an empty zone
//   list rendered as "nothing watched"; "always" schedule must stay
//   "always", not an accidental always-closed week; "site default"
//   sensitivity must show the site's own floor, never 0.
// - a stored value silently coerced by the page into something the
//   installer never chose: if the site's storing floor was raised after a
//   camera's custom minConfidence was saved, that value is shown exactly as
//   stored (never snapped to the nearest legal option), so a save either
//   keeps it (still legal) or the server's own "below_storing_floor" error
//   tells the installer why, instead of this page quietly picking a
//   different number for them.
// - camera-page-bootstrap-lesson (agent bus, 2026-09-26): a client with no
//   browser bootstrap block passes every harness check that drives its
//   exported functions directly while the real page never fetches anything.
//   See the bottom of this file, and harness/cameraAiPage.harness.mjs's own
//   copy of activityPage.harness.mjs's THE FEARED ONE check.

const SVG_NS = "http://www.w3.org/2000/svg";

/* ── constants mirrored from contracts/cameraAiSettings.ts ──────────────
   (that file compiles to CommonJS -- see dist/tsconfig's "module":
   "NodeNext" -- so it cannot be imported by a browser the way
   dist/gridLayout.mjs and dist/playback.mjs are, both of which are .mts
   compiled as ES modules for exactly this reason. These numbers are the
   contract's own source of truth; contracts/cameraAiSettings.ts is where a
   change to them belongs, and harness/cameraAiPage.harness.mjs checks these
   copies still match it.) ------------------------------------------------ */
export const AI_MIN_CONFIDENCE = 0.3;
export const AI_MAX_CONFIDENCE = 0.9;
export const AI_CONFIDENCE_STEP = 0.05;
export const AI_MAX_ZONES = 8;
export const AI_MIN_ZONE_POINTS = 3;
export const AI_MAX_ZONE_POINTS = 32;

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const POLL_MS = 30_000;

/* ── pure helpers (no document, no fetch) ────────────────────────────── */

/** Clamp to 0..1 and round to 4 places -- "points ... rounded to 4 places". */
export function roundFraction(v) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  const c = n < 0 ? 0 : n > 1 ? 1 : n;
  return Math.round(c * 10000) / 10000;
}

/**
 * Where a pointer (mouse click or touch tap -- both arrive as
 * clientX/clientY) landed on the still, as a frame fraction, clamped to
 * 0..1. `rect` is the still's own bounding box ({ left, top, width, height
 * }), the same shape Element.getBoundingClientRect() returns.
 */
export function pointerFraction(clientX, clientY, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 };
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  return { x: roundFraction(x), y: roundFraction(y) };
}

/** The first unused "z1".."z<AI_MAX_ZONES>" id, or null when all are taken. */
export function nextZoneId(existingZones) {
  const used = new Set((existingZones || []).map((z) => z.id));
  for (let n = 1; n <= AI_MAX_ZONES; n++) {
    const id = `z${n}`;
    if (!used.has(id)) return id;
  }
  return null;
}

/**
 * The legal 0.30..0.90-step-0.05 values at or above `floor`. `floor` above
 * AI_MAX_CONFIDENCE means no custom value is legal at all (every camera on
 * this site must use "site default" until the floor comes back down) --
 * refused, not guessed at: the caller shows that as a disabled custom
 * option, never a silently-adjusted number.
 */
export function confidenceOptions(floor) {
  if (typeof floor !== "number" || !Number.isFinite(floor)) return [];
  const out = [];
  for (let n = 0; ; n++) {
    const v = Math.round((AI_MIN_CONFIDENCE + n * AI_CONFIDENCE_STEP) * 1e6) / 1e6;
    if (v > AI_MAX_CONFIDENCE + 1e-9) break;
    if (v >= floor - 1e-9) out.push(v);
  }
  return out;
}

/**
 * `confidenceOptions(floor)`, but a currently-stored custom value is always
 * included even if it no longer lands on that list (the floor moved after
 * this camera's value was saved) -- see the file header's "a stored value
 * silently coerced" note. The stored value is never re-sorted to the front;
 * it is inserted in its numeric place so the dropdown still reads low-to-high.
 */
export function confidenceOptionsWithStored(floor, stored) {
  const options = confidenceOptions(floor);
  if (typeof stored !== "number" || !Number.isFinite(stored)) return options;
  if (options.some((v) => Math.abs(v - stored) < 1e-9)) return options;
  const withStored = [...options, stored];
  withStored.sort((a, b) => a - b);
  return withStored;
}

function minutesFromHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function hhmmFromMinutes(mins) {
  if (typeof mins !== "number" || !Number.isFinite(mins)) return "08:00";
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** One weekday's default panel state: closed, with placeholder hours ready
 *  for when the installer switches it on. */
function defaultWeekday() {
  return { open: false, from: "08:00", to: "18:00" };
}

/** A fresh panel's state for a camera with no saved settings yet -- "the
 *  behaviour before this feature existed" (build rule 5): whole frame,
 *  always watching, site default sensitivity, both kinds. */
export function defaultPanelState(cameraId, name) {
  return {
    cameraId,
    name: typeof name === "string" && name !== "" ? name : cameraId,
    zones: [],
    scheduleMode: "always",
    weekly: [0, 1, 2, 3, 4, 5, 6].map(defaultWeekday),
    minConfidenceMode: "default",
    minConfidenceValue: null,
    kinds: { person: true, vehicle: true },
  };
}

/**
 * Panel state built from the server's own CameraAiSettings (whatever GET
 * /camera-ai-settings returned for this camera -- the defaults when it has
 * never been saved, exactly matching defaultPanelState above field for
 * field, so loading a never-configured camera changes nothing on screen).
 */
export function stateFromSettings(cameraId, name, settings, floor) {
  const state = defaultPanelState(cameraId, name);
  if (!settings || typeof settings !== "object") return state;
  if (Array.isArray(settings.zones)) {
    state.zones = settings.zones.map((z) => ({
      id: String(z.id),
      mode: z.mode === "ignore" ? "ignore" : "watch",
      points: Array.isArray(z.points) ? z.points.map(([x, y]) => [roundFraction(x), roundFraction(y)]) : [],
    }));
  }
  if (settings.schedule && typeof settings.schedule === "object") {
    state.scheduleMode = "custom";
    const weekly = Array.isArray(settings.schedule.weekly) ? settings.schedule.weekly : [];
    state.weekly = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      // Only the day's FIRST interval is shown and editable -- this panel
      // never creates more than one, so a second interval could only come
      // from outside this page; see the file header on not inventing a
      // multi-range editor this round.
      const day = weekly[i];
      if (!Array.isArray(day) || day.length === 0) return defaultWeekday();
      const iv = day[0];
      return { open: true, from: hhmmFromMinutes(iv && iv.open), to: hhmmFromMinutes(iv && iv.close) };
    });
  }
  if (typeof settings.minConfidence === "number") {
    state.minConfidenceMode = "custom";
    state.minConfidenceValue = settings.minConfidence;
  }
  if (settings.kinds && typeof settings.kinds === "object") {
    state.kinds = {
      person: settings.kinds.person !== false,
      vehicle: settings.kinds.vehicle !== false,
    };
  }
  void floor; // accepted for symmetry with confidenceOptionsWithStored's own call site
  return state;
}

/**
 * The POST body's shape (a bare CameraAiSettings): "absent fields validate
 * as defaults", but this page always sends every field it knows, in the
 * exact shape checkCameraAiSettings reads.
 */
export function settingsBodyFromState(state, timeZone) {
  return {
    zones: state.zones.map((z) => ({
      id: z.id,
      mode: z.mode,
      points: z.points.map(([x, y]) => [roundFraction(x), roundFraction(y)]),
    })),
    schedule:
      state.scheduleMode === "always"
        ? null
        : {
            timeZone,
            weekly: state.weekly.map((day) => {
              if (!day.open) return [];
              const open = minutesFromHHMM(day.from);
              const close = minutesFromHHMM(day.to);
              // Both null (unparseable) as well as open === close are left
              // for the server to name plainly (bad_hours) rather than
              // guessed at here -- but a day whose times could not even be
              // read at all is sent as closed, never as a fabricated 0..0
              // interval a reader might mistake for a real one.
              if (open === null || close === null) return [];
              return [{ open, close }];
            }),
            closedDates: [],
          },
    minConfidence: state.minConfidenceMode === "default" ? null : state.minConfidenceValue,
    kinds: { person: Boolean(state.kinds.person), vehicle: Boolean(state.kinds.vehicle) },
  };
}

const REASON_TEXT = {
  not_an_array: "must be a list",
  too_many_zones: `no more than ${AI_MAX_ZONES} zones`,
  not_an_object: "must be an object",
  bad_zone_id: "needs an id",
  duplicate_zone_id: "two zones share an id",
  bad_zone_mode: "must be Watch or Ignore",
  bad_zone_point_count: `needs ${AI_MIN_ZONE_POINTS} to ${AI_MAX_ZONE_POINTS} points`,
  bad_zone_point: "has a point outside the picture",
  bad_time_zone: "the time zone is not valid",
  bad_hours: "each open day needs a from time different from its to time",
  bad_closed_date: "a closed date is not valid",
  bad_confidence: "must be a number",
  bad_confidence_range: `must be from ${AI_MIN_CONFIDENCE} to ${AI_MAX_CONFIDENCE}`,
  bad_confidence_step: `must land on a ${AI_CONFIDENCE_STEP} step`,
  below_storing_floor: "cannot be set below the site's storing floor",
  unknown_field: "has a field this page does not know",
  bad_kind_flag: "must be on or off",
  not_an_object_camera: "must be an object",
};

/** Plain text for a FieldProblem.reason -- never the raw code, on a page an
 *  installer (not a developer) reads. */
export function describeReason(reason) {
  return REASON_TEXT[reason] || String(reason);
}

/**
 * Every problem the server listed, grouped by the top-level field a
 * matching input exists for ("minConfidence", "kinds.person",
 * "kinds.vehicle", "schedule") plus a "zones" bucket for every zones[...]
 * field (no single zone input to point at once a zone is already drawn), so
 * the panel can flag the right section AND still show every message, not
 * just the first (rule: "no fix-and-resave one field at a time").
 */
export function fieldErrorMap(errors) {
  const groups = { zones: [], schedule: [], minConfidence: [], kinds: [], other: [] };
  for (const e of Array.isArray(errors) ? errors : []) {
    const field = String(e && e.field);
    const reason = describeReason(e && e.reason);
    const line = `${field}: ${reason}`;
    if (field === "zones" || field.startsWith("zones[")) groups.zones.push(line);
    else if (field === "schedule") groups.schedule.push(line);
    else if (field === "minConfidence") groups.minConfidence.push(line);
    else if (field === "kinds" || field.startsWith("kinds.")) groups.kinds.push(line);
    else groups.other.push(line);
  }
  return groups;
}

/* ── DOM helpers -- never innerHTML ──────────────────────────────────── */

function el(doc, tag, attrs, kids) {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids || []) {
    if (kid !== null && kid !== undefined) node.append(kid);
  }
  return node;
}

function svgEl(doc, tag, attrs) {
  const node = doc.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  }
  return node;
}

function clearChildren(node) {
  if (!node) return;
  if (typeof node.replaceChildren === "function") node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

function fmtConfidence(v) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "?";
}

/* ── one camera's panel ──────────────────────────────────────────────── */

function buildZonePolygon(doc, zone, hatchId) {
  const pointsAttr = zone.points.map(([x, y]) => `${x},${y}`).join(" ");
  const isIgnore = zone.mode === "ignore";
  return svgEl(doc, "polygon", {
    points: pointsAttr,
    fill: isIgnore ? `url(#${hatchId})` : "rgba(76,139,245,0.28)",
    stroke: isIgnore ? "#ffb4b4" : "#4c8bf5",
    "stroke-width": 0.004,
    "stroke-dasharray": isIgnore ? "0.01 0.008" : "none",
  });
}

/** One camera's whole "AI settings" panel: the zone editor, schedule,
 *  sensitivity, kinds, save button and its errors, and the two spec notes.
 *  `fetchFn`/`imgSrc` are injected so a harness never touches a network or a
 *  real image. Exported (only startCameraAiPage called it before) so a
 *  harness can build one panel against a minimal fake `doc` and check where
 *  a save error actually lands in the tree, without a real browser. */
export function createCameraPanel(doc, opts, camera) {
  const { fetchFn, now, log } = opts;
  const cameraId = camera.cameraId;
  const hatchId = `ai-hatch-${cameraId}`.replace(/[^a-zA-Z0-9_-]/g, "_");

  let state = defaultPanelState(cameraId, camera.name);
  let floor = null;
  let timeZone = "UTC";
  let draft = null; // { mode: "watch" | "ignore", points: [] } while drawing

  const root = el(doc, "details", { class: "ai-panel panel" }, []);
  const summary = el(doc, "summary", {}, []);
  const summaryName = el(doc, "strong", {});
  // Untrusted text (the camera's own name): .textContent, never innerHTML.
  summaryName.textContent = state.name;
  summary.append(summaryName, el(doc, "span", { class: "dim", text: " — AI settings" }));
  root.append(summary);

  const body = el(doc, "div", { class: "ai-body" }, []);
  root.append(body);

  const stillStatus = el(doc, "p", { class: "dim ai-still-status", text: "Loading a still…" });
  const stillWrap = el(doc, "div", { class: "ai-still-wrap" }, []);
  const stillImg = el(doc, "img", { class: "ai-still", alt: "" });
  const overlay = svgEl(doc, "svg", { class: "ai-overlay", viewBox: "0 0 1 1", preserveAspectRatio: "none" });
  const defs = svgEl(doc, "defs", {});
  const pattern = svgEl(doc, "pattern", {
    id: hatchId, width: 0.04, height: 0.04, patternUnits: "objectBoundingBox", patternTransform: "rotate(45)",
  });
  pattern.append(svgEl(doc, "rect", { width: 0.04, height: 0.04, fill: "rgba(90,35,35,0.35)" }));
  pattern.append(svgEl(doc, "rect", { width: 0.018, height: 0.04, fill: "rgba(255,180,180,0.55)" }));
  defs.append(pattern);
  overlay.append(defs);
  stillWrap.append(stillImg, overlay);
  body.append(stillWrap, stillStatus);

  if (typeof stillImg.addEventListener === "function") {
    stillImg.addEventListener("load", () => {
      stillStatus.textContent = "";
    });
    stillImg.addEventListener("error", () => {
      stillStatus.textContent = "No recent still is available yet for this camera.";
    });
  }

  // Zone editor controls.
  const modeSelect = el(doc, "select", { class: "ai-zone-mode" }, [
    el(doc, "option", { value: "watch", text: "Watch" }),
    el(doc, "option", { value: "ignore", text: "Ignore" }),
  ]);
  const startBtn = el(doc, "button", { type: "button", class: "ai-zone-start", text: "Start zone" });
  const closeBtn = el(doc, "button", { type: "button", class: "ai-zone-close", text: "Close zone", disabled: true });
  const cancelBtn = el(doc, "button", { type: "button", class: "ai-zone-cancel", text: "Cancel", disabled: true });
  const zoneHint = el(doc, "span", { class: "dim ai-zone-hint", text: "" });
  const zoneControls = el(doc, "div", { class: "row" }, [
    el(doc, "label", { text: "Draw a" }, []),
    modeSelect, startBtn, closeBtn, cancelBtn, zoneHint,
  ]);
  body.append(zoneControls);

  const legend = el(doc, "div", { class: "ai-zone-legend row" }, [
    el(doc, "span", { class: "ai-legend-swatch ai-legend-watch" }),
    el(doc, "span", { text: "Watch" }),
    el(doc, "span", { class: "ai-legend-swatch ai-legend-ignore" }),
    el(doc, "span", { text: "Ignore (hatched)" }),
  ]);
  body.append(legend);

  const zoneList = el(doc, "ul", { class: "ai-zone-list" }, []);
  body.append(zoneList);
  // A zone problem ("zones[0].mode: ...") belongs right here, next to the
  // zone editor it describes -- not in one combined block down by Save,
  // where an installer scrolling a fully-expanded panel would have to find
  // it, remember it, then scroll back up to fix it.
  const zoneErrorsEl = el(doc, "div", { class: "ai-errors error", role: "alert" }, []);
  body.append(zoneErrorsEl);

  function renderOverlay() {
    // Rebuild every polygon, plus the in-progress draft line -- zones are
    // few (at most AI_MAX_ZONES) so a full rebuild on every change is
    // simpler than patching, and this is not a hot path.
    clearChildren(overlay);
    overlay.append(defs);
    for (const z of state.zones) overlay.append(buildZonePolygon(doc, z, hatchId));
    if (draft && draft.points.length > 0) {
      const pts = draft.points.map(([x, y]) => `${x},${y}`).join(" ");
      overlay.append(svgEl(doc, "polyline", {
        points: pts, fill: "none",
        stroke: draft.mode === "ignore" ? "#ffb4b4" : "#4c8bf5",
        "stroke-width": 0.004, "stroke-dasharray": "0.008 0.006",
      }));
      for (const [x, y] of draft.points) {
        overlay.append(svgEl(doc, "circle", { cx: x, cy: y, r: 0.006, fill: "#fff" }));
      }
    }
  }

  function renderZoneList() {
    clearChildren(zoneList);
    if (state.zones.length === 0) {
      const empty = el(doc, "li", { class: "dim", text: "No zones — the whole frame is watched." });
      zoneList.append(empty);
    }
    for (const z of state.zones) {
      const label = el(doc, "span", { text: `${z.id}: ${z.mode === "ignore" ? "Ignore" : "Watch"} (${z.points.length} points)` });
      const del = el(doc, "button", { type: "button", class: "danger", text: "Delete" });
      del.addEventListener("click", () => {
        state.zones = state.zones.filter((zz) => zz.id !== z.id);
        renderZoneList();
        renderOverlay();
      });
      zoneList.append(el(doc, "li", {}, [label, del]));
    }
  }

  function updateZoneButtons() {
    startBtn.disabled = draft !== null || state.zones.length >= AI_MAX_ZONES;
    closeBtn.disabled = draft === null || draft.points.length < AI_MIN_ZONE_POINTS;
    cancelBtn.disabled = draft === null;
    modeSelect.disabled = draft !== null;
    if (draft === null && state.zones.length >= AI_MAX_ZONES) {
      zoneHint.textContent = `Up to ${AI_MAX_ZONES} zones.`;
    } else if (draft) {
      zoneHint.textContent = `${draft.points.length}/${AI_MAX_ZONE_POINTS} points — tap the still to add more, then Close zone.`;
    } else {
      zoneHint.textContent = "";
    }
  }

  startBtn.addEventListener("click", () => {
    if (state.zones.length >= AI_MAX_ZONES) return;
    draft = { mode: modeSelect.value === "ignore" ? "ignore" : "watch", points: [] };
    updateZoneButtons();
    renderOverlay();
  });
  cancelBtn.addEventListener("click", () => {
    draft = null;
    updateZoneButtons();
    renderOverlay();
  });
  closeBtn.addEventListener("click", () => {
    if (!draft || draft.points.length < AI_MIN_ZONE_POINTS) return;
    const id = nextZoneId(state.zones);
    if (id !== null) {
      state.zones.push({ id, mode: draft.mode, points: draft.points });
    }
    draft = null;
    updateZoneButtons();
    renderZoneList();
    renderOverlay();
  });

  // Pointer events on the still itself -- fires for mouse clicks AND touch
  // taps alike ("works with mouse and touch"), unlike click-only handling on
  // some browsers for a bare <img>.
  stillWrap.addEventListener("pointerdown", (ev) => {
    if (!draft || draft.points.length >= AI_MAX_ZONE_POINTS) return;
    const rect = typeof stillWrap.getBoundingClientRect === "function" ? stillWrap.getBoundingClientRect() : null;
    const frac = pointerFraction(ev.clientX, ev.clientY, rect);
    draft.points.push([frac.x, frac.y]);
    updateZoneButtons();
    renderOverlay();
  });

  // Schedule.
  const scheduleAlways = el(doc, "input", { type: "radio", name: `sched-${cameraId}`, value: "always" });
  const scheduleCustom = el(doc, "input", { type: "radio", name: `sched-${cameraId}`, value: "custom" });
  const scheduleRow = el(doc, "div", { class: "row" }, [
    el(doc, "label", {}, [scheduleAlways, el(doc, "span", { text: "Always" })]),
    el(doc, "label", {}, [scheduleCustom, el(doc, "span", { text: "Per weekday" })]),
  ]);
  const timeZoneNote = el(doc, "p", { class: "dim ai-timezone" });
  const weekRows = el(doc, "div", { class: "ai-week" }, []);
  const dayInputs = [];
  for (let i = 0; i < 7; i++) {
    const dayOpen = el(doc, "input", { type: "checkbox" });
    const dayFrom = el(doc, "input", { type: "time" });
    const dayTo = el(doc, "input", { type: "time" });
    dayInputs.push({ open: dayOpen, from: dayFrom, to: dayTo });
    const dayName = el(doc, "span", { text: DAY_NAMES[i] });
    const row = el(doc, "div", { class: "row ai-week-row" }, [
      el(doc, "label", {}, [dayOpen, dayName]),
      el(doc, "label", { text: "from" }, [dayFrom]),
      el(doc, "label", { text: "to" }, [dayTo]),
    ]);
    weekRows.append(row);
  }
  const scheduleErrorsEl = el(doc, "div", { class: "ai-errors error", role: "alert" }, []);
  const scheduleFieldset = el(doc, "fieldset", { class: "ai-schedule" }, [
    el(doc, "legend", { text: "Schedule" }),
    scheduleRow, timeZoneNote, weekRows, scheduleErrorsEl,
  ]);
  body.append(scheduleFieldset);

  function syncScheduleVisibility() {
    weekRows.hidden = state.scheduleMode !== "custom";
    for (const d of dayInputs) {
      d.from.disabled = !d.open.checked;
      d.to.disabled = !d.open.checked;
    }
  }
  scheduleAlways.addEventListener("change", () => {
    if (scheduleAlways.checked) { state.scheduleMode = "always"; syncScheduleVisibility(); }
  });
  scheduleCustom.addEventListener("change", () => {
    if (scheduleCustom.checked) { state.scheduleMode = "custom"; syncScheduleVisibility(); }
  });
  for (const d of dayInputs) {
    d.open.addEventListener("change", syncScheduleVisibility);
  }

  // Sensitivity.
  const sensDefault = el(doc, "input", { type: "radio", name: `sens-${cameraId}`, value: "default" });
  const sensCustom = el(doc, "input", { type: "radio", name: `sens-${cameraId}`, value: "custom" });
  const sensDefaultLabel = el(doc, "span", { text: "Site default" });
  const sensSelect = el(doc, "select", { class: "ai-sensitivity-select" }, []);
  const sensitivityErrorsEl = el(doc, "div", { class: "ai-errors error", role: "alert" }, []);
  const sensitivityFieldset = el(doc, "fieldset", { class: "ai-sensitivity" }, [
    el(doc, "legend", { text: "Sensitivity" }),
    el(doc, "div", { class: "row" }, [
      el(doc, "label", {}, [sensDefault, sensDefaultLabel]),
      el(doc, "label", {}, [sensCustom, el(doc, "span", { text: "Custom" }), sensSelect]),
    ]),
    sensitivityErrorsEl,
  ]);
  body.append(sensitivityFieldset);

  function renderSensitivityOptions() {
    clearChildren(sensSelect);
    const options = confidenceOptionsWithStored(floor, state.minConfidenceValue);
    for (const v of options) {
      sensSelect.append(el(doc, "option", { value: String(v), text: v.toFixed(2) }));
    }
    const noCustom = options.length === 0;
    sensCustom.disabled = noCustom;
    sensSelect.disabled = noCustom || state.minConfidenceMode !== "custom";
    sensDefaultLabel.textContent = `Site default (${floor === null ? "unknown" : fmtConfidence(floor)})`;
    if (noCustom && state.minConfidenceMode === "custom") {
      // The floor rose above every legal custom value since this was saved:
      // fall back to showing "default" selected rather than a disabled,
      // unselectable custom radio with nothing to pick -- the stored value
      // itself is untouched until Save is pressed again.
      sensDefault.checked = true;
    }
  }
  sensDefault.addEventListener("change", () => {
    if (sensDefault.checked) { state.minConfidenceMode = "default"; sensSelect.disabled = true; }
  });
  sensCustom.addEventListener("change", () => {
    if (sensCustom.checked) {
      state.minConfidenceMode = "custom";
      sensSelect.disabled = false;
      if (sensSelect.value) state.minConfidenceValue = Number(sensSelect.value);
    }
  });
  sensSelect.addEventListener("change", () => {
    state.minConfidenceValue = Number(sensSelect.value);
  });

  // Kinds.
  const personBox = el(doc, "input", { type: "checkbox" });
  const vehicleBox = el(doc, "input", { type: "checkbox" });
  const kindsErrorsEl = el(doc, "div", { class: "ai-errors error", role: "alert" }, []);
  const kindsFieldset = el(doc, "fieldset", { class: "ai-kinds" }, [
    el(doc, "legend", { text: "Kinds" }),
    el(doc, "div", { class: "row" }, [
      el(doc, "label", {}, [personBox, el(doc, "span", { text: "Person" })]),
      el(doc, "label", {}, [vehicleBox, el(doc, "span", { text: "Vehicle" })]),
    ]),
    kindsErrorsEl,
  ]);
  body.append(kindsFieldset);
  personBox.addEventListener("change", () => { state.kinds.person = personBox.checked; });
  vehicleBox.addEventListener("change", () => { state.kinds.vehicle = vehicleBox.checked; });

  // Errors + save.
  const errorsEl = el(doc, "div", { class: "ai-errors error", role: "alert" }, []);
  const saveBtn = el(doc, "button", { type: "button", class: "ai-save", text: "Save" });
  const saveStatus = el(doc, "span", { class: "ai-save-status dim" });
  body.append(errorsEl, el(doc, "div", { class: "row" }, [saveBtn, saveStatus]));
  body.append(el(doc, "p", { class: "dim", text: "Settings apply to new detections from now on. Earlier events are not re-judged." }));
  body.append(el(doc, "p", { class: "dim", text: "Outside the schedule the AI is not watching this camera. CPU use is unchanged for now." }));

  /** Fills one section's own error slot with its own lines, or leaves it
   *  empty (and so hidden - .ai-errors:empty) when that section has none. */
  function renderErrorGroup(slotEl, lines, heading) {
    clearChildren(slotEl);
    if (lines.length === 0) return;
    const list = el(doc, "ul", {}, []);
    for (const line of lines) list.append(el(doc, "li", { text: line }));
    slotEl.append(el(doc, "p", { text: heading }), list);
  }

  // Each fieldset gets its OWN slot next to it (zoneErrorsEl,
  // scheduleErrorsEl, sensitivityErrorsEl, kindsErrorsEl above) so an
  // installer sees a zone problem by the zone editor, not several scrolls
  // away by Save - matching fieldErrorMap's own doc comment ("so the panel
  // can flag the right section"). Only "other" - a problem with no matching
  // section - still lands in the bottom block by Save.
  function renderErrors(errors) {
    const groups = fieldErrorMap(errors);
    renderErrorGroup(zoneErrorsEl, groups.zones, "Zone problems:");
    renderErrorGroup(scheduleErrorsEl, groups.schedule, "Schedule problems:");
    renderErrorGroup(sensitivityErrorsEl, groups.minConfidence, "Sensitivity problems:");
    renderErrorGroup(kindsErrorsEl, groups.kinds, "Kinds problems:");
    renderErrorGroup(errorsEl, groups.other, "These settings could not be saved:");
  }

  function applyStateToForm() {
    summaryName.textContent = state.name;
    (state.scheduleMode === "custom" ? scheduleCustom : scheduleAlways).checked = true;
    for (let i = 0; i < 7; i++) {
      dayInputs[i].open.checked = state.weekly[i].open;
      dayInputs[i].from.value = state.weekly[i].from;
      dayInputs[i].to.value = state.weekly[i].to;
    }
    syncScheduleVisibility();
    (state.minConfidenceMode === "custom" ? sensCustom : sensDefault).checked = true;
    renderSensitivityOptions();
    if (state.minConfidenceMode === "custom" && state.minConfidenceValue !== null) {
      sensSelect.value = String(state.minConfidenceValue);
    }
    personBox.checked = state.kinds.person;
    vehicleBox.checked = state.kinds.vehicle;
    renderZoneList();
    renderOverlay();
    updateZoneButtons();
  }

  function loadStill() {
    const atIso = new Date(now() - 90_000).toISOString();
    stillStatus.textContent = "Loading a still…";
    stillImg.src = `/still?camera=${encodeURIComponent(cameraId)}&at=${encodeURIComponent(atIso)}`;
  }

  async function save() {
    saveBtn.disabled = true;
    saveStatus.textContent = "Saving…";
    for (const slot of [zoneErrorsEl, scheduleErrorsEl, sensitivityErrorsEl, kindsErrorsEl, errorsEl]) clearChildren(slot);
    try {
      const body = settingsBodyFromState(state, timeZone);
      const res = await fetchFn(`/camera-ai-settings/${encodeURIComponent(cameraId)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        if (data && Array.isArray(data.errors)) {
          renderErrors(data.errors);
          saveStatus.textContent = "";
        } else {
          saveStatus.textContent = (data && data.message) || "Something went wrong.";
        }
        return;
      }
      saveStatus.textContent = "Saved.";
    } catch (err) {
      if (typeof log === "function") log("error", "camera AI settings save failed", { cameraId, message: err && err.message });
      saveStatus.textContent = "Could not reach the recorder.";
    } finally {
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener("click", () => { void save(); });

  return {
    root,
    /** Apply a fresh load (or the site-wide floor/timeZone/problem) from GET
     *  /camera-ai-settings -- called once at start, and can be re-called by
     *  a future refresh without losing anything the installer typed, since
     *  the caller only invokes this right after a load, never mid-edit. */
    applyLoaded(settings, siteFloor, siteTimeZone) {
      floor = siteFloor;
      timeZone = siteTimeZone;
      state = stateFromSettings(cameraId, camera.name, settings, siteFloor);
      applyStateToForm();
      loadStill();
    },
    setSaveDisabled(disabled, reason) {
      saveBtn.disabled = disabled;
      saveStatus.textContent = disabled ? reason || "" : "";
    },
    getState() { return state; },
  };
}

/* ── page driver ──────────────────────────────────────────────────────── */

/**
 * Wires up the whole "AI settings" section: fetches GET /camera-settings
 * (for camera ids and names) and GET /camera-ai-settings (for each camera's
 * settings, the storing floor and the NVR's time zone), builds one panel per
 * camera, and reports the file-level problem (if any) in a top-level
 * notice.
 */
export function startCameraAiPage(opts) {
  const doc = opts.doc;
  const fetchFn = opts.fetchFn;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const setIntervalFn = opts.setIntervalFn;
  const containerId = opts.containerId || "aiSettingsList";
  const noticeId = opts.noticeId || "aiSettingsNotice";

  const container = typeof doc.getElementById === "function" ? doc.getElementById(containerId) : null;
  const notice = typeof doc.getElementById === "function" ? doc.getElementById(noticeId) : null;

  const panels = new Map();

  function showNotice(text) {
    if (!notice) return;
    if (!text) {
      notice.textContent = "";
      notice.hidden = true;
      return;
    }
    notice.textContent = text;
    notice.hidden = false;
  }

  async function load() {
    let cameraList;
    let aiData;
    try {
      const [camerasRes, aiRes] = await Promise.all([
        fetchFn("/camera-settings", { credentials: "same-origin" }),
        fetchFn("/camera-ai-settings", { credentials: "same-origin" }),
      ]);
      if ((camerasRes && camerasRes.status === 401) || (aiRes && aiRes.status === 401)) {
        if (typeof opts.navigate === "function") opts.navigate("/login?next=%2Fcameras-page");
        return;
      }
      cameraList = (await camerasRes.json().catch(() => null)) || { cameras: [] };
      aiData = (await aiRes.json().catch(() => null)) || { cameras: {}, storingFloor: null, timeZone: "UTC", problem: null };
    } catch (err) {
      log("error", "camera AI settings page could not load", { message: err && err.message });
      showNotice("Could not reach the recorder.");
      return;
    }
    showNotice(aiData.problem || null);
    const cameras = Array.isArray(cameraList.cameras) ? cameraList.cameras : [];
    if (container) clearChildren(container);
    panels.clear();
    if (cameras.length === 0 && container) {
      container.append(el(doc, "p", { class: "dim", text: "No cameras yet." }));
    }
    for (const camera of cameras) {
      if (!camera || typeof camera.cameraId !== "string") continue;
      const panel = createCameraPanel(doc, { fetchFn, now, log }, camera);
      panels.set(camera.cameraId, panel);
      const settings = aiData.cameras && Object.hasOwn(aiData.cameras, camera.cameraId) ? aiData.cameras[camera.cameraId] : null;
      panel.applyLoaded(settings, aiData.storingFloor, aiData.timeZone);
      if (aiData.storingFloor === null) {
        panel.setSaveDisabled(true, "The site's storing floor could not be read, so nothing can be saved yet.");
      }
      if (container) container.append(panel.root);
    }
  }

  const ready = load();
  let timer = null;
  if (setIntervalFn) timer = setIntervalFn(() => { void load(); }, POLL_MS);

  return {
    ready,
    reload: load,
    panels,
    stop() {
      if (timer !== null && typeof opts.clearIntervalFn === "function") opts.clearIntervalFn(timer);
      timer = null;
    },
  };
}

// Browser bootstrap. Runs only when the real page has the panel's container
// in the DOM; a harness importing this module for its pure helpers has no
// side effects. Copies camera-page-bootstrap-lesson (agent bus,
// 2026-09-26): every new NVR page client needs this, and
// harness/cameraAiPage.harness.mjs proves it the same way
// harness/activityPage.harness.mjs proves activity-client.mjs's own.
if (typeof document !== "undefined" &&
    typeof document.getElementById === "function" &&
    document.getElementById("aiSettingsList")) {
  startCameraAiPage({
    doc: document,
    fetchFn: function (url, init) {
      return fetch(url, init);
    },
    now: () => Date.now(),
    setIntervalFn: (fn, ms) => window.setInterval(fn, ms),
    clearIntervalFn: (id) => window.clearInterval(id),
    navigate: (url) => { window.location.assign(url); },
    log: () => {},
  });
}
