// agent/cloud-link.mjs
//
// Cloud link on the box: the address, the claim code, and a check-in every
// minute (CLOUD-LINK-SPEC.md section B, "The API"). This file does the I/O
// contracts/cloudLink.ts deliberately does not: it reads and writes
// cloud.json (this route's own state -- a separate file from config.json on
// purpose, so this code path never even opens the file that holds camera
// credentials), reads agent/cloud-enroll.mjs's own cloud-enrollment.json and
// section C's checkin-last.json (written by `camctl checkin`, not by
// anything in this file), and composes contracts/cloudLink.ts's
// cloudStatusView for the System page. Section C (the timer units and
// camctl's own checkin-last.json writer) and section D (the System page's
// Cloud UI section) are built elsewhere; this file only serves the three
// API routes.
//
// Routes: GET /cloud-link, POST /cloud-link, POST /cloud-link/enroll -- all
// three permission system.manage (installer only), exactly like
// /site-settings (contracts/routeAccess.ts).
//
// NOTHING IS SENT UNLESS THE INSTALLER TURNS IT ON: POST /cloud-link/enroll
// is refused 409 "cloud_off" whenever settings.enabled is not true, and this
// file never calls enroll() any other way. HTTPS ONLY: checkCloudSettings
// already refuses any non-https url before it can ever reach cloud.json, and
// enroll() (agent/cloud-enroll.mjs) refuses a non-https url again on its own
// before sending anything -- belt and suspenders, since a hand-edited
// cloud.json is possible even though the API never writes one.
//
// NO CAMERA CREDENTIAL EVER LEAVES THIS FILE: it never reads config.json,
// cameras.json or camera.secret, and never even imports anything that does.
// NO KEY OR TOKEN EVER REACHES A RESPONSE OR A LOG LINE: GET /cloud-link's
// view (cloudStatusView) reports only state, a device id, a claim code (only
// while live), and check-in facts -- never a key, public or private
// (agent/cloud-enroll.mjs's own CLOUD_ENROLLMENT_FILE never holds one
// either). THE CLAIM CODE IS NEVER WRITTEN TO A LOG: this file's own log()
// calls after an enrol attempt carry only the outcome, never
// result.claimCode.
//
// THE FEARED FAILURES, by name:
// - a bad or malicious POST /cloud-link body reaching disk before
//   checkCloudSettings has approved it -- validation always runs BEFORE the
//   write-serialisation queue below even starts.
// - changing the cloud address while an old claim code or enrolment is still
//   on file, so the box looks enrolled with a device the NEW cloud has never
//   heard of -- any url change (checked by VALUE, including null<->a url)
//   unlinks cloud-enrollment.json, and the response says so
//   (enrollmentCleared), never silently.
// - a corrupt hand-edited cloud.json being silently rebuilt from empty on
//   the next save, discarding whatever was actually configured -- the same
//   refuse-rather-than-guess discipline agent/site-settings.mjs already
//   keeps for site.json: a save over an unreadable file is refused 409, not
//   quietly rebuilt.
// - POST /cloud-link/enroll running with settings.enabled still false (or a
//   defaulted-away url from a corrupt cloud.json) -- refused 409 before
//   enroll() is ever called, never merely discouraged.
// - a claim code, a device id or an enrol failure's message ending up in a
//   log line or a thrown error in a way a log shipper could pick up --
//   log() here only ever carries `outcome` and (for a save) the changed
//   FIELD NAMES, never a value, matching agent/site-settings.mjs's own audit
//   discipline.
import { open, rename, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonBody } from './camera-settings.mjs';
import { enroll, CLOUD_ENROLLMENT_FILE } from './cloud-enroll.mjs';
import {
  checkCloudSettings,
  cloudStatusView,
  enrollUrlOf,
  DEFAULT_CLOUD_SETTINGS,
} from '../dist/cloudLink.js';

export const CLOUD_SETTINGS_FILE = 'cloud.json';
/** Written by `camctl checkin` (CLOUD-LINK-SPEC.md section C, not this
 *  file) after every check-in attempt. This route only ever reads it: a
 *  missing file just means "never checked in", the same as any other
 *  cross-piece file this codebase reads (agent/checkin.mjs's own
 *  readJsonFileOrNull discipline for health.json / detect-health.json). */
export const CLOUD_CHECKIN_FILE = 'checkin-last.json';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, message, extra = {}) => sendJson(res, status, { ok: false, code, message, ...extra });

/** Missing, unreadable, not JSON, or not JSON `null`: reads as "not written
 *  yet" -- never an error that blocks GET /cloud-link (the same discipline
 *  agent/checkin.mjs's own readJsonFileOrNull keeps for health.json). */
async function readJsonFileOrNull(file, readFileFn) {
  let text;
  try {
    text = await readFileFn(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * cloud-enrollment.json off disk, field by field -- never a spread of
 * whatever the file happens to hold, so a stray extra property (or key
 * material some future bug wrote there) can never ride into cloudStatusView
 * or a response. Anything not exactly agent/cloud-enroll.mjs's own shape
 * reads as null (never enrolled), matching the pure contract's own doc
 * comment: "Trusted, already-parsed input: reading and validating the file
 * off disk is the API route's job" -- this function is that job.
 */
async function readEnrollmentRecord(stateDir, readFileFn) {
  const raw = await readJsonFileOrNull(join(stateDir, CLOUD_ENROLLMENT_FILE), readFileFn);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.url !== 'string') return null;
  if (typeof raw.deviceId !== 'string') return null;
  if (typeof raw.claimed !== 'boolean') return null;
  if (raw.claimCode !== null && typeof raw.claimCode !== 'string') return null;
  if (raw.expiresUtc !== null && typeof raw.expiresUtc !== 'string') return null;
  if (typeof raw.atUtc !== 'string') return null;
  return {
    url: raw.url,
    deviceId: raw.deviceId,
    claimed: raw.claimed,
    claimCode: raw.claimCode,
    expiresUtc: raw.expiresUtc,
    atUtc: raw.atUtc,
  };
}

/** checkin-last.json (CLOUD-LINK-SPEC.md section C) off disk, field by
 *  field -- same discipline as readEnrollmentRecord above. Anything not
 *  exactly `{ seq, lastOutcome, lastAtUtc }` reads as null (never
 *  checked in), never a guessed time (build rule 5). */
async function readCheckinRecord(stateDir, readFileFn) {
  const raw = await readJsonFileOrNull(join(stateDir, CLOUD_CHECKIN_FILE), readFileFn);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.seq !== 'number' || !Number.isFinite(raw.seq)) return null;
  if (typeof raw.lastOutcome !== 'string') return null;
  if (typeof raw.lastAtUtc !== 'string') return null;
  return { seq: raw.seq, lastOutcome: raw.lastOutcome, lastAtUtc: raw.lastAtUtc };
}

/**
 * cloud.json off disk, distinguishing "truly missing" (kind: "missing" --
 * this box has never touched it, the defaults apply) from "present but
 * broken" (kind: "unreadable", with `reason` saying why -- unlike a merely
 * missing file, this one must not be silently rebuilt from empty on the next
 * save; see the SAVE path below). Mirrors agent/site-settings.mjs's own
 * `load()` split for site.json, for the same round-1 bug it was written to
 * fix there.
 */
async function loadRaw(file, readFileFn) {
  let text;
  try {
    text = await readFileFn(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', reason: `cloud.json cannot be read: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: 'unreadable', reason: `cloud.json is not valid JSON: ${err.message}` };
  }
  const checked = checkCloudSettings(parsed);
  if (!checked.ok) {
    return { kind: 'unreadable', reason: `cloud.json failed validation: ${checked.reason}` };
  }
  return { kind: 'ok', settings: checked.settings };
}

/** The whole text flushed to disk before the rename that makes it the file
 *  -- the same idiom agent/site-settings.mjs's own persist() and
 *  agent/cloud-enroll.mjs's own writeFileSynced() both use, for the same
 *  reason (a power cut right after a bare rename can leave a zero-length
 *  file on XFS, the appliance's own filesystem). */
async function persist(file, obj) {
  const tmp = `${file}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.writeFile(`${JSON.stringify(obj, null, 2)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

export function createCloudLink({
  stateDir,
  audit,
  now = () => new Date(),
  log = () => {},
  readFileFn = readFile,
  // Forwarded, unchanged, to agent/cloud-enroll.mjs's enroll() -- both
  // undefined in every real deployment (enroll() then falls back to the
  // real global fetch and the real device identity); a harness passes fakes
  // of both so POST /cloud-link/enroll never touches the network or a real
  // device-identity.json.
  fetchFn,
  identity,
}) {
  const file = join(stateDir, CLOUD_SETTINGS_FILE);
  const actorOf = (principal) => principal?.username ?? principal?.displayId ?? 'unknown';

  let writing = Promise.resolve();
  function serialise(fn) {
    const run = writing.then(fn, fn);
    writing = run.catch(() => {});
    return run;
  }

  /** The settings a fresh read of cloud.json gives right now -- defaults
   *  when missing or broken (`problem` says which, and why). Never cached:
   *  an installer who just saved a new address in this same session must
   *  see it take effect on the very next GET. */
  async function currentView() {
    const loaded = await loadRaw(file, readFileFn);
    if (loaded.kind === 'ok') return { settings: loaded.settings, problem: null };
    return { settings: DEFAULT_CLOUD_SETTINGS, problem: loaded.kind === 'unreadable' ? loaded.reason : null };
  }

  async function statusViewNow(settings) {
    const enrollment = await readEnrollmentRecord(stateDir, readFileFn);
    const checkin = await readCheckinRecord(stateDir, readFileFn);
    return cloudStatusView({ settings, enrollment, checkin, nowMs: now().getTime() });
  }

  async function handle(req, res, pathname, method, principal) {
    if (method === 'GET' && pathname === '/cloud-link') {
      const { settings, problem } = await currentView();
      const view = await statusViewNow(settings);
      sendJson(res, 200, { ok: true, settings, ...view, problem });
      return true;
    }

    if (method === 'POST' && pathname === '/cloud-link') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const checked = checkCloudSettings(body);
      if (!checked.ok) {
        refuse(res, 400, checked.reason, 'these cloud settings could not be saved');
        return true;
      }
      await serialise(async () => {
        const loaded = await loadRaw(file, readFileFn);
        if (loaded.kind === 'unreadable') {
          // The existing cloud.json cannot be trusted: saving anyway would
          // rebuild it from defaults and silently discard whatever it
          // actually held -- refuse, the same way agent/site-settings.mjs
          // refuses over an unreadable site.json, and let a human notice
          // and repair the file.
          refuse(res, 409, 'cloud_settings_unreadable', `the existing cloud.json cannot be trusted, so this save is refused rather than risk overwriting it with guessed values: ${loaded.reason}`);
          return;
        }
        const before = loaded.kind === 'ok' ? loaded.settings : DEFAULT_CLOUD_SETTINGS;
        const nextSettings = checked.settings;
        await persist(file, nextSettings);

        // "Changing the URL to a different address clears cloud-enrollment.json
        // (it belonged to the old cloud) -- stated in the response, never
        // silent." Compared by VALUE, including null<->a-url in either
        // direction, so a box enrolled while pointed at address A and then
        // repointed at address B (or switched back to no address at all)
        // never keeps A's claim code or device record lying around looking
        // current.
        let enrollmentCleared = false;
        if (before.url !== nextSettings.url) {
          try {
            await unlink(join(stateDir, CLOUD_ENROLLMENT_FILE));
            enrollmentCleared = true;
          } catch (err) {
            if (err.code !== 'ENOENT') throw err; // nothing to clear: no enrolment existed for the old address
          }
        }

        const actor = actorOf(principal);
        const changed = [];
        if (before.url !== nextSettings.url) changed.push('url');
        if (before.enabled !== nextSettings.enabled) changed.push('enabled');
        // Field names only, never a value -- the same discipline
        // agent/site-settings.mjs's own audit call keeps for site.json.
        audit('cloud.settings', req, { actor, fields: changed, enrollmentCleared });
        log('info', 'cloud link settings changed', { fields: changed, enrollmentCleared });
        sendJson(res, 200, { ok: true, settings: nextSettings, enrollmentCleared });
      });
      return true;
    }

    if (method === 'POST' && pathname === '/cloud-link/enroll') {
      const { settings } = await currentView();
      // settings.enabled === true, by checkCloudSettings' own rule, can only
      // ever coexist with a real url -- but a hand-edited or otherwise
      // unreadable cloud.json falls back to DEFAULT_CLOUD_SETTINGS
      // (enabled: false) above, so this one check alone covers "off" AND
      // "no address to enrol against" without guessing at either.
      if (settings.enabled !== true || settings.url === null) {
        refuse(res, 409, 'cloud_off', 'turn the cloud on, with an address, before requesting a claim code');
        return true;
      }
      const result = await enroll({ stateDir, url: enrollUrlOf(settings.url), now, fetchFn, identity });
      const actor = actorOf(principal);
      if (result.outcome !== 'enrolled' && result.outcome !== 'already_claimed') {
        // Every non-success outcome from enroll() is already a named value,
        // never a throw (agent/cloud-enroll.mjs's own doc comment) -- this
        // route passes that outcome straight through rather than guessing
        // at a friendlier one. `result.message` is enroll()'s own operator-
        // facing text, which that file's own harness proves never carries
        // key material.
        audit('cloud.enroll', req, { actor, outcome: result.outcome });
        log('info', 'cloud enroll did not succeed', { outcome: result.outcome });
        refuse(res, 502, 'enroll_failed', result.message ?? `enrolment did not succeed (${result.outcome})`, { outcome: result.outcome });
        return true;
      }
      audit('cloud.enroll', req, { actor, outcome: result.outcome });
      // THE CLAIM CODE IS NEVER WRITTEN TO A LOG: only the outcome, never
      // result.claimCode, appears here or in the audit call above.
      log('info', 'cloud enroll attempted', { outcome: result.outcome });
      const view = await statusViewNow(settings);
      sendJson(res, 200, { ok: true, settings, ...view });
      return true;
    }

    return false;
  }

  return { handle };
}
