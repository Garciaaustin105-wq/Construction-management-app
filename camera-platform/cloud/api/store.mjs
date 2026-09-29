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
 * `expiresAtS` (CLOUD-LOGIN-SPEC.md, "B. Store additions") is epoch seconds,
 * set on an unclaimed record (`Math.ceil(codeExpiresMs / 1000)`) so a
 * DynamoDB adapter can attach it as that record's TTL attribute, and cleared
 * to `null` the moment a claim (or a revoke) lands. A record written before
 * this field existed reads back WITHOUT the key at all; every `Store`
 * implementation must normalize that absence to `null` on the way out --
 * never `undefined`, and never `0` (a blank is not a zero, build rule 5;
 * `0` would additionally read as "already expired").
 *
 * @typedef {Object} StoreDevice
 * @property {string} deviceId
 * @property {DeviceState} state
 * @property {string} publicKeyPem
 * @property {string|null} code
 * @property {number|null} codeExpiresMs
 * @property {string|null} installerId
 * @property {string|null} siteId
 * @property {number|null} expiresAtS
 */

/**
 * The options `putDevice` takes alongside the next device record.
 * `ifState: null` means "must not exist" -- the conditional write succeeds
 * only when there is no stored record for this `deviceId` at all, the shape
 * a first-ever `putDevice` (device provisioning) needs.
 *
 * `ifCode` (optional) makes it a compare-and-swap on the claim code too: when
 * present (anything but `undefined`), the write ALSO requires the stored
 * record's current `code` to equal `ifCode` exactly (`null` matches only a
 * stored `null`). A write that leaves `state` unchanged -- re-issuing a claim
 * code keeps a device `"unclaimed"` -- can only be made race-safe this way:
 * `ifState` alone would still match after a concurrent writer committed, and
 * both callers would be told they won (reviewer's finding, 2026-09-27).
 * A DynamoDB adapter does the same with a condition on both attributes.
 *
 * @typedef {Object} PutDeviceOptions
 * @property {DeviceState|null} ifState
 * @property {string|null} [ifCode]
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
 * One installer's tenancy tree together with its optimistic-concurrency
 * version, exactly as `getTenancyRecord` returns it and `putTenancy` guards
 * writes with (CLOUD-LOGIN-SPEC.md, "B. Store additions"). `version` starts
 * at `1` for a seeded tenancy and at `1` for the first `putTenancy` write
 * that creates one (`(ifVersion ?? 0) + 1` with `ifVersion: null`), and
 * increments by exactly one on every successful `putTenancy` after that.
 *
 * @typedef {Object} TenancyRecord
 * @property {Tenancy} tenancy
 * @property {number} version
 */

/**
 * `putTenancy`'s options. `ifVersion: null` means "create; refuse if a
 * tenancy is already stored for this installerId." A number means "replace
 * only if the CURRENTLY STORED version is exactly this" (optimistic
 * concurrency, the same shape as `PutDeviceOptions.ifState` above, but on a
 * version counter rather than a state enum because a tenancy tree has no
 * small fixed set of states to condition on). Passing anything else is a
 * caller bug and MAY throw (build rule 10).
 *
 * @typedef {Object} PutTenancyOptions
 * @property {number|null} ifVersion
 */

/**
 * A user record, keyed by its own (already normalized) `login`. The store
 * does not validate this shape -- `cloud/contracts/auth.ts`'s
 * `checkUserRecord` is the one owner of what a valid user record looks like
 * (`userId`, `login`, `installerId`, `password`, `disabled`, `sessionEpoch`,
 * `createdMs`); the store only needs to know that every user has a `login`
 * it is keyed by and a `sessionEpoch` that `putUser`'s `ifEpoch` option
 * conditions on. Deliberately typed loosely here rather than re-declaring
 * auth.ts's shape a second time and risking the two drifting apart (one
 * owner per file, build rule 3).
 *
 * @typedef {Object} StoreUser
 * @property {string} login
 * @property {number} sessionEpoch
 */

/**
 * `putUser`'s options. Exactly one of the two is given on any call:
 * `{ ifAbsent: true }` for a create (CLOUD-LOGIN-SPEC.md, "B. Store
 * additions") -- succeeds only when no user is currently stored for
 * `user.login`; `{ ifEpoch: n }` for an update -- succeeds only when a user
 * IS currently stored for `user.login` and its stored `sessionEpoch` equals
 * `n` exactly (a missing user refuses `ifEpoch` rather than creating one;
 * `putUser` never creates on `ifEpoch`). Neither key present, or both
 * present, is a caller bug and MAY throw (build rule 10).
 *
 * @typedef {Object} PutUserOptions
 * @property {true} [ifAbsent]
 * @property {number} [ifEpoch]
 */

/**
 * One session record exactly as `putSession` stores it and `getSession`
 * returns it (CLOUD-LOGIN-SPEC.md, section A "Sessions" and section B
 * "Store additions"). `epoch` is the issuing user's `sessionEpoch` AT THE
 * MOMENT the session was created -- `cloud/contracts/auth.ts`'s
 * `sessionState` compares it against the user's CURRENT `sessionEpoch` to
 * decide whether a password reset or a disable has revoked this session.
 *
 * @typedef {Object} StoreSession
 * @property {string} login
 * @property {number} createdMs
 * @property {number} lastSeenMs
 * @property {number} epoch
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
 *   found" (a blank is not a zero, build rule 5). Unchanged by section B's
 *   additions below: it keeps returning exactly what the most recent
 *   successful `putTenancy` wrote.
 *
 * @property {(installerId: string) => Promise<TenancyRecord|null>} getTenancyRecord
 *   Returns `{ tenancy, version }` for exactly one installer (CLOUD-LOGIN-
 *   SPEC.md, "B. Store additions"), or `null` when `installerId` names no
 *   installer this store holds a tenancy for. A seeded tenancy (constructed
 *   with initial data rather than written through `putTenancy`) starts at
 *   `version: 1`. Never throws for an unknown installerId.
 *
 * @property {(installerId: string, tenancy: Tenancy, options: PutTenancyOptions) => Promise<boolean>} putTenancy
 *   A conditional write, the tenancy-tree analogue of `putDevice`
 *   (CLOUD-LOGIN-SPEC.md, "B. Store additions"): succeeds -- writes
 *   `tenancy` as installerId's tree, stores its new version as
 *   `(options.ifVersion ?? 0) + 1`, and returns `true` -- only when
 *   `options.ifVersion` is `null` and no tenancy is currently stored for
 *   `installerId`, or `options.ifVersion` is a number equal to the
 *   CURRENTLY STORED version. Otherwise returns `false` and leaves the
 *   stored tenancy and version untouched -- never throws for a failed
 *   condition. Atomic per `installerId`: two concurrent `putTenancy` calls
 *   for the same installerId and the same `ifVersion` must never both
 *   return `true` (cloud/harness/storeConformance.harness.mjs proves this
 *   with `Promise.all`, the same pattern as `putDevice`'s and
 *   `putSession`'s races).
 *
 * @property {(login: string) => Promise<StoreUser|null>} getUser
 *   Returns the stored user record for `login` (already normalized by the
 *   caller -- the store does no normalization of its own), or `null` when
 *   no such login is stored. Never throws for an unknown login.
 *
 * @property {(user: StoreUser, options: PutUserOptions) => Promise<boolean>} putUser
 *   A conditional write keyed by `user.login` (CLOUD-LOGIN-SPEC.md, "B.
 *   Store additions"): with `{ ifAbsent: true }`, succeeds and writes `user`
 *   only when no user is currently stored for that login; with
 *   `{ ifEpoch: n }`, succeeds and writes `user` only when a user IS
 *   currently stored for that login AND its stored `sessionEpoch === n`.
 *   Returns `false` and leaves the store untouched on a failed condition --
 *   never throws for one. Atomic per `login`: two concurrent `putUser`
 *   calls with `{ ifAbsent: true }` for the same login must never both
 *   return `true` (cloud/harness/storeConformance.harness.mjs proves this
 *   with `Promise.all`).
 *
 * @property {(key: string, atMs: number) => Promise<string>} recordFailedLogin
 *   Appends one login ATTEMPT under `key` (`"acct:<login>"` or
 *   `"src:<address>"`, CLOUD-LOGIN-SPEC.md section A) and returns its `id` --
 *   `atMs` zero-padded to 15 digits, then `"#"`, then 16 further hex
 *   characters, chosen so ids from different `atMs` values sort in TIME
 *   ORDER and two ids are always DISTINCT even when their `atMs` is
 *   identical (cloud/harness/storeConformance.harness.mjs proves both).
 *   Every entry is an attempt until it is proven good, not a confirmed
 *   failure: `cloud/api/login.mjs` records one on BOTH keys before it knows
 *   whether this request will turn out to be locked, wrong, or a real login
 *   (CLOUD-LOGIN-SPEC.md section C step 2, "record first, then count only
 *   the entries ahead of your own" -- the fix for many simultaneous guesses
 *   all reading a 0-failure budget before any of them had recorded one).
 *   Never throws; a first attempt for a never-seen `key` simply starts that
 *   key's history.
 *
 * @property {(key: string, sinceMs: number) => Promise<Array<{ id: string, atMs: number }>>} failedLogins
 *   Returns every attempt recorded for `key` with `atMs >= sinceMs`,
 *   ASCENDING BY `id` (not by `atMs` alone, and not by recording order --
 *   `id` is the one field two attempts sharing an `atMs` can still be
 *   ordered by). `[]` for a `key` with no recorded attempts at or after
 *   `sinceMs` -- never throws. On DynamoDB this MUST be a STRONGLY
 *   CONSISTENT read: a caller that just called `recordFailedLogin` for this
 *   same `key` needs to see that entry in this very read, or "record first,
 *   then count" collapses back into the race it exists to close.
 *
 * @property {(key: string, id: string) => Promise<boolean>} deleteFailedLogin
 *   Removes the one attempt named by `id` under `key`, returning `true` when
 *   it was there to remove and `false` (changing nothing) when `key`/`id`
 *   names no recorded attempt -- never throws. This is how a request undoes
 *   its OWN just-recorded attempt: both of them, when the request itself
 *   turns out to be locked out (CLOUD-LOGIN-SPEC.md section C step 2, so a
 *   refused attempt never lengthens the lock it was refused by), and the
 *   source key's alone on a successful login (step 4) -- `clearFailedLogins`
 *   below is the one that wipes a whole key, and only the account key is
 *   ever wiped outright.
 *
 * @property {(key: string) => Promise<void>} clearFailedLogins
 *   Discards every recorded attempt for `key`, and only `key` -- a sibling
 *   key (the source-address budget when the account key is cleared on a
 *   successful login, CLOUD-LOGIN-SPEC.md section C step 4) is never
 *   touched. Never throws for a `key` with nothing recorded.
 *
 * @property {(tokenHash: string, session: StoreSession) => Promise<boolean>} putSession
 *   A create-only write: succeeds and stores `session` under `tokenHash`
 *   only when no session is currently stored for that hash, and returns
 *   `true`; returns `false` and leaves the store untouched when one already
 *   exists -- `putSession` never overwrites (CLOUD-LOGIN-SPEC.md, "B. Store
 *   additions"). Atomic per `tokenHash`: two concurrent `putSession` calls
 *   for the same hash must never both return `true`
 *   (cloud/harness/storeConformance.harness.mjs proves this with
 *   `Promise.all`).
 *
 * @property {(tokenHash: string) => Promise<StoreSession|null>} getSession
 *   Returns the stored session for `tokenHash`, or `null` when none is
 *   stored. Never throws for an unknown hash.
 *
 * @property {(tokenHash: string, lastSeenMs: number) => Promise<boolean>} touchSession
 *   Updates the stored session's `lastSeenMs` in place and returns `true`,
 *   or returns `false` (and does nothing) when no session is stored for
 *   `tokenHash`. Never throws for a missing session.
 *
 * @property {(tokenHash: string) => Promise<boolean>} deleteSession
 *   Removes the stored session for `tokenHash`, if any. Never throws when
 *   there is nothing to delete.
 */
