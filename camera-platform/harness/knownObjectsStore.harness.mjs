/**
 * The known-objects store (agent/known-objects.mjs): the file that says which
 * spots hide events automatically, and the camera fingerprint that lapses them.
 *
 * THE FEARED FAILURES: a file that cannot be read being overwritten with "no
 * objects" - the only record of what hid which events, gone, while looking
 * like a fresh start; a half-read file hiding people on the strength of the
 * half that parsed; a crash mid-write leaving a half file; two processes (the
 * detector counting matches, the API recording an owner's answer, camctl
 * resetting) each writing over the other's change; a camera password, or a
 * whole camera address, reaching the fingerprint, the file or a problem
 * message; a new password lapsing every known object as if the camera moved.
 */
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { readFile as fsReadFile, rename as fsRename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKnownObjectsStore, cameraFingerprint, KNOWN_OBJECTS_FILE } from "../agent/known-objects.mjs";
import { learnKnownObjects, answerKnownObject, noteMatch } from "../dist/knownObjects.js";
import { check, eq, report } from "./_assert.mjs";

console.log("known objects store");

const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3_600_000;

async function dir() {
  return mkdtemp(path.join(tmpdir(), "camplat-known-"));
}

/** One valid object, as the contract stores it. */
function object(over = {}) {
  return {
    id: "cam-1:person:1790000000000",
    cameraId: "cam-1",
    kind: "person",
    box: { x: 0.698, y: 0.364, w: 0.088, h: 0.42 },
    state: "active",
    lapsedAtUtc: null,
    lapseReason: null,
    learnedAtUtc: "2026-09-23T00:30:00.000Z",
    firstSeenUtc: "2026-09-22T21:55:07.748Z",
    lastSeenUtc: "2026-09-23T00:20:31.210Z",
    lastMatchedUtc: null,
    members: 3,
    matched: 0,
    confidenceMax: 0.7988,
    sampleEventId: "cam-1:1:1",
    memberEventIds: ["cam-1:1:1", "cam-1:2:2", "cam-1:3:3"],
    cameraFingerprint: "0123456789abcdef",
    answer: null,
    ...over,
  };
}
const fileText = (objects) => `${JSON.stringify({ version: 1, objects }, null, 2)}\n`;

// This evening's real umbrella rows (2026-09-22, bench camera), as the fold
// stored them: 17 still events of a furled patio umbrella, stored as a person.
// [first, last, confidence, x, y, w, h]. Embedded so the harness never
// depends on a scratch file.
const UMBRELLA = [
  ["2026-09-22T21:55:07.748Z", "2026-09-22T21:55:07.748Z", 0.6226, 0.69768, 0.36345, 0.09393, 0.42538],
  ["2026-09-22T21:56:59.379Z", "2026-09-22T21:56:59.379Z", 0.5047, 0.69773, 0.36596, 0.08889, 0.41594],
  ["2026-09-22T22:01:52.974Z", "2026-09-22T22:01:52.974Z", 0.5123, 0.69909, 0.36571, 0.08833, 0.43438],
  ["2026-09-22T22:05:02.386Z", "2026-09-22T22:05:02.386Z", 0.5341, 0.69785, 0.36701, 0.09931, 0.42035],
  ["2026-09-22T22:05:18.590Z", "2026-09-22T22:05:25.379Z", 0.6479, 0.69783, 0.36372, 0.08986, 0.40962],
  ["2026-09-22T22:06:00.379Z", "2026-09-22T22:06:00.379Z", 0.5901, 0.69961, 0.36481, 0.07954, 0.41503],
  ["2026-09-22T22:07:05.161Z", "2026-09-22T22:07:14.559Z", 0.7988, 0.69979, 0.36473, 0.08178, 0.41967],
  ["2026-09-22T22:07:33.954Z", "2026-09-22T22:07:36.562Z", 0.6457, 0.7002, 0.36623, 0.08032, 0.41702],
  ["2026-09-22T22:07:49.149Z", "2026-09-22T22:08:03.400Z", 0.6743, 0.69975, 0.36437, 0.09332, 0.41222],
  ["2026-09-22T22:08:22.198Z", "2026-09-22T22:08:28.393Z", 0.7623, 0.70121, 0.36325, 0.07917, 0.43076],
  ["2026-09-22T22:08:47.989Z", "2026-09-22T22:11:29.956Z", 0.7881, 0.69939, 0.36584, 0.08819, 0.41676],
  ["2026-09-22T22:12:04.606Z", "2026-09-22T22:12:07.800Z", 0.5668, 0.70037, 0.36335, 0.08832, 0.41729],
  ["2026-09-22T22:12:22.001Z", "2026-09-22T22:12:22.001Z", 0.5589, 0.69792, 0.3626, 0.09173, 0.42515],
  ["2026-09-22T22:12:41.995Z", "2026-09-22T22:13:29.988Z", 0.7684, 0.6976, 0.36341, 0.09171, 0.43008],
  ["2026-09-22T22:13:59.381Z", "2026-09-22T22:14:05.775Z", 0.6638, 0.69782, 0.36306, 0.0853, 0.42685],
  ["2026-09-22T22:16:38.396Z", "2026-09-22T22:16:38.396Z", 0.5169, 0.69589, 0.36153, 0.08744, 0.44704],
  ["2026-09-22T22:20:31.210Z", "2026-09-22T22:20:31.210Z", 0.5817, 0.69874, 0.36382, 0.08386, 0.42189],
];

await check("a missing file is no objects and no problem, and writing nothing to it creates nothing", async () => {
  const stateDir = await dir();
  const store = createKnownObjectsStore({ stateDir });
  eq(await store.load(), { objects: [], problem: null }, "no file: nothing known, nothing wrong");
  eq(await store.save([]), { ok: true, objects: [], changed: false }, "saving nothing is not a write");
  eq(await store.update(() => null), { ok: true, objects: [], changed: false }, "update giving null writes nothing");
  eq(await readdir(stateDir), [], "and the directory is exactly as it was: a box with no known objects gains no file");
  eq(path.basename(store.file), KNOWN_OBJECTS_FILE, "the file is <stateDir>/known-objects.json");
});

await check("THIS EVENING: the umbrella the contract learns is written, and read back exactly", async () => {
  const stateDir = await dir();
  const store = createKnownObjectsStore({ stateDir });
  const events = [];
  UMBRELLA.forEach(([first, last, conf, x, y, w, h], i) => {
    for (const shift of [0, 2 * HOUR]) {
      events.push({
        id: `cam-1:${shift}:${i}`, cameraId: "cam-1", kind: "person",
        firstUtc: iso(Date.parse(first) + shift), lastUtc: iso(Date.parse(last) + shift),
        bestConfidence: conf, bestBox: { x, y, w, h }, travel: 0, finished: true,
      });
    }
  });
  const learning = learnKnownObjects({ events, existing: [], nowUtc: "2026-09-23T00:30:00.000Z", fingerprints: { "cam-1": "0123456789abcdef" } });
  eq(learning.learned.length, 1, "the contract learns one object from the real rows");
  const saved = await store.save(learning.learned);
  eq([saved.ok, saved.changed], [true, true], "written");
  const loaded = await store.load();
  eq(loaded, { objects: learning.learned, problem: null }, "read back exactly as written");
  const raw = JSON.parse(await readFile(store.file, "utf8"));
  eq(Object.keys(raw), ["version", "objects"], "the file is { version, objects }");
  eq(raw.version, 1, "version 1");
  eq(await readdir(stateDir), [KNOWN_OBJECTS_FILE], "and no temporary file is left behind");
});

await check("THE FEARED ONE: a file that cannot be read is reported, gives no objects, and is never overwritten", async () => {
  const stateDir = await dir();
  await writeFile(path.join(stateDir, KNOWN_OBJECTS_FILE), fileText([object()]));
  let writes = 0;
  let renames = 0;
  const store = createKnownObjectsStore({
    stateDir,
    readFileFn: async () => { const err = new Error("permission denied"); err.code = "EACCES"; throw err; },
    writeFileFn: async () => { writes += 1; },
    renameFn: async () => { renames += 1; },
  });
  const loaded = await store.load();
  eq(loaded.objects, [], "nothing known: nothing will be hidden");
  if (!/could not be read \(EACCES\)/.test(loaded.problem ?? "")) throw new Error(`the problem should say why: ${loaded.problem}`);
  const saved = await store.save([object({ id: "cam-1:person:2" })]);
  eq([saved.ok, saved.code, saved.objects], [false, "unreadable", []], "save refused");
  let mutated = false;
  const updated = await store.update((objects) => { mutated = true; return objects; });
  eq([updated.ok, updated.code, mutated], [false, "unreadable", false], "update refused before it is even asked what to write");
  eq([writes, renames], [0, 0], "nothing was written, nothing renamed");
  eq(await readFile(path.join(stateDir, KNOWN_OBJECTS_FILE), "utf8"), fileText([object()]), "the file is as it was");
});

await check("THE FEARED ONE: a half-written or empty file is refused whole, never overwritten, and never quoted", async () => {
  for (const [text, why] of [[fileText([object()]).slice(0, 140), "cut off half way"], ["", "empty"], ["not json {\"password\": \"hunter2\"}", "not JSON at all"]]) {
    const stateDir = await dir();
    const file = path.join(stateDir, KNOWN_OBJECTS_FILE);
    await writeFile(file, text);
    const store = createKnownObjectsStore({ stateDir });
    const loaded = await store.load();
    eq(loaded.objects, [], `${why}: no objects`);
    eq(loaded.problem, `${KNOWN_OBJECTS_FILE} is not valid JSON`, `${why}: said plainly, without the parser's quote of the text`);
    const saved = await store.save([object()]);
    eq([saved.ok, saved.code], [false, "unreadable"], `${why}: save refused`);
    const answered = await store.update((objects) => objects);
    eq(answered.ok, false, `${why}: update refused`);
    eq(await readFile(file, "utf8"), text, `${why}: the file is byte for byte what it was`);
  }
});

await check("THE FEARED ONE: one object the checker refuses spoils the whole file - no half of it is trusted", async () => {
  const stateDir = await dir();
  const file = path.join(stateDir, KNOWN_OBJECTS_FILE);
  const good1 = object();
  const good2 = object({ id: "cam-2:person:1790000000000", cameraId: "cam-2" });
  const bad = object({ id: "cam-1:plate:1", kind: "plate" });   // a plate is never a known object
  for (const [raw, why] of [
    [{ version: 1, objects: [good1, bad, good2] }, "a plate among good objects"],
    [{ version: 1, objects: [good1, { ...good2, notice: ["Seen as a person 3 times"] }] }, "an object with a field the file does not have"],
    [{ version: 2, objects: [good1] }, "a version this code does not know"],
    [{ version: 1, objects: [good1], note: "edited by hand" }, "an extra top-level key"],
    [{ version: 1, objects: [good1, { ...good1 }] }, "the same id twice"],
  ]) {
    const text = `${JSON.stringify(raw, null, 2)}\n`;
    await writeFile(file, text);
    const store = createKnownObjectsStore({ stateDir });
    const loaded = await store.load();
    eq(loaded.objects, [], `${why}: NO objects - not the good ones either`);
    if (!/failed its check/.test(loaded.problem ?? "")) throw new Error(`${why}: the problem should say the check failed: ${loaded.problem}`);
    eq((await store.save([good1])).code, "unreadable", `${why}: never overwritten`);
    eq(await readFile(file, "utf8"), text, `${why}: untouched`);
  }
});

await check("THE FEARED ONE: a problem message never carries a camera address, its user name or its password", async () => {
  const stateDir = await dir();
  // A hand-edited file quoting a whole camera address where a kind belongs:
  // the checker quotes bad values back, and this must not reach a log.
  await writeFile(path.join(stateDir, KNOWN_OBJECTS_FILE),
    fileText([object({ kind: "rtsp://camuser9:Hunter-22@10.1.2.3:554/Streaming/Channels/102" })]));
  const { problem } = await createKnownObjectsStore({ stateDir }).load();
  if (problem === null) throw new Error("the file should have been refused");
  for (const secret of ["rtsp://", "camuser9", "Hunter-22", "10.1.2.3"]) {
    if (problem.includes(secret)) throw new Error(`the problem carries ${secret}: ${problem}`);
  }
  if (!/kind must be/.test(problem)) throw new Error(`while still saying what is wrong: ${problem}`);
});

await check("a problem lists the first few of the checker's errors, not hundreds", async () => {
  const stateDir = await dir();
  const many = Array.from({ length: 40 }, (_, i) => object({ id: `x${i}`, confidenceMax: 2 }));   // one error each
  await writeFile(path.join(stateDir, KNOWN_OBJECTS_FILE), fileText(many));
  const { problem } = await createKnownObjectsStore({ stateDir }).load();
  eq((problem.match(/confidenceMax must be/g) ?? []).length, 3, "three shown");
  if (!/and 37 more/.test(problem)) throw new Error(`and the rest counted: ${problem}`);
});

await check("THE FEARED ONE: a write that fails half way (disk full) or a rename that fails leaves the old file whole", async () => {
  for (const which of ["write", "rename"]) {
    const stateDir = await dir();
    const file = path.join(stateDir, KNOWN_OBJECTS_FILE);
    await writeFile(file, fileText([object()]));
    const store = createKnownObjectsStore({
      stateDir,
      writeFileFn: async (f, text) => {
        await writeFile(f, which === "write" ? text.slice(0, 50) : text);   // a partial write, then the disk fills
        if (which === "write") { const err = new Error("no space"); err.code = "ENOSPC"; throw err; }
      },
      renameFn: async (from, to) => {
        if (which === "rename") { const err = new Error("busy"); err.code = "EBUSY"; throw err; }
        return fsRename(from, to);
      },
    });
    const saved = await store.save([object(), object({ id: "cam-2:person:1", cameraId: "cam-2" })]);
    eq([saved.ok, saved.code], [false, "write_failed"], `${which}: reported as a failed write`);
    if (!saved.problem.includes(which === "write" ? "ENOSPC" : "EBUSY")) throw new Error(`${which}: the problem should name the error: ${saved.problem}`);
    eq(saved.objects, [object()], `${which}: and it says what the file still holds`);
    eq(await readFile(file, "utf8"), fileText([object()]), `${which}: the old file is whole`);
    eq(await readdir(stateDir), [KNOWN_OBJECTS_FILE], `${which}: no temporary file left behind`);
    eq((await store.load()).objects, [object()], `${which}: and still reads`);
  }
});

await check("the new file goes beside the old one and is renamed over it; it is never written in place", async () => {
  const stateDir = await dir();
  const file = path.join(stateDir, KNOWN_OBJECTS_FILE);
  await writeFile(file, fileText([object()]));
  const written = [];
  const store = createKnownObjectsStore({
    stateDir,
    writeFileFn: async (f, text) => { written.push(f); await writeFile(f, text); },
  });
  const next = [object({ matched: 1 })];
  eq((await store.save(next)).ok, true, "saved");
  eq(written.length, 1, "one write");
  if (written[0] === file) throw new Error("wrote the live file in place");
  eq(path.dirname(written[0]), stateDir, "beside it, on the same drive, so the rename is atomic");
  eq((await store.load()).objects, next, "and the rename made it the file");
});

await check("a write of objects that would fail their own check is refused, and nothing is written", async () => {
  const stateDir = await dir();
  const file = path.join(stateDir, KNOWN_OBJECTS_FILE);
  await writeFile(file, fileText([object()]));
  const store = createKnownObjectsStore({ stateDir });
  for (const [objects, why] of [
    [[{ ...object(), notice: ["Seen as a person 3 times"] }], "the page's notice lines saved with it"],
    [[object({ box: { x: 0.9, y: 0.1, w: 0.3, h: 0.2 } })], "a box outside the frame"],
    [[object(), object()], "two objects with one id"],
    [[{ ...object(), url: "rtsp://camuser9:Hunter-22@10.1.2.3/sub" }], "a camera address saved on an object"],
  ]) {
    const saved = await store.save(objects);
    eq([saved.ok, saved.code], [false, "invalid"], `${why}: refused`);
    if (saved.problem.includes("Hunter-22") || saved.problem.includes("rtsp://")) throw new Error(`${why}: the refusal quotes an address: ${saved.problem}`);
    eq(await readFile(file, "utf8"), fileText([object()]), `${why}: the file is untouched`);
  }
  eq((await store.save("everything")).code, "invalid", "save of something that is not a list: refused, not read as 'write nothing'");
});

await check("THE FEARED ONE: another process writes between our read and our rename - we start over on top of theirs", async () => {
  const stateDir = await dir();
  const file = path.join(stateDir, KNOWN_OBJECTS_FILE);
  await writeFile(file, fileText([object()]));
  // The detector counts a match; while it writes, the API server records the
  // owner's answer (it writes the file between the detector's read and its
  // rename). The answer must survive, AND the match must still be counted.
  let reads = 0;
  const store = createKnownObjectsStore({
    stateDir,
    readFileFn: async (f, enc) => {
      reads += 1;
      if (reads === 2) {
        const answered = answerKnownObject(object(), { belongs: false, by: "austin" }, "2026-09-23T01:00:00.000Z");
        await writeFile(file, fileText([answered]));
      }
      return fsReadFile(f, enc);
    },
  });
  let calls = 0;
  const result = await store.update((objects) => {
    calls += 1;
    return objects.map((o) => noteMatch(o, { cameraId: "cam-1", kind: "person", bestBox: o.box, bestConfidence: 0.6, travel: 0 }, "2026-09-23T01:00:05.000Z"));
  });
  eq([result.ok, result.changed], [true, true], "written");
  eq(calls, 2, "the change was made twice: once on the old file, again on theirs");
  const [final] = (await store.load()).objects;
  eq(final.answer, { belongs: false, atUtc: "2026-09-23T01:00:00.000Z", by: "austin" }, "the owner's answer is still there");
  eq([final.matched, final.lastMatchedUtc], [1, "2026-09-23T01:00:05.000Z"], "and so is the match");
  eq(await readdir(stateDir), [KNOWN_OBJECTS_FILE], "the abandoned first attempt left no temporary file");
});

await check("a file that keeps changing under every attempt is reported busy, and not overwritten", async () => {
  const stateDir = await dir();
  const file = path.join(stateDir, KNOWN_OBJECTS_FILE);
  await writeFile(file, fileText([object()]));
  let n = 0;
  const store = createKnownObjectsStore({
    stateDir,
    readFileFn: async (f, enc) => {
      n += 1;
      if (n % 2 === 0) await writeFile(file, fileText([object({ matched: n })]));   // someone writing in a loop
      return fsReadFile(f, enc);
    },
  });
  const result = await store.update((objects) => objects.map((o) => ({ ...o, members: o.members + 1 })));
  eq([result.ok, result.code], [false, "busy"], "gave up and said so");
  const [final] = (await store.load()).objects;
  eq(final.members, 3, "our change never landed over theirs");
});

await check("a change that writes the same objects is not a write; a throw from the change writes nothing and comes back", async () => {
  const stateDir = await dir();
  const file = path.join(stateDir, KNOWN_OBJECTS_FILE);
  await writeFile(file, fileText([object()]));
  let writes = 0;
  const store = createKnownObjectsStore({ stateDir, writeFileFn: async (f, t) => { writes += 1; await writeFile(f, t); } });
  eq(await store.update((objects) => objects), { ok: true, objects: [object()], changed: false }, "the same objects: nothing written");
  eq(writes, 0, "no write");
  let threw = null;
  try { await store.update(() => { throw new Error("no such object"); }); } catch (err) { threw = err; }
  eq(threw?.message, "no such object", "the caller's own refusal comes back to it");
  eq([writes, await readFile(file, "utf8")], [0, fileText([object()])], "and nothing was written");
});

// ---------------- cameraFingerprint ----------------

const HIK = { cameraId: "cam-2", name: "Gate", host: "10.9.8.2", vendor: "hikvision", channel: 1, stream: "main" };
const TYPED = { cameraId: "cam-1", url: "rtsp://camuser9:Hunter-22@10.9.8.1:554/main", substreamUrl: "rtsp://camuser9:Hunter-22@10.9.8.1:554/sub" };

check("THE FEARED ONE: the fingerprint never holds the login - a new password or user is not a moved camera", () => {
  const base = cameraFingerprint(TYPED);
  for (const [cam, why] of [
    [{ ...TYPED, url: "rtsp://camuser9:0ther-pw@10.9.8.1:554/main", substreamUrl: "rtsp://camuser9:0ther-pw@10.9.8.1:554/sub" }, "a new password"],
    [{ ...TYPED, url: "rtsp://viewer:x@10.9.8.1:554/main", substreamUrl: "rtsp://viewer:x@10.9.8.1:554/sub" }, "another user"],
    [{ ...TYPED, url: "rtsp://10.9.8.1:554/main", substreamUrl: "rtsp://10.9.8.1:554/sub" }, "no login in the address (the site login is used)"],
    [{ ...TYPED, url: "rtsp://10.9.8.1/main", substreamUrl: "rtsp://10.9.8.1/sub" }, "the default port written out or left off"],
    [{ ...TYPED, url: "rtsp://camuser9:p%40ss@10.9.8.1:554/main", substreamUrl: "rtsp://camuser9:p@ss@10.9.8.1:554/sub" }, "a password with an @ in it"],
  ]) {
    eq(cameraFingerprint(cam), base, why);
  }
  const inPath = (user, pass) => ({ cameraId: "c", url: `rtsp://10.9.8.5:554/user=${user}&password=${pass}&channel=1&stream=0.sdp` });
  eq(cameraFingerprint(inPath("admin", "Hunter-22")), cameraFingerprint(inPath("bob", "0ther")), "a login carried in the path (some vendors) is not part of it either");
  const inQuery = (pass) => ({ cameraId: "c", url: `rtsp://10.9.8.5:554/cam/realmonitor?channel=1&subtype=1&pwd=${pass}` });
  eq(cameraFingerprint(inQuery("Hunter-22")), cameraFingerprint(inQuery("0ther")), "nor one in the query");
  eq(cameraFingerprint({ ...HIK, extra: { password: "Hunter-22" } }), cameraFingerprint(HIK), "nor anything outside the fields it reads");
});

check("the fingerprint changes with what the camera connects to: host, channel, stream, vendor, and each address's host, port and path", () => {
  const seen = new Map([[cameraFingerprint(HIK), "base"], [cameraFingerprint(TYPED), "typed base"]]);
  for (const [cam, why] of [
    [{ ...HIK, host: "10.9.8.3" }, "another host"],
    [{ ...HIK, channel: 2 }, "another channel"],
    [{ ...HIK, stream: "sub" }, "another stream"],
    [{ ...HIK, vendor: "axis" }, "another vendor"],
    [{ ...TYPED, url: "rtsp://camuser9:Hunter-22@10.9.8.9:554/main" }, "the address's host"],
    [{ ...TYPED, url: "rtsp://camuser9:Hunter-22@10.9.8.1:8554/main" }, "the address's port"],
    [{ ...TYPED, url: "rtsp://camuser9:Hunter-22@10.9.8.1:554/main2" }, "the address's path"],
    [{ ...TYPED, substreamUrl: "rtsp://camuser9:Hunter-22@10.9.8.1:554/sub2" }, "the substream the detector watches"],
    [{ ...TYPED, substreamUrl: undefined }, "the substream taken away"],
    [{ cameraId: "c", url: "rtsp://10.9.8.5:554/cam/realmonitor?channel=2&subtype=1&pwd=x" }, "a channel chosen in the query"],
    [{ cameraId: "c", url: "rtsp://10.9.8.5:554/cam/realmonitor?channel=1&subtype=1&pwd=x" }, "(its twin on channel 1)"],
  ]) {
    const fp = cameraFingerprint(cam);
    if (seen.has(fp)) throw new Error(`${why}: same fingerprint as ${seen.get(fp)}`);
    seen.set(fp, why);
  }
});

check("the fingerprint ignores what does not move the camera (its name, its bitrate) and reads blanks as the recorder does", () => {
  const base = cameraFingerprint(HIK);
  eq(cameraFingerprint({ ...HIK, name: "Front gate" }), base, "renamed");
  eq(cameraFingerprint({ ...HIK, bitrateKbps: 4096 }), base, "a bitrate");
  eq(cameraFingerprint({ ...HIK, host: "CAM-2.LOCAL" }), cameraFingerprint({ ...HIK, host: "cam-2.local" }), "host names in any case");
  const bare = { cameraId: "cam-2", host: "10.9.8.2", vendor: "hikvision" };
  eq(cameraFingerprint(bare), base, "channel and stream left out mean 1 and main, as resolveCameraUrl reads them");
  eq(cameraFingerprint({ cameraId: "c", host: "10.9.8.2" }), cameraFingerprint({ cameraId: "c", host: "10.9.8.2", vendor: "generic" }), "vendor left out means generic");
});

check("THE FEARED ONE: the fingerprint holds nothing of the address - 16 hex characters, and an address it cannot parse is never read", () => {
  const fp = cameraFingerprint(TYPED);
  if (!/^[0-9a-f]{16}$/.test(fp)) throw new Error(`not 16 hex characters: ${fp}`);
  // An address that fails to parse is most often one whose password broke it:
  // its text must not be used at all, so two broken ones fingerprint alike.
  eq(cameraFingerprint({ cameraId: "c", url: "rtsp://camuser9:Hun/ter@10.9.8.1/main" }),
    cameraFingerprint({ cameraId: "c", url: "rtsp://other:pw/x@10.9.8.7/zzz" }), "two unparseable addresses: the same, because neither was read");
  for (const bad of [null, undefined, "cam-1", 7, []]) {
    let threw = false;
    try { cameraFingerprint(bad); } catch { threw = true; }
    if (!threw) throw new Error(`${JSON.stringify(bad)}: fingerprinted anyway`);
  }
});

report("known objects store");
