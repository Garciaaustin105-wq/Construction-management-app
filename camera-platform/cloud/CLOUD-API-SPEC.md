# Cloud API, first endpoints (AWS-shaped, no AWS dependency yet)

The owner chose AWS on 2026-09-27 (bus note camera-cloud-hosting). These
handlers are written in the AWS Lambda style, taking an API Gateway HTTP API
v2 event, but they depend only on injected `deps`. That way they run and are
tested with no AWS account and no AWS SDK. The DynamoDB adapter and the
deploy (CDK or SAM) come later, once the owner has set up the account.
Nothing here installs a package.

Files:
- `cloud/api/*.mjs` (I/O layer, plain ESM like agent/*.mjs) import the
  compiled contracts from `cloud/dist/...`, matching what the harnesses
  import.
- Tests go in `cloud/harness/`.

## The store interface (cloud/api/store.mjs documents it; cloud/api/memoryStore.mjs implements it)

All methods are async, and never throw on "not found": they return null or
false.

- **`getDevice(deviceId)`** returns `{ deviceId, state, publicKeyPem, code,
  codeExpiresMs, installerId, siteId } | null`.
- **`putDevice(device, { ifState })`**
  - A conditional write: it succeeds only if the stored state equals
    `ifState` (null meaning "must not exist").
  - It returns `true` on success, or `false` when the condition failed
    (someone else changed it).
- **`acceptCheckin(deviceId, seq, payload, atMs)`** is the authoritative
  replay guard. It stores only if seq > the stored lastSeq (or there is none
  yet). It returns `"accepted"` or `"stale"`, and is atomic per device (in
  DynamoDB, a conditional update).
- **`lastSeqMap(deviceIds)`** returns a `Map` of the stored lastSeq.
- **`latestCheckin(deviceId)`** returns `{ atMs, payload } | null`.
- **`findDeviceByCode(code)`** returns a device or null.
- **`getTenancy(installerId)`** returns that installer's Tenancy (slice 2).
  It is never all installers.

`memoryStore.mjs` is a correct in-memory implementation, with each
conditional write atomic under one-at-a-time async use. A store
conformance harness (`storeConformance.harness.mjs`) runs every contract
above against it. Any future DynamoDB adapter must pass the same suite.

## Handlers (each `export async function handler(event, deps)` returns `{ statusCode, headers, body }`)

`deps` is `{ store, nowMs(), verifySignature, principalOf(event), log }`.
Real auth arrives later; `principalOf` returns a slice 2 Principal or null.
Every body is JSON. An error body is `{ ok: false, reason }` and never
includes a payload, a signature, a key or a stack trace.

- **`api/checkin.mjs`: `POST /checkin`**, with the NVR's envelope
  `{ payload, signature }` as the body.
  - **Unreadable body:** over 64 KB gives 413 `too_large`; not JSON gives
    400 `malformed`. The body may be base64 when `isBase64Encoded` is set.
  - **Verification:** `verifyCheckin(envelope, { devices, lastSeq, nowMs,
    verifySignature })`, with `devices` built from `getDevice` and
    `lastSeq` from `lastSeqMap` for that one device.
  - **Refusal statuses:**

    | Reason | Status |
    |---|---|
    | malformed, unsupported_version | 400 |
    | unknown_device, bad_signature | 401 |
    | not_claimed | 403 |
    | replay | 409 |
    | clock_skew | 422 |

  - **Accepted:** then `acceptCheckin`. `"stale"` (a race) gives 409
    `replay`; `"accepted"` gives 200 `{ ok: true, seq }`.
  - **Logging:** one log line per request, with reason and deviceId only.
- **`api/claim.mjs`: `POST /claim`**, with body `{ code }`.
  - The principal must be an installer_tech. Otherwise it is 401
    (no principal) or 403 `installer_only`.
  - The code goes through `parseClaimCode`. Invalid gives 400 with the parse
    reason.
  - Then `findDeviceByCode`. Not found gives 404 `no_such_code`, the same
    answer as an expired code, so a probe cannot tell them apart.
  - Then `claimStep` with the installer id. Refused gives 409 with the
    reason, except `code_expired`, which gives 404 `no_such_code`.
  - Then `putDevice(next, { ifState: "unclaimed" })`. A false gives 409
    `wrong_state`.
  - Success gives 200 `{ ok: true, deviceId }`.
- **`api/fleet.mjs`: `GET /fleet`**
  - It needs a principal (401 otherwise).
  - It loads `getTenancy(principal's installer)`, plus `visibleSites`, the
    devices on those sites, and their latest check-ins.
  - It returns 200 `{ ok: true, rows: fleetRow(...)[] }`, sorted by
    deviceId. `intervalMs` is 60,000, the box's check-in interval; take the
    real one from agent/checkin.mjs if it declares one.
  - It never includes a device outside the principal's scope.

## Tests that matter

- Store conformance:
  - `acceptCheckin` refuses an equal or lower seq, and races two
    concurrent accepts of the same seq so exactly one wins;
  - `putDevice`'s condition works;
  - `getTenancy` never returns another installer's data.
- Check-in:
  - every reason gives its status code;
  - an oversized body gives 413;
  - a base64 body is accepted;
  - two concurrent identical envelopes give one 200 and one 409;
  - no payload, signature or key appears in any error body or log line.
- Claim:
  - a non-installer gets 403;
  - an expired code and an unknown code give the SAME 404;
  - a code cannot be claimed twice;
  - two concurrent claims give one success.
- Fleet:
  - an installer sees only their own devices;
  - a regional manager sees only their group;
  - a device with no check-in shows status "never".
