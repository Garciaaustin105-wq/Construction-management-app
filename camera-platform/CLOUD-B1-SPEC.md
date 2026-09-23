# Cloud control plane — design spec (B1)

Status: design only, 2026-09-23. Nothing here is built. This is the plan for
`BUILD-PLAN.md`'s B1 ("cloud control plane"), written now because Austin
settled the tenancy, roles, licensing and alert-channel questions that B1 was
waiting on (bus notes below), and `docs/handoff-signed-updates.md` flagged
tenancy as the open decision that "shapes every table and route and is
expensive to change later."

This is a design, not an implementation order. It follows build rule 1
(contract, then harness, then UI) and rule 12 (report what a professional
specified; do not specify the engineering) — nothing here should be read as
"start coding this shape," only as "this is what the shape is once someone
does."

**Sources read:** `BUILD-PLAN.md` (B1/B2, sequencing notes), `AI-PLAN.md` (D3
alerts), `HEALTH-ALERTS-DESIGN.md`, `agent/auth.mjs`, `contracts/access.ts`,
`agent/ui/accounts-client.mjs` + `accounts.html`, `agent/verify-release.mjs`,
`setup/` (`install.sh`, `sign-release.mjs`, `trust-anchor.sh`, `README.md`),
`agent/healthfacts.mjs`, `docs/handoff-signed-updates.md`, and the agent-bus
notes `camera-market-and-channels`, `camera-licensing-channel`,
`camera-roles-decided`, `camera-alert-channel-decided`,
`camera-tiers-and-licensing`, `camera-site-topology`, `camera-handoff-next`,
`camera-platform-client-targets` (all Austin, 2026-09-22 unless dated
otherwise).

---

## 1. Tenancy

Austin, 2026-09-22, two statements taken together (`camera-roles-decided`):
first about the first chain customer — "no customers access to this its just
store manager or regional manager then head office" — then widening it:
"lets not just focus on this one organization these nvrs will be used
everywhere from car washes to storage facilitys to customer homes." And
separately (`camera-market-and-channels`): "i will also sell nvr and
licensing to other installers too."

So the platform is multi-tenant two ways at once: many kinds of customer
organization, sold through many installers, one of whom happens to be
Austin's own company.

```
platform (Austin's company — manufacturer and software developer)
 └─ installer account (one per installer; Austin's company is also one)
     └─ customer organization (a chain, a single car wash, a storage
        facility, a household — shapes vary, do not assume one)
         └─ group (optional — e.g. a region; nesting groups inside groups
            is not yet decided, see §9)
             └─ site (one physical location)
                 └─ NVR (usually one per site)
                     └─ camera
```

Firm rules from the notes:

- **One installer never sees another's customers.** Each installer's account
  oversees its own organizations only (`camera-market-and-channels`, point 3).
- **A user's scope is a level in this tree, not a hardcoded shape.** Head
  office is organization-scoped, a regional manager is group-scoped, a store
  manager is site-scoped, a homeowner is organization-scoped for a
  one-site organization. Build nothing that assumes the chain's shape, or
  that Austin's company is the only installer (`camera-roles-decided`,
  `camera-market-and-channels`: "Build nothing that assumes one installer,
  one organization shape, or Austin as the only installer").
- **Sites and NVRs are today's `siteId`.** `agent/healthfacts.mjs` already
  stamps every health snapshot with `config.siteId` — B1's site record is
  the cloud-side counterpart of a value the box already carries.

## 2. Users and scopes

| Role | Who | Scope | Sees / does |
|---|---|---|---|
| Platform staff | Austin's company, running the platform itself | across installers, for support | see §9 — how much is open |
| Installer tech | works for an installer | that installer's whole book, or narrower if the installer sets it up | everything today's on-box **installer** role can do (§8), for every org/site under that installer — minus video a client has blocked (§3) |
| Head office | chain staff | one organization | live + recorded video, health, settings, for every site in the org |
| Regional manager | chain staff | one group (region) | the same, for sites in that group only |
| Store manager | staff at one site | one site | the same, for that site only — close to today's on-box **store** role, but explicitly site-scoped rather than "whole box" |
| Homeowner | owns a household NVR | their organization (= their one site) | *inferred, to confirm (§9):* the same set as a store manager — a homeowner is the account holder for their own site, the way a store manager is the account holder for theirs |

**"No customer access" is specific to the chain**, where shoppers are not
account holders at all. It does not mean customers never get accounts —
at a household, the customer *is* the account holder (the homeowner). The
rule that generalizes: the people watching a site as staff or owners get
accounts; the public passing through the site never does.

**Alerts are opt-in per user, scoped to what their role already covers**
(`camera-roles-decided`): a regional manager can only opt into alerts for
cameras their group already reaches, never wider. Defaults (which cameras,
which hours) differ by kind of place — a home may want alerts all night, a
car wash only after closing — and that is seed structure, never seeded
values (build rule 8).

## 3. Installer access to video, and the privacy option

Decided (`camera-market-and-channels`, point 4): installer oversight
**includes** the client's live view and recorded footage — "thats how it
works currently with openeye." This is the default for every client.

**The privacy option (installer-controlled, per client):**

- By default, a client sees no viewer log and has no switch to turn
  installer access off. This is not hidden from them out of secrecy; it is
  simply not offered unless the installer turns it on.
- Per client, the installer may turn the option on. Once on, the client
  sees "Your installer can view your cameras" and gets their own switch to
  allow or block installer viewing.
- **The installer decides, client by client, who gets the switch at all.**
  It is not a platform-wide setting and not the client's to request.

**What a blocked installer keeps** (Austin: "the installer still needs all
the drives and information just no video feed"): health, drives, cameras
online, recording status, settings, updates, and alerts about the box.
**What they lose:** live view and recorded footage. By extension — Austin
did not say this explicitly, and it needs confirming before it is built —
event crops and snapshots would also count as video, since they are
pictures of the footage; see §9.

**The appliance's own audit log keeps recording installer access
internally either way.** Blocking video from the installer's *view* is not
the same as the box stopping its own record of who touched it — the audit
log described in `agent/auth.mjs` (`account_created`, `password_reset`,
`login`, etc.) and the `/audit` route stay as they are; B1 adds a parallel,
cloud-side "who viewed what" log for remote access, per BUILD-PLAN's own B1
line.

## 4. Licensing

**Who bills whom** (`camera-licensing-channel`, quoting Austin verbatim):
"installers will typically pay and they make money off the licensing as
well," and "me as a manufacture and software dev does not want to deal
with the customers and collections we only need the money from the
installers unless its our own private customers then that will be
different."

Decided:

- **Austin's company sells NVRs and licensing to installers, and collects
  only from installers.** The platform never bills, chases, or collects
  from an installer's end customers.
- **Each installer resells to their own customers at their own price**,
  keeps the margin, and owns that billing relationship entirely.
- **Exception: Austin's company's own private customers** — the ones
  where his company is itself the installer — are billed directly. The
  detail of how is not yet specified (§9).

**What a lapsed licence does** (Austin, quoted in full because the wording
is exact): "when a license turns off we will not have anything on the
cloud and also no updates the camera and the nvr onsite facility will keep
working but nothing going to the cloud will work."

So a lapsed licence switches off:

- every cloud feature — remote access, the cloud dashboard, anything
  relayed off-site
- all software updates, including security fixes

And it must never touch:

- recording
- local viewing (on the site's own LAN)
- the on-box AI (detection, alerts evaluation on the box itself)

This matches `camera-tiers-and-licensing`'s design rule, stated before the
09-22 decisions and still the right rule: "a lapsed licence must never stop
recording or local viewing — it gates cloud/fleet features only. Holding a
customer's footage hostage is both wrong and a support nightmare at 180
sites."

**Confirm before building** (flagged in `camera-licensing-channel` itself):
push alerts leave the site, so by this rule they read as a cloud feature
that a lapse would stop — not yet confirmed as a deliberate choice. See §9
for that and the other licensing items still open.

## 5. Opt-in alerts, and where they fit

`AI-PLAN.md`'s D3 and `HEALTH-ALERTS-DESIGN.md`'s "where alerts go" both
named the cloud as the missing piece for getting an alert off the box.
Austin's 2026-09-22 decision (`camera-alert-channel-decided`) answers it:

- **Push notifications to phones**, opt-in, for customers and their
  managers. Austin does not want alerts for himself.
- **Nothing is sent unless a user opts in on their own device.** Each
  user's cameras, hours and triggers are theirs; `contracts/alertRules.ts`
  already models cameras, a schedule by weekday, holidays, zones, minimum
  confidence and cooldown — seed the structure, never the values.
- **Defaults offered to an opting-in user:** people only, snapshot
  included.
- **Proposed transport (not built):** standard Web Push from the NVR's own
  page — service worker plus VAPID, payload encrypted end to end, relayed
  by the browser vendor's push service — which needs the page on HTTPS.
- **Wording stays a finding**, never a verdict — "Person, 0.82, camera 1,
  2:04 AM," matching build rule 11. Suppressed known-object events never
  alert.

**How this relates to B1/B2:** the push notification itself can leave the
site directly (it does not route through B1's console). What needs B1/B2
is **opening the notification's picture or page from outside the site** —
that is remote access, which is exactly what B1 (accounts, scope) and B2
(relay) exist to provide. On the bench today, Tailscale covers that gap;
it is not a shipped answer.

## 6. How an NVR talks to the cloud

**Outbound only.** No inbound ports on the appliance, matching the design
already chosen for local viewers vs. remote ones in `contracts/bandwidth.ts`
(the existing `local | direct | relay` split), and matching what OpenEye's
own documentation describes for the same problem (`openeye-web-connect`
bus note): peer-to-peer first over outbound UDP via STUN, relay as the
fallback, metadata to the vendor's servers either way. That note's design
lesson stands for B2 as well as B1: **show which transport a session got;
never hide it.**

**Identity is a separate concern from the code-signing trust anchor
already built**, and the two should not be conflated:

- The trust anchor (`/etc/camplat/trusted-keys.json`, placed by
  `setup/trust-anchor.sh`, checked by `agent/verify-release.mjs`) answers
  "is this *update* genuinely ours." It is Ed25519, lives outside the
  release payload on purpose, and that invariant is already load-bearing —
  `docs/handoff-signed-updates.md` has a check proving a forged release
  cannot smuggle in its own trust anchor.
- B1 needs a second identity: "is this *box* genuinely one of ours, and
  which installer/organization/site does it belong to." `BUILD-PLAN.md`
  calls this "IoT fleet provisioning, claim cert in the image" — a
  certificate baked in at build time, so enrolment needs no keys typed by
  hand. This is the box proving itself to the cloud, not code proving
  itself to the box; it is a new piece, not a reuse of the signing key.

**What goes up, in the steady state, is telemetry — not video.** The box
already measures and writes almost everything B1 needs, just locally:
`agent/healthfacts.mjs` gathers per-camera `lastSealedUtc`, segment counts
and bytes, per-store mount/free/total, `recorderRunning`, and retention
figures into `health.json` every 30 seconds; `camctl alerts` (per
`HEALTH-ALERTS-DESIGN.md`) evaluates that into `alerts.json` every 60. B1's
telemetry is this same shape, sent to the cloud instead of (or as well as)
sat on the box waiting to be read locally — `HEALTH-ALERTS-DESIGN.md`
already named "pushed to the cloud side" as option 2 for where alerts go,
explicit that it "needs the cloud, which is not in this plan" at the time
it was written.

**Video never leaves the site as part of telemetry.** It leaves only when
a person asks for it:

- a live view or playback session from off-site (B2, relayed)
- an export, handed to whoever asked for it
- an alert's snapshot, delivered to a user who opted in — a single
  picture, not a stream

Everything else — the recordings themselves — stays on the box, for
exactly as long as its own retention settings say, licence or no licence.

**Updates ride the same outbound channel, licence-gated.** The box already
decides for itself whether to trust what arrives (`verify-release.mjs`
runs the *installed* verifier against a trust anchor the release cannot
bring with it — an invariant `docs/handoff-signed-updates.md` calls out by
name: "untrusted code must not decide whether to trust itself"). B1 adds
the cloud as the notifier and distributor of new releases; it does not
change how the box decides to install one. A lapsed licence stops the box
from being offered — or fetching — updates at all, per §4.

## 7. Phases, smallest useful first

`BUILD-PLAN.md` already scopes B1 at 3–4 weeks and B2 at 2–3, with B1's
exit bar: "an appliance enrols from a factory image with no keys typed,
appears in the console, and can be diagnosed from 200 miles away without
SSH." Given how much more the tenancy and licensing model now specifies,
B1 splits into three slices, smallest first — each one shippable and
useful before the next starts:

1. **Box identity and telemetry.** Enrolment (claim cert, no typed keys),
   health/alerts telemetry uploaded, a bare fleet list. No tenancy model
   yet — one flat list of boxes is enough to hit BUILD-PLAN's own B1 exit
   bar on its own.
2. **Tenancy and role scoping.** Installer accounts, customer
   organizations, groups, sites, and the five roles from §2, each scoped
   as described there. The cloud-side audit log of who viewed what
   (telemetry only — no video yet, since B2 is not built) belongs here,
   since "who viewed what" needs the accounts this slice creates.
3. **Licensing and the privacy switch.** The entitlement check described
   in §4 (billing itself — how an installer is actually charged — is a
   separate, smaller piece, out of scope for this spec), the lapsed-licence
   gate on cloud features and updates, and the per-client privacy toggle
   from §3, enforced wherever the tenancy layer decides who may ask for
   what.

**Then B2**, exactly as `BUILD-PLAN.md` already scopes it: relay and
remote live, which only makes sense once B1 exists to say who is allowed
to ask.

**Alerts (D3) can build in parallel with B1**, not after it — the push
notification itself does not need the cloud control plane, only a public
HTTPS endpoint for the NVR's own page. It converges with B1/B2 only at the
"open the picture from off-site" step in §5.

## 8. What the box has today, and what changes

| | Today (on the box) | Target (B1) |
|---|---|---|
| **Roles** | Two: `installer` (everything, `contracts/access.ts`) and `store` (daily use, no destructive settings). Plus a device-only `display` credential for wall TVs. | Five human roles (§2), each scoped to a level of the tenancy tree, not just "this box." `installer tech` is closest to today's `installer`, but scoped to one installer's customers rather than global; `store manager` is closest to today's `store`, made explicitly site-scoped. `head office`, `regional manager`, and `homeowner` (as a distinct name, if not a distinct permission set) do not exist today. |
| **Tenancy** | None. `accounts.json` (`agent/auth.mjs`) is a flat table of usernames and roles, scoped to that one box only — no concept of "installer," "organization," or "group." | The whole tree in §1, sitting above the box. B1 does not replace on-box accounts; it adds a cloud layer that has to map onto them somehow — exactly how (same login reused, or a separate cloud-held credential the cloud uses to reach the box) is open, see §9. |
| **Privacy switch** | Does not exist. An `installer` account can always do everything `account.manage`-adjacent; nothing in `auth.mjs` or `access.ts` distinguishes "blocked by this client" from ordinary access. | The per-client toggle in §3, and video routes on the box would need to start checking it. |
| **Licensing** | Does not exist, on the box or anywhere else. Nothing gates a feature on payment status. | The entitlement check in §4. |
| **Telemetry off-site** | None. `health.json` and `alerts.json` are written and read locally only. `HEALTH-ALERTS-DESIGN.md` names this gap directly: "the box is loopback-only, reached over an SSH tunnel... an alert that only lives on the box is seen only when someone looks." | Uploaded to the cloud per §6, on the identity from enrolment. |
| **Device identity** | Only the code-signing trust anchor (`trusted-keys.json`), which authenticates *updates*, not the *box*. | Adds a separate enrolment identity (claim cert) that authenticates the box to the cloud. |

## 9. Open decisions

Nothing below is decided. Each came up while reading the sources and
belongs here, not stated as settled anywhere above.

- **Per-camera vs. per-box licensing.** Named open in both
  `camera-licensing-channel` and `camera-tiers-and-licensing`; it also
  interacts with the NVR tiers already planned (16 cameras today, 24+
  tiers coming per `camera-tiers-and-licensing`).
- **Reseller branding.** Whether an installer can put their own name or
  look on what their customers see. Not raised by Austin yet.
- **What the platform owner (Austin's company) can see across other
  installers' organizations.** Named open in both
  `camera-market-and-channels` and `camera-licensing-channel`. §2's
  "Platform staff" row is a placeholder, not a decision.
- **Austin's own private-customer billing.** Decided that it "will be
  different" from the installer-wholesale model; nothing about how.
- **Whether push alerts stop when a licence lapses.** They leave the
  site, so §4's rule would say yes, but `camera-licensing-channel` flags
  this explicitly as unconfirmed rather than assuming it.
- **Whether event crops/snapshots count as "video" for a blocked
  installer.** §3's read is "yes, by extension" (they are pictures of the
  footage), but `camera-market-and-channels` states this only as
  something to confirm when built, not a decision.
- **Whether groups (regions) can nest.** `camera-roles-decided`
  calls this out by name as undecided ("nestable or not: undecided").
- **How a cloud role maps onto an on-box account.** Same credential
  reused for both, or the cloud holds its own credential and acts on the
  box on the user's behalf. Not raised by Austin yet; flagged here because
  §8 depends on the answer.
- **What a homeowner can see and do.** §2 gives them the same set as a
  store manager, because both hold one site. That follows from
  `camera-roles-decided` (a homeowner is org scope of a one-site org) but
  Austin has not said it.
- **How billing itself is collected from installers** (invoicing,
  card-on-file, terms) — separate from the wholesale-vs-retail *policy* in
  §4, which is decided; the billing mechanics are not.
