/**
 * The Accounts page's display-layout assignment (agent/ui/accounts-
 * client.mjs), SITE-SETTINGS-SPEC.md section 3: "the installer
 * (account.manage) assigns a display a layout: a shape plus cameras."
 *
 * accounts-client.mjs is loaded ONLY as the real browser page's own
 * <script type="module"> -- it touches `document` at module top level and
 * calls its own start() unconditionally, so (unlike every *-client.mjs that
 * gates its bootstrap behind an element check) it cannot be imported by
 * this harness's own process without a fake `document`/`window`/`fetch`
 * already in place. Every check below therefore runs in its own child
 * process, the same way harness/activityPage.harness.mjs's own THE FEARED
 * ONE check does -- here for every check, since there is no other way in.
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/accountsPage.harness.mjs`.
 *
 * THE FEARED FAILURES:
 *  - GRID_SHAPES (mirrored here, since a static top-level import of the
 *    browser's own "/ui/grid-layout.js" would break Node's module resolver)
 *    drifting from contracts/gridLayout.mts's real GRID_SHAPES.
 *  - a display's assignment summary counting a removed camera as if it
 *    were still assigned, or silently dropping it from the count entirely.
 *  - the page never asking for /display-layouts or /camera-settings at all
 *    -- the exact shape of bug camera-page-bootstrap-lesson (agent bus,
 *    2026-09-26) already burned this codebase once.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { check, eq, report } from "./_assert.mjs";

const root = process.cwd();
const grid = await import(pathToFileURL(join(root, "dist/gridLayout.mjs")).href);

console.log("accounts page");

/** Runs `code` (an ES module body) in a fresh child process and returns its
 *  parsed last stdout line as JSON -- the same isolation
 *  activityPage.harness.mjs's own THE FEARED ONE check uses, needed here for
 *  every check because accounts-client.mjs has no DOM-guarded bootstrap to
 *  import around. */
function runChild(code) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", cwd: root, timeout: 20_000 });
  if (r.status !== 0) throw new Error(`child failed: ${(r.stderr || "").slice(0, 800)}`);
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1] || "null");
}

/** A fake document good enough for accounts-client.mjs's own top-level
 *  getElementById calls and its DOM-building calls during a normal render
 *  -- everything is the same "answer myself for anything" Proxy the other
 *  THE FEARED ONE checks use. */
const FAKE_DOC_PRELUDE = `
  const handler = {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => "";
      if (k === "then") return undefined;
      if (k === "value" || k === "textContent" || k === "className") return "";
      if (k === "length") return 0;
      if (k === Symbol.iterator) return function* () {};
      return fake;
    },
    apply() { return fake; },
    set() { return true; },
  };
  const fake = new Proxy(function () {}, handler);
  globalThis.document = {
    getElementById: () => fake, createElement: () => fake, createElementNS: () => fake,
    createTextNode: () => fake, querySelector: () => fake, querySelectorAll: () => [],
    addEventListener() {}, body: fake, documentElement: fake,
  };
  globalThis.window = { location: { assign() {}, replace() {}, origin: "https://nvr.local" }, addEventListener() {}, confirm: () => true, prompt: () => null };
  globalThis.location = globalThis.window.location;
`;

/* ------------------------------------------------------------------ */
/* GRID_SHAPES: the mirrored copy against the real contract.           */
/* ------------------------------------------------------------------ */

await check("GRID_SHAPES matches contracts/gridLayout.mts's own shapes", () => {
  const code = `${FAKE_DOC_PRELUDE}
    globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const client = await import(${JSON.stringify(pathToFileURL(join(root, "agent/ui/accounts-client.mjs")).href)} + "?shapes");
    console.log(JSON.stringify(client.GRID_SHAPES));
    process.exit(0);
  `;
  const shapes = runChild(code);
  eq(shapes, grid.GRID_SHAPES.map((s) => ({ id: s.id, cells: s.cells })));
});

/* ------------------------------------------------------------------ */
/* describeAssignment: the honest summary, removed cameras named.      */
/* ------------------------------------------------------------------ */

await check("describeAssignment counts assigned and removed cameras separately, and never conflates them", () => {
  const code = `${FAKE_DOC_PRELUDE}
    let cameraSettingsSeen = false;
    globalThis.fetch = (url) => {
      if (String(url).startsWith("/camera-settings")) {
        cameraSettingsSeen = true;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, cameras: [{ cameraId: "cam1", name: "Front" }, { cameraId: "cam2", name: "Back" }] }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, principal: { kind: "user", username: "root", role: "installer" }, accounts: [], displays: [], displays_: [], cameras: [] }) });
    };
    const client = await import(${JSON.stringify(pathToFileURL(join(root, "agent/ui/accounts-client.mjs")).href)} + "?describe");
    // Give the module's own start() time to run loadCameraOptions() before
    // this reads its module-level state through the exported function.
    await new Promise((r) => setTimeout(r, 150));
    const withRemoved = client.describeAssignment({ layout: "2x2", cells: ["cam1", "cam-gone", null, "cam2"] });
    const none = client.describeAssignment(null);
    const allKnown = client.describeAssignment({ layout: "1x1", cells: ["cam1"] });
    console.log(JSON.stringify({ withRemoved, none, allKnown }));
    process.exit(0);
  `;
  const out = runChild(code);
  eq(out.withRemoved, "2x2 — 2 cameras assigned — 1 removed", out.withRemoved);
  eq(out.none, "No layout assigned");
  eq(out.allKnown, "1x1 — 1 camera assigned");
});

/* ------------------------------------------------------------------ */
/* THE FEARED ONE: the page starts itself and asks for everything it   */
/* needs, including the two new routes this feature adds.              */
/* ------------------------------------------------------------------ */

await check("THE FEARED ONE: in a browser the page STARTS ITSELF -- loading accounts-client.mjs with the real page in the DOM fetches every route it needs, including /display-layouts and /camera-settings, with no harness calling it", () => {
  const code = `${FAKE_DOC_PRELUDE}
    const calls = [];
    globalThis.fetch = (url) => {
      calls.push(String(url).split("?")[0]);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        ok: true, principal: { kind: "user", username: "root", role: "installer" },
        accounts: [], displays: [], cameras: [], displays_map: {},
      }) });
    };
    await import(${JSON.stringify(pathToFileURL(join(root, "agent/ui/accounts-client.mjs")).href)} + "?boot");
    await new Promise((r) => setTimeout(r, 150));
    console.log(JSON.stringify(calls));
    process.exit(0);
  `;
  const calls = runChild(code);
  for (const wanted of ["/auth/state", "/accounts", "/displays", "/camera-settings", "/display-layouts"]) {
    eq(calls.includes(wanted), true, `expected a request for ${wanted}, got ${JSON.stringify(calls)}`);
  }
});

/* ------------------------------------------------------------------ */
/* No innerHTML anywhere in this client.                               */
/* ------------------------------------------------------------------ */

check("accounts-client.mjs never uses innerHTML", async () => {
  const src = await readFile(join(root, "agent/ui/accounts-client.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  eq(code.includes("innerHTML"), false);
});

/* ------------------------------------------------------------------ */
/* Gap 3 (MANAGER-RULES-SPEC.md section 4): the Accounts page can      */
/* create a manager account -- the role picker offers it, matching the */
/* client's own ROLE_DESCRIPTIONS, and submitting the form sends       */
/* role: "manager".                                                    */
/* ------------------------------------------------------------------ */

await check("the role picker offers Manager, with the same description accounts-client.mjs's own ROLE_DESCRIPTIONS uses", async () => {
  const html = await readFile(join(root, "agent/ui/accounts.html"), "utf8");
  const m = /<option value="manager">([^<]*)<\/option>/.exec(html);
  if (m === null) throw new Error("accounts.html has no <option value=\"manager\"> in its role picker");
  const code = `
    globalThis.document = { getElementById: () => ({}) };
    const client = await import(${JSON.stringify(pathToFileURL(join(root, "agent/ui/accounts-client.mjs")).href)} + "?roles");
    console.log(JSON.stringify(client.ROLE_DESCRIPTIONS));
    process.exit(0);
  `;
  const descriptions = runChild(code);
  eq(m[1].includes(descriptions.manager), true, `option text ${JSON.stringify(m[1])} does not carry ROLE_DESCRIPTIONS.manager ${JSON.stringify(descriptions.manager)}`);
});

await check("creating an account with role Manager selected sends POST /accounts with role: \"manager\"", () => {
  const code = `
    const realEls = {};
    function realEl(id) {
      if (!realEls[id]) {
        realEls[id] = {
          value: "", disabled: false, hidden: false, textContent: "", className: "",
          _listeners: {},
          addEventListener(type, fn) { this._listeners[type] = fn; },
          reset() { this.value = ""; },
          append() {}, focus() {}, select() {}, setSelectionRange() {},
        };
      }
      return realEls[id];
    }
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => "";
        if (k === "then") return undefined;
        if (k === "value" || k === "textContent" || k === "className") return "";
        if (k === "length") return 0;
        if (k === Symbol.iterator) return function* () {};
        return fake;
      },
      apply() { return fake; },
      set() { return true; },
    };
    const fake = new Proxy(function () {}, handler);
    globalThis.document = {
      getElementById: (id) => realEl(id),
      createElement: () => fake, createElementNS: () => fake,
      createTextNode: () => fake, querySelector: () => fake, querySelectorAll: () => [],
      addEventListener() {}, body: fake, documentElement: fake,
    };
    globalThis.window = { location: { assign() {}, replace() {}, origin: "https://nvr.local" }, addEventListener() {}, confirm: () => true, prompt: () => null };
    globalThis.location = globalThis.window.location;

    const posts = [];
    globalThis.fetch = (url, init) => {
      if (String(url) === "/accounts" && init && init.method === "POST") {
        posts.push(JSON.parse(init.body));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        ok: true, principal: { kind: "user", username: "root", role: "installer" },
        accounts: [], displays: [], cameras: [], displays_map: {},
      }) });
    };
    await import(${JSON.stringify(pathToFileURL(join(root, "agent/ui/accounts-client.mjs")).href)} + "?submit");
    await new Promise((r) => setTimeout(r, 150));

    realEls.addUsername.value = "site-manager";
    realEls.addRole.value = "manager";
    realEls.addPassword.value = "at-least-12-chars";
    realEls.addConfirm.value = "at-least-12-chars";
    realEls.addAccountForm._listeners.submit({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 150));

    console.log(JSON.stringify(posts));
    process.exit(0);
  `;
  const posts = runChild(code);
  eq(posts.length, 1, `expected exactly one POST /accounts, got ${JSON.stringify(posts)}`);
  eq(posts[0].role, "manager", `expected role "manager", got ${JSON.stringify(posts[0])}`);
  eq(posts[0].username, "site-manager");
});

report("accounts page");
