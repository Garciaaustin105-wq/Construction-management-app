// agent/ui/layout-client.mjs
//
// Named wall layouts on the Live page (agent/ui/index.html), SITE-SETTINGS-
// SPEC.md section 3: save the current grid as a named layout, load one, set
// a default, the one-time "save this browser's current layout to your
// account" offer -- and, separately, a paired display's own read-only poll
// of its assigned layout.
//
// Deliberately its OWN file (one owner per file, AGENTS.md build rule 3):
// wall-client.mjs owns the grid itself (auto-packed cells, paging, which
// sockets are open) and now also a SAVED layout's explicit rendering
// (setExplicitLayout/cells, added alongside this file); this file owns only
// the account-facing save/load/default UI and GET/POST /layouts, plus the
// display's GET /display-layout poll -- neither one touches a socket or a
// cell directly, only through the wall instance handed to it.
//
// Same discipline as every other *-client.mjs here: every dependency (the
// document, fetch, storage, the wall instance, the timers) arrives through
// `opts`, never read off a bare global inside an exported function, so a
// harness can drive this without a browser. Nothing here ever sets
// innerHTML -- a layout's own NAME is text an account typed, set with
// .textContent only.
//
// THE FEARED FAILURES this file is written against:
// - "save the current grid" disagreeing with what is actually on screen:
//   cellsForSave reads wall.cells(), the wall's own record of what it just
//   rendered (the CHOSEN stream per cell), never re-derived here.
// - a removed camera's cell round-tripping into a blank: rawCellsFromView
//   keeps a "removed" cell's own cameraId (so the NEXT read still resolves
//   it as removed, or as found again if the camera comes back), and never
//   collapses it to null the way an "empty" cell already is.
// - the one-time migration offer reappearing on every load, or moving data
//   without an explicit yes ("nothing moves on its own"): the flag is
//   written on EITHER answer, and only "yes" ever calls POST /layouts.
// - a display's own poll retrying forever against a 403 it can never fix
//   (wrong principal kind), or applying `null` as if it were an empty shape.
// - camera-page-bootstrap-lesson (agent bus, 2026-09-26): see the bottom of
//   this file.

const MIGRATION_KEY = "camplat.layouts.migrationOffered";
const DISPLAY_POLL_MS = 60_000;

// Mirrored from contracts/savedLayouts.ts -- that file compiles to CommonJS,
// so it cannot be imported by a browser the way dist/gridLayout.mjs can.
// harness/layoutClientPage.harness.mjs checks this copy still matches it.
export const MAX_LAYOUT_NAME_LENGTH = 60;

function byId(doc, id) {
  return typeof doc.getElementById === "function" ? doc.getElementById(id) : null;
}

function clearChildren(node) {
  if (!node) return;
  if (typeof node.replaceChildren === "function") node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

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

/* ── pure helpers (no document, no fetch) ─────────────────────────────── */

const REASON_TEXT = {
  not_an_array: "must be a list",
  too_many_layouts: "too many saved layouts for one account",
  not_an_object: "must be an object",
  bad_name: `needs a name, at most ${MAX_LAYOUT_NAME_LENGTH} characters`,
  bad_layout_id: "is not a known grid shape",
  bad_cell_count: "does not match that grid shape's own cell count",
  bad_cell_value: "names a camera incorrectly",
  duplicate_layout_name: "is already used by another saved layout",
  bad_default_name: "does not name one of the saved layouts",
};

/** Plain text for a FieldProblem.reason -- never the raw code. */
export function describeLayoutReason(reason) {
  return REASON_TEXT[reason] || String(reason);
}

/**
 * The save payload's `cells` (string|null per index), from wall.cells()'s
 * own `{kind, index, cameraId?}` array -- sorted by index first, since
 * nothing here may assume the wall handed the cells back in cell order.
 */
export function cellsForSave(rendered) {
  const list = (Array.isArray(rendered) ? rendered.slice() : []).sort(
    (a, b) => (a && typeof a.index === "number" ? a.index : 0) - (b && typeof b.index === "number" ? b.index : 0),
  );
  return list.map((c) => (c && c.kind === "camera" && typeof c.cameraId === "string" ? c.cameraId : null));
}

/**
 * The inverse of the server's own resolveLayoutCells, for round-tripping a
 * layout GET /layouts already resolved back into the raw shape POST
 * /layouts needs (full-replace: every OTHER saved layout has to go back out
 * exactly as it came in). A "removed" cell keeps its own cameraId -- that
 * camera may come back, and this must never be the place that quietly loses
 * it (the failure this whole feature exists to avoid, one layer up).
 */
export function rawCellsFromView(cells) {
  return (Array.isArray(cells) ? cells : []).map((c) =>
    c && c.kind !== "empty" && typeof c.cameraId === "string" ? c.cameraId : null);
}

function toApiLayouts(layouts) {
  return (Array.isArray(layouts) ? layouts : []).map((l) => ({
    name: l.name, layout: l.layout, cells: rawCellsFromView(l.cells),
  }));
}

/* ── DOM ──────────────────────────────────────────────────────────────── */

function buildPanel(doc) {
  const trigger = el(doc, "button", { type: "button", id: "layoutsTrigger", class: "layoutctl-trigger", text: "Layouts" });
  const migrationBanner = el(doc, "div", { id: "layoutsMigration", class: "layoutctl-migration", hidden: true }, []);
  const nameInput = el(doc, "input", { type: "text", id: "layoutSaveName", maxlength: String(MAX_LAYOUT_NAME_LENGTH), placeholder: "Layout name", autocomplete: "off" });
  const saveBtn = el(doc, "button", { type: "button", id: "layoutSaveButton", text: "Save current grid as…" });
  const errorsEl = el(doc, "div", { class: "error layoutctl-errors", id: "layoutErrors", role: "alert" }, []);
  const statusEl = el(doc, "span", { class: "dim", id: "layoutStatus" });
  const listEl = el(doc, "div", { id: "layoutsList" }, []);
  const panel = el(doc, "div", { id: "layoutsPanel", class: "layoutctl-panel", hidden: true }, [
    migrationBanner,
    el(doc, "div", { class: "row" }, [nameInput, saveBtn]),
    errorsEl, statusEl,
    el(doc, "p", { class: "dim layoutctl-heading", text: "Saved layouts" }),
    listEl,
  ]);
  const wrap = el(doc, "div", { class: "layoutctl-wrap", id: "layoutControlsWrap" }, [trigger, panel]);
  return { wrap, trigger, panel, migrationBanner, nameInput, saveBtn, errorsEl, statusEl, listEl };
}

/** One saved layout's row: its name (untrusted text an account typed --
 *  .textContent only), Load, Set default (or a fixed "Default" mark), and
 *  Delete. */
function layoutRow(doc, layout, isDefault, handlers) {
  const nameEl = el(doc, "strong", { text: layout.name });
  const loadBtn = el(doc, "button", { type: "button", text: "Load", onclick: () => handlers.onLoad(layout) });
  const defaultBtn = el(doc, "button", {
    type: "button",
    text: isDefault ? "Default" : "Set default",
    disabled: isDefault,
    onclick: () => handlers.onSetDefault(layout),
  });
  const delBtn = el(doc, "button", { type: "button", class: "danger", text: "Delete", onclick: () => handlers.onDelete(layout) });
  return el(doc, "div", { class: "row layoutctl-row" }, [nameEl, loadBtn, defaultBtn, delBtn]);
}

/* ── the account's own save / load / default UI ──────────────────────── */

/**
 * Wires the "Layouts" control on the Live page. Does nothing at all for a
 * display principal or a signed-out one -- "a display never edits it", and
 * nowhere here should even ask a display to.
 */
export function startLayoutControls(opts) {
  const doc = opts.doc;
  const fetchFn = opts.fetchFn;
  const wall = opts.wall;
  const storage = opts.storage || null;
  const confirmFn = typeof opts.confirmFn === "function" ? opts.confirmFn : () => true;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const containerId = opts.containerId || "layoutControls";
  const container = byId(doc, containerId);
  if (!container || !wall) return { ready: Promise.resolve() };

  const dom = buildPanel(doc);
  container.append(dom.wrap);

  let layouts = [];
  let defaultName = null;
  let open = false;

  function readStorage(key) {
    if (!storage) return null;
    try { return storage.getItem(key); } catch { return null; }
  }
  function writeStorage(key, value) {
    if (!storage) return;
    try { storage.setItem(key, value); } catch { /* a browser with storage blocked still has to work */ }
  }

  function setOpen(next) {
    open = next;
    dom.panel.hidden = !open;
  }
  dom.trigger.addEventListener("click", () => setOpen(!open));

  function renderErrors(errors) {
    clearChildren(dom.errorsEl);
    if (!Array.isArray(errors) || errors.length === 0) return;
    const list = el(doc, "ul", {}, errors.map((e) => el(doc, "li", { text: `${e.field}: ${describeLayoutReason(e.reason)}` })));
    dom.errorsEl.append(el(doc, "p", { text: "These layouts could not be saved:" }), list);
  }

  function renderList() {
    clearChildren(dom.listEl);
    if (layouts.length === 0) {
      dom.listEl.append(el(doc, "p", { class: "dim", text: "No saved layouts yet." }));
      return;
    }
    for (const layout of layouts) {
      dom.listEl.append(layoutRow(doc, layout, layout.name === defaultName, {
        onLoad: (l) => { wall.setExplicitLayout(l.layout, l.cells); setOpen(false); },
        onSetDefault: (l) => { void setDefault(l.name); },
        onDelete: (l) => { void removeLayout(l.name); },
      }));
    }
  }

  async function persistAccountLayouts(nextLayouts, nextDefault) {
    dom.statusEl.textContent = "Saving…";
    clearChildren(dom.errorsEl);
    let res;
    try {
      res = await fetchFn("/layouts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layouts: nextLayouts, defaultName: nextDefault }),
      });
    } catch (err) {
      log("error", "layouts save failed", { message: err && err.message });
      dom.statusEl.textContent = "Could not reach the recorder.";
      return false;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      if (data && Array.isArray(data.errors)) renderErrors(data.errors);
      else dom.statusEl.textContent = (data && data.message) || "Something went wrong.";
      return false;
    }
    layouts = Array.isArray(data.layouts) ? data.layouts : [];
    defaultName = data.defaultName ?? null;
    dom.statusEl.textContent = "Saved.";
    renderList();
    return true;
  }

  async function saveLayout(name, shapeId, cellsRaw) {
    const trimmed = (name || "").trim();
    if (trimmed === "") { dom.statusEl.textContent = "Name the layout first."; return; }
    const withoutSame = toApiLayouts(layouts.filter((l) => l.name !== trimmed));
    const next = [...withoutSame, { name: trimmed, layout: shapeId, cells: cellsRaw }];
    // The account's very first saved layout becomes its default -- an
    // explicit, sensible choice worth making once, never a preset that
    // restamps a default the account later changed by hand.
    const nextDefault = layouts.length === 0 ? trimmed : defaultName;
    const ok = await persistAccountLayouts(next, nextDefault);
    if (ok) dom.nameInput.value = "";
  }

  async function setDefault(name) {
    await persistAccountLayouts(toApiLayouts(layouts), name);
  }

  async function removeLayout(name) {
    if (!confirmFn(`Delete the saved layout "${name}"?`)) return;
    const next = toApiLayouts(layouts.filter((l) => l.name !== name));
    const nextDefault = defaultName === name ? null : defaultName;
    await persistAccountLayouts(next, nextDefault);
  }

  dom.saveBtn.addEventListener("click", () => {
    const current = wall.cells();
    if (!current || !current.shapeId || !Array.isArray(current.cells)) {
      dom.statusEl.textContent = "Nothing to save yet.";
      return;
    }
    void saveLayout(dom.nameInput.value, current.shapeId, cellsForSave(current.cells));
  });

  function maybeOfferMigration() {
    if (readStorage(MIGRATION_KEY) === "done") return;
    // Only offered once, ever, and only while the account has nothing saved
    // yet -- an account that already has a saved layout has already been
    // through this decision one way or another.
    if (layouts.length > 0) { writeStorage(MIGRATION_KEY, "done"); return; }
    let current;
    try { current = wall.cells(); } catch { current = null; }
    const hasCamera = current && Array.isArray(current.cells) && current.cells.some((c) => c && c.kind === "camera");
    if (!current || !current.shapeId || !hasCamera) { writeStorage(MIGRATION_KEY, "done"); return; }
    clearChildren(dom.migrationBanner);
    dom.migrationBanner.hidden = false;
    const yes = el(doc, "button", { type: "button", text: "Save this browser's current layout to your account" });
    const no = el(doc, "button", { type: "button", text: "No thanks" });
    yes.addEventListener("click", () => {
      writeStorage(MIGRATION_KEY, "done");
      dom.migrationBanner.hidden = true;
      void saveLayout("My layout", current.shapeId, cellsForSave(current.cells));
    });
    no.addEventListener("click", () => {
      writeStorage(MIGRATION_KEY, "done");
      dom.migrationBanner.hidden = true;
    });
    dom.migrationBanner.append(
      el(doc, "p", { text: "Today's grid lives only in this browser, and is lost on a new phone or a cleared browser. Save it to your account?" }),
      yes, no,
    );
  }

  async function load() {
    let res;
    try {
      res = await fetchFn("/layouts", { credentials: "same-origin" });
    } catch (err) {
      log("error", "layouts load failed", { message: err && err.message });
      dom.statusEl.textContent = "Could not reach the recorder.";
      return;
    }
    if (res.status === 401 || res.status === 403) { container.hidden = true; return; }
    const data = await res.json().catch(() => null);
    if (!data || data.ok === false) {
      dom.statusEl.textContent = (data && data.message) || "Could not load layouts.";
      return;
    }
    layouts = Array.isArray(data.layouts) ? data.layouts : [];
    defaultName = data.defaultName ?? null;
    if (data.problem) dom.statusEl.textContent = data.problem;
    renderList();
    maybeOfferMigration();
  }

  async function init() {
    let res;
    try {
      res = await fetchFn("/auth/state", { credentials: "same-origin" });
    } catch (err) {
      dom.statusEl.textContent = "Could not reach the recorder.";
      return;
    }
    const state = await res.json().catch(() => null);
    if (!state || !state.principal || state.principal.kind !== "user") {
      // A display, or nobody signed in: this control has nothing to offer.
      container.hidden = true;
      return;
    }
    await load();
  }

  const ready = init();
  return { ready, reload: load, dom };
}

/* ── a paired display's own read-only poll ───────────────────────────── */

/**
 * A display's own assigned layout (SITE-SETTINGS-SPEC.md: "the wall shows it
 * on load and when it changes (poll 60 s)"). No-ops entirely for anything
 * other than a display principal -- there is no id in GET /display-layout
 * to name a different one, and there is nothing for an operator's own
 * browser to poll here (that is startLayoutControls above, and its explicit
 * "Load" button).
 */
export function startDisplayLayoutPoll(opts) {
  const fetchFn = opts.fetchFn;
  const applyLayout = typeof opts.applyLayout === "function" ? opts.applyLayout : () => {};
  const clearLayout = typeof opts.clearLayout === "function" ? opts.clearLayout : () => {};
  const intervalMs = typeof opts.intervalMs === "number" && opts.intervalMs > 0 ? opts.intervalMs : DISPLAY_POLL_MS;
  const setIntervalFn = opts.setIntervalFn;
  const clearIntervalFn = opts.clearIntervalFn;
  const log = typeof opts.log === "function" ? opts.log : () => {};

  let timer = null;
  let isDisplay = false;

  async function poll() {
    let res;
    try {
      res = await fetchFn("/display-layout", { credentials: "same-origin" });
    } catch (err) {
      log("error", "display layout poll failed", { message: err && err.message });
      return;
    }
    if (res.status === 403) return; // not a display credential after all -- nothing to fix by retrying
    const data = await res.json().catch(() => null);
    if (!data || data.ok === false) return;
    if (data.layout && Array.isArray(data.layout.cells) && typeof data.layout.layout === "string") {
      applyLayout(data.layout.layout, data.layout.cells);
    } else {
      // Never assigned yet: back to the ordinary auto grid, not a blank hold.
      clearLayout();
    }
  }

  async function init() {
    let res;
    try {
      res = await fetchFn("/auth/state", { credentials: "same-origin" });
    } catch {
      return;
    }
    const state = await res.json().catch(() => null);
    if (!state || !state.principal || state.principal.kind !== "display") return;
    isDisplay = true;
    await poll();
    if (setIntervalFn) timer = setIntervalFn(poll, intervalMs);
  }

  const ready = init();
  return {
    ready,
    poll,
    get isDisplay() { return isDisplay; },
    stop() {
      if (timer !== null && typeof clearIntervalFn === "function") clearIntervalFn(timer);
      timer = null;
    },
  };
}

// Browser bootstrap. Runs only when the real Live page has #layoutControls
// in the DOM; a harness importing this module for its pure exports
// (cellsForSave, rawCellsFromView, describeLayoutReason, ...) or driving
// startLayoutControls/startDisplayLayoutPoll directly with a fake wall has
// no side effects here. Copies camera-page-bootstrap-lesson (agent bus,
// 2026-09-26) -- see harness/layoutClientPage.harness.mjs's own copy of
// activityPage.harness.mjs's THE FEARED ONE check.
//
// The wall instance itself is bridged through `window.__campLatWall`, set by
// index.html's own inline script immediately after it creates the wall --
// this module is loaded by its own <script> tag, so it cannot reach a
// variable local to that other script's scope any other way, and it must
// never re-create a second wall of its own.
if (typeof document !== "undefined" &&
    typeof document.getElementById === "function" &&
    document.getElementById("layoutControls")) {
  const wall = typeof window !== "undefined" ? window.__campLatWall : undefined;
  const fetchFn = function (url, init) { return fetch(url, init); };
  let storage;
  try { storage = window.localStorage; } catch { storage = undefined; }
  startLayoutControls({
    doc: document,
    fetchFn,
    wall,
    storage,
    confirmFn: function (msg) { return window.confirm(msg); },
    log: () => {},
  });
  startDisplayLayoutPoll({
    doc: document,
    fetchFn,
    setIntervalFn: function (fn, ms) { return window.setInterval(fn, ms); },
    clearIntervalFn: function (id) { window.clearInterval(id); },
    applyLayout: function (shapeId, cells) { if (wall) wall.setExplicitLayout(shapeId, cells); },
    clearLayout: function () { if (wall) wall.clearExplicitLayout(); },
    log: () => {},
  });
}
