/**
 * The Recording page's retention line and fills-first warning
 * (agent/ui/recording-client.mjs), run without a browser.
 *
 * recording-client.mjs is a self-executing page script: it grabs its DOM
 * elements at module load and calls start() at the bottom, with nothing
 * exported. There is no way to import a function out of it. So, the way
 * harness/reviewPage.harness.mjs already does for review.html's own inline
 * script, this harness reads the file as text, appends ONE line exposing the
 * handful of internal names this suite needs on `globalThis.__page`, and
 * drops the trailing `start();` call (which would otherwise reach the real
 * network via fetch for no reason this suite needs). Nothing about the
 * shipped file changes; the instrumentation lives only in the copy this
 * harness writes to a temp file.
 *
 * The failure this suite fears (build rule 19): the two numbers a floor and
 * an estimate produce look identical on screen. On 2026-09-21 the laptop NVR
 * held 4.1 h and nothing said so was uncertain -- this page must never say
 * "at least" and "about" in the same words, and must never call a fill order
 * from a floor (house rule 11: report measurements, don't render verdicts).
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, eq, report } from "./_assert.mjs";

console.log("recording client: retention line + fills-first");

/* ── the smallest DOM this page's contract needs ──────────────────────────── */

class FakeEl {
  constructor(tag, id = null) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.value = "";
    this.min = "";
    this.max = "";
    this._text = "";
    this.classList = {
      set: new Set(),
      add(c) { this.set.add(c); },
      remove(c) { this.set.delete(c); },
      contains(c) { return this.set.has(c); },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  addEventListener() { /* wiring is not this suite's concern -- see report */ }
  setAttribute(k, v) { this[k] = String(v); }
  getAttribute(k) { return this[k] ?? null; }
  // Same invariant as the System and review pages: nothing here builds markup
  // from data, so nothing here may need innerHTML.
  set innerHTML(_) { throw new Error("the page must not use innerHTML"); }
  get innerHTML() { return ""; }
}

const PAGE_IDS = [
  "whoami", "message", "signOut", "storageError", "storeList", "retentionLine",
  "settingsNotice", "currentSetting", "limitNone", "limitDays", "days",
  "saveRetention", "fillsFirst", "confirmDelete", "confirmDeleteText",
  "confirmDeleteYes", "confirmDeleteNo",
];

function freshDom() {
  const byId = {};
  for (const id of PAGE_IDS) byId[id] = new FakeEl(id === "storeList" ? "div" : "span", id);
  byId.limitNone.checked = true; // matches recording.html: "until the drives are full" is the default radio
  return byId;
}

/* ── load the real file, expose its internals the way reviewPage.harness.mjs does ── */

const stateDir = await mkdtemp(join(tmpdir(), "camplat-recording-client-"));
const source = (await readFile(join(import.meta.dirname, "..", "agent", "ui", "recording-client.mjs"), "utf8"))
  .replaceAll("\r\n", "\n"); // a CRLF checkout must not break this anchor -- see reviewPage.harness.mjs
const START = "\nstart();\n";
if (!source.endsWith(START)) {
  throw new Error("recording-client.mjs must still end with a bare start(); call -- update this harness's anchor");
}
const EXPOSED = [
  "renderRetention", "updateFillsFirst", "formatHoursOrDays", "retentionSpace", "selectedMaxDays",
];
// retentionInfo is a module-private `let`, not a function, so a getter/setter
// pair is exposed for it instead of the name itself. Everything else here is
// the file's own, unmodified function -- this harness calls the real code.
const instrumented = source.slice(0, -START.length) + `
globalThis.__page = {
  ${EXPOSED.join(", ")},
  get retentionInfo() { return retentionInfo; },
  set retentionInfo(v) { retentionInfo = v; },
};
`;
const tmpScript = join(stateDir, "recording-client.instrumented.mjs");
await writeFile(tmpScript, instrumented);

let byId;
globalThis.document = {
  getElementById: (id) => byId[id] ?? null,
  createElement: (tag) => new FakeEl(tag),
  querySelectorAll: () => [], // clearBad() only; out of this suite's scope
};
byId = freshDom();

await import(pathToFileURL(tmpScript).href);
const page = globalThis.__page;

/* ── helpers ───────────────────────────────────────────────────────────────── */

// A minimal RetentionSummary["ok"] shape (contracts/siteHealth.ts), with just
// the fields renderRetention/updateFillsFirst read.
const ok = (over = {}) => ({
  kind: "ok", hours: 1, days: 1 / 24, basis: "at_least", limitingCameraId: "cam1-main",
  spaceHours: 1, spaceBasis: "at_least", cameras: [], stores: [], totalKbps: 0, camerasCounted: 1,
  ...over,
});

function setLimit(days) {
  if (days === null) {
    byId.limitNone.checked = true;
    byId.limitDays.checked = false;
    byId.days.value = "";
  } else {
    byId.limitNone.checked = false;
    byId.limitDays.checked = true;
    byId.days.value = String(days);
  }
}

function render(retention, limitDays) {
  page.retentionInfo = retention;
  setLimit(limitDays);
  page.renderRetention();
  page.updateFillsFirst();
  return {
    line: byId.retentionLine.textContent, lineHidden: byId.retentionLine.hidden,
    warn: byId.fillsFirst.textContent, warnHidden: byId.fillsFirst.hidden,
  };
}

/* ── formatHoursOrDays / retentionSpace: pure, no DOM ─────────────────────── */

check("formatHoursOrDays: under 48 h stays in hours, 48 h and over becomes days", () => {
  eq(page.formatHoursOrDays(4.3), "4.3 hours", "4.3");
  eq(page.formatHoursOrDays(47.96), "48.0 hours", "rounds up to the boundary text, not the boundary itself");
  eq(page.formatHoursOrDays(48), "2.0 days", "the boundary itself");
  eq(page.formatHoursOrDays(31.6), "31.6 hours", "31.6");
  eq(page.formatHoursOrDays(60), "2.5 days", "60");
});

check("retentionSpace: reads spaceHours/spaceBasis; falls back to days*24 as \"projected\" for an older server", () => {
  eq(page.retentionSpace(ok({ spaceHours: 4.3, spaceBasis: "at_least" })), { hours: 4.3, basis: "at_least" }, "spaceHours present");
  eq(page.retentionSpace(ok({ spaceHours: 31.6, spaceBasis: "projected" })), { hours: 31.6, basis: "projected" }, "spaceHours present");
  eq(page.retentionSpace({ kind: "ok", days: 2, hours: 48 }), { hours: 48, basis: "projected" }, "older server, no spaceHours: never claim \"measured\" or \"at_least\" it never sent");
  eq(page.retentionSpace({ kind: "ok" }), null, "neither field present: nothing to show");
});

/* ── renderRetention: the exact sentence for each basis ───────────────────── */

check("renderRetention: today's real number -- 4.3 h, at_least, still filling", () => {
  const r = render(ok({ spaceHours: 4.3, spaceBasis: "at_least" }), null);
  eq(r.line, "The drives hold at least 4.3 hours so far. They are still filling, so how long they will hold is not known until there is a full day of recording.", "line");
  eq(r.lineHidden, false, "line shown");
});

check("renderRetention: 31.6 h, projected (estimate from the last full day)", () => {
  const r = render(ok({ spaceHours: 31.6, spaceBasis: "projected" }), null);
  eq(r.line, "At the current recording rate the drives hold about 31.6 hours (estimate from the last full day).", "line");
});

check("renderRetention: measured (drive full) states the figure as fact, not an estimate", () => {
  const r = render(ok({ spaceHours: 60, spaceBasis: "measured" }), null);
  eq(r.line, "The drives are full and hold about 2.5 days.", "line");
});

check("renderRetention: kind unknown keeps the server's refusal message, unchanged", () => {
  const r = render({ kind: "unknown", reason: "no_cameras", message: "no cameras are configured, so there is nothing to keep", unmeasuredCameraIds: [], cameras: [], stores: [] }, null);
  eq(r.line, "How long the drives hold can't be worked out yet: no cameras are configured, so there is nothing to keep", "line");
});

check("renderRetention: no retention info at all (health poll failed) hides the line instead of guessing", () => {
  page.retentionInfo = null;
  page.renderRetention();
  eq([byId.retentionLine.textContent, byId.retentionLine.hidden], ["", true], "cleared and hidden");
});

/* ── updateFillsFirst: never a verdict from a floor ───────────────────────── */

check("THE FEARED ONE: today's real numbers -- 4.3 h at_least, no limit set, shows no warning", () => {
  const r = render(ok({ spaceHours: 4.3, spaceBasis: "at_least" }), null);
  eq([r.warn, r.warnHidden], ["", true], "no limit is being edited, so there is nothing to compare against");
});

check("THE FEARED ONE: 31.6 h projected, a 1-day limit being typed -- the limit binds first, no warning", () => {
  const r = render(ok({ spaceHours: 31.6, spaceBasis: "projected" }), 1);
  eq([r.warn, r.warnHidden], ["", true], "31.6 h already outlasts the 24 h limit");
});

check("at_least, limit typed BELOW the floor: not known yet, never a fills-first verdict", () => {
  const r = render(ok({ spaceHours: 4.3, spaceBasis: "at_least" }), 1); // 24 h limit > 4.3 h floor
  eq(r.warn, "Not known yet whether the drives fill before this limit.", "warn text");
  eq(r.warnHidden, false, "shown");
});

check("at_least, limit typed AT OR ABOVE the floor: the floor already covers it, so no warning at all", () => {
  const r = render(ok({ spaceHours: 100, spaceBasis: "at_least" }), 1); // 24 h limit <= 100 h floor
  eq([r.warn, r.warnHidden], ["", true], "no warning");
});

check("measured/projected, limit shorter than the space: the existing fills-first warning, hours-scale", () => {
  const r = render(ok({ spaceHours: 10, spaceBasis: "measured" }), 1); // 24 h limit > 10 h
  eq(r.warn, "The drives fill in about 10.0 hours, before this limit, so the oldest recordings will be deleted sooner.", "warn text");
  eq(r.warnHidden, false, "shown");
});

check("measured/projected, limit shorter than the space: the existing fills-first warning, days-scale", () => {
  const r = render(ok({ spaceHours: 60, spaceBasis: "projected" }), 5); // 120 h limit > 60 h
  eq(r.warn, "The drives fill in about 2.5 days, before this limit, so the oldest recordings will be deleted sooner.", "warn text");
});

check("measured/projected, limit longer than the space: the limit is what deletes, no warning", () => {
  const r = render(ok({ spaceHours: 200, spaceBasis: "projected" }), 5); // 120 h limit < 200 h
  eq([r.warn, r.warnHidden], ["", true], "no warning");
});

check("no limit being edited at all: no warning regardless of basis", () => {
  const r = render(ok({ spaceHours: 1, spaceBasis: "measured" }), null);
  eq([r.warn, r.warnHidden], ["", true], "no limit");
});

check("retention unknown: no warning, however the limit is set", () => {
  page.retentionInfo = { kind: "unknown", reason: "cameras_unknown", message: "x", unmeasuredCameraIds: [], cameras: [], stores: [] };
  setLimit(3);
  page.updateFillsFirst();
  eq([byId.fillsFirst.textContent, byId.fillsFirst.hidden], ["", true], "no warning without a measured space");
});

report("recording client: retention line + fills-first");
