"""Checks for motion_gate: whether the detector looks at a frame at all.
Run by harness/motionGate.harness.mjs, which skips loudly without numpy.

THE FEARED FAILURES, each one a person the product never shows:
  - a person who arrives on a frame the gate skipped, and is never looked at;
  - a person who stops moving, is looked at too rarely, and splits into two
    events, or vanishes from the one they were in;
  - a gate that, once quiet, never looks again;
  - a measure that counts the letterbox padding, so real movement reads as
    a fraction of what it is and falls under the threshold.
"""
import math
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0])
import numpy as np  # noqa: E402
import motion_gate as g  # noqa: E402

failures = []
total = 0


def check(name, fn):
    global total
    total += 1
    try:
        fn()
        print(f"  ok   {name}")
    except AssertionError as e:
        failures.append(name)
        print(f"  FAIL {name}\n       {e}")


def eq(got, want, what):
    assert got == want, f"{what}: expected {want!r}, got {got!r}"


def run(frames, fps=5, threshold=g.DEFAULT_THRESHOLD, keepalive_ms=g.DEFAULT_KEEPALIVE_MS, seen=lambda i: False):
    """Drive the gate over `frames` (a list of changed fractions) at `fps`.
    `seen(i)`: whether a look at frame i finds something kept. Returns the
    indices looked at and their reasons."""
    state, looks = g.new_state(), []
    for i, changed in enumerate(frames):
        now = i * 1000 / fps
        look, reason = g.decide(state, changed, now, threshold, keepalive_ms)
        if look:
            looks.append((i, reason))
            state = g.after_look(state, now, seen(i))
    return looks


print("motion gate")

check("the hold rate keeps a still thing inside one event, even with two misses", lambda: (
    eq(g.HOLD_INTERVAL_MS * 3 <= g.MERGE_GAP_MS, True, "three looks fit in the merge gap"),
    eq(g.TRACK_MEMORY_MS, g.MERGE_GAP_MS, "tracking lasts as long as the fold keeps an event open"),
    eq(g.HOLD_INTERVAL_MS < g.DEFAULT_KEEPALIVE_MS, True, "and a tracked thing is looked at more often than an empty scene"),
))

check("when unsure, it looks", lambda: (
    eq(g.decide(g.new_state(), 0.0, 0), (True, "first"), "the first frame"),
    eq(g.decide({"last_look_ms": 0, "last_seen_ms": None}, None, 200), (True, "unsure"), "nothing to compare against"),
    eq(g.decide({"last_look_ms": 0, "last_seen_ms": None}, float("nan"), 200), (True, "unsure"), "a measure that is not a number"),
    eq(g.decide({"last_look_ms": 0, "last_seen_ms": None}, -0.1, 200), (True, "unsure"), "a negative share"),
    eq(g.decide({"last_look_ms": 5000, "last_seen_ms": None}, 0.0, 4000), (True, "clock"), "a clock that ran backwards"),
    eq(g.decide(None, 0.0, 0), (True, "unsure"), "no state at all"),
    eq(g.decide({"last_look_ms": 0}, 0.0, float("inf")), (True, "unsure"), "an unreadable clock"),
))

check("movement is looked at, every frame it lasts", lambda: (
    eq([r for _, r in run([0.0] + [0.02] * 10)], ["first"] + ["motion"] * 10, "ten moving frames, ten looks"),
))

check("a quiet empty scene is skipped, and looked at on the keepalive", lambda: (
    # 60 s at 5 fps, nothing moving, nothing found: the first look, then one
    # every keepalive (5 s).
    eq(g.DEFAULT_KEEPALIVE_MS, 5_000, "the measured default"),
    eq(run([0.0] * 300), [(0, "first")] + [(i, "keepalive") for i in range(25, 300, 25)], "12 looks in 300 frames"),
    eq(run([0.0] * 300, keepalive_ms=10_000)[:3], [(0, "first"), (50, "keepalive"), (100, "keepalive")],
       "and a site that sets 10 s gets 10 s"),
))

def still_person():
    # A person walks in (frames 5-15 move), is found, then stands still for
    # 60 s. Found on every look while there.
    frames = [0.0] * 5 + [0.03] * 10 + [0.0] * 300
    looks = run(frames, seen=lambda i: i >= 5)
    seen_at = [i for i, _ in looks if i >= 5]
    gaps_ms = [(b - a) * 200 for a, b in zip(seen_at, seen_at[1:])]
    eq(max(gaps_ms) <= g.HOLD_INTERVAL_MS, True, f"never unseen longer than the hold interval: {max(gaps_ms)} ms")
    eq(max(gaps_ms) < g.MERGE_GAP_MS, True, "so the fold never splits the event")
    eq({r for i, r in looks if i > 15}, {"hold"}, "it was the hold that kept looking")
check("THE STILL PERSON: someone who stops moving stays one event", still_person)

def two_misses():
    # The worst case the hold rate is sized for: while still, two hold looks
    # in a row miss them (a pose the model scores under the floor). Found in
    # review: this check used to "miss" frames 20 and 35, which were never
    # looked at, so it passed without a single miss. The misses are now taken
    # from the looks that really happen.
    frames = [0.03] * 5 + [0.0] * 200
    holds = [i for i, r in run(frames, seen=lambda i: True) if r == "hold"]
    missed = set(holds[1:3])
    eq(len(missed), 2, f"two real hold looks to miss: {sorted(missed)}")
    looks = run(frames, seen=lambda i: i not in missed)
    eq(set(i for i, _ in looks) >= missed, True, "the missed looks did happen")
    found = [i for i, _ in looks if i not in missed]
    gap_ms = max((b - a) * 200 for a, b in zip(found, found[1:]))
    eq(gap_ms < g.MERGE_GAP_MS, True, f"two missed looks leave a {gap_ms} ms gap, inside the merge gap")
check("two missed looks in a row still do not split an event", two_misses)

def goes_quiet():
    # Once whatever was tracked has gone, the camera drops back to keepalive.
    frames = [0.03] * 5 + [0.0] * 300
    looks = run(frames, seen=lambda i: i < 5)
    after = [r for i, r in looks if i * 200 > 4 * 200 + g.TRACK_MEMORY_MS]
    eq(set(after) <= {"keepalive"}, True, f"only keepalive looks once tracking has lapsed: {sorted(set(after))}")
check("once the tracked thing has gone, it stops holding", goes_quiet)

def below_threshold():
    # Someone far away, arriving with less movement than the threshold, stays
    # for 12 s. The keepalive finds them.
    frames = [0.0] * 60 + [0.002] * 60 + [0.0] * 30
    looks = run(frames, seen=lambda i: 60 <= i < 120)
    found = [i for i, _ in looks if 60 <= i < 120]
    eq(len(found) > 0, True, "found while present, though they never crossed the threshold")
    eq((found[0] - 60) * 200 <= g.DEFAULT_KEEPALIVE_MS, True, f"within the keepalive bound: {(found[0] - 60) * 200} ms")
check("THE QUIET ARRIVAL: something below the threshold is found within the keepalive", below_threshold)

def parked_car_cost():
    # A car parked in view all the time: tracked forever, never moving. This
    # is the price of the hold, stated rather than discovered: one look every
    # 3 s, 20 a minute, 6.7% of 5 fps.
    looks = run([0.0] * 300, seen=lambda i: True)  # frames 0..299: one minute
    eq(len(looks), 60_000 // g.HOLD_INTERVAL_MS, f"looks in a minute with a parked car: {len(looks)}")
    eq(round(100 * len(looks) / 300, 1), 6.7, "6.7% of the frames")
check("the cost of a parked car in view is one look every 3 s", parked_car_cost)

check("decide never changes the state it is given", lambda: (
    (lambda s: (g.decide(s, 0.5, 100), eq(s, {"last_look_ms": 0, "last_seen_ms": None}, "untouched")))(
        {"last_look_ms": 0, "last_seen_ms": None}),
))

def grid_ignores_padding():
    # A 640x640 letterboxed frame of a 16:9 picture: 640x360 of picture, grey
    # padding below. A change only in the padding is not movement.
    a = np.full((640, 640, 3), 0x72, dtype=np.uint8)
    b = a.copy()
    b[400:640, :, :] = 255
    eq(g.changed_fraction(g.grid_of(a, 640, 360), g.grid_of(b, 640, 360)), 0.0, "padding does not count")
    eq(g.grid_of(a, 640, 360).shape, (g.GRID_H, g.GRID_W), "the grid is 160 x 90")
check("the measure reads the picture, never the letterbox padding", grid_ignores_padding)

def grid_full_share():
    # A person-sized change covering an eighth of the picture reads as an
    # eighth, not an eighth of the whole square.
    a = np.zeros((640, 640, 3), dtype=np.uint8)
    b = a.copy()
    b[0:360, 0:80, :] = 200
    eq(abs(g.changed_fraction(g.grid_of(a, 640, 360), g.grid_of(b, 640, 360)) - 0.125) < 1e-9, True, "1/8 of the picture")
check("a change's share is of the picture, not of the padded square", grid_full_share)

def noise_is_quiet():
    rng = np.random.default_rng(7)
    a = rng.integers(100, 110, size=(640, 640, 3), dtype=np.uint8)
    b = np.clip(a.astype(np.int16) + rng.integers(-10, 11, size=a.shape), 0, 255).astype(np.uint8)
    eq(g.changed_fraction(g.grid_of(a, 640, 360), g.grid_of(b, 640, 360)), 0.0, "noise within 10 levels, averaged over blocks, is still")
check("sensor noise under the cell threshold is not movement", noise_is_quiet)

check("frames that cannot be compared give None, which the gate looks on", lambda: (
    eq(g.changed_fraction(None, np.zeros((90, 160))), None, "no previous frame"),
    eq(g.changed_fraction(np.zeros((90, 160)), np.zeros((120, 160))), None, "a shape that changed"),
    eq(g.decide({"last_look_ms": 0, "last_seen_ms": None}, g.changed_fraction(None, None), 200)[0], True, "and the gate looks"),
))

def gate_counts():
    # The class the worker and replay run: every frame counted, every look
    # given its reason, and the reasons adding up to the looks.
    gate = g.Gate(640, 360, track_floor=0.5)
    base = np.full((640, 640, 3), 90, dtype=np.uint8)
    looks = 0
    for i in range(300):  # a minute at 5 fps; the first 20 s has a bar sweeping across
        fr = base.copy()
        if i < 100:
            x = (i % 8) * 80
            fr[0:360, x:x + 80] = 250
        if gate.should_look(fr, i * 200):
            looks += 1
            gate.looked([], i * 200)
    t = gate.totals()
    eq(t["frames"], 300, "every frame counted")
    eq(t["looked"], looks, "every look counted")
    eq(sum(t["reasons"].values()), t["looked"], "the reasons add up to the looks")
    eq(t["reasons"]["motion"] > 0 and t["reasons"]["keepalive"] > 0, True, f"it looked for motion and on the keepalive: {t['reasons']}")
    eq(0 < t["looked"] < 300, True, f"it skipped some and looked at some: {t['looked']}")
check("the Gate counts every frame, and says why it looked", gate_counts)

def gate_tracks_only_what_is_kept():
    gate = g.Gate(640, 360, track_floor=0.5)
    fr = np.full((640, 640, 3), 90, dtype=np.uint8)
    gate.should_look(fr, 0)
    gate.looked([{"kind": "vehicle", "confidence": 0.3}], 0)
    eq(gate.state["last_seen_ms"], None, "a 0.3 guess under a 0.5 floor does not start holding")
    gate.looked([{"kind": "vehicle", "confidence": 0.7}], 200)
    eq(gate.state["last_seen_ms"], 200, "a kept sighting does")
check("only what the service keeps holds the camera at the hold rate", gate_tracks_only_what_is_kept)

def gate_window():
    gate = g.Gate(640, 360, track_floor=0.5, window_s=60)
    fr = np.full((640, 640, 3), 90, dtype=np.uint8)
    lines = []
    for i in range(700):  # 140 s at 5 fps
        if gate.should_look(fr, i * 200):
            gate.looked([], i * 200)
        line = gate.window_report(i * 200)
        if line:
            lines.append(line)
    eq(len(lines), 2, "a report each minute")
    eq(lines[0]["type"], "gate", "a gate line")
    eq(lines[0]["windowS"], 60.0, "covering the minute")
    eq(lines[0]["frames"] + lines[1]["frames"] <= 700, True, "windows do not double-count")
    eq(all(sum(l["reasons"].values()) == l["looked"] for l in lines), True, "each window's reasons add up")
check("the Gate reports once a minute, each minute on its own", gate_window)

def gate_unmeasurable_frame():
    gate = g.Gate(640, 360, track_floor=0.5)
    gate.should_look(np.full((640, 640, 3), 90, dtype=np.uint8), 0)
    gate.looked([], 0)
    eq(gate.should_look("not a frame", 200), True, "a frame it cannot measure is looked at")
check("a frame the Gate cannot measure is looked at, never skipped", gate_unmeasurable_frame)

def drifting(i, x0=40, step=4, w=40, h=100, y=130, grey=90, fg=200):
    """A 640x640 letterboxed frame with a person-sized box drifting right."""
    fr = np.full((640, 640, 3), 0x72, dtype=np.uint8)
    fr[:360, :, :] = grey
    x = x0 + i * step
    fr[y:y + h, x:x + w, :] = fg
    return fr, {"x": x / 640, "y": y / 360, "w": w / 640, "h": h / 360}


def slow_drifter():
    # The reviewer's case: a person-sized box drifting 4 px a frame. The whole
    # scene changes less than the threshold, so without local motion the gate
    # looks every 3 s, and one missed look lets the box move too far for the
    # fold to join the next sighting to the event.
    gate = g.Gate(640, 360, track_floor=0.5)
    looks, overall = [], []
    prev = None
    for i in range(100):
        fr, box = drifting(i)
        grid = g.grid_of(fr, 640, 360)
        if prev is not None:
            overall.append(g.changed_fraction(prev, grid))
        prev = grid
        if gate.should_look(fr, i * 200):
            looks.append(i)
            gate.looked([{"kind": "person", "confidence": 0.9, "box": box}], i * 200)
    eq(max(overall) < g.DEFAULT_THRESHOLD, True, f"the scene alone reads as still: {max(overall):.4f}")
    gaps = [b - a for a, b in zip(looks, looks[1:])]
    eq(max(gaps), 1, f"but its own patch is moving, so it is looked at every frame: gaps {sorted(set(gaps))}")
check("THE SLOW DRIFTER: a tracked thing whose own patch moves is looked at every frame", slow_drifter)


def parked_car_keeps_cheap_rate():
    gate = g.Gate(640, 360, track_floor=0.5)
    fr, box = drifting(0)
    looks = []
    for i in range(300):  # the same frame for a minute: a parked car
        if gate.should_look(fr, i * 200):
            looks.append(i)
            gate.looked([{"kind": "vehicle", "confidence": 0.9, "box": box}], i * 200)
    eq(len(looks), 60_000 // g.HOLD_INTERVAL_MS, f"still one look every 3 s: {len(looks)} in a minute")
check("a parked car's unchanging patch keeps it at the cheap hold rate", parked_car_keeps_cheap_rate)


def small_picture_has_no_padding():
    # Found in review: a picture narrower than 160 or shorter than 90 used to
    # be read as a 160x90 crop that reached into the padding.
    a = np.full((640, 640, 3), 0x72, dtype=np.uint8)
    a[:, :140, :] = 90                      # a 140x640 portrait picture
    b = a.copy()
    b[:, 200:400, :] = 255                  # change only in the padding
    eq(g.changed_fraction(g.grid_of(a, 140, 640), g.grid_of(b, 140, 640)), 0.0, "padding does not count")
    c = a.copy()
    c[0:640, 0:70, :] = 250                 # half the picture changes
    frac = g.changed_fraction(g.grid_of(a, 140, 640), g.grid_of(c, 140, 640))
    eq(abs(frac - 0.5) < 0.02, True, f"and half the picture reads as half: {frac:.3f}")
check("a picture smaller than the grid is measured without its padding", small_picture_has_no_padding)


def one_gate_across_files():
    # The scoring runner replays a clip one 60 s file at a time. Found in
    # review: each file started a fresh gate, with a free first look and a
    # reset keepalive, which live never does. save/restore must make two
    # halves behave exactly as one continuous gate.
    frames = [drifting(i)[0] if 40 <= i < 60 else drifting(0)[0] for i in range(200)]
    boxes = [drifting(i)[1] if 40 <= i < 60 else drifting(0)[1] for i in range(200)]
    found = lambda i: [{"kind": "person", "confidence": 0.9, "box": boxes[i]}] if 30 <= i < 80 else []

    def drive(gate, rng):
        out = []
        for i in rng:
            if gate.should_look(frames[i], i * 200):
                out.append(i)
                gate.looked(found(i), i * 200)
        return out
    whole = drive(g.Gate(640, 360, 0.5), range(200))
    first = g.Gate(640, 360, 0.5)
    part1 = drive(first, range(0, 100))
    import json
    second = g.Gate(640, 360, 0.5)
    second.restore(json.loads(json.dumps(first.save())))
    part2 = drive(second, range(100, 200))
    eq(part1 + part2, whole, "the same looks, file boundary or not")
    fresh = drive(g.Gate(640, 360, 0.5), range(100, 200))
    eq(fresh != part2, True, "while a fresh gate on the second file would have looked differently")
check("a gate saved and restored across files is one continuous gate", one_gate_across_files)


def restore_rubbish_starts_fresh():
    gate = g.Gate(640, 360, 0.5)
    gate.restore({"state": "nonsense"})
    eq(gate.state, g.new_state(), "unreadable state starts fresh, which only means looking more")
    gate.restore(None)
    eq(gate.prev, None, "and nothing half-restored")
check("an unreadable saved gate starts fresh rather than guessing", restore_rubbish_starts_fresh)

print(f"\nmotion gate: {total - len(failures)} passed, {len(failures)} failed")
sys.exit(1 if failures else 0)
