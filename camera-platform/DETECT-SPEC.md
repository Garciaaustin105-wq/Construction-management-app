# `camplat-detect` — the detector service (AI-PLAN D1)

**Status: the pure half is built (this document + `contracts/detectSchedule.ts`
+ its harness). The service itself is not.**

D1's exit bar is in AI-PLAN.md and this slice does not reach it: the recall and
false-positive numbers need the clip library, which needs the bench camera, and
the isolation proof needs the running service. What is settled here is the
arithmetic every later piece depends on — **how much of the detector each camera
gets, and which frames it may skip** — because those two decisions are where a
detector fails silently.

## The two failures this contract exists to prevent

**1. Silent starvation.** Sixteen cameras, one chip. If the service simply runs
them all as fast as it can, the cameras that happen to decode quickest get most
of the chip and the rest get whatever is left — which can be nearly nothing. A
person walks past camera 9, camera 9 was running at 0.2 fps, and nobody ever
sees them. Meanwhile the alert rule on camera 9 is enabled and green, so the
store believes that camera is watched. **An unwatched camera must never look
like a watched one.**

**2. Analysing the past.** A detector that falls behind and queues frames keeps
working perfectly and reports later and later. An after-hours person alert that
arrives four minutes late is not a late alert, it is a useless one — the
intruder has gone. So the service **drops frames to stay live and never queues
them**, and a frame older than `MAX_FRAME_LAG_MS` is discarded unanalysed
rather than turned into an event with an honest-looking timestamp.

## What is decided here

### Sharing the chip: `planDetectSchedule`

Modelled on `bandwidth.ts`, deliberately, because it is the same problem and the
house already answered it: **when there is not enough to go round, degrade
everyone rather than dropping anyone.** Fifteen cameras at 4 fps beats twelve at
5 and three at nothing, because the three at nothing are invisible failures.

- Cameras an alert rule is currently watching are `armed`. They hold their
  target while `normal` cameras degrade, and degrade only once the normals are
  at the floor. This is `bandwidth.ts`'s `pinned`, for the same reason.
- Sharing among equals is max-min fair: a camera asking for less than its share
  takes only what it asked for, and the surplus goes back to the others.
- Granted rates are floored to 3 decimals, **downwards**, so the plan can never
  add up to more chip than the box has.

### Two refusals, because a wrong answer here looks fine

- **`unmeasured_capacity`** — the plan refuses when detector throughput is
  `null`. AI-PLAN records that the Hailo-8L is *likely* short at 16 cameras and
  that measured frames-a-second is still "to verify"; `budget.ts` and
  `retention.ts` already refuse to project on an unmeasured camera, and this is
  the same rule (build rule 5, a blank is not a zero). A default of "probably
  80 fps" would produce a confident schedule for a box that cannot keep it.
- **`over_capacity`** — when the cameras do not fit even at
  `MIN_USEFUL_FPS`, the plan refuses and reports `watchableCameras`: how many
  this box can actually watch. That is an installer's decision — fewer cameras
  on detection, or the AI NVR instead of the Standard — and it is exactly the
  decision a silently-degraded schedule would hide. Build rule 11: report the
  measurement, do not render the verdict.

`MIN_USEFUL_FPS` is 1. A person crossing a frame is in it for a second or two;
below one frame a second, whether they are seen is luck. A camera that cannot be
given 1 fps is not being watched, and the contract says so rather than
scheduling it at 0.3 and calling it covered.

### Skipping frames: `shouldProcessFrame`

Pure, and takes epoch milliseconds rather than ISO strings — it is called about
eighty times a second, and `parseUtc` on every frame is a cost with no reader.

It returns a reason, never a bare boolean, so the service can count *why* it
skipped. `too_soon` is the schedule working; a rising `stale` count is the box
being overloaded and is a health fact worth surfacing, not a detail to hide.

Pacing compares timestamps against an exact, possibly fractional `intervalMs`.
It must not round the interval into a timer: at 3 fps, rounding 333.33ms to
333ms drifts a frame every few seconds, which over an hour is a different frame
count than the plan promised.

## Not decided here, and not to be guessed

- Which detector model, and its licence. AI-PLAN's licence rule stands: no
  Ultralytics YOLO, and every model's licence written into `models/LICENSES.md`
  before it is used.
- Real throughput on either chip. Until `camctl` measures it on hardware, every
  caller of this contract has to pass `null` and get a refusal. That is the
  intended behaviour, not a gap to work around.
- The events SQLite file, the crop store and their retention. Separate slice,
  separate contract.
