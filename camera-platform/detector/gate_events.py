"""Per live event: how much the picture moved while it happened.

Read-only companion to gate_replay.py. gate_replay says how many person events
a gate setting would miss; this says WHICH, with what they looked like to the
detector (confidence, box size) beside the movement the gate would have seen,
so a missed event can be told apart as a real person the gate would lose or a
false alarm the gate would rightly skip. Nothing is decided here.

Input (--jobs): {"fps": 5, "files": [{"path", "startMs"}], "events": [{"id",
"firstMs", "lastMs", "confidence", "boxArea"}]}. Output: one JSON line per event.
"""
import argparse
import bisect
import json
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0])
import motion_gate as g  # noqa: E402
from gate_replay import frames, probe_size, INPUT  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True)
    jobs = json.load(open(ap.parse_args().jobs))
    fps = float(jobs["fps"])
    step = 1000.0 / fps
    files = sorted(jobs["files"], key=lambda f: f["startMs"])
    starts = [f["startMs"] for f in files]
    w, h = probe_size(files[0]["path"])
    scale = min(INPUT / w, INPUT / h)
    pic_w, pic_h = int(w * scale), int(h * scale)
    cache = {}

    def series(i):
        """(times, changed) for file i, measured against the end of file i-1."""
        if i in cache:
            return cache[i]
        prev = None
        if i > 0 and files[i]["startMs"] - files[i - 1]["startMs"] <= 62_000:
            for fr in frames(files[i - 1]["path"], fps):
                prev = g.grid_of(fr, pic_w, pic_h)
        ts, cs = [], []
        for k, fr in enumerate(frames(files[i]["path"], fps)):
            grid = g.grid_of(fr, pic_w, pic_h)
            ts.append(files[i]["startMs"] + k * step)
            cs.append(g.changed_fraction(prev, grid))
            prev = grid
        cache[i] = (ts, cs)
        return cache[i]

    for e in jobs["events"]:
        lo = bisect.bisect_right(starts, e["firstMs"]) - 1
        hi = bisect.bisect_right(starts, e["lastMs"]) - 1
        peak, n = None, 0
        for i in range(max(0, lo), max(0, hi) + 1):
            ts, cs = series(i)
            for t, c in zip(ts, cs):
                if e["firstMs"] - step <= t <= e["lastMs"] + step and c is not None:
                    n += 1
                    peak = c if peak is None else max(peak, c)
        print(json.dumps({**e, "framesMeasured": n, "peakChanged": peak}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
