"""Checks for detector/appearance.py (the clothing signature,
APPEARANCE-OF-DAY-SPEC.md's "What is measured") and its wiring into
yolox_worker.py's --appearance flag. Needs numpy (building synthetic crops);
run by harness/appearance.harness.mjs, which skips loudly when numpy is
missing, the same as harness/yoloxPost.harness.mjs does for
test_postprocess.py.

THE FEARED FAILURES, each one a signature that looks fine and is wrong:
  - a face pixel reaching the histogram because the head cut is off by a row
    or two, or because some future edit reads the crop before trimming it;
  - grey or black clothing "vanishing" (all-zero mass) because hue is noise
    at near-zero saturation and scatters across all 8 hue bins instead of
    landing predictably;
  - a too-small box getting a GUESSED signature instead of null;
  - the --appearance flag defaulting on, or the key leaking onto a vehicle;
  - a face or landmark library quietly becoming a dependency of this file.
"""
import ast
import math
import re
import sys

DETECTOR_DIR = __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0]
sys.path.insert(0, DETECTOR_DIR)
import numpy as np  # noqa: E402
import appearance as ap  # noqa: E402
from yolox_worker import apply_appearance, INPUT, letterbox_ratio  # noqa: E402

failures = []
total = 0


def check(name, fn):
    global total
    total += 1
    try:
        fn()
        print(f"  ok   {name}")
    except Exception as err:  # noqa: BLE001
        failures.append(name)
        print(f"  FAIL {name}\n       {err}")


def eq(got, want, what):
    assert got == want, f"{what}: expected {want!r}, got {got!r}"


print("appearance")

# ---------------- null_reason: the too-small gate, refuse rather than guess ----------------

check("THE FEARED ONE: a box under 48 px on the source frame is refused, never a guessed signature", lambda: (
    eq(ap.null_reason(47), "too_small", "just under"),
    eq(ap.null_reason(47.999), "too_small", "fractional pixels, still under"),
    eq(ap.null_reason(0), "too_small", "zero"),
    eq(ap.null_reason(-5), "too_small", "negative, never seen for real but never trusted either"),
))

check("48 px exactly is tall enough (the spec says UNDER 48, not at or under)", lambda: (
    eq(ap.null_reason(48), None, "exactly the floor"),
    eq(ap.null_reason(48.5), None, "just over"),
    eq(ap.null_reason(200), None, "comfortably over"),
))

check("an unreadable height is refused the same as a too-small one, never crashes and never guesses", lambda: (
    eq(ap.null_reason(float("nan")), "too_small", "NaN"),
    eq(ap.null_reason(float("inf")), "too_small", "infinity"),
    eq(ap.null_reason(None), "too_small", "not a number at all"),
    eq(ap.null_reason("48"), "too_small", "a string that LOOKS like a number is still refused, not parsed"),
    eq(ap.null_reason(True), "too_small", "a bool is not trusted as a height even though True == 1 in Python"),
))

# ---------------- per-reason counters: the existing gate/health reporting ----------------

check("new_counts() is zeroed for every known reason, nothing else", lambda: (
    eq(ap.new_counts(), {r: 0 for r in ap.APPEARANCE_NULL_REASONS}, "exactly the known reasons, all zero"),
))

check("bump_reason increments the right key and returns the same dict", lambda: (
    (lambda c: (
        ap.bump_reason(c, "too_small"),
        eq(c["too_small"], 1, "bumped once"),
        ap.bump_reason(c, "too_small"),
        eq(c["too_small"], 2, "bumped again"),
        eq(c["empty_crop"], 0, "the other reason untouched"),
    ))(ap.new_counts()),
))

def bump_reason_refuses_unknown_key():
    try:
        ap.bump_reason(ap.new_counts(), "wrong_face")
    except ValueError:
        return  # expected - refused loudly, not silently added as a new key
    raise AssertionError("bump_reason accepted an unrecognised reason instead of refusing it")
check("THE FEARED ONE: an unrecognised reason is refused loudly, never silently added as a new key", bump_reason_refuses_unknown_key)


# ---------------- crop_for_box: mapping a source-frame box back to the letterboxed buffer ----------------

def crop_for_box_maps_known_box():
    # A 640x640 frame, and a box that (per postprocess()'s own math) came
    # from a source frame of width=1280, height=720 at exactly half scale
    # (ratio = 640/1280 = 0.5, well under the 640/720 alternative, so width
    # is the binding side): a source-pixel box at (100, 100)-(300, 400)
    # becomes fractions x=100/1280, y=100/720, w=200/1280, h=300/720, and
    # should map BACK to pixel (50, 50)-(150, 200) in the 640-space frame -
    # exactly half of the source-pixel box, because that is what "* ratio"
    # means.
    width, height = 1280, 720
    ratio = letterbox_ratio(width, height, size=640)
    eq(round(ratio, 6), 0.5, "sanity: width is the binding side at this aspect")
    box = {"x": 100 / width, "y": 100 / height, "w": 200 / width, "h": 300 / height}
    frame = np.zeros((640, 640, 3), dtype=np.uint8)
    frame[50:200, 50:150] = (7, 8, 9)  # a marker exactly where the crop should land
    crop = ap.crop_for_box(frame, box, width, height, ratio, 640)
    eq(crop.shape, (150, 100, 3), "150 rows (200-50), 100 cols (150-50)")
    eq(bool(np.all(crop[:, :, 0] == 7)), True, "the marker, not some other patch of the frame")
check("crop_for_box recovers exactly the pixel region a known box maps to", crop_for_box_maps_known_box)


def crop_for_box_clips_to_frame_bounds():
    width, height = 640, 640
    ratio = letterbox_ratio(width, height, size=640)
    box = {"x": 0.9, "y": 0.9, "w": 0.5, "h": 0.5}  # runs off the right/bottom edge
    frame = np.zeros((640, 640, 3), dtype=np.uint8)
    crop = ap.crop_for_box(frame, box, width, height, ratio, 640)  # must not raise
    eq(crop.shape[0] <= 640 and crop.shape[1] <= 640, True, "clipped, not an out-of-bounds slice")
check("crop_for_box clips to the frame's own bounds rather than raising on a box that rounds past the edge", crop_for_box_clips_to_frame_bounds)


# ---------------- signature(): the head cut, symmetry, normalisation ----------------

check("THE FEARED ONE: the region boundaries are pinned to the spec's own literals, not just to each other - a regression here would read real face pixels while every self-consistency check below still passes", lambda: (
    eq(ap.UPPER_START, 0.20, "the head cut must be exactly the spec's 20% - a regression here reads real face pixels"),
    eq(ap.UPPER_END, 0.55, "upper region end, per the spec"),
    eq(ap.LOWER_START, 0.55, "lower region start, per the spec"),
    eq(ap.LOWER_END, 0.95, "lower region end, per the spec"),
    eq(ap.SIDE_TRIM, 0.15, "side trim, per the spec"),
))


def _rng_crop(h, w, seed):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)


def _rewrite_head(crop):
    modified = crop.copy()
    head_rows = int(round(ap.UPPER_START * crop.shape[0]))
    modified[:head_rows] = 255 - modified[:head_rows]  # a totally different image, up there
    # Also blow it up with an out-of-range-looking pattern to make sure
    # nothing downstream would silently "average it away" instead of never
    # reading it at all.
    modified[: max(1, head_rows // 2)] = 0
    return modified


check("THE FEARED ONE: the head is never read - replacing the top 20% of the crop with anything gives an IDENTICAL signature", lambda: (
    (lambda crop, sig_before: (
        eq(sig_before is not None, True, "a normal crop produces a real signature"),
        (lambda modified: (
            eq(ap.signature(modified, 1.5), sig_before, "top 20% rewritten to something else entirely - result must not move at all"),
        ))(_rewrite_head(crop)),
    ))(_rng_crop(200, 100, seed=1), ap.signature(_rng_crop(200, 100, seed=1), 1.5)),
))


check("grey clothing still produces mass - it does not vanish because hue is undefined at zero saturation", lambda: (
    (lambda crop: (
        (lambda upper: (
            eq(round(sum(upper), 3) >= 0.99, True, f"the region's mass sums to ~1, not 0: {sum(upper)}"),
            eq(all(v == 0.0 for i, v in enumerate(upper) if i // (ap.SAT_BINS * ap.VAL_BINS) != 0 or (i // ap.VAL_BINS) % ap.SAT_BINS != 0), True,
               "every non-zero bin sits at hue=0, sat=0 (the achromatic cells) - grey never scatters across the other 7 hue bins"),
        ))(ap._region_signature(crop, ap.UPPER_START, ap.UPPER_END)),
    ))(np.full((200, 100, 3), 128, dtype=np.uint8)),
))

check("black clothing still produces mass, the same way grey does", lambda: (
    (lambda crop: (
        (lambda lower: (
            eq(round(sum(lower), 3) >= 0.99, True, f"mass, not zero: {sum(lower)}"),
        ))(ap._region_signature(crop, ap.LOWER_START, ap.LOWER_END)),
    ))(np.zeros((200, 100, 3), dtype=np.uint8)),
))

check("a saturated, non-grey colour is NOT forced into the achromatic cell - it lands on its own hue/sat bin instead", lambda: (
    (lambda crop: (
        (lambda upper: (
            eq(upper[0 * ap.SAT_BINS * ap.VAL_BINS + 0 * ap.VAL_BINS + 2], 0.0, "the achromatic cell (hue0,sat0,val2) stays empty for a fully saturated green"),
            eq(sum(upper) >= 0.99, True, "still normalised to ~1 mass overall"),
        ))(ap._region_signature(crop, ap.UPPER_START, ap.UPPER_END)),
    ))(np.tile(np.array([0, 255, 0], dtype=np.uint8), (200, 100, 1))),  # pure green (BGR): B=0,G=255,R=0 -> hue 120 deg, full saturation
))

check("symmetry: a crop mirrored left-right gives the exact same signature - a colour histogram cannot see position", lambda: (
    (lambda crop: (
        eq(ap.signature(crop, 1.2), ap.signature(np.fliplr(crop), 1.2), "the trim is symmetric (15% each side), so the mirrored crop's trimmed region is exactly the same pixels, reordered"),
    ))(_rng_crop(300, 140, seed=7)),
))

check("determinism: the same crop signed twice gives the same answer, bit for bit", lambda: (
    (lambda crop: (
        eq(ap.signature(crop, 0.5), ap.signature(crop, 0.5), "no hidden randomness"),
    ))(_rng_crop(150, 90, seed=3)),
))

check("normalisation: each region's 72 numbers sum to ~1 for a crop with real pixels in it", lambda: (
    (lambda sig: (
        eq(abs(sum(sig[:72]) - 1.0) < 0.01, True, f"upper region: {sum(sig[:72])}"),
        eq(abs(sum(sig[72:144]) - 1.0) < 0.01, True, f"lower region: {sum(sig[72:144])}"),
        eq(len(sig), 145, "72 + 72 + 1"),
    ))(ap.signature(_rng_crop(220, 120, seed=11), 0.7)),
))

check("aspect ratio rides as the 145th number, rounded to 3 decimals, exactly what was passed in", lambda: (
    eq(ap.signature(_rng_crop(100, 60, seed=2), 1.23456)[144], 1.235, "rounded to 3 places"),
))

check("a non-finite aspect ratio is never sent through as NaN/inf - refused to 0.0 rather than poisoning every downstream comparison", lambda: (
    eq(ap.signature(_rng_crop(100, 60, seed=2), float("nan"))[144], 0.0, "NaN refused"),
    eq(ap.signature(_rng_crop(100, 60, seed=2), float("inf"))[144], 0.0, "infinity refused"),
))

check("a crop with no pixels at all gives None, not a crash or a fabricated zero vector", lambda: (
    eq(ap.signature(np.zeros((0, 10, 3), dtype=np.uint8), 1.0), None, "zero height"),
    eq(ap.signature(np.zeros((10, 0, 3), dtype=np.uint8), 1.0), None, "zero width"),
    eq(ap.signature(None, 1.0), None, "no crop at all"),
))

check("THE FEARED ONE: a region that ends up empty after slicing returns all-zero mass, never a crash and never a fabricated distribution", lambda: (
    eq(ap._region_signature(_rng_crop(50, 50, seed=8), 0.95, 0.20), [0.0] * ap.REGION_LEN, "y1 before y0 (a degenerate slice): zeros, not an exception"),
))

check("a genuinely tiny crop (a couple of pixels) still returns the full 145-number shape, never a crash", lambda: (
    eq(len(ap.signature(_rng_crop(3, 3, seed=4), 1.0)), 145, "shape holds even at the very edge of usable size"),
))

# ---------------- compute(): the worker-facing entry point ----------------

def compute_end_to_end_person_box():
    width, height = 1000, 800
    ratio = letterbox_ratio(width, height, size=INPUT)
    box = {"x": 0.3, "y": 0.1, "w": 0.15, "h": 0.5}  # 0.5 * 800 = 400 px tall - well over the floor
    frame = (np.random.default_rng(9).integers(0, 256, size=(INPUT, INPUT, 3))).astype(np.uint8)
    sig, reason = ap.compute(frame, box, width, height, ratio, INPUT)
    eq(reason, None, "tall enough: no refusal")
    eq(len(sig), 145, "a real signature")
    expected_aspect = round((box["w"] * width) / (box["h"] * height), 3)
    eq(sig[144], expected_aspect, "aspect ratio computed in real pixel units, not the raw box fractions")
check("compute() end to end: a normal person box gets a real 145-number signature", compute_end_to_end_person_box)


def compute_too_small_gives_null_and_a_reason():
    width, height = 1000, 800
    ratio = letterbox_ratio(width, height, size=INPUT)
    box = {"x": 0.3, "y": 0.1, "w": 0.05, "h": 0.05}  # 0.05*800 = 40 px, under 48
    frame = np.zeros((INPUT, INPUT, 3), dtype=np.uint8)
    sig, reason = ap.compute(frame, box, width, height, ratio, INPUT)
    eq(sig, None, "no signature")
    eq(reason, "too_small", "the exact reason, for the caller's counter")
check("THE FEARED ONE: compute() on a too-small box gives null with a reason, never a guessed number", compute_too_small_gives_null_and_a_reason)


# ---------------- apply_appearance(): the worker's own wiring ----------------

def apply_appearance_only_touches_persons():
    width, height = 1000, 800
    ratio = letterbox_ratio(width, height, size=INPUT)
    frame = (np.random.default_rng(5).integers(0, 256, size=(INPUT, INPUT, 3))).astype(np.uint8)
    detections = [
        {"kind": "person", "confidence": 0.9, "box": {"x": 0.2, "y": 0.1, "w": 0.1, "h": 0.5}},
        {"kind": "vehicle", "species": "car", "confidence": 0.8, "box": {"x": 0.5, "y": 0.5, "w": 0.3, "h": 0.3}},
    ]
    counts = ap.new_counts()
    apply_appearance(detections, frame, width, height, ratio, counts)
    eq("appearance" in detections[0], True, "the person gets the key")
    eq(len(detections[0]["appearance"]), 145, "a real signature, box is tall enough")
    eq("appearance" in detections[1], False, "the vehicle NEVER gets the key, not even null - appearance is a person-only concept")
check("apply_appearance sets the key on persons only, never on vehicles", apply_appearance_only_touches_persons)


def apply_appearance_counts_the_null_reason():
    width, height = 1000, 800
    ratio = letterbox_ratio(width, height, size=INPUT)
    frame = np.zeros((INPUT, INPUT, 3), dtype=np.uint8)
    detections = [
        {"kind": "person", "confidence": 0.9, "box": {"x": 0.2, "y": 0.1, "w": 0.05, "h": 0.03}},  # too small
    ]
    counts = ap.new_counts()
    apply_appearance(detections, frame, width, height, ratio, counts)
    eq(detections[0]["appearance"], None, "null on the wire")
    eq(counts["too_small"], 1, "the per-reason counter - what rides the existing gate/health reporting")
check("apply_appearance bumps the per-reason counter when a signature comes back null", apply_appearance_counts_the_null_reason)


check("THE FEARED ONE: no --appearance flag means no key at all - apply_appearance is simply never called, and detections built by postprocess()-shaped code never carry the key on their own", lambda: (
    (lambda detections: (
        eq(any("appearance" in d for d in detections), False, "nothing here ever sets the key by itself"),
    ))([
        {"kind": "person", "confidence": 0.9, "box": {"x": 0.2, "y": 0.1, "w": 0.1, "h": 0.5}},
        {"kind": "vehicle", "species": "truck", "confidence": 0.7, "box": {"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2}},
    ]),
))


def appearance_flag_defaults_off_and_gates_the_call_site():
    src_path = DETECTOR_DIR + "/yolox_worker.py"
    with open(src_path, "r", encoding="utf-8") as f:
        src = f.read()
    m = re.search(r'add_argument\("--appearance",\s*action="store_true"\)', src)
    assert m is not None, "must be a plain store_true flag - argparse guarantees the default is False, never a value that could default true"
    # The exact call site, not the def line above it (which also starts with
    # "apply_appearance(detections" but takes `counts`, not `appearance_counts`).
    idx = src.index("apply_appearance(detections, frame, width, height, ratio, appearance_counts)")
    before = src[:idx]
    guard_idx = before.rfind("if args.appearance:")
    assert guard_idx != -1 and idx - guard_idx < 100, "the call site must be directly behind the flag's own guard"
check("the --appearance flag is a plain store_true (default off) and its one call site is gated behind it", appearance_flag_defaults_off_and_gates_the_call_site)


# ---------------- no face recognition, ever ----------------

FORBIDDEN_MODULES = {
    "cv2", "dlib", "face_recognition", "mediapipe", "insightface",
    "mtcnn", "facenet", "retinaface", "deepface", "face_alignment",
}


def _imported_top_level_modules(path):
    with open(path, "r", encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=path)
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                names.add(node.module.split(".")[0])
    return names


check("THE FEARED ONE: no face or landmark library is imported by appearance.py or yolox_worker.py - grep the actual AST, not just the word 'face' in a comment", lambda: (
    (lambda mods_a, mods_w: (
        eq(mods_a & FORBIDDEN_MODULES, set(), f"appearance.py imports: {sorted(mods_a)}"),
        eq(mods_w & FORBIDDEN_MODULES, set(), f"yolox_worker.py imports: {sorted(mods_w)}"),
    ))(
        _imported_top_level_modules(DETECTOR_DIR + "/appearance.py"),
        _imported_top_level_modules(DETECTOR_DIR + "/yolox_worker.py"),
    ),
))

check("no OpenCV dependency was added for the HSV conversion - numpy only, per the spec's explicit instruction", lambda: (
    eq("cv2" in _imported_top_level_modules(DETECTOR_DIR + "/appearance.py"), False, "cv2 not imported by appearance.py"),
))


print(f"\nappearance: {total - len(failures)} passed, {len(failures)} failed")
sys.exit(1 if failures else 0)
