# Storage-Facility Camera Service — Architecture and Build Plan

> **Status:** plan, not a spec. Nothing has been built. Written 2026-09-10.
>
> **v4 — the estate changes the question.** v1 targeted construction; v2
> retargeted to self-storage; v3 made the build conditional on reaching ~50
> facilities. The human then disclosed the actual footprint: **150+ stores at
> 16–30 cameras each — roughly 3,450 cameras — mostly Hikvision, on OpenEye
> NVRs.**
>
> That is past every threshold in v3. It also makes the platform the *second*
> most important thing in this document. **The Hikvision estate is the first**,
> and it is both the larger liability and the far larger opportunity.

---

## 0. The estate you actually have

150+ stores × 16–30 cameras ≈ **2,400–4,500 cameras, call it 3,450.** Mostly
Hikvision, recording to OpenEye NVRs.

Two things follow, and neither is "build a platform".

### 0.1 The Hikvision estate is an active security problem, today

Not a compliance abstraction — a live one:

- **CVE-2017-7921**, a critical authentication bypass in Hikvision cameras, was
  added to CISA's Known Exploited Vulnerabilities catalog on **5 March 2026**
  after confirmation that attackers are **actively exploiting it in the wild**.
  Federal agencies were given until 26 March 2026 to remediate.
- **October 2025: the FCC closed the last loopholes** — retroactively revoking
  outstanding equipment authorisations and banning importation of legacy models.
  New units, **and replacement parts**, are drying up.
- **Firmware pipelines are breaking.** Sanctions prevent the use of US technology
  in future firmware, so new vulnerabilities increasingly will not get patched.

To be accurate about what is *not* true: the FCC action is an importation and
marketing ban, **not** a mandate to remove installed equipment. A private
commercial business with no federal ties may legally keep running Hikvision
cameras it already owns. Nobody is going to confiscate anything.

But read that alongside what these facilities sell. **A self-storage operator's
entire product is "your property is safe here."** Three thousand-plus cameras
carrying an actively-exploited authentication bypass, on a firmware line that is
going dark, is not a paperwork risk. It is a breach with a press release attached,
at customers whose only differentiator is security.

**Do this in the next few weeks, independent of every other decision in this
document:** VLAN-isolate the cameras, remove all internet exposure and port
forwarding, disable UPnP, rotate every default credential, and confirm the NVRs
are the only route in. That is a weekend of work per store at most and it
addresses the exploited CVE without buying anything.

### 0.2 The refresh is the actual business

Those cameras have to be replaced over the next 12–24 months — not because a
regulator will force it, but because parts and firmware are ending.

| | Low | High |
|---|---|---|
| Cameras | 2,400 | 4,500 |
| At $250–400/camera installed | **$600,000** | **$1,800,000** |
| At 30–40% margin | **$180,000** | **$720,000** |

**That is the opportunity in this conversation.** It is one to two orders of
magnitude larger than anything the software saves, and it is in front of you now.

**And you are unusually well placed for it, because your VMS is not the problem.**
The generic industry advice is to swap the VMS to an ONVIF platform first, then
phase hardware over 12–24 months. **You already did that step** — OpenEye is
NDAA-clean and takes standard ONVIF cameras. So this is not a rip-and-replace.
It is a **camera-by-camera swap onto recorders you already own**, phaseable store
by store, with no forklift moment and no retraining. Your existing OpenEye
investment is exactly what makes the migration cheap.

Specify NDAA-compliant, ONVIF, **smart-codec** cameras (§2 — it halves storage and
buys retention for free). Axis, Avigilon and Hanwha give written 889 attestations.

### 0.3 So should you build the platform now?

At 3,450 cameras, the arithmetic finally clears v3's threshold:

| | Per month | Per year |
|---|---|---|
| License cost at $3.25 × 3,450 | $11,212 | **$134,550** |
| AWS COGS if self-built ($1.38) | $4,761 | $57,132 |
| **Gross saving from building** | **$6,451** | **$77,418** |

$77k/year is real money. But **150 sites needs real operations** — on-call
rotation, fleet patching, someone accountable at 2am — and that is a fully-loaded
$80–120k/year. **Even at this scale the pure build case is roughly break-even to
negative.** It got much better than v3 and it still does not clear.

**What clears easily is negotiating.** $3.25 is your friend's price at your
friend's volume. You are a 3,450-camera account about to spend $600k–1.8M on new
cameras — which is the single moment of maximum leverage you will ever have over
a VMS vendor, and every one of them wants that hardware decision to go their way.

| Negotiated license | Annual saving | Engineering required |
|---|---|---|
| $2.50 | $31,050 | **None** |
| $2.25 | $41,400 | **None** |
| $2.00 | $51,750 | **None** |

Competitively bid the VMS alongside the camera refresh — OpenEye against Eagle
Eye, Rhombus, Avigilon Alta, Genetec. **A phone call at 3,450 cameras plausibly
captures most of what eight months of engineering would, with no ops burden and
no vendor-migration risk.** Do that first. If it fails, you will have learned
exactly what your vendor dependency is worth, which is the strongest possible
input to the build decision.

### 0.4 Order of operations

1. **Weeks:** network-isolate the Hikvision estate (§0.1). Non-negotiable, cheap.
2. **This quarter:** competitive-bid VMS + cameras together (§0.3). Capture the
   license savings without building.
3. **12–24 months:** phased camera refresh onto existing OpenEye NVRs (§0.2).
   **This is the business.**
4. **Reassess the build** once the refresh is underway and you know your real
   negotiated license rate. The plan from §1 onward stays current for that day.

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

## 3. The two businesses

You are not short of technology. You are short of nothing at all on the hard part
— **you already have the customers**, which is what kills almost every entrant in
this category.

| | **A — Be the dealer/integrator** | **B — Build the platform** |
|---|---|---|
| What you do | Buy licenses at $3.25, install, service, resell | Everything in §4–§12 |
| Time to first revenue | **Weeks** | 6–9 months |
| Engineering | None | A team, then forever |
| Install margin | 30–40% of $10–24k = **$3,000–9,600/site** | Identical |
| Recurring margin | $4.75/cam at $8 retail = **$190/site/mo** | $6.62/cam = $265/site/mo |
| **Delta** | — | **+$75/site/month** |
| Biggest risk | Vendor changes terms or goes direct | You spend a year to save $75/site/month |

That bottom row is §0 restated: **the entire economic gain from building is $75
per facility per month.** Twenty facilities is $1,500/month — less than the cost
of maintaining what you built.

**Recommendation: run A. Revisit B at §0.2's trigger.**

And notice what A already gives you without a line of code: at 20 facilities,
**$3,800/month of recurring margin plus $60,000–190,000 of install revenue.**
The install is the business; the recurring is an annuity that compounds and that
carries real value if you ever sell. Neither requires you to own a platform.

Ten installs also buy the information B needs — what storage operators actually
call support about, what install labour really costs, which cameras survive a
Florida summer, which gate systems your customers actually run. **Phase 0 (§12)
is written to be run on installs you are doing anyway**, so the two paths share
their first month rather than competing.

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

**The three prices that matter**, per camera per month:

| | Amount | Source |
|---|---|---|
| Dealer license cost | **$3.25** | A working installer's actual invoice |
| Your AWS COGS if you build instead | **$1.38** | §11 above |
| Retail you can charge | **$8–15** | Category runs $5–20 for cloud retention, $15–40 for premium cloud VMS |

Per 40-camera facility:

| Path | Cost/mo | Revenue at $8/cam | **Gross/mo** |
|---|---|---|---|
| **A — resell** | $130 license | $320 | **$190** |
| **B — build** | $55 AWS | $320 | **$265** |

**The difference is $75/site/month, and that is the whole prize for building.**

Note also that per-camera pricing has a ceiling here that it does not have
elsewhere: at 40–70 cameras, Spot AI's $99/camera would be $4,000–6,000/month for
one facility. Nobody in self-storage pays that. High channel counts are exactly
why entry pricing in this vertical sits where it does — and why $8–15 retail on a
$3.25 cost is a comfortable, defensible place to stand.

The recurring is real but it is not the near-term money:

**A 40–60 camera install at $250–400/camera fitted is $10,000–24,000, at 30–40%
margin — $3,000–9,600 per site, once.** One install is worth two to five years of
that site's recurring revenue. The install pays now; the recurring compounds.
Which is §3's argument stated in dollars.

**The number that actually decides profitability is the truck roll.** At
$190/site/month gross, one $150 site visit costs most of a month. That is true on
*both* paths, which is worth sitting with: the operational discipline that makes
this business work — remote diagnosis, good camera selection, clean installs — has
nothing to do with who owns the software. Build it into how you install, now.

If you do eventually build (§0.2), that is why remote diagnosis is a Phase 2
feature and not a Phase 6 one.

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

1. **Who owns the 150 stores — you, or your customers?** (§0.) It does not change
   the security work or the refresh, but it decides who captures the $134k/year of
   license spend and who carries the ops burden if you ever build. Answer this
   before anything in §0.3 is acted on.
2. **What did the competitive bid actually return?** (§0.3.) The build decision
   waits on that number, not on a threshold.
3. **Do you sell hardware, or spec it?** Selling means inventory and RMAs;
   specifying means a lighter company and a worse install experience. At
   3,450 cameras this is a materially bigger question than it was at 20 sites.
4. **Which access-control vendor first?** PTI is the most deployed. Storable/Nokē
   is the largest ecosystem. Ask your actual customers what is on their gates —
   the answer is probably already known and it should decide Phase 5.
5. **Retention promise.** 30 days is the default and it sizes every drive you buy.
   Sixty doubles the storage BOM — unless smart codec pays for it (§2).
6. **Monitoring.** Do you offer 24/7 remote guarding, or partner for it? It is the
   highest-value service at unmanned facilities and a completely different company
   to run.
7. **Insurance and counsel.** Before the first paying site: E&O cover, and a
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
- [NDAA Section 889 camera compliance](https://tec-tel.com/resources/ndaa-section-889-camera-compliance) and [Hikvision alternatives for federal-touching facilities](https://tec-tel.com/compare/hikvision-alternatives)
- [CISA KEV listing of CVE-2017-7921](https://netcrook.com/hikvision-camera-vulnerabilities-privilege-escalation-2026/) — added 5 March 2026, actively exploited
- [Can I still use my existing Hikvision system after the 2026 FCC changes?](https://www.clevelandsecuritycameras.com/post/can-i-still-use-my-existing-hikvision-system-after-the-2026-fcc-changes) — importation/marketing ban, not a removal mandate for private commercial use
- [FCC closes the remaining Hikvision loopholes](https://blog.camerasecuritynow.com/2026/01/13/hikvision-dahua-cameras-critical-2026-update-plan-ahead-now/) — October 2025, retroactive authorisation revocation; parts and firmware supply
- [Replacing Hikvision — NDAA migration sequencing](https://www.coram.ai/post/replacing-hikvision-a-painless-guide-to-ndaa-compliance) — swap VMS to ONVIF first, phase hardware over 12–24 months
- [Audio surveillance consent by state](https://www.upcounsel.com/audio-surveillance-laws-by-state/) — 11 all-party states + DC, including Florida
- [Surveillance compliance checklist — BIPA](https://www.forasoft.com/learn/video-surveillance/articles-vms/surveillance-compliance-checklist)
