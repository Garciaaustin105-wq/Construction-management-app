# Field notes — assumptions awaiting a measurement

Running record of what this project currently *assumes* versus what has been
*measured*. Every open item below is answerable with hardware on a bench and
`agent/camctl.mjs`. Record answers here rather than in a conversation.

Last updated 2026-09-10. Nothing in the Measured column yet.

| # | Assumption in use | Where it bites | How to answer | Measured |
|---|---|---|---|---|
| 1 | **Cameras stream 2 Mbps** | Every storage, retention and AWS figure written to date | `camctl probe <ip> --seconds 30` | — |
| 1b | Cameras are 4MP on **H.265+ VBR** (not H.264, not CBR) | 12x storage swing — see below | `camctl probe` reports codec; camera web UI reports rate control | — |
| 2 | SADP multicast group is `239.255.255.250` **or** `239.255.255.230`, UDP 37020 | Whether discovery finds Hikvision cameras at all | `camctl discover <cidr> --raw-dir ./sadp-raw`, keep the files | — |
| 3 | Hikvision RTSP path is `/Streaming/Channels/101` and `/102` | Whether onboarding works without touching each camera | `camctl probe` succeeding at all | — |
| 4 | Cameras sit on an external PoE switch, not the NVR's built-in PoE ports | $60–120k of switches and 450–900 hours, across 150 stores | Look at one rack | — |
| 5 | 16 TB per appliance gives 30 days | Appliance BOM | Falls out of #1 | — |

## Why #1 is the one that matters

Every disk-sizing table in `docs/camera-service-plan-2026-09-10.md` assumes
2 Mbps per camera. Storage-facility corridors are static scenes, and cameras with
smart codecs (Zipstream, WiseStream, dynamic GOP) commonly average **half to a
quarter** of their configured bitrate on an empty corridor.

If the real figure is nearer 1 Mbps, the 16 TB in the plan is closer to 8 —
across 150 appliances that is a materially different bill of materials. The
number moves the hardware order, so it should be measured before anything is
ordered.

Note that ffprobe usually reports **no** bitrate for RTSP, and a camera's
*configured* bitrate is a setting rather than a measurement. `camctl probe`
captures for 30 seconds and weighs the file for exactly this reason.

## Resolution is not what fills the disk — rate control is

4MP is the right resolution for these sites: enough to read a face in a corridor
or a plate at a gate, without 8MP's bitrate. But megapixels do not size a disk.
**A 4MP and an 8MP camera both set to 2 Mbps produce byte-identical recordings.**
What varies is the bitrate needed for a given quality, and — far more — how the
camera is configured to spend it.

Hikvision's own guidance for 2688×1520 at 25 fps H.265+ is **max 4096 kbps,
average 2048 kbps**. The 2 Mbps used throughout this project is therefore the
vendor's recommended *average* for exactly this resolution, which makes the
existing figures defensible. It is also the best case.

Same 4MP camera, 23 per store, 30 days:

| Encoder and rate control | Avg | GB/day/cam | Per store |
|---|---|---|---|
| H.265+ VBR, static corridor, smart codec working | 0.5–1 Mbps | 5.4–10.8 | **3.7–7.5 TB** |
| H.265+ VBR — Hikvision's recommended average | 2 Mbps | 21.6 | **14.9 TB** |
| H.265 **CBR** pinned at max | 4 Mbps | 43.2 | **29.8 TB** |
| H.264 VBR | 3–4 Mbps | 32–43 | **22–30 TB** |
| H.264 **CBR** | ~6 Mbps | 64.8 | **44.7 TB** |

**A 12x spread on identical cameras**, driven entirely by codec and rate control.
That is 2× 8 TB versus 4× 16 TB per appliance — across 150 stores, a materially
different hardware order for hardware that records the same pictures.

### 16 cameras on H.264, worked through

The small-store case. Computed with `camctl size --cameras 16`, not by hand:

| H.264 profile | Avg | GB/day/cam | Fleet GB/day | Disk for 30 days |
|---|---|---|---|---|
| VBR, smart codec, static corridor | 2 Mbps | 21.6 | 346 | **10.4 TB** |
| VBR, typical | 3 Mbps | 32.4 | 518 | **15.6 TB** |
| VBR, higher quality | 4 Mbps | 43.2 | 691 | **20.7 TB** |
| CBR pinned at max | 6 Mbps | 64.8 | 1,037 | **31.1 TB** |

Retention actually achieved (raw disk, 10% filesystem overhead):

| Raw disk | Usable | 2 Mbps | 3 Mbps | 4 Mbps | 6 Mbps |
|---|---|---|---|---|---|
| 2× 8 TB | 14.4 TB | 42 d | 28 d | 21 d | 14 d |
| 2× 12 TB | 21.6 TB | 63 d | 42 d | 31 d | 21 d |
| 2× 16 TB | 28.8 TB | 83 d | 56 d | 42 d | 28 d |
| 4× 12 TB | 43.2 TB | 125 d | 83 d | 63 d | 42 d |
| 4× 16 TB | 57.6 TB | 167 d | 111 d | 83 d | 56 d |

**2× 8 TB does not reach 30 days on H.264 at any realistic quality** — it gives
28 days at 3 Mbps and 14 at CBR. The smallest 16-camera H.264 appliance that
clears 30 days with margin is **2× 12 TB**, and that only at 3 Mbps or better.

Switching the same 16 cameras to H.265+ (roughly half the bitrate for equal
quality), 30-day target:

| | H.264 | H.265+ | Saved per store |
|---|---|---|---|
| Typical | 15.6 TB | 7.8 TB | 7.8 TB |
| Higher quality | 20.7 TB | 10.4 TB | 10.4 TB |
| CBR at max | 31.1 TB | 15.6 TB | 15.6 TB |

On H.265+ a 16-camera store fits comfortably in **2× 8 TB**. On H.264 it needs
2× 12 TB or 2× 16 TB. That one setting is the difference between the cheapest
appliance in the range and the next one up — before any hardware is bought.

### What to check, and it is free

1. **H.265+ or H.264?** Older 4MP models support only H.264 and cost roughly
   double the storage. Worth knowing which stores have them before ordering disk.
2. **VBR or CBR?** CBR pins every camera at max whether the corridor is empty or
   not. VBR with a sensible max is the single largest storage lever in the whole
   project, and it is a settings change rather than a purchase.
3. **Smart codec on?** On a static corridor it takes the average well below the
   VBR figure.

Getting all three right can move a store from 30 TB to under 8 TB. Do this before
the appliance BOM is fixed, not after.

`camctl probe` reports resolution, codec and *measured* bitrate together, so it
answers this per camera rather than per datasheet.

## Why #2 needs the raw captures

SADP is reverse-engineered, not published, and sources disagree on the multicast
group. `camctl` probes both and `--raw-dir` writes every response to disk. Those
captures are the difference between a parser that is a careful guess and one that
is a known quantity — and they will show whether real cameras report fields the
parser does not yet read.
