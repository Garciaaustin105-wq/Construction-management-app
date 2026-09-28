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

report("store conformance");
