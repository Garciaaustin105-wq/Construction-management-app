/**
 * The teach list page (TEACH-LIST-SPEC.md piece 4): teach-client.mjs's pure
 * helpers proven directly (the reviewClient.harness.mjs pattern), then
 * agent/ui/teach.html's own <script type="module"> run for real against a
 * real api server on a real socket, with only the DOM faked (the
 * reviewPage.harness.mjs pattern).
 *
 * The failures tested (build rule 19, and TEACH-LIST-SPEC.md's own
 * "Harnesses" section): a tap posts exactly the moment's span and counts; no
 * fetch to /clip-library happens without one; "3+" only ASKS for the exact
 * number, it does not save until that row's own Save is tapped; Skip never
 * posts; nothing a card renders ever claims a verdict; a successful save
 * updates the progress line without disturbing the other cards on screen.
 */
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { openEventsDb } from "../agent/events-db.mjs";
import {
  progressLine, localTime, momentTitle, momentText, stillUrl, watchUrl, saveBody, isExactCount, friendlyTeachProblem,
} from "../agent/ui/teach-client.mjs";
import { check, eq, same, report } from "./_assert.mjs";

console.log("teach page");

/* ============================================================ Part A: teach-client.mjs's own pure helpers ============================================================ */

check("progressLine: the target is derived, never a repeated constant, and null on a body this page cannot trust", () => {
  eq(progressLine({ personCount: 12, personsStillNeeded: 8, emptyMinutes: 25, emptyMinutesStillNeeded: 35 }),
    "12 of 20 people, 25 of 60 quiet minutes in the answer key");
  eq(progressLine({ personCount: 20, personsStillNeeded: 0, emptyMinutes: 60, emptyMinutesStillNeeded: 0 }),
    "20 of 20 people, 60 of 60 quiet minutes in the answer key", "the gate met exactly");
  for (const bad of [null, undefined, 7, "x", {}, { personCount: 1 }, { error: "invalid library" }]) {
    eq(progressLine(bad), null, `bad library ${JSON.stringify(bad)}`);
  }
});

check("localTime: local HH:MM", () => {
  eq(localTime("2026-09-20T00:00:00Z").length, 5, "HH:MM shape");
  eq(/^\d\d:\d\d$/.test(localTime("2026-09-20T14:32:00Z")), true);
});

check("momentTitle: one line per kind, and a fallback for anything else", () => {
  eq(momentTitle("moved_nothing_stored"), "Moved, nothing stored");
  eq(momentTitle("person_stored"), "Person stored");
  eq(momentTitle("quiet"), "Quiet");
  eq(momentTitle("made_up"), "Moment");
});

const MOMENTS = {
  moved: { kind: "moved_nothing_stored", cameraId: "cam-1", startUtc: "2026-09-20T00:00:00Z", endUtc: "2026-09-20T00:01:00Z",
    stillAtUtc: "2026-09-20T00:00:30Z", evidence: { frames: 20, motionLooks: 12 } },
  person: { kind: "person_stored", cameraId: "cam-1", startUtc: "2026-09-20T00:09:50Z", endUtc: "2026-09-20T00:10:14Z",
    stillAtUtc: "2026-09-20T00:10:02Z", evidence: { bestConfidence: 0.71, sightings: 3, hidden: false } },
  personHidden: { kind: "person_stored", cameraId: "cam-1", startUtc: "2026-09-20T00:09:50Z", endUtc: "2026-09-20T00:10:14Z",
    stillAtUtc: "2026-09-20T00:10:02Z", evidence: { bestConfidence: 0.61, sightings: 4, hidden: true } },
  quiet: { kind: "quiet", cameraId: "cam-1", startUtc: "2026-09-20T00:20:00Z", endUtc: "2026-09-20T00:25:00Z",
    stillAtUtc: "2026-09-20T00:22:30Z", evidence: { minutes: 5 } },
};

check("momentText: the exact measurement, from the evidence alone -- never a guess when evidence is missing", () => {
  eq(momentText(MOMENTS.moved), "Motion looked at 12 of 20 frame(s); nothing was stored.");
  eq(momentText(MOMENTS.person), "A person was stored: 71% best confidence, 3 sighting(s).");
  eq(momentText(MOMENTS.personHidden), "A person was stored: 61% best confidence, 4 sighting(s). Marked as a known object.");
  eq(momentText(MOMENTS.quiet), "5 quiet minute(s): gate data present, no motion, nothing stored.");
  eq(momentText({ kind: "moved_nothing_stored", evidence: {} }), "", "missing evidence fields -> blank, not 0");
  eq(momentText(null), "");
  eq(momentText({ kind: "moved_nothing_stored", evidence: null }), "");
});

check("FEARED (rule 11): no card wording claims a verdict -- only a measurement", () => {
  const FORBIDDEN = ["miss", "fail", "wrong", "false", "mistake", "error", "bad "];
  for (const m of Object.values(MOMENTS)) {
    const text = (momentTitle(m.kind) + " " + momentText(m)).toLowerCase();
    for (const word of FORBIDDEN) {
      eq(text.includes(word), false, `${JSON.stringify(m.kind)} text must not contain ${JSON.stringify(word)}: ${text}`);
    }
  }
});

check("stillUrl / watchUrl: the exact query GET /still and Review's own query expect", () => {
  eq(stillUrl("cam-1", "2026-09-20T00:00:30Z"), "/still?camera=cam-1&at=2026-09-20T00%3A00%3A30Z");
  eq(watchUrl("cam-1", "2026-09-20T00:00:30Z"), "/review?camera=cam-1&at=2026-09-20T00%3A00%3A30Z");
});

check("FEARED: saveBody's scenes follow checkLibrary's own empty/expected rule exactly", () => {
  const m = { cameraId: "cam-1", startUtc: "2026-09-20T00:00:00Z", endUtc: "2026-09-20T00:01:00Z" };
  same(saveBody(m, 0, false), { cameraId: "cam-1", startUtc: m.startUtc, endUtc: m.endUtc, people: 0, vehicles: 0, scenes: ["empty"] }, "nobody, no car -> empty, nothing else");
  same(saveBody(m, 1, false), { cameraId: "cam-1", startUtc: m.startUtc, endUtc: m.endUtc, people: 1, vehicles: 0, scenes: ["person"] }, "a person, no car");
  same(saveBody(m, 0, true), { cameraId: "cam-1", startUtc: m.startUtc, endUtc: m.endUtc, people: 0, vehicles: 1, scenes: ["vehicle"] }, "nobody, car on -> vehicle, never empty");
  same(saveBody(m, 3, true), { cameraId: "cam-1", startUtc: m.startUtc, endUtc: m.endUtc, people: 3, vehicles: 1, scenes: ["person", "vehicle"] }, "both");
  // scenes is never both empty AND person/vehicle, and never neither -- checkLibrary refuses either.
  for (const [people, carOn] of [[0, false], [1, false], [0, true], [5, true]]) {
    const scenes = saveBody(m, people, carOn).scenes;
    eq(scenes.length > 0, true, `${people}/${carOn}: never empty array`);
    eq(scenes.includes("empty") && (scenes.includes("person") || scenes.includes("vehicle")), false, `${people}/${carOn}: never both`);
  }
});

check("isExactCount: whole numbers 3-20 only -- smaller counts have their own dedicated button", () => {
  for (const n of [3, 4, 20]) eq(isExactCount(n), true, String(n));
  for (const n of [0, 1, 2, 2.5, 21, -3, NaN, Infinity, "3"]) eq(isExactCount(n), false, String(n));
});

check("friendlyTeachProblem: every GET /teach-moments and GET /still code reads as a sentence, an unknown code still answers something", () => {
  for (const code of ["bad_camera_id", "bad_day", "footage_gone", "segment_open", "still_in_future", "crop_failed", "busy"]) {
    eq(typeof friendlyTeachProblem(code), "string");
    eq(friendlyTeachProblem(code).length > 0, true, code);
  }
  eq(typeof friendlyTeachProblem("made_up_code"), "string", "never blank, never a throw");
});

/* ============================================================ Part B: the page, run for real ============================================================ */

const now = () => new Date("2026-09-21T00:30:00Z");
const ms = (iso) => Date.parse(iso);

const stateDir = await mkdtemp(join(tmpdir(), "camplat-teach-page-"));
const disk0 = join(stateDir, "disk0");
await mkdir(join(disk0, "cam-1"), { recursive: true });
const config = {
  siteId: "teach-page-01",
  storeRoots: [disk0],
  segmentSeconds: 60,
  credentials: { username: "svc", password: "p@ss" },
  cameras: [
    { cameraId: "cam-1", host: "10.0.0.5", vendor: "generic", name: "Front" },
    { cameraId: "cam-2", host: "10.0.0.6", vendor: "generic" },
  ],
};
const index = openIndex(join(stateDir, "index.db"));
// A real file on disk, not just an index row: POST /clip-library hard-links
// (or copies) the actual recording when a card is answered, so a save check
// below needs something there to link.
const DAY_FILE_BYTES = 100;
await writeFile(join(disk0, "cam-1", "day.mp4"), Buffer.alloc(DAY_FILE_BYTES, 7));
index.put({
  cameraId: "cam-1", startUtc: "2026-09-21T00:00:00Z", endUtc: "2026-09-21T01:00:00Z", path: "cam-1/day.mp4",
  bytes: DAY_FILE_BYTES, state: "sealed", hold: false, pendingUpload: false, bitrateKbps: null,
});

// Five moments, well inside the evaluated window (now = 00:30), each its OWN
// card a different check below answers -- so no check needs to reload the
// day mid-suite (a reload after a save is exactly proposeTeachMoments'
// rule 7/18 "never re-offer an answered moment" doing its job, which would
// make an earlier check's card vanish out from under a later one). Three
// separate, non-adjacent motion minutes (0, 5, 7 -- more than a minute apart,
// so none merge) give moved_nothing_stored 3 cards on their own; a person
// event at minute 10; a whole quiet 5-minute block at 20-24.
const gateDir = join(stateDir, "gate-windows");
await mkdir(gateDir, { recursive: true });
const T0 = ms("2026-09-21T00:00:00Z");
const minuteIso = (i) => new Date(T0 + i * 60_000).toISOString();
const lines = [];
for (const m of [0, 5, 7]) {
  lines.push({ cameraId: "cam-1", atUtc: minuteIso(m), windowS: 60, frames: 20, looked: 12, reasons: { motion: 12 } });
}
for (let m = 20; m <= 24; m += 1) {
  lines.push({ cameraId: "cam-1", atUtc: minuteIso(m), windowS: 60, frames: 20, looked: 0, reasons: {} });
}
await writeFile(join(gateDir, "2026-09-21.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const eventsDb = openEventsDb(join(stateDir, "events.db"));
eventsDb.upsert({
  id: "person-1",
  event: {
    id: "person-1", cameraId: "cam-1", kind: "person",
    firstUtc: minuteIso(10), lastUtc: new Date(T0 + 10 * 60_000 + 4000).toISOString(),
    count: 3, bestConfidence: 0.71,
    bestBox: { x: 0.2, y: 0.2, w: 0.2, h: 0.4 }, bestUtc: new Date(T0 + 10 * 60_000 + 2000).toISOString(),
  },
}, true);
eventsDb.close();

const installerAuth = {
  principalOf: () => ({ kind: "user", username: "tech", role: "installer" }),
  handle: async () => false,
  audit: () => {},
};

const STILL_BYTES = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
function fakeSpawn(cmd, args) {
  const { EventEmitter } = globalThis.__ee;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const tmpPath = args[args.length - 1];
  queueMicrotask(async () => {
    try {
      await writeFile(tmpPath, STILL_BYTES);
      child.emit("close", 0);
    } catch (err) {
      child.emit("error", err);
    }
  });
  return child;
}
{
  const { EventEmitter } = await import("node:events");
  globalThis.__ee = { EventEmitter };
}

const server = createApiServer({ stateDir, config, index, now, auth: installerAuth, spawnFn: fakeSpawn });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const host = `127.0.0.1:${server.address().port}`;

/* ── the smallest DOM this page's contract needs ─────────────────────────── */

class FakeEl {
  constructor(tag, id = null) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this.attrs = {};
    this.listeners = {};
    this._text = "";
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v); }
  get childNodes() { return this.children; }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.children.push(c); return c;
  }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === "string" ? textNode(c) : c); }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i < 0) throw new Error("removeChild: not a child");
    this.children.splice(i, 1); c.parentNode = null; return c;
  }
  replaceChildren(...cs) { this.textContent = ""; this.append(...cs); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, extra = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ type, target: this, currentTarget: this, preventDefault() {}, ...extra });
  }
  dispatchEvent(ev) { this.fire(ev && ev.type); return true; }
  set innerHTML(_) { throw new Error("the page must not use innerHTML"); }
}
globalThis.Event = class { constructor(type) { this.type = String(type); } };
const textNode = (s) => { const t = new FakeEl("#text"); t._text = s; return t; };

/** Depth-first search for the first (or every) descendant whose className
 *  includes `cls` -- teach.html gives every part of a card a stable class,
 *  so this is enough to find them without a real querySelector. */
function findByClass(root, cls) {
  if (String(root.className).split(/\s+/).includes(cls)) return root;
  for (const c of root.children) {
    const found = findByClass(c, cls);
    if (found) return found;
  }
  return null;
}
function findAllByClass(root, cls, out = []) {
  if (String(root.className).split(/\s+/).includes(cls)) out.push(root);
  for (const c of root.children) findAllByClass(c, cls, out);
  return out;
}

function freshDom() {
  const byId = {};
  for (const [id, tag] of [["cameraTiles", "div"], ["camera", "select"], ["day", "input"],
    ["pageError", "div"], ["progress", "div"], ["emptyNote", "div"], ["notesBox", "div"], ["cards", "div"]]) {
    byId[id] = new FakeEl(tag, id);
  }
  byId.pageError.hidden = true;
  byId.emptyNote.hidden = true;
  byId.notesBox.hidden = true;
  return byId;
}

let fetchLog = [];
const realFetch = globalThis.fetch;
function install(byId) {
  globalThis.document = {
    getElementById: (id) => byId[id] ?? null,
    createElement: (tag) => new FakeEl(tag),
    createTextNode: textNode,
  };
  globalThis.location = { host, protocol: "http:" };
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    fetchLog.push({ url: u, opts });
    if (!u.startsWith("/")) throw new Error(`the page fetched a non-relative URL: ${u}`);
    return realFetch(`http://${host}${u}`, opts);
  };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
async function until(fn, what, limitMs = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > limitMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const html = (await import("node:fs/promises").then((m) => m.readFile(join(import.meta.dirname, "..", "agent", "ui", "teach.html"), "utf8")))
  .replaceAll("\r\n", "\n");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const clientUrl = pathToFileURL(join(import.meta.dirname, "..", "agent", "ui", "teach-client.mjs")).href;
const NAMES = ["el", "view", "showPageError", "todayUtc", "loadCameras", "drawCameraTiles", "chooseCamera",
  "loadDay", "drawDay", "refreshProgress", "buildCard", "wireEvents"];
const START = "\nwireEvents();\nloadCameras();\n";
if (!script.includes(START)) throw new Error("teach.html must end its script with wireEvents(); loadCameras();");
const transformed = script
  .replace("'/ui/teach-client.js'", `'${clientUrl}'`)
  .replace(START, `\nglobalThis.__page = { ${NAMES.join(", ")} };${START}`);
const tmpScript = join(stateDir, "teach-page.mjs");
await writeFile(tmpScript, transformed);

const dom = freshDom();
install(dom);
let startupError = null;
await import(pathToFileURL(tmpScript).href).catch((e) => { startupError = e; });
const page = globalThis.__page;
if (startupError) throw startupError;

// The page just loaded on the REAL wall-clock "today" (todayUtc() reads the
// actual system clock, not this suite's pinned `now` -- it runs client-side,
// where there is no server clock to pin). This suite's fixtures are for
// 2026-09-21, so point the day field at it, the same way a person would.
await until(() => fetchLog.some((f) => f.url.startsWith("/teach-moments")), "the page's own first (real-today) load to finish starting");
await settle();
dom.day.value = "2026-09-21";
dom.day.dispatchEvent(new Event("change"));
await until(() => dom.cards.children.length >= 5, "cards for the fixture day");
await settle();

/* ── the checks ───────────────────────────────────────────────────────────── */

await check("startup: cameras load, cam-1 is chosen first, and the day defaults to today (UTC)", () => {
  eq(startupError, null, "no exception during startup");
  eq(page.el.camera.value, "cam-1", "the first camera in GET /cameras");
  eq(dom.cameraTiles.children.length, 2, "one tile per camera");
  eq(findByClass(dom.cameraTiles, "chosen").textContent, "Front", "cam-1's own name, not its id");
});

await check("FEARED: all three kinds of moment render, one card each, in priority order", () => {
  eq(dom.cards.children.length, 5, "three moved_nothing_stored (minutes 0, 5, 7), one person_stored, one quiet");
  const titles = dom.cards.children.map((c) => findByClass(c, "cardTitle").textContent);
  same(titles, ["Moved, nothing stored", "Moved, nothing stored", "Moved, nothing stored", "Person stored", "Quiet"]);
});

await check("FEARED (rule 11): nothing rendered on the page claims a verdict, not just the pure helper's own inputs", () => {
  const FORBIDDEN = ["miss", "fail", "wrong", "mistake"];
  const text = dom.cards.textContent.toLowerCase() + " " + dom.notesBox.textContent.toLowerCase();
  for (const word of FORBIDDEN) eq(text.includes(word), false, `page text must not contain ${JSON.stringify(word)}`);
});

await check("the still and Watch link carry the moment's own camera and instant", () => {
  const card = dom.cards.children[0];
  const img = card.children[0];
  eq(img.src, "/still?camera=cam-1&at=2026-09-21T00%3A00%3A30.000Z");
  const watch = findByClass(card, "watch");
  eq(watch.href, "/review?camera=cam-1&at=2026-09-21T00%3A00%3A30.000Z");
});

await check("FEARED: nothing posts to /clip-library without a tap", () => {
  eq(fetchLog.some((f) => f.url.startsWith("/clip-library")), false, "five cards drawn, nothing answered yet");
});

// Each check below answers a DIFFERENT one of the five cards and never
// reloads the day -- proposeTeachMoments correctly stops re-offering a
// moment once it is in the library (rule 7/18), so a reload here would make
// an earlier check's own card vanish out from under a later one.

await check("FEARED: a tap posts exactly the moment's span and counts", async () => {
  const before = fetchLog.length;
  const card = dom.cards.children[0]; // moved_nothing_stored, cam-1 00:00-00:01
  const answers = findByClass(card, "answers");
  const oneBtn = answers.children[1]; // Nobody, 1, 2, 3+, car, Skip
  eq(oneBtn.textContent, "1", "the second answer button");
  oneBtn.fire("click");
  await settle();
  const posts = fetchLog.slice(before).filter((f) => f.url === "/clip-library" && f.opts && f.opts.method === "POST");
  eq(posts.length, 1, "exactly one POST");
  const body = JSON.parse(posts[0].opts.body);
  same(body, {
    cameraId: "cam-1", startUtc: "2026-09-21T00:00:00.000Z", endUtc: "2026-09-21T00:01:00.000Z",
    people: 1, vehicles: 0, scenes: ["person"],
  }, "exactly the moment's span, 1 person, no car, no other field");
  const status = findByClass(card, "cardStatus");
  eq(status.textContent, "Saved.");
  eq(oneBtn.disabled, true, "every answer button on a saved card is disabled");
});

await check("the car toggle is read at the moment of the tap, and folds into scenes", async () => {
  const before = fetchLog.length;
  const card = dom.cards.children[3]; // person_stored
  const answers = findByClass(card, "answers");
  const carBox = answers.children[4].children[0]; // the label's own checkbox
  carBox.checked = true;
  const nobodyBtn = answers.children[0];
  nobodyBtn.fire("click");
  await settle();
  const post = fetchLog.slice(before).find((f) => f.url === "/clip-library");
  const body = JSON.parse(post.opts.body);
  eq(body.people, 0);
  eq(body.vehicles, 1, "the car toggle, read at tap time");
  same(body.scenes, ["vehicle"], "never empty when a car is claimed");
});

await check('FEARED: "3+" only asks for the exact number -- it does not save by itself, and a bad number is refused locally, without a POST', async () => {
  const card = dom.cards.children[1]; // moved_nothing_stored, minute 5 -- untouched by any earlier check
  const answers = findByClass(card, "answers");
  const threeBtn = answers.children[3];
  eq(threeBtn.textContent, "3+");
  const exactRow = findByClass(card, "exactRow");
  eq(exactRow.hidden, true, "closed until asked for");
  const before = fetchLog.length;
  threeBtn.fire("click");
  eq(exactRow.hidden, false, "tapping 3+ only reveals the row");
  eq(fetchLog.length, before, "no fetch from revealing it");

  const exactInput = exactRow.children[0];
  const exactSave = exactRow.children[1];
  exactInput.value = "2"; // below the "3+" floor
  exactSave.fire("click");
  await settle();
  eq(fetchLog.length, before, "an out-of-range number is refused before any fetch");
  const status = findByClass(card, "cardStatus");
  eq(status.textContent.includes("3 or more"), true, "says why, in words");

  exactInput.value = "7";
  exactSave.fire("click");
  await settle();
  const posts = fetchLog.slice(before).filter((f) => f.url === "/clip-library");
  eq(posts.length, 1, "exactly one POST, from the exact row's own Save");
  const body = JSON.parse(posts[0].opts.body);
  eq(body.people, 7);
});

await check("FEARED: Skip never posts -- it only removes the card from view", async () => {
  const before = fetchLog.length;
  const card = dom.cards.children[2]; // moved_nothing_stored, minute 7 -- untouched by any earlier check
  const answers = findByClass(card, "answers");
  const skipBtn = answers.children[5];
  eq(skipBtn.textContent, "Skip");
  skipBtn.fire("click");
  await settle();
  eq(card.hidden, true, "hidden, not removed -- the DOM node still exists for inspection");
  eq(fetchLog.filter((f) => f.url === "/clip-library").length - fetchLog.slice(0, before).filter((f) => f.url === "/clip-library").length, 0, "no POST at all");
});

await check("a save updates the progress line without touching the other cards", async () => {
  const cardsBefore = dom.cards.children.slice(); // element REFERENCES, not a rendered snapshot
  const progressBefore = dom.progress.textContent;
  const card = dom.cards.children[4]; // quiet, unanswered
  const answers = findByClass(card, "answers");
  answers.children[0].fire("click"); // Nobody
  await until(() => findByClass(card, "cardStatus").textContent === "Saved.", "the quiet card to save");
  await until(() => dom.progress.textContent !== progressBefore, "the progress line to move");
  // Reference equality per slot, not eq()/JSON.stringify: a card carries a
  // parentNode back-reference, which JSON.stringify would throw on (circular).
  eq(dom.cards.children.length, cardsBefore.length, "same number of cards");
  eq(dom.cards.children.every((c, i) => c === cardsBefore[i]), true, "the SAME card elements, not a re-render");
  eq(dom.progress.textContent.includes(" people, "), true, "still the same shape of line");
});

await check("choosing a different camera reloads the day for it", async () => {
  const before = fetchLog.length;
  page.chooseCamera("cam-2");
  await until(() => fetchLog.some((f, i) => i >= before && f.url.startsWith("/teach-moments?") && f.url.includes("camera=cam-2")), "a reload for cam-2");
  await until(() => dom.emptyNote.hidden === false, "the empty note to show once cam-2's (empty) day finishes drawing");
  eq(dom.cards.children.length, 0, "cam-2 has no footage at all in this suite's fixtures");
});

server.close();
server.closeEvents();
server.closeEventCrops();
server.closeStillsCleanup();
index.close();
await rm(stateDir, { recursive: true, force: true });
check("THE HIDDEN ROW STAYS HIDDEN: the page's CSS makes [hidden] win over any class's display (found in review)", () => {
  // .exactRow sets display: flex; without this rule the "how many exactly"
  // row showed before 3+ was tapped, inviting a count for the wrong button.
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  eq(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(style), true, "a [hidden] { display: none !important } rule");
  eq(/\.exactRow\s*\{[^}]*display:\s*flex/.test(style), true, "and the class it has to beat is still there (this check is not vacuous)");
});

report("teach page");
