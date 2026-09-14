# Health alerts and the recorder watchdog (L18)

Status: design only, 2026-09-14. Nothing here is built. The pure half can be
built and harness-tested on the dev PC; everything that touches systemd is proven
on the Debian box in stage 2 or 3.

## The problem

- `RuntimeWatchdogSec` pets the hardware watchdog. It catches a hung kernel, not
  a hung recorder.
- `Restart=always` catches a recorder that **exits**. It does not catch one
  that is alive but stuck: an event loop wedged on a disk that stopped
  answering, or every ffmpeg stalled while node carries on.
- `health.json` is written every 30 s, but nobody reads it. A dead camera or a
  drive at 99% is only noticed when someone goes looking for footage that isn't
  there.

## What counts as a problem

Each alert is a measurement with a threshold. It reports what it saw and never
what to do about it (build rules 11 and 13). The one automatic action on the
box is systemd restarting a recorder that has stopped reporting.

| id | raised when | measured from |
|---|---|---|
| `recorder_stale` | `health.json` `atUtc` is older than 3 health intervals (90 s) | the file's own timestamp |
| `camera_not_recording` | a camera's newest sealed segment ended more than `max(3 × segmentSeconds, 300 s)` ago | per-camera `lastSealedUtc`, a new health field |
| `disk_filling` | a store root is more than 92% used (eviction aims for 85%, so eviction is not keeping up) | `disks[].used / total` |
| `disk_missing` | a configured store root is refused at start, or `statfs` fails | `refusedRoots`, and a root absent from `disks` |
| `quarantine_large` | `.quarantine` is above its limit (Q2) | `disks[].quarantine` |
| `retention_unknown` | the recorder refused to compute retention | `retentionRefused` |
| `drive_failing` | SMART reports failure or a rising reallocated count | **waits for L16**: real `smartctl` output from the box |

Thresholds live in one place in the contract, with units in the name
(`staleAfterMs`, `diskFullFraction`). None of them come from field data yet, so
they are starting values, not truths.

## The rules that stop false alarms

1. **Blank is not OK.** When a measurement is missing (no `disks` entry, no
   `lastSealedUtc`), the alert state is `unknown`, never `clear`. An unknown
   condition is shown as unknown. (Build rule 5.)
2. **Two in a row.** An alert is raised only after the condition holds on two
   checks in a row, and cleared only after two good checks. A single slow
   `statfs` is not an incident.
3. **Grace after start.** For `segmentSeconds × 2 + restartDelay` after the
   recorder starts, `camera_not_recording` stays `unknown`. Every camera has
   "no recent segment" right after a reboot.
4. **One event per change.** Raising and clearing are logged once each, with
   `raisedUtc`. An alert that stays raised is not logged again every 30 s.
5. **The clock can be wrong.** If `atUtc` is in the future by more than 60 s,
   the result is `clock_suspect`, not a pile of stale alerts (the bench camera
   sat at epoch 0; see L14).

## Shape (build rules 1 and 2)

- `contracts/alerts.ts`, pure, with no I/O and no clock:
  `evaluateAlerts(health, previous, nowUtc, thresholds) -> { alerts, transitions }`.
  - `alerts` is one entry per id (and per camera or root), each with a state of
    `raised`, `clear` or `unknown`, plus `since` and the measured value with its
    unit.
  - `transitions` holds only what changed, which is what gets logged.
- `harness/alerts.harness.mjs`, testing the failures we fear:
  - a camera that flaps once raises nothing;
  - a reboot does not raise `camera_not_recording` for every camera;
  - a missing disk entry is `unknown`, not `clear`;
  - a clock 10 years off gives `clock_suspect` rather than stale alerts;
  - a raised alert stays raised, and logs once, across 100 checks.
- `recorder-service.mjs`: add `lastSealedUtc` per camera to `health.json` (from
  the recorder's `sealed` event, so there is no index query every 30 s).
- **The reader:** `camctl alerts`, run by a systemd timer every 60 s as its own
  small unit. It reads `health.json` and the previous `alerts.json`, runs
  `evaluateAlerts`, writes `alerts.json`, and logs transitions to the journal.
  - It is a separate process on purpose. A wedged recorder cannot report its
    own wedge.
- **The API:** `GET /alerts` returns `alerts.json`. The live and review pages
  show a banner for anything `raised` or `unknown`.

## The watchdog: two ways, one recommended

**A. Stale-file restart (recommended first).** The alerts timer already knows
when `recorder_stale` has been raised twice in a row. At that point it asks
for a restart.
- **Decided: a request file, no root and no polkit.** `camplat-alerts.timer`
  runs `camctl alerts --restart-stale` every 60 s as the service user. On the
  transition into raised it writes `$STATE_DIR/restart-recorder.request`.
  `camplat-recorder-restart.path` (root) sees the file; its service removes it
  and runs `systemctl restart --no-block camplat-recorder.service`.
- Only the transition restarts. An alert that stays raised has no transition,
  so a restart that did not help is not repeated every minute. A missing
  health.json is "unknown", not raised, so it never restarts on its own
  (`Restart=on-failure` covers a recorder that exits).
- Built and checked on Windows (`harness/alertsRun.harness.mjs`); **the path
  unit itself is unproven until stage 2.**
- Pros: plain files, no native module, testable on Windows, and the same signal
  as the alert.
- Cons: detection takes about 2–3 minutes, not seconds.

**B. `Type=notify` and `WatchdogSec` (later, only if A is too slow).**
- Node has no built-in `sd_notify`, and `dgram` cannot send to a unix socket.
  The options are a native module (a new dependency) or spawning
  `systemd-notify WATCHDOG=1` with `NotifyAccess=all`.
- A notify message sent from a short-lived child process may not be credited
  to the service if the child exits first. **Unproven on Debian 13's systemd:
  test on the box before relying on it.**
- As L18 says, never set `WatchdogSec` until the ping is proven, or systemd
  kills a healthy recorder every interval.
- The ping has to mean progress. It must come from the health timer, and only
  when at least one camera has sealed a segment recently (or none is
  configured). Otherwise a recorder whose ffmpegs are all stuck gets petted
  forever.

## Where alerts go (a decision for Austin, D7)

The box is loopback-only, reached over an SSH tunnel, so an alert that only
lives on the box is seen only when someone looks. The options:

1. **On the box only** (`alerts.json`, `/alerts`, page banner). Free and
   buildable now. Nobody is told.
2. **Pushed to the cloud side**, when B1/B2 exist. Needs the cloud, which is not
   in this plan.
3. **Email or SMS from the box.** Needs outbound network and a provider. Some
   cost money. It also touches the network setup, so it is decided and done
   with Austin there.

Recommended: build 1 now, and design the alert record so 2 can send it
unchanged later.

## Order

1. Contract and harness (dev PC, models implement, the checks come first).
2. `lastSealedUtc` in `health.json`, plus `camctl alerts` (dev PC, file source
   only, no network).
3. Stage 2 on the box:
   - install the timer;
   - freeze the recorder (`kill -STOP`) and watch `recorder_stale` raise and the
     restart happen;
   - fill a disk and watch `disk_filling` raise.
4. The page banner (after the Linux build is approved).
5. Option B, only if option A's detection time proves too slow on the box.
6. `drive_failing`, after L16's `smartctl` output exists.
