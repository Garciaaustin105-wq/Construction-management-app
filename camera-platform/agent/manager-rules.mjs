/**
 * Manager rules: GET/POST /rules (rules.manage) and GET /rule-templates
 * (rules.manage). MANAGER-RULES-SPEC.md section 3. The rules are
 * contracts/managerRules.ts; this file reads the request, writes rules.json
 * (tmp then rename, the same convention agent/camera-ai-settings.mjs and
 * agent/areas.mjs already keep) and writes the audit line.
 *
 * The evaluator itself (reading occupancy.db, running evaluateManagerRule,
 * writing firings to rules.db) lives in agent/api-server.mjs, on its own 5 s
 * timer — this file only owns rules.json (which rules exist) and hands the
 * evaluator its `listEnabled()` read; it never opens rules.db and never runs
 * the evaluator loop itself (build rule 3, one owner per file/concern).
 */
import { open, rename, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJsonBody } from './camera-settings.mjs';
import { checkManagerRule, MANAGER_RULE_TEMPLATES } from '../dist/managerRules.js';

export const RULES_FILE = 'rules.json';
export const RULES_VERSION = 1;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, message, extra = {}) => sendJson(res, status, { ok: false, code, message, ...extra });

function emptyFile() {
  return { version: RULES_VERSION, rules: [] };
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The stored file, checking each rule against the site's CURRENT openHours —
 * a rule using open_hours/closed_hours saved while hours WERE set, read back
 * after they were cleared, would otherwise sit on file unrefusably; reading
 * it as broken (rather than throwing) means the installer sees every OTHER
 * rule normally and gets a clear reason for this one (rule 16), and the
 * evaluator (agent/api-server.mjs) simply never evaluates a broken rule.
 */
async function load(file, readFileFn, openHours) {
  let raw;
  try {
    raw = await readFileFn(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file: emptyFile(), problem: null, invalid: [] };
    return { file: emptyFile(), problem: `rules.json cannot be read: ${err.message}`, invalid: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { file: emptyFile(), problem: `rules.json is not valid JSON: ${err.message}`, invalid: [] };
  }
  if (!isRecord(parsed) || parsed.version !== RULES_VERSION || !Array.isArray(parsed.rules)) {
    return { file: emptyFile(), problem: 'rules.json is not shaped as expected', invalid: [] };
  }
  const rules = [];
  const invalid = [];
  for (const raw of parsed.rules) {
    const checked = checkManagerRule(raw, openHours);
    if (checked.ok) rules.push(checked.rule);
    else invalid.push({ id: isRecord(raw) && typeof raw.id === 'string' ? raw.id : '(unknown)', errors: checked.errors });
  }
  return { file: { version: RULES_VERSION, rules }, problem: null, invalid };
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

/**
 * `config`: for "no such camera". `areasNow()`: agent/areas.mjs's own read,
 * injected rather than imported directly so this file does not become a
 * second owner of areas.json — it only ever asks "does this area exist on
 * this camera", never reads or writes the file. `openHoursNow()`:
 * agent/site-settings.mjs's own read (the site's current openHours + zone).
 */
export function createManagerRules({
  stateDir, config, audit, now = () => new Date(), log = () => {}, readFileFn = readFile,
  areasNow, openHoursNow,
}) {
  const file = join(stateDir, RULES_FILE);

  let writing = Promise.resolve();
  function serialise(fn) {
    const run = writing.then(fn, fn);
    writing = run.catch(() => {});
    return run;
  }

  const actorOf = (principal) => principal?.username ?? null;

  /** The evaluator's own read (agent/api-server.mjs): every currently-valid,
   *  enabled rule. Never the invalid ones — those simply never fire, per
   *  refuse-rather-than-guess (build rule 10). */
  async function listEnabled() {
    const { timeZone, openHours } = await openHoursNow();
    const { file: fileObj } = await load(file, readFileFn, openHours);
    return { rules: fileObj.rules.filter((r) => r.enabled), openHours, timeZone };
  }

  async function handle(req, res, pathname, method, principal) {
    if (method === 'GET' && pathname === '/rule-templates') {
      sendJson(res, 200, { ok: true, templates: MANAGER_RULE_TEMPLATES });
      return true;
    }

    if (method === 'GET' && pathname === '/rules') {
      const { openHours } = await openHoursNow();
      const { file: fileObj, problem, invalid } = await load(file, readFileFn, openHours);
      sendJson(res, 200, { ok: true, rules: fileObj.rules, problem, invalid });
      return true;
    }

    if (method === 'POST' && pathname === '/rules') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      if (typeof body.cameraId !== 'string' || !config.cameras.some((c) => c.cameraId === body.cameraId)) {
        refuse(res, 404, 'no_such_camera', 'there is no camera with that id');
        return true;
      }
      if (body.areaId !== null && body.areaId !== undefined) {
        const areas = await areasNow();
        if (!areas.some((a) => a.id === body.areaId && a.cameraId === body.cameraId)) {
          refuse(res, 404, 'no_such_area', 'there is no such area on that camera');
          return true;
        }
      }
      const { openHours } = await openHoursNow();
      await serialise(async () => {
        const { file: before, problem: beforeProblem } = await load(file, readFileFn, openHours);
        if (beforeProblem) {
          refuse(res, 409, 'rules_unreadable', `the existing rules.json cannot be trusted, so this save is refused rather than risk erasing other rules: ${beforeProblem}`);
          return;
        }
        const existing = typeof body.id === 'string' ? before.rules.find((r) => r.id === body.id) : undefined;
        const id = existing ? existing.id : (typeof body.id === 'string' && body.id !== '' ? body.id : randomUUID());
        const actor = actorOf(principal);
        const nowUtc = now().toISOString();
        const candidate = {
          ...body,
          id,
          areaId: body.areaId ?? null,
          createdBy: existing ? existing.createdBy : actor,
          updatedUtc: nowUtc,
          updatedBy: actor,
        };
        const checked = checkManagerRule(candidate, openHours);
        if (!checked.ok) {
          refuse(res, 400, 'invalid', 'this rule could not be saved', { errors: checked.errors });
          return;
        }
        const nextRules = [...before.rules.filter((r) => r.id !== id), checked.rule]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        await persist(file, { version: RULES_VERSION, rules: nextRules });
        audit('rules.save', req, { actor, id: checked.rule.id, template: checked.rule.template, enabled: checked.rule.enabled, created: existing === undefined });
        log('info', 'a manager rule was saved', { id: checked.rule.id, template: checked.rule.template });
        sendJson(res, 200, { ok: true, rule: checked.rule });
      });
      return true;
    }

    return false;
  }

  return { handle, listEnabled };
}
