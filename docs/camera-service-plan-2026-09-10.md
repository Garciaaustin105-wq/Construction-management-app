# Jobsite Camera Service — Architecture and Build Plan

> **Status:** plan, not a spec. Nothing here has been built. Written 2026-09-10.
> Decisions locked with the human before writing are in [§1](#1-decisions-already-locked).
>
> This is a **standalone business**, not a feature of Terra Vista. It gets its
> own repo, its own AWS account, its own P&L. The one deliberate tie back to the
> construction app is an outbound API — see [§10](#10-the-wedge-why-this-beats-a-generic-vms).

---

## 1. Decisions already locked

| Question | Answer | Consequence |
|---|---|---|
| What is it for | Standalone business | Own repo + own AWS org. No Supabase RLS reuse by default. |
| Camera hardware | BYO ONVIF/RTSP + Linux bridge on site | No manufacturing. Works with cameras already installed. This is the OpenEye model. |
| v1 scope | Live view, playback, motion/person/vehicle alerts, AI search + PPE, job linkage | Too much for one v1. Phased in [§11](#11-build-order). |
| Connectivity | Mixed broadband and LTE | **Bandwidth is the binding constraint.** Drives the entire architecture. |

---

## 2. Executive summary — the one number that decides everything

One 4MP camera at 2 Mbps H.265, recording continuously, produces **21.6 GB/day
— 648 GB/month**. That single figure decides the architecture, the price list,
and whether the business works.

| Recording model | Raw AWS cost / camera / month | Notes |
|---|---|---|
| Continuous → Kinesis Video Streams | **~$20.41** | $5.51 ingest + $14.90 storage @30-day retention. Add ~$5.51 again if cloud AI re-reads the stream. |
| Continuous → S3 direct (60s segments, lifecycle to IA at day 7) | **~$10–12** | Ingress free; ~$9.69 blended storage + ~$0.22 PUTs, **plus an IA early-deletion penalty** — see the caveat below. |
| **Edge-first: record local, upload events + keyframes** | **~$0.30–0.80** | ~15–20 GB/month uploaded. Storage rounds to pennies. |

Spot AI quotes around **$99/camera/month**. OpenEye starts at about
**$5/channel/month** — and understanding *why* it can be that cheap is the whole
strategy, so it gets its own section ([§3.1](#31-what-openeyes-5-actually-buys)).
The short version: $5 is a cloud-*management* licence sitting on top of hardware
the customer already bought, with recording kept local and 2 GB of cloud storage.
It is not $5 of cloud video.

At $99 continuous-cloud recording has gross margin. At $25 it is thin. **At $5 it
is roughly four times underwater before you have paid a single support
engineer.**

> **Caveat on the S3 row, because it is the kind of error that looks fine.**
> S3 Infrequent Access bills a **30-day minimum storage duration**. Transition at
> day 7 and delete at day 30 and you are charged for 30 days of IA on data you
> held for 23, so the real figure is nearer $11–12 than $9.69. It also has a
> 128 KB minimum billable object size, so *do not* write 10-second segments to
> IA. Either transition at day 0, or keep 30-day retention entirely in Standard
> and only tier data you intend to keep for 90+ days. Model this properly before
> anyone quotes a continuous-cloud tier — the conclusion below does not change,
> but the number does.

**Therefore: the bridge records locally and is the source of truth. The cloud
holds an index, events, clips and thumbnails, and fetches original footage on
demand.** Every subsequent decision in this document follows from that sentence.
The corollary is the promise you can then make and OpenEye's cloud-first rivals
cannot: *a severed uplink loses no footage.*

Second consequence: **live view must be peer-to-peer WebRTC**, edge → browser,
with a TURN relay only as NAT fallback. Relayed video is billed to you per
minute; direct video is billed to the customer's own uplink. On an LTE site it
is billed to their data cap, which is why the viewer needs a hard bandwidth
budget and a substream default.

---

## 3. What we are actually competing with

| | Spot AI | OpenEye (OWS) | Verkada | This |
|---|---|---|---|---|
| Cameras | Their own + BYO | **BYO standard IP** | Proprietary only | BYO ONVIF/RTSP |
| Recording | On-prem appliance | On-prem recorder | On-camera SSD | On-prem bridge |
| Pricing | ~$99/cam/mo, quote-only | **from ~$5/channel/mo** + hardware, quote-only | Camera + licence, high | TBD, see [§9](#9-unit-economics-and-pricing) |
| Cloud storage included | Substantial | **2 GB** on the entry tier | On-camera | See §9 |
| Sold via | Direct | **Integrators** | Direct | Direct, construction-first |
| AI search | Yes, headline feature | Limited | Yes | Phase 4 |
| Construction-native | No | No | No | **Yes — the wedge** |

None of these is technically out of reach. All three are better funded, and two
sell through integrator channels that took a decade to build. **The build is not
the hard part of this business; distribution and 24/7 support are.** That is not
a reason to stop — it is the reason the wedge in [§10](#10-the-wedge-why-this-beats-a-generic-vms)
has to be real rather than a slogan.

### 3.1 What OpenEye's $5 actually buys

This number was corrected into the plan by the human, and it is the most
important competitive fact in the document — so it is worth being precise about
what is inside it. OWS 24/7 **Lite**, the entry tier, includes **2 GB of cloud
storage**. At 2 Mbps that is **2.3 hours of one camera**. It is a budget for
event clips, not a video archive.

Three things make $5 possible, and you have **none of them by default**:

| Their lever | What it does | Do you have it? |
|---|---|---|
| Customer buys OpenEye hardware — a cloud recorder or their cloud cameras — as a separate one-time purchase | Takes margin up front; the recorder is the archive | Only if you sell hardware at margin (open decision #2) |
| Recording stays local, 2 GB in the cloud | Cloud COGS rounds to ~$0.05/camera/month | **Yes** — this is the same edge-first design as §2 |
| Sold **exclusively through integrators** | The integrator does install, support and the truck rolls | **No.** Direct sales means you eat all of it |

**Conclusion, and it changes the pricing strategy: do not try to compete at $5.**
That price is a software line item inside a deal that also carries hardware margin
and an integrator's support labour. Matching it while selling direct means
matching their revenue and absorbing costs they never touch.

The viable position is the opposite one: **OpenEye's cost structure at
Spot AI's altitude.** Edge-first recording keeps COGS near $1.63, and you charge
$25–40 for things OpenEye's $5 tier does not include at all — real cloud
retention, AI search, PPE observation, and the construction-native features in
[§10](#10-the-wedge-why-this-beats-a-generic-vms). You are not the cheap option.
You are the option that costs a quarter of Spot AI and knows what a job site is.

---

## 4. Architecture — three planes

Keep these separate in your head and in the repo. They fail independently, scale
differently, and have different cost curves.

```
   SITE (Linux bridge)              AWS CONTROL PLANE           AWS MEDIA PLANE
 ┌───────────────────────┐        ┌────────────────────┐      ┌──────────────────┐
 │ ONVIF discovery       │  mTLS  │ IoT Core           │      │ S3 (clips,       │
 │ RTSP ingest (go2rtc)  │◄──────►│  · registry        │      │    keyframes,    │
 │ segment writer (ffmpeg│  MQTT  │  · device shadow   │      │    exports)      │
 │   stream-copy, no     │        │  · jobs / OTA      │      │ + lifecycle      │
 │   transcode)          │        │ Greengrass v2      │      │ + Object Lock    │
 │ ring buffer on NVMe   │        │ Fleet provisioning │      │ CloudFront       │
 │ detector (Hailo NPU)  │        └─────────┬──────────┘      │  (signed URLs)   │
 │ upload agent (Go)     │                  │                 └────────┬─────────┘
 │ WebRTC publisher      │        ┌─────────▼──────────┐               │
 └──────────┬────────────┘        │ App tier           │◄──────────────┘
            │                     │  Next.js + Postgres│
            │   WebRTC (P2P)      │  segment index     │
            └────────────────────►│  events, tenants   │
                  viewer          │  pgvector search   │
                                  └────────────────────┘
```

**Rule that keeps this honest:** the cloud never assumes it has the footage. It
holds a *segment index* that says where each span of time lives — `edge`, `s3`,
`glacier`, or **`gap`**. A gap is an explicit record meaning *we do not know what
happened here*, never an absence that renders as empty timeline. (Build rule B1:
a blank is not a zero. A camera that was offline is not a camera that saw
nothing, and a customer looking for a theft must be told which it was.)

---

## 5. The edge bridge

### 5.1 Hardware — reference BOM

| Part | Choice | ~Cost | Why |
|---|---|---|---|
| Compute | Intel N100/N150 mini PC, 16 GB RAM, 2× M.2 | $180–250 | x86 keeps ffmpeg/QuickSync/driver support boring. ARM saves $60 and costs weeks. |
| NPU | Hailo-8L M.2 (13 TOPS) or Hailo-8 (26 TOPS) | $70 / $200 | Hailo is the right pick past ~4 cameras; ~5 W. Coral (4 TOPS) only for 1–3 cameras; Jetson only if you need model flexibility at 7–25 W. |
| Storage | 4 TB NVMe (8 TB for 8+ cams at 30 days) | $200–450 | See sizing below. |
| LTE | M.2 modem (e.g. Quectel RM520N) + antennas | ~$150 | Optional per site. |
| **Total** | | **$600–1,000** | Incumbent appliances retail $1,500–4,000. |

**Storage sizing, stated as a contract:** 4 TB ÷ 21.6 GB/camera/day = **185
camera-days**. Eight cameras → 23 days. Sixteen → 11.5 days. Thirty-day
retention on eight cameras needs ~5.2 TB. *Retention is a function of camera
count, bitrate and disk — the UI must show the computed number per site, never
a marketing "30 days".* Every quantity carries its unit (build rule B2); a
retention promise without the bitrate it assumed is the same class of error.

Sell hardware at or near cost. The subscription is the business; hardware is an
RMA liability.

### 5.2 Software — build vs adopt

| Layer | Adopt | Build |
|---|---|---|
| RTSP/ONVIF ingest, restream, WebRTC | **go2rtc** (MIT) | — |
| Segmenting | **ffmpeg** `-c copy` | segment naming, index, ring-buffer eviction |
| Object detection | **Frigate** (MIT) as the v1 detector | — (but see caveat) |
| Fleet OTA, identity | **AWS IoT Greengrass v2** + fleet provisioning (X.509, TPM 2.0 supported) | component packaging |
| Uplink agent | — | **This is the piece you own.** |

**Never transcode.** Stream-copy H.264/H.265 to fMP4. Transcoding is the
difference between 4 cameras and 40 on one box. Only the low-res substream
(640×360, ~5 fps) is decoded, and only for the detector.

**Frigate caveat, read before committing:** the code is MIT so commercial use and
redistribution are fine, but the *name, brand and logo* are trademarks of
Frigate, Inc. and are explicitly **not** licensed — you may not use "Frigate" in
the name of a commercial product or service. So: use it, rebrand completely,
attribute in your notices, and keep the cloud contract detector-agnostic so you
can swap in a GStreamer + Hailo pipeline later without touching the cloud. Also
note Frigate 0.16+ ships face recognition and LPR — **both must be compiled out
or hard-disabled by default** for the reasons in [§8](#8-legal-gates-the-refusals).

**The uplink agent (Go or Rust) is the actual product.** Responsibilities:

1. Enrolment via fleet provisioning claim certificate → per-device X.509.
2. Device shadow sync — camera list, retention, schedules, alert rules.
3. Maintain the local segment index; publish deltas to the cloud.
4. **Bandwidth-budgeted upload queue.** Per-site bytes/day cap, priority ordering
   (alert clips > keyframes > requested retrievals > backfill), store-and-forward
   across outages, resumable multipart. On LTE the budget is the feature.
5. On-demand retrieval: cloud asks for `camera X, 14:02:00–14:04:30`, agent cuts
   it from the ring buffer and uploads it.
6. Health telemetry: per-camera up/down, disk free, computed retention days,
   uplink quality, NPU inference latency, dropped frames.

### 5.3 OS and updates

Debian 13 minimal + systemd + podman for v1. **Add A/B image updates (RAUC or
Mender) before the fleet passes ~50 units** — you cannot send a truck to a site
because a `apt upgrade` bricked a bridge, and a bad update that takes out 200
customers' recording simultaneously is an extinction event. Greengrass handles
application components; it does not save you from a broken kernel.

---

## 6. The AWS cloud

| Need | Service | Why, and what was rejected |
|---|---|---|
| Device identity, registry, shadows, OTA | **IoT Core + Greengrass v2** | Fleet provisioning issues per-device X.509 on first connect; TPM 2.0 supported. *Rejected:* AWS Panorama — **end of support 31 May 2026**, do not start there. Greengrass v1 also ends 7 Oct 2026; v2 only. |
| Bulk footage storage | **S3** + lifecycle: Standard → IA @7d → Glacier IR @30d → expire/Deep Archive @90d | Ingress is free; lifecycle roughly halves blended cost. *Rejected:* KVS as the archive — it is ~2× S3 and is built for streaming APIs, not bulk retention. |
| Evidence holds | **S3 Object Lock** (governance mode) + SHA-256 per object | If a customer will ever use a clip in an insurance claim or a prosecution, chain of custody is a product requirement, not a nicety. |
| Live view signalling + TURN | **KVS WebRTC** ($0.03/signalling channel/month + messages + TURN minutes) | Managed signalling and STUN/TURN for pennies. *Rejected for v1:* self-hosted coturn + SFU — real money in ops time. Revisit if TURN minutes ever dominate. |
| Playback delivery | **CloudFront** + signed URLs over fMP4/HLS | Cheaper egress than S3 direct, and signed URLs give per-clip, time-boxed access. |
| Event bus | IoT Rules → **EventBridge** → Lambda | Events are small JSON; keep them off the media path entirely. |
| App DB + tenancy | **Aurora Serverless v2 (Postgres)** + pgvector | See §7. *Considered:* Supabase — the team already has debugged multi-tenant RLS, which is worth real weeks. Ruled second only because "standalone business, AWS cloud" was locked; **revisit if speed to first customer matters more than purity.** |
| Semantic search index | **pgvector in the same Postgres** | *Rejected for v1:* OpenSearch Serverless — right at large scale, but it has a floor cost per collection that a 20-site business cannot justify. AWS's own reference pairs Titan Multimodal Embeddings with OpenSearch; the embedding half of that is worth copying, the index half is not, yet. |
| Notifications | SNS → push/SMS, plus email | — |

---

## 7. The data contracts — write these first

House rule A1: contract in a pure lib, then a harness, then the UI. These are
the three that everything else is derived from, and each must compile and be
testable with no network, no camera and no database.

```ts
// Where a span of time physically lives. `gap` is a first-class value.
type SegmentTier = 'edge' | 's3' | 'glacier' | 'gap';

interface Segment {
  cameraId: string;
  startUtc: string;        // ISO 8601, always UTC
  endUtc: string;
  tier: SegmentTier;
  key: string | null;      // S3 key; null when tier is 'edge' or 'gap'
  bytes: number | null;    // null when 'gap' — NOT 0
  codec: 'h264' | 'h265';
  bitrateKbps: number;     // carries its unit
  gapReason?: 'camera_offline' | 'bridge_offline' | 'disk_full'
            | 'evicted_by_retention' | 'unknown';
}

interface DetectionEvent {
  cameraId: string;
  atUtc: string;
  kind: 'motion' | 'person' | 'vehicle';
  confidence: number;              // 0–1, always shown to the user
  boxes: BoundingBox[];
  clipSegment: Segment | null;     // null until uploaded
  keyframeKey: string | null;
}

// A measurement, never a verdict. See §8.
interface PpeObservation {
  eventId: string;
  item: 'hard_hat' | 'hi_vis' | 'eye_protection';
  framesInspected: number;
  framesDetected: number;
  confidence: number;
  // deliberately absent: `compliant: boolean`, `violation: true`, any person id
}
```

Three properties of these types are load-bearing:

- **`gap` with a `gapReason`.** The timeline UI renders a hatched band saying
  *"camera offline 02:10–06:44"*. It never renders quiet grey that a customer
  reads as "nothing happened."
- **`bytes: null` on a gap.** Not `0`. Summing a month of storage must not treat
  outages as free footage.
- **`PpeObservation` has no boolean.** It reports frames inspected and frames
  detected, and the UI says "hard hat not detected in 6 of 40 frames — review".
  That is build rule 11, and it is also what keeps you out of court.

**Retention arithmetic is a pure function** — `computeRetentionDays(cameras[],
diskBytes)` — with a harness, because it is the number the sales page prints and
the number a customer sues over.

---

## 8. Legal gates (the refusals)

These are product decisions, not lawyer decisions, and they are cheaper to make
now than after the first class action. **Get real counsel before launch;** this
section exists so the defaults are right in the meantime.

| Gate | Default | Why |
|---|---|---|
| **Face recognition** | **Do not ship.** | Illinois BIPA requires informed written consent for facial geometry, at $1,000–$5,000 **per violation**; cumulative settlements have passed $1.8 bn. This is the single largest liability in the category and v1 gets no benefit from it. Person *re-identification within one session* is defensible; matching against a named gallery is the bright line. Frigate's built-in face recognition must be disabled. |
| **Audio** | **Off, per-camera opt-in, geo-gated.** | 11 states plus DC require all-party consent (CA, CT, DE, FL, IL, MD, MA, MI, MT, NH, PA, WA). Florida is on that list — your home market. |
| **Employee monitoring disclosure** | Built-in signage kit + written notice template, required at site activation | California AB 1221 (effective Jan 2026) requires disclosing what you record and why each method is necessary. Make it a setup step the installer cannot skip. |
| **NDAA / Section 889** | Technically support any ONVIF camera; **never sell or certify Hikvision, Dahua, Huawei, Hytera, ZTE** | Federal contractors and grant recipients cannot use them, and there is no remediation path. Any customer touching public work needs a compliant camera list. Axis, Avigilon and Hanwha give written 889 attestations; Reolink is not named but its documentation is thinner. |
| **PPE detection** | Measurements only, human clicks to act | See `PpeObservation` above. Build rule 13: nothing auto-applies. |

---

## 9. Unit economics and pricing

Assumptions, stated so they can be argued with: 4MP H.265 at 2 Mbps, 30-day
retention, us-east-1, 8 cameras per site, 60 alert events per camera per day at
30 s each, one keyframe per 60 s.

**Per camera per month, edge-first:**

| Line | Cost |
|---|---|
| S3 storage (~15 GB: 13.5 GB clips + 1.7 GB keyframes) | $0.30 |
| S3 requests | $0.05 |
| IoT Core messages + shadow | $0.10 |
| KVS WebRTC signalling + occasional TURN | $0.15 |
| CloudFront egress (playback, ~5 GB) | $0.43 |
| Compute (Lambda, Aurora share) | ~$0.60 |
| **AWS cost of goods** | **~$1.63** |
| Embeddings + AI search (Phase 4, per camera) | +$0.50–2.00 |

Gross margin by price point, before any support cost:

| Price / camera / month | Gross margin | One $150 truck roll costs you |
|---|---|---|
| $5 (matching OpenEye Lite) | $3.37 — 67% | **45 camera-months** |
| $25 | $23.37 — 93% | 6 camera-months |
| $40 | $38.37 — 96% | 4 camera-months |
| $99 (Spot AI) | $97.37 — 98% | 1.5 camera-months |

The percentages flatter the $5 column and hide the real problem: **the absolute
dollars per camera are what pay a support engineer, not the ratio.** A hundred
cameras at $5 is $337/month of gross profit — less than one support incident.
The same hundred at $25 is $2,337 and the business breathes.

So the margin is not the risk at $25+. **Support, truck rolls and churn are the
risk**, and they are the reason bridge health telemetry and remote diagnosis are
a Phase 2 feature rather than a Phase 6 one. Every problem you can diagnose
without driving to a site is the entire month's profit on four cameras.

Amortised hardware: $800 per site ÷ 8 cameras ÷ 36 months = **$2.78/camera/month**
if you finance it, or a one-time charge if you do not.

---

## 10. The wedge — why this beats a generic VMS

You will not out-feature Verkada or out-channel OpenEye. What you have that
none of them do is **an existing construction/landscape platform with jobs,
visits, crews, geofences and photos already modelled** — and the domain
knowledge to know what a contractor actually wants footage *for*.

Construction-native features nobody in the category will build:

1. **Clip → job linkage.** A camera belongs to a site; a site maps to a job. Every
   event lands on the job record next to the photos, receipts and time entries.
2. **Delivery verification.** Vehicle detected at the gate at 07:14 → attach to
   the material order → "your sod arrived" with the clip.
3. **Visit verification.** The existing crew-tracking and geofence system says a
   crew clocked in; the camera says a truck arrived at 07:02. Two sources
   agreeing is a receipt. Two sources disagreeing is *information* — show both,
   never average them, never auto-resolve (build rule D5).
4. **Progress timelapse.** One keyframe per minute, already being captured for
   nothing, becomes a customer-facing build video. This is a sales feature that
   costs zero incremental storage.
5. **Theft and after-hours.** Equipment yards and unoccupied sites — the actual
   reason contractors buy cameras at all.

The integration is **an outbound webhook + REST API** from the camera platform
into Terra Vista, not shared code and not a shared database. Two products, one
contract. That keeps the standalone business standalone and still lets you demo
something no competitor can.

---

## 11. Build order

Each phase has an exit criterion. **Do not start the next phase until the
previous one's criterion is met on real hardware at a real site**, because every
assumption above is about to meet an actual camera on an actual LTE modem.

### Phase 0 — Prove the premise (2 weeks, no product code)
Buy one mini PC, one Hailo, three cameras of three brands, one LTE modem. Put
them in a real yard. Measure: actual bitrate per camera, actual GB/day, actual
detection accuracy on your own footage, actual LTE upload throughput at 3pm.
**Exit:** the numbers in §2 and §9 are confirmed or this document is rewritten.
Half the plans in this category die here and it is cheap to find out.

### Phase 1 — The bridge records and survives (4–6 weeks)
ONVIF discovery, RTSP ingest, stream-copy segmenting, NVMe ring buffer, retention
arithmetic with a harness, local web UI. No cloud at all.
**Exit:** 8 cameras recording 7 days continuously; pull the power and the network
repeatedly and lose nothing but the seconds during the outage, with a correctly
recorded `gap`.

### Phase 2 — Cloud control plane (4 weeks)
IoT fleet provisioning, device shadow, segment index sync, health telemetry, the
tenant/site/camera model, OTA via Greengrass.
**Exit:** a bridge enrols from a factory image with no manual keys, appears in
the console, and can be remotely diagnosed without SSH.

### Phase 3 — See it (4–6 weeks)
WebRTC live view (P2P, TURN fallback), timeline UI with explicit gaps, on-demand
retrieval from the edge, clip export with hash + Object Lock.
**Exit:** a non-technical person finds a specific 30-second event from three days
ago in under a minute, on an LTE site, and emails the clip.

### Phase 4 — Alerts (3–4 weeks)
Detector on the Hailo, zones and schedules, alert rules, push/SMS/email, clip
auto-upload with bandwidth budget.
**Exit:** false-alert rate low enough that *you* keep notifications on for a week.
This is the honest bar; anything higher and customers mute it, and a muted
alerting product is a recording product at an alerting price.

### Phase 5 — Terra Vista integration (2 weeks)
Webhook out, job/visit linkage, delivery and arrival verification, timelapse.
**Exit:** an event appears on a job record in the construction app.

### Phase 6 — AI search and PPE (6–8 weeks)
Keyframe embeddings (Titan Multimodal on Bedrock, or self-hosted SigLIP) →
pgvector → text query. PPE as `PpeObservation` measurements only.
**Exit:** "red truck at the gate on Tuesday" returns the right clip in the top
five, on a real 30-day archive — and no screen anywhere renders a compliance
verdict.

**Realistic total: 6–8 months to a sellable v1**, assuming the phases are worked
sequentially by a small team. Phases 1 and 3 are the ones that always overrun.

---

## 12. Open decisions for the human

These need answers before Phase 2, and none of them is mine to make:

1. **Aurora vs Supabase.** Purity says Aurora. Weeks-to-first-customer says
   Supabase, whose multi-tenant RLS you have already debugged once. Which matters
   more right now?
2. **Do you sell hardware, or spec it?** Selling it means RMAs, inventory and
   customs. Specifying it ("buy this $700 mini PC and this NVMe, we'll ship the
   image") means a worse install experience and a much lighter company.
3. **Direct or through integrators?** OpenEye's channel is its moat *and* the
   reason it can price at $5 (§3.1) — the integrator absorbs the support cost.
   Direct is faster to first revenue, much slower to a hundred sites, and forces
   you to price at $25+ to fund your own support.
4. **Which market first — construction sites, or equipment yards?** Yards have
   power, internet and a fixed address. Active sites have LTE, dust, theft and
   urgency. The yard is the easier build; the site is the bigger pain.
5. **Retention promise.** 30 days is the category default and it sizes every
   NVMe you ever buy. Committing to 60 doubles your hardware BOM.
6. **Insurance and counsel.** Before the first paying site: E&O cover, and a
   lawyer's read on §8. A VMS that loses footage during an incident gets sued.

---

## 13. What this plan deliberately does not do

- **No face recognition.** §8.
- **No cloud-continuous recording tier**, at any price, until someone proves a
  customer will pay the $10–26/camera/month it costs.
- **No compliance verdicts.** PPE reports frames, a human decides.
- **No auto-anything.** Nothing acts on a detection without a person clicking.
- **No own camera hardware.** BYO ONVIF is the whole strategy; building cameras
  is a different company.

---

## Sources

- [Amazon Kinesis Video Streams pricing](https://aws.amazon.com/kinesis/video-streams/pricing/) — $0.0085/GB ingest and consume, $0.023/GB-month storage, WebRTC signalling from $0.03/channel/month
- [AWS Panorama end of support](https://docs.aws.amazon.com/panorama/latest/dev/panorama-end-of-support.html) — 31 May 2026
- [AWS IoT Greengrass v2 fleet provisioning](https://docs.aws.amazon.com/greengrass/v2/developerguide/fleet-provisioning.html) and [v2.17 release notes](https://aws.amazon.com/about-aws/whats-new/2026/04/aws-iot-greengrass-v217/) — TPM 2.0, non-root install; Greengrass v1 EOL 7 Oct 2026
- [Frigate MIT licence](https://github.com/blakeblackshear/frigate/blob/dev/LICENSE) and [trademark policy](https://github.com/blakeblackshear/frigate/blob/dev/TRADEMARK.md)
- [Frigate video pipeline](https://docs.frigate.video/frigate/video_pipeline/) — substream decode, 5 fps sampling
- [Hailo-8 vs Coral for NVR workloads](https://botmonster.com/smart-home/hailo-8-vs-coral-tpu-frigate-nvr-comparison/) and [edge accelerator comparison](https://www.geeky-gadgets.com/ai-edge-sbc-hardware-comparison/)
- [Spot AI pricing](https://surveillant.ai/guides/spot-ai-pricing) — ~$99/camera/month, quote-only
- [OpenEye OWS 24/7 Lite announcement](https://www.openeye.net/introducing-ows-247-lite-the-most-affordable-subscription-option-for-openeye-web-services/) — entry tier includes **2 GB cloud storage**
- [OWS licensing](https://answers.openeye.net/OpenEye_Web_Services/OWS_Licensing) — per-channel, 1:1 policy, OpenEye recorder or cloud cameras purchased separately
- [OpenEye pricing](https://surveillant.ai/guides/openeye-pricing) and [cloud VSaaS pricing guide](https://surveillant.ai/guides/cloud-video-surveillance-pricing) — $5–30/channel/month band, sold only through integrators
- [NDAA Section 889 camera compliance](https://tec-tel.com/resources/ndaa-section-889-camera-compliance) and [compliant brand list](https://security.getuniqcli.com/guides/ndaa-compliant-camera-brands)
- [Surveillance compliance checklist — GDPR, BIPA, DPIA](https://www.forasoft.com/learn/video-surveillance/articles-vms/surveillance-compliance-checklist)
- [Employee monitoring laws by state 2026](https://www.intelogos.com/blog/employee-monitoring-laws-by-state) — California AB 1221
- [Audio surveillance consent by state](https://www.upcounsel.com/audio-surveillance-laws-by-state/) — 11 all-party states + DC
- [Video semantic search on AWS](https://aws.amazon.com/blogs/media/video-semantic-search-with-ai-on-aws/) and [Titan Multimodal Embeddings + OpenSearch](https://aws.amazon.com/blogs/machine-learning/implement-serverless-semantic-search-of-image-and-live-video-with-amazon-titan-multimodal-embeddings/)
