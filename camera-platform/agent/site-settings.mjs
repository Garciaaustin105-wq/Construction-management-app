/**
 * Site settings' routes: GET/POST /site-settings (installer only,
 * system.manage; every save audited) and GET /site (any signed-in role, plus
 * a paired display -- the pages use it to hide nav links). SITE-SETTINGS-SPEC.md
 * section 1. The rules are contracts/siteSettings.ts; this file reads the
 * request, writes site.json (tmp then rename, the same convention
 * agent/camera-ai-settings.mjs already keeps for camera-ai.json), reads the
 * version and trust-anchor facts for the System page, and writes the audit
 * line with the changed fields.
 *
 * This file also hands out two small accessors other routes in
 * agent/api-server.mjs need: `effectiveTimeZoneNow()` (camera-ai-settings' own
 * GET, and the default for a client that omits /activity's `tz`) and
 * `isFeatureEnabledNow(key)` (the /activity and /activity-page 404
 * feature_off gate). Both re-read site.json fresh on every call, the same
 * "never cache a value that can change out from under a running process"
 * discipline agent/camera-ai-settings.mjs already keeps for the storing
 * floor: an installer who just changed the site zone or a feature switch in
 * this same session must see it take effect immediately, not after a
 * restart.
 */
import { open, rename, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonBody } from './camera-settings.mjs';
import {
  checkSiteSettings, checkSiteSettingsFile, siteSettingsView, diffSiteSettings,
  applyPreset, effectiveTimeZone, isFeatureEnabled, checkOpenHoursField,
  FEATURE_REGISTRY, SITE_TYPES, SITE_SETTINGS_VERSION,
} from '../dist/siteSettings.js';

export const SITE_SETTINGS_FILE = 'site.json';

/** "No license service configured yet": licensing arrives with the cloud
 *  (CLOUD-B1-SPEC.md section 4). Fixed text, no I/O -- there is nothing to
 *  read yet, so nothing here pretends there is. */
const LICENSE_TEXT = 'No license service configured yet';

/** The trust anchor lives outside any release (agent/verify-release.mjs's own
 *  doc comment): the same env override and the same default path that file
 *  already uses, so "the trusted key ids" on the System page can never name a
 *  different anchor than the one an upgrade is actually checked against. */
const DEFAULT_TRUSTED_KEYS_PATH = '/etc/camplat/trusted-keys.json';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, message, extra = {}) => sendJson(res, status, { ok: false, code, message, ...extra });

/**
 * The stored file, validated -- never throws. A file that cannot be read, is
 * not JSON, or fails validation comes back as `file: null` (siteSettingsView's
 * own "missing" case: every field at its default) with `problem` saying why
 * (rule 16), so a reader shows the site at its defaults rather than crash or
 * guess. Distinguishing "truly missing" (problem: null) from "present but
 * broken" (problem: a reason) only matters to the SAVE path below, which must
 * refuse rather than silently rebuild a broken file from empty (round 1's own
 * bug, fixed in agent/camera-ai-settings.mjs's `load()` -- this keeps the same
 * split).
 */
async function load(file, readFileFn) {
  let raw;
  try {
    raw = await readFileFn(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file: null, problem: null };
    return { file: null, problem: `site.json cannot be read: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { file: null, problem: `site.json is not valid JSON: ${err.message}` };
  }
  const checked = checkSiteSettingsFile(parsed);
  if (!checked.ok) {
    const shown = checked.errors.slice(0, 3).map((e) => `${e.field}: ${e.reason}`).join('; ');
    const more = checked.errors.length > 3 ? `; and ${checked.errors.length - 3} more` : '';
    return { file: null, problem: `site.json failed validation: ${shown}${more}` };
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

/** The first 12 characters of `<appDir>/VERSION`, plus its mtime -- "when it
 *  was installed" (SITE-SETTINGS-SPEC.md section 2). Unreadable reports its
 *  reason, never a blank or a guess. */
async function versionInfo(appDir, readFileFn, statFn) {
  const path = join(appDir, 'VERSION');
  let raw;
  try {
    raw = await readFileFn(path, 'utf8');
  } catch (err) {
    return { ok: false, problem: `VERSION cannot be read: ${err.message}` };
  }
  let installedAtUtc;
  try {
    const st = await statFn(path);
    installedAtUtc = st.mtime.toISOString();
  } catch (err) {
    return { ok: false, problem: `VERSION's own file time cannot be read: ${err.message}` };
  }
  return { ok: true, version: raw.slice(0, 12), installedAtUtc };
}

/**
 * Public key ids only, from the same trust anchor agent/verify-release.mjs
 * already reads (never the PEM itself -- nothing here needs it, and nothing
 * here ever hands it to a browser). Mirrors that file's own
 * `readTrustedKeys` filtering (a revoked key is not "trusted"), but keeps the
 * reason a file could not be used instead of silently returning an empty set
 * -- "anything unreadable shows its reason, never a blank or a guess."
 */
async function trustedKeyIds(keysPath, readFileFn) {
  let raw;
  try {
    raw = await readFileFn(keysPath, 'utf8');
  } catch (err) {
    return { ok: false, problem: `the trust anchor (${keysPath}) cannot be read: ${err.message}` };
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return { ok: false, problem: `the trust anchor is not valid JSON: ${err.message}` };
  }
  if (typeof body !== 'object' || body === null || !Array.isArray(body.keys)) {
    return { ok: false, problem: 'the trust anchor is not shaped as expected (no "keys" array)' };
  }
  const ids = [];
  for (const k of body.keys) {
    if (typeof k !== 'object' || k === null) continue;
    if (typeof k.id !== 'string') continue;
    if (k.revoked === true) continue;
    ids.push(k.id);
  }
  return { ok: true, ids };
}

export function createSiteSettings({
  stateDir,
  // The parent of agent/ in every deployment (agent/api-server.mjs's own
  // `import.meta.dirname` for its UI files is the same directory this
  // resolves from) -- overridable so a harness can point VERSION at a temp
  // dir without touching the real checkout.
  appDir = join(import.meta.dirname, '..'),
  audit,
  now = () => new Date(),
  log = () => {},
  readFileFn = readFile,
  statFn = stat,
  trustedKeysPath = process.env.CAMPLAT_TRUSTED_KEYS || DEFAULT_TRUSTED_KEYS_PATH,
}) {
  const file = join(stateDir, SITE_SETTINGS_FILE);
  const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

  let writing = Promise.resolve();
  function serialise(fn) {
    const run = writing.then(fn, fn);
    writing = run.catch(() => {});
    return run;
  }

  const actorOf = (principal) => principal?.username ?? principal?.displayId ?? 'unknown';

  /** The settings a fresh read of site.json gives right now -- defaults when
   *  missing or broken (`problem` says which, and why). */
  async function currentView() {
    const { file: fileObj, problem } = await load(file, readFileFn);
    return { settings: siteSettingsView(fileObj), problem };
  }

  /** GET /camera-ai-settings's own "the effective zone" (SITE-SETTINGS-SPEC.md:
   *  "new camera AI schedules use the site zone"), and /activity's default
   *  when the client omits `tz` -- read fresh, never cached, so a zone change
   *  this same session takes effect on the very next request. */
  async function effectiveTimeZoneNow() {
    const { settings } = await currentView();
    return effectiveTimeZone(settings, systemTimeZone());
  }

  /** The /activity and /activity-page 404 feature_off gate, reused for
   *  /areas, /areas/list, /rules, /rule-templates and /reports (all gated on
   *  managerRules — MANAGER-RULES-SPEC.md section 4). */
  async function isFeatureEnabledNow(key) {
    const { settings } = await currentView();
    return isFeatureEnabled(settings.features, key);
  }

  /** The manager-rules evaluator's own read (agent/api-server.mjs, every 5 s):
   *  the site's current openHours (or null, "not set") and its effective
   *  time zone, together and fresh, so a rule using open_hours/closed_hours
   *  is judged against whatever is on file AT THIS INSTANT — never a cached
   *  copy from when the evaluator's timer started. */
  async function openHoursNow() {
    const { settings } = await currentView();
    return { openHours: settings.openHours, timeZone: effectiveTimeZone(settings, systemTimeZone()) };
  }

  async function handle(req, res, pathname, method, principal) {
    if (method === 'GET' && pathname === '/site-settings') {
      const { settings, problem } = await currentView();
      const systemZone = systemTimeZone();
      const version = await versionInfo(appDir, readFileFn, statFn);
      const trusted = await trustedKeyIds(trustedKeysPath, readFileFn);
      sendJson(res, 200, {
        ok: true,
        settings,
        systemTimeZone: systemZone,
        effectiveTimeZone: effectiveTimeZone(settings, systemZone),
        featureRegistry: FEATURE_REGISTRY,
        siteTypes: SITE_TYPES,
        problem,
        version: version.ok ? { version: version.version, installedAtUtc: version.installedAtUtc } : null,
        versionProblem: version.ok ? null : version.problem,
        trustedKeyIds: trusted.ok ? trusted.ids : [],
        trustedKeysProblem: trusted.ok ? null : trusted.problem,
        license: LICENSE_TEXT,
      });
      return true;
    }

    if (method === 'POST' && pathname === '/site-settings') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const checked = checkSiteSettings(body);
      if (!checked.ok) {
        refuse(res, 400, 'invalid', 'these settings could not be saved', { errors: checked.errors });
        return true;
      }
      await serialise(async () => {
        const { file: beforeFile, problem: beforeProblem } = await load(file, readFileFn);
        if (beforeProblem) {
          // The existing site.json cannot be trusted: saving anyway would
          // rebuild it from defaults and silently discard whatever it
          // actually held (round 1's own fixed bug -- refuse, the same way
          // agent/camera-ai-settings.mjs refuses over an unreadable
          // camera-ai.json, and let a human notice and repair the file).
          refuse(res, 409, 'site_settings_unreadable', `the existing site.json cannot be trusted, so this save is refused rather than risk overwriting it with guessed values: ${beforeProblem}`);
          return;
        }
        const before = siteSettingsView(beforeFile);
        // "A preset never changes switches silently later: it applies once,
        // when chosen." applyPreset is a no-op unless THIS save is actually
        // changing the site type (it compares against `before`, not against
        // itself) -- so features only ever come from the preset the moment
        // the type changes, and from the operator's own submitted switches on
        // every other save (full-replace, like every other field here).
        const withPreset = applyPreset(before, checked.settings.siteType);
        const nextSettings = {
          displayName: checked.settings.displayName,
          timeZone: checked.settings.timeZone,
          siteType: checked.settings.siteType,
          features: checked.settings.siteType === before.siteType ? checked.settings.features : withPreset.features,
          // openHours has its own route (POST /open-hours, MANAGER-RULES-SPEC.md
          // section 3 — editable by the installer OR a manager, unlike the rest
          // of this route's system.manage-only fields): this save NEVER touches
          // it, whatever (if anything) the body said about it, so an installer
          // saving the display name does not silently clear a manager's stored
          // open hours.
          openHours: before.openHours,
          // appearanceMatchPercent (APPEARANCE-OF-DAY-SPEC.md): an ordinary
          // full-replace field, like displayName/timeZone above -- not a
          // preset-driven switch and not openHours' own separate route, so
          // it always takes whatever this save submitted (checkSiteSettings
          // already defaulted it to 80 when the body omitted it).
          appearanceMatchPercent: checked.settings.appearanceMatchPercent,
        };
        const nowUtc = now().toISOString();
        const actor = actorOf(principal);
        const nextFile = { version: SITE_SETTINGS_VERSION, ...nextSettings, updatedUtc: nowUtc, updatedBy: actor };
        await persist(file, nextFile);
        const changed = diffSiteSettings(before, nextSettings);
        // Never a value -- the same discipline diffCameraAiSettings already
        // keeps (a changed feature switch is worth naming, its old and new
        // value is not).
        audit('site.settings', req, { actor, fields: changed });
        log('info', 'site settings changed', { fields: changed });
        sendJson(res, 200, { ok: true, settings: nextSettings });
      });
      return true;
    }

    // GET/POST /open-hours (MANAGER-RULES-SPEC.md section 3): the store's
    // open hours, in the site's own Schedule shape (contracts/alertRules.ts).
    // Its own route rather than folded into GET/POST /site-settings above
    // because it is reachable by a manager too (hours.manage, routeAccess.ts)
    // -- system.manage stays installer-only for everything else in the Site
    // section.
    if (method === 'GET' && pathname === '/open-hours') {
      const { settings } = await currentView();
      sendJson(res, 200, { ok: true, openHours: settings.openHours });
      return true;
    }
    if (method === 'POST' && pathname === '/open-hours') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const checked = checkOpenHoursField(body.openHours);
      if (!checked.ok) {
        refuse(res, 400, 'invalid', 'open hours could not be saved', { errors: [{ field: 'openHours', reason: checked.reason }] });
        return true;
      }
      await serialise(async () => {
        const { file: beforeFile, problem: beforeProblem } = await load(file, readFileFn);
        if (beforeProblem) {
          refuse(res, 409, 'site_settings_unreadable', `the existing site.json cannot be trusted, so this save is refused rather than risk overwriting it with guessed values: ${beforeProblem}`);
          return;
        }
        const before = siteSettingsView(beforeFile);
        const nextSettings = { ...before, openHours: checked.openHours };
        const nowUtc = now().toISOString();
        const actor = actorOf(principal);
        const nextFile = { version: SITE_SETTINGS_VERSION, ...nextSettings, updatedUtc: nowUtc, updatedBy: actor };
        await persist(file, nextFile);
        const changed = diffSiteSettings(before, nextSettings);
        audit('site.open-hours', req, { actor, fields: changed });
        log('info', 'site open hours changed', { fields: changed });
        sendJson(res, 200, { ok: true, openHours: nextSettings.openHours });
      });
      return true;
    }

    if (method === 'GET' && pathname === '/site') {
      const { settings } = await currentView();
      const systemZone = systemTimeZone();
      sendJson(res, 200, {
        ok: true,
        displayName: settings.displayName,
        timeZone: effectiveTimeZone(settings, systemZone),
        features: settings.features,
      });
      return true;
    }

    return false;
  }

  return { handle, effectiveTimeZoneNow, isFeatureEnabledNow, openHoursNow };
}
