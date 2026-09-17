/**
 * The Recording page's routes: read and set how long recordings are kept.
 * storage.manage (routeAccess). The rules are contracts/recordingSettings.ts;
 * the deleting is recorder-service's runAgeEviction, which reads
 * recording.json on its next pass (within five minutes), without a restart.
 *
 * A limit that would delete footage is refused with how much, until the
 * request confirms it: nobody lowers 30 days to 1 and finds out afterwards.
 */
import { open, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonBody } from './camera-settings.mjs';
import {
  RECORDING_FILE, MIN_DAYS, MAX_DAYS, checkRecordingSettings, readRecordingFile,
  recordingFileText, ageCutoffMs, confirmSave,
} from '../dist/recordingSettings.js';

const MESSAGES = {
  not_an_object: 'send the settings as a JSON object',
  bad_max_days: `keep recordings for a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}, or no limit`,
  unknown_key: 'that is not a recording setting',
  bad_confirm: 'confirm is true or absent',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, extra = {}) =>
  sendJson(res, status, { ok: false, code, message: MESSAGES[code] ?? code, ...extra });

export function createRecordingSettings({ stateDir, index, now = () => new Date(), audit, log = () => {} }) {
  const file = join(stateDir, RECORDING_FILE);

  async function load() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      text = err.code === 'ENOENT' ? null : undefined;
    }
    return readRecordingFile(text);
  }

  async function persist(settings) {
    const tmp = file + '.tmp';
    const fh = await open(tmp, 'w', 0o644);
    try {
      await fh.writeFile(recordingFileText(settings));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  }

  let writing = Promise.resolve();
  const serialise = (fn) => {
    const run = writing.then(fn, fn);
    writing = run.catch(() => {});
    return run;
  };

  async function handle(req, res, pathname, method, principal) {
    if (pathname !== '/recording-settings') return false;

    if (method === 'GET') {
      const { settings, problem } = await load();
      sendJson(res, 200, { ok: true, settings, problem, minDays: MIN_DAYS, maxDays: MAX_DAYS });
      return true;
    }

    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const { confirm, ...rest } = body;
      if (confirm !== undefined && typeof confirm !== 'boolean') {
        refuse(res, 400, 'bad_confirm', { field: 'confirm' });
        return true;
      }
      const checked = checkRecordingSettings(rest);
      if (!checked.ok) {
        refuse(res, 400, checked.reason, { field: checked.field ?? null });
        return true;
      }
      await serialise(async () => {
        const before = (await load()).settings;
        const cutoff = ageCutoffMs(checked.settings, now().getTime());
        const wouldDelete = cutoff === null
          ? { segments: 0, bytes: 0, oldestUtc: null }
          : index.olderThanStats(cutoff);
        const decision = confirmSave(wouldDelete, confirm);
        if (!decision.save) {
          sendJson(res, 409, {
            ok: false, code: 'would_delete', wouldDelete,
            message: 'this limit deletes recordings already on the drives; confirm to save it',
          });
          return;
        }
        await persist(checked.settings);
        audit('recording.settings', req, {
          actor: principal?.username ?? null,
          fromMaxDays: before.maxDays,
          toMaxDays: checked.settings.maxDays,
          confirmedSegments: wouldDelete.segments,
        });
        log('info', 'recording settings changed', { maxDays: checked.settings.maxDays });
        sendJson(res, 200, { ok: true, settings: checked.settings, wouldDelete });
      });
      return true;
    }

    return false;
  }

  return { handle };
}
