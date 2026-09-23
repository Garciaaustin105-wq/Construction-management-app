// agent/device-identity.mjs
//
// The box's own identity, kept separate from the release-signing trust
// anchor (/etc/camplat/trusted-keys.json, agent/verify-release.mjs -- that
// answers "is this UPDATE genuinely ours"; this file answers "is this BOX
// genuinely one of ours, and which one" -- CLOUD-B1-SPEC.md section 6). B1
// phase-1 brief, piece 1. This file is never imported by verify-release.mjs
// and never reads or writes trusted-keys.json; the two identities must not
// be conflated, so this module does not even know that file's path.
//
// <stateDir>/device-identity.json holds an Ed25519 key pair, generated once
// on first use (node:crypto, no external dependency) and reused forever
// after, mode 0600, written atomically (a fully-flushed temp file linked
// into place, never a partial file -- the box's drives are XFS).
//
// THE PRIVATE KEY NEVER LEAVES THIS FILE: loadOrCreateIdentity() below
// returns only the public half; nothing here ever logs the private key or
// puts it in a thrown error's message; signWithIdentity() is the one
// function that touches it, and even that returns nothing but a signature.
//
// A file that exists but cannot be trusted -- unreadable, not JSON, missing
// a field, holding a deviceId that does not match its own public key -- is
// REFUSED, never silently overwritten with a fresh identity (build rule 10:
// refuse rather than guess). A new identity would orphan this box from
// whatever cloud record already knows its old deviceId; the operator fixes
// or removes the file by hand and reruns `camctl identity`.
//
// checkin.mjs's own top comment documents the two functions this file must
// export and their exact shapes; keep this file and that comment in sync.

import { generateKeyPairSync, createHash, createPrivateKey, createPublicKey, sign as signBytes, randomBytes } from "node:crypto";
import { readFile, open, link, unlink, stat, chown } from "node:fs/promises";
import path from "node:path";

export const DEVICE_IDENTITY_FILE = "device-identity.json";
export const DEVICE_IDENTITY_VERSION = 1;

/**
 * RFC 4648 base32, upper case, no padding. Chosen over hex or base64 because
 * a deviceId has to be READ, not just stored -- CLOUD-B1-SPEC.md section 7's
 * own exit bar is diagnosing a box "200 miles away", which starts with an
 * installer reading or typing this id into a support ticket or a phone call.
 * Base32's alphabet drops the 0/O, 1/I/L confusions by construction and is
 * conventionally case-insensitive, unlike base64 (case-sensitive, and uses
 * `+` and `/` that do not survive being read aloud or pasted into an
 * upper-case-only field); hex is unambiguous too but needs nearly twice as
 * many characters for the same entropy.
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * deviceId = base32(sha256(publicKey SPKI DER)[0:16]). The DER bytes, not
 * the PEM text: PEM line-wrapping and whitespace are an encoding detail, not
 * part of the key, and must never be able to change the id. 16 bytes (128
 * bits) of a well-distributed hash makes a collision across every box this
 * platform will ever build practically impossible, while keeping the id
 * short enough to read and type back (26 base32 characters, no padding).
 */
function deriveDeviceId(publicKeyDer) {
  const hash = createHash("sha256").update(publicKeyDer).digest();
  return base32Encode(hash.subarray(0, 16));
}

function identityPath(stateDir) {
  return path.join(stateDir, DEVICE_IDENTITY_FILE);
}

/**
 * Throws a refusal. The message names only WHAT is wrong, never a value out
 * of the file under inspection -- that file may hold this box's own private
 * key, and a refusal message is exactly the kind of text that ends up
 * pasted into a support ticket or a log a level below where the private key
 * itself is allowed to go.
 */
function refuse(reason) {
  const err = new Error(
    `${DEVICE_IDENTITY_FILE} refused: ${reason}. This file is never regenerated automatically -- ` +
      "a new identity would orphan this box from any cloud record of its old one. " +
      "Fix or remove the file by hand, then run `camctl identity` again.",
  );
  err.code = "DEVICE_IDENTITY_REFUSED";
  throw err;
}

/**
 * Parses and fully validates a device-identity.json body. Never returns a
 * partial result: any structural problem, or a deviceId that does not match
 * its own public key, refuses the WHOLE file (refuse() above) rather than
 * trusting the parts that happened to look fine.
 */
function parseIdentityFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("the file is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) return refuse("the file is not a JSON object");
  const { version, createdAtUtc, deviceId, publicKeyPem, privateKeyPem } = parsed;
  if (version !== DEVICE_IDENTITY_VERSION) return refuse(`unrecognised version (expected ${DEVICE_IDENTITY_VERSION})`);
  if (typeof createdAtUtc !== "string" || Number.isNaN(Date.parse(createdAtUtc))) return refuse("createdAtUtc is missing or not an ISO timestamp");
  if (typeof deviceId !== "string" || deviceId.length === 0) return refuse("deviceId is missing or empty");
  if (typeof publicKeyPem !== "string" || publicKeyPem.length === 0) return refuse("publicKeyPem is missing or empty");
  if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) return refuse("privateKeyPem is missing or empty");

  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    return refuse("publicKeyPem does not parse as a key");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") return refuse("publicKeyPem is not an Ed25519 key");

  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    return refuse("privateKeyPem does not parse as a key"); // never echoes the value itself
  }
  if (privateKey.asymmetricKeyType !== "ed25519") return refuse("privateKeyPem is not an Ed25519 key");

  const der = publicKey.export({ type: "spki", format: "der" });
  if (deviceId !== deriveDeviceId(der)) {
    return refuse("deviceId does not match its own public key (the file may have been hand-edited, or merged from two boxes)");
  }

  return { version, createdAtUtc, deviceId, publicKeyPem, privateKeyPem, publicKey, privateKey };
}

/** Reads and validates the identity file, or null if it genuinely does not
 *  exist yet (ENOENT only -- every other read failure is a refusal, not a
 *  "missing", so it is never silently replaced with a brand new identity). */
async function readIdentityFileOrNull(stateDir) {
  let text;
  try {
    text = await readFile(identityPath(stateDir), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return refuse(`the file could not be read (${err.code ?? err.message})`);
  }
  return parseIdentityFile(text);
}

/**
 * The whole file's text, fsynced to a temp file, then LINKED into place --
 * not renamed. A hard link fails with EEXIST if `realPath` already exists,
 * which is exactly the property a first-ever identity needs: two processes
 * racing to create the FIRST identity for a fresh stateDir (e.g. two camctl
 * invocations moments apart on a freshly imaged box) can never have the
 * second one silently clobber the first's file after some caller has
 * already returned the first one's deviceId -- the same orphaning this
 * file's "refused, not replaced" rule exists to prevent, just at creation
 * time instead of at read time. Returns whether THIS call's write actually
 * became the file (false if it lost the race).
 */
/**
 * Who a NEW identity file should belong to, or null to leave it as created.
 * Found 2026-09-23, before it was ever run on the box: `sudo camctl identity`
 * runs as root, so the file would come out root-owned and 0600 - and the
 * camera service, which runs as its own user and will sign check-ins with it,
 * could never read it. When root creates it, it belongs to whoever owns the
 * state directory (camplat on the appliance). Anyone else creating it owns it
 * already, and a root-owned state directory means root is the right owner.
 */
export function identityOwner(runningUid, dirStat) {
  if (runningUid !== 0 || !dirStat) return null;
  if (!Number.isInteger(dirStat.uid) || !Number.isInteger(dirStat.gid) || dirStat.uid === 0) return null;
  return { uid: dirStat.uid, gid: dirStat.gid };
}

async function writeIdentityFileAtomic(realPath, text) {
  const tmp = `${realPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await open(tmp, "w", 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  const runningUid = typeof process.getuid === "function" ? process.getuid() : null;
  const owner = identityOwner(runningUid, await stat(path.dirname(realPath)).catch(() => null));
  if (owner) await chown(tmp, owner.uid, owner.gid);
  try {
    await link(tmp, realPath);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    return false; // someone else won; our freshly generated identity is thrown away, unused
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** In-process guard: concurrent callers for the SAME stateDir, in the SAME
 *  process, share one creation attempt instead of each generating and
 *  racing their own key pair. The link()-based file guard above still
 *  covers the cross-process case; this just avoids doing (and discarding)
 *  the work twice when it is avoidable. */
const creating = new Map();

/** Loads the identity, creating it on first use. Returns the full record
 *  (including the private key material) plus whether THIS call created it --
 *  loadOrCreateIdentity() below strips the private key before returning. */
async function ensureIdentity(stateDir) {
  const existing = await readIdentityFileOrNull(stateDir);
  if (existing) return { identity: existing, created: false };

  const key = path.resolve(stateDir);
  const already = creating.get(key);
  if (already) return already;

  const attempt = (async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const der = publicKey.export({ type: "spki", format: "der" });
    const record = {
      version: DEVICE_IDENTITY_VERSION,
      createdAtUtc: new Date().toISOString(),
      deviceId: deriveDeviceId(der),
      publicKeyPem,
      privateKeyPem,
    };
    const text = `${JSON.stringify(record, null, 2)}\n`;

    if (process.platform === "win32") {
      // NTFS does not honour a POSIX open() mode the way the appliance's own
      // XFS does -- saying so here, loudly, once per creation, rather than
      // claiming a protection that was never actually applied (the brief:
      // "skip loudly on Windows"). This box's private key lives in this file.
      console.error(
        `warning: ${DEVICE_IDENTITY_FILE} could not be created with mode 0600 on Windows; ` +
          "secure this file's NTFS permissions by hand.",
      );
    }
    const won = await writeIdentityFileAtomic(identityPath(stateDir), text);

    // Re-read rather than trust `record`: writeIdentityFileAtomic() may have
    // lost the creation race to a concurrent process, in which case the
    // file on disk now holds THEIR identity, not this one -- and that is
    // the one every later call, in every process, must agree on from here.
    const onDisk = await readIdentityFileOrNull(stateDir);
    if (!onDisk) return refuse("the file disappeared immediately after being written");
    return { identity: onDisk, created: won };
  })();

  creating.set(key, attempt);
  try {
    return await attempt;
  } finally {
    creating.delete(key);
  }
}

/**
 * Loads the box's device identity, creating it on first use.
 * -> Promise<{ deviceId: string, publicKeyPem: string, createdAtUtc: string, created: boolean }>
 * NEVER returns the private key. `created` is true only when THIS call is
 * the one that actually generated the identity now on disk (false for every
 * later call, and false for a call that raced another process and lost).
 */
export async function loadOrCreateIdentity(stateDir) {
  const { identity, created } = await ensureIdentity(stateDir);
  return { deviceId: identity.deviceId, publicKeyPem: identity.publicKeyPem, createdAtUtc: identity.createdAtUtc, created };
}

/**
 * Signs `message` (a Buffer) with the box's device private key, creating
 * the identity first if this is the very first use.
 * -> Promise<Buffer> a 64-byte raw Ed25519 signature.
 * The one function allowed to touch the private key -- and it still never
 * returns the key itself, only a signature over the caller's message.
 */
export async function signWithIdentity(stateDir, message) {
  const { identity } = await ensureIdentity(stateDir);
  return signBytes(null, message, identity.privateKey);
}
