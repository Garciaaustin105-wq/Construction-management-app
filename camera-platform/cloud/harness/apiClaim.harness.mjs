// cloud/harness/apiClaim.harness.mjs — cloud/api/claim.mjs's `POST /claim`
// handler.
//
// FEARED: an unknown code and an expired code answering differently (a
// prober learning "that code once existed"); a code claimed twice because
// the conditional write was skipped; a non-installer let through.
//
// cloud/api/memoryStore.mjs's createMemoryStore() is itself a stub today
// ("createMemoryStore: not built"), so every check below is expected to FAIL
// for that reason (or for cloud/api/claim.mjs's own "handler: not built")
// until both are built — "Harnesses import the memory store for the handler
// tests, so they will fail 'not built' until it exists. That is fine."
// createMemoryStore() is called INSIDE each check's own body, never at
// module top level.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { formatClaimCode } from "../dist/cloud/contracts/claimCode.js";
import { handler } from "../api/claim.mjs";
import { createMemoryStore } from "../api/memoryStore.mjs";

console.log("api claim");

const NOW_MS = Date.parse("2026-09-27T00:00:00.000Z");
const CODE = formatClaimCode([1, 2, 3, 4, 5, 6, 7, 8]); // a real, checksum-valid canonical code
const OTHER_CODE = formatClaimCode([8, 7, 6, 5, 4, 3, 2, 1]);

const installerTech = { userId: "user-1", role: "installer_tech", scope: { kind: "installer", id: "inst-1" } };
const storeManager = { userId: "user-2", role: "store_manager", scope: { kind: "site", id: "site-1" } };

const unclaimedDevice = (deviceId = "dev-1", overrides = {}) => ({
  deviceId,
  state: "unclaimed",
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
  code: CODE,
  codeExpiresMs: NOW_MS + 3600000,
  installerId: null,
  siteId: null,
  ...overrides,
});

function baseDeps(overrides = {}) {
  const logs = [];
  const deps = {
    store: createMemoryStore({ devices: [unclaimedDevice()] }),
    nowMs: () => NOW_MS,
    verifySignature: () => true,
    principalOf: () => installerTech,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return { deps, logs };
}

function parseBody(response) {
  return JSON.parse(response.body);
}

function eventFor(code) {
  return { body: JSON.stringify({ code }) };
}

// ---- principal checks ----

await check("no principal gives 401", async () => {
  const { deps, logs } = baseDeps({ principalOf: () => null });
  const r = await handler(eventFor(CODE), deps);
  eq(r.statusCode, 401);
  same(parseBody(r), { ok: false, reason: "no_principal" });
  same(logs, [{ reason: "no_principal", deviceId: null }]);
});

await check("a non-installer principal gets 403 installer_only", async () => {
  const { deps, logs } = baseDeps({ principalOf: () => storeManager });
  const r = await handler(eventFor(CODE), deps);
  eq(r.statusCode, 403);
  same(parseBody(r), { ok: false, reason: "installer_only" });
  same(logs, [{ reason: "installer_only", deviceId: null }]);
});

await check("a non-installer is refused before the code is even inspected", async () => {
  // Even a garbage code must still answer installer_only, not a parse reason —
  // the role check runs first, regardless of what was sent.
  const { deps } = baseDeps({ principalOf: () => storeManager });
  const r = await handler(eventFor("not-a-real-code-at-all"), deps);
  same(parseBody(r), { ok: false, reason: "installer_only" });
});

// ---- parseClaimCode refusals ----

await check("an invalid code gives 400 with parseClaimCode's own reason", async () => {
  const { deps } = baseDeps();
  const r = await handler(eventFor("too-short"), deps);
  eq(r.statusCode, 400);
  same(parseBody(r), { ok: false, reason: "wrong_length" });
});

// ---- unknown code and expired code give the SAME 404 ----

await check("an unknown code gives 404 no_such_code", async () => {
  const { deps, logs } = baseDeps({ store: createMemoryStore({ devices: [] }) });
  const r = await handler(eventFor(CODE), deps);
  eq(r.statusCode, 404);
  same(parseBody(r), { ok: false, reason: "no_such_code" });
  same(logs, [{ reason: "no_such_code", deviceId: null }]);
});

await check("an expired code gives the SAME 404 no_such_code as an unknown code", async () => {
  const { deps } = baseDeps({
    store: createMemoryStore({ devices: [unclaimedDevice("dev-1", { codeExpiresMs: NOW_MS - 1 })] }),
    nowMs: () => NOW_MS,
  });
  const rExpired = await handler(eventFor(CODE), deps);

  const { deps: deps2 } = baseDeps({ store: createMemoryStore({ devices: [] }) });
  const rUnknown = await handler(eventFor(CODE), deps2);

  eq(rExpired.statusCode, 404);
  same(parseBody(rExpired), parseBody(rUnknown), "an expired code and an unknown code must be indistinguishable");
  same(parseBody(rExpired), { ok: false, reason: "no_such_code" });
});

// ---- a code cannot be claimed twice ----

await check("a code cannot be claimed twice: the second attempt is refused", async () => {
  const { deps } = baseDeps();
  const r1 = await handler(eventFor(CODE), deps);
  eq(r1.statusCode, 200);
  same(parseBody(r1), { ok: true, deviceId: "dev-1" });

  const r2 = await handler(eventFor(CODE), deps);
  eq(r2.statusCode, 404, "the code was single-use and is now cleared: it is unknown, not merely refused");
  same(parseBody(r2), { ok: false, reason: "no_such_code" });
});

// ---- two concurrent claims give one success ----

await check("two concurrent claims of the SAME code give exactly one success", async () => {
  const { deps } = baseDeps();
  const [r1, r2] = await Promise.all([handler(eventFor(CODE), deps), handler(eventFor(CODE), deps)]);
  const statusCodes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
  const winner = r1.statusCode === 200 ? r1 : r2;
  const loser = r1.statusCode === 200 ? r2 : r1;
  eq(statusCodes.includes(200), true, "exactly one concurrent claim must succeed");
  same(parseBody(winner), { ok: true, deviceId: "dev-1" });
  eq(parseBody(loser).ok, false, "the losing concurrent claim must be refused, not silently duplicated");
});

// ---- success path ----

await check("a well-formed claim by an installer_tech succeeds with 200 and the deviceId", async () => {
  const { deps, logs } = baseDeps();
  const r = await handler(eventFor(CODE), deps);
  eq(r.statusCode, 200);
  same(parseBody(r), { ok: true, deviceId: "dev-1" });
  same(logs, [{ reason: null, deviceId: "dev-1" }]);
  const stored = await deps.store.getDevice("dev-1");
  eq(stored.state, "claimed");
  eq(stored.installerId, "inst-1", "claimStep's installerId comes straight from principal.scope.id");
  eq(stored.code, null, "the code is single-use and must be cleared");
});

// ---- mutation guard: the loser of a concurrent-claim race gets exactly 409 wrong_state ----

await check("the losing concurrent claim gets exactly 409 wrong_state, not merely ok:false", async () => {
  const { deps } = baseDeps();
  const [r1, r2] = await Promise.all([handler(eventFor(CODE), deps), handler(eventFor(CODE), deps)]);
  const loser = r1.statusCode === 200 ? r2 : r1;
  eq(loser.statusCode, 409, "the loser of a concurrent claim race must be refused with 409, not some other status");
  same(parseBody(loser), { ok: false, reason: "wrong_state" }, "the loser's body must be exactly wrong_state");
});

// ---- mutation guard: an expired code's log entry still carries the real deviceId ----

await check("an expired code's log entry carries the real deviceId, unlike an unknown code's null", async () => {
  const { deps, logs } = baseDeps({
    store: createMemoryStore({ devices: [unclaimedDevice("dev-1", { codeExpiresMs: NOW_MS - 1 })] }),
  });
  const r = await handler(eventFor(CODE), deps);
  eq(r.statusCode, 404);
  same(parseBody(r), { ok: false, reason: "no_such_code" }, "the body must not leak code_expired -- identical to an unknown code");
  same(
    logs,
    [{ reason: "no_such_code", deviceId: "dev-1" }],
    "the device is known here, so its id is logged even though the response withholds the distinction",
  );
});

// ---- mutation guard: no log entry ever contains the claim code itself ----

await check("no log entry, on any outcome, ever contains the claim code itself", async () => {
  const scenarios = [];

  {
    const { deps, logs } = baseDeps();
    await handler(eventFor(CODE), deps); // success
    scenarios.push({ label: "success", logs, needles: [CODE] });
  }
  {
    const { deps, logs } = baseDeps({ principalOf: () => null });
    await handler(eventFor(CODE), deps); // no principal
    scenarios.push({ label: "no principal", logs, needles: [CODE] });
  }
  {
    const { deps, logs } = baseDeps({ principalOf: () => storeManager });
    await handler(eventFor(CODE), deps); // installer_only
    scenarios.push({ label: "installer_only", logs, needles: [CODE] });
  }
  {
    const { deps, logs } = baseDeps();
    await handler(eventFor("too-short"), deps); // malformed code, still the caller's raw input
    scenarios.push({ label: "malformed code", logs, needles: ["too-short"] });
  }
  {
    const { deps, logs } = baseDeps({ store: createMemoryStore({ devices: [] }) });
    await handler(eventFor(CODE), deps); // unknown code
    scenarios.push({ label: "unknown code", logs, needles: [CODE] });
  }
  {
    const { deps, logs } = baseDeps({
      store: createMemoryStore({ devices: [unclaimedDevice("dev-1", { codeExpiresMs: NOW_MS - 1 })] }),
    });
    await handler(eventFor(CODE), deps); // expired code
    scenarios.push({ label: "expired code", logs, needles: [CODE] });
  }

  for (const { label, logs, needles } of scenarios) {
    eq(logs.length, 1, `${label}: exactly one log line`);
    const text = JSON.stringify(logs[0]);
    for (const needle of needles) {
      eq(text.includes(needle), false, `${label}: log entry ${text} must never contain the claim code ${JSON.stringify(needle)}`);
    }
  }
});

report("api claim");
