// cloud/harness/apiFleet.harness.mjs — cloud/api/fleet.mjs's `GET /fleet`
// handler.
//
// FEARED: a device outside a principal's scope leaking into the list; a
// never-checked-in device reported as "offline" instead of "never" (a blank
// is not a zero).
//
// cloud/api/memoryStore.mjs's createMemoryStore() is itself a stub today
// ("createMemoryStore: not built"), so every check below is expected to FAIL
// for that reason (or for cloud/api/fleet.mjs's own "handler: not built")
// until both are built — "Harnesses import the memory store for the handler
// tests, so they will fail 'not built' until it exists. That is fine."
// createMemoryStore() is called INSIDE each check's own body, never at
// module top level.
//
// Every fake `principalOf` here returns an `ApiPrincipal` (the pure
// `Principal` plus `installerId`) — see cloud/api/fleet.mjs's own
// "KNOWN SPEC/CONTRACT GAP" comment for why that extra field exists.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { handler, CHECKIN_INTERVAL_MS } from "../api/fleet.mjs";
import { createMemoryStore } from "../api/memoryStore.mjs";
import { buildCheckin } from "../dist/contracts/deviceCheckin.js";

console.log("api fleet");

const NOW_MS = Date.parse("2026-09-27T00:00:00.000Z");

const BASE_FACTS = {
  version: "v1",
  uptimeSec: 10,
  cameras: [],
  drives: [],
  footageHeld: { hours: null, basis: null, refusedReason: null },
  detector: { capacityFps: null, minConfidence: null, motionGateEnabled: null },
  knownObjects: { active: null, lapsed: null },
  lastSealedUtc: null,
};

function makePayload(deviceId, seq, sentAtUtc) {
  return buildCheckin(BASE_FACTS, { deviceId, nowUtc: sentAtUtc, seq });
}

// ---- fixtures: one installer, one org, two groups, one site per group ----

function twoGroupTenancy() {
  return {
    installers: [{ id: "inst-1", name: "Installer One" }],
    orgs: [{ id: "org-1", installerId: "inst-1", name: "Org One", privacy: { offered: false, installerBlocked: false } }],
    groups: [
      { id: "group-A", orgId: "org-1", parentGroupId: null, name: "Region A" },
      { id: "group-B", orgId: "org-1", parentGroupId: null, name: "Region B" },
    ],
    sites: [
      { id: "site-A1", orgId: "org-1", groupId: "group-A", name: "Site A1" },
      { id: "site-B1", orgId: "org-1", groupId: "group-B", name: "Site B1" },
    ],
    devices: [
      { deviceId: "dev-A1", siteId: "site-A1" },
      { deviceId: "dev-B1", siteId: "site-B1" },
    ],
  };
}

function storeDevice(deviceId, overrides = {}) {
  return {
    deviceId,
    state: "claimed",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    code: null,
    codeExpiresMs: null,
    installerId: "inst-1",
    siteId: null,
    ...overrides,
  };
}

const installerTechPrincipal = { userId: "u-1", role: "installer_tech", scope: { kind: "installer", id: "inst-1" }, installerId: "inst-1" };
const regionalManagerA = { userId: "u-2", role: "regional_manager", scope: { kind: "group", id: "group-A" }, installerId: "inst-1" };

function baseDeps(overrides = {}) {
  const logs = [];
  const deps = {
    store: createMemoryStore({
      devices: [storeDevice("dev-A1", { siteId: "site-A1" }), storeDevice("dev-B1", { siteId: "site-B1" })],
      tenancies: { "inst-1": twoGroupTenancy() },
    }),
    nowMs: () => NOW_MS,
    verifySignature: () => true,
    principalOf: () => installerTechPrincipal,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return { deps, logs };
}

function parseBody(response) {
  return JSON.parse(response.body);
}

const EVENT = {};

// ---- principal checks ----

await check("no principal gives 401", async () => {
  const { deps, logs } = baseDeps({ principalOf: () => null });
  const r = await handler(EVENT, deps);
  eq(r.statusCode, 401);
  same(parseBody(r), { ok: false, reason: "no_principal" });
  same(logs, [{ reason: "no_principal", deviceId: null }]);
});

// ---- an ASYNC principalOf (one that returns a Promise) must work exactly
// like a synchronous one, including one that resolves to null ----

await check("fleet works with an ASYNC principalOf that resolves to a principal", async () => {
  const { deps } = baseDeps({ principalOf: async () => installerTechPrincipal });
  const r = await handler(EVENT, deps);
  eq(r.statusCode, 200);
  const body = parseBody(r);
  const ids = body.rows.map((row) => row.deviceId).sort();
  same(ids, ["dev-A1", "dev-B1"]);
});

await check("fleet gives 401 no_principal when an ASYNC principalOf resolves to null", async () => {
  const { deps, logs } = baseDeps({ principalOf: async () => null });
  const r = await handler(EVENT, deps);
  eq(r.statusCode, 401);
  same(parseBody(r), { ok: false, reason: "no_principal" });
  same(logs, [{ reason: "no_principal", deviceId: null }]);
});

// ---- an installer sees only their own devices ----

await check("an installer_tech sees every device under their installer, and no other installer's", async () => {
  const otherInstallerDevice = storeDevice("dev-ghost", { installerId: "inst-2", siteId: "site-ghost" });
  const { deps } = baseDeps({
    store: createMemoryStore({
      devices: [storeDevice("dev-A1", { siteId: "site-A1" }), storeDevice("dev-B1", { siteId: "site-B1" }), otherInstallerDevice],
      // inst-2's tenancy is deliberately seeded too, to prove getTenancy("inst-1")
      // (and this handler) never mixes the two together.
      tenancies: {
        "inst-1": twoGroupTenancy(),
        "inst-2": {
          installers: [{ id: "inst-2", name: "Installer Two" }],
          orgs: [{ id: "org-2", installerId: "inst-2", name: "Org Two", privacy: { offered: false, installerBlocked: false } }],
          groups: [],
          sites: [{ id: "site-ghost", orgId: "org-2", groupId: null, name: "Ghost Site" }],
          devices: [{ deviceId: "dev-ghost", siteId: "site-ghost" }],
        },
      },
    }),
  });
  const r = await handler(EVENT, deps);
  eq(r.statusCode, 200);
  const body = parseBody(r);
  const ids = body.rows.map((row) => row.deviceId).sort();
  same(ids, ["dev-A1", "dev-B1"], "an installer_tech must see every device under their own installer");
  if (r.body.includes("dev-ghost")) throw new Error("another installer's device must never appear in the response body at all");
});

// ---- a regional manager sees only their group ----

await check("a regional_manager sees only their own group's sites, not a sibling group's", async () => {
  const { deps } = baseDeps({ principalOf: () => regionalManagerA });
  const r = await handler(EVENT, deps);
  eq(r.statusCode, 200);
  const body = parseBody(r);
  const ids = body.rows.map((row) => row.deviceId).sort();
  same(ids, ["dev-A1"], "group-A's regional manager must see only dev-A1, on site-A1");
  if (r.body.includes("dev-B1")) throw new Error("group-B's device must never appear for group-A's regional manager");
});

// ---- rows are sorted by deviceId ----

await check("rows are sorted by deviceId ascending", async () => {
  const { deps } = baseDeps();
  const r = await handler(EVENT, deps);
  const body = parseBody(r);
  const ids = body.rows.map((row) => row.deviceId);
  const sorted = [...ids].sort();
  same(ids, sorted, "rows must already be sorted by deviceId");
});

// ---- a device with no check-in shows status "never" ----

await check("a device that has never checked in reports status \"never\", not \"offline\"", async () => {
  const { deps } = baseDeps();
  const r = await handler(EVENT, deps);
  const body = parseBody(r);
  const rowA1 = body.rows.find((row) => row.deviceId === "dev-A1");
  same(rowA1, { deviceId: "dev-A1", state: "claimed", status: "never", lastSeenUtc: null, health: null });
});

await check("a device that HAS checked in recently reports status \"online\", with its health summary", async () => {
  const { deps } = baseDeps();
  const sentAtUtc = new Date(NOW_MS - CHECKIN_INTERVAL_MS).toISOString(); // 1 interval ago: well within online
  await deps.store.acceptCheckin("dev-A1", 1, makePayload("dev-A1", 1, sentAtUtc), Date.parse(sentAtUtc));
  const r = await handler(EVENT, deps);
  const body = parseBody(r);
  const rowA1 = body.rows.find((row) => row.deviceId === "dev-A1");
  eq(rowA1.status, "online");
  eq(rowA1.lastSeenUtc, sentAtUtc);
  if (rowA1.health === null) throw new Error("a device that has checked in must carry a non-null health summary");
});

// ---- NEW RULE: the store record's own installerId, not just the tenancy
// tree's placement, decides whether a device may appear (contract updated
// in cloud/api/fleet.mjs step 4; not yet implemented in code, so this check
// is expected to FAIL until it is) ----

function crossOwnershipTenancy() {
  return {
    installers: [{ id: "inst-1", name: "Installer One" }],
    orgs: [{ id: "org-1", installerId: "inst-1", name: "Org One", privacy: { offered: false, installerBlocked: false } }],
    groups: [],
    sites: [{ id: "site-A1", orgId: "org-1", groupId: null, name: "Site A1" }],
    devices: [
      { deviceId: "dev-own", siteId: "site-A1" },
      { deviceId: "dev-claimed-by-other", siteId: "site-A1" },
      { deviceId: "dev-unclaimed", siteId: "site-A1" },
    ],
  };
}

await check(
  "a device whose STORE record's installerId disagrees with the principal's -- claimed by another installer, or unclaimed -- is withheld even though the requester's own tenancy lists it on their own site; the requester's own device still appears",
  async () => {
    const { deps } = baseDeps({
      store: createMemoryStore({
        devices: [
          storeDevice("dev-own", { siteId: "site-A1" }), // installerId "inst-1": matches the requester
          storeDevice("dev-claimed-by-other", { siteId: "site-A1", installerId: "inst-2" }), // claimed by another installer
          storeDevice("dev-unclaimed", { siteId: "site-A1", installerId: null, state: "unclaimed" }), // never claimed
        ],
        tenancies: { "inst-1": crossOwnershipTenancy() },
      }),
    });
    const r = await handler(EVENT, deps);
    eq(r.statusCode, 200);
    const body = parseBody(r);
    const ids = body.rows.map((row) => row.deviceId).sort();
    same(ids, ["dev-own"], "only the device whose store record's installerId matches the principal's own installer may appear");
    if (r.body.includes("dev-claimed-by-other")) {
      throw new Error(
        "a device claimed by another installer's store record must never appear in the response body, even when the requester's own tenancy lists it",
      );
    }
    if (r.body.includes("dev-unclaimed")) {
      throw new Error(
        "an unclaimed device (store installerId null) must never appear in the response body, even when the requester's own tenancy lists it",
      );
    }
  },
);

// ---- MUTATION GUARD: a privacy-blocked installer still gets fleet/health
// rows -- health is allowed; only video/snapshot are blocked
// (cloud/contracts/scope.ts's `can`). Kills a mutation that has fleet.mjs
// call `can(..., "video")` (or otherwise filter on `org.privacy`) before
// including a row ----

function privacyBlockedTenancy() {
  return {
    installers: [{ id: "inst-1", name: "Installer One" }],
    orgs: [
      {
        id: "org-blocked",
        installerId: "inst-1",
        name: "Blocked Org",
        privacy: { offered: true, installerBlocked: true },
      },
    ],
    groups: [],
    sites: [{ id: "site-blocked", orgId: "org-blocked", groupId: null, name: "Blocked Site" }],
    devices: [{ deviceId: "dev-blocked", siteId: "site-blocked" }],
  };
}

await check(
  "a privacy-blocked org's device still appears in the fleet, with its health summary -- fleet never filters on installer-blocked privacy",
  async () => {
    const { deps } = baseDeps({
      store: createMemoryStore({
        devices: [storeDevice("dev-blocked", { siteId: "site-blocked" })],
        tenancies: { "inst-1": privacyBlockedTenancy() },
      }),
    });
    const sentAtUtc = new Date(NOW_MS - CHECKIN_INTERVAL_MS).toISOString(); // 1 interval ago: well within online
    await deps.store.acceptCheckin("dev-blocked", 1, makePayload("dev-blocked", 1, sentAtUtc), Date.parse(sentAtUtc));
    const r = await handler(EVENT, deps);
    eq(r.statusCode, 200);
    const body = parseBody(r);
    const rowBlocked = body.rows.find((row) => row.deviceId === "dev-blocked");
    if (rowBlocked === undefined) {
      throw new Error("a privacy-blocked org's device must still appear in the fleet listing (only video/snapshot are blocked, never health)");
    }
    eq(rowBlocked.status, "online");
    eq(rowBlocked.lastSeenUtc, sentAtUtc);
    if (rowBlocked.health === null) {
      throw new Error("a privacy-blocked org's device must still carry a non-null health summary");
    }
  },
);

report("api fleet");
