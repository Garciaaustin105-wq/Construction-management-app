# Cloud slice 1: device claim, signed check-in, fleet list (pure contracts)

Slice 1 of CLOUD-B1-SPEC.md section 7 ("box identity and telemetry"). It is
hosting-agnostic: pure functions only. Hosting is not decided, and nothing
here depends on it. The cloud never receives video in this slice (section
6).

**Layout:**
- Everything lives in `camera-platform/cloud/`, never shipped in an NVR
  release (release.mjs ships agent, dist, setup, harness and detector only).
- `cloud/contracts/*.ts` compile with `cloud/tsconfig.json` (same compiler
  options as ../tsconfig.json, rootDir `contracts`, outDir `dist`), and
  import the box's own contract: `../../contracts/deviceCheckin.ts`
  (canonicalJson, checkinDigest, CheckinPayload, CHECKIN_SCHEMA_VERSION).
  That way the box and the cloud can never disagree about what was signed.
- Tests go in `cloud/harness/*.harness.mjs`, using `../../harness/_assert.mjs`,
  with a runner `cloud/harness/run-all.mjs`.

**Rules** (AGENTS.md build rules):
- refuse rather than guess;
- a blank is not a zero;
- every quantity carries its unit;
- no credential, URL or camera address in any output;
- functions never throw on bad input (a refusal is a value), except on
  caller bugs such as a non-function `verifySignature`.

## 1. contracts/claimCode.ts

A claim code is shown on the NVR's setup screen and typed by the installer
to take ownership. Human-typed, so it must be forgiving.

- `CLAIM_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"`: Crockford base32,
  no I, L, O or U.
- `formatClaimCode(values: number[]): string`
  - `values` is exactly 8 integers 0..31.
  - The result is `"XXXX-XXXX-C"`: 8 symbols, then one Crockford check
    symbol. The check value is `(sum over i of values[i]*(i+1)) mod 37`,
    drawn from `CLAIM_ALPHABET + "*~$=U"`.
  - Any other input throws (a caller bug).
- `parseClaimCode(input: unknown)` returns `{ ok: true, code: string }` (the
  canonical `"XXXX-XXXX-C"` form) or `{ ok: false, reason }`.
  - It is case-insensitive, and strips spaces and hyphens.
  - It maps O to 0, and I or L to 1.
  - Reasons are exactly one of `"not_text"`, `"wrong_length"`,
    `"bad_symbol"` and `"bad_check"`.
- `claimStep(device, action, nowMs)` is the claim state machine.
  - `device` is `{ state: "unclaimed" | "claimed" | "revoked", code: string
    | null, codeExpiresMs: number | null, installerId: string | null }`.
  - Actions:
    - `{ type: "claim", code, installerId }`: allowed only from
      unclaimed, with an exact canonical code match and
      `nowMs < codeExpiresMs`.
    - `{ type: "revoke" }`: allowed only from claimed.
    - `{ type: "reissue", code, codeExpiresMs }`: allowed from unclaimed or
      revoked. It sets a fresh code and clears `installerId`.
  - It returns `{ ok: true, device }` (a new object; the input is never
    mutated) or `{ ok: false, reason }`. Reasons are exactly one of
    `"wrong_state"`, `"code_mismatch"`, `"code_expired"`, `"no_code"` and
    `"bad_action"`.
  - A successful claim clears `code` and `codeExpiresMs`: the code is
    single-use.

## 2. contracts/checkinVerify.ts

- `CLOCK_SKEW_LIMIT_MS = 300000` (5 min).
- `verifyCheckin(envelope, ctx)` returns `{ ok: true, payload }` or
  `{ ok: false, reason }`.
  - `envelope` is `{ payload: CheckinPayload, signature: string }`, with the
    signature as base64. It is unknown until checked.
  - `ctx` is `{ devices: Map<deviceId, { state, publicKeyPem }>,
    lastSeq: Map<deviceId, number>, nowMs: number, verifySignature:
    (digestHex: string, signatureB64: string, publicKeyPem: string) =>
    boolean }`.
- The checks run in this order, and the first failure wins:

  | # | Reason | Fails when |
  |---|---|---|
  | 1 | `"malformed"` | the envelope or payload shape is wrong |
  | 2 | `"unsupported_version"` | `checkinVersion` is not `CHECKIN_SCHEMA_VERSION` |
  | 3 | `"unknown_device"` | the deviceId is not in `devices` |
  | 4 | `"not_claimed"` | the device state is not `"claimed"` |
  | 5 | `"bad_signature"` | `verifySignature(checkinDigest(payload), signature, key)` is false, or it throws |
  | 6 | `"replay"` | `seq <= lastSeq.get(deviceId)`; an absent lastSeq accepts any seq >= 1 |
  | 7 | `"clock_skew"` | `abs(Date.parse(sentAtUtc) - nowMs) > CLOCK_SKEW_LIMIT_MS` |

- A refusal never includes the payload's health contents or the signature.

## 3. contracts/fleet.ts

- `fleetStatus(lastAcceptedMs: number | null, nowMs, intervalMs)` returns:
  - `"never"` when the value is null;
  - `"online"` when age <= 2.5 x intervalMs;
  - `"late"` when age <= 10 x intervalMs;
  - `"offline"` otherwise.
  - Age is `nowMs - lastAcceptedMs`. A negative age (a future timestamp)
    counts as `"online"`.
- `summarizeHealth(health: CheckinPayload["health"], nowMs)` returns only
  measurements:

  ```
  { version, uptimeSec,
    cameras: { total, recording, silent: string[] (cameraIds whose lastSealedUtc is null
               or older than 10 min), neverRecorded: string[] (lastSealedUtc null) },
    drives: { total, problems: [{ label, reason }] } (a drive with ok === false or a
               non-null problem field, whatever deviceCheckin's CheckinDriveFact carries),
    footageHeldHours (number | null, passed through; never 0 for null),
    lastSealedUtc }
  ```

  Find the exact field names in deviceCheckin.ts's `CheckinCameraFact` and
  `CheckinDriveFact`, and never guess them.
- `fleetRow(device, lastAccepted, nowMs, intervalMs)` returns
  `{ deviceId, state, status: fleetStatus(...), lastSeenUtc | null, health:
  summarizeHealth(...) | null }`.
  - `device` is `{ deviceId, state }`.
  - `lastAccepted` is `{ atMs, payload } | null`.

## Tests that matter

- **claimCode:**
  - format then parse round-trips for 1,000 generated codes;
  - lowercase, spaces and missing hyphens are accepted;
  - O and I/L are mapped;
  - a single-symbol typo fails `bad_check`, for every position.
- **claimStep:**
  - it refuses from every wrong state;
  - an expired code is refused, including at `nowMs == codeExpiresMs`;
  - a claim is single-use;
  - reissue clears the installer;
  - the input is never mutated.
- **verifyCheckin:**
  - each reason reached in order;
  - `verifySignature` throwing gives `bad_signature`, not a crash;
  - replay at an equal seq;
  - clock skew at exactly the limit is accepted, and 1 ms more is refused;
  - no health data inside a refusal.
- **fleetStatus:** at exactly 2.5x and 10x, the boundaries are inclusive.
- **summarizeHealth:** null stays null, and a never-recorded camera is
  listed in both `silent` and `neverRecorded`.
