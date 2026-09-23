/**
 * The review page's script, run for real: the <script type="module"> out of
 * agent/ui/review.html, against the real api server on a real socket, with
 * only the DOM faked. A browser is still the only proof that a <video> seeks
 * into a fragmented MP4 (REVIEW-UI-SPEC.md says so); everything the page
 * DECIDES is checked here.
 *
 * The failures tested (build rule 19): a slow answer for a day the user has
 * already left drawn over the day they are on; a DST day built by adding
 * 86 400 000; a gap that plays on silently instead of stopping with its
 * reason; a camera refusal that shows nothing; the error the browser fires
 * when the page itself clears the video, reported as a codec failure.
 *
 * The clock is pinned (server now = 2026-09-11T12:00:00Z) and the time zone is
 * pinned (America/New_York), so "local day" means the same thing on every
 * machine.
 */
process.env.TZ = "America/New_York";

import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createApiServer } from "../agent/api-server.mjs";
// These suites test the routes, not sign-in: an installer is always signed in.
// Access itself is proven in auth.harness.mjs against the real module.
const installerAuth = {
  principalOf: () => ({ kind: "user", username: "tech", role: "installer" }),
  handle: async () => false,
  audit: () => {},
};
import { openIndex } from "../agent/segindex.mjs";
import { closeAll } from "../agent/live.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("review page");
const now = () => new Date("2026-09-11T12:00:00Z");
const ms = (iso) => Date.parse(iso);

/* ── the recorder: segments A, B, a logged gap, C, and an open one ─────────── */

const stateDir = await mkdtemp(join(tmpdir(), "camplat-review-"));
const disk0 = join(stateDir, "disk0");
await mkdir(join(disk0, "cam-1"), { recursive: true });
const config = {
  siteId: "carwash-01",
  storeRoots: [disk0],
  credentials: { username: "svc", password: "p@ss" },
  segmentSeconds: 60,
  cameras: [
    { cameraId: "cam-1", host: "10.0.0.5", vendor: "generic", name: "Bay 1" },
    { cameraId: "cam-2", host: "10.0.0.6", vendor: "generic" },
  ],
};
const index = openIndex(join(stateDir, "index.db"));
const seg = (startUtc, endUtc, state) => ({
  cameraId: "cam-1", startUtc, endUtc, path: `cam-1/${ms(startUtc)}.mp4`, bytes: 10, state,
  hold: false, pendingUpload: false, bitrateKbps: null,
});
for (const [s, e] of [["2026-09-11T10:00:00Z", "2026-09-11T10:01:00Z"],
  ["2026-09-11T10:01:00Z", "2026-09-11T10:02:00Z"], ["2026-09-11T10:05:00Z", "2026-09-11T10:06:00Z"]]) {
  index.put(seg(s, e, "sealed"));
  await writeFile(join(disk0, "cam-1", `${ms(s)}.mp4`), Buffer.alloc(10, 7));
}
index.put(seg("2026-09-11T11:58:00Z", null, "open"));
index.addGap({ cameraId: "cam-1", startUtc: "2026-09-11T10:02:00Z", endUtc: "2026-09-11T10:05:00Z", reason: "camera_offline" });

// What the detector found that day (D2). Two people and a car inside the
// recorded stretches, two of them in the same second — the pair a "next"
// button stepping on the clock alone would silently skip — and one on another
// day, which must not appear on this one.
const EVENTS = [
  ["e-person-1", "person", "2026-09-11T10:00:30Z", 6000],
  ["e-car-1", "vehicle", "2026-09-11T10:00:30Z", 9000],
  ["e-person-2", "person", "2026-09-11T10:05:30Z", 4000],
  ["e-yesterday", "person", "2026-09-10T10:00:00Z", 4000],
];
{
  const { openEventsDb } = await import("../agent/events-db.mjs");
  const db = openEventsDb(join(stateDir, "events.db"));
  for (const [id, kind, at, len] of EVENTS) {
    db.upsert({ id, event: {
      id, cameraId: "cam-1", kind,
      firstUtc: new Date(ms(at)).toISOString(),
      lastUtc: new Date(ms(at) + len).toISOString(),
      count: 20, bestConfidence: 0.81,
      bestBox: { x: 0.3, y: 0.2, w: 0.1, h: 0.5 },
      bestUtc: new Date(ms(at)).toISOString(),
    } }, true);
  }
  db.close();
}

const server = createApiServer({ stateDir, config, index, now, auth: installerAuth });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const host = `127.0.0.1:${server.address().port}`;
const idOf = (iso) => `cam-1.${ms(iso)}`;

/* ── the smallest DOM the page's contract allows ──────────────────────────── */

class FakeEl {
  constructor(tag, id = null) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.className = "";
    this.hidden = false;
    this.value = "";
    this.title = "";
    this.attrs = {};
    this.listeners = {};
    this._text = "";
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v); }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children.at(-1) ?? null; }
  get childNodes() { return this.children; }
  get options() { return this.children; }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.children.push(c); return c;
  }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === "string" ? textNode(c) : c); }
  insertBefore(c, ref) {
    if (ref === null) return this.appendChild(c);
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = this.children.indexOf(ref);
    if (i < 0) throw new Error("insertBefore: ref is not a child");
    c.parentNode = this; this.children.splice(i, 0, c); return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i < 0) throw new Error("removeChild: not a child");
    this.children.splice(i, 1); c.parentNode = null; return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...cs) { this.textContent = ""; this.append(...cs); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "href") this.href = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; if (k === "src") this.src = ""; }
  addEventListener(type, fn, opts) {
    (this.listeners[type] ??= []).push({ fn, once: Boolean(opts && opts.once) });
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l.fn !== fn);
  }
  fire(type, extra = {}) {
    const ls = this.listeners[type] ?? [];
    this.listeners[type] = ls.filter((l) => !l.once);
    for (const l of ls) l.fn({ type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra });
  }
  dispatchEvent(ev) { this.fire(ev && ev.type); return true; }
  set innerHTML(_) { throw new Error("the page must not use innerHTML"); }
}
globalThis.Event = class { constructor(type) { this.type = String(type); } };
const textNode = (s) => { const t = new FakeEl("#text"); t._text = s; return t; };

class FakeVideo extends FakeEl {
  constructor(id) { super("video", id); this.src = ""; this.currentTime = 0; this.playbackRate = 1; this.defaultPlaybackRate = 1; this.plays = 0; this.paused = true; this.loads = 0; }
  play() { this.plays++; this.paused = false; return Promise.reject(new Error("autoplay blocked")); }
  pause() { this.paused = true; }
  load() { this.loads++; }
}

let page;
function freshDom() {
  const byId = {};
  for (const [id, tag] of [["camera", "select"], ["day", "input"], ["prevDay", "button"], ["nextDay", "button"],
    ["pageError", "div"], ["strip", "div"], ["playhead", "div"], ["hours", "div"], ["status", "div"],
    ["exportFrom", "select"], ["exportTo", "select"], ["exportBtn", "button"], ["exportStatus", "div"],
    ["cameraTiles", "div"], ["dayBtn", "button"], ["calendar", "div"], ["calPrev", "button"],
    ["calNext", "button"], ["calLabel", "span"], ["calGrid", "div"],
    ["saveVideoBtn", "button"], ["teachBtn", "button"], ["sheet", "div"], ["sheetTitle", "h2"],
    ["sheetClose", "button"], ["sheetGo", "button"], ["sheetStatus", "div"], ["sheetRange", "div"],
    ["lengthChips", "div"], ["teachFields", "div"], ["teachProgress", "div"], ["nobodyChip", "button"],
    ["exactNote", "div"],
    ["peopleMinus", "button"], ["peopleN", "span"], ["peoplePlus", "button"],
    ["vehiclesMinus", "button"], ["vehiclesN", "span"], ["vehiclesPlus", "button"],
    ["slower", "button"], ["faster", "button"], ["rate", "span"], ["back10", "button"], ["fwd10", "button"],
    ["clock", "span"], ["clipPeople", "select"], ["clipVehicles", "select"], ["clipSaveBtn", "button"],
    ["clipStatus", "div"],
    ["events", "div"], ["prevEvent", "button"], ["nextEvent", "button"],
    ["filterPerson", "button"], ["filterVehicle", "button"], ["filterPlate", "button"],
    ["eventTiles", "div"], ["eventNote", "div"],
    ["hiddenRow", "div"], ["hiddenNote", "span"], ["hiddenToggle", "button"],
    ["knownObjects", "div"], ["knownObjectsList", "div"]]) {
    byId[id] = new FakeEl(tag, id);
    byId[id].disabled = false;
  }
  for (const tag of ["empty", "person", "vehicle", "shadows", "headlights", "rain", "animal", "night"]) {
    const box = new FakeEl("input", "clipTag-" + tag);
    box.checked = false;
    byId[box.id] = box;
  }
  byId.video = new FakeVideo("video");
  byId.pageError.hidden = true;
  byId.playhead.hidden = true;
  byId.calendar.hidden = true;
  byId.sheet.hidden = true;
  byId.teachFields.hidden = true;
  byId.events.hidden = true;
  byId.filterPlate.hidden = true;
  byId.hiddenRow.hidden = true;
  byId.knownObjects.hidden = true;
  byId.strip.appendChild(byId.playhead);
  byId.strip.getBoundingClientRect = () => ({ left: 100, width: 1000, top: 0, height: 36 });
  return byId;
}

let fetchLog = [];
let fetchBroken = false;
// A promise that holds every /playback answer until it resolves: a slow recorder.
let holdPlayback = null;
// The same for /export/plan.
let holdPlan = null;
const realFetch = globalThis.fetch;
// Listeners the page puts on the document (visibilitychange), kept so a
// check can fire them. `hidden` is flipped by the checks that need it.
const docListeners = [];
function install(byId) {
  globalThis.document = {
    hidden: false,
    addEventListener: (type, fn) => { docListeners.push({ type, fn }); },
    getElementById: (id) => byId[id] ?? null,
    createElement: (tag) => (tag === "video" ? new FakeVideo() : new FakeEl(tag)),
    createTextNode: textNode,
  };
  globalThis.location = { host, protocol: "http:" };
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    fetchLog.push(u);
    if (fetchBroken) return Promise.reject(new TypeError("fetch failed"));
    if (!u.startsWith("/")) throw new Error(`the page fetched a non-relative URL: ${u}`);
    if (holdPlayback && u.startsWith("/playback?")) {
      return holdPlayback.then(() => realFetch(`http://${host}${u}`, opts));
    }
    if (holdPlan && u.startsWith("/export/plan?")) {
      return holdPlan.then(() => realFetch(`http://${host}${u}`, opts));
    }
    return realFetch(`http://${host}${u}`, opts);
  };
}

// The script, verbatim, with its one import pointed at the file on disk and a
// handle on its top-level names appended. Nothing else about it changes.
// A Windows checkout is CRLF and everything below matches exact multi-line
// strings, so the line endings are normalised here rather than depended on.
// (They cost a green suite once: a rebase re-checked the file out as CRLF and
// the startup anchor stopped matching, for a reason nothing to do with the
// change.)
const html = (await readFile(join(import.meta.dirname, "..", "agent", "ui", "review.html"), "utf8"))
  .replaceAll("\r\n", "\n");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const clientUrl = pathToFileURL(join(import.meta.dirname, "..", "agent", "ui", "review-client.mjs")).href;
const NAMES = ["view", "el", "dayWindow", "shiftDay", "loadCameras", "loadDay", "clearStrip", "drawStrip",
  "drawHours", "movePlayhead", "playAt", "applyPlan", "stopVideo", "wireEvents",
  "exportWindow", "setExportStatus", "clearExport", "offerExport", "wireExport", "setRate", "step", "saveTestClip", "wireTestClip",
  "watchedInstant", "drawCameraTiles", "chooseCamera", "chooseDay", "drawDayButton", "showCalendar",
  "stepMonth", "drawCalendar", "loadMonth", "fillTimeDropdowns", "chosenWindow", "openSheet",
  "closeSheet", "drawLengthChips", "pickLength", "sheetGo", "showCounts", "bumpCount", "tapNobody",
  "loadTeachProgress", "wireFriendly",
  "loadEvents", "drawEvents", "drawMarks", "drawTiles", "eventWords", "currentMomentUtc",
  "goToEvent", "updateStepButtons", "stepEvent", "refreshTick", "wireRefresh", "localDayValue", "chooseDay",
  "loadKnownObjects", "renderKnownObjects", "sendKnownObjectAnswer"];
// The handle goes in just before the two startup calls, so a throw while the
// page starts up is one failed check rather than a crashed suite.
const START = "\nwireFriendly();\nwireEvents();\nloadCameras();\n";
if (!script.includes(START)) throw new Error("review.html must end its script with wireFriendly(); wireEvents(); loadCameras();");
const bannerUrl = pathToFileURL(join(import.meta.dirname, "..", "agent", "ui", "alert-banner.mjs")).href;
// The speed ladder is the compiled contract, as the server serves it from dist.
const playbackUrl = pathToFileURL(join(import.meta.dirname, "..", "dist", "playback.mjs")).href;
const transformed = script.replace("'/ui/review-client.js'", `'${clientUrl}'`).replace("'/ui/alert-banner.js'", `'${bannerUrl}'`)
  .replace("'/ui/playback.js'", `'${playbackUrl}'`)
  .replace(START, `\nglobalThis.__page = { ${NAMES.join(", ")} };${START}`);
const tmpScript = join(stateDir, "review-page.mjs");
await writeFile(tmpScript, transformed);

const settle = () => new Promise((r) => setTimeout(r, 60));
async function until(fn, what, limitMs = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > limitMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const dom = freshDom();
install(dom);
// The page starts a 5-second refresh timer when it wires itself up. A real
// one would keep this suite alive for ever (report() sets the exit code, it
// does not exit) and fire loadDay() in the middle of other checks. So it is
// captured here, and the checks below fire ticks by hand.
const pageIntervals = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, everyMs) => { pageIntervals.push({ fn, everyMs }); return pageIntervals.length; };
let startupError = null;
await import(pathToFileURL(tmpScript).href).catch((e) => { startupError = e; });
globalThis.setInterval = realSetInterval;
page = globalThis.__page;
const barsOf = () => dom.strip.children.filter((c) => c !== dom.playhead);

/* ── the checks ───────────────────────────────────────────────────────────── */

await check("the page uses no innerHTML and only relative fetches", async () => {
  eq(html.includes("innerHTML"), false, "no innerHTML anywhere in the file");
  eq(html.includes("86400000") || html.includes("86_400_000"), false, "no day arithmetic in ms");
});

await check("dayWindow is local midnight to the next local midnight, DST days included", async () => {
  eq(page.dayWindow("2026-09-11"), { startUtc: "2026-09-11T04:00:00.000Z", endUtc: "2026-09-12T04:00:00.000Z" }, "a summer day");
  eq(page.dayWindow("2026-03-08"), { startUtc: "2026-03-08T05:00:00.000Z", endUtc: "2026-03-09T04:00:00.000Z" }, "spring forward: 23 h");
  eq(page.dayWindow("2026-11-01"), { startUtc: "2026-11-01T04:00:00.000Z", endUtc: "2026-11-02T05:00:00.000Z" }, "fall back: 25 h");
  for (const bad of ["", "2026-9-11", "2026-02-30", "2026-13-01", "2026-00-10", "20260911", "2026-09-11T00:00", null, undefined, 20260911]) {
    eq(page.dayWindow(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
});

await check("shiftDay crosses months, years and DST, and refuses what dayWindow refuses", async () => {
  eq(page.shiftDay("2026-03-01", -1), "2026-02-28", "back over February");
  eq(page.shiftDay("2026-12-31", 1), "2027-01-01", "into a new year");
  eq(page.shiftDay("2026-03-08", 1), "2026-03-09", "over spring forward");
  eq(page.shiftDay("2026-02-30", 1), null, "a day that does not exist");
});

await check("on load: cameras listed by name, today defaulted, a future day refused out loud", async () => {
  if (startupError) throw startupError;
  await until(() => dom.camera.children.length === 2 && !dom.pageError.hidden, "cameras + the first timeline's answer");
  eq(dom.camera.children.map((o) => [o.value, o.textContent]), [["cam-1", "Bay 1"], ["cam-2", "cam-2"]], "value = id, text = name else id");
  eq(/^\d{4}-\d{2}-\d{2}$/.test(dom.day.value), true, `today as YYYY-MM-DD: ${dom.day.value}`);
  // The server's clock is 2026-09-11, so the machine's real today is the future to it.
  eq(dom.pageError.hidden, false, "the error line is shown");
  eq(dom.pageError.textContent, "That day has not happened yet.", "the refusal in plain words, not a code");
  eq(barsOf().length, 0, "nothing drawn for a refused day");
});

await check("a day draws recorded, a widened reasoned gap, recorded, and the future tail", async () => {
  dom.day.value = "2026-09-11";
  fetchLog = [];
  await page.loadDay();
  const q = new URLSearchParams(fetchLog.find((u) => u.startsWith("/timeline?")).split("?")[1]);
  eq([q.get("camera"), q.get("start"), q.get("end"), q.get("buckets")],
    ["cam-1", "2026-09-11T04:00:00.000Z", "2026-09-12T04:00:00.000Z", "96"], "the query");
  eq(dom.pageError.hidden, true, "the error line is gone");
  const bars = barsOf();
  const kinds = bars.map((b) => b.className);
  eq(kinds.at(-1), "bar future", "the part after now is its own kind");
  const gap = bars.find((b) => b.className === "bar gap" && b.title.startsWith("Camera offline"));
  eq(Boolean(gap), true, `the logged gap carries its reason: ${bars.map((b) => b.title).join(" | ")}`);
  eq(gap.title, "Camera offline, 06:02 to 06:05", "reason, then local times");
  eq(parseFloat(gap.style.width) >= 0.399, true, `a 3 minute gap is widened to be seen: ${gap.style.width}`);
  eq(bars.some((b) => b.title === "Recorded, 06:00 to 06:02"), true, "recorded runs merge and read in local time");
  eq(dom.strip.lastChild === dom.playhead, true, "the playhead stays on top");
  eq(dom.hours.children.map((s) => s.textContent), ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"], "hour labels");
  eq(dom.hours.children[2].style.left, "25%", "06:00 sits a quarter of the way in");
});

await check("THE FEARED ONE: a slow answer for a day already left is not drawn", async () => {
  dom.day.value = "2026-09-11";
  const first = page.loadDay();
  dom.day.value = "2030-01-01";
  const second = page.loadDay();
  await Promise.all([first, second]);
  eq(dom.pageError.textContent, "That day has not happened yet.", "the day on screen is the second one");
  eq(barsOf().length, 0, "the first day's bars never land");
  dom.day.value = "2030-01-01";
  const a = page.loadDay();
  dom.day.value = "2026-09-11";
  const b = page.loadDay();
  await Promise.all([a, b]);
  eq(dom.pageError.hidden, true, "and the other way round: no stale error over a drawn day");
  eq(barsOf().length > 0, true, "the second day is drawn");
});

await check("a click on the strip plays the moment under it, at its offset", async () => {
  // The strip is 1000 px from x = 100, so one pixel is 86.4 s of the day.
  // x = 350.5 is fraction 0.2505: 21 643 200 ms after 04:00Z = 10:00:43.2Z,
  // 43.2 s into segment A.
  dom.strip.fire("click", { clientX: 350.5 });
  await until(() => dom.video.src !== "", "a src");
  eq(dom.video.src, `/segments/${idOf("2026-09-11T10:00:00Z")}`, "segment A through the segment route");
  dom.video.fire("loadedmetadata");
  eq(Math.abs(dom.video.currentTime - 43.2) < 1e-6, true, `seeked to the offset: ${dom.video.currentTime}`);
  eq(dom.video.plays, 1, "play() called once (its rejection swallowed)");
  eq(dom.status.textContent, "Playing from 06:00", "local time being played");
  dom.video.fire("loadedmetadata");
  eq(dom.video.plays, 1, "the seek listener was once-only");
});

await check("the playhead follows currentTime and hides off the day", async () => {
  dom.video.currentTime = 30;
  dom.video.fire("timeupdate");
  eq(dom.playhead.hidden, false, "shown");
  const want = ((6 * 3600 + 30) / 86400) * 100;
  eq(Math.abs(parseFloat(dom.playhead.style.left) - want) < 1e-6, true, `at ${dom.playhead.style.left}`);
  page.movePlayhead("2026-09-13T00:00:00Z");
  eq(dom.playhead.hidden, true, "a moment off the drawn day hides it, never pins it to an edge");
});

await check("THE FEARED ONE: continuous play stops at a gap and names it", async () => {
  dom.video.fire("ended");
  await until(() => dom.video.src.endsWith(idOf("2026-09-11T10:01:00Z")), "segment B");
  dom.video.fire("ended");
  await until(() => dom.status.className === "status problem", "the gap");
  eq(dom.status.textContent.startsWith("Camera offline"), true, `labelled: ${dom.status.textContent}`);
  eq(dom.video.paused, true, "the video stopped");
  eq(dom.video.src, "", "its src cleared");
  eq(dom.playhead.hidden, true, "the playhead hidden");
  const btn = dom.status.children.find((c) => c.tagName === "BUTTON");
  eq(btn?.textContent, "Jump to next recording", "a way past the gap");
  btn.fire("click");
  await until(() => dom.video.src.endsWith(idOf("2026-09-11T10:05:00Z")), "segment C");
});

await check("the error the page causes itself is not a codec failure; a real one is", async () => {
  page.stopVideo();
  dom.status.textContent = "";
  dom.video.fire("error");
  eq(dom.status.textContent, "", "clearing the src fires error: not reported");
  await page.playAt("2026-09-11T10:00:10Z");
  dom.video.fire("error");
  eq(dom.status.textContent, "This browser cannot play this recording (H.265 needs hardware decoding)", "said out loud");
  eq(dom.status.className, "status problem", "as a problem");
});

await check("live, future and refusals each say what they are", async () => {
  await page.playAt("2026-09-11T11:59:00Z");
  eq(dom.status.textContent, "This moment is still being recorded. Watch live", "live");
  eq(dom.status.children.find((c) => c.tagName === "A")?.href, "/", "linked to the live page");
  await page.playAt("2026-09-11T12:30:00Z");
  eq(dom.status.textContent, "That moment has not happened yet", "future");
  dom.camera.value = "../x";
  await page.playAt("2026-09-11T10:00:10Z");
  eq(dom.status.textContent.startsWith("bad_camera_id: "), true, `refusal shown: ${dom.status.textContent}`);
  eq(dom.status.className, "status problem", "as a problem");
  dom.camera.value = "cam-1";
});

await check("changing day or camera stops playback and redraws", async () => {
  await page.playAt("2026-09-11T10:00:10Z");
  eq(page.view.playing !== null, true, "playing");
  fetchLog = [];
  dom.day.value = "2026-09-12";
  dom.nextDay.fire("click");
  await until(() => fetchLog.some((u) => u.startsWith("/timeline?")), "a reload");
  eq(dom.day.value, "2026-09-13", "next day");
  eq(page.view.playing, null, "playback forgotten");
  dom.prevDay.fire("click");
  dom.prevDay.fire("click");
  eq(dom.day.value, "2026-09-11", "back two days");
  await settle();
  fetchLog = [];
  dom.camera.value = "cam-2";
  dom.camera.fire("change");
  await until(() => fetchLog.some((u) => u.includes("camera=cam-2")), "a reload for the new camera");
  await settle();
  eq(barsOf().every((b) => b.className !== "bar recorded"), true, "cam-2 has nothing recorded");
  dom.camera.value = "cam-1";
});

await check("THE FEARED ONE: a slow playback answer for a camera already left never plays", async () => {
  page.stopVideo();
  let release;
  holdPlayback = new Promise((r) => { release = r; });
  try {
    fetchLog = [];
    const pending = page.playAt("2026-09-11T10:00:10Z");
    await until(() => fetchLog.some((u) => u.startsWith("/playback?")), "the playback request");
    dom.camera.fire("change");
    release();
    await pending;
    await settle();
    eq(dom.video.src, "", "the old camera's segment was never loaded");
    eq(page.view.playing, null, "and nothing is recorded as playing");
    eq(dom.status.textContent.startsWith("Playing from"), false, `no stale status: ${dom.status.textContent}`);
  } finally {
    holdPlayback = null;
  }
  // A second click supersedes the first the same way.
  let release2;
  holdPlayback = new Promise((r) => { release2 = r; });
  try {
    const first = page.playAt("2026-09-11T10:00:10Z");
    holdPlayback = null;
    const second = page.playAt("2026-09-11T10:05:10Z");
    await second;
    release2();
    await first;
    eq(dom.video.src, `/segments/${idOf("2026-09-11T10:05:00Z")}`, "the later click wins, whatever answers last");
  } finally {
    holdPlayback = null;
    page.stopVideo();
  }
});

/* ── export ── */

const linkOf = () => dom.exportStatus.children.find((c) => c.tagName === "A") ?? null;
const planQuery = () => {
  const u = fetchLog.find((x) => x.startsWith("/export/plan?"));
  return u ? new URLSearchParams(u.split("?")[1]) : null;
};
async function offer(from, to) {
  dom.camera.value = "cam-1";
  dom.day.value = "2026-09-11";
  dom.exportFrom.value = from;
  dom.exportTo.value = to;
  fetchLog = [];
  await page.offerExport();
}

await check("test clip: the boxes follow the counts, so nobody types a contradiction", async () => {
  dom.clipPeople.value = "2";
  dom.clipPeople.fire("change");
  eq([dom["clipTag-person"].checked, dom["clipTag-empty"].checked], [true, false], "people tick person");
  dom["clipTag-empty"].checked = true;
  dom["clipTag-empty"].fire("change");
  eq([dom["clipTag-person"].checked, dom.clipPeople.value, dom.clipVehicles.value], [false, "0", "0"], "empty clears them");
  eq(dom.clipPeople.options.map((o) => o.value).join(","), "0,1,2,3,4,5,6,7,8,9,10", "0 to 10");
});

await check("test clip: a save posts the shown range, and the same stretch again is refused out loud", async () => {
  dom.day.value = "2026-09-11";
  dom.exportFrom.value = "06:00";
  dom.exportTo.value = "06:02";
  dom["clipTag-empty"].checked = false;
  dom.clipPeople.value = "1";
  dom.clipPeople.fire("change");
  fetchLog = [];
  await page.saveTestClip();
  eq(fetchLog, ["/clip-library"], "one POST");
  eq(dom.clipStatus.className, "clipStatus saved", "saved: " + dom.clipStatus.textContent);
  if (!dom.clipStatus.textContent.includes("2 files") || !dom.clipStatus.textContent.includes("1 person")) {
    throw new Error("says what it kept: " + dom.clipStatus.textContent);
  }
  const saved = JSON.parse(await readFile(join(stateDir, "clip-library.json"), "utf8"));
  eq(saved.clips.map((c) => [c.cameraId, c.startUtc, c.endUtc, c.scenes, c.expected.length]),
    [["cam-1", "2026-09-11T10:00:00.000Z", "2026-09-11T10:02:00.000Z", ["person"], 1]], "the answer on disk");
  eq(dom.clipSaveBtn.disabled, false, "button back");
  await page.saveTestClip();
  eq(dom.clipStatus.className, "clipStatus problem", "refused");
  if (!dom.clipStatus.textContent.startsWith("Not saved: ")) throw new Error(dom.clipStatus.textContent);
});

await check("test clip: a range with a gap is not saved, and nothing is ticked is asked for", async () => {
  dom.exportFrom.value = "06:03";
  dom.exportTo.value = "06:06";
  dom.exportTo.fire("change");
  await page.saveTestClip();
  eq(dom.clipStatus.className, "clipStatus problem", "gap refused: " + dom.clipStatus.textContent);
  for (const t of ["person", "empty", "vehicle"]) dom["clipTag-" + t].checked = false;
  fetchLog = [];
  await page.saveTestClip();
  eq(fetchLog, [], "no request");
  eq(dom.clipStatus.textContent, "Tick at least one box that describes the clip", "asks");
});

await check("exportWindow is local times on the shown day, and refuses what did not happen", async () => {
  eq(page.exportWindow("2026-09-11", "06:00", "06:06"),
    { startUtc: "2026-09-11T10:00:00.000Z", endUtc: "2026-09-11T10:06:00.000Z" }, "a summer morning");
  eq(page.exportWindow("2026-03-08", "01:00", "04:00"),
    { startUtc: "2026-03-08T06:00:00.000Z", endUtc: "2026-03-08T08:00:00.000Z" }, "over spring forward: 3 wall hours, 2 real");
  eq(page.exportWindow("2026-03-08", "02:30", "03:30"), null, "02:30 never happened that day");
  for (const [d, f, t] of [["2026-09-11", "06:06", "06:00"], ["2026-09-11", "06:00", "06:00"], ["2026-09-11", "23:00", "00:00"],
    ["2026-09-11", "", "06:00"], ["2026-09-11", "6:00", "06:06"], ["2026-09-11", "06:60", "07:00"],
    ["2026-09-11", "24:00", "23:00"], ["2026-09-11", "06:00:00", "06:06:00"], ["2026-02-30", "06:00", "07:00"],
    ["2026-09-11", null, "07:00"]]) {
    eq(page.exportWindow(d, f, t), null, `refused: ${JSON.stringify([d, f, t])}`);
  }
});

await check("an offer names files, size, delivered local times and gaps, and its link is that range's ZIP", async () => {
  await offer("06:00", "06:06");
  const q = planQuery();
  eq(q && [q.get("camera"), q.get("start"), q.get("end")],
    ["cam-1", "2026-09-11T10:00:00.000Z", "2026-09-11T10:06:00.000Z"], "the plan query");
  eq(dom.exportStatus.className, "exportStatus", "not a problem");
  eq(dom.exportStatus.textContent, "3 files, 30 B, 06:00 to 06:06, 1 gap not recorded. Download ZIP", "the offer");
  const a = linkOf();
  eq(Boolean(a), true, "a download link");
  eq(a.getAttribute("href"), "/export?" + q.toString(), "the link asks for exactly what was planned");
  const res = await realFetch(`http://${host}${a.getAttribute("href")}`);
  await res.arrayBuffer();
  eq([res.status, res.headers.get("content-type")], [200, "application/zip"], "and the recorder serves it as a ZIP");

  await offer("06:00", "06:02");
  eq(dom.exportStatus.textContent, "2 files, 20 B, 06:00 to 06:02. Download ZIP", "no gaps, no gap words");
});

await check("refusals, bad times and an unreachable recorder each say so and offer nothing", async () => {
  await offer("07:00", "08:00");
  eq(dom.exportStatus.className, "exportStatus problem", "a problem");
  eq(dom.exportStatus.textContent,
    "That stretch runs into footage still being recorded. Pick a time that has finished.", "in plain words");
  eq(linkOf(), null, "no link");

  await offer("06:03", "06:04");
  eq(dom.exportStatus.textContent, "Nothing was recorded in that stretch.", "in plain words");
  eq(linkOf(), null, "no link");

  await offer("06:06", "06:00");
  eq(planQuery(), null, "nothing fetched for an end before the start");
  eq([dom.exportStatus.className, dom.exportStatus.textContent],
    ["exportStatus problem", "Pick a start and an end time on this day, the end after the start"], "told why");

  fetchBroken = true;
  try {
    await offer("06:00", "06:06");
  } finally {
    fetchBroken = false;
  }
  eq([dom.exportStatus.className, dom.exportStatus.textContent],
    ["exportStatus problem", `Cannot reach the recorder (${host})`], "names the host");
  eq(linkOf(), null, "no link");
});

await check("THE FEARED ONE: a slow plan for a camera already left never offers its download", async () => {
  let release;
  holdPlan = new Promise((r) => { release = r; });
  try {
    dom.camera.value = "cam-1";
    dom.day.value = "2026-09-11";
    dom.exportFrom.value = "06:00";
    dom.exportTo.value = "06:06";
    fetchLog = [];
    const pending = page.offerExport().then(() => null, (e) => e);
    await until(() => planQuery() !== null, "the plan request");
    dom.camera.value = "cam-2";
    dom.camera.fire("change");
    release();
    const failed = await pending;
    if (failed) throw failed;
    await settle();
    eq(linkOf(), null, "no link for the camera the user left");
    eq(dom.exportStatus.textContent, "", `nothing stale shown: ${dom.exportStatus.textContent}`);
  } finally {
    holdPlan = null;
    dom.camera.value = "cam-1";
    dom.camera.fire("change");
    await settle();
  }

  // A shown offer is withdrawn when anything it describes changes.
  for (const [what, act] of [
    ["the end time", () => { dom.exportTo.value = "06:02"; dom.exportTo.fire("change"); }],
    ["the start time", () => { dom.exportFrom.value = "06:01"; dom.exportFrom.fire("change"); }],
    ["the day", () => { dom.day.fire("change"); }],
    ["the next-day button", () => { dom.nextDay.fire("click"); }],
    ["the previous-day button", () => { dom.prevDay.fire("click"); }],
  ]) {
    await offer("06:00", "06:06");
    eq(Boolean(linkOf()), true, `an offer is shown before changing ${what}`);
    act();
    eq(linkOf(), null, `changing ${what} withdraws it`);
  }
  await settle();
  dom.day.value = "2026-09-11";
  await page.loadDay();
});

await check("the button asks, and a page bug in the offer is not blamed on the recorder", async () => {
  dom.camera.value = "cam-1";
  dom.day.value = "2026-09-11";
  dom.exportFrom.value = "06:00";
  dom.exportTo.value = "06:02";
  page.clearExport();
  dom.exportBtn.fire("click");
  await until(() => linkOf() !== null, "the offer from a button click");
  eq(dom.exportStatus.textContent, "2 files, 20 B, 06:00 to 06:02. Download ZIP", "the button's offer");

  const createElement = globalThis.document.createElement;
  globalThis.document.createElement = () => { throw new Error("page bug in offerExport"); };
  let err = null;
  try {
    await page.offerExport().catch((e) => { err = e; });
  } finally {
    globalThis.document.createElement = createElement;
  }
  eq(err?.message, "page bug in offerExport", "offerExport lets the page's own error out");
  eq(dom.exportStatus.textContent.startsWith("Cannot reach"), false, `not called unreachable: ${dom.exportStatus.textContent}`);
  page.clearExport();
});

await check("a bug in the page is not blamed on the recorder", async () => {
  // Only a failed fetch or unreadable JSON is "unreachable". A throw while
  // drawing is the page's own fault and must surface as itself.
  dom.status.textContent = "";
  dom.video.addEventListener = () => { throw new Error("page bug in play"); };
  let err = null;
  try {
    await page.playAt("2026-09-11T10:00:10Z").catch((e) => { err = e; });
  } finally {
    delete dom.video.addEventListener;
  }
  eq(err?.message, "page bug in play", "playAt lets the page's own error out");
  eq(dom.status.textContent.startsWith("unreachable"), false, `not called unreachable: ${dom.status.textContent}`);
  page.stopVideo();

  dom.day.value = "2026-09-11";
  for (const [what, run] of [["loadDay", () => page.loadDay()], ["loadCameras", () => page.loadCameras()]]) {
    dom.hours.appendChild = () => { throw new Error(`page bug in ${what}`); };
    err = null;
    try {
      await run().catch((e) => { err = e; });
    } finally {
      delete dom.hours.appendChild;
    }
    eq(err?.message, `page bug in ${what}`, `${what} lets the page's own error out`);
    eq(!dom.pageError.hidden && dom.pageError.textContent.startsWith("Cannot reach"), false,
      `${what} does not say the recorder is unreachable: ${dom.pageError.textContent}`);
  }
  await page.loadDay();
});

await check("an unreachable recorder is named, not a blank page", async () => {
  fetchBroken = true;
  await page.loadCameras();
  eq(dom.pageError.hidden, false, "shown");
  eq(dom.pageError.textContent, `Cannot reach the recorder (${host})`, "names the host");
  await page.playAt("2026-09-11T10:00:10Z");
  eq(dom.status.textContent, "unreachable: cannot reach the recorder", "playback too");
  fetchBroken = false;
});

/* ── playback controls: speed, +/-10 s, the clock ──────────────────────────── */

await check("with nothing playing the steps are off and the clock reads unknown, not midnight", async () => {
  page.stopVideo();
  eq(dom.rate.textContent, "1x", "starts at 1x");
  eq(dom.slower.disabled, false, "slower available at 1x");
  eq(dom.faster.disabled, false, "faster available at 1x");
  eq(dom.back10.disabled, true, "-10s off with nothing playing");
  eq(dom.fwd10.disabled, true, "+10s off with nothing playing");
  eq(dom.clock.textContent, "--:--:--", "an unknown time is not 00:00:00");
});

await check("speed stops at both ends and the button at the end says so", async () => {
  for (let i = 0; i < 6; i++) dom.slower.fire("click");
  eq(dom.rate.textContent, "0.25x", "bottom of the ladder");
  eq(dom.video.playbackRate, 0.25, "the video runs at it");
  eq(dom.slower.disabled, true, "slower off at the bottom");
  eq(dom.faster.disabled, false, "faster still on");
  for (let i = 0; i < 7; i++) dom.faster.fire("click");
  eq(dom.rate.textContent, "8x", "top, not wrapped round to 0.25x");
  eq(dom.video.playbackRate, 8, "the video runs at 8x");
  eq(dom.faster.disabled, true, "faster off at the top");
  dom.slower.fire("click");
  dom.slower.fire("click");
  eq(dom.rate.textContent, "2x", "back down to 2x");
});

await check("a new segment keeps the chosen speed", async () => {
  await page.playAt("2026-09-11T10:00:10Z");
  eq(dom.video.src, `/segments/${idOf("2026-09-11T10:00:00Z")}`, "segment A");
  dom.video.playbackRate = 1; // what a browser does to a new src
  dom.video.fire("loadedmetadata");
  eq(dom.video.playbackRate, 2, "still 2x after the load");
  eq(dom.back10.disabled, false, "-10s on while playing");
  eq(dom.fwd10.disabled, false, "+10s on while playing");
});

await check("the clock shows the local second being played", async () => {
  dom.video.currentTime = 30;
  dom.video.fire("timeupdate");
  eq(dom.clock.textContent, "06:00:30", "10:00:30Z in New York");
});

await check("a step inside the segment moves the video without asking the recorder", async () => {
  dom.video.currentTime = 20;
  const before = fetchLog.length;
  dom.fwd10.fire("click");
  eq(dom.video.currentTime, 30, "+10s");
  dom.back10.fire("click");
  dom.back10.fire("click");
  eq(dom.video.currentTime, 10, "-10s twice");
  await settle();
  eq(fetchLog.length, before, "no /playback request for a step that stays inside");
});

await check("a step off the front of a segment asks the recorder for that instant", async () => {
  await page.playAt("2026-09-11T10:01:10Z");
  eq(dom.video.src, `/segments/${idOf("2026-09-11T10:01:00Z")}`, "segment B");
  dom.video.fire("loadedmetadata");
  dom.video.currentTime = 4;
  const before = fetchLog.length;
  dom.back10.fire("click");
  await until(() => dom.video.src === `/segments/${idOf("2026-09-11T10:00:00Z")}`, "segment A again");
  const asked = fetchLog.slice(before).find((u) => u.startsWith("/playback?"));
  eq(new URLSearchParams(asked.split("?")[1]).get("at"), "2026-09-11T10:00:54.000Z", "B's start minus 6 s");
  dom.video.fire("loadedmetadata");
  eq(Math.abs(dom.video.currentTime - 54) < 1e-6, true, `54 s into A: ${dom.video.currentTime}`);
});

await check("a step into a gap stops and says why instead of skipping to the next footage", async () => {
  await page.playAt("2026-09-11T10:01:10Z");
  dom.video.fire("loadedmetadata");
  dom.video.currentTime = 55;
  dom.fwd10.fire("click");
  await until(() => dom.video.src === "", "the video stopped");
  await settle();
  eq(dom.video.src, "", "not segment C");
  eq(dom.status.textContent.startsWith("Playing"), false, `a gap, not playback: ${dom.status.textContent}`);
  eq(dom.back10.disabled, true, "-10s off in a gap");
  eq(dom.fwd10.disabled, true, "+10s off in a gap");
  eq(dom.clock.textContent, "--:--:--", "clock cleared");
  eq(dom.rate.textContent, "2x", "the speed choice survives the stop");
});

/* ── the friendly page: a camera, a calendar, a moment ─────────────────────
 * The failures feared here: a tile and the page disagreeing about which
 * camera is being shown, a calendar that marks a day with no footage (or
 * hides one that has it), a dropdown that loses the quarter hour it was on,
 * and a length chip that downloads the dropdowns' range instead of the moment
 * the person is actually watching.
 */

await check("a camera is a tile to tap, and tapping one draws that camera's day", async () => {
  dom.day.value = "2026-09-11";
  dom.camera.value = "cam-1";
  page.drawCameraTiles();
  eq(dom.cameraTiles.children.map((t) => t.textContent), ["Bay 1", "cam-2"], "one tile per camera, by name");
  eq(dom.cameraTiles.children.map((t) => t.className), ["camTile chosen", "camTile"], "the one being shown is marked");
  fetchLog = [];
  dom.cameraTiles.children[1].fire("click");
  await until(() => fetchLog.some((u) => u.startsWith("/timeline?") && u.includes("camera=cam-2")), "cam-2's timeline");
  eq(dom.camera.value, "cam-2", "the select is the page's one answer, and the tap moved it");
  eq(dom.cameraTiles.children.map((t) => t.className), ["camTile", "camTile chosen"], "and the tiles followed");
  dom.cameraTiles.children[0].fire("click");
  await until(() => dom.camera.value === "cam-1", "back on cam-1");
  await settle();
});

await check("the day is picked from a calendar, with the days that have footage marked", async () => {
  dom.camera.value = "cam-1";
  dom.day.value = "2026-09-11";
  fetchLog = [];
  page.showCalendar(true);
  eq(dom.calendar.hidden, false, "the calendar is open");
  eq(dom.calLabel.textContent, "September 2026", "on the month of the day being shown");
  await until(() => dom.calGrid.children.some((c) => c.className.includes("recorded")), "the recorded days marked");
  eq(dom.calGrid.children.length, 35, "five weeks of seven cells");
  eq(dom.calGrid.children.slice(0, 2).map((c) => c.className), ["calBlank", "calBlank"],
    "the 1st is a Tuesday, so the week starts with two blanks");
  eq(dom.calGrid.children.filter((c) => c.className.includes("recorded")).map((c) => c.textContent),
    ["11"], "only the day this camera has footage on");
  eq(dom.calGrid.children.filter((c) => c.className.includes("chosen")).map((c) => c.textContent),
    ["11"], "and the day on screen is the chosen one");

  fetchLog = [];
  const twelfth = dom.calGrid.children.find((c) => c.className.startsWith("calDay") && c.textContent === "12");
  twelfth.fire("click");
  eq(dom.day.value, "2026-09-12", "the date input is the page's one answer, and the tap moved it");
  eq(dom.calendar.hidden, true, "the calendar closes once a day is chosen");
  eq(dom.dayBtn.textContent, "Day: 2026-09-12", "the button says which day is on screen");
  await until(() => fetchLog.some((u) => u.startsWith("/timeline?") && u.includes("start=2026-09-12")), "that day's timeline");
  dom.day.value = "2026-09-11";
  await page.loadDay();
});

await check("the times are a dropdown of the day's quarter hours, never typed", async () => {
  dom.camera.value = "cam-1";
  dom.day.value = "2026-09-11";
  await page.loadDay();
  eq(dom.exportFrom.children.length, 97, "96 quarter hours and the end of the day");
  eq(dom.exportTo.children.length, 97, "on both dropdowns");
  eq(dom.exportFrom.children[0].textContent, "12:00 AM (nothing recorded)",
    "a step with no footage is offered and said to be empty, not hidden");
  const recorded = dom.exportFrom.children.filter((o) => !o.textContent.includes("nothing recorded"));
  eq(recorded.map((o) => o.textContent), ["6:00 AM"], "the one quarter hour this camera recorded in");
  eq(dom.exportFrom.value, "2026-09-11T10:00:00.000Z",
    "From starts on it, and its value is a whole instant, not a wall clock");

  fetchLog = [];
  dom.exportTo.value = "2026-09-11T10:15:00.000Z";
  await page.offerExport();
  const q = planQuery();
  eq([q.get("start"), q.get("end")],
    ["2026-09-11T10:00:00.000Z", "2026-09-11T10:15:00.000Z"], "the chosen instants, straight through");
});

await check("Save video and Teach the AI open the same sheet, with the lengths each needs", async () => {
  page.openSheet("save");
  eq(dom.sheet.hidden, false, "the sheet is open");
  eq([dom.sheetTitle.textContent, dom.sheetGo.textContent], ["Save video", "Get the video"], "in plain words");
  eq(dom.lengthChips.children.map((c) => c.textContent), ["1 min", "5 min", "15 min", "1 hour"], "download lengths");
  eq(dom.teachFields.hidden, true, "and nothing about teaching");
  page.openSheet("teach");
  eq([dom.sheetTitle.textContent, dom.sheetGo.textContent], ["Teach the AI", "Save what I said"], "in plain words");
  eq(dom.lengthChips.children.map((c) => c.textContent), ["1 min", "2 min", "5 min"],
    "teaching lengths: short enough for a person to check by hand");
  eq(dom.lengthChips.children.map((c) => c.className), ["chip", "chip on", "chip"], "two minutes to start");
  eq(dom.teachFields.hidden, false, "and the teaching fields are there");
  page.closeSheet();
  eq(dom.sheet.hidden, true, "closed");
});

await check("THE FEARED ONE: a length chip takes the moment being watched, not what the dropdowns say", async () => {
  dom.camera.value = "cam-1";
  dom.day.value = "2026-09-11";
  await page.loadDay();
  dom.strip.fire("click", { clientX: 350.5 });
  await until(() => dom.video.src !== "", "a src");
  dom.video.fire("loadedmetadata");
  eq(page.watchedInstant(), "2026-09-11T10:00:43.200Z", "the instant on screen");

  page.openSheet("save");
  page.pickLength(1);
  eq(dom.sheetRange.textContent, "06:00 to 06:01", "half a minute either side, in local time");
  fetchLog = [];
  dom.sheetGo.fire("click");
  await until(() => planQuery() !== null, "a plan for the chip's range");
  eq([planQuery().get("start"), planQuery().get("end")],
    ["2026-09-11T10:00:13.200Z", "2026-09-11T10:01:13.200Z"],
    "a minute around the moment, not the dropdowns' range");
  // Two ranges on screen for one download is exactly the kind of thing that
  // looks fine and is wrong, so Exact times says which one is in force.
  eq(dom.exactNote.textContent,
    "The length button above is in use (06:00 to 06:01). Choose a time here to use these instead.",
    "the dropdowns do not stand there as if they decided it");

  dom.exportFrom.fire("change");
  fetchLog = [];
  await page.offerExport();
  eq(planQuery().get("start"), dom.exportFrom.value, "an exact time chosen by hand takes the range back");
  eq(dom.exactNote.textContent, "These times are the ones that will be used.", "and the note says so");
  page.closeSheet();
});

await check("with nothing playing the sheet asks for a moment instead of choosing one", async () => {
  page.stopVideo();
  page.openSheet("save");
  page.pickLength(5);
  eq(dom.sheetRange.textContent, "Play the moment you want first, then pick a length.", "says what is missing");
  eq(page.chosenWindow(), page.exportWindow(dom.day.value, dom.exportFrom.value, dom.exportTo.value),
    "and falls back to the dropdowns rather than inventing a time");
  page.closeSheet();
});

await check("teaching is tapped, not typed: the counters are what gets saved", async () => {
  page.openSheet("teach");
  dom.clipPeople.value = "0";
  dom.clipVehicles.value = "0";
  dom["clipTag-empty"].checked = false;
  dom["clipTag-person"].checked = false;
  dom["clipTag-vehicle"].checked = false;
  page.showCounts();
  dom.peoplePlus.fire("click");
  dom.peoplePlus.fire("click");
  eq([dom.peopleN.textContent, dom.clipPeople.value], ["2", "2"],
    "what is shown and what is saved are the same two people");
  eq([dom["clipTag-person"].checked, dom["clipTag-empty"].checked], [true, false], "a count ticks its own box");
  dom.peopleMinus.fire("click");
  dom.peopleMinus.fire("click");
  eq([dom.peopleN.textContent, dom["clipTag-person"].checked], ["0", false],
    "back to none, and the claim that there was a person goes with it");
  dom.peopleMinus.fire("click");
  eq(dom.peopleN.textContent, "0", "a count never goes below zero");
  dom.nobodyChip.fire("click");
  eq([dom["clipTag-empty"].checked, dom.nobodyChip.className], [true, "chip on"], "Nobody is the empty scene");
  dom.vehiclesPlus.fire("click");
  eq([dom.vehiclesN.textContent, dom["clipTag-empty"].checked], ["1", false],
    "and a car means the scene was not empty after all");
  page.closeSheet();
});

await check("the sheet counts what has been taught and states no verdict on it", async () => {
  page.openSheet("teach");
  await until(() => dom.teachProgress.textContent !== "", "the count");
  eq(/^\d+ clips? saved so far: \d+ people, \d+ cars, \d+ min of nobody\. Still wanted: \d+ people, \d+ min of nobody\.$/
    .test(dom.teachProgress.textContent), true, dom.teachProgress.textContent);
  eq(/enough|ready|good|done/i.test(dom.teachProgress.textContent), false, "counts, not a verdict");
  page.closeSheet();
});

/* ── D2: the detector's events on the timeline ────────────────────────────── */

const marksOf = () => dom.strip.children.filter((c) => String(c.className).startsWith("mark"));
const tilesOf = () => dom.eventTiles.children;
const loadDayWithEvents = async (day) => {
  dom.day.value = day;
  await page.loadDay();
  // loadDay does not wait for /events: the bar is drawn first and the marks
  // land on it. The note is emptied when the ask starts, so a non-empty note
  // is THIS day's answer rather than the last one still on screen.
  await until(() => dom.eventNote.textContent !== "", "the events to land");
};

await check("the day's events arrive as marks on the bar, where they happened", async () => {
  await loadDayWithEvents("2026-09-11");
  const marks = marksOf();
  eq(marks.length, 3, "three events on this day, and not yesterday's");
  eq(marks.map((m) => m.className).sort(), ["mark person", "mark person", "mark vehicle"], "one per event, by kind");
  // 10:00:30Z is six hours and thirty seconds into a window starting 04:00Z.
  const at = marks.find((m) => m.title.startsWith("Person, 06:00"));
  eq(Boolean(at), true, `plain words on the mark: ${marks.map((m) => m.title).join(" | ")}`);
  eq(at.title, "Person, 06:00, 6 s", "what it was, when, and how long");
  eq(Math.abs(parseFloat(at.style.left) - (6 * 3600 + 30) / 864) < 0.01, true, `placed at ${at.style.left}`);
  eq(dom.strip.lastChild === dom.playhead, true, "the playhead still sits on top of the marks");
  eq(dom.events.hidden, false, "the row is shown");
  eq(tilesOf().length, 3, "and one tile per event to click through");
  eq(tilesOf()[0].textContent.includes("06:00"), true, "oldest first");
  eq(dom.eventNote.textContent, "3 of 3 shown.", "the note counts them");
});

await check("THE FEARED ONE: turning a kind off says so, and never reads as 'none found'", async () => {
  await loadDayWithEvents("2026-09-11");
  dom.filterVehicle.fire("click");
  eq(marksOf().map((m) => m.className), ["mark person", "mark person"], "the car is off the bar");
  eq(dom.filterVehicle.getAttribute("aria-pressed"), "false", "and the button is drawn as off");
  eq(dom.filterVehicle.textContent, "Vehicles (1)", "THE FEARED ONE: the count still says there IS one");
  eq(dom.eventNote.textContent, "2 of 3 shown.", "the note says two of three");
  dom.filterVehicle.fire("click");
  eq(marksOf().length, 3, "and back on again");
  eq(dom.filterVehicle.getAttribute("aria-pressed"), "true", "pressed again");
});

await check("THE FEARED ONE: Next walks every event, including two in the same second", async () => {
  await loadDayWithEvents("2026-09-11");
  page.stopVideo();
  const seen = [];
  for (let i = 0; i < 4; i++) {
    dom.nextEvent.fire("click");
    await settle();
    if (page.view.here === null) break;
    if (seen.at(-1) !== page.view.here) seen.push(page.view.here);
  }
  eq(seen, ["e-car-1", "e-person-1", "e-person-2"], "every event, in time order, none skipped");
  eq(dom.status.textContent, "No later event on this day", "and it says when there are no more");
  eq(dom.nextEvent.disabled, true, "the button that can do nothing looks like it");
  dom.prevEvent.fire("click");
  await settle();
  eq(page.view.here, "e-person-1", "previous comes back the same way");
});

await check("jumping to an event starts a little before it, not on top of it", async () => {
  await loadDayWithEvents("2026-09-11");
  fetchLog = [];
  tilesOf()[2].fire("click");
  await until(() => fetchLog.some((u) => u.startsWith("/playback?")), "the jump");
  const q = new URLSearchParams(fetchLog.find((u) => u.startsWith("/playback?")).split("?")[1]);
  eq(q.get("at"), "2026-09-11T10:05:27.000Z", "three seconds of run-up, so the person walks in");
  eq(dom.status.textContent, "Person, 06:05, 4 s", "and the line under the video says which event");
});

await check("a day the detector watched and saw nothing says so, and says it differently", async () => {
  await loadDayWithEvents("2026-09-08");
  eq(dom.events.hidden, false, "the row is there: the detector was running");
  eq(dom.eventNote.textContent, "Nothing detected on this day.", "nobody walked past");
  eq(marksOf().length, 0, "no marks");
  eq([dom.nextEvent.disabled, dom.prevEvent.disabled], [true, true], "and nowhere to step");
});

await check("THE FEARED ONE: a recorder with no detector shows no row at all", async () => {
  const pageFetch = globalThis.fetch;
  let asked = false;
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("/events?")) {
      asked = true;
      return Promise.resolve({ ok: true, json: async () => ({
        ok: true, cameraId: "cam-1", available: false, events: [], truncated: false }) });
    }
    return pageFetch(url, opts);
  };
  try {
    dom.day.value = "2026-09-11";
    fetchLog = [];
    await page.loadDay();
    await until(() => asked, "the events ask");
    await settle();
    eq(dom.events.hidden, true, "nothing was ever watching, so nothing is claimed");
    eq(marksOf().length, 0, "and no marks on the bar");
  } finally {
    globalThis.fetch = pageFetch;
  }
});

/* ── D3: a thumbnail per tile, lazy, and never a broken tile ─────────────── */

// The strip's img elements never fetch for real in this fake DOM (browsers
// load <img src> through their own resource fetcher, not through
// globalThis.fetch), so these checks watch what the page decides to ask for
// via the element itself: whether .src ever got set, not the network log.
function findDescendant(el, pred) {
  for (const c of el.children) {
    if (pred(c)) return c;
    const found = findDescendant(c, pred);
    if (found) return found;
  }
  return undefined;
}
const imgOf = (tile) => findDescendant(tile, (c) => c.tagName === "IMG");

await check("thumbnails: with no IntersectionObserver at all, nothing is ever requested, not everything", async () => {
  eq(typeof globalThis.IntersectionObserver, "undefined", "this check runs before the page has ever seen one");
  await loadDayWithEvents("2026-09-11");
  const tiles = tilesOf();
  eq(tiles.length, 3, "the tiles themselves still draw");
  for (const tile of tiles) {
    const img = imgOf(tile);
    eq(img !== undefined, true, "still a usable tile: an <img> is there");
    eq(img.hidden, true, "and hidden, so no broken-image icon shows for it");
    eq(Boolean(img.src), false,
      "THE FEARED ONE: a fallback that requested every crop would spawn hundreds of ffmpeg jobs on a busy day");
  }
  eq(dom.eventNote.textContent, "3 of 3 shown.", "the rest of the row is unaffected");
});

// A stub good enough to test the page's own IntersectionObserver usage: it
// remembers what got observed and lets a check say "this tile is now on
// screen" without a real layout engine under the fake DOM.
class FakeIntersectionObserver {
  constructor(cb) { this.cb = cb; this.watching = new Set(); FakeIntersectionObserver.instances.push(this); }
  observe(el) { this.watching.add(el); }
  unobserve(el) { this.watching.delete(el); }
  disconnect() { this.watching.clear(); }
  appear(el) {
    if (!this.watching.has(el)) throw new Error("appear() on an element the page never observed");
    this.cb([{ target: el, isIntersecting: true }]);
  }
}
FakeIntersectionObserver.instances = [];
globalThis.IntersectionObserver = FakeIntersectionObserver;

await check("thumbnails: a tile's image targets its own event, and only once the tile is actually visible", async () => {
  await loadDayWithEvents("2026-09-11");
  const tiles = tilesOf();
  const markers = page.view.markers;
  eq(tiles.length, markers.length, "one tile per shown event");
  const obs = FakeIntersectionObserver.instances.at(-1);
  eq(Boolean(obs), true, "the page built an observer now that one exists");
  eq(obs.watching.size, tiles.length, "every tile is registered, even the ones off screen");
  for (const tile of tiles) {
    eq(Boolean(imgOf(tile).src), false, "THE FEARED ONE: nothing requested for a tile nobody has scrolled to");
  }

  const target = tiles[0];
  const img = imgOf(target);
  obs.appear(img);
  eq(img.src, "/event-crop?id=" + encodeURIComponent(markers[0].id), `points at its own event: ${img.src}`);
  eq(obs.watching.has(img), false, "stops being watched the moment it is asked for");
  eq(Boolean(imgOf(tiles[1]).src), false, "a sibling tile that never appeared still makes no request");
  eq(Boolean(imgOf(tiles[2]).src), false, "neither does the other one");
});

await check("thumbnails: a crop that fails hides the image, keeps the words, and is never retried", async () => {
  await loadDayWithEvents("2026-09-11");
  const tile = tilesOf()[1];
  const img = imgOf(tile);
  const wordsBefore = tile.textContent;
  const obs = FakeIntersectionObserver.instances.at(-1);
  obs.appear(img);
  const requested = img.src;
  eq(Boolean(requested), true, "it was asked for once it appeared");
  img.fire("error");
  eq(img.hidden, true, "no broken-image icon");
  eq(tile.textContent, wordsBefore, "THE FEARED ONE: the plain words a usable tile depends on are untouched");
  img.fire("error");
  eq(img.src, requested, "and it is never retried");
  eq(obs.watching.has(img), false, "not re-queued after failing either");
});

await check("THE FEARED ONE: the timeline, filters and Next/Previous still work when every crop 404s", async () => {
  await loadDayWithEvents("2026-09-11");
  const obs = FakeIntersectionObserver.instances.at(-1);
  for (const tile of tilesOf()) {
    const img = imgOf(tile);
    obs.appear(img);
    img.fire("error");
  }
  // Exactly the behaviour already proven above, now with every crop failed.
  dom.filterVehicle.fire("click");
  eq(marksOf().map((m) => m.className), ["mark person", "mark person"], "the car is off the bar, thumbnails or not");
  dom.filterVehicle.fire("click");
  eq(marksOf().length, 3, "and back on");
  page.stopVideo();
  const seen = [];
  for (let i = 0; i < 4; i++) {
    dom.nextEvent.fire("click");
    await settle();
    if (page.view.here === null) break;
    if (seen.at(-1) !== page.view.here) seen.push(page.view.here);
  }
  eq(seen, ["e-car-1", "e-person-1", "e-person-2"], "Next still walks every event, in order, none skipped");
  eq(dom.nextEvent.disabled, true, "and still knows when it has run out");
});

/* ── keeping today current (refreshDecision, wired in) ───────────────────── */

// Why this block exists: on 2026-09-20 a person walked up to the house and
// was detected twice, at 0.88 and 0.90, and a Review page opened before he
// arrived never showed either, because nothing ever asked again.
const timelineAsks = () => fetchLog.filter((u) => u.startsWith("/timeline?")).length;
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** A tick on today as it is at this instant: a check that awaits across
 *  local midnight must not tick with the date it read before. */
const tickToday = () => { page.el.day.value = localToday(); page.refreshTick(); };
/** Run `fn` with today drawn, nothing open and a load long overdue, then put
 *  the day back. The checks above leave a clip in the player; left there, it
 *  would (correctly) hold every refresh off. */
async function onToday(fn) {
  const before = { day: page.el.day.value };
  page.stopVideo();
  page.view.sheetMode = null;
  page.el.day.value = localToday();
  page.view.lastLoadMs = Date.now() - 60_000;
  try {
    await fn();
  } finally {
    fetchBroken = false;
    globalThis.document.hidden = false;
    page.view.playing = null;
    page.view.sheetMode = null;
    page.el.day.value = before.day;
    await page.loadDay();
    await settle();
  }
}

await check("the page ticks every 5 s, and once more when the tab is looked at again", async () => {
  eq(pageIntervals.length, 1, "one timer");
  eq(pageIntervals[0].everyMs, 5000, "every 5 s");
  eq(pageIntervals[0].fn === page.refreshTick, true, "running the refresh tick");
  eq(docListeners.filter((l) => l.type === "visibilitychange").length, 1, "and one visibilitychange listener");
});

await check("THE ORIGINAL BUG: a page left open on today asks again", async () => {
  await onToday(async () => {
    const before = timelineAsks();
    page.refreshTick();
    await settle();
    eq(page.view.lastRefresh.reason, "due", "due");
    eq(timelineAsks(), before + 1, "and it asked the recorder again");
  });
});

await check("THE FEARED ONE: never while a clip is open, and it resumes when the clip is gone", async () => {
  await onToday(async () => {
    page.view.playing = { segmentStartUtc: "2026-09-11T10:00:00Z" };
    const before = timelineAsks();
    page.refreshTick();
    await settle();
    eq(page.view.lastRefresh.reason, "clip_open", "held off");
    eq(timelineAsks(), before, "nothing asked while someone is watching");
    page.view.playing = null;
    tickToday();
    await settle();
    eq(timelineAsks(), before + 1, "and asked as soon as the clip was gone");
  });
});

await check("nor while the save sheet is open", async () => {
  await onToday(async () => {
    page.view.sheetMode = "save";
    const before = timelineAsks();
    page.refreshTick();
    await settle();
    eq(page.view.lastRefresh.reason, "sheet_open", "held off");
    eq(timelineAsks(), before, "nothing asked");
  });
});

await check("a hidden tab asks nothing; looking at it again asks at once", async () => {
  await onToday(async () => {
    globalThis.document.hidden = true;
    const before = timelineAsks();
    page.refreshTick();
    await settle();
    eq(page.view.lastRefresh.reason, "hidden", "held off");
    eq(timelineAsks(), before, "nothing asked of a box running inference");
    globalThis.document.hidden = false;
    page.el.day.value = localToday();
    for (const l of docListeners.filter((x) => x.type === "visibilitychange")) l.fn();
    await settle();
    eq(timelineAsks(), before + 1, "asked the moment the tab came back, not a tick later");
  });
});

await check("a day that is over is never asked again", async () => {
  const day = page.el.day.value;
  page.stopVideo();
  page.el.day.value = "2026-09-11";
  page.view.lastLoadMs = Date.now() - 60_000;
  const before = timelineAsks();
  page.refreshTick();
  await settle();
  eq(page.view.lastRefresh.reason, "day_is_over", "history cannot gain events");
  eq(timelineAsks(), before, "so nothing is asked");
  page.el.day.value = day;
});

await check("a recorder that cannot be reached is retried on the interval, not on every tick", async () => {
  await onToday(async () => {
    fetchBroken = true;
    const started = Date.now();
    await page.loadDay();
    eq(page.view.lastLoadMs >= started, true, "the failed ATTEMPT is stamped");
    const before = timelineAsks();
    page.refreshTick();
    await settle();
    eq(page.view.lastRefresh.reason, "too_soon", "so the next tick waits");
    eq(timelineAsks(), before, "and does not hammer a recorder that is down");
  });
});

await check("a clip the browser cannot play is closed, so refreshing resumes", async () => {
  // Found in review: the video's error handler said so on screen but left
  // view.playing set, and every tick after answered clip_open, for good.
  await onToday(async () => {
    await page.playAt("2026-09-11T10:00:10Z");
    await until(() => page.view.playing !== null, "a clip to open");
    page.el.video.fire("error");
    eq(page.view.playing, null, "the clip that cannot play is no longer open");
    eq(/cannot play this recording/.test(page.el.status.textContent), true, "and the reason stays on screen");
    const before = timelineAsks();
    page.view.lastLoadMs = Date.now() - 60_000;
    tickToday();
    await settle();
    eq(page.view.lastRefresh.reason, "due", "refreshing carries on");
    eq(timelineAsks(), before + 1, "and asks the recorder again");
  });
});

/* ── following today across midnight ─────────────────────────────────────── */

const localYesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return page.localDayValue(d); };
/** Today and yesterday from ONE reading of the clock, so a check that runs
 *  across local midnight compares like with like. */
const days = () => {
  const at = new Date();
  return { today: page.localDayValue(at), yesterday: page.localDayValue(new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1)),
    before: page.localDayValue(new Date(at.getFullYear(), at.getMonth(), at.getDate() - 2)) };
};

await check("THE MIDNIGHT ONE: a page left open on today moves to the new day", async () => {
  // Midnight, from the page's side: it was showing, and following, the day
  // that has just become yesterday.
  page.stopVideo();
  const was = page.el.day.value;
  const d = days();
  page.el.day.value = d.yesterday;
  page.view.followDay = page.el.day.value;
  const before = timelineAsks();
  page.refreshTick();
  await settle();
  eq(page.view.lastFollow.reason, "new_day", "it saw the new day");
  eq(page.el.day.value, d.today, "and moved to it");
  eq(page.view.followDay, d.today, "and follows it from here, though the move went through chooseDay");
  eq(timelineAsks() > before, true, "and asked the recorder for it");
  page.el.day.value = was;
  await page.loadDay();
  await settle();
});

await check("THE FEARED ONE: a day picked on purpose is left alone at midnight", async () => {
  page.stopVideo();
  const was = page.el.day.value;
  const d = days();
  page.el.day.value = d.yesterday;
  page.view.followDay = d.today;
  page.refreshTick();
  await settle();
  eq(page.view.lastFollow.reason, "not_following", "not the day being followed");
  eq(page.el.day.value, d.yesterday, "so it stays where it was put");
  page.el.day.value = was;
});

await check("it waits while a clip is open or the calendar is open, then moves", async () => {
  const was = page.el.day.value;
  for (const [open, close, reason] of [
    [() => { page.view.playing = { segmentStartUtc: "2026-09-11T10:00:00Z" }; }, () => { page.view.playing = null; }, "clip_open"],
    [() => { page.el.calendar.hidden = false; }, () => { page.el.calendar.hidden = true; }, "picking_day"],
    [() => { page.view.sheetMode = "save"; }, () => { page.view.sheetMode = null; }, "sheet_open"],
    [() => { globalThis.document.hidden = true; }, () => { globalThis.document.hidden = false; }, "hidden"],
  ]) {
    const d = days();
    page.el.day.value = d.yesterday;
    page.view.followDay = page.el.day.value;
    open();
    page.refreshTick();
    await settle();
    eq(page.view.lastFollow.reason, reason, `held: ${reason}`);
    eq(page.el.day.value, d.yesterday, `the day is not changed under ${reason}`);
    close();
    page.refreshTick();
    await settle();
    eq(page.el.day.value, d.today, `and it moves once ${reason} is over`);
  }
  page.el.day.value = was;
  await page.loadDay();
  await settle();
});

await check("coming back to today follows it again", async () => {
  const was = page.el.day.value;
  page.view.followDay = "2026-01-01";
  const d = days();
  page.el.day.value = d.today;
  page.refreshTick();
  await settle();
  eq(page.view.followDay, d.today, "showing today means following today");
  page.el.day.value = was;
  await page.loadDay();
  await settle();
});

await check("THE STALE ONE: stepping away and back after midnight is a choice, not a follow", async () => {
  // Found in review. Following the day that has just become yesterday, the
  // person steps back a day, then forward again to it. The page used to
  // still remember that day as followed, and pulled them on to today within
  // 5 s of the click that put them there.
  page.stopVideo();
  const was = page.el.day.value;
  const d = days();
  page.el.day.value = d.yesterday;
  page.view.followDay = d.yesterday;
  dom.prevDay.fire("click");
  await settle();
  eq(page.el.day.value, d.before, "stepped back a day");
  dom.nextDay.fire("click");
  await settle();
  eq(page.el.day.value, d.yesterday, "and forward again, by hand");
  page.refreshTick();
  await settle();
  eq(page.view.lastFollow.reason, "not_following", "a day reached by hand is not followed");
  eq(page.el.day.value, d.yesterday, "so it stays where the person put it");
  page.el.day.value = was;
  await page.loadDay();
  await settle();
});

/* ── known objects (D: KNOWN-OBJECTS-SPEC.md) ─────────────────────────────
 * Two different failures feared, tested two different ways:
 * - the hidden-events toggle and the greyed mark it reveals go through the
 *   REAL /events route (it already has a routeAccess.ts rule), so this is a
 *   real round trip, exactly like every other events check above.
 * - the Known Objects section talks to GET /known-objects and POST
 *   /known-objects/answer, which routeAccess.ts has no rule for yet (see the
 *   report: that file is not this feature's to add, and five agents share
 *   this checkout right now). So THIS page's own logic is proven the same
 *   way "a recorder with no detector" is proven above: by answering those two
 *   fetches directly, real server or not. harness/knownObjectsApi.harness.mjs
 *   proves the routes themselves, with routing turned on for that suite only. */

await check("known objects: a suppressed event is counted, greyed, and only drawn once asked for", async () => {
  {
    const { openEventsDb } = await import("../agent/events-db.mjs");
    const db = openEventsDb(join(stateDir, "events.db"));
    db.upsert({ id: "e-hidden-1", event: {
      id: "e-hidden-1", cameraId: "cam-1", kind: "person",
      firstUtc: "2026-09-11T10:03:00.000Z", lastUtc: "2026-09-11T10:03:04.000Z",
      count: 34, bestConfidence: 0.8,
      bestBox: { x: 0.3, y: 0.2, w: 0.1, h: 0.42 },
      bestUtc: "2026-09-11T10:03:00.000Z",
    } }, true, { suppressedBy: "cam-1:person:1758000000000" });
    db.close();
  }
  await loadDayWithEvents("2026-09-11");
  eq(marksOf().length, 3, "THE FEARED ONE: hidden by default, not counted as a fourth event");
  eq(dom.hiddenRow.hidden, false, "but its own row appears now that something is hidden");
  eq(dom.hiddenNote.textContent, "1 hidden - known object", "singular, and the right count");
  eq(dom.hiddenToggle.getAttribute("aria-pressed"), "false", "not showing them");
  eq(dom.hiddenToggle.textContent, "Show hidden", "says what tapping it would do");

  dom.hiddenToggle.fire("click");
  await until(() => marksOf().length === 4, "the hidden mark to be asked for and drawn");
  eq(dom.hiddenToggle.getAttribute("aria-pressed"), "true", "now showing");
  eq(dom.hiddenToggle.textContent, "Hide known objects", "and says the opposite");
  const greyed = marksOf().filter((m) => m.className.includes("suppressed"));
  eq(greyed.length, 1, "exactly the one hidden event, drawn differently from the rest");
  eq(greyed[0].title.endsWith("(hidden: known object)"), true, `plain words on the mark itself: ${greyed[0].title}`);
  const greyedTile = tilesOf().find((t) => t.className.includes("suppressed"));
  eq(Boolean(greyedTile), true, "the tile row shows it too");
  eq(greyedTile.textContent.includes("(hidden: known object)"), true, "in its own words, not just its colour");

  dom.hiddenToggle.fire("click");
  await until(() => marksOf().length === 3, "back to the default view");
  eq(dom.hiddenRow.hidden, false, "still says how many are hidden, even while hiding them again");
});

await check("known objects: the section shows the measurement, localised, and the two answers", async () => {
  const KNOWN_OBJECT = {
    id: "cam-1:person:1758000000000", cameraId: "cam-1", kind: "person",
    box: { x: 0.3, y: 0.2, w: 0.1, h: 0.42 }, state: "active",
    lapsedAtUtc: null, lapseReason: null, learnedAtUtc: "2026-09-11T09:00:00.000Z",
    firstSeenUtc: "2026-09-11T05:55:00.000Z", lastSeenUtc: "2026-09-11T08:10:00.000Z",
    lastMatchedUtc: "2026-09-11T08:10:00.000Z", members: 34, matched: 4,
    confidenceMax: 0.8, sampleEventId: "e-hidden-1", memberEventIds: ["e-hidden-1"],
    cameraFingerprint: "abc123def4567890", answer: null,
    notice: [
      "Seen as a person 34 times at the same spot, never moving, from 2026-09-11T05:55:00.000Z to 2026-09-11T08:10:00.000Z.",
      "Highest score as a person: 0.80.",
      "No answer recorded yet.",
    ],
  };
  let stored = KNOWN_OBJECT;
  const pageFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith("/known-objects?")) {
      if (!u.includes("camera=cam-1")) throw new Error(`scoped to the wrong camera: ${u}`);
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, problem: null, objects: [stored] }) });
    }
    if (u === "/known-objects/answer" && opts && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      eq(body, { id: KNOWN_OBJECT.id, belongs: false }, "posts exactly the id and the answer, nothing else");
      stored = { ...KNOWN_OBJECT, answer: { belongs: false, atUtc: "2026-09-11T10:30:00.000Z", by: "tech" },
        notice: [...KNOWN_OBJECT.notice.slice(0, 2), "tech said it should not be there."] };
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, object: stored }) });
    }
    return pageFetch(url, opts);
  };
  try {
    await page.loadKnownObjects();
    eq(dom.knownObjects.hidden, false, "the section appears");
    eq(dom.knownObjectsList.children.length, 1, "one card for the one active object");
    const img = findDescendant(dom.knownObjectsList, (c) => c.tagName === "IMG");
    eq(img.src, "/event-crop?id=e-hidden-1", "the sample event's crop, the same route event tiles use");
    const notice = findDescendant(dom.knownObjectsList, (c) => c.tagName === "P" && c.textContent.startsWith("Seen as"));
    eq(notice.textContent, "Seen as a person 34 times at the same spot, never moving, from 9/11, 1:55 AM to 9/11, 4:10 AM.",
      `the UTC instant became local time: ${notice.textContent}`);
    const belongsBtn = findDescendant(dom.knownObjectsList, (c) => c.tagName === "BUTTON" && c.textContent === "It belongs there");
    const shouldNotBtn = findDescendant(dom.knownObjectsList, (c) => c.tagName === "BUTTON" && c.textContent === "It should not be there");
    eq(Boolean(belongsBtn && shouldNotBtn), true, "both answers offered before anyone has answered");

    shouldNotBtn.fire("click");
    await until(() => findDescendant(dom.knownObjectsList, (c) => c.className === "knownAnswer") !== undefined,
      "the answer to land and the section to redraw from it");
    const answerLine = findDescendant(dom.knownObjectsList, (c) => c.className === "knownAnswer");
    eq(answerLine.textContent, "tech said it should not be there, 9/11, 6:30 AM.", answerLine.textContent);
    eq(findDescendant(dom.knownObjectsList, (c) => c.tagName === "BUTTON"), undefined,
      "THE FEARED ONE: once answered, no button is left offering to answer again as if nothing happened");
  } finally {
    globalThis.fetch = pageFetch;
  }
});

await check("known objects: a sample crop that 404s (no_such_event - events retention has since deleted the row) hides quietly, the same as any other footage-gone thumbnail", async () => {
  // EVENTS-RETENTION-SPEC.md section 6: once an event's row is deleted along
  // with its video, /event-crop?id= for it answers 404 no_such_event instead
  // of the 409 footage_gone it would have answered while the row still
  // existed but the footage did not. The <img> error event this page reacts
  // to carries no status code at all, so there is nothing here that COULD
  // treat the two differently - which is exactly the point: retention
  // deleting the row must not turn a quiet missing-picture card into a
  // broken one.
  const KNOWN_OBJECT = {
    id: "cam-1:person:1758000001000", cameraId: "cam-1", kind: "person",
    box: { x: 0.3, y: 0.2, w: 0.1, h: 0.42 }, state: "active",
    lapsedAtUtc: null, lapseReason: null, learnedAtUtc: "2026-09-11T09:00:00.000Z",
    firstSeenUtc: "2026-09-11T05:55:00.000Z", lastSeenUtc: "2026-09-11T08:10:00.000Z",
    lastMatchedUtc: "2026-09-11T08:10:00.000Z", members: 34, matched: 4,
    confidenceMax: 0.8, sampleEventId: "e-retired-1", memberEventIds: ["e-retired-1"],
    cameraFingerprint: "abc123def4567890", answer: null,
    notice: ["Seen as a person 34 times.", "Highest score as a person: 0.80.", "No answer recorded yet."],
  };
  const pageFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("/known-objects?")) return Promise.resolve({ ok: true, json: async () => ({ ok: true, problem: null, objects: [KNOWN_OBJECT] }) });
    return pageFetch(url, opts);
  };
  try {
    await page.loadKnownObjects();
    const img = findDescendant(dom.knownObjectsList, (c) => c.tagName === "IMG");
    eq(img.src, "/event-crop?id=e-retired-1", "still asks for it by id, whether or not the row survived retention");
    img.fire("error");
    eq(img.hidden, true, "hidden quietly, the same as a 409 footage_gone would leave it");
    eq(dom.knownObjects.hidden, false, "the card itself stays: its measurement and answer buttons never depended on the picture");
  } finally {
    globalThis.fetch = pageFetch;
  }
});

await check("known objects: nothing readable from the recorder means nothing shown, not a broken section", async () => {
  const pageFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("/known-objects?")) return Promise.resolve({ ok: false, status: 404, json: async () => ({ ok: false, code: "no_such_route" }) });
    return pageFetch(url, opts);
  };
  try {
    await page.loadKnownObjects();
    eq(dom.knownObjects.hidden, true, "no section, not an empty-looking one");
    eq(dom.knownObjectsList.children.length, 0, "and nothing left over from the previous check");
  } finally {
    globalThis.fetch = pageFetch;
  }
});

globalThis.fetch = realFetch;
closeAll();
server.close();
server.closeEvents();

index.close();
await rm(stateDir, { recursive: true, force: true });
report("review page");
