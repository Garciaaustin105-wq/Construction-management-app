# Software build plan

Where the code is, what is left, and the order that gets to something usable
soonest. Every phase exits on a demonstrable result, not on "the code is written".

**Done: 189 checks passing.** The pure contracts and the appliance's moving parts
are built and tested. What is missing is everything that turns them into a
running system.

---

## What exists now

| | |
|---|---|
| **Contracts** (pure, no I/O) | time · segment · retention · camera · rtsp · store · eviction · recovery · net · ffprobe · budget · bandwidth · timeline · uploadPolicy |
| **Agent** (I/O) | `camctl` · segindex (SQLite) · segstore · recorder · evict · media · discovery (SADP/ONVIF/sweep) · preflight · config |
| **Setup** | `install.sh` · build guide |
| **Proven** | 691,200 segments: 115 MB, 4.4 ms timeline queries, 2 ms bounded eviction |

Nothing here talks to a camera yet, and nothing serves a client.

---

## A standing rule, learned from a competitor

**Every automatic mechanism must have a manual override, and the manual path is
never second-class.**

Two different products, and I had them confused. Setting it straight, because
the gap is only in one of them:

**OpenEye does this well.** Manual entry by device IP, *and* — the part that
matters on an install day — **it can change a camera's IP from the NVR**. Sixteen
cameras out of the box all answering on the same factory default is a real
problem, and the alternative is plugging them in one at a time, opening each web
interface, and setting an address by hand. Doing it from the recorder is the
difference between an afternoon and ten minutes.

**Spot.ai is the one that auto-connects with no useful manual route.** When
discovery fails there, the installer is stuck at a site with a working camera.

So we need both capabilities, and neither is optional:

| Level | Input | Catches |
|---|---|---|
| 1 | Nothing — sweep, SADP, WS-Discovery | The normal case |
| 2 | **An IP** — we walk `candidatePaths()` | Camera outside the swept range, or silent to discovery |
| 3 | **A full RTSP URL**, used verbatim | Non-standard port, unknown path, a model nobody has seen |

**Plus IP assignment from the appliance** — SADP can set a Hikvision camera's
address without touching its web interface, and ONVIF's `SetNetworkInterfaces`
does the same for anything compliant. Both are how the tools that do this
already work.

> **Build this one with hardware in front of you.** Assigning an address wrongly
> puts a camera on a subnet nothing can reach, and recovery is a physical reset
> button on a pole. It is the one piece of the discovery stack that should not be
> written blind and tested later.

The same rule applies everywhere else it comes up: auto-assigned camera names,
auto-detected bitrates, auto-selected substreams. **Automatic by default,
manual always available.**

## Phase A — the appliance stands alone (4–5 weeks)

**The goal: a box you could install at one car wash today and the staff on site
could use it.** No cloud, no relay, no accounts. LAN only.

This is deliberately first. It is the shortest path to something real, it proves
every assumption in `FIELD-NOTES.md`, and it de-risks everything after it.

### A1 — `recorder-service.mjs` (1 week)
The daemon the systemd unit already points at. Wires together what is built:
load config → recover from the index against disk → start a recorder per camera →
run the eviction loop on a timer → expose health.

*Exit:* 16 cameras record for 7 days unattended. Pull the power repeatedly; lose
only the outage seconds, with correct gaps and reasons.

### A2 — local HTTP/WS API (1–2 weeks)
The interface every client will use, served from the appliance:
cameras, timeline query, segment playback (HTTP range over fMP4), live stream
negotiation, health, config.

*Exit:* `curl` can list cameras, fetch a timeline for any window, and play back a
segment from three days ago.

### A3 — local web UI (2 weeks)
Served by the appliance. Live grid, timeline with gaps, playback, export.
Deliberately plain — it becomes the desktop client's core in Phase C.

*Exit:* someone who has never seen it finds a specific event from two days ago
without being told how.

> **Milestone: a working NVR.** Not sellable — no remote access — but genuinely
> usable on site, and every storage and camera assumption is now measured rather
> than assumed.

---

## Phase B — remote access (5–6 weeks)

### B1 — cloud control plane (3–4 weeks)
Device registry and enrolment (IoT fleet provisioning, claim cert in the image),
accounts and per-site scope (§2.5 — a store manager sees their store), health
telemetry, audit log of who viewed what.

*Exit:* an appliance enrols from a factory image with no keys typed, appears in
the console, and can be diagnosed from 200 miles away without SSH.

### B2 — relay and remote live (2–3 weeks)
The appliance holds an outbound connection; viewers reach it through the relay.
No port forwarding. `bandwidth.ts` governs allocation; local viewers bypass the
uplink budget entirely.

*Exit:* live view of any camera from off-site, on a connection with no inbound
ports open. Three concurrent viewers degrade gracefully rather than failing.

> **Milestone: feature parity with OpenEye's core.** Remote live, remote
> playback, multi-site. This is the point where a site could migrate.

---

## Phase C — the clients (6–7 weeks)

The product is three programs:

| Program | Runs on | Built in |
|---|---|---|
| **The recorder** | The NVR box, on Linux. That program is what the Linux system is for. | Phases A and B |
| **Desktop app** | Windows and Mac | C1 |
| **Mobile app** | iPhone and Android | C2 |

**Both apps use the recorder's own API** (A2): directly on the LAN, through the
relay (B2) off-site. No app gets a private route. A feature an app needs goes
into the API first and is harness-tested there, so the web UI, the desktop app
and the phones cannot disagree about what was recorded. The decisions the web UI
makes (timeline layout, what a click means, gap wording, what an export will
contain) live in pure modules such as `agent/ui/review-client.mjs`, for the apps
to reuse rather than re-derive.

**H.265 does not play everywhere.** The cameras record it. iPhones and Macs
decode it in hardware; most recent Android phones do, but older and cheap ones
may not; a Windows PC needs hardware decode or Microsoft's HEVC extension. Every
client detects this and says so, as the review page already does. A black tile
is never the answer.

> The estimates below were set when C1 was a web client. Re-estimate C1 once the
> desktop app's shell is chosen.

### C1 — desktop app, Windows and Mac (3 weeks)
An installed application, not a browser tab, grown out of the A3 web UI. 16-up
grid on substreams, tap for main stream, timeline with gap reasons, export with
hash. Matches what people already know — §2.55, faithful parity.

- **One codebase for both.** Still to decide before C1 starts: a native build
  per platform, or one web-view shell around the A3 UI.
- **Signed installers.** Unsigned, Windows warns on first launch and macOS
  refuses. Signing needs an Apple Developer account and a Windows code-signing
  certificate, and both cost money.
- **Several sites** in one app, each scoped as B1 allows.

*Exit:* installed from a download onto a clean Windows PC and a clean Mac, it
finds a site's recorder, shows live, plays yesterday, and exports a range.

### C2 — mobile app, iPhone and Android (4 weeks)
6-up paginated grid, swipe for more, tap to full quality, timeline, alerts.
**Stop the previous page's streams on swipe** or streams accumulate as someone
browses. Both stores review the app before release; allow for that in the date.

*Exit for both:* a manager uses it for a week without being taught, and prefers
it to nothing. Compared against OpenEye by someone who uses OpenEye daily.

---

## Phase D — detection (3–4 weeks)

**Superseded by AI-PLAN.md (2026-09-16), which adds plate search and
plain-English search.**

Hailo pipeline on the substream, perimeter and gate cameras only. Person,
vehicle, plate. `uploadPolicy.ts` decides what becomes a timeline marker.

Deliberately last: the timeline works with zero detections, and every phase
before this is more valuable. But it is what the car washes actually want —
after-hours person alerts and gate LPR.

**Avoid Ultralytics YOLO (AGPL).** Use YOLOX, MobileNet-SSD, or Hailo's model
zoo, which ships permissively licensed and pre-compiled for their silicon.

*Exit:* false-alert rate low enough that we keep notifications on for a week.

---

## Sequencing notes

**The recorder on Linux comes first, and gets finished before the apps start.**
Decided by Austin, 2026-09-14. Phases A and B, the program on the NVR box,
are built and proven on Linux before any work on C1 or C2. Development and
bench tests run on Windows, but that proves nothing about the box: an item
is only done once it passes on the Linux build.

**Roughly 5 months to Phase C.** A is the one that must not be rushed — every
number in this project is an assumption until A1 runs against real cameras.

**Phase A can start before hardware arrives.** The recorder integration suite
already runs the whole loop against a fake producer.

**D is independent.** It can slip without blocking anything, and it needs the
Hailo, which is the one part not yet bought.

**What would change this order:** a bid landing sooner than expected. If a car
wash is scheduled before Phase B is done, install ours alongside the OpenEye
system on LAN-only Phase A — the customer gets what they paid for, we get a
proving ground, and remote access follows when it is ready.
