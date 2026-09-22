#!/usr/bin/env python3
"""Replay a RECORDED file through the detector and print every frame's boxes.

Why this exists: events.db keeps only the best box of an event, so nothing
stored can answer "how much did it move". This reads footage that is already on
disk and prints one JSON line per frame, so the question can be asked of the
past — including the past before anyone thought to ask.

It is also the scoring harness D1's exit bar needs: a clip with a known answer,
replayed, gives a measured detection rate instead of an impression.

    python3 replay.py --file /srv/camplat/disk0/cam1-main/1234.mp4 \
        --model /opt/camplat-models/yolox_s.onnx --fps 5

Output, one per frame:
    {"frame": 0, "tSec": 0.0, "detections": [{"kind": "person", "confidence": 0.91,
     "box": {"x": .., "y": .., "w": .., "h": ..}}]}

READ ONLY. It opens one file, decodes it and prints. It never touches the
index, events.db, the live services or the camera — a diagnostic that could
disturb recording would be worse than no diagnostic (build rule 21).

Decoding and pre-processing are IDENTICAL to detector/yolox_worker.py, which
this imports from rather than re-implementing: a replay that letterboxed
differently would produce boxes that are subtly wrong in a way nobody would
notice, and every conclusion drawn from them would be wrong too.
"""
import argparse
import json
import math
import os
import subprocess
import sys

from yolox_worker import INPUT, postprocess, letterbox_ratio, say  # noqa: E402
import motion_gate  # noqa: E402


def probe_size(path):
    """The file's picture size, from ffprobe. None when it cannot tell."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30,
        )
        w, h = (int(v) for v in out.stdout.strip().split(",")[:2])
        return (w, h) if w > 0 and h > 0 else None
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="a recorded mp4 on disk")
    ap.add_argument("--model", required=True)
    ap.add_argument("--fps", type=float, default=5.0, help="sample rate, to match the live detector")
    ap.add_argument("--start", type=float, default=0.0, help="seconds into the file")
    ap.add_argument("--frames", type=int, default=0, help="stop after this many (0 = all)")
    ap.add_argument("--threads", type=int, default=2)
    # Motion gate (detector/motion_gate.py): look only when something moves,
    # holds still while tracked, or is due a keepalive. Off unless detect.json
    # turns it on; the scoring runner passes the live settings, so a
    # score is made the way live runs.
    ap.add_argument("--gate", action="store_true")
    ap.add_argument("--track-floor", type=float, default=None,
                    help="detect.json minConfidence: what counts as tracking")
    ap.add_argument("--gate-threshold", type=float, default=None)
    ap.add_argument("--gate-keepalive-ms", type=float, default=None)
    # A clip is recorded as several files, and live runs ONE gate across all
    # of them. Found in review: replaying each file with a fresh gate gave
    # every file a free first look and a reset keepalive, which live never
    # has. The runner passes a state file (read if it exists, written at the
    # end) and each file's start on the clip's clock.
    ap.add_argument("--gate-state", default=None,
                    help="carry the gate across files: read at start if present, written at the end")
    ap.add_argument("--gate-clock-offset-ms", type=float, default=0.0,
                    help="this file's start on the clip's clock, for the gate only")
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
        if not math.isfinite(args.gate_clock_offset_ms) or args.gate_clock_offset_ms < 0:
            say({"type": "error", "message": "--gate-clock-offset-ms must be a time from 0 on"})
            return 2
        gate_settings = (args.track_floor, threshold, keepalive)

    import numpy as np
    import onnxruntime as ort

    size = probe_size(args.file)
    if size is None:
        print(json.dumps({"type": "error", "message": "could not read the file's picture size"}))
        return 2
    width, height = size

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, args.threads)
    session = ort.InferenceSession(args.model, sess_options=opts, providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name

    vf = (f"fps={args.fps},scale={INPUT}:{INPUT}:force_original_aspect_ratio=decrease,"
          f"pad={INPUT}:{INPUT}:0:0:color=0x727272")
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error"]
    if args.start > 0:
        cmd += ["-ss", str(args.start)]
    cmd += ["-i", args.file, "-an", "-vf", vf, "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"]
    ff = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    frame_bytes = INPUT * INPUT * 3
    gate = None
    if gate_settings is not None:
        ratio = letterbox_ratio(width, height)
        floor, threshold, keepalive = gate_settings
        gate = motion_gate.Gate(int(width * ratio), int(height * ratio), floor, threshold, keepalive)
        if args.gate_state and os.path.exists(args.gate_state):
            try:
                with open(args.gate_state, encoding="utf8") as fh:
                    gate.restore(json.load(fh))
            except (OSError, ValueError):
                pass  # unreadable: a fresh gate, which only looks more
    i = 0
    try:
        while True:
            buf = ff.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(INPUT, INPUT, 3)
            # Frame time, not wall time: a replay runs faster or slower than
            # life, and the gate must see the clip's own clock.
            t_ms = (args.start + i / args.fps) * 1000 + args.gate_clock_offset_ms
            if gate is None or gate.should_look(frame, t_ms):
                blob = frame.transpose(2, 0, 1)[None].astype(np.float32)
                detections = postprocess(session.run(None, {input_name: blob})[0], width, height)
                if gate is not None:
                    gate.looked(detections, t_ms)
                print(json.dumps({"frame": i, "tSec": round(args.start + i / args.fps, 3),
                                  "detections": detections}, separators=(",", ":")))
            i += 1
            if args.frames and i >= args.frames:
                break
    finally:
        ff.kill()
    if gate is not None:
        print(json.dumps(gate.totals(), separators=(",", ":")))
        if args.gate_state:
            with open(args.gate_state, "w", encoding="utf8") as fh:
                json.dump(gate.save(), fh)
    print(json.dumps({"type": "done", "frames": i, "size": [width, height]}), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
