// cloud/harness/dynamoKeys.harness.mjs — cloud/api/dynamoKeys.mjs (pure key
// and item shapes, condition expressions) AND cloud/api/dynamoStore.mjs's
// own control flow (CLOUD-AWS-SPEC.md section D lists this file's pure
// checks; the task that produced it also asked for the adapter's control
// flow to be proven here with a scripted fake `doc`).
//
// TWO DIFFERENT KINDS OF PROOF LIVE IN THIS ONE FILE:
//
//   1. Everything through "condition expression checks" below exercises
//      cloud/api/dynamoKeys.mjs ALONE -- pure functions, no SDK, no
//      network, no fake anything. These checks are exactly what
//      CLOUD-AWS-SPEC.md section D asks for.
//
//   2. Everything from "dynamoStore.mjs control flow" onward drives
//      cloud/api/dynamoStore.mjs through a scripted fake `doc` object whose
//      `send(command)` returns CANNED responses (or throws canned errors)
//      keyed on which Command class was constructed. THIS PROVES ONLY OUR
//      OWN CONTROL FLOW -- that a ConditionalCheckFailedException becomes
//      `false`/`"stale"` and not a throw, that any other error propagates,
//      that a permanently-unprocessed BatchGet/BatchWrite eventually gives
//      up and throws instead of looping forever, and that findDeviceByCode
//      rejects a stale index entry. IT PROVES NOTHING ABOUT WHETHER REAL
//      DYNAMODB ACTUALLY BEHAVES THE WAY THE FAKE SCRIPTS IT TO -- no
//      table exists yet (CLOUD-AWS-SPEC.md's own opening paragraph), and
//      only cloud/harness/storeConformance.harness.mjs run with
//      CAMPLAT_STORE=dynamo against a real table can prove that. Read every
//      "FAKE-DOC:" check below with that caveat.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import * as keys from "../api/dynamoKeys.mjs";
import { createDynamoStore } from "../api/dynamoStore.mjs";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  BatchGetCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";

console.log("dynamoKeys");

const NOW_MS = Date.parse("2026-09-27T00:00:00.000Z");
const SESSION_MAX_MS = 7 * 24 * 3600_000; // mirrors dynamoKeys.mjs's own (duplicated, flagged) constant

function device(deviceId, overrides = {}) {
  return {
    deviceId,
    state: "unclaimed",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    code: null,
    codeExpiresMs: null,
    installerId: null,
    siteId: null,
    expiresAtS: null,
    ...overrides,
  };
}

// ===========================================================================
// 1. cloud/api/dynamoKeys.mjs -- pure round-trips, no storage attr leaks,
//    codeKey presence, TTLs, keyPrefix placement (CLOUD-AWS-SPEC.md section D)
// ===========================================================================

// ---- device: round-trip, no leaks, codeKey presence ----

await check("device round-trips through toDeviceItem/fromDeviceItem unchanged", async () => {
  const d = device("dev-1", { installerId: "inst-1", siteId: "site-1", expiresAtS: 12345 });
  const item = keys.toDeviceItem(d);
  same(keys.fromDeviceItem(item), d, "round trip must reproduce every field exactly");
});

await check("fromDeviceItem never leaks pk, sk, or codeKey", async () => {
  const d = device("dev-2", { state: "unclaimed", code: "AAAA-AAAA-A" });
  const item = keys.toDeviceItem(d, "test-prefix#");
  const back = keys.fromDeviceItem(item);
  for (const storageKey of ["pk", "sk", "codeKey"]) {
    eq(Object.prototype.hasOwnProperty.call(back, storageKey), false, `fromDeviceItem must not return ${storageKey}`);
  }
});

await check("a claimed device has no codeKey; an unclaimed device with a code has it", async () => {
  const claimed = keys.toDeviceItem(device("dev-c", { state: "claimed", code: null, installerId: "inst-1", siteId: "site-1" }));
  eq(Object.prototype.hasOwnProperty.call(claimed, "codeKey"), false, "claimed: no codeKey");

  const unclaimedNoCode = keys.toDeviceItem(device("dev-u0", { state: "unclaimed", code: null }));
  eq(Object.prototype.hasOwnProperty.call(unclaimedNoCode, "codeKey"), false, "unclaimed but no code yet: no codeKey");

  const unclaimedWithCode = keys.toDeviceItem(device("dev-u1", { state: "unclaimed", code: "BBBB-BBBB-B" }));
  eq(Object.prototype.hasOwnProperty.call(unclaimedWithCode, "codeKey"), true, "unclaimed with a code: codeKey present");
  eq(unclaimedWithCode.codeKey, "BBBB-BBBB-B", "codeKey equals the code when no prefix is given");
});

await check("a device record with no expiresAtS at all reads back as null, never undefined or 0", async () => {
  // Simulates a pre-existing item written before expiresAtS existed.
  const item = keys.toDeviceItem(device("dev-old"));
  delete item.expiresAtS;
  const back = keys.fromDeviceItem(item);
  eq(back.expiresAtS, null, "missing expiresAtS normalizes to null");
  eq(Object.prototype.hasOwnProperty.call(back, "expiresAtS"), true, "the key is present, holding null");
});

// ---- latest check-in: round-trip (the public {atMs, payload} shape) ----

await check("checkin item round-trips atMs and payload (seq stays internal to the item, not part of Store's latestCheckin shape)", async () => {
  const payload = { deviceId: "dev-3", seq: 7, sentAtUtc: "2026-09-27T00:00:00.000Z" };
  const item = keys.toCheckinItem("dev-3", 7, NOW_MS + 500, payload);
  const rec = keys.fromCheckinItem(item);
  eq(rec.atMs, NOW_MS + 500);
  same(rec.payload, payload);
  eq(rec.seq, 7, "seq is still readable off the record (lastSeqMap needs it) even though Store.latestCheckin never forwards it");
  for (const storageKey of ["pk", "sk"]) {
    eq(Object.prototype.hasOwnProperty.call(rec, storageKey), false, `fromCheckinItem must not return ${storageKey}`);
  }
});

// ---- tenancy: round-trip, no leaks ----

await check("tenancy round-trips through toTenancyItem/fromTenancyItem unchanged", async () => {
  const tenancy = { installers: [{ id: "inst-1", name: "Acme" }], orgs: [], groups: [], sites: [], devices: [] };
  const item = keys.toTenancyItem("inst-1", tenancy, 3);
  const rec = keys.fromTenancyItem(item);
  same(rec.tenancy, tenancy);
  eq(rec.version, 3);
  for (const storageKey of ["pk", "sk"]) {
    eq(Object.prototype.hasOwnProperty.call(rec, storageKey), false, `fromTenancyItem must not return ${storageKey}`);
  }
});

// ---- user: round-trip (whole loosely-typed object), no leaks ----

await check("user round-trips through toUserItem/fromUserItem unchanged, including every field", async () => {
  const user = {
    userId: "usr_0123456789abcdef",
    login: "tech@example.com",
    installerId: "inst-1",
    password: { algo: "scrypt", N: 32768, r: 8, p: 1, salt: "a".repeat(64), key: "b".repeat(128) },
    disabled: false,
    sessionEpoch: 2,
    createdMs: NOW_MS,
  };
  const item = keys.toUserItem(user);
  const back = keys.fromUserItem(item);
  same(back, user, "every field must round-trip, not just the ones this file happens to know about");
  for (const storageKey of ["pk", "sk"]) {
    eq(Object.prototype.hasOwnProperty.call(back, storageKey), false, `fromUserItem must not return ${storageKey}`);
  }
});

// ---- failed login: round-trip, no leaks, TTL ----

await check("failed login round-trips through toFailedLoginItem/fromFailedLoginItem unchanged", async () => {
  const id = "000000001700000000#deadbeefdeadbeef00000000";
  const item = keys.toFailedLoginItem("acct:tech@example.com", id, NOW_MS);
  const back = keys.fromFailedLoginItem(item);
  eq(back.id, id);
  eq(back.atMs, NOW_MS);
  eq(Object.prototype.hasOwnProperty.call(back, "expiresAtS"), false, "fromFailedLoginItem must not leak the storage-only TTL");
});

await check("a failed login carries the TTL it must: ceil(atMs / 1000) + 86400", async () => {
  const item = keys.toFailedLoginItem("acct:x", "some-id", NOW_MS + 999);
  eq(item.expiresAtS, Math.ceil((NOW_MS + 999) / 1000) + 86400);
});

// ---- session: round-trip, no leaks, TTL ----

await check("session round-trips through toSessionItem/fromSessionItem unchanged", async () => {
  const session = { login: "tech@example.com", createdMs: NOW_MS, lastSeenMs: NOW_MS + 10, epoch: 1 };
  const item = keys.toSessionItem("a".repeat(64), session);
  const back = keys.fromSessionItem(item);
  same(back, session);
  eq(Object.prototype.hasOwnProperty.call(back, "expiresAtS"), false, "fromSessionItem must not leak the storage-only TTL");
});

await check("a session carries the TTL it must: ceil((createdMs + SESSION_MAX_MS) / 1000)", async () => {
  const item = keys.toSessionItem("b".repeat(64), { login: "x", createdMs: NOW_MS, lastSeenMs: NOW_MS, epoch: 0 });
  eq(item.expiresAtS, Math.ceil((NOW_MS + SESSION_MAX_MS) / 1000));
});

// ---- keyPrefix lands on pk and codeKey, and nowhere else ----

await check("keyPrefix lands on pk and codeKey, and nowhere else", async () => {
  const PREFIX = "test-abc123#";

  const d = device("dev-px", { state: "unclaimed", code: "CCCC-CCCC-C", installerId: "inst-px", siteId: "site-px" });
  const devItem = keys.toDeviceItem(d, PREFIX);
  eq(devItem.pk.startsWith(PREFIX), true, "device pk carries the prefix");
  eq(devItem.pk, `${PREFIX}DEV#dev-px`);
  eq(devItem.sk, "META", "sk is never prefixed");
  eq(devItem.codeKey.startsWith(PREFIX), true, "codeKey carries the prefix");
  eq(devItem.codeKey, `${PREFIX}CCCC-CCCC-C`);
  eq(devItem.deviceId, "dev-px", "the deviceId attribute itself is never prefixed");
  eq(devItem.code, "CCCC-CCCC-C", "the plain code attribute itself is never prefixed");

  const checkinItem = keys.toCheckinItem("dev-px", 1, NOW_MS, {}, PREFIX);
  eq(checkinItem.pk, `${PREFIX}DEV#dev-px`);
  eq(checkinItem.sk, "CHECKIN");

  const tenancyItem = keys.toTenancyItem("inst-px", {}, 1, PREFIX);
  eq(tenancyItem.pk, `${PREFIX}INST#inst-px`);
  eq(tenancyItem.sk, "TENANCY");

  const userItem = keys.toUserItem({ login: "tech@example.com", sessionEpoch: 0 }, PREFIX);
  eq(userItem.pk, `${PREFIX}USER#tech@example.com`);
  eq(userItem.sk, "META");
  eq(userItem.login, "tech@example.com", "the login attribute itself is never prefixed");

  const failItem = keys.toFailedLoginItem("acct:x", "some-id-123", NOW_MS, PREFIX);
  eq(failItem.pk, `${PREFIX}FAIL#acct:x`);
  eq(failItem.sk, "some-id-123", "sk (the failed-login id) is never prefixed");

  const sessItem = keys.toSessionItem("c".repeat(64), { login: "x", createdMs: NOW_MS, lastSeenMs: NOW_MS, epoch: 0 }, PREFIX);
  eq(sessItem.pk, `${PREFIX}SESS#${"c".repeat(64)}`);
  eq(sessItem.sk, "META");

  eq(keys.codeKeyValue("DDDD-DDDD-D", PREFIX), `${PREFIX}DDDD-DDDD-D`);
  eq(keys.deviceIdFromPk(`${PREFIX}DEV#dev-px`, PREFIX), "dev-px", "deviceIdFromPk inverts the prefixed pk correctly");
});

await check("with no keyPrefix given, every key builder defaults to the empty string", async () => {
  eq(keys.deviceKey("dev-1").pk, "DEV#dev-1");
  eq(keys.checkinKey("dev-1").pk, "DEV#dev-1");
  eq(keys.tenancyKey("inst-1").pk, "INST#inst-1");
  eq(keys.userKey("a@b.com").pk, "USER#a@b.com");
  eq(keys.failedLoginKey("acct:x", "id-1").pk, "FAIL#acct:x");
  eq(keys.sessionKey("h".repeat(64)).pk, `SESS#${"h".repeat(64)}`);
  eq(keys.codeKeyValue("EEEE-EEEE-E"), "EEEE-EEEE-E");
});

// ---- padAtMs / deviceIdFromPk ----

await check("padAtMs zero-pads to 15 digits and preserves ascending order", async () => {
  eq(keys.padAtMs(0), "000000000000000");
  eq(keys.padAtMs(0).length, 15);
  eq(keys.padAtMs(NOW_MS).length, 15);
  eq(keys.padAtMs(1) < keys.padAtMs(2), true);
  eq(keys.padAtMs(9) < keys.padAtMs(10), true, "numeric, not lexicographic-on-unpadded-digits, ordering");
});

await check("padAtMs refuses a negative or non-numeric atMs (a caller bug)", async () => {
  for (const bad of [-1, NaN, "1000", null, undefined]) {
    let threw = false;
    try {
      keys.padAtMs(bad);
    } catch {
      threw = true;
    }
    eq(threw, true, `padAtMs(${JSON.stringify(bad)}) must throw`);
  }
});

await check("deviceIdFromPk refuses a pk that does not carry the expected prefix", async () => {
  let threw = false;
  try {
    keys.deviceIdFromPk("INST#not-a-device", "");
  } catch {
    threw = true;
  }
  eq(threw, true);
});

// ---- condition expression checks ----

await check("putDeviceCondition: ifState null means attribute_not_exists(pk)", async () => {
  const cond = keys.putDeviceCondition({ ifState: null });
  eq(cond.ConditionExpression, "attribute_not_exists(#pk)");
  same(cond.ExpressionAttributeNames, { "#pk": "pk" });
  same(cond.ExpressionAttributeValues, {});
});

await check("putDeviceCondition: a state condition compares the aliased #state attribute", async () => {
  const cond = keys.putDeviceCondition({ ifState: "unclaimed" });
  eq(cond.ConditionExpression, "#state = :ifState");
  same(cond.ExpressionAttributeNames, { "#state": "state" });
  same(cond.ExpressionAttributeValues, { ":ifState": "unclaimed" });
});

await check("putDeviceCondition: ifCode ANDs a code comparison on, including when ifCode is null", async () => {
  const withCode = keys.putDeviceCondition({ ifState: "unclaimed", ifCode: "OLD0-OLD0-0" });
  eq(withCode.ConditionExpression, "#state = :ifState AND #code = :ifCode");
  same(withCode.ExpressionAttributeValues, { ":ifState": "unclaimed", ":ifCode": "OLD0-OLD0-0" });

  const nullCode = keys.putDeviceCondition({ ifState: "unclaimed", ifCode: null });
  same(nullCode.ExpressionAttributeValues, { ":ifState": "unclaimed", ":ifCode": null }, "null is a real, comparable condition value, not \"absent\"");

  const noCode = keys.putDeviceCondition({ ifState: "unclaimed" });
  eq(noCode.ConditionExpression, "#state = :ifState", "omitting ifCode entirely leaves state alone deciding");
});

await check("putDeviceCondition refuses a missing ifState (a caller bug)", async () => {
  let threw = false;
  try {
    keys.putDeviceCondition({});
  } catch {
    threw = true;
  }
  eq(threw, true);
});

await check("acceptCheckinCondition: attribute_not_exists(pk) OR seq < :seq", async () => {
  const cond = keys.acceptCheckinCondition(9);
  eq(cond.ConditionExpression, "attribute_not_exists(#pk) OR #seq < :seq");
  same(cond.ExpressionAttributeValues, { ":seq": 9 });
});

await check("putTenancyCondition: null creates, a number replaces at that exact version", async () => {
  const create = keys.putTenancyCondition(null);
  eq(create.ConditionExpression, "attribute_not_exists(#pk)");
  const replace = keys.putTenancyCondition(2);
  eq(replace.ConditionExpression, "#version = :ifVersion");
  same(replace.ExpressionAttributeValues, { ":ifVersion": 2 });
});

await check("putTenancyCondition refuses a non-null, non-numeric ifVersion", async () => {
  let threw = false;
  try {
    keys.putTenancyCondition("2");
  } catch {
    threw = true;
  }
  eq(threw, true);
});

await check("putUserCondition: exactly one of ifAbsent or ifEpoch, and refuses neither/both", async () => {
  eq(keys.putUserCondition({ ifAbsent: true }).ConditionExpression, "attribute_not_exists(#pk)");
  const byEpoch = keys.putUserCondition({ ifEpoch: 3 });
  eq(byEpoch.ConditionExpression, "attribute_exists(#pk) AND #sessionEpoch = :ifEpoch");
  same(byEpoch.ExpressionAttributeValues, { ":ifEpoch": 3 });

  for (const bad of [{}, { ifAbsent: true, ifEpoch: 1 }]) {
    let threw = false;
    try {
      keys.putUserCondition(bad);
    } catch {
      threw = true;
    }
    eq(threw, true, `putUserCondition(${JSON.stringify(bad)}) must throw`);
  }
});

await check("putSessionCondition / touchSessionCondition", async () => {
  eq(keys.putSessionCondition().ConditionExpression, "attribute_not_exists(#pk)");
  eq(keys.touchSessionCondition().ConditionExpression, "attribute_exists(#pk)");
});

await check("byCodeQueryCondition targets the byCode index with the prefixed codeKey value", async () => {
  const cond = keys.byCodeQueryCondition("FFFF-FFFF-F", "test-p#");
  eq(cond.IndexName, "byCode");
  same(cond.ExpressionAttributeValues, { ":codeKey": "test-p#FFFF-FFFF-F" });
});

await check("failedLoginsQueryCondition pads sinceMs to match the sk's leading 15 digits", async () => {
  const cond = keys.failedLoginsQueryCondition("acct:x", 42, "test-p#");
  eq(cond.ExpressionAttributeValues[":pk"], "test-p#FAIL#acct:x");
  eq(cond.ExpressionAttributeValues[":sinceSk"], "000000000000042");
});

// ===========================================================================
// 2. dynamoStore.mjs control flow, via a scripted fake `doc`
//
// FAKE-DOC: every check below proves only cloud/api/dynamoStore.mjs's OWN
// control flow against a `doc.send()` that returns exactly what we script
// it to. It does not, and cannot, prove that real DynamoDB actually behaves
// this way -- that is storeConformance.harness.mjs's job, run for real
// against a table (CAMPLAT_STORE=dynamo), which we cannot do here (no table
// exists).
// ===========================================================================

function fakeDoc(handler) {
  return { send: async (command) => handler(command) };
}

function conditionalCheckFailedError() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

await check("FAKE-DOC: putDevice — a ConditionalCheckFailedException becomes false, never a throw", async () => {
  const doc = fakeDoc((command) => {
    if (command instanceof PutCommand) throw conditionalCheckFailedError();
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  const result = await store.putDevice(device("dev-1"), { ifState: null });
  eq(result, false);
});

await check("FAKE-DOC: acceptCheckin — a ConditionalCheckFailedException becomes \"stale\", never a throw", async () => {
  const doc = fakeDoc((command) => {
    if (command instanceof PutCommand) throw conditionalCheckFailedError();
    throw new Error("unexpected command");
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  const result = await store.acceptCheckin("dev-1", 5, { seq: 5 }, NOW_MS);
  eq(result, "stale");
});

await check("FAKE-DOC: putTenancy / putUser / putSession also translate a conditional failure to false", async () => {
  const doc = fakeDoc((command) => {
    if (command instanceof PutCommand) throw conditionalCheckFailedError();
    throw new Error("unexpected command");
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  eq(await store.putTenancy("inst-1", { installers: [], orgs: [], groups: [], sites: [], devices: [] }, { ifVersion: null }), false);
  eq(await store.putUser({ login: "x", sessionEpoch: 0 }, { ifAbsent: true }), false);
  eq(await store.putSession("a".repeat(64), { login: "x", createdMs: NOW_MS, lastSeenMs: NOW_MS, epoch: 0 }), false);
});

await check("FAKE-DOC: touchSession — a ConditionalCheckFailedException (no such session) becomes false", async () => {
  const doc = fakeDoc((command) => {
    if (command instanceof UpdateCommand) throw conditionalCheckFailedError();
    throw new Error("unexpected command");
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  eq(await store.touchSession("a".repeat(64), NOW_MS), false);
});

await check("FAKE-DOC: any error OTHER than ConditionalCheckFailedException always propagates as a throw", async () => {
  const boom = () => {
    const err = new Error("service is unavailable");
    err.name = "InternalServerError";
    throw err;
  };
  const doc = fakeDoc((command) => {
    if (command instanceof PutCommand) boom();
    throw new Error("unexpected command");
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  let threw = false;
  try {
    await store.putDevice(device("dev-1"), { ifState: null });
  } catch (err) {
    threw = true;
    eq(err.message, "service is unavailable");
  }
  eq(threw, true, "a non-conditional error must never become false");
});

await check("FAKE-DOC: getDevice/getUser/getSession propagate an unexpected error rather than hiding it as \"not found\"", async () => {
  const doc = fakeDoc((command) => {
    if (command instanceof GetCommand) {
      const err = new Error("network blip");
      throw err;
    }
    throw new Error("unexpected command");
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  let threw = false;
  try {
    await store.getDevice("dev-1");
  } catch {
    threw = true;
  }
  eq(threw, true);
});

await check("FAKE-DOC: lastSeqMap — permanently unprocessed BatchGetItem keys are retried, then the adapter gives up and throws", async () => {
  let sendCount = 0;
  const doc = fakeDoc((command) => {
    if (command instanceof BatchGetCommand) {
      sendCount += 1;
      const requested = command.input.RequestItems.t.Keys;
      // Every attempt reports every key as unprocessed: simulates a table
      // that never makes progress (e.g. sustained throttling).
      return { Responses: { t: [] }, UnprocessedKeys: { t: { Keys: requested } } };
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  let threw = false;
  try {
    await store.lastSeqMap(["dev-1", "dev-2"]);
  } catch {
    threw = true;
  }
  eq(threw, true, "bounded retries must eventually give up and throw, not loop forever");
  eq(sendCount > 1, true, "it must actually have retried at least once before giving up");
});

await check("FAKE-DOC: lastSeqMap succeeds once UnprocessedKeys eventually empties out", async () => {
  let attempt = 0;
  const doc = fakeDoc((command) => {
    if (command instanceof BatchGetCommand) {
      attempt += 1;
      const requested = command.input.RequestItems.t.Keys;
      if (attempt === 1) {
        // First attempt: one key succeeds, one is reported unprocessed.
        return {
          Responses: { t: [{ pk: "DEV#dev-1", sk: "CHECKIN", seq: 4, atMs: NOW_MS, payload: {} }] },
          UnprocessedKeys: { t: { Keys: requested.filter((k) => k.pk === "DEV#dev-2") } },
        };
      }
      // Second attempt: the retry succeeds.
      return { Responses: { t: [{ pk: "DEV#dev-2", sk: "CHECKIN", seq: 9, atMs: NOW_MS, payload: {} }] }, UnprocessedKeys: {} };
    }
    throw new Error("unexpected command");
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  const map = await store.lastSeqMap(["dev-1", "dev-2"]);
  eq(map.get("dev-1"), 4);
  eq(map.get("dev-2"), 9);
  eq(attempt, 2, "exactly one retry was needed");
});

await check("FAKE-DOC: clearFailedLogins — permanently unprocessed BatchWriteItem items are retried, then the adapter gives up and throws", async () => {
  const doc = fakeDoc((command) => {
    if (command instanceof QueryCommand) {
      return { Items: [{ pk: "FAIL#k", sk: "000000000001000#aaaaaaaaaaaaaaaaaaaaaaaa" }] };
    }
    if (command instanceof BatchWriteCommand) {
      const requests = command.input.RequestItems.t;
      return { UnprocessedItems: { t: requests } }; // never makes progress
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  let threw = false;
  try {
    await store.clearFailedLogins("k");
  } catch {
    threw = true;
  }
  eq(threw, true);
});

await check("FAKE-DOC: findDeviceByCode — a stale eventually-consistent index entry (the code has since moved on) is rejected, not returned", async () => {
  const doc = fakeDoc((command) => {
    if (command instanceof QueryCommand) {
      return { Items: [{ pk: "DEV#dev-1", sk: "META", codeKey: "AAAA-AAAA-A" }] };
    }
    if (command instanceof GetCommand) {
      // The consistent re-read shows this device's code has already moved
      // on to something else -- the index's answer was stale.
      return { Item: keys.toDeviceItem(device("dev-1", { code: "BBBB-BBBB-B" })) };
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  eq(await store.findDeviceByCode("AAAA-AAAA-A"), null);
});

await check("FAKE-DOC: findDeviceByCode — returns the device when the consistent re-read confirms the code still matches", async () => {
  const doc = fakeDoc((command) => {
    if (command instanceof QueryCommand) {
      return { Items: [{ pk: "DEV#dev-2", sk: "META", codeKey: "CCCC-CCCC-C" }] };
    }
    if (command instanceof GetCommand) {
      return { Item: keys.toDeviceItem(device("dev-2", { code: "CCCC-CCCC-C" })) };
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  const found = await store.findDeviceByCode("CCCC-CCCC-C");
  eq(found?.deviceId, "dev-2");
});

await check("FAKE-DOC: findDeviceByCode — no index candidate at all means null with no consistent re-read attempted", async () => {
  let getCalled = false;
  const doc = fakeDoc((command) => {
    if (command instanceof QueryCommand) return { Items: [] };
    if (command instanceof GetCommand) {
      getCalled = true;
      return { Item: undefined };
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  eq(await store.findDeviceByCode("ZZZZ-ZZZZ-Z"), null);
  eq(getCalled, false, "no candidate means no consistent re-read is needed");
});

await check("FAKE-DOC: deleteFailedLogin / deleteSession report existence through ReturnValues: ALL_OLD", async () => {
  const doc = fakeDoc((command) => {
    if (command instanceof DeleteCommand) {
      const { pk, sk } = command.input.Key;
      const existed = !pk.includes("nope") && !String(sk).includes("nope");
      return { Attributes: existed ? { pk, sk } : undefined };
    }
    throw new Error("unexpected command");
  });
  const store = createDynamoStore({ tableName: "t", doc, keyPrefix: "" });
  eq(await store.deleteSession("nope-hash"), false);
  eq(await store.deleteSession("real-hash"), true);
  eq(await store.deleteFailedLogin("acct:x", "nope-id"), false);
});

await check("createDynamoStore refuses an unusable tableName or doc (a caller bug)", async () => {
  for (const bad of [{ tableName: "", doc: fakeDoc(() => ({})) }, { tableName: "t", doc: {} }, { tableName: "t", doc: null }]) {
    let threw = false;
    try {
      createDynamoStore(bad);
    } catch {
      threw = true;
    }
    eq(threw, true, `createDynamoStore(${JSON.stringify({ tableName: bad.tableName })}) must throw`);
  }
});

report("dynamoKeys");
