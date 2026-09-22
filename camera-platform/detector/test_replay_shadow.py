"""Checks for replay.py's shadow mode (--gate --gate-shadow): the model on
every frame, the gate beside it marking the frames it would have looked at.
Run by harness/replayShadow.harness.mjs, which skips loudly without numpy.
No model, no ffmpeg and no onnxruntime are needed: the per-frame step and the
output line are tested directly, and main() is driven with stand-ins for the
decoder and the model.

THE FEARED FAILURES, each one a wrong answer to "what does the gate cost":
  - a shadow gate that decides differently from the live one. Told what the
    frames it skipped contained, its keepalive and hold would reset on frames
    live never looked at, and the "gated" set would be a gate nobody runs;
  - a shadow that skips the model on some frames, so the reference is not
    every frame; or a plain gated run that stops skipping;
  - a plain gated or ungated line that changes, breaking the scoring runner
    and every comparison with scores taken before;
  - --gate-shadow without --gate quietly running, every frame reading as
    looked at by a gate that never ran.
"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types

HERE = __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0]
sys.path.insert(0, HERE)
import numpy as np  # noqa: E402
import motion_gate as g  # noqa: E402
import replay as r  # noqa: E402

REPLAY = os.path.join(HERE, "replay.py")

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


def same_list(got, want, what):
    """eq for long lists: names the first place they part, not 300 values."""
    for i, (a, b) in enumerate(zip(got, want)):
        assert a == b, f"{what}: first differs at [{i}]: expected {b!r}, got {a!r}"
    assert len(got) == len(want), f"{what}: expected {len(want)} items, got {len(got)}"


FPS = 5
N = 300  # one minute


def scene(i):
    """Frame i of a minute with every case the gate treats differently, at
    5 fps, letterboxed 640x360 in 640x640 as the worker's frames are:
      0-59     nothing there: the first look, then the keepalive;
      60-99    a person-sized box arrives and drifts 4 px a frame: motion,
               then local motion under what is tracked;
      100-179  it stands still: the 3 s hold, skipping the frames between;
      180-299  it has gone: holds until tracking lapses, then keepalive."""
    fr = np.full((640, 640, 3), 0x72, dtype=np.uint8)
    fr[:360, :, :] = 90
    if 60 <= i < 180:
        x = 40 + (min(i, 99) - 60) * 4
        fr[130:230, x:x + 40, :] = 200
    return fr


def fake_model(frame):
    """A stand-in for the model: a person wherever the picture is bright.
    Works on the uint8 frame and on the float blob the real path builds."""
    ys, xs = np.nonzero(frame[:360, :, 0] >= 150)
    if len(xs) == 0:
        return []
    x, y = int(xs.min()), int(ys.min())
    w, h = int(xs.max()) - x + 1, int(ys.max()) - y + 1
    return [{"kind": "person", "species": "person", "confidence": 0.9,
             "box": {"x": x / 640, "y": y / 360, "w": w / 640, "h": h / 360}}]


_drives = {}


def drive(mode):
    """step() over the scene. mode: "ungated", "plain" or "shadow". Returns
    (looked per frame, detections per frame, frames the model ran on, gate).
    Each mode is run once and shared: the checks only read the result."""
    if mode not in _drives:
        gate = None if mode == "ungated" else g.Gate(640, 360, track_floor=0.5)
        looked, found, ran = [], [], []
        for i in range(N):
            def detect(frame, i=i):
                ran.append(i)
                return fake_model(frame)
            d, lk = r.step(gate, scene(i), i * 1000 / FPS, detect, shadow=(mode == "shadow"))
            looked.append(lk)
            found.append(d)
        _drives[mode] = (looked, found, ran, gate)
    return _drives[mode]


print("replay shadow")


def same_looks():
    plain, _, _, pg = drive("plain")
    shadow, _, _, sg = drive("shadow")
    reasons = pg.totals()["reasons"]
    eq(all(reasons[k] > 0 for k in ("first", "motion", "hold", "keepalive")), True,
       f"the scene looks for every reason it can: {reasons}")
    eq(0 < sum(plain) < N, True, f"and the gate skips some frames: it looked at {sum(plain)} of {N}")
    same_list(shadow, plain, "the looked sequence")
    eq(sg.totals(), pg.totals(), "and the gate counts them the same")
    eq(json.dumps(sg.save()), json.dumps(pg.save()), "and ends in the same state, to carry to the next file")
check("THE SHADOW GATE IS THE LIVE GATE: it looks at exactly the frames a plain gated run does", same_looks)


def model_runs():
    _, _, ran_u, _ = drive("ungated")
    plain, found_p, ran_p, _ = drive("plain")
    shadow, found_s, ran_s, _ = drive("shadow")
    same_list(ran_u, list(range(N)), "ungated: the model runs on every frame")
    same_list(ran_s, list(range(N)), "shadow: the model runs on every frame")
    same_list(ran_p, [i for i in range(N) if plain[i]], "plain gated: only on the frames the gate looked at")
    same_list([d is None for d in found_p], [not lk for lk in plain], "plain gated has no detections for a skipped frame")
    same_list([found_s[i] for i in range(N) if shadow[i]], [found_p[i] for i in range(N) if plain[i]],
              "the shadow's looked frames found exactly what the plain run found")
    eq(any(found_s[i] for i in range(N) if not shadow[i]), True,
       "and its skipped frames still carry the model's answer, which is the reference")
check("shadow runs the model on every frame; plain gated only on looked frames; ungated on every frame", model_runs)


def frame_lines():
    d = [{"kind": "person", "confidence": 0.9, "box": {"x": 0.1, "y": 0.2, "w": 0.1, "h": 0.3}}]
    plain = r.frame_line(3, 0.2 * 3, d)
    eq("gateLooked" in plain, False, "no gateLooked key when not in shadow mode")
    eq(json.dumps(plain, separators=(",", ":")),
       '{"frame":3,"tSec":0.6,"detections":[{"kind":"person","confidence":0.9,'
       '"box":{"x":0.1,"y":0.2,"w":0.1,"h":0.3}}]}',
       "and the line is byte for byte what replay always printed, time rounded to the ms")
    eq(r.frame_line(3, 0.6, d, True)["gateLooked"], True, "looked")
    eq(r.frame_line(3, 0.6, d, False)["gateLooked"], False, "skipped is false, not missing: it is a measurement")
    eq(type(r.frame_line(0, 0.0, [], np.bool_(True))["gateLooked"]), bool, "always a plain boolean, never numpy's")
    eq(list(r.frame_line(3, 0.6, d, False)), ["frame", "tSec", "detections", "gateLooked"], "added after the old keys")
check("frame_line: no gateLooked unless given; a boolean when it is", frame_lines)


def refuses_without_gate():
    p = subprocess.run([sys.executable, REPLAY, "--file", "x", "--model", "y", "--gate-shadow"],
                       capture_output=True, text=True, timeout=60, cwd=HERE)
    eq(p.returncode, 2, f"exit code (stderr: {p.stderr.strip()[-200:]})")
    lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
    eq(len(lines), 1, f"one line out: {lines}")
    line = json.loads(lines[0])
    eq(line.get("type"), "error", "an error line")
    eq("--gate-shadow" in line.get("message", ""), True,
       f"naming the flag, not the file it never opened: {line.get('message')!r}")
check("--gate-shadow without --gate exits 2 with an error line (a subprocess)", refuses_without_gate)


@contextlib.contextmanager
def stand_ins(frames):
    """main() with the decoder, the model and ffprobe replaced, restoring all
    three after. The decoder hands out `frames` of the scene as raw bgr24, one
    read at a time as ffmpeg's pipe does; the model's output is the blob it was
    given, which fake_model reads back into a frame."""
    calls = {"probe": 0, "popen": 0, "model": 0}

    class Decoder:
        def __init__(self):
            self.i = 0
            self.stdout = self

        def read(self, size):
            if self.i >= frames:
                return b""
            fr = scene(self.i)
            self.i += 1
            assert fr.nbytes == size, f"a frame is {fr.nbytes} bytes, replay read {size}"
            return fr.tobytes()

        def kill(self):
            pass

    def popen(cmd, **kw):
        calls["popen"] += 1
        return Decoder()

    def probe(path):
        calls["probe"] += 1
        return (640, 360)

    class Session:
        def __init__(self, *a, **kw):
            calls["model"] += 1

        def get_inputs(self):
            return [types.SimpleNamespace(name="images")]

        def run(self, outputs, feeds):
            return [feeds["images"]]

    ort = types.SimpleNamespace(SessionOptions=lambda: types.SimpleNamespace(), InferenceSession=Session)
    saved = (r.probe_size, r.subprocess, r.postprocess, sys.modules.get("onnxruntime"), sys.argv)
    r.probe_size = probe
    r.subprocess = types.SimpleNamespace(Popen=popen, PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL)
    r.postprocess = lambda out, w, h: fake_model(out[0].transpose(1, 2, 0))
    sys.modules["onnxruntime"] = ort
    try:
        yield calls
    finally:
        r.probe_size, r.subprocess, r.postprocess, ort_before, sys.argv = saved
        if ort_before is None:
            sys.modules.pop("onnxruntime", None)
        else:
            sys.modules["onnxruntime"] = ort_before


def run_main(args, frames=200):
    """(exit code, stdout lines, stand-in calls) of replay.main() with `args`."""
    out, err = io.StringIO(), io.StringIO()
    with stand_ins(frames) as calls:
        sys.argv = ["replay.py", "--file", "clip.mp4", "--model", "m.onnx"] + args
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = r.main()
    return code, out.getvalue().splitlines(), calls


def old_loop(gated, frames=200):
    """replay.py's loop as it was before shadow mode, restated from its last
    version: the lines a plain run must still print, byte for byte."""
    gate = g.Gate(640, 360, 0.5, g.DEFAULT_THRESHOLD, g.DEFAULT_KEEPALIVE_MS) if gated else None
    out = []
    for i in range(frames):
        frame = scene(i)
        t_ms = (0.0 + i / 5.0) * 1000 + 0.0
        if gate is None or gate.should_look(frame, t_ms):
            detections = fake_model(frame)
            if gate is not None:
                gate.looked(detections, t_ms)
            out.append(json.dumps({"frame": i, "tSec": round(0.0 + i / 5.0, 3),
                                   "detections": detections}, separators=(",", ":")))
    if gate is not None:
        out.append(json.dumps(gate.totals(), separators=(",", ":")))
    return out


def main_end_to_end():
    tmp = tempfile.mkdtemp(prefix="replay-shadow-")
    try:
        code, ungated, _ = run_main([])
        eq(code, 0, "ungated exit code")
        same_list(ungated, old_loop(False), "ungated output, line by line")
        gate_args = ["--gate", "--track-floor", "0.5"]
        code, plain, _ = run_main(gate_args + ["--gate-state", os.path.join(tmp, "plain.json")])
        eq(code, 0, "plain gated exit code")
        same_list(plain, old_loop(True), "plain gated output, line by line")
        code, shadow, _ = run_main(gate_args + ["--gate-shadow", "--gate-state", os.path.join(tmp, "shadow.json")])
        eq(code, 0, "shadow exit code")
        frames = [json.loads(ln) for ln in shadow[:-1]]
        eq(len(frames), 200, "shadow prints every frame")
        eq(all(type(f.get("gateLooked")) is bool for f in frames), True, "each with a boolean gateLooked")
        looked = []
        for f in frames:
            if f.pop("gateLooked"):
                looked.append(json.dumps(f, separators=(",", ":")))
        same_list(looked, plain[:-1], "the frames it marked looked are the plain run's lines, byte for byte")
        eq(shadow[-1], plain[-1], "the final gate totals line is the plain run's")
        with open(os.path.join(tmp, "plain.json"), encoding="utf8") as a, \
                open(os.path.join(tmp, "shadow.json"), encoding="utf8") as b:
            eq(b.read() == a.read(), True, "and the gate state carried to the next file is the plain run's")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
check("main(): plain gated and ungated output unchanged; shadow adds every frame and nothing else", main_end_to_end)


def refuses_before_opening():
    code, lines, calls = run_main(["--gate-shadow"])
    eq(code, 2, "exit code")
    eq(calls, {"probe": 0, "popen": 0, "model": 0}, "the file was never probed or decoded, the model never loaded")
    eq(json.loads(lines[0])["type"], "error", "an error line")
    code, lines, calls = run_main(["--gate", "--gate-shadow"])
    eq((code, calls["probe"]), (2, 0), "with --gate but no --track-floor, the gate's own refusal still applies")
    eq("--track-floor" in json.loads(lines[0])["message"], True, f"and says so: {lines[0]}")
check("the refusals come before the file is probed or the model loaded", refuses_before_opening)

print(f"\nreplay shadow: {total - len(failures)} passed, {len(failures)} failed")
sys.exit(1 if failures else 0)
