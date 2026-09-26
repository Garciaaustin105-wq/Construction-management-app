/**
 * Per-camera AI settings' routes: GET /camera-ai-settings and
 * POST /camera-ai-settings/<cameraId>. Installer only (camera.manage, in
 * routeAccess). The rules are contracts/cameraAiSettings.ts; this file reads
 * the request, writes camera-ai.json (tmp then rename, same convention as
 * agent/camera-settings.mjs's cameras.json and agent/recording-settings.mjs's
 * recording.json) and writes the audit line with the changed fields.
 *
 * agent/detect-service.mjs owns READING this same file (it re-reads it every
 * 30 s on its own; this file never talks to that running process, the same
 * separation agent/recording-settings.mjs keeps from recorder-service.mjs's
 * own age-eviction pass).
 *
 * Nothing here ever sees a camera credential or address: `config.cameras` is
 * read only for `cameraId`, to answer "no such camera" for one that is not
 * configured - never its `url`/`host`/login.
 */
import { open, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonBody } from './camera-settings.mjs';
import {
  checkCameraAiSettings, checkCameraAiSettingsFile, settingsForCamera, diffCameraAiSettings,
  CAMERA_AI_SETTINGS_VERSION,
} from '../dist/cameraAiSettings.js';

export const CAMERA_AI_SETTINGS_FILE = 'camera-ai.json';

/** detect-service.mjs's own default when detect.json's minConfidence is
 *  absent - read the same tolerant way every other file in this codebase
 *  reads that field (agent/gate-check.mjs, agent/score-clips.mjs): absent
 *  means the default, and anything else that is not a number 0..1 refuses. */
const DEFAULT_MIN_CONFIDENCE = 0.5;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, message, extra = {}) => sendJson(res, status, { ok: false, code, message, ...extra });

function emptyFile() {
  return { version: CAMERA_AI_SETTINGS_VERSION, cameras: {} };
}

/**
 * The site's storing floor (detect.json's own minConfidence), read fresh on
 * every request rather than cached: an installer who just lowered it in the
 * same session must see the new floor immediately, and a camera's own
 * minConfidence can never be saved below whatever the floor is AT SAVE TIME.
 * `{ ok: false, problem }` when detect.json cannot be trusted - the same
 * refusal shape agent/gate-check.mjs and agent/score-clips.mjs already use
 * for this exact field.
 */
async function readStoringFloor(stateDir, readFileFn) {
  let raw;
  try {
    raw = await readFileFn(join(stateDir, 'detect.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, floor: DEFAULT_MIN_CONFIDENCE };
    return { ok: false, problem: `detect.json cannot be read: ${err.message}` };
  }
  let detect;
  try {
    detect = JSON.parse(raw);
  } catch (err) {
    return { ok: false, problem: `detect.json is not valid JSON: ${err.message}` };
  }
  const minConfidence = detect?.minConfidence === undefined ? DEFAULT_MIN_CONFIDENCE : detect.minConfidence;
  if (typeof minConfidence !== 'number' || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    return { ok: false, problem: `detect.json minConfidence must be a number from 0 to 1, got ${JSON.stringify(detect?.minConfidence)}` };
  }
  return { ok: true, floor: minConfidence };
}

/**
 * The stored file, validated against `floor` - never throws. A file that
 * cannot be read or fails validation comes back as the empty defaults, with
 * `problem` saying why (rule 16: say what could not be used, and why); the
 * caller shows every camera at its defaults rather than refuse the whole
 * page over one bad file (build rule 10's sibling: refuse a SAVE that would
 * make things worse, never a READ that only reports what is already there).
 */
async function load(file, readFileFn, floor) {
  let raw;
  try {
    raw = await readFileFn(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file: emptyFile(), problem: null };
    return { file: emptyFile(), problem: `camera-ai.json cannot be read: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { file: emptyFile(), problem: `camera-ai.json is not valid JSON: ${err.message}` };
  }
  const checked = checkCameraAiSettingsFile(parsed, floor);
  if (!checked.ok) {
    const shown = checked.errors.slice(0, 3).map((e) => `${e.cameraId || '(file)'}: ${e.field}: ${e.reason}`).join('; ');
    const more = checked.errors.length > 3 ? `; and ${checked.errors.length - 3} more` : '';
    return { file: emptyFile(), problem: `camera-ai.json failed validation: ${shown}${more}` };
  }
  return { file: checked.file, problem: null };
}

async function persist(file, fileObj) {
  const tmp = `${file}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.writeFile(`${JSON.stringify(fileObj, null, 2)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

export function createCameraAiSettings({ stateDir, config, audit, now = () => new Date(), log = () => {}, readFileFn = readFile }) {
  const file = join(stateDir, CAMERA_AI_SETTINGS_FILE);
  // The NVR's own zone (CAMERA-AI-SETTINGS-SPEC.md: "its timeZone is the
  // NVR's own zone ... until the site time-zone setting exists"), read once:
  // this process does not change zone while it runs.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  let writing = Promise.resolve();
  /** Serialised: each save reads the file the previous save just wrote. */
  function serialise(fn) {
    const run = writing.then(fn, fn);
    writing = run.catch(() => {});
    return run;
  }

  const actorOf = (principal) => principal?.username ?? null;

  async function handle(req, res, pathname, method, principal) {
    if (method === 'GET' && pathname === '/camera-ai-settings') {
      const floorResult = await readStoringFloor(stateDir, readFileFn);
      if (!floorResult.ok) {
        // The floor itself cannot be trusted: every camera's own minConfidence
        // depends on it, so nothing here is guessed at - reported, not hidden.
        sendJson(res, 200, { ok: true, cameras: {}, storingFloor: null, timeZone, problem: floorResult.problem });
        return true;
      }
      const { file: fileObj, problem } = await load(file, readFileFn, floorResult.floor);
      const cameras = {};
      for (const c of config.cameras) {
        cameras[c.cameraId] = settingsForCamera(fileObj, c.cameraId);
      }
      sendJson(res, 200, { ok: true, cameras, storingFloor: floorResult.floor, timeZone, problem });
      return true;
    }

    const match = /^\/camera-ai-settings\/([^/]+)$/.exec(pathname);
    if (match && method === 'POST') {
      let cameraId;
      try { cameraId = decodeURIComponent(match[1]); } catch { cameraId = ''; }
      if (cameraId === '' || !config.cameras.some((c) => c.cameraId === cameraId)) {
        refuse(res, 404, 'no_such_camera', 'there is no camera with that id');
        return true;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const floorResult = await readStoringFloor(stateDir, readFileFn);
      if (!floorResult.ok) {
        refuse(res, 409, 'floor_unknown', `the site's storing floor cannot be read, so a camera's minimum confidence cannot be checked: ${floorResult.problem}`);
        return true;
      }
      const checked = checkCameraAiSettings(body, floorResult.floor);
      if (!checked.ok) {
        // Every problem this body has, in one answer (rule: no fix-and-resave
        // one field at a time).
        refuse(res, 400, 'invalid', 'these settings could not be saved', { errors: checked.errors });
        return true;
      }
      await serialise(async () => {
        const { file: before, problem: beforeProblem } = await load(file, readFileFn, floorResult.floor);
        if (beforeProblem) {
          // The existing file cannot be trusted: saving anyway would rebuild
          // it from `emptyFile()` and silently wipe every OTHER camera's
          // settings under this one save (rule: nothing is deleted by a
          // setting). Refuse, the same way an unreadable storing floor is
          // refused above, and let a human notice and fix the file.
          refuse(res, 409, 'ai_settings_unreadable', `the existing camera-ai.json cannot be trusted, so this save is refused rather than risk erasing other cameras' settings: ${beforeProblem}`);
          return;
        }
        const previous = settingsForCamera(before, cameraId);
        const nowUtc = now().toISOString();
        const actor = actorOf(principal);
        const stored = { ...checked.settings, updatedUtc: nowUtc, updatedBy: actor ?? 'unknown' };
        const nextFile = { version: CAMERA_AI_SETTINGS_VERSION, cameras: { ...before.cameras, [cameraId]: stored } };
        await persist(file, nextFile);
        const changed = diffCameraAiSettings(previous, checked.settings);
        // Never a value, per diffCameraAiSettings' own doc comment - only
        // which of the 4 fields changed (build rule: never a credential,
        // and here, simply never the picture of what changed either).
        audit('camera.ai-settings', req, { actor, cameraId, fields: changed });
        log('info', 'camera AI settings changed', { cameraId, fields: changed });
        sendJson(res, 200, { ok: true, settings: checked.settings });
      });
      return true;
    }

    return false;
  }

  return { handle };
}
