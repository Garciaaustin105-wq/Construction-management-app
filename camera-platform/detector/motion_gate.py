"""Deciding, frame by frame, whether the detector needs to look at all.

WHY. The model is the expensive part. The EliteDesk manages about 9 frames a
second of it, and 16 cameras at 5 fps ask for 80. Over 19.7 hours on the
bench porch camera (2026-09-21) the scene moved in 2.3% of frames on average,
at a 0.5%-of-pixels threshold (/usr/local/bin/motion-duty.py). Looking only
when something moves is the difference between needing an accelerator and
not.

WHAT IT MUST NEVER DO, in the order it would hurt:
  - miss a person who arrives. When it is not sure, it LOOKS: the first frame,
    a frame with nothing to compare against, a measure it could not read, a
    clock that ran backwards. A wasted look costs CPU; a skipped person is
    the miss this whole product is judged on.
  - break one event into many. A camera that is tracking something (a
    sighting within TRACK_MEMORY_MS) looks every HOLD_INTERVAL_MS even when
    nothing moves. That is three looks inside the fold's 10 s merge gap, so a
    person standing still, or a parked car, stays one event even if two looks
    in a row miss it. And a tracked thing whose OWN patch of the picture is
    changing (LOCAL_THRESHOLD) is looked at every frame, however little the
    whole scene changed: the fold joins sightings by where the box is as well
    as when, so a slow drifter looked at only every 3 s, with one look missed,
    has moved too far to be joined and splits (found in review, 2026-09-21).
  - go blind for good. With nothing moving and nothing tracked it still looks
    every keepalive_ms, so something that arrived below the motion threshold
    is found within that bound.

The policy (decide / after_look) is pure: no I/O, no clock, no numpy. The
measure (grid_of / changed_fraction) is the one motion-duty.py used for the
day-long run: grey at 160x90, a pixel counts as changed when it moves by more
than 12 levels from the previous frame. So the thresholds measured there mean
the same thing here.
"""

import math

# The measure, as motion-duty.py took it.
CELL = 12              # 0-255: a pixel changed when it moved by more than this
GRID_W, GRID_H = 160, 90

# contracts/detection.ts MERGE_GAP_MS: the fold closes an event after this
# long without a sighting. Duplicated because the worker is Python; the check
# in harness/motionGate.harness.mjs compares the two, so they cannot drift.
MERGE_GAP_MS = 10_000

# Look this often at something tracked but still: three looks per merge gap.
HOLD_INTERVAL_MS = 3_000
# A sighting keeps the camera "tracking" for as long as the fold keeps its
# event open.
TRACK_MEMORY_MS = MERGE_GAP_MS

# Both chosen by replaying a real day (2026-09-21, bench porch camera, 21.5 h
# of substream, 86 live person events; detector/gate_replay.py and
# gate_events.py, FIELD-NOTES.md):
#
# Movement: this share of the grid changed. Every one of the 30 confident
# person events (0.8 and over) moved at least 1.45% of the grid, 2.9 times
# this. The events that moved less were low-confidence (median 0.56), and
# the 8 looked at were all fixed objects the detector took for people: a
# furled patio umbrella against the sky, a fence-post cap at dusk. Going
# lower (0.003) cost 1.6 points of load and caught more of those, no
# people.
DEFAULT_THRESHOLD = 0.005
# With nothing moving and nothing tracked, look anyway this often. This is
# the bound on the case the day could not test: a REAL person far enough
# away to move fewer pixels than the threshold. 5 s rather than 10: 6.6% of
# frames looked at over the day instead of 5.2%, both well under the ~11%
# that sixteen cameras can afford on the EliteDesk. Both measured before
# LOCAL_THRESHOLD existed; the live worker reports the load with it.
DEFAULT_KEEPALIVE_MS = 5_000

# A tracked thing is moving when this share of the grid cells under its box
# changed. The reviewer's slow drifter (a 40x100 px box, 4 px a frame) changed
# about a fifth of its cells each frame while the whole scene read 0.36%,
# under DEFAULT_THRESHOLD. A parked car's cells do not change at all, so it
# keeps the cheap 3 s hold.
LOCAL_THRESHOLD = 0.10

LOOK_REASONS = ("first", "unsure", "clock", "motion", "hold", "keepalive")
SKIP_REASONS = ("still", "tracking_still")


def new_state():
    """A camera that has not looked yet."""
    return {"last_look_ms": None, "last_seen_ms": None}


def _finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def decide(state, changed, now_ms, threshold=DEFAULT_THRESHOLD, keepalive_ms=DEFAULT_KEEPALIVE_MS,
           local_changed=None):
    """(look, reason) for one frame. Never raises, never mutates `state`.

    changed: the share of the grid that changed since the previous frame
    (changed_fraction), or None when there was nothing to compare against.
    now_ms:  a monotonic clock in milliseconds.
    local_changed: the largest share of cells that changed under any tracked
    box (local_fraction), or None when nothing is tracked.
    """
    if not isinstance(state, dict) or not _finite(now_ms):
        return True, "unsure"
    last_look = state.get("last_look_ms")
    if not _finite(last_look):
        return True, "first"
    if not _finite(changed) or changed < 0:
        return True, "unsure"
    since_look = now_ms - last_look
    if since_look < 0:
        return True, "clock"
    if not _finite(threshold) or not _finite(keepalive_ms):
        return True, "unsure"
    if changed >= threshold:
        return True, "motion"
    if _finite(local_changed) and local_changed >= LOCAL_THRESHOLD:
        return True, "motion"
    last_seen = state.get("last_seen_ms")
    tracking = _finite(last_seen) and 0 <= now_ms - last_seen <= TRACK_MEMORY_MS
    if tracking:
        if since_look >= HOLD_INTERVAL_MS:
            return True, "hold"
        return False, "tracking_still"
    if since_look >= keepalive_ms:
        return True, "keepalive"
    return False, "still"


def after_look(state, now_ms, tracked):
    """The state after a look. `tracked`: the look found something the
    service keeps (at or above detect.json's minConfidence)."""
    return {
        "last_look_ms": now_ms,
        "last_seen_ms": now_ms if tracked else (state or {}).get("last_seen_ms"),
    }


def grid_of(bgr, pic_w, pic_h):
    """Grey 160x90 of the PICTURE in a letterboxed frame.

    The worker's frames are 640x640 with the picture at the top left and grey
    padding after it. The padding never changes, so leaving it in would dilute
    every measure (a 16:9 picture is 56% of the square). Each grid cell is the
    mean of its block, as ffmpeg's scale averages for motion-duty.py; a
    nearest-pixel sample would keep the sensor noise that averaging removes,
    and the measured thresholds would not carry over.
    """
    import numpy as np
    h, w = bgr.shape[:2]
    pic_w = max(1, min(int(pic_w), w))
    pic_h = max(1, min(int(pic_h), h))
    # Blocks of at least one pixel. A picture smaller than 160x90 (or a
    # portrait one) gets a smaller grid rather than a crop that reaches into
    # the padding, which never changes and would dilute every measure.
    bw, bh = max(1, pic_w // GRID_W), max(1, pic_h // GRID_H)
    gw, gh = pic_w // bw, pic_h // bh
    pic = bgr[: bh * gh, : bw * gw].astype(np.float32)
    # BT.601 luma from B, G, R: what ffmpeg's format=gray gives.
    grey = pic[:, :, 0] * 0.114 + pic[:, :, 1] * 0.587 + pic[:, :, 2] * 0.299
    return grey.reshape(gh, bh, gw, bw).mean(axis=(1, 3))


def changed_fraction(prev, cur, cell=CELL):
    """Share of grid cells that moved by more than `cell`, or None when the
    two cannot be compared (no previous frame, a shape that changed). None is
    not zero: decide() looks on None."""
    if prev is None or cur is None:
        return None
    if getattr(prev, "shape", None) != getattr(cur, "shape", None):
        return None
    import numpy as np
    return float((np.abs(cur - prev) > cell).mean())


def local_fraction(prev, cur, boxes, cell=CELL):
    """The largest share of changed cells under any of `boxes` (x, y, w, h as
    fractions of the picture, as the worker reports them), or None when there
    are no boxes or the frames cannot be compared."""
    if not boxes or prev is None or cur is None:
        return None
    if getattr(prev, "shape", None) != getattr(cur, "shape", None):
        return None
    import math as m
    import numpy as np
    mask = np.abs(cur - prev) > cell
    gh, gw = mask.shape
    best = 0.0
    for b in boxes:
        try:
            x0 = min(gw - 1, max(0, int(m.floor(b["x"] * gw))))
            y0 = min(gh - 1, max(0, int(m.floor(b["y"] * gh))))
            x1 = min(gw, max(x0 + 1, int(m.ceil((b["x"] + b["w"]) * gw))))
            y1 = min(gh, max(y0 + 1, int(m.ceil((b["y"] + b["h"]) * gh))))
        except (KeyError, TypeError, ValueError):
            continue
        best = max(best, float(mask[y0:y1, x0:x1].mean()))
    return best


WINDOW_S = 60  # the worker reports what the gate did about once a minute


class Gate:
    """The gate as yolox_worker.py and replay.py run it: the policy, the
    measure, and the counts. One class for both, so the scoring runner gates
    exactly as live does.

    Times are milliseconds on the caller's clock: monotonic wall time live,
    frame time in a replay. Nothing here reads a clock.
    """

    def __init__(self, pic_w, pic_h, track_floor, threshold=DEFAULT_THRESHOLD,
                 keepalive_ms=DEFAULT_KEEPALIVE_MS, window_s=WINDOW_S):
        self.pic_w, self.pic_h = pic_w, pic_h
        self.track_floor = track_floor
        self.threshold, self.keepalive_ms = threshold, keepalive_ms
        self.window_ms = window_s * 1000
        self.state = new_state()
        self.prev = None
        # The boxes of what the last looks kept, while tracking lasts.
        self.boxes = []
        self.total = self._zero()
        self.window = self._zero()
        self.window_start_ms = None

    @staticmethod
    def _zero():
        return {"frames": 0, "looked": 0, "reasons": {r: 0 for r in LOOK_REASONS}}

    def should_look(self, bgr, now_ms):
        """Measure this frame against the last and decide. Counts it either way."""
        if self.window_start_ms is None:
            self.window_start_ms = now_ms
        try:
            grid = grid_of(bgr, self.pic_w, self.pic_h)
        except Exception:  # a frame that cannot be measured is looked at, never skipped
            grid = None
        changed = changed_fraction(self.prev, grid)
        seen = self.state.get("last_seen_ms")
        if self.boxes and (seen is None or not 0 <= now_ms - seen <= TRACK_MEMORY_MS):
            self.boxes = []  # tracking has lapsed: nothing left to watch locally
        local = local_fraction(self.prev, grid, self.boxes)
        self.prev = grid
        look, reason = decide(self.state, changed, now_ms, self.threshold, self.keepalive_ms, local)
        for c in (self.total, self.window):
            c["frames"] += 1
            if look:
                c["looked"] += 1
                c["reasons"][reason] += 1
        return look

    def looked(self, detections, now_ms):
        """Record what the look found. Tracking counts only what the service
        keeps, so a faint 0.3 guess does not hold the camera at the look-every-
        3-s rate all day."""
        kept = [d for d in detections if d.get("confidence", 0) >= self.track_floor]
        # A look that misses keeps the last boxes: the thing is very likely
        # still there, and its patch is where movement would show.
        boxes = [d["box"] for d in kept if isinstance(d.get("box"), dict)]
        if boxes:
            self.boxes = boxes
        self.state = after_look(self.state, now_ms, bool(kept))

    def window_report(self, now_ms):
        """The once-a-minute gate line, or None when the minute is not up."""
        if self.window_start_ms is None or now_ms - self.window_start_ms < self.window_ms:
            return None
        line = {"type": "gate", "windowS": round((now_ms - self.window_start_ms) / 1000, 1), **self.window}
        self.window = self._zero()
        self.window_start_ms = now_ms
        return line

    def totals(self):
        """Every frame since the start, for replay's final line."""
        return {"type": "gate", **self.total}

    def save(self):
        """What the next replay of the same clip needs to carry on as ONE gate,
        as live does across segment boundaries: the policy state, the boxes it
        is watching, and the last grid. JSON-safe; counts are not carried, so
        each file's totals are its own."""
        return {"state": dict(self.state), "boxes": list(self.boxes),
                "prev": None if self.prev is None else self.prev.tolist()}

    def restore(self, saved):
        """Carry on from save(). Anything unreadable starts fresh, which only
        makes the gate look more, never less."""
        import numpy as np
        try:
            st = saved["state"]
            self.state = {"last_look_ms": st.get("last_look_ms"), "last_seen_ms": st.get("last_seen_ms")}
            self.boxes = [b for b in saved.get("boxes", []) if isinstance(b, dict)]
            self.prev = None if saved.get("prev") is None else np.array(saved["prev"], dtype=np.float32)
        except (KeyError, TypeError, ValueError, AttributeError):
            self.state, self.boxes, self.prev = new_state(), [], None
