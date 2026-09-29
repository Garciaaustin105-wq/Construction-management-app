/**
 * `POST /enroll`: a box introducing itself and getting back a claim code
 * (cloud/CLOUD-LOOP-SPEC.md section B). AWS Lambda / API Gateway HTTP API v2
 * style: `handler(event, deps)` depends only on injected `deps`, so it runs
 * and is tested with no AWS account and no AWS SDK, exactly like
 * cloud/api/checkin.mjs, cloud/api/claim.mjs and cloud/api/fleet.mjs. No
 * principal is required or checked here -- a box authenticates itself with
 * its Ed25519 signature (`deps.verifySignature`), not a logged-in user,
 * exactly as `/checkin` does.
 *
 * See cloud/CLOUD-LOOP-SPEC.md section B for the full contract, and
 * cloud/harness/apiEnroll.harness.mjs for the checks it must pass --
 * including real signed Ed25519 envelopes, built the same way
 * cloud/harness/enroll.harness.mjs and cloud/harness/apiCheckin.harness.mjs
 * already do.
 *
 * IMPLEMENTATION NOTE for whoever builds this handler: dynamically import
 * the compiled contracts INSIDE the handler body, exactly the way
 * cloud/api/checkin.mjs imports `verifyCheckin` and cloud/api/claim.mjs
 * imports `parseClaimCode`/`claimStep` --
 *   `const { verifyEnrollment } = await import("../dist/cloud/contracts/enroll.js");`
 *   `const { formatClaimCode, claimStep } = await import("../dist/cloud/contracts/claimCode.js");`
 * never a static top-level import of a compiled contract (this file, like
 * its siblings, is plain ESM and must load even before `tsc` has run once).
 *
 * `verifyEnrollment`'s `ctx` needs a `deviceIdOf(publicKeyPem)` function,
 * but `EnrollDeps` below (cloud/CLOUD-LOOP-SPEC.md section B's own list)
 * carries no such field -- deriving a deviceId from a public key needs only
 * `node:crypto`, which THIS file (plain ESM, unlike contracts/) can import
 * directly, exactly the way `agent/device-identity.mjs` already does:
 * `deviceId = base32(sha256(publicKey SPKI DER)[0:16])`. This handler must
 * use that SAME derivation (not reinvent one), or a genuine box's own
 * `payload.deviceId` would fail `bad_device_id` against the cloud's
 * disagreeing answer. It is computed here, not injected, because it is a
 * fixed function of its input, never something a caller legitimately needs
 * to fake.
 */

/**
 * @typedef {Object} EnrollEvent
 * @property {string} body
 *   The request body, exactly as API Gateway hands it to a Lambda proxy
 *   integration -- always a string. Holds the JSON text of
 *   `{ payload, signatureB64 }` (cloud/contracts/enroll.ts's
 *   `EnrollEnvelope`). Unlike cloud/api/checkin.mjs's `CheckinEvent`, there is
 *   no base64/`isBase64Encoded` handling or body-size ceiling in this
 *   contract -- cloud/CLOUD-LOOP-SPEC.md section B names none, so this
 *   handler does not invent one.
 */

/**
 * @typedef {Object} EnrollDeps
 * @property {import("./store.mjs").Store} store
 * @property {() => number} nowMs
 *   The cloud's own clock reading, in epoch milliseconds -- passed straight
 *   through to `verifyEnrollment`'s `ctx.nowMs` and used to compute
 *   `codeExpiresMs = nowMs() + CLAIM_CODE_TTL_MS`. Called exactly once per
 *   request, so a single request sees one consistent "now" throughout.
 * @property {(message: string, signatureB64: string, publicKeyPem: string) => boolean} verifySignature
 *   Passed straight through as `ctx.verifySignature` to `verifyEnrollment`
 *   (cloud/contracts/enroll.ts) -- this handler never calls `node:crypto`
 *   itself.
 * @property {(n: number) => number[]} randomValues
 *   Returns `n` fresh random integers, each in `0..31` -- the exact shape
 *   `formatClaimCode` (cloud/contracts/claimCode.ts) needs for its `values`
 *   argument. Always called as `randomValues(8)` here. Injected (rather than
 *   this handler calling `node:crypto` directly) so a harness can hand it a
 *   deterministic sequence and assert on the exact resulting claim code.
 * @property {boolean} allowOpenEnrollment
 *   Passed straight through as `ctx.allowOpenEnrollment` to `verifyEnrollment`.
 *   `true` only on a dev server (cloud/CLOUD-LOOP-SPEC.md section D);
 *   production enrolment needs the factory claim certificate, which does not
 *   exist yet (build rule 10: refuse rather than guess).
 * @property {number} maxSkewMs
 *   Passed straight through as `ctx.maxSkewMs` to `verifyEnrollment`.
 * @property {(entry: EnrollLogEntry) => void} log
 *   Called EXACTLY ONCE per request, after the outcome (accepted, already
 *   claimed, or refused) is known, and never before -- so a request that
 *   never finishes deciding never logs a half-formed entry.
 */

/**
 * The one log line `handler` emits per request. NEVER any other field -- no
 * payload, no signature, no public key, and, above every other field here,
 * NEVER THE CLAIM CODE -- however deep a debugging temptation goes. A claim
 * code is a bearer secret an installer types in; it belongs in the response
 * body handed to the box that just proved its identity, and nowhere else.
 *
 * @typedef {Object} EnrollLogEntry
 * @property {string|null} reason
 *   `null` on any successful (200) outcome -- a fresh or reissued code, or an
 *   already-claimed device learning `claimed: true`; otherwise the exact
 *   refusal reason string (one of `EnrollVerifyReason` from
 *   cloud/contracts/enroll.ts, or this handler's own `"wrong_state"` /
 *   `"key_mismatch"`).
 * @property {string|null} deviceId
 *   `null` UNTIL VERIFIED -- that is, for every refusal that
 *   `verifyEnrollment` itself produces (`enrollment_closed`, `malformed`,
 *   `bad_device_id`, `clock_skew`, `bad_signature`), `deviceId` is `null`,
 *   even though a `malformed` or `bad_device_id` body may have carried a
 *   `payload.deviceId` string -- unlike cloud/api/checkin.mjs's best-effort
 *   deviceId, this handler never logs an UNVERIFIED deviceId (an attacker
 *   who does not hold the matching private key must not get their claimed
 *   deviceId written to the log at all). Once `verifyEnrollment` returns
 *   `{ ok: true, deviceId }`, every log line from that point on (including
 *   `"wrong_state"` and `"key_mismatch"`, and every success) carries that
 *   verified deviceId.
 */

/**
 * @typedef {Object} EnrollResponse
 * @property {number} statusCode
 * @property {Record<string,string>} headers
 * @property {string} body
 *   JSON TEXT (via `JSON.stringify`), matching API Gateway's Lambda proxy
 *   integration -- one of:
 *   - a refusal: exactly `{"ok":false,"reason":"<reason>"}`;
 *   - already claimed: exactly `{"ok":true,"claimed":true,"claimCode":null,"expiresUtc":null}`;
 *   - a fresh or reissued code: exactly `{"ok":true,"claimed":false,"claimCode":"<code>","expiresUtc":"<iso>"}`.
 *   No other key is ever present, on any outcome.
 */

/** How long a freshly issued (or reissued) claim code stays valid before it
 *  expires, in milliseconds -- 24 hours (cloud/CLOUD-LOOP-SPEC.md section B).
 *  The unit lives in the name (build rule 6: every quantity carries its
 *  unit) precisely so a future reader is never left guessing whether this
 *  number is seconds, milliseconds, or hours. */
export const CLAIM_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Handle one `POST /enroll`. Contract, in order (cloud/CLOUD-LOOP-SPEC.md
 * section B):
 *
 * 1. **Parse and verify.** `JSON.parse(event.body)`; a parse failure is
 *    treated exactly like `verifyEnrollment`'s own `"malformed"` -- both give
 *    400 `{ ok: false, reason: "malformed" }` -- so a body that never even
 *    reaches `verifyEnrollment` still answers through the same table as one
 *    that does. Otherwise call
 *    `verifyEnrollment(parsed, { nowMs: deps.nowMs(), maxSkewMs:
 *    deps.maxSkewMs, allowOpenEnrollment: deps.allowOpenEnrollment,
 *    deviceIdOf, verifySignature: deps.verifySignature })`
 *    (cloud/contracts/enroll.ts), where `deviceIdOf` is THIS handler's own
 *    `node:crypto`-backed function (see the IMPLEMENTATION NOTE above) --
 *    not one of `EnrollDeps`'s fields.
 *    - `"enrollment_closed"` -> 403 `{ ok: false, reason: "enrollment_closed" }`.
 *    - every other `verifyEnrollment` refusal, and this handler's own parse
 *      failure -> 400 `{ ok: false, reason }`.
 *    - Every refusal here logs `{ reason, deviceId: null }` (deviceId is
 *      unverified at this point -- see `EnrollLogEntry`) and returns.
 * 2. **Verified.** `verifyEnrollment` returned `{ ok: true, deviceId,
 *    publicKeyPem }`. Look up `deps.store.getDevice(deviceId)`:
 *    - **`null` (no stored record at all)** -> generate a fresh code:
 *      `formatClaimCode(deps.randomValues(8))` (cloud/contracts/claimCode.ts),
 *      `codeExpiresMs = deps.nowMs() + CLAIM_CODE_TTL_MS`,
 *      `expiresAtS = Math.ceil(codeExpiresMs / 1000)` (cloud/CLOUD-LOGIN-SPEC.md
 *      section D -- store.mjs's DynamoDB TTL guard rail on every unclaimed
 *      record), then `deps.store.putDevice({ deviceId, state: "unclaimed",
 *      publicKeyPem, code, codeExpiresMs, expiresAtS, installerId: null,
 *      siteId: null }, { ifState: null })`. A `false` result (another
 *      enrolment of the same box won a concurrent race) -> 409
 *      `{ ok: false, reason: "wrong_state" }`, log
 *      `{ reason: "wrong_state", deviceId }` -- the box is expected to
 *      retry, which lands it in the "same key, unclaimed" branch below.
 *    - **a stored record exists and its `publicKeyPem` differs from the
 *      verified `publicKeyPem`** -> 409 `{ ok: false, reason: "key_mismatch"
 *      }`, log `{ reason: "key_mismatch", deviceId }`. A stored key is NEVER
 *      replaced by this handler, under any circumstance.
 *    - **same key, stored `state` is `"unclaimed"` or `"revoked"`** ->
 *      `claimStep(device, { type: "reissue", code: formatClaimCode(deps.randomValues(8)),
 *      codeExpiresMs: deps.nowMs() + CLAIM_CODE_TTL_MS })`
 *      (cloud/contracts/claimCode.ts) always succeeds from either state (its
 *      own contract), then `deps.store.putDevice({ ...device, ...step.device,
 *      expiresAtS, siteId: null }, { ifState: <the state `device` was in when
 *      read above>, ifCode: <the code `device` held when read above> })`,
 *      where `expiresAtS` is recomputed from THIS reissue's own
 *      `codeExpiresMs`, never carried over from the record's previous value.
 *      `siteId: null` because an unclaimed device never keeps a site
 *      (store.mjs). `ifCode` because a re-issue leaves the state
 *      `"unclaimed"`, so `ifState` alone would let two racing re-enrols both
 *      win with different codes while the store kept only one -- a
 *      plausible-looking dead code (review finding, 2026-09-27).
 *      Re-enrolling always yields a fresh, unexpired code. A `false` from
 *      this `putDevice` (lost a concurrent race to another enrol, claim or
 *      revoke of the same device landing first) is inferred to mean the
 *      same `409 { ok: false, reason: "wrong_state" }` as the "no stored
 *      record" branch above -- cloud/CLOUD-LOOP-SPEC.md section B does not
 *      spell this particular race out, but every other conditional write in
 *      this codebase (cloud/api/claim.mjs step 6) maps a lost race to
 *      `wrong_state`, and build rule 10 says refuse rather than guess at a
 *      DIFFERENT, invented status for the same shape of failure.
 *    - **same key, stored `state` is `"claimed"`** -> 200
 *      `{ ok: true, claimed: true, claimCode: null, expiresUtc: null }` --
 *      the box learns it is already owned, with no code at all (there is
 *      nothing left to claim).
 * 3. **Success (fresh or reissued code).** 200
 *    `{ ok: true, claimed: false, claimCode, expiresUtc: new
 *    Date(codeExpiresMs).toISOString() }`.
 * 4. **Every response** has `headers: { "content-type": "application/json" }`
 *    and a `body` that is `JSON.stringify`'d text, never a bare object.
 * 5. **`log` is called EXACTLY ONCE**, at the very end of whichever branch
 *    above the request took -- never twice, never zero times. **The claim
 *    code is never logged, on any branch, on any outcome** -- checked
 *    directly by cloud/harness/apiEnroll.harness.mjs across every code path
 *    that ever generates or reissues one.
 *
 * @param {EnrollEvent} event
 * @param {EnrollDeps} deps
 * @returns {Promise<EnrollResponse>}
 */
export async function handler(event, deps) {
  const respond = (statusCode, payload) => ({
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  // 1) Parse the envelope. A body that never parses is answered exactly like
  // verifyEnrollment's own "malformed" refusal: 400, logged with a null
  // (unverified) deviceId.
  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    deps.log({ reason: "malformed", deviceId: null });
    return respond(400, { ok: false, reason: "malformed" });
  }

  // This handler's OWN deviceId derivation -- the same one
  // agent/device-identity.mjs uses: base32(sha256(publicKey SPKI DER)[0:16]).
  const { createHash, createPublicKey } = await import("node:crypto");
  const base32 = (bytes) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let acc = 0;
    let bits = 0;
    let out = "";
    for (const byte of bytes) {
      acc = (acc << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += alphabet[(acc >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
    return out;
  };
  // null for an unparseable key AND for any key that is not Ed25519: boxes
  // only ever hold Ed25519 (agent/device-identity.mjs refuses anything else),
  // so an RSA key that self-derives a matching id is still not a box.
  const deviceIdOf = (publicKeyPem) => {
    let key;
    try { key = createPublicKey(publicKeyPem); } catch { return null; }
    if (key.asymmetricKeyType !== "ed25519") return null;
    const spkiDer = key.export({ type: "spki", format: "der" });
    return base32(createHash("sha256").update(spkiDer).digest().subarray(0, 16));
  };

  const { verifyEnrollment } = await import("../dist/cloud/contracts/enroll.js");
  const { formatClaimCode, claimStep } = await import("../dist/cloud/contracts/claimCode.js");

  // One consistent "now" for the whole request: deps.nowMs is called exactly
  // once, and its single reading drives both verification and code expiry.
  const nowMs = deps.nowMs();

  const verified = await verifyEnrollment(parsed, {
    nowMs,
    maxSkewMs: deps.maxSkewMs,
    allowOpenEnrollment: deps.allowOpenEnrollment,
    deviceIdOf,
    verifySignature: deps.verifySignature,
  });

  if (!verified.ok) {
    const statusCode = verified.reason === "enrollment_closed" ? 403 : 400;
    deps.log({ reason: verified.reason, deviceId: null });
    return respond(statusCode, { ok: false, reason: verified.reason });
  }

  const deviceId = verified.deviceId;
  const publicKeyPem = verified.publicKeyPem;
  const device = await deps.store.getDevice(deviceId);

  if (device == null) {
    const code = await formatClaimCode(deps.randomValues(8));
    const codeExpiresMs = nowMs + CLAIM_CODE_TTL_MS;
    // expiresAtS: the DynamoDB TTL guard rail on every unclaimed record
    // (cloud/CLOUD-LOGIN-SPEC.md section D) -- epoch seconds, ceiling-rounded
    // from codeExpiresMs so the TTL never fires a moment before the code
    // itself actually expires.
    const expiresAtS = Math.ceil(codeExpiresMs / 1000);
    const record = { deviceId, state: "unclaimed", publicKeyPem, code, codeExpiresMs, expiresAtS, installerId: null, siteId: null };
    const stored = await deps.store.putDevice(record, { ifState: null });
    if (stored === false) {
      deps.log({ reason: "wrong_state", deviceId });
      return respond(409, { ok: false, reason: "wrong_state" });
    }
    deps.log({ reason: null, deviceId });
    return respond(200, {
      ok: true,
      claimed: false,
      claimCode: code,
      expiresUtc: new Date(codeExpiresMs).toISOString(),
    });
  }

  if (device.publicKeyPem !== publicKeyPem) {
    deps.log({ reason: "key_mismatch", deviceId });
    return respond(409, { ok: false, reason: "key_mismatch" });
  }

  if (device.state === "unclaimed" || device.state === "revoked") {
    const ifState = device.state;
    const code = await formatClaimCode(deps.randomValues(8));
    const codeExpiresMs = nowMs + CLAIM_CODE_TTL_MS;
    // Same TTL guard rail as a brand-new device's record: a reissue always
    // recomputes expiresAtS from the NEW codeExpiresMs, never keeps the old one.
    const expiresAtS = Math.ceil(codeExpiresMs / 1000);
    const step = await claimStep({ ...device }, { type: "reissue", code, codeExpiresMs });
    const stored = await deps.store.putDevice({ ...device, ...step.device, expiresAtS, siteId: null }, { ifState, ifCode: device.code });
    if (stored === false) {
      deps.log({ reason: "wrong_state", deviceId });
      return respond(409, { ok: false, reason: "wrong_state" });
    }
    deps.log({ reason: null, deviceId });
    return respond(200, {
      ok: true,
      claimed: false,
      claimCode: code,
      expiresUtc: new Date(codeExpiresMs).toISOString(),
    });
  }

  // state "claimed": the box learns it is already owned; the stored record is
  // left untouched and there is no code left to hand out.
  deps.log({ reason: null, deviceId });
  return respond(200, { ok: true, claimed: true, claimCode: null, expiresUtc: null });
}
