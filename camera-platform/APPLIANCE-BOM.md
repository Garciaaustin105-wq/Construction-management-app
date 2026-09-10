# The NVR appliance — what to buy

For 16 AVYCON 5MP @ 30 fps cameras and dual 8 TB, running Debian + ffmpeg +
Node + SQLite. Roughly **$800 a store**.

## The build

| Part | Spec | ~Cost |
|---|---|---|
| Motherboard + CPU | **Intel N150 mini-ITX NAS board** — 6× SATA, 2× M.2 NVMe, 2–4× Intel i226-V 2.5GbE, DDR5 SODIMM. Sold as "6-bay NAS motherboard" by Topton / CWWK / HKUXZR | $200 |
| RAM | 16 GB DDR5 SODIMM | $45 |
| OS drive | 256 GB NVMe — **never** the surveillance drives | $25 |
| Recording | **2× WD Purple 8 TB** (see below) | $340 |
| Case + PSU | Mini-ITX NAS case, 4 bays, filtered intake, 120 mm slow fan | $120 |
| UPS | ~600 VA with USB | $70 |
| *Optional* | Hailo-8L M.2 (13 TOPS) if detection runs on-box | +$70 |
| | **Total** | **~$800** |

## Why this shape

**The workload is trivial for the CPU and brutal for the disk.** Sixteen
stream-copies is about half a core — we never transcode. The only decoding is
the substream for detection, and Intel QuickSync does that in the iGPU. An N150
is comfortably enough; an i3-N305/N355 buys 8 cores for ~$50 more if on-box
analytics ever grow.

**It has to be a NAS board, not a mini PC.** Most N100 mini PCs have one M.2 and
no SATA bays. We need two 3.5" drives, two NICs, and a spare M.2. The 6-bay
boards have all of it on one 17 × 17 cm board.

**Two NICs are not optional.** One to the store LAN, one to a camera-only
segment. That makes the appliance the isolation boundary around cameras that
should never see the internet.

**No PoE on the appliance.** A separate managed PoE switch is independently
replaceable, and a switch failure then does not take the recorder down with it.
Built-in PoE is the mistake in the box we are replacing.

## The drives — the one place not to save money

Sixteen cameras at 2.5 Mbps write **5 MB/s sustained, 158 TB a year**. Split
across two drives with whole cameras assigned to each, that is **79 TB/year per
drive**:

| Drive | Workload rating | Our load | |
|---|---|---|---|
| Desktop (WD Blue, Barracuda) | 55 TB/yr | **143%** | **exceeds rating** |
| Seagate SkyHawk 8 TB | 180 TB/yr | 44% | ok |
| **WD Purple 8 TB** | **360 TB/yr** | **22%** | **recommended** |
| SkyHawk AI | 550 TB/yr | 14% | overkill here |

A desktop drive is rated for 8–10 hours a day. In continuous surveillance it
fails with bad sectors inside 6–18 months. **WD Purple 8 TB has double SkyHawk's
standard workload rating at the same capacity**, which is why it is the pick —
not because SkyHawk is inadequate, but because headroom on the one part that
wears out is cheap.

Assign whole cameras to drives; do not stripe or RAID. Striped, one failure
loses every camera's history. Assigned, it loses eight cameras and leaves eight
intact. RAID-1 halves capacity for resilience the cloud copy already provides.

Filesystem: **XFS**, one per drive. It handles the constant create/delete of a
ring buffer better than ext4 and does not fragment as badly with large files.

## Three BIOS settings that decide whether you drive to the store

1. **Restore on AC Power Loss → Power On.** The single most important setting in
   the build. A store loses power at 3am; without this the recorder stays off
   until somebody visits. Default on most boards is *Power Off*.
2. **Watchdog timer enabled** (Intel iTCO, driver `iTCO_wdt`). A hung recorder
   that reboots itself is a non-event; one that does not is a truck roll.
3. **Disable deep C-states / suspend.** This box never sleeps.

Then in the OS: `systemd` units with `Restart=always`, and NUT for the UPS —
configured to ride through short outages and shut down cleanly only when the
battery is nearly gone. Recording longer is better than shutting down early,
because fragmented mp4 survives truncation anyway.

## Thermals

Storage offices are dusty and often not air-conditioned. Filtered intake,
positive pressure, and keep the drives under ~45 °C. Check `smartctl` temperature
in the fleet telemetry — a drive running hot is a drive about to fail, and
knowing a week early turns an emergency into a scheduled visit.

## What not to buy

- **Mini PC + USB drive enclosure.** USB drops under sustained write. It will
  corrupt footage and you will not know until you need it.
- **Synology / QNAP.** Turnkey but locked down; we want our own stack on it.
- **Used 1U enterprise.** Cheap, but loud, power-hungry and unwelcome in an
  office.
- **Desktop hard drives.** See the table above.
