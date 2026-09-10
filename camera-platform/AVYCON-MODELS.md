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

### Build: dual 8 TB — and the budget the appliance enforces

**Dual 8 TB, as used today.** 16 TB raw → 14.4 TB after filesystem overhead →
**12.2 TB at 85% fill**, which is where a ring buffer should live.

The retention target is not a number to pick — it is **whatever the current NVR
delivers on this hardware**, established by the parallel run. What the budget
contract does is make that figure visible and defend it: once you know what
you have, it tells you the moment a camera drifts and starts eroding it.

For reference, at a 30-day figure that works out to 2,353 kbps per camera:

| Config | Avg | Utilisation | Projected |
|---|---|---|---|
| **4MP @ 15 fps** | 1.3 Mbps | 55% | **54 days** |
| 4MP @ 20 fps | 1.6 Mbps | 68% | 44 days |
| 4MP @ 30 fps | 2.0 Mbps | 85% | 35 days |
| 4MP @ 30 fps CBR | 4.0 Mbps | 170% | **18 days — misses** |

**Dual 8 TB holds 30 days comfortably at 4MP/15fps, with 54 days of runway.**
The ceiling is 2.35 Mbps per camera; the recommended config sits at 1.3.

What it does not have is slack for the estimate being wrong. On 2× 12 TB an
unmeasured bitrate running high would have been absorbed. Here it is not — so
the encoder profile stops being advice and becomes a build requirement, and the
appliance has to enforce it rather than report on it afterwards.

That is what `contracts/budget.ts` is for:

- `computePerCameraBudget(30, usableBytes, 16)` → the 2,353 kbps ceiling.
- `checkAgainstBudget(measured, budget)` → fleet utilisation, projected days, and
  **which cameras are over their share, named and ranked worst first**.
- It **refuses** to project at all if any camera is unmeasured — with no spare
  disk, the unmeasured one may be exactly the one eating the margin, and a
  projection that silently skipped it would read as reassuring while being wrong.

One useful subtlety it encodes: a camera over its equal share does **not** mean
the target is missed. Some cameras running hot is fine while others run cold —
fleet utilisation decides whether 30 days holds, and the per-camera list is for
finding *which one changed*. The gate will always be the busiest camera on site;
that is not a fault, it is a gate.

### Why 2× 12 TB was the earlier recommendation

It would have given 53 days at 2 Mbps and still cleared 30 at 3 Mbps — insurance
against a bitrate nobody has measured yet, for about $120 a store.

That insurance is not being bought, which is a reasonable call at 4MP/15fps: the
recommended config uses 55% of the budget, so there is room for the measurement
to come in nearly twice as high as modelled and still hold 30 days. **It does
mean the first `camctl probe` on a real camera stops being a nice-to-have.**
Measure before the fleet is configured, not after.

### The current configuration — 5MP @ 30 fps on dual 8 TB

**This is what the estate runs today, not a target.** Recording it as the
baseline, because the acceptance bar for our appliance is *"at least as good as
the NVR it replaces on the same cameras and the same disk"* — not a round number
I picked.

At a generic untuned 5MP @ 30 fps H.265+ VBR figure of ~2,500 kbps, 16 cameras
on 2× 8 TB held to 85% fill gives about **28 days**. Whether that matches what
OpenEye actually delivers today is unknown and worth knowing — see below.

| If it measures at | Days on 2× 8 TB |
|---|---|
| 2,000 kbps | 35.4 |
| 2,200 kbps | 32.2 |
| **2,500 kbps — untuned estimate** | **28.3** |
| 2,800 kbps | 25.3 |
| 3,200 kbps | 22.1 |

#### The parallel run answers this for free

The migration already runs our appliance beside the existing NVR on the same
cameras for 30 days (see the plan, §5.4). That comparison was designed to prove
nothing is lost — **it also measures retention on both systems against identical
input**, which is a far better answer than any estimate here. If ours holds as
long or longer, the question is closed.

#### Four settings that would extend it, if you want more

Not a rescue, just headroom. Nothing here is required for the appliance to match
what you have.

1. **I-frame interval (GOP).** The one most often left wrong. Many cameras
   default to a GOP of 1× the frame rate — an I-frame every second. Setting it to
   **2× the frame rate (60 at 30 fps)** typically takes **15–25%** off with no
   visible loss on a static corridor. On its own that is roughly 28 days → 34.
2. **H.265+ / smart codec on.** If it is off, every figure above is wrong anyway.
3. **VBR max cap** near 4096 rather than 8192. VBR spends to its cap when a scene
   gets busy; a lower cap bounds the worst hour without touching the quiet ones.
4. **3D noise reduction on.** Sensor noise is expensive to encode and worst at
   night under IR — exactly when a corridor is least busy and should be cheapest.
   DNR off is why night bitrate sometimes exceeds day.

Check any configuration:

```
camctl budget --cameras 16 --disk-tb 16 --days 28 --kbps 2500
```

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
