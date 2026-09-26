/**
 * Named wall layouts on the Live page (agent/ui/layout-client.mjs),
 * SITE-SETTINGS-SPEC.md section 3, run without a browser: the round-trips
 * (cellsForSave, rawCellsFromView), the account save/load/default UI driven
 * against a fake wall instance, the display's own read-only poll, and the
 * removed-camera cell a loaded layout hands the wall unchanged.
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/layoutClientPage.harness.mjs`.
 *
 * THE FEARED FAILURES:
 *  - "save the current grid" disagreeing with what cells() actually reports
 *    (cellsForSave re-sorting or re-deriving instead of reading it back).
 *  - a removed cell round-tripping through a save into a plain empty one --
 *    rawCellsFromView must keep its cameraId, the WHOLE point of "camera
 *    removed" surviving a resave of some OTHER layout in the same account.
 *  - the migration offer appearing twice, or moving data on "no thanks".
 *  - a display's poll running for an ordinary operator account, or an
 *    operator's save/load UI running for a display.
 *  - a client with no browser bootstrap passing every check that drives its
 *    exported functions directly while the real page never fetches anything
 *    (camera-page-bootstrap-lesson, agent bus, 2026-09-26).
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { check, eq, same, report } from "./_assert.mjs";

const root = process.cwd();
const client = await import(pathToFileURL(join(root, "agent/ui/layout-client.mjs")).href);
const contract = await import(pathToFileURL(join(root, "dist/savedLayouts.js")).href);

console.log("layout client page");

/* ------------------------------------------------------------------ */
/* A small fake DOM.                                                   */
/* ------------------------------------------------------------------ */

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.disabled = false;
    this.value = "";
    this.hidden = false;
    this._text = "";
    this._listeners = new Map();
    this._attrs = new Map();
  }
  set innerHTML(_) {
    throw new Error("layout-client.mjs must not use innerHTML");
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...kids) {
    for (const k of kids) this.appendChild(k);
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...kids) {
    for (const c of this.children.slice()) this.removeChild(c);
    this.append(...kids);
  }
  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null;
  }
  set textContent(v) {
    this._text = v === null || v === undefined ? "" : String(v);
    this.children = [];
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  setAttribute(name, value) {
    this._attrs.set(String(name), String(value));
    if (name === "id") this.id = String(value);
    // Real DOM elements reflect the boolean "hidden" attribute onto the IDL
    // property automatically; this fake only sets it here so that
    // `el(doc, tag, { hidden: true })` (used for a control's INITIAL state)
    // agrees with a later direct `.hidden = false` assignment (used for
    // every toggle after that) -- el() itself only ever calls setAttribute
    // for a `true` boolean flag, never for `false`.
    if (name === "hidden") this.hidden = true;
  }
  getAttribute(name) {
    return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null;
  }
  addEventListener(type, fn) {
    const list = this._listeners.get(type) ?? [];
    list.push(fn);
    this._listeners.set(type, list);
  }
  fire(type) {
    for (const fn of this._listeners.get(type) ?? []) fn({ target: this });
  }
}

function all(el, out = []) {
  out.push(el);
  for (const c of el.children) all(c, out);
  return out;
}
const byIdIn = (rootEl, id) => all(rootEl).find((e) => e.id === id);
const withText = (rootEl, text) => all(rootEl).filter((e) => e.textContent === text);

function fakeDoc() {
  const body = new FakeEl("div");
  return {
    _body: body,
    createElement: (tag) => new FakeEl(tag),
    getElementById: (id) => (byIdIn(body, id) ?? null),
    mount(el) { body.appendChild(el); },
  };
}

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function makeFetchFrom(routes) {
  const calls = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      const key = `${(init && init.method) || "GET"} ${url.split("?")[0]}`;
      const handler = routes[key];
      if (!handler) return jsonRes(404, { ok: false });
      return handler(url, init);
    },
  };
}

/** A minimal stand-in for wall-client.mjs's own instance -- just the three
 *  methods layout-client.mjs ever calls on it. */
function fakeWall(initialCells) {
  const calls = [];
  let cells = initialCells || { shapeId: "2x2", cells: [{ kind: "camera", index: 0, cameraId: "cam1" }] };
  return {
    calls,
    cells: () => cells,
    setExplicitLayout: (shapeId, resolvedCells) => { calls.push({ op: "load", shapeId, cells: resolvedCells }); },
    clearExplicitLayout: () => { calls.push({ op: "clear" }); },
  };
}

/* ------------------------------------------------------------------ */
/* Pure helpers.                                                       */
/* ------------------------------------------------------------------ */

check("MAX_LAYOUT_NAME_LENGTH matches the contract it mirrors", () => {
  eq(client.MAX_LAYOUT_NAME_LENGTH, contract.MAX_LAYOUT_NAME_LENGTH);
});

check("cellsForSave reads back exactly what the wall rendered, in index order", () => {
  const rendered = [
    { kind: "empty", index: 1 },
    { kind: "camera", index: 0, cameraId: "cam1" },
    { kind: "camera", index: 2, cameraId: "cam2" },
  ];
  eq(client.cellsForSave(rendered), ["cam1", null, "cam2"]);
});

check("THE FEARED ONE: a removed cell survives a round trip -- rawCellsFromView keeps its cameraId, never collapsing it to null like an empty cell", () => {
  const view = [
    { kind: "camera", index: 0, cameraId: "cam1" },
    { kind: "removed", index: 1, cameraId: "cam9-gone" },
    { kind: "empty", index: 2 },
  ];
  eq(client.rawCellsFromView(view), ["cam1", "cam9-gone", null]);
});

check("describeLayoutReason never echoes an unrecognised code, but never hides one either", () => {
  eq(client.describeLayoutReason("duplicate_layout_name"), "is already used by another saved layout");
  eq(client.describeLayoutReason("something_new"), "something_new");
});

/* ------------------------------------------------------------------ */
/* The account's own save / load / default UI.                         */
/* ------------------------------------------------------------------ */

function mountControls(doc) {
  const container = new FakeEl("div");
  container.setAttribute("id", "layoutControls");
  doc.mount(container);
  return container;
}

await check("does nothing at all for a display principal -- a display never edits it", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const wall = fakeWall();
  const { fetchFn, calls } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "display", displayId: "wall-1" } }),
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall });
  await ctl.ready;
  eq(calls.some((c) => c.url === "/layouts"), false, "never asked for the account's own layouts");
  eq(doc.getElementById("layoutControls").hidden, true, "and the control hides itself");
});

await check("loads the account's saved layouts and renders one row per layout, the default marked", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const wall = fakeWall();
  const layouts = [
    { name: "Front counter", layout: "2x2", cells: [{ kind: "camera", index: 0, cameraId: "cam1" }, { kind: "empty", index: 1 }, { kind: "empty", index: 2 }, { kind: "empty", index: 3 }] },
    { name: "Back lot", layout: "1x1", cells: [{ kind: "camera", index: 0, cameraId: "cam2" }] },
  ];
  const { fetchFn } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "store" } }),
    "GET /layouts": () => jsonRes(200, { ok: true, layouts, defaultName: "Back lot", problem: null }),
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall, storage: null });
  await ctl.ready;
  eq(withText(ctl.dom.listEl, "Front counter").length, 1, "first layout named");
  eq(withText(ctl.dom.listEl, "Back lot").length, 1, "second layout named");
  const defaultButtons = all(ctl.dom.listEl).filter((e) => e.tagName === "BUTTON" && e.textContent === "Default");
  eq(defaultButtons.length, 1, "exactly one row already marked default");
});

await check("Load calls the wall's own setExplicitLayout with the saved shape and resolved cells, untouched", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const wall = fakeWall();
  const cells = [{ kind: "camera", index: 0, cameraId: "cam1" }, { kind: "removed", index: 1, cameraId: "cam9-gone" }];
  const { fetchFn } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "installer" } }),
    "GET /layouts": () => jsonRes(200, { ok: true, layouts: [{ name: "Lot", layout: "2x2", cells }], defaultName: null, problem: null }),
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall });
  await ctl.ready;
  const loadBtn = all(ctl.dom.listEl).find((e) => e.tagName === "BUTTON" && e.textContent === "Load");
  loadBtn.fire("click");
  eq(wall.calls, [{ op: "load", shapeId: "2x2", cells }], "handed to the wall exactly as the server resolved it");
});

await check("saving the current grid posts a full-replace body carrying every OTHER saved layout back out unchanged", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const existingRaw = [{ kind: "camera", index: 0, cameraId: "camX" }, { kind: "removed", index: 1, cameraId: "cam9-gone" }];
  const wall = fakeWall({ shapeId: "1x1", cells: [{ kind: "camera", index: 0, cameraId: "cam3" }] });
  let posted = null;
  const { fetchFn } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "installer" } }),
    "GET /layouts": () => jsonRes(200, { ok: true, layouts: [{ name: "Existing", layout: "2x2", cells: existingRaw }], defaultName: "Existing", problem: null }),
    "POST /layouts": (url, init) => {
      posted = JSON.parse(init.body);
      return jsonRes(200, { ok: true, layouts: posted.layouts, defaultName: posted.defaultName });
    },
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall });
  await ctl.ready;
  ctl.dom.nameInput.value = "New one";
  ctl.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(posted.layouts.length, 2, "the existing layout plus the new one");
  const existingOut = posted.layouts.find((l) => l.name === "Existing");
  eq(existingOut.cells, ["camX", "cam9-gone"], "THE FEARED ONE: the other layout's removed cell survived the round trip, never collapsed to null");
  const newOut = posted.layouts.find((l) => l.name === "New one");
  eq(newOut, { name: "New one", layout: "1x1", cells: ["cam3"] }, "the new one, from wall.cells() exactly");
  eq(posted.defaultName, "Existing", "an existing default is never silently replaced by a new save");
});

await check("the very first saved layout becomes the account's default, without being asked twice", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const wall = fakeWall({ shapeId: "2x2", cells: [{ kind: "camera", index: 0, cameraId: "cam1" }] });
  let posted = null;
  const { fetchFn } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "store" } }),
    "GET /layouts": () => jsonRes(200, { ok: true, layouts: [], defaultName: null, problem: null }),
    "POST /layouts": (url, init) => {
      posted = JSON.parse(init.body);
      return jsonRes(200, { ok: true, layouts: posted.layouts, defaultName: posted.defaultName });
    },
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall });
  await ctl.ready;
  ctl.dom.nameInput.value = "My first";
  ctl.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(posted.defaultName, "My first", "the account's very first layout");
});

await check("a 400 from the server lists every field problem, in plain words", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const wall = fakeWall();
  const { fetchFn } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "store" } }),
    "GET /layouts": () => jsonRes(200, { ok: true, layouts: [], defaultName: null, problem: null }),
    "POST /layouts": () => jsonRes(400, { ok: false, code: "invalid", errors: [{ field: "layouts[0].name", reason: "bad_name" }] }),
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall });
  await ctl.ready;
  ctl.dom.nameInput.value = "x";
  ctl.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(ctl.dom.errorsEl.textContent.includes(`needs a name, at most ${client.MAX_LAYOUT_NAME_LENGTH} characters`), true, ctl.dom.errorsEl.textContent);
});

await check("Delete asks for confirmation, and does nothing at all when refused", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const wall = fakeWall();
  const { fetchFn, calls } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "store" } }),
    "GET /layouts": () => jsonRes(200, { ok: true, layouts: [{ name: "Lot", layout: "1x1", cells: [{ kind: "camera", index: 0, cameraId: "cam1" }] }], defaultName: "Lot", problem: null }),
    "POST /layouts": () => jsonRes(200, { ok: true, layouts: [], defaultName: null }),
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall, confirmFn: () => false });
  await ctl.ready;
  const delBtn = all(ctl.dom.listEl).find((e) => e.tagName === "BUTTON" && e.textContent === "Delete");
  delBtn.fire("click");
  await new Promise((r) => setTimeout(r, 10));
  eq(calls.some((c) => c.init && c.init.method === "POST"), false, "refused confirm means nothing was sent");
});

/* ------------------------------------------------------------------ */
/* The one-time migration offer.                                       */
/* ------------------------------------------------------------------ */

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

await check("offers to migrate the browser's own grid once, only when the account has nothing saved yet", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const wall = fakeWall({ shapeId: "2x2", cells: [{ kind: "camera", index: 0, cameraId: "cam1" }] });
  const storage = fakeStorage();
  const { fetchFn } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "store" } }),
    "GET /layouts": () => jsonRes(200, { ok: true, layouts: [], defaultName: null, problem: null }),
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall, storage });
  await ctl.ready;
  eq(ctl.dom.migrationBanner.hidden, false, "offered");
});

await check("saying yes to the offer saves the current grid and never offers again", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const wall = fakeWall({ shapeId: "2x2", cells: [{ kind: "camera", index: 0, cameraId: "cam1" }] });
  const storage = fakeStorage();
  let posted = null;
  const { fetchFn } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "store" } }),
    "GET /layouts": () => jsonRes(200, { ok: true, layouts: [], defaultName: null, problem: null }),
    "POST /layouts": (url, init) => { posted = JSON.parse(init.body); return jsonRes(200, { ok: true, layouts: posted.layouts, defaultName: posted.defaultName }); },
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall, storage });
  await ctl.ready;
  const yesBtn = all(ctl.dom.migrationBanner).find((e) => e.tagName === "BUTTON" && e.textContent.includes("Save this browser's current layout"));
  yesBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(posted.layouts.length, 1, "the browser's grid was saved");
  eq(storage.getItem("camplat.layouts.migrationOffered"), "done", "never offered again");
});

await check("saying no thanks flags the offer done and moves nothing", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const wall = fakeWall({ shapeId: "2x2", cells: [{ kind: "camera", index: 0, cameraId: "cam1" }] });
  const storage = fakeStorage();
  const { fetchFn, calls } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "store" } }),
    "GET /layouts": () => jsonRes(200, { ok: true, layouts: [], defaultName: null, problem: null }),
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall, storage });
  await ctl.ready;
  const noBtn = all(ctl.dom.migrationBanner).find((e) => e.tagName === "BUTTON" && e.textContent === "No thanks");
  noBtn.fire("click");
  eq(storage.getItem("camplat.layouts.migrationOffered"), "done", "the offer will not come back");
  eq(calls.some((c) => c.init && c.init.method === "POST"), false, "nothing moved on its own");
});

await check("a wall with nothing on screen yet is not offered a migration for an empty grid", async () => {
  const doc = fakeDoc();
  mountControls(doc);
  const wall = fakeWall({ shapeId: "2x2", cells: [{ kind: "empty", index: 0 }, { kind: "empty", index: 1 }] });
  const storage = fakeStorage();
  const { fetchFn } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "store" } }),
    "GET /layouts": () => jsonRes(200, { ok: true, layouts: [], defaultName: null, problem: null }),
  });
  const ctl = client.startLayoutControls({ doc, fetchFn, wall, storage });
  await ctl.ready;
  eq(ctl.dom.migrationBanner.hidden, true, "nothing worth migrating");
});

/* ------------------------------------------------------------------ */
/* The display's own read-only poll.                                   */
/* ------------------------------------------------------------------ */

function fakeTimers() {
  const live = new Map();
  let next = 1;
  return {
    setIntervalFn: (fn, ms) => { live.set(next, { fn, ms }); return next++; },
    clearIntervalFn: (id) => live.delete(id),
    tick() { for (const { fn } of [...live.values()]) fn(); },
    get count() { return live.size; },
  };
}

await check("a display applies its assigned layout on load and every 60s, exactly as the server resolved it", async () => {
  const applied = [];
  const timers = fakeTimers();
  const cells = [{ kind: "camera", index: 0, cameraId: "cam1" }, { kind: "removed", index: 1, cameraId: "cam9-gone" }];
  const { fetchFn } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "display", displayId: "wall-1" } }),
    "GET /display-layout": () => jsonRes(200, { ok: true, layout: { layout: "2x2", cells }, problem: null }),
  });
  const poll = client.startDisplayLayoutPoll({
    fetchFn, setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn,
    applyLayout: (shapeId, resolvedCells) => applied.push({ shapeId, cells: resolvedCells }),
  });
  await poll.ready;
  eq(applied, [{ shapeId: "2x2", cells }], "applied once on load, exactly as resolved");
  eq(timers.count, 1, "one 60s timer");
  applied.length = 0;
  timers.tick();
  await new Promise((r) => setTimeout(r, 10));
  eq(applied.length, 1, "polled again");
});

await check("a display with no assignment yet clears back to the auto grid, never holds a blank", async () => {
  const cleared = [];
  const { fetchFn } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "display", displayId: "wall-1" } }),
    "GET /display-layout": () => jsonRes(200, { ok: true, layout: null, problem: null }),
  });
  const poll = client.startDisplayLayoutPoll({ fetchFn, clearLayout: () => cleared.push(true) });
  await poll.ready;
  eq(cleared, [true]);
});

await check("does nothing at all for an ordinary operator account -- this is the display's own poll only", async () => {
  const { fetchFn, calls } = makeFetchFrom({
    "GET /auth/state": () => jsonRes(200, { ok: true, principal: { kind: "user", username: "alice", role: "installer" } }),
  });
  const poll = client.startDisplayLayoutPoll({ fetchFn, applyLayout: () => { throw new Error("must never be called"); } });
  await poll.ready;
  eq(poll.isDisplay, false);
  eq(calls.some((c) => c.url === "/display-layout"), false, "never even asked");
});

/* ------------------------------------------------------------------ */
/* No innerHTML anywhere in this client.                               */
/* ------------------------------------------------------------------ */

check("layout-client.mjs never uses innerHTML", async () => {
  const src = await readFile(join(root, "agent/ui/layout-client.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  eq(code.includes("innerHTML"), false);
});

/* ------------------------------------------------------------------ */
/* THE FEARED ONE: the browser starts this itself.                     */
/* ------------------------------------------------------------------ */

await check("THE FEARED ONE: in a browser the page STARTS ITSELF -- loading layout-client.mjs with the real page in the DOM fetches /layouts and /display-layout with no harness calling it", () => {
  const clientUrl = pathToFileURL(join(root, "agent/ui/layout-client.mjs")).href;
  const code = `
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => "";
        if (k === "then") return undefined;
        if (k === "value" || k === "textContent") return "";
        if (k === "length") return 0;
        return fake;
      },
      apply() { return fake; },
      set() { return true; },
    };
    const fake = new Proxy(function () {}, handler);
    const calls = [];
    globalThis.document = {
      getElementById: (id) => (id === "layoutControls" ? fake : null),
      createElement: () => fake, createElementNS: () => fake,
      createTextNode: () => fake, querySelector: () => fake, querySelectorAll: () => [],
      addEventListener() {}, body: fake, documentElement: fake,
    };
    globalThis.window = {
      location: { assign() {} }, addEventListener() {}, localStorage: undefined,
      setInterval: () => 1, clearInterval: () => {}, confirm: () => true,
      // The bridge index.html sets right after creating its own wall -- see
      // layout-client.mjs's bottom bootstrap comment.
      __campLatWall: { cells: () => ({ shapeId: "2x2", cells: [] }), setExplicitLayout() {}, clearExplicitLayout() {} },
    };
    globalThis.fetch = (url) => {
      calls.push(String(url));
      if (String(url).includes("/auth/state")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, principal: { kind: "user", username: "alice", role: "installer" } }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, layouts: [], defaultName: null, problem: null }) });
    };
    await import(${JSON.stringify(clientUrl)} + "?boot");
    await new Promise((r) => setTimeout(r, 150));
    console.log(JSON.stringify(calls));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", cwd: root, timeout: 20_000 });
  eq(r.status, 0, `the child ran (${(r.stderr || "").slice(0, 400)})`);
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  const calls = JSON.parse(lines[lines.length - 1] || "[]");
  eq(calls.includes("/layouts"), true, `it asked for /layouts on its own: ${JSON.stringify(calls)}`);
  eq(calls.filter((u) => u === "/auth/state").length >= 1, true, "and checked who is signed in");
});

/* ── the Layouts panel never renders off-screen ─────────────────────────── */

await check("FEARED: the .layoutctl-panel is anchored so it can never land off the left edge of the viewport", async () => {
  // Found 2026-09-26 and reproduced in a real browser at 375px width (and,
  // separately, at desktop widths whenever the trigger sits near the left):
  // `.layoutctl-wrap` (the trigger button's own wrapper) is
  // `position: relative`, small -- only as wide as the "Layouts" button --
  // and `.layoutctl-panel` was `position: absolute; right: 0`, which anchors
  // the panel's RIGHT edge to the WRAP's right edge (the trigger's own
  // right edge). #layoutControls is a sibling of #controls in a flex-wrap
  // row (index.html's own markup), so on a narrow viewport -- or any time
  // the trigger is left-anchored at all, not just on a phone -- the wrap
  // sits near x=0, and up to `min(360px, 100vw-32px)` of panel width
  // extends LEFTWARD from there: measured live, 74% of the panel (name
  // field, save button, every row's Load/Set default/Delete) rendered at a
  // negative X, off-screen, with document.documentElement.scrollWidth
  // reporting no overflow at all (a negatively-positioned absolute element
  // never registers as horizontal overflow) -- so a scrollWidth check alone
  // cannot catch this class of bug; the CSS rule itself must be checked.
  //
  // The fix anchors the panel from the trigger's LEFT edge instead, so it
  // only ever grows rightward from wherever the trigger already is -- which
  // this page's own layout keeps on-screen (the trigger is never placed so
  // far right that its own width plus min(360px, 100vw-32px) would overflow
  // the other edge).
  const html = await readFile(join(root, "agent/ui/index.html"), "utf8");
  const m = /\.layoutctl-panel\s*\{([^}]*)\}/.exec(html);
  eq(m !== null, true, "a .layoutctl-panel rule exists");
  const decl = m[1];
  eq(/\bposition:\s*absolute\b/.test(decl), true, "still absolutely positioned (this check assumes that)");
  eq(/\bleft:\s*0\b/.test(decl), true, "FEARED: anchored from the left, so it grows away from x=0, never past it");
  eq(/\bright:\s*0\b/.test(decl), false, "FEARED: must NOT also anchor from the right -- that reintroduces the negative-X bug for a left-sitting trigger");
});

report("layout client page");
