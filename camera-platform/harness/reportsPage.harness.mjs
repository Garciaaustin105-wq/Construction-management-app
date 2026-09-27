/**
 * agent/ui/reports-client.mjs: the Reports page (MANAGER-RULES-SPEC.md
 * section 5) -- day-string/shift helpers, the coverage line's exact
 * wording, the Review deep link, and the browser bootstrap block
 * (camera-page-bootstrap-lesson, agent bus 2026-09-26).
 *
 * NOT REGISTERED in harness/run-all.mjs; run it directly:
 * `node harness/reportsPage.harness.mjs`.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { check, eq, report } from "./_assert.mjs";

const root = process.cwd();
const client = await import(pathToFileURL(join(root, "agent/ui/reports-client.mjs")).href);

console.log("reports page");

check("dayStringInZone gives YYYY-MM-DD in the named zone, not the process's own", () => {
  // 2026-09-26T23:30:00Z is still 2026-09-26 in UTC but already 2026-09-27 in
  // a zone ahead of it (Asia/Tokyo, UTC+9) -- proving the zone argument is
  // actually used, not the runner's own local time.
  const ms = Date.parse("2026-09-26T23:30:00Z");
  eq(client.dayStringInZone("UTC", ms), "2026-09-26");
  eq(client.dayStringInZone("Asia/Tokyo", ms), "2026-09-27");
});

check("shiftDay moves by exactly one calendar date, including across a month/year boundary", () => {
  eq(client.shiftDay("2026-09-26", 1), "2026-09-27");
  eq(client.shiftDay("2026-09-26", -1), "2026-09-25");
  eq(client.shiftDay("2026-09-30", 1), "2026-10-01");
  eq(client.shiftDay("2026-01-01", -1), "2025-12-31");
});

check("REQUIRED: the coverage line matches the spec's own exact wording", () => {
  const iso = "2026-06-01T00:00:00Z";
  eq(client.coverageText(iso, "UTC"), "Reports go back to 2026-06-01, as far as this NVR keeps video.");
});

check("no footage yet (oldestFootageUtc null) gets its own honest line, never a coverage claim it cannot back up", () => {
  eq(client.coverageText(null, "UTC"), "No footage recorded on this NVR yet.");
});

check("REQUIRED: the Review deep link is exactly /review?camera=&at=, keyed to the firing's own startMs", () => {
  const link = client.reviewLinkFor({ cameraId: "cam-1", startMs: Date.parse("2026-09-26T14:10:00Z") });
  eq(link, "/review?camera=cam-1&at=2026-09-26T14%3A10%3A00.000Z");
});

/** A minimal fake `doc` good enough for renderReport's own DOM writes. */
function fakeDoc() {
  function fakeEl(tag) {
    const node = {
      tag, children: [], attrs: {}, _text: "", hidden: false,
      get textContent() { return this._text; },
      set textContent(v) { this._text = v; this.children = []; },
      append(...kids) { for (const k of kids) this.children.push(k); },
      setAttribute(k, v) { this.attrs[k] = v; if (k === "href") node.href = v; },
      addEventListener() {},
    };
    return node;
  }
  const store = {};
  return {
    _store: store,
    createElement: (tag) => fakeEl(tag),
    getElementById: (id) => (store[id] = store[id] || fakeEl("div")),
  };
}

check("renderReport draws each firing's own server-supplied text via textContent, never re-derived, and its own Review link", () => {
  const doc = fakeDoc();
  client.renderReport(doc, {
    day: "2026-09-26", timeZone: "America/Chicago", oldestFootageUtc: "2026-01-01T00:00:00Z",
    groups: [{
      ruleId: "r1", ruleName: "Manager's desk unattended",
      firings: [{ cameraId: "cam-1", startMs: Date.parse("2026-09-26T14:10:00Z"), text: "Manager's desk unattended 9:10-9:55 (45 min)" }],
    }],
  }, () => {});
  const groups = doc._store.reportGroups;
  eq(groups.children.length, 1);
  const group = groups.children[0];
  const heading = group.children[0];
  eq(heading.textContent, "Manager's desk unattended");
  const li = group.children[1].children[0];
  const lineSpan = li.children[0];
  eq(lineSpan.textContent, "Manager's desk unattended 9:10-9:55 (45 min)");
  const link = li.children[1];
  eq(link.href, "/review?camera=cam-1&at=2026-09-26T14%3A10%3A00.000Z");
});

check("an empty day shows #reportEmpty and hides no coverage line", () => {
  const doc = fakeDoc();
  client.renderReport(doc, { day: "2026-09-26", timeZone: "UTC", oldestFootageUtc: null, groups: [] }, () => {});
  eq(doc._store.reportEmpty.hidden, false);
  eq(doc._store.reportCoverage.textContent, "No footage recorded on this NVR yet.");
});

/** THE FEARED ONE: with #reportBody in the DOM, the real bootstrap fetches
 *  GET /reports on its own, with no harness calling startReportsPage
 *  directly -- same isolation shape as harness/activityPage.harness.mjs. */
await check("THE FEARED ONE: the real bootstrap asks GET /reports on its own", () => {
  const clientUrl = pathToFileURL(join(root, "agent/ui/reports-client.mjs")).href;
  const code = `
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => "";
        if (k === "then") return undefined;
        if (k === "value" || k === "textContent") return "";
        if (k === "length") return 0;
        if (k === "hidden") return false;
        return fake;
      },
      apply() { return fake; },
      set() { return true; },
    };
    const fake = new Proxy(function () {}, handler);
    globalThis.document = {
      getElementById: (id) => (id === "reportBody" ? fake : null),
      createElement: () => fake, createElementNS: () => fake, createTextNode: () => fake,
      querySelector: () => fake, querySelectorAll: () => [],
      addEventListener() {}, body: fake, documentElement: fake,
    };
    globalThis.window = { location: { assign() {} }, addEventListener() {} };
    const calls = [];
    globalThis.fetch = (url) => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, day: "2026-09-26", timeZone: "UTC", groups: [], oldestFootageUtc: null }) });
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
  eq(calls.some((u) => u.startsWith("/reports?day=")), true, `it asked for /reports on its own: ${JSON.stringify(calls)}`);
});

report("reports page");
