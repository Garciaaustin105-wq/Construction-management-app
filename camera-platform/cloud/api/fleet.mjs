/**
 * `GET /fleet`: the per-device online/late/offline dashboard list for every
 * device a logged-in principal may see (cloud/CLOUD-API-SPEC.md, "Handlers";
 * CLOUD-B1-SPEC.md section 7). AWS Lambda / API Gateway HTTP API v2 style:
 * `handler(event, deps)` depends only on injected `deps`.
 *
 * See cloud/CLOUD-API-SPEC.md's "Handlers" section and "Tests that matter"
 * for the full contract, and cloud/harness/apiFleet.harness.mjs for the
 * checks it must pass -- including the "KNOWN SPEC/CONTRACT GAP" below,
 * which the harness's fakes work around explicitly rather than silently.
 *
 * KNOWN SPEC/CONTRACT GAP -- flagged, not guessed around (build rule 10):
 * cloud/CLOUD-API-SPEC.md says this handler "loads getTenancy(principal's
 * installer)", and `Store.getTenancy` (cloud/api/store.mjs) is keyed by
 * `installerId`. But cloud/contracts/scope.ts's `Principal` type carries an
 * installerId ONLY when `role === "installer_tech"` (whose `scope.kind` is
 * `"installer"` and `scope.id` IS that installerId). cloud/CLOUD-SLICE1-SPEC.md
 * section 3's own "Tests that matter" also requires "a regional manager sees
 * only their group" through this SAME endpoint -- and a `regional_manager`'s
 * `Principal` (`scope: { kind: "group", id } `) names no installer at all;
 * one exists only indirectly, several hops away, through
 * `orgOfSite`/`installerOfSite` (cloud/contracts/tenancy.ts) -- which
 * themselves need a `Tenancy` ALREADY LOADED to walk, the very thing this
 * handler is trying to load in the first place. Nothing in the given
 * contracts resolves that circularity (no store method maps a group, org or
 * site id to an installerId without a `Tenancy` already in hand).
 *
 * This file does not invent a resolution. Instead, it requires `deps.principalOf`
 * to return an `ApiPrincipal` (below): the pure `Principal` PLUS an
 * `installerId` the auth layer is assumed to already know from the caller's
 * session (whatever chain role they hold, a real login already sits inside
 * one specific installer's customer base) -- a fact that belongs to auth,
 * outside cloud/contracts/scope.ts's pure "what can this role do" concern.
 * Whoever wires real auth in must supply it; cloud/harness/apiFleet.harness.mjs's
 * fake `principalOf` supplies it directly, for every role tested including
 * `regional_manager`.
 */

/**
 * The `Principal` (cloud/contracts/scope.ts) plus the one field this
 * handler needs that the pure contract does not carry -- see the file-level
 * "KNOWN SPEC/CONTRACT GAP" comment above.
 *
 * @typedef {import("../contracts/scope.js").Principal & { installerId: string }} ApiPrincipal
 */

/**
 * @typedef {Object} FleetEvent
 *   No query parameters or path parameters are defined by
 *   cloud/CLOUD-API-SPEC.md for this endpoint yet -- the fleet list is
 *   always "every device this principal may see", unfiltered and unpaged.
 *   Kept as its own (currently empty) typedef, rather than reusing
 *   `Record<string, unknown>`, so a future query parameter has a single
 *   place to be added without touching every call site's type.
 */

/**
 * @typedef {Object} FleetDeps
 * @property {import("./store.mjs").Store} store
 * @property {() => number} nowMs
 *   Passed through as `fleetRow`'s (and `fleetStatus`'s) `nowMs`
 *   (cloud/contracts/fleet.ts) -- called exactly once per request, so every
 *   row in one response is judged "online/late/offline" against the same
 *   instant.
 * @property {(digestHex: string, signatureB64: string, publicKeyPem: string) => boolean} verifySignature
 *   Present for a uniform `deps` shape across every handler, but UNUSED
 *   here.
 * @property {(event: FleetEvent) => (ApiPrincipal|null|Promise<ApiPrincipal|null>)} principalOf
 *   See the file-level "KNOWN SPEC/CONTRACT GAP" comment: returns an
 *   `ApiPrincipal` (a `Principal` plus `installerId`), or `null` when the
 *   request carries no valid session. May be async (cloud/CLOUD-LOGIN-SPEC.md
 *   section C: a real `principalFromEvent` reads the session from the store)
 *   -- this handler always `await`s it.
 * @property {(entry: FleetLogEntry) => void} log
 *   Called exactly once per request, after the outcome is known.
 */

/**
 * @typedef {Object} FleetLogEntry
 * @property {string|null} reason
 *   `null` on a successful (200) listing; otherwise the refusal reason.
 * @property {string|null} deviceId
 *   Always `null` for this endpoint -- a fleet LISTING refuses or succeeds
 *   as a whole, never per-device, so there is no single deviceId to
 *   attribute a refusal to. Kept as a field (rather than dropped) only so
 *   `FleetLogEntry`, `ClaimLogEntry` and `CheckinLogEntry` share one shape
 *   across all three handlers.
 */

/**
 * The check-in interval used to classify a device's `FleetStatus`
 * (cloud/contracts/fleet.ts's `fleetStatus`), in milliseconds.
 *
 * KNOWN GAP, per this task's own instructions: "take the real one from
 * agent/checkin.mjs if it declares one." As of this writing,
 * agent/checkin.mjs declares no check-in-SENDING interval constant at all
 * (only `CHECKIN_LOCK_FUTURE_MS = 60_000`, an unrelated future-clock-skew
 * guard for its own file-locking, not how often a box checks in) -- the
 * actual cadence lives in a systemd timer unit (`camplat-checkin.timer`,
 * referenced only in a comment, not a checked-in unit file) outside this
 * repo's tracked files. cloud/CLOUD-API-SPEC.md's own fallback value,
 * "60,000, the box's check-in interval", is used here unchanged. If a real
 * timer unit or an exported constant is added to agent/checkin.mjs later,
 * this constant must be updated to match it, and this comment deleted.
 *
 * @type {number}
 */
export const CHECKIN_INTERVAL_MS = 60000;

/**
 * @typedef {Object} FleetResponse
 * @property {number} statusCode
 * @property {Record<string,string>} headers
 * @property {string} body
 *   JSON text -- `{"ok":true,"rows":[...]}` on success (each row exactly
 *   cloud/contracts/fleet.ts's `FleetRow`), or
 *   `{"ok":false,"reason":"<reason>"}` on refusal, never any other key.
 */

/**
 * Handle one `GET /fleet`. Contract, in order (cloud/CLOUD-API-SPEC.md,
 * "Handlers"):
 *
 * 1. **Principal.** `const principal = await deps.principalOf(event);` --
 *    always awaited (`principalOf` may be async; a synchronous fake still
 *    works). `principal === null` -> 401
 *    `{ ok: false, reason: "no_principal" }`, log
 *    `{ reason: "no_principal", deviceId: null }`, return.
 * 2. **`deps.store.getTenancy(principal.installerId)`.** `null` (no tenancy
 *    on file for that installer at all) -> 404
 *    `{ ok: false, reason: "no_tenancy" }`, log
 *    `{ reason: "no_tenancy", deviceId: null }`, return. (Not one of
 *    "Tests that matter"'s named cases, but required so this handler never
 *    throws or returns malformed JSON for a principal whose installer has
 *    no tenancy loaded yet -- refuse rather than guess, build rule 10.)
 * 3. **`visibleSites(tenancy, principal)`** (cloud/contracts/scope.ts) --
 *    called with the PLAIN `Principal` fields (`userId`, `role`, `scope`);
 *    `principal.installerId` is never passed to it, since `visibleSites`'s
 *    own contract does not accept or need one. This is what actually scopes
 *    the result: an `installer_tech` principal's `scope.kind` is
 *    `"installer"` and gets every site under every org that installer owns;
 *    a `regional_manager`'s `scope.kind` is `"group"` and gets only that
 *    group's sites; and so on for every role `visibleSites` documents.
 * 4. **Gather devices.** For every `{ deviceId, siteId }` in
 *    `tenancy.devices` whose `siteId` is in the set from step 3, look up
 *    `deps.store.getDevice(deviceId)`. A `deviceId` present in the tenancy
 *    tree but absent from the store (a caller bug in whatever populated
 *    the tenancy, or a device deleted from the store but not yet removed
 *    from the tree) is SKIPPED -- never fabricated as a row with made-up
 *    `state` (a blank is not a zero, build rule 5) -- and this is not an
 *    error worth refusing the whole request over.
 *    A store record whose `installerId` is not EXACTLY
 *    `principal.installerId` is SKIPPED too -- claimed by (or revoked
 *    from) another installer, or unclaimed (`null`). The store record is
 *    the authority on who owns a device; the tenancy tree only says where
 *    it is placed. If the two ever disagree, the row is withheld rather
 *    than leaking one installer's device and health to another.
 * 5. **For each surviving device,** `deps.store.latestCheckin(deviceId)`,
 *    then `fleetRow(device, lastAccepted, deps.nowMs(),
 *    CHECKIN_INTERVAL_MS)` (cloud/contracts/fleet.ts) -- `lastAccepted ===
 *    null` for a device that has never checked in produces `status:
 *    "never"` (`fleetRow` -> `fleetStatus`'s own contract), never
 *    `"offline"`.
 * 6. **Sort** the resulting rows by `deviceId`, ascending, as plain
 *    strings (`Array.prototype.sort()`'s default comparator, since
 *    `deviceId` is always a string).
 * 7. **Respond** 200 `{ ok: true, rows }`, log
 *    `{ reason: null, deviceId: null }`.
 * 8. **Scope leakage.** No device outside the sites `visibleSites` returned
 *    in step 3 may EVER appear in `rows` -- not filtered out after the
 *    fact, but never fetched from the store in the first place (step 4
 *    iterates only `tenancy.devices` entries whose `siteId` passed the
 *    step-3 check). cloud/harness/apiFleet.harness.mjs builds a tenancy with
 *    devices on sites BOTH inside and outside the tested principal's scope
 *    and asserts the out-of-scope ones never appear, by id, anywhere in the
 *    response body text.
 * 9. **Every response** has `headers: { "content-type": "application/json" }`
 *    and a `body` that is `JSON.stringify`'d text.
 * 10. **`log` is called exactly once per request.**
 *
 * @param {FleetEvent} event
 * @param {FleetDeps} deps
 * @returns {Promise<FleetResponse>}
 */
export async function handler(event, deps) {
  const principal = await deps.principalOf(event);
  if (principal == null) {
    deps.log({ reason: "no_principal", deviceId: null });
    return {
      statusCode: 401,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, reason: "no_principal" }),
    };
  }

  const tenancy = await deps.store.getTenancy(principal.installerId);
  if (tenancy == null) {
    deps.log({ reason: "no_tenancy", deviceId: null });
    return {
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, reason: "no_tenancy" }),
    };
  }

  const { visibleSites } = await import("../dist/cloud/contracts/scope.js");
  const { fleetRow } = await import("../dist/cloud/contracts/fleet.js");

  // visibleSites takes the PLAIN Principal (userId, role, scope) -- the
  // auth-supplied `installerId` extension is never passed on to it.
  const plainPrincipal = {
    userId: principal.userId,
    role: principal.role,
    scope: principal.scope,
  };
  const visible = new Set(await visibleSites(tenancy, plainPrincipal));

  const nowMs = deps.nowMs();
  const rows = [];
  for (const { deviceId, siteId } of tenancy.devices ?? []) {
    if (!visible.has(siteId)) continue;
    const device = await deps.store.getDevice(deviceId);
    if (device == null) continue;
    if (device.installerId !== principal.installerId) continue;
    const lastAccepted = await deps.store.latestCheckin(deviceId);
    rows.push(await fleetRow(device, lastAccepted, nowMs, CHECKIN_INTERVAL_MS));
  }
  rows.sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));

  deps.log({ reason: null, deviceId: null });
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, rows }),
  };
}
