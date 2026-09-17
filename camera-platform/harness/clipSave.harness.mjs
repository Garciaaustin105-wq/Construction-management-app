/**
 * "Save as test clip" (AI-PLAN D0): the Review page turns a range of recorded
 * footage into an answer-key entry, and the footage is kept out of the
 * recorder's reach so the key still has something to score next month.
 *
 * Feared: a key entry whose footage is gone or partial; a broken library file
 * overwritten by a save and every earlier answer lost; a half-copied clip left
 * behind looking whole; the storage layout reaching the browser.
 */
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClipLibrary, clipIdFor, CLIP_DIR } from "../agent/clip-library.mjs";
import { decideRoute } from "../dist/routeAccess.js";
import { check, eq, report } from "./_assert.mjs";

console.log("clip save");

const tmp = await mkdtemp(join(tmpdir(), "camplat-clipsave-"));
const stateDir = join(tmp, "state");
const root = join(tmp, "disk0");
await mkdir(stateDir, { recursive: true });
await mkdir(join(root, "cam2-sub"), { recursive: true });
const exists = (p) => stat(p).then(() => true, () => false);
const libFile = join(stateDir, "clip-library.json");

const T0 = Date.UTC(2026, 8, 17, 14, 0, 0);
const at = (sec) => new Date(T0 + sec * 1000).toISOString();

// Two one-minute segments on disk, 14:00-14:02.
const files = [];
for (let i = 0; i < 2; i++) {
  const startMs = T0 + i * 60_000;
  const path = `cam2-sub/${startMs}.mp4`;
  await writeFile(join(root, path), `footage-${i}`);
  files.push({ segmentId: `cam2-sub.${startMs}`, path, name: `cam2-sub/x${i}.mp4`, startUtc: new Date(startMs).toISOString(), endUtc: new Date(startMs + 60_000).toISOString(), bytes: 9 });
}

let gapSeconds = 0;
let prepRefusal = null;
const prepared = [];
function prepare(cameraId, startUtc, endUtc) {
  prepared.push({ cameraId, startUtc, endUtc });
  if (prepRefusal) return prepRefusal;
  return {
    ok: true,
    plan: {
      ok: true, cameraId, requested: { startUtc, endUtc },
      delivered: { startUtc: files[0].startUtc, endUtc: files[1].endUtc },
      files, gaps: gapSeconds ? [{ startUtc: at(30), endUtc: at(40), reason: "camera_offline", source: "logged" }] : [],
      recordedSeconds: 120 - gapSeconds, gapSeconds, totalBytes: 18,
    },
  };
}

const audits = [];
let linkImpl = null;
let copyImpl = null;
const lib = createClipLibrary({
  stateDir, prepare,
  rootFor: () => root,
  audit: (action, req, details) => audits.push({ action, details }),
  log: () => {},
  link: (a, b) => (linkImpl ? linkImpl(a, b) : import("node:fs/promises").then((m) => m.link(a, b))),
  copyFile: (a, b) => (copyImpl ? copyImpl(a, b) : import("node:fs/promises").then((m) => m.copyFile(a, b))),
});

const principal = { kind: "user", username: "installer", role: "installer" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (!(await lib.handle(req, res, url.pathname, req.method, principal))) {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function get() {
  const res = await fetch(base + "/clip-library");
  return { status: res.status, json: await res.json() };
}
async function post(body) {
  const res = await fetch(base + "/clip-library", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}
const walk = (over = {}) => ({ cameraId: "cam2-sub", startUtc: at(10), endUtc: at(70), scenes: ["person"], people: 1, vehicles: 0, ...over });

async function reset() {
  await rm(libFile, { force: true });
  await rm(join(root, CLIP_DIR), { recursive: true, force: true });
  gapSeconds = 0; prepRefusal = null; linkImpl = null; copyImpl = null;
  audits.length = 0; prepared.length = 0;
}

/* ---------------- ids ---------------- */

await check("a clip id is a safe file name built from camera and start", () => {
  const id = clipIdFor("Cam_2-Sub", at(10));
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("unsafe id " + id);
  eq(id.startsWith("cam-2-sub-"), true, "camera first: " + id);
  if (clipIdFor("Cam_2-Sub", at(10)) !== id) throw new Error("not stable");
  if (clipIdFor("Cam_2-Sub", at(11)) === id) throw new Error("a different second must be a different id");
  const long = clipIdFor("c".repeat(64), at(10));
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(long)) throw new Error("long camera id overflows: " + long);
});

await check("the storage folder can never be a camera's folder", () => {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(CLIP_DIR)) throw new Error(CLIP_DIR + " is a valid camera id");
});

/* ---------------- reading ---------------- */

await reset();
await check("no library yet reads as an empty one, not an error", async () => {
  const r = await get();
  eq(r.status, 200, "status");
  eq(r.json.ok, true, "ok");
  eq(r.json.library, { version: 1, clips: [] }, "empty");
  eq(r.json.problem, null, "no problem");
});

/* ---------------- saving ---------------- */

await reset();
await check("a save writes the answer and keeps the footage out of the recorder's reach", async () => {
  const r = await post(walk({ note: "front path" }));
  eq(r.status, 200, "status " + r.text);
  const id = clipIdFor("cam2-sub", at(10));
  eq(r.json.clip, {
    id, cameraId: "cam2-sub", startUtc: at(10), endUtc: at(70), scenes: ["person"],
    expected: [{ kind: "person", fromUtc: at(10), toUtc: at(70), count: 1 }], note: "front path",
  }, "the clip as saved");
  eq(r.json.fileCount, 2, "two files");
  eq(prepared, [{ cameraId: "cam2-sub", startUtc: at(10), endUtc: at(70) }], "planned the asked range");
  const saved = JSON.parse(await readFile(libFile, "utf8"));
  eq(saved.clips.map((c) => c.id), [id], "on disk");
  for (let i = 0; i < 2; i++) {
    const kept = join(root, CLIP_DIR, id, `${T0 + i * 60_000}.mp4`);
    eq(await readFile(kept, "utf8"), `footage-${i}`, "footage " + i + " kept");
  }
  // The recorder deleting its own copy must not touch the clip's.
  await rm(join(root, files[0].path));
  eq(await readFile(join(root, CLIP_DIR, id, `${T0}.mp4`), "utf8"), "footage-0", "survives eviction");
  await writeFile(join(root, files[0].path), "footage-0");
  eq(audits.length, 1, "audited");
  eq(audits[0].action, "cliplibrary.add", "action");
  eq(audits[0].details.actor, "installer", "who");
  eq(audits[0].details.clipId, id, "which");
});

await check("THE FEARED ONE: no storage path reaches the browser", async () => {
  await rm(libFile, { force: true });
  await rm(join(root, CLIP_DIR), { recursive: true, force: true });
  const r = await post(walk());
  eq(r.status, 200, "saved");
  if (r.text.includes(tmp.replace(/\\/g, "\\\\")) || r.text.includes(".mp4") || r.text.includes(CLIP_DIR)) {
    throw new Error("layout leaked: " + r.text);
  }
});

await check("vehicles become expected vehicles, and none of either needs the empty tag", async () => {
  await reset();
  const r = await post(walk({ scenes: ["vehicle", "night"], people: 0, vehicles: 2 }));
  eq(r.status, 200, r.text);
  eq(r.json.clip.expected, [{ kind: "vehicle", fromUtc: at(10), toUtc: at(70), count: 2 }], "vehicles");
  await reset();
  const empty = await post(walk({ scenes: ["empty"], people: 0, vehicles: 0 }));
  eq(empty.status, 200, empty.text);
  eq(empty.json.clip.expected, [], "nothing expected");
  eq(Object.hasOwn(empty.json.clip, "note"), false, "no note, no key");
});

await reset();
await check("THE FEARED ONE: footage with a gap is refused, and nothing is written", async () => {
  gapSeconds = 10;
  const r = await post(walk());
  eq(r.status, 409, "status");
  eq(r.json.code, "footage_gap", "code");
  eq(await exists(libFile), false, "no library");
  eq(await exists(join(root, CLIP_DIR)), false, "no footage copied");
});

await reset();
await check("a range the recorder cannot export is refused with its own reason", async () => {
  prepRefusal = { ok: false, status: 422, code: "export_reaches_recording", message: "still recording" };
  const r = await post(walk());
  eq(r.status, 422, "status");
  eq(r.json.code, "export_reaches_recording", "code");
  eq(await exists(libFile), false, "nothing written");
});

await reset();
await check("an answer that contradicts itself is refused with the reasons", async () => {
  const r = await post(walk({ scenes: ["empty"], people: 1 }));
  eq(r.status, 400, "status");
  eq(r.json.code, "bad_clip", "code");
  if (!Array.isArray(r.json.errors) || !r.json.errors.some((e) => e.includes("empty"))) throw new Error("no reason: " + r.text);
  eq(await exists(libFile), false, "nothing written");
  eq(await exists(join(root, CLIP_DIR)), false, "no footage copied");
  eq(prepared.length, 0, "refused before touching footage");
});

await reset();
await check("bad fields are refused before anything else", async () => {
  for (const [body, code] of [
    [walk({ cameraId: "../x" }), "bad_camera_id"],
    [walk({ people: -1 }), "bad_count"],
    [walk({ people: 1.5 }), "bad_count"],
    [walk({ vehicles: "2" }), "bad_count"],
    [walk({ people: 999 }), "bad_count"],
    [walk({ scenes: "person" }), "bad_scenes"],
    [walk({ note: 5 }), "bad_note"],
    [walk({ note: "x".repeat(501) }), "bad_note"],
  ]) {
    const r = await post(body);
    eq([r.status, r.json.code], [400, code], JSON.stringify(body).slice(0, 80));
  }
  eq(prepared.length, 0, "no footage planned");
});

await reset();
await check("THE FEARED ONE: the same stretch saved twice is refused, and the first answer stays", async () => {
  eq((await post(walk())).status, 200, "first");
  const again = await post(walk({ startUtc: at(40), endUtc: at(100), scenes: ["empty"], people: 0 }));
  eq(again.status, 400, "overlap refused");
  eq(again.json.code, "bad_clip", "code");
  const saved = JSON.parse(await readFile(libFile, "utf8"));
  eq(saved.clips.length, 1, "still one");
  eq(saved.clips[0].expected[0].count, 1, "the first answer");
  eq((await readdir(join(root, CLIP_DIR))).length, 1, "one footage folder");
});

await reset();
await check("THE FEARED ONE: a library file that cannot be read is never overwritten by a save", async () => {
  await writeFile(libFile, "{ this is not json");
  const g = await get();
  eq(g.status, 200, "still answers");
  if (typeof g.json.problem !== "string" || g.json.problem.length === 0) throw new Error("problem not reported");
  const r = await post(walk());
  eq(r.status, 409, "refused");
  eq(r.json.code, "library_unreadable", "code");
  eq(await readFile(libFile, "utf8"), "{ this is not json", "file untouched");
  await writeFile(libFile, JSON.stringify({ version: 1, clips: [{ id: "x", cameraId: "c", startUtc: at(0), endUtc: at(1), scenes: ["ghost"], expected: [] }] }));
  eq((await post(walk())).json.code, "library_unreadable", "a valid-JSON but invalid key is also unreadable");
});

await reset();
await check("a hard link that fails (another drive) falls back to a copy", async () => {
  linkImpl = async () => { const e = new Error("cross-device"); e.code = "EXDEV"; throw e; };
  const r = await post(walk());
  eq(r.status, 200, r.text);
  const id = clipIdFor("cam2-sub", at(10));
  eq(await readFile(join(root, CLIP_DIR, id, `${T0 + 60_000}.mp4`), "utf8"), "footage-1", "copied");
});

await reset();
await check("THE FEARED ONE: a copy that fails half way leaves no clip and no answer", async () => {
  linkImpl = async () => { const e = new Error("nope"); e.code = "EPERM"; throw e; };
  let n = 0;
  copyImpl = async (a, b) => {
    if (n++ === 1) { const e = new Error("disk full"); e.code = "ENOSPC"; throw e; }
    return (await import("node:fs/promises")).copyFile(a, b);
  };
  const r = await post(walk());
  eq(r.status, 500, "status");
  eq(r.json.code, "footage_copy_failed", "code");
  eq(await exists(libFile), false, "no answer");
  eq(await exists(join(root, CLIP_DIR, clipIdFor("cam2-sub", at(10)))), false, "no half clip");
  eq(audits.length, 0, "nothing audited");
});

await reset();
await check("two saves of one stretch at once: exactly one wins", async () => {
  const [a, b] = await Promise.all([post(walk()), post(walk({ scenes: ["empty"], people: 0 }))]);
  eq([a.status, b.status].sort(), [200, 400], "one saved, one refused");
  eq(JSON.parse(await readFile(libFile, "utf8")).clips.length, 1, "one clip");
});

await check("other paths and methods are not this module's", async () => {
  const res = await fetch(base + "/clip-library", { method: "DELETE" });
  eq(res.status, 404, "delete");
  const other = await fetch(base + "/clip-library-x");
  eq(other.status, 404, "prefix");
});

/* ---------------- access ---------------- */

await check("reading the key is review; saving copies footage out, so it is export", () => {
  const store = { kind: "user", username: "s", role: "store" };
  const display = { kind: "display", displayId: "d" };
  eq(decideRoute(principal, "GET", "/clip-library").kind, "allow", "installer reads");
  eq(decideRoute(principal, "POST", "/clip-library").kind, "allow", "installer saves");
  eq(decideRoute(display, "POST", "/clip-library").kind === "allow", false, "a wall display cannot save");
  eq(decideRoute(display, "GET", "/clip-library").kind === "allow", false, "a wall display cannot read");
  eq(typeof decideRoute(store, "GET", "/clip-library").kind, "string", "store decided, not thrown");
});

server.close();
await rm(tmp, { recursive: true, force: true });
report("clipSave");
