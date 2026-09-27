/**
 * `POST /checkin`: the cloud's side of an NVR's signed health check-in
 * (cloud/CLOUD-API-SPEC.md, "Handlers"; CLOUD-B1-SPEC.md section 6). AWS
 * Lambda / API Gateway HTTP API v2 style: `handler(event, deps)` depends
 * only on injected `deps`, so it runs and is tested with no AWS account and
 * no AWS SDK (cloud/CLOUD-API-SPEC.md's own opening paragraph). No principal
 * is required or checked here -- a box authenticates itself with its
 * Ed25519 signature (`deps.verifySignature`), not a logged-in user.
 *
 * See
 * cloud/CLOUD-API-SPEC.md's "Handlers" section and "Tests that matter" for
 * the full contract, and cloud/harness/apiCheckin.harness.mjs for the checks
 * it must pass -- including real signed Ed25519 envelopes, built the same
 * way cloud/harness/checkinVerify.harness.mjs already does.
 */

/**
 * @typedef {Object} CheckinEvent
 * @property {string} body
 *   The request body, exactly as API Gateway hands it to a Lambda proxy
 *   integration -- always a string. Holds the JSON text of
 *   `{ payload, signature }` (cloud/contracts/checkinVerify.ts's
 *   `CheckinEnvelope`), or that JSON text base64-encoded when
 *   `isBase64Encoded` is `true`.
 * @property {boolean} [isBase64Encoded]
 *   When `true`, `body` is base64 and must be decoded (to UTF-8 text) before
 *   it is parsed as JSON or measured for size (see `MAX_BODY_BYTES` below --
 *   the 64 KB ceiling is on the DECODED payload's byte length, the actual
 *   thing a device sent, not on the base64 text's own larger length).
 */

/**
 * @typedef {Object} CheckinDeps
 * @property {import("./store.mjs").Store} store
 * @property {() => number} nowMs
 *   The cloud's own clock reading, in epoch milliseconds -- passed straight
 *   through to `verifyCheckin`'s `ctx.nowMs` and to `store.acceptCheckin`'s
 *   `atMs`. Called exactly once per request, so a single request sees one
 *   consistent "now" throughout, even though clock-skew and staleness are
 *   both time-sensitive checks.
 * @property {(digestHex: string, signatureB64: string, publicKeyPem: string) => boolean} verifySignature
 *   Passed straight through as `ctx.verifySignature` to
 *   `verifyCheckin` (cloud/contracts/checkinVerify.ts) -- this handler never
 *   calls `node:crypto` itself.
 * @property {(event: CheckinEvent) => (import("../contracts/scope.js").Principal|null)} principalOf
 *   Present on every handler's `deps` for a uniform shape
 *   (cloud/CLOUD-API-SPEC.md, "Handlers": "deps is { store, nowMs(),
 *   verifySignature, principalOf(event), log }"), but UNUSED here: a
 *   check-in is authenticated by its Ed25519 signature, never by a logged-in
 *   principal, so this handler never calls it. (Unlike cloud/api/claim.mjs
 *   and cloud/api/fleet.mjs, which require one.)
 * @property {(entry: CheckinLogEntry) => void} log
 *   Called EXACTLY ONCE per request, after the outcome (accepted or
 *   refused) is known, and never before -- so a request that never finishes
 *   deciding never logs a half-formed entry.
 */

/**
 * The one log line `handler` emits per request (cloud/CLOUD-API-SPEC.md,
 * "Handlers": "one log line per request, with reason and deviceId only").
 * NEVER any other field -- no payload, no signature, no health data, no
 * public key, however deep a debugging temptation goes.
 *
 * @typedef {Object} CheckinLogEntry
 * @property {string|null} reason
 *   `null` on a successful (200) check-in; otherwise the exact refusal
 *   reason string from the status table below (`"malformed"`,
 *   `"too_large"`, `"replay"`, etc.).
 * @property {string|null} deviceId
 *   The check-in's `payload.deviceId` when the body was parseable far
 *   enough to read one, else `null` -- NEVER a fabricated placeholder for
 *   "unknown" (a blank is not a zero, build rule 5). A body that is not even
 *   valid JSON, for instance, logs `deviceId: null`.
 */

/**
 * @typedef {Object} CheckinResponse
 * @property {number} statusCode
 * @property {Record<string,string>} headers
 * @property {string} body
 *   JSON TEXT (via `JSON.stringify`), matching API Gateway's Lambda proxy
 *   integration, which requires `body` to be a string, never a bare object
 *   -- exactly `{"ok":true,"seq":<number>}` on success, or exactly
 *   `{"ok":false,"reason":"<reason>"}` on every refusal, with NO other key
 *   ever present (cloud/CLOUD-API-SPEC.md, "Handlers": "An error body is
 *   { ok: false, reason } and never includes a payload, a signature, a key
 *   or a stack trace").
 */

/** The largest a check-in body may be before it is refused outright, in
 *  bytes of the DECODED payload (after undoing base64, when present) -- a
 *  device sending megabytes of anything is refused before it is even
 *  parsed as JSON. */
export const MAX_BODY_BYTES = 65536;

/**
 * Map a `verifyCheckin` refusal reason (cloud/contracts/checkinVerify.ts)
 * plus this handler's own two body-level refusals (`"too_large"`,
 * `"malformed"` for body text that never reaches `verifyCheckin` at all) to
 * an HTTP status code. Exported so cloud/harness/apiCheckin.harness.mjs can
 * assert against the same table this handler is built from, rather than a
 * second, hand-copied one that could quietly drift.
 *
 * @type {Record<string, number>}
 */
export const CHECKIN_STATUS_BY_REASON = {
  too_large: 413,
  malformed: 400,
  unsupported_version: 400,
  unknown_device: 401,
  bad_signature: 401,
  not_claimed: 403,
  replay: 409,
  clock_skew: 422,
};

/**
 * Handle one `POST /checkin`. Contract, in order:
 *
 * 1. **Decode.** If `event.isBase64Encoded`, base64-decode `event.body` to
 *    UTF-8 text first; otherwise use `event.body` as-is. Measure the
 *    DECODED text's byte length (`Buffer.byteLength(text, "utf8")`); if it
 *    exceeds `MAX_BODY_BYTES`, respond 413 `{ ok: false, reason:
 *    "too_large" }` WITHOUT attempting to parse it as JSON at all (a
 *    64 MB string is not something to hand to `JSON.parse` first), log
 *    `{ reason: "too_large", deviceId: null }`, and return.
 * 2. **Parse.** `JSON.parse` the decoded text. A parse failure responds 400
 *    `{ ok: false, reason: "malformed" }`, logs `{ reason: "malformed",
 *    deviceId: null }`, and returns -- this handler's OWN "malformed", one
 *    step before `verifyCheckin`'s own "malformed" for a body that DID
 *    parse as JSON but is not shaped like a `CheckinEnvelope`.
 * 3. **Extract a deviceId for logging, best-effort.** Read
 *    `parsed?.payload?.deviceId` when it is a string; otherwise `null`. This
 *    value is ONLY for `log`'s `deviceId` field -- it is never trusted for
 *    anything security-relevant before `verifyCheckin` has run.
 * 4. **Build `verifyCheckin`'s ctx and verify.** `ctx.devices` is a `Map`
 *    with AT MOST the one entry for that extracted deviceId (when it is a
 *    string and `deps.store.getDevice(deviceId)` resolves non-null) --
 *    never every device in the store; `ctx.lastSeq` is built the same way
 *    from `deps.store.lastSeqMap([deviceId])` (an empty map when there is no
 *    deviceId to look up yet). `ctx.nowMs = deps.nowMs()`; `ctx.verifySignature
 *    = deps.verifySignature`. Call
 *    `verifyCheckin(parsed, ctx)` (cloud/contracts/checkinVerify.ts).
 * 5. **A refusal from step 4** maps through `CHECKIN_STATUS_BY_REASON`,
 *    responds `{ ok: false, reason }` with that status, logs
 *    `{ reason, deviceId }` (the same best-effort deviceId from step 3 --
 *    `verifyCheckin` never echoes the deviceId back on a refusal, by
 *    design, so this handler cannot read a "more trustworthy" one off its
 *    result), and returns.
 * 6. **On success,** call `deps.store.acceptCheckin(payload.deviceId,
 *    payload.seq, payload, deps.nowMs())`.
 *    - `"stale"` (lost a concurrent race to an equal-or-higher `seq`, per
 *      `Store.acceptCheckin`'s own contract): respond 409
 *      `{ ok: false, reason: "replay" }` -- the SAME status and reason as a
 *      replay caught by `verifyCheckin` itself, so a caller cannot
 *      distinguish "you replayed" from "you raced yourself and lost" --
 *      log `{ reason: "replay", deviceId: payload.deviceId }`, and return.
 *    - `"accepted"`: respond 200 `{ ok: true, seq: payload.seq }`, log
 *      `{ reason: null, deviceId: payload.deviceId }`, and return.
 * 7. **Every response** has `headers: { "content-type": "application/json" }`
 *    and a `body` that is `JSON.stringify`'d text, never a bare object.
 * 8. **`log` is called EXACTLY ONCE**, at the very end of whichever branch
 *    above the request took -- never twice, never zero times, and its
 *    argument NEVER carries any key beyond `reason` and `deviceId` (no
 *    `payload`, no `signature`, no `health`, no public key -- checked
 *    directly by cloud/harness/apiCheckin.harness.mjs across EVERY refusal
 *    reason, not only a couple of examples).
 *
 * @param {CheckinEvent} event
 * @param {CheckinDeps} deps
 * @returns {Promise<CheckinResponse>}
 */
export async function handler(event, deps) {
  const respond = (statusCode, body) => ({
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Every refusal logs exactly once, with only reason and deviceId, and
  // answers { ok, reason } with the status the table assigns.
  const refuse = (reason, deviceId) => {
    deps.log({ reason, deviceId });
    return respond(CHECKIN_STATUS_BY_REASON[reason] ?? 400, { ok: false, reason });
  };

  // 1. Decode (undoing base64 when present), then size-check the DECODED
  // text before any attempt to parse it as JSON.
  const text = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return refuse("too_large", null);
  }

  // 2. Parse. A body that is not JSON at all never reaches verifyCheckin.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("malformed", null);
  }

  // 3. Best-effort deviceId, for the log line ONLY.
  const loggedDeviceId =
    typeof parsed?.payload?.deviceId === "string" ? parsed.payload.deviceId : null;

  // 4. Build verifyCheckin's ctx for this ONE device and verify.
  const { verifyCheckin } = await import("../dist/cloud/contracts/checkinVerify.js");
  const nowMs = deps.nowMs();
  const devices = new Map();
  let lastSeq = new Map();
  if (loggedDeviceId !== null) {
    const device = await deps.store.getDevice(loggedDeviceId);
    if (device != null) {
      devices.set(loggedDeviceId, device);
    }
    lastSeq = (await deps.store.lastSeqMap([loggedDeviceId])) ?? new Map();
  }
  const verdict = await verifyCheckin(parsed, {
    devices,
    lastSeq,
    nowMs,
    verifySignature: deps.verifySignature,
  });

  // 5. A refusal maps through the table; the log carries the step-3
  // deviceId, since verifyCheckin never echoes one back.
  const refusalReason =
    typeof verdict === "string"
      ? verdict
      : verdict && typeof verdict === "object" && verdict.ok === false
        ? (typeof verdict.reason === "string" ? verdict.reason : "malformed")
        : null;
  if (refusalReason !== null) {
    return refuse(refusalReason, loggedDeviceId);
  }

  // 6. Verified: commit through the store. 'stale' (lost a concurrent race)
  // answers exactly like a replay verifyCheckin itself caught.
  const payload = parsed.payload;
  const outcome = await deps.store.acceptCheckin(
    payload.deviceId,
    payload.seq,
    payload,
    nowMs,
  );
  if (outcome === "stale") {
    return refuse("replay", payload.deviceId);
  }

  deps.log({ reason: null, deviceId: payload.deviceId });
  return respond(200, { ok: true, seq: payload.seq });
}
