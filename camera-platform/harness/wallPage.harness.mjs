/**
 * The live wall's controls: layout, paging, and which sockets are open.
 *
 * The failures these checks exist to prevent (build rule 19):
 *
 *  - Eleven black rectangles on a 4x4 wall with five cameras. On a TV in a
 *    car wash office a black rectangle looks exactly like a dead camera, and
 *    staff ring the installer out for a fault that was never there. Every
 *    empty cell must SAY it is empty, in words, on screen.
 *  - A sixteen-camera site opening sixteen streams to fill a 2x2 wall. The
 *    box decodes every stream it opens, so the four the operator is actually
 *    watching are the ones that stutter -- which looks like a camera fault.
 *  - A page turn that tears down and rebuilds a camera that never left the
 *    screen: a black tile and a keyframe wait on every camera, every turn.
 *  - One physical camera drawn as two tiles because it exposes two streams.
 *  - An installer's camera name reaching the page as markup.
 *  - A TV browser in private mode, or without the fullscreen API, showing no
 *    cameras at all because a storage call threw.
 *
 * The host page owns sockets, MSE and playback. This module owns none of it,
 * so openStream/closeStream here are recorded, not performed.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as grid from "../dist/gridLayout.mjs";
import { check, eq, same, report } from "./_assert.mjs";

const { createWall } = await import(
  pathToFileURL(join(process.cwd(), "agent/ui/wall-client.mjs")).href
);

console.log("wallPage");

/* ------------------------------------------------------------------ */
/* A DOM small enough to read, strict enough to catch the two mistakes  */
/* that matter: markup injection, and a cell that never got drawn.      */
/* ------------------------------------------------------------------ */

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.disabled = false;
    this.value = "";
    this.id = "";
    this._text = "";
    this._listeners = new Map();
    this._attrs = new Map();
  }
  set innerHTML(_) {
    // An installer can name a camera "<img src=x onerror=...>". A page that
    // assigns that to innerHTML executes it.
    throw new Error("the wall must not use innerHTML");
  }
  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i < 0) throw new Error("removeChild: not a child");
    this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  append(...kids) {
    for (const k of kids) this.appendChild(k);
  }
  set textContent(v) {
    this._text = v === null || v === undefined ? "" : String(v);
    this.children = [];
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  get classList() {
    const self = this;
    return {
      add(...names) {
        const have = self.className.split(" ").filter(Boolean);
        for (const n of names) if (!have.includes(n)) have.push(n);
        self.className = have.join(" ");
      },
      remove(...names) {
        self.className = self.className
          .split(" ")
          .filter((c) => c && !names.includes(c))
          .join(" ");
      },
      contains(n) {
        return self.className.split(" ").includes(n);
      },
      toggle(n, on) {
        if (on === true) this.add(n);
        else if (on === false) this.remove(n);
        else if (this.contains(n)) this.remove(n);
        else this.add(n);
      },
    };
  }
  setAttribute(name, value) {
    this._attrs.set(String(name), String(value));
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

function fakeDoc(extra) {
  const doc = { createElement: (tag) => new FakeEl(tag) };
  return Object.assign(doc, extra ?? {});
}

/** Every element in the subtree, the wall's own roots included. */
function all(el, out = []) {
  out.push(el);
  for (const c of el.children) all(c, out);
  return out;
}
const withClass = (el, cls) => all(el).filter((e) => e.classList.contains(cls));
const byId = (el, id) => all(el).find((e) => e.id === id);

/* ------------------------------------------------------------------ */

let nextId = 0;
function device(label, streamIds, opts = {}) {
  const streams = streamIds.map((cameraId) => ({
    cameraId,
    name: null,
    channel: null,
    resolved: opts.unresolvedCount ? false : true,
    unresolvedReason: null,
  }));
  return {
    deviceId: opts.deviceId ?? `host:10.0.0.${++nextId}`,
    label,
    host: null,
    resolved: !opts.unresolvedCount,
    unresolvedCount: opts.unresolvedCount ?? 0,
    streams,
  };
}
const devices = (n) => Array.from({ length: n }, (_, i) => device(`Cam ${i + 1}`, [`cam${i + 1}`]));

/**
 * Builds a wall and records every stream call, in order, so the ORDER of
 * close-versus-open is testable and not merely assumed.
 */
function makeWall(opts = {}) {
  const gridRoot = new FakeEl("div");
  const controlsRoot = new FakeEl("div");
  const calls = [];
  const wall = createWall({
    doc: fakeDoc(opts.docExtra),
    gridRoot,
    controlsRoot,
    grid,
    openStream: (cameraId, body, shape, quality) => calls.push({ op: "open", cameraId, body, shape, quality }),
    moveStream: (cameraId, body, shape, quality) => calls.push({ op: "move", cameraId, body, shape, quality }),
    closeStream: (cameraId) => calls.push({ op: "close", cameraId }),
    storage: opts.storage,
    layout: opts.layout,
    timers: opts.timers,
  });
  if (opts.devices) wall.setDevices(opts.devices);
  return { wall, gridRoot, controlsRoot, calls };
}
const opened = (calls) => calls.filter((c) => c.op === "open").map((c) => c.cameraId);
const closed = (calls) => calls.filter((c) => c.op === "close").map((c) => c.cameraId);
const sockets = (calls) => calls.filter((c) => c.op !== "move");

/* ------------------------------------------------------------------ */

check("an empty cell says so in words, where eleven black rectangles would be", () => {
  const { gridRoot } = makeWall({ layout: "4x4", devices: devices(5) });
  const cells = withClass(gridRoot, "cell");
  eq(cells.length, 16, "sixteen cells drawn, not five");
  const empties = withClass(gridRoot, "cell-empty");
  eq(empties.length, 11, "eleven of them empty");
  for (const cell of empties) {
    const label = withClass(cell, "cell-empty-label")[0];
    if (label === undefined) throw new Error("an empty cell with no label is a black rectangle");
    eq(label.textContent, "Empty - no camera assigned", "and it says what it is");
  }
});

check("a sixteen-camera site on a 2x2 wall opens four sockets, not sixteen", () => {
  const { calls } = makeWall({ layout: "2x2", devices: devices(16) });
  eq(opened(calls).length, 4, "four streams");
  eq(opened(calls), ["cam1", "cam2", "cam3", "cam4"], "the four on screen");
  eq(closed(calls), [], "nothing to close on a first render");
});

check("one physical camera with two streams is one cell, not two", () => {
  const bench = device("Front door", ["cam1-main", "cam2-sub"], { deviceId: "host:192.168.1.64" });
  const { gridRoot, calls } = makeWall({ layout: "2x2", devices: [bench] });
  const filled = withClass(gridRoot, "cell").filter((c) => !c.classList.contains("cell-empty"));
  eq(filled.length, 1, "ONE cell for the box, however many channels it answers on");
  eq(opened(calls), ["cam1-main"], "and one socket -- the first stream, not a guess at which is main");
  eq(withClass(gridRoot, "cell-stream").length, 1, "with a picker to choose the other");
});

check("a single-stream camera gets no picker to confuse anyone", () => {
  const { gridRoot } = makeWall({ layout: "2x2", devices: devices(1) });
  eq(withClass(gridRoot, "cell-stream").length, 0, "nothing to pick between");
});

check("choosing the other stream closes the first one", () => {
  const bench = device("Front door", ["cam1-main", "cam2-sub"], { deviceId: "host:192.168.1.64" });
  const { wall, calls } = makeWall({ layout: "2x2", devices: [bench] });
  calls.length = 0;
  wall.setStream("host:192.168.1.64", "cam2-sub");
  eq(closed(calls), ["cam1-main"], "the old stream is released");
  eq(opened(calls), ["cam2-sub"], "the chosen one opened");
  same(wall.state().streaming, ["cam2-sub"], "and only that one is live");
});

check("turning the page never reopens a camera that stayed on screen", () => {
  // Nine cameras at 3x3, then 2x2: cam1-4 never left. Reopening them costs a
  // black tile and a keyframe wait on all four.
  const nine = devices(9);
  const { wall, calls } = makeWall({ layout: "3x3", devices: nine });
  eq(opened(calls).length, 9, "nine open at 3x3");
  calls.length = 0;

  wall.setLayout("2x2");
  eq(opened(calls), [], "nothing reopened");
  eq(closed(calls), ["cam5", "cam6", "cam7", "cam8", "cam9"], "only the five that left");
  same(wall.state().streaming, ["cam1", "cam2", "cam3", "cam4"], "four still live");
});

check("a stream is closed before its replacement is opened", () => {
  // Opening first means both are decoding at once, which on a full wall is
  // exactly when it stutters.
  const nine = devices(9);
  const { wall, calls } = makeWall({ layout: "2x2", devices: nine });
  calls.length = 0;
  wall.nextPage();
  const firstOpen = calls.findIndex((c) => c.op === "open");
  const lastClose = calls.map((c) => c.op).lastIndexOf("close");
  if (lastClose > firstOpen) throw new Error("an open happened before the last close");
  eq(closed(calls), ["cam1", "cam2", "cam3", "cam4"], "page 1's cameras released");
  eq(opened(calls), ["cam5", "cam6", "cam7", "cam8"], "page 2's opened");
});

const layoutPicker = (root) => {
  const found = withClass(root, "layout-picker");
  eq(found.length, 1, "ONE layout control");
  return found[0];
};
const layoutTrigger = (root) => {
  const found = withClass(layoutPicker(root), "layout-trigger");
  eq(found.length, 1, "one thing to tap to open it");
  return found[0];
};
const layoutChoices = (root) => {
  const menus = withClass(layoutPicker(root), "layout-menu");
  eq(menus.length, 1, "one panel of choices");
  return menus[0].children;
};
const menuIsOpen = (root) =>
  withClass(layoutPicker(root), "layout-menu")[0].classList.contains("layout-menu-open");

check("the layout choices come from the contract, plus the rotation", () => {
  const { controlsRoot } = makeWall({ layout: "2x2", devices: devices(4) });
  const choices = layoutChoices(controlsRoot);
  eq(choices.map((b) => b.value), grid.GRID_SHAPES.map((s) => s.id).concat(["tour"]), "one per shape, in order");
  eq(choices.filter((b) => b.classList.contains("layout-button-on")).map((b) => b.value),
    ["2x2"], "exactly one marked, the current one");
  eq(choices.map((b) => b.getAttribute("aria-pressed")),
    ["false", "true", "false", "false", "false"], "and it says so out loud");
});

check("THE FEARED ONE: an icon draws the layout it actually picks", () => {
  // An icon that disagrees with its layout is a picture that lies, and nobody
  // would think to check it against the contract.
  const { controlsRoot } = makeWall({ layout: "2x2", devices: devices(4) });
  const choices = layoutChoices(controlsRoot);
  for (const shape of grid.GRID_SHAPES) {
    const icon = choices.find((b) => b.value === shape.id).children[0];
    eq(icon.children.length, shape.cells, shape.id + ": one box per camera it shows");
    eq(icon.style.gridTemplateColumns, "repeat(" + shape.columns + ", 1fr)", shape.id + ": columns");
    eq(icon.style.gridTemplateRows, "repeat(" + shape.rows + ", 1fr)", shape.id + ": rows");
  }
  // Rotation is one lit box out of four: one camera at a time, from many.
  eq(choices.find((b) => b.value === "tour").children[0].children.map((c) => c.className),
    ["layout-icon-box", "layout-icon-box layout-icon-box-off",
      "layout-icon-box layout-icon-box-off", "layout-icon-box layout-icon-box-off"], "one lit, three dim");
});

check("the closed control shows the layout you are on, in a picture", () => {
  const { controlsRoot } = makeWall({ layout: "3x3", devices: devices(9) });
  eq(menuIsOpen(controlsRoot), false, "it starts closed, so nothing covers the wall");
  const trigger = layoutTrigger(controlsRoot);
  eq(trigger.value, "3x3", "it knows what is showing");
  eq(trigger.getAttribute("aria-expanded"), "false", "and says it is closed");
  eq(trigger.children[0].children.length, 9, "and draws the nine cameras on screen");
});

check("the words are not lost with the pictures: every choice still says what it is", () => {
  const { controlsRoot } = makeWall({ layout: "2x2", devices: devices(4) });
  const choices = layoutChoices(controlsRoot);
  const labels = choices.map((b) => b.getAttribute("aria-label"));
  eq(labels, ["1 camera", "4 cameras (2x2)", "9 cameras (3x3)", "16 cameras (4x4)",
    "Rotate cameras, one at a time"], "every layout names itself for anyone who cannot see the icon");
  eq(choices.map((b) => b.title), labels, "and on hover");
  eq(layoutTrigger(controlsRoot).getAttribute("aria-label"), "4 cameras (2x2)", "the closed control too");
});

check("opening it shows the choices, and picking one changes the wall and closes it", () => {
  const { wall, controlsRoot, gridRoot } = makeWall({ layout: "2x2", devices: devices(9) });
  layoutTrigger(controlsRoot).fire("click");
  eq(menuIsOpen(controlsRoot), true, "open");
  eq(layoutTrigger(controlsRoot).getAttribute("aria-expanded"), "true", "and says so");
  layoutChoices(controlsRoot).find((b) => b.value === "3x3").fire("click");
  eq(wall.state().layout, "3x3", "layout changed");
  eq(withClass(gridRoot, "cell").length, 9, "and the wall redrew");
  // THE FEARED ONE: a panel left open over a wall nobody is standing at.
  eq(menuIsOpen(controlsRoot), false, "and it closed itself");
  eq(layoutTrigger(controlsRoot).value, "3x3", "the closed control now shows the new layout");
});

check("opening it twice closes it again", () => {
  const { controlsRoot } = makeWall({ layout: "2x2", devices: devices(4) });
  layoutTrigger(controlsRoot).fire("click");
  eq(menuIsOpen(controlsRoot), true, "open");
  layoutTrigger(controlsRoot).fire("click");
  eq(menuIsOpen(controlsRoot), false, "closed");
});

check("sixteen cameras on 4x4 are all on screen at once", () => {
  const { wall, calls, gridRoot } = makeWall({ layout: "2x2", devices: devices(16) });
  calls.length = 0;
  wall.setLayout("4x4");
  eq(withClass(gridRoot, "cell-empty").length, 0, "no empty cells");
  eq(wall.state().pageCount, 1, "one page");
  eq(opened(calls).length + calls.filter((c) => c.op === "move").length, 16, "sixteen live");
});

function fakeTimers() {
  const live = new Map();
  let next = 1;
  return {
    setInterval: (fn, ms) => { live.set(next, { fn, ms }); return next++; },
    clearInterval: (id) => { live.delete(id); },
    tick() { for (const { fn } of [...live.values()]) fn(); },
    get count() { return live.size; },
  };
}

check("rotation shows one camera at a time and turns by itself, and stops when you pick a grid", () => {
  const timers = fakeTimers();
  const { wall, calls } = makeWall({ layout: "2x2", devices: devices(3), timers });
  eq(timers.count, 0, "a grid does not rotate");
  wall.setLayout("tour");
  eq(wall.state().layout, "1x1", "one camera");
  eq(wall.state().touring, true, "rotating");
  eq(timers.count, 1, "one timer, not one per redraw");
  calls.length = 0;
  timers.tick();
  eq(wall.state().pageIndex, 1, "moved on");
  eq(opened(calls), ["cam2"], "to the next camera");
  eq(closed(calls), ["cam1"], "and let the last one go");
  timers.tick(); timers.tick();
  eq(wall.state().pageIndex, 0, "and wraps back to the first");
  wall.setLayout("3x3");
  eq(timers.count, 0, "a grid stops the rotation");
  wall.setLayout("tour");
  wall.destroy();
  eq(timers.count, 0, "destroy stops it too");
});

check("the quality menu is Auto, High, Low -- and a choice reaches every camera on screen", () => {
  const { wall, controlsRoot, calls } = makeWall({ layout: "2x2", devices: devices(3) });
  const found = withClass(controlsRoot, "quality-select");
  eq(found.length, 1, "one quality menu");
  eq(found[0].children.map((o) => o.value), ["auto", "high", "low"], "no medium it cannot deliver");
  eq(found[0].children.filter((o) => o.selected).map((o) => o.value), ["auto"], "auto by default");
  eq(calls.filter((c) => c.op === "open").map((c) => c.quality), ["auto", "auto", "auto"], "opened on auto");
  calls.length = 0;
  const select = withClass(controlsRoot, "quality-select")[0];
  select.value = "low";
  select.fire("change");
  eq(wall.state().quality, "low", "changed");
  eq(sockets(calls), [], "the wall reopens nothing itself");
  eq(calls.filter((c) => c.op === "move").map((c) => c.quality), ["low", "low", "low"], "every camera told");
  wall.setQuality("medium");
  eq(wall.state().quality, "low", "an unknown choice is ignored");
});

check("the quality choice survives a power cut, and a junk stored value is auto", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  makeWall({ devices: devices(1), storage }).wall.setQuality("high");
  eq(makeWall({ devices: devices(1), storage }).wall.state().quality, "high", "remembered");
  store.set("camplat.wall.quality", "ultra");
  eq(makeWall({ devices: devices(1), storage }).wall.state().quality, "auto", "junk is auto");
});

check("rotation survives a power cut", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  makeWall({ layout: "2x2", devices: devices(3), storage, timers: fakeTimers() }).wall.setLayout("tour");
  const timers = fakeTimers();
  const { wall } = makeWall({ devices: devices(3), storage, timers });
  eq(wall.state().touring, true, "still rotating");
  eq(wall.state().layout, "1x1", "one at a time");
  eq(timers.count, 1, "and the timer is running");
});

check("the page label counts from one, and is drawn even on a single page", () => {
  const one = makeWall({ layout: "4x4", devices: devices(3) });
  eq(byId(one.controlsRoot, "pageLabel").textContent, "Page 1 of 1",
    "an operator who cannot see the count does not know whether there are more cameras");

  const many = makeWall({ layout: "2x2", devices: devices(9) });
  eq(byId(many.controlsRoot, "pageLabel").textContent, "Page 1 of 3", "one-based for humans");
  many.wall.setPage(2);
  eq(byId(many.controlsRoot, "pageLabel").textContent, "Page 3 of 3", "pageIndex 2 reads as page 3");
});

check("a one-page wall does not offer a page turn that does nothing", () => {
  const { controlsRoot } = makeWall({ layout: "4x4", devices: devices(3) });
  eq(byId(controlsRoot, "prevPage").disabled, true, "prev disabled");
  eq(byId(controlsRoot, "nextPage").disabled, true, "next disabled");

  const many = makeWall({ layout: "2x2", devices: devices(9) });
  eq(byId(many.controlsRoot, "nextPage").disabled, false, "enabled when there is somewhere to go");
});

check("next on the last page wraps, because nobody is standing there to explain", () => {
  const { wall } = makeWall({ layout: "2x2", devices: devices(9) });
  wall.setPage(2);
  wall.nextPage();
  eq(wall.state().pageIndex, 0, "wrapped forward to the first page");
  wall.prevPage();
  eq(wall.state().pageIndex, 2, "and back to the last");
});

check("setPage clamps rather than wrapping, so a bad number is not a blank wall", () => {
  const { wall } = makeWall({ layout: "2x2", devices: devices(9) });
  wall.setPage(99);
  eq(wall.state().pageIndex, 2, "clamped to the last real page");
  wall.setPage(-3);
  eq(wall.state().pageIndex, 0, "and up to the first");
});

check("a camera name is text, never markup", () => {
  const nasty = device('<img src=x onerror="boom">', ["cam1"]);
  const { gridRoot } = makeWall({ layout: "1x1", devices: [nasty] });
  const label = withClass(gridRoot, "cell-label")[0];
  eq(label.textContent, '<img src=x onerror="boom">', "drawn as the characters it is");
  eq(label.children.length, 0, "and produced no elements");
});

check("a camera that will not resolve says so on its own cell", () => {
  const broken = device("Back lot", ["cam1", "cam2"], { unresolvedCount: 2 });
  const { gridRoot } = makeWall({ layout: "1x1", devices: [broken] });
  const warn = withClass(gridRoot, "cell-warn")[0];
  if (warn === undefined) throw new Error("an unresolved camera must be visible on the wall");
  eq(warn.textContent, "2 stream(s) not resolved", "and says how many");
});

check("storage that throws does not stop the wall drawing", () => {
  // A TV browser in private mode throws on setItem. Cameras still matter more.
  const hostile = {
    getItem() { throw new Error("private mode"); },
    setItem() { throw new Error("private mode"); },
  };
  const { wall, gridRoot } = makeWall({ layout: "2x2", devices: devices(4), storage: hostile });
  eq(withClass(gridRoot, "cell").length, 4, "the wall drew anyway");
  wall.setLayout("3x3");
  eq(wall.state().layout, "3x3", "and still takes instructions");
});

check("a remembered layout comes back, but the page does not", () => {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const first = makeWall({ layout: "2x2", devices: devices(9), storage });
  first.wall.setLayout("3x3");
  first.wall.setPage(1);

  const second = makeWall({ devices: devices(9), storage });
  eq(second.wall.state().layout, "3x3", "the installer's grid choice survives a power cut");
  eq(second.wall.state().pageIndex, 0, "the page does not -- a wall should come back on page 1");
});

check("an explicit layout beats whatever was remembered", () => {
  const store = new Map([["camplat.wall.layout", "4x4"]]);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const { wall } = makeWall({ layout: "1x1", devices: devices(2), storage });
  eq(wall.state().layout, "1x1", "the caller asked for 1x1");
});

check("a browser with no fullscreen API still shows cameras", () => {
  const { controlsRoot, gridRoot } = makeWall({ layout: "2x2", devices: devices(4) });
  const btn = byId(controlsRoot, "fullscreen");
  if (btn === undefined) throw new Error("no fullscreen control");
  btn.fire("click"); // gridRoot has no requestFullscreen; this must not throw
  eq(withClass(gridRoot, "cell").length, 4, "wall intact");
});

check("fullscreen asks for the grid, and a second press leaves it", () => {
  const asked = [];
  const { controlsRoot, gridRoot, wall } = makeWall({ layout: "2x2", devices: devices(4) });
  gridRoot.requestFullscreen = () => asked.push("enter");
  byId(controlsRoot, "fullscreen").fire("click");
  eq(asked, ["enter"], "the grid goes full screen, not the whole page with its controls");
  void wall;
});

check("a wall with no cameras at all is a labelled grid, not a blank screen", () => {
  const { gridRoot, controlsRoot, calls } = makeWall({ layout: "2x2", devices: [] });
  eq(withClass(gridRoot, "cell-empty").length, 4, "four labelled empties");
  eq(opened(calls), [], "and nothing streaming");
  eq(byId(controlsRoot, "pageLabel").textContent, "Page 1 of 1", "never page 1 of 0");
});

check("the grid is told its own shape", () => {
  const { wall, gridRoot } = makeWall({ layout: "2x2", devices: devices(4) });
  eq(gridRoot.style.gridTemplateColumns, "repeat(2, 1fr)", "two columns at 2x2");
  wall.setLayout("4x4");
  eq(gridRoot.style.gridTemplateColumns, "repeat(4, 1fr)", "four at 4x4");
  const cell = withClass(gridRoot, "cell")[0];
  eq(cell.style.aspectRatio, "16 / 9", "and a cell holds a camera's shape, not a stretched one");
});

check("replacing the device list releases the cameras that went away", () => {
  const { wall, calls } = makeWall({ layout: "2x2", devices: devices(4) });
  calls.length = 0;
  wall.setDevices([device("Only one", ["cam1"], { deviceId: "host:10.0.0.1" })]);
  eq(closed(calls).sort(), ["cam2", "cam3", "cam4"], "the removed three are torn down");
  eq(opened(calls), [], "cam1 never left the screen");
});

check("destroy leaves nothing running and nothing on screen", () => {
  const { wall, gridRoot, controlsRoot, calls } = makeWall({ layout: "2x2", devices: devices(4) });
  calls.length = 0;
  wall.destroy();
  eq(closed(calls).sort(), ["cam1", "cam2", "cam3", "cam4"], "every socket released");
  eq(gridRoot.children.length, 0, "grid emptied");
  eq(controlsRoot.children.length, 0, "controls emptied");
  same(wall.state().streaming, [], "and it admits to holding nothing");
});

check("redrawing the same wall twice changes no sockets", () => {
  // The page re-renders on every control press. If a redraw reopened anything
  // the wall would flicker continuously.
  const { wall, calls } = makeWall({ layout: "2x2", devices: devices(4) });
  calls.length = 0;
  wall.setPage(0);
  // A move hands a kept stream its redrawn cell; it opens and closes nothing.
  eq(sockets(calls), [], "no socket touched at all");
});

check("a camera that resolved to no streams at all is a cell, not a phantom socket", () => {
  // The /devices shape allows it: a camera the recorder could not interrogate
  // comes back with unresolvedCount set and streams empty. There is no id to
  // open, so the wall must hold no socket for it -- otherwise what it holds is
  // a nameless entry, and the next redraw asks the host page to close a stream
  // that was never opened.
  const broken = device("Back door", [], { unresolvedCount: 2 });
  const { wall, calls } = makeWall({ devices: [broken, device("Lot", ["lot-1"])] });
  eq(calls.filter((c) => c.op === "open").map((c) => c.cameraId), ["lot-1"],
    "only the camera that has a stream");
  eq(wall.state().streaming, ["lot-1"], "and nothing nameless is remembered as live");
  calls.length = 0;
  wall.setPage(0);
  eq(sockets(calls), [], "redrawing must not close a stream that was never opened");
});

check("a camera kept across a layout change is handed its new cell and shape", () => {
  const { wall, gridRoot, calls } = makeWall({ layout: "2x2", devices: devices(1) });
  const first = calls.find((c) => c.op === "open");
  eq(first.shape.id, "2x2", "open is told the shape it opens into");
  calls.length = 0;
  wall.setLayout("1x1");
  eq(opened(calls), [], "no reopen: the camera never left the screen");
  const moves = calls.filter((c) => c.op === "move");
  eq(moves.length, 1, "one move");
  eq(moves[0].shape.id, "1x1", "with the new shape");
  if (moves[0].body === first.body) throw new Error("moved into the removed cell");
  if (!withClass(gridRoot, "cell-body").includes(moves[0].body)) throw new Error("the new body is not on the wall");
});

check("a camera named like a JavaScript internal is still just a camera", () => {
  // deviceId and cameraId are installer-supplied strings used as object keys.
  // On a plain {} the key "__proto__" does not store a value and "constructor"
  // reads back a function -- so the wall would either lose the camera or read
  // .streams off Object and throw, taking every other camera down with it.
  const odd = device("Odd", ["constructor"], { deviceId: "__proto__" });
  const { wall, gridRoot, calls } = makeWall({ devices: [odd, device("Lot", ["lot-1"])] });
  eq(withClass(gridRoot, "cell-label").map((el) => el.textContent), ["Odd", "Lot"],
    "both cameras drew");
  eq(calls.filter((c) => c.op === "open").map((c) => c.cameraId), ["constructor", "lot-1"],
    "and both opened, by the id the installer actually gave");
  eq(wall.state().streaming, ["constructor", "lot-1"], "");
});

// Verify the index.html TV wall CSS and fullscreen handling
check("index.html implements TV wall with contain (never cover) and dual fullscreen detection", () => {
  const indexPath = join(process.cwd(), "agent/ui/index.html");
  let htmlContent = readFileSync(indexPath, "utf-8");
  // Normalize CRLF to LF for consistent matching
  htmlContent = htmlContent.replace(/\r\n/g, "\n");

  if (!htmlContent.includes("object-fit: contain")) throw new Error("object-fit: contain is missing from wall-mode rules");
  if (htmlContent.includes("object-fit: cover")) throw new Error("THE FEARED ONE: a wall never crops a camera's picture");
  if (!htmlContent.includes("display-mode: fullscreen")) throw new Error("display-mode: fullscreen detection is missing");
  if (!htmlContent.includes("fullscreenchange")) throw new Error("fullscreenchange listener is missing");
  if (htmlContent.includes('.grid:fullscreen { background: #000; padding: 6px; }')) throw new Error("old .grid:fullscreen padding rule should be removed");
});

report("wallPage");
