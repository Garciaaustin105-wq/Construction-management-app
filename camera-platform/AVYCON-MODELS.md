# AVYCON — camera selection

What is confirmed from distributor listings, what the model numbers mean, and
what still has to be measured. **AVYCON's own site, and two distributor sites
carrying the datasheets, are blocked by this environment's egress proxy** — so
everything below comes from distributor product listings, and the gaps at the
bottom are real gaps, not laziness.

## Reading the model numbers

```
AVC - NPB 51 M 50 - W
      │   │  │  │   └─ colour: -B black, -G grey, default white
      │   │  │  └───── lens: F28 = 2.8mm fixed; M50 = 5–50mm motorised
      │   │  └──────── F fixed lens / M motorised / AVT varifocal
      │   └─────────── sensor: 41 = 4MP · 51 = 5MP · 81 = 8MP/4K · 321 = 32MP multi-sensor
      └─────────────── series and form factor (B bullet, E/S turret, P panoramic, CMS multi-sensor)
```

Once you have this, a price list reads itself.

## Confirmed across the range

- **H.265+ is supported.** This is the answer to the open question in
  `FIELD-NOTES.md` — and it is the 2x storage lever. It roughly halves the disk
  versus H.264 for the same picture.
- **Triple stream** on several models. Architecturally this matters more than it
  sounds — see below.
- **ONVIF** on every model listed.
- **NDAA Section 889** compliant, with a written statement.
- **MicroSD slot** on the models seen.
- **True WDR**, on-camera AI, and two low-light technologies: *InfiniteColor*
  (white light, full colour at night) and *InfiniteStar* (low-light sensor).

### Triple stream changes what the appliance can do

With two streams, the sub-stream feeds the detector and live view has to share
it or pull the main stream. With three, recording, detection and live view each
get their own — so an operator watching a camera cannot degrade detection on it,
and detection cannot degrade the recording. **Prefer triple-stream models**, and
where a model has only two, expect live view and detection to contend.

## Models identified, by role

| Role | Model | Why |
|---|---|---|
| **Corridors** (the bulk of any facility) | 4MP turret, e.g. `AVC-ENN41AVT` (2.8–12mm motorised, mic) | 4MP is the sweet spot at corridor distances. 8MP doubles the bitrate for detail nobody uses at 20 feet. |
| **Perimeter / exterior** | `AVC-NCB51F28` — 5MP H.265+ bullet, full colour, 2.8mm, triple stream | Full colour at night beats IR mono for identification: IR cannot tell you what colour a coat was. |
| **Gate — LPR** | `AVC-NPB51M50` — 5MP H.265+ LPR bullet, 5–50mm motorised autofocus, 147ft smart IR, audio in/out, alarm in/out | The motorised long lens is what lets you frame a plate at the actual gate distance. **Spec this one by measured distance, not by catalogue.** |
| **Drive aisles / open areas** | `AVC-NPE81F180` — 8MP 180° panoramic turret, full colour, **2-way speaker + siren** | One camera covers an aisle. The speaker and siren are on-camera deterrence for an unmanned site. |
| **Wide open areas** | `AVC-NCMS321M04` — 32MP multi-sensor (4 heads) | One drop, four directions. Counts as four streams for sizing. |
| **Flexible / retrofit** | `AVC-NSE81M` — 8MP turret, 2.7–13.5mm motorised, WDR | When you do not yet know the field of view. |

## Choosing for a storage facility specifically

**Corridors are the whole game and they are the easy case.** Static scene, fixed
distance, controlled lighting. 4MP fixed or short-motorised, H.265+ VBR, smart
codec on. That combination is what puts a store in the cheap end of the disk
range rather than the expensive one.

**Lighting deserves more thought than resolution.** Storage corridors are often
dim and motion-lit. A full-colour-at-night camera identifies a person far better
than a higher-resolution IR one, because clothing colour is the cue people
actually testify to. Spend the money there before spending it on megapixels.

**Only go 8MP where distance demands it** — the gate, a long drive aisle. Every
8MP camera is roughly double the storage of a 4MP one at equal quality.

**Turn the microphones off.** Several models have a built-in mic. Florida is an
all-party-consent state, so audio is off by default and enabled only per-camera
with a deliberate decision behind it.

## Storage for the NVR — 16 identical cameras

Sizing for **our own appliance**, the box replacing the OpenEye NVR. All 16
cameras the same model, AVYCON H.265+ VBR.

| Avg bitrate | GB/day/cam | Store GB/day | Disk for 30 days |
|---|---|---|---|
| 1.5 Mbps — smart codec on a static corridor | 16.2 | 259 | 7.8 TB |
| **2 Mbps — vendor's recommended average for 4MP H.265+** | **21.6** | **346** | **10.4 TB** |
| 2.5 Mbps | 27.0 | 432 | 13.0 TB |
| 3 Mbps — mixed indoor/outdoor, more motion | 32.4 | 518 | 15.6 TB |
| 4 Mbps — CBR, or 5MP+ at quality | 43.2 | 691 | 20.7 TB |

Days achieved **at 85% fill**, which is where a ring buffer should live:

| Disk | Usable | 1.5 Mbps | 2 Mbps | 2.5 Mbps | 3 Mbps | 4 Mbps |
|---|---|---|---|---|---|---|
| 2× 8 TB | 12.2 TB | 47 d | 35 d | 28 d | **24 d** | 18 d |
| 2× 10 TB | 15.3 TB | 59 d | 44 d | 35 d | 30 d | 22 d |
| **2× 12 TB** | **18.4 TB** | **71 d** | **53 d** | **43 d** | **35 d** | **27 d** |
| 2× 16 TB | 24.5 TB | 94 d | 71 d | 57 d | 47 d | 35 d |

### Buy 2× 12 TB

At the expected 2 Mbps it gives **53 days** — comfortably past 30 with room for
the estimate to be wrong. It still clears 30 days at 3 Mbps, and only misses at
a full 4 Mbps.

2× 8 TB works only if the cameras really sit at or below 2 Mbps. At 3 Mbps it
gives 24 days and misses the promise. **The whole gap is about $120 a store** —
cheap insurance against a bitrate nobody has measured yet.

### 4MP is the floor — what going above it costs

Days on the recommended 2× 12 TB, 16 identical cameras, H.265+ VBR:

| Config | Avg | GB/day | 30-day disk | Days on 2× 12 TB |
|---|---|---|---|---|
| **4MP 2688×1520 @ 15 fps** | **1.3 Mbps** | 225 | 6.7 TB | **82 days** |
| 4MP @ 20 fps | 1.6 Mbps | 276 | 8.3 TB | 66 days |
| 4MP @ 30 fps | 2.0 Mbps | 346 | 10.4 TB | 53 days |
| 5MP 2592×1944 @ 15 fps | 1.6 Mbps | 276 | 8.3 TB | 66 days |
| 5MP @ 30 fps | 2.5 Mbps | 432 | 13.0 TB | 43 days |
| 8MP 3840×2160 @ 15 fps | 2.6 Mbps | 449 | 13.5 TB | 41 days |
| 8MP @ 30 fps | 4.0 Mbps | 691 | 20.7 TB | 27 days |

**8MP roughly doubles the disk against 4MP at the same frame rate**, and it is
the only row that misses 30 days on 2× 12 TB.

### Frame rate is a free lever worth as much as resolution

Look down the table rather than across it. **4MP at 15 fps and 8MP at 30 fps
differ by three times on disk** — but the resolution decides whether you can
identify someone, and the frame rate mostly does not.

Storage corridors are people walking. 15 fps is ample to identify a person, read
a face, and follow a route. 30 fps buys smoother playback of motion nobody is
analysing frame by frame. Dropping 30 → 15 fps takes roughly a third off the
bitrate (not half — I-frame overhead does not scale with frame rate), for no loss
in the thing the footage is actually for.

So **4MP at 15 fps meets "at least 4MP quality" and gives 82 days on 2× 12 TB.**
That is the configuration to start from: it satisfies the quality floor, leaves
the largest margin for the bitrate estimate being wrong, and leaves headroom to
raise frame rate later on the cameras that turn out to need it — the gate above
all, where a vehicle crossing the frame is the one genuinely fast subject on the
site.

Do not confuse the two axes. "4MP quality" is a statement about pixels. It does
not imply 30 fps, and paying for 30 fps everywhere is how a 12 TB appliance
quietly becomes a 20 TB one.

### One SKU is worth more than the storage maths

All-identical cameras buy things that never show up in a capacity table:

- **One RTSP path to confirm.** AVYCON's path varies by model; with one model,
  one bench test settles onboarding for every camera you ever install.
- **One spare on the shelf** covers any failure at any store.
- **One config profile** — codec, rate control, substream, schedule — so
  "correctly configured" is a single thing rather than a per-model question.
- **One measured bitrate** turns this table from an estimate into a fact.

The flip side is worth naming: uniformity makes misconfiguration uniform too.
One camera set to CBR in the golden profile puts every store in the 4 Mbps
column at once. That is the argument for the appliance reporting **measured**
bitrate per camera and flagging drift, rather than trusting the profile.

### Assign whole cameras to drives — do not stripe

With two drives the instinct is to span them into one volume. **Don't.** Striped,
one drive failure loses every camera's entire history. Assigned — cameras 1–8 on
drive A, 9–16 on drive B — the same failure loses eight cameras completely and
leaves eight fully intact.

Neither is good, but bounded beats total: an investigation with half the cameras
is still an investigation. And the cloud already holds incident clips and
keyframes, so the drive is the bulk archive rather than the only copy of what
mattered.

RAID-1 survives the failure but halves capacity — 2× 12 TB becomes 10.8 TB
usable, below even the 2× 8 TB row. Not worth it here.

## Still to confirm — on the bench, not from a catalogue

| | Why it matters | How |
|---|---|---|
| **RTSP path per model** | AVYCON documents that it varies by model; `/profile1` and `/profile2` is the first candidate, not the answer | `camctl probe <ip> --vendor avycon --try-all` |
| **Whether ONVIF ships enabled** | Decides whether WS-Discovery finds them out of the box, as Hikvision's does not | `camctl discover` |
| **Default rate control — CBR or VBR** | Worth 2x on storage on its own | Camera web UI |
| **Bitrate range and smart-codec settings** | Sets the achievable floor | Camera web UI, then `camctl probe` to check the claim |
| **Measured bitrate per model, per scene** | The only figure that sizes a disk | `camctl probe --seconds 30` |

Record answers in `FIELD-NOTES.md`. One bench test per model covers every unit
of that model you ever install.

| Model | Main path | Sub path | ONVIF default | Rate control | Measured kbps |
|---|---|---|---|---|---|
| *(fill in)* | | | | | |
