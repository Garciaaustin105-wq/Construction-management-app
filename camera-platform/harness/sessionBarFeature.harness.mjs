/**
 * session-bar.mjs's feature-based nav hiding (SITE-SETTINGS-SPEC.md: "a
 * switched-off feature: its nav link is hidden ... never 403, which would
 * read as a permission problem"), run without a browser.
 *
 * session-bar.mjs already has its own PAGE_NEEDS/hideRefusedLinks exports
 * proven by harness/activityPage.harness.mjs; this file covers only what
 * this round ADDED to it: FEATURE_LINKS/hideFeatureLinks, and the bar()
 * building (or skipping) the Activity link, and the bottom bootstrap now
 * also fetching /site.
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/sessionBarFeature.harness.mjs`.
 *
 * THE FEARED FAILURES:
 *  - a feature the /site response never mentions at all being hidden
 *    anyway -- "a blank is not a zero" applies here too: only an explicit
 *    `false` hides a link, an absent key does not.
 *  - /site failing (a slow or unreachable recorder) turning into every
 *    feature link disappearing, instead of just not hiding anything yet.
 *  - the bar's own Activity link surviving a switched-off feature because
 *    hideFeatureLinks only ever looked at links that existed BEFORE bar()
 *    built its own.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { check, eq, report } from "./_assert.mjs";

const root = process.cwd();
const sessionBar = await import(pathToFileURL(join(root, "agent/ui/session-bar.mjs")).href);

console.log("session bar feature");

/** A minimal fake `doc` -- just enough for hideFeatureLinks' own
 *  querySelectorAll("a[href]") walk, matching hideRefusedLinks' own test
 *  style already proven in harness/activityPage.harness.mjs (that file
 *  never needed a fake `doc` of its own because these two functions were
 *  designed to take one). */
function fakeDocWithLinks(hrefs) {
  const anchors = hrefs.map((href) => ({
    hidden: false,
    getAttribute: (name) => (name === "href" ? href : null),
  }));
  return { querySelectorAll: () => anchors, _anchors: anchors };
}

check("FEATURE_LINKS names the Activity, Rules, Reports and Alerts pages, and nothing else", () => {
  // Alerts (MANAGER-ALERTS-SPEC.md, this codebase's build 2) joined Rules and
  // Reports on the managerRules switch after this check was first written --
  // updated here rather than left to silently drift, the same "and nothing
  // else" exhaustiveness this check's own name promises.
  eq(sessionBar.FEATURE_LINKS, {
    "/activity-page": "activity", "/rules-page": "managerRules", "/reports-page": "managerRules",
    "/alerts-page": "managerRules",
  });
});

check("PAGE_NEEDS names rules.manage for Rules and events.view for Reports, matching routeAccess.ts", () => {
  eq(sessionBar.PAGE_NEEDS["/rules-page"], "rules.manage");
  eq(sessionBar.PAGE_NEEDS["/reports-page"], "events.view");
});

check("managerRules off hides both the Rules and the Reports link, not just Activity", () => {
  const doc = fakeDocWithLinks(["/rules-page", "/reports-page", "/activity-page"]);
  sessionBar.hideFeatureLinks(doc, { managerRules: false, activity: true });
  eq(doc._anchors[0].hidden, true, "Rules");
  eq(doc._anchors[1].hidden, true, "Reports");
  eq(doc._anchors[2].hidden, false, "Activity is untouched by managerRules");
});

check("an explicit false hides the matching link", () => {
  const doc = fakeDocWithLinks(["/activity-page", "/system"]);
  sessionBar.hideFeatureLinks(doc, { activity: false });
  eq(doc._anchors[0].hidden, true, "the Activity link");
  eq(doc._anchors[1].hidden, false, "an unrelated link is untouched");
});

check("a feature the map never mentions at all is never hidden -- a blank is not a zero", () => {
  const doc = fakeDocWithLinks(["/activity-page"]);
  sessionBar.hideFeatureLinks(doc, {});
  eq(doc._anchors[0].hidden, false, "no explicit false means no hiding");
});

check("features undefined (a failed /site) hides nothing at all", () => {
  const doc = fakeDocWithLinks(["/activity-page"]);
  sessionBar.hideFeatureLinks(doc, undefined);
  eq(doc._anchors[0].hidden, false);
});

check("an explicit true is exactly as untouched as no entry at all", () => {
  const doc = fakeDocWithLinks(["/activity-page"]);
  sessionBar.hideFeatureLinks(doc, { activity: true });
  eq(doc._anchors[0].hidden, false);
});

/* ------------------------------------------------------------------ */
/* THE FEARED ONE: the bar itself, and the bootstrap that builds it.   */
/* ------------------------------------------------------------------ */

/** Runs session-bar.mjs's own bottom bootstrap in a fresh child process --
 *  the same isolation activityPage.harness.mjs's own THE FEARED ONE check
 *  uses, needed here because this module touches `window`/`document` for
 *  real at the bottom of the file, unconditionally, exactly like the
 *  production page always loads it. */
function runChild(activityOn) {
  const url = pathToFileURL(join(root, "agent/ui/session-bar.mjs")).href;
  const code = `
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => "";
        if (k === "then") return undefined;
        if (k === "value" || k === "textContent" || k === "cssText") return "";
        if (k === "length") return 0;
        if (k === "hidden") return false;
        return fake;
      },
      apply() { return fake; },
      set() { return true; },
    };
    const fake = new Proxy(function () {}, handler);
    const anchors = [{ hidden: false, getAttribute: (n) => (n === "href" ? "/activity-page" : null) }];
    globalThis.document = {
      getElementById: () => fake, createElement: () => fake, createElementNS: () => fake,
      createTextNode: () => fake, querySelector: () => fake, querySelectorAll: () => anchors,
      addEventListener() {}, body: fake, documentElement: fake, visibilityState: "visible",
    };
    globalThis.window = { location: { pathname: "/", replace() {} }, addEventListener() {}, fetch: undefined, matchMedia: undefined };
    globalThis.location = globalThis.window.location;
    const calls = [];
    globalThis.window.fetch = (url) => {
      calls.push(String(url));
      if (String(url).startsWith("/auth/state")) {
        return Promise.resolve({ status: 200, json: async () => ({ ok: true, principal: { kind: "user", username: "alice", role: "store" }, permissions: ["live.view", "events.view"] }) });
      }
      if (String(url).startsWith("/site")) {
        return Promise.resolve({ status: 200, json: async () => ({ ok: true, displayName: null, timeZone: "UTC", features: { activity: ${activityOn} } }) });
      }
      return Promise.resolve({ status: 404, json: async () => ({ ok: false }) });
    };
    await import(${JSON.stringify(url)} + "?boot=${activityOn}");
    await new Promise((r) => setTimeout(r, 150));
    console.log(JSON.stringify({ calls, staticAnchorHidden: anchors[0].hidden }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", cwd: root, timeout: 20_000 });
  if (r.status !== 0) throw new Error(`child failed: ${(r.stderr || "").slice(0, 800)}`);
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1] || "null");
}

await check("THE FEARED ONE: the real page fetches /site on its own, alongside /auth/state, with no harness calling it", () => {
  const out = runChild(true);
  eq(out.calls.some((u) => u.startsWith("/auth/state")), true, `asked who is signed in: ${JSON.stringify(out.calls)}`);
  eq(out.calls.some((u) => u.startsWith("/site")), true, `asked which features are on: ${JSON.stringify(out.calls)}`);
});

await check("a switched-off feature hides even a static <a> already in the page, not just the bar's own link", () => {
  const out = runChild(false);
  eq(out.staticAnchorHidden, true, "the page's own Activity link, present before the bar ran");
});

await check("an switched-on feature leaves the same static link alone", () => {
  const out = runChild(true);
  eq(out.staticAnchorHidden, false);
});

/** Drives the real bar() (via the bottom bootstrap) for one principal/
 *  feature combination, and returns the hrefs it actually built PLUS which
 *  of them hideRefusedLinks then hid -- proving the two-permission,
 *  two-switch combination end to end, not just each half in isolation. */
function runBarChild(principal, permissions, managerRulesOn) {
  const url = pathToFileURL(join(root, "agent/ui/session-bar.mjs")).href;
  const code = `
    const built = [];
    function fakeAnchor() {
      const a = { hidden: false, href: "", textContent: "",
        getAttribute(n) { return n === "href" ? a.href : null; },
        set style(v) {}, addEventListener() {} };
      return a;
    }
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => "";
        if (k === "then") return undefined;
        if (k === "value" || k === "cssText") return "";
        if (k === "length") return 0;
        if (k === "hidden") return false;
        return fake;
      },
      apply() { return fake; },
      set() { return true; },
    };
    const fake = new Proxy(function () {}, handler);
    globalThis.document = {
      getElementById: () => fake,
      createElement: (tag) => { if (tag === "a") { const a = fakeAnchor(); built.push(a); return a; } return fake; },
      createElementNS: () => fake, createTextNode: () => fake,
      querySelector: () => fake, querySelectorAll: () => built,
      addEventListener() {}, body: fake, documentElement: fake, visibilityState: "visible",
    };
    globalThis.window = { location: { pathname: "/", replace() {} }, addEventListener() {}, fetch: undefined };
    globalThis.location = globalThis.window.location;
    globalThis.window.fetch = (u) => {
      const uu = String(u);
      if (uu.startsWith("/auth/state")) {
        return Promise.resolve({ status: 200, json: async () => ({ ok: true, principal: ${JSON.stringify(principal)}, permissions: ${JSON.stringify(permissions)} }) });
      }
      if (uu.startsWith("/site")) {
        return Promise.resolve({ status: 200, json: async () => ({ ok: true, displayName: null, timeZone: "UTC", features: { activity: true, managerRules: ${managerRulesOn} } }) });
      }
      return Promise.resolve({ status: 404, json: async () => ({ ok: false }) });
    };
    await import(${JSON.stringify(url)} + "?bar=" + Math.random());
    await new Promise((r) => setTimeout(r, 150));
    console.log(JSON.stringify(built.map((a) => ({ href: a.href, hidden: a.hidden }))));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", cwd: root, timeout: 20_000 });
  if (r.status !== 0) throw new Error(`child failed: ${(r.stderr || "").slice(0, 800)}`);
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1] || "[]");
}

await check("REQUIRED: a manager, managerRules on, sees Rules and Reports, neither hidden", () => {
  const anchors = runBarChild({ kind: "user", username: "mgr", role: "manager" },
    ["live.view", "playback.view", "layout.edit", "events.view", "rules.manage", "hours.manage"], true);
  const rules = anchors.find((a) => a.href === "/rules-page");
  const reports = anchors.find((a) => a.href === "/reports-page");
  eq(rules !== undefined && rules.hidden, false, `Rules link visible: ${JSON.stringify(anchors)}`);
  eq(reports !== undefined && reports.hidden, false, `Reports link visible: ${JSON.stringify(anchors)}`);
});

await check("REQUIRED: a store account, managerRules on, sees Reports but Rules is hidden (no rules.manage)", () => {
  const anchors = runBarChild({ kind: "user", username: "clerk", role: "store" },
    ["live.view", "playback.view", "export.create", "segment.hold", "layout.edit", "events.view"], true);
  const rules = anchors.find((a) => a.href === "/rules-page");
  const reports = anchors.find((a) => a.href === "/reports-page");
  eq(rules === undefined || rules.hidden, true, `Rules link hidden for store: ${JSON.stringify(anchors)}`);
  eq(reports !== undefined && reports.hidden, false, `Reports link visible for store: ${JSON.stringify(anchors)}`);
});

await check("REQUIRED: managerRules off hides both links even for an installer who holds every permission", () => {
  const anchors = runBarChild({ kind: "user", username: "tech", role: "installer" },
    ["live.view", "playback.view", "export.create", "segment.hold", "layout.edit", "camera.manage",
      "storage.manage", "system.manage", "account.manage", "audit.view", "events.view", "network.view",
      "rules.manage", "hours.manage"], false);
  const rules = anchors.find((a) => a.href === "/rules-page");
  const reports = anchors.find((a) => a.href === "/reports-page");
  eq(rules === undefined, true, `Rules link never even built when managerRules is off: ${JSON.stringify(anchors)}`);
  eq(reports === undefined, true, `Reports link never even built when managerRules is off: ${JSON.stringify(anchors)}`);
});

report("session bar feature");
