/**
 * Runs detector/test_replay_shadow.py (replay.py --gate --gate-shadow: the
 * model on every frame, the gate beside it marking what it would have looked
 * at) when Python with numpy is present; skips LOUDLY when it is not, like
 * motionGate does. camctl gate-check's whole answer rests on the shadow gate
 * deciding exactly as the live one does, and on plain replay output staying
 * what the scoring runner already reads. No model, ffmpeg or onnxruntime is
 * needed: the test stands in for all three.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const candidates = [process.env.CAMPLAT_PYTHON, "python3", "python"].filter(Boolean);
let python = null;
for (const c of candidates) {
  const r = spawnSync(c, ["-c", "import numpy"], { encoding: "utf8" });
  if (r.status === 0) { python = c; break; }
}
if (python === null) {
  console.log("replay shadow\n  SKIP no Python with numpy here (set CAMPLAT_PYTHON to the detector venv's python)");
  console.log("replay shadow: 0 passed, 0 failed (skipped)");
  process.exit(0);
}
const r = spawnSync(python, [path.join(import.meta.dirname, "..", "detector", "test_replay_shadow.py")], { stdio: "inherit" });
process.exit(r.status ?? 1);
