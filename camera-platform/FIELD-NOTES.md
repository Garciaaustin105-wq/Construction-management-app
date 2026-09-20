# Field notes — assumptions awaiting a measurement

Running record of what this project currently *assumes* versus what has been
*measured*. Every open item below is answerable with hardware on a bench and
`agent/camctl.mjs`. Record answers here rather than in a conversation.

Last updated 2026-09-13 — first live bench session done (see "Bench log" below).

| # | Assumption in use | Where it bites | How to answer | Measured |
|---|---|---|---|---|
| 1 | **Cameras stream 2 Mbps** | Every storage, retention and AWS figure written to date | `camctl probe <ip> --seconds 30` | **1797 kbps measured** (ECI-T24F2, 4MP H.264, VBR cap 6144, static bench scene). 2 Mbps assumption holds; see bench log for the caveat |
| 1b | Cameras are 4MP on **H.265+ VBR** (not H.264, not CBR) | 12x storage swing — see below | `camctl probe` reports codec; camera web UI reports rate control | 4MP **H.264** VBR (cap 6144 kbps, VBR lower 32). H.265 IS supported by the camera but not enabled by default — enabling it is the storage lever, it was never free |
| 2 | SADP multicast group is `239.255.255.250` **or** `239.255.255.230`, UDP 37020 | Whether discovery finds Hikvision cameras at all | `camctl discover <cidr> --raw-dir ./sadp-raw`, keep the files | **Works.** Raw replies captured in `sadp-raw/` (activated + factory-reset states) |
| 3 | Hikvision RTSP path is `/Streaming/Channels/101` and `/102` | Whether onboarding works without touching each camera | `camctl probe` succeeding at all | **`/Streaming/Channels/101` confirmed streaming** on ECI-T24F2 (OEM code 1) with H.264. `/102` still assumed for sub |
| 3b | **AVYCON path is `/profile1` and `/profile2`** — vendor says it varies by model | Onboarding every new camera | `camctl probe <ip> --vendor avycon --try-all` | — |
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

## AVYCON — the chosen replacement camera

**NDAA:** AVYCON publishes a formal Section 889 compliance statement — no
prohibited System-on-Chip from covered vendors, and an explicit commitment to
avoid OEM, ODM or JDM relationships with vendors in violation. That is a written
attestation, the same standard applied to Axis, Avigilon and Hanwha, so it
clears the bar the refresh exists to meet. **Keep a copy of the statement on
file** — the point of the refresh is being able to prove compliance, not just
assert it.

**ONVIF:** AVYCON supports ONVIF Profile S. Unlike the Hikvision estate, where
ONVIF is off by default from firmware v5.5.0, new AVYCON cameras should answer
WS-Discovery — so `camctl discover` gets easier as the refresh progresses, not
harder.

**RTSP — the one to pin down.** The documented pattern is `/profile1` (main) and
`/profile2` (sub), but AVYCON's own documentation says **the stream path varies
by model**. `candidatePaths()` therefore holds an ordered list rather than a
single template, and `buildRtspUrl` refuses to return an undocumented convention
as though it were the answer.

Resolve it once per model, on the bench:

```
camctl probe <ip> --vendor avycon --try-all --user U --pass P
```

It walks the candidates, reports which one streams, and tells you to record it
here. **Do this for each AVYCON model before ordering in volume** — one bench
test per model turns the whole fleet's onboarding into a known quantity.

| AVYCON model | Working main path | Working sub path | Codec | Measured bitrate |
|---|---|---|---|---|
| *(fill in from `--try-all`)* | | | | |

**H.265+ is supported across the AVYCON range** — confirmed from distributor
listings. That closes the smart-codec question and puts the cheap end of the disk
table in reach. What is still open is the *default rate control* (CBR or VBR),
which is worth 2x on its own.

Model-by-model selection is in [`AVYCON-MODELS.md`](AVYCON-MODELS.md), including
the model-number scheme and a table to fill in from the bench.

## IP assignment — a Phase A capability, to build with hardware present

Cameras ship on a factory-default address. Sixteen of them arriving on the same
one is the normal case, not an edge case, and the recorder has to be able to
reassign them without anyone opening sixteen web interfaces.

| Mechanism | Works on | Notes |
|---|---|---|
| **SADP** (UDP 37020) | Hikvision and its OEMs | The same protocol already used for discovery can set the address. This is what Hikvision's own SADP tool does. |
| **ONVIF `SetNetworkInterfaces`** | Anything ONVIF-compliant, incl. AVYCON | Requires ONVIF enabled and credentials |

**Do not write this blind.** An address set wrongly puts a camera on a subnet
nothing can reach, and the fix is the reset button on a pole. Capture a real SADP
set-IP exchange alongside the discovery captures (`--raw-dir`) before
implementing.

Open questions for the bench:

| | |
|---|---|
| What is AVYCON's factory default address — static, or DHCP? | — |
| Does SADP set-IP need the camera's current password? | — |
| Does AVYCON ship with ONVIF enabled, so `SetNetworkInterfaces` is available? | — |

## Bench log — 2026-09-13, first live camera

Camera: **ECI-T24F2** (Hikvision OEM, detailOEMCode 1), fw V5.7.1build 220609,
MAC `08-54-11-5d-7e-70`, SN ECI-T24F220230615AAWRAC4440853. Bench: one camera on
a PoE switch, PC cabled to the same switch (wired NIC statically 192.168.1.50/24
at bench time).

### Recorder end-to-end (same session)

The A1 recorder ran against the live camera from `C:\camplat-bench\state\config.json`
(store root `C:\camplat-bench\disk0`, 30 s segments): RTSP → copy-mux → WIP →
sealed `<epochMs>.mp4` → index → `/timeline` → review UI. Findings in the order
they bit:

1. **Audio on (G.711ulaw) produces ZERO recording.** The probe refused and the
   same would hit the recorder: the MP4 copy-mux rejects the audio track. USER
   CORRECTION: **stores run audio ON** — the legally-gated audio-off default
   must become a per-site option, and the recorder must handle a G.711 track
   (transcode or muxer choice) before fleet rollout. Open on the bus
   (bench-audio-on-breaks-copy-mux).
2. **Quality level, not the VBR cap, is the spend knob.** Same camera, same cap
   (6144): quality 60 → 1737 kbps; quality 100 → 5198 kbps. 16 cams on 16 TB:
   ~48 days at 60, **~18 days at 100 — fails the 30-day target**. Fleet recipe:
   VBR, quality ~60, cap 6144. (bench-quality-level-drives-bitrate)
3. **Full ISAPI settings inventory captured** in `bench-isapi/` (device info,
   both streams, image pipeline, smart codec, time). Sub stream 102 = 640×360
   H.264 @ 1024 kbps — right size for the live grid. Some trees 403 for admin.
4. **Camera clock was epoch-0**: NTP mode with no NTP server on the isolated
   LAN. The appliance must SERVE NTP to the cameras — add to commissioning.
5. **ffmpeg `%s` (epoch-seconds segment naming) does not exist on Windows**
   (Microsoft CRT): the recorder crash-looped with `Failed to open segment ''`
   before any recording. Fix: `agent/wipNames.mjs` — the Linux appliance keeps
   `%s` untouched; win32 bench names WIP files `%Y%m%dT%H%M%S` (local wall
   time), parsed by `wipStartMs`/`wipCompare` everywhere. Sealed names and the
   recovery contract are unchanged. (bench-win32-strftime-s-breaks-segment-naming)
6. **Recovery quarantined the 7 stale WIP files** from the crash-loop rather
   than sealing them (it cannot parse bench-format names — item 5's fix covered
   recording, not recovery). They remain in `.quarantine/`. Linux appliances
   never see this; noted as a bench-only wart.
7. **MSE forbids ffmpeg's default fMP4 addressing** (`TFHD base-data-offset
   not allowed by MSE`): the live copy-mux without `+default_base_moof`
   produced a stream ffmpeg itself decoded cleanly (ffprobe + decode exit 0),
   but Chrome rejected the FIRST moof+mdat append — video decode error 3,
   then every later append riding as InvalidStateError. Symptom was a tile
   stuck on a stale status line ("waiting for the first frame…" is never
   updated by the page — stage reporting added to the UI as part of the
   diagnosis). Fix in `liveFfmpegArgs`: `-movflags
   frag_keyframe+empty_moov+default_base_moof` (commit 7c85345). Verified:
   headless Edge tile reaches `live` and holds it. The page's own box
   accumulator, codec extraction and WS transport were all correct.

Store size corrected mid-session: **16 cameras per store** (was 23 in the plan
tables). Retention at the fleet recipe (1737 kbps measured): 2× 8 TB ≈ 48 d.

### Discovery and probe (earlier in the session)

What the session proved, in order:

1. **Discovery works on real hardware**, in two states: activated (camera had a
   previous owner's password at 10.0.0.115) and factory-fresh inactive (after a
   reset button hold, at Hikvision default 192.168.1.64 with ports 80/554 open).
   Raw SADP replies for both states are in `sadp-raw/`.
2. **The documented RTSP path is real**: `rtsp://…:554/Streaming/Channels/101`
   streamed immediately with camera-created credentials — H.264, 2560×1440,
   20 fps, no audio.
3. **Measured bitrate: 1797 kbps** (6,737,232 bytes in 30 s). The VBR cap is
   6144 kbps but the static scene averaged 0.29× the cap — consistent with the
   smart-codec/VBR reasoning above, on a bench rather than a corridor.
4. **`camctl probe --try-all` said "no" for every path twice** — first because
   the old credentials were wrong (ISAPI 401 while port 554 stayed open: the
   port and paths were never the problem), then because **ffmpeg was not
   installed on the bench PC**. Probe verdicts depend on ffmpeg; `preflight`
   exists for exactly this and should be run first next time.

Retention arithmetic at the measured figure (`camctl size` basis, raw disk):

| | 1 camera | 16 cameras (one store) |
|---|---|---|
| 16 TB raw at 1797 kbps | 742 days | **~46 days** |
| 16 TB raw at H.265+ (~0.9 Mbps) | ~1,480 days | **~93 days** |

(Store size corrected 2026-09-13: 16 cameras per store, not the 23 assumed in
the plan tables.)

So **16 TB per store clears the 30-day target at the measured bitrate with
~50% headroom** — a store with busier scenes spends some of it. The rest of the
margin comes free by enabling H.265+ (the camera supports it), which was
the open lever in #1b and is a settings change, not a purchase.

## Why #2 needs the raw captures

SADP is reverse-engineered, not published, and sources disagree on the multicast
group. `camctl` probes both and `--raw-dir` writes every response to disk. Those
captures are the difference between a parser that is a careful guess and one that
is a known quantity — and they will show whether real cameras report fields the
parser does not yet read.

## Bench log — 2026-09-17, signed upgrades proven on the laptop NVR

Handoff item 2: the whole signing path run against a real box, not a harness.
The box is the ROG laptop NVR (Tailscale `100.104.228.7`), which was running
release `1c075c1a` — a build from before releases were signed, so it has no
manifest and no verifier of its own. That made it the honest first-install
case: the installed release cannot vouch for anything, so `upgrade.sh` fell
back to the incoming release's verifier, exactly the one documented exception.

Setup, all deliberate:

- A **throwaway keypair** generated on the PC outside the repo
  (`Temp/camplat-bench/`, id `bench-throwaway-2026-09-17`), plus a second
  throwaway "attacker" key never placed in any anchor. Neither key is or ever
  was in the repository.
- **Two releases built from the same clean tree at `6159197`** (`node
  setup/release.mjs` twice, ~30 s apart) so the only difference is
  `builtAtUtc`: A at `01:07:47.868Z`, B at `01:08:19.275Z`. After B installs,
  replaying A is a real downgrade attempt, not a simulation.
- A signed with the bench key, B signed with the bench key, a copy of A
  re-signed with the attacker key (sign-release replaces the signature in
  place — the manifest bytes are identical, only the signature envelope
  differs).
- The tampered and extra-file tarballs were built **on the laptop** from B's
  tree after signing: `echo "TAMPERED" >> agent/api-server.mjs` for one,
  `pwned-by-attacker.txt` added for the other — manifest and signature left
  untouched, so the attack is purely "the tree is not what was signed."

**Anchor placement** (extracted from the signed tarball, source from the PC):

```
  anchor placed: 1 key(s) trusted here: bench-throwaway-2026-09-17
```

`/etc/camplat/trusted-keys.json` landed `root:root 0644` in `/etc/camplat/`
`root:root 0755`, contents byte-identical to the bench `trusted-keys.json`.

**Upgrade 1 — old unsigned release to signed A:**

```
OK: 6159197b6e6a043b65f15510fc5842e3a058d454, signed by bench-throwaway-2026-09-17, 189 files verified
current: 1c075c1a91d7bdef529c126a8835d7ef59b73f47
new:     6159197b6e6a043b65f15510fc5842e3a058d454
● camplat-recorder.service … Active: active (running) … 3s ago
● camplat-api.service … Active: active (running) … 3s ago
```

**Upgrade 2 — signed A to signed B** (same version string, newer build):
accepted and swapped the same way. `camplat-api`, which had been left inactive
by a manual stop hours earlier, came back on the upgrade's restart of both
services.

**The five refusals, each attempted through `upgrade.sh` on the box, each
refused before anything was touched, each leaving `/opt/camplat` on B and
no `/opt/camplat.new` behind:**

| Attack | Refusal message (verbatim) |
|---|---|
| replay release A after B installed (downgrade) | `REFUSED (downgrade): this release was built 2026-09-18T01:07:47.868Z, older than the installed 2026-09-18T01:08:19.275Z` |
| copy of A signed by the attacker's key | `REFUSED (unsigned): this release carries no signature from a key this recorder trusts` |
| `agent/api-server.mjs` modified after signing | `REFUSED (file_changed): agent/api-server.mjs is not the file the manifest signed for` |
| `pwned-by-attacker.txt` added after signing | `REFUSED (file_extra): pwned-by-attacker.txt is in the release but not in the manifest` |
| the old unsigned release the box was installed from | `REFUSED: this release has no MANIFEST.json, so there is nothing to check it against` |

Every attempt also printed the wrapper line `refusing to install <tarball>: it
could not be shown to be genuine` and exited 1. Two things worth keeping:
an unknown key's signature is reported as "unsigned" — the verifier does not
try unknown key ids, so an attacker learns nothing about *why*; and the
downgrade message carries both build times, which is what makes a rollback
deliberate (`CAMPLAT_ALLOW_DOWNGRADE=1`) rather than accidental.

**Recorder continuity.** Both upgrades restarted the recorder, and both times
it was back to "recovery complete … 473 confirmed, 0 lost" and both cameras
re-opened within one second of the stop. The camera at `192.168.1.64` turned
out to be unplugged for the whole session, so no footage was flowing; the
recorder spent the evening doing the correct thing instead — recording gaps
and retrying (its `exited code 146` loop was the camera being absent, not the
box misbehaving; the identical loop appeared at 21:04, an hour before the
first upgrade). When the camera was plugged back in (~21:28), the recorder's next retry
latched on without any intervention and sealed real footage on release B —
`cam1-main` sealing a growing 25.7 MB segment in `.inprogress/` within a
minute of the camera answering ping, both cameras `opened` + `sealed` in the
journal, eight minutes after the upgrade restart. Continuity through the
signed upgrades held.

A Windows bench gotcha for the next person: `sign-release.mjs` shells out to
`tar`, and Git Bash's GNU tar reads a `C:\` path as host `C` and fails
(`Cannot connect to C: resolve failed`). Run it with the Windows bsdtar ahead
on `PATH` (`PATH="/c/Windows/System32:$PATH" node setup/sign-release.mjs …`).

## Bench log — 2026-09-18, one appliance under a site's real load (handoff item 6)

**What this machine is, before any number is read.** The laptop NVR is a ROG
Zephyrus G14: Ryzen 9 7940HS, 16 threads, plus an RTX 4060. The appliance is an
N150, several times slower per core. **None of these numbers is an N150 number.**
What this run can say honestly: whether recording is isolated from display and
decode load (a software property, pass/fail), what each load costs *relative to
the others*, and that the method works — the scripts in `bench/` run unchanged
on an N150 board the day one arrives.

**Setup.** 16 cameras recorded: the real ECI-T24F2 (`cam1-main` + `cam2-sub`)
and 14 synthetic cameras served on the box itself by mediamtx v1.21.0 (checksum
verified, bound to `127.0.0.1`, removed afterwards). The synthetic main streams
loop one pre-encoded clip at the REAL camera's measured profile — 2560x1440,
20 fps, H.264 Main, 1.77 Mbps (measured 1.797 in log #1) — with stream-copy, so
the source costs almost nothing. Substreams: 640x360, 20 fps, ~400 kbps. Each
synthetic camera has its own host name (`camN.localhost`), because of finding 1.
Each phase is 5 minutes, sampled every 5 s. Raw data: `bench/results-2026-09-18/`.

| Phase | Machine busy | Recorder + live ffmpeg | Wall (Chromium) | Detector-style decode | Disk write |
|---|---|---|---|---|---|
| A — 16 cameras recording | 3.0% | 8.2% of a core | — | — | 3.5 MB/s |
| B — + 9-tile wall on the box | 5.1% | 11.0% | 26.2% of a core | — | 3.4 MB/s |
| C — + 16 substreams decoded at 5 fps | 5.4% | 9.0% | 19.1% | 21.5% of a core | 3.6 MB/s |

CPU is per-process as a percentage of ONE core (100 = one core busy). The
synthetic source cost 20–27% of a core and is excluded from every figure above.

**Recording integrity — the only pass/fail: PASS in all three phases.** Every one
of the 16 cameras recorded 100% of every window: largest gap 0 s, no
`gap_recorded` events, 99.9% of expected frames present (`bench/integrity.mjs`,
counting packets against duration x frame rate). Recording did not notice the
wall or the decoding.

**What the numbers say, relative to each other:**
- **Recording is the cheap part.** 16 cameras stream-copied cost ~8% of one core.
- **Serving live tiles is cheap.** ~0.3% of a core per tile (B minus A, 9 tiles).
- **Drawing the wall is the expensive part** — 19–26% of a core for nine 360p
  tiles, more than recording all 16 cameras. The same wall measured 26.2% and
  19.1% in two runs, so read it as ±25%. **On an N150 this is the number to
  measure first**, and whether Chromium decodes in hardware there (VA-API on
  QuickSync) decides it. Not checked on this box.
- **Detector-style decoding** is ~1.3% of a core per 640x360 substream, and
  that is the decode half only. Inference cannot be measured until D1 exists.
- **A manager's browser does not run on the NVR.** Its decode lands on the
  manager's own laptop or phone; the NVR pays only the serving cost above. It
  was counted from that, not measured with a second browser here.

**Findings the test flushed out — each is a real defect or trap, not load:**

1. **`groupCamerasByDevice` merges cameras that share an IP.** It groups by host
   so a camera's main and substream show as one tile. Any site where many
   cameras come through ONE address — an old DVR or analog encoder
   (`dvr-ip/Channels/101`, `/201`, `/301`…), exactly what a migration off an
   existing system looks like — would show one tile instead of sixteen. The
   first wall attempt showed one tile for 14 cameras on `127.0.0.1`.
2. **Every live tile opens its own RTSP session to the camera** (`agent/live.mjs`
   spawns an ffmpeg per viewer, separate from the recorder's). A camera shown on
   two TVs plus a manager holds four sessions. Real cameras cap concurrent RTSP
   sessions, and a three-TV site can reach that cap.
3. **The web server binds only the Tailscale address** (`100.104.228.7:8080`),
   while `LINUX-BUILD-PLAN.md` D7 points the kiosk browser at `127.0.0.1`. As
   configured, a kiosk wall would show a blank screen. The bind and the kiosk
   plan must agree before a box ships with a wall.
4. **A restart during recording leaves a 28-byte stub per camera** — an MP4
   `ftyp` header with no video — in the camera's directory, named like a real
   segment. Recovery counted them (`partials: 16`) and left them in place.
   Anything that lists segments will list an unplayable one.
5. **`substreamUrl` is a second address.** The previous session's config had it
   set on all 14 fake cameras; repointing `url` alone left the live wall pulling
   from the old place while recording used the new one. Two fields for one
   camera is two places to forget.

**Process notes for the next bench run:**
- The previous attempt at this item (2026-09-18 afternoon) was abandoned
  mid-test: config changed, never restored, no results written, 276 gaps logged
  by the 14 dead cameras it left configured. Its backup
  `config.json.bench-backup-20260918` is what this run restored.
- It also served the 14 streams **from the Windows PC across Tailscale**, and
  left that server running afterwards, listening on `0.0.0.0:8554`. A network
  path in the middle of a load test turns a Wi-Fi hiccup into a "gap" the
  appliance did not cause. Serve synthetic cameras on the box under test.
- `bench/measure.sh` finds sysstat columns by header name. The first draft read
  them by position and would have reported ~0% CPU for every process: `pidstat
  -h` ends each row with the command name, not a number.
- `bench/integrity.mjs` matches `gap_recorded` on the raw log line. The first
  draft read a `message` field that the recorder never writes, so it would have
  called a dead camera healthy. It was proven on a window with known gaps (18.7%
  coverage, 8 gap events, flagged) before being trusted.
- The only signing key this box trusts is `bench-throwaway-2026-09-17`, whose
  private half was retired. **Nothing can be deployed here until a new bench key
  is anchored** with `CAMPLAT_TRUSTED_KEYS_FORCE=1`. That is the signing working.
- Restored afterwards: `config.json` back to `cam1-main` + `cam2-sub`, mediamtx
  and the test directory removed, real camera recording. Chromium (snap, 153)
  stays installed for the wall. The 14 synthetic cameras' footage stays on disk
  until retention evicts it; no configured camera points at it.

## Bench log — 2026-09-18 late, a camera connection that dies now fails in seconds

**What happened first.** At 22:34:38 the laptop NVR suspended (logind: "The
system will suspend now!"; no lid, power-key or idle event logged). It resumed
at 23:07:55 and the USB NIC came back ("carrier on") -- and for the next 13
minutes the recorder logged NOTHING: no sealed segments and no ffmpeg exits.
The RTSP connection had died across the suspend without a reset, and ffmpeg,
running with no socket timeout, sat blocked on it. `camera_not_recording`
raised at ~23:09 (correct: 5-min threshold, two checks, after wake) but nothing
acts on a per-camera alert, and the recorder process itself was alive so
`recorder_stale` never raised. An unrelated restart at 23:21 broke it loose.

**Proof before the fix.** Against a peer that accepts the TCP connection and
then says nothing: without `-timeout` ffmpeg was still waiting at 30 s; with
`-timeout 5000000` it gave up by itself at 5 s -- on ffmpeg 6.1.1 (the laptop)
and 9.0.1. Fixed in `17afa0a`: 10 s on the recording and detection ffmpeg.
The same commit masks sleep/suspend/hibernate in install.sh; on the laptop it
was masked by hand (`systemctl start suspend.target` -> "Unit suspend.target
is masked").

**The unplug test, on 17afa0a, cam1-main** (camera cable pulled at the PoE
switch, so power and link go together):

| Time | Event |
|---|---|
| 23:44:02 | last normal segment sealed |
| 23:44:36 | ffmpeg exited by itself -- it did not hang |
| 23:44:38 | recorder restarted it and recorded the gap |
| 23:45:12 | camera confirmed dark (no ping); live file not growing |
| 23:45:18 | a retry exited 146 (camera unreachable) -- failing cleanly |
| 23:45:20-35 | camera booting: retries every ~5 s, each exiting after ~3 s with 143 (no route to host: the camera not yet answering ARP), each with a gap recorded |
| 23:45:38 | video flowing again: live file 28 B -> 3.1 MB in 6 s |
| 23:46:01 | first full segment sealed after recovery |

No restart, no human, no hang. Two things to know from it:
- **Correction (2026-09-19):** an earlier version of this entry said the 143s
  were the recorder's own start-up kill rule. There is no such rule: the
  recorder signals ffmpeg only when stopping. ffmpeg exits with 256 minus the
  errno, and 143 is EHOSTUNREACH, measured on the laptop against an absent
  address. The other codes measured: 145 connection refused, 146 connect timed
  out, 183 a peer that accepts and says nothing, 0 when the timeout fires
  mid-stream. The new socket timeout is what covers a stream that was already
  running.
- **`audio_dropped` on cam1-main at 23:46:05**, right after the camera
  rebooted: the recorder fell back to video-only. Video is fine; check that
  audio comes back rather than staying dropped until the next restart.

## Bench log — 2026-09-19, audio survives a camera outage; a stuck camera is restarted

**Audio.** In the unplug test, cam1-main came back video-only: two quick
failures with audio on switched it to a video-only trial, the camera recovered
during that trial, and audio stayed off "until the service restarts". The two
failures were network exits (146, 143), not audio. Fixed:
- exits 143/144/145/146/152/155 (the camera unreachable) never count against
  audio (`NETWORK_EXIT_CODES` in agent/recorder.mjs);
- a drop is not permanent: when the video-only run ends, the reconnect tries
  audio again, and `audio_restored` is logged once an audio run holds.
Both were reproduced as failing checks first (harness/recorder.harness.mjs).

**The per-camera alert now acts.** `camera_not_recording` raised at 23:09 on
the 18th and nothing happened for 12 minutes. Now, on the transition into
raised, `camctl alerts --restart-stale` writes
`restart-camera.<cameraId>.request` in the state directory; the recorder
service polls every 5 s, deletes the file, and restarts only that camera's
ffmpeg (SIGTERM, then SIGKILL). No root is needed. A gap is recorded from the
later of the last sealed segment and that run's start, with reason `unknown`:
nothing on the box knows why the stream stalled. Camera ids are checked
against the API's id rule when the file is written and again when it is read,
and a request naming no configured camera is deleted and ignored.

Not yet installed on the laptop NVR.

## 2026-09-19: load-test findings 3 and 4 fixed, and a recovery bug they exposed

**Finding 3 (web server bound only the Tailscale address).** The API server
now listens on a plan, not one address (contracts/listenPlan.ts,
agent/listeners.mjs): loopback always (the TV on the box's own HDMI), the
card with the default route (the store LAN, for managers and the Mac Minis),
and Tailscale. The camera network has no default route, so it is never picked;
naming it (`if:<card>` or its address), or any wildcard, is refused. Cards that
come up later (Tailscale, DHCP) are picked up within 10 s. Set with
`CAMPLAT_API_LISTEN` and `CAMPLAT_CAMERA_INTERFACES` in the unit (install.sh).
The laptop NVR still has `CAMPLAT_API_HOST=<tailscale ip>`, which now means
that address plus loopback; `upgrade.sh` does not rewrite the unit, so it keeps
working unchanged.

**Finding 4 (a restart leaves a 28-byte stub).** A segment is empty when it
starts with an MP4 `ftyp` box and holds no `moov`, `moof` or `mdat` box,
decided by structure, never size (an ffmpeg with another brand list writes a
32-byte stub). The running recorder and recovery both move stubs to
quarantine; recovery counts them as `empty` and indexes none of them.

**Found on the way: an unindexed in-progress file was filed under camera
".inprogress" at a start time in 1970.** A power cut between ffmpeg opening a
new file and the recorder indexing it left a file recovery "adopted" by
reading `<cam>/.inprogress/<name>` as a sealed path: the directory became the
camera, and the name's epoch seconds were read as milliseconds. The footage
was on disk and on no timeline. The existing check only asserted that
something was adopted. Now the scan reads the start time from the name
(wipNames.mjs) and recovery adopts it under its own camera as a partial, or
quarantines it when the time cannot be read.

Not yet installed on the laptop NVR.

**Finding 2 (every live tile opened its own camera session): fixed the same
day.** One source (one ffmpeg, one RTSP session) per camera and quality,
shared by every viewer; a late joiner gets the stored init segment and starts
on the next fragment (frag_keyframe: each starts on a keyframe); a viewer more
than 6 MB behind skips whole fragments and resumes on one, so a slow screen
never holds up the others. The caps now count what they protect: 2 sessions
per camera, 32 on the box, 128 viewers. A 3-TV x 9-tile site is 27 viewers on
at most one session per camera. Also fixed in review: a source whose last
viewer left stayed joinable until its ffmpeg exited, and its exit could delete
a fresh source for the same camera from the map.

## Bench log — 2026-09-19 afternoon, today's fixes on the laptop NVR (d39b58d)

Installed signed (bench-2026-09-18, 196 files verified) over 17afa0a, then
d39b58d on top. Recovery on start: 1140 confirmed, 2 partials, 0 empty, 0
lost. The load-test drop-in (`CAMPLAT_API_HOST=<tailscale ip>`) was replaced,
with Austin's go-ahead, by `listen.conf`: `CAMPLAT_API_LISTEN=loopback,
default-route,tailscale` and `CAMPLAT_CAMERA_INTERFACES=enx00e04c6840ac`.

| Check | Result |
|---|---|
| Listening | 127.0.0.1, 192.168.4.45 (house Wi-Fi), its two ULA IPv6, Tailscale v4+v6; **not** 192.168.1.50 (camera USB adapter) |
| Manager access from the LAN | Austin's PC on the house Wi-Fi (192.168.4.42): 200 |
| Stream sharing, real camera | 2 tabs on the laptop (127.0.0.1) + 1 on the PC (Tailscale): **1** live ffmpeg |
| Unplug at the PoE switch, ~1 min | ffmpeg exited 143 every ~5 s (no route), gap recorded each try, recording back at 14:49:43 unaided |
| Audio after the unplug | **no audio_dropped**; the first sealed segment after is h264 + aac. Last night the same test dropped audio until a restart |
| Live tiles after the unplug | sources failed cleanly while the camera was dark (`live_source_failed`, no bytes), tiles reconnected by themselves: 6 viewers on 3 sessions |

**Open: Austin's Samsung phone cannot reach http://192.168.4.45:8080 on the
same Wi-Fi.** A tcpdump on wlp2s0 saw no SYN at all while it retried, so the
packets never reach the laptop; the PC on the same Wi-Fi works. Ruled out:
guest network, mobile data, the phone's Tailscale (offline). Parked by Austin.
Earlier the same phone could not play the 2560x1440 main stream (video error
4); d39b58d falls back to the substream, not yet seen on the phone.

**Noticed:** a camera that is down records a gap row on every retry (~5 s),
so a one-minute outage is a dozen adjacent gaps. Harmless, but noisy on a
timeline; worth merging adjacent camera_offline gaps.

**Later the same afternoon (36492ba, installed signed).** `camctl clean-empty`
listed 10 of 1216 recordings holding no video, all 28-byte stubs from restarts
on 2026-09-16..19; one sat in `disk0/cam2-sub/.inprogress/`, left from when
cam2-sub recorded to disk0 during the load test, where the current recorder
(on disk1) never looks. `--apply` moved all 10 to quarantine (1 on disk0, 9 on
disk1) and removed their rows; a second run found none. The one-gap-per-outage
change (db35151) was then proven with a second unplug (15:25:18 to about
15:26:25 local): six retries per camera, **one gap each** (19:25:29 to
19:26:31/32 UTC, camera_offline), closed at the first new segment; no
audio_dropped. The gap starts about 10 s after the unplug, when the socket
timeout declares the stream dead, so the timeline has an unmarked ~10 s
between the last video and the gap. Starting the gap at the end of the last
recorded segment would close that.

**Security fix the same afternoon (90ec738, installed signed).** Austin saw
the camera's password on a live tile while it reconnected through the
unplug. ffmpeg prints its input URL with credentials; live.mjs forwarded the
last stderr lines to the viewer and the API log. Tiles now show only fixed
plain sentences (liveTileText), the server never sends ffmpeg's words, and
the log keeps them scrubbed. On the laptop, 2 older camplat-api journal
entries (2026-09-15 and 2026-09-18) still hold a visible camera password;
the recorder's journal holds none. Clearing them is Austin's call (journalctl
--rotate, then --vacuum-time=1s), and the bench camera's password should be
changed since it was shown on screen. Every box that ran a build before
90ec738 has the same exposure in its API journal.

**Orphaned live ffmpegs (fixed in af9aa6a, installed signed).** After the
15:39 unplug the laptop had 6 live ffmpegs, each with an ESTAB session to the
camera's port 554, for 2 viewers. The 4 orphans had been sent SIGTERM while
blocked reading the dead camera; ffmpeg honours SIGTERM only between reads,
and the live arguments lacked the socket timeout the recorder got in
17afa0a. Now the live ffmpeg has `-timeout` (the recorder's value) and a
retired source gets SIGKILL 5 s after SIGTERM if it has not exited. Re-tested
16:07 with 2 viewers: 2 live + 2 recorder sessions before; during the outage
the log shows 2 "live source killed"; after the replug, again 2 live + 2
recorder sessions and no orphans. The restart that installed af9aa6a cleared
the earlier 4.

**Gap start (dd9515d, installed signed).** Unplug at about 20:20:20 UTC: both
cameras' last segment ends 20:20:18; the drop was noticed at 20:20:40
(gap_recorded); after the replug the dropped file was sealed and measured and
each gap was pulled back to start 20:20:18.9, ending 20:21:58 where video
resumed. Video, gap, video, with no unmarked stretch.

## Bench log — 2026-09-19 evening, the D1 detector on the laptop NVR

Python environment `/opt/camplat-detect/venv` (numpy 2.5.3, onnxruntime 1.30.0,
CPU only; 153 MB), models copied to `/opt/camplat-models/` (hashes as in
models/LICENSES.md). `detector/test_postprocess.py` 8/8 on the laptop.

**Capacity, measured (YOLOX-s, 640 px, Ryzen laptop):** 9.35 frames/s with 2
threads, 16.29 with 4. detect.json set to capacityFps 9, cam1-main at 5 fps.
This is the laptop's number; an appliance gets its own measurement (rule 10).

**Found on the way:** a configured substream address saved without a login was
refused by the camera (401): the recorder adds the site login, live and
detection did not (1d6c314). With the camera unplugged, the worker exited and
the whole daemon exited with it — every timer was unref()'d — and systemd
restarted it 12 times in 6 minutes (3dd17d8).

**First person seen (Austin walking, 30 s, 5 fps):** 126 of 144 frames, median
confidence 0.87, best 0.95; the 18 frames of "nobody" are him stepping out.
The walk became 6 events: the same-thing rule needed overlapping boxes, and a
person walking toward the camera grows too fast for that (0.29 x 0.72 to
0.43 x 0.99 of the frame in 200 ms). Weak guesses (a 0.35 "vehicle", a 0.67
"person" the size of the frame) were all stored.

**After the fixes (matchScore centre fallback, storing floor 0.5; 82fc644),
the same walk:** 199 sightings, ONE event (01:48:17 to 01:49:03, best 0.94),
plus one single sighting at the frame edge two seconds before. Recording
untouched throughout (segments sealed on schedule); detector 0 restarts.

**Still to do for D1's exit:** the clip library — recorded walks, an hour of
empty scene, headlights — with hand-written expected events, then
`scoreLibrary`. The 95% / 1-false-per-hour bar has not been measured yet.

## Bench log — 2026-09-19 late, D2 markers on the laptop NVR (fb08c9d)

Installed signed over `3dd17d8`: **211 files verified**, recorder, api and
detector restarted (upgrade.sh restarts the first two; camplat-detect was
restarted by hand so it runs the new build too). Austin confirms the marks are
on the Review timeline.

**The signing key had to be rotated, and that is the durable fact here.** The
box trusted `bench-2026-09-18` and the private half of that key no longer
exists — not on the PC, not on the box. It was a throwaway generated in a temp
directory that has since been cleared, exactly as `bench-throwaway-2026-09-17`
was. Signing with the 09-17 key under the 09-18 id was refused as `unsigned`,
which is the trust chain working: the verifier checks the signature, not the
label. With Austin's go-ahead the anchor was force-replaced
(`CAMPLAT_TRUSTED_KEYS_FORCE=1`) with a new key.

| | |
|---|---|
| Trusted now | `bench-2026-09-20` only |
| Private key | `C:\Users\garci_9e2kg3l\Temp\camplat-bench\bench-2026-09-20.key` — **still a temp dir; third key to live there** |
| Signing on Windows | `sign-release.mjs` must run from **PowerShell**: Git Bash's GNU tar reads `C:\...` as a remote host and fails with "Cannot connect to C: resolve failed" |

**Verified against the installed code, on the box:** eventQuery 4, eventsDb 5,
eventMarkers 15, apiServer 60, reviewPage 44 — all passing under the box's own
node.

**Not verified by this agent:** `/events` answering with a real session, and
the page rendering in a browser. Nobody signed in from here, and a signed-out
probe cannot tell a real route from a made-up one — the box answers 401 for
both, on purpose (routeAccess: a scan must learn nothing).

**The detector's 28 events at install time** included one lasting 31 minutes
with 9,209 sightings (21:48:17 to 22:18:59 local, best 0.94). Worth a look on
the page: either someone really was in frame that long, or the same-thing rule
is holding a static object open. The marks now make that visible, which is the
point of D2.

**D2's exit bar is still unmeasured:** "a known person walk-by found in under
30 s without scrubbing" is a claim about a person using it, and nobody has
been timed yet. The strip is tiles, not crops — D1 stores `bestBox` and
`bestUtc` but no image, so crops mean cutting frames from the recording on
demand (one ffmpeg seek per event, cached, refused when the segment is gone).

**The first thing the markers showed: three vehicles that were never there.**
Austin saw "Vehicle" on a timeline with no vehicle in the footage. All three
were single frames at 0.35, 0.36 and 0.36, and all three sat inside one
four-minute window this afternoon (17:08 to 17:12 local) — written by the
build that ran BEFORE the 0.5 storing floor. Of 28 stored events, 15 were
below the floor and every one of them was from that window; nothing stored
since the current build started (21:43) is below 0.55. So the page was honest
and the data was old.

Two things followed, both with Austin's go-ahead:

- The 15 pre-fix rows were deleted (backed up first to
  `~/events-pre-fix-backup.json` on the box; predicate `best_confidence <
  0.5`, newest row 21:12:14Z, nothing from tonight). 13 events remain, all
  people.
- **`detect.json` carried no `minConfidence`.** The 0.5 floor was coming from
  a default in `detect-service.mjs`, so the number governing what gets stored
  was not visible anywhere on the box. It is now written in explicitly. A
  setting that cannot be read cannot be checked, and this one had just spent
  an evening being blamed on the page.

The UI deliberately does NOT re-filter by confidence: the floor belongs at the
detector, and a page that hides low-confidence events would be hiding evidence
from the person whose job is to look at it.

**Still unmeasured:** false events per hour on an empty scene, and recall on a
walk-by. Austin has deferred both to a session where the room can be left
alone. Until then nobody should quote a false-positive rate for this box.
