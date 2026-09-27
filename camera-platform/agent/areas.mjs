/**
 * Areas: GET/POST /areas (the installer's own drawing surface, camera.manage)
 * and GET /areas/list (a manager's reduced, READ-ONLY view — names, which
 * camera, and the polygon itself, for the Rules page's own outlined still —
 * rules.manage). DELETE /areas/<id> removes one.
 * MANAGER-RULES-SPEC.md section 1. The rules are contracts/areas.ts; this
 * file reads the request, writes areas.json (tmp then rename, the same
 * convention agent/camera-ai-settings.mjs already keeps for camera-ai.json)
 * and writes the audit line.
 *
 * agent/detect-service.mjs owns READING this same file for occupancy
 * sampling (it re-reads it every `occupancyReloadMs` on its own); this file
 * never talks to that running process, the same separation
 * agent/camera-ai-settings.mjs already keeps from detect-service's reload of
 * camera-ai.json.
 *
 * Nothing here ever sees a camera credential or address: `config.cameras` is
 * read only for `cameraId` (and its own display `name`, never its `url`) —
 * to answer "no such camera" for one that is not configured, and to give a
 * manager's reduced view something to show besides a bare id.
 */
import { open, rename, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJsonBody } from './camera-settings.mjs';
import { checkArea, checkAreasFile, AREAS_VERSION } from '../dist/areas.js';

export const AREAS_FILE = 'areas.json';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, message, extra = {}) => sendJson(res, status, { ok: false, code, message, ...extra });

function emptyFile() {
  return { version: AREAS_VERSION, areas: [] };
}

/**
 * The stored file, validated — never throws. A file that cannot be read, is
 * not JSON, or fails validation comes back as the empty defaults, with
 * `problem` saying why (rule 16): the installer sees no areas rather than a
 * crash, and a save is refused separately below rather than risk rebuilding
 * a broken file from empty (the same split agent/camera-ai-settings.mjs and
 * agent/site-settings.mjs already keep).
 */
async function load(file, readFileFn) {
  let raw;
  try {
    raw = await readFileFn(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file: emptyFile(), problem: null };
    return { file: emptyFile(), problem: `areas.json cannot be read: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { file: emptyFile(), problem: `areas.json is not valid JSON: ${err.message}` };
  }
  const checked = checkAreasFile(parsed);
  if (!checked.ok) {
    const shown = checked.errors.slice(0, 3).map((e) => `${e.index}: ${e.field}: ${e.reason}`).join('; ');
    const more = checked.errors.length > 3 ? `; and ${checked.errors.length - 3} more` : '';
    return { file: emptyFile(), problem: `areas.json failed validation: ${shown}${more}` };
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

export function createAreas({ stateDir, config, audit, log = () => {}, readFileFn = readFile }) {
  const file = join(stateDir, AREAS_FILE);

  let writing = Promise.resolve();
  /** Serialised: each save reads the file the previous save just wrote. */
  function serialise(fn) {
    const run = writing.then(fn, fn);
    writing = run.catch(() => {});
    return run;
  }

  const actorOf = (principal) => principal?.username ?? null;

  /** agent/manager-rules.mjs's own read: "does this area exist on this
   *  camera" — never a second owner of areas.json, just a lookup. */
  async function listAreas() {
    const { file: fileObj } = await load(file, readFileFn);
    return fileObj.areas;
  }

  async function handle(req, res, pathname, method, principal) {
    if (method === 'GET' && pathname === '/areas') {
      const { file: fileObj, problem } = await load(file, readFileFn);
      sendJson(res, 200, { ok: true, areas: fileObj.areas, problem });
      return true;
    }

    // The manager's own reduced view (MANAGER-RULES-SPEC.md section 5):
    // "Managers see area names and a still with the area outlined, but never
    // draw or edit areas" — the boundary the Rules page needs is READ vs
    // WRITE, not points-vs-no-points: this route needs only rules.manage
    // (routeAccess.ts), which carries no way to reach POST/DELETE /areas
    // (camera.manage) at all, so handing back `points` here lets a manager
    // see exactly the outline the spec promises without ever gaining a way
    // to move it. (Earlier revision withheld points entirely; that made the
    // outline the Rules page's own spec section promises impossible to draw
    // — corrected here, not re-derived, once that page's job made the gap
    // concrete.)
    if (method === 'GET' && pathname === '/areas/list') {
      const { file: fileObj, problem } = await load(file, readFileFn);
      const cameraName = new Map(config.cameras.map((c) => [c.cameraId, c.name ?? null]));
      const areas = fileObj.areas.map((a) => ({
        id: a.id, cameraId: a.cameraId, cameraName: cameraName.get(a.cameraId) ?? null, name: a.name, points: a.points,
      }));
      sendJson(res, 200, { ok: true, areas, problem });
      return true;
    }

    if (method === 'POST' && pathname === '/areas') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      if (typeof body.cameraId !== 'string' || !config.cameras.some((c) => c.cameraId === body.cameraId)) {
        refuse(res, 404, 'no_such_camera', 'there is no camera with that id');
        return true;
      }
      await serialise(async () => {
        const { file: before, problem: beforeProblem } = await load(file, readFileFn);
        if (beforeProblem) {
          // The existing file cannot be trusted: saving anyway would rebuild
          // it from `emptyFile()` and silently wipe every OTHER area under
          // this one save (the same refusal agent/camera-ai-settings.mjs
          // keeps for camera-ai.json).
          refuse(res, 409, 'areas_unreadable', `the existing areas.json cannot be trusted, so this save is refused rather than risk erasing other areas: ${beforeProblem}`);
          return;
        }
        // An id the client sent that already exists is an edit (replace that
        // one area in place); anything else — no id, or an id not on file —
        // is a new area, given a fresh server-side id so two installers
        // drawing at once can never collide.
        const existing = typeof body.id === 'string' ? before.areas.find((a) => a.id === body.id) : undefined;
        const id = existing ? existing.id : (typeof body.id === 'string' && body.id !== '' ? body.id : randomUUID());
        const otherAreas = before.areas.filter((a) => a.id !== id);
        const checked = checkArea({ ...body, id }, otherAreas);
        if (!checked.ok) {
          refuse(res, 400, 'invalid', 'this area could not be saved', { errors: checked.errors });
          return;
        }
        const nextAreas = [...otherAreas, checked.area].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const nextFile = { version: AREAS_VERSION, areas: nextAreas };
        await persist(file, nextFile);
        const actor = actorOf(principal);
        audit('areas.save', req, { actor, id: checked.area.id, cameraId: checked.area.cameraId, created: existing === undefined });
        log('info', 'an area was saved', { id: checked.area.id, cameraId: checked.area.cameraId });
        sendJson(res, 200, { ok: true, area: checked.area });
      });
      return true;
    }

    const match = /^\/areas\/([^/]+)$/.exec(pathname);
    if (match && method === 'DELETE') {
      let id;
      try { id = decodeURIComponent(match[1]); } catch { id = ''; }
      await serialise(async () => {
        const { file: before, problem: beforeProblem } = await load(file, readFileFn);
        if (beforeProblem) {
          refuse(res, 409, 'areas_unreadable', `the existing areas.json cannot be trusted, so this delete is refused: ${beforeProblem}`);
          return;
        }
        if (!before.areas.some((a) => a.id === id)) {
          refuse(res, 404, 'no_such_area', 'no such area');
          return;
        }
        const nextAreas = before.areas.filter((a) => a.id !== id);
        await persist(file, { version: AREAS_VERSION, areas: nextAreas });
        const actor = actorOf(principal);
        audit('areas.delete', req, { actor, id });
        log('info', 'an area was deleted', { id });
        sendJson(res, 200, { ok: true });
      });
      return true;
    }

    return false;
  }

  return { handle, listAreas };
}
