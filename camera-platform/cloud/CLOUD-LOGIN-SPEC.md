# Cloud installer login, the setup tool, and production sign-up

Owner's decisions, 2026-09-28: installers log in with **our own login** (not
Cognito); NVRs sign up with **the claim code only** (no factory certificate,
no installer token), unclaimed sign-ups expire after a day, and the sign-up
route is rate-limited. This spec covers everything for that which runs
WITHOUT AWS. The DynamoDB adapter, the Lambda router and the deploy template
come next, in their own spec.

**One login design, not two.** The NVR box already has a proven one
(`contracts/access.ts`, `agent/auth.mjs`). Where this spec and the box
agree, the box's code is the reference; where the cloud differs, the reason
is written down (a Lambda keeps nothing in memory between requests, so
sessions and failure counts live in the store).

## A. `cloud/contracts/auth.ts` (pure, no I/O)

- **Password rule: reuse the box's.** Re-export `validatePassword` and
  `MIN_PASSWORD_LENGTH` from `contracts/access.ts` (add
  `"../contracts/access.ts"` to `cloud/tsconfig.json`'s `include`; it has no
  imports). Same 12-character minimum, same refusal list, same reasons.
- **Login names.** `normalizeLogin(raw): string | null` -- a string, trimmed
  of nothing (a leading/trailing space is refused, not stripped),
  lower-cased, 3 to 64 characters from `[a-z0-9._@+-]`, else `null`. Logins
  are compared only in this normalized form.
- **Stored password record: the box's shape.** `{ algo: "scrypt", N, r, p,
  salt, key }` with `salt` 64 hex characters (32 bytes) and `key` 128 hex
  characters (64 bytes). `checkPasswordRecord(raw): string[]` returns
  problems, in order: `"not_object"`, `"bad_algo"`, `"bad_params"` (N a power
  of two in 1024..1048576, r in 1..16, p in 1..4 -- the box's bounds, so a
  tampered N cannot pin the CPU), `"bad_salt"`, `"bad_key"`.
  Constants: `SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 }`, `SALT_BYTES = 32`,
  `KEY_BYTES = 64`. Hashing is I/O and lives in `cloud/api/login.mjs`.
- **User record.** `{ userId, login, installerId, password, disabled,
  sessionEpoch, createdMs }`. `checkUserRecord(raw): string[]` checks every
  field (`userId` matches `/^usr_[0-9a-f]{16}$/`, `login` is already
  normalized, `password` passes `checkPasswordRecord`, `disabled` is a
  boolean, `sessionEpoch` a non-negative integer, `createdMs` a finite
  number). `sessionEpoch` goes up by one on every password reset and every
  disable: that is how the box's "resetting a password signs out that
  account's other sessions" works without scanning a table.
- **Failed-login throttle: the box's escalation.** `loginDecision(failuresMs,
  nowMs, freeFailures) -> { allowed: true } | { allowed: false, retryAfterMs }`.
  - Only failures with `nowMs - f < FAILURE_MEMORY_MS` (24 h) count; call
    that count `n`.
  - `n < freeFailures` -> allowed. Otherwise locked until
    `max(failures) + min(FIRST_LOCK_MS * 2 ** (n - freeFailures),
    MAX_LOCK_MS)`: 30 s after the 5th failure, 60 s after the 6th, ... capped
    at 15 minutes. Exactly the box's numbers.
  - Two keys, two budgets: `FREE_FAILURES_PER_ACCOUNT = 5`,
    `FREE_FAILURES_PER_SOURCE = 20`.
  - Anything that is not an array of finite numbers -> `{ allowed: false,
    retryAfterMs: MAX_LOCK_MS }`. A broken count fails closed.
- **Sessions.** Token: 32 random bytes, base64url (43 characters), handed to
  the browser once; only its SHA-256 hex is stored. A session record is
  `{ login, createdMs, lastSeenMs, epoch }`.
  `SESSION_IDLE_MS = 12 h`, `SESSION_MAX_MS = 7 days` (the box's values).
  `sessionState(session, user, nowMs)` -> first match wins:
  `"malformed"` (bad record) -> `"revoked"` (no user, user disabled,
  `session.login !== user.login`, or `session.epoch !== user.sessionEpoch`)
  -> `"expired_max"` (`nowMs -
  createdMs >= SESSION_MAX_MS`) -> `"expired_idle"` (`nowMs - lastSeenMs >=
  SESSION_IDLE_MS`) -> `"valid"`.
  `SESSION_TOUCH_EVERY_MS = 5 min`; `needsTouch(session, nowMs)` is true when
  `lastSeenMs` is at least that old (one write per 5 minutes per session, not
  one per request -- AWS costs are tight).
- **Principal.** `principalOf(user)`: an active user -> `{ userId, role:
  "installer_tech", scope: { kind: "installer", id: installerId },
  installerId }` (the `ApiPrincipal` shape `cloud/api/fleet.mjs` already
  reads); a disabled user -> `null`. Chain roles come later; this build logs
  in installers only.

## B. Store additions (`store.mjs` typedefs, `memoryStore.mjs`, conformance)

- **Users, keyed by normalized login.**
  - `getUser(login) -> user | null`.
  - `putUser(user, { ifAbsent: true })` creates; refused (false) if that
    login exists.
  - `putUser(user, { ifEpoch: n })` updates; refused unless the stored user
    exists with `sessionEpoch === n`.
- **Failed logins** (each entry is an attempt until it is proven good; see
  section C for why).
  - `recordFailedLogin(key, atMs) -> id`: `id` is a string that sorts in
    time order: `atMs` zero-padded to 15 digits, then `#`, then 8 hex
    characters of a per-process counter (so same-millisecond attempts in one
    process sort in call order), then 8 random hex characters.
  - `failedLogins(key, sinceMs) -> [{ id, atMs }]`, ascending by `id`. For
    DynamoDB this is a strongly consistent read.
  - `deleteFailedLogin(key, id) -> boolean`.
  - `clearFailedLogins(key)`.
  - Keys are `"acct:<login>"` and `"src:<address>"`. (DynamoDB will expire
    entries with a TTL after `FAILURE_MEMORY_MS`; the memory store need not.)
- **Sessions.**
  - `putSession(tokenHash, session)`: create only; false if that hash exists.
  - `getSession(tokenHash)`.
  - `touchSession(tokenHash, lastSeenMs)`.
  - `deleteSession(tokenHash)`.
- **Tenancy writes (the setup tool only; no HTTP route writes tenancy yet).**
  - `getTenancyRecord(installerId) -> { tenancy, version } | null`.
  - `putTenancy(installerId, tenancy, { ifVersion })` -> boolean.
    `ifVersion: null` means "create; refuse if one exists".
    A number means "replace only if the stored version is exactly this".
    A successful write stores `version = (ifVersion ?? 0) + 1`.
  - `getTenancy` is unchanged and returns what `putTenancy` wrote.
  - Seeded tenancies start at version 1.
- **Devices.** `StoreDevice` gains `expiresAtS: number | null` (epoch
  seconds). It is set on an unclaimed record so DynamoDB can delete the
  record after its claim code dies, and it is `null` on a claimed or revoked
  one. `putDevice` stores it as given. A record written before this field
  existed reads back without it; treat that as `null`, never as 0.
  - DynamoDB's TTL deletes up to ~48 h late, so handlers keep checking
    `codeExpiresMs` exactly as today.
- **Every getter returns a copy.** Mutating a returned user, session or
  tenancy must not change the store.
- **`storeConformance.harness.mjs` covers every new method**, including these
  races run with `Promise.all`:
  - two `putUser(..., { ifAbsent: true })` for one login -> exactly one wins;
  - two `putTenancy` with the same `ifVersion` -> exactly one wins;
  - two `putSession` for one hash -> exactly one wins.

## C. `cloud/api/login.mjs`: `POST /login`, `POST /logout`, `principalFromEvent`

**Event shape** for these three (the Lambda router will adapt API Gateway's
event into it):

```
{ body: string, headers: Record<string, string> (lower-case names), sourceIp: string }
```

**Deps**: `{ store, nowMs(), randomBytes(n), scrypt?, scryptParams?, log }`.
`scrypt` defaults to node:crypto's (promisified) and is injectable so a test
can count calls. `scryptParams` defaults to `SCRYPT_PARAMS`, and tests pass
`{ N: 1024, r: 8, p: 1 }`.

Also export `hashPassword(password, deps)` and `verifyPassword(password,
record, deps)`. Both use `password.normalize("NFC")`, like the box. Verify
uses the record's own parameters, bounded by `checkPasswordRecord`, and
compares with `timingSafeEqual`.

### `loginHandler(event, deps)`

1. The body must be JSON `{ login, password }` with both strings, and the
   `content-type` must be `application/json`. Anything else -> 400
   `{ ok: false, reason: "bad_request" }`.
   - Requiring JSON means a cross-site HTML form cannot post a login.
2. Normalize the login.
   - The account key is `"acct:" + normalized`. If the login does not
     normalize, use `"acct:" + raw.toLowerCase()`, and at most 64
     characters of it.
   - The source key is `"src:" + sourceIp`.
   - **Record first, then count.** Record an attempt on both keys, then read
     both keys' entries. For each key, run `loginDecision` on the times of
     the entries that sort strictly BEFORE this request's own entry.
     - If either is not allowed: delete this request's two entries (a
       refused attempt is not a guess and must not lengthen the lock), then
       429 `{ ok: false, reason: "locked", retryAfterS }` with a
       `retry-after` header. No scrypt runs.
     - Why the order matters: many copies of this handler run at once. If
       each one counted before any had recorded, 20 simultaneous guesses
       would all pass a 5-guess budget (measured: all 20 ran). Counting
       only the entries ahead of your own lets exactly the first ones
       through.
3. Load the user.
   - The same 401 `{ ok: false, reason: "bad_credentials" }`, byte for byte,
     for any of these:
     - an unknown login or a login that does not normalize: still run ONE
       scrypt against a fixed dummy record built with the same parameters,
       so the timing matches;
     - a wrong password;
     - a disabled user: never say "disabled".
   - The two entries recorded in step 2 stay: they are the failure records.
     An unknown login still grows its account count, so a lockout reveals
     nothing about whether the account exists.
4. Success:
   - clear the account key, and delete only this request's own source entry
     (NOT the whole source key: one good account must not wipe a sprayer's
     count);
   - create the token and `putSession(hash, { login, createdMs: now,
     lastSeenMs: now, epoch: user.sessionEpoch })`;
   - respond 200 `{ ok: true }` with `set-cookie: camplat_session=<token>;
     HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`.
   - The token appears ONLY in that header, never in the body.
5. Logging: exactly one `deps.log({ route: "login", reason, userId })` per
   request. `reason` is null on success. `userId` is null when unknown.
   - Never log the login name, the password, the token or its hash.

### `logoutHandler(event, deps)`

- Delete the session that the cookie names, if any.
- Always 200, with a clearing cookie: `camplat_session=; HttpOnly; Secure;
  SameSite=Strict; Path=/; Max-Age=0`.

### `principalFromEvent(event, deps) -> principal | null`

1. Parse the `cookie` header. Use the box's `parseCookies` rules (copy them;
   `agent/auth.mjs` is not importable from the cloud).
2. The token must match `/^[A-Za-z0-9_-]{43}$/`.
3. Hash it and get the session, then the user for the session's login, then
   run `sessionState`.
4. Anything but `"valid"` -> delete that session (best effort) and return
   `null`.
5. If `needsTouch` is true, call `touchSession`.
6. Return `principalOf(user)`.
- Cookie only. There is no bearer token in production; the dev server's dev
  token is dev-only.

### Changes to existing handlers

`claim.mjs` and `fleet.mjs` change `deps.principalOf(event)` to `await
deps.principalOf(event)`, so an async principal works. Nothing else in them
changes.

## D. Production sign-up (`cloud/api/enroll.mjs`, `cloud/contracts/enroll.ts`)

- Production runs with `allowOpenEnrollment: true` (the owner's decision).
  - Rewrite the contract comments that said production needs a factory
    certificate. They now record this decision and its guard rails:
    - codes expire in 24 h;
    - unclaimed records expire with them;
    - `/enroll` is throttled at API Gateway (deploy spec);
    - a claim needs a logged-in installer.
- Every unclaimed record that enrol writes (new, or a code reissue) gets
  `expiresAtS = Math.ceil(codeExpiresMs / 1000)`.
- A claim writes `expiresAtS: null`.
- No per-request rate-limit state in the handler.

## E. The setup tool: `cloud/admin/admin.mjs`

A command-line tool Austin runs himself. It exports `runAdmin(argv, deps)`,
where deps is `{ store, promptSecret(question) -> Promise<string>,
out(line), nowMs(), randomBytes(n), scryptParams? }`, and it returns an exit
code.

Connecting its `main` to DynamoDB belongs to the AWS spec. Until then, `main`
exits with "no production store yet".

**Commands:**
- `create-installer <installerId> <name>`
- `create-user <login> <installerId>`. The installer must exist.
  - The password comes from `promptSecret`, asked twice. They must match,
    and `validatePassword(pw, login)` must pass; otherwise the tool prints
    the box's reason text.
  - The new user is `userId = "usr_" + 8 random bytes hex`, with
    `sessionEpoch: 0`.
- `reset-password <login>`: prompts the same way. It writes the new hash and
  `sessionEpoch + 1` with `ifEpoch`, which signs out every existing session.
- `disable-user <login>` and `enable-user <login>`. Disable also bumps the
  epoch.
- `create-org <installerId> <orgId> <name>`. The org's privacy defaults to
  `{ offered: false, installerBlocked: false }`, the documented default.
- `create-site <installerId> <orgId> <siteId> <name>`
- `assign-device <installerId> <deviceId> <siteId>`. This replaces the dev
  server's "place it on site-dev" glue.
  - The device must be claimed by THAT installer, and the site must be that
    installer's.
  - First write the tenancy's `devices` entry (replace any existing entry
    for the device) with `ifVersion`. Then write the device record's
    `siteId` with `ifState: "claimed"`.
  - If the second write fails, say exactly which half landed. Re-running the
    same command is safe (idempotent).

**Rules for every command:**
- A password is never an argument. Any `--password` / `--password=...` /
  `-p` argument -> exit 2 with a message that does not repeat its value.
  Arguments end up in shell history and process lists.
- Every tenancy change passes `checkTenancy` before it is written, and uses
  `getTenancyRecord` + `putTenancy({ ifVersion })`.
  - A lost race prints "someone else changed this installer's setup at the
    same moment; nothing was changed -- run it again", and exits 1.
- The output never contains a password, a hash, a salt or a session.

## F. Tests that matter (write them failing first)

- **`cloud/harness/auth.harness.mjs`**
  - every `checkPasswordRecord` and `checkUserRecord` reason;
  - the password rule IS the box's (the same function object);
  - `loginDecision` boundaries: 4 vs 5 failures; 30 s then 60 s; the
    15-minute cap; a failure exactly 24 h old no longer counts; garbage
    fails closed;
  - `sessionState` boundaries: exactly 12 h idle, exactly 7 days, epoch
    mismatch, disabled or missing user;
  - `needsTouch` at 5 minutes;
  - a disabled user has no principal.
- **`cloud/harness/apiLogin.harness.mjs`**
  - an unknown login and a wrong password give byte-identical responses;
  - an unknown login still runs exactly one scrypt;
  - the 6th try inside the lock is 429 even with the RIGHT password, and
    runs no scrypt;
  - an unknown login gets locked just like a real one;
  - success clears the account count but not the source count;
  - the cookie flags are exact;
  - the token is in no body and no log line, and the password in no log
    line;
  - `principalFromEvent`: a tampered token, an idle-expired session, a
    max-expired session, a reset password (epoch bumped), a disabled user
    and a deleted session all give null; a good one gives the installer
    principal, and touches only after 5 minutes;
  - logout ends the session.
- **`storeConformance.harness.mjs`**: section B's methods and the three
  races.
- **`cloud/harness/admin.harness.mjs`**
  - a password argument is refused, and its value never echoed;
  - mismatched and weak passwords are refused with the box's reason;
  - `assign-device` refuses another installer's device, an unclaimed
    device, and another installer's site;
  - a lost `putTenancy` race changes nothing;
  - `reset-password` kills an existing session (through
    `principalFromEvent`);
  - no hash or salt in the output.
- **`devLoop.harness.mjs`**: the dev server gains `/login` and `/logout`,
  and its `/claim` and `/fleet` accept a real session as well as the dev
  token. The loop runs:
  1. seed an installer and a user through `runAdmin`;
  2. log in over HTTPS;
  3. the box enrols;
  4. claim;
  5. `assign-device`;
  6. the box checks in;
  7. fleet shows it online;
  - all using the cookie, not the dev token.
- **`apiEnroll` / `apiClaim`**: `expiresAtS` is set on enrol and on reissue,
  cleared on claim; an async `principalOf` works.

## G. Known limits (measured or reasoned, not guessed)

- **The attempt count is strict within one process, not across servers.**
  One process orders its own attempts exactly: 20 simultaneous wrong guesses
  run exactly 5 password checks, every time (10 trials). Across separate
  Lambda instances, ids come from each host's clock. A request recorded a
  fraction of a millisecond later, with a smaller id from a slower clock, can
  land after another request has already counted. So a burst timed inside
  the hosts' clock skew (about a millisecond under Amazon Time Sync) can slip
  a guess or two past the budget. The `/login` route's API Gateway burst
  limit (deploy spec) bounds it. If this ever matters, the strict version is
  a per-key document with a version number and a conditional append, the
  same pattern as `putTenancy`.
- **The setup tool's `assign-device` is two writes, not one transaction.** If
  the second write fails, the tool says which half landed; re-running it is
  safe. That failure path is reviewed, not tested.
- **Measured before this build existed:** `harness/pushDelivery.harness.mjs`
  (the box's own push-alert suite) fails whenever the real clock is past
  2026-09-28T14:00Z. It is a real-clock dependency in that harness, found
  while verifying this build, and tracked separately.
