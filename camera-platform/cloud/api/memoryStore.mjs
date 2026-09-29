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

import { randomBytes as nodeRandomBytes } from "node:crypto";

/**
 * A `recordFailedLogin` id: `atMs` zero-padded to 15 digits, then `"#"`, then
 * 16 further hex characters -- 8 from a per-store monotonic counter (`seq`,
 * zero-padded), then 8 from real randomness. The counter, not the random
 * half, is what decides the sort order between two attempts recorded at the
 * IDENTICAL `atMs`: two calls can easily land in the same millisecond (that
 * is exactly the burst this store exists to prove is handled correctly --
 * cloud/harness/apiLogin.harness.mjs's "20 simultaneous wrong guesses"), and
 * `cloud/api/login.mjs` counts "the entries that sort strictly before this
 * request's own" to decide who is let through. Node is single-threaded, so
 * concurrent `Promise.all` callers still each run their own synchronous
 * record-then-yield span in a fixed order (CLOUD-LOGIN-SPEC.md section C
 * step 2's "exactly the first ones through" only holds if same-millisecond
 * ties break by that real order, not by a coin flip on random bytes -- a
 * purely random tail would let a *later* caller's entry sort ahead of an
 * *earlier* one about half the time, which turns a deterministic lockout
 * boundary (5 real failures, then the 6th is locked) into a roughly 1-in-6
 * chance of the 6th slipping through). The random half still guards
 * distinctness on its own (so a counter overflow or reset is never the only
 * thing standing between two attempts and a collision) and keeps the id from
 * being a bare guessable sequence number.
 *
 * @param {number} atMs
 * @param {number} seq
 * @returns {string}
 */
function makeFailedLoginId(atMs, seq) {
  const timePart = String(atMs).padStart(15, "0");
  const seqPart = (seq >>> 0).toString(16).padStart(8, "0");
  const randPart = nodeRandomBytes(4).toString("hex");
  return `${timePart}#${seqPart}${randPart}`;
}

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
  const tenancyVersions = new Map(); // installerId -> version number (CLOUD-LOGIN-SPEC.md, "B. Store additions")
  const users = new Map(); // login -> stored StoreUser
  const failedLoginsByKey = new Map(); // "acct:<login>" | "src:<address>" -> Array<{ id, atMs }> (insertion order; sorted by id on read)
  let failSeq = 0; // per-store monotonic counter feeding makeFailedLoginId's seq part
  const sessions = new Map(); // tokenHash -> stored StoreSession

  // A device record written before `expiresAtS` existed has no such key at
  // all (not even `undefined`); every getter must hand that back as `null`,
  // never as `undefined` and never as `0` (a blank is not a zero, build
  // rule 5; store.mjs's StoreDevice doc).
  function cloneDevice(stored) {
    const cloned = structuredClone(stored);
    if (cloned.expiresAtS === undefined) {
      cloned.expiresAtS = null;
    }
    return cloned;
  }

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
    // Seeded tenancies start at version 1 (CLOUD-LOGIN-SPEC.md, "B. Store additions").
    tenancyVersions.set(installerId, 1);
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
      return stored === undefined ? null : cloneDevice(stored);
    },

    async findDeviceByCode(code) {
      if (code === null || code === undefined) {
        return null;
      }
      for (const stored of devices.values()) {
        if (stored.code !== null && stored.code !== undefined && stored.code === code) {
          return cloneDevice(stored);
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

    async getTenancyRecord(installerId) {
      const stored = tenancies.get(installerId);
      if (stored === undefined) {
        return null;
      }
      return { tenancy: structuredClone(stored), version: tenancyVersions.get(installerId) };
    },

    async putTenancy(installerId, tenancy, opts) {
      const { ifVersion } = opts ?? {};
      if (ifVersion !== null && !(typeof ifVersion === "number" && Number.isFinite(ifVersion))) {
        throw new Error("createMemoryStore.putTenancy: ifVersion must be null or a finite number");
      }
      const storedVersion = tenancyVersions.get(installerId);
      // ifVersion === null: "must not exist yet" (no stored version at all).
      // A number: must equal the CURRENTLY STORED version exactly -- the
      // synchronous read-check-write below has no await in it, so of two
      // concurrent callers at the same ifVersion exactly one observes a
      // match (store.mjs's putTenancy contract, storeConformance's race).
      const matches = ifVersion === null ? storedVersion === undefined : storedVersion === ifVersion;
      if (!matches) {
        return false;
      }
      tenancies.set(installerId, structuredClone(tenancy));
      tenancyVersions.set(installerId, (ifVersion ?? 0) + 1);
      return true;
    },

    async getUser(login) {
      const stored = users.get(login);
      return stored === undefined ? null : structuredClone(stored);
    },

    async putUser(user, opts) {
      const { ifAbsent, ifEpoch } = opts ?? {};
      const stored = users.get(user.login);
      let matches;
      if (ifAbsent === true && ifEpoch === undefined) {
        matches = stored === undefined;
      } else if (ifEpoch !== undefined && ifAbsent === undefined) {
        matches = stored !== undefined && stored.sessionEpoch === ifEpoch;
      } else {
        throw new Error("createMemoryStore.putUser: options must give exactly one of ifAbsent or ifEpoch");
      }
      if (!matches) {
        return false;
      }
      users.set(user.login, structuredClone(user));
      return true;
    },

    async recordFailedLogin(key, atMs) {
      const id = makeFailedLoginId(atMs, failSeq++);
      const entry = { id, atMs };
      const list = failedLoginsByKey.get(key);
      if (list === undefined) {
        failedLoginsByKey.set(key, [entry]);
      } else {
        list.push(entry);
      }
      return id;
    },

    async failedLogins(key, sinceMs) {
      const list = failedLoginsByKey.get(key) ?? [];
      // Sorted on the way out, never assumed sorted on the way in: callers
      // may record failures out of order (a retried write, a clock step).
      // Ascending by id (not by atMs alone -- two entries can share an atMs,
      // and id is what breaks that tie; see makeFailedLoginId above).
      return list
        .filter((e) => e.atMs >= sinceMs)
        .map((e) => ({ id: e.id, atMs: e.atMs }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async deleteFailedLogin(key, id) {
      const list = failedLoginsByKey.get(key);
      if (list === undefined) {
        return false;
      }
      const idx = list.findIndex((e) => e.id === id);
      if (idx === -1) {
        return false;
      }
      list.splice(idx, 1);
      return true;
    },

    async clearFailedLogins(key) {
      failedLoginsByKey.delete(key);
    },

    async putSession(tokenHash, session) {
      if (sessions.has(tokenHash)) {
        return false;
      }
      sessions.set(tokenHash, structuredClone(session));
      return true;
    },

    async getSession(tokenHash) {
      const stored = sessions.get(tokenHash);
      return stored === undefined ? null : structuredClone(stored);
    },

    async touchSession(tokenHash, lastSeenMs) {
      const stored = sessions.get(tokenHash);
      if (stored === undefined) {
        return false;
      }
      stored.lastSeenMs = lastSeenMs;
      return true;
    },

    async deleteSession(tokenHash) {
      return sessions.delete(tokenHash);
    },
  };
}
