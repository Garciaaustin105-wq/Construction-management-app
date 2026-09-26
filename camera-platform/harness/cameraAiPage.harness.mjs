/**
 * The Cameras page's "AI settings" panel (CAMERA-AI-SETTINGS-SPEC.md), run
 * without a browser: agent/ui/camera-ai-client.mjs's pure helpers, plus the
 * routing and page-shell checks that don't need one either.
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/cameraAiPage.harness.mjs`.
 *
 * THE FEARED FAILURES, in the spec's and AGENTS.md's own words:
 *  - a blank read as a zero: a never-configured camera's panel must show
 *    "whole frame", "always", "site default" and both kinds ON, never an
 *    empty/false/zero reading of any of those (build rule 5).
 *  - a pointer position outside the still (a drag that ends past the edge)
 *    landing outside 0..1, so a saved zone point the server would refuse.
 *  - the first server-side problem hiding every other one from the
 *    installer.
 *  - a store account reaching the panel at all -- checked at the routing
 *    layer this page's script and its data both sit behind, the same way
 *    activityPage.harness.mjs checks its own page's nav link.
 *  - camera-page-bootstrap-lesson (agent bus, 2026-09-26): a client with no
 *    browser bootstrap block passes every check that drives its exported
 *    functions directly while the real page never fetches anything.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { check, eq, same, report } from "./_assert.mjs";

const root = process.cwd();
const client = await import(pathToFileURL(join(root, "agent/ui/camera-ai-client.mjs")).href);
const contract = await import(pathToFileURL(join(root, "dist/cameraAiSettings.js")).href);
const { decideRoute } = await import(pathToFileURL(join(root, "dist/routeAccess.js")).href);

console.log("camera AI settings page");

const {
  AI_MIN_CONFIDENCE, AI_MAX_CONFIDENCE, AI_CONFIDENCE_STEP, AI_MAX_ZONES, AI_MIN_ZONE_POINTS, AI_MAX_ZONE_POINTS,
  roundFraction, pointerFraction, nextZoneId, confidenceOptions, confidenceOptionsWithStored,
  defaultPanelState, stateFromSettings, settingsBodyFromState, describeReason, fieldErrorMap, DAY_NAMES,
  createCameraPanel,
} = client;

const installer = { kind: "user", username: "tech", role: "installer" };
const store = { kind: "user", username: "frontdesk", role: "store" };
const display = { kind: "display", displayId: "backroom-tv" };

/* ── the client's own numbers never drift from the contract's ───────────── */

check("the client's copied constants match contracts/cameraAiSettings.ts exactly", () => {
  eq(AI_MIN_CONFIDENCE, contract.MIN_CONFIDENCE, "MIN_CONFIDENCE");
  eq(AI_MAX_CONFIDENCE, contract.MAX_CONFIDENCE, "MAX_CONFIDENCE");
  eq(AI_CONFIDENCE_STEP, contract.CONFIDENCE_STEP, "CONFIDENCE_STEP");
  eq(AI_MAX_ZONES, contract.MAX_ZONES, "MAX_ZONES");
  eq(AI_MIN_ZONE_POINTS, contract.MIN_ZONE_POINTS, "MIN_ZONE_POINTS");
  eq(AI_MAX_ZONE_POINTS, contract.MAX_ZONE_POINTS, "MAX_ZONE_POINTS");
});

/* ── zone-editor maths: pointer position to fractions, clamped 0..1 ─────── */

check("pointerFraction: inside the still maps linearly to 0..1", () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };
  same(pointerFraction(100, 50, rect), { x: 0, y: 0 }, "top-left corner");
  same(pointerFraction(300, 150, rect), { x: 1, y: 1 }, "bottom-right corner");
  same(pointerFraction(200, 100, rect), { x: 0.5, y: 0.5 }, "centre");
});

check("pointerFraction: FEARED -- outside the still clamps to 0..1, never a negative or >1 fraction", () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };
  same(pointerFraction(-500, -500, rect), { x: 0, y: 0 }, "far above and left");
  same(pointerFraction(9000, 9000, rect), { x: 1, y: 1 }, "far below and right");
  same(pointerFraction(99, 50, rect), { x: 0, y: 0 }, "one pixel left of the edge");
});

check("pointerFraction: a degenerate (zero-size) rect never divides by zero into NaN or Infinity", () => {
  same(pointerFraction(10, 10, { left: 0, top: 0, width: 0, height: 0 }), { x: 0, y: 0 }, "zero rect");
  same(pointerFraction(10, 10, null), { x: 0, y: 0 }, "no rect yet (still not loaded)");
});

check("roundFraction: rounds to 4 places and clamps 0..1", () => {
  eq(roundFraction(0.123456), 0.1235, "rounds");
  eq(roundFraction(-0.5), 0, "clamps low");
  eq(roundFraction(1.5), 1, "clamps high");
});

check("nextZoneId: the first free id, and null once AI_MAX_ZONES are all used", () => {
  eq(nextZoneId([]), "z1", "empty");
  eq(nextZoneId([{ id: "z1" }, { id: "z2" }]), "z3", "skips used ones");
  eq(nextZoneId([{ id: "z2" }, { id: "z1" }]), "z3", "order-independent");
  const full = Array.from({ length: AI_MAX_ZONES }, (_, i) => ({ id: `z${i + 1}` }));
  eq(nextZoneId(full), null, `FEARED: no id beyond ${AI_MAX_ZONES} zones`);
});

check("confidenceOptions: the 0.30..0.90 step-0.05 grid at or above the floor", () => {
  same(confidenceOptions(0.5), [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9], "floor on the grid");
  eq(confidenceOptions(0.5).every((v) => v >= AI_MIN_CONFIDENCE - 1e-9 && v <= AI_MAX_CONFIDENCE + 1e-9), true, "stays in range");
  same(confidenceOptions(0), confidenceOptions(0.3), "a floor below the grid's own minimum changes nothing");
  same(confidenceOptions(0.95), [], "FEARED: a floor above MAX_CONFIDENCE leaves no legal custom value");
  same(confidenceOptions(null), [], "an unknown floor is never guessed at as 0");
});

check("confidenceOptionsWithStored: a stored value the floor has since outgrown is still shown, never silently dropped or coerced", () => {
  const withStored = confidenceOptionsWithStored(0.6, 0.4);
  eq(withStored.includes(0.4), true, "the stored value is present");
  same([...withStored].sort((a, b) => a - b), withStored, "still sorted low to high");
  same(confidenceOptionsWithStored(0.5, 0.55), confidenceOptions(0.5), "a stored value already on the list is not duplicated");
  same(confidenceOptionsWithStored(0.5, null), confidenceOptions(0.5), "no stored custom value yet: unchanged");
});

/* ── a blank is not a zero: a never-configured camera's panel ──────────── */

check("defaultPanelState: whole frame, always, site default, both kinds -- the pre-feature behaviour", () => {
  const s = defaultPanelState("cam-1", "Front Door");
  eq(s.zones.length, 0, "no zones");
  eq(s.scheduleMode, "always", "always, not an accidental closed week");
  eq(s.weekly.length, 7, "seven weekdays");
  eq(s.weekly.every((d) => d.open === false), true, "every day starts closed in the editor (schedule itself is 'always', not read from these)");
  eq(s.minConfidenceMode, "default", "site default, never a bare 0");
  eq(s.kinds.person, true, "person on");
  eq(s.kinds.vehicle, true, "vehicle on");
});

check("stateFromSettings(null-ish settings) is exactly defaultPanelState -- a never-saved camera looks untouched", () => {
  same(stateFromSettings("cam-1", "Front Door", null, 0.5), defaultPanelState("cam-1", "Front Door"), "null settings");
  same(stateFromSettings("cam-1", "Front Door", contract.DEFAULT_CAMERA_AI_SETTINGS, 0.5), defaultPanelState("cam-1", "Front Door"), "the contract's own defaults object");
});

/* ── the form round-trip: load settings, edit, the POST body shape ─────── */

check("round trip: load a camera's saved settings, then the POST body matches it field for field", () => {
  const saved = {
    zones: [{ id: "z1", mode: "ignore", points: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]] }],
    schedule: {
      timeZone: "America/Chicago",
      weekly: [[], [{ open: 480, close: 1320 }], [{ open: 480, close: 1320 }], [{ open: 480, close: 1320 }],
        [{ open: 480, close: 1320 }], [{ open: 480, close: 1320 }], [{ open: 1080, close: 120 }]],
      closedDates: [],
    },
    minConfidence: 0.6,
    kinds: { person: true, vehicle: false },
  };
  const state = stateFromSettings("cam-1", "Front Door", saved, 0.5);
  eq(state.scheduleMode, "custom", "schedule loaded as custom");
  eq(state.weekly[0].open, false, "Sunday closed");
  eq(state.weekly[1].open, true, "Monday open");
  eq(state.weekly[1].from, "08:00", "Monday from");
  eq(state.weekly[1].to, "22:00", "Monday to");
  eq(state.weekly[6].from, "18:00", "Saturday from (past-midnight schedule)");
  eq(state.weekly[6].to, "02:00", "Saturday to (past-midnight schedule)");
  eq(state.minConfidenceMode, "custom", "sensitivity loaded as custom");
  eq(state.minConfidenceValue, 0.6, "sensitivity value");
  eq(state.kinds.vehicle, false, "vehicle off, loaded exactly");

  const body = settingsBodyFromState(state, "America/Chicago");
  same(body.zones, saved.zones, "zones round-trip exactly");
  same(body.schedule, saved.schedule, "schedule round-trips exactly, including the past-midnight Saturday");
  eq(body.minConfidence, 0.6, "minConfidence round-trips");
  same(body.kinds, { person: true, vehicle: false }, "kinds round-trip");

  const checked = contract.checkCameraAiSettings(body, 0.5);
  eq(checked.ok, true, `FEARED: the page's own POST body must validate against the real contract (${checked.ok ? "" : JSON.stringify(checked.errors)})`);
});

check("FEARED: an existing schedule's saved zone survives an unrelated edit even when the site's zone has since changed", () => {
  const saved = {
    zones: [],
    schedule: {
      timeZone: "America/Chicago",
      weekly: [[], [{ open: 480, close: 1020 }], [], [], [], [], []],
      closedDates: [],
    },
    minConfidence: null,
    kinds: { person: true, vehicle: true },
  };
  // The camera's schedule was saved under America/Chicago. Since then the
  // installer has changed the SITE's zone to something else entirely.
  const state = stateFromSettings("cam-9", "Loading Dock", saved, 0.5);
  eq(state.scheduleTimeZone, "America/Chicago", "the loaded schedule's own zone is captured, not discarded");

  // The installer edits something unrelated -- flips a kind -- and saves.
  // Site's CURRENT effective zone (module-level, from the site, not the
  // schedule) is passed in as the second argument, exactly as save() does.
  state.kinds.vehicle = false;
  const body = settingsBodyFromState(state, "Asia/Tokyo");
  eq(body.schedule.timeZone, "America/Chicago", "FEARED: must NOT silently shift to the site's current zone");
  eq(body.kinds.vehicle, false, "the actual edit still went through");

  const checked = contract.checkCameraAiSettings(body, 0.5);
  eq(checked.ok, true, "still validates");
});

check("a brand-new custom schedule (no saved zone yet) takes the site's current zone", () => {
  const state = defaultPanelState("cam-10", "New Camera");
  eq(state.scheduleTimeZone, null, "no saved schedule yet");
  state.scheduleMode = "custom";
  state.weekly[1] = { open: true, from: "09:00", to: "17:00" };
  const body = settingsBodyFromState(state, "Asia/Tokyo");
  eq(body.schedule.timeZone, "Asia/Tokyo", "a fresh schedule is saved in the site's current zone");
});

check("round trip: 'always' schedule and 'site default' sensitivity both send exactly null, never a fabricated value", () => {
  const state = defaultPanelState("cam-2", "Back Lot");
  const body = settingsBodyFromState(state, "America/Chicago");
  eq(body.schedule, null, "always -> null schedule");
  eq(body.minConfidence, null, "site default -> null minConfidence");
  const checked = contract.checkCameraAiSettings(body, 0.5);
  eq(checked.ok, true, "validates as the defaults");
  same(checked.settings, contract.DEFAULT_CAMERA_AI_SETTINGS, "and IS the defaults, not merely valid");
});

check("round trip: editing (add a zone, flip a kind) changes only what was edited", () => {
  const state = defaultPanelState("cam-3", "Aisle 4");
  state.zones.push({ id: "z1", mode: "watch", points: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  state.kinds.vehicle = false;
  const body = settingsBodyFromState(state, "UTC");
  eq(body.zones.length, 1, "the new zone is there");
  eq(body.kinds.person, true, "person untouched");
  eq(body.kinds.vehicle, false, "vehicle flipped");
  eq(body.schedule, null, "schedule untouched (still always)");
  const checked = contract.checkCameraAiSettings(body, 0.5);
  eq(checked.ok, true, "still validates");
});

check("FEARED: a day switched off sends an empty interval list, never open===close or a fabricated 0..0 range", () => {
  const state = defaultPanelState("cam-4", "Loading Dock");
  state.scheduleMode = "custom";
  // Monday is left closed (the default); Tuesday is opened with real hours.
  state.weekly[2] = { open: true, from: "09:00", to: "17:00" };
  const body = settingsBodyFromState(state, "UTC");
  same(body.schedule.weekly[1], [], "Monday: closed all day, an empty array");
  same(body.schedule.weekly[2], [{ open: 540, close: 1020 }], "Tuesday: the one interval given");
  const checked = contract.checkCameraAiSettings(body, 0.5);
  eq(checked.ok, true, "validates");
});

/* ── errors shown: every problem, described in plain words ─────────────── */

check("fieldErrorMap: groups every problem, and none are dropped -- 'no fix-and-resave one at a time'", () => {
  const errors = [
    { field: "zones[0].mode", reason: "bad_zone_mode" },
    { field: "zones[1].points", reason: "bad_zone_point_count" },
    { field: "schedule", reason: "bad_hours" },
    { field: "minConfidence", reason: "below_storing_floor" },
    { field: "kinds.person", reason: "bad_kind_flag" },
  ];
  const groups = fieldErrorMap(errors);
  eq(groups.zones.length, 2, "both zone problems kept");
  eq(groups.schedule.length, 1, "schedule problem kept");
  eq(groups.minConfidence.length, 1, "minConfidence problem kept");
  eq(groups.kinds.length, 1, "kinds problem kept");
  const totalIn = errors.length;
  const totalOut = groups.zones.length + groups.schedule.length + groups.minConfidence.length + groups.kinds.length + groups.other.length;
  eq(totalOut, totalIn, "FEARED: every server problem reaches the page, none silently dropped");
});

check("describeReason: plain words for every reason the real contract can actually produce, never a raw code shown verbatim by accident", () => {
  const knownReasons = [
    "not_an_array", "too_many_zones", "not_an_object", "bad_zone_id", "duplicate_zone_id", "bad_zone_mode",
    "bad_zone_point_count", "bad_zone_point", "bad_time_zone", "bad_hours", "bad_closed_date", "bad_confidence",
    "bad_confidence_range", "bad_confidence_step", "below_storing_floor", "unknown_field", "bad_kind_flag",
  ];
  for (const reason of knownReasons) {
    eq(describeReason(reason) === reason, false, `"${reason}" has real words, not just its own code echoed back`);
  }
  eq(describeReason("some_future_reason_this_page_does_not_know"), "some_future_reason_this_page_does_not_know", "an unknown reason still shows SOMETHING rather than throwing");
});

check("a live invalid body's errors (from the real contract) all describe to real words", () => {
  const checked = contract.checkCameraAiSettings({
    zones: [{ id: "z1", mode: "sideways", points: [[0, 0], [1, 1]] }],
    minConfidence: 0.05,
    kinds: { person: "yes" },
  }, 0.5);
  eq(checked.ok, false, "the fixture is deliberately invalid");
  const groups = fieldErrorMap(checked.errors);
  const shown = [...groups.zones, ...groups.schedule, ...groups.minConfidence, ...groups.kinds, ...groups.other];
  eq(shown.length, checked.errors.length, "every real contract error is shown");
  eq(shown.every((line) => !/^[a-z_]+: [a-z_]+$/.test(line)), true, "none of them are just 'field: raw_code' with no real words");
});

/* ── a real (if minimal) DOM: does each error land NEXT TO its own field? ─
 *
 * fieldErrorMap's own doc comment says grouping exists "so the panel can
 * flag the right section" - checked above only at the grouping level. This
 * builds one real camera panel (createCameraPanel, exported above) against
 * a small but real element tree (no jsdom dependency here - none is
 * installed) and asks where each group's <ul> actually ends up once a save
 * comes back 400, the way a browser would show it.
 */

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._text = "";
    this.className = "";
    this.listeners = {};
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.value = "";
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); for (const c of this.children) c.parentNode = null; this.children = []; }
  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      this.children.push(n);
      n.parentNode = this;
    }
  }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); n.parentNode = null; return n; }
  replaceChildren(...nodes) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...nodes); }
  get firstChild() { return this.children[0] || null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(type, ev) { for (const fn of this.listeners[type] || []) fn(ev); }
}

class FakeDocument {
  createElement(tag) { return new FakeElement(tag); }
  createElementNS(_ns, tag) { return new FakeElement(tag); }
}

/** Depth-first walk of the fake tree, yielding every element once. */
function* walk(node) {
  yield node;
  for (const c of node.children) yield* walk(c);
}

/** This element's own class list contains `cls` (space-separated, like a
 *  real className). */
function hasClass(node, cls) {
  return String(node.className || "").split(/\s+/).includes(cls);
}

/** The nearest ancestor fieldset's own class (e.g. "ai-schedule"), or null
 *  for an error slot that sits directly in the body (zones, "other"). */
function ancestorFieldsetClass(node) {
  for (let p = node.parentNode; p; p = p.parentNode) {
    if (p.tagName === "fieldset") {
      const known = ["ai-schedule", "ai-sensitivity", "ai-kinds"].find((c) => hasClass(p, c));
      if (known) return known;
    }
  }
  return null;
}

/** Every "ai-errors" slot in the tree that actually holds a rendered <ul> of
 *  messages right now, tagged by which fieldset (if any) it lives inside and
 *  by the text of its own messages. */
function renderedErrorSlots(root) {
  const slots = [];
  for (const node of walk(root)) {
    if (!hasClass(node, "ai-errors")) continue;
    const uls = node.children.filter((c) => c.tagName === "ul");
    if (uls.length === 0) continue; // .ai-errors:empty -- nothing shown here
    const lines = uls[0].children.map((li) => li.textContent);
    slots.push({ fieldset: ancestorFieldsetClass(node), lines });
  }
  return slots;
}

async function buildPanelAndSave(fetchResponse) {
  const doc = new FakeDocument();
  const panel = createCameraPanel(doc, {
    fetchFn: async () => ({ ok: false, json: async () => fetchResponse }),
    now: () => new Date("2026-09-26T12:00:00.000Z"),
    log: () => {},
  }, { cameraId: "cam-1", name: "Front Door" });
  panel.applyLoaded(null, 0.5, "UTC");
  // The Save button's own click handler runs `save()`; find it by walking
  // the tree rather than exposing save() itself, the same way a real click
  // in a real browser would trigger it.
  const saveBtn = [...walk(panel.root)].find((n) => hasClass(n, "ai-save"));
  for (const fn of saveBtn.listeners.click || []) fn();
  await new Promise((r) => setTimeout(r, 0)); // let the async save() settle
  return panel.root;
}

await check("REQUIRED (page lens finding): a zone error lands next to the zone editor, a schedule error next to the schedule, sensitivity next to sensitivity, kinds next to kinds -- not all lumped into one block by Save", async () => {
  const root = await buildPanelAndSave({
    ok: false,
    errors: [
      { field: "zones[0].mode", reason: "bad_zone_mode" },
      { field: "schedule", reason: "bad_hours" },
      { field: "minConfidence", reason: "below_storing_floor" },
      { field: "kinds.person", reason: "bad_kind_flag" },
    ],
  });
  const slots = renderedErrorSlots(root);
  const withText = (needle) => slots.filter((s) => s.lines.some((l) => l.includes(needle)));

  eq(withText("zones[0].mode").length, 1, "the zone problem is shown exactly once");
  eq(withText("zones[0].mode")[0].fieldset, null, "not inside any fieldset (there is no zone <fieldset> - the zone editor sits directly in the body)");

  eq(withText("schedule:").length, 1, "the schedule problem is shown exactly once");
  eq(withText("schedule:")[0].fieldset, "ai-schedule", "REQUIRED: next to the schedule fieldset, not the bottom block");

  eq(withText("minConfidence").length, 1, "the sensitivity problem is shown exactly once");
  eq(withText("minConfidence")[0].fieldset, "ai-sensitivity", "REQUIRED: next to the sensitivity fieldset");

  eq(withText("kinds.person").length, 1, "the kinds problem is shown exactly once");
  eq(withText("kinds.person")[0].fieldset, "ai-kinds", "REQUIRED: next to the kinds fieldset");

  // None of the four field-specific problems fell through to the bottom,
  // Save-adjacent "other" block -- that block is for problems with no
  // matching section only.
  const bottomBlock = slots.find((s) => s.fieldset === null && s.lines.some((l) => l.includes("schedule:") || l.includes("minConfidence") || l.includes("kinds.person")));
  eq(bottomBlock, undefined, "no field-specific problem is ALSO duplicated into the bottom block");
});

await check("a problem naming no known field ('other') still reaches the installer, in the bottom block", async () => {
  const root = await buildPanelAndSave({ ok: false, errors: [{ field: "somethingUnexpected", reason: "totally_new_reason" }] });
  const slots = renderedErrorSlots(root);
  const other = slots.find((s) => s.lines.some((l) => l.startsWith("somethingUnexpected:")));
  eq(other !== undefined, true, "the unmatched problem still shows up somewhere");
  eq(other.fieldset, null, "in the general block, not miscategorised into a fieldset");
});

/* ── the store role never sees the panel ────────────────────────────────── */

check("FEARED: a store account and a wall display are refused the page, its data AND its script -- never just some of the three", () => {
  for (const [method, path] of [
    ["GET", "/cameras-page"], ["GET", "/camera-ai-settings"], ["GET", "/ui/camera-ai-client.js"],
    ["POST", "/camera-ai-settings/cam-1"],
  ]) {
    const storeDecision = decideRoute(store, method, path);
    eq(storeDecision.kind, "refuse", `store ${method} ${path}`);
    eq(storeDecision.status, 403, `store ${method} ${path} is a 403, not merely absent`);
    const displayDecision = decideRoute(display, method, path);
    eq(displayDecision.kind, "refuse", `display ${method} ${path}`);
  }
  for (const [method, path] of [["GET", "/cameras-page"], ["GET", "/camera-ai-settings"], ["GET", "/ui/camera-ai-client.js"]]) {
    eq(decideRoute(installer, method, path).kind, "allow", `installer keeps ${method} ${path}`);
  }
});

/* ── page shell: phone width, dark theme, no innerHTML ──────────────────── */

await check("cameras.html: the AI panel has its 16px gutter, the notice and list containers, and loads its own client", async () => {
  const html = await readFile(join(root, "agent/ui/cameras.html"), "utf8");
  eq(html.includes("padding:16px"), true, "the AI panel's own 16px gutter");
  eq(html.includes('id="aiSettingsList"'), true, "the per-camera panel container");
  eq(html.includes('id="aiSettingsNotice"'), true, "the file-problem notice");
  eq(html.includes('src="/ui/camera-ai-client.js"'), true, "loads its own client");
  eq(html.includes("color-scheme: dark"), true, "dark, like the rest of this app");
  eq(/overflow-x:\s*(scroll|auto)/.test(html), false, "FEARED: nothing forces a sideways scroll");
});

await check("camera-ai-client.mjs never sets innerHTML (comments may name it while explaining the house rule)", async () => {
  const src = await readFile(join(root, "agent/ui/camera-ai-client.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  eq(code.includes("innerHTML"), false, "no innerHTML in the real code");
  eq(code.includes(".textContent"), true, "text is set with .textContent instead");
});

check("DAY_NAMES: seven names, Sunday first -- matching alertRules.ts's own weekly[0] = Sunday", () => {
  eq(DAY_NAMES.length, 7, "seven days");
  eq(DAY_NAMES[0], "Sunday", "index 0");
  eq(DAY_NAMES[6], "Saturday", "index 6");
});

/* ── THE FEARED ONE: in a browser the page starts itself ────────────────── */

await check("THE FEARED ONE: loading camera-ai-client.mjs with the real page in the DOM fetches its own settings with no harness calling it", () => {
  // Same technique as harness/activityPage.harness.mjs's own copy of this
  // check (camera-page-bootstrap-lesson, agent bus 2026-09-26): load the
  // module fresh, in its own process, with a fake document holding
  // #aiSettingsList, and record what it asks the server for.
  const clientUrl = pathToFileURL(join(root, "agent/ui/camera-ai-client.mjs")).href;
  const code = `
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => "";
        if (k === "then") return undefined;
        if (k === "value" || k === "textContent" || k === "className") return "";
        if (k === "length") return 0;
        if (k === "hidden" || k === "disabled" || k === "checked") return false;
        return fake;
      },
      apply() { return fake; },
      set() { return true; },
    };
    const fake = new Proxy(function () {}, handler);
    const calls = [];
    globalThis.document = {
      getElementById: (id) => (id === "aiSettingsList" || id === "aiSettingsNotice" ? fake : fake),
      createElement: () => fake, createElementNS: () => fake,
      createTextNode: () => fake, querySelector: () => fake, querySelectorAll: () => [],
      addEventListener() {}, body: fake, documentElement: fake,
    };
    globalThis.window = { location: { assign() {} }, setInterval: () => 1, clearInterval: () => {}, addEventListener() {} };
    globalThis.fetch = (url) => {
      calls.push(String(url));
      if (String(url).startsWith("/camera-settings")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, cameras: [{ cameraId: "cam-1", name: "Front Door" }] }) });
      }
      if (String(url).startsWith("/camera-ai-settings")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, cameras: {}, storingFloor: 0.5, timeZone: "UTC", problem: null }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };
    await import(${JSON.stringify(clientUrl)} + "?boot");
    await new Promise((r) => setTimeout(r, 150));
    console.log(JSON.stringify(calls));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", cwd: root, timeout: 20_000 });
  eq(r.status, 0, `the child ran (${(r.stderr || "").slice(0, 500)})`);
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  const calls = JSON.parse(lines[lines.length - 1] || "[]");
  eq(calls.some((u) => u === "/camera-settings"), true, `it asked for /camera-settings on its own: ${JSON.stringify(calls)}`);
  eq(calls.some((u) => u === "/camera-ai-settings"), true, `it asked for /camera-ai-settings on its own: ${JSON.stringify(calls)}`);
});

report("camera AI settings page");
