// agent/push-store.mjs
//
// Manager rules, build 2: phone alerts (MANAGER-ALERTS-SPEC.md) -- the two
// on-disk stores this build owns:
//
// - vapid.json: this box's own VAPID identity (agent/web-push.mjs's own
//   generateVapidKeys), created ONCE, mode 0600, chowned like agent/device-
//   identity.mjs's own device-identity.json when root creates it
//   (identityOwner, reused as-is -- the SAME lesson: a root-run setup step
//   creates the file, the camplat service signs with it afterwards and must
//   be able to read it). NEVER regenerated on a corrupt read: a fresh
//   identity would orphan every phone already subscribed with the OLD
//   public key -- refused, exactly like a corrupt device-identity.json.
// - push-subscriptions.json: one row per account per device
//   (contracts/pushAlerts.ts's own StoredPushSubscription), mode 0600.
//   Every row is checked TWICE before it is trusted: validateSubscription
//   (agent/web-push.mjs -- the row's CRYPTOGRAPHIC fields: endpoint,
//   p256dh, auth) and checkPushSubscriptionRow (contracts/pushAlerts.ts --
//   everything else). Deduplicated on endpoint. An account's own list, add
//   and remove only ever touch that account's own rows; the installer's own
//   view is a per-account COUNT, never an endpoint.
//
// What this file does NOT own: the sender loop (agent/api-server.mjs's own
// 5 s timer, MANAGER-ALERTS-SPEC.md's "Delivery"), the HTTP routes for the
// Alerts page, and the audit line each save/remove writes -- those belong to
// whichever file wires this store to a request, the same split agent/
// device-identity.mjs itself keeps from checkin.mjs.
//
// THE ONE FUNCTION ALLOWED TO TOUCH THE VAPID PRIVATE KEY: sendManagerAlertPush,
// below. Every other export that touches vapid.json (loadOrCreatePublicVapidKey)
// returns the public half only -- see its own comment, and
// harness/pushStore.harness.mjs's "THE FEARED ONE".

import { readFile, open, rename, link, unlink, stat, chown } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { identityOwner } from './device-identity.mjs';
import { generateVapidKeys, validateSubscription, sendPush, toBase64Url } from './web-push.mjs';
import {
  checkPushSubscriptionRow,
  upsertByEndpoint,
  subscriptionsForAccount,
  removeOwnSubscription,
  subscriptionCountsByAccount,
} from '../dist/pushAlerts.js';

export const VAPID_FILE = 'vapid.json';
export const VAPID_VERSION = 1;
export const PUSH_SUBSCRIPTIONS_FILE = 'push-subscriptions.json';
export const PUSH_SUBSCRIPTIONS_VERSION = 1;

function decodeBase64Url(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('not a base64url string');
  return Buffer.from(value, 'base64url');
}

async function chownToStateDirOwnerIfRoot(tmpPath, stateDir) {
  const runningUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const owner = identityOwner(runningUid, await stat(stateDir).catch(() => null));
  if (owner) await chown(tmpPath, owner.uid, owner.gid);
}

/* ================================================================ vapid.json */

/**
 * Throws a refusal. Names only WHAT is wrong, never a value out of the file
 * -- this file holds the box's own VAPID private key, and a refusal message
 * is exactly the kind of text that ends up pasted into a support ticket, a
 * level below where the private key itself is allowed to go (the same
 * discipline agent/device-identity.mjs's own refuse() keeps).
 */
function refuseVapid(reason) {
  const err = new Error(
    `${VAPID_FILE} refused: ${reason}. This file is never regenerated automatically -- ` +
      'a new VAPID identity would orphan every phone already subscribed with the old public key. ' +
      'Fix or remove the file by hand, then let the service create a fresh one.',
  );
  err.code = 'VAPID_REFUSED';
  throw err;
}

/** Parses and fully validates a vapid.json body. Never returns a partial
 *  result -- any structural problem refuses the WHOLE file. */
function parseVapidFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuseVapid('the file is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) return refuseVapid('the file is not a JSON object');
  const { version, createdUtc, publicKey, privateKey } = parsed;
  if (version !== VAPID_VERSION) return refuseVapid(`unrecognised version (expected ${VAPID_VERSION})`);
  if (typeof createdUtc !== 'string' || Number.isNaN(Date.parse(createdUtc))) return refuseVapid('createdUtc is missing or not an ISO timestamp');
  if (typeof publicKey !== 'string' || publicKey.length === 0) return refuseVapid('publicKey is missing or empty');
  if (typeof privateKey !== 'string' || privateKey.length === 0) return refuseVapid('privateKey is missing or empty'); // never echoes the value itself

  let publicKeyBuf;
  let privateKeyBuf;
  try {
    publicKeyBuf = decodeBase64Url(publicKey);
  } catch {
    return refuseVapid('publicKey does not decode as base64url');
  }
  try {
    privateKeyBuf = decodeBase64Url(privateKey);
  } catch {
    return refuseVapid('privateKey does not decode as base64url'); // never echoes the value
  }
  if (publicKeyBuf.length !== 65 || publicKeyBuf[0] !== 0x04) return refuseVapid('publicKey is not a 65-byte uncompressed P-256 point');
  if (privateKeyBuf.length !== 32) return refuseVapid('privateKey is not a 32-byte P-256 scalar');

  return { version, createdUtc, publicKey: publicKeyBuf, privateKey: privateKeyBuf };
}

/** ENOENT only -> null; every other read failure is a refusal, never a
 *  "missing" that would get silently replaced with a brand new identity. */
async function readVapidFileOrNull(stateDir) {
  let text;
  try {
    text = await readFile(join(stateDir, VAPID_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return refuseVapid(`the file could not be read (${err.code ?? err.message})`);
  }
  return parseVapidFile(text);
}

/**
 * Fsynced to a temp file, then LINKED into place -- not renamed. A hard link
 * fails with EEXIST if the real path already exists, which is exactly the
 * property a first-ever VAPID identity needs: two processes racing to
 * create it for a fresh stateDir can never have the second one silently
 * clobber the first's file after some caller has already returned the
 * first one's public key. Returns whether THIS call's write actually became
 * the file (the same technique, and the same reason, as agent/device-
 * identity.mjs's own writeIdentityFileAtomic).
 */
async function writeVapidFileAtomic(stateDir, text) {
  const realPath = join(stateDir, VAPID_FILE);
  const tmp = `${realPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chownToStateDirOwnerIfRoot(tmp, dirname(realPath));
  try {
    await link(tmp, realPath);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false; // someone else won; this freshly generated key pair is thrown away, unused
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** In-process guard: concurrent callers for the SAME stateDir, in the SAME
 *  process, share one creation attempt rather than each generating (and
 *  discarding) their own key pair. The link()-based file guard above still
 *  covers the cross-process case. */
const creatingVapid = new Map();

async function ensureVapid(stateDir) {
  const existing = await readVapidFileOrNull(stateDir);
  if (existing) return { identity: existing, created: false };

  const key = stateDir;
  const already = creatingVapid.get(key);
  if (already) return already;

  const attempt = (async () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const record = {
      version: VAPID_VERSION,
      createdUtc: new Date().toISOString(),
      publicKey: toBase64Url(publicKey),
      privateKey: toBase64Url(privateKey),
    };
    const text = `${JSON.stringify(record, null, 2)}\n`;

    if (process.platform === 'win32') {
      // NTFS does not honour a POSIX open() mode -- said loudly, once per
      // creation, rather than claiming a protection never actually applied
      // (the same "skip loudly on Windows" agent/device-identity.mjs keeps).
      // This box's VAPID private key lives in this file.
      console.error(`warning: ${VAPID_FILE} could not be created with mode 0600 on Windows; secure this file's NTFS permissions by hand.`);
    }
    const won = await writeVapidFileAtomic(stateDir, text);

    // Re-read rather than trust `record`: writeVapidFileAtomic() may have
    // lost the creation race, in which case the file on disk now holds
    // THEIR key pair, not this one -- and that is the one every later call
    // must agree on.
    const onDisk = await readVapidFileOrNull(stateDir);
    if (!onDisk) return refuseVapid('the file disappeared immediately after being written');
    return { identity: onDisk, created: won };
  })();

  creatingVapid.set(key, attempt);
  try {
    return await attempt;
  } finally {
    creatingVapid.delete(key);
  }
}

/**
 * The box's own VAPID public key, creating the identity on first use.
 * -> Promise<{ publicKey: Buffer, createdUtc: string, created: boolean }>
 * NEVER returns the private key -- this is the function a route serving the
 * public key to the browser calls; it structurally cannot leak the private
 * half because it never has it.
 */
export async function loadOrCreatePublicVapidKey(stateDir) {
  const { identity, created } = await ensureVapid(stateDir);
  return { publicKey: identity.publicKey, createdUtc: identity.createdUtc, created };
}

/**
 * Sends one push message, signing it with this box's own VAPID private key
 * -- loaded and used inside this function, never returned to the caller.
 * Takes everything agent/web-push.mjs's own sendPush takes EXCEPT
 * `vapidKeys` (this function supplies that itself) and returns exactly what
 * sendPush returns: an { outcome, status, message } — reused wholesale,
 * never reimplemented, per this build's own brief.
 */
export async function sendManagerAlertPush(stateDir, args) {
  const { identity } = await ensureVapid(stateDir);
  return sendPush({ ...args, vapidKeys: { publicKey: identity.publicKey, privateKey: identity.privateKey } });
}

/* ==================================================== push-subscriptions.json */

function emptySubscriptionsFile() {
  return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptions: [] };
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The stored file, checking each row with contracts/pushAlerts.ts's own
 * checkPushSubscriptionRow. A structurally broken FILE (unreadable, not
 * JSON, wrong shape) never throws -- it comes back as the empty defaults
 * with `problem` set (build rule 16: say what could not be used, and why),
 * the same split agent/manager-rules.mjs's own load() keeps for rules.json.
 * A single bad ROW is collected in `invalid` rather than losing every other
 * account's subscription to it.
 */
async function load(file, readFileFn) {
  let raw;
  try {
    raw = await readFileFn(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file: emptySubscriptionsFile(), problem: null, invalid: [] };
    return { file: emptySubscriptionsFile(), problem: `${PUSH_SUBSCRIPTIONS_FILE} cannot be read: ${err.message}`, invalid: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { file: emptySubscriptionsFile(), problem: `${PUSH_SUBSCRIPTIONS_FILE} is not valid JSON: ${err.message}`, invalid: [] };
  }
  if (!isRecord(parsed) || parsed.version !== PUSH_SUBSCRIPTIONS_VERSION || !Array.isArray(parsed.subscriptions)) {
    return { file: emptySubscriptionsFile(), problem: `${PUSH_SUBSCRIPTIONS_FILE} is not shaped as expected`, invalid: [] };
  }
  const rows = [];
  const invalid = [];
  for (const rawRow of parsed.subscriptions) {
    const checked = checkPushSubscriptionRow(rawRow);
    if (checked.ok) rows.push(checked.row);
    else invalid.push({ id: isRecord(rawRow) && typeof rawRow.id === 'string' ? rawRow.id : '(unknown)', errors: checked.errors });
  }
  return { file: { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptions: rows }, problem: null, invalid };
}

async function persistSubscriptions(stateDir, fileObj) {
  const realPath = join(stateDir, PUSH_SUBSCRIPTIONS_FILE);
  const tmp = `${realPath}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(fileObj, null, 2)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chownToStateDirOwnerIfRoot(tmp, stateDir);
  await rename(tmp, realPath);
}

/**
 * A push-subscriptions.json store scoped to one stateDir, mirroring agent/
 * manager-rules.mjs's own createManagerRules: state (the write-serialising
 * queue) lives in this closure, not a module-level global, so two stateDirs
 * in one process (e.g. two temp directories in one harness run) never share
 * one write queue.
 */
export function createPushSubscriptionStore({ stateDir, readFileFn = readFile, now = () => new Date() }) {
  const file = join(stateDir, PUSH_SUBSCRIPTIONS_FILE);

  let writing = Promise.resolve();
  /** Serialised: each write reads the file the previous write just wrote. */
  function serialise(fn) {
    const run = writing.then(fn, fn);
    writing = run.catch(() => {});
    return run;
  }

  /** Every row, validated -- for the sender loop and for a harness. Never
   *  filtered by account: a caller that must not see another account's row
   *  (listOwn, below) does that filtering itself, from this same read. */
  async function all() {
    const { file: fileObj, problem, invalid } = await load(file, readFileFn);
    return { subscriptions: fileObj.subscriptions, problem, invalid };
  }

  /** "An account sees ... only its own" (MANAGER-ALERTS-SPEC.md). */
  async function listOwn(username) {
    const { subscriptions, problem } = await all();
    return { subscriptions: subscriptionsForAccount(subscriptions, username), problem };
  }

  /** "The installer can see a count per account, but never the endpoints." */
  async function accountCounts() {
    const { subscriptions, problem } = await all();
    return { counts: subscriptionCountsByAccount(subscriptions), problem };
  }

  /**
   * Adds (or, on a repeat endpoint, replaces -- "deduplicate on endpoint")
   * one subscription. `rawSubscription` is the browser's own PushSubscription
   * JSON ({ endpoint, keys: { p256dh, auth } }), checked with agent/web-
   * push.mjs's own validateSubscription BEFORE this file's own
   * checkPushSubscriptionRow ever sees it -- the cryptographic shape and the
   * row shape are two different questions, refused separately so a caller
   * can tell which one failed.
   */
  async function add({ username, rawSubscription, label, rules }) {
    let validated;
    try {
      validated = validateSubscription(rawSubscription);
    } catch (err) {
      return { ok: false, code: 'invalid_subscription', message: err.message };
    }
    const candidate = {
      id: randomUUID(),
      username,
      endpoint: validated.endpoint,
      p256dh: rawSubscription.keys.p256dh,
      auth: rawSubscription.keys.auth,
      createdUtc: now().toISOString(),
      label: label ?? null,
      rules: rules ?? 'all',
    };
    const checked = checkPushSubscriptionRow(candidate);
    if (!checked.ok) return { ok: false, code: 'invalid_row', errors: checked.errors };

    return serialise(async () => {
      const { file: before, problem: beforeProblem } = await load(file, readFileFn);
      if (beforeProblem) {
        // The existing file cannot be trusted: saving anyway would rebuild
        // it from empty and silently drop every OTHER account's
        // subscription (rule: nothing is deleted by a save). Refuse.
        return { ok: false, code: 'subscriptions_unreadable', message: `the existing ${PUSH_SUBSCRIPTIONS_FILE} cannot be trusted, so this save is refused rather than risk erasing other subscriptions: ${beforeProblem}` };
      }
      const nextRows = upsertByEndpoint(before.subscriptions, checked.row);
      await persistSubscriptions(stateDir, { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptions: nextRows });
      return { ok: true, subscription: checked.row };
    });
  }

  /** Removes `id`, but ONLY if it belongs to `username` -- "removes ... only
   *  its own" is enforced HERE, at the data layer, not left to whichever
   *  route calls this with a caller-supplied id (build rule: refuse rather
   *  than trust a caller's own scoping). */
  async function removeOwn({ username, id }) {
    return serialise(async () => {
      const { file: before, problem: beforeProblem } = await load(file, readFileFn);
      if (beforeProblem) {
        return { ok: false, code: 'subscriptions_unreadable', message: `the existing ${PUSH_SUBSCRIPTIONS_FILE} cannot be trusted, so this remove is refused: ${beforeProblem}` };
      }
      const nextRows = removeOwnSubscription(before.subscriptions, username, id);
      if (nextRows.length === before.subscriptions.length) {
        return { ok: false, code: 'not_found', message: 'no subscription with that id belongs to this account' };
      }
      await persistSubscriptions(stateDir, { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptions: nextRows });
      return { ok: true };
    });
  }

  return { all, listOwn, accountCounts, add, removeOwn };
}
