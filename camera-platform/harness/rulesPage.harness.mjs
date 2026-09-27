/**
 * agent/ui/rules-client.mjs: the Rules page (MANAGER-RULES-SPEC.md
 * section 5) -- the pure sentence/draft/body builders, the template prefill,
 * identity-free wording, and the browser bootstrap block
 * (camera-page-bootstrap-lesson, agent bus 2026-09-26).
 *
 * NOT REGISTERED in harness/run-all.mjs; run it directly:
 * `node harness/rulesPage.harness.mjs`.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { check, eq, same, report } from "./_assert.mjs";

const root = process.cwd();
const client = await import(pathToFileURL(join(root, "agent/ui/rules-client.mjs")).href);
const rulesContract = await import(pathToFileURL(join(root, "dist/managerRules.js")).href);

console.log("rules page");

check("REQUIRED: the plain-words sentence matches the spec's own worked example exactly", () => {
  const draft = { kind: "person", conditionType: "absent_longer_than", minutes: 20, when: "open_hours", alert: true, report: true };
  eq(client.ruleSentence(draft, "Office camera", "Manager's desk"),
    "When a person is missing for more than 20 minutes from Manager's desk on Office camera during open hours, alert me and add to the daily report.");
});

check("a whole-camera rule (no area) reads as \"the whole <camera> camera\", never a bare null or empty string", () => {
  const draft = { kind: "person", conditionType: "enters", when: "closed_hours", alert: true, report: true };
  const s = client.ruleSentence(draft, "Front door", null);
  eq(s.includes("the whole Front door camera"), true, s);
});

check("every template's own draft, once built, produces a sentence containing that template's own label as the rule's own name would", () => {
  for (const def of rulesContract.MANAGER_RULE_TEMPLATES) {
    const draft = client.draftFromTemplate(def);
    eq(draft.name, def.label);
    eq(draft.cameraId, "", "a template never guesses a camera");
    eq(draft.areaId, null, "a template never guesses an area");
    const s = client.ruleSentence(draft, "Cam", null);
    eq(typeof s, "string");
    eq(s.length > 0, true);
  }
});

check("REQUIRED: \"Manager's desk unattended\" (desk_unattended) is first among the templates, matching the spec's own order", () => {
  eq(rulesContract.MANAGER_RULE_TEMPLATES[0].label, "Manager's desk unattended");
});

check("draftFromRule/buildRuleBody round-trip every condition shape without losing a field", () => {
  const rule = {
    id: "r1", name: "Test", enabled: true, template: "away_and_back", cameraId: "cam-1", areaId: "a1",
    kind: "vehicle", condition: { type: "away_and_back", minMinutes: 10 }, when: "always",
    notify: { alert: false, report: true, cooldownMinutes: 5 },
  };
  const draft = client.draftFromRule(rule);
  const body = client.buildRuleBody(draft);
  same(body, {
    id: "r1", name: "Test", enabled: true, template: "away_and_back", cameraId: "cam-1", areaId: "a1",
    kind: "vehicle", condition: { type: "away_and_back", minMinutes: 10 }, when: "always",
    notify: { alert: false, report: true, cooldownMinutes: 5 },
  });
});

check("buildRuleBody never sends an id for a brand-new draft (blankDraft/draftFromTemplate) -- the server mints one", () => {
  const body = client.buildRuleBody(client.blankDraft());
  eq(Object.hasOwn(body, "id"), false);
});

check("identity-free: no draft or sentence helper in this file ever takes or emits a person's name -- only camera/area/rule names pass through", () => {
  const src = client.ruleSentence.toString() + client.buildRuleBody.toString() + client.draftFromTemplate.toString();
  for (const bad of ["person.name", "personName", "customerName", "manager.name"]) {
    eq(src.includes(bad), false, `must never reference ${bad}`);
  }
});

check("describeReason turns hours_not_set into the spec's own exact refusal words", () => {
  eq(client.describeReason("hours_not_set"), "set the store's open hours first");
});

/** THE FEARED ONE: with #rulesBody in the DOM, the real bootstrap fetches
 *  every route the page needs on its own, with no harness calling
 *  startRulesPage directly -- same isolation shape as
 *  harness/activityPage.harness.mjs. */
await check("THE FEARED ONE: the real bootstrap fetches rule-templates, rules, areas/list, cameras and open-hours on its own", () => {
  const clientUrl = pathToFileURL(join(root, "agent/ui/rules-client.mjs")).href;
  const code = `
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => "";
        if (k === "then") return undefined;
        if (k === "value" || k === "textContent" || k === "checked") return "";
        if (k === "length") return 0;
        if (k === "hidden" || k === "disabled") return false;
        return fake;
      },
      apply() { return fake; },
      set() { return true; },
    };
    const fake = new Proxy(function () {}, handler);
    globalThis.document = {
      getElementById: (id) => (id === "rulesBody" ? fake : null),
      createElement: () => fake, createElementNS: () => fake, createTextNode: () => fake,
      querySelector: () => fake, querySelectorAll: () => [],
      addEventListener() {}, body: fake, documentElement: fake,
    };
    globalThis.window = { location: { assign() {} }, addEventListener() {} };
    const calls = [];
    globalThis.fetch = (url) => {
      calls.push(String(url));
      const u = String(url);
      if (u.startsWith("/rule-templates")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ templates: [] }) });
      if (u.startsWith("/rules")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ rules: [] }) });
      if (u.startsWith("/areas/list")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ areas: [] }) });
      if (u.startsWith("/cameras")) return Promise.resolve({ ok: true, status: 200, json: async () => ([]) });
      if (u.startsWith("/open-hours")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ openHours: null }) });
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
  for (const path of ["/rule-templates", "/rules", "/areas/list", "/cameras", "/open-hours"]) {
    eq(calls.some((u) => u.startsWith(path)), true, `it asked for ${path} on its own: ${JSON.stringify(calls)}`);
  }
});

/* ── a real (if minimal) DOM: does the existing-rules row survive the
 * shared base <label> CSS rule? (page lens finding, severity medium) ──
 *
 * rules.html's own `label { flex-direction:column; font-size:12px;
 * color:var(--muted); }` was written for THIS form's own field labels
 * ("Name<input>"). renderRulesList used to reuse the generic `.row` class
 * for the on/off-switch-plus-name label in the "Existing rules" list --
 * `.row` never redeclares flex-direction/font-size/color, so those three
 * properties fell through from the base `label` rule regardless of `.row`'s
 * higher selector specificity (a class selector only outranks a type
 * selector for a property BOTH rules actually set), stacking the checkbox
 * and the rule's own name on separate lines in small muted gray. */

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

class FakeDoc {
  constructor() { this.registry = new Map(); }
  createElement(tag) { return new FakeElement(tag); }
  createElementNS(_ns, tag) { return new FakeElement(tag); }
  getElementById(id) {
    if (!this.registry.has(id)) this.registry.set(id, new FakeElement("div"));
    return this.registry.get(id);
  }
}

function fakeFetch(rules) {
  return async (url) => {
    const u = String(url);
    if (u.startsWith("/rule-templates")) return { ok: true, status: 200, json: async () => ({ templates: [] }) };
    if (u.startsWith("/rules")) return { ok: true, status: 200, json: async () => ({ rules }) };
    if (u.startsWith("/areas/list")) return { ok: true, status: 200, json: async () => ({ areas: [] }) };
    if (u.startsWith("/cameras")) return { ok: true, status: 200, json: async () => ([{ cameraId: "cam-1", name: "Front" }]) };
    if (u.startsWith("/open-hours")) return { ok: true, status: 200, json: async () => ({ openHours: null }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

await check("REQUIRED (page lens finding): the existing-rules on/off-switch-plus-name row has its own class, never the shared .row that would leave it to the base <label> rule", async () => {
  const doc = new FakeDoc();
  const rule = {
    id: "r1", name: "Manager's desk unattended", enabled: true, template: "desk_unattended",
    cameraId: "cam-1", areaId: null, kind: "person",
    condition: { type: "absent_longer_than", minutes: 20 }, when: "always",
    notify: { alert: true, report: true, cooldownMinutes: 0 },
    createdBy: "installer1", updatedUtc: "2026-09-26T00:00:00.000Z", updatedBy: "installer1",
  };
  const page = client.startRulesPage({
    doc, fetchFn: fakeFetch([rule]), now: () => new Date("2026-09-26T12:00:00Z"), log: () => {}, navigate: () => {},
  });
  await page.ready;
  const rulesListEl = doc.getElementById("rulesList");
  eq(rulesListEl.children.length, 1, "one rendered row for the one rule");
  const li = rulesListEl.children[0];
  eq(li.tagName, "li");
  const toggleWrap = li.children[0];
  eq(toggleWrap.tagName, "label");
  const classes = String(toggleWrap.className).split(/\s+/).filter(Boolean);
  eq(classes.includes("row"), false, `must not reuse the shared .row class (got class="${toggleWrap.className}")`);
  eq(classes.includes("rule-toggle"), true, `expected the toggle row's own class (got class="${toggleWrap.className}")`);
});

await check("REQUIRED (page lens finding): rules.html's .rule-toggle rule redeclares every property the base <label> rule sets, so it truly wins rather than merely out-specificity-ing .row", async () => {
  const html = await readFile(join(root, "agent/ui/rules.html"), "utf8");
  const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html);
  eq(styleMatch !== null, true, "rules.html has a <style> block");
  const css = styleMatch[1];
  const labelMatch = /(?:^|[,{}])\s*label\s*\{([^}]*)\}/.exec(css);
  eq(labelMatch !== null, true, "the base label rule this page relies on for its own field labels still exists");
  const toggleMatch = /\.rule-toggle\s*\{([^}]*)\}/.exec(css);
  eq(toggleMatch !== null, true, ".rule-toggle is defined in rules.html's stylesheet");
  const decl = toggleMatch[1];
  // A class selector only beats a type selector for a property BOTH rules
  // set -- so .rule-toggle must actually redeclare each of these, not just
  // outrank `label` on paper, or the exact leak this finding reported
  // (column layout, 12px muted text) comes right back.
  for (const prop of ["flex-direction", "font-size", "color"]) {
    const has = new RegExp(`(^|[;{])\\s*${prop}\\s*:`).test(decl);
    eq(has, true, `.rule-toggle must set its own ${prop}, or the base "label" rule's ${prop} silently wins`);
  }
});

report("rules page");
