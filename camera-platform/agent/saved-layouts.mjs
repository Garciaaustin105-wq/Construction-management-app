/**
 * Saved wall layouts' routes (SITE-SETTINGS-SPEC.md section 3):
 *   GET/POST /layouts          (layout.edit, own account only)
 *   GET/POST /display-layouts  (account.manage -- the installer's own view of
 *                               every paired display's assignment)
 *   GET      /display-layout   (the display credential, its own layout only)
 *
 * The rules are contracts/savedLayouts.ts; this file reads the request,
 * writes <stateDir>/layouts.json and <stateDir>/display-layouts.json (tmp
 * then rename, the same convention agent/camera-ai-settings.mjs and
 * agent/site-settings.mjs already keep), resolves cells against the live
 * camera list for "camera removed", and writes the audit line.
 *
 * THE FEARED FAILURES, by name:
 * - one account reading or writing another account's layouts -- every read
 *   and write here goes through contracts/savedLayouts.ts's own
 *   `accountLayouts`/`withAccountLayouts`, keyed on `principal.username`,
 *   never on anything the request body names;
 * - a display reading anything other than its OWN assignment -- GET
 *   /display-layout takes no id from the request at all: it is always
 *   `principal.displayId`, so there is no field to tamper with;
 * - a corrupt layouts.json or display-layouts.json being silently rebuilt
 *   from empty on the next save, discarding every account's (or every
 *   display's) real layouts -- refused instead, the same way
 *   agent/camera-ai-settings.mjs and agent/site-settings.mjs already refuse
 *   over their own unreadable files.
 */
import { open, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonBody } from './camera-settings.mjs';
import { validateName } from '../dist/access.js';
import {
  checkAccountLayouts, accountLayouts, withAccountLayouts, emptyLayoutsFile,
  resolveLayoutCells, checkDisplayLayout, emptyDisplayLayoutsFile, displayLayout, withDisplayLayout,
  LAYOUTS_VERSION, DISPLAY_LAYOUTS_VERSION,
} from '../dist/savedLayouts.js';

export const LAYOUTS_FILE = 'layouts.json';
export const DISPLAY_LAYOUTS_FILE = 'display-layouts.json';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, message, extra = {}) => sendJson(res, status, { ok: false, code, message, ...extra });

function summarise(problems) {
  const shown = problems.slice(0, 3).join('; ');
  const more = problems.length > 3 ? `; and ${problems.length - 3} more` : '';
  return `${shown}${more}`;
}

/**
 * layouts.json, validated -- never throws. Every account's own slice is
 * checked with checkAccountLayouts (contracts/savedLayouts.ts never exports a
 * whole-file checker: an account's slice is the unit it validates). A single
 * bad slice is treated as the WHOLE file being untrustworthy, the same
 * file-level granularity agent/camera-ai-settings.mjs's own
 * checkCameraAiSettingsFile already uses for camera-ai.json -- accountLayouts()
 * and withAccountLayouts() below trust their input completely (no validation
 * inside them), so this is the only place that ever stands between a hand-
 * edited file and a scoped read or write.
 */
async function loadLayouts(path, readFileFn) {
  let raw;
  try {
    raw = await readFileFn(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file: emptyLayoutsFile(), problem: null };
    return { file: emptyLayoutsFile(), problem: `layouts.json cannot be read: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { file: emptyLayoutsFile(), problem: `layouts.json is not valid JSON: ${err.message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || parsed.version !== LAYOUTS_VERSION
    || typeof parsed.accounts !== 'object' || parsed.accounts === null || Array.isArray(parsed.accounts)) {
    return { file: emptyLayoutsFile(), problem: 'layouts.json failed validation: not shaped as a layouts file' };
  }
  const accounts = {};
  const problems = [];
  for (const [username, slice] of Object.entries(parsed.accounts)) {
    const checked = checkAccountLayouts(slice);
    if (!checked.ok) {
      problems.push(`${username}: ${checked.errors.slice(0, 2).map((e) => `${e.field}: ${e.reason}`).join(', ')}`);
      continue;
    }
    accounts[username] = checked.account;
  }
  if (problems.length > 0) {
    return { file: emptyLayoutsFile(), problem: `layouts.json failed validation: ${summarise(problems)}` };
  }
  return { file: { version: LAYOUTS_VERSION, accounts }, problem: null };
}

/** display-layouts.json, validated the same way, one display per entry. */
async function loadDisplayLayouts(path, readFileFn) {
  let raw;
  try {
    raw = await readFileFn(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file: emptyDisplayLayoutsFile(), problem: null };
    return { file: emptyDisplayLayoutsFile(), problem: `display-layouts.json cannot be read: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { file: emptyDisplayLayoutsFile(), problem: `display-layouts.json is not valid JSON: ${err.message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || parsed.version !== DISPLAY_LAYOUTS_VERSION
    || typeof parsed.displays !== 'object' || parsed.displays === null || Array.isArray(parsed.displays)) {
    return { file: emptyDisplayLayoutsFile(), problem: 'display-layouts.json failed validation: not shaped as a display-layouts file' };
  }
  const displays = {};
  const problems = [];
  for (const [displayId, entry] of Object.entries(parsed.displays)) {
    const checked = checkDisplayLayout(entry);
    if (!checked.ok) {
      problems.push(`${displayId}: ${checked.errors.slice(0, 2).map((e) => `${e.field}: ${e.reason}`).join(', ')}`);
      continue;
    }
    displays[displayId] = checked.layout;
  }
  if (problems.length > 0) {
    return { file: emptyDisplayLayoutsFile(), problem: `display-layouts.json failed validation: ${summarise(problems)}` };
  }
  return { file: { version: DISPLAY_LAYOUTS_VERSION, displays }, problem: null };
}

async function persist(path, fileObj) {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.writeFile(`${JSON.stringify(fileObj, null, 2)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

export function createSavedLayouts({ stateDir, config, audit, now = () => new Date(), log = () => {} }) {
  const layoutsPath = join(stateDir, LAYOUTS_FILE);
  const displayLayoutsPath = join(stateDir, DISPLAY_LAYOUTS_FILE);

  // Serialised per file: a /layouts save and a /display-layouts save never
  // touch the same file, so they are free to race each other, but two saves
  // to the SAME file must never interleave (the same discipline
  // agent/camera-ai-settings.mjs keeps with one `writing` chain per file).
  let writingLayouts = Promise.resolve();
  function serialiseLayouts(fn) {
    const run = writingLayouts.then(fn, fn);
    writingLayouts = run.catch(() => {});
    return run;
  }
  let writingDisplays = Promise.resolve();
  function serialiseDisplays(fn) {
    const run = writingDisplays.then(fn, fn);
    writingDisplays = run.catch(() => {});
    return run;
  }

  const currentCameraIds = () => config.cameras.map((c) => c.cameraId);
  const viewOf = (l) => ({ name: l.name, layout: l.layout, cells: resolveLayoutCells(l.cells, currentCameraIds()) });

  async function handle(req, res, pathname, method, principal) {
    if (pathname === '/layouts') {
      // routeAccess.ts gates this on layout.edit, which no display carries
      // (contracts/access.ts) -- so principal.username is always a real
      // account name here, never null.
      const username = principal.username;

      if (method === 'GET') {
        const { file, problem } = await loadLayouts(layoutsPath, readFile);
        const account = accountLayouts(file, username);
        sendJson(res, 200, {
          ok: true,
          layouts: account.layouts.map(viewOf),
          defaultName: account.defaultName,
          problem,
        });
        return true;
      }

      if (method === 'POST') {
        const body = await readJsonBody(req, res);
        if (body === null) return true;
        const checked = checkAccountLayouts(body);
        if (!checked.ok) {
          refuse(res, 400, 'invalid', 'these layouts could not be saved', { errors: checked.errors });
          return true;
        }
        await serialiseLayouts(async () => {
          const { file: before, problem } = await loadLayouts(layoutsPath, readFile);
          if (problem) {
            // Refuse rather than rewrite the whole file from this one
            // account's slice, which would erase every OTHER account's saved
            // layouts under a save that never meant to touch them.
            refuse(res, 409, 'layouts_unreadable', `the existing layouts.json cannot be trusted, so this save is refused rather than risk erasing other accounts' layouts: ${problem}`);
            return;
          }
          const nextFile = withAccountLayouts(before, username, checked.account);
          await persist(layoutsPath, nextFile);
          audit('layouts.save', req, { actor: username, layoutCount: checked.account.layouts.length, defaultName: checked.account.defaultName });
          log('info', 'saved layouts changed', { actor: username, layoutCount: checked.account.layouts.length });
          sendJson(res, 200, { ok: true, layouts: checked.account.layouts.map(viewOf), defaultName: checked.account.defaultName });
        });
        return true;
      }
      return false;
    }

    if (pathname === '/display-layouts') {
      const actor = principal.username ?? principal.displayId ?? 'unknown';

      if (method === 'GET') {
        // The installer's own admin view of every assignment: raw cells
        // (camera id or null), not resolved against the live camera list --
        // this is config, not a wall on screen. Resolution
        // (SITE-SETTINGS-SPEC.md's "camera removed" cell) is for the display
        // itself (GET /display-layout below) and for GET /layouts, per the
        // handoff's own note on resolveLayoutCells' call sites.
        const { file, problem } = await loadDisplayLayouts(displayLayoutsPath, readFile);
        sendJson(res, 200, { ok: true, displays: file.displays, problem });
        return true;
      }

      if (method === 'POST') {
        const body = await readJsonBody(req, res);
        if (body === null) return true;
        const name = validateName(body?.displayId);
        if (name.kind !== 'ok') {
          refuse(res, 400, 'bad_display_id', name.reason);
          return true;
        }
        const checked = checkDisplayLayout(body);
        if (!checked.ok) {
          refuse(res, 400, 'invalid', 'this display layout could not be saved', { errors: checked.errors });
          return true;
        }
        await serialiseDisplays(async () => {
          const { file: before, problem } = await loadDisplayLayouts(displayLayoutsPath, readFile);
          if (problem) {
            refuse(res, 409, 'display_layouts_unreadable', `the existing display-layouts.json cannot be trusted, so this save is refused rather than risk erasing other displays' layouts: ${problem}`);
            return;
          }
          const nextFile = withDisplayLayout(before, name.name, checked.layout);
          await persist(displayLayoutsPath, nextFile);
          audit('display-layouts.save', req, { actor, displayId: name.name });
          log('info', 'display layout assigned', { actor, displayId: name.name });
          sendJson(res, 200, { ok: true, displayId: name.name, layout: checked.layout });
        });
        return true;
      }
      return false;
    }

    if (pathname === '/display-layout' && method === 'GET') {
      // No id anywhere in this request -- it is always the caller's OWN
      // display, by construction, never one a query string could name.
      if (principal.kind !== 'display') {
        refuse(res, 403, 'forbidden', 'this route is for a paired display only');
        return true;
      }
      const { file, problem } = await loadDisplayLayouts(displayLayoutsPath, readFile);
      const dl = displayLayout(file, principal.displayId);
      sendJson(res, 200, {
        ok: true,
        layout: dl === null ? null : { layout: dl.layout, cells: resolveLayoutCells(dl.cells, currentCameraIds()) },
        problem,
      });
      return true;
    }

    return false;
  }

  return { handle };
}
