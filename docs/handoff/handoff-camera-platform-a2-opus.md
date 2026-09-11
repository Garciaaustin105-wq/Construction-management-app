# HANDOFF — camera-platform, and the A2 local API

**For: Claude Opus 5 running locally. Written 2026-09-11 by Claude Opus 5 (cloud session).**
**Branch: `claude/camera-service-plan-uwr6st` (NOT main). Stay on it.**
**Everything described here is committed and pushed as of `3e47b14`.**

---

## Read this first if you cannot find anything

The work is **not** in `src/`. It is a separate subsystem in **`camera-platform/`**
at the repo root, deliberately isolated from the Next.js app:

- its own `tsconfig.json` (NodeNext, `"types": []`)
- excluded from the root tsconfig and from eslint's dist
- no dependency on anything in `src/`, and nothing in `src/` imports it

If you ran `git log main` or searched `src/`, you found nothing because there is
nothing there. Check the branch:

```bash
git branch --show-current          # expect claude/camera-service-plan-uwr6st
git log --oneline -12
ls camera-platform/
```

If the branch is not there at all, **fetch first**. It was built in a cloud container
and pushed from there, so a local clone that had not fetched since has no trace of
it. `git log --all` searches only the refs you already have. (Measured 2026-09-10: a
local session found nothing until `git fetch` brought in
`origin/claude/camera-service-plan-uwr6st`.)

**The agent bus will be empty for you.** The cloud session that wrote this
registered on a bus that `.mcp.json` spawns *in-process* (`node
tools/agent-bus/server.mjs`), whose state lives in `.git/agent-bus/state.json` —
per-checkout, never committed. Three notes were posted there and are gone. They
are reproduced in full under "What was on the board" below. That is why this file
exists: build rule 24, facts the next agent needs go somewhere durable.

---

## What this subsystem is

An internal NVR/VMS replacing **OpenEye** across one customer's estate: 150+
sites, 16–30 cameras each, self-storage, now expanding to car washes. The company
does its own installs. The motive is margin — eliminating a $3.25/camera/month
dealer licence fee and capturing the NVR hardware.

**It is not a product to sell to other integrators.** One customer, one operator.

### The governing principle: faithful parity

The user's words: *"nothing wrong with the system"* and *"lets do what they do
because its a tested system."* OpenEye works. Copy its behaviour unless a change
is cheap and unambiguously better. **Do not improve things nobody asked to
improve.** Several earlier competitive claims in this project turned out to be
wrong precisely because they assumed OpenEye had a gap it did not have.

### Five decisions that will surprise you if you assume otherwise

1. **No footage in the cloud. None.** No clips, no keyframes, no synced
   detections. The cloud holds the control plane only. The user settled this
   explicitly: *"i dont really care to keep anything on the cloud."*
2. Local recording is the source of truth. Stream-copy (`-c copy`), **never
   transcode** — that is the difference between 16 cameras on one box and 4.
3. **Every automatic mechanism needs a manual override.** Spot.ai's auto-only
   camera connect is the named anti-pattern: *"any problems and we have no way to
   manually connect cameras."* Manual camera entry is a first-class path, not a
   fallback.
4. Hardware is fixed: ~$633 N100 6-bay, 2× 8TB SkyHawk, 16 cameras at 5MP/30fps.
   See `camera-platform/APPLIANCE-BOM.md`.
5. **A gap in recording is a first-class value with a reason, never an absence.**
   `SegmentTier` includes `"gap"` and carries a `GapReason`. `buildTimeline`
   always returns contiguous coverage.

---

## What exists (209 checks passing)

```bash
cd camera-platform
npx tsc -p tsconfig.json && node harness/run-all.mjs
```

That is the whole verification story. No jest, no vitest — plain `.mjs`
harnesses and an `_assert.mjs`. Run it before you touch anything, so you know the
baseline is green on your machine and not just in CI.

**On Windows**, "209 passing" held only on Linux until the commit after `a7c669e`.
One check, "the index is never placed on a recording drive", compared
`indexPathFor()`, which uses `path.join` and so returns backslashes on Windows,
against a hard-coded `/var/lib/camplat` prefix. That was a harness bug, not a
product bug. The appliance is Linux. The harness now compares against
`path.join(...)`. If you see that one check fail, do not "fix" `indexPathFor`
(build rule 22).

`camera-platform/` has no `package.json`. `npx tsc` only works because it walks
up to the root `node_modules`. In a fresh worktree with no `node_modules`, it
fetches the unrelated `tsc` package from npm instead. Run `npm ci` at the root
first, or call `<a checkout with node_modules>/node_modules/.bin/tsc` directly.
The code imports only Node built-ins. `node:sqlite` needs Node ≥ 22.5.

### `contracts/` — pure TypeScript, no I/O

`"types": []` is load-bearing: reaching for `URL`, `process` or `fetch` breaks the
build. That has already caught one real mistake. Do not add `"types"` to make an
error go away.

| File | What it owns |
|---|---|
| `time.ts` | UTC instants. `parseUtc` **throws** rather than returning NaN |
| `segment.ts` | `Segment`, `SegmentTier` (incl. `gap`), `buildTimeline`, `coverage`, `coalesceForDisplay` |
| `timeline.ts` | `buildReviewTimeline` — spans plus bucketed detections, each bucket carrying its own `coverage` so a *quiet* bucket and a *blind* bucket render differently. `pointsOfInterest` surfaces blind spots |
| `retention.ts` | `computeRetentionDays` — **refuses** if any camera is unmeasured |
| `camera.ts` | Identity is **MAC + serial, never IP**. `reconcile` returns `ipChanged` |
| `rtsp.ts` | `candidatePaths()` is the single source of truth; `buildRtspUrl` derives from it. Returns `{ url, redacted }` — credentials never reach a log |
| `cameraSource.ts` | Manual entry. `parseRtspUrl` is hand-written (no `URL` global) |
| `store.ts` / `eviction.ts` / `recovery.ts` | Ring buffer, eviction order, crash reconciliation |
| `net.ts` | CIDR; refuses sweeps wider than /16 |
| `ffprobe.ts` | Returns `bitrateKbps: null` when RTSP reports none — **the common case** |
| `budget.ts` | Per-camera bitrate ceiling; refuses to project with any unmeasured camera |
| `bandwidth.ts` | `allocateBandwidth`. Degrades uniformly rather than refusing; `pinned` degrades last; `transport: "local"` viewers are excluded from the uplink budget. `MOBILE_TILES_PER_PAGE = 6`, `DESKTOP_TILES = 16` |
| `uploadPolicy.ts` | Event filtering. Car-wash daytime vehicles are `index_only`; alarms bypass everything |

### `agent/` — plain `.mjs`, node builtins only

| File | What it owns |
|---|---|
| `recorder-service.mjs` | **The daemon (A1, the last thing finished).** `start()`, `loadConfig()`, `runRecovery()`, `resolveCameraUrl()`. Recovery runs *before* any recorder starts |
| `recorder.mjs` | ffmpeg supervision. `ffmpegArgs()`, `detectionArgs()` (VAAPI), `createCameraRecorder()` |
| `segindex.mjs` | `openIndex(file)` over `node:sqlite` (built into Node 22 — no dependency) |
| `segstore.mjs` | Segment files. `.inprogress/` makes the open segment structurally obvious |
| `config.mjs` | `DEFAULT_PATHS` (index on NVMe, **not** on a recording drive), `assignCamerasToDrives`, `XFS_MOUNT_OPTIONS` |
| `camctl.mjs` | CLI: `preflight`, `discover`, `probe`, `size`, `budget`, `bench` |
| `sadp.mjs` / `wsdiscovery.mjs` / `sweep.mjs` | Discovery: Hikvision SADP (UDP 37020), WS-Discovery (UDP 3702), CIDR sweep |
| `evict.mjs` / `media.mjs` / `preflight.mjs` | Eviction runner, ffprobe wrapper, preflight checks |

### `openIndex()` — the API A2 will lean on

```js
import { openIndex } from "./agent/segindex.mjs";
const ix = openIndex(indexPathFor());

ix.put(segment)                                  // upsert; NULL round-trips as NULL
ix.putMany(segments)                             // one transaction — fsync is not free
ix.get(path)
ix.all()
ix.forCamera(cameraId)
ix.inRange(cameraId, startUtc, endUtc)           // <- the timeline query
ix.withState(state)
ix.oldestEvictable(limit)                        // bounded SQL, added after the scale test
ix.remove(path) / ix.removeMany(paths)
ix.totalBytes() / ix.count()
ix.addGap({ cameraId, startUtc, endUtc, reason })
ix.gapsFor(cameraId)
ix.close()
```

`bytes` and `bitrateKbps` are `null` when unknown and **must stay null** — build
rule 5, a blank is not a zero. A `?? 0` or `?? 2000` anywhere near these is a bug;
that exact mistake was committed once already, in scaffolding written to prove the
contracts prevent it.

---

## Your task: A2 — the local HTTP/WS API (1–2 weeks)

From `camera-platform/BUILD-PLAN.md`:

> The interface every client will use, served from the appliance: cameras,
> timeline query, segment playback (HTTP range over fMP4), live stream
> negotiation, health, config.
>
> *Exit:* `curl` can list cameras, fetch a timeline for any window, and play back
> a segment from three days ago.

### Order of work — build rule 1, and it is not negotiable

**Contract in `contracts/` (pure), then a harness, then the transport.** The
request/response shapes, the range-math, the window validation and the
stream-negotiation decision are all pure functions. They belong in `contracts/`
with a harness that runs with no socket open. Only then does an HTTP server get
written around them.

Build rule 2 exists because of this: split I/O from maths, or the harness cannot
run standalone.

### Things that are already decided, so you do not redecide them

- **Segments are fragmented MP4** (`+frag_keyframe+empty_moov`). This is why
  range playback works at all — a truncated *plain* MP4 is unplayable in full.
- **Relay-by-default**, the OpenEye model, so viewer count does not multiply
  uplink. `bandwidth.ts` already models this; `transport: "local"` is excluded
  from the uplink budget. A client on the LAN must be able to take the direct
  path.
- **GOP asymmetry:** main stream at 2× fps (storage), substream ~1s (startup
  latency). Live tiles pull the substream; that is how OpenEye gets instant
  grids. The user confirmed the behaviour to match: *"when i open the app... it
  does give me live feed instantly for all cameras"*, 6 tiles on mobile with
  swipe, all of them on desktop.
- **Timeline search is a separate, single-viewer function** in OpenEye, not the
  live grid. Match that.
- Credentials never reach a log. `buildRtspUrl` gives you `redacted` — use it.

### The failure to test, not the happy path (build rule 19)

At minimum: a range request that straddles a **gap**; a window with no coverage
at all (must return coverage-with-a-reason, not an empty 200); a segment whose
`bytes` is `null`; a request for a window partly in the future; a client asking
for more tiles than the uplink can carry (it degrades, it does not refuse).

---

## What was on the board (reproduced — the bus state is gone)

**`camera-platform-exists`** — A new subsystem lives in `camera-platform/` — an
internal NVR replacing OpenEye across a customer's 150+ sites (self-storage, now
car washes first). NOT part of the Next.js app: own tsconfig (NodeNext,
`"types": []` to prove purity), own harnesses, excluded from the root tsconfig and
from eslint's dist. 209 checks: `cd camera-platform && npx tsc -p tsconfig.json &&
node harness/run-all.mjs`. Contracts are pure in `contracts/`, all I/O in
`agent/`. Read `camera-platform/BUILD-PLAN.md` before adding anything.

**`camera-platform-decisions`** — Decisions that will surprise you if you assume
otherwise: (1) NO footage in the cloud — no clips, no keyframes, no synced
detections; the cloud holds only the control plane. (2) Governing principle is
FAITHFUL PARITY with OpenEye, whose system the customer says works fine — do what
they do unless it is cheap and unambiguously better. (3) Every automatic mechanism
needs a manual override; Spot.ai's auto-only camera connect is the anti-pattern.
(4) Hardware is fixed: ~$633 N100 6-bay, 2× 8TB SkyHawk, 16 cameras at 5MP/30fps.
(5) A gap in recording is a first-class value with a REASON, never an absence.

**`camera-platform-unmeasured`** — Every storage figure in camera-platform rests
on an ASSUMED 2.5 Mbps per camera. Nothing has touched a real camera yet.
`camera-platform/FIELD-NOTES.md` lists what is open: real bitrate, the AVYCON RTSP
path (vendor says it varies by model — use `camctl probe <ip> --vendor avycon
--try-all`), whether ONVIF ships enabled, SADP's multicast group, and whether
cameras sit on the NVR's built-in PoE ports (worth $60–120k across the estate). Do
not treat any disk-sizing number as fact until `camctl probe` has run on hardware.

> **Two numbers, not one (found on re-post, 2026-09-10).** The note above says
> storage rests on 2.5 Mbps. `FIELD-NOTES.md` #1 and the "Open" section below say
> **2 Mbps**, and the storage tables there use 2 Mbps. 2500 kbps is what
> `contracts/bandwidth.ts` (`main: 2500`) and `camctl bench` (disk-write
> requirement) assume. Both are assumptions and neither is measured. Do not pick
> one and do not average them (build rule 18). `camctl probe` on a real camera
> replaces both.

**Re-post these on your bus**, since yours is the real one:

```powershell
node tools/agent-bus/server.mjs register opus-camera "camera-platform: appliance software"
node tools/agent-bus/server.mjs board
```

---

## Open, and not yours to guess at

`camera-platform/FIELD-NOTES.md` is the live record. Nothing is in the Measured
column. The one that matters is **#1, the real per-camera bitrate** — every
storage, retention and AWS figure written to date assumes 2 Mbps, which is
Hikvision's recommended *average* for 4MP H.265+ and therefore the best case.
Storage-corridor scenes with smart codecs commonly run half to a quarter of that.
If the real number is nearer 1 Mbps, the 16 TB in the plan is closer to 8 — across
150 appliances that is a different hardware order.

**Flagged as must-be-built-with-hardware-present**, so do not write it blind:
IP assignment from the appliance (SADP set-IP / ONVIF `SetNetworkInterfaces`).

Constraints that are settled and stay settled:

- Cameras sit on an isolated segment behind the appliance, **no route to the
  internet** (dual NIC).
- Never certify or sell NDAA Section 889 covered cameras (Hikvision, Dahua,
  Huawei, Hytera, ZTE) or their OEM rebadges. The existing estate is Hikvision —
  that is the thing being replaced, and CVE-2017-7921 is on CISA KEV.
- No face recognition (BIPA, $1,000–5,000 per violation). Audio off by default and
  geo-gated — Florida is an all-party-consent state. Plates are never
  auto-matched to a tenant.

---

## Background reading, in order

1. `camera-platform/BUILD-PLAN.md` — phases A–D, and the standing rule that every
   automatic mechanism has a manual override
2. `camera-platform/FIELD-NOTES.md` — what is assumed vs measured
3. `docs/camera-service-plan-2026-09-10.md` — the plan. §2.55 is the parity
   principle, §2.5a is the no-cloud-footage decision, §2.6 is the parity check
   against OpenEye's actual behaviour
4. `docs/camera-aws-cost-and-onboarding.md` — **~$244/month for 150 stores**, ~80%
   of it fixed platform cost. Earlier figures of $744–865 were withdrawn; they
   costed an architecture the user never described. Do not reintroduce them.
5. `camera-platform/APPLIANCE-BOM.md`, `camera-platform/AVYCON-MODELS.md`
6. `docs/build-rules.md` — all 31, with the incident behind each

Build rule 4 applies to you before you write anything: **re-read the state of the
world immediately before writing code, not when you were handed the spec.** Four
failures in this project came from that gap. This document is already stale in
whatever way the last commit made it stale.
