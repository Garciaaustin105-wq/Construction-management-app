/**
 * The store interface every cloud handler (cloud/api/checkin.mjs,
 * cloud/api/claim.mjs, cloud/api/fleet.mjs) depends on, and that every store
 * implementation must satisfy -- cloud/api/memoryStore.mjs today, a future
 * DynamoDB adapter later, both proven against the same
 * cloud/harness/storeConformance.harness.mjs suite (cloud/CLOUD-API-SPEC.md,
 * "The store interface").
 *
 * JSDOC TYPEDEFS ONLY -- NO CODE. This file is never imported at runtime by
 * anything: it exists purely so `@typedef {import("./store.mjs").Store}
 * Store` (or the individual typedefs below) can be referenced from
 * cloud/api/memoryStore.mjs, cloud/api/checkin.mjs, cloud/api/claim.mjs and
 * cloud/api/fleet.mjs without repeating this shape in four places. See
 * cloud/CLOUD-API-SPEC.md, "The store interface", for the prose contract
 * every method below must satisfy; this file only names the shapes.
 *
 * Two build rules bind every method here (cloud/AGENTS.md):
 *  - "All methods are async, and never throw on 'not found': they return
 *    null or false" -- a missing device, a missing check-in, an unknown
 *    installer's tenancy, are all VALUES (`null`), never a rejection.
 *  - Refuse rather than guess (build rule 10): a caller bug -- a
 *    non-function argument, a malformed device object passed to `putDevice`
 *    -- is allowed to throw or reject; "not found" is not a caller bug.
 */

/**
 * A device's claim lifecycle state, exactly as cloud/contracts/claimCode.ts's
 * `ClaimDevice.state` defines it. Kept as its own typedef here (rather than
 * only inline on `StoreDevice`) so a future store adapter's own types can
 * reference `DeviceState` by name.
 *
 * @typedef {"unclaimed"|"claimed"|"revoked"} DeviceState
 */

/**
 * One device record exactly as the store holds it. A superset of
 * cloud/contracts/claimCode.ts's `ClaimDevice` (`state`, `code`,
 * `codeExpiresMs`, `installerId`) plus the two fields the store alone is
 * responsible for: `deviceId` (the record's own key) and `publicKeyPem` (the
 * Ed25519 key cloud/contracts/checkinVerify.ts's `verifyCheckin` checks a
 * signature against) and `siteId` (which site cloud/api/fleet.mjs must
 * cross-reference against a tenancy tree to decide visibility). NEVER a
 * camera address, a camera credential, or anything from CLOUD-B1-SPEC.md
 * section 6's "must never carry" list -- a device record is identity and
 * claim state only.
 *
 * `siteId` is set once a device is claimed onto a site (CLOUD-B1-SPEC.md
 * section 7 does not fully specify when the siteId is assigned relative to
 * claiming; until that is decided, an unclaimed device's `siteId` MUST be
 * `null`, never a fabricated placeholder -- a blank is not a zero, build
 * rule 5).
 *
 * @typedef {Object} StoreDevice
 * @property {string} deviceId
 * @property {DeviceState} state
 * @property {string} publicKeyPem
 * @property {string|null} code
 * @property {number|null} codeExpiresMs
 * @property {string|null} installerId
 * @property {string|null} siteId
 */

/**
 * The options `putDevice` takes alongside the next device record.
 * `ifState: null` means "must not exist" -- the conditional write succeeds
 * only when there is no stored record for this `deviceId` at all, the shape
 * a first-ever `putDevice` (device provisioning) needs.
 *
 * @typedef {Object} PutDeviceOptions
 * @property {DeviceState|null} ifState
 */

/**
 * `acceptCheckin`'s result: `"accepted"` when this call's `seq` won the race
 * (whether because it was the only call, or because it beat every concurrent
 * caller for the same device), `"stale"` when it lost -- either because
 * `seq` was not greater than the already-stored `lastSeq` at the moment this
 * call actually committed, or because a concurrent call for the same device
 * and an equal-or-higher `seq` committed first. Never anything else.
 *
 * @typedef {"accepted"|"stale"} AcceptCheckinResult
 */

/**
 * The last accepted check-in for one device, exactly as `latestCheckin`
 * returns it (`null` when the device has never had one accepted).
 *
 * @typedef {Object} StoreLatestCheckin
 * @property {number} atMs
 * @property {import("../../contracts/deviceCheckin.js").CheckinPayload} payload
 */

/**
 * The whole ownership tree for one installer, exactly as
 * cloud/contracts/tenancy.ts's `Tenancy` type shapes it. Re-exported by name
 * here (rather than only imported at each call site) so `Store.getTenancy`'s
 * return type is documented next to the rest of the store interface.
 *
 * @typedef {import("../dist/cloud/contracts/tenancy.js").Tenancy} Tenancy
 */

/**
 * The store every cloud handler is written against. Every method is async
 * and NEVER throws on "not found" -- that is always a returned `null` or
 * `false`, never a rejection (a caller bug, such as a non-function
 * `ifState`, a malformed `device` object, or a `deviceIds` argument that is
 * not an array, is the one case each method MAY reject or throw for,
 * build rule 10).
 *
 * `memoryStore.mjs`'s `createMemoryStore()` is one implementation, proven
 * correct by `cloud/harness/storeConformance.harness.mjs`. Any future
 * DynamoDB adapter must pass that exact same suite, unmodified, to be
 * accepted as a drop-in replacement -- the suite is written against this
 * typedef, not against `createMemoryStore`'s internals.
 *
 * @typedef {Object} Store
 *
 * @property {(deviceId: string) => Promise<StoreDevice|null>} getDevice
 *   Returns the stored device record, or `null` when `deviceId` names no
 *   record at all. Never throws for an unknown id.
 *
 * @property {(device: StoreDevice, options: PutDeviceOptions) => Promise<boolean>} putDevice
 *   A conditional write (cloud/CLOUD-API-SPEC.md, "The store interface"):
 *   succeeds -- writes `device` and returns `true` -- only when the
 *   CURRENTLY STORED record's `state` equals `options.ifState`
 *   (`options.ifState === null` matching "no stored record exists yet").
 *   When the condition does not hold (someone else changed the record
 *   between this caller's read and this call, or a record already exists
 *   when `ifState` was `null`), it returns `false` and leaves the stored
 *   record untouched -- it never overwrites on a failed condition, and
 *   never throws for a failed condition. The check-and-write must be
 *   atomic per `device.deviceId`: two concurrent `putDevice` calls for the
 *   same device and the same `ifState` must never both return `true`
 *   (cloud/harness/storeConformance.harness.mjs proves this with
 *   `Promise.all`).
 *
 * @property {(deviceId: string, seq: number, payload: import("../../contracts/deviceCheckin.js").CheckinPayload, atMs: number) => Promise<AcceptCheckinResult>} acceptCheckin
 *   The authoritative replay guard (cloud/CLOUD-API-SPEC.md, "The store
 *   interface"): stores `{ atMs, payload }` as this device's latest
 *   check-in, and remembers `seq` as its new `lastSeq`, ONLY IF `seq` is
 *   strictly greater than the currently stored `lastSeq` for `deviceId` (or
 *   there is no stored `lastSeq` yet, in which case any `seq` is accepted --
 *   cloud/contracts/checkinVerify.ts already enforces `seq >= 1` for that
 *   case upstream; this method itself does not re-check a floor). On
 *   success returns `"accepted"`; when `seq` was not strictly greater,
 *   returns `"stale"` and leaves the stored `lastSeq` and latest check-in
 *   untouched. MUST be atomic per `deviceId`: two concurrent calls for the
 *   same `deviceId` and the same (or either) `seq` must resolve to exactly
 *   one `"accepted"` between them when at most one of the two `seq` values
 *   could have won honestly (cloud/harness/storeConformance.harness.mjs
 *   proves this with `Promise.all`; a real DynamoDB adapter does this with a
 *   conditional update, per cloud/CLOUD-API-SPEC.md).
 *
 * @property {(deviceIds: string[]) => Promise<Map<string, number>>} lastSeqMap
 *   Returns a `Map<deviceId, lastSeq>` covering every id in `deviceIds` that
 *   has ever had an accepted check-in. An id with no accepted check-in yet
 *   is simply ABSENT from the returned map (never present with a value of
 *   `0` -- a blank is not a zero, build rule 5); callers read a missing
 *   entry with `.get(id) ?? undefined` and treat `undefined` as "no prior
 *   seq", exactly as cloud/contracts/checkinVerify.ts's `VerifyCheckinCtx`
 *   already expects.
 *
 * @property {(deviceId: string) => Promise<StoreLatestCheckin|null>} latestCheckin
 *   Returns the most recently ACCEPTED check-in for `deviceId` (the same
 *   `{ atMs, payload }` `acceptCheckin` most recently stored for it), or
 *   `null` when the device has never had one accepted. Never throws for a
 *   device that has never checked in.
 *
 * @property {(code: string) => Promise<StoreDevice|null>} findDeviceByCode
 *   Returns the device record whose CURRENT `code` field exactly equals
 *   `code` (the canonical `"XXXX-XXXX-C"` form
 *   cloud/contracts/claimCode.ts's `parseClaimCode` produces), or `null`
 *   when no stored device currently carries that code -- including a device
 *   whose code has since been consumed (cleared to `null` by a successful
 *   claim) or reissued to a different value. Never throws for an unmatched
 *   code. This lookup does NOT itself check expiry
 *   (`device.codeExpiresMs`) -- that is `cloud/contracts/claimCode.ts`'s
 *   `claimStep`'s job, given the device this method returned.
 *
 * @property {(installerId: string) => Promise<Tenancy|null>} getTenancy
 *   Returns the WHOLE ownership tree for exactly one installer -- NEVER all
 *   installers, and never another installer's orgs, groups, sites or
 *   devices mixed into the result (cloud/CLOUD-API-SPEC.md, "The store
 *   interface"; cloud/harness/storeConformance.harness.mjs's "getTenancy
 *   never returns another installer's data" proves this directly). Returns
 *   `null` when `installerId` names no installer this store holds a tenancy
 *   for -- never an empty-but-present `Tenancy` object standing in for "not
 *   found" (a blank is not a zero, build rule 5).
 */
