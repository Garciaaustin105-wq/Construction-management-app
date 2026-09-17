/**
 * The Cameras page's routes: list, add, edit and remove cameras, and set the
 * camera login. Installer only (camera.manage, in routeAccess). The rules are
 * contracts/cameraEdit.ts; this file reads the request, writes cameras.json
 * and keeps the running API's config in step.
 *
 * The recorder picks the change up on its own: it watches cameras.json and
 * restarts onto the new list (recorder-service.mjs).
 *
 * Nothing here sends a camera password back out. GET shows the login as
 * { username, passwordSet }; an address from config.json that still carries a
 * password is shown redacted and flagged, and cannot be saved until it is
 * re-entered without one.
 */
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { CAMERAS_FILE } from './recorder-service.mjs';
import {
  addCamera, updateCamera, removeCamera, checkLogin, loginView, changedFields,
  cameraFileText, fromConfigCamera, cameraProblems,
} from '../dist/cameraEdit.js';
import { redactRtspUrl } from '../dist/rtsp.js';

const MAX_BODY_BYTES = 16 * 1024;
const VIEW_KEYS = ['cameraId', 'name', 'host', 'url', 'vendor', 'channel', 'stream', 'bitrateKbps'];
const STATUS = { no_such_camera: 404, last_camera: 409, camera_needs_fixing: 409, too_many_cameras: 409 };
const MESSAGES = {
  not_an_object: 'send the camera as a JSON object',
  bad_camera_id: 'the camera id is lowercase letters, digits and dashes, up to 40, starting with a letter or digit',
  camera_id_taken: 'another camera already uses that id',
  bad_name: 'the name is up to 60 characters',
  need_host_or_url: 'enter the camera\'s IP address, or its full stream address',
  both_host_and_url: 'enter an IP address or a stream address, not both',
  bad_url: 'the stream address must start with rtsp://',
  url_has_login: 'leave the user and password out of the address; set them under Camera login',
  bad_host: 'that is not an IP address or host name',
  bad_vendor: 'choose the camera brand',
  generic_needs_url: 'for another brand, enter the full stream address instead of the IP',
  bad_channel: 'the channel is a whole number from 1 to 256',
  bad_stream: 'choose the main or sub stream',
  bad_bitrate: 'the bitrate is a whole number of kbps from 64 to 20000, or blank',
  duplicate_stream: 'another camera already records that stream',
  too_many_cameras: 'this recorder takes at most 64 cameras',
  no_such_camera: 'there is no camera with that id',
  id_cannot_change: 'a camera\'s id cannot change; remove it and add a new one',
  last_camera: 'the recorder needs at least one camera',
  bad_username: 'the camera user name is 1 to 64 characters, without a colon',
  bad_password: 'the camera password is 1 to 128 characters',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, message, extra = {}) => sendJson(res, status, { ok: false, code, message, ...extra });
const refuseEdit = (res, r) => refuse(res, STATUS[r.reason] ?? 400, r.reason, MESSAGES[r.reason] ?? r.reason, { field: r.field });

/** A JSON object body, or a refusal already sent (null). */
export async function readJsonBody(req, res) {
  if (!/^application\/json(;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
    refuse(res, 415, 'json_required', 'send application/json');
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      refuse(res, 413, 'body_too_large', 'request body too large');
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    refuse(res, 400, 'bad_json', 'the request body must be a JSON object');
    return null;
  }
  return body;
}

/** One camera as the page sees it: managed keys only, no password anywhere. */
function cameraForPage(camera, problem) {
  const out = {};
  for (const k of VIEW_KEYS) if (camera[k] !== undefined) out[k] = camera[k];
  if (typeof out.url === 'string') out.url = redactRtspUrl(out.url);
  out.problem = problem;
  return out;
}

/**
 * `config` is the API's live config object; it is updated in place after each
 * write so /cameras, live view and exports see the new list at once.
 * `onChange()` runs after that (the API recomputes its drive assignment).
 */
export function createCameraSettings({ stateDir, config, audit, onChange = () => {}, log = () => {} }) {
  const file = join(stateDir, CAMERAS_FILE);
  // Only a login set on this page is written to cameras.json; until then the
  // recorder keeps config.json's credentials.
  let pageLogin = config.camerasLogin ?? null;

  const current = () => config.cameras.map(fromConfigCamera);

  let writing = Promise.resolve();
  /** Serialised: each edit reads the list the previous one wrote. */
  function serialise(fn) {
    const run = writing.then(fn, fn);
    writing = run.catch(() => {});
    return run;
  }

  async function persist(cameras, login) {
    const tmp = file + '.tmp';
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(cameraFileText(cameras, login));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
    config.cameras = cameras;
    config.camerasSource = CAMERAS_FILE;
    config.camerasFileProblem = null;
    if (login !== null) config.credentials = login;
    pageLogin = login;
    config.camerasLogin = login;
    onChange();
  }

  /** Refuses (and returns false) when any camera in the list cannot be saved. */
  function refuseIfUnsaveable(res, cameras) {
    const problems = cameraProblems(cameras);
    const at = problems.findIndex((p) => p !== null);
    if (at < 0) return false;
    refuse(res, 409, 'camera_needs_fixing',
      `camera ${cameras[at].cameraId} must be fixed first: ${MESSAGES[problems[at]] ?? problems[at]}`,
      { cameraId: cameras[at].cameraId, reason: problems[at] });
    return true;
  }

  const actorOf = (principal) => principal.username ?? null;

  async function handle(req, res, pathname, method, principal) {
    if (method === 'GET' && pathname === '/camera-settings') {
      const cameras = current();
      const problems = cameraProblems(cameras);
      const login = pageLogin ?? (config.credentials?.username ? config.credentials : null);
      sendJson(res, 200, {
        ok: true,
        cameras: cameras.map((c, i) => cameraForPage(c, problems[i])),
        login: loginView(login),
        source: config.camerasSource ?? 'config.json',
        fileProblem: config.camerasFileProblem ?? null,
      });
      return true;
    }

    if (method === 'POST' && pathname === '/cameras') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      await serialise(async () => {
        const before = current();
        const r = addCamera(before, body);
        if (!r.ok) return refuseEdit(res, r);
        if (refuseIfUnsaveable(res, r.cameras)) return;
        await persist(r.cameras, pageLogin);
        const added = r.cameras[r.cameras.length - 1];
        audit('camera.add', req, { actor: actorOf(principal), cameraId: added.cameraId });
        log('info', 'camera added', { cameraId: added.cameraId });
        sendJson(res, 201, { ok: true, camera: cameraForPage(added, null) });
      });
      return true;
    }

    const match = /^\/cameras\/([^/]+)$/.exec(pathname);
    if (match && (method === 'POST' || method === 'DELETE')) {
      let cameraId;
      try { cameraId = decodeURIComponent(match[1]); } catch { cameraId = ''; }
      const body = method === 'POST' ? await readJsonBody(req, res) : {};
      if (body === null) return true;
      await serialise(async () => {
        const before = current();
        const r = method === 'POST' ? updateCamera(before, cameraId, body) : removeCamera(before, cameraId);
        if (!r.ok) return refuseEdit(res, r);
        if (refuseIfUnsaveable(res, r.cameras)) return;
        await persist(r.cameras, pageLogin);
        if (method === 'POST') {
          const old = before.find((c) => c.cameraId === cameraId);
          const now = r.cameras.find((c) => c.cameraId === cameraId);
          audit('camera.update', req, { actor: actorOf(principal), cameraId, fields: changedFields(old, now) });
          sendJson(res, 200, { ok: true, camera: cameraForPage(now, null) });
        } else {
          audit('camera.remove', req, { actor: actorOf(principal), cameraId });
          sendJson(res, 200, { ok: true });
        }
        log('info', method === 'POST' ? 'camera updated' : 'camera removed', { cameraId });
      });
      return true;
    }

    if (method === 'POST' && pathname === '/camera-login') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      await serialise(async () => {
        const r = checkLogin(body);
        if (!r.ok) return refuseEdit(res, r);
        const cameras = current();
        if (refuseIfUnsaveable(res, cameras)) return;
        const old = pageLogin ?? config.credentials ?? null;
        await persist(cameras, r.login);
        // Whether each part changed, never the values.
        audit('camera.login', req, {
          actor: actorOf(principal),
          usernameChanged: old?.username !== r.login.username,
          passwordChanged: old?.password !== r.login.password,
        });
        log('info', 'camera login changed', {});
        sendJson(res, 200, { ok: true, login: loginView(r.login) });
      });
      return true;
    }

    return false;
  }

  return { handle };
}
