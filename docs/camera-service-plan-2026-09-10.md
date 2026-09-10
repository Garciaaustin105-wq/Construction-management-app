# Storage-Facility Camera Service — Architecture and Build Plan

> **Status:** plan, not a spec. Nothing has been built. Written 2026-09-10.
>
> **v2 — retargeted.** v1 aimed this at construction sites with crew/job linkage
> and AI as a headline feature. The human corrected both: **the customers are
> self-storage facilities**, and AI is not a priority. Crew tracking, job linkage,
> PPE detection and the Terra Vista integration are **cut entirely**. The
> economics in §2 survived the pivot unchanged; almost nothing else did.

---

## 1. What this is

You sell and install camera systems for **self-storage facilities**, to customers
you already serve. That last clause is the whole business, and §3 argues it is
worth more than any technology in this document.

| Decision | Answer |
|---|---|
| Customer | Self-storage operators, mostly existing accounts |
| Cameras | BYO ONVIF/RTSP — no proprietary hardware |
| Recording | Local appliance on site, cloud holds index + incident clips |
| Connectivity | **Wired broadband** (fixed commercial sites), LTE as failover |
| AI | Narrow and cheap only — see §7. No semantic search, no PPE, no faces |
| Cut from v1 | Crew tracking, job/visit linkage, PPE, construction phasing, LTE-first |

---

## 2. The number that decides the architecture

A 4MP camera at 2 Mbps H.265 produces **21.6 GB/day — 648 GB/month**.

| Recording model | Raw AWS cost / camera / month |
|---|---|
| Continuous → Kinesis Video Streams | ~$20.41 |
| Continuous → S3 direct | ~$10–12 |
| **Edge-first: record local, upload incidents + keyframes** | **~$0.80–1.60** |

Now multiply by a storage facility's real camera count (§4): **40 cameras
continuously cloud-recorded is $400–800/month of AWS alone.** No storage operator
pays that. Edge-first is not an optimisation here, it is the only design that
exists.

> **Caveat on the S3 row.** S3 Infrequent Access bills a 30-day minimum storage
> duration and a 128 KB minimum object size. Transition at day 7, delete at day
> 30, and you pay for 30 days on data you held 23. Model it properly before
> quoting any continuous-cloud tier. The conclusion does not change; the number
> does.

**A bigger lever than anything cloud-side:** storage corridors are static scenes.
Cameras with smart codecs (Axis Zipstream, Hanwha WiseStream, most vendors' dynamic
GOP) drop a motionless corridor to **0.5–1 Mbps average**. That halves or
quarters every storage figure in this document. **Specify smart-codec cameras and
tune the GOP before you optimise a single line of cloud code.**

---

## 3. The honest strategic advice, before the build plan

You are not primarily short of technology. You are short of nothing at all on the
hard part — **you already have the customers**, which is the thing that kills
almost every entrant in this category.

That creates two genuinely different businesses:

| | **A — Be the integrator** | **B — Build the platform** |
|---|---|---|
| What you do | Resell OpenEye / Eagle Eye / Rhombus, install it, service it | Everything in §5–§9 |
| Time to first revenue | **Weeks** | 6–12 months |
| Engineering | None | A team |
| One-time margin | 30–40% on a $10–24k install | Same |
| Recurring | 20–40% share of ~$300/site/mo | **~90%** of it |
| Biggest risk | You never own the recurring revenue | You spend a year and learn storage operators wanted something else |

**Recommendation: do A now, and let it fund and specify B.** Not as a hedge — as
the cheapest possible way to buy the information B needs. Ten installs teaches you
what a storage operator actually calls support about, what the install labour
really costs, which cameras fail in a Florida summer, and whether the recurring
line is worth owning. Every one of those sites is a future migration target for
your own platform. And the money arrives while you learn.

If you want to start building B in parallel anyway, the rest of this document is
that plan. **Phase 0 in §10 is designed to be run on your first A install**, so
the two paths share their first month of work rather than competing.

---

## 4. What a storage facility actually looks like

This is where the v1 plan was most wrong. It assumed 8 cameras on an LTE trailer.

| Reality | Consequence |
|---|---|
| **20–70 cameras per site** — one indoor climate-controlled facility runs 60–70 | Appliance sizing, storage media and detector budget all change |
| Gate, perimeter, drive aisles, corridors, elevators, office | Most cameras are static interior corridor views |
| **Fixed commercial site with power and wired internet** | Drop LTE-first. LTE becomes failover — cutting the internet is a burglar's move |
| **LPR at the gate is table stakes**, not a luxury | It is the highest-value analytic in this vertical (§7) |
| Increasingly **unmanned / remotely managed** | Video is the only presence on site. Talk-down speakers are a real product |
| **The NVR itself gets stolen during break-ins** | See below — this is a design requirement, not a footnote |

### 4.1 The appliance is a theft target

The industry's own guidance is blunt: on-site theft of the recorder during a
break-in is the primary risk, which is what makes cloud backup worth paying for.

Three requirements fall straight out of that:

1. **Incident clips upload immediately** — priority interrupt, not a batch window.
   Footage of the break-in must leave the building before the recorder does.
2. The appliance lives in a **locked, alarmed space**, and its own tamper/power
   loss is itself an alert published to the cloud.
3. **Cloud is not a backup of everything.** It is a backup of the moments that
   matter, uploaded fast. That is exactly the edge-first design in §2, arrived at
   from the security side instead of the cost side.

### 4.2 Storage sizing, restated for real camera counts

| Cameras | Bitrate | 30-day storage | Media |
|---|---|---|---|
| 24 | 2 Mbps | 15.5 TB | 2× 10 TB surveillance HDD |
| 40 | 2 Mbps | **26 TB** | 2× 16 TB, or 4× 8 TB |
| 40 | 1 Mbps (smart codec) | **13 TB** | 2× 8 TB |
| 60 | 2 Mbps | 39 TB | 4× 12 TB |

**Use surveillance-rated HDDs (WD Purple, Seagate SkyHawk), not NVMe.** v1 said
NVMe; at 26 TB that is a ~$1,500 mistake against ~$600 of spinning disk. Sustained
write for 40 cameras is only ~10 MB/s — trivial for HDD. Keep a small NVMe for
the OS, the segment index and the hot ring buffer only.

**Retention is a computed number, never a marketing one.** `retentionDays =
usableBytes / (Σ cameraBitrate × 86400)`. It is a pure function with a harness
(§8), it is shown per site in the UI, and it carries its units — a "30-day"
promise that silently assumed 1 Mbps is the kind of error that looks fine until a
customer needs day 22.

---

## 5. The appliance

### 5.1 Hardware, by site size

| Site | Compute | Detector | Storage | ~Cost |
|---|---|---|---|---|
| ≤24 cams | Intel N100/N150, 16 GB | Hailo-8L (13 TOPS) | 2-bay, 2× 10 TB | ~$900 |
| 25–70 cams | Core i3/i5 or Ryzen, 32 GB | Hailo-8 (26 TOPS) | 4-bay, 4× 12 TB | ~$1,800–2,400 |

Plus an LTE failover modem (~$150) and a UPS. Against a $15–24k installed system,
the appliance is not where the customer feels the cost.

**Why not one big box for everything:** 40 concurrent ffmpeg stream-copies is
mostly RAM and I/O, which is cheap — but 40 concurrent *detection* streams is not.
Which leads to the single most useful sizing decision in this vertical:

> **You do not need object detection on 40 interior corridor cameras.** Run the
> detector on the perimeter, the gate and the entry doors — 10–15 streams — plus
> interior cameras only during closed hours. That fits one Hailo-8 comfortably and
> cuts the compute budget by two thirds. Motion-only recording triggers still run
> on everything, because motion is nearly free.

### 5.2 Software — build vs adopt

| Layer | Adopt | Build |
|---|---|---|
| RTSP/ONVIF ingest, restream, WebRTC | **go2rtc** (MIT) | — |
| Segmenting | **ffmpeg** `-c copy` | segment naming, index, ring-buffer eviction |
| Object detection | **Frigate** (MIT) as v1 detector | — (caveat below) |
| LPR | Frigate 0.16+ has it, or a dedicated ALPR engine | plate → tenant matching |
| Fleet OTA + identity | **AWS IoT Greengrass v2** + fleet provisioning | component packaging |
| Uplink agent | — | **This is the piece you own** |

**Never transcode.** Stream-copy H.264/H.265 to fMP4. Only the low-res substream
(640×360, ~5 fps) is decoded, and only for cameras that have a detector assigned.

**Frigate caveat:** the code is MIT — commercial use and redistribution are fine —
but the *name, brand and logo* are trademarks of Frigate, Inc. and explicitly not
licensed. You may not use "Frigate" in the name of a commercial product. Use it,
rebrand completely, attribute in your notices, and keep the cloud contract
detector-agnostic so you can swap in a GStreamer + Hailo pipeline later.
**Hard-disable its face recognition** (§9); keep its LPR.

**The uplink agent (Go or Rust) is the actual product:**

1. Enrol via fleet provisioning claim cert → per-device X.509.
2. Device shadow: camera list, retention, schedules, zones, alert rules.
3. Maintain the local segment index, publish deltas.
4. **Priority upload queue.** Incident clips pre-empt everything (§4.1); then
   keyframes, then requested retrievals, then backfill. Store-and-forward across
   outages, resumable multipart.
5. On-demand retrieval: cloud asks for `camera 12, 03:14:00–03:16:30`, agent cuts
   it from the ring buffer and uploads.
6. Health telemetry: per-camera up/down, disk free, **computed retention days**,
   uplink state, tamper/power events.

### 5.3 OS and updates

Debian 13 minimal + systemd + podman. **Add A/B image updates (RAUC or Mender)
before the fleet passes ~50 units.** You cannot drive to a facility because an
`apt upgrade` bricked a recorder, and a bad update that stops recording across
every customer simultaneously is an extinction event for a security vendor.

---

## 6. The AWS cloud

Amazon Web Services throughout — nothing here is on another provider.

| Need | Service | Why, and what was rejected |
|---|---|---|
| Device identity, shadows, OTA | **IoT Core + Greengrass v2** | Fleet provisioning issues per-device X.509 on first connect; TPM 2.0 supported. *Rejected:* AWS Panorama — **end of support 31 May 2026**. Greengrass v1 ends 7 Oct 2026; v2 only. |
| Incident clips, keyframes, exports | **S3** + lifecycle | Ingress free. Keep 30-day incident retention in Standard; tier only what you keep 90+ days. |
| Evidence holds | **S3 Object Lock** + SHA-256 per object | Storage disputes end in lien auctions, insurance claims and prosecutions. Chain of custody is a product requirement here, not a nicety. |
| Live view signalling + TURN | **KVS WebRTC** ($0.03/signalling channel/month + messages + TURN minutes) | Managed signalling and STUN/TURN. *Rejected for v1:* self-hosted coturn + SFU. |
| Playback delivery | **CloudFront** + signed URLs | Cheaper egress, and time-boxed per-clip access. |
| Event bus | IoT Rules → **EventBridge** → Lambda | Events are small JSON. Keep them off the media path. |
| App DB + tenancy | **Aurora Serverless v2 (Postgres)** | *Considered:* Supabase — you have already debugged multi-tenant RLS once, worth real weeks. Revisit if speed to first site matters more than purity. |
| Notifications | SNS → push/SMS + email | After-hours alerts are the product. |

---

## 7. The AI you actually need

You said AI is the least of your worries. For this vertical you are mostly right,
and the exception matters — so here is the whole of it:

| Analytic | Verdict | Why |
|---|---|---|
| **Motion detection** | Ship | Nearly free, runs on every camera, drives recording triggers |
| **Person / vehicle, after hours** | Ship | The core alert. Perimeter and gate only |
| **LPR at the gate** | **Ship — this is table stakes** | Standard expectation in self-storage. Plate → tenant matching is a headline feature and legally far safer than faces |
| **Tailgating at the gate** | Phase 4 | Two vehicles, one code. A named industry problem |
| **Loitering / after-hours dwell** | Phase 4 | Cheap once person detection exists |
| Semantic "search footage by description" | **Cut** | Spot AI's headline. Expensive, and gate-event correlation (§8) answers the same questions better in this vertical |
| PPE / safety compliance | **Cut** | Construction feature. No storage operator asked |
| Face recognition | **Refuse** | §9 |

The pattern: **narrow, cheap, runs at the edge, on a handful of cameras.** No
Bedrock, no vector database, no per-frame embedding bill.

---

## 8. The wedge — gate events, not job records

v1's wedge was job/visit linkage. Cut. The replacement is the thing storage
operators genuinely cannot get cheaply:

**Every access event, joined to the video of that access.**

Self-storage runs on gate access control — keypad codes tied to tenants. The
established platforms are **PTI (StorLogix / StorLogix Cloud, the most widely
deployed)**, **Storable Access Control**, **Nokē**, **Sentinel**, **SpiderDoor**
and **OpenTech**; facility management runs on **SiteLink**, **storEDGE** (both
Storable) and **Yardi**. PTI now has a real-time cloud integration with Storable
Edge, so access changes propagate in seconds rather than on a sync schedule.

The product feature: *"Unit 214 was accessed at 15:04 by code 8871"* → one click →
the corridor camera covering unit 214 and the gate camera, at that timestamp,
side by side.

**Be clear-eyed that this integration is expected, not novel.** Nokē already
partners with Eagle Eye for video; PTI ships its own. You are not inventing the
category — you are doing it at a price a single-site operator can afford, with a
support relationship you already have. That is a good enough reason to exist. A
claim that this is a novel feature would not survive the first sales call.

**What it requires, and it is the real work:** a **camera → unit mapping**. Which
camera covers which unit numbers. It is a facility map, it is tedious to build at
install time, and once built it is the thing a competitor cannot copy out of your
customer's site. Treat it as a first-class data model and an install deliverable,
not a config file.

---

## 9. The data contracts — write these first

House rule A1: contract in a pure lib, then a harness, then the UI. No React, no
I/O, no browser globals; each must compile and be tested with no camera and no
database.

```ts
// Where a span of time physically lives. `gap` is a first-class value.
type SegmentTier = 'edge' | 's3' | 'glacier' | 'gap';

interface Segment {
  cameraId: string;
  startUtc: string;          // ISO 8601, always UTC
  endUtc: string;
  tier: SegmentTier;
  key: string | null;        // S3 key; null when 'edge' or 'gap'
  bytes: number | null;      // null when 'gap' — NOT 0
  codec: 'h264' | 'h265';
  bitrateKbps: number;       // carries its unit
  gapReason?: 'camera_offline' | 'appliance_offline' | 'disk_full'
            | 'evicted_by_retention' | 'tampered' | 'unknown';
}

interface AccessEvent {                 // from the gate/access system
  facilityId: string;
  atUtc: string;
  source: 'pti' | 'storable' | 'noke' | 'sentinel' | 'spiderdoor' | 'opentech';
  kind: 'gate_open' | 'gate_denied' | 'unit_door' | 'keypad_entry' | 'alarm';
  unitNumber: string | null;
  tenantRef: string | null;             // opaque ref, never PII in this table
  cameraIds: string[];                  // resolved from the unit→camera map
}

interface Detection {
  cameraId: string;
  atUtc: string;
  kind: 'motion' | 'person' | 'vehicle' | 'plate';
  confidence: number;                   // 0–1, always shown to the user
  plate?: { text: string; confidence: number };  // never auto-matched to a tenant
  clipSegment: Segment | null;          // null until uploaded
}
```

Four properties are load-bearing:

- **`gap` with a `gapReason`.** The timeline renders a hatched band saying
  *"camera offline 02:10–06:44"*. It never renders quiet grey a customer reads as
  "nothing happened". Build rule B1: a blank is not a zero. During a break-in
  investigation, "we don't know" and "nothing happened" are opposite answers.
- **`bytes: null` on a gap.** Not `0`. Outages must not sum as free footage.
- **`tampered` as an explicit gap reason.** §4.1.
- **`plate` is never auto-matched to a tenant.** A plate read is a measurement with
  a confidence; a human confirms the match. Build rule 11 — report measurements,
  do not render verdicts — and one wrong auto-match in an eviction dispute is a
  lawsuit.

`computeRetentionDays(cameras[], usableBytes)` is a pure function with a harness,
because it is the number on the quote and the number a customer sues over.

---

## 10. Legal gates (the refusals)

Cheaper to decide now than after the first claim. **Get counsel before the first
paying site;** these are the defaults until then.

| Gate | Default | Why |
|---|---|---|
| **Face recognition** | **Do not ship** | Illinois BIPA: informed written consent for facial geometry, $1,000–$5,000 per violation, $1.8bn in cumulative settlements. No storage operator needs it. Frigate's must be disabled. |
| **LPR** | **Ship, with a human in the loop** | A plate is not a biometric and this is a private gate reading vehicles on the customer's own property — a materially different legal posture from faces. Still: never auto-act on a read. |
| **Audio** | **Off, per-camera opt-in, geo-gated** | 11 states plus DC need all-party consent — including **Florida**. |
| **Signage and lease terms** | Signage kit + lease-addendum template, required at commissioning | Tenants must know. Make it an install step the technician cannot skip. |
| **NDAA / Section 889** | Support any ONVIF camera; **never sell or certify** Hikvision, Dahua, Huawei, Hytera, ZTE | No remediation path exists. Any customer touching public work or federal money needs a compliant list. Axis, Avigilon and Hanwha give written attestations. |
| **Footage requests** | Written policy: who can request, what is logged, what needs a subpoena | You will get police requests and tenant-dispute requests. Decide the process before the first one, not during it. |

---

## 11. Unit economics

Assumptions: 40 cameras, 2 Mbps H.265, 30-day local retention, incident clips and
keyframes to cloud (~15 GB/camera/month), us-east-1.

**Per camera per month:** S3 storage $0.30 · requests $0.05 · IoT $0.05 ·
WebRTC signalling/TURN $0.15 · CloudFront egress $0.43 · compute share $0.40 →
**~$1.38 AWS cost of goods.** Per 40-camera site: **~$55/month.**

**Per-camera pricing breaks down in this vertical**, and it is worth seeing why:

| Price/channel | 40-cam site | 60-cam site | Plausible? |
|---|---|---|---|
| $5 | $200/mo | $300/mo | **Yes — the market rate** |
| $10 | $400/mo | $600/mo | Stretching |
| $25 | $1,000/mo | $1,500/mo | No |
| $99 (Spot AI) | $3,960/mo | $5,940/mo | Not in this vertical |

v1 concluded "don't compete at $5". **That was reasoned on 8-camera sites and is
wrong here.** At 40–70 cameras, $5/channel *is* the right number — it lands at
$200–300/month, which is a real facility security budget. OpenEye's entry price
exists precisely because high-channel-count verticals like this one set it.

At $5 × 40 = $200/month against $55 COGS, that is **$145/site/month gross**. Twenty
sites is $2,900/month. That is a genuine business but it is not the near-term money:

**A 40–60 camera install at $250–400/camera fitted is $10,000–24,000, at 30–40%
margin — $3,000–9,600 per site, once.** One install is worth two to five years of
that site's recurring revenue. The install pays now; the recurring compounds.
Which is §3's argument stated in dollars.

**The number that actually decides profitability is the truck roll.** At $145/site
gross, one $150 site visit costs a month. Remote diagnosis is therefore a Phase 2
feature, not a Phase 6 one — every fault you can resolve without driving is a
month of that site's margin.

---

## 12. Build order

Each phase has an exit criterion met **on real hardware at a real facility**.

### Phase 0 — Prove it on a paying install (2–3 weeks, no product code)
Run this on your first §3-path-A install. Measure: real bitrate per camera type,
real GB/day with smart codec on and off, LTE failover throughput, and what the
install labour actually costs you.
**Exit:** §2, §4.2 and §11 are confirmed against a real facility, or this document
is rewritten. Cheap, and half the plans in this category die here.

### Phase 1 — The appliance records and survives (5–6 weeks)
ONVIF discovery, RTSP ingest, stream-copy segmenting, HDD ring buffer, retention
arithmetic with a harness, local web UI. No cloud.
**Exit:** 40 cameras recording 7 days continuously. Pull power and network
repeatedly; lose nothing but the outage seconds, with a correct `gap` recorded.

### Phase 2 — Cloud control plane (4 weeks)
IoT fleet provisioning, shadows, segment index sync, health telemetry, tamper
alerts, multi-site console, OTA.
**Exit:** an appliance enrols from a factory image with no manual keys, and you
can diagnose a camera fault at a site 200 miles away without SSH.

### Phase 3 — See it (5–6 weeks)
WebRTC live view (P2P, TURN fallback), timeline with explicit gaps, on-demand
retrieval, **priority incident upload (§4.1)**, clip export with hash + Object Lock.
**Exit:** a facility manager finds a specific 30-second event from three days ago
in under a minute and emails the clip to police.

### Phase 4 — Alerts and LPR (4–5 weeks)
Detector on perimeter/gate, zones and schedules, after-hours person/vehicle, LPR
at the gate, push/SMS/email.
**Exit:** false-alert rate low enough that *you* keep notifications on for a week.
A muted alerting product is a recording product at an alerting price.

### Phase 5 — Access-control integration (4–6 weeks)
Unit→camera mapping model and install tooling, then one integration end to end —
**PTI first**, it is the most widely deployed.
**Exit:** an access event on a real facility opens the right video in one click.

### Phase 6 — Multi-site and remote guarding (ongoing)
Cross-site console, talk-down speakers, monitoring-centre handoff.

**Realistic total: 6–9 months to a sellable v1.** Phases 1 and 3 always overrun.

---

## 13. Open decisions

1. **Path A, path B, or both?** (§3.) The one that matters. Everything else waits
   on it.
2. **Do you sell hardware, or spec it?** Selling means inventory and RMAs;
   specifying means a lighter company and a worse install experience.
3. **Which access-control vendor first?** PTI is the most deployed. Storable/Nokē
   is the largest ecosystem. Ask your actual customers what is on their gates —
   the answer is probably already known and it should decide Phase 5.
4. **Retention promise.** 30 days is the default and it sizes every drive you buy.
   Sixty doubles the storage BOM — unless smart codec pays for it (§2).
5. **Monitoring.** Do you offer 24/7 remote guarding, or partner for it? It is the
   highest-value service at unmanned facilities and a completely different company
   to run.
6. **Insurance and counsel.** Before the first paying site: E&O cover, and a
   lawyer's read on §10. A camera system that loses footage during a break-in
   gets sued.

---

## 14. What this plan deliberately does not do

- **No face recognition.** §10.
- **No cloud-continuous recording**, at any price, until someone proves a storage
  operator will pay the $400–800/site/month it costs.
- **No semantic AI search, no PPE.** Cut with the construction pivot.
- **No crew tracking, no job linkage, no Terra Vista integration.** Cut.
- **No auto-matching a plate to a tenant.** A human confirms.
- **No own camera hardware.** BYO ONVIF is the strategy.

---

## Sources

- [Amazon Kinesis Video Streams pricing](https://aws.amazon.com/kinesis/video-streams/pricing/) — $0.0085/GB ingest and consume, $0.023/GB-month storage, WebRTC signalling from $0.03/channel/month
- [AWS Panorama end of support](https://docs.aws.amazon.com/panorama/latest/dev/panorama-end-of-support.html) — 31 May 2026
- [AWS IoT Greengrass v2 fleet provisioning](https://docs.aws.amazon.com/greengrass/v2/developerguide/fleet-provisioning.html), [v2.17 release](https://aws.amazon.com/about-aws/whats-new/2026/04/aws-iot-greengrass-v217/) — TPM 2.0; v1 EOL 7 Oct 2026
- [Frigate MIT licence](https://github.com/blakeblackshear/frigate/blob/dev/LICENSE), [trademark policy](https://github.com/blakeblackshear/frigate/blob/dev/TRADEMARK.md), [video pipeline](https://docs.frigate.video/frigate/video_pipeline/)
- [Hailo-8 vs Coral for NVR workloads](https://botmonster.com/smart-home/hailo-8-vs-coral-tpu-frigate-nvr-comparison/)
- [Self-storage camera coverage guide](https://www.backstreet-surveillance.com/blog/post/security-cameras-for-storage-units-what-to-consider-for-coverage-placement-and-monitoring) — perimeter bullets, corridor domes, LPR at gate, multi-site VMS
- [Cameras for self-storage — IPVM discussion](https://ipvm.com/discussions/cameras-for-mini-storage-buildings) — 60–70 cameras on an indoor climate-controlled facility
- [PTI Security Systems](https://www.ptisecurity.com/us/en) and [PTI–Storable real-time cloud integration](https://www.insideselfstorage.com/suppliers-products/pti-security-systems-partners-with-storable-to-launch-real-time-cloud-integration-for-self-storage-operators)
- [Storable StorApp integrations](https://www.storable.com/resources/integration/storapp/) — SiteLink, storEDGE; Nokē, PTI, Sentinel, Bearbox, OpenTech ICT
- [Self-storage security solutions round-up](https://www.neighbor.com/storage-blog/self-storage-security-solutions/) — Nokē/Eagle Eye video partnership; PTI, Sentinel, SpiderDoor in access control
- [Remote guarding for self-storage](https://eliteisi.com/remote-guarding-for-self-storage-facilities-real-time-prevention-of-break-ins-and-unauthorized-access/) — talk-down, unmanned sites
- [OpenEye OWS 24/7 Lite](https://www.openeye.net/introducing-ows-247-lite-the-most-affordable-subscription-option-for-openeye-web-services/) — entry tier includes 2 GB cloud storage; [OWS licensing](https://answers.openeye.net/OpenEye_Web_Services/OWS_Licensing) — per channel, recorder purchased separately
- [NDAA Section 889 camera compliance](https://tec-tel.com/resources/ndaa-section-889-camera-compliance)
- [Audio surveillance consent by state](https://www.upcounsel.com/audio-surveillance-laws-by-state/) — 11 all-party states + DC, including Florida
- [Surveillance compliance checklist — BIPA](https://www.forasoft.com/learn/video-surveillance/articles-vms/surveillance-compliance-checklist)
