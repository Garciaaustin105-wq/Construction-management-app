/**
 * `createDynamoStore({ tableName, doc, keyPrefix })`: a DynamoDB
 * implementation of `cloud/api/store.mjs`'s `Store` interface
 * (cloud/CLOUD-AWS-SPEC.md section A), the future drop-in replacement for
 * `cloud/api/memoryStore.mjs`'s `createMemoryStore()`. Both must pass the
 * exact same `cloud/harness/storeConformance.harness.mjs` suite,
 * unmodified -- this file settles no new design decisions about what the
 * Store interface means, only how to make DynamoDB honor it.
 *
 * `doc` is injected -- a `DynamoDBDocumentClient` (`@aws-sdk/lib-dynamodb`)
 * in production, wired once per Lambda cold start over the runtime's own
 * copy of the SDK (cloud/CLOUD-AWS-SPEC.md section B), or a scripted fake
 * with just a `send(command)` method in a test
 * (cloud/harness/dynamoKeys.harness.mjs). This file only ever calls
 * `doc.send(new SomeCommand(...))`; it never constructs a client itself, so
 * it has no credentials, no region, and no network concerns of its own.
 *
 * Every key and item shape comes from `./dynamoKeys.mjs` (pure); this file
 * is the one owner of I/O (build rule 3): retries, backoff, and the
 * `ConditionalCheckFailedException -> false` (or `"stale"` for
 * `acceptCheckin`) translation cloud/CLOUD-AWS-SPEC.md section A documents.
 * Any OTHER error -- a throttle, a validation error, a network failure --
 * is never swallowed: it propagates, because "not found" and "lost a race"
 * are values, but everything else is a caller's (or AWS's) problem to see
 * (store.mjs's own contract; build rule 10).
 *
 * See cloud/CLOUD-AWS-SPEC.md section A for the full contract, and
 * cloud/harness/dynamoKeys.harness.mjs for the fake-`doc` control-flow
 * checks this file must pass (that harness's own header says plainly: a
 * fake `doc` proves only OUR control flow -- the retry loop, the
 * conditional-failure translation -- never DynamoDB's own real semantics).
 * `cloud/harness/storeConformance.harness.mjs` is what proves behavioral
 * correctness, against the memory store always and against a real table
 * when `CAMPLAT_STORE=dynamo`/`CAMPLAT_DDB_TABLE` are set -- which we
 * cannot run here (no table exists yet).
 */

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  BatchGetCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import * as keys from "./dynamoKeys.mjs";

/** DynamoDB's own item ceiling is 400 KB; refuse a putTenancy well under
 *  that (CLOUD-AWS-SPEC.md section A) -- a tenancy tree splitting its
 *  storage strategy is later work, not something to discover mid-write in
 *  production. `JSON.stringify` byte length is an approximation (DynamoDB's
 *  own attribute-value encoding has a little more overhead per field), but
 *  it is on the conservative side of "clearly still fine" vs "clearly
 *  refuse", which is all a 350 KB vs 400 KB margin needs to be. */
const MAX_TENANCY_BYTES = 350 * 1024;

/** Bounded retries for BatchGet/BatchWrite's Unprocessed* (CLOUD-AWS-SPEC.md
 *  section A: "retrying ... with backoff, up to a bound; then throw"). Five
 *  attempts with a capped exponential backoff keeps a real throttle
 *  recoverable while keeping a fake-doc test (cloud/harness/dynamoKeys.harness.mjs)
 *  that always reports "unprocessed" fast: worst case a bit over half a
 *  second, not a hung test. */
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 10;
const RETRY_CAP_MS = 200;

/** DynamoDB's own hard limits per request (not just a spec choice: the API
 *  itself refuses a BatchGetItem over 100 keys or a BatchWriteItem over 25
 *  requests). */
const BATCH_GET_CHUNK = 100;
const BATCH_WRITE_CHUNK = 25;

function isConditionalCheckFailed(err) {
  return Boolean(err) && err.name === "ConditionalCheckFailedException";
}

function backoffMs(attempt) {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `{ ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues }`
 *  from `dynamoKeys.mjs` -> the fields a Put/Update command actually wants,
 *  omitting an empty `ExpressionAttributeValues` map (the DynamoDB API
 *  rejects one that is present but empty). */
function condFields(cond) {
  const names = cond.ExpressionAttributeNames ?? {};
  const values = cond.ExpressionAttributeValues ?? {};
  return {
    ConditionExpression: cond.ConditionExpression,
    ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
  };
}

/**
 * @param {{ tableName: string, doc: { send: Function }, keyPrefix?: string }} args
 * @returns {import("./store.mjs").Store}
 */
export function createDynamoStore({ tableName, doc, keyPrefix = "" }) {
  if (typeof tableName !== "string" || tableName.length === 0) {
    throw new Error("createDynamoStore: tableName must be a non-empty string");
  }
  if (!doc || typeof doc.send !== "function") {
    throw new Error("createDynamoStore: doc must be a DynamoDBDocumentClient (or a fake with a send(command) method)");
  }
  if (typeof keyPrefix !== "string") {
    throw new Error("createDynamoStore: keyPrefix must be a string");
  }

  async function getItem(key, { consistent = true } = {}) {
    const res = await doc.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: consistent }));
    return res.Item ?? null;
  }

  /** BatchGetItem in chunks of 100, retrying UnprocessedKeys with backoff up
   *  to RETRY_MAX_ATTEMPTS, then throwing (CLOUD-AWS-SPEC.md section A). */
  async function batchGetAll(keyList) {
    const out = [];
    for (let i = 0; i < keyList.length; i += BATCH_GET_CHUNK) {
      let remaining = keyList.slice(i, i + BATCH_GET_CHUNK);
      let attempt = 0;
      while (remaining.length > 0) {
        const res = await doc.send(
          new BatchGetCommand({ RequestItems: { [tableName]: { Keys: remaining, ConsistentRead: true } } }),
        );
        out.push(...(res.Responses?.[tableName] ?? []));
        const unprocessed = res.UnprocessedKeys?.[tableName]?.Keys ?? [];
        if (unprocessed.length === 0) break;
        attempt += 1;
        if (attempt > RETRY_MAX_ATTEMPTS) {
          throw new Error(
            `dynamoStore: BatchGetItem gave up after ${RETRY_MAX_ATTEMPTS} retries with ${unprocessed.length} unprocessed key(s) still outstanding`,
          );
        }
        await sleep(backoffMs(attempt));
        remaining = unprocessed;
      }
    }
    return out;
  }

  /** BatchWriteItem (delete-only, used by clearFailedLogins) in chunks of
   *  25, retrying UnprocessedItems the same way. */
  async function batchDeleteAll(keyList) {
    for (let i = 0; i < keyList.length; i += BATCH_WRITE_CHUNK) {
      let requests = keyList.slice(i, i + BATCH_WRITE_CHUNK).map((Key) => ({ DeleteRequest: { Key } }));
      let attempt = 0;
      while (requests.length > 0) {
        const res = await doc.send(new BatchWriteCommand({ RequestItems: { [tableName]: requests } }));
        const unprocessed = res.UnprocessedItems?.[tableName] ?? [];
        if (unprocessed.length === 0) break;
        attempt += 1;
        if (attempt > RETRY_MAX_ATTEMPTS) {
          throw new Error(
            `dynamoStore: BatchWriteItem gave up after ${RETRY_MAX_ATTEMPTS} retries with ${unprocessed.length} unprocessed item(s) still outstanding`,
          );
        }
        await sleep(backoffMs(attempt));
        requests = unprocessed;
      }
    }
  }

  /** One Query, following LastEvaluatedKey to the end. Used by both
   *  failedLogins (a strongly consistent read, store.mjs's own requirement
   *  so "record first, then count" never races itself) and
   *  clearFailedLogins (which then deletes what it found). */
  async function queryAll(input) {
    const out = [];
    let ExclusiveStartKey;
    do {
      const res = await doc.send(new QueryCommand({ ...input, ExclusiveStartKey }));
      out.push(...(res.Items ?? []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  return {
    // -------------------------------------------------------------------
    // Devices
    // -------------------------------------------------------------------

    async getDevice(deviceId) {
      const item = await getItem(keys.deviceKey(deviceId, keyPrefix));
      return item === null ? null : keys.fromDeviceItem(item);
    },

    async putDevice(device, options) {
      const item = keys.toDeviceItem(device, keyPrefix);
      const cond = keys.putDeviceCondition(options); // throws for a caller bug (missing ifState)
      try {
        await doc.send(new PutCommand({ TableName: tableName, Item: item, ...condFields(cond) }));
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },

    async findDeviceByCode(code) {
      if (code === null || code === undefined) return null;
      // Step 1: query the sparse byCode GSI -- eventually consistent, so
      // its answer is only ever a CANDIDATE (CLOUD-AWS-SPEC.md section A).
      const q = keys.byCodeQueryCondition(code, keyPrefix);
      const res = await doc.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: q.IndexName,
          KeyConditionExpression: q.KeyConditionExpression,
          ExpressionAttributeNames: q.ExpressionAttributeNames,
          ExpressionAttributeValues: q.ExpressionAttributeValues,
          Limit: 1,
        }),
      );
      const candidate = (res.Items ?? [])[0];
      if (!candidate) return null;
      // Step 2: a CONSISTENT re-read of the device the candidate points at.
      const item = await getItem({ pk: candidate.pk, sk: "META" });
      if (!item) return null;
      const device = keys.fromDeviceItem(item);
      // Return it only if its CURRENT code still equals the one asked for
      // -- the index entry may be stale (a reissue, a claim, since the
      // query ran).
      return device.code === code ? device : null;
    },

    async acceptCheckin(deviceId, seq, payload, atMs) {
      const item = keys.toCheckinItem(deviceId, seq, atMs, payload, keyPrefix);
      const cond = keys.acceptCheckinCondition(seq);
      try {
        await doc.send(new PutCommand({ TableName: tableName, Item: item, ...condFields(cond) }));
        return "accepted";
      } catch (err) {
        if (isConditionalCheckFailed(err)) return "stale";
        throw err;
      }
    },

    async latestCheckin(deviceId) {
      const item = await getItem(keys.checkinKey(deviceId, keyPrefix));
      if (item === null) return null;
      const rec = keys.fromCheckinItem(item);
      return { atMs: rec.atMs, payload: rec.payload };
    },

    async lastSeqMap(deviceIds) {
      if (!Array.isArray(deviceIds)) {
        throw new Error("lastSeqMap: deviceIds must be an array");
      }
      const map = new Map();
      const uniqueIds = [...new Set(deviceIds)];
      if (uniqueIds.length === 0) return map;
      const items = await batchGetAll(uniqueIds.map((id) => keys.checkinKey(id, keyPrefix)));
      for (const item of items) {
        const rec = keys.fromCheckinItem(item);
        map.set(keys.deviceIdFromPk(item.pk, keyPrefix), rec.seq);
      }
      return map;
    },

    // -------------------------------------------------------------------
    // Tenancy
    // -------------------------------------------------------------------

    async getTenancy(installerId) {
      const item = await getItem(keys.tenancyKey(installerId, keyPrefix));
      return item === null ? null : keys.fromTenancyItem(item).tenancy;
    },

    async getTenancyRecord(installerId) {
      const item = await getItem(keys.tenancyKey(installerId, keyPrefix));
      return item === null ? null : keys.fromTenancyItem(item);
    },

    async putTenancy(installerId, tenancy, options) {
      const { ifVersion } = options ?? {};
      const cond = keys.putTenancyCondition(ifVersion); // throws for a caller bug (bad ifVersion)
      const nextVersion = (ifVersion ?? 0) + 1;
      const item = keys.toTenancyItem(installerId, tenancy, nextVersion, keyPrefix);
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (size > MAX_TENANCY_BYTES) {
        throw new Error(
          `putTenancy: serialized tenancy for installerId ${JSON.stringify(installerId)} is ${size} bytes, over the ${MAX_TENANCY_BYTES}-byte refusal limit (DynamoDB's own item limit is 400 KB)`,
        );
      }
      try {
        await doc.send(new PutCommand({ TableName: tableName, Item: item, ...condFields(cond) }));
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },

    // -------------------------------------------------------------------
    // Users
    // -------------------------------------------------------------------

    async getUser(login) {
      const item = await getItem(keys.userKey(login, keyPrefix));
      return item === null ? null : keys.fromUserItem(item);
    },

    async putUser(user, options) {
      const item = keys.toUserItem(user, keyPrefix);
      const cond = keys.putUserCondition(options); // throws for a caller bug (neither/both of ifAbsent, ifEpoch)
      try {
        await doc.send(new PutCommand({ TableName: tableName, Item: item, ...condFields(cond) }));
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },

    // -------------------------------------------------------------------
    // Failed logins
    // -------------------------------------------------------------------

    async recordFailedLogin(key, atMs) {
      // No CAS needed: the random half of the id makes a same-millisecond
      // collision practically impossible, and a fresh append never
      // overwrites anything (unlike memoryStore.mjs's per-process counter,
      // there is no single process to count across -- separate Lambda
      // invocations are separate processes -- so real randomness stands in
      // for it here).
      const id = `${keys.padAtMs(atMs)}#${nodeRandomBytes(12).toString("hex")}`;
      const item = keys.toFailedLoginItem(key, id, atMs, keyPrefix);
      await doc.send(new PutCommand({ TableName: tableName, Item: item }));
      return id;
    },

    async failedLogins(key, sinceMs) {
      const q = keys.failedLoginsQueryCondition(key, sinceMs, keyPrefix);
      const items = await queryAll({
        TableName: tableName,
        KeyConditionExpression: q.KeyConditionExpression,
        ExpressionAttributeNames: q.ExpressionAttributeNames,
        ExpressionAttributeValues: q.ExpressionAttributeValues,
        ConsistentRead: true, // store.mjs: "record first, then count" needs this to see its own just-recorded entry.
      });
      return items
        .map((item) => keys.fromFailedLoginItem(item))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async deleteFailedLogin(key, id) {
      const res = await doc.send(
        new DeleteCommand({ TableName: tableName, Key: keys.failedLoginKey(key, id, keyPrefix), ReturnValues: "ALL_OLD" }),
      );
      return res.Attributes !== undefined;
    },

    async clearFailedLogins(key) {
      const q = keys.failedLoginsQueryCondition(key, 0, keyPrefix);
      const items = await queryAll({
        TableName: tableName,
        KeyConditionExpression: q.KeyConditionExpression,
        ExpressionAttributeNames: q.ExpressionAttributeNames,
        ExpressionAttributeValues: q.ExpressionAttributeValues,
        ConsistentRead: true,
      });
      await batchDeleteAll(items.map((item) => ({ pk: item.pk, sk: item.sk })));
    },

    // -------------------------------------------------------------------
    // Sessions
    // -------------------------------------------------------------------

    async putSession(tokenHash, session) {
      const item = keys.toSessionItem(tokenHash, session, keyPrefix);
      const cond = keys.putSessionCondition();
      try {
        await doc.send(new PutCommand({ TableName: tableName, Item: item, ...condFields(cond) }));
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },

    async getSession(tokenHash) {
      const item = await getItem(keys.sessionKey(tokenHash, keyPrefix));
      return item === null ? null : keys.fromSessionItem(item);
    },

    async touchSession(tokenHash, lastSeenMs) {
      const cond = keys.touchSessionCondition();
      try {
        await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: keys.sessionKey(tokenHash, keyPrefix),
            UpdateExpression: "SET #lastSeenMs = :lastSeenMs",
            ExpressionAttributeNames: { ...cond.ExpressionAttributeNames, "#lastSeenMs": "lastSeenMs" },
            ExpressionAttributeValues: { ":lastSeenMs": lastSeenMs },
            ConditionExpression: cond.ConditionExpression,
          }),
        );
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },

    async deleteSession(tokenHash) {
      const res = await doc.send(
        new DeleteCommand({ TableName: tableName, Key: keys.sessionKey(tokenHash, keyPrefix), ReturnValues: "ALL_OLD" }),
      );
      return res.Attributes !== undefined;
    },
  };
}
