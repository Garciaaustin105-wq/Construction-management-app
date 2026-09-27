/**
 * agent/push-store.mjs (MANAGER-ALERTS-SPEC.md, build 2: phone alerts) --
 * vapid.json and push-subscriptions.json.
 *
 * THE FEARED FAILURES, in order:
 * - the VAPID private key reaching anywhere but the file it lives in: a
 *   return value, a thrown error's message, or console output -- even when
 *   the state directory holds a fuzzed push-subscriptions.json full of
 *   other accounts' endpoints too;
 * - a corrupt or hand-tampered vapid.json being silently replaced instead
 *   of refused, which would orphan every phone subscribed with the old key;
 * - two callers racing to create the FIRST VAPID identity for a fresh
 *   stateDir and ending up with two different ones;
 * - a subscription for one account being listed, counted-with-an-endpoint,
 *   or removed by a DIFFERENT account;
 * - a corrupt push-subscriptions.json being silently rebuilt from empty,
 *   dropping every other account's subscription.
 */
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { check, eq, same, report } from "./_assert.mjs";
import {
  loadOrCreatePublicVapidKey, sendManagerAlertPush, VAPID_FILE, VAPID_VERSION,
  createPushSubscriptionStore, PUSH_SUBSCRIPTIONS_FILE,
} from "../agent/push-store.mjs";
import { generateP256KeyPair, toBase64Url } from "../agent/web-push.mjs";

console.log("push store");

const root = await mkdtemp(join(tmpdir(), "camplat-push-store-"));
let dirCounter = 0;
async function freshStateDir() {
  const dir = join(root, `state-${dirCounter++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// A real point on the P-256 curve (a fresh key pair's public half) -- random
// bytes with the right LENGTH pass validateSubscription's own check, but
// fail later at the actual ECDH step encryptPayload performs, which is not
// what these tests are about. Each call gets its own endpoint (a random
// path), since "deduplicate on endpoint" means two subscriptions sharing one
// endpoint are the SAME device, not two -- exactly one other test's own point.
let endpointCounter = 0;
const GOOD_SUBSCRIPTION = () => ({
  endpoint: `https://push.example.com/dev-${endpointCounter++}-${randomBytes(6).toString("hex")}`,
  keys: {
    p256dh: toBase64Url(generateP256KeyPair().publicKey),
    auth: randomBytes(16).toString("base64url"),
  },
});

/* =============================================================== vapid.json */

await check("loadOrCreatePublicVapidKey creates on first use, and returns the SAME key on every later call", async () => {
  const dir = await freshStateDir();
  const first = await loadOrCreatePublicVapidKey(dir);
  eq(first.created, true, "first call created it");
  eq(Buffer.isBuffer(first.publicKey), true, "publicKey is a Buffer");
  eq(first.publicKey.length, 65, "an uncompressed P-256 point");
  eq(first.publicKey[0], 0x04, "starts with the uncompressed-point marker");

  const second = await loadOrCreatePublicVapidKey(dir);
  eq(second.created, false, "second call did not create it again");
  eq(Buffer.compare(second.publicKey, first.publicKey), 0, "same public key");
  eq(second.createdUtc, first.createdUtc, "same createdUtc -- not regenerated");
});

await check("vapid.json is written mode 0600 where the OS supports it (skip loudly on Windows)", async () => {
  const dir = await freshStateDir();
  const originalError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    await loadOrCreatePublicVapidKey(dir);
  } finally {
    console.error = originalError;
  }
  const st = await stat(join(dir, VAPID_FILE));
  if (process.platform === "win32") {
    eq(logged.some((l) => l.toLowerCase().includes("windows")), true, "a loud warning names Windows when the mode could not be applied");
  } else {
    eq(st.mode & 0o777, 0o600, "file mode is exactly 0600");
  }
});

await check("vapid.json records version, createdUtc, and base64url public/private keys of the right lengths", async () => {
  const dir = await freshStateDir();
  await loadOrCreatePublicVapidKey(dir);
  const record = JSON.parse(await readFile(join(dir, VAPID_FILE), "utf8"));
  eq(record.version, VAPID_VERSION);
  eq(typeof record.createdUtc, "string");
  eq(Buffer.from(record.publicKey, "base64url").length, 65);
  eq(Buffer.from(record.privateKey, "base64url").length, 32);
});

await check("a corrupt (not-JSON) vapid.json is refused, and left untouched -- never silently regenerated", async () => {
  const dir = await freshStateDir();
  const file = join(dir, VAPID_FILE);
  await writeFile(file, "{ not json at all");
  let threw = null;
  try {
    await loadOrCreatePublicVapidKey(dir);
  } catch (err) {
    threw = err;
  }
  eq(threw !== null, true, "refuses rather than regenerating");
  eq(threw.message.toLowerCase().includes("refused"), true, "the error says it was refused");
  eq(threw.message.toLowerCase().includes("orphan"), true, "explains WHY it refuses rather than replaces");
  const after = await readFile(file, "utf8");
  eq(after, "{ not json at all", "the corrupt file is byte-for-byte unchanged");
});

for (const [label, mutate] of [
  ["missing privateKey", (r) => { delete r.privateKey; return r; }],
  ["missing publicKey", (r) => { delete r.publicKey; return r; }],
  ["wrong version", (r) => ({ ...r, version: 999 })],
  ["unparsable createdUtc", (r) => ({ ...r, createdUtc: "not a date" })],
  ["publicKey too short", (r) => ({ ...r, publicKey: Buffer.from([0x04, 1, 2, 3]).toString("base64url") })],
  ["privateKey wrong length", (r) => ({ ...r, privateKey: Buffer.from([1, 2, 3]).toString("base64url") })],
]) {
  await check(`a structurally broken vapid.json (${label}) is refused, never replaced`, async () => {
    const dir = await freshStateDir();
    await loadOrCreatePublicVapidKey(dir);
    const file = join(dir, VAPID_FILE);
    const record = mutate(JSON.parse(await readFile(file, "utf8")));
    await writeFile(file, JSON.stringify(record, null, 2));
    let threw = null;
    try {
      await loadOrCreatePublicVapidKey(dir);
    } catch (err) {
      threw = err;
    }
    eq(threw !== null, true, `refused: ${label}`);
  });
}

await check("concurrent loadOrCreatePublicVapidKey calls in ONE process for a fresh stateDir all agree on one key", async () => {
  const dir = await freshStateDir();
  const results = await Promise.all([loadOrCreatePublicVapidKey(dir), loadOrCreatePublicVapidKey(dir), loadOrCreatePublicVapidKey(dir)]);
  const keys = new Set(results.map((r) => r.publicKey.toString("base64url")));
  eq(keys.size, 1, "every concurrent caller sees the same public key, not several different ones");
  eq(results.filter((r) => r.created).length >= 1, true, "at least one call reports having created it");
});

function runInWorker(stateDir, startAtMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL("./_pushStoreWorker.mjs", import.meta.url), { workerData: { stateDir, startAtMs } });
    worker.once("message", (msg) => { resolvePromise(msg); worker.terminate(); });
    worker.once("error", rejectPromise);
  });
}

await check("two workers (standing in for two SEPARATE processes) racing to create the FIRST vapid.json for a fresh stateDir agree on one public key", async () => {
  const dir = await freshStateDir();
  const startAtMs = Date.now() + 150;
  const [a, b] = await Promise.all([runInWorker(dir, startAtMs), runInWorker(dir, startAtMs)]);
  eq(a.ok, true, `worker A succeeded (${a.message ?? ""})`);
  eq(b.ok, true, `worker B succeeded (${b.message ?? ""})`);
  eq(a.publicKey, b.publicKey, "both workers agree on the same public key");
  eq([a.created, b.created].filter(Boolean).length, 1, "exactly one of the two writes became the file");
});

await check("sendManagerAlertPush signs and sends with this box's own VAPID identity, via a fake fetch -- no network, no key in the result", async () => {
  const dir = await freshStateDir();
  const pub = await loadOrCreatePublicVapidKey(dir);
  let seenRequest = null;
  const fetchFn = async (url, init) => {
    seenRequest = { url, init };
    return { status: 201, headers: { get: () => null } };
  };
  const result = await sendManagerAlertPush(dir, {
    subscription: GOOD_SUBSCRIPTION(),
    payload: "hello",
    contact: "mailto:ops@example.com",
    ttlSeconds: 60,
    fetchFn,
  });
  eq(result.outcome, "sent");
  eq(seenRequest !== null, true, "fetchFn was actually called (no real network call was made)");
  eq(seenRequest.init.headers.Authorization.startsWith("vapid t="), true, "signed with a VAPID authorization header");
  eq(JSON.stringify(result).includes("BEGIN"), false, "no key material in sendManagerAlertPush's own result");
});

/* ============================ THE FEARED ONE (vapid) ================= */

await check("THE FEARED ONE: the VAPID private key never appears in loadOrCreatePublicVapidKey's return, a refusal's message, console output, or sendManagerAlertPush's result", async () => {
  const dir = await freshStateDir();
  const originalError = console.error;
  const originalLog = console.log;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  console.log = (...a) => logged.push(a.join(" "));
  let pub;
  try {
    pub = await loadOrCreatePublicVapidKey(dir);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  const record = JSON.parse(await readFile(join(dir, VAPID_FILE), "utf8"));
  const privateKeyMark = record.privateKey; // the real secret, straight from the file it is allowed to live in

  eq(Object.prototype.hasOwnProperty.call(pub, "privateKey"), false, "no privateKey field at all on the returned object");
  eq(JSON.stringify(pub).includes(privateKeyMark), false, "loadOrCreatePublicVapidKey's return value never carries the private key");
  for (const line of logged) {
    eq(line.includes(privateKeyMark), false, "console output during creation must not contain the private key");
  }

  const sendResult = await sendManagerAlertPush(dir, {
    subscription: GOOD_SUBSCRIPTION(),
    payload: "hi",
    contact: "mailto:ops@example.com",
    ttlSeconds: 60,
    fetchFn: async () => ({ status: 201, headers: { get: () => null } }),
  });
  eq(JSON.stringify(sendResult).includes(privateKeyMark), false, "sendManagerAlertPush's own result never carries the private key");

  // Now force a refusal on a SEPARATE, deliberately corrupted file and make
  // sure that error's message does not echo the private key it holds.
  const dir2 = await freshStateDir();
  await loadOrCreatePublicVapidKey(dir2);
  const file2 = join(dir2, VAPID_FILE);
  const record2 = JSON.parse(await readFile(file2, "utf8"));
  const mark2 = `MARK-vapid-${randomBytes(8).toString("hex")}`;
  const realPrivateKey2 = record2.privateKey;
  record2.privateKey = `${realPrivateKey2}${mark2}`; // still garbage enough to fail base64url decode length checks
  await writeFile(file2, JSON.stringify(record2, null, 2));
  let refusalMessage = "";
  try {
    await loadOrCreatePublicVapidKey(dir2);
    throw new Error("expected a refusal");
  } catch (err) {
    refusalMessage = err.message;
  }
  eq(refusalMessage.includes(mark2), false, "a refusal's message must not echo any part of the private key field");
  eq(refusalMessage.includes(realPrivateKey2), false, "nor the original private key either");
});

/* ==================================================== push-subscriptions.json */

await check("add() validates the crypto shape first: a malformed subscription is refused with invalid_subscription, nothing written", async () => {
  const dir = await freshStateDir();
  const store = createPushSubscriptionStore({ stateDir: dir });
  const r = await store.add({ username: "mgr1", rawSubscription: { endpoint: "http://not-https.example.com/x", keys: { p256dh: "a", auth: "b" } }, label: null, rules: "all" });
  eq(r.ok, false);
  eq(r.code, "invalid_subscription");
  let exists = true;
  try { await stat(join(dir, PUSH_SUBSCRIPTIONS_FILE)); } catch { exists = false; }
  eq(exists, false, "nothing was written");
});

await check("add() then listOwn(): the row is visible to its own account, at mode 0600", async () => {
  const dir = await freshStateDir();
  const store = createPushSubscriptionStore({ stateDir: dir });
  const r = await store.add({ username: "mgr1", rawSubscription: GOOD_SUBSCRIPTION(), label: "iPhone Safari", rules: "all" });
  eq(r.ok, true);
  const { subscriptions } = await store.listOwn("mgr1");
  eq(subscriptions.length, 1);
  eq(subscriptions[0].label, "iPhone Safari");
  if (process.platform !== "win32") {
    const st = await stat(join(dir, PUSH_SUBSCRIPTIONS_FILE));
    eq(st.mode & 0o777, 0o600, "push-subscriptions.json is mode 0600");
  }
});

await check("REQUIRED: an account sees and removes only its own subscriptions, never another account's", async () => {
  const dir = await freshStateDir();
  const store = createPushSubscriptionStore({ stateDir: dir });
  const a = await store.add({ username: "mgr1", rawSubscription: GOOD_SUBSCRIPTION(), label: "A's phone", rules: "all" });
  const b = await store.add({ username: "mgr2", rawSubscription: GOOD_SUBSCRIPTION(), label: "B's phone", rules: "all" });
  eq(a.ok, true);
  eq(b.ok, true);

  const ownA = await store.listOwn("mgr1");
  eq(ownA.subscriptions.length, 1);
  eq(ownA.subscriptions[0].username, "mgr1");

  const removeOthers = await store.removeOwn({ username: "mgr1", id: b.subscription.id });
  eq(removeOthers.ok, false, "mgr1 cannot remove mgr2's subscription by id");
  eq(removeOthers.code, "not_found");

  const stillThere = await store.listOwn("mgr2");
  eq(stillThere.subscriptions.length, 1, "mgr2's subscription is untouched");

  const removeOwn = await store.removeOwn({ username: "mgr2", id: b.subscription.id });
  eq(removeOwn.ok, true);
  eq((await store.listOwn("mgr2")).subscriptions.length, 0);
  eq((await store.listOwn("mgr1")).subscriptions.length, 1, "mgr1's own subscription is unaffected by mgr2's remove");
});

await check("REQUIRED: accountCounts() gives a count per account and never an endpoint or key", async () => {
  const dir = await freshStateDir();
  const store = createPushSubscriptionStore({ stateDir: dir });
  await store.add({ username: "mgr1", rawSubscription: GOOD_SUBSCRIPTION(), label: null, rules: "all" });
  const secondSub = GOOD_SUBSCRIPTION();
  await store.add({ username: "mgr1", rawSubscription: secondSub, label: null, rules: "all" });
  await store.add({ username: "mgr2", rawSubscription: GOOD_SUBSCRIPTION(), label: null, rules: "all" });
  const { counts } = await store.accountCounts();
  same(counts, { mgr1: 2, mgr2: 1 });
  const text = JSON.stringify(counts);
  eq(text.includes("https://"), false, "no endpoint in the installer's own counts view");
  eq(text.includes(secondSub.keys.p256dh), false, "no key material either");
});

await check("REQUIRED: re-subscribing the SAME endpoint (deduplicate on endpoint) replaces the row, never doubles it", async () => {
  const dir = await freshStateDir();
  const store = createPushSubscriptionStore({ stateDir: dir });
  const sub = GOOD_SUBSCRIPTION();
  const first = await store.add({ username: "mgr1", rawSubscription: sub, label: "first label", rules: "all" });
  eq(first.ok, true);
  const second = await store.add({ username: "mgr1", rawSubscription: sub, label: "second label", rules: ["r1"] });
  eq(second.ok, true);
  const { subscriptions } = await store.listOwn("mgr1");
  eq(subscriptions.length, 1, "one row, not two, for the same endpoint");
  eq(subscriptions[0].label, "second label", "the newer row won");
  same(subscriptions[0].rules, ["r1"]);
});

await check("REQUIRED: a corrupt push-subscriptions.json refuses add() and removeOwn() rather than silently rebuilding it from empty", async () => {
  const dir = await freshStateDir();
  const store = createPushSubscriptionStore({ stateDir: dir });
  await store.add({ username: "mgr1", rawSubscription: GOOD_SUBSCRIPTION(), label: "keep me", rules: "all" });
  const file = join(dir, PUSH_SUBSCRIPTIONS_FILE);
  const before = await readFile(file, "utf8");
  await writeFile(file, "{ not json");

  const addResult = await store.add({ username: "mgr2", rawSubscription: GOOD_SUBSCRIPTION(), label: null, rules: "all" });
  eq(addResult.ok, false);
  eq(addResult.code, "subscriptions_unreadable");

  const removeResult = await store.removeOwn({ username: "mgr1", id: "whatever" });
  eq(removeResult.ok, false);
  eq(removeResult.code, "subscriptions_unreadable");

  const after = await readFile(file, "utf8");
  eq(after, "{ not json", "the corrupt file is byte-for-byte unchanged -- never overwritten by a refused save");
  eq(after === before, false, "sanity: the test actually corrupted it");
});

await check("a single bad row in an otherwise-good file is reported in `invalid`, never dropping every other row's read", async () => {
  const dir = await freshStateDir();
  const store = createPushSubscriptionStore({ stateDir: dir });
  const good = await store.add({ username: "mgr1", rawSubscription: GOOD_SUBSCRIPTION(), label: null, rules: "all" });
  eq(good.ok, true);
  const file = join(dir, PUSH_SUBSCRIPTIONS_FILE);
  const fileObj = JSON.parse(await readFile(file, "utf8"));
  fileObj.subscriptions.push({ id: "broken-row", username: "mgr2" }); // missing endpoint/p256dh/auth/createdUtc
  await writeFile(file, JSON.stringify(fileObj, null, 2));

  const { subscriptions, invalid } = await store.all();
  eq(subscriptions.length, 1, "the one good row still reads back");
  eq(invalid.length, 1, "the broken row is reported, not silently dropped without a trace");
  eq(invalid[0].id, "broken-row");
});

await rm(root, { recursive: true, force: true });
report("push store");
