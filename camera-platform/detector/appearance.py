"""The clothing signature: APPEARANCE-OF-DAY-SPEC.md's "What is measured",
computed by yolox_worker.py for each PERSON detection, only when the worker
was started with --appearance.

NO FACE RECOGNITION, EVER. This module never reads the top 20% of a person's
box - that is the head, and the crop handed to signature() is sliced to skip
it before a single pixel reaches the histogram. There is no face detector, no
landmark library, and no face crop anywhere in this file; APPEARANCE-OF-DAY-
SPEC.md's own test list says to grep for one and fail if it is ever added,
and detector/test_appearance.py does exactly that.

WHAT IS MEASURED, per detection:
  - upper body: 20% to 55% of the box height;
  - lower body: 55% to 95% of the box height;
  - each trimmed 15% from the left and right edges, to drop background;
  - per region, an 8 (hue) x 3 (saturation) x 3 (value) HSV histogram, L1-
    normalised (72 numbers) - a pixel with very low saturation or value is
    binned by value only (hue=0, sat=0, its own value bin), so grey and black
    clothing still land as real mass in a few predictable cells instead of
    scattering across all 8 hue bins on hue noise that is meaningless once a
    pixel is that close to grey (hue is undefined at zero saturation);
  - plus the box's own aspect ratio (build).
  - 72 + 72 + 1 = 145 numbers, each rounded to 3 decimal places.

TOO SMALL: a box under MIN_BOX_HEIGHT_PX tall on the SOURCE frame (not the
640x640 letterboxed one this worker actually holds in memory) gets no
signature - null, never a guess (rule 10) - and the reason is handed back
alongside so the caller's counter (mirroring motion_gate.py's own per-reason
counters, into the worker's existing gate/health reporting) can count why.

NUMPY, NOT OPENCV. RGB/BGR->HSV is arithmetic (the standard max/min/delta
formula), not a vision primitive, so it does not need OpenCV - and the worker
does not otherwise depend on it. Every function that touches pixel data
imports numpy INSIDE itself, deferred, the same discipline motion_gate.py
already uses for its own numpy-touching functions (grid_of, changed_fraction,
local_fraction): importing this module - which yolox_worker.py does
unconditionally, gate or no gate, appearance flag or not - must stay as cheap
as importing motion_gate already is, so detector/test_arrival_stamps.py's
"no numpy needed at all" property (see harness/arrivalStamps.harness.mjs) is
never broken by an unrelated feature landing in the same worker.
"""
import math

# The one hard size gate (spec: "A box under 48 px tall on the source frame
# gives appearance: null"). Measured on the source frame's own pixels, never
# the 640x640 letterboxed buffer this worker actually crops from - a camera
# running at a resolution well above 640 would otherwise let a box that
# reads plenty tall in letterboxed-space slip through when it is actually a
# speck on the real picture.
MIN_BOX_HEIGHT_PX = 48

# Every reason compute() can hand back for a null signature, the same
# discipline as motion_gate.LOOK_REASONS / contracts/detectStream.ts's
# GATE_REASONS: a fixed, known set, so a counter dict built from this tuple
# can never silently gain a key nobody validated.
#   too_small  - the source-frame box height gate above.
#   empty_crop - the box's OWN region, after the 15%-each-side trim, still
#                had no pixels to read (a pathologically thin or degenerate
#                box); kept distinct from too_small because it is a different
#                measurement (crop shape, not source-frame height) even
#                though both end in the same null.
APPEARANCE_NULL_REASONS = ("too_small", "empty_crop")

# Region boundaries, fractions of the box's OWN height - see the module
# docstring. UPPER_START is also the head cut: nothing above it is ever read.
UPPER_START, UPPER_END = 0.20, 0.55
LOWER_START, LOWER_END = 0.55, 0.95
SIDE_TRIM = 0.15  # each side, fraction of the box's own width

HUE_BINS, SAT_BINS, VAL_BINS = 8, 3, 3
REGION_LEN = HUE_BINS * SAT_BINS * VAL_BINS  # 72

# "Very low saturation or value" - the threshold below which a pixel is
# achromatic enough that its hue is noise, not signal, and gets binned by
# value alone instead. Chosen generously (grey concrete, black uniforms,
# shadow) rather than tightly, since the cost of calling a borderline pixel
# achromatic is just one fewer hue-distinguished pixel, while the cost of
# NOT doing so - hue noise scattering black/grey clothing's mass across all 8
# hue bins - is exactly the failure this rule exists to prevent.
LOW_SAT = 0.15
LOW_VAL = 0.15


def null_reason(box_height_px):
    """None when a signature should be computed for this box height (on the
    SOURCE frame, in pixels); otherwise which of APPEARANCE_NULL_REASONS
    explains why not. Pure, never raises: an unreadable height (not a
    finite number) is refused the same as one that is simply too small -
    guessing a signature for a height that cannot even be checked would be
    exactly the wrong-answer-that-looks-plausible rule 10 exists to stop."""
    if isinstance(box_height_px, bool) or not isinstance(box_height_px, (int, float)):
        return "too_small"
    if not math.isfinite(box_height_px):
        return "too_small"
    if box_height_px < MIN_BOX_HEIGHT_PX:
        return "too_small"
    return None


def bump_reason(counts, reason):
    """Increment counts[reason] in place and return it. `reason` must be one
    of APPEARANCE_NULL_REASONS - the same discipline contracts/detectStream.ts
    enforces on the gate's own reasons (a key nobody defined is refused, not
    silently added), applied here on the Python side before it ever reaches
    the wire."""
    if reason not in counts:
        raise ValueError(f"unknown appearance null reason: {reason!r}")
    counts[reason] += 1
    return counts


def new_counts():
    """A zeroed counter for every known reason - what a worker run starts
    with, and what a caller resets a reporting window to."""
    return {r: 0 for r in APPEARANCE_NULL_REASONS}


def crop_for_box(frame_bgr, box, width, height, ratio, input_size):
    """The pixel region of `frame_bgr` - the worker's ONLY pixel buffer, the
    640x640 letterboxed frame ffmpeg hands main() (see yolox_worker.py's
    module docstring) - that this detection's box covers.

    box's x/y/w/h are fractions of the SOURCE frame (width, height):
    postprocess() decodes boxes in `frame_bgr`'s own 640-pixel space and then
    divides by `ratio` to land there (see its `xyxy = ... / ratio` line), so
    recovering pixel coordinates in `frame_bgr` multiplies by that exact same
    ratio back - the precise inverse of the division that produced the
    fractions in the first place, not a fresh guess at the mapping.

    Clipped to the frame's own bounds; never raises on a box that rounds
    slightly outside them (a fraction of 1.0, or floating-point slop at an
    edge)."""
    x0 = box["x"] * width * ratio
    y0 = box["y"] * height * ratio
    x1 = x0 + box["w"] * width * ratio
    y1 = y0 + box["h"] * height * ratio
    ix0 = max(0, min(input_size, int(round(x0))))
    iy0 = max(0, min(input_size, int(round(y0))))
    ix1 = max(ix0, min(input_size, int(round(x1))))
    iy1 = max(iy0, min(input_size, int(round(y1))))
    return frame_bgr[iy0:iy1, ix0:ix1]


def _region_bounds(h, w, y0_frac, y1_frac, side_trim=SIDE_TRIM):
    y0 = max(0, min(h, int(round(y0_frac * h))))
    y1 = max(0, min(h, int(round(y1_frac * h))))
    x0 = max(0, min(w, int(round(side_trim * w))))
    x1 = max(0, min(w, int(round((1 - side_trim) * w))))
    return y0, y1, x0, x1


def _bgr_to_hsv(bgr):
    """(h, s, v) for an array of BGR pixels - the channel order the worker
    reads them in (see run_model's own blob build: "HWC BGR"). h in [0, 1),
    s and v in [0, 1]. Pure numpy arithmetic (the standard max/min/delta
    formula scaled to a 0..1 hue instead of 0..360) - deliberately not
    OpenCV, which this worker does not otherwise depend on. Deferred numpy
    import: see the module docstring."""
    import numpy as np

    arr = bgr.astype(np.float32) / 255.0
    b, g, r = arr[..., 0], arr[..., 1], arr[..., 2]
    maxc = np.maximum(np.maximum(r, g), b)
    minc = np.minimum(np.minimum(r, g), b)
    v = maxc
    delta = maxc - minc
    safe_max = np.where(maxc > 0, maxc, 1.0)
    s = np.where(maxc > 0, delta / safe_max, 0.0)

    safe_delta = np.where(delta == 0, 1.0, delta)
    rc = ((g - b) / safe_delta) % 6.0
    gc = ((b - r) / safe_delta) + 2.0
    bc = ((r - g) / safe_delta) + 4.0
    h = np.select([maxc == r, maxc == g, maxc == b], [rc, gc, bc], default=0.0)
    h = np.where(delta == 0, 0.0, h) / 6.0
    h = h % 1.0
    return h, s, v


def _hsv_histogram(h, s, v):
    """The 8x3x3 HSV histogram (raw counts, not yet normalised) for one
    region's pixels, flattened hue-major (hue, then saturation, then value)
    - the same fixed order every call uses, so two histograms are always
    comparable position by position. A pixel with s < LOW_SAT or v < LOW_VAL
    is binned at (hue=0, sat=0, its own value bin) regardless of its actual
    hue and saturation - see the module docstring for why. Deferred numpy
    import: see the module docstring."""
    import numpy as np

    hue_bin = np.clip((h * HUE_BINS).astype(np.int64), 0, HUE_BINS - 1)
    sat_bin = np.clip((s * SAT_BINS).astype(np.int64), 0, SAT_BINS - 1)
    val_bin = np.clip((v * VAL_BINS).astype(np.int64), 0, VAL_BINS - 1)

    low = (s < LOW_SAT) | (v < LOW_VAL)
    hue_bin = np.where(low, 0, hue_bin)
    sat_bin = np.where(low, 0, sat_bin)

    hist = np.zeros((HUE_BINS, SAT_BINS, VAL_BINS), dtype=np.float64)
    flat_h, flat_s, flat_v = hue_bin.ravel(), sat_bin.ravel(), val_bin.ravel()
    if flat_h.size:
        np.add.at(hist, (flat_h, flat_s, flat_v), 1.0)
    return hist.reshape(-1)  # hue-major: index = hue*SAT_BINS*VAL_BINS + sat*VAL_BINS + val


def _region_signature(crop_bgr, y0_frac, y1_frac):
    """The L1-normalised 72-number histogram for one region of `crop_bgr`
    (the box's OWN region fractions - 0 rows/columns when the region or the
    trim leaves nothing, never negative indices or a wraparound slice)."""
    h, w = crop_bgr.shape[0], crop_bgr.shape[1]
    y0, y1, x0, x1 = _region_bounds(h, w, y0_frac, y1_frac)
    if y1 <= y0 or x1 <= x0:
        return [0.0] * REGION_LEN
    region = crop_bgr[y0:y1, x0:x1]
    hue, sat, val = _bgr_to_hsv(region)
    flat = _hsv_histogram(hue, sat, val)
    total = float(flat.sum())
    if total > 0:
        flat = flat / total
    return [round(float(x), 3) for x in flat]


def signature(crop_bgr, aspect_ratio):
    """145 numbers - upper region (72), lower region (72), aspect ratio (1) -
    or None when `crop_bgr` has no pixels at all (0 height or width; the
    caller's null_reason() gate on the source-frame box height is the
    PRIMARY refusal, this is only a last-resort one for a crop that reached
    here empty some other way).

    `crop_bgr` is the box's FULL region, head included - the 20% head cut and
    the 15%-per-side background trim happen HERE, on the box's own height and
    width, never by the caller, so a caller that forgets to trim cannot leak
    head pixels into the signature by mistake. This is also why replacing the
    top 20% of `crop_bgr` with anything at all must give back an identical
    signature: those rows are never sliced into either region."""
    if crop_bgr is None:
        return None
    if crop_bgr.shape[0] == 0 or crop_bgr.shape[1] == 0:
        return None
    upper = _region_signature(crop_bgr, UPPER_START, UPPER_END)
    lower = _region_signature(crop_bgr, LOWER_START, LOWER_END)
    ar = float(aspect_ratio) if isinstance(aspect_ratio, (int, float)) and math.isfinite(aspect_ratio) else 0.0
    return upper + lower + [round(ar, 3)]


def compute(frame_bgr, box, width, height, ratio, input_size):
    """One call for the worker's main loop: (signature_or_None,
    reason_or_None). box_height_px is measured on the SOURCE frame (box["h"]
    * height) - never the 640-space crop - so null_reason's gate means what
    the spec says it means regardless of how far the camera's real resolution
    sits above or below 640. Only ever called for a PERSON detection - the
    caller's job, not this function's."""
    box_height_px = box["h"] * height
    reason = null_reason(box_height_px)
    if reason is not None:
        return None, reason

    crop = crop_for_box(frame_bgr, box, width, height, ratio, input_size)
    box_width_px = box["w"] * width
    aspect_ratio = box_width_px / box_height_px if box_height_px > 0 else 0.0
    sig = signature(crop, aspect_ratio)
    if sig is None:
        return None, "empty_crop"
    return sig, None
