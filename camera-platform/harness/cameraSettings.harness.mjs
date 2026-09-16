/**
 * The Cameras page routes on a real server (loopback only), writing a real
 * cameras.json in a temp state dir, then read back by the recorder's own
 * loadConfig.
 *
 * Feared: a camera password in any response, in cameras.json from an address
 * the page was sent, or in the audit log; a save that writes a file the
 * recorder then refuses; an edit the running API does not see; a broken
 * cameras.json leaving the recorder with no cameras.
 */
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer } from "../agent/api-server.mjs";
import { loadConfig } from "../agent/recorder-service.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { indexPathFor } from "../agent/config.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("camera settings");

const OLD_PW = "hunter2-old";
const SVC_PW = "p@ss-svc";
const NEW_PW = "N3w-cam-pw";
const audits = [];
const auth = {
  principalOf: () => ({ kind: "user", username: "tech", role: "installer" }),
  handle: async () => false,
  audit: (event, _req, fields) => audits.push({ event, ...fields }),
};

const stateDir = await mkdtemp(join(tmpdir(), "camplat-camset-"));
const fileConfig = {
  siteId: "bench",
  storeRoots: [join(stateDir, "disk0")],
  credentials: { username: "svc", password: SVC_PW },
  cameras: [
    { cameraId: "cam-1", url: `rtsp://admin:${OLD_PW}@10.0.0.5:8554/live` },
    { cameraId: "cam-2", host: "10.0.0.6", vendor: "hikvision", audio: true },
  ],
};
await writeFile(join(stateDir, "config.json"), JSON.stringify(fileConfig));
const config = await loadConfig(stateDir);
const index = openIndex(indexPathFor(stateDir));
const server = createApiServer({ stateDir, config, index, auth });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const send = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
};
const noSecrets = (text, what) => {
  for (const s of [OLD_PW, SVC_PW, NEW_PW]) if (text.includes(s)) throw new Error(`${what} carries a password`);
};
const camerasFile = join(stateDir, "cameras.json");
const exists = (p) => stat(p).then(() => true, () => false);

try {
  await check("FEARED: the settings view carries no password, and flags the old address", async () => {
    const r = await send("GET", "/camera-settings");
    eq(r.status, 200);
    noSecrets(r.text, "GET /camera-settings");
    eq(r.json.login, { username: "svc", passwordSet: true });
    eq(r.json.source, "config.json");
    eq(r.json.cameras.map((c) => c.problem), ["url_has_login", null]);
    eq(r.json.cameras[1], { cameraId: "cam-2", host: "10.0.0.6", vendor: "hikvision", channel: 1, stream: "main", problem: null },
      "older entry shown as the stream it records; unmanaged keys not shown");
  });

  await check("FEARED: nothing saves while a camera still has a password in its address", async () => {
    const r = await send("POST", "/cameras", { cameraId: "cam-3", host: "10.0.0.7", vendor: "axis", channel: 1, stream: "main" });
    eq([r.status, r.json.code, r.json.cameraId], [409, "camera_needs_fixing", "cam-1"]);
    noSecrets(r.text, "refusal");
    eq(await exists(camerasFile), false, "no file written");
  });

  await check("re-entering the address without a login saves, and the API sees it at once", async () => {
    const r = await send("POST", "/cameras/cam-1", { name: "Lot", url: "rtsp://10.0.0.5:8554/live" });
    eq(r.status, 200);
    const text = await readFile(camerasFile, "utf8");
    noSecrets(text, "cameras.json");
    const saved = JSON.parse(text);
    eq(saved.login, null, "config.json's login is not copied in");
    eq(saved.cameras[1].audio, true, "unmanaged key kept");
    eq(config.cameras[0].name, "Lot");
    const list = await send("GET", "/cameras");
    noSecrets(list.text, "GET /cameras");
    eq(list.json.find((v) => v.cameraId === "cam-1").name, "Lot");
  });

  await check("add, refuse a duplicate, refuse the last removal", async () => {
    eq((await send("POST", "/cameras", { cameraId: "cam-3", host: "10.0.0.7", vendor: "axis", channel: 1, stream: "main" })).status, 201);
    const dup = await send("POST", "/cameras", { cameraId: "cam-4", host: "10.0.0.7", vendor: "axis", channel: 1, stream: "main" });
    eq([dup.status, dup.json.code, dup.json.field], [400, "duplicate_stream", "host"]);
    eq((await send("POST", "/cameras", { cameraId: "cam-5", url: `rtsp://u:${NEW_PW}@10.0.0.9/x` })).json.code, "url_has_login");
    eq((await send("DELETE", "/cameras/cam-3")).status, 200);
    eq((await send("DELETE", "/cameras/cam-2")).status, 200);
    const last = await send("DELETE", "/cameras/cam-1");
    eq([last.status, last.json.code], [409, "last_camera"]);
    eq((await send("DELETE", "/cameras/nope")).status, 404);
    eq(config.cameras.map((c) => c.cameraId), ["cam-1"]);
  });

  await check("bodies that are not JSON objects are refused", async () => {
    const res = await fetch(base + "/cameras", { method: "POST", body: "{}" });
    eq(res.status, 415);
    eq((await send("POST", "/cameras", [1])).status, 400);
  });

  await check("FEARED: setting the camera login never returns or audits the password", async () => {
    eq((await send("POST", "/camera-login", { username: "admin", password: "" })).json.code, "bad_password");
    const r = await send("POST", "/camera-login", { username: "admin", password: NEW_PW });
    eq(r.json, { ok: true, login: { username: "admin", passwordSet: true } });
    const view = await send("GET", "/camera-settings");
    noSecrets(view.text, "GET after login");
    eq(view.json.login, { username: "admin", passwordSet: true });
    noSecrets(JSON.stringify(audits), "audit");
    eq(audits.map((a) => a.event), ["camera.update", "camera.add", "camera.remove", "camera.remove", "camera.login"]);
    eq(audits[0].fields, ["name", "url"], "field names; the old address is not in them");
    eq(audits[4].passwordChanged, true);
  });

  await check("FEARED: the recorder reads back exactly what the page saved", async () => {
    const c = await loadConfig(stateDir);
    eq(c.camerasSource, "cameras.json");
    eq(c.cameras, [{ cameraId: "cam-1", name: "Lot", url: "rtsp://10.0.0.5:8554/live" }]);
    eq(c.credentials, { username: "admin", password: NEW_PW });
    eq(c.camerasFileProblem, null);
  });

  await check("FEARED: a broken cameras.json falls back to config.json and says why", async () => {
    await writeFile(camerasFile, JSON.stringify({ version: 1, cameras: [] }));
    const c = await loadConfig(stateDir);
    eq(c.cameras.map((x) => x.cameraId), ["cam-1", "cam-2"]);
    eq(c.credentials.username, "svc");
    eq([c.camerasSource, c.camerasFileProblem], ["config.json", "no_cameras"]);
  });
} finally {
  await new Promise((r) => server.close(r));
  index.close();
  await rm(stateDir, { recursive: true, force: true });
}

report("camera settings");
