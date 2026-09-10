# AWS Cost and Automatic Camera Onboarding

> Companion to [`camera-service-plan-2026-09-10.md`](camera-service-plan-2026-09-10.md).
> Two questions answered concretely: **what AWS costs**, and **how cameras
> connect themselves**. Estate: 150 stores, ~3,450 cameras, edge-first recording.

---

## Part 1 — What AWS costs

### 1.1 Correction to the plan

The plan used **$1.38/camera/month** as AWS cost of goods — a generic per-camera
placeholder. Itemised properly below, the real figure is **$0.25–0.46**. The
placeholder was 3–5× too high, and it was used in the build-vs-buy case, so:

| | Plan said | Actual |
|---|---|---|
| AWS per year | $57,132 | **$10,400–19,200** |
| License cost avoided | $134,550 | $134,550 |
| **Annual saving from self-hosting** | $77,418 | **$115,000–124,000** |

The build case is materially stronger than the plan states.

### 1.2 Assumptions

State these, because they drive everything. **Local disk is the archive; AWS
holds the index, incident clips and keyframes only.**

| | |
|---|---|
| Stores / cameras | 150 / 3,450 (avg 23) |
| Incident clips | 15/camera/day × 30 s @ 2 Mbps = 3.4 GB/camera/month |
| Keyframes | 1/minute @ 40 KB = 1.7 GB/camera/month |
| **Uploaded** | **~6 GB/camera/month → 20.7 TB/month fleet-wide** |
| Cloud retention | 30 days |
| Region | us-east-1 |

### 1.3 The monthly bill

| Line | Basis | Monthly |
|---|---|---|
| S3 storage | 20,700 GB × $0.023 | **$476** |
| S3 PUT requests | ~4.0M × $0.005/1,000 | $20 |
| S3 GET requests | ~1M | $1 |
| CloudFront egress | 1 TB review traffic × $0.085 | $85 |
| IoT Core messages | 6.48M × $1.00/M | $7 |
| IoT connectivity | 6.48M min × $0.08/M | $1 |
| IoT shadow + registry | ~2M ops × $1.25/M | $3 |
| IoT rules | 6.48M × $0.15/M | $1 |
| Greengrass | 150 devices × ~$0.16 *(verify current rate)* | $24 |
| KVS WebRTC signalling | 150 channels × $0.03 | $5 |
| KVS WebRTC TURN + messages | variable — see §1.5 | $50 |
| Postgres (RDS t4g.medium, or Aurora SLS v2 ~1 ACU) | | $90 |
| Lambda + console hosting (Fargate ×2) | | $50 |
| CloudWatch logs, metrics, alarms | ~50 GB ingest | $45 |
| Route 53, ACM, KMS | | $10 |
| **Total** | | **~$865/month** |

**≈ $10,400/year. $0.25 per camera per month.**

**Heavier scenario** — 3× the events, 90-day retention with lifecycle to Glacier
Instant Retrieval, 3 TB of review traffic: **~$1,600/month, $19,200/year,
$0.46/camera.** Budget somewhere in that band; it is not a number that will
surprise you.

### 1.4 Four design choices worth real money

Each of these is a decision in the appliance, not a negotiation with AWS:

| Choice | Wrong way | Right way | Saves |
|---|---|---|---|
| **Keyframe storage** | One S3 object per keyframe → 149M PUTs | Bundle an hour of keyframes per camera into one object → 2.5M PUTs | **$725/mo** |
| **Telemetry rate** | 1 message per 10 s per appliance | 1 batched message per minute | $38/mo |
| **WebRTC channels** | One signalling channel per camera (3,450) | One per appliance, multiplexed (150) | $99/mo |
| **Store credentials** | AWS Secrets Manager, 150 secrets × $0.40 | SSM Parameter Store standard parameters | $60/mo |

Together that is **~$920/month — more than the entire rest of the bill.** Get
these right in Phase 1 and the platform costs a rounding error. Get them wrong
and AWS costs double what it should for no benefit.

### 1.5 The one line to watch

**KVS WebRTC TURN minutes.** Live view is peer-to-peer between the viewer's
browser and the appliance, which costs nothing — but when NAT traversal fails it
relays through TURN, which bills per streaming minute. If a store's firewall
blocks direct connections, every minute of live view at that store becomes a
billed relay minute.

Budget $50/month, **alarm on it at $150**, and if it climbs, fix the network at
the offending stores rather than paying the relay. This is the only line in the
bill with an unbounded shape.

### 1.6 What AWS is not

Do not confuse the AWS bill with the cost of the system:

| | |
|---|---|
| AWS, ongoing | **$10,400–19,200/year** |
| 150 appliances @ $900–1,400 | $135,000–210,000 one-time — but **replaces NVRs being bought anyway** |
| PoE switches, *if* §5.2 requires them | $60,000–120,000 one-time |
| Re-cabling labour, *if* required | 450–900 hours |
| Build | 6–9 months |
| Ongoing software ops | ~0.25–0.5 FTE |

**AWS is the cheapest part of this project by an order of magnitude.** The
capital question is switches and appliances; the real question is engineering
time. Nobody should ever be surprised by the cloud bill here.

---

## Part 2 — How cameras connect automatically

Goal: **plug in an appliance, and the store's cameras appear by themselves.**
Nobody types 3,450 RTSP URLs.

### 2.1 Layer 0 — the appliance enrols itself

1. **One OS image for all 150 stores**, carrying a shared *claim* certificate.
2. First boot: AWS IoT **fleet provisioning**. The appliance generates its own
   keypair and CSR; AWS issues a unique X.509 certificate. The claim cert only
   ever buys the right to ask for a real one.
3. Thing name derives from the hardware serial. A pre-registered
   serial → store table assigns it to a store.
4. It pulls its configuration from its **device shadow** and starts.

**Nobody types a key.** Ship the box, plug it in, it appears in the console.
Greengrass v2's fleet provisioning supports TPM 2.0 if we want hardware-bound
identity later.

### 2.2 Layer 1 — find the cameras

Run all four concurrently on the camera-side NIC and merge the results. No single
method finds everything.

| Method | Transport | Finds | Why it matters here |
|---|---|---|---|
| **Hikvision SADP** | UDP multicast, **port 37020** | Hikvision cameras **even with ONVIF disabled** — model, serial, firmware, IP, MAC | **The one that matters for our estate.** ONVIF is off by default since firmware v5.5.0; SADP still answers. Open-source implementations exist to work from. |
| **ONVIF WS-Discovery** | UDP 3702, 239.255.255.250 | Any ONVIF-enabled camera | For the NDAA-compliant cameras arriving over the next 12–24 months |
| **ARP sweep + port probe** | 554, 80, 443, 8000 | Everything else, including silent cameras | The backstop that always works |
| **MAC OUI lookup** | — | Vendor, from the MAC prefix | Identifies a camera that answers nothing at all |

> **Implementation note on SADP:** published sources disagree on the multicast
> group — some say `239.255.255.230`, others `239.255.255.250`, both on port
> 37020. **Probe both.** Verify against a real camera in Phase 0 and write down
> what actually answered.

### 2.3 Layer 2 — identify and template

1. Vendor from SADP or MAC OUI → pick the RTSP URL template.
   Hikvision: `rtsp://<user>:<pass>@<ip>:554/Streaming/Channels/101` (main),
   `/102` (substream). Pattern is `/Streaming/Channels/CCS`.
2. Try the store's credential list, delivered via device shadow from **SSM
   Parameter Store**. Never baked into the image.
3. `ffprobe` the stream: resolution, codec, frame rate, **actual** bitrate.
4. Auto-assign: main stream → recording, substream → detection.

Recording the *measured* bitrate matters — it is the input to the retention
calculation, and a camera whose real output is 4 Mbps rather than the assumed 2
silently halves that store's retention.

### 2.4 Layer 3 — identity that survives

> **A camera's identity is its MAC address and serial number. Never its IP.**

DHCP leases move, cameras reboot onto new addresses, and a store's whole subnet
can be renumbered during the PoE migration (§5.2 of the plan). Key on MAC and
serial and a camera that moves re-attaches itself silently. Key on IP and you
re-onboard the estate every time anything changes — 3,450 times.

This single rule is the difference between onboarding that works and onboarding
that generates support tickets forever.

### 2.5 Layer 4 — adopt

- A new camera enters the console as **`discovered`**, everything pre-filled.
- One click to name it and assign a zone — or **auto-adopt** when the MAC matches
  a manifest uploaded before the install.
- **Replacement flow:** an unknown MAC appearing where a known camera used to be
  prompts *"replacement for Camera 14?"*. Accept, and it inherits the name, zone,
  retention and detection config.

That last one is worth building early. It is what makes the 12–24 month Hikvision
refresh operationally free — swapping a camera becomes a click, not a
reconfiguration.

### 2.6 Layer 5 — keep watching

- Rescan every 5 minutes.
- Known camera missing beyond threshold → write a `gap` with reason
  `camera_offline`, raise an alert.
- Unknown camera appears → discovered queue.
- **Known MAC at a new IP → update silently.** Not an alert. This will happen
  constantly and must never generate noise.

### 2.7 Security note

**SADP has a documented history of abuse for DDoS reflection and amplification.**
It is a UDP multicast protocol that answers strangers. That is one more reason the
cameras sit on an isolated segment behind the dual-NIC appliance with no route off
the store network — the discovery traffic should never be reachable from outside,
and neither should the cameras.

---

## Sources

- [AWS IoT Core pricing](https://aws.amazon.com/iot-core/pricing/) — $1.00/M messages, $0.08/M connection-minutes, $1.25/M shadow+registry ops, $0.15/M rules
- [Amazon Kinesis Video Streams pricing](https://aws.amazon.com/kinesis/video-streams/pricing/) — WebRTC signalling channels from $0.03/month, TURN billed per streaming minute
- [AWS IoT Greengrass v2 fleet provisioning](https://docs.aws.amazon.com/greengrass/v2/developerguide/fleet-provisioning.html) — claim certificates, TPM 2.0
- [Hikvision RTSP URL patterns](https://www.cctvmanuals.com/2026/07/08/hikvision-ip-camera-rtsp-url/) — `/Streaming/Channels/CCS`
- [Enabling ONVIF on Hikvision cameras](https://support.digital-watchdog.com/hc/en-us/articles/43283500720916-Enabling-ONVIF-On-Hikvision-Cameras) — disabled by default since firmware v5.5.0
- [SADP protocol analysis](https://www.oreateai.com/blog/analysis-of-hikvision-sadp-protocol-principles-and-sdk-technology/b10d32909e9dfea04b2175e485b48dac) and [hikvision-tooling](https://github.com/cameronnewman/hikvision-tooling) — UDP multicast discovery, port 37020, MAC/serial/firmware in the response
- [SADP DDoS reflection amplification](https://www.corero.com/hikvision-sadp-ddos-reflection-amplification/)
- [WS-Discovery](https://en.wikipedia.org/wiki/WS-Discovery) — UDP 3702, 239.255.255.250
