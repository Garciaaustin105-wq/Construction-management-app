/** The Cameras page's edits. Feared: a camera password coming back out (in the
 *  login view, the audit field list, or a stream address typed with a login in
 *  it); the last camera removed; the same stream recorded twice; a blank
 *  channel or stream quietly defaulted; an edit dropping a setting the page
 *  does not show; a broken cameras.json half-read. */
import {
  checkCamera, addCamera, updateCamera, removeCamera, checkLogin, loginView,
  changedFields, cameraFileText, parseCameraFile, MAX_CAMERAS, fromConfigCamera, cameraProblems,
} from "../dist/cameraEdit.js";
import { check, eq, report } from "./_assert.mjs";

console.log("cameraEdit");

const SECRET = "Zq7-secret-pw";
const HOST = { cameraId: "front", name: "Front door", host: "192.168.1.64", vendor: "hikvision", channel: 1, stream: "main" };
const URLCAM = { cameraId: "gate", name: "Gate", url: "rtsp://192.168.1.70:554/stream1" };
const reason = (r) => (r.ok ? "ok" : r.reason);

check("a host camera is accepted with keys in a fixed order", () => {
  const r = checkCamera({ stream: "main", channel: 1, vendor: "hikvision", host: " 192.168.1.64 ", name: " Front door ", cameraId: "front" }, []);
  eq(r, { ok: true, camera: HOST });
});

check("a url camera is accepted; bitrate kept when given", () => {
  eq(checkCamera({ ...URLCAM, bitrateKbps: 2048 }, []), { ok: true, camera: { ...URLCAM, bitrateKbps: 2048 } });
});

check("blank name becomes null, not empty", () => {
  eq(checkCamera({ ...HOST, name: "   " }, []).camera.name, null);
});

check("bad ids refused", () => {
  for (const id of ["", "Front", "-a", "a b", "a/b", "../x", "a".repeat(41), 7, null]) {
    eq(reason(checkCamera({ ...HOST, cameraId: id }, [])), "bad_camera_id", JSON.stringify(id));
  }
});

check("taken id refused", () => {
  eq(reason(checkCamera({ ...HOST, host: "192.168.1.99" }, [HOST])), "camera_id_taken");
});

check("FEARED: blank channel or stream is refused, never defaulted", () => {
  const { channel, ...noChannel } = HOST;
  const { stream, ...noStream } = HOST;
  const { vendor, ...noVendor } = HOST;
  eq(reason(checkCamera(noChannel, [])), "bad_channel");
  eq(reason(checkCamera({ ...HOST, channel: "" }, [])), "bad_channel");
  eq(reason(checkCamera({ ...HOST, channel: "1" }, [])), "bad_channel");
  eq(reason(checkCamera({ ...HOST, channel: 0 }, [])), "bad_channel");
  eq(reason(checkCamera({ ...HOST, channel: 257 }, [])), "bad_channel");
  eq(reason(checkCamera({ ...HOST, channel: 1.5 }, [])), "bad_channel");
  eq(reason(checkCamera(noStream, [])), "bad_stream");
  eq(reason(checkCamera({ ...HOST, stream: "third" }, [])), "bad_stream");
  eq(reason(checkCamera(noVendor, [])), "bad_vendor");
  eq(reason(checkCamera({ ...HOST, vendor: "acme" }, [])), "bad_vendor");
  eq(reason(checkCamera({ ...HOST, vendor: "generic" }, [])), "generic_needs_url", "generic by host records nothing");
});

check("host or url, exactly one", () => {
  eq(reason(checkCamera({ cameraId: "x" }, [])), "need_host_or_url");
  eq(reason(checkCamera({ cameraId: "x", host: " ", url: "" }, [])), "need_host_or_url");
  eq(reason(checkCamera({ ...HOST, url: URLCAM.url }, [])), "both_host_and_url");
});

check("bad hosts refused", () => {
  for (const h of ["256.1.1.1", "1.2.3", "01.2.3.4", "a b", "host/path", "user@host", "-bad.local", "1.2.3.4:554"]) {
    eq(reason(checkCamera({ ...HOST, host: h }, [])), "bad_host", h);
  }
  eq(reason(checkCamera({ ...HOST, host: "cam-3.local" }, [])), "ok");
});

check("FEARED: a url carrying a login is refused and the refusal does not echo it", () => {
  for (const u of [
    `rtsp://admin:${SECRET}@192.168.1.70/stream1`,
    `rtsp://admin@192.168.1.70/stream1`,
    `rtsp://192.168.1.70/Streaming/Channels/101?user=admin&password=${SECRET}`,
    `rtsp://192.168.1.70/cam/realmonitor;pwd=${SECRET}`,
  ]) {
    const r = checkCamera({ cameraId: "gate", url: u }, []);
    const why = reason(r);
    if (why !== "url_has_login" && why !== "bad_url") throw new Error(`${u}: got ${why}`);
    if (JSON.stringify(r).includes(SECRET)) throw new Error("refusal echoed the password");
  }
});

check("non-rtsp url refused", () => {
  eq(reason(checkCamera({ cameraId: "gate", url: "http://192.168.1.70/" }, [])), "bad_url");
});

check("bitrate bounds", () => {
  for (const b of [63, 20001, 1.5, "2000"]) eq(reason(checkCamera({ ...HOST, bitrateKbps: b }, [])), "bad_bitrate", String(b));
  eq(checkCamera({ ...HOST, bitrateKbps: null }, []).camera.bitrateKbps, undefined);
});

check("FEARED: the same stream twice is refused (host case, url)", () => {
  eq(reason(checkCamera({ ...HOST, cameraId: "dup" }, [HOST])), "duplicate_stream");
  eq(reason(checkCamera({ ...HOST, cameraId: "dup", host: "CAM.local" }, [{ ...HOST, host: "cam.local" }])), "duplicate_stream");
  eq(reason(checkCamera({ ...URLCAM, cameraId: "dup" }, [URLCAM])), "duplicate_stream");
  eq(reason(checkCamera({ ...HOST, cameraId: "sub", stream: "sub" }, [HOST])), "ok");
  eq(reason(checkCamera({ ...HOST, cameraId: "ch2", channel: 2 }, [HOST])), "ok");
});

check("a stored camera with no stream counts as main for duplicates", () => {
  const { stream, ...legacy } = HOST;
  eq(reason(checkCamera({ ...HOST, cameraId: "dup" }, [legacy])), "duplicate_stream");
});

check("camera limit", () => {
  const many = Array.from({ length: MAX_CAMERAS }, (_, i) => ({ ...HOST, cameraId: `c${i}`, channel: i + 1 }));
  eq(reason(addCamera(many, { ...HOST, cameraId: "one-more", host: "10.0.0.1" })), "too_many_cameras");
});

check("add appends and does not mutate the input", () => {
  const before = [HOST];
  const r = addCamera(before, URLCAM);
  eq(r.cameras.map((c) => c.cameraId), ["front", "gate"]);
  eq(before.length, 1);
});

check("FEARED: update keeps settings the page does not manage", () => {
  const stored = [{ ...HOST, audio: true, detect: { zones: [1] } }, URLCAM];
  const r = updateCamera(stored, "front", { name: "Lobby", host: "192.168.1.64", vendor: "hikvision", channel: 1, stream: "sub" });
  eq(r.ok, true);
  eq(r.cameras[0], { ...HOST, name: "Lobby", stream: "sub", audio: true, detect: { zones: [1] } });
  eq(stored[0].name, "Front door", "input untouched");
});

check("update: switching host to url drops the host fields", () => {
  const r = updateCamera([HOST], "front", { url: "rtsp://192.168.1.64/live" });
  eq(r.cameras[0], { cameraId: "front", name: null, url: "rtsp://192.168.1.64/live" });
});

check("update refusals", () => {
  eq(reason(updateCamera([HOST], "nope", HOST)), "no_such_camera");
  eq(reason(updateCamera([HOST], "front", { ...HOST, cameraId: "renamed" })), "id_cannot_change");
  eq(reason(updateCamera([HOST, URLCAM], "gate", { url: URLCAM.url.replace("stream1", "s2") })), "ok");
  eq(reason(updateCamera([HOST, URLCAM], "gate", { host: HOST.host, vendor: "hikvision", channel: 1, stream: "main" })), "duplicate_stream");
  eq(reason(updateCamera([HOST], "front", HOST)), "ok", "an unchanged save is not its own duplicate");
});

check("FEARED: the last camera cannot be removed", () => {
  eq(reason(removeCamera([HOST], "front")), "last_camera");
  eq(reason(removeCamera([HOST, URLCAM], "nope")), "no_such_camera");
  eq(removeCamera([HOST, URLCAM], "front").cameras, [URLCAM]);
});

check("login checks", () => {
  eq(checkLogin({ username: "admin", password: " " + SECRET }), { ok: true, login: { username: "admin", password: " " + SECRET } });
  eq(reason(checkLogin({ username: "", password: "x" })), "bad_username");
  eq(reason(checkLogin({ username: "a:b", password: "x" })), "bad_username");
  eq(reason(checkLogin({ username: "a\nb", password: "x" })), "bad_username");
  eq(reason(checkLogin({ username: "a".repeat(65), password: "x" })), "bad_username");
  eq(reason(checkLogin({ username: "admin", password: "" })), "bad_password");
  eq(reason(checkLogin({ username: "admin", password: "x\u0000" })), "bad_password");
  eq(reason(checkLogin({ username: "admin", password: "x".repeat(129) })), "bad_password");
  eq(reason(checkLogin({ username: "admin" })), "bad_password");
  eq(reason(checkLogin(null)), "not_an_object");
});

check("FEARED: a login refusal never carries the password", () => {
  const r = checkLogin({ username: "a:b", password: SECRET });
  if (JSON.stringify(r).includes(SECRET)) throw new Error("leaked");
});

check("FEARED: the login view never carries the password or its length", () => {
  const v = loginView({ username: "admin", password: SECRET });
  eq(v, { username: "admin", passwordSet: true });
  eq(loginView(null), { username: null, passwordSet: false });
  eq(loginView({ username: "", password: "" }), { username: null, passwordSet: false });
});

check("FEARED: audit gets field names only", () => {
  const f = changedFields(HOST, { ...HOST, name: SECRET, channel: 2 });
  eq(f, ["name", "channel"]);
  if (JSON.stringify(f).includes(SECRET)) throw new Error("value in audit");
  eq(changedFields(HOST, { ...HOST, audio: true }), []);
});

check("file round-trip keeps cameras, extra keys and login", () => {
  const cams = [{ ...HOST, audio: true }, URLCAM];
  const login = { username: "admin", password: SECRET };
  eq(parseCameraFile(cameraFileText(cams, login)), { ok: true, cameras: cams, login });
  eq(parseCameraFile(cameraFileText(cams, null)), { ok: true, cameras: cams, login: null });
});

check("FEARED: a broken file is refused whole", () => {
  eq(parseCameraFile("{").reason, "not_json");
  eq(parseCameraFile("[]").reason, "bad_version");
  eq(parseCameraFile(JSON.stringify({ version: 2, cameras: [HOST] })).reason, "bad_version");
  eq(parseCameraFile(JSON.stringify({ version: 1, cameras: [] })).reason, "no_cameras");
  eq(parseCameraFile(JSON.stringify({ version: 1 })).reason, "no_cameras");
  eq(parseCameraFile(JSON.stringify({ version: 1, cameras: [HOST, { ...HOST, cameraId: "dup" }] })).reason, "bad_camera");
  eq(parseCameraFile(JSON.stringify({ version: 1, cameras: [HOST, { cameraId: "bad" }] })).reason, "bad_camera");
  eq(parseCameraFile(JSON.stringify({ version: 1, cameras: [HOST], login: { username: "admin", password: "" } })).reason, "bad_login");
  const r = parseCameraFile(JSON.stringify({ version: 1, cameras: [HOST], login: { username: "a:b", password: SECRET } }));
  if (JSON.stringify(r).includes(SECRET)) throw new Error("leaked");
});

check("FEARED: an older config.json host camera saves as the stream it records today", () => {
  const legacy = { cameraId: "cam-2", host: "10.0.0.6", bitrateKbps: 2500, audio: true };
  const c = fromConfigCamera(legacy);
  eq(c, { cameraId: "cam-2", host: "10.0.0.6", bitrateKbps: 2500, audio: true, vendor: "generic", channel: 1, stream: "main" });
  eq(legacy.vendor, undefined, "input untouched");
  eq(fromConfigCamera({ ...HOST, channel: 3, stream: "sub" }), { ...HOST, channel: 3, stream: "sub" });
  eq(fromConfigCamera(URLCAM), URLCAM, "url entries get no host fields");
  eq(cameraProblems([c]), ["generic_needs_url"], "it never recorded; the page says so instead of saving it");
  eq(cameraProblems([fromConfigCamera({ cameraId: "cam-5", host: "10.0.0.8", vendor: "axis" })]), [null]);
});

check("problems name the camera that cannot be saved as is, never its password", () => {
  const list = [HOST, { cameraId: "old", url: `rtsp://admin:${SECRET}@10.0.0.5/live` }, { ...HOST, cameraId: "dup" }];
  const p = cameraProblems(list);
  eq(p, [null, "url_has_login", "duplicate_stream"]);
  if (JSON.stringify(p).includes(SECRET)) throw new Error("leaked");
});

report("cameraEdit");
