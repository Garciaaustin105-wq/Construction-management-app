#!/usr/bin/env python3
"""camplat-detect worker: one camera's substream in, one JSON line per frame out.

Run by agent/detect-service.mjs, never by hand on a site. Protocol (stdout, one
JSON object per line; contracts/detectStream.ts reads and checks every line):

  {"type": "ready", "model": "yolox_s", "inputSize": 640}
  {"type": "frame", "atUtc": "...Z", "detections": [
      {"kind": "vehicle", "species": "truck", "confidence": 0.82,
       "box": {"x": .., "y": .., "w": .., "h": ..}}]}
  {"type": "error", "message": "..."}

Boxes are fractions of the camera's frame (0..1). The worker never prints the
camera URL: it carries the password (bench 2026-09-19), so errors say what
failed, not where.

Decoding is ffmpeg's (the substream, rate-limited by its fps filter, letterboxed
to the model's square input). Inference is ONNX Runtime on the CPU here; the
Hailo-8 build swaps run_model() and nothing else. Pre- and post-processing
follow YOLOX's own demo (Megvii-BaseDetection/YOLOX, demo/ONNXRuntime):
BGR, unnormalised 0..255, image at the top-left of a 114-grey square; outputs
decoded on strides 8/16/32, score = objectness x class, per-class NMS.

Only numpy and onnxruntime are needed. postprocess() and letterbox_ratio() are
pure and tested by detector/test_postprocess.py.
"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

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
    args = ap.parse_args()

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

    vf = (f"fps={args.fps},scale={INPUT}:{INPUT}:force_original_aspect_ratio=decrease,"
          f"pad={INPUT}:{INPUT}:0:0:color=0x727272")
    ff = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp",
         "-timeout", RTSP_TIMEOUT_US, "-i", args.url, "-an", "-vf", vf,
         "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    say({"type": "ready", "model": args.model.rsplit("/", 1)[-1].rsplit(".", 1)[0], "inputSize": INPUT})

    frame_bytes = INPUT * INPUT * 3
    last = time.monotonic()
    try:
        while True:
            buf = ff.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                say({"type": "error", "message": "the substream ended"})
                return 3
            at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(INPUT, INPUT, 3)
            detections = postprocess(run_model(frame), width, height)
            say({"type": "frame", "atUtc": at, "detections": detections})
            now = time.monotonic()
            if now - last > STALL_SECONDS:
                say({"type": "error", "message": f"fell {int(now - last)} s behind"})
            last = now
    finally:
        ff.kill()


if __name__ == "__main__":
    sys.exit(main())
