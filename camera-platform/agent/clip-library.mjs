/**
 * "Save as test clip" (AI-PLAN D0): the Review page's routes that turn a range
 * of recorded footage into an answer-key entry. The footage is hard-linked
 * into CLIP_DIR so recorder eviction cannot delete it; on the same drive a
 * hard link costs no space until the recorder deletes its own copy. A library
 * file that cannot be read is never overwritten.
 */
import { readFile, open, rename, mkdir, rm, link as fsLink, copyFile as fsCopyFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { readJsonBody } from './camera-settings.mjs';
import { checkLibrary, SCENE_TAGS } from '../dist/clipLibrary.js';
import { isCameraId } from '../dist/apiQuery.js';

export const CLIP_DIR = '.camplat-clips';
export const LIBRARY_FILE = 'clip-library.json';

const MESSAGES = {
  library_unreadable: 'the clip library file could not be read and will not be overwritten; fix or remove it first',
  bad_clip: 'this clip cannot be saved',
  footage_gap: 'part of this range was not recorded; a test clip needs all of it',
  footage_copy_failed: 'the recorded footage could not be kept, so nothing was saved',
  library_write_failed: 'the clip library could not be written, so nothing was saved',
  bad_camera_id: 'cameraId is not a camera id',
  bad_count: 'people and vehicles are whole numbers from 0 to 20',
  bad_scenes: 'scenes is a list of scene names',
  bad_note: 'note is text of at most 500 characters',
};

const isCount = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 20;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, extra = {}) =>
  sendJson(res, status, { ok: false, code, message: MESSAGES[code] ?? code, ...extra });

export function clipIdFor(cameraId, startUtc) {
  const camera = String(cameraId).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '') || 'cam';
  const when = new Date(startUtc);
  const stamp = Number.isFinite(when.getTime())
    ? when.toISOString().toLowerCase().replace(/[^a-z0-9]/g, '')
    : 'notatime';
  const keep = Math.max(1, 63 - stamp.length);
  const name = camera.length > keep ? camera.slice(0, keep) : camera;
  return `${name}-${stamp}`;
}

export function createClipLibrary({ stateDir, prepare, rootFor, audit, log = () => {}, link = fsLink, copyFile = fsCopyFile }) {
  const file = join(stateDir, LIBRARY_FILE);

  async function load() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { library: { version: 1, clips: [] }, problem: null };
      return {
        library: { version: 1, clips: [] },
        problem: `the clip library file could not be read (${err.code ?? 'unknown error'})`,
      };
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return { library: { version: 1, clips: [] }, problem: 'the clip library file is not valid JSON' };
    }
    const checked = checkLibrary(raw);
    if (!checked.ok) {
      return {
        library: { version: 1, clips: [] },
        problem: `the clip library file is not a valid library: ${checked.errors.join('; ')}`,
      };
    }
    return { library: checked.library, problem: null };
  }

  async function removeDirs(dirs) {
    for (const dir of dirs) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // clearing kept footage is best effort
      }
    }
  }

  async function save(res, req, clip, principal) {
    const loaded = await load();
    if (loaded.problem) {
      // a library we cannot read is never overwritten
      refuse(res, 409, 'library_unreadable', { problem: loaded.problem });
      return;
    }
    const checked = checkLibrary({ version: 1, clips: [...loaded.library.clips, clip] });
    if (!checked.ok) {
      refuse(res, 400, 'bad_clip', { errors: checked.errors });
      return;
    }
    const prep = prepare(clip.cameraId, clip.startUtc, clip.endUtc);
    if (!prep.ok) {
      sendJson(res, prep.status, { ok: false, code: prep.code, message: prep.message });
      return;
    }
    if (prep.plan.gapSeconds > 0) {
      refuse(res, 409, 'footage_gap');
      return;
    }
    const made = [];
    let fileCount = 0;
    let bytes = 0;
    try {
      for (const f of prep.plan.files) {
        const root = rootFor(f, clip.cameraId);
        const dir = join(root, CLIP_DIR, clip.id);
        if (!made.includes(dir)) made.push(dir);
        await mkdir(dir, { recursive: true });
        const dest = join(dir, basename(f.path));
        try {
          await link(join(root, f.path), dest);
        } catch {
          // a link across drives cannot work; keep a real copy instead
          await copyFile(join(root, f.path), dest);
        }
        fileCount += 1;
        bytes += f.bytes;
      }
    } catch (err) {
      await removeDirs(made);
      log('warn', 'test clip footage could not be kept', { clipId: clip.id, error: err.code ?? 'unknown' });
      refuse(res, 500, 'footage_copy_failed');
      return;
    }
    const tmp = file + '.tmp';
    try {
      const fh = await open(tmp, 'w', 0o644);
      try {
        await fh.writeFile(JSON.stringify(checked.library, null, 2) + '\n');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, file);
    } catch {
      await removeDirs(made);
      refuse(res, 500, 'library_write_failed');
      return;
    }
    audit('cliplibrary.add', req, {
      actor: principal?.username ?? null,
      clipId: clip.id,
      cameraId: clip.cameraId,
      startUtc: clip.startUtc,
      endUtc: clip.endUtc,
      fileCount,
    });
    log('info', 'test clip saved', { clipId: clip.id });
    sendJson(res, 200, { ok: true, clip, fileCount, bytes });
  }

  let writing = Promise.resolve();
  const serialise = (fn) => {
    const run = writing.then(fn, fn);
    writing = run.catch(() => {});
    return run;
  };

  async function handle(req, res, pathname, method, principal) {
    if (pathname !== '/clip-library') return false;
    if (method === 'GET') {
      const loaded = await load();
      sendJson(res, 200, { ok: true, library: loaded.library, problem: loaded.problem });
      return true;
    }
    if (method !== 'POST') return false;
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (!isCameraId(body.cameraId)) {
      refuse(res, 400, 'bad_camera_id');
      return true;
    }
    if (!isCount(body.people) || !isCount(body.vehicles)) {
      refuse(res, 400, 'bad_count');
      return true;
    }
    if (!Array.isArray(body.scenes) || !body.scenes.every((s) => typeof s === 'string')) {
      refuse(res, 400, 'bad_scenes');
      return true;
    }
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) {
      refuse(res, 400, 'bad_note');
      return true;
    }
    if (typeof body.startUtc !== 'string' || typeof body.endUtc !== 'string') {
      refuse(res, 400, 'bad_clip', { errors: ['startUtc and endUtc must be times'] });
      return true;
    }
    const expected = [];
    if (body.people > 0) {
      expected.push({ kind: 'person', fromUtc: body.startUtc, toUtc: body.endUtc, count: body.people });
    }
    if (body.vehicles > 0) {
      expected.push({ kind: 'vehicle', fromUtc: body.startUtc, toUtc: body.endUtc, count: body.vehicles });
    }
    const clip = {
      id: clipIdFor(body.cameraId, body.startUtc),
      cameraId: body.cameraId,
      startUtc: body.startUtc,
      endUtc: body.endUtc,
      scenes: body.scenes,
      expected,
    };
    if (body.note !== undefined) clip.note = body.note;
    await serialise(() => save(res, req, clip, principal));
    return true;
  }

  return { handle };
}
