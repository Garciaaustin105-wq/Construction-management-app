/**
 * Runs detector/test_appearance.py (the clothing signature,
 * APPEARANCE-OF-DAY-SPEC.md's "What is measured") when Python with numpy is
 * present; skips LOUDLY when it is not, like yoloxPost does for
 * test_postprocess.py - the same reason: building synthetic crops needs
 * numpy, even though importing appearance.py itself does not (it defers its
 * own numpy import, the same discipline motion_gate.py uses, so importing
 * yolox_worker.py stays numpy-free for arrivalStamps).
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
  console.log("appearance\n  SKIP no Python with numpy here (set CAMPLAT_PYTHON to the detector venv's python)");
  console.log("appearance: 0 passed, 0 failed (skipped)");
  process.exit(0);
}
const r = spawnSync(python, [path.join(import.meta.dirname, "..", "detector", "test_appearance.py")], { stdio: "inherit" });
process.exit(r.status ?? 1);
