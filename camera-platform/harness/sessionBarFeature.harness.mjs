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

check("FEATURE_LINKS names the Activity page, and nothing this round did not add", () => {
  eq(sessionBar.FEATURE_LINKS, { "/activity-page": "activity" });
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

report("session bar feature");
