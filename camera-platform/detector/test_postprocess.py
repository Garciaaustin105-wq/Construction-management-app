"""Checks for yolox_worker.postprocess: the arithmetic that turns the model's raw
output into boxes. Needs numpy only (no model, no camera). Run by
harness/yoloxPost.harness.mjs, which skips loudly when numpy is missing.

THE FEARED FAILURES: a box in the wrong place because the grid, the stride or
the letterbox was undone wrongly (the detector "works" and every alert zone
is wrong); one person reported several times; a dog or a chair reported as a
person; a model with a different input size decoded as if it were 640.
"""
import math
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0])
import numpy as np  # noqa: E402
from yolox_worker import postprocess, letterbox_ratio  # noqa: E402

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


def close(a, b, what, tol=1e-4):
    if abs(a - b) > tol:
        raise AssertionError(f"{what}: expected {b}, got {a}")


def empty():
    return np.zeros((1, 8400, 85), dtype=np.float32)


def place(out, stride, col, row, dx, dy, w_px, h_px, obj, cls, prob, grid_before=0):
    n = 640 // stride
    idx = grid_before + row * n + col
    out[0, idx, 0] = dx
    out[0, idx, 1] = dy
    out[0, idx, 2] = math.log(w_px / stride)
    out[0, idx, 3] = math.log(h_px / stride)
    out[0, idx, 4] = obj
    out[0, idx, 5 + cls] = prob
    return idx


# Worked by hand: stride 8, cell (10, 20), offsets 0.5 -> centre (84, 164) in
# the 640 square, 40 x 80 px. The frame is 1280 x 720, so the ratio is 0.5 and
# the image sits at the top-left: (128, 248) to (208, 408) in the frame.
def person_in_the_right_place():
    out = empty()
    place(out, 8, 10, 20, 0.5, 0.5, 40, 80, 0.9, 0, 0.9)
    ds = postprocess(out, 1280, 720)
    if len(ds) != 1:
        raise AssertionError(f"expected one detection, got {ds}")
    d = ds[0]
    if d["kind"] != "person":
        raise AssertionError(d)
    close(d["confidence"], 0.81, "confidence = objectness x class")
    close(d["box"]["x"], 128 / 1280, "x")
    close(d["box"]["y"], 248 / 720, "y")
    close(d["box"]["w"], 80 / 1280, "w")
    close(d["box"]["h"], 160 / 720, "h")


def letterbox_is_undone_on_a_tall_frame():
    # 720 x 1280 portrait: ratio 0.5 again, but now the width is what is short.
    close(letterbox_ratio(720, 1280), 0.5, "ratio")
    out = empty()
    place(out, 32, 5, 10, 0.0, 0.0, 64, 128, 0.95, 0, 0.95, grid_before=6400 + 1600)
    d = postprocess(out, 720, 1280)[0]
    # centre (160, 320) -> frame (320, 640); 64 x 128 -> 128 x 256
    close(d["box"]["x"], (320 - 64) / 720, "x")
    close(d["box"]["y"], (640 - 128) / 1280, "y")


def one_person_is_one_detection():
    out = empty()
    place(out, 8, 10, 20, 0.5, 0.5, 40, 80, 0.9, 0, 0.9)
    place(out, 8, 11, 20, 0.4, 0.5, 40, 80, 0.85, 0, 0.9)   # the neighbouring cell sees the same person
    place(out, 16, 5, 10, 0.2, 0.3, 40, 80, 0.8, 0, 0.8, grid_before=6400)  # and a coarser stride too
    ds = [d for d in postprocess(out, 1280, 720) if d["kind"] == "person"]
    if len(ds) != 1:
        raise AssertionError(f"expected one person after NMS, got {len(ds)}: {ds}")
    close(ds[0]["confidence"], 0.81, "the best of the three kept")


def two_people_apart_stay_two():
    out = empty()
    place(out, 8, 10, 20, 0.5, 0.5, 40, 80, 0.9, 0, 0.9)
    place(out, 8, 60, 20, 0.5, 0.5, 40, 80, 0.9, 0, 0.9)
    ds = postprocess(out, 1280, 720)
    if len(ds) != 2:
        raise AssertionError(f"two separate people should stay two: {ds}")


def only_people_and_vehicles():
    out = empty()
    place(out, 8, 10, 20, 0.5, 0.5, 40, 80, 0.9, 16, 0.95)   # 16: dog
    place(out, 8, 30, 20, 0.5, 0.5, 40, 80, 0.9, 56, 0.95)   # 56: chair
    place(out, 8, 50, 20, 0.5, 0.5, 80, 40, 0.9, 2, 0.9)     # 2: car
    place(out, 8, 70, 40, 0.5, 0.5, 80, 60, 0.9, 7, 0.9)     # 7: truck
    kinds = sorted(d["kind"] for d in postprocess(out, 1280, 720))
    if kinds != ["vehicle", "vehicle"]:
        raise AssertionError(f"only the car and the truck, as vehicles: {kinds}")


def below_the_floor_is_dropped():
    out = empty()
    place(out, 8, 10, 20, 0.5, 0.5, 40, 80, 0.4, 0, 0.5)     # 0.2 < 0.25
    if postprocess(out, 1280, 720):
        raise AssertionError("a 0.2 score was reported")


def boxes_stay_inside_the_frame():
    out = empty()
    place(out, 32, 19, 11, 0.9, 0.9, 400, 400, 0.9, 0, 0.9, grid_before=6400 + 1600)  # hangs off the bottom right
    d = postprocess(out, 1280, 720)[0]["box"]
    if d["x"] < 0 or d["y"] < 0 or d["x"] + d["w"] > 1 + 1e-9 or d["y"] + d["h"] > 1 + 1e-9:
        raise AssertionError(f"box left the frame: {d}")


def a_different_input_size_is_refused():
    try:
        postprocess(np.zeros((1, 3549, 85), dtype=np.float32), 1280, 720)  # a 416-px model
    except ValueError:
        return
    raise AssertionError("decoded a 416-px model's output as if it were 640")


def a_person_reports_the_species_person():
    out = empty()
    place(out, 8, 10, 20, 0.5, 0.5, 40, 80, 0.9, 0, 0.9)
    d = postprocess(out, 1280, 720)[0]
    if d["kind"] != "person" or d["species"] != "person":
        raise AssertionError(d)


def a_car_class_detection_reports_car():
    out = empty()
    place(out, 8, 50, 20, 0.5, 0.5, 80, 40, 0.9, 2, 0.9)   # 2: car
    d = postprocess(out, 1280, 720)[0]
    if d["kind"] != "vehicle" or d["species"] != "car":
        raise AssertionError(d)


def a_truck_class_detection_reports_truck():
    out = empty()
    place(out, 8, 70, 40, 0.5, 0.5, 80, 60, 0.9, 7, 0.9)   # 7: truck
    d = postprocess(out, 1280, 720)[0]
    if d["kind"] != "vehicle" or d["species"] != "truck":
        raise AssertionError(d)


def the_higher_scoring_class_wins_the_species_and_nms_still_collapses_to_one():
    # Two neighbouring cells (the same "one person seen twice" shape as
    # one_person_is_one_detection above) see the same vehicle: one reads it as
    # a car, the other - scoring higher - as a truck. NMS runs per KIND, so
    # this must still collapse to ONE vehicle, and its species must follow the
    # stronger reading, not the first one written.
    out = empty()
    place(out, 8, 50, 20, 0.5, 0.5, 80, 40, 0.9, 2, 0.6)   # car: 0.9*0.6 = 0.54
    place(out, 8, 51, 20, 0.4, 0.5, 80, 40, 0.9, 7, 0.8)   # truck: 0.9*0.8 = 0.72, overlapping box
    ds = [d for d in postprocess(out, 1280, 720) if d["kind"] == "vehicle"]
    if len(ds) != 1:
        raise AssertionError(f"one physical object should stay one vehicle detection: {ds}")
    if ds[0]["species"] != "truck":
        raise AssertionError(f"the higher-scoring class should decide the species: {ds[0]}")
    close(ds[0]["confidence"], 0.72, "confidence is the winning class's score")


print("yolox postprocess")
check("THE FEARED ONE: a person lands exactly where the model put them, in the camera's frame", person_in_the_right_place)
check("the letterbox is undone on a portrait frame too", letterbox_is_undone_on_a_tall_frame)
check("THE FEARED ONE: one person seen by several cells and strides is one detection", one_person_is_one_detection)
check("two people apart stay two", two_people_apart_stay_two)
check("THE FEARED ONE: a dog or a chair is never a person; cars and trucks are vehicles", only_people_and_vehicles)
check("a score below the floor is dropped", below_the_floor_is_dropped)
check("a box hanging off the frame is clipped to it", boxes_stay_inside_the_frame)
check("THE FEARED ONE: a model with another input size is refused, not misread", a_different_input_size_is_refused)
check("a person reports the species person", a_person_reports_the_species_person)
check("a car-class detection reports the species car", a_car_class_detection_reports_car)
check("a truck-class detection reports the species truck", a_truck_class_detection_reports_truck)
check("THE FEARED ONE: the higher-scoring class wins the species, and NMS (per kind) still collapses two class readings of one object to one detection", the_higher_scoring_class_wins_the_species_and_nms_still_collapses_to_one)
print(f"yolox postprocess: {total - len(failures)} passed, {len(failures)} failed")
sys.exit(1 if failures else 0)
