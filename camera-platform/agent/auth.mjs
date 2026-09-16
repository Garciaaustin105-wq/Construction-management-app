// agent/auth.mjs
//
// Accounts, passwords, sessions and wall displays: the part of access control
// that touches secrets. The policy -- who may do what -- is contracts/access.ts
// and contracts/routeAccess.ts; this file only establishes WHO is asking.
//
// Decisions worth defending:
//
// - Fail closed on a broken accounts file. Reading a corrupt accounts.json as
//   "no accounts" would reopen first-boot activation to the whole LAN, so an
//   unreadable file signs nobody in and activates nothing until a person
//   repairs it.
// - First boot needs an activation code unless the request comes from the box
//   itself. There is no default account; the code is written to
//   <stateDir>/activation-code (0600), so creating the first installer needs a
//   shell on the box or a console, not just a LAN cable. (Loopback is trusted
//   because nothing proxies to this server. A reverse proxy would make every
//   request loopback, and this exemption would have to go.)
// - scrypt, from node:crypto, with its parameters stored beside each hash, so
//   raising the cost later does not lock out existing accounts. Parameters read
//   back from the file are bounded: a tampered N = 2^30 must not become a
//   single request that pins the CPU.
// - Sessions live in memory and die with the process. A restart signs people
//   out, which is acceptable; a session file is one more secret on disk.
//   Displays are the exception: a TV has nobody to sign it back in, so its
//   cookie is its long-lived token, checked against a stored SHA-256.
// - The role is read from the account on every request, never from the
//   session, so removing an account or resetting its password takes effect on
//   the next request rather than when a cookie happens to expire.

import { scrypt as scryptCb, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, appendFile, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validatePassword, validateName, needsActivation, canRemoveAccount, permissionsFor, ALL_PERMISSIONS, can,
} from '../dist/access.js';

const scrypt = (password, salt, keylen, opts) =>
  new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });

export const SESSION_COOKIE = 'camplat_session';
export const DISPLAY_COOKIE = 'camplat_display';

/** ~100 ms on the appliance; the harness passes a cheaper N. */
export const DEFAULT_SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1 });
const KEY_BYTES = 64;
const SALT_BYTES = 32;

const IDLE_MS = 12 * 3600 * 1000;
const ABSOLUTE_MS = 7 * 24 * 3600 * 1000;
const DISPLAY_MAX_AGE_S = 400 * 24 * 3600;

const FREE_FAILURES = 5;
const FIRST_LOCK_MS = 30 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;
const MAX_THROTTLE_ENTRIES = 10000;

const MAX_BODY_BYTES = 16 * 1024;
const AUDIT_READ_LINES = 500;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 50 bits from an alphabet with no 0/O or 1/I/L to misread off a screen. */
function activationCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, message, headers) => sendJson(res, status, { ok: false, code, message }, headers);

/** Cookie header -> { name: value }, first occurrence wins. Never throws. */
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eqAt = part.indexOf('=');
    if (eqAt < 1) continue;
    const name = part.slice(0, eqAt).trim();
    const value = part.slice(eqAt + 1).trim();
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/** A JSON object body, or a refusal already sent (returns null). */
async function readJsonBody(req, res) {
  const type = String(req.headers['content-type'] ?? '');
  if (!/^application\/json(;|$)/i.test(type)) {
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
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    refuse(res, 400, 'bad_json', 'the request body is not JSON');
    return null;
  }
  if (!isPlainObject(body)) {
    refuse(res, 400, 'bad_json', 'the request body must be a JSON object');
    return null;
  }
  return body;
}

function validStoredHash(h) {
  return isPlainObject(h) && h.algo === 'scrypt'
    && Number.isInteger(h.N) && h.N >= 1024 && h.N <= 1048576 && (h.N & (h.N - 1)) === 0
    && Number.isInteger(h.r) && h.r >= 1 && h.r <= 16
    && Number.isInteger(h.p) && h.p >= 1 && h.p <= 4
    && typeof h.salt === 'string' && /^[0-9a-f]{64}$/.test(h.salt)
    && typeof h.key === 'string' && /^[0-9a-f]{128}$/.test(h.key);
}

/** The accounts file, checked field by field. Anything off is "unreadable". */
function parseAccountsFile(text) {
  const data = JSON.parse(text);
  if (!isPlainObject(data) || data.version !== 1 || !Array.isArray(data.users) || !Array.isArray(data.displays)) {
    throw new Error('not an accounts file');
  }
  const users = new Map();
  for (const u of data.users) {
    if (!isPlainObject(u)) throw new Error('bad user');
    const name = validateName(u.username);
    if (name.kind !== 'ok' || name.name !== u.username) throw new Error('bad username');
    if (u.role !== 'installer' && u.role !== 'store') throw new Error('bad role');
    if (!validStoredHash(u.hash)) throw new Error('bad hash');
    if (users.has(u.username)) throw new Error('duplicate user');
    users.set(u.username, { username: u.username, role: u.role, hash: u.hash, createdUtc: String(u.createdUtc ?? '') });
  }
  const displays = new Map();
  for (const dsp of data.displays) {
    if (!isPlainObject(dsp)) throw new Error('bad display');
    const name = validateName(dsp.displayId);
    if (name.kind !== 'ok' || name.name !== dsp.displayId) throw new Error('bad display id');
    if (typeof dsp.tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(dsp.tokenSha256)) throw new Error('bad token');
    if (displays.has(dsp.displayId)) throw new Error('duplicate display');
    displays.set(dsp.displayId, { displayId: dsp.displayId, tokenSha256: dsp.tokenSha256, createdUtc: String(dsp.createdUtc ?? '') });
  }
  return { users, displays };
}

/**
 * Open the accounts in `stateDir`.
 *
 * Returns { principalOf, handle, audit, authorizeUpgrade, isBroken }.
 * `handle(req, res, pathname, principal)` answers the auth, account, display
 * and audit routes and returns true, or returns false for any other path.
 */
export async function createAuth({
  stateDir,
  now = () => new Date(),
  scryptParams = DEFAULT_SCRYPT,
  secureCookies = false,
  // The harness turns this off to exercise the code path a LAN client takes.
  trustLoopback = true,
  log = () => {},
}) {
  const accountsPath = join(stateDir, 'accounts.json');
  const codePath = join(stateDir, 'activation-code');
  const auditPath = join(stateDir, 'audit.jsonl');

  let users = new Map();
  let displays = new Map();
  let broken = false;
  try {
    ({ users, displays } = parseAccountsFile(await readFile(accountsPath, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      broken = true;
      log('error', 'accounts file unreadable; nobody can sign in until it is repaired', { path: accountsPath, error: err.message });
    }
  }

  const installerCount = () => [...users.values()].filter((u) => u.role === 'installer').length;

  let code = null;
  if (!broken && needsActivation(installerCount())) {
    code = activationCode();
    await writeFile(codePath, code + '\n', { mode: 0o600 });
    log('warn', 'no installer account: activation code written', { path: codePath });
  }

  // tokenHash -> { username, createdMs, lastMs }
  const sessions = new Map();
  // remote address -> { failures, lockedUntilMs, lastMs }
  const throttle = new Map();

  let writing = Promise.resolve();
  /** Write the in-memory accounts atomically; serialised so writes never interleave. */
  function persist() {
    const snapshot = JSON.stringify({
      version: 1,
      users: [...users.values()],
      displays: [...displays.values()],
    }, null, 2) + '\n';
    const run = async () => {
      const tmp = accountsPath + '.tmp';
      const fh = await open(tmp, 'w', 0o600);
      try {
        await fh.writeFile(snapshot);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, accountsPath);
    };
    writing = writing.then(run, run);
    return writing;
  }

  async function hashPassword(password) {
    const salt = randomBytes(SALT_BYTES);
    const { N, r, p } = scryptParams;
    const key = await scrypt(password.normalize('NFC'), salt, KEY_BYTES, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
    return { algo: 'scrypt', N, r, p, salt: salt.toString('hex'), key: key.toString('hex') };
  }

  let dummyHash = null;
  /** Constant work whether or not the account exists. */
  async function verifyPassword(stored, password) {
    if (typeof password !== 'string') return false;
    const target = stored ?? (dummyHash ??= await hashPassword(randomBytes(16).toString('hex')));
    if (!validStoredHash(target)) return false;
    const key = await scrypt(password.normalize('NFC'), Buffer.from(target.salt, 'hex'), KEY_BYTES,
      { N: target.N, r: target.r, p: target.p, maxmem: 256 * target.N * target.r + 1024 * 1024 });
    return timingSafeEqual(key, Buffer.from(target.key, 'hex')) && stored !== null;
  }

  function audit(event, req, fields = {}) {
    const line = JSON.stringify({
      t: now().toISOString(),
      event,
      ip: req?.socket?.remoteAddress ?? null,
      ...fields,
    }) + '\n';
    appendFile(auditPath, line, { mode: 0o600 }).catch((err) => log('error', 'audit write failed', { error: err.message }));
  }

  const cookieFlags = `; HttpOnly; SameSite=Strict; Path=/${secureCookies ? '; Secure' : ''}`;

  function startSession(username) {
    const token = randomBytes(32).toString('base64url');
    const t = now().getTime();
    sessions.set(sha256(token), { username, createdMs: t, lastMs: t });
    return `${SESSION_COOKIE}=${token}; Max-Age=${ABSOLUTE_MS / 1000}${cookieFlags}`;
  }
  const clearSession = `${SESSION_COOKIE}=; Max-Age=0${cookieFlags}`;
  const clearDisplay = `${DISPLAY_COOKIE}=; Max-Age=0${cookieFlags}`;

  function revokeSessionsOf(username, exceptHash = null) {
    for (const [h, s] of sessions) if (s.username === username && h !== exceptHash) sessions.delete(h);
  }

  /** The session's key, when the request carries a live one. */
  function sessionHashOf(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (typeof token !== 'string' || token === '') return null;
    const h = sha256(token);
    const s = sessions.get(h);
    if (!s) return null;
    const t = now().getTime();
    if (t - s.lastMs > IDLE_MS || t - s.createdMs > ABSOLUTE_MS || !users.has(s.username)) {
      sessions.delete(h);
      return null;
    }
    return h;
  }

  function principalOf(req) {
    if (broken) return { kind: 'anonymous' };
    const h = sessionHashOf(req);
    if (h !== null) {
      const s = sessions.get(h);
      s.lastMs = now().getTime();
      const u = users.get(s.username);
      return { kind: 'user', username: u.username, role: u.role };
    }
    const token = parseCookies(req.headers.cookie)[DISPLAY_COOKIE];
    if (typeof token === 'string' && token !== '') {
      const th = sha256(token);
      for (const dsp of displays.values()) {
        if (dsp.tokenSha256 === th) return { kind: 'display', displayId: dsp.displayId };
      }
    }
    return { kind: 'anonymous' };
  }

  function lockedFor(req) {
    const e = throttle.get(req.socket.remoteAddress);
    if (!e) return 0;
    const left = e.lockedUntilMs - now().getTime();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }
  function recordFailure(req) {
    const key = req.socket.remoteAddress;
    const t = now().getTime();
    if (!throttle.has(key) && throttle.size >= MAX_THROTTLE_ENTRIES) {
      for (const [k, e] of throttle) if (e.lockedUntilMs < t) throttle.delete(k);
      if (throttle.size >= MAX_THROTTLE_ENTRIES) throttle.delete(throttle.keys().next().value);
    }
    const e = throttle.get(key) ?? { failures: 0, lockedUntilMs: 0 };
    e.failures += 1;
    if (e.failures >= FREE_FAILURES) {
      e.lockedUntilMs = t + Math.min(FIRST_LOCK_MS * 2 ** (e.failures - FREE_FAILURES), MAX_LOCK_MS);
    }
    throttle.set(key, e);
  }
  const clearFailures = (req) => throttle.delete(req.socket.remoteAddress);

  /** 429 already sent when locked out. */
  function throttled(req, res) {
    const wait = lockedFor(req);
    if (wait === 0) return false;
    refuse(res, 429, 'too_many_attempts', `too many failed attempts; try again in ${wait} s`, { 'Retry-After': String(wait) });
    return true;
  }

  const principalView = (p) =>
    p.kind === 'user' ? { kind: 'user', username: p.username, role: p.role }
      : p.kind === 'display' ? { kind: 'display', displayId: p.displayId }
        : { kind: 'anonymous' };

  /** Persist, or roll the in-memory change back and answer 500. */
  async function commit(res, rollback) {
    try {
      await persist();
      return true;
    } catch (err) {
      rollback();
      log('error', 'accounts write failed', { error: err.message });
      refuse(res, 500, 'accounts_write_failed', 'the account change could not be saved');
      return false;
    }
  }

  async function handle(req, res, pathname, principal) {
    const m = req.method;
    const isAuthPath = pathname.startsWith('/auth/') || pathname === '/accounts' || pathname.startsWith('/accounts/')
      || pathname === '/displays' || pathname.startsWith('/displays/') || pathname === '/audit';
    if (!isAuthPath) return false;

    if (broken && pathname !== '/auth/state') {
      refuse(res, 503, 'accounts_unreadable', 'the accounts file is damaged; nobody can sign in until it is repaired');
      return true;
    }

    // ---------- GET /auth/state ----------
    if (m === 'GET' && pathname === '/auth/state') {
      if (broken) {
        refuse(res, 503, 'accounts_unreadable', 'the accounts file is damaged; nobody can sign in until it is repaired');
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        needsActivation: needsActivation(installerCount()),
        activationNeedsCode: !(trustLoopback && LOOPBACK.has(req.socket.remoteAddress)),
        principal: principalView(principal),
        permissions: ALL_PERMISSIONS.filter((perm) => can(principal, perm)),
      });
      return true;
    }

    // ---------- POST /auth/activate ----------
    if (m === 'POST' && pathname === '/auth/activate') {
      if (throttled(req, res)) return true;
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      if (!needsActivation(installerCount())) {
        refuse(res, 409, 'already_activated', 'this recorder already has an installer account');
        return true;
      }
      if (!(trustLoopback && LOOPBACK.has(req.socket.remoteAddress))) {
        const given = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
        const ok = code !== null && given.length === code.length
          && timingSafeEqual(Buffer.from(given), Buffer.from(code));
        if (!ok) {
          recordFailure(req);
          audit('activate_failed', req, { reason: 'bad_code' });
          refuse(res, 403, 'bad_activation_code', `the activation code is in ${codePath} on the recorder`);
          return true;
        }
      }
      const name = validateName(body.username);
      if (name.kind !== 'ok') { refuse(res, 400, 'bad_username', name.reason); return true; }
      const pw = validatePassword(body.password, name.name);
      if (pw.kind !== 'ok') { refuse(res, 400, 'weak_password', pw.reason); return true; }
      const hash = await hashPassword(body.password);
      // Re-checked after the await: two activations racing must not both win.
      if (!needsActivation(installerCount())) {
        refuse(res, 409, 'already_activated', 'this recorder already has an installer account');
        return true;
      }
      const account = { username: name.name, role: 'installer', hash, createdUtc: now().toISOString() };
      users.set(name.name, account);
      if (!(await commit(res, () => users.delete(name.name)))) return true;
      code = null;
      await unlink(codePath).catch(() => {});
      clearFailures(req);
      audit('activated', req, { actor: name.name });
      sendJson(res, 200, { ok: true, principal: { kind: 'user', username: name.name, role: 'installer' } },
        { 'Set-Cookie': startSession(name.name) });
      return true;
    }

    // ---------- POST /auth/login ----------
    if (m === 'POST' && pathname === '/auth/login') {
      if (throttled(req, res)) return true;
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      if (needsActivation(installerCount())) {
        refuse(res, 409, 'not_activated', 'this recorder has no installer account yet');
        return true;
      }
      const name = validateName(body.username);
      const account = name.kind === 'ok' ? users.get(name.name) ?? null : null;
      const ok = await verifyPassword(account?.hash ?? null, body.password);
      if (!ok || account === null) {
        recordFailure(req);
        audit('login_failed', req, { username: name.kind === 'ok' ? name.name : '(invalid)' });
        // One message for both: which half was wrong is for the attacker, not the user.
        refuse(res, 401, 'bad_credentials', 'wrong username or password');
        return true;
      }
      clearFailures(req);
      audit('login', req, { actor: account.username });
      sendJson(res, 200, { ok: true, principal: { kind: 'user', username: account.username, role: account.role } },
        { 'Set-Cookie': startSession(account.username) });
      return true;
    }

    // ---------- POST /auth/logout ----------
    if (m === 'POST' && pathname === '/auth/logout') {
      const h = sessionHashOf(req);
      if (h !== null) {
        audit('logout', req, { actor: sessions.get(h).username });
        sessions.delete(h);
      }
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': [clearSession, clearDisplay] });
      return true;
    }

    // ---------- POST /auth/display ----------
    if (m === 'POST' && pathname === '/auth/display') {
      if (throttled(req, res)) return true;
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const th = typeof body.token === 'string' && body.token !== '' ? sha256(body.token.trim()) : null;
      const dsp = th === null ? undefined : [...displays.values()].find((x) => x.tokenSha256 === th);
      if (!dsp) {
        recordFailure(req);
        audit('display_pair_failed', req);
        refuse(res, 401, 'bad_display_token', 'that display code is not valid');
        return true;
      }
      clearFailures(req);
      audit('display_paired', req, { displayId: dsp.displayId });
      sendJson(res, 200, { ok: true, principal: { kind: 'display', displayId: dsp.displayId } },
        { 'Set-Cookie': `${DISPLAY_COOKIE}=${body.token.trim()}; Max-Age=${DISPLAY_MAX_AGE_S}${cookieFlags}` });
      return true;
    }

    // ---------- POST /auth/password (own password) ----------
    if (m === 'POST' && pathname === '/auth/password') {
      if (principal.kind !== 'user') {
        refuse(res, 403, 'forbidden', 'a display has no password');
        return true;
      }
      if (throttled(req, res)) return true;
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const account = users.get(principal.username);
      if (!(await verifyPassword(account.hash, body.currentPassword))) {
        recordFailure(req);
        audit('password_change_failed', req, { actor: principal.username });
        refuse(res, 401, 'bad_credentials', 'the current password is wrong');
        return true;
      }
      const pw = validatePassword(body.newPassword, principal.username);
      if (pw.kind !== 'ok') { refuse(res, 400, 'weak_password', pw.reason); return true; }
      const before = account.hash;
      account.hash = await hashPassword(body.newPassword);
      if (!(await commit(res, () => { account.hash = before; }))) return true;
      clearFailures(req);
      // Everywhere else this account is signed in is signed out: a password
      // is changed because someone else may know it.
      revokeSessionsOf(principal.username);
      audit('password_changed', req, { actor: principal.username });
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': startSession(principal.username) });
      return true;
    }

    // Everything below manages the box; routeAccess already required
    // account.manage or audit.view, and principal is a user.
    const actor = principal.kind === 'user' ? principal.username : null;

    // ---------- /accounts ----------
    if (pathname === '/accounts' && m === 'GET') {
      const list = [...users.values()]
        .map((u) => ({ username: u.username, role: u.role, createdUtc: u.createdUtc, permissions: permissionsFor(u.role) }))
        .sort((a, b) => (a.username < b.username ? -1 : 1));
      sendJson(res, 200, { ok: true, accounts: list });
      return true;
    }
    if (pathname === '/accounts' && m === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const name = validateName(body.username);
      if (name.kind !== 'ok') { refuse(res, 400, 'bad_username', name.reason); return true; }
      if (body.role !== 'installer' && body.role !== 'store') {
        refuse(res, 400, 'bad_role', 'role must be installer or store');
        return true;
      }
      const pw = validatePassword(body.password, name.name);
      if (pw.kind !== 'ok') { refuse(res, 400, 'weak_password', pw.reason); return true; }
      const hash = await hashPassword(body.password);
      if (users.has(name.name)) { refuse(res, 409, 'account_exists', 'that username is taken'); return true; }
      users.set(name.name, { username: name.name, role: body.role, hash, createdUtc: now().toISOString() });
      if (!(await commit(res, () => users.delete(name.name)))) return true;
      audit('account_created', req, { actor, target: name.name, role: body.role });
      sendJson(res, 200, { ok: true, account: { username: name.name, role: body.role } });
      return true;
    }
    if (pathname.startsWith('/accounts/')) {
      const rest = pathname.slice('/accounts/'.length);
      const isReset = m === 'POST' && rest.endsWith('/password');
      const rawName = isReset ? rest.slice(0, -'/password'.length) : rest;
      const account = users.get(rawName);
      if (!account || (m !== 'DELETE' && !isReset)) {
        refuse(res, 404, 'no_such_account', 'no such account');
        return true;
      }
      if (m === 'DELETE') {
        const verdict = canRemoveAccount(account, installerCount());
        if (verdict.kind !== 'ok') { refuse(res, 409, 'last_installer', verdict.reason); return true; }
        users.delete(account.username);
        if (!(await commit(res, () => users.set(account.username, account)))) return true;
        revokeSessionsOf(account.username);
        audit('account_removed', req, { actor, target: account.username });
        sendJson(res, 200, { ok: true });
        return true;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const pw = validatePassword(body.password, account.username);
      if (pw.kind !== 'ok') { refuse(res, 400, 'weak_password', pw.reason); return true; }
      const before = account.hash;
      account.hash = await hashPassword(body.password);
      if (!(await commit(res, () => { account.hash = before; }))) return true;
      revokeSessionsOf(account.username);
      audit('password_reset', req, { actor, target: account.username });
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ---------- /displays ----------
    if (pathname === '/displays' && m === 'GET') {
      const list = [...displays.values()]
        .map((x) => ({ displayId: x.displayId, createdUtc: x.createdUtc }))
        .sort((a, b) => (a.displayId < b.displayId ? -1 : 1));
      sendJson(res, 200, { ok: true, displays: list });
      return true;
    }
    if (pathname === '/displays' && m === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const name = validateName(body.displayId);
      if (name.kind !== 'ok') { refuse(res, 400, 'bad_display_id', name.reason); return true; }
      if (displays.has(name.name)) { refuse(res, 409, 'display_exists', 'that display id is taken'); return true; }
      // 120 bits, grouped for typing into a TV remote's keyboard once.
      const token = activationCode() + activationCode() + activationCode().slice(0, 4);
      displays.set(name.name, { displayId: name.name, tokenSha256: sha256(token), createdUtc: now().toISOString() });
      if (!(await commit(res, () => displays.delete(name.name)))) return true;
      audit('display_created', req, { actor, target: name.name });
      // The token is shown once and never stored in the clear.
      sendJson(res, 200, { ok: true, display: { displayId: name.name }, token });
      return true;
    }
    if (pathname.startsWith('/displays/') && m === 'DELETE') {
      const id = pathname.slice('/displays/'.length);
      const dsp = displays.get(id);
      if (!dsp) { refuse(res, 404, 'no_such_display', 'no such display'); return true; }
      displays.delete(id);
      if (!(await commit(res, () => displays.set(id, dsp)))) return true;
      audit('display_removed', req, { actor, target: id });
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ---------- GET /audit ----------
    if (pathname === '/audit' && m === 'GET') {
      let text = '';
      try {
        text = await readFile(auditPath, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const entries = [];
      for (const line of text.split('\n').slice(-AUDIT_READ_LINES - 1)) {
        if (line === '') continue;
        try { entries.push(JSON.parse(line)); } catch { /* a torn last line */ }
      }
      sendJson(res, 200, { ok: true, entries: entries.reverse() });
      return true;
    }

    refuse(res, 404, 'no_such_route', 'No such route');
    return true;
  }

  return { principalOf, handle, audit, isBroken: () => broken };
}
