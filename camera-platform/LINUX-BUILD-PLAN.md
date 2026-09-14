# Linux build plan: the recorder on the NVR box

Written 2026-09-14 by Claude (opus-camera), with audit units run on gpt-oss (local)
and GLM, while Austin was at work. Stage 0 is committed (see its result below); nothing has been pushed or
run on a Linux machine.

This plan covers Phases A and B of BUILD-PLAN.md, the program on the box, and
nothing else. The desktop and mobile apps wait until Austin says this is right
(decided 2026-09-14).

## What "done on Linux" means

An item is done when it passes on Linux, with the versions that ship on the box.
A pass on the Windows bench does not count.

The A1 exit in BUILD-PLAN.md stays the finish line: 16 cameras record for 7 days
unattended, with repeated power pulls, and nothing is lost that was not being
written at the moment the power went.

## Where things stand

Everything so far has been proven on Windows only:

- The harness suite: 209 checks at 40a3614, plus the export work since. Almost
  every harness uses a fake ffmpeg. **No harness runs a real ffmpeg**, so the
  whole media path rests on one bench session.
- One real camera run (2026-09-13): ECI-T24F2, one store root, 30 s segments,
  **ffmpeg 9.0.1 and Node 24.19** on Windows 11.
- The export download test.

The box will run different versions. Debian 12 ships ffmpeg 5.1 and Debian 13
ships 7.1, while the bench used 9.0.1. The installer puts Node 22 on the box, and
the bench used Node 24. The box also has two recording drives, two NICs, systemd,
XFS, an unprivileged service user and a hardware watchdog. The bench had none of
these.

## Decisions for Austin

Each has a recommendation, and nothing below waits on the last two.

- **D1. Which Linux machine first.**
  - Recommended: any spare x86 PC with Debian on its own SSD or USB drive, for
    the software stages (1 and 2).
  - Then buy the reference board (APPLIANCE-BOM.md, about $633) for stages 3
    and 4.
  - Not WSL on this PC. WSL adds virtual network adapters to Windows, which is
    the internet setup you asked us not to touch. It also isn't the real kernel,
    iGPU or disks.
- **D2. Debian 12 or 13.** Recommended: Debian 13, the current stable release.
  It ships ffmpeg 7.1 and a newer kernel, which matters for the N100's graphics.
  Check this on the machine; don't take it on trust.
- **D3. Node version.** Recommended: pin Node 24 LTS on the box, the same major
  version as the bench, so a bench pass and a box pass test the same runtime.
- **D4. How to reach the review page before Phase B login exists.** Recommended:
  over an SSH tunnel only. The API binds to 127.0.0.1 by design
  (A2-TRANSPORT-SPEC.md), and LAN binding waits for auth.
- **D5. Load for the 7-day test with one camera.** A1 says 16 cameras, and we
  have one. Options:
  - borrow or buy more cameras;
  - have a local relay on the box re-serve the one camera 16 times, which tests
    disks and CPU but not 16 real network sources;
  - play recorded files as 16 synthetic streams at the measured 1737 kbps.

  Recommended: the relay for the first soak, real cameras before the fleet.
- **D6. Audio on (already open on the board as bench-audio-on-breaks-copy-mux).**
  Stores run audio on, and a G.711 audio track currently produces zero
  recording. A fix is needed before stage 4. The choices are transcoding audio to
  AAC, or a different container. That choice is a product decision, so it isn't
  made here.

## Problems found on 2026-09-14

Every item was checked by reading the code. The first was also reproduced.

### Blockers: they lose footage or stop the box recording

**L1. A restart with two drives wipes the index. CONFIRMED by repro.**
- **Where:** `agent/recorder-service.mjs:90`, `runRecovery`.
- **Cause:** the per-drive filter `s.path.startsWith("")` is always true, so
  each drive's recovery pass sees every indexed segment. Segment paths are
  relative to their drive, so a segment on the other drive looks missing.
- **Repro:** two temp drives, one held segment on each, then one recovery.
  - Drive 0's segment vanishes from the index. The file stays on disk, invisible
    to playback and never evicted, so the drive fills.
  - Drive 1's segment comes back with `hold=false` and no end time, so held
    evidence becomes evictable.
  - Two fake "unknown" gaps are logged over real footage.
- **When it fires:** every restart of a two-drive box, which is the reference
  build.
- **Why nothing caught it:** the bench had one drive, and
  `service.harness.mjs` never restarts with segments on both drives.
- **Fix:** each drive's recovery gets only the index rows for cameras assigned to
  that drive.
- **Acceptance:** a FEARED harness check restarts with held segments on both
  drives and requires the index to be unchanged, with zero lost and zero gaps.

**L2. An unmounted drive records onto the OS drive.**
- **Cause:** the installer creates `/srv/camplat/disk0` as a plain directory.
  If the disk fails to mount, the directory is still there and writable:
  - ffmpeg records onto the NVMe, filling the drive that holds the OS and the
    index;
  - preflight's `statfs` succeeds on a plain directory, so it reports the store
    as fine (`agent/preflight.mjs:60`).
- **Second part:** without `nofail` in fstab, a dead recording disk sends Debian
  into emergency mode at boot, and a headless box with no keyboard stays down.
- **Fix:**
  - the service refuses a store root that is not a mount point (its device
    differs from its parent's), logs it, and keeps recording the other drive;
  - bench configs opt out explicitly;
  - fstab lines get `nofail,x-systemd.device-timeout=30s`;
  - preflight checks for a real mount.
- **Acceptance:** a harness check with a fake mount probe, plus a stage 2 test
  with a disk unplugged.

**L3. The installer can leave a Node that cannot run the recorder.**
- **Cause:** `setup/install.sh:29` keeps any Node 20 or newer, but the index
  needs `node:sqlite`:
  - Node 20 does not have it;
  - Node 22 before 22.13 needs a flag the unit never sets.

  Preflight is looser still: it checks for Node 18 or newer
  (`agent/preflight.mjs:19`).
- **A related bug:** `ExecStart` hard-codes `/usr/bin/node`, while the check
  accepts a node found anywhere on the PATH.
- **Fix:**
  - install the pinned major from D3;
  - check for the capability (`node -e "require('node:sqlite')"`), not a
    version number;
  - write the resolved node path into the unit;
  - preflight uses the same check.

**L4. A backwards clock step can overwrite footage.**
- **The chain:**
  - The unit waits for the network, not for the clock (`After=network-online`).
    If chrony steps the clock back after the recorder has started, ffmpeg's
    `%s` names repeat earlier seconds.
  - On Linux, `rename()` silently replaces an existing file
    (`agent/segstore.mjs:94`).
  - The index upserts on camera plus start time
    (`agent/segindex.mjs:66`, `ON CONFLICT ... DO UPDATE`).
  - So an older sealed segment is replaced, both on disk and in the index, with
    no error.
- **Fix:**
  - the unit orders after `time-sync.target`, with chrony's wait service
    enabled (check the unit name on the box);
  - `sealSegment` refuses to seal onto an existing name and quarantines the new
    file instead.
- **Acceptance:** a harness check with a pre-existing sealed file, plus a
  stage 2 test with `date -s` two minutes back.

**L5. The installer never enables the service.**
- **Cause:** `setup/install.sh` runs `daemon-reload` but never
  `systemctl enable`, so the box does not record after a reboot.
- **What else is wrong in the unit:**
  - Without a config file, `Restart=always` crash-loops every 5 seconds.
  - `StartLimitIntervalSec` sits in `[Service]`, but systemd reads it in
    `[Unit]`.
- **Fix:**
  - enable the unit;
  - add `ConditionPathExists=/var/lib/camplat/config.json`;
  - move the start limit into `[Unit]`;
  - set an explicit `TimeoutStopSec=30s`.
- **Credit:** GLM found this one.

**L6. The code never reaches the box.**
- **What's missing:**
  - Nothing copies the program to `/opt/camplat`.
  - `dist/`, the compiled contracts every agent module imports, is gitignored.
  - camera-platform has no `package.json`, and `tsc` is borrowed from the
    lowvoltage-app checkout.
  - The installer also makes the service user the owner of `/opt/camplat`, so
    the recorder could rewrite its own code.
- **Fix:**
  - a release script on the dev machine builds a tarball (`agent/`, `dist/`,
    `setup/`, and a VERSION file with the commit);
  - the installer unpacks it into `/opt/camplat` owned by root and read-only to
    the service;
  - the box never needs TypeScript.

**L7. The API server has no service.**
- **Cause:** only `camplat-recorder.service` exists. `agent/api-server.mjs` is a
  separate process (with live view inside it) and nothing starts it, so there is
  no timeline, playback or export on the box after a reboot.
- **Fix:** add `camplat-api.service` with the same user, bound to 127.0.0.1
  (see D4), starting after the recorder. Both processes open the same SQLite
  index in WAL mode; stage 2 must show they coexist under load.

**L8. A missing or broken ffmpeg kills every camera.**
- **Cause:** `agent/recorder.mjs:170` spawns ffmpeg with no `'error'` listener.
  If the spawn fails (binary missing, not executable), the unhandled error event
  crashes the whole daemon, so all cameras go down, not just one, and systemd
  restarts it into the same crash.
- **Contrast:** `live.mjs:272` and `media.mjs:20` do handle it.
- **Fix:** listen for `'error'` and treat it like an exit: record a gap and
  retry with backoff.
- **Acceptance:** a harness check where the fake spawn emits `error`.

### Wrong or misleading, but not losing footage

- **L9. Drives are configured in two places.**
  - The unit sets `CAMPLAT_STORE_ROOTS`, and preflight reads it
    (`preflight.mjs:48`).
  - The recorder ignores it and uses `config.json`
    (`recorder-service.mjs:70`).
  - So preflight can pass on different disks from the ones being recorded to.
    Pick one source.
- **L10. Mounting a fresh XFS disk leaves it owned by root.**
  - The installer's `install -d` ownership sits underneath the mount and is
    hidden by it, so the recorder cannot write.
  - Fix: the disk instructions add a `chown` after mounting, and preflight
    checks the disk is writable as `camplat`. (GLM found this.)
- **L11. Some failures are silent.**
  - A config file the service user cannot read is reported as "not
    commissioned" (`recorder-service.mjs:60` swallows every read error).
  - A health file that fails to write is ignored (`recorder-service.mjs:224`).
  - Fix: only a missing file means uncommissioned; log health write failures.
- **L12. Discovery doesn't choose a network card.**
  - SADP and WS-Discovery join multicast without naming an interface
    (`sadp.mjs:76`, `wsdiscovery.mjs:57`).
  - The bench PC had one NIC. On a two-NIC box the kernel picks the interface
    from the routing table, likely the store LAN, so discovery on the camera
    network may find nothing.
  - Fix: a `--iface` option, defaulting to the camera NIC. Test in stage 3.
- **L13. Shutdown doesn't wait for ffmpeg.**
  - `recorder.stop()` sends SIGTERM and seals straight away without waiting for
    ffmpeg to exit (`recorder.mjs:208`), so the last segment is left for
    recovery on the next boot.
  - That is safe by design, but stage 2 must show it: after
    `systemctl restart`, no ffmpeg is left over and no file is quarantined.

### Box setup the installer does not do yet

- **L14. Cameras need time from the box.** The bench camera sat at epoch 0 with
  no NTP on its network. Chrony must serve time on the camera NIC only (an
  `allow` line for the camera subnet). This touches the box's network config, so
  it is done with Austin there, on the box, never on this PC.
- **L15. The UPS is installed but not configured.** `nut-client` is installed,
  but nothing sets it up. APPLIANCE-BOM.md wants the box to ride through short
  outages and shut down cleanly only near an empty battery. This needs the UPS
  present (stage 3).
- **L16. Drive health isn't watched.** `smartmontools` is installed, `smartd` is
  not configured, and drive temperature and SMART status are not in
  `health.json`.
- **L17. Logs are not capped.** Nothing limits journald's size, so on a small
  NVMe logs should be capped (`SystemMaxUse=`).
- **L18. The watchdog only covers the OS.** `RuntimeWatchdogSec` has systemd pet
  the hardware watchdog, which catches a hung kernel, not a hung recorder.
  Per-service watchdog needs `Type=notify` and a ping from the health timer.
  Don't add `WatchdogSec` without both, or systemd will kill a healthy recorder
  every interval. Confirm with `wdctl` in stage 3.
  Design: HEALTH-ALERTS-DESIGN.md (alerts contract, a stale-file restart
  first, `Type=notify` only if that proves too slow; where alerts go is D7).
- **L19. QuickSync drivers aren't installed.** The installer doesn't install
  `intel-media-va-driver` or `vainfo`, and a `/dev/dri` node existing doesn't
  prove decode works. This only matters for detection (Phase D). Note it now;
  don't block A1 on it.

## Stages

Each stage has an exit, and a stage is not started until the one before it exits.

### Stage 0: fixes on the dev machine (no hardware, agents only)

- **Scope:** L1, L2 (service and preflight), L3 (preflight half), L4
  (`sealSegment` half), L8, L9, L11.
- **How:** Claude writes each FEARED harness check first, and gpt-oss or GLM
  implements it one function at a time. Then `tsc` and `run-all`.
- **Also:** the release script (L6), and the installer and unit changes (L3, L5,
  L6, L7, L10). Shell and systemd text can only be proven on Linux, so these are
  written here and proven in stage 2.
- **Exit:**
  - `run-all` is green on Windows with the new checks;
  - each new check fails when its fix is reverted;
  - the installer has had a line-by-line review.

### Stage 0 result (2026-09-14)

- **Committed, not pushed**, on `claude/camera-service-plan-uwr6st`:
  - `62d6126`: L1, L2, L3 (preflight half), L4, L8, L9, L11;
  - `70f6ada`: the release script and installer, for L2, L3, L5, L6, L7 and L10.
- `run-all` is green on Windows.
- The installer and unit text stay unproven until stage 2.

### Before the box: work that needs no Linux machine

These items run in order. Each is agents only, and each FEARED check is written
before its fix.

**Status (2026-09-14): all seven are done and committed on the camera branch,
not yet pushed.**
- Q1 `772c327`, Q2 `f049963`, A1 `607b2f6`, R1 `d670991`, S1 `4cd0cad`,
  L17/L16 `f97551d`, L12 `e681024`.
- Still unproven until the box: `install.sh` and `stage1-check.sh` on Debian
  (stages 1 and 2), smartd's NVMe self-test on Debian 12's smartmontools
  (stage 2), and the multicast half of L12 (stage 3).

1. **Q1. Quarantine can overwrite a file it set aside.**
   - **Cause:** `applyRecovery` names the target from the file's path alone
     (`segstore.mjs:145`). If the same path is quarantined on a later boot, it
     replaces the first file.
   - **Also:** a failed move is swallowed (`.catch(() => {})`) but still
     reported as quarantined.
   - **Fix:** use a unique name, as `sealSegment` already does, and report a
     failed move as a failure.
2. **Q2. Quarantine space is invisible.** Eviction works from `statfs`, so
   `.quarantine/` silently takes space from retention.
   - **Fix:** report its size in `health.json`, and warn above a limit.
   - **Never auto-delete:** a human decides what happens to quarantined files.
3. **A1. `camctl audit`.** Stage 4 needs it, and stage 2 can use it.
   - It runs the recovery planner as a dry run against the index and a disk
     scan, then prints lost, orphan, partial and quarantine counts.
   - It is read-only.
4. **R1. A real-ffmpeg check.** No harness runs a real ffmpeg yet.
   - **What it does:** records a local `lavfi` test pattern through the
     recorder's own output arguments for three short segments, then ffprobes
     them.
   - **Constraints:** file source only, no server and no network. Only the
     input arguments change, because `-rtsp_transport` is RTSP-only. The check
     skips when ffmpeg is missing.
   - **Why it matters:** in stage 1 it tests the box's ffmpeg, which closes the
     version gap described above.
5. **S1. `setup/stage1-check.sh`.**
   - It prints `node -v`, `ffmpeg -version` and `uname -r`, then runs
     `run-all`, all into one file for Austin to send back.
   - It installs nothing and starts nothing.
6. **Installer text, proven in stage 2:**
   - L17: a journald size cap.
   - L16: a basic `smartd` config. The `health.json` half waits for real
     `smartctl` output from the box.
7. **L12. A `--iface` option for discovery.** The multicast half is proven only
   in stage 3.

Checked already: no harness writes outside a temp dir, so a read-only
`/opt/camplat` will not break stage 1.

Left for the box or for Austin:
- L13 (stage 2 shows it);
- L14 and L15 (stage 3);
- L18 (needs a `Type=notify` design; do it after stage 2);
- L19 (Phase D);
- the D1–D6 decisions.

### Stage 1: the suite on Linux (the D1 machine; Austin sets it up)

- **Setup:** Debian (D2) and pinned Node (D3), with the release tarball
  unpacked.
- **Run:** `node harness/run-all.mjs` with the box's Node, then `tsc` on the dev
  machine, to prove the shipped `dist/` matches.
- **Record in FIELD-NOTES:** `ffmpeg -version`, `node -v` and `uname -r`.
- **Exit:** every check passes on Linux. Any check that behaves differently
  from Windows gets a board note before it is fixed.

### Stage 2: systemd and the file system (same machine, no camera needed)

- **Media source:** a synthetic stream. The machine plays a test pattern into a
  local RTSP relay. That is a server, so **Austin approves it first**. It runs
  on the Linux machine only and uses no network setup on this PC.
- **Exit, all shown with commands and output:**
  - The installer runs twice with no change the second time. After a reboot,
    both services are running with no manual step.
  - `systemctl restart` leaves no ffmpeg behind. `kill -9` on node, then a
    restart, leaves exactly one ffmpeg per camera. Recovery quarantines nothing.
  - Two store roots with segments on both, then a restart: the index is
    unchanged (L1 on real disks).
  - A store not mounted: that drive is refused and logged, the other drive keeps
    recording, and the OS drive does not grow (L2).
  - The clock stepped back 2 minutes: no sealed file is overwritten (L4).
  - A sealed file's size is unchanged 10 seconds after sealing, so nothing was
    renamed while still open.
  - The API reads timeline and playback while the recorder writes, with no
    SQLite busy errors over one hour.
  - A disk filled past 85%: eviction runs, held segments survive, and the health
    file shows retention.

### Stage 3: the reference box (Austin present)

- **Hardware per APPLIANCE-BOM.md.** The BIOS settings are Restore on AC Power
  Loss = Power On, iTCO watchdog on, and deep C-states off.
- **Disks:** XFS created by Austin from the printed commands (the installer never
  formats), with fstab using `nofail`.
- **Exit:**
  - `camctl preflight` is all green, including the real mount check and a write
    test as `camplat`;
  - `camctl bench --path /srv/camplat/disk0 --writers 8 --seconds 20` meets the
    disk budget on both drives;
  - `wdctl` shows the watchdog armed;
  - pulling the UPS's wall plug: the box rides through, and NUT shuts down
    cleanly only at low battery;
  - camera network: NIC2 has no route to the internet, chrony serves the camera
    subnet, and the camera's clock is correct;
  - discovery finds the camera on NIC2 (L12), and `camctl probe` passes with
    audio on once D6 is fixed;
  - one camera records for 24 hours: the timeline has no gaps other than the
    ones we caused, and export plays.

### Stage 4: the A1 soak (Austin does the pulls)

- **Load:** 16 streams (D5) at the fleet recipe (VBR, quality about 60, cap
  6144), for 7 days, on both drives.
- **Faults, each logged with its time:**
  - at least 10 wall-power pulls, some within 30 seconds of a segment sealing
    and some during eviction;
  - one camera-network cable pull;
  - one recording disk unplugged while running.
- **Before the soak, add `camctl audit`,** which compares the index with a disk
  scan and prints lost, orphan and quarantine counts.
- **Exit:**
  - after every fault, `camctl audit` reads zero lost and zero quarantined,
    apart from the one segment being written when power went;
  - gaps appear only where the log says a fault happened;
  - retention is within 10% of the prediction from the measured bitrate;
  - nobody logged in to fix anything.

## Who does what

- **Agents** (Claude supervises; gpt-oss and GLM implement; Claude verifies):
  stage 0, the release script, installer text, harness checks, `camctl audit`,
  and reading stage 1 to 4 output.
- **Austin:** the D1 to D6 decisions, the Linux machine, the reference hardware,
  BIOS, cabling, disks, the camera, power pulls, and approving any server or
  scan before it runs.
- **Not in this plan:** the desktop app, the mobile app, the cloud (B1 and B2
  come after A1 exits), and detection.

## Appendix: how the audit was done

- **Claude** read `recorder-service.mjs`, `config.mjs`, `recorder.mjs`,
  `segstore.mjs`, `evict.mjs`, `preflight.mjs`, `install.sh` and the setup
  README, and reproduced L1 in temp folders (no servers, no network).
- **gpt-oss:20b**, one unit per file group on the bus lane `camera-gpt-oss`:
  - The service and store units answered. Of about 30 findings, roughly 3 were
    usable. The rename-replaces-file observation fed L4, and the shutdown timing
    fed L13.
  - Most of the rest were wrong. It claimed `camplat` cannot write
    `/var/lib/camplat` (the installer creates it), that UDP 37020 needs root, and
    that `path.join` puts backslashes in URLs on Linux.
  - It missed L1, which was in a file it was given.
  - The recorder and live units came back empty (the thinking budget ran out).
    Retried with 4 or 5 narrow questions each (bus tasks on `camera-gpt-oss`),
    both answered in under 10 seconds. Every answer that cited a line was right:
    - no `'error'` listener at `recorder.mjs:170` (L8);
    - `stop()` does not wait for exit (L13);
    - only the newest file is left unsealed;
    - `live.mjs:272` does attach its error listener;
    - systemd's control-group kill reaps ffmpeg where a shell `kill -9` orphans
      it.

    It correctly answered "unsure" on ffmpeg version differences rather than
    guessing. Claude checked those by hand: every option in `ffmpegArgs` and
    `liveFfmpegArgs` (`contracts/liveNegotiation.ts:140`) predates ffmpeg 5.1,
    so nothing is known to break. Their behaviour on the box's ffmpeg is still
    unproven: stage 2 covers it with the relay, and stage 3 with the real
    camera.
- **GLM 5.3 Flash**, one cross-check of the installer against the daemon: most of
  its findings held up on checking, and it found L5, L10 and the `/usr/bin/node`
  half of L3.
- **Lesson for the next audit:** ask the local model narrow questions about one
  file ("which line, yes or no, or unsure"), and give cross-file work to GLM.
  Broad "find portability problems" prompts gave gpt-oss room to invent
  problems, and it did.
