# Cloud loop, locally: enrol, claim, check in, see it online

**Goal.** Prove the NVR and the cloud fit together, end to end, on the bench
laptop, with no AWS account resources and no network or firewall change:

1. `camctl enroll` -- the box introduces itself (its public key) and gets a
   claim code;
2. an installer claims the box with that code;
3. `camctl checkin` -- signed check-ins are accepted;
4. `GET /fleet` lists the box `"online"` with its health summary.

**Where it runs.** Everything on the laptop, bound to `127.0.0.1` only, over
https with a throwaway self-signed certificate. The box's sender stays
**https-only** (agent/checkin.mjs refuses `http://` -- that rule is not
relaxed); the box trusts the dev certificate through `NODE_EXTRA_CA_CERTS`
for that one command. State is in memory: restarting the dev server forgets
everything, and the box simply enrols again.

**Out of scope, named so nobody assumes it exists:** the factory claim
certificate (CLOUD-B1-SPEC.md, "enrolment, claim cert, no typed keys"), a
real login, the endpoint that assigns a device to a site, persistence, AWS.

## A. `cloud/contracts/enroll.ts` (pure)

The box proves it holds the private key for the public key it presents, and
that the deviceId it claims is the one that key produces. Pure: every crypto
step is injected, exactly as `checkinVerify.ts` does it.

- **Types**
  - `EnrollPayload`: `{ deviceId: string, publicKeyPem: string, sentAtUtc:
    string (ISO-8601), nonce: string (16 to 64 chars of [A-Za-z0-9_-]) }`.
  - `EnrollEnvelope`: `{ payload: EnrollPayload, signatureB64: string }`.
  - `EnrollCtx`: `{ nowMs, maxSkewMs, allowOpenEnrollment: boolean,
    deviceIdOf(publicKeyPem): string | null,
    verifySignature(message, signatureB64, publicKeyPem): boolean }`.
  - The signed message is `canonicalJson(payload)` from
    contracts/deviceCheckin.ts -- the SAME function check-ins sign (Ed25519
    signs the canonical text itself; there is no separate hash step). Reuse
    it; never write a second canonicaliser.
- **`verifyEnrollment(envelope: unknown, ctx)`** returns
  `{ ok: true, deviceId, publicKeyPem } | { ok: false, reason }`. Checks run in
  this order; the first failure wins:
  1. `"enrollment_closed"` -- `ctx.allowOpenEnrollment !== true`. Production
     enrolment needs the factory claim certificate, which does not exist
     yet, so the default is to refuse (build rule 10). Only the dev server
     turns this on.
  2. `"malformed"` -- not an object; any field missing or of the wrong type;
     `nonce` outside its shape; `sentAtUtc` not parseable; `signatureB64`
     not a non-empty string.
  3. `"bad_device_id"` -- `ctx.deviceIdOf(publicKeyPem)` is `null` (an
     unparseable key) or differs from `payload.deviceId`. A box can never
     enrol under another box's id.
  4. `"clock_skew"` -- `|nowMs - Date.parse(sentAtUtc)| > maxSkewMs`
     (boundary inclusive: exactly `maxSkewMs` is fine).
  5. `"bad_signature"` -- `verifySignature(canonicalJson(payload),
     signatureB64, publicKeyPem)` is false.
- Never throws, whatever `envelope` is.

## B. `cloud/api/enroll.mjs` -- `POST /enroll`

`handler(event, deps)`, Lambda-style like the other three. `deps`:
`{ store, nowMs, verifySignature, randomValues(n): number[] (each 0..31),
allowOpenEnrollment, maxSkewMs, log }`.
`CLAIM_CODE_TTL_MS = 24 h` (exported, unit in the name).

1. Parse `event.body` as JSON (a parse failure is `"malformed"`), then
   `verifyEnrollment`. Refusals: `enrollment_closed` -> 403, everything else
   -> 400, body `{ ok: false, reason }`.
2. `store.getDevice(deviceId)`:
   - **none** -> a new code `formatClaimCode(randomValues(8))`, then
     `putDevice({ deviceId, state: "unclaimed", publicKeyPem, code,
     codeExpiresMs: now + CLAIM_CODE_TTL_MS, installerId: null, siteId:
     null }, { ifState: null })`. A `false` (another enrol of the same box won
     the race) -> 409 `{ ok: false, reason: "wrong_state" }`; the box retries.
   - **stored `publicKeyPem` differs** -> 409 `"key_mismatch"`. A stored key is
     never replaced here.
   - **same key, `"unclaimed"` or `"revoked"`** -> `claimStep(device, { type:
     "reissue", code: <new>, codeExpiresMs })`, then `putDevice({ ...device,
     ...step.device }, { ifState: <the state it was in> })`. Re-enrolling
     always yields a fresh, unexpired code.
   - **same key, `"claimed"`** -> 200 `{ ok: true, claimed: true, claimCode:
     null, expiresUtc: null }` -- the box learns it is already owned.
3. Success -> 200 `{ ok: true, claimed: false, claimCode, expiresUtc }`.
4. `log` exactly once per request: `{ reason, deviceId }` (deviceId `null`
   until verified). **The claim code is never logged.**

## C. The box: `camctl enroll` and a real `camctl checkin`

New `agent/cloud-enroll.mjs` (I/O; the payload shape stays in the contract
above) plus two camctl commands. Both need the box's identity, so they run as
the `camplat` user (`sudo -u camplat ...`).

- `camctl enroll --url https://.../enroll` -- `loadOrCreateIdentity`, build
  the payload (random nonce, `sentAtUtc` now), sign `canonicalJson(payload)`
  with `signWithIdentity`, POST it. https only, refused otherwise, exactly like
  `sendCheckin`. Writes `cloud-enrollment.json` in the state dir `{ url,
  deviceId, claimed, claimCode, expiresUtc, atUtc }` (atomic write), and
  prints the claim code on its own line. Never prints or writes a key.
- `camctl checkin --url https://.../checkin` -- a real send through the
  existing `sendCheckin`. `--dry-run` keeps its current behaviour.
- The signed text must be byte-for-byte what the cloud verifies: both sides
  call contracts/deviceCheckin.ts's `canonicalJson`, pinned by a test.

## D. `cloud/dev/server.mjs` -- the local cloud

`node cloud/dev/server.mjs --port P --cert C --key K`.

- **Loopback only.** Listens on `127.0.0.1`; any `--host` other than
  `127.0.0.1` or `::1` is refused at start. https only.
- **Routes:** `POST /enroll`, `POST /checkin`, `POST /claim`, `GET /fleet`
  -> the four handlers, sharing one `createMemoryStore`.
  `allowOpenEnrollment: true` here and nowhere else.
- **Dev auth.** At start it prints a random bearer token. `/claim` and
  `/fleet` need `Authorization: Bearer <token>` and then act as one fixed
  principal: `installer_tech`, scope installer `inst-dev`, installerId
  `inst-dev`. No token -> 401 `no_principal`. `/enroll` and `/checkin` are
  authenticated by the device's own signature, not the token.
- **Seed and one piece of dev glue.** The tenancy is seeded with installer
  `inst-dev`, org `org-dev` and site `site-dev`. After a successful claim,
  the dev server places the device on `site-dev` in that tenancy (and sets
  the store record's `siteId`). This stands in for the future
  assign-to-site endpoint; it is marked dev-only in the code.
- Real Ed25519 verification (node:crypto). Logs one line per request, never a
  code, token or key.

## E. Tests that matter

- **enroll contract:** each reason in order; `enrollment_closed` wins even
  over a malformed body; a key whose deviceId differs is refused; the skew
  boundary; never throws on junk.
- **enroll handler:** new device -> a valid claim code with an expiry 24 h
  out; same key again -> a fresh code; claimed -> `claimed: true` and no
  code; different key for a known id -> `key_mismatch`, stored key
  untouched; two concurrent enrols of a new box -> exactly one 200; the
  code is absent from every log entry.
- **the loop (devLoop harness):** spawn the dev server with an
  openssl-generated certificate on a free port; a test box identity (a
  fresh Ed25519 key pair) enrols, the claim with the returned code gives
  200, a signed check-in is accepted, and `/fleet` shows the box `"online"`
  with a health summary. Also: a non-loopback `--host` is refused; `/fleet`
  without the token is 401. When `openssl` is not on PATH the harness prints
  `SKIPPED: openssl not found` and exits non-zero, never a silent pass.
- **box side:** `camctl enroll` refuses `http://`; writes
  `cloud-enrollment.json` without any key material; a box-signed enrol
  envelope verifies with the cloud's `verifyEnrollment` (same canonical text
  on both sides).
