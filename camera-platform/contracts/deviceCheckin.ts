/**
 * The signed health check-in a box sends to the cloud (CLOUD-B1-SPEC.md
 * section 6, "how an NVR talks to the cloud", and section 7's phase-1
 * slice: "box identity and telemetry"). Pure: no fs, no clock, no network --
 * the caller (agent/checkin.mjs) measures the box, gets the time, and holds
 * the signing key; this file only shapes what those measurements become and
 * checks a signature over the result.
 *
 * WHAT THIS PAYLOAD MUST NEVER CARRY, EVEN BY ACCIDENT (CLOUD-B1-SPEC.md
 * section 6, "what goes up... is telemetry -- not video", and the B1 phase-1
 * brief verbatim): camera URLs, hosts' credentials, user names, passwords,
 * account data, events, pictures, video, IP addresses of cameras.
 * buildCheckin() enforces this structurally, not by trusting its caller:
 * every field on the output is picked off the input BY NAME, one at a time.
 * There is no `...` spread of caller data anywhere below. A caller that hands
 * buildCheckin() a `facts` object with a stray `password`, `rtspUrl`, or
 * `devicePrivateKeyPem` property -- from a bug two files away, or a fuzzed
 * test on purpose -- gets a payload that simply does not have that property,
 * because nothing here ever reads it by that name. harness/
 * deviceCheckin.harness.mjs's THE FEARED ONE proves exactly this by fuzzing
 * facts with every secret the box holds and grepping the result for them.
 *
 * NO node:crypto HERE, ON PURPOSE, EVEN THOUGH THE BRIEF NAMES verifyCheckin
 * AS PART OF THIS FILE -- A DOCUMENTED DEVIATION. This repo's contracts/ are
 * compiled with tsconfig's `"types": []`, which has no @types/node and
 * cannot resolve `node:crypto` or the `Buffer` type (confirmed by actually
 * running tsc: TS2307 / TS2591). contracts/releaseTrust.ts already keeps
 * node:crypto out for a design reason ("the cryptography belongs where
 * node:crypto lives" -- agent/verify-release.mjs); here it is also a hard
 * build error, not only a preference. So `checkinDigest` below is the
 * CANONICAL JSON TEXT to be signed -- Ed25519 needs no separate pre-hash of
 * its own (agent/verify-release.mjs's whoSigned() and setup/sign-release.mjs
 * already sign/verify raw manifest bytes directly, the same way) -- and the
 * actual signature check, `verifyCheckin(payload, signature, publicKey)`,
 * lives in agent/checkin.mjs instead, where node:crypto is available. It
 * still reuses `canonicalJson` and `checkinDigest` from here, so a future
 * cloud service reusing this contract gets the SAME digest computation
 * either way; only the final `crypto.verify()` call itself is duplicated
 * code, not the part that could drift into disagreeing about what was
 * actually signed.
 */

/** This payload shape's own version, bumped only if a field's meaning ever changes. */
export const CHECKIN_SCHEMA_VERSION = 1;

/** One camera, as the box measured it -- nothing about how to reach it. */
export interface CheckinCameraFact {
  cameraId: string;
  /**
   * Whether the recorder currently has this camera's URL resolved and is
   * attempting to record it. Null when health.json itself could not be
   * read, so "unknown" is never reported as "not recording" (a blank is not
   * a zero).
   */
  recording: boolean | null;
  /** The live detector's worker state for this camera (e.g. "watching"), or
   *  null when detection is not configured for it, or has never reported. */
  detecting: string | null;
  /** The motion gate's cumulative looked/frames share since the detector
   *  last started, in [0, 1], or null when the gate is off or unmeasured. */
  gateShare: number | null;
  /** ISO time the newest sealed segment for this camera ended, or null. */
  lastSealedUtc: string | null;
}

/** One store root, as the box measured it -- never its filesystem path. */
export interface CheckinDriveFact {
  /** Position among the box's reported store roots. Not the path: a path is
   *  not one of the named categories this payload may carry, and reporting
   *  it would expose local layout for no benefit on the cloud side. */
  index: number;
  /** usedBytes / totalBytes, in [0, 1], or null when unmeasured. */
  fillFraction: number | null;
}

export interface CheckinFacts {
  /** The running release's commit (agent/verify-release.mjs's own
   *  installedRelease().version), or null when none is installed (a dev
   *  checkout, or before the first signed release). Never a placeholder
   *  like "dev" standing in for a real one. */
  version: string | null;
  uptimeSec: number;
  cameras: readonly CheckinCameraFact[];
  drives: readonly CheckinDriveFact[];
  /**
   * Whole-box retention, exactly as health.json's own footageHeld() run
   * already computed it (recorder-service.mjs's writeHealth()).
   * Recomputing it here would re-run the segment query only that file's
   * SQLite handle has, and risks a second answer that quietly disagrees
   * with the first.
   */
  footageHeld: {
    hours: number | null;
    basis: string | null;
    refusedReason: string | null;
  };
  detector: {
    capacityFps: number | null;
    minConfidence: number | null;
    motionGateEnabled: boolean | null;
  };
  knownObjects: {
    active: number | null;
    lapsed: number | null;
  };
  /** The newest lastSealedUtc across every camera, or null. Named at top
   *  level per the brief ("time of the last sealed segment"), even though
   *  it is also implicit in `cameras`. */
  lastSealedUtc: string | null;
}

export interface CheckinPayload {
  checkinVersion: typeof CHECKIN_SCHEMA_VERSION;
  deviceId: string;
  /** Monotonically increasing per device; the cloud refuses a seq it has
   *  already seen from this device (CLOUD-B1-SPEC.md section 6). */
  seq: number;
  sentAtUtc: string;
  health: {
    version: string | null;
    uptimeSec: number;
    cameras: CheckinCameraFact[];
    drives: CheckinDriveFact[];
    footageHeld: { hours: number | null; basis: string | null; refusedReason: string | null };
    detector: { capacityFps: number | null; minConfidence: number | null; motionGateEnabled: boolean | null };
    knownObjects: { active: number | null; lapsed: number | null };
    lastSealedUtc: string | null;
  };
}

/** Throws with a message naming only a FIELD, never a VALUE -- so a bad
 *  `facts` object built from real (secret-bearing) box state can never leak
 *  through a validation error, however it was constructed. */
function fail(what: string): never {
  throw new TypeError(`buildCheckin: ${what}`);
}

function asRecord(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) fail(`${what} is not an object`);
  return raw as Record<string, unknown>;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isIsoStringOrNull(x: unknown): x is string | null {
  if (x === null) return true;
  return typeof x === "string" && !Number.isNaN(Date.parse(x));
}

/** A fraction in [0, 1], or null for "not measured". Gate shares, fill
 *  fractions and confidence thresholds are all this same shape. */
function isUnitFractionOrNull(x: unknown): x is number | null {
  if (x === null) return true;
  return isFiniteNumber(x) && x >= 0 && x <= 1;
}

function buildCamera(raw: unknown, i: number): CheckinCameraFact {
  const r = asRecord(raw, `facts.cameras[${i}]`);
  if (typeof r.cameraId !== "string" || r.cameraId.length === 0) fail(`facts.cameras[${i}].cameraId is not a non-empty string`);
  if (r.recording !== null && typeof r.recording !== "boolean") fail(`facts.cameras[${i}].recording is not boolean or null`);
  if (r.detecting !== null && typeof r.detecting !== "string") fail(`facts.cameras[${i}].detecting is not string or null`);
  if (!isUnitFractionOrNull(r.gateShare)) fail(`facts.cameras[${i}].gateShare is not a 0..1 number or null`);
  if (!isIsoStringOrNull(r.lastSealedUtc)) fail(`facts.cameras[${i}].lastSealedUtc is not an ISO string or null`);
  // Field by field, never `...r`: any extra property on `raw` (a url, a
  // password, anything at all) simply never reaches the object below.
  return {
    cameraId: r.cameraId as string,
    recording: (r.recording as boolean | null) ?? null,
    detecting: (r.detecting as string | null) ?? null,
    gateShare: r.gateShare as number | null,
    lastSealedUtc: r.lastSealedUtc as string | null,
  };
}

function buildDrive(raw: unknown, i: number): CheckinDriveFact {
  const r = asRecord(raw, `facts.drives[${i}]`);
  if (!isFiniteNumber(r.index) || r.index < 0 || !Number.isInteger(r.index)) fail(`facts.drives[${i}].index is not a non-negative integer`);
  if (!isUnitFractionOrNull(r.fillFraction)) fail(`facts.drives[${i}].fillFraction is not a 0..1 number or null`);
  return { index: r.index as number, fillFraction: r.fillFraction as number | null };
}

/**
 * Shape a signed check-in payload from measured facts. Pure and total: given
 * well-formed inputs it always returns the same payload for the same
 * arguments; given anything else it throws rather than guessing (build rule
 * 10), with a message that names only a field, never a value.
 *
 * Every array is re-sorted (cameras by cameraId, drives by index) so the
 * payload -- and so its signature -- does not depend on what order the
 * caller happened to iterate its own facts in.
 */
export function buildCheckin(facts: CheckinFacts, opts: { deviceId: string; nowUtc: string; seq: number }): CheckinPayload {
  const f = asRecord(facts as unknown, "facts");
  const o = asRecord(opts as unknown, "opts");

  if (typeof o.deviceId !== "string" || o.deviceId.length === 0) fail("opts.deviceId is not a non-empty string");
  if (typeof o.nowUtc !== "string" || Number.isNaN(Date.parse(o.nowUtc))) fail("opts.nowUtc is not an ISO string");
  if (!Number.isInteger(o.seq) || (o.seq as number) < 0 || !Number.isSafeInteger(o.seq)) fail("opts.seq is not a non-negative safe integer");

  if (f.version !== null && typeof f.version !== "string") fail("facts.version is not a string or null");
  if (!isFiniteNumber(f.uptimeSec) || (f.uptimeSec as number) < 0) fail("facts.uptimeSec is not a non-negative number");
  if (!Array.isArray(f.cameras)) fail("facts.cameras is not an array");
  if (!Array.isArray(f.drives)) fail("facts.drives is not an array");

  const cameras = (f.cameras as unknown[])
    .map(buildCamera)
    .sort((a, b) => (a.cameraId < b.cameraId ? -1 : a.cameraId > b.cameraId ? 1 : 0));
  const drives = (f.drives as unknown[]).map(buildDrive).sort((a, b) => a.index - b.index);

  const fh = asRecord(f.footageHeld, "facts.footageHeld");
  if (fh.hours !== null && !isFiniteNumber(fh.hours)) fail("facts.footageHeld.hours is not a number or null");
  if (fh.basis !== null && typeof fh.basis !== "string") fail("facts.footageHeld.basis is not a string or null");
  if (fh.refusedReason !== null && typeof fh.refusedReason !== "string") fail("facts.footageHeld.refusedReason is not a string or null");

  const det = asRecord(f.detector, "facts.detector");
  if (det.capacityFps !== null && !isFiniteNumber(det.capacityFps)) fail("facts.detector.capacityFps is not a number or null");
  if (!isUnitFractionOrNull(det.minConfidence)) fail("facts.detector.minConfidence is not a 0..1 number or null");
  if (det.motionGateEnabled !== null && typeof det.motionGateEnabled !== "boolean") fail("facts.detector.motionGateEnabled is not boolean or null");

  const ko = asRecord(f.knownObjects, "facts.knownObjects");
  if (ko.active !== null && (!isFiniteNumber(ko.active) || (ko.active as number) < 0)) fail("facts.knownObjects.active is not a non-negative number or null");
  if (ko.lapsed !== null && (!isFiniteNumber(ko.lapsed) || (ko.lapsed as number) < 0)) fail("facts.knownObjects.lapsed is not a non-negative number or null");

  if (!isIsoStringOrNull(f.lastSealedUtc)) fail("facts.lastSealedUtc is not an ISO string or null");

  return {
    checkinVersion: CHECKIN_SCHEMA_VERSION,
    deviceId: o.deviceId as string,
    seq: o.seq as number,
    sentAtUtc: o.nowUtc as string,
    health: {
      version: (f.version as string | null) ?? null,
      uptimeSec: f.uptimeSec as number,
      cameras,
      drives,
      footageHeld: {
        hours: (fh.hours as number | null) ?? null,
        basis: (fh.basis as string | null) ?? null,
        refusedReason: (fh.refusedReason as string | null) ?? null,
      },
      detector: {
        capacityFps: (det.capacityFps as number | null) ?? null,
        minConfidence: (det.minConfidence as number | null) ?? null,
        motionGateEnabled: (det.motionGateEnabled as boolean | null) ?? null,
      },
      knownObjects: {
        active: (ko.active as number | null) ?? null,
        lapsed: (ko.lapsed as number | null) ?? null,
      },
      lastSealedUtc: (f.lastSealedUtc as string | null) ?? null,
    },
  };
}

/**
 * Deterministic JSON: object keys sorted recursively; arrays left in the
 * order given (buildCheckin() already fixed that order, by value, not by
 * whatever order the caller's own facts happened to iterate in). Two
 * payloads equal in value always canonicalize to the same bytes, whatever
 * key order the object that reached JSON.parse happened to carry after a
 * trip over the wire -- which is the property a reproducible signature
 * needs, not merely "JSON.stringify happens to agree with itself".
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The exact text an Ed25519 signature is taken over: the payload's own
 * canonical JSON. A distinct name from `canonicalJson` on purpose, even
 * though today it returns the same string -- callers that mean "I need the
 * thing to sign or check a signature against" should say `checkinDigest`,
 * so if that ever needs to differ from `canonicalJson` (e.g. a length cap,
 * or a real pre-hash once this repo's contracts/ can reach node:crypto)
 * there is exactly one call site per purpose to change, not a naming
 * convention to remember. See this file's top comment for why the actual
 * `crypto.verify()` call is not here.
 */
export function checkinDigest(payload: CheckinPayload): string {
  return canonicalJson(payload);
}
