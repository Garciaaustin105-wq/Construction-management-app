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

## Storage for a 16-camera store

Modelled as a real mix rather than 16 identical cameras, all AVYCON H.265+ VBR:
10 × 4MP corridor turrets, 4 × 5MP perimeter bullets, 1 × 5MP LPR gate,
1 × 8MP panoramic aisle.

| Scenario | Total | GB/day | 30 days |
|---|---|---|---|
| Optimistic — smart codec working, quiet site | 22 Mbps | 240 | 7.2 TB |
| **Expected** — H.265+ VBR, mixed roles | **32 Mbps** | **346** | **10.4 TB** |
| Conservative — busy site, smart codec less effective | 44 Mbps | 475 | 14.3 TB |
| Bad case — someone leaves a camera on CBR | 66 Mbps | 708 | 21.2 TB |

Days achieved **at 85% fill** — a ring buffer should never run to the rim:

| Disk | Usable @85% | Optimistic | Expected | Conservative | Bad case |
|---|---|---|---|---|---|
| 2× 8 TB | 12.2 TB | 51 d | 35 d | **26 d** | 17 d |
| 2× 10 TB | 15.3 TB | 64 d | 44 d | 32 d | 22 d |
| **2× 12 TB** | **18.4 TB** | **77 d** | **53 d** | **39 d** | **26 d** |
| 2× 16 TB | 24.5 TB | 102 d | 71 d | 52 d | 35 d |

### Buy 2× 12 TB

It holds 30 days in every scenario except a camera left on CBR, and 53 days in
the expected one. **2× 8 TB fails the conservative case at 26 days** — and the
conservative case is not pessimistic, it is what a busy site in summer looks
like. The step from 8 TB to 12 TB is roughly $120 per store against a 30-day
promise you would otherwise miss and only discover when someone needed day 28.

### Assign whole cameras to drives — do not stripe

With two drives the instinct is to span or stripe them into one volume. **Don't.**
Striped, one drive failure loses every camera's entire history. Assigned — say
cameras 1–8 on drive A, 9–16 on drive B — the same failure loses eight cameras
completely and leaves the other eight fully intact.

Neither is good, but bounded beats total: an investigation with half the cameras
is still an investigation, whereas a site with a 30-day hole across every camera
has nothing. And since the cloud already holds incident clips and keyframes
(§ the plan), the drive is the bulk archive, not the only copy of what mattered.

RAID-1 would survive the failure but halves capacity — 2× 12 TB becomes 10.8 TB
usable, below even the 2× 8 TB figure above. Not worth it here.

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
