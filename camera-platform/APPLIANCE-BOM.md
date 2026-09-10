# The NVR appliance — what to buy

For 16 AVYCON 5MP @ 30 fps cameras and dual 8 TB, running Debian + ffmpeg +
Node + SQLite. Roughly **$800 a store**.

## You are not buying an NVR

There is no NVR to buy. The recorder is the software in this repo; what you order
is a small server to run it on. Buying an OpenEye, Hikvision or Synology NVR
would mean paying for their recording software and then not using it.

So the order is a short parts list, and the assembly is about 20 minutes a unit.

## What to order — one store

| # | Item | Notes | ~Cost |
|---|---|---|---|
| 1 | **Topton / CWWK / HKUXZR N150 6-bay NAS motherboard**, mini-ITX | Board + CPU in one. 6× SATA, 2× M.2 NVMe, 2–4× Intel i226-V 2.5GbE, 1× DDR5 SODIMM. Sold on Amazon (HKUXZR listing), toptonpc.com and AliExpress. All three are the same reference design | $200 |
| 2 | 16 GB DDR5 SODIMM, 4800 MHz | One slot, so one stick | $45 |
| 3 | 256 GB NVMe M.2 2280 | OS only | $25 |
| 4 | **Jonsbo N2** (5-bay) or **N3** (8-bay) mini-ITX NAS case + SFX PSU | Hot-swap trays, filtered intake. N2 is the right size for two drives with room to grow | $120–150 |
| 5 | **2× WD Purple 8 TB** | Not desktop drives — see below | $340 |
| 6 | CyberPower or APC ~600 VA UPS with USB | Draw is 14 W with two drives, so runtime is generous | $70 |
| | | **Total** | **~$800** |

Optional: **Hailo-8L M.2** (13 TOPS, ~$70) in the second M.2 slot, only when
detection moves on-box. Nothing in Phase 1–3 needs it.

### Best bang for the buck

Three tiers, cheapest first.

#### Tier 1 — free, and worth more than any component swap

**Tune the encoder before you spend anything.** Setting the I-frame interval to
2× the frame rate takes 15–25% off the bitrate with no visible loss on a static
corridor. On the same dual 8 TB that is roughly **28 days becoming 34**.

To buy those six days with hardware you would spend $150+ on larger drives. The
setting is free and takes a minute per camera. Do this first, every time.

#### Tier 2 — real savings, no capability lost

| Swap | From | To | Saves |
|---|---|---|---|
| Case | Jonsbo N2 | generic mini-ITX NAS case + SFX PSU | **$60** |
| Drives | 2× WD Purple 8 TB | **2× Seagate SkyHawk 8 TB** | **$60** |
| Board | N150 | N100, same 6-bay board | $30 |
| OS drive | 256 GB NVMe | 128 GB | $7 |
| UPS | 600 VA | 350 VA (draw is only 14 W) | $20 |
| | | **Value build total** | **~$633** |

**SkyHawk is the standout.** It is rated 180 TB/year against our 79 — 44%
utilisation, comfortable headroom. WD Purple's 360 TB/year is 4.5× our load;
that is headroom we will never use, bought at $30 a drive. Purple stays the
recommendation only if you want the extra margin for its own sake.

Hot-swap trays are the only thing lost with the cheaper case, and drive swaps are
a site visit regardless.

#### Tier 3 — recertified enterprise drives, with eyes open

Manufacturer-recertified **Seagate Exos 8 TB** runs well under new surveillance
drives and carries a 550 TB/year rating with a typical 2-year warranty. Tempting,
and genuinely used this way — but they are enterprise drives, not surveillance
drives:

- **No ATA streaming command support.** Surveillance firmware prefers dropping a
  frame to stalling on a retry; enterprise firmware retries. In an NVR that shows
  up as occasional hiccups rather than data loss, but it is a real difference.
- **7200 rpm: hotter, louder, ~2× the power.** In a dusty, unconditioned store
  office, heat is what kills drives.
- **Shorter warranty**, and an RMA is a site visit.

Worth it if you are price-driven and the stores are climate-controlled. I would
not, at this scale — see the next paragraph.

#### The number that should govern all of this

**One truck roll is ~$150.** The entire Tier 2 saving is $167 — about one avoided
site visit. So value engineering here should never touch anything that affects
reliability: **cut the case, not the drives.** A desktop drive saves $120 a store
and runs at 143% of its rating; it fails inside 6–18 months and the callout costs
more than the saving, twice over.

### The prebuilt alternative, and why not

**Aoostar N150 4-bay NAS barebone**, about $500–590, is the closest thing to a
ready-made box: same N150, 4 SATA bays, 2× 2.5GbE, add RAM and drives.

Not recommended, for three reasons: it is **$200–300 more** for the same compute;
it has **one M.2 slot**, so the OS drive and a future Hailo cannot coexist; and
it is currently **marketplace-only with the vendor's own product page 404ing**,
which is a poor foundation for a rollout that needs identical spares for years.
The board route costs less, expands further, and you control the spec.

### Buy one first

Nothing here has been measured against a real camera yet. **Order a single unit**,
run the bench session — `camctl probe` for the real bitrate, then the recorder
against a live AVYCON camera — and confirm the numbers before ordering the rest.
One unit is $800 to de-risk a decision you will repeat many times.

## The build in detail

Measured power on this platform: **9.3 W idle with no drives, 14.3 W with two,
18.7 W with four.** That is what makes a small UPS give a long runtime, and it is
why fan noise in a store office is not an issue.

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
