# Cloud link on the box: the address, the claim code, and a check-in every minute

**Why.** The cloud loop works (cloud/CLOUD-LOOP-SPEC.md, proven live on the
bench 2026-09-28), but only by hand: `camctl enroll --url` and `camctl checkin
--url`. A real box must check in on its own, and the installer must be able to
see its claim code and whether the cloud is hearing from it -- on the System
page, not over SSH.

**Owner's rules that shape it.** Nothing is sent unless the installer turns it
on (off by default -- agent/checkin.mjs already sends nothing without a URL).
https only. Local-first: this is the control channel only; no video goes this
way. No camera credential ever leaves the box (agent/checkin.mjs's existing
guards stay exactly as they are).

## A. `contracts/cloudLink.ts` (pure)

- `CloudSettings`: `{ url: string | null, enabled: boolean }` -- what the box
  keeps in `cloud.json` in its state dir. A separate file on purpose:
  `config.json` holds camera credentials and is never read for this.
- `checkCloudSettings(raw: unknown)` -> `{ ok: true, settings } | { ok: false,
  reason }`. Reasons: `"not_an_object"`, `"bad_url"` (not a string, not a
  parseable absolute URL, or not `https:` -- `http:` is refused, never
  upgraded), `"url_has_credentials"` (a `user:pass@` part), `"bad_enabled"`
  (not a boolean). `url: null` with `enabled: false` is valid (the default);
  `enabled: true` with `url: null` is `"bad_url"`.
- `DEFAULT_CLOUD_SETTINGS = { url: null, enabled: false }`.
- `enrollUrlOf(url)` and `checkinUrlOf(url)`: the base address plus
  `/enroll` or `/checkin`, one trailing slash tolerated, never two.
- `cloudStatusView({ settings, enrollment, checkin, nowMs })` -> what the
  System page shows, measurements only (build rule 11):
  - `enrollment` is the parsed `cloud-enrollment.json` or `null`;
    `checkin` is `{ seq, lastOutcome, lastAtUtc } | null` (see C).
  - Returns `{ state, deviceId, claimCode, codeExpiresUtc, codeExpired,
    lastCheckinUtc, lastOutcome }` where `state` is one of `"off"` (not
    enabled), `"not_enrolled"`, `"waiting_for_claim"` (enrolled, a code, not
    claimed), `"claimed"`. `claimCode` is shown only while
    `waiting_for_claim` and not expired; `codeExpired: true` says so instead
    of hiding it silently. A blank is not a zero: never-checked-in is
    `lastCheckinUtc: null`, not a time.

## B. The API: `GET /cloud-link`, `POST /cloud-link`, `POST /cloud-link/enroll`

All three: permission `system.manage` (installer only), like `/site-settings`.

- `GET /cloud-link` -> `cloudStatusView(...)` plus the settings. Reads
  `cloud.json` (absent = defaults), `cloud-enrollment.json`, and the check-in
  record from C. Never returns a key, a token or a camera URL.
- `POST /cloud-link` `{ url, enabled }` -> validated by `checkCloudSettings`;
  refused 400 with the reason; written atomically (tmp + rename). Changing the
  URL to a different address clears `cloud-enrollment.json` (it belonged to
  the old cloud) -- stated in the response, never silent.
- `POST /cloud-link/enroll` -> calls agent/cloud-enroll.mjs `enroll()` with
  `enrollUrlOf(settings.url)`; refused 409 `"cloud_off"` when not enabled.
  Returns the new status view (the claim code included). The claim code is
  never written to a log.

## C. The timer

- `camplat-checkin.service` (oneshot, `User=$RUN_USER`, same shape as
  `camplat-alerts.service`) runs `camctl checkin` with NO `--url`: camctl then
  reads `cloud.json` and does nothing -- exit 0, one quiet line -- unless
  enabled with a valid URL.
- `camplat-checkin.timer`: `OnBootSec=2min`, `OnUnitActiveSec=60s` (the cloud's
  `CHECKIN_INTERVAL_MS` in cloud/api/fleet.mjs is 60 000 ms; they must agree),
  `AccuracySec=5s`.
- After each attempt camctl writes `checkin-last.json` in the state dir
  `{ seq, lastOutcome, lastAtUtc }` (atomic) for the status view. It never
  holds the payload or the signature.
- **Both `setup/install.sh` and `setup/upgrade.sh` write and enable these two
  units** (idempotently) -- upgrade.sh today installs no units, so without
  this a box already in the field would never get the timer.

## D. The System page: a "Cloud" section

Below the Site section, installer only (the section is absent for anyone
without `system.manage`, same as Site). Shows the state in words ("Off",
"Not enrolled yet", "Waiting for the installer to claim it -- code XXXX-XXXX-C,
expires ...", "Claimed"), the last check-in time and outcome, the device id,
a Cloud address field, an On/Off switch, Save, and "Get a claim code". Every
browser client needs its bootstrap block and a load check (bus note
camera-page-bootstrap-lesson).

## E. Tests that matter

- **contract:** every refusal reason; http refused; credentials in the URL
  refused; the four states; an expired code is flagged, not silently shown or
  dropped; never-checked-in is null; the two URL helpers never produce `//`.
- **API:** 403 for a store or manager account; a bad body is 400 with the
  reason and changes nothing on disk; changing the URL clears the old
  enrolment and says so; enrol while off is 409; no response ever contains
  key material.
- **timer path:** `camctl checkin` with no `cloud.json` sends nothing and
  exits 0; with `enabled: false` sends nothing; with a valid enabled URL it
  sends and writes `checkin-last.json` (fake fetch).
- **units:** install.sh and upgrade.sh both contain the two units with the 60 s
  interval (a text check), and upgrade.sh enables the timer.
- **page:** the section renders each state from a fake status, never shows a
  claim code once claimed, and is absent without `system.manage`.
