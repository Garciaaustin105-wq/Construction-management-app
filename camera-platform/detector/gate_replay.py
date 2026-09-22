"""Measure the motion gate against a real recorded day, before it goes live.

Read-only: it decodes recorded footage, prints one JSON result to stdout and
writes nothing. It is how motion_gate.py's threshold and keepalive were
chosen (FIELD-NOTES.md, 2026-09-21), and how they should be checked again on
any new site or camera.

Input, a JSON file (--jobs):
  {"fps": 5,
   "files":  [{"path": "/srv/.../<epochMs>.mp4", "startMs": 1790...}, ...],
   "people": [{"firstMs": ..., "lastMs": ...}, ...],     live person events
   "tracked": [{"firstMs": ..., "lastMs": ...}, ...]}    every live event, any kind
The footage should be the SUBSTREAM, the stream the live detector reads. The
frames are decoded exactly as yolox_worker.py decodes them: letterboxed to
640x640 at the granted fps, then reduced with motion_gate.grid_of.

For each (threshold, keepalive) it replays motion_gate.decide over every frame
and reports:
  looked       share of frames the detector would still run on (the load)
  peopleFound  live person events with at least one look inside them
  missed       the ones with none, with how much they moved
"Tracked" is approximated from the live events (a look inside a live event
finds it), since live ran on every frame.

Two limits on what it measures, found in review (2026-09-21):
  - peopleFound is OPTIMISTIC. A look anywhere between an event's first and
    last sighting counts it found, but live stores only the event's first,
    best and last sightings, not every frame the person was seen in, so a
    look that landed where the model saw nobody still counts. It bounds what
    the gate could find; `camctl score` with the gate on measures what it
    does find.
  - It predates the local-motion rule (motion_gate.LOCAL_THRESHOLD: a tracked
    thing whose own patch moves is looked at every frame). It has no boxes
    per frame to apply that rule to, so its load figures are without it. The
    live worker reports its real load, rule included, once a minute
    (detect-health.json, gate.lastWindow).
"""
import argparse
import bisect
import json
import subprocess
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0])
import numpy as np  # noqa: E402
import motion_gate as g  # noqa: E402

INPUT = 640
THRESHOLDS = [0.002, 0.003, 0.005, 0.0075, 0.01, 0.02]
KEEPALIVES_MS = [5_000, 10_000, 20_000, 30_000, 60_000]


def probe_size(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height", "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        w, h = (int(x) for x in r.stdout.strip().split(",")[:2])
        return w, h
    except ValueError:
        return None


def frames(path, fps):
    vf = (f"fps={fps},scale={INPUT}:{INPUT}:force_original_aspect_ratio=decrease,"
          f"pad={INPUT}:{INPUT}:0:0:color=0x727272")
    p = subprocess.Popen(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path,
                          "-an", "-vf", vf, "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    n = INPUT * INPUT * 3
    try:
        while True:
            b = p.stdout.read(n)
            if not b or len(b) < n:
                return
            yield np.frombuffer(b, dtype=np.uint8).reshape(INPUT, INPUT, 3)
    finally:
        p.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True)
    args = ap.parse_args()
    jobs = json.load(open(args.jobs))
    fps = float(jobs["fps"])
    step_ms = 1000.0 / fps
    files = sorted(jobs["files"], key=lambda f: f["startMs"])
    if not files:
        print(json.dumps({"error": "no files"}))
        return 2
    size = probe_size(files[0]["path"])
    if size is None:
        print(json.dumps({"error": "could not read the picture size"}))
        return 2
    w, h = size
    scale = min(INPUT / w, INPUT / h)
    pic_w, pic_h = int(w * scale), int(h * scale)

    # One pass over the footage: a time and a changed share for every frame.
    times, changed = [], []
    prev, prev_end = None, None
    for f in files:
        if prev_end is not None and f["startMs"] - prev_end > 2000:
            prev = None  # a hole in the footage: nothing to compare against
        i = -1
        for i, fr in enumerate(frames(f["path"], fps)):
            grid = g.grid_of(fr, pic_w, pic_h)
            times.append(f["startMs"] + i * step_ms)
            changed.append(g.changed_fraction(prev, grid))
            prev = grid
        prev_end = f["startMs"] + (i + 1) * step_ms
    t = np.array(times)

    def covered(spans):
        """Per frame: inside any span (padded by one frame each side)."""
        mask = np.zeros(len(t), dtype=bool)
        for s in spans:
            a = bisect.bisect_left(times, s["firstMs"] - step_ms)
            b = bisect.bisect_right(times, s["lastMs"] + step_ms)
            mask[a:b] = True
        return mask

    tracked = covered(jobs.get("tracked", []))
    people = [p for p in jobs.get("people", []) if times[0] <= p["firstMs"] <= times[-1]]
    ch = np.array([c if c is not None else -1.0 for c in changed])

    people_motion = []
    for p in people:
        a = bisect.bisect_left(times, p["firstMs"] - step_ms)
        b = bisect.bisect_right(times, p["lastMs"] + step_ms)
        people_motion.append(float(ch[a:b].max()) if b > a else None)

    results = []
    for threshold in THRESHOLDS:
        for keepalive in KEEPALIVES_MS:
            state, looked = g.new_state(), np.zeros(len(t), dtype=bool)
            for i in range(len(t)):
                c = changed[i]
                look, _ = g.decide(state, c, t[i], threshold, keepalive)
                if look:
                    looked[i] = True
                    state = g.after_look(state, t[i], bool(tracked[i]))
            found, missed = 0, []
            for p, m in zip(people, people_motion):
                a = bisect.bisect_left(times, p["firstMs"] - step_ms)
                b = bisect.bisect_right(times, p["lastMs"] + step_ms)
                if looked[a:b].any():
                    found += 1
                else:
                    missed.append({"firstMs": p["firstMs"], "seconds": round((p["lastMs"] - p["firstMs"]) / 1000, 1),
                                   "maxChanged": m})
            results.append({"threshold": threshold, "keepaliveMs": keepalive,
                            "looked": round(float(looked.mean()), 4),
                            "peopleFound": found, "people": len(people), "missed": missed[:10]})

    valid = ch[ch >= 0]
    print(json.dumps({
        "frames": len(t), "hours": round((times[-1] - times[0]) / 3_600_000, 2), "picture": [pic_w, pic_h],
        "trackedShare": round(float(tracked.mean()), 4),
        "dutyAt": {str(th): round(float((valid >= th).mean()), 4) for th in THRESHOLDS},
        "peopleMotion": sorted(round(m, 4) for m in people_motion if m is not None),
        "results": results,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
