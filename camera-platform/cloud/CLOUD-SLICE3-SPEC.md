# Cloud slice 3: license entitlement (pure contract)

This is CLOUD-B1-SPEC.md section 4, as pure functions. It is
hosting-agnostic. It uses the same layout as the earlier slices.

Owner's decisions, quoted: "when a license turns off we will not have
anything on the cloud and also no updates the camera and the nvr onsite
facility will keep working but nothing going to the cloud will work."

- **A lapse switches off:** every cloud feature (remote access, the cloud
  dashboard, anything relayed off-site) and all software updates.
- **A lapse must NEVER touch:** recording, local viewing on the site's LAN,
  or the on-box AI.
- **Installers pay; the platform collects only from installers.**

**Undecided, so these are inputs, never guessed:**
- **What unit a license covers** (per camera or per box): this contract
  only answers "is this device covered".
- **Whether push alerts stop on a lapse:** a policy input,
  `pushAlertsNeedLicense: boolean | null`. A null policy means push is
  answered `"policy_undecided"`, never allowed or blocked by default.
- **Any grace period:** a policy input, `graceMs: number | null`. A null
  means no grace.

## contracts/license.ts

- **Types**
  - `License`: `{ id, installerId, deviceIds: string[], startsMs, endsMs,
    revokedMs: number | null }`.
  - `LicensePolicy`: `{ pushAlertsNeedLicense: boolean | null, graceMs:
    number | null }`.
- **`checkLicense(l)`**
  - It lists every problem, with the reasons `"ends_before_starts"`,
    `"empty_devices"`, `"duplicate_device"` and `"bad_time"`.
  - Times are finite integers in ms.
- **`coverage(licenses, deviceId, nowMs, policy)`** returns `{ state:
  "active" | "grace" | "lapsed" | "none", licenseId: string | null, endsMs:
  number | null }`.
  - active: the device is covered by a license that has started and not
    ended, and is not revoked.
  - grace: it ended within `graceMs` (only when graceMs is non-null) and is
    not revoked.
  - lapsed: it ended, or was revoked, and the time is past any grace.
  - none: no license ever named the device.
  - The best license wins, in the order active, then grace, then lapsed.
    Among equals, the latest `endsMs` wins.
- **`entitled(cov, feature, policy)`** returns `{ ok: true } | { ok: false,
  reason }`.
  - `"recording"`, `"local_view"` and `"on_box_ai"` are ALWAYS ok, whatever
    the state (the owner's rule).
  - `"remote_access"`, `"cloud_dashboard"` and `"updates"` are ok only
    when active or grace; otherwise `"license_lapsed"`, or `"no_license"`
    when the state is none.
  - `"push_alerts"`:
    - policy null gives `"policy_undecided"`;
    - false is always ok;
    - true follows the remote_access rule.

**Tests that matter:**
- recording, local view and on-box AI are ok in EVERY state, including
  none and revoked;
- the boundaries: exactly at `endsMs` is lapsed, and exactly at
  `endsMs + graceMs` is lapsed;
- revoked beats active;
- the best of several licenses is chosen;
- a null push policy is `"policy_undecided"` in every state;
- `checkLicense` lists every problem.
