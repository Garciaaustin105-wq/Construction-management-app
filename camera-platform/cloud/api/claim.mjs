/**
 * `POST /claim`: an installer_tech taking ownership of a device with a
 * human-typed claim code (cloud/CLOUD-API-SPEC.md, "Handlers"; CLOUD-B1-SPEC.md
 * section 7). AWS Lambda / API Gateway HTTP API v2 style: `handler(event,
 * deps)` depends only on injected `deps`.
 *
 * See
 * cloud/CLOUD-API-SPEC.md's "Handlers" section and "Tests that matter" for
 * the full contract, and cloud/harness/apiClaim.harness.mjs for the checks
 * it must pass.
 */

/**
 * @typedef {Object} ClaimEvent
 * @property {string} body
 *   JSON text of `{ code: string }`, exactly as API Gateway hands a Lambda
 *   proxy integration its request body -- always a string, never
 *   pre-parsed.
 */

/**
 * @typedef {Object} ClaimDeps
 * @property {import("./store.mjs").Store} store
 * @property {() => number} nowMs
 *   Passed straight through as `claimStep`'s `nowMs`
 *   (cloud/contracts/claimCode.ts) -- called exactly once per request.
 * @property {(digestHex: string, signatureB64: string, publicKeyPem: string) => boolean} verifySignature
 *   Present for a uniform `deps` shape across every handler
 *   (cloud/CLOUD-API-SPEC.md, "Handlers"), but UNUSED here -- claiming is
 *   authenticated by the caller's logged-in principal (`deps.principalOf`),
 *   never by a device signature.
 * @property {(event: ClaimEvent) => (import("../contracts/scope.js").Principal|null)} principalOf
 *   The logged-in principal attempting the claim, or `null` when the
 *   request carries no valid session at all. Only an `installer_tech`
 *   principal may claim a device (CLOUD-B1-SPEC.md section 7: claiming is
 *   an installer action). For an `installer_tech`, `principal.scope.kind`
 *   is always `"installer"` and `principal.scope.id` IS that installer's
 *   id (cloud/contracts/scope.ts's own `Principal` contract) -- this
 *   handler passes `principal.scope.id` straight through as `claimStep`'s
 *   `action.installerId`, with no separate installer lookup needed.
 * @property {(entry: ClaimLogEntry) => void} log
 *   Called exactly once per request, after the outcome is known.
 */

/**
 * @typedef {Object} ClaimLogEntry
 * @property {string|null} reason
 *   `null` on a successful (200) claim; otherwise the exact refusal reason
 *   string returned in the response body.
 * @property {string|null} deviceId
 *   The claimed (or attempted) device's id once it is known (after
 *   `findDeviceByCode` resolves one) -- `null` before that point (no
 *   principal, a malformed code, or a code that matched no device at all),
 *   never a fabricated placeholder.
 */

/**
 * @typedef {Object} ClaimResponse
 * @property {number} statusCode
 * @property {Record<string,string>} headers
 * @property {string} body
 *   JSON text -- `{"ok":true,"deviceId":"<id>"}` on success, or
 *   `{"ok":false,"reason":"<reason>"}` on every refusal, never any other
 *   key (cloud/CLOUD-API-SPEC.md, "Handlers").
 */

/**
 * Handle one `POST /claim`. Contract, in order (cloud/CLOUD-API-SPEC.md,
 * "Handlers"):
 *
 * 1. **Principal.** `const principal = deps.principalOf(event);`
 *    - `principal === null` -> 401 `{ ok: false, reason: "no_principal" }`.
 *    - `principal.role !== "installer_tech"` -> 403
 *      `{ ok: false, reason: "installer_only" }` -- checked BEFORE parsing
 *      the body at all: a non-installer's malformed code is still
 *      `installer_only`, not `bad_code` or similar (least information to a
 *      caller who was never allowed to be here regardless of what they
 *      sent).
 *    In both cases, log `{ reason, deviceId: null }` and return.
 * 2. **Parse the body.** `JSON.parse(event.body)`, then read `.code`. A
 *    `JSON.parse` failure, or a parsed body whose `.code` is not a string,
 *    is passed to `parseClaimCode` UNCHANGED (its own contract already
 *    covers "not a string" as `"not_text"` -- this handler does not
 *    special-case a parse failure into a different reason; a body that is
 *    not even valid JSON is treated as `parseClaimCode(undefined)`, i.e.
 *    `"not_text"`, the same 400 path).
 * 3. **`parseClaimCode(code)` (cloud/contracts/claimCode.ts).** Not `ok` ->
 *    400 `{ ok: false, reason: parsed.reason }` (one of `"not_text"`,
 *    `"wrong_length"`, `"bad_symbol"`, `"bad_check"`), log
 *    `{ reason: parsed.reason, deviceId: null }` (no device is known yet),
 *    return.
 * 4. **`deps.store.findDeviceByCode(parsed.code)`.** `null` -> 404
 *    `{ ok: false, reason: "no_such_code" }`, log
 *    `{ reason: "no_such_code", deviceId: null }` (the code matched
 *    nothing, so there IS no device id to log), return. This is
 *    DELIBERATELY the identical response an expired code produces at step 5
 *    -- a prober must not be able to tell "no such code" from "that code
 *    existed but expired" apart.
 * 5. **`claimStep(device, { type: "claim", code: parsed.code, installerId:
 *    principal.scope.id }, deps.nowMs())`** (cloud/contracts/claimCode.ts).
 *    - `reason === "code_expired"` -> 404 `{ ok: false, reason:
 *      "no_such_code" }` (same collapse as step 4), log
 *      `{ reason: "no_such_code", deviceId: device.deviceId }` -- here the
 *      device IS known, so its id is logged even though the response
 *      itself withholds the distinction from the caller.
 *    - any other refusal (`"wrong_state"`, `"code_mismatch"`, `"no_code"`,
 *      `"bad_action"`) -> 409 `{ ok: false, reason }` verbatim, log
 *      `{ reason, deviceId: device.deviceId }`.
 * 6. **`deps.store.putDevice({ ...device, ...claimStepResult.device }, {
 *    ifState: "unclaimed" })`.** `claimStep` returns only the four
 *    `ClaimDevice` fields (state, code, codeExpiresMs, installerId), so they
 *    are laid over the stored record; writing `claimStepResult.device` on
 *    its own would drop `deviceId`, `publicKeyPem` and `siteId`, and the
 *    conditional write could never match. `false` (lost a race: someone else's claim,
 *    revoke or reissue landed first) -> 409
 *    `{ ok: false, reason: "wrong_state" }`, log
 *    `{ reason: "wrong_state", deviceId: device.deviceId }`. This is how
 *    "a code cannot be claimed twice" and "two concurrent claims give
 *    exactly one success" are actually enforced -- `claimStep` itself is
 *    pure and always happy to compute a "claimed" result from a
 *    `device` object read a moment ago; only this conditional write, racing
 *    against another request's, can lose.
 * 7. **Success:** respond 200 `{ ok: true, deviceId: device.deviceId }`,
 *    log `{ reason: null, deviceId: device.deviceId }`.
 * 8. **Every response** has `headers: { "content-type": "application/json" }`
 *    and a `body` that is `JSON.stringify`'d text.
 * 9. **`log` is called exactly once per request.**
 *
 * @param {ClaimEvent} event
 * @param {ClaimDeps} deps
 * @returns {Promise<ClaimResponse>}
 */
export async function handler(event, deps) {
  const { parseClaimCode, claimStep } = await import("../dist/cloud/contracts/claimCode.js");

  const respond = (statusCode, payload) => ({
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const principal = deps.principalOf(event);
  if (principal === null) {
    deps.log({ reason: "no_principal", deviceId: null });
    return respond(401, { ok: false, reason: "no_principal" });
  }
  if (principal.role !== "installer_tech") {
    deps.log({ reason: "installer_only", deviceId: null });
    return respond(403, { ok: false, reason: "installer_only" });
  }

  let code;
  try {
    code = JSON.parse(event.body).code;
  } catch {
    code = undefined;
  }

  const parsed = parseClaimCode(code);
  if (!parsed.ok) {
    deps.log({ reason: parsed.reason, deviceId: null });
    return respond(400, { ok: false, reason: parsed.reason });
  }

  const device = await deps.store.findDeviceByCode(parsed.code);
  if (device === null) {
    deps.log({ reason: "no_such_code", deviceId: null });
    return respond(404, { ok: false, reason: "no_such_code" });
  }

  const step = claimStep(
    device,
    { type: "claim", code: parsed.code, installerId: principal.scope.id },
    deps.nowMs(),
  );
  if (!step.ok) {
    if (step.reason === "code_expired") {
      deps.log({ reason: "no_such_code", deviceId: device.deviceId });
      return respond(404, { ok: false, reason: "no_such_code" });
    }
    deps.log({ reason: step.reason, deviceId: device.deviceId });
    return respond(409, { ok: false, reason: step.reason });
  }

  const written = await deps.store.putDevice({ ...device, ...step.device }, { ifState: "unclaimed" });
  if (written === false) {
    deps.log({ reason: "wrong_state", deviceId: device.deviceId });
    return respond(409, { ok: false, reason: "wrong_state" });
  }

  deps.log({ reason: null, deviceId: device.deviceId });
  return respond(200, { ok: true, deviceId: device.deviceId });
}
