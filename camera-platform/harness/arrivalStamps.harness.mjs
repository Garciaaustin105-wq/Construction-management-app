/**
 * Runs detector/test_arrival_stamps.py (pairing a frame read from ffmpeg's
 * stdout with the arrival time ffmpeg's showinfo filter reports on stderr).
 * Unlike yoloxPost/motionGate, this needs no numpy - yolox_worker.py's numpy
 * and onnxruntime imports are both deferred inside main(), so importing the
 * module at all (which the test does, to reach PtsPairer/ArrivalStamps/the
 * parsers) costs nothing but the standard library. Still skips LOUDLY, same
 * spirit as the others, if no `python` is on PATH at all - the bench PC and
 * a bare CI box are not guaranteed to have one.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const candidates = [process.env.CAMPLAT_PYTHON, "python3", "python"].filter(Boolean);
let python = null;
for (const c of candidates) {
  const r = spawnSync(c, ["-c", "import sys"], { encoding: "utf8" });
  if (r.status === 0) { python = c; break; }
}
if (python === null) {
  console.log("arrival stamps\n  SKIP no Python here (set CAMPLAT_PYTHON to point at one)");
  console.log("arrival stamps: 0 passed, 0 failed (skipped)");
  process.exit(0);
}
const r = spawnSync(python, [path.join(import.meta.dirname, "..", "detector", "test_arrival_stamps.py")], { stdio: "inherit" });
process.exit(r.status ?? 1);
