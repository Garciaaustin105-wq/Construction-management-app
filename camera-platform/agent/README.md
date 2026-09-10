# camctl — the field tool

Point it at a camera subnet. It tells you what is there, what each camera is
**really** streaming, and what that means for retention.

Plain Node, **no dependencies**, no build step beyond compiling the contracts.

## On the box with the cameras

```bash
sudo apt install ffmpeg          # the only prerequisite
cd camera-platform
npx tsc -p tsconfig.json         # compile the contracts once
node agent/camctl.mjs preflight
```

## Find the cameras

```bash
node agent/camctl.mjs discover 192.168.1.0/24 --raw-dir ./sadp-raw
```

Three methods run together, because none finds everything:

- **TCP sweep of 554/80** — the backstop. A camera is something that answers on
  554 and streams when asked. Works whether or not ONVIF is on.
- **SADP** (UDP 37020) — Hikvision's own protocol. Answers *even with ONVIF
  disabled*, which since firmware v5.5.0 is the default. Gives model, serial and
  firmware.
- **ONVIF WS-Discovery** (UDP 3702) — the published standard, for cameras that
  have ONVIF enabled.

The sweep decides what exists; the other two enrich it.

**Please use `--raw-dir` on the first run.** SADP is reverse-engineered rather
than published, and sources disagree on the multicast group — this probes both
`239.255.255.250` and `239.255.255.230`. Every raw response is written to that
directory. Keep them: they turn the parser from a careful guess into a known
quantity, and they show whether your cameras report fields it does not yet read.

## Measure a camera

```bash
node agent/camctl.mjs probe 192.168.1.64 --user admin --pass '...' \
  --cameras 23 --disk-tb 16
```

Reports codec, resolution, fps, whether the stream carries **audio** (legally
gated, off by default), and then the number that matters:

```
  bitrate      not reported by RTSP — measuring
measuring real bitrate over 30s ...
  measured     1180 kbps  (4425000 bytes in 30s)

at this bitrate, 23 camera(s) on 16 TB raw:
  56.6 days retention
```

**Why it captures rather than asking.** ffprobe usually reports no `bit_rate`
for RTSP — there is no container header to read it from. And a camera's
*configured* bitrate is a setting, not a measurement: on a smart-codec camera
watching an empty corridor the two differ several-fold. Only the measurement
sizes a disk, so `camctl` captures for 30 seconds and weighs the result. It
refuses samples under 20 seconds, because a variable-bitrate camera says nothing
useful in two.

If reported and measured differ by more than 25%, it says so and tells you to
trust the measurement.

## What to run first, with one camera on a bench

1. `preflight` — confirms ffmpeg is there.
2. `discover` with `--raw-dir` — confirms SADP answers, and captures the raw
   replies.
3. `probe` — confirms the RTSP template is right for your firmware, and gives
   the first real bitrate number this project has had.

Step 3 is the one that matters. Every storage figure so far has assumed 2 Mbps.
One measurement replaces that assumption with a fact, and the retention
projection at the end of `probe` is the honest version of every disk-sizing
table written to date.

## Notes

Credentials never reach a log. `buildRtspUrl` returns a playable URL and a
redacted one; only the redacted form is printed, and errors are scrubbed before
being shown. Pass credentials via `CAMPLAT_USER` / `CAMPLAT_PASS` rather than
argv if other people can see your process list.

A sweep wider than a `/16` is refused — a `/8` is a typo, not a plan.
