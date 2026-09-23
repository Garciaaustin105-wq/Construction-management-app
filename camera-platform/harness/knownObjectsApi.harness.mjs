/**
 * D's surfaces on top of known objects (KNOWN-OBJECTS-SPEC.md): the /events
 * `hidden` param and `hiddenCount`, and the two new routes, GET
 * /known-objects and POST /known-objects/answer, against a real HTTP server.
 *
 * Access is the REAL compiled policy (dist/routeAccess.js): both routes need
 * `events.view`, the same reach as /events. (Until 2026-09-23 this file used a
 * stand-in because the rules did not exist yet; harness/routeAccess.harness.mjs
 * now checks the table itself.)
 *
 * THE FEARED FAILURES here: an umbrella's 600 suppressed sightings crowding
 * the one real person out of a window's limit (same trap eventsDb.harness.mjs
 * already proves at the storage layer — this proves the route passes
 * `hidden` and reads back `hiddenCount` rather than dropping either); a
 * display or a signed-out request reading or writing an owner's answer; an
 * answer that silently no-ops for an id that does not exist, reported as
 * success; and a store that cannot be trusted being written over anyway.
 */
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createApiServer } from "../agent/api-server.mjs";
import { openEventsDb } from "../agent/events-db.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { createKnownObjectsStore } from "../agent/known-objects.mjs";
import { closeAll } from "../agent/live.mjs";
import { decideRoute as realDecideRoute } from "../dist/routeAccess.js";
import { check, eq, report } from "./_assert.mjs";

console.log("known objects api");


const now = () => new Date("2026-09-11T12:00:00Z");

const ANONYMOUS = { kind: "anonymous" };
const DISPLAY = { kind: "display", displayId: "wall-1" };
const INSTALLER = { kind: "user", username: "tech", role: "installer" };
const STORE_USER = { kind: "user", username: "clerk", role: "store" };

let principal = INSTALLER;
const audits = [];
const auth = {
  principalOf: () => principal,
  handle: async () => false,
  audit: (event, _req, fields) => audits.push({ event, ...fields }),
};

const stateDir = await mkdtemp(join(tmpdir(), "camplat-known-api-"));
await mkdir(join(stateDir, "disk0"), { recursive: true });

const config = {
  siteId: "carwash-01",
  storeRoots: [join(stateDir, "disk0")],
  segmentSeconds: 60,
  credentials: { username: "svc", password: "p@ss" },
  cameras: [
    { cameraId: "cam-1", host: "10.0.0.5", vendor: "generic" },
    { cameraId: "cam-2", host: "10.0.0.6", vendor: "generic" },
  ],
};
const index = openIndex(join(stateDir, "index.db"));

// ---------- events.db: three of cam-1's, one of cam-2's ----------
{
  const db = openEventsDb(join(stateDir, "events.db"));
  db.upsert({ id: "e1", event: {
    id: "e1", cameraId: "cam-1", kind: "person",
    firstUtc: "2026-09-11T10:00:00.000Z", lastUtc: "2026-09-11T10:00:05.000Z",
    count: 5, bestConfidence: 0.9, bestBox: { x: 0.6, y: 0.5, w: 0.05, h: 0.2 },
    bestUtc: "2026-09-11T10:00:00.000Z",
  } }, true);
  db.upsert({ id: "e2", event: {
    id: "e2", cameraId: "cam-1", kind: "person",
    firstUtc: "2026-09-11T10:01:00.000Z", lastUtc: "2026-09-11T10:01:04.000Z",
    count: 4, bestConfidence: 0.7, bestBox: { x: 0.3, y: 0.2, w: 0.1, h: 0.42 },
    bestUtc: "2026-09-11T10:01:00.000Z",
  } }, true, { suppressedBy: "obj-1" });
  db.upsert({ id: "e3", event: {
    id: "e3", cameraId: "cam-1", kind: "person",
    firstUtc: "2026-09-11T10:02:00.000Z", lastUtc: "2026-09-11T10:02:04.000Z",
    count: 3, bestConfidence: 0.72, bestBox: { x: 0.3, y: 0.2, w: 0.1, h: 0.41 },
    bestUtc: "2026-09-11T10:02:00.000Z",
  } }, true, { suppressedBy: "obj-1" });
  db.upsert({ id: "e-cam2", event: {
    id: "e-cam2", cameraId: "cam-2", kind: "vehicle",
    firstUtc: "2026-09-11T10:00:00.000Z", lastUtc: "2026-09-11T10:00:10.000Z",
    count: 2, bestConfidence: 0.95, bestBox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
    bestUtc: "2026-09-11T10:00:00.000Z",
  } }, true);
  db.close();
}

// ---------- known-objects.json: built and validated through the real store,
// never hand-written, so a mistake in this fixture fails setup loudly rather
// than as a mysterious 200-with-empty-objects deep in a later check ----------
const knownStore = createKnownObjectsStore({ stateDir });
const OBJ_ACTIVE = {
  id: "obj-1", cameraId: "cam-1", kind: "person",
  box: { x: 0.3, y: 0.2, w: 0.1, h: 0.42 },
  state: "active", lapsedAtUtc: null, lapseReason: null,
  learnedAtUtc: "2026-09-11T09:00:00.000Z",
  firstSeenUtc: "2026-09-11T05:55:00.000Z", lastSeenUtc: "2026-09-11T08:10:00.000Z",
  lastMatchedUtc: null, members: 3, matched: 0, confidenceMax: 0.72,
  sampleEventId: "e2", memberEventIds: ["e1", "e2", "e3"],
  cameraFingerprint: "aaaa1111bbbb2222", answer: null,
};
const OBJ_LAPSED = {
  ...OBJ_ACTIVE, id: "obj-2", state: "lapsed",
  lapsedAtUtc: "2026-09-10T00:00:00.000Z", lapseReason: "unseen",
  memberEventIds: ["e1"], members: 1, sampleEventId: "e1",
};
const OBJ_CAM2 = {
  ...OBJ_ACTIVE, id: "obj-3", cameraId: "cam-2", kind: "vehicle",
  memberEventIds: ["e-cam2"], members: 1, sampleEventId: "e-cam2",
  answer: { belongs: true, atUtc: "2026-09-10T12:00:00.000Z", by: "tech" },
};
const setupResult = await knownStore.save([OBJ_ACTIVE, OBJ_LAPSED, OBJ_CAM2]);
if (!setupResult.ok) {
  throw new Error(`test setup: the fixture known objects failed their own check: ${setupResult.problem}`);
}

const server = createApiServer({ stateDir, config, index, now, auth, decideRouteImpl: realDecideRoute });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const fetchJson = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json, text };
};
const postJson = (url, body, extra = {}) => {
  const { headers, ...rest } = extra;
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...rest,
  });
};

/* ── GET /events: hidden and hiddenCount ─────────────────────────────────── */

const eventsQ = (extra = {}) => new URLSearchParams({
  camera: "cam-1", start: "2026-09-11T10:00:00Z", end: "2026-09-11T11:00:00Z", ...extra,
});

await check("events: hidden defaults to include, exactly as every caller before suppression saw it", async () => {
  const { res, json } = await fetchJson(`${base}/events?${eventsQ()}`);
  eq(res.status, 200, "status");
  eq(json.events.map((e) => e.id), ["e1", "e2", "e3"], "every event in the window, hidden or not");
  eq(json.hiddenCount, 2, "and it says how many of those are hidden");
  eq(json.events.find((e) => e.id === "e2").suppressedBy, "obj-1", "each hidden event names its object");
  eq(json.events.find((e) => e.id === "e1").suppressedBy, null, "and an unhidden one carries null, not absent");
});

await check("events: hidden=exclude is the Review page's own default view", async () => {
  const { json } = await fetchJson(`${base}/events?${eventsQ({ hidden: "exclude" })}`);
  eq(json.events.map((e) => e.id), ["e1"], "only the one nothing is hiding");
  eq(json.hiddenCount, 2, "the count does not change with the mode asked for");
});

await check("events: hidden=only shows nothing else", async () => {
  const { json } = await fetchJson(`${base}/events?${eventsQ({ hidden: "only" })}`);
  eq(json.events.map((e) => e.id), ["e2", "e3"], "just what is hidden");
  eq(json.hiddenCount, 2, "still the same count");
});

await check("events: hidden trims blank space and refuses what it does not recognise", async () => {
  const { json: trimmed } = await fetchJson(`${base}/events?${eventsQ({ hidden: " exclude " })}`);
  eq(trimmed.events.map((e) => e.id), ["e1"], "surrounding space is not a different mode");
  const { res, json } = await fetchJson(`${base}/events?${eventsQ({ hidden: "everything" })}`);
  eq(res.status, 400, "status");
  eq(json.code, "bad_hidden", "THE FEARED ONE: an unrecognised mode is refused, never quietly read as include or exclude");
  eq(json.message.includes("include"), true, `says what is allowed: ${json.message}`);
});

await check("events: no detector installed still carries hiddenCount, at zero", async () => {
  // A recorder with events.db but nothing suppressed on THIS camera: cam-2's
  // one event is not suppressed, so hiddenCount is 0, not absent.
  const { json } = await fetchJson(`${base}/events?${new URLSearchParams({ camera: "cam-2", start: "2026-09-11T00:00:00Z", end: "2026-09-12T00:00:00Z" })}`);
  eq(json.hiddenCount, 0, "zero, not undefined");
});

/* ── GET /known-objects ───────────────────────────────────────────────────── */

await check("known-objects: every camera, each with its measurement lines", async () => {
  const { res, json } = await fetchJson(`${base}/known-objects`);
  eq(res.status, 200, "status");
  eq(json.ok, true, "ok");
  eq(json.problem, null, "a good file has no problem");
  eq(json.objects.map((o) => o.id).sort(), ["obj-1", "obj-2", "obj-3"], "every object, every camera");
  const obj1 = json.objects.find((o) => o.id === "obj-1");
  eq(Array.isArray(obj1.notice) && obj1.notice.length > 0, true, `knownObjectNotice's lines are attached: ${JSON.stringify(obj1.notice)}`);
  eq(obj1.notice.some((line) => /umbrella|false positive|not a person/i.test(line)), false, "THE FEARED ONE: measurement only, never a verdict word");
});

await check("known-objects: scoped to one camera when asked", async () => {
  const { json } = await fetchJson(`${base}/known-objects?${new URLSearchParams({ camera: "cam-1" })}`);
  eq(json.objects.map((o) => o.id).sort(), ["obj-1", "obj-2"], "cam-1's two, not cam-2's");
  const { json: cam2 } = await fetchJson(`${base}/known-objects?${new URLSearchParams({ camera: "cam-2" })}`);
  eq(cam2.objects.map((o) => o.id), ["obj-3"], "and the other way round");
});

await check("known-objects: a bad camera id is refused the same way /events refuses it", async () => {
  const { res, json } = await fetchJson(`${base}/known-objects?${new URLSearchParams({ camera: "../etc" })}`);
  eq(res.status, 400, "status");
  eq(json.code, "bad_camera_id", "code");
});

await check("known-objects: signed out is refused, a display is refused, the store account is allowed", async () => {
  principal = ANONYMOUS;
  try {
    const { res } = await fetchJson(`${base}/known-objects`);
    eq(res.status, 401, "anonymous: sign in first");
  } finally {
    principal = INSTALLER;
  }
  principal = DISPLAY;
  try {
    const { res } = await fetchJson(`${base}/known-objects`);
    eq(res.status, 403, "THE FEARED ONE: a wall display cannot read who has been standing where");
  } finally {
    principal = INSTALLER;
  }
  principal = STORE_USER;
  try {
    const { res } = await fetchJson(`${base}/known-objects`);
    eq(res.status, 200, "the store account uses this page too (same reach as events.view elsewhere)");
  } finally {
    principal = INSTALLER;
  }
});

/* ── POST /known-objects/answer ──────────────────────────────────────────── */

await check("answer: records the owner's answer, signed by the account that gave it, and audits it", async () => {
  audits.length = 0;
  const { res, json } = await postJson(`${base}/known-objects/answer`, { id: "obj-1", belongs: true });
  eq(res.status, 200, "status");
  eq(json.ok, true, "ok");
  eq(json.object.answer, { belongs: true, atUtc: now().toISOString(), by: "tech" }, "the training label, by the signed-in account");
  eq(Array.isArray(json.object.notice), true, "the notice comes back too, for the page to redraw from");
  eq(audits, [{ event: "known-object.answer", actor: "tech", id: "obj-1", belongs: true }], "one audit line, naming who and what");

  const { json: reread } = await fetchJson(`${base}/known-objects?${new URLSearchParams({ camera: "cam-1" })}`);
  eq(reread.objects.find((o) => o.id === "obj-1").answer.belongs, true, "and it is what GET now reads back");
});

await check("answer: a later answer replaces the earlier one, not a second label alongside it", async () => {
  const { json } = await postJson(`${base}/known-objects/answer`, { id: "obj-1", belongs: false });
  eq(json.object.answer.belongs, false, "changed its mind");
  eq(json.object.answer.by, "tech", "still the account giving it");
});

await check("answer: an id that does not exist is refused, never a silent success", async () => {
  const { res, json } = await postJson(`${base}/known-objects/answer`, { id: "no-such-object", belongs: true });
  eq(res.status, 404, "status");
  eq(json.code, "no_such_known_object", "code");
  eq(json.ok, false, "ok");
});

await check("answer: bad bodies are refused before anything is written", async () => {
  const cases = [
    [{}, 400, "bad_id"],
    [{ id: "" }, 400, "bad_id"],
    [{ id: 7, belongs: true }, 400, "bad_id"],
    [{ id: "obj-1" }, 400, "bad_belongs"],
    [{ id: "obj-1", belongs: "yes" }, 400, "bad_belongs"],
    [{ id: "obj-1", belongs: 1 }, 400, "bad_belongs"],
  ];
  for (const [body, status, code] of cases) {
    const { res, json } = await postJson(`${base}/known-objects/answer`, body);
    eq(res.status, status, JSON.stringify(body));
    eq(json.code, code, JSON.stringify(body));
  }
  const { res: badJson, json: badJsonBody } = await postJson(`${base}/known-objects/answer`, "not json");
  eq(badJson.status, 400, "unparseable body");
  eq(badJsonBody.code, "bad_json", "code");
  const { res: arrayRes, json: arrayJson } = await postJson(`${base}/known-objects/answer`, [1, 2]);
  eq(arrayRes.status, 400, "an array is not an object");
  eq(arrayJson.code, "bad_json", "code");
  // No Content-Type header set by hand: fetch supplies its own default for a
  // plain string body (text/plain), never application/json on its own.
  const noType = await fetch(`${base}/known-objects/answer`, {
    method: "POST",
    body: JSON.stringify({ id: "obj-1", belongs: true }),
  });
  eq(noType.status, 415, "not sent as JSON");
});

await check("answer: signed out and a display are refused, before the store is ever touched", async () => {
  audits.length = 0;
  principal = ANONYMOUS;
  try {
    const { res } = await postJson(`${base}/known-objects/answer`, { id: "obj-1", belongs: true });
    eq(res.status, 401, "anonymous");
  } finally {
    principal = INSTALLER;
  }
  principal = DISPLAY;
  try {
    const { res } = await postJson(`${base}/known-objects/answer`, { id: "obj-1", belongs: true });
    eq(res.status, 403, "a display cannot answer for the owner");
  } finally {
    principal = INSTALLER;
  }
  eq(audits.length, 0, "neither refusal wrote an audit line");
});

await check("answer: a cross-origin POST is refused before this route ever sees it", async () => {
  const { res } = await postJson(`${base}/known-objects/answer`, { id: "obj-1", belongs: true }, {
    headers: { Origin: "https://evil.example" },
  });
  eq(res.status, 403, "the same cross-origin guard every POST route shares");
});

/* ── an unreadable store: neither route trusts it, and neither writes over it ── */

await check("THE FEARED ONE: a store that fails its own check is never overwritten, and says so instead of hiding people", async () => {
  const goodText = await readFile(knownStore.file, "utf8");
  await writeFile(knownStore.file, "{ not json", "utf8");
  try {
    const { res, json } = await fetchJson(`${base}/known-objects`);
    eq(res.status, 200, "GET still answers");
    eq(json.objects, [], "no object is trusted from a file that cannot be trusted");
    eq(typeof json.problem === "string" && json.problem.length > 0, true, "and it says why, in the field built for it");

    const { res: postRes, json: postJsonBody } = await postJson(`${base}/known-objects/answer`, { id: "obj-1", belongs: true });
    eq(postRes.status, 409, "the answer is refused rather than written over an untrustworthy file");
    eq(postJsonBody.code, "unreadable", "code");

    const stillThere = await readFile(knownStore.file, "utf8");
    eq(stillThere, "{ not json", "THE FEARED ONE: the broken file itself was never touched by either route");
  } finally {
    await writeFile(knownStore.file, goodText, "utf8");
  }
});

/* ── camctl known-objects: list and reset, against a temp state dir of its
 * own — a separate process, a separate directory, so nothing here can be
 * confused by (or confuse) the running server's fixtures above. ─────────── */

const camctlPath = join(import.meta.dirname, "..", "agent", "camctl.mjs");
const runCamctl = (dir, flags) => spawnSync(process.execPath, [camctlPath, "known-objects", "--state-dir", dir, ...flags],
  { encoding: "utf8", timeout: 30_000 });

await check("camctl known-objects: lists every object, in the same measurement words, no verdict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camplat-known-cli-"));
  try {
    const s = createKnownObjectsStore({ stateDir: dir });
    const r = await s.save([OBJ_ACTIVE, { ...OBJ_LAPSED, id: "obj-2b" }, { ...OBJ_CAM2, id: "obj-3b" }]);
    if (!r.ok) throw new Error(`setup: ${r.problem}`);
    const p = runCamctl(dir, []);
    eq(p.status, 0, `exit code: ${p.stderr}`);
    eq(p.stdout.includes("obj-1"), true, "lists the active one");
    eq(p.stdout.includes("obj-2b"), true, "and the lapsed one");
    eq(p.stdout.includes("obj-3b"), true, "and the other camera's");
    eq(p.stdout.includes("Seen as a person"), true, "the same notice text the page shows");
    eq(/umbrella|false positive|not a person/i.test(p.stdout), false, "THE FEARED ONE: a measurement, never a verdict");

    const scoped = runCamctl(dir, ["--camera", "cam-2"]);
    eq(scoped.status, 0, "exit code");
    eq(scoped.stdout.includes("obj-3b"), true, "cam-2's object");
    eq(scoped.stdout.includes("obj-1"), false, "not cam-1's");

    const empty = runCamctl(dir, ["--camera", "cam-9"]);
    eq(empty.status, 0, "exit code");
    eq(empty.stdout.trim(), "no known objects for cam-9", "says plainly there is nothing, not a blank screen");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check("camctl known-objects: --reset --id lapses one object by hand and un-hides its events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camplat-known-cli-"));
  try {
    const s = createKnownObjectsStore({ stateDir: dir });
    const r = await s.save([OBJ_ACTIVE]);
    if (!r.ok) throw new Error(`setup: ${r.problem}`);
    const db = openEventsDb(join(dir, "events.db"));
    db.upsert({ id: "e1", event: {
      id: "e1", cameraId: "cam-1", kind: "person",
      firstUtc: "2026-09-11T10:00:00.000Z", lastUtc: "2026-09-11T10:00:04.000Z",
      count: 1, bestConfidence: 0.7, bestBox: { x: 0.3, y: 0.2, w: 0.1, h: 0.42 },
      bestUtc: "2026-09-11T10:00:00.000Z",
    } }, true, { suppressedBy: OBJ_ACTIVE.id });
    db.close();

    const p = runCamctl(dir, ["--reset", "--id", OBJ_ACTIVE.id]);
    eq(p.status, 0, `exit code: ${p.stderr}`);
    eq(p.stdout.includes("1 known object(s) reset"), true, p.stdout);
    eq(p.stdout.includes("1 event(s) shown again"), true, p.stdout);

    const { objects } = await s.load();
    eq(objects[0].state, "lapsed", "reset by hand");
    eq(objects[0].lapseReason, "reset_by_hand", "the reason names what happened");

    const db2 = openEventsDb(join(dir, "events.db"));
    const after = db2.getById("e1");
    db2.close();
    eq(after.suppressedBy, null, "THE FEARED ONE: the event it was hiding is shown again, not left flagged");

    const again = runCamctl(dir, ["--reset", "--id", OBJ_ACTIVE.id]);
    eq(again.status, 0, "resetting an already-lapsed object is not an error");
    eq(again.stdout.includes("already lapsed"), true, "and says so, plainly, rather than pretending it reset again");

    const missing = runCamctl(dir, ["--reset", "--id", "no-such-id"]);
    eq(missing.status, 1, "an id that does not exist is refused, exit 1");
    eq(missing.stdout.startsWith("Refused:"), true, missing.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check("camctl known-objects: --camera --reset lapses every active object of that camera, and only that camera", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camplat-known-cli-"));
  try {
    const s = createKnownObjectsStore({ stateDir: dir });
    const other = { ...OBJ_ACTIVE, id: "obj-1-other", memberEventIds: ["e9"], members: 1, sampleEventId: "e9" };
    const r = await s.save([OBJ_ACTIVE, other, OBJ_CAM2]);
    if (!r.ok) throw new Error(`setup: ${r.problem}`);

    const p = runCamctl(dir, ["--camera", "cam-1", "--reset"]);
    eq(p.status, 0, `exit code: ${p.stderr}`);
    eq(p.stdout.includes("2 known object(s) reset"), true, p.stdout);
    eq(p.stdout.includes("no events database here"), true, "this fixture has no events.db, and it says so rather than a silent 0");

    const { objects } = await s.load();
    eq(objects.find((o) => o.id === OBJ_ACTIVE.id).state, "lapsed", "cam-1's first object");
    eq(objects.find((o) => o.id === "obj-1-other").state, "lapsed", "and cam-1's second");
    eq(objects.find((o) => o.id === OBJ_CAM2.id).state, "active", "cam-2's object untouched");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check("camctl known-objects: --reset with neither --id nor --camera is a usage error, exit 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camplat-known-cli-"));
  try {
    const p = runCamctl(dir, ["--reset"]);
    eq(p.status, 2, `exit code: ${p.stdout} ${p.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check("camctl known-objects: a store that cannot be trusted is refused, exit 1, never written over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camplat-known-cli-"));
  try {
    const file = join(dir, "known-objects.json");
    await writeFile(file, "{ not json", "utf8");
    const list = runCamctl(dir, []);
    eq(list.status, 1, "list refuses");
    eq(list.stdout.startsWith("Refused:"), true, list.stdout);
    const reset = runCamctl(dir, ["--reset", "--id", "anything"]);
    eq(reset.status, 1, "reset refuses too");
    eq(reset.stdout.startsWith("Refused:"), true, reset.stdout);
    eq(await readFile(file, "utf8"), "{ not json", "THE FEARED ONE: the broken file itself was never touched");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── cleanup ──────────────────────────────────────────────────────────────── */

closeAll();
server.close();
server.closeEvents();
index.close();
await rm(stateDir, { recursive: true, force: true });
report("known objects api");
