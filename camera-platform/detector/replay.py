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
import subprocess
import sys

from yolox_worker import INPUT, postprocess


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
    args = ap.parse_args()

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
    i = 0
    try:
        while True:
            buf = ff.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(INPUT, INPUT, 3)
            blob = frame.transpose(2, 0, 1)[None].astype(np.float32)
            detections = postprocess(session.run(None, {input_name: blob})[0], width, height)
            print(json.dumps({"frame": i, "tSec": round(args.start + i / args.fps, 3),
                              "detections": detections}, separators=(",", ":")))
            i += 1
            if args.frames and i >= args.frames:
                break
    finally:
        ff.kill()
    print(json.dumps({"type": "done", "frames": i, "size": [width, height]}), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
