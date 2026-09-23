#!/usr/bin/env python3
"""camplat-detect worker: one camera's substream in, one JSON line per frame out.

Run by agent/detect-service.mjs, never by hand on a site. Protocol (stdout, one
JSON object per line; contracts/detectStream.ts reads and checks every line):

  {"type": "ready", "model": "yolox_s", "inputSize": 640}
  {"type": "frame", "atUtc": "...Z", "timeSource": "arrival", "detections": [
      {"kind": "vehicle", "species": "truck", "confidence": 0.82,
       "box": {"x": .., "y": .., "w": .., "h": ..}}]}
  {"type": "error", "message": "..."}

Boxes are fractions of the camera's frame (0..1). The worker never prints the
camera URL: it carries the password (bench 2026-09-19), so errors say what
failed, not where.

Decoding is ffmpeg's (the substream, decimated to --fps by a select filter,
letterboxed to the model's square input). Inference is ONNX Runtime on the CPU
here; the Hailo-8 build swaps run_model() and nothing else. Pre- and post-processing
follow YOLOX's own demo (Megvii-BaseDetection/YOLOX, demo/ONNXRuntime):
BGR, unnormalised 0..255, image at the top-left of a 114-grey square; outputs
decoded on strides 8/16/32, score = objectness x class, per-class NMS.

Only numpy and onnxruntime are needed. postprocess() and letterbox_ratio() are
pure and tested by detector/test_postprocess.py.

With --gate the model runs only on frames motion_gate.Gate says to look at,
so a "frame" line is printed only for those, and about once a minute a line
  {"type": "gate", "windowS": 60, "frames": N, "looked": K,
   "reasons": {"first": .., "unsure": .., "clock": .., "motion": .., "hold": .., "keepalive": ..}}
says how many frames were read and why each look happened: the measured
load of this camera, which is what decides how many cameras a box can take.

TIMESTAMPING. atUtc used to be stamped when a frame was READ from ffmpeg's
stdout pipe - after RTSP buffering, software decode, the fps/scale/pad filters
and the pipe itself. Measured on a live camera (event-times-lag-footage,
2026-09-21/22): stored event times ran 0.7-2.4 s LATER than the footage of the
same moment, median ~1.1-1.2 s, growing over the day. Fixed at the source: the
ffmpeg input runs with -use_wallclock_as_timestamps, which stamps each packet
with the wall clock at the moment ITS BYTES ARRIVED, and -copyts, which carries
that stamp through decode and the filter chain instead of ffmpeg's default of
rebasing timestamps to start at zero. showinfo is placed LAST in the filter
chain (see the vf string in main()) so it reports each OUTPUT frame's time on
stderr - the same frame count as what main()'s loop reads from stdout, one
read per output frame, so pairing by index (PtsPairer) lines the two up.

showinfo's own `pts_time` text field is NOT used: measured on the box
(ffmpeg 6.1.1, fps 5 and fps 8) it is printed with printf's default %g, six
significant figures - at a ~1.79e9 s Unix epoch that keeps only ~1000 s of
resolution, useless as a wall clock (rule 6: a wrong unit looks fine here,
this looks fine and is off by however many hundreds of seconds rounding ate).
Used instead: the raw integer `pts` field, exact, divided by the exact
time_base showinfo itself reports once at filter init ("config in time_base:
N/D") - never assumed to be 1/--fps, though it measured out that way both
times, because a wrong assumption here would look exactly as plausible as a
right one (rule 10).

NO MANUFACTURED FRAMES, NO GRID QUANTIZATION. An adversarial review of the
first pass of this fix (uncommitted, 2026-09-23) found that `fps=N` - a
CONSTANT FRAME RATE filter - was doing double duty as the decimator, and that
is the wrong tool: when no new frame has arrived by fps='s next output tick,
it DUPLICATES the last frame it saw and rewrites the copy's PTS onto its own
even output grid. showinfo, downstream of it, dutifully reports that invented
PTS as if it were a real arrival - worst exactly when the stream is already
stalling, which is when the timestamp matters most - and even a fresh frame's
real PTS gets quantized onto the same ~60-100 ms grid. Replaced with `select`:
it only ever passes an EXISTING frame through, at its own PTS, never invents
one, so it decimates instead of resampling - `isnan(prev_selected_t)+
gt(floor(t*fps),floor(prev_selected_t*fps))` keeps the first frame that
arrives in each 1/fps slot of the wall clock, measured on the frame's own
arrival-stamped PTS (a "1/fps since the last one" rule measured 4.0 frames a
second at --fps 5: every gap overshoots to the next arrival). `-fps_mode vfr` (the
ffmpeg 6.1/5.1+ replacement for `-vsync vfr`) is the second half of the same
fix: it tells the rawvideo output to pass frames through with their own
timestamps rather than padding to a constant rate, so even a future change
upstream cannot make the OUTPUT stage manufacture a duplicate to keep pace.
Net effect for detector/detect-service.mjs: this worker may now see fewer
than `fps` frames a second while the stream stutters - never more, and never
a copy of a frame it already reported.

Belt and suspenders: showinfo also reports each frame's content `checksum`.
PtsPairer.offer() compares it against the checksum of the frame immediately
before it (by ffmpeg's own frame index, not stderr arrival order) and marks a
match as a duplicate; main() refuses to call such a frame "arrival" even if
its pts paired cleanly, falling back to "read" instead (see PtsPairer.take()
and ArrivalStamps.wait_for()). This is a backstop, not the primary defence -
`select`+`-fps_mode vfr` above should mean ffmpeg itself never manufactures a
duplicate any more - for a duplicate that reaches this worker by some other
path (a future regression, an unusual ffmpeg build). It is deliberately
conservative in one direction only: a genuinely static camera view CAN emit
two REAL, distinct frames whose pixels checksum identically, and those will
also fall back to "read" once in a while - a small utility cost, traded
against rule 10 (refuse rather than guess when a wrong answer would look
plausible) rather than ever inventing a timestamp.

Pairing can fail a frame at a time (a missed or garbled stderr line, or one
that has not arrived yet) without failing the worker: PtsPairer.take() gives
back (None, False), and that frame's atUtc falls back to the read-time stamp
exactly as before, marked "timeSource": "read" rather than "arrival" so a
measurement can tell which is which (rule 17 - never blend a measurement with
an assumption). The wait for a late line is bounded (STDERR_WAIT_S); a frame
the gate itself skipped is never waited on at all. See
detector/test_arrival_stamps.py for the pairing logic's own tests, including
real showinfo lines captured on the box.

STDERR THREAD SUPERVISION. _drain_stderr's thread is what keeps ffmpeg's
stderr pipe from filling and blocking ffmpeg's own writes (see its docstring)
- and it is also the only source PtsPairer ever hears from. If it ever stops
while ffmpeg is still running (today that should only happen if a future
change breaks the broad except around its read loop; it is not expected in
this version), nothing raises: every later frame would just silently fall
back to "read", forever, with nothing in the logs to say why. main()'s loop
checks stderr_reader_dead(stderr_thread, ff) every iteration, alongside the
existing STALL_SECONDS check, and - unlike that check, which only logs - exits
on it, so the service that runs this worker restarts it into a fresh ffmpeg
and a fresh thread rather than let it limp along degraded.
"""
import argparse
import json
import math
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

import motion_gate

# How long to wait for the stderr showinfo line matching a frame already read
# from stdout before giving up and stamping it with the read-time fallback
# instead. showinfo runs as the LAST step before a frame is muxed to stdout,
# so in practice the two arrive within milliseconds of each other on separate
# OS pipes from the same ffmpeg process; 0.5 s is generous slack for
# scheduling jitter while staying far under STALL_SECONDS and under the
# shortest frame interval this product runs (a camera below 2 fps is not
# expected), so a consistently slow or missing stderr line costs at most a
# fraction of a frame's worth of delay, never a hang.
STDERR_WAIT_S = 0.5

# ffmpeg's showinfo filter, one line per OUTPUT frame it sees, e.g.:
#   [Parsed_showinfo_3 @ 0x...] n:   0 pts:8950910562 pts_time:1.79018e+09
#   duration: 1 duration_time:0.2 fmt:bgr24 cl:left sar:0/1 s:640x640 i:P
#   iskey:0 type:P checksum:8F5F093D plane_checksum:[8F5F093D] mean:[106]
#   stdev:[47.0]
# and once at filter init:
#   [Parsed_showinfo_3 @ 0x...] config in time_base: 1/5, frame_rate: 5/1
# Both captured verbatim from the box's ffmpeg (6.1.1-3ubuntu5) at fps 5 and
# fps 8; detector/test_arrival_stamps.py parses those exact lines. The
# checksum group is optional (wrapped in its own non-capturing group) so a
# line missing it - a different ffmpeg build, a line torn mid-write - still
# yields (n, pts, None) rather than failing to match at all: the pts pairing
# must not depend on the duplicate-detection backstop being available.
SHOWINFO_TIME_BASE_RE = re.compile(r"config in time_base:\s*(-?\d+)/(\d+)\b")
SHOWINFO_FRAME_RE = re.compile(
    r"\bn:\s*(\d+)\b.*?\bpts:\s*(-?\d+)\b(?:.*?\bchecksum:\s*([0-9A-Fa-f]+)\b)?"
)


def parse_showinfo_time_base(line):
    """(num, den) from showinfo's one-time "config in time_base: N/D" line,
    or None. Read once per worker run (learn_time_base) and used to turn
    every later frame's raw integer pts into seconds - never showinfo's own
    pts_time text (see the module docstring: it loses everything below
    ~1000 s of resolution at this magnitude). Never raises."""
    if not isinstance(line, str):
        return None
    m = SHOWINFO_TIME_BASE_RE.search(line)
    if not m:
        return None
    try:
        num, den = int(m.group(1)), int(m.group(2))
    except ValueError:
        return None
    if den <= 0 or num <= 0:
        return None
    return num, den


def parse_showinfo_frame(line):
    """(n, pts, checksum) - the frame index, its RAW integer pts in whatever
    time_base parse_showinfo_time_base last learned, and showinfo's content
    checksum (a hex string, or None when the line has no checksum field) -
    from one showinfo frame report line, or None when the line is not one
    (ffmpeg's other stderr chatter at -loglevel info, a progress line, a line
    torn in half by a buffered read). Never raises. The checksum is used only
    to flag a frame whose content exactly repeats the one before it
    (PtsPairer.offer) - never to pair or order anything, that stays the raw
    pts's job."""
    if not isinstance(line, str):
        return None
    m = SHOWINFO_FRAME_RE.search(line)
    if not m:
        return None
    try:
        n, pts = int(m.group(1)), int(m.group(2))
    except ValueError:
        return None
    return n, pts, m.group(3)


class PtsPairer:
    """Pairs a frame read from ffmpeg's stdout, by its sequential index, with
    the arrival wall-clock time showinfo reported for that same output frame
    on stderr. Pure with respect to time and I/O - the caller (ArrivalStamps
    below) decides when to give up waiting; this only remembers what it has
    been told and does the pts -> seconds arithmetic once the time_base is
    known.

    offer() and learn_time_base() accept whatever arrives, in whatever order:
    a duplicate line for an index already offered just overwrites (real
    ffmpeg reports each frame once; nothing here assumes a caller cannot
    retry), and an index offered out of order is filed under its own key
    regardless of when it arrived - there is no ordering requirement between
    stdout and stderr beyond "eventually, for the same frame".

    Bounded: offer() forgets anything more than EVICT_HORIZON frames older
    than the newest index it has seen, so an index whose line never arrives
    (skipped by the motion gate and never waited on, or genuinely lost)
    cannot grow this dict for the life of a worker that runs for days.

    Also flags a duplicate: a frame whose showinfo checksum exactly matches
    the checksum of the frame immediately before it, by ffmpeg's own frame
    index n - not stderr arrival order, which real ffmpeg does not reorder
    within a run but offer() does not require either (see above). Tracked as
    `_last_checksum`, the checksum of the most recently OFFERED frame: valid
    because real ffmpeg emits one stderr line per frame strictly in the order
    frames pass through the filter chain, so consecutive offer() calls are, in
    practice, consecutive frames. take() hands the flag back alongside the
    time so the caller can refuse to call a duplicate "arrival" - see the
    module docstring's NO MANUFACTURED FRAMES section for why this exists and
    why it only ever costs a fallback to "read", never a wrong "arrival".
    """

    EVICT_HORIZON = 200  # ~40 s of frames at 5 fps: far more slack than any
                          # reordering or delay actually seen between ffmpeg's
                          # stdout and stderr, and still bounded.

    def __init__(self):
        self._raw = {}       # frame index -> (raw integer pts, is_duplicate)
        self._max_n = -1
        self.time_base = None  # (num, den), or None until learned
        self._last_checksum = None  # the most recently OFFERED frame's
                                     # checksum, or None; never reset by an
                                     # offer() that has no checksum of its own

    def learn_time_base(self, num, den):
        if num > 0 and den > 0:
            self.time_base = (num, den)

    def offer(self, n, pts, checksum=None):
        is_duplicate = checksum is not None and checksum == self._last_checksum
        self._raw[n] = (pts, is_duplicate)
        if checksum is not None:
            self._last_checksum = checksum
        if n > self._max_n:
            self._max_n = n
            horizon = self._max_n - self.EVICT_HORIZON
            if horizon > 0:
                for stale in [k for k in self._raw if k < horizon]:
                    del self._raw[stale]

    def _seconds(self, pts):
        if self.time_base is None:
            return None
        num, den = self.time_base
        return pts * num / den

    def peek(self, n):
        """The arrival time for frame n if already known, without forgetting
        it. None when it has not arrived (yet, or ever) or the time_base
        needed to convert it is not known yet. Duplicate status is not part
        of peek()'s answer - it is only meaningful once, at take() time, the
        same as the pairing itself."""
        entry = self._raw.get(n)
        if entry is None:
            return None
        pts, _ = entry
        return self._seconds(pts)

    def take(self, n):
        """Like peek(), but forgets it - the pairing is used once, the same
        as a frame is read once. Returns (seconds_or_None, is_duplicate):
        is_duplicate is False both when n is genuinely unique and when n was
        never offered at all - the caller already treats seconds is None as
        "no arrival stamp", so an unknown frame being reported as "not a
        duplicate" claims nothing further."""
        entry = self._raw.pop(n, None)
        if entry is None:
            return None, False
        pts, is_duplicate = entry
        return self._seconds(pts), is_duplicate

    def discard(self, n):
        self._raw.pop(n, None)


class ArrivalStamps:
    """Thread-safe glue around PtsPairer: the stderr-reading thread calls
    offer_line() for every line it reads; the frame-reading thread calls
    wait_for(n, timeout_s) after deciding a frame IS going to be reported
    (never for a frame the gate skipped - those cost nothing) and gets back
    (seconds_or_None, is_duplicate) - seconds is None if nothing arrived
    within the bound, and is_duplicate (see PtsPairer.offer) is the caller's
    signal to refuse "arrival" even when seconds is not None. Never blocks
    longer than timeout_s, so a stalled or missing stderr line costs that
    frame its arrival stamp, never the worker its liveness.
    """

    def __init__(self):
        self._pairer = PtsPairer()
        self._cond = threading.Condition()

    def offer_line(self, line):
        tb = parse_showinfo_time_base(line)
        if tb is not None:
            with self._cond:
                self._pairer.learn_time_base(*tb)
                self._cond.notify_all()
            return
        fr = parse_showinfo_frame(line)
        if fr is None:
            return
        n, pts, checksum = fr
        with self._cond:
            self._pairer.offer(n, pts, checksum)
            self._cond.notify_all()

    def wait_for(self, n, timeout_s):
        """(seconds_or_None, is_duplicate) - see the class docstring."""
        deadline = time.monotonic() + timeout_s
        with self._cond:
            while self._pairer.peek(n) is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(remaining)
            return self._pairer.take(n)


def _drain_stderr(pipe, stamps):
    """Read ffmpeg's stderr for as long as the process lives, offering every
    line to `stamps`. Runs in its own thread so ffmpeg's stderr pipe is never
    left unread: once it is captured with PIPE instead of DEVNULL (required
    to see showinfo's report at all), an unread pipe fills its OS buffer and
    blocks ffmpeg's next write to it, which would stall the whole worker -
    gated or not, showinfo or not, this thread must run.

    At -loglevel info (needed: showinfo logs at AV_LOG_INFO, one level above
    the "error" this worker used before) ffmpeg ALSO logs its own input
    banner, which names the substream URL with its password, and per-second
    progress stats. Those bytes are read into this process's memory and go
    NO FURTHER: only the handful of numbers and hex digits per line that
    match SHOWINFO_TIME_BASE_RE or SHOWINFO_FRAME_RE ever leave this
    function, and every other line - including any that name the camera - is
    parsed, found not to match, and dropped. Nothing here is ever printed,
    said() over stdout, or raised into an exception message.

    The broad excepts below mean this loop should not be able to exit while
    `pipe` still has data or the process behind it is still alive - but if a
    future change ever breaks that, main()'s stderr_reader_dead() check is
    what notices: this function does not, and must not, try to signal its own
    death (a thread cannot safely say anything about itself failing after the
    fact; the supervision lives with the thing that can still act on it).
    """
    try:
        for raw in iter(pipe.readline, b""):
            try:
                line = raw.decode("utf-8", errors="replace")
                stamps.offer_line(line)
            except Exception:
                continue  # one unreadable or unparsable line costs only itself
    except Exception:
        pass  # the pipe went away with the process; the main loop notices too
    finally:
        try:
            pipe.close()
        except Exception:
            pass


# How far an arrival stamp may sit from the moment its frame was read before
# it is refused as implausible. Arrival comes first, so the stamp may be
# EARLIER than the read by the pipeline's lag - measured at a 1.18 s median on
# the bench, so a minute is far past any lag this worker would still be
# running live through - and later only by a clock step between the two
# readings of the same box clock.
MAX_ARRIVAL_LAG_S = 60.0
MAX_ARRIVAL_LEAD_S = 2.0


def resolve_time_source(arrival_s, is_duplicate, read_s):
    """"arrival" or "read" - the one decision that must never call a
    manufactured or duplicated time "arrival": given what
    ArrivalStamps.wait_for() returned for a frame, "arrival" only when a
    pairing was actually found (arrival_s is not None), it was not flagged a
    duplicate, AND it is plausible against read_s, the wall-clock second the
    frame was read; "read" for any failure alone - no pairing at all, a
    pairing that repeats the frame before it (see PtsPairer.offer), or a
    stamp outside [read_s - MAX_ARRIVAL_LAG_S, read_s + MAX_ARRIVAL_LEAD_S].
    Found 2026-09-23 on the bench: the first frame after a restart paired
    with pts 0 and was stored as an event at 1970-01-01. Pulled out of
    main()'s loop as its own pure function (rule 2: split I/O from maths) so
    this exact decision is unit-tested directly rather than only through
    main(), which cannot run without a real ffmpeg."""
    if arrival_s is None or is_duplicate:
        return "read"
    if not math.isfinite(arrival_s):
        return "read"
    if arrival_s < read_s - MAX_ARRIVAL_LAG_S or arrival_s > read_s + MAX_ARRIVAL_LEAD_S:
        return "read"
    return "arrival"


def stderr_reader_dead(stderr_thread, ffmpeg_proc):
    """True exactly when _drain_stderr's thread has stopped but ffmpeg is
    still running - the one failure this worker cannot recover from on its
    own: no more showinfo lines will ever reach ArrivalStamps, so every frame
    from here on would silently fall back to timeSource "read" forever, with
    nothing in the logs to say why (the MEDIUM finding this fixes - no
    liveness supervision on that thread). False while the thread is alive.
    Also false once ffmpeg itself has exited: that is the thread's own normal
    end (its pipe closes with the process), handled by the ordinary
    "substream ended" path in main()'s read loop, not by this one - checking
    ffmpeg_proc.poll() here is what tells the two apart."""
    return (not stderr_thread.is_alive()) and (ffmpeg_proc.poll() is None)

INPUT = 640
STRIDES = (8, 16, 32)
# COCO class ids -> the kinds contracts/detection.ts stores.
KIND_OF_CLASS = {0: "person", 2: "vehicle", 3: "vehicle", 5: "vehicle", 7: "vehicle"}
# COCO class ids -> the species contracts/detection.ts stores (SPECIES_OF_KIND
# there is the source of truth; keep this in lockstep with it by hand, since
# nothing here can import a .ts file). Every key is also a key of
# KIND_OF_CLASS, and SPECIES_OF_CLASS[c] must always be a species of
# KIND_OF_CLASS[c] - a mismatch would make checkDetection refuse the whole
# detection ("bad_species"), not just drop the word.
SPECIES_OF_CLASS = {0: "person", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
SCORE_FLOOR = 0.25   # permissive: alert rules apply their own, higher floors
NMS_IOU = 0.45
STALL_SECONDS = 15   # no frame for this long: exit, and the service restarts us
RTSP_TIMEOUT_US = "10000000"  # the recorder's socket timeout (agent/recorder.mjs)


def say(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _iso(dt):
    """A datetime (UTC) as contracts/time.ts's parseUtc expects: milliseconds,
    'Z' rather than '+00:00'."""
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def letterbox_ratio(width, height, size=INPUT):
    """The scale that fits a width x height frame inside size x size."""
    return min(size / width, size / height)


def nms(boxes, scores, iou_threshold):
    """Greedy NMS on xyxy boxes. Returns kept indices, best score first."""
    import numpy as np
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        area_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        area_o = (boxes[order[1:], 2] - boxes[order[1:], 0]) * (boxes[order[1:], 3] - boxes[order[1:], 1])
        iou = inter / np.maximum(area_i + area_o - inter, 1e-9)
        order = order[1:][iou <= iou_threshold]
    return keep


def postprocess(output, width, height, size=INPUT, score_floor=SCORE_FLOOR, nms_iou=NMS_IOU):
    """YOLOX raw output (1, N, 5 + classes) -> detections for the frame.

    1. Decode: for each stride s, a grid of (size/s)^2 cells; cx,cy =
       (raw + cell) * s; w,h = exp(raw) * s.
    2. score = objectness x class probability, per class we keep; for each
       anchor also remember WHICH of the kind's classes scored highest, so the
       species survives the max() that picks the kind's score.
    3. Per kind, drop below score_floor, NMS at nms_iou - per kind, not per
       species (see the comment at the call site: a car reading and a truck
       reading of the same box are one physical object, not two).
    4. Undo the letterbox (divide by the ratio: the image sits at the top-left)
       and express boxes as fractions of the camera frame, clipped to it.
       Species is the winning class of the kept, winning anchor.
    """
    import numpy as np
    pred = np.array(output, dtype=np.float32).reshape(-1, output.shape[-1]).copy()
    grids, expanded = [], []
    for s in STRIDES:
        n = size // s
        xv, yv = np.meshgrid(np.arange(n), np.arange(n))
        grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
        expanded.append(np.full((n * n, 1), s))
    grid = np.concatenate(grids, 0).astype(np.float32)
    stride = np.concatenate(expanded, 0).astype(np.float32)
    if pred.shape[0] != grid.shape[0]:
        raise ValueError(f"model output has {pred.shape[0]} anchors, expected {grid.shape[0]} for {size}px")
    pred[:, :2] = (pred[:, :2] + grid) * stride
    pred[:, 2:4] = np.exp(pred[:, 2:4]) * stride

    ratio = letterbox_ratio(width, height, size)
    cx, cy, w, h = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
    xyxy = np.stack((cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), 1) / ratio
    objectness = pred[:, 4]

    detections = []
    for kind in ("person", "vehicle"):
        class_ids = [c for c, k in KIND_OF_CLASS.items() if k == kind]
        # One score per anchor per class in this kind; scores.max(1) is exactly
        # the old per-kind score, and winner.argmax(1) is the class that won it
        # - the thing the old max() threw away.
        class_scores = objectness[:, None] * pred[:, 5:][:, class_ids]
        scores = class_scores.max(1)
        winner = class_scores.argmax(1)
        mask = scores >= score_floor
        if not mask.any():
            continue
        b, sc, win = xyxy[mask], scores[mask], winner[mask]
        # NMS stays per KIND, not per species: a car-class box and a truck-class
        # box overlapping the same object are two readings of one thing (the
        # same reason a person seen by two grid cells is one detection, not
        # two), so they must still suppress each other. Splitting NMS by
        # species would let a van that reads "car" from the front and "truck"
        # from the side survive as two vehicles for one physical object.
        for i in nms(b, sc, nms_iou):
            x1 = float(np.clip(b[i, 0], 0, width))
            y1 = float(np.clip(b[i, 1], 0, height))
            x2 = float(np.clip(b[i, 2], 0, width))
            y2 = float(np.clip(b[i, 3], 0, height))
            if x2 - x1 < 1 or y2 - y1 < 1:
                continue
            fx, fy = x1 / width, y1 / height
            fw, fh = min((x2 - x1) / width, 1.0 - fx), min((y2 - y1) / height, 1.0 - fy)
            detections.append({
                "kind": kind,
                "species": SPECIES_OF_CLASS[class_ids[win[i]]],
                "confidence": round(float(sc[i]), 4),
                "box": {"x": round(fx, 5), "y": round(fy, 5), "w": round(fw, 5), "h": round(fh, 5)},
            })
    return detections


def probe_size(url):
    """The substream's width and height, from ffprobe. None when it cannot tell."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-timeout", RTSP_TIMEOUT_US,
             "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", url],
            capture_output=True, text=True, timeout=30,
        )
        w, h = (int(v) for v in out.stdout.strip().split(",")[:2])
        return (w, h) if w > 0 and h > 0 else None
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--fps", type=float, required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--threads", type=int, default=2)
    # Motion gate (detector/motion_gate.py): look only when something moves,
    # holds still while tracked, or is due a keepalive. Off unless detect.json
    # turns it on; detect-service passes these.
    ap.add_argument("--gate", action="store_true")
    ap.add_argument("--track-floor", type=float, default=None,
                    help="detect.json minConfidence: what counts as tracking")
    ap.add_argument("--gate-threshold", type=float, default=None)
    ap.add_argument("--gate-keepalive-ms", type=float, default=None)
    args = ap.parse_args()
    gate_settings = None
    if args.gate:
        threshold = motion_gate.DEFAULT_THRESHOLD if args.gate_threshold is None else args.gate_threshold
        keepalive = motion_gate.DEFAULT_KEEPALIVE_MS if args.gate_keepalive_ms is None else args.gate_keepalive_ms
        # Refused here rather than guessed: a gate that never looks, or one
        # that ignores every sighting, would read as a quiet camera.
        if args.track_floor is None or not 0 <= args.track_floor <= 1:
            say({"type": "error", "message": "--gate needs --track-floor from 0 to 1"})
            return 2
        if not 0 < threshold < 1 or not 1000 <= keepalive <= 600000:
            say({"type": "error", "message": "the gate's threshold must be between 0 and 1, its keepalive 1000-600000 ms"})
            return 2
        gate_settings = (args.track_floor, threshold, keepalive)

    import numpy as np
    import onnxruntime as ort

    size = probe_size(args.url)
    if size is None:
        say({"type": "error", "message": "could not read the substream's picture size (camera unreachable?)"})
        return 2
    width, height = size

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, args.threads)
    session = ort.InferenceSession(args.model, sess_options=opts, providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name

    def run_model(bgr):
        blob = bgr.transpose(2, 0, 1)[None].astype(np.float32)  # HWC BGR 0..255 -> NCHW
        return session.run(None, {input_name: blob})[0]

    # showinfo LAST: it must see the frame after select/scale/pad, the same
    # one main()'s loop reads from stdout, one read per output frame, so its
    # `n` lines up with the read loop's own frame_index without any
    # translation.
    #
    # select, not fps=: fps= is a constant-frame-rate filter - when no new
    # frame has arrived by its next output tick it DUPLICATES the last frame
    # it saw and rewrites the copy's PTS onto its own even output grid, which
    # showinfo then reports as an invented "arrival". select only ever passes
    # an EXISTING frame through at its own PTS - it decimates, never
    # resamples. It keeps the FIRST frame that arrives in each 1/fps slot of
    # the wall clock: `gt(floor(t*fps),floor(prev_selected_t*fps))`, measured
    # on the frame's own arrival-stamped PTS. (The isnan() term is ffmpeg's
    # own idiom for "always keep the first frame": prev_selected_t is NaN
    # until something has been selected, and any comparison against NaN is
    # false.) Slots, not "at least 1/fps since the last one": measured
    # 2026-09-23, that spacing rule gave 4.0 frames a second at --fps 5,
    # because every gap overshoots to the next arriving frame, so each second
    # lost a frame. A slot rule keeps one frame per slot whenever one arrives:
    # `fps` a second on a healthy stream, fewer during a stall, never more,
    # never a copy. See the module docstring's NO MANUFACTURED FRAMES section.
    vf = (f"select='isnan(prev_selected_t)+gt(floor(t*{args.fps}),floor(prev_selected_t*{args.fps}))',"
          f"scale={INPUT}:{INPUT}:force_original_aspect_ratio=decrease,"
          f"pad={INPUT}:{INPUT}:0:0:color=0x727272,showinfo")
    ff = subprocess.Popen(
        # -use_wallclock_as_timestamps stamps each input packet with the wall
        # clock at the moment it is read from the RTSP socket - the packet's
        # ARRIVAL, not whenever this process later gets around to decoding
        # and filtering it. -copyts carries that stamp through instead of
        # ffmpeg's default of rebasing every output to start at zero, so it
        # survives to showinfo at the far end of the filter chain. -loglevel
        # info (up from "error"): showinfo logs at AV_LOG_INFO, one level
        # this worker used to suppress entirely - see _drain_stderr for what
        # that costs and why it is safe. -fps_mode vfr (the ffmpeg 5.1+
        # replacement for -vsync vfr) is the output-side half of the same fix
        # as `select` above: it passes frames through to the rawvideo muxer
        # with their own timestamps instead of padding to a constant rate, so
        # this stage cannot manufacture a duplicate either, even if some
        # future change to `vf` reintroduces a frame-rate filter upstream.
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info",
         "-use_wallclock_as_timestamps", "1", "-rtsp_transport", "tcp",
         "-timeout", RTSP_TIMEOUT_US, "-i", args.url, "-an", "-copyts",
         "-fps_mode", "vfr", "-vf", vf,
         "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    stamps = ArrivalStamps()
    stderr_thread = threading.Thread(target=_drain_stderr, args=(ff.stderr, stamps), daemon=True)
    stderr_thread.start()
    say({"type": "ready", "model": args.model.rsplit("/", 1)[-1].rsplit(".", 1)[0], "inputSize": INPUT})

    frame_bytes = INPUT * INPUT * 3
    gate = None
    if gate_settings is not None:
        ratio = letterbox_ratio(width, height)
        floor, threshold, keepalive = gate_settings
        gate = motion_gate.Gate(int(width * ratio), int(height * ratio), floor, threshold, keepalive)
    frame_index = 0
    last = time.monotonic()
    try:
        while True:
            buf = ff.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                say({"type": "error", "message": "the substream ended"})
                return 3
            read_at = datetime.now(timezone.utc)
            idx = frame_index
            frame_index += 1
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(INPUT, INPUT, 3)
            now_ms = time.monotonic() * 1000
            if gate is None or gate.should_look(frame, now_ms):
                detections = postprocess(run_model(frame), width, height)
                if gate is not None:
                    gate.looked(detections, now_ms)
                # Waited for ONLY here, never for a frame the gate skipped
                # above: that wait would cost CPU-saving frames the very
                # latency the gate exists to avoid, for a timestamp nobody
                # is about to read.
                arrival_s, is_duplicate = stamps.wait_for(idx, STDERR_WAIT_S)
                # is_duplicate: showinfo's checksum for this frame exactly
                # matched the frame before it. select+-fps_mode vfr above
                # should mean that never happens any more, but if it ever
                # does by some other path resolve_time_source() refuses to
                # call it "arrival" - see the module docstring's NO
                # MANUFACTURED FRAMES section. read_at is the plausibility
                # anchor: a stamp far from it (pts 0 on the first frame after
                # a restart became 1970) is refused the same way.
                time_source = resolve_time_source(arrival_s, is_duplicate, read_at.timestamp())
                at = _iso(datetime.fromtimestamp(arrival_s, tz=timezone.utc)) if time_source == "arrival" else _iso(read_at)
                say({"type": "frame", "atUtc": at, "timeSource": time_source, "detections": detections})
            if gate is not None:
                report = gate.window_report(now_ms)
                if report is not None:
                    say(report)
            # Checked every iteration, alongside the stall check below: unlike
            # that one (which only logs), a dead stderr thread is fatal -
            # nothing can pair an arrival time again for the life of this
            # process - so this exits and lets the service restart the
            # worker into a fresh ffmpeg and a fresh thread, rather than run
            # on silently downgraded to timeSource "read" forever.
            if stderr_reader_dead(stderr_thread, ff):
                say({"type": "error", "message": "stderr reader thread died while ffmpeg is still running"})
                return 4
            now = time.monotonic()
            if now - last > STALL_SECONDS:
                say({"type": "error", "message": f"fell {int(now - last)} s behind"})
            last = now
    finally:
        ff.kill()


if __name__ == "__main__":
    sys.exit(main())
