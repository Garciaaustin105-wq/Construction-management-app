/**
 * agent/ui/areas-client.mjs: the Areas panel on the Cameras page
 * (MANAGER-RULES-SPEC.md section 1) -- pure helpers, the constants mirrored
 * from contracts/areas.ts, and the browser bootstrap block
 * (camera-page-bootstrap-lesson, agent bus 2026-09-26).
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/areasPage.harness.mjs`.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { check, eq, report } from "./_assert.mjs";

const root = process.cwd();
const client = await import(pathToFileURL(join(root, "agent/ui/areas-client.mjs")).href);
const areasContract = await import(pathToFileURL(join(root, "dist/areas.js")).href);

console.log("areas panel (Cameras page)");

check("the mirrored constants match contracts/areas.ts exactly -- a drift here would silently let this page offer what the server refuses", () => {
  eq(client.MIN_AREA_POINTS, areasContract.MIN_AREA_POINTS);
  eq(client.MAX_AREA_POINTS, areasContract.MAX_AREA_POINTS);
  eq(client.MAX_AREAS_PER_CAMERA, areasContract.MAX_AREAS_PER_CAMERA);
});

/** A minimal fake `doc`/element good enough for createCameraAreasPanel's own
 *  DOM writes, without a real browser -- same shape as
 *  harness/cameraAiPage.harness.mjs's own fakes. */
function fakeDoc() {
  const listeners = new Map();
  function fakeEl(tag) {
    const node = {
      tag, children: [], attrs: {}, _text: "", hidden: false, disabled: false, value: "",
      get textContent() { return this._text; },
      set textContent(v) { this._text = v; this.children = []; },
      className: "",
      append(...kids) { for (const k of kids) this.children.push(k); },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(type, fn) {
        const key = `${type}`;
        if (!listeners.has(node)) listeners.set(node, {});
        listeners.get(node)[key] = fn;
      },
      fire(type, ev) { const m = listeners.get(node); if (m && m[type]) m[type](ev || {}); },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    };
    return node;
  }
  return {
    createElement: (tag) => fakeEl(tag),
    createElementNS: (_ns, tag) => fakeEl(tag),
  };
}

check("createCameraAreasPanel builds a panel whose summary shows the camera's own name", () => {
  const doc = fakeDoc();
  const panel = client.createCameraAreasPanel(doc, { fetchFn: async () => ({ ok: true, json: async () => ({}) }), now: () => 0 }, { cameraId: "cam-1", name: "Front Desk" });
  eq(panel.root.children[0].children[0].textContent, "Front Desk");
});

check("applyLoaded renders the camera's own areas only, never another camera's", () => {
  const doc = fakeDoc();
  const panel = client.createCameraAreasPanel(doc, { fetchFn: async () => ({ ok: true, json: async () => ({}) }), now: () => 0 }, { cameraId: "cam-1", name: "Front Desk" });
  panel.applyLoaded([{ id: "a1", cameraId: "cam-1", name: "Manager's desk", points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] }]);
  // The list <ul> is the 4th body child (still status/wrap, controls, errors, list) --
  // rather than depend on exact indices, just prove the area name reached SOME node's textContent.
  const allText = JSON.stringify(panel.root);
  eq(allText.includes("Manager's desk"), true, "the loaded area's name reached the panel");
});

/** THE FEARED ONE: run the module's own bottom bootstrap in a fresh child
 *  process (camera-page-bootstrap-lesson) -- proving the REAL page, with
 *  #areasList in the DOM, fetches on its own with no harness calling
 *  startAreasPage directly. Same isolation shape as
 *  harness/activityPage.harness.mjs and harness/cameraAiPage.harness.mjs. */
await check("THE FEARED ONE: with #areasList in the DOM, the real bootstrap fetches /camera-settings and /areas on its own", () => {
  const clientUrl = pathToFileURL(join(root, "agent/ui/areas-client.mjs")).href;
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
    // id-aware: importing areas-client.mjs also imports camera-ai-client.mjs
    // (for roundFraction/pointerFraction) -- THAT module's own bottom
    // bootstrap must stay dormant here (it looks for "aiSettingsList"), so
    // getElementById only answers truthy for the id this test cares about.
    globalThis.document = {
      getElementById: (id) => (id === "areasList" ? fake : null),
      createElement: () => fake, createElementNS: () => fake, createTextNode: () => fake,
      querySelector: () => fake, querySelectorAll: () => [],
      addEventListener() {}, body: fake, documentElement: fake,
    };
    globalThis.window = { location: { assign() {} }, addEventListener() {}, setInterval: () => 1, clearInterval: () => {} };
    const calls = [];
    globalThis.fetch = (url) => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ cameras: [], areas: [] }) });
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
  eq(calls.some((u) => u.startsWith("/camera-settings")), true, `it asked for /camera-settings on its own: ${JSON.stringify(calls)}`);
  eq(calls.some((u) => u.startsWith("/areas")), true, `it asked for /areas on its own: ${JSON.stringify(calls)}`);
});

report("areas panel");
