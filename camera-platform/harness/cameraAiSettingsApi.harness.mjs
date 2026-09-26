/**
 * GET /camera-ai-settings and POST /camera-ai-settings/<cameraId>, end to end
 * through the real server (agent/api-server.mjs -> agent/camera-ai-settings.mjs
 * -> dist/cameraAiSettings.js). CAMERA-AI-SETTINGS-SPEC.md's own "Tests that
 * matter" for the API: store and display are refused (camera.manage, the
 * same reach as /camera-settings); an invalid body is a 400 listing EVERY
 * problem, not the first; every save writes an audit line with the changed
 * FIELDS, never a value; and no camera credential, URL or rtsp:// ever
 * reaches camera-ai.json, a JSON response or the audit.
 *
 * THE FEARED FAILURES, by name:
 * - a camera's own address (this harness gives cam-1 a real rtsp://user:pass@
 *   URL, same as the site's config) leaking into camera-ai.json, the GET/POST
 *   JSON, or an audit line;
 * - the first bad field in a request hiding every other one from the caller;
 * - a save below the site's storing floor going through anyway;
 * - a display or store account reaching either route at all.
 */
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { indexPathFor } from "../agent/config.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("camera AI settings API");

const CAM_PW = "cam-ai-s3cret";
const audits = [];
const authAs = (principal) => ({
  principalOf: () => principal,
  handle: async () => false,
  audit: (event, _req, fields) => audits.push({ event, ...fields }),
});
const installer = authAs({ kind: "user", username: "tech", role: "installer" });

const stateDir = await mkdtemp(join(tmpdir(), "camplat-aiset-"));
const config = {
  siteId: "bench",
  storeRoots: [join(stateDir, "disk0")],
  credentials: { username: "svc", password: "svc-pw" },
  cameras: [
    { cameraId: "cam-1", url: `rtsp://admin:${CAM_PW}@10.0.0.5:554/main` },
    { cameraId: "cam-2", host: "10.0.0.6", vendor: "hikvision" },
  ],
};
await writeFile(join(stateDir, "config.json"), JSON.stringify(config));
await writeFile(join(stateDir, "detect.json"), JSON.stringify({ capacityFps: 10, minConfidence: 0.4, cameras: [{ cameraId: "cam-1" }, { cameraId: "cam-2" }] }));

const index = openIndex(indexPathFor(stateDir));
let server = createApiServer({ stateDir, config, index, auth: installer });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let base = `http://127.0.0.1:${server.address().port}`;

const send = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, text, json };
};
const noSecrets = (text, what) => {
  if (text.includes(CAM_PW) || /rtsp:\/\//i.test(text)) throw new Error(`${what} carries a camera credential or address: ${text}`);
};
const aiFile = join(stateDir, "camera-ai.json");
const exists = (p) => stat(p).then(() => true, () => false);
const GOOD_ZONE = { id: "z1", mode: "watch", points: [[0, 0], [1, 0], [1, 1]] };

try {
  await check("GET /camera-ai-settings: every configured camera at its defaults, the storing floor and the NVR's time zone - no credential anywhere", async () => {
    const r = await send("GET", "/camera-ai-settings");
    eq(r.status, 200);
    noSecrets(r.text, "GET /camera-ai-settings");
    eq(r.json.ok, true);
    eq(r.json.storingFloor, 0.4, "detect.json's own floor");
    eq(typeof r.json.timeZone, "string", "the NVR's own zone");
    eq(r.json.cameras["cam-1"], { zones: [], schedule: null, minConfidence: null, kinds: { person: true, vehicle: true } }, "cam-1: never configured, exactly the pre-feature defaults");
    eq(r.json.cameras["cam-2"], { zones: [], schedule: null, minConfidence: null, kinds: { person: true, vehicle: true } }, "cam-2: same");
  });

  await check("POST /camera-ai-settings/<cameraId>: saves, GET reflects it at once, and the file has no credential", async () => {
    const body = { zones: [GOOD_ZONE], schedule: null, minConfidence: 0.5, kinds: { person: true, vehicle: false } };
    const r = await send("POST", "/camera-ai-settings/cam-1", body);
    eq(r.status, 200);
    eq(r.json.settings, body);
    const view = await send("GET", "/camera-ai-settings");
    eq(view.json.cameras["cam-1"], body, "the save is visible on the next GET");
    eq(view.json.cameras["cam-2"], { zones: [], schedule: null, minConfidence: null, kinds: { person: true, vehicle: true } }, "cam-2 untouched");
    const text = await readFile(aiFile, "utf8");
    noSecrets(text, "camera-ai.json");
    const stored = JSON.parse(text);
    eq(stored.version, 1);
    eq(typeof stored.cameras["cam-1"].updatedUtc, "string");
    eq(stored.cameras["cam-1"].updatedBy, "tech");
  });

  await check("a minConfidence below the site's storing floor is refused, never saved", async () => {
    const r = await send("POST", "/camera-ai-settings/cam-2", { minConfidence: 0.3 }); // floor is 0.4
    eq(r.status, 400);
    eq(r.json.errors.some((e) => e.field === "minConfidence" && e.reason === "below_storing_floor"), true);
    const view = await send("GET", "/camera-ai-settings");
    eq(view.json.cameras["cam-2"].minConfidence, null, "unsaved: still the default");
  });

  await check("FEARED: an invalid body is a 400 listing EVERY problem, not just the first", async () => {
    const r = await send("POST", "/camera-ai-settings/cam-1", {
      zones: [{ id: "", mode: "sideways", points: [[0, 0], [2, 0]] }],
      schedule: { timeZone: "Not/AZone", weekly: [], closedDates: [] },
      minConfidence: 5,
      kinds: { person: "yes" },
    });
    eq(r.status, 400);
    const fields = r.json.errors.map((e) => e.field).sort();
    eq(fields.includes("zones[0].id"), true, "zone id");
    eq(fields.includes("zones[0].mode"), true, "zone mode");
    eq(fields.includes("zones[0].points"), true, "too few points (2, needs 3)");
    eq(fields.includes("schedule"), true, "schedule");
    eq(fields.includes("minConfidence"), true, "minConfidence out of range");
    eq(fields.includes("kinds.person"), true, "kinds.person not a boolean");
    eq(r.json.errors.length >= 6, true, "every problem, in one answer - not fix-and-resave one at a time");
  });

  await check("an unknown camera id is 404, and nothing is written", async () => {
    const before = await exists(aiFile);
    const r = await send("POST", "/camera-ai-settings/nope", { minConfidence: null });
    eq(r.status, 404);
    eq(r.json.code, "no_such_camera");
    eq(await exists(aiFile), before, "the file is untouched either way");
  });

  await check("bodies that are not JSON objects are refused the same way every other settings route refuses them", async () => {
    const res = await fetch(base + "/camera-ai-settings/cam-1", { method: "POST", body: "{}" });
    eq(res.status, 415);
    eq((await send("POST", "/camera-ai-settings/cam-1", [1])).status, 400);
  });

  await check("FEARED: every save writes an audit line naming who, which camera, and which FIELDS changed - never a value, never a credential", async () => {
    noSecrets(JSON.stringify(audits), "audit log");
    const savedAudits = audits.filter((a) => a.event === "camera.ai-settings");
    eq(savedAudits.length, 1, "only the one successful save above (cam-1) - the below-floor and invalid attempts on cam-2/cam-1 wrote nothing");
    eq(savedAudits[0].actor, "tech");
    eq(savedAudits[0].cameraId, "cam-1");
    eq(new Set(savedAudits[0].fields), new Set(["zones", "minConfidence", "kinds"]), "exactly the fields that changed from the defaults - never schedule, which stayed null");
  });

  await server.close();

  await check("FEARED: a store account and a display credential are BOTH refused (camera.manage, never events.view or live.view)", async () => {
    for (const principal of [{ kind: "user", username: "clerk", role: "store" }, { kind: "display", displayId: "wall-1" }]) {
      const s = createApiServer({ stateDir, config, index, auth: authAs(principal) });
      await new Promise((r) => s.listen(0, "127.0.0.1", r));
      const b = `http://127.0.0.1:${s.address().port}`;
      try {
        const get = await fetch(`${b}/camera-ai-settings`);
        eq(get.status, 403, `${principal.role ?? principal.kind}: GET refused`);
        const post = await fetch(`${b}/camera-ai-settings/cam-1`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
        });
        eq(post.status, 403, `${principal.role ?? principal.kind}: POST refused`);
      } finally {
        await new Promise((r) => s.close(r));
      }
    }
  });

  server = createApiServer({ stateDir, config, index, auth: installer });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  await check("a bad detect.json (the storing floor unreadable) is reported, not guessed at, on GET and refuses a POST", async () => {
    await writeFile(join(stateDir, "detect.json"), "not json");
    const get = await send("GET", "/camera-ai-settings");
    eq(get.status, 200);
    eq(get.json.storingFloor, null);
    eq(typeof get.json.problem, "string");
    const post = await send("POST", "/camera-ai-settings/cam-1", { minConfidence: 0.5 });
    eq(post.status, 409, "cannot check a camera's floor against a floor that cannot be read");
    // restore, so this file leaves the state dir usable for anything after it
    await writeFile(join(stateDir, "detect.json"), JSON.stringify({ capacityFps: 10, minConfidence: 0.4, cameras: [] }));
  });

  await check("FEARED: a corrupt camera-ai.json (not this route's own writing - a disk glitch or a bad hand edit) refuses the next save instead of silently wiping every OTHER camera's settings", async () => {
    // cam-1 already carries real, saved settings from an earlier check in
    // this file (zones, minConfidence, kinds) - this is exactly the row that
    // must not be allowed to vanish.
    const before = await readFile(aiFile, "utf8");
    eq(JSON.parse(before).cameras["cam-1"].kinds.vehicle, false, "cam-1's real settings are on disk before the corruption");

    await writeFile(aiFile, "{ not valid json", "utf8");
    const r = await send("POST", "/camera-ai-settings/cam-2", { minConfidence: 0.5 });
    eq(r.status, 409, "refused rather than rebuilt from empty");
    eq(r.json.code, "ai_settings_unreadable");

    const onDisk = await readFile(aiFile, "utf8");
    eq(onDisk, "{ not valid json", "the file itself was never overwritten by the refused save");

    // restore a valid file so later checks in this run see a sane state, and
    // confirm the restored cam-1 settings are exactly what they were.
    await writeFile(aiFile, before, "utf8");
    const restored = await send("GET", "/camera-ai-settings");
    eq(restored.json.cameras["cam-1"].kinds, { person: true, vehicle: false }, "cam-1's settings, once the file is fixed by hand, are exactly as they were - nothing was lost");
  });
} finally {
  await new Promise((r) => server.close(r));
  index.close();
  await rm(stateDir, { recursive: true, force: true });
}

report("camera AI settings API");
