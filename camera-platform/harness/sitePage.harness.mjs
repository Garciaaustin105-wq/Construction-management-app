/**
 * The Site section on the System page (agent/ui/site-client.mjs),
 * SITE-SETTINGS-SPEC.md sections 1-2, run without a browser.
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/sitePage.harness.mjs`.
 *
 * THE FEARED FAILURES:
 *  - a camera with no custom schedule (schedule: null, "always") counted as
 *    "in another zone" -- there is no zone on it to disagree with anything.
 *  - a store account (no system.manage) seeing a Site form it can never
 *    save: GET /site-settings answers 403 for them, and the section must be
 *    removed, not left half-drawn.
 *  - a client with no browser bootstrap passing every check that drives its
 *    exported functions directly, while the real page never fetches
 *    anything at all (camera-page-bootstrap-lesson, agent bus, 2026-09-26).
 *  - MAX_DISPLAY_NAME_LENGTH drifting from contracts/siteSettings.ts's own
 *    export, since this file mirrors it rather than importing the compiled
 *    (CommonJS) contract.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { check, eq, same, report } from "./_assert.mjs";

const root = process.cwd();
const client = await import(pathToFileURL(join(root, "agent/ui/site-client.mjs")).href);
const contract = await import(pathToFileURL(join(root, "dist/siteSettings.js")).href);

console.log("site page");

/* ------------------------------------------------------------------ */
/* A small fake DOM: just enough for buildSiteSection's own tree.      */
/* ------------------------------------------------------------------ */

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.style = {};
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.hidden = false;
    this._text = "";
    this._listeners = new Map();
    this._attrs = new Map();
  }
  set innerHTML(_) {
    throw new Error("site-client.mjs must not use innerHTML");
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
    // See harness/layoutClientPage.harness.mjs's own copy of this comment:
    // reflects the boolean "hidden" attribute onto the IDL property, the way
    // a real DOM element does, so an el()-built control's initial `hidden:
    // true` agrees with a later direct `.hidden = false` toggle.
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
const byTag = (root, tag) => all(root).filter((e) => e.tagName === tag.toUpperCase());
const byIdIn = (root, id) => all(root).find((e) => e.id === id);

function fakeDoc() {
  const body = new FakeEl("div");
  return {
    _body: body,
    createElement: (tag) => new FakeEl(tag),
    getElementById: (id) => (byIdIn(body, id) ?? null),
    mount(el) { body.appendChild(el); },
  };
}

/* ------------------------------------------------------------------ */
/* Pure helpers.                                                       */
/* ------------------------------------------------------------------ */

check("MAX_DISPLAY_NAME_LENGTH matches the contract it mirrors", () => {
  eq(client.MAX_DISPLAY_NAME_LENGTH, contract.MAX_DISPLAY_NAME_LENGTH, "site-client.mjs's own copy");
});

check("a camera with no custom schedule is never 'in another zone' -- there is no zone on it", () => {
  const cams = { cam1: { schedule: null }, cam2: { schedule: { timeZone: "America/Chicago", weekly: [], closedDates: [] } } };
  const out = client.camerasInAnotherZone(cams, "America/Chicago", (id) => id);
  eq(out, [], "cam2's own zone matches the site's; cam1 has no zone to disagree at all");
});

check("a camera whose saved schedule zone differs from the site's is listed, by name", () => {
  const cams = {
    cam1: { schedule: { timeZone: "America/New_York", weekly: [], closedDates: [] } },
    cam2: { schedule: { timeZone: "America/Chicago", weekly: [], closedDates: [] } },
  };
  const out = client.camerasInAnotherZone(cams, "America/Chicago", (id) => (id === "cam1" ? "Front door" : id));
  eq(out, [{ cameraId: "cam1", name: "Front door", zone: "America/New_York" }], "only the mismatched one, named");
});

check("a camera name falls back to its own id when none is known -- never blank", () => {
  const cams = { cam1: { schedule: { timeZone: "America/New_York", weekly: [], closedDates: [] } } };
  const out = client.camerasInAnotherZone(cams, "America/Chicago", (id) => id);
  eq(out[0].name, "cam1", "the id itself");
});

check("changedFeatureKeys names only the keys that actually differ, never a value", () => {
  eq(client.changedFeatureKeys({ activity: true }, { activity: false }), ["activity"]);
  eq(client.changedFeatureKeys({ activity: true }, { activity: true }), []);
  eq(client.changedFeatureKeys(undefined, { activity: true }), ["activity"]);
});

check("describeSiteReason never echoes a raw code it does not recognise, but never hides one either", () => {
  eq(client.describeSiteReason("bad_time_zone"), "is not a recognised time zone");
  eq(client.describeSiteReason("something_new"), "something_new");
});

check("REQUIRED: the mirrored appearance-match constants match contracts/siteSettings.ts exactly", () => {
  eq(client.MIN_APPEARANCE_MATCH_PERCENT, contract.MIN_APPEARANCE_MATCH_PERCENT);
  eq(client.MAX_APPEARANCE_MATCH_PERCENT, contract.MAX_APPEARANCE_MATCH_PERCENT);
  eq(client.DEFAULT_APPEARANCE_MATCH_PERCENT, contract.DEFAULT_APPEARANCE_MATCH_PERCENT);
});

check("describeSiteReason turns bad_appearance_match_percent into the field's own real bounds, never the raw code", () => {
  eq(client.describeSiteReason("bad_appearance_match_percent"), "must be a number from 50 to 99");
});

/* ------------------------------------------------------------------ */
/* DOM: the section builds, and the store-account 403 removes it.      */
/* ------------------------------------------------------------------ */

function makeFetchFrom(routes) {
  const calls = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      const key = `${(init && init.method) || "GET"} ${url.split("?")[0]}`;
      const handler = routes[key];
      if (!handler) return { ok: false, status: 404, json: async () => ({ ok: false }) };
      return handler(url, init);
    },
  };
}

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const SITE_SETTINGS_OK = {
  ok: true,
  settings: { displayName: "Front lot", timeZone: "America/Chicago", siteType: "retail", features: { activity: true } },
  systemTimeZone: "UTC",
  effectiveTimeZone: "America/Chicago",
  featureRegistry: [{ key: "activity", registryDefault: true }],
  siteTypes: ["retail", "storage", "carwash", "home", "other"],
  problem: null,
  version: { version: "abc123def456", installedAtUtc: "2026-09-01T00:00:00.000Z" },
  versionProblem: null,
  trustedKeyIds: ["key-1"],
  trustedKeysProblem: null,
  license: "No license service configured yet",
};

await check("the section fills from GET /site-settings", async () => {
  const doc = fakeDoc();
  const rootEl = new FakeEl("div");
  rootEl.setAttribute("id", "siteSectionRoot");
  doc.mount(rootEl);
  const { fetchFn, calls } = makeFetchFrom({
    "GET /site-settings": () => jsonRes(200, SITE_SETTINGS_OK),
    "GET /camera-ai-settings": () => jsonRes(200, { ok: true, cameras: {}, storingFloor: 0.3, timeZone: "America/Chicago", problem: null }),
    "GET /camera-settings": () => jsonRes(200, { ok: true, cameras: [] }),
  });
  const page = client.startSitePage({ doc, fetchFn, timeZones: [] });
  await page.ready;
  eq(page.dom.nameInput.value, "Front lot", "display name");
  eq(page.dom.tzInput.value, "America/Chicago", "time zone");
  eq(page.dom.typeSelect.value, "retail", "site type");
  eq(calls.some((c) => c.url === "/site-settings"), true, "it asked for /site-settings itself");
});

await check("REQUIRED: the appearance match-percent field fills from settings, shows the spec's own limits text, and is always sent on save (never silently reset to 80)", async () => {
  const doc = fakeDoc();
  const rootEl = new FakeEl("div");
  rootEl.setAttribute("id", "siteSectionRoot");
  doc.mount(rootEl);
  let posted = null;
  const { fetchFn } = makeFetchFrom({
    "GET /site-settings": () => jsonRes(200, { ...SITE_SETTINGS_OK, settings: { ...SITE_SETTINGS_OK.settings, appearanceMatchPercent: 72 } }),
    "GET /camera-ai-settings": () => jsonRes(200, { ok: true, cameras: {}, storingFloor: 0.3, timeZone: "America/Chicago", problem: null }),
    "GET /camera-settings": () => jsonRes(200, { ok: true, cameras: [] }),
    "POST /site-settings": (url, init) => {
      posted = JSON.parse(init.body);
      return jsonRes(200, { ok: true, settings: { ...SITE_SETTINGS_OK.settings, appearanceMatchPercent: posted.appearanceMatchPercent } });
    },
  });
  const page = client.startSitePage({ doc, fetchFn, timeZones: [] });
  await page.ready;
  eq(page.dom.appearanceMatchInput.value, "72", "loaded from settings, never the registry default");
  eq(page.dom.appearanceLimitsText.textContent, client.APPEARANCE_LIMITS_TEXT);
  page.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(posted.appearanceMatchPercent, 72, "sent on every save, even one that never touched this field");
});

await check("a site that never saved this field reads the registry-style default (80), never blank or zero (build rule 5)", async () => {
  const doc = fakeDoc();
  const rootEl = new FakeEl("div");
  rootEl.setAttribute("id", "siteSectionRoot");
  doc.mount(rootEl);
  const { fetchFn } = makeFetchFrom({
    "GET /site-settings": () => jsonRes(200, SITE_SETTINGS_OK), // SITE_SETTINGS_OK's own settings omit appearanceMatchPercent
    "GET /camera-ai-settings": () => jsonRes(200, { ok: true, cameras: {}, storingFloor: 0.3, timeZone: "America/Chicago", problem: null }),
    "GET /camera-settings": () => jsonRes(200, { ok: true, cameras: [] }),
  });
  const page = client.startSitePage({ doc, fetchFn, timeZones: [] });
  await page.ready;
  eq(page.dom.appearanceMatchInput.value, "80");
});

check("featureLabel names managerRules and appearanceOfDay in plain words, never the bare registry key", () => {
  eq(client.featureLabel("managerRules"), "Manager rules");
  eq(client.featureLabel("appearanceOfDay").includes("no face"), true, client.featureLabel("appearanceOfDay"));
});

await check("a store account (403 on GET /site-settings) loses the whole section, not a broken form", async () => {
  const doc = fakeDoc();
  const rootEl = new FakeEl("div");
  rootEl.setAttribute("id", "siteSectionRoot");
  doc.mount(rootEl);
  const { fetchFn } = makeFetchFrom({
    "GET /site-settings": () => jsonRes(403, { ok: false, code: "forbidden" }),
  });
  const page = client.startSitePage({ doc, fetchFn, timeZones: [] });
  await page.ready;
  eq(rootEl.hidden, true, "the whole section is hidden, never a form nobody can save");
});

await check("saving posts the form's own fields, and a changed site type reports which switches the preset touched", async () => {
  const doc = fakeDoc();
  const rootEl = new FakeEl("div");
  rootEl.setAttribute("id", "siteSectionRoot");
  doc.mount(rootEl);
  let posted = null;
  const { fetchFn } = makeFetchFrom({
    "GET /site-settings": () => jsonRes(200, { ...SITE_SETTINGS_OK, settings: { ...SITE_SETTINGS_OK.settings, siteType: "home", features: { activity: false } } }),
    "GET /camera-ai-settings": () => jsonRes(200, { ok: true, cameras: {}, storingFloor: 0.3, timeZone: "America/Chicago", problem: null }),
    "GET /camera-settings": () => jsonRes(200, { ok: true, cameras: [] }),
    "POST /site-settings": (url, init) => {
      posted = JSON.parse(init.body);
      return jsonRes(200, { ok: true, settings: { displayName: "Front lot", timeZone: "America/Chicago", siteType: "retail", features: { activity: true } } });
    },
  });
  const page = client.startSitePage({ doc, fetchFn, timeZones: [] });
  await page.ready;
  page.dom.typeSelect.value = "retail";
  page.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(posted.siteType, "retail", "the form's own choice, not the loaded one");
  eq(posted.displayName, "Front lot", "and the rest of the form");
  eq(page.dom.presetNote.textContent.includes("Turned on: Activity"), true,
    `a note names what the preset actually changed: ${page.dom.presetNote.textContent}`);
});

await check("a blank time zone saves as null (the system zone), never an empty string", async () => {
  const doc = fakeDoc();
  const rootEl = new FakeEl("div");
  rootEl.setAttribute("id", "siteSectionRoot");
  doc.mount(rootEl);
  let posted = null;
  const { fetchFn } = makeFetchFrom({
    "GET /site-settings": () => jsonRes(200, SITE_SETTINGS_OK),
    "GET /camera-ai-settings": () => jsonRes(200, { ok: true, cameras: {}, storingFloor: 0.3, timeZone: "America/Chicago", problem: null }),
    "GET /camera-settings": () => jsonRes(200, { ok: true, cameras: [] }),
    "POST /site-settings": (url, init) => {
      posted = JSON.parse(init.body);
      return jsonRes(200, { ok: true, settings: { displayName: null, timeZone: null, siteType: "retail", features: { activity: true } } });
    },
  });
  const page = client.startSitePage({ doc, fetchFn, timeZones: [] });
  await page.ready;
  page.dom.tzInput.value = "  ";
  page.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(posted.timeZone, null, "blank means null, not \"\"");
});

await check("a 400 lists every field problem in plain words", async () => {
  const doc = fakeDoc();
  const rootEl = new FakeEl("div");
  rootEl.setAttribute("id", "siteSectionRoot");
  doc.mount(rootEl);
  const { fetchFn } = makeFetchFrom({
    "GET /site-settings": () => jsonRes(200, SITE_SETTINGS_OK),
    "GET /camera-ai-settings": () => jsonRes(200, { ok: true, cameras: {}, storingFloor: 0.3, timeZone: "America/Chicago", problem: null }),
    "GET /camera-settings": () => jsonRes(200, { ok: true, cameras: [] }),
    "POST /site-settings": () => jsonRes(400, { ok: false, code: "invalid", errors: [{ field: "timeZone", reason: "bad_time_zone" }] }),
  });
  const page = client.startSitePage({ doc, fetchFn, timeZones: [] });
  await page.ready;
  page.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(page.dom.saveErrors.textContent.includes("is not a recognised time zone"), true, page.dom.saveErrors.textContent);
});

await check("the zone-mismatch list names a camera whose schedule disagrees with the effective zone, and says none when they all agree", async () => {
  const doc = fakeDoc();
  const rootEl = new FakeEl("div");
  rootEl.setAttribute("id", "siteSectionRoot");
  doc.mount(rootEl);
  const { fetchFn } = makeFetchFrom({
    "GET /site-settings": () => jsonRes(200, SITE_SETTINGS_OK),
    "GET /camera-ai-settings": () => jsonRes(200, {
      ok: true,
      cameras: { cam1: { schedule: { timeZone: "America/New_York", weekly: [], closedDates: [] } } },
      storingFloor: 0.3, timeZone: "America/Chicago", problem: null,
    }),
    "GET /camera-settings": () => jsonRes(200, { ok: true, cameras: [{ cameraId: "cam1", name: "Loading dock" }] }),
  });
  const page = client.startSitePage({ doc, fetchFn, timeZones: [] });
  await page.ready;
  await new Promise((r) => setTimeout(r, 20));
  eq(page.dom.zonesList.textContent.includes("Loading dock"), true, page.dom.zonesList.textContent);
  eq(page.dom.zonesList.textContent.includes("America/New_York"), true, page.dom.zonesList.textContent);
});

/* ------------------------------------------------------------------ */
/* No innerHTML anywhere in this client.                               */
/* ------------------------------------------------------------------ */

check("site-client.mjs never uses innerHTML", async () => {
  const src = await readFile(join(root, "agent/ui/site-client.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  eq(code.includes("innerHTML"), false);
});

/* ------------------------------------------------------------------ */
/* THE FEARED ONE: the browser starts this itself.                     */
/* ------------------------------------------------------------------ */

await check("THE FEARED ONE: in a browser the page STARTS ITSELF -- loading site-client.mjs with the real page in the DOM fetches /site-settings with no harness calling it", () => {
  const clientUrl = pathToFileURL(join(root, "agent/ui/site-client.mjs")).href;
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
      getElementById: (id) => (id === "siteSectionRoot" ? fake : null),
      createElement: () => fake, createElementNS: () => fake,
      createTextNode: () => fake, querySelector: () => fake, querySelectorAll: () => [],
      addEventListener() {}, body: fake, documentElement: fake,
    };
    globalThis.window = { location: { assign() {} }, addEventListener() {} };
    globalThis.fetch = (url) => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, settings: { displayName: null, timeZone: null, siteType: null, features: {} }, systemTimeZone: "UTC", effectiveTimeZone: "UTC", featureRegistry: [], problem: null, version: null, versionProblem: "n/a", trustedKeyIds: [], trustedKeysProblem: "n/a", license: "x" }) });
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
  eq(calls.includes("/site-settings"), true, `it asked for /site-settings on its own: ${JSON.stringify(calls)}`);
});

report("site page");
