// agent/checkin.mjs
//
// The box's own half of a signed cloud check-in (CLOUD-B1-SPEC.md section 6;
// B1 phase-1 brief, piece 3, "the sender"). This file does the I/O that
// contracts/deviceCheckin.ts deliberately does not: it reads health.json and
// detect-health.json off disk, asks agent/device-identity.mjs to sign, and
// -- only if a cloud address is actually configured -- makes the one HTTP
// request this whole slice exists to make. Everything about WHAT the
// payload may contain is decided in the contract, not here; this file only
// decides HOW to get it there.
//
// NOTHING IS SENT BY DEFAULT. With no `url`, sendCheckin() does nothing and
// says so (`{ outcome: "no_url" }`) -- this file is never wired into a
// service by this brief, and no config here defaults to a real address.
//
// NO URL, USER NAME OR PASSWORD LEAVES THIS FILE, and none is even READ by
// it. health.json can legitimately hold one: recorder-service.mjs's own
// `unresolved` list carries a raw, UNSCRUBBED resolution-failure `reason`
// that can echo a camera's URL, password included (the same trap
// agent/healthfacts.mjs's own top comment documents for a different reader
// of the same file). readCheckinFacts() below reads `unresolved` only to
// know WHICH camera ids are in it -- .cameraId, never .reason -- and every
// other field it reads off health.json / detect-health.json is picked by
// name, never spread. harness/checkin.harness.mjs's THE FEARED ONE fuzzes
// both files with planted secrets and proves none reach a built payload, a
// camctl output, or a thrown error's message.

import { readFile, rename, open, stat, unlink } from "node:fs/promises";
import { createPublicKey, verify as verifyBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedRelease } from "./verify-release.mjs";
import { buildCheckin, checkinDigest, canonicalJson } from "../dist/deviceCheckin.js";

/** Where the recorder writes its own health snapshot (recorder-service.mjs). */
const HEALTH_FILE = "health.json";
/** Where the live detector writes its own (detect-service.mjs). */
const DETECT_HEALTH_FILE = "detect-health.json";
/** This file's own persisted state: only the next sequence number to use. */
export const CHECKIN_STATE_FILE = "checkin-state.json";
/** How long a check-in POST may take before it is treated as failed. */
export const CHECKIN_TIMEOUT_MS = 10_000;

/**
 * THE RACE THIS GUARDS AGAINST (a reviewer's finding on an earlier version
 * of this file): two overlapping sendCheckin() calls for the SAME stateDir
 * -- one process running it twice at once, or two processes (a manual
 * `camctl checkin` while camplat-checkin.timer also fires) -- could both
 * read-checkin-state.json's seq before either had written it back, both
 * compute the same "next" seq, and both send a check-in carrying it. The
 * cloud's own replay defense (CLOUD-B1-SPEC.md section 6) treats a repeated
 * seq as a replay; the box would not be replaying anything, but would still
 * look like it was.
 *
 * The fix serialises read-seq/write-seq/send as ONE unit per stateDir, two
 * layers deep:
 *  - an in-process promise chain (inProcessChains below), so concurrent
 *    calls in the SAME process queue behind each other for free, no
 *    filesystem contention at all in the common case;
 *  - an exclusive lock file, CHECKIN_LOCK_FILE, created with the 'wx' flag
 *    (fails with EEXIST if it already exists -- that failure IS the lock,
 *    nothing about the file's contents matters), removed in a finally block
 *    once the attempt is done, which is what makes this safe across
 *    SEPARATE processes too, where nothing in this file's own memory is
 *    shared.
 * A lock held far longer than any real attempt could take is assumed to
 * belong to a process that crashed or was killed while holding it, not to a
 * checkin still legitimately in flight, and is broken -- with a logged note
 * naming exactly that -- rather than waited on forever.
 */
export const CHECKIN_LOCK_FILE = "checkin-state.json.lock";
/** CHECKIN_TIMEOUT_MS bounds one real attempt; this sits well above it so a
 *  genuinely in-flight attempt is never mistaken for an abandoned lock. */
export const CHECKIN_LOCK_STALE_MS = 5 * CHECKIN_TIMEOUT_MS;
/**
 * How far AHEAD of the clock a lock file's time may be before it is broken.
 * Found in review (2026-09-23): after the box clock steps back (NTP, an RTC
 * settling after boot) a lock made before the step is dated in the future,
 * its age reads negative, it never looks stale, and every check-in waits on
 * it for good. A minute covers ordinary clock jitter.
 */
export const CHECKIN_LOCK_FUTURE_MS = 60_000;
/** How long a caller retries, polling, for a lock held by a genuinely
 *  in-flight attempt (in another process -- a same-process caller never
 *  finds this loop contended; see withSerializedCheckinState()) before
 *  giving up rather than waiting past all reason. */
export const CHECKIN_LOCK_MAX_WAIT_MS = 3 * CHECKIN_LOCK_STALE_MS;
const CHECKIN_LOCK_POLL_MS = 25;

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The release's own root, one level above agent/ -- the same layout
 *  agent/verify-release.mjs's `--installed <dir>` argument assumes. */
const DEFAULT_APP_DIR = path.join(AGENT_DIR, "..");

async function readJsonFileOrNull(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null; // missing or unreadable: "not written yet", never an error that blocks a checkin
  }
  try {
    return JSON.parse(text);
  } catch {
    return null; // half-written or corrupt: same treatment -- a stale checkin is worse than a thin one
  }
}

/**
 * Reads health.json and detect-health.json off disk and shapes them into
 * contracts/deviceCheckin.ts's CheckinFacts, field by field -- the same
 * discipline buildCheckin() itself uses, so a stray property on either file
 * never becomes part of a checkin. `stateDir` is where both files live
 * (agent/config.mjs's DEFAULT_PATHS.stateDir in production).
 */
export async function readCheckinFacts({ stateDir, appDir = DEFAULT_APP_DIR, uptimeSecFn = () => os.uptime() }) {
  const health = await readJsonFileOrNull(path.join(stateDir, HEALTH_FILE));
  const detectHealth = await readJsonFileOrNull(path.join(stateDir, DETECT_HEALTH_FILE));

  // Only .cameraId out of each `unresolved` entry -- see this file's top
  // comment for why .reason must never be touched.
  const unresolvedIds = new Set(
    Array.isArray(health?.unresolved)
      ? health.unresolved.map((u) => (u && typeof u === "object" ? u.cameraId : null)).filter((id) => typeof id === "string")
      : [],
  );
  const lastSealedByCamera =
    health?.lastSealedUtc && typeof health.lastSealedUtc === "object" && !Array.isArray(health.lastSealedUtc)
      ? health.lastSealedUtc
      : {};
  const cameraIds = Array.isArray(health?.cameraIds) ? health.cameraIds.filter((id) => typeof id === "string") : [];

  const detectByCamera = new Map();
  if (Array.isArray(detectHealth?.cameras)) {
    for (const c of detectHealth.cameras) {
      if (c && typeof c === "object" && typeof c.cameraId === "string") detectByCamera.set(c.cameraId, c);
    }
  }

  const cameras = cameraIds.map((cameraId) => {
    const d = detectByCamera.get(cameraId);
    const share = d?.gate?.sinceStart?.share;
    const sealed = lastSealedByCamera[cameraId];
    return {
      cameraId,
      // health is at least the object we just read it from, so its presence
      // (vs. health.json being entirely unreadable) is what "known at all"
      // means here -- not whether THIS camera individually resolved.
      recording: health ? !unresolvedIds.has(cameraId) : null,
      detecting: typeof d?.state === "string" ? d.state : null,
      gateShare: typeof share === "number" && Number.isFinite(share) ? share : null,
      lastSealedUtc: typeof sealed === "string" ? sealed : null,
    };
  });

  const disks = Array.isArray(health?.disks) ? health.disks : [];
  const drives = disks.map((d, index) => {
    const total = typeof d?.total === "number" ? d.total : null;
    const used = typeof d?.used === "number" ? d.used : null;
    return { index, fillFraction: total !== null && used !== null && total > 0 ? used / total : null };
  });

  const sealedTimes = Object.values(lastSealedByCamera).filter((v) => typeof v === "string");
  // ISO-8601 UTC strings compare lexically in chronological order as long as
  // every writer uses the same precision, which Date#toISOString() does.
  const topLastSealedUtc = sealedTimes.length > 0 ? sealedTimes.reduce((a, b) => (a > b ? a : b)) : null;

  let version = null;
  try {
    version = installedRelease(appDir)?.version ?? null;
  } catch {
    version = null; // installedRelease() already refuses to throw; this is one more layer of "never block a checkin"
  }

  return {
    version,
    uptimeSec: Math.max(0, Math.floor(uptimeSecFn())),
    cameras,
    drives,
    // Reused, not recomputed -- see contracts/deviceCheckin.ts's
    // CheckinFacts.footageHeld doc comment for why.
    footageHeld: {
      hours: typeof health?.retentionHours === "number" ? health.retentionHours : null,
      basis: typeof health?.retentionBasis === "string" ? health.retentionBasis : null,
      refusedReason: typeof health?.retentionRefused === "string" ? health.retentionRefused : null,
    },
    detector: {
      capacityFps: typeof detectHealth?.capacityFps === "number" ? detectHealth.capacityFps : null,
      minConfidence: typeof detectHealth?.minConfidence === "number" ? detectHealth.minConfidence : null,
      motionGateEnabled: typeof detectHealth?.motionGate?.enabled === "boolean" ? detectHealth.motionGate.enabled : null,
    },
    knownObjects: {
      active: typeof detectHealth?.knownObjects?.active === "number" ? detectHealth.knownObjects.active : null,
      lapsed: typeof detectHealth?.knownObjects?.lapsed === "number" ? detectHealth.knownObjects.lapsed : null,
    },
    lastSealedUtc: topLastSealedUtc,
  };
}

/**
 * The whole text flushed to disk before the rename that makes it the file --
 * the same idiom agent/known-objects.mjs's writeFileSynced() uses, for the
 * same reason (a power cut right after a bare rename can leave a zero-length
 * file on XFS, the appliance's own filesystem).
 */
async function writeFileSynced(file, text) {
  const fh = await open(file, "w", 0o644);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * The next sequence number to sign with, read back from disk. A missing
 * file means "never checked in before" (seq starts at 0, so the first
 * checkin sent is seq 1 -- see sendCheckin()). A file that exists but is not
 * a small state file this code wrote is refused, not guessed past: resetting
 * to 0 after real checkins had already reached higher numbers would make
 * every future checkin from this device look like a replay of an old one to
 * the cloud's own defense (CLOUD-B1-SPEC.md section 6), and get refused for
 * real -- exactly the kind of wrong-but-plausible answer build rule 10 says
 * to refuse instead of produce.
 */
export async function readCheckinState(stateDir) {
  let text;
  try {
    text = await readFile(path.join(stateDir, CHECKIN_STATE_FILE), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { kind: "ok", seq: 0 };
    return { kind: "corrupt", reason: `${CHECKIN_STATE_FILE} could not be read (${err.code ?? "error"})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "corrupt", reason: `${CHECKIN_STATE_FILE} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || !Number.isInteger(parsed.seq) || parsed.seq < 0) {
    return { kind: "corrupt", reason: `${CHECKIN_STATE_FILE} does not hold a valid seq` };
  }
  return { kind: "ok", seq: parsed.seq };
}

async function writeCheckinState(stateDir, seq) {
  const file = path.join(stateDir, CHECKIN_STATE_FILE);
  await writeFileSynced(`${file}.tmp`, JSON.stringify({ seq }));
  await rename(`${file}.tmp`, file);
}

/**
 * Acquires the cross-process check-in lock for `stateDir`, waiting out a
 * lock genuinely held by another attempt and breaking one that has clearly
 * outlived any real attempt. Never leaves a stale lock in place silently:
 * breaking one always logs why, naming its age, so a pattern of stale locks
 * (a crashing checkin process, say) shows up somewhere a human will see it.
 */
async function acquireCheckinLock(stateDir, { staleMs = CHECKIN_LOCK_STALE_MS, maxWaitMs = CHECKIN_LOCK_MAX_WAIT_MS } = {}) {
  const lockPath = path.join(stateDir, CHECKIN_LOCK_FILE);
  const waitDeadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.close();
      return lockPath; // acquired
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let ageMs = null;
    try {
      ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
    } catch {
      ageMs = null; // the lock vanished between our open() and this stat(): loop and try again
    }
    const future = ageMs !== null && ageMs < -CHECKIN_LOCK_FUTURE_MS;
    if (ageMs !== null && (ageMs > staleMs || future)) {
      console.error(future
        ? `checkin: breaking a stale lock at ${lockPath} (dated ${Math.round(-ageMs / 1000)}s in the future -- ` +
          `the clock stepped back since it was made)`
        : `checkin: breaking a stale lock at ${lockPath} (held ${Math.round(ageMs / 1000)}s, over the ` +
          `${Math.round(staleMs / 1000)}s timeout) -- assuming the process that created it crashed or was killed`,
      );
      try {
        await unlink(lockPath);
      } catch {
        // someone else broke it first; loop and try to acquire again
      }
      continue;
    }
    if (Date.now() > waitDeadline) {
      const err = new Error(`the check-in lock at ${lockPath} is still held after ${maxWaitMs}ms`);
      err.code = "CHECKIN_LOCK_TIMEOUT";
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, CHECKIN_LOCK_POLL_MS));
  }
}

async function releaseCheckinLock(lockPath) {
  await unlink(lockPath).catch(() => {}); // best-effort: already gone is fine, not an error
}

/** stateDir (resolved) -> a promise that settles once every call queued so
 *  far for it has finished, success or failure -- the in-process half of
 *  the serialisation documented above CHECKIN_LOCK_FILE. */
const inProcessChains = new Map();

/**
 * Runs `fn` as the sole read-seq/write-seq/send attempt for `stateDir` at a
 * time, queued behind any other call for the same stateDir already running
 * in THIS process, and holding the cross-process lock file for the exact
 * span `fn` runs. `fn` is expected to always resolve to an outcome object,
 * never reject (sendCheckin() below only ever throws for its one documented
 * programmer-error case, which is deliberately let through rather than
 * turned into an outcome) -- but even if it did reject, the lock is still
 * released (finally) and the NEXT queued call still gets its turn (a prior
 * call's rejection must never skip the one behind it).
 */
async function withSerializedCheckinState(stateDir, fn, { lockStaleMs, lockMaxWaitMs } = {}) {
  const key = path.resolve(stateDir);
  const prior = inProcessChains.get(key) ?? Promise.resolve();

  async function runLocked() {
    let lockPath;
    try {
      lockPath = await acquireCheckinLock(stateDir, { staleMs: lockStaleMs, maxWaitMs: lockMaxWaitMs });
    } catch (err) {
      return { outcome: "lock_failed", message: `could not acquire the check-in lock: ${err.message}` };
    }
    try {
      return await fn();
    } finally {
      await releaseCheckinLock(lockPath);
    }
  }

  const run = prior.then(runLocked, runLocked);
  inProcessChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * The agent/device-identity.mjs interface this file depends on (built
 * separately -- piece 1 of the same brief this file is piece 3 of).
 * Documented here in full because this file, its exports, and its own
 * harness can all be written and run before agent/device-identity.mjs
 * exists in this checkout (two builders, one checkout; see the brief and
 * the agent-bus note "b1-checkin-split"):
 *
 *   loadOrCreateIdentity(stateDir)
 *     -> Promise<{ deviceId: string, publicKeyPem: string, createdAtUtc: string }>
 *     Creates <stateDir>/device-identity.json on first use, reuses it after.
 *     NEVER returns the private key.
 *   signWithIdentity(stateDir, message: Buffer)
 *     -> Promise<Buffer>  (a 64-byte raw Ed25519 signature)
 *     Loads the identity, including the private key, and signs `message`
 *     with it. The one function allowed to touch the private key -- and it
 *     still never RETURNS the key itself, only a signature.
 *
 * Imported lazily, inside getRealIdentity() rather than at module load, for
 * exactly that reason: importing agent/checkin.mjs (and running its own
 * harness, which always injects a fake `identity`) must not fail just
 * because agent/device-identity.mjs has not landed yet.
 */
async function getRealIdentity() {
  const mod = await import("./device-identity.mjs");
  if (typeof mod.loadOrCreateIdentity !== "function" || typeof mod.signWithIdentity !== "function") {
    throw new Error("agent/device-identity.mjs does not export loadOrCreateIdentity/signWithIdentity as documented in agent/checkin.mjs");
  }
  return { loadOrCreateIdentity: mod.loadOrCreateIdentity, signWithIdentity: mod.signWithIdentity };
}

/**
 * B1 phase-1 LICENCE HOOK. CLOUD-B1-SPEC.md section 4 decides that a lapsed
 * licence must stop every cloud feature, this one included -- but the
 * licence check itself is section 7's slice 3, not built yet, and no format
 * for it exists to check against (the brief: "do not invent a licence
 * format"). This is deliberately the one place that future decision plugs
 * into: swap the `checkLicence` passed to sendCheckin() for the real check
 * when it exists, and nothing else in this file changes. Until then, every
 * box reads as licensed -- this hook existing does not mean checking it does
 * anything yet.
 */
async function defaultLicenceCheck() {
  return { licensed: true };
}

/**
 * Whether `signature` (base64) over `payload` verifies under `publicKey`
 * (SPKI PEM, ed25519). Reuses contracts/deviceCheckin.ts's canonical-JSON
 * digest so this box and a future cloud service can never disagree about
 * WHAT was signed, even though (see that file's top comment) the actual
 * crypto.verify() call has to live here, not there -- contracts/ cannot
 * import node:crypto. Never throws: a malformed key, a malformed signature
 * and a genuine mismatch all simply return false.
 */
export function verifyCheckin(payload, signature, publicKey) {
  if (typeof signature !== "string" || typeof publicKey !== "string") return false;
  let key;
  try {
    key = createPublicKey(publicKey);
  } catch {
    return false;
  }
  if (key.asymmetricKeyType !== "ed25519") return false;
  const sigBytes = Buffer.from(signature, "base64");
  if (sigBytes.length !== 64) return false; // every Ed25519 signature is exactly 64 bytes
  try {
    return verifyBytes(null, Buffer.from(checkinDigest(payload), "utf8"), key, sigBytes);
  } catch {
    return false;
  }
}

/**
 * Builds and signs a check-in without sending it: reads facts, gets (or
 * creates) the device identity, builds the payload, signs it. No network.
 * This is what `camctl checkin --dry-run` calls (see the B1 phase-1 brief's
 * piece 4) -- it prints `canonicalText` and `signature` and sends nothing,
 * because nothing here does either.
 *
 * `identity` is injectable so a harness never needs the real
 * device-identity.mjs on disk; production code (sendCheckin(), or camctl's
 * dry-run) omits it and gets getRealIdentity()'s lazy import.
 */
export async function composeCheckin({ stateDir, now, seq, identity, appDir, uptimeSecFn }) {
  const id = identity ?? (await getRealIdentity());
  const facts = await readCheckinFacts({ stateDir, appDir, uptimeSecFn });
  const deviceIdentity = await id.loadOrCreateIdentity(stateDir);
  const nowUtc = now().toISOString();
  const payload = buildCheckin(facts, { deviceId: deviceIdentity.deviceId, nowUtc, seq });
  const digestText = checkinDigest(payload);
  const signatureBytes = await id.signWithIdentity(stateDir, Buffer.from(digestText, "utf8"));
  const signature = Buffer.isBuffer(signatureBytes) ? signatureBytes.toString("base64") : Buffer.from(signatureBytes).toString("base64");
  return { payload, canonicalText: canonicalJson(payload), signature, deviceId: deviceIdentity.deviceId };
}

/**
 * Sends one check-in, or explains why it did not.
 *
 * With no `url` configured, does nothing and says so -- this brief wires no
 * default address, and no cloud service exists yet to send one to. `url`
 * must be `https://`; `http://` is refused outright, never attempted.
 *
 * `fetchFn` defaults to the global fetch (agent/web-push.mjs's sendPush()
 * uses the same default-injection shape, for the same reason: a harness
 * passes a fake one and never touches the network).
 *
 * @returns {Promise<{outcome: string, status?: number, seq?: number, message?: string}>}
 *   outcome is one of: "no_url" | "bad_url" | "refused_insecure_url" |
 *   "not_licensed" | "lock_failed" | "state_corrupt" | "state_write_failed" |
 *   "compose_failed" | "network_error" | "sent" | "rejected" |
 *   "server_error" | "unexpected_status".
 */
export async function sendCheckin({
  stateDir,
  url,
  fetchFn = globalThis.fetch,
  now = () => new Date(),
  identity,
  appDir,
  uptimeSecFn,
  checkLicence = defaultLicenceCheck,
  timeoutMs = CHECKIN_TIMEOUT_MS,
  lockStaleMs = CHECKIN_LOCK_STALE_MS,
  lockMaxWaitMs = CHECKIN_LOCK_MAX_WAIT_MS,
} = {}) {
  if (!url) {
    return { outcome: "no_url", message: "no cloud check-in address is configured; nothing sent" };
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { outcome: "bad_url", message: "the configured check-in address is not a valid URL; nothing sent" };
  }
  if (parsedUrl.protocol !== "https:") {
    return {
      outcome: "refused_insecure_url",
      message: `refusing to send a check-in over ${parsedUrl.protocol.replace(":", "")}; only https is allowed`,
    };
  }

  let licence;
  try {
    licence = await checkLicence();
  } catch (err) {
    return { outcome: "not_licensed", message: `licence check failed, treated as not licensed: ${err.message}` };
  }
  if (!licence || licence.licensed !== true) {
    return { outcome: "not_licensed", message: "this box is not licensed for cloud features; nothing sent" };
  }

  // Everything from here on -- reading the current seq, persisting the next
  // one, composing and sending -- runs as ONE serialised unit per stateDir
  // (see withSerializedCheckinState() and the comment above
  // CHECKIN_LOCK_FILE for why). Without this, two overlapping calls could
  // both read the same seq before either wrote it back and send duplicates.
  return withSerializedCheckinState(
    stateDir,
    async () => {
      const state = await readCheckinState(stateDir);
      if (state.kind === "corrupt") {
        return { outcome: "state_corrupt", message: state.reason };
      }
      const seq = state.seq + 1;

      // Persisted BEFORE the attempt, not after a 2xx: if the send fails
      // outright this seq is simply never used again (a harmless gap the
      // cloud will see), but if it succeeds and a crash lands between the
      // response and a persist-after-send, retrying with the SAME seq next
      // run would look exactly like a replay to the cloud's own seq-based
      // defense (CLOUD-B1-SPEC.md section 6) and get refused for real.
      // Persisting first means a seq is never reused, full stop.
      try {
        await writeCheckinState(stateDir, seq);
      } catch (err) {
        return { outcome: "state_write_failed", message: `could not persist the check-in sequence number: ${err.message}` };
      }

      let composed;
      try {
        composed = await composeCheckin({ stateDir, now, seq, identity, appDir, uptimeSecFn });
      } catch (err) {
        return { outcome: "compose_failed", seq, message: `could not build the check-in: ${err.message}` };
      }

      if (typeof fetchFn !== "function") {
        throw new Error("no fetch is available; pass fetchFn (this Node has no global fetch)");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-camplat-device-id": composed.deviceId,
            "x-camplat-signature": composed.signature,
          },
          body: composed.canonicalText,
          signal: controller.signal,
        });
      } catch (err) {
        return { outcome: "network_error", seq, message: `could not reach ${parsedUrl.hostname}: ${err.message}` };
      } finally {
        clearTimeout(timer);
      }

      const status = response.status;
      if (status >= 200 && status < 300) return { outcome: "sent", status, seq };
      if (status >= 400 && status < 500) return { outcome: "rejected", status, seq };
      if (status >= 500) return { outcome: "server_error", status, seq };
      return { outcome: "unexpected_status", status, seq };
    },
    { lockStaleMs, lockMaxWaitMs },
  );
}
