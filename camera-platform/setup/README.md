# Building the test NVR

From a box of parts to a recording appliance. About an hour, most of it waiting
for Debian to install.

## 1. Parts

Per `../APPLIANCE-BOM.md` — the ~$633 value build:

- Intel N100/N150 6-bay mini-ITX NAS board (Topton / CWWK / HKUXZR)
- 16 GB DDR5 SODIMM
- 128–256 GB NVMe — **OS only**
- 2× Seagate SkyHawk 8 TB
- Mini-ITX NAS case + SFX PSU
- ~350 VA UPS with USB

## 2. BIOS — before anything else

Three settings, and the first is the one that turns a power cut into a truck roll:

| Setting | Value | Why |
|---|---|---|
| **Restore on AC Power Loss** | **Power On** | Default is usually *off*. Without it, a 3am outage leaves the box dead until someone drives out. |
| Watchdog timer (iTCO) | Enabled | A hung recorder that reboots itself is a non-event. One that doesn't is a visit. |
| Deep C-states / suspend | Disabled | This box never sleeps. |

## 3. Debian

Minimal install — no desktop, SSH server only. Put it on the **NVMe**, and leave
both SkyHawks untouched during installation.

## 4. Network

Two interfaces, and the separation is the security boundary:

- **NIC 1** → store LAN, has internet
- **NIC 2** → camera segment only, **no route to the internet**

The cameras sit behind the appliance and are unreachable from outside. With the
Hikvision estate that is doing real work — those cameras carry an
actively-exploited vulnerability. With new AVYCON cameras it is still the right
shape.

## 5. Install

```bash
sudo ./setup/install.sh
```

Installs ffmpeg, Node 22, smartmontools, chrony and NUT; creates the service
user; writes the systemd unit; arms the watchdog.

**It does not format anything.** It prints the disk commands for you to run
deliberately — a script that formats disks is one that eventually formats the
wrong one. Follow its output to make the XFS filesystems, and note
`allocsize=64m` in the mount options: without it, eight concurrent writers
fragment every segment across the platter and playback seeks forever.

## 6. Verify

```bash
node agent/camctl.mjs preflight
```

Expect all green. The two that catch people:

- **iGPU render node** — if missing, substream decode falls back to software and
  eats a core of four. Usually means the user isn't in the `render` group.
- **index off the recording drives** — the SQLite index belongs on the NVMe. On a
  spinning disk it seeks against the video stream and both get slower.

Then measure the disks actually do what the BOM assumed:

```bash
node agent/camctl.mjs bench --path /srv/camplat/disk0 --writers 8 --seconds 20
```

Eight cameras at 2.5 Mbps need 2.5 MB/s. Anything under 10× that is worth
investigating before you trust it.

## 7. First camera

```bash
node agent/camctl.mjs discover 192.168.100.0/24 --raw-dir ./sadp-raw
node agent/camctl.mjs probe <ip> --vendor avycon --try-all --user U --pass P
```

`--try-all` resolves the RTSP path, which AVYCON documents as varying by model.
Record what worked in `../FIELD-NOTES.md` — one bench test per model settles
onboarding for every unit of that model you ever install.

`probe` also measures the **real** bitrate over 30 seconds. That single number
replaces every storage estimate in this project, which are all still assumptions.

## What is not built yet

The recorder, index, eviction, recovery, timeline and bandwidth logic are done
and tested (175 checks). Still missing before this is a product:

- `recorder-service.mjs` — the daemon the systemd unit points at
- Cloud control plane: enrolment, telemetry, the console
- Relay and live view
- The mobile app

So this box will record, and you can prove the hardware and the camera settings
on it. It will not yet be something you can hand to a customer.
