/**
 * How long recordings are kept: the contract, the routes on a real server
 * (loopback), and the recorder's age pass deleting real files in temp drives.
 *
 * Feared: a missing or broken recording.json deleting footage; lowering the
 * limit deleting footage nobody was shown; a segment only partly past the
 * limit, a held one, or one pending upload deleted; a limit applying only
 * after a restart.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer } from "../agent/api-server.mjs";
import { runAgeEviction } from "../agent/recorder-service.mjs";
import { openIndex } from "../agent/segindex.mjs";
import {
  checkRecordingSettings, readRecordingFile, ageCutoffMs, confirmSave, recordingFileText,
} from "../dist/recordingSettings.js";
import { decideRoute } from "../dist/routeAccess.js";
import { check, eq, report } from "./_assert.mjs";

console.log("recording settings");

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-16T12:00:00Z");
const tmp = await mkdtemp(join(tmpdir(), "camplat-recset-"));
const stateDir = join(tmp, "state");
const d0 = join(tmp, "disk0");
const d1 = join(tmp, "disk1");
await mkdir(stateDir, { recursive: true });
const exists = (p) => stat(p).then(() => true, () => false);
const quiet = () => {};

let n = 0;
/** A sealed segment on `root` that ended `endAgoMs` before NOW and lasted a minute. */
const seg = async (root, cameraId, endAgoMs, extra = {}) => {
  const endMs = NOW - endAgoMs - 1000 * n++;   // distinct starts: (camera, start) is the key
  const s = {
    cameraId, startUtc: new Date(endMs - 60_000).toISOString(), endUtc: new Date(endMs).toISOString(),
    path: `${cameraId}/${endMs - 60_000}.mp4`, bytes: 10, state: "sealed",
    hold: false, pendingUpload: false, bitrateKbps: null, root, ...extra,
  };
  await mkdir(join(root, cameraId), { recursive: true });
  await writeFile(join(root, s.path), "0123456789");
  return s;
};

try {
  await check("the contract: whole days 1..365 or null; anything else refused", () => {
    eq(checkRecordingSettings({ maxDays: null }), { ok: true, settings: { maxDays: null } });
    eq(checkRecordingSettings({ maxDays: 30, version: 1 }), { ok: true, settings: { maxDays: 30 } });
    for (const bad of [0, 366, 1.5, "30", -1, NaN, undefined]) {
      eq(checkRecordingSettings({ maxDays: bad }).ok, false, `maxDays ${String(bad)}`);
    }
    eq(checkRecordingSettings({ maxDays: 5, maxdays: 1 }), { ok: false, reason: "unknown_key", field: "maxdays" });
    eq(checkRecordingSettings([30]).ok, false);
    eq(readRecordingFile(recordingFileText({ maxDays: 7 })), { settings: { maxDays: 7 }, problem: null });
  });

  await check("FEARED: no file, an unreadable, broken or invalid file is no age limit", () => {
    eq(readRecordingFile(null), { settings: { maxDays: null }, problem: null });
    eq(readRecordingFile(undefined).problem, "unreadable");
    eq(readRecordingFile("{maxDays: 1").problem, "not_json");
    eq(readRecordingFile('{"maxDays": 0}'), { settings: { maxDays: null }, problem: "invalid" });
    eq(readRecordingFile('{"maxDays": "1"}').settings.maxDays, null);
    eq(ageCutoffMs({ maxDays: null }, NOW), null);
    eq(ageCutoffMs({ maxDays: 2 }, NaN), null);
    eq(ageCutoffMs({ maxDays: 2 }, NOW), NOW - 2 * DAY);
  });

  await check("FEARED: a limit that deletes footage saves only with confirm exactly true", () => {
    const some = { segments: 3, bytes: 30, oldestUtc: "2026-09-01T00:00:00.000Z" };
    eq(confirmSave({ segments: 0, bytes: 0, oldestUtc: null }, undefined), { save: true });
    eq(confirmSave(some, true), { save: true });
    for (const c of [undefined, false, "true", 1, "yes"]) eq(confirmSave(some, c).save, false, `confirm ${String(c)}`);
  });

  await check("only the installer's storage permission reaches the routes and page", () => {
    const installer = { kind: "user", username: "tech", role: "installer" };
    const owner = { kind: "user", username: "own", role: "store" };
    for (const [m, p] of [["GET", "/recording-settings"], ["POST", "/recording-settings"], ["GET", "/ui/recording-client.js"]]) {
      eq(decideRoute(installer, m, p).kind, "allow", `${m} ${p} installer`);
      eq(decideRoute(owner, m, p).kind === "allow", false, `${m} ${p} store account`);
    }
    for (const p of ["/", "/review"]) {
      eq(decideRoute(owner, "GET", p).kind, "allow", `the store account is a real one: ${p}`);
    }
    eq(decideRoute(installer, "GET", "/recording-page").kind, "allow");
  });

  // ---- the age pass on real files ----
  const index = openIndex(join(stateDir, "index.db"));
  const old0 = await seg(d0, "cam-1", 10 * DAY);
  const old1 = await seg(d1, "cam-2", 9 * DAY);
  const straddles = await seg(d0, "cam-1", 3 * DAY - 30_000);   // ends 30s inside the limit
  const fresh = await seg(d0, "cam-1", 1 * DAY);
  const held = await seg(d0, "cam-1", 20 * DAY, { hold: true });
  const pending = await seg(d1, "cam-2", 20 * DAY, { pendingUpload: true });
  const open = await seg(d1, "cam-2", 20 * DAY, { state: "open" });
  index.putMany([old0, old1, straddles, fresh, held, pending, open]);
  const all = [old0, old1, straddles, fresh, held, pending, open];
  const onDisk = async (s) => exists(join(s.root, s.path));
  const recFile = join(stateDir, "recording.json");
  const pass = () => runAgeEviction(index, [d0, d1], stateDir, { now: () => new Date(NOW), log: quiet });

  await check("FEARED: with no file, or a broken one, the age pass deletes nothing", async () => {
    eq(await pass(), { segments: 0, bytesFreed: 0 });
    await writeFile(recFile, '{"maxDays": 0}');
    const logged = [];
    eq((await runAgeEviction(index, [d0, d1], stateDir, { now: () => new Date(NOW), log: (...a) => logged.push(a) })).segments, 0);
    eq(logged.map((l) => l[2]?.problem), ["invalid"], "and says why");
    await writeFile(recFile, "not json");
    eq((await pass()).segments, 0);
    for (const s of all) eq(await onDisk(s), true, s.path);
    eq(index.count(), 7);
  });

  const auth = { principalOf: () => ({ kind: "user", username: "tech", role: "installer" }), handle: async () => false, audit: (e, _r, f) => audits.push({ e, ...f }) };
  const audits = [];
  const config = { siteId: "bench", storeRoots: [d0, d1], credentials: null, cameras: [{ cameraId: "cam-1", url: "rtsp://10.0.0.5/a" }, { cameraId: "cam-2", url: "rtsp://10.0.0.6/a" }] };
  const server = createApiServer({ stateDir, config, index, auth, now: () => new Date(NOW) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method, body) => {
    const res = await fetch(base + "/recording-settings", {
      method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  try {
    await check("the page reads a broken file as no limit, and is told so", async () => {
      const r = await send("GET");
      eq([r.status, r.json.settings, r.json.problem], [200, { maxDays: null }, "not_json"]);
    });

    await check("FEARED: lowering the limit is refused with what it deletes; nothing written", async () => {
      const r = await send("POST", { maxDays: 3 });
      eq([r.status, r.json.code], [409, "would_delete"]);
      eq(r.json.wouldDelete, { segments: 2, bytes: 20, oldestUtc: old0.startUtc }, "held, pending, open and straddling not counted");
      eq(await readFile(recFile, "utf8"), "not json", "file untouched");
      eq((await send("POST", { maxDays: 3, confirm: "true" })).json.code, "bad_confirm");
      eq((await send("POST", { maxDays: 3.5, confirm: true })).json.code, "bad_max_days");
      eq(audits.length, 0);
    });

    await check("a limit that deletes nothing saves without confirming", async () => {
      const r = await send("POST", { maxDays: 30 });
      eq([r.status, r.json.settings], [200, { maxDays: 30 }]);
      eq(readRecordingFile(await readFile(recFile, "utf8")), { settings: { maxDays: 30 }, problem: null });
      eq((await pass()).segments, 0, "30 days deletes nothing here");
    });

    await check("FEARED: confirmed, the next pass deletes exactly what was shown, on each drive", async () => {
      const r = await send("POST", { maxDays: 3, confirm: true });
      eq([r.status, r.json.wouldDelete.segments], [200, 2]);
      eq(audits.at(-1), { e: "recording.settings", actor: "tech", fromMaxDays: 30, toMaxDays: 3, confirmedSegments: 2 });
      eq(await pass(), { segments: 2, bytesFreed: 20 }, "no restart: the pass reads the file");
      eq([await onDisk(old0), await onDisk(old1)], [false, false]);
      for (const s of [straddles, fresh, held, pending, open]) eq(await onDisk(s), true, `kept ${s.path}`);
      eq(index.count(), 5);
      eq((await pass()).segments, 0, "a second pass has nothing left");
    });

    await check("the page and its script are served, and the script never writes HTML", async () => {
      const page = await fetch(base + "/recording-page");
      const html = await page.text();
      eq([page.status, html.includes('src="/ui/recording-client.js"'), html.includes('id="confirmDeleteYes"')], [200, true, true]);
      const script = await fetch(base + "/ui/recording-client.js");
      const js = await script.text();
      eq([script.status, /javascript/.test(script.headers.get("content-type") ?? "")], [200, true]);
      eq(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), false, "textContent only");
      eq(js.includes("confirm: true"), true);
    });

    await check("no limit again saves without confirming and stops age deletion", async () => {
      eq((await send("POST", { maxDays: null })).status, 200);
      eq((await (await import("node:fs/promises")).readFile(recFile, "utf8")).includes('"maxDays": null'), true);
      eq((await runAgeEviction(index, [d0, d1], stateDir, { now: () => new Date(NOW + 400 * DAY), log: quiet })).segments, 0);
    });
  } finally {
    await new Promise((r) => server.close(r));
    index.close();
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

report("recording settings");
