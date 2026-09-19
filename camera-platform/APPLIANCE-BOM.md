# The NVR appliance — what to buy

For 16 AVYCON 5MP @ 30 fps cameras and dual 8 TB, running Debian + ffmpeg +
Node + SQLite. Roughly **$870 a store**, or **$1,070 with AI** (case and
board chosen by Austin 2026-09-19; see "The case" and "Two models").

## You are not buying an NVR

There is no NVR to buy. The recorder is the software in this repo; what you order
is a small server to run it on. Buying an OpenEye, Hikvision or Synology NVR
would mean paying for their recording software and then not using it.

So the order is a short parts list, and the assembly is about 20 minutes a unit.

## Two models, one box (Austin, 2026-09-16; board unified 2026-09-19)

| | **Standard NVR** (no AI) | **AI NVR** |
|---|---|---|
| Board | **i3-N305** 6-bay NAS board | the same board |
| AI chip | none; the second NVMe slot is left empty | **Hailo-8 M.2 2280** (26 TOPS) in the second NVMe slot |
| Everything else | the list below | the same list |
| ~Cost | **~$870** | **~$1,070** (+$199 chip) |

**Every NVR gets the N305 (Austin, 2026-09-19).** The N150 was ~$50 cheaper,
but it cannot decode 16 detection substreams, so a Standard NVR built on it
could only become an AI NVR by swapping the whole board on site: about an hour
of lost recording. With the N305 in every box, the **upgrade is plugging the
Hailo-8 into the empty slot and turning the detector on** (AI-PLAN.md): about
five minutes, no footage lost. That also lets AI be sold later as an add-on
(chip plus licence) to any installed box.

Both run the same software and handle at least 16 cameras. The chip slot must
be PCIe NVMe, not SATA M.2; the Hailo-8L (13 TOPS) is short at 16 cameras.
Prices are estimates; recheck before ordering.

## What to order — one store (Standard NVR)

| # | Item | Notes | ~Cost |
|---|---|---|---|
| 1 | **Topton / CWWK / HKUXZR i3-N305 6-bay NAS motherboard**, mini-ITX | Board + CPU in one. 6× SATA, 2× M.2 NVMe (one for the OS, one kept free for the AI chip), 2–4× Intel i226-V 2.5GbE, 1× DDR5 SODIMM. Sold on Amazon (HKUXZR listing), toptonpc.com and AliExpress. All three are the same reference design, also sold with an N150 (~$50 less), which we do not use | $250 |
| 2 | 16 GB DDR5 SODIMM, 4800 MHz | One slot, so one stick | $45 |
| 3 | 256 GB NVMe M.2 2280 | OS only | $25 |
| 4 | **RackChoice 2U "Compact Rackmount" chassis** (Amazon B0BN1XBL2R: 4× 3.5" internal + 2× 5.25") + a standard ATX PSU | Flat NVR-style box that sits on a rack shelf. 2 drives at 16 cameras, 3 at 24, 4 at 32. See "The case" | **$99** case (Austin, from the listing) + ~$40 PSU (estimate) |
| 5 | **2× WD Purple 8 TB** | Not desktop drives — see below | $340 |
| 6 | CyberPower or APC ~600 VA UPS with USB | Draw is 14 W with two drives, so runtime is generous | $70 |
| | | **Total** | **~$870** |

AI NVR: add the Hailo-8 in the free NVMe slot (table above).

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
| Drives | 2× WD Purple 8 TB | **2× Seagate SkyHawk 8 TB** | **$60** |
| OS drive | 256 GB NVMe | 128 GB | $7 |
| UPS | 600 VA | 350 VA (draw is only 14 W) | $20 |
| | | **Value build total** | **~$780** |

The board is not on this list. The N100 and N150 versions are cheaper, but
they give up the five-minute AI upgrade (see "Two models, one box").

**SkyHawk is the standout.** It is rated 180 TB/year against our 79 — 44%
utilisation, comfortable headroom. WD Purple's 360 TB/year is 4.5× our load;
that is headroom we will never use, bought at $30 a drive. Purple stays the
recommendation only if you want the extra margin for its own sake.

The chosen case has no hot-swap trays, and that costs nothing here: a drive
swap is a site visit either way.

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

Not recommended, for three reasons: it is **$200–300 more** for an N150, which
is weaker than the N305 we now use;
it has **one M.2 slot**, so the OS drive and a future Hailo cannot coexist; and
it is currently **marketplace-only with the vendor's own product page 404ing**,
which is a poor foundation for a rollout that needs identical spares for years.
The board route costs less, expands further, and you control the spec.

### Buy one first

Nothing here has been measured against a real camera yet. **Order a single unit**,
run the bench session — `camctl probe` for the real bitrate, then the recorder
against a live AVYCON camera — and confirm the numbers before ordering the rest.
One unit is well under $1,000 to de-risk a decision you will repeat many times.

## The build in detail

Measured power on this platform: **9.3 W idle with no drives, 14.3 W with two,
18.7 W with four.** That is what makes a small UPS give a long runtime, and it is
why fan noise in a store office is not an issue.

## The case

**Chosen 2026-09-19 (Austin): RackChoice 2U "Compact Rackmount" chassis,
Amazon B0BN1XBL2R.** Specs below are from the listing, as Austin read them out. The NVR sits
on a shelf in a small rack at each site. It does not need to be bolted in, but
it has to fit, and it should look like an NVR: a flat metal box.

| | |
|---|---|
| Size | 19" wide × 2U (3.5") tall × **400 mm (15.75") deep, not counting the front handles** |
| Needs | a full-width rack shelf **at least 16" deep**, plus room for the handles in front. Can be bolted into the rack later |
| Drives | **4× 3.5" internal + 2× 5.25"**; a 3.5"-to-2.5" adapter is included. Not hot-swap |
| Board | up to 9.6 × 9.6" (micro-ATX, mini-ITX), so the 17 × 17 cm NAS board fits |
| Power supply | a standard ATX (PS2) PSU, not SFX. The box draws ~15–30 W, so any decent low-wattage unit will do |
| Cooling | 2× 80 mm intake fans, plus the PSU's 120 mm fan on top |
| Build | zinc-coated steel, aluminium handles; front USB 3.0 ×2 |
| One case for every tier | 2 drives at 16 cameras, 3 at 24, 4 at 32. The two 5.25" bays can take a 5th and 6th drive with brackets, matching the board's 6 SATA ports |

**Check before the first order.** Two things the listing does not give: the
**CPU cooler height limit**
(2U is short inside; the N305 board ships with a low heatsink that should
fit, but compare the two numbers; the listing gives none); and whether the two
80 mm intakes have a **dust filter** (add one if not; see Thermals).

**Board reliability: burn in before the fleet order.** Only SATA1 on the N305
NAS board is native. SATA2–6 come from a JMB585 bridge chip, so our second
recording drive sits behind it. Two Amazon reviews of the HKUXZR N305 board
disagree (Austin forwarded both, 2026-09-19). One owner is happy. The other
had two bad boards: the first saw only SATA1 and had a dead 10 GbE port; the
second **dropped the SATA2 drive every few hours**, and swapping drives and
cables did not fix it. That is one review each way, not a verdict. But a
dropped drive stops half the cameras until a reboot, so before any fleet order:
buy **2–3 boards from different sellers** (HKUXZR, CWWK, Topton), run each
**7 days** with drives on SATA2–4, and read `dmesg` for link resets. A board
that drops a drive once is out. The `disk_missing` alert would catch a drop in
minutes, but nothing brings the drive back without a reboot. If every
candidate fails, look for a board whose extra SATA ports use a different
controller, or a server-class board.

**If a site's shelf is shallower than 16":** use the **Jonsbo N2** instead. It
is 222.5 × 222.5 × 224 mm (an 8.8" cube, per jonsbo.com), has 5 hot-swap bays
and takes an SFX PSU. It is just over 5U tall, so leave **6U** of clear height.

**At fleet scale:** NVR brands do not design their boxes. A chassis maker builds
a standard enclosure with the brand's front panel. At 180+ sites, a quote for a
branded NVR-style case sized for this board is worth getting once this parts
list settles.

## Why this shape

**The workload is trivial for the CPU and brutal for the disk.** Sixteen
stream-copies is about half a core — we never transcode. Decoding is the
substream for detection, plus the nine-tile wall a site's own TV shows on the
NVR's HDMI output — Intel QuickSync does both in the iGPU. The site's other
TVs are driven by Mac Minis pulling their tiles over the LAN, and serving
those is stream-copy, so it stays cheap. An N150 would be enough for
recording alone; every box gets the 8-core i3-N305 anyway, so that any box
can take the AI chip later without a board swap.

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

Storage offices are dusty and often not air-conditioned, and a rack shelf
next to a PoE switch and a UPS runs warmer than an open desk. Filtered intake,
front-to-back airflow, positive pressure, and keep the drives under ~45 °C. Check `smartctl` temperature
in the fleet telemetry — a drive running hot is a drive about to fail, and
knowing a week early turns an emergency into a scheduled visit.

## What not to buy

- **Mini PC + USB drive enclosure.** USB drops under sustained write. It will
  corrupt footage and you will not know until you need it.
- **Synology / QNAP.** Turnkey but locked down; we want our own stack on it.
- **Used 1U enterprise.** Cheap, but loud, power-hungry and unwelcome in an
  office.
- **Desktop hard drives.** See the table above.
