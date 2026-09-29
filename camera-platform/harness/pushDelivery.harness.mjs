/**
 * Manager rules, build 2: phone alerts -- agent/push-delivery.mjs.
 *
 * Two halves: the HTTP routes (GET /push/public-key, POST /push/subscribe,
 * POST /push/unsubscribe/<id>, GET /push/my-subscriptions, POST /push/test,
 * GET /push/counts), against a real server with the REAL compiled access
 * policy (dist/routeAccess.js); and the sender loop (createPushDelivery's
 * own runSenderPass), called directly rather than through a real timer --
 * every tick is driven by hand here, against a fully controlled fake fetch
 * and a fake, mutable clock, so a retry schedule of up to 30 minutes is
 * proven in milliseconds of real wall-clock time, and every scenario is
 * exactly reproducible rather than raced against a live setInterval.
 * "Tests NEVER send real pushes or touch the network: sendPush's fetch is
 * injected" -- nothing in this file ever omits fetchFn.
 *
 * THE FEARED FAILURES here, by name:
 * - a subscription for one account listed, removed, or SENT TO by another;
 * - a firing sent twice to the same subscription -- across ordinary retries,
 *   across many idle passes after it already sent, and across a crash that
 *   leaves a delivery row claimed but unresolved;
 * - 404/410 not deleting the dead subscription, or deleting the wrong one;
 * - 429/5xx/a network error retried on a schedule other than 1 min / 5 min /
 *   30 min, or retried forever instead of failing once exhausted;
 * - a subscription's own rule selection ("all" vs. an explicit allow-list)
 *   not actually filtering which firings it receives;
 * - a phone that subscribed AFTER a firing already existed getting flooded
 *   with that history;
 * - managerRules off sending anything at all;
 * - a payload over the plaintext budget being sent truncated instead of
 *   refused;
 * - a camera credential, URL, or a person's name anywhere in a response,
 *   the audit log, or push-subscriptions.json/rules.db on disk.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { closeAll } from "../agent/live.mjs";
import { openRulesDb } from "../agent/rules-db.mjs";
import { createPushSubscriptionStore } from "../agent/push-store.mjs";
import { createPushDelivery } from "../agent/push-delivery.mjs";
import { generateP256KeyPair, toBase64Url, MAX_PLAINTEXT_BYTES } from "../agent/web-push.mjs";
import { decideRoute as realDecideRoute } from "../dist/routeAccess.js";
import { check, eq, report } from "./_assert.mjs";

console.log("push delivery");

let endpointCounter = 0;
const GOOD_SUBSCRIPTION = () => ({
  endpoint: `https://push.example.com/dev-${endpointCounter++}-${randomBytes(6).toString("hex")}`,
  keys: {
    p256dh: toBase64Url(generateP256KeyPair().publicKey),
    auth: randomBytes(16).toString("base64url"),
  },
});

const STANDING_OF = (username) => (
  username === "tech" ? { role: "installer" }
    : username === "regional" ? { role: "manager" }
      : username === "clerk" ? { role: "store" }
        : { role: null }
);

const CAM_PW = "push-delivery-s3cret";
const configFor = (stateDir) => ({
  siteId: "bench",
  storeRoots: [join(stateDir, "disk0")],
  credentials: { username: "svc", password: "svc-pw" },
  cameras: [{ cameraId: "cam-1", name: "Front Desk", url: `rtsp://admin:${CAM_PW}@10.0.0.5:554/main` }],
});

async function freshStateDir(tag) {
  const dir = await mkdtemp(join(tmpdir(), `camplat-push-delivery-${tag}-`));
  await mkdir(join(dir, "disk0"), { recursive: true });
  return dir;
}

/* ============================================================= HTTP routes */

{
  const stateDir = await freshStateDir("routes");
  const config = configFor(stateDir);
  const index = openIndex(join(stateDir, "index.db"));

  let principal = { kind: "user", username: "tech", role: "installer" };
  const audits = [];
  const auth = {
    principalOf: () => principal,
    handle: async () => false,
    audit: (event, _req, fields) => audits.push({ event, ...fields }),
    standingOf: STANDING_OF,
  };
  const seenFetches = [];
  const fetchFn = async () => { seenFetches.push(1); return { status: 201, headers: { get: () => null } }; };

  const server = createApiServer({ stateDir, config, index, auth, decideRouteImpl: realDecideRoute, pushFetchFn: fetchFn });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
    return { status: res.status, json, text };
  };
  const noSecrets = (text, what) => {
    if (text.includes(CAM_PW) || /rtsp:\/\//i.test(text)) throw new Error(`${what} carries a camera credential or address: ${text}`);
  };

  await check("GET /push/public-key: creates the identity once and hands back only the public half", async () => {
    const a = await send("GET", "/push/public-key");
    eq(a.status, 200);
    eq(a.json.ok, true);
    eq(typeof a.json.publicKey, "string");
    eq(a.json.publicKey.length > 0, true);
    const b = await send("GET", "/push/public-key");
    eq(b.json.publicKey, a.json.publicKey, "the SAME identity on the next call, not regenerated");
    noSecrets(a.text, "GET /push/public-key");
  });

  await check("public-key: signed out is 401, a wall display is 403, store/manager/installer are all 200 (same reach as events.view)", async () => {
    principal = { kind: "anonymous" };
    eq((await send("GET", "/push/public-key")).status, 401);
    principal = { kind: "display", displayId: "wall-1" };
    eq((await send("GET", "/push/public-key")).status, 403);
    for (const p of [
      { kind: "user", username: "tech", role: "installer" },
      { kind: "user", username: "regional", role: "manager" },
      { kind: "user", username: "clerk", role: "store" },
    ]) {
      principal = p;
      eq((await send("GET", "/push/public-key")).status, 200, p.role);
    }
  });

  let techSubId = null;
  await check("POST /push/subscribe: adds a device for the signed-in account, audited, without ever echoing the endpoint or keys", async () => {
    principal = { kind: "user", username: "tech", role: "installer" };
    audits.length = 0;
    const sub = GOOD_SUBSCRIPTION();
    const r = await send("POST", "/push/subscribe", { subscription: sub, label: "Tech's phone", rules: "all" });
    eq(r.status, 200);
    eq(r.json.ok, true);
    eq(typeof r.json.subscription.id, "string");
    eq(r.json.subscription.label, "Tech's phone");
    eq(r.json.subscription.endpointHost, new URL(sub.endpoint).host, "the host only, never the full endpoint");
    eq(r.text.includes(sub.endpoint), false, "THE FEARED ONE: the raw endpoint never appears in the response");
    eq(r.text.includes(sub.keys.p256dh), false, "nor a key");
    eq(audits, [{ event: "push.subscribe", actor: "tech", id: r.json.subscription.id, label: "Tech's phone" }]);
    eq(JSON.stringify(audits).includes(sub.endpoint), false, "nor in the audit line");
    techSubId = r.json.subscription.id;
  });

  await check("POST /push/subscribe: a malformed body is refused before anything is written", async () => {
    const r = await send("POST", "/push/subscribe", { label: "no subscription field" });
    eq(r.status, 400);
    eq(r.json.code, "bad_subscription");
  });

  let clerkSubId = null;
  await check("GET /push/my-subscriptions: an account sees only its own, endpoint shown only as its host, never keys", async () => {
    principal = { kind: "user", username: "clerk", role: "store" };
    const sub = GOOD_SUBSCRIPTION();
    const added = await send("POST", "/push/subscribe", { subscription: sub, label: "Clerk's phone" });
    clerkSubId = added.json.subscription.id;

    const mine = await send("GET", "/push/my-subscriptions");
    eq(mine.json.subscriptions.map((s) => s.id), [clerkSubId], "clerk sees only clerk's own device");
    eq(mine.text.includes(sub.endpoint), false, "no raw endpoint");
    eq(Object.prototype.hasOwnProperty.call(mine.json.subscriptions[0], "p256dh"), false, "no key field at all");

    principal = { kind: "user", username: "tech", role: "installer" };
    const techs = await send("GET", "/push/my-subscriptions");
    eq(techs.json.subscriptions.map((s) => s.id), [techSubId], "THE FEARED ONE: tech never sees clerk's device, or the other way round");
  });

  await check("POST /push/unsubscribe/<id>: removes only the caller's own, a stranger's id is refused as not_found", async () => {
    principal = { kind: "user", username: "clerk", role: "store" };
    audits.length = 0;
    const wrong = await send("POST", `/push/unsubscribe/${techSubId}`, undefined);
    eq(wrong.status, 404, "THE FEARED ONE: clerk cannot remove tech's device by guessing its id");
    eq(wrong.json.code, "not_found");
    eq(audits.length, 0, "no audit line for a refused removal");

    const ok = await send("POST", `/push/unsubscribe/${clerkSubId}`, undefined);
    eq(ok.status, 200);
    eq(audits, [{ event: "push.unsubscribe", actor: "clerk", id: clerkSubId }]);
    const after = await send("GET", "/push/my-subscriptions");
    eq(after.json.subscriptions, [], "gone");
  });

  await check("GET /push/counts: the installer's own per-account view, counts only, never an endpoint", async () => {
    principal = { kind: "user", username: "tech", role: "installer" };
    const r = await send("GET", "/push/counts");
    eq(r.status, 200);
    eq(r.json.counts, { tech: 1 }, "clerk's was just removed above; tech's one device remains");
    noSecrets(r.text, "GET /push/counts");

    principal = { kind: "user", username: "regional", role: "manager" };
    eq((await send("GET", "/push/counts")).status, 403, "a manager has no reason to see every account's count");
    principal = { kind: "user", username: "clerk", role: "store" };
    eq((await send("GET", "/push/counts")).status, 403, "nor a store account");
  });

  await check("POST /push/test: sends to the caller's own devices via the injected fetch, no real network, rate-limited to 1 per 30s", async () => {
    principal = { kind: "user", username: "tech", role: "installer" };
    seenFetches.length = 0;
    const first = await send("POST", "/push/test", undefined);
    eq(first.status, 200);
    eq(first.json.results.length, 1, "tech's one device");
    eq(first.json.results[0].outcome, "sent");
    eq(seenFetches.length, 1, "the fake fetch was called; the real network never was");

    const second = await send("POST", "/push/test", undefined);
    eq(second.status, 429, "THE FEARED ONE: a second test inside the 30s window is refused, not sent again");
    eq(second.json.code, "rate_limited");
    eq(seenFetches.length, 1, "no second send happened");
  });

  await check("POST /push/test: an account with no devices is refused plainly, not sent to nobody silently", async () => {
    principal = { kind: "user", username: "regional", role: "manager" };
    const r = await send("POST", "/push/test", undefined);
    eq(r.status, 404);
    eq(r.json.code, "no_devices");
  });

  closeAll();
  server.close();
  server.closeManagerRulesEvaluator();
  server.closePushDelivery();
  server.closeEventRetention();
  server.closeOccupancy();
  server.closeRules();
  index.close();
  await rm(stateDir, { recursive: true, force: true });
}

/* ================================================================ the loop */

/** A fake, fully injected fetch: `plan(endpoint)` sets an ARRAY of
 *  `{status}` or `{network:true}` responses, consumed one per call to that
 *  endpoint. A call past the end of its plan is a test bug, thrown loudly --
 *  this is what proves a firing is never sent twice: the harness itself
 *  cannot be fooled into quietly supplying a response for an attempt it
 *  never expected to happen. */
function makeFetch() {
  const plans = new Map(); // endpoint -> responses[]
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const queue = plans.get(url);
    if (!queue || queue.length === 0) {
      throw new Error(`THE FEARED ONE: a send happened to ${url} with no response planned -- an unexpected extra attempt, possibly a double-send`);
    }
    const next = queue.shift();
    if (next.network) throw new Error("simulated network failure -- no HTTP response was ever received");
    return { status: next.status, headers: { get: () => null } };
  };
  return {
    fetchFn,
    plan: (endpoint, responses) => plans.set(endpoint, [...responses]),
    callsTo: (endpoint) => calls.filter((c) => c === endpoint).length,
  };
}

/** Inserts one firing directly into rules.db, bypassing the evaluator
 *  entirely -- this file proves DELIVERY, which starts from a firing already
 *  on disk however it got there (build rule 2: split I/O from maths; the
 *  evaluator's own maths is managerRules.harness.mjs's job, not this file's).
 *  Returns the inserted row's own id, since deliveries.firing_id needs it and
 *  no other reader of this table has ever cared. */
function insertFiring(rdb, { ruleId, ruleName = "Manager's desk unattended", cameraId = "cam-1", startMs, text, alertWanted = true }) {
  rdb.insert({
    ruleId, ruleName, cameraId, areaId: null, kind: "person", what: "absent_longer_than",
    complete: true, startMs, endMs: startMs + 60_000, durationMs: 60_000,
    text: text ?? `${ruleName} at ${new Date(startMs).toISOString()}`,
    alertWanted, reportWanted: true,
  });
  return rdb.firingsWantingAlert().find((f) => f.ruleId === ruleId && f.startMs === startMs).id;
}

const T0 = Date.parse("2026-09-28T14:00:00Z");

/**
 * One rules.db + one push-subscriptions.json, a fully controlled clock and
 * fetch, and a real createPushDelivery calling the real rules-db.mjs and
 * push-store.mjs -- only the network (fetchFn) and the account directory
 * (standingOf) are faked. `pushStoreNow` lets one test give subscriptions a
 * specific createdUtc (the "no flood" check below needs to).
 */
async function makeHarness(tag, { isManagerRulesEnabled = () => true, pushStoreNow } = {}) {
  const stateDir = await freshStateDir(tag);
  const rdb = openRulesDb(join(stateDir, "rules.db"));
  const clock = { ms: T0 };
  // push-delivery.mjs's own no-flood filter compares a firing's startMs
  // against Date.parse(subscription.createdUtc) -- so the subscription
  // store must stamp createdUtc from the SAME injected clock every other
  // component here is driven by. createPushSubscriptionStore's own default
  // `now` is the REAL wall clock (agent/push-store.mjs); left unset, every
  // subscription below gets created at real "today", which is already past
  // the fixed T0 the REQUIRED cases insert their firings at -- the no-flood
  // filter then discards them before delivery ever reaches the network.
  // `pushStoreNow` still lets one case override with its own fixed instant.
  const pushStore = createPushSubscriptionStore({ stateDir, now: pushStoreNow ?? (() => new Date(clock.ms)) });
  const audits = [];
  const fake = makeFetch();
  const delivery = createPushDelivery({
    stateDir,
    getRulesDb: () => rdb,
    pushStore,
    standingOf: STANDING_OF,
    isManagerRulesEnabled,
    audit: (event, _req, fields) => audits.push({ event, ...fields }),
    now: () => new Date(clock.ms),
    log: () => {},
    fetchFn: fake.fetchFn,
  });
  return { stateDir, rdb, pushStore, clock, fake, delivery, audits };
}

async function cleanup(h) {
  h.rdb.close();
  await rm(h.stateDir, { recursive: true, force: true });
}

/** The delivery row for the one (firing, subscription) pair a single-firing,
 *  single-subscription scenario cares about — asserts there is exactly one
 *  row before returning it, so a test that expects "nothing else happened"
 *  cannot be fooled by a second row it never looked at. */
function onlyDeliveryRow(rdb) {
  const rows = rdb.allDeliveries();
  eq(rows.length, 1, `exactly one delivery row, got ${JSON.stringify(rows)}`);
  return rows[0];
}

await check("REQUIRED: 201 is recorded sent, and never re-sent on further passes", async () => {
  const h = await makeHarness("sent");
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" });
    insertFiring(h.rdb, { ruleId: "rule-sent", startMs: T0 });
    h.fake.plan(sub.endpoint, [{ status: 201 }]);

    await h.delivery.runSenderPass();
    eq(onlyDeliveryRow(h.rdb).state, "sent");
    eq(h.fake.callsTo(sub.endpoint), 1);

    await h.delivery.runSenderPass();
    await h.delivery.runSenderPass();
    eq(h.fake.callsTo(sub.endpoint), 1, "THE FEARED ONE: no further pass re-sends an already-sent firing");
  } finally { await cleanup(h); }
});

await check("REQUIRED: 404 deletes the subscription and records the delivery gone", async () => {
  const h = await makeHarness("gone");
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" });
    insertFiring(h.rdb, { ruleId: "rule-gone", startMs: T0 });
    h.fake.plan(sub.endpoint, [{ status: 404 }]);

    await h.delivery.runSenderPass();
    eq(onlyDeliveryRow(h.rdb).state, "gone");
    const { subscriptions } = await h.pushStore.listOwn("tech");
    eq(subscriptions.length, 0, "the dead subscription is gone from push-subscriptions.json");

    // A further pass must never try that endpoint again -- the row is
    // terminal AND the subscription itself no longer exists to iterate over.
    await h.delivery.runSenderPass();
    eq(h.fake.callsTo(sub.endpoint), 1);
  } finally { await cleanup(h); }
});

await check("REQUIRED: 410 deletes the subscription and records the delivery gone (the SAME rule as 404)", async () => {
  const h = await makeHarness("gone-410");
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" });
    insertFiring(h.rdb, { ruleId: "rule-gone-410", startMs: T0 });
    h.fake.plan(sub.endpoint, [{ status: 410 }]);

    await h.delivery.runSenderPass();
    eq(onlyDeliveryRow(h.rdb).state, "gone");
    const { subscriptions } = await h.pushStore.listOwn("tech");
    eq(subscriptions.length, 0, "the dead subscription is gone from push-subscriptions.json");

    await h.delivery.runSenderPass();
    eq(h.fake.callsTo(sub.endpoint), 1);
  } finally { await cleanup(h); }
});

await check("REQUIRED: a subscription that goes gone (404/410) on the FIRST firing in a pass gets exactly one network call for that pass, never a second one for a later pending firing to the same subscription", async () => {
  const h = await makeHarness("gone-once-per-pass");
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" });
    insertFiring(h.rdb, { ruleId: "rule-gone-a", startMs: T0 });
    insertFiring(h.rdb, { ruleId: "rule-gone-b", startMs: T0 + 1 });
    // Only ONE response planned: a second attempt within this same pass
    // would hit the fake's own "no response planned" refusal below anyway,
    // but this also proves the count directly.
    h.fake.plan(sub.endpoint, [{ status: 404 }]);

    await h.delivery.runSenderPass();
    const rows = h.rdb.allDeliveries();
    eq(rows.length, 1, "THE FEARED ONE: the second firing never even got a delivery row attempted against the now-gone subscription");
    eq(rows[0].state, "gone");
    eq(h.fake.callsTo(sub.endpoint), 1, "THE FEARED ONE: exactly one network call for a dead endpoint in one pass, regardless of how many firings were pending for it");

    await h.delivery.runSenderPass();
    eq(h.fake.callsTo(sub.endpoint), 1, "and still just one call on a later pass -- the subscription no longer exists to iterate over");
  } finally { await cleanup(h); }
});

await check("REQUIRED: 429 retries once on its own schedule, then a 201 sends", async () => {
  const h = await makeHarness("retry-429");
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" });
    insertFiring(h.rdb, { ruleId: "rule-429", startMs: T0 });
    h.fake.plan(sub.endpoint, [{ status: 429 }, { status: 201 }]);

    await h.delivery.runSenderPass();
    let row = onlyDeliveryRow(h.rdb);
    eq(row.state, "retry");
    eq(row.attempts, 1);
    eq(row.nextAtMs, T0 + 60_000, "the schedule's own first delay, 1 minute");

    await h.delivery.runSenderPass(); // not due yet
    eq(h.fake.callsTo(sub.endpoint), 1, "never retried before its own next_at_ms");

    h.clock.ms = row.nextAtMs + 1;
    await h.delivery.runSenderPass();
    row = onlyDeliveryRow(h.rdb);
    eq(row.state, "sent");
    eq(h.fake.callsTo(sub.endpoint), 2, "exactly one retry, then sent -- never a third call");
  } finally { await cleanup(h); }
});

await check("REQUIRED: a network error retries on the same schedule as 5xx", async () => {
  const h = await makeHarness("retry-network");
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" });
    insertFiring(h.rdb, { ruleId: "rule-network", startMs: T0 });
    h.fake.plan(sub.endpoint, [{ network: true }, { status: 201 }]);

    await h.delivery.runSenderPass();
    let row = onlyDeliveryRow(h.rdb);
    eq(row.state, "retry");
    eq(row.attempts, 1);
    eq(row.lastCode, null, "no HTTP status was ever received");

    h.clock.ms = row.nextAtMs + 1;
    await h.delivery.runSenderPass();
    row = onlyDeliveryRow(h.rdb);
    eq(row.state, "sent");
    eq(h.fake.callsTo(sub.endpoint), 2);
  } finally { await cleanup(h); }
});

await check("REQUIRED: 500 retries three times on the 1/5/30-minute schedule, then fails and stops", async () => {
  const h = await makeHarness("retry-500");
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" });
    insertFiring(h.rdb, { ruleId: "rule-500", startMs: T0 });
    h.fake.plan(sub.endpoint, [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);

    const expectedDelays = [60_000, 300_000, 1_800_000];
    for (let i = 0; i < 3; i += 1) {
      await h.delivery.runSenderPass();
      const row = onlyDeliveryRow(h.rdb);
      eq(row.state, "retry", `attempt ${i}`);
      eq(row.attempts, i + 1, `attempt ${i}`);
      const priorNextAt = i === 0 ? T0 : h.clock.ms;
      eq(row.nextAtMs, priorNextAt + expectedDelays[i], `attempt ${i}'s own delay`);
      h.clock.ms = row.nextAtMs + 1;
    }
    await h.delivery.runSenderPass(); // the 4th attempt: schedule exhausted
    const row = onlyDeliveryRow(h.rdb);
    eq(row.state, "failed");
    eq(h.fake.callsTo(sub.endpoint), 4, "one initial attempt plus exactly three retries");

    await h.delivery.runSenderPass();
    eq(h.fake.callsTo(sub.endpoint), 4, "THE FEARED ONE: never retried again once the schedule is exhausted");
  } finally { await cleanup(h); }
});

await check("REQUIRED: a crash mid-loop never double-sends on restart -- a stale 'sending' claim is resolved to failed, never resent", async () => {
  const h = await makeHarness("crash");
  try {
    const sub = GOOD_SUBSCRIPTION();
    const added = await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" });
    const firingId = insertFiring(h.rdb, { ruleId: "rule-crash", startMs: T0 });
    // A response IS planned -- proving the point requires that a send would
    // have succeeded if this file's own claim-before-send discipline failed
    // and the pass tried anyway.
    h.fake.plan(sub.endpoint, [{ status: 201 }]);

    // Simulate the previous process: it claimed this pair 'sending' and then
    // never came back (a crash between the network call and recording its
    // outcome) -- rules-db.mjs's own schema comment on this state.
    h.rdb.claimSending(firingId, added.subscription.id, T0 - 5_000);

    await h.delivery.runSenderPass();
    const row = onlyDeliveryRow(h.rdb);
    eq(row.state, "failed", "resolved to failed -- the outcome of the crashed attempt is unknown, and it is never guessed as safe to repeat");
    eq(h.fake.callsTo(sub.endpoint), 0, "THE FEARED ONE: no send was ever attempted for a claim left over from a crash, although one would have succeeded");
  } finally { await cleanup(h); }
});

await check("REQUIRED: managerRules off means no sends, and no delivery row is even created", async () => {
  const h = await makeHarness("off", { isManagerRulesEnabled: () => false });
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" });
    insertFiring(h.rdb, { ruleId: "rule-off", startMs: T0 });
    h.fake.plan(sub.endpoint, [{ status: 201 }]);

    await h.delivery.runSenderPass();
    eq(h.rdb.allDeliveries().length, 0);
    eq(h.fake.callsTo(sub.endpoint), 0);
  } finally { await cleanup(h); }
});

await check("REQUIRED: an account opted in to specific rules gets only those rules", async () => {
  const h = await makeHarness("rule-selection");
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: ["rule-wanted"] });
    insertFiring(h.rdb, { ruleId: "rule-wanted", startMs: T0 });
    insertFiring(h.rdb, { ruleId: "rule-not-wanted", startMs: T0 + 1 });
    h.fake.plan(sub.endpoint, [{ status: 201 }, { status: 201 }]);

    await h.delivery.runSenderPass();
    const rows = h.rdb.allDeliveries();
    eq(rows.length, 1, "THE FEARED ONE: no row at all for the rule this device never opted into");
    eq(rows[0].firingId, h.rdb.firingsWantingAlert().find((f) => f.ruleId === "rule-wanted").id);
    eq(h.fake.callsTo(sub.endpoint), 1);
  } finally { await cleanup(h); }
});

await check("REQUIRED: a subscription only receives firings from AFTER it was created -- a new phone is never flooded with history", async () => {
  const h = await makeHarness("no-flood", { pushStoreNow: () => new Date(T0) });
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" }); // createdUtc === T0
    insertFiring(h.rdb, { ruleId: "rule-history", startMs: T0 - 3_600_000 }); // an hour BEFORE the subscription existed
    insertFiring(h.rdb, { ruleId: "rule-future", startMs: T0 + 1 }); // just after
    h.fake.plan(sub.endpoint, [{ status: 201 }]);

    await h.delivery.runSenderPass();
    const rows = h.rdb.allDeliveries();
    eq(rows.length, 1, "THE FEARED ONE: no delivery row at all for the firing that predates the subscription");
    eq(rows[0].firingId, h.rdb.firingsWantingAlert().find((f) => f.ruleId === "rule-future").id);
  } finally { await cleanup(h); }
});

await check("REQUIRED: a payload over the plaintext budget is refused whole, never sent truncated, and never retried", async () => {
  const h = await makeHarness("too-big");
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "tech", rawSubscription: sub, label: null, rules: "all" });
    insertFiring(h.rdb, { ruleId: "rule-too-big", startMs: T0, text: "x".repeat(MAX_PLAINTEXT_BYTES + 500) });
    // No response planned at all: if this ever reached the network, the
    // fake's own refusal (see makeFetch) would fail the test outright.

    await h.delivery.runSenderPass();
    const row = onlyDeliveryRow(h.rdb);
    eq(row.state, "failed");
    eq(row.lastCode, null, "no HTTP status: the network was never touched");
    eq(h.fake.callsTo(sub.endpoint), 0, "THE FEARED ONE: never sent, truncated or otherwise");

    await h.delivery.runSenderPass();
    eq(h.fake.callsTo(sub.endpoint), 0, "and never retried on a later pass either -- the payload will not get shorter");
  } finally { await cleanup(h); }
});

await check("REQUIRED: an account that never subscribed itself receives nothing -- no row, no send, for anyone who never opted in", async () => {
  const h = await makeHarness("no-subscribers");
  try {
    insertFiring(h.rdb, { ruleId: "rule-nobody", startMs: T0 });
    await h.delivery.runSenderPass();
    eq(h.rdb.allDeliveries().length, 0);
  } finally { await cleanup(h); }
});

await check("REQUIRED: standing is re-checked fresh every pass -- a subscription for an account with no permission left is never sent to", async () => {
  const h = await makeHarness("standing");
  try {
    const sub = GOOD_SUBSCRIPTION();
    await h.pushStore.add({ username: "ex-employee", rawSubscription: sub, label: null, rules: "all" });
    insertFiring(h.rdb, { ruleId: "rule-standing", startMs: T0 });
    // No response planned: STANDING_OF("ex-employee") is { role: null } (no
    // such account any more, or never one events.view/rules.manage reaches)
    // -- mayReceiveFiring must refuse before this ever calls the network.
    await h.delivery.runSenderPass();
    eq(h.rdb.allDeliveries().length, 0, "THE FEARED ONE: an installer who was removed, or demoted, keeps getting nothing the moment standing is re-checked");
  } finally { await cleanup(h); }
});

report("push delivery");
