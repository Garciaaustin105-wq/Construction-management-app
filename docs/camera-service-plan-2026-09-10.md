# Internal Camera Platform — Plan

> **Status:** plan, not a spec. Nothing built. Last revised 2026-09-10.
>
> **v6 — go, and the shape is settled.** It is an internal platform for our own
> estate — 150+ stores, ~3,450 cameras — which we install and service ourselves.
> Not a product: no tenants, no billing, no customers.
>
> **The decision is made: keep the existing cameras, replace the OpenEye NVRs
> with our own appliance.** That resolves v5's gating condition — the recorders
> are being replaced by choice, so the appliance is not new capital, it is the
> recorder we were buying anyway.
>
> It also happens to be the correct sequencing. Industry guidance for escaping a
> Hikvision estate is exactly this: **move the recording platform first, phase the
> cameras over 12–24 months.** We are doing the hard half first and inheriting a
> clean path for the rest.
>
> Two things now gate the work, and neither is commercial. They are in §5.

---

## 1. Do this first — the Hikvision estate

This outranks everything else in this document and does not depend on any
decision in it.

### 1.1 It is an active security problem, today

- **CVE-2017-7921**, a critical authentication bypass in Hikvision cameras, went
  into CISA's Known Exploited Vulnerabilities catalog on **5 March 2026** —
  confirmed **actively exploited in the wild**. Federal remediation deadline was
  26 March 2026.
- **October 2025: the FCC closed the remaining loopholes**, retroactively revoking
  outstanding equipment authorisations and banning importation of legacy models.
  New units **and replacement parts** are drying up.
- **Firmware pipelines are breaking.** Sanctions block US technology in future
  firmware, so new vulnerabilities increasingly will not be patched.

What is *not* true: this is an importation and marketing ban, **not** a mandate to
remove installed equipment. A private commercial business with no federal ties may
legally keep running Hikvision it already owns.

But these are storage facilities. **Their entire product is "your property is safe
here."** 3,450 cameras carrying an actively-exploited authentication bypass, on a
firmware line going dark, is not a compliance abstraction.

**Do this within weeks, buying nothing:** VLAN-isolate every camera, remove all
internet exposure and port forwarding, disable UPnP, rotate every default
credential, confirm the NVR is the only route in. A weekend per store at most.

### 1.2 The refresh has to happen anyway

Not because a regulator forces it — because parts and firmware are ending.

| Cameras | 2,400 | 4,500 |
|---|---|---|
| At $250–400/camera installed | $600,000 | $1,800,000 |

Since we do our own installs, that is a cost line, not a revenue line. It is
happening across the next 12–24 months regardless.

**Recorder first, cameras after — which is what we are doing.** Standard guidance
for escaping a Hikvision estate is to move the recording platform to something
ONVIF-native first, then phase the cameras. Replacing the NVRs now and keeping the
Hikvision cameras for the moment is therefore the correct order, not a compromise.

Two things follow. First, **the cameras stay vulnerable until they are replaced**,
so §5.3's isolation is doing real work in the meantime — it is the control that
makes keeping them defensible. Second, once the appliance is in, swapping a camera
is a one-line configuration change instead of a platform migration, so the refresh
can go at whatever pace the budget allows, camera by camera, store by store.

When they are replaced: NDAA-compliant, ONVIF, smart-codec.

Axis, Avigilon and Hanwha all give written 889 attestations. Smart codec matters
more than it sounds: it halves storage (§4) and therefore halves the disk in every
appliance we buy — so **specify it now**, while sizing the appliances, even though
the cameras arrive later.

---

## 2. Should we build it? Now yes — conditionally

### 2.1 What internal-only changes

Three things, and together they flip the answer:

1. **The license is pure cost, not a pass-through.** We are not reselling it at a
   markup. Every dollar eliminated is a dollar to the bottom line.
2. **We already carry the 2am pager.** Earlier drafts loaded $80–120k/year of new
   operations against the build. That was right for a company that does not
   already support 150 stores of cameras. **We do.** The incremental is the
   software-specific part, not the whole function.
3. **The savings scale with us.** Licenses grow linearly with every camera added;
   AWS cost of goods grows at roughly 40% of that rate, and the fixed engineering
   does not grow at all.

### 2.2 The arithmetic

| | Per year |
|---|---|
| License cost, 3,450 cameras at $3.25 | **$134,550** |
| AWS cost of goods if self-hosted (~$1.38/camera) | $57,132 |
| **Gross saving** | **$77,418** |
| Less incremental software ops (~0.25–0.5 FTE) | −$25,000 to −$50,000 |
| **Net annual** | **$27,000 – $52,000** |

Positive, finally — but not by enough to ignore the capital cost:

**150 appliances at $900–1,400 each is $135,000–210,000 of hardware.** Against
$27–52k/year net, that is a **3–6 year payback on hardware alone**, before
counting six to nine months of build.

### 2.3 The condition is met

v5 gated this on whether the NVRs were being replaced anyway. **They are — by
decision.** So the appliance is not $135–210k of new capital; it is the difference
against a recorder we were buying regardless, which is close to a wash. Payback on
the $77k/year runs from roughly year one.

**The remaining financial risk is not the appliance. It is §5.2** — if the cameras
turn out to sit on the OpenEye recorders' built-in PoE ports, the project carries
$60–120k of switches and several hundred hours of re-cabling that nobody has
budgeted. That is the number to establish before ordering anything.

---

## 3. What internal-only lets us delete

Roughly a third of every previous draft. Gone, permanently:

| Deleted | Why |
|---|---|
| Multi-tenancy, RLS, tenant isolation | One company, one estate |
| Billing, plans, metering, Stripe | Nobody is invoiced |
| Customer-facing portal, branding, white-label | Internal users only |
| Dealer/reseller management | Not selling it |
| SLA tiers, support ticketing, onboarding flows | We are the customer |
| Semantic AI search, PPE detection | Cut in earlier drafts, stay cut |
| Marketing site, pricing pages, sales collateral | — |

What remains is a **fleet recorder with a good operations console.** That is a much
smaller and much more achievable thing than any prior version of this plan.

Access-control integration (PTI, Storable, Nokē, Sentinel) stays **optional** —
build it only for the gate systems our stores actually run, and only after §11
Phase 4. It was a product differentiator when we were selling; internally it is
just a convenience.

---

## 4. Sizing the estate

Per store, 30-day retention:

| Cameras | @2 Mbps | @1 Mbps (smart codec) | Disk |
|---|---|---|---|
| 16 | 10.4 TB | 5.2 TB | 2× 8 TB |
| 23 (avg) | 14.9 TB | 7.5 TB | 2× 8 TB |
| 30 | 19.4 TB | 9.7 TB | 2× 12 TB |

**Surveillance-rated HDDs (WD Purple, Seagate SkyHawk), not NVMe** — sustained
write for 30 cameras is only ~8 MB/s. Small NVMe for OS and index only.

**Retention is computed, never assumed:** `retentionDays = usableBytes /
(Σ cameraBitrate × 86400)`. A pure function with a harness, shown per store in the
console. A "30-day" figure that silently assumed 1 Mbps is how you discover on day
22 that the footage you need is gone.

Cloud (AWS) holds the index, incident clips and keyframes only — roughly
15 GB/camera/month. Continuous cloud recording for this estate would be
**$35,000–70,000/month.** It is not a tier we will ever offer ourselves.

---

## 5. The two things that gate this

Both are estate facts we do not yet know, and both are cheap to establish. Neither
is a reason not to proceed; one of them is a reason to budget differently.

### 5.1 Getting video out of Hikvision cameras — easier than expected

Since firmware **v5.5.0, Hikvision ships with ONVIF disabled by default**, and
enabling it means creating a dedicated ONVIF user in each camera's web interface.
Across 3,450 cameras that is a per-device touch nobody wants.

**We can skip it entirely. RTSP does not require ONVIF.** Hikvision's URL pattern
is stable and documented:

```
rtsp://<user>:<pass>@<ip>:554/Streaming/Channels/101   # channel 1, main stream
rtsp://<user>:<pass>@<ip>:554/Streaming/Channels/102   # channel 1, substream
```

Pattern is `/Streaming/Channels/CCS` — `CC` the channel, `S` the stream.

**So the appliance must accept templated RTSP URLs as a first-class camera source,
not merely as a fallback behind ONVIF discovery.** Point it at an IP range with a
vendor template and credentials and it adopts the whole store. ONVIF stays
supported for auto-discovery and PTZ on new NDAA-compliant cameras later — but it
is a convenience, never the migration path. Building discovery-first would create
a 3,450-camera configuration job out of nothing.

### 5.2 Where are the cameras plugged in? — the expensive unknown

**This is the question that can swing the project by six figures.**

Cameras plugged into an NVR's **built-in PoE ports** sit on the recorder's own
private, isolated subnet (typically `192.168.254.x` or `192.168.253.x`),
unreachable from the store LAN. Cameras on an **external PoE switch** take an
address on the normal network like any other device.

| If cameras are on… | Swapping the recorder means |
|---|---|
| **An external PoE switch** | Rack the appliance, point it at the camera subnet, done. A morning per store. |
| **The OpenEye NVR's own PoE ports** | Every camera must move to an external PoE switch and be re-addressed. **$60–120k of switches across 150 stores, plus roughly 3–6 hours per store — 450–900 hours.** |

Third-party cameras are also not plug-and-play on a recorder's PoE ports even when
they physically fit, so "just plug them into the new box" is not an escape.

**Establish this before ordering anything.** It may well differ store to store.
Bulk re-addressing is at least tractable — Hikvision's SADP and Batch Configuration
tools do it in batches rather than camera by camera — but the switches and the
labour are real money and must be in the budget from the start, not discovered at
store 40.

### 5.3 Design consequence: the appliance is dual-NIC

Whichever topology we find, the appliance gets **two network interfaces**: one to
the store LAN and internet, one to a camera-only segment. That makes the appliance
the **security boundary around the Hikvision cameras** — which matters more than
usual here, because we are keeping those cameras for now and they carry an
actively-exploited vulnerability (§1.1).

Done properly this is a genuine security *improvement* over what is deployed today:
cameras on an isolated segment, no route to the internet, no inbound path except
through our own appliance. **Owning the recorder is what makes that enforceable.**

### 5.4 Migrate by parallel-run, never big-bang

IP cameras serve **multiple concurrent RTSP clients** (typically 2–4 streams). So
a new appliance can pull the *same cameras* the OpenEye NVR is already recording,
at the same time, without touching the existing system.

1. One appliance, one store. Both record. **OpenEye stays authoritative.**
2. Thirty days. Compare segment by segment. Prove retention, gap handling, and that
   a power cut loses nothing.
3. Only then make the appliance authoritative. Keep OpenEye alive as fallback
   another 30 days.
4. Store by store. **Never more than a handful in flight.**

If the platform is wrong we find out at one store with a working NVR beside it —
not across 150 stores with the footage already gone. Any plan without a parallel
run is not worth executing.

## 6. The appliance

| Store size | Compute | Detector | Disk | ~Cost |
|---|---|---|---|---|
| 16–24 cams | Intel N100/N150, 16 GB, **2× 2.5GbE** | Hailo-8L | 2× 8 TB | ~$900 |
| 25–30 cams | Core i3, 32 GB, **2× 2.5GbE** | Hailo-8 | 2× 12 TB | ~$1,200–1,400 |

**Dual NIC is not optional** (§5.3). N100 boxes with two to four 2.5GbE ports are
standard and add nothing to the price.

Plus a UPS, and — where §5.2 requires it — a managed PoE switch at $400–800.
LTE failover optional per store, worth it where cutting the line is a plausible
burglary step.

**Do not put PoE in the appliance itself.** A separate managed switch is more
reliable, independently replaceable, and keeps a switch failure from taking the
recorder down with it. Repeating OpenEye's built-in-PoE mistake would leave the
next person swapping our box with the same §5.2 problem.

**Adopt, don't build:** go2rtc (MIT) for RTSP/ONVIF ingest and WebRTC; ffmpeg
`-c copy` for segmenting; Frigate (MIT) as the detector; AWS IoT Greengrass v2 for
fleet OTA and identity. **Camera onboarding is templated RTSP first (§5.1)** —
vendor URL template plus an IP range plus credentials adopts a whole store.

**Never transcode.** Stream-copy H.264/H.265. Only the low-res substream is decoded,
and only on cameras with a detector assigned — **perimeter, gate and entry doors
only, ~8–12 per store.** You do not need object detection on twenty interior
corridor cameras; motion triggers are nearly free and cover them.

**Frigate caveat:** MIT code, so commercial and internal use are fine — but the
name and logo are trademarked and not licensed. Internally that barely matters;
still, keep the interface detector-agnostic. **Hard-disable its face recognition**
(§10); keep its LPR.

**The uplink agent (Go) is the piece we write:** enrolment via fleet provisioning,
device shadow, segment index, priority upload queue (incident clips pre-empt
everything — the recorder is itself a theft target), on-demand retrieval, and
health telemetry.

**OS:** Debian 13 + systemd + podman. **A/B image updates (RAUC or Mender) before
store 50.** A bad update that stops recording across 150 stores at once is the
worst day this company has ever had.

---

## 7. AWS

| Need | Service |
|---|---|
| Device identity, shadows, fleet OTA | **IoT Core + Greengrass v2** (Panorama is EOL 31 May 2026; Greengrass v1 EOL 7 Oct 2026 — v2 only) |
| Incident clips, keyframes, exports | **S3** + lifecycle |
| Evidence holds | **S3 Object Lock** + SHA-256 per object |
| Live view signalling / TURN | **KVS WebRTC** |
| Playback delivery | **CloudFront** + signed URLs |
| Events | IoT Rules → EventBridge → Lambda |
| Console DB | **Aurora Serverless v2 (Postgres)** — single tenant, no RLS needed |
| Alerts | SNS → push/SMS/email |

---

## 8. Fleet operations is the actual product

At one store, a VMS is a video player. At 150, **the console is the product** — and
this is where an internal build beats a bought one, because we can tune it to
exactly how we work.

The screen that pays for the project:

- Every camera across 150 stores, up or down, with time-since-last-frame
- **Computed retention days per store**, flagged before it drops under target
- Disk SMART warnings *before* failure, so a drive ships with the next scheduled visit
- Appliance tamper, power-loss and uplink state
- Firmware and OS version drift across the fleet
- **Which faults are remotely fixable and which need a truck**

That last line is the economics. At 150 stores, if better diagnosis avoids 100 site
visits a year at ~$150, that is **$15,000/year** — a fifth of the platform's entire
saving, from one screen. Every fault resolved from a desk is a fault that did not
cost a morning's drive.

Build this in **Phase 2**, not Phase 6.

---

## 9. Data contracts — write these first

Pure modules in `src/lib/`, no I/O, no React, each testable with no camera and no
database.

```ts
type SegmentTier = 'edge' | 's3' | 'glacier' | 'gap';

interface Segment {
  cameraId: string;
  startUtc: string;          // ISO 8601, always UTC
  endUtc: string;
  tier: SegmentTier;
  key: string | null;        // null when 'edge' or 'gap'
  bytes: number | null;      // null when 'gap' — NOT 0
  codec: 'h264' | 'h265';
  bitrateKbps: number;       // carries its unit
  gapReason?: 'camera_offline' | 'appliance_offline' | 'disk_full'
            | 'evicted_by_retention' | 'tampered' | 'unknown';
}

interface Detection {
  cameraId: string;
  atUtc: string;
  kind: 'motion' | 'person' | 'vehicle' | 'plate';
  confidence: number;                            // 0–1, always shown
  plate?: { text: string; confidence: number };  // never auto-matched to a tenant
  clipSegment: Segment | null;
}
```

Three properties are load-bearing:

- **`gap` carries a reason.** The timeline shows a hatched band reading *"camera
  offline 02:10–06:44"*, never quiet grey that reads as "nothing happened." During
  a break-in investigation those are opposite answers.
- **`bytes: null` on a gap, not `0`.** Outages must not sum as free footage.
- **A plate read is a measurement, not an identification.** Confidence is always
  shown and a human confirms any match to a tenant. One wrong auto-match in an
  eviction dispute is a lawsuit — and internal use does not change that.

---

## 10. Legal

Internal use removes the product-liability surface. It does **not** remove these,
because we are still recording the public and our stores' tenants.

| Gate | Default |
|---|---|
| **Face recognition** | **Do not ship.** Illinois BIPA: $1,000–5,000 per violation, $1.8bn in cumulative settlements. Disable Frigate's. |
| **LPR** | Ship, human in the loop. A plate is not a biometric and this is our own gate on our own property — a materially safer posture than faces. Never auto-act on a read. |
| **Audio** | Off, per-camera opt-in, geo-gated. 11 states + DC require all-party consent — **including Florida**. |
| **Signage** | Required at commissioning. An install step the technician cannot skip. |
| **Footage requests** | Written policy before the first one: who may request, what is logged, what needs a subpoena. Police and tenant-dispute requests will come. |
| **New cameras** | NDAA-compliant only. Never buy more Hikvision, Dahua, Huawei, Hytera or ZTE. |

---

## 11. Build order

Gated on §2.3. Each phase exits on real hardware in a real store.

**Phase 0 — Survey the estate (1–2 weeks, no code).** The commercial decision is
made; this establishes what it costs. For a representative sample of stores, and
then for all 150: **are the cameras on the NVR's built-in PoE ports or an external
switch (§5.2)?** Camera models, firmware versions, and whether the documented RTSP
URL works with existing credentials (§5.1). Real bitrate per camera type.
*Exit: a per-store topology inventory, and a switch-and-labour budget that is
either near zero or $60–120k. Nothing gets ordered before this.*

**Phase 1 — One appliance records (5–6 weeks).** Templated RTSP onboarding (§5.1,
ONVIF discovery later), dual-NIC camera segment, stream-copy segmenting, ring
buffer, retention arithmetic with a harness, local UI. No cloud. *Exit: 30 real
Hikvision cameras at a real store recording 7 days; pull power and network
repeatedly and lose nothing but the outage seconds, with a correct `gap`.*

**Phase 2 — Fleet console (4–5 weeks).** IoT fleet provisioning, shadows, index
sync, health telemetry, the §8 screen, OTA. *Exit: diagnose a camera fault at a
store 200 miles away without SSH.*

**Phase 3 — Parallel run (4 weeks + 30 days observation).** §5.4, at one store,
beside OpenEye. *Exit: 30 days of segment-by-segment agreement with the NVR.*

**Phase 4 — See it (5–6 weeks).** WebRTC live view, timeline with explicit gaps,
on-demand retrieval, priority incident upload, clip export with hash + Object Lock.
*Exit: a store manager finds a 30-second event from three days ago in under a
minute and emails it to police.*

**Phase 5 — Alerts and LPR (4–5 weeks).** Detector on perimeter/gate, zones,
schedules, after-hours person/vehicle, LPR, notifications. *Exit: false-alert rate
low enough that we keep notifications on for a week.*

**Phase 6 — Roll out.** Store by store, per §5.4, never more than a handful in
flight. Decommission OpenEye per store only after its 30-day fallback window.
Camera replacement rides along at whatever pace the budget allows (§1.2).

**Realistic: 6–9 months to the first authoritative store**, then 6–12 months of
rollout at a deliberate pace.

---

## 12. Open decisions

1. **Are the cameras on NVR PoE ports or external switches?** (§5.2.) Answer this
   first — it is worth $60–120k plus 450–900 hours, and it may differ by store.
2. **Who is on call for this?** We already carry the pager for cameras; someone
   must own the *software*. If that person does not exist, §2.2's ops number is
   wrong and the case weakens.
3. **Does the estate stay at 150 stores, or grow?** Growth strengthens the build —
   licenses scale linearly, engineering does not.
4. **Retention target.** 30 days sizes every disk. Smart-codec cameras (§1.2) may
   buy 60 for free.
5. **Do our stores' gate systems matter enough to integrate?** (§3.) Only worth it
   after Phase 5, and only for systems we actually run.
6. **What happens to the OpenEye recorders we pull?** 150 NDAA-clean NVRs have
   resale or spares value. Do not skip this.
7. **Camera replacement pace.** The appliance makes it incremental (§1.2), so this
   becomes a pure budget question rather than a technical one.

---

## 13. What this deliberately does not do

- **Not a product.** No tenants, no billing, no external customers, no sales.
- **No face recognition.** §10.
- **No cloud-continuous recording.** $35–70k/month for this estate.
- **No auto-matching a plate to a tenant.** A human confirms.
- **No big-bang migration.** §5.4, or not at all.
- **No ONVIF-first onboarding.** §5.1 — it would invent a 3,450-camera config job.
- **No PoE in the appliance.** §6 — it is the mistake we are currently paying for.
- **No more Hikvision.** §10.

---

## Sources

- [CISA KEV listing of CVE-2017-7921](https://netcrook.com/hikvision-camera-vulnerabilities-privilege-escalation-2026/) — added 5 March 2026, actively exploited
- [Can I still use my existing Hikvision system after the 2026 FCC changes?](https://www.clevelandsecuritycameras.com/post/can-i-still-use-my-existing-hikvision-system-after-the-2026-fcc-changes) — importation/marketing ban, not a removal mandate for private commercial use
- [FCC closes the remaining Hikvision loopholes](https://blog.camerasecuritynow.com/2026/01/13/hikvision-dahua-cameras-critical-2026-update-plan-ahead-now/) — Oct 2025 retroactive revocation; parts and firmware supply
- [Replacing Hikvision — NDAA migration sequencing](https://www.coram.ai/post/replacing-hikvision-a-painless-guide-to-ndaa-compliance)
- [NDAA Section 889 compliance](https://tec-tel.com/resources/ndaa-section-889-camera-compliance) and [compliant brand list](https://security.getuniqcli.com/guides/ndaa-compliant-camera-brands)
- [Amazon Kinesis Video Streams pricing](https://aws.amazon.com/kinesis/video-streams/pricing/)
- [AWS Panorama end of support](https://docs.aws.amazon.com/panorama/latest/dev/panorama-end-of-support.html) — 31 May 2026
- [AWS IoT Greengrass v2 fleet provisioning](https://docs.aws.amazon.com/greengrass/v2/developerguide/fleet-provisioning.html); [v2.17](https://aws.amazon.com/about-aws/whats-new/2026/04/aws-iot-greengrass-v217/) — v1 EOL 7 Oct 2026
- [Frigate MIT licence](https://github.com/blakeblackshear/frigate/blob/dev/LICENSE), [trademark policy](https://github.com/blakeblackshear/frigate/blob/dev/TRADEMARK.md), [video pipeline](https://docs.frigate.video/frigate/video_pipeline/)
- [Hailo-8 vs Coral for NVR workloads](https://botmonster.com/smart-home/hailo-8-vs-coral-tpu-frigate-nvr-comparison/)
- [Audio surveillance consent by state](https://www.upcounsel.com/audio-surveillance-laws-by-state/) — 11 all-party states + DC, including Florida
- [Surveillance compliance checklist — BIPA](https://www.forasoft.com/learn/video-surveillance/articles-vms/surveillance-compliance-checklist)
