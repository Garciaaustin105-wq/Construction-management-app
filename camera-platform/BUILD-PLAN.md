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

### C1 — desktop web client (3 weeks)
16-up grid on substreams, tap for main stream, timeline with gap reasons,
export with hash. Matches what people already know — §2.55, faithful parity.

### C2 — mobile app (4 weeks)
6-up paginated grid, swipe for more, tap to full quality, timeline, alerts.
**Stop the previous page's streams on swipe** or streams accumulate as someone
browses.

*Exit for both:* a manager uses it for a week without being taught, and prefers
it to nothing. Compared against OpenEye by someone who uses OpenEye daily.

---

## Phase D — detection (3–4 weeks)

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
