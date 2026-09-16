# Model licenses

Every model the NVR runs is listed here, with its license, **before** it is
used (AI-PLAN.md). Model files are not committed to this repository.

No Ultralytics YOLO (AGPL-3.0), including YOLOv5/v8/v11 weights repackaged in
other model zoos.

| Model | Use | License | Source | SHA-256 | Where it lives |
|---|---|---|---|---|---|
| YOLOX-s (ONNX) | D1 person/vehicle detector, CPU/GPU testing | Apache-2.0 | github.com/Megvii-BaseDetection/YOLOX, release 0.1.1rc0, `yolox_s.onnx` | c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063 | bench PC only, `C:/camplat-bench/models/` |
| YOLOX-tiny (ONNX) | D1, smaller detector for CPU-only sizing | Apache-2.0 | same release, `yolox_tiny.onnx` | 427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7 | bench PC only, `C:/camplat-bench/models/` |

Both are trained on COCO (80 classes); D1 uses only person, car, truck, bus
and motorcycle.
