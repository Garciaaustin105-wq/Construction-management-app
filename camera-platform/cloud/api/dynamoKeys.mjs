/**
 * DynamoDB key and item shapes for every record `cloud/api/store.mjs`'s
 * `Store` interface needs, plus the `ConditionExpression` for every
 * conditional write `cloud/api/dynamoStore.mjs` performs
 * (cloud/CLOUD-AWS-SPEC.md section A, the table under "One table, on-demand
 * billing...").
 *
 * PURE (build rule 2): no SDK import, no `node:crypto`, no clock, no I/O of
 * any kind. Every function here is a plain data transform -- string
 * concatenation, object shaping -- so it loads and runs with no AWS account,
 * no network, and (like `cloud/api/login.mjs`'s dynamically-imported
 * contracts) no dependency on `tsc` having ever run. `cloud/api/dynamoStore.mjs`
 * is the ONLY file that imports the AWS SDK and actually talks to a table;
 * this file only decides what bytes would be sent.
 *
 * | Record         | pk                    | sk       | Extra attributes |
 * |----------------|-----------------------|----------|-------------------|
 * | device         | `DEV#<deviceId>`      | `META`   | `codeKey` ONLY while unclaimed with a code; `expiresAtS` |
 * | latest check-in| `DEV#<deviceId>`      | `CHECKIN`| `seq`, `atMs`, `payload` |
 * | tenancy        | `INST#<installerId>`  | `TENANCY`| `tenancy`, `version` |
 * | user           | `USER#<login>`        | `META`   | (the whole `StoreUser`) |
 * | failed login   | `FAIL#<key>`          | `<id>`   | `atMs`; `expiresAtS` |
 * | session        | `SESS#<tokenHash>`    | `META`   | `login`, `createdMs`, `lastSeenMs`, `epoch`; `expiresAtS` |
 *
 * Every key builder takes an optional `keyPrefix` (default `""`), put in
 * front of `pk` and `codeKey` and NOWHERE else -- not `sk`, not any other
 * attribute (cloud/CLOUD-AWS-SPEC.md section A). `cloud/harness/storeConformance.harness.mjs`
 * uses a fresh prefix per store instance in DynamoDB mode so a test run never
 * touches a real record (build rule 21) and can find everything it wrote
 * again with one `Scan` + `begins_with(pk, prefix)`.
 *
 * `fromXItem` strips every storage-only attribute (`pk`, `sk`, `codeKey`, and
 * the `expiresAtS` the adapter adds to sessions and failed logins) so a
 * getter returns EXACTLY the shape `cloud/api/store.mjs` documents -- never a
 * DynamoDB implementation detail leaking through. A device's own
 * `expiresAtS` is different: it is Store data (`StoreDevice.expiresAtS`,
 * CLOUD-LOGIN-SPEC.md "B. Store additions") and round-trips like any other
 * field, missing normalized to `null` exactly as `memoryStore.mjs` does (a
 * blank is not a zero, build rule 5).
 *
 * See cloud/CLOUD-AWS-SPEC.md section A for the full contract, and
 * cloud/harness/dynamoKeys.harness.mjs for the checks this file must pass.
 */

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

/** The DynamoDB GSI name every `findDeviceByCode` query reads. */
export const BY_CODE_INDEX = "byCode";

/** @param {string} deviceId @param {string} [keyPrefix] */
export function deviceKey(deviceId, keyPrefix = "") {
  return { pk: `${keyPrefix}DEV#${deviceId}`, sk: "META" };
}

/** @param {string} deviceId @param {string} [keyPrefix] */
export function checkinKey(deviceId, keyPrefix = "") {
  return { pk: `${keyPrefix}DEV#${deviceId}`, sk: "CHECKIN" };
}

/** @param {string} installerId @param {string} [keyPrefix] */
export function tenancyKey(installerId, keyPrefix = "") {
  return { pk: `${keyPrefix}INST#${installerId}`, sk: "TENANCY" };
}

/** @param {string} login @param {string} [keyPrefix] */
export function userKey(login, keyPrefix = "") {
  return { pk: `${keyPrefix}USER#${login}`, sk: "META" };
}

/** @param {string} key @param {string} [keyPrefix] -- the `FAIL#<key>` partition alone, for a Query. */
export function failedLoginPk(key, keyPrefix = "") {
  return `${keyPrefix}FAIL#${key}`;
}

/** @param {string} key @param {string} id @param {string} [keyPrefix] */
export function failedLoginKey(key, id, keyPrefix = "") {
  return { pk: failedLoginPk(key, keyPrefix), sk: id };
}

/** @param {string} tokenHash @param {string} [keyPrefix] */
export function sessionKey(tokenHash, keyPrefix = "") {
  return { pk: `${keyPrefix}SESS#${tokenHash}`, sk: "META" };
}

/** The `byCode` GSI's own partition key value for a claim code. */
export function codeKeyValue(code, keyPrefix = "") {
  return `${keyPrefix}${code}`;
}

/**
 * `atMs` zero-padded to 15 digits -- the same width `memoryStore.mjs`'s
 * `makeFailedLoginId` uses, and exactly what a `sk >= :sinceMs` string
 * comparison needs: every failed-login `sk` is `<15-digit atMs>#<random
 * hex>`, which is strictly LONGER than (never equal to) a bare 15-digit
 * value, so lexicographic comparison against the padded `sinceMs` alone
 * still sorts correctly at every boundary (an entry AT exactly `sinceMs`
 * compares as "after" the bare 15-digit prefix, because a proper prefix
 * always sorts before the longer string it prefixes -- so it is correctly
 * included, matching `atMs >= sinceMs`).
 *
 * @param {number} atMs
 */
export function padAtMs(atMs) {
  if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0) {
    throw new Error(`padAtMs: atMs must be a finite non-negative number, got ${JSON.stringify(atMs)}`);
  }
  return String(Math.trunc(atMs)).padStart(15, "0");
}

/**
 * The inverse of `deviceKey`/`checkinKey`'s `pk`: recovers the raw
 * `deviceId` from a `DEV#<deviceId>` partition key (used by
 * `dynamoStore.mjs`'s `lastSeqMap`, which only gets `pk`/`sk` back from a
 * `BatchGetCommand` and has no other way to know which device each returned
 * check-in item belongs to).
 *
 * @param {string} pk @param {string} [keyPrefix]
 */
export function deviceIdFromPk(pk, keyPrefix = "") {
  const prefix = `${keyPrefix}DEV#`;
  if (typeof pk !== "string" || !pk.startsWith(prefix)) {
    throw new Error(`deviceIdFromPk: pk ${JSON.stringify(pk)} does not start with ${JSON.stringify(prefix)}`);
  }
  return pk.slice(prefix.length);
}

// ---------------------------------------------------------------------------
// Storage-only TTL constants
// ---------------------------------------------------------------------------

/** CLOUD-AWS-SPEC.md section A: `expiresAtS = ceil(atMs / 1000) + 86400`. */
const FAILED_LOGIN_TTL_S = 86400;

/**
 * Mirrors `cloud/contracts/auth.ts`'s `SESSION_MAX_MS` (7 days,
 * `7 * 24 * 3600_000`). Duplicated here, as a literal, rather than imported
 * from the compiled contract: this file must stay pure and loadable before
 * `tsc` has ever run (the same reason `cloud/api/login.mjs` never
 * statically imports a compiled contract at the top of the file -- see its
 * own header). FLAGGED, not silently assumed (build rule 10): if
 * `SESSION_MAX_MS` ever changes in `cloud/contracts/auth.ts`, this literal
 * must change with it, or DynamoDB will expire a session's storage row
 * slightly early or late relative to `auth.ts`'s own idle/max checks. That
 * drift is low-stakes on its own -- `expiresAtS` is a storage-cleanup TTL,
 * never the thing that actually decides whether a session is still valid
 * (`sessionState` in `auth.ts` does that, independently, on every request)
 * -- but it is still worth a human's eyes if the two ever diverge.
 */
const SESSION_MAX_MS = 7 * 24 * 3600_000;

// ---------------------------------------------------------------------------
// device
// ---------------------------------------------------------------------------

/**
 * @param {import("./store.mjs").StoreDevice} device
 * @param {string} [keyPrefix]
 */
export function toDeviceItem(device, keyPrefix = "") {
  const { pk, sk } = deviceKey(device.deviceId, keyPrefix);
  const item = {
    pk,
    sk,
    deviceId: device.deviceId,
    state: device.state,
    publicKeyPem: device.publicKeyPem,
    code: device.code ?? null,
    codeExpiresMs: device.codeExpiresMs ?? null,
    installerId: device.installerId ?? null,
    siteId: device.siteId ?? null,
    expiresAtS: device.expiresAtS ?? null,
  };
  // "codeKey ONLY while unclaimed with a code" (CLOUD-AWS-SPEC.md section A)
  // -- BOTH conditions, not just a non-null code: a claimed or revoked
  // device must never appear in the sparse byCode index, even if a caller
  // forgot to clear `code` back to null.
  if (device.state === "unclaimed" && device.code !== null && device.code !== undefined) {
    item.codeKey = codeKeyValue(device.code, keyPrefix);
  }
  return item;
}

/** @param {Record<string, any>} item @returns {import("./store.mjs").StoreDevice} */
export function fromDeviceItem(item) {
  return {
    deviceId: item.deviceId,
    state: item.state,
    publicKeyPem: item.publicKeyPem,
    code: item.code ?? null,
    codeExpiresMs: item.codeExpiresMs ?? null,
    installerId: item.installerId ?? null,
    siteId: item.siteId ?? null,
    expiresAtS: item.expiresAtS ?? null,
  };
}

// ---------------------------------------------------------------------------
// latest check-in
// ---------------------------------------------------------------------------

/**
 * @param {string} deviceId @param {number} seq
 * @param {number} atMs @param {import("../../contracts/deviceCheckin.js").CheckinPayload} payload
 * @param {string} [keyPrefix]
 */
export function toCheckinItem(deviceId, seq, atMs, payload, keyPrefix = "") {
  const { pk, sk } = checkinKey(deviceId, keyPrefix);
  return { pk, sk, seq, atMs, payload };
}

/**
 * Returns `{ seq, atMs, payload }` -- `seq` stays in the result (unlike
 * every other `fromXItem`, which strips every non-Store field) because
 * `dynamoStore.mjs`'s `lastSeqMap` needs it; `Store.latestCheckin` itself
 * only ever forwards `{ atMs, payload }` of what this returns, per
 * store.mjs's own documented shape.
 *
 * @param {Record<string, any>} item
 */
export function fromCheckinItem(item) {
  return { seq: item.seq, atMs: item.atMs, payload: item.payload };
}

// ---------------------------------------------------------------------------
// tenancy
// ---------------------------------------------------------------------------

/**
 * @param {string} installerId
 * @param {import("./store.mjs").Tenancy} tenancy
 * @param {number} version
 * @param {string} [keyPrefix]
 */
export function toTenancyItem(installerId, tenancy, version, keyPrefix = "") {
  const { pk, sk } = tenancyKey(installerId, keyPrefix);
  return { pk, sk, tenancy, version };
}

/** @param {Record<string, any>} item @returns {import("./store.mjs").TenancyRecord} */
export function fromTenancyItem(item) {
  return { tenancy: item.tenancy, version: item.version };
}

// ---------------------------------------------------------------------------
// user -- StoreUser is loosely typed (store.mjs's own comment: the store
// does not validate its shape), so the whole object round-trips by spread
// rather than by naming each field, exactly the way `login`, `userId`,
// `password`, etc. all travel through unchanged.
// ---------------------------------------------------------------------------

/** @param {import("./store.mjs").StoreUser} user @param {string} [keyPrefix] */
export function toUserItem(user, keyPrefix = "") {
  const { pk, sk } = userKey(user.login, keyPrefix);
  // Spread first, key fields last: a stray pk/sk on the caller's object (it
  // should never have one) can never shadow the real key.
  return { ...user, pk, sk };
}

/** @param {Record<string, any>} item @returns {import("./store.mjs").StoreUser} */
export function fromUserItem(item) {
  const { pk, sk, ...rest } = item;
  return rest;
}

// ---------------------------------------------------------------------------
// failed login
// ---------------------------------------------------------------------------

/** @param {string} key @param {string} id @param {number} atMs @param {string} [keyPrefix] */
export function toFailedLoginItem(key, id, atMs, keyPrefix = "") {
  const { pk, sk } = failedLoginKey(key, id, keyPrefix);
  return { pk, sk, atMs, expiresAtS: Math.ceil(atMs / 1000) + FAILED_LOGIN_TTL_S };
}

/** @param {Record<string, any>} item @returns {{ id: string, atMs: number }} */
export function fromFailedLoginItem(item) {
  return { id: item.sk, atMs: item.atMs };
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

/** @param {string} tokenHash @param {import("./store.mjs").StoreSession} session @param {string} [keyPrefix] */
export function toSessionItem(tokenHash, session, keyPrefix = "") {
  const { pk, sk } = sessionKey(tokenHash, keyPrefix);
  return {
    pk,
    sk,
    login: session.login,
    createdMs: session.createdMs,
    lastSeenMs: session.lastSeenMs,
    epoch: session.epoch,
    expiresAtS: Math.ceil((session.createdMs + SESSION_MAX_MS) / 1000),
  };
}

/** @param {Record<string, any>} item @returns {import("./store.mjs").StoreSession} */
export function fromSessionItem(item) {
  return { login: item.login, createdMs: item.createdMs, lastSeenMs: item.lastSeenMs, epoch: item.epoch };
}

// ---------------------------------------------------------------------------
// Condition expressions -- every attribute name referenced is aliased via
// ExpressionAttributeNames, defensively: several of these ("state", "code",
// "version", "seq") are plain enough English words that aliasing every one,
// always, is cheaper than auditing DynamoDB's reserved-word list by hand
// every time a new condition is added. ExpressionAttributeValues is always
// present (possibly `{}`), never omitted -- callers decide whether an empty
// map should be sent at all (the DynamoDB API rejects an empty map, but
// that is `dynamoStore.mjs`'s problem, not this pure file's).
// ---------------------------------------------------------------------------

/**
 * @param {import("./store.mjs").PutDeviceOptions} options
 * @returns {{ ConditionExpression: string, ExpressionAttributeNames: Record<string,string>, ExpressionAttributeValues: Record<string,any> }}
 */
export function putDeviceCondition(options) {
  const { ifState, ifCode } = options ?? {};
  if (ifState === undefined) {
    throw new Error("putDeviceCondition: options.ifState is required (null or a DeviceState)");
  }
  const names = {};
  const values = {};
  const parts = [];
  if (ifState === null) {
    parts.push("attribute_not_exists(#pk)");
    names["#pk"] = "pk";
  } else {
    parts.push("#state = :ifState");
    names["#state"] = "state";
    values[":ifState"] = ifState;
  }
  // ifCode present (anything but undefined) -- a compare-and-swap on the
  // claim code too (store.mjs's PutDeviceOptions doc). `null` is a real,
  // comparable DynamoDB NULL-type value here, not "no condition".
  if (ifCode !== undefined) {
    parts.push("#code = :ifCode");
    names["#code"] = "code";
    values[":ifCode"] = ifCode;
  }
  return { ConditionExpression: parts.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values };
}

/** `attribute_not_exists(pk) OR seq < :seq` (CLOUD-AWS-SPEC.md section A). @param {number} seq */
export function acceptCheckinCondition(seq) {
  return {
    ConditionExpression: "attribute_not_exists(#pk) OR #seq < :seq",
    ExpressionAttributeNames: { "#pk": "pk", "#seq": "seq" },
    ExpressionAttributeValues: { ":seq": seq },
  };
}

/** @param {number|null} ifVersion */
export function putTenancyCondition(ifVersion) {
  if (ifVersion === null) {
    return { ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" }, ExpressionAttributeValues: {} };
  }
  if (typeof ifVersion !== "number" || !Number.isFinite(ifVersion)) {
    throw new Error(`putTenancyCondition: ifVersion must be null or a finite number, got ${JSON.stringify(ifVersion)}`);
  }
  return {
    ConditionExpression: "#version = :ifVersion",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ":ifVersion": ifVersion },
  };
}

/** @param {import("./store.mjs").PutUserOptions} options */
export function putUserCondition(options) {
  const { ifAbsent, ifEpoch } = options ?? {};
  if (ifAbsent === true && ifEpoch === undefined) {
    return { ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" }, ExpressionAttributeValues: {} };
  }
  if (ifEpoch !== undefined && ifAbsent === undefined) {
    return {
      ConditionExpression: "attribute_exists(#pk) AND #sessionEpoch = :ifEpoch",
      ExpressionAttributeNames: { "#pk": "pk", "#sessionEpoch": "sessionEpoch" },
      ExpressionAttributeValues: { ":ifEpoch": ifEpoch },
    };
  }
  throw new Error("putUserCondition: options must give exactly one of ifAbsent or ifEpoch");
}

/** `putSession` is create-only. */
export function putSessionCondition() {
  return { ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" }, ExpressionAttributeValues: {} };
}

/** `touchSession`'s condition: refuse (never create) when no session is stored. */
export function touchSessionCondition() {
  return { ConditionExpression: "attribute_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" }, ExpressionAttributeValues: {} };
}

// ---------------------------------------------------------------------------
// Query conditions (byCode GSI, failedLogins)
// ---------------------------------------------------------------------------

/** @param {string} code @param {string} [keyPrefix] */
export function byCodeQueryCondition(code, keyPrefix = "") {
  return {
    IndexName: BY_CODE_INDEX,
    KeyConditionExpression: "#codeKey = :codeKey",
    ExpressionAttributeNames: { "#codeKey": "codeKey" },
    ExpressionAttributeValues: { ":codeKey": codeKeyValue(code, keyPrefix) },
  };
}

/** @param {string} key @param {number} sinceMs @param {string} [keyPrefix] */
export function failedLoginsQueryCondition(key, sinceMs, keyPrefix = "") {
  return {
    KeyConditionExpression: "#pk = :pk AND #sk >= :sinceSk",
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: { ":pk": failedLoginPk(key, keyPrefix), ":sinceSk": padAtMs(sinceMs) },
  };
}
