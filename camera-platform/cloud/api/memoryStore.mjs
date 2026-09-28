/**
 * `createMemoryStore()`: a correct in-memory implementation of the `Store`
 * interface (cloud/api/store.mjs; cloud/CLOUD-API-SPEC.md, "The store
 * interface"). Used directly by cloud/api/checkin.mjs, cloud/api/claim.mjs
 * and cloud/api/fleet.mjs today (there is no AWS account yet -- see
 * cloud/CLOUD-API-SPEC.md's own opening paragraph), and by every one of
 * their harnesses as the real `deps.store`. A future DynamoDB adapter must
 * pass the exact same cloud/harness/storeConformance.harness.mjs suite this
 * file is proven against, unmodified.
 *
 * See cloud/harness/storeConformance.harness.mjs
 * for the checks it must pass, and the contract below for the shape and the
 * one design decision this file settles that cloud/CLOUD-API-SPEC.md leaves
 * open (the seed argument, next).
 *
 * DESIGN DECISION THIS FILE SETTLES (flagged, not silently assumed --
 * build rule 10): cloud/CLOUD-API-SPEC.md's store interface lists no method
 * for LOADING a tenancy into the store -- only `getTenancy(installerId)` to
 * read one back out. Some seam has to exist for a tenancy tree to reach the
 * store at all (a real DynamoDB adapter would simply find rows already in
 * its table; an in-memory store constructed fresh in every test and every
 * Lambda cold start has nothing to read unless something puts it there
 * first). This file settles that seam as an optional `seed` argument to
 * `createMemoryStore`, used by tests (and by a future bootstrap path, e.g.
 * "load these tenancies once at cold start") -- NOT a general-purpose write
 * method on `Store` itself, and NOT reachable from any HTTP handler.
 * `cloud/harness/storeConformance.harness.mjs`, `apiClaim.harness.mjs` and
 * `apiFleet.harness.mjs` are all written against this signature; anyone
 * changing it must update those three harnesses in the same change.
 */

/**
 * @typedef {Object} MemoryStoreSeed
 * @property {import("./store.mjs").StoreDevice[]} [devices]
 *   Initial device records, keyed internally by `deviceId`. Two entries
 *   sharing a `deviceId` is a caller bug (ambiguous initial state) and MAY
 *   throw synchronously rather than silently keeping one -- build rule 10.
 * @property {Record<string, import("./store.mjs").Tenancy>} [tenancies]
 *   Initial tenancies, keyed by `installerId` -- exactly what
 *   `getTenancy(installerId)` will read back. An installerId absent from
 *   this map (or from an empty/omitted `tenancies`) makes `getTenancy` for
 *   that id resolve to `null`, per `Store.getTenancy`'s own contract, never
 *   an error.
 */

/**
 * Build a fresh, empty-unless-seeded in-memory `Store`
 * (cloud/api/store.mjs). Pure with respect to its arguments -- `seed` is
 * read once at construction and never mutated afterward, and mutating a
 * `seed.devices[i]` or `seed.tenancies[k]` object AFTER this call must have
 * no effect on the store (the store must copy what it needs out of `seed`,
 * never alias it) -- but the returned `Store` itself is of course stateful:
 * that IS what a store is for.
 *
 * Contract each method of the returned `Store` must satisfy is on the
 * `Store` typedef in cloud/api/store.mjs; this function's own job is only
 * to CONSTRUCT one, correctly, including the concurrency guarantees
 * `putDevice` and `acceptCheckin` document there. "Atomic under one-at-a-time
 * async use" (cloud/CLOUD-API-SPEC.md) means: this implementation may do its
 * bookkeeping with plain synchronous JS state (a `Map`, ordinary object
 * fields) precisely BECAUSE Node's single-threaded event loop already
 * serializes every synchronous section between two `await` points -- a
 * conditional-write method must perform its read-check-write as one
 * synchronous span with no `await` in the middle of it, not because it needs
 * an explicit lock. Two concurrent callers still each get a distinct,
 * correct answer (cloud/harness/storeConformance.harness.mjs's races prove
 * this with real `Promise.all` calls, not just a single-threaded assumption
 * asserted in prose).
 *
 * @param {MemoryStoreSeed} [seed]
 * @returns {import("./store.mjs").Store}
 */
export function createMemoryStore(seed = {}) {
  const src = seed ?? {};
  // All state is plain synchronous JS held in Maps; every record is cloned on
  // the way in and on the way out, so nothing the caller owns is ever aliased
  // or mutated by the store, and no seed object is retained by reference.
  const devices = new Map(); // deviceId -> stored StoreDevice
  const latest = new Map(); // deviceId -> latest accepted check-in record
  const tenancies = new Map(); // installerId -> stored Tenancy

  for (const device of src.devices ?? []) {
    if (devices.has(device.deviceId)) {
      throw new Error(
        `createMemoryStore: seed.devices has two entries for deviceId ${JSON.stringify(device.deviceId)}`,
      );
    }
    devices.set(device.deviceId, structuredClone(device));
  }
  for (const [installerId, tenancy] of Object.entries(src.tenancies ?? {})) {
    tenancies.set(installerId, structuredClone(tenancy));
  }

  return {
    // Every conditional method below performs its whole read-check-write as
    // one synchronous span with no `await` in it: the event loop serializes
    // such spans, so of two concurrent callers exactly one wins the race.
    async putDevice(device, opts = {}) {
      const { ifState, ifCode } = opts ?? {};
      const stored = devices.get(device.deviceId);
      const stateMatches =
        ifState === undefined
          ? true
          : ifState === null
            ? stored === undefined
            : stored !== undefined && stored.state === ifState;
      // ifCode: compare-and-swap on the claim code too (store.mjs); absent
      // means state alone decides.
      const codeMatches = ifCode === undefined || (stored !== undefined && stored.code === ifCode);
      if (!stateMatches || !codeMatches) {
        return false;
      }
      devices.set(device.deviceId, structuredClone(device));
      return true;
    },

    async getDevice(deviceId) {
      const stored = devices.get(deviceId);
      return stored === undefined ? null : structuredClone(stored);
    },

    async findDeviceByCode(code) {
      if (code === null || code === undefined) {
        return null;
      }
      for (const stored of devices.values()) {
        if (stored.code !== null && stored.code !== undefined && stored.code === code) {
          return structuredClone(stored);
        }
      }
      return null;
    },

    async acceptCheckin(deviceId, seq, payload, nowMs) {
      const stored = latest.get(deviceId);
      // The guard is seq alone (store.mjs). Receive time is recorded, never
      // compared: the cloud clock can step back, and two check-ins can land
      // in one millisecond. JS runs this synchronously between awaits, so
      // of two concurrent accepts exactly one commits first.
      if (stored !== undefined && seq <= stored.seq) {
        return "stale";
      }
      latest.set(deviceId, { seq, atMs: nowMs, payload: structuredClone(payload) });
      return "accepted";
    },

    async latestCheckin(deviceId) {
      const stored = latest.get(deviceId);
      // Exactly the interface's shape; `seq` stays internal (lastSeqMap).
      return stored === undefined ? null : { atMs: stored.atMs, payload: structuredClone(stored.payload) };
    },

    async lastSeqMap(deviceIds) {
      const map = new Map();
      for (const deviceId of deviceIds ?? []) {
        const stored = latest.get(deviceId);
        if (stored !== undefined) {
          map.set(deviceId, stored.seq);
        }
      }
      return map;
    },

    async getTenancy(installerId) {
      const stored = tenancies.get(installerId);
      return stored === undefined ? null : structuredClone(stored);
    },
  };
}
