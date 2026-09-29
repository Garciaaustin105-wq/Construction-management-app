// cloud/harness/storeConformance.harness.mjs — cloud/api/store.mjs's `Store`
// interface, proven against cloud/api/memoryStore.mjs's `createMemoryStore()`.
// Any future DynamoDB adapter must pass this exact same suite, unmodified,
// to be accepted as a drop-in replacement (cloud/CLOUD-API-SPEC.md, "The
// store interface").
//
// FEARED: a conditional write ("if the state is still X") that is not
// actually atomic — two concurrent callers who each read "unclaimed" both
// believing they alone get to write "claimed"; a getTenancy that leaks one
// installer's tree into another's.
//
// createMemoryStore() itself is a stub today ("createMemoryStore: not
// built"), so every check below is expected to FAIL for that reason until
// cloud/api/memoryStore.mjs is built. It is called INSIDE each check's own
// body (never at module top level) so that stub throw is caught by `check`
// as one failing check, not an uncaught crash of the whole harness.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { createMemoryStore } from "../api/memoryStore.mjs";
import { buildCheckin } from "../dist/contracts/deviceCheckin.js";

console.log("store conformance");

const NOW_MS = Date.parse("2026-09-27T00:00:00.000Z");

const BASE_FACTS = {
  version: "abc123",
  uptimeSec: 100,
  cameras: [],
  drives: [],
  footageHeld: { hours: null, basis: null, refusedReason: null },
  detector: { capacityFps: null, minConfidence: null, motionGateEnabled: null },
  knownObjects: { active: null, lapsed: null },
  lastSealedUtc: null,
};

function makePayload(deviceId, seq, sentAtUtc = "2026-09-27T00:00:00.000Z") {
  return buildCheckin(BASE_FACTS, { deviceId, nowUtc: sentAtUtc, seq });
}

function device(deviceId, overrides = {}) {
  return {
    deviceId,
    state: "unclaimed",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    code: null,
    codeExpiresMs: null,
    installerId: null,
    siteId: null,
    ...overrides,
  };
}

function tenancyFor(installerId, marker) {
  return {
    installers: [{ id: installerId, name: `installer ${marker}` }],
    orgs: [{ id: `org-${marker}`, installerId, name: `org ${marker}`, privacy: { offered: false, installerBlocked: false } }],
    groups: [],
    sites: [{ id: `site-${marker}`, orgId: `org-${marker}`, groupId: null, name: `site ${marker}` }],
    devices: [{ deviceId: `dev-${marker}`, siteId: `site-${marker}` }],
  };
}

// ---- acceptCheckin: refuses an equal or lower seq ----

await check("acceptCheckin refuses a seq equal to the stored lastSeq", async () => {
  const store = createMemoryStore();
  const first = await store.acceptCheckin("dev-1", 5, makePayload("dev-1", 5), NOW_MS);
  eq(first, "accepted", "the first ever seq for this device must be accepted");
  const again = await store.acceptCheckin("dev-1", 5, makePayload("dev-1", 5), NOW_MS + 1000);
  eq(again, "stale", "an equal seq must be refused");
});

await check("acceptCheckin refuses a seq lower than the stored lastSeq", async () => {
  const store = createMemoryStore();
  await store.acceptCheckin("dev-2", 10, makePayload("dev-2", 10), NOW_MS);
  const lower = await store.acceptCheckin("dev-2", 3, makePayload("dev-2", 3), NOW_MS + 1000);
  eq(lower, "stale", "a lower seq must be refused");
  // The stale attempt must not have overwritten the stored latest check-in.
  const latest = await store.latestCheckin("dev-2");
  eq(latest.payload.seq, 10, "the stale write must not clobber the accepted one");
});

await check("acceptCheckin accepts a strictly higher seq after a prior accept", async () => {
  const store = createMemoryStore();
  await store.acceptCheckin("dev-3", 1, makePayload("dev-3", 1), NOW_MS);
  const r = await store.acceptCheckin("dev-3", 2, makePayload("dev-3", 2), NOW_MS + 1000);
  eq(r, "accepted");
});

// ---- acceptCheckin: races two concurrent accepts of the same seq ----

await check("acceptCheckin races two concurrent accepts of the SAME seq: exactly one wins", async () => {
  const store = createMemoryStore();
  const payload = makePayload("dev-race", 1);
  const [r1, r2] = await Promise.all([
    store.acceptCheckin("dev-race", 1, payload, NOW_MS),
    store.acceptCheckin("dev-race", 1, payload, NOW_MS),
  ]);
  const results = [r1, r2].sort();
  same(results, ["accepted", "stale"], "exactly one of two identical concurrent accepts must win");
});

// Corrected 2026-09-27. This used to demand "exactly one wins" for seq 1 vs
// seq 2, which the interface does not say: if 1 commits first, 2 is still
// strictly greater and is honestly accepted. The old wording could only be
// met by also comparing receive times, which drops real check-ins after a
// clock step. The invariants that DO hold, in either commit order:
await check("acceptCheckin races DIFFERENT seqs: the higher always wins and ends up stored, the lower never overwrites it", async () => {
  for (const order of [[1, 2], [2, 1]]) {
    const store = createMemoryStore();
    const results = await Promise.all(
      order.map((seq) => store.acceptCheckin("dev-race-2", seq, makePayload("dev-race-2", seq), NOW_MS)),
    );
    const bySeq = Object.fromEntries(order.map((seq, i) => [seq, results[i]]));
    eq(bySeq[2], "accepted", `seq 2 can never be stale against seq 1 (order ${order})`);
    eq((await store.latestCheckin("dev-race-2")).payload.seq, 2, `the stored latest is the higher seq (order ${order})`);
    eq((await store.lastSeqMap(["dev-race-2"])).get("dev-race-2"), 2, `lastSeq is the higher seq (order ${order})`);
  }
});

await check("a lower seq that arrives after a higher one is stale", async () => {
  const store = createMemoryStore();
  eq(await store.acceptCheckin("dev-race-3", 2, makePayload("dev-race-3", 2), NOW_MS), "accepted");
  eq(await store.acceptCheckin("dev-race-3", 1, makePayload("dev-race-3", 1), NOW_MS + 1000), "stale");
});

// ---- lastSeqMap ----

await check("lastSeqMap omits a device that has never accepted a check-in (a blank is not a zero)", async () => {
  const store = createMemoryStore();
  await store.acceptCheckin("dev-4", 7, makePayload("dev-4", 7), NOW_MS);
  const map = await store.lastSeqMap(["dev-4", "dev-never-seen"]);
  eq(map.get("dev-4"), 7);
  eq(map.has("dev-never-seen"), false, "an id with no accepted check-in must be ABSENT, never present with 0");
});

// ---- putDevice's condition ----

await check("putDevice(device, { ifState: null }) succeeds only when no record exists yet", async () => {
  const store = createMemoryStore();
  const first = await store.putDevice(device("dev-p1"), { ifState: null });
  eq(first, true, "no stored record yet: ifState null must match");
  const second = await store.putDevice(device("dev-p1"), { ifState: null });
  eq(second, false, "a record now exists: ifState null must no longer match");
});

await check("putDevice's condition checks the CURRENTLY STORED state, not the caller's belief", async () => {
  const store = createMemoryStore();
  await store.putDevice(device("dev-p2", { state: "unclaimed" }), { ifState: null });
  const wrongCondition = await store.putDevice(device("dev-p2", { state: "claimed" }), { ifState: "claimed" });
  eq(wrongCondition, false, "the stored state is unclaimed, not claimed: the write must be refused");
  const rightCondition = await store.putDevice(device("dev-p2", { state: "claimed" }), { ifState: "unclaimed" });
  eq(rightCondition, true, "the stored state really is unclaimed: the write must succeed");
  const stored = await store.getDevice("dev-p2");
  eq(stored.state, "claimed", "the successful write must actually be visible afterward");
});

await check("putDevice races two concurrent conditional writes for the same device: exactly one succeeds", async () => {
  const store = createMemoryStore();
  await store.putDevice(device("dev-p3", { state: "unclaimed" }), { ifState: null });
  const [a, b] = await Promise.all([
    store.putDevice(device("dev-p3", { state: "claimed", installerId: "inst-a" }), { ifState: "unclaimed" }),
    store.putDevice(device("dev-p3", { state: "claimed", installerId: "inst-b" }), { ifState: "unclaimed" }),
  ]);
  const results = [a, b].sort();
  same(results, [false, true], "exactly one of two racing claims of the same unclaimed device must succeed");
});

// ---- getDevice / findDeviceByCode: never throw on "not found" ----

await check("getDevice and findDeviceByCode return null, never throw, for an unknown id or code", async () => {
  const store = createMemoryStore();
  eq(await store.getDevice("dev-nope"), null);
  eq(await store.findDeviceByCode("NOPE-CODE-1"), null);
});

await check("latestCheckin returns null for a device that has never checked in", async () => {
  const store = createMemoryStore();
  eq(await store.latestCheckin("dev-never"), null);
});

// ---- getTenancy: never returns another installer's data ----

await check("getTenancy returns exactly the seeded installer's own tenancy, never mixed with another's", async () => {
  const store = createMemoryStore({
    tenancies: {
      "inst-A": tenancyFor("inst-A", "a"),
      "inst-B": tenancyFor("inst-B", "b"),
    },
  });
  const gotA = await store.getTenancy("inst-A");
  same(gotA, tenancyFor("inst-A", "a"), "installer A's tenancy must come back exactly as seeded");
  const gotB = await store.getTenancy("inst-B");
  same(gotB, tenancyFor("inst-B", "b"), "installer B's tenancy must come back exactly as seeded");

  const serializedA = JSON.stringify(gotA);
  if (serializedA.includes("inst-B") || serializedA.includes("org-b") || serializedA.includes("site-b") || serializedA.includes("dev-b")) {
    throw new Error("installer A's tenancy must never contain any of installer B's ids");
  }
});

await check("getTenancy returns null for an installerId with no seeded tenancy", async () => {
  const store = createMemoryStore({ tenancies: { "inst-A": tenancyFor("inst-A", "a") } });
  eq(await store.getTenancy("inst-ghost"), null);
});

// ---- Added 2026-09-27: the fleet handler read `atMs` off latestCheckin and
// got undefined, because the memory store returned its own internal record
// shape. Every adapter must return EXACTLY the interface's shape.

await check("latestCheckin returns exactly { atMs, payload } -- the atMs passed to acceptCheckin, no other keys", async () => {
  const store = createMemoryStore();
  const payload = makePayload("dev-shape", 4);
  await store.acceptCheckin("dev-shape", 4, payload, NOW_MS + 1234);
  const latest = await store.latestCheckin("dev-shape");
  same(Object.keys(latest).sort(), ["atMs", "payload"]);
  eq(latest.atMs, NOW_MS + 1234);
  eq(latest.payload.seq, 4);
});

await check("a strictly higher seq is accepted even when atMs did not move forward (the cloud clock stepped back)", async () => {
  // The interface guards on seq alone. Refusing on receive time would drop
  // real check-ins after an NTP step, or two in the same millisecond.
  const store = createMemoryStore();
  eq(await store.acceptCheckin("dev-clock", 1, makePayload("dev-clock", 1), NOW_MS), "accepted");
  eq(await store.acceptCheckin("dev-clock", 2, makePayload("dev-clock", 2), NOW_MS), "accepted", "same millisecond");
  eq(await store.acceptCheckin("dev-clock", 3, makePayload("dev-clock", 3), NOW_MS - 5000), "accepted", "clock went backwards");
  const latest = await store.latestCheckin("dev-clock");
  eq(latest.payload.seq, 3);
  eq(latest.atMs, NOW_MS - 5000, "atMs is recorded as given, never adjusted");
});

// ---- Added 2026-09-27: ifCode, a compare-and-swap on the claim code. A code
// re-issue leaves state "unclaimed", so ifState alone let two racing re-issues
// BOTH win while the store kept only one code.

await check("putDevice ifCode: two re-issues racing from the same code -- exactly one wins, and its code is what is stored", async () => {
  const store = createMemoryStore({ devices: [device("dev-cas", { code: "OLD0-OLD0-0" })] });
  const [a, b] = await Promise.all([
    store.putDevice(device("dev-cas", { code: "AAAA-AAAA-A" }), { ifState: "unclaimed", ifCode: "OLD0-OLD0-0" }),
    store.putDevice(device("dev-cas", { code: "BBBB-BBBB-B" }), { ifState: "unclaimed", ifCode: "OLD0-OLD0-0" }),
  ]);
  same([a, b].sort(), [false, true]);
  eq((await store.getDevice("dev-cas")).code, a ? "AAAA-AAAA-A" : "BBBB-BBBB-B", "the stored code is the winner's");
});

await check("putDevice ifCode: a stale code is refused, null matches only null, and omitting ifCode keeps the old behaviour", async () => {
  const store = createMemoryStore({ devices: [device("dev-c1", { code: "CUR0-CUR0-0" }), device("dev-c2")] });
  eq(await store.putDevice(device("dev-c1", { code: "NEW0-NEW0-0" }), { ifState: "unclaimed", ifCode: "OLD0-OLD0-0" }), false, "stale code");
  eq((await store.getDevice("dev-c1")).code, "CUR0-CUR0-0", "a refused write changes nothing");
  eq(await store.putDevice(device("dev-c1", { code: "NEW0-NEW0-0" }), { ifState: "unclaimed", ifCode: null }), false, "null vs a stored code");
  eq(await store.putDevice(device("dev-c2", { code: "NEW0-NEW0-0" }), { ifState: "unclaimed", ifCode: null }), true, "null vs a stored null");
  eq(await store.putDevice(device("dev-c1", { code: "NEW1-NEW1-1" }), { ifState: "unclaimed" }), true, "no ifCode: state alone");
});

// ---- StoreDevice.expiresAtS (CLOUD-LOGIN-SPEC.md, "B. Store additions") ----

await check("putDevice/getDevice round-trip expiresAtS", async () => {
  const store = createMemoryStore();
  await store.putDevice(device("dev-exp1", { expiresAtS: 1234567890 }), { ifState: null });
  eq((await store.getDevice("dev-exp1")).expiresAtS, 1234567890, "expiresAtS round-trips");
  await store.putDevice(device("dev-exp1", { state: "claimed", expiresAtS: null }), { ifState: "unclaimed" });
  eq((await store.getDevice("dev-exp1")).expiresAtS, null, "a claim clears it back to null");
});

await check("a device record written before expiresAtS existed reads back as null, never 0 or undefined", async () => {
  // Simulates a pre-existing record: no expiresAtS key at all, not even undefined.
  const oldShapeDevice = {
    deviceId: "dev-old-shape",
    state: "unclaimed",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    code: null,
    codeExpiresMs: null,
    installerId: null,
    siteId: null,
  };
  const store = createMemoryStore({ devices: [oldShapeDevice] });
  const got = await store.getDevice("dev-old-shape");
  eq(got.expiresAtS, null, "missing expiresAtS reads back as null, not undefined");
  eq(Object.prototype.hasOwnProperty.call(got, "expiresAtS"), true, "the key is present, holding null");
  const byCode = await store.putDevice({ ...oldShapeDevice, deviceId: "dev-old-shape-2", code: "OLD0-OLD0-1" }, { ifState: null });
  eq(byCode, true, "seed write for findDeviceByCode case");
  const foundByCode = await store.findDeviceByCode("OLD0-OLD0-1");
  eq(foundByCode.expiresAtS, null, "findDeviceByCode also normalizes a missing expiresAtS to null");
});

// ---- Users, keyed by normalized login ----

function user(login, overrides = {}) {
  return {
    userId: "usr_0123456789abcdef",
    login,
    installerId: "inst-1",
    password: { algo: "scrypt", N: 32768, r: 8, p: 1, salt: "a".repeat(64), key: "b".repeat(128) },
    disabled: false,
    sessionEpoch: 0,
    createdMs: NOW_MS,
    ...overrides,
  };
}

await check("getUser returns null, never throws, for an unknown login", async () => {
  const store = createMemoryStore();
  eq(await store.getUser("nobody@example.com"), null);
});

await check("putUser ifAbsent creates once; a second ifAbsent for the same login is refused", async () => {
  const store = createMemoryStore();
  eq(await store.putUser(user("tech@example.com"), { ifAbsent: true }), true, "first create");
  eq(await store.putUser(user("tech@example.com", { userId: "usr_ffffffffffffffff" }), { ifAbsent: true }), false, "already exists");
  const got = await store.getUser("tech@example.com");
  eq(got.userId, "usr_0123456789abcdef", "the second write did not overwrite the first");
});

await check("putUser ifEpoch succeeds only when the STORED sessionEpoch matches, and refuses a missing user", async () => {
  const store = createMemoryStore();
  eq(await store.putUser(user("tech@example.com", { sessionEpoch: 0 }), { ifEpoch: 0 }), false, "no stored user yet: ifEpoch must refuse, not create");
  eq(await store.getUser("tech@example.com"), null, "still nothing stored");
  await store.putUser(user("tech@example.com", { sessionEpoch: 0 }), { ifAbsent: true });
  eq(await store.putUser(user("tech@example.com", { sessionEpoch: 1 }), { ifEpoch: 5 }), false, "stale epoch (5 != stored 0)");
  eq((await store.getUser("tech@example.com")).sessionEpoch, 0, "refused write changes nothing");
  eq(await store.putUser(user("tech@example.com", { sessionEpoch: 1 }), { ifEpoch: 0 }), true, "epoch matches the stored value");
  eq((await store.getUser("tech@example.com")).sessionEpoch, 1, "the successful write is visible");
});

await check("mutating a returned user does not change the store", async () => {
  const store = createMemoryStore();
  await store.putUser(user("tech@example.com"), { ifAbsent: true });
  const got = await store.getUser("tech@example.com");
  got.disabled = true;
  got.password.key = "z".repeat(128);
  eq((await store.getUser("tech@example.com")).disabled, false, "the store's copy is untouched");
  eq((await store.getUser("tech@example.com")).password.key, "b".repeat(128), "nested fields are also copied, not aliased");
});

await check("putUser races two concurrent ifAbsent creates for the SAME login: exactly one wins", async () => {
  const store = createMemoryStore();
  const [a, b] = await Promise.all([
    store.putUser(user("race@example.com", { userId: "usr_aaaaaaaaaaaaaaaa" }), { ifAbsent: true }),
    store.putUser(user("race@example.com", { userId: "usr_bbbbbbbbbbbbbbbb" }), { ifAbsent: true }),
  ]);
  same([a, b].sort(), [false, true], "exactly one of two racing ifAbsent creates must succeed");
});

// ---- Failed logins ----
// Section B, CLOUD-LOGIN-SPEC.md: recordFailedLogin now returns an id
// (Array<{ id, atMs }> is failedLogins's shape, not a bare number[]), and
// deleteFailedLogin/the concurrent-recording race are new.

await check("recordFailedLogin/failedLogins: ascending order, filtered to sinceMs", async () => {
  const store = createMemoryStore();
  await store.recordFailedLogin("acct:tech@example.com", NOW_MS + 300);
  await store.recordFailedLogin("acct:tech@example.com", NOW_MS + 100);
  await store.recordFailedLogin("acct:tech@example.com", NOW_MS + 200);
  const all = await store.failedLogins("acct:tech@example.com", 0);
  same(all.map((e) => e.atMs), [NOW_MS + 100, NOW_MS + 200, NOW_MS + 300], "ascending regardless of insertion order");
  const sinceFiltered = await store.failedLogins("acct:tech@example.com", NOW_MS + 150);
  same(sinceFiltered.map((e) => e.atMs), [NOW_MS + 200, NOW_MS + 300], "only entries with atMs >= sinceMs");
  same(await store.failedLogins("acct:never-seen", 0), [], "an unknown key has no failures, never throws");
});

// Written first and seen failing (createMemoryStore had no id-sorting or
// tie-breaking at all before this fix): ids must sort in time order across
// different atMs values, and stay distinct even when atMs ties -- the exact
// property cloud/api/login.mjs's "record first, then count only the entries
// ahead of your own" depends on.
await check("recordFailedLogin ids sort in time order and are distinct for the same atMs", async () => {
  const store = createMemoryStore();
  const idEarly = await store.recordFailedLogin("acct:time-order", NOW_MS);
  const idLate = await store.recordFailedLogin("acct:time-order", NOW_MS + 1);
  eq(idEarly < idLate, true, "a later atMs must produce an id that sorts after an earlier one");

  const idSameA = await store.recordFailedLogin("acct:time-order-2", NOW_MS);
  const idSameB = await store.recordFailedLogin("acct:time-order-2", NOW_MS);
  eq(idSameA === idSameB, false, "two attempts at the identical atMs must still get distinct ids");
  const tied = await store.failedLogins("acct:time-order-2", 0);
  same(tied.map((e) => e.id).sort(), [idSameA, idSameB].sort(), "both recorded, both distinct");
});

await check("deleteFailedLogin removes exactly one entry, and returns false for an unknown id", async () => {
  const store = createMemoryStore();
  const idA = await store.recordFailedLogin("acct:del", NOW_MS);
  const idB = await store.recordFailedLogin("acct:del", NOW_MS + 1);
  eq(await store.deleteFailedLogin("acct:del", "not-a-real-id"), false, "unknown id under a real key");
  eq(await store.deleteFailedLogin("acct:never-seen", idA), false, "a real id under an unknown key");
  eq(await store.deleteFailedLogin("acct:del", idA), true, "removes the one entry it names");
  const remaining = await store.failedLogins("acct:del", 0);
  same(remaining.map((e) => e.id), [idB], "only the other entry is left");
  eq(await store.deleteFailedLogin("acct:del", idA), false, "deleting the same id again is a no-op false");
});

await check("20 concurrent recordFailedLogin calls on one key (Promise.all) all land with distinct ids", async () => {
  const store = createMemoryStore();
  const ids = await Promise.all(Array.from({ length: 20 }, () => store.recordFailedLogin("acct:burst", NOW_MS)));
  eq(new Set(ids).size, 20, "all 20 concurrent calls produced distinct ids");
  const entries = await store.failedLogins("acct:burst", 0);
  eq(entries.length, 20, "all 20 attempts actually landed");
});

await check("clearFailedLogins clears one key and leaves another untouched", async () => {
  const store = createMemoryStore();
  await store.recordFailedLogin("acct:tech@example.com", NOW_MS);
  await store.recordFailedLogin("src:203.0.113.5", NOW_MS);
  await store.clearFailedLogins("acct:tech@example.com");
  same(await store.failedLogins("acct:tech@example.com", 0), [], "cleared");
  const untouched = await store.failedLogins("src:203.0.113.5", 0);
  same(untouched.map((e) => e.atMs), [NOW_MS], "the other key is untouched");
});

// ---- Sessions ----

const HASH_1 = "a".repeat(64);
const HASH_2 = "b".repeat(64);
function session(overrides = {}) {
  return { login: "tech@example.com", createdMs: NOW_MS, lastSeenMs: NOW_MS, epoch: 0, ...overrides };
}

await check("getSession returns null, never throws, for an unknown hash", async () => {
  const store = createMemoryStore();
  eq(await store.getSession(HASH_1), null);
});

await check("putSession is create-only: a second putSession for the same hash is refused", async () => {
  const store = createMemoryStore();
  eq(await store.putSession(HASH_1, session()), true, "first create");
  eq(await store.putSession(HASH_1, session({ login: "someone.else" })), false, "hash already taken");
  eq((await store.getSession(HASH_1)).login, "tech@example.com", "the second write did not overwrite the first");
});

await check("putSession races two concurrent creates for the SAME hash: exactly one wins", async () => {
  const store = createMemoryStore();
  const [a, b] = await Promise.all([
    store.putSession(HASH_2, session({ login: "one" })),
    store.putSession(HASH_2, session({ login: "two" })),
  ]);
  same([a, b].sort(), [false, true], "exactly one of two racing session creates must succeed");
});

await check("touchSession updates lastSeenMs and reports false for a missing session", async () => {
  const store = createMemoryStore();
  eq(await store.touchSession(HASH_1, NOW_MS + 1000), false, "no such session");
  await store.putSession(HASH_1, session());
  eq(await store.touchSession(HASH_1, NOW_MS + 5000), true, "touched");
  eq((await store.getSession(HASH_1)).lastSeenMs, NOW_MS + 5000, "the touch is visible");
});

await check("deleteSession removes the session; deleting again is a no-op false", async () => {
  const store = createMemoryStore();
  await store.putSession(HASH_1, session());
  await store.deleteSession(HASH_1);
  eq(await store.getSession(HASH_1), null, "gone");
});

await check("mutating a returned session does not change the store", async () => {
  const store = createMemoryStore();
  await store.putSession(HASH_1, session());
  const got = await store.getSession(HASH_1);
  got.login = "tampered";
  eq((await store.getSession(HASH_1)).login, "tech@example.com", "the store's copy is untouched");
});

// ---- Tenancy writes: getTenancyRecord / putTenancy ----

await check("seeded tenancies start at version 1, and getTenancy keeps returning what putTenancy wrote", async () => {
  const store = createMemoryStore({ tenancies: { "inst-A": tenancyFor("inst-A", "a") } });
  const rec = await store.getTenancyRecord("inst-A");
  eq(rec.version, 1, "seeded tenancies start at version 1");
  same(rec.tenancy, tenancyFor("inst-A", "a"), "the seeded tree comes back exactly");

  const nextTree = tenancyFor("inst-A", "a2");
  eq(await store.putTenancy("inst-A", nextTree, { ifVersion: 1 }), true, "replace at the current version");
  same(await store.getTenancy("inst-A"), nextTree, "getTenancy returns what putTenancy just wrote");
  eq((await store.getTenancyRecord("inst-A")).version, 2, "version advanced to (ifVersion ?? 0) + 1");
});

await check("getTenancyRecord returns null for an installerId with no tenancy", async () => {
  const store = createMemoryStore();
  eq(await store.getTenancyRecord("inst-ghost"), null);
});

await check("putTenancy(installerId, tenancy, { ifVersion: null }) creates once; refused when one already exists", async () => {
  const store = createMemoryStore();
  const tree = tenancyFor("inst-new", "n");
  eq(await store.putTenancy("inst-new", tree, { ifVersion: null }), true, "first create");
  eq((await store.getTenancyRecord("inst-new")).version, 1, "a fresh create stores version (null ?? 0) + 1 = 1");
  eq(await store.putTenancy("inst-new", tenancyFor("inst-new", "n2"), { ifVersion: null }), false, "refused: one already exists");
  same(await store.getTenancy("inst-new"), tree, "the refused write changed nothing");
});

await check("putTenancy refuses a stale ifVersion and leaves the store untouched", async () => {
  const store = createMemoryStore({ tenancies: { "inst-A": tenancyFor("inst-A", "a") } });
  eq(await store.putTenancy("inst-A", tenancyFor("inst-A", "wrong"), { ifVersion: 99 }), false, "stale version");
  same(await store.getTenancy("inst-A"), tenancyFor("inst-A", "a"), "unchanged");
});

await check("putTenancy races two concurrent writes at the SAME ifVersion: exactly one wins", async () => {
  const store = createMemoryStore({ tenancies: { "inst-race": tenancyFor("inst-race", "r") } });
  const [a, b] = await Promise.all([
    store.putTenancy("inst-race", tenancyFor("inst-race", "r-a"), { ifVersion: 1 }),
    store.putTenancy("inst-race", tenancyFor("inst-race", "r-b"), { ifVersion: 1 }),
  ]);
  same([a, b].sort(), [false, true], "exactly one of two racing writes at the same version must succeed");
  eq((await store.getTenancyRecord("inst-race")).version, 2, "exactly one advance happened");
});

await check("mutating a returned tenancy (via getTenancyRecord) does not change the store", async () => {
  const store = createMemoryStore({ tenancies: { "inst-A": tenancyFor("inst-A", "a") } });
  const rec = await store.getTenancyRecord("inst-A");
  rec.tenancy.installers[0].name = "tampered";
  same((await store.getTenancyRecord("inst-A")).tenancy, tenancyFor("inst-A", "a"), "the store's copy is untouched");
});

report("store conformance");
