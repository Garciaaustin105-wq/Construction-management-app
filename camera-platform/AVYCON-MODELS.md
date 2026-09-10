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
