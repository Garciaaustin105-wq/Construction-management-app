/**
 * Runs detector/test_postprocess.py (the YOLOX box arithmetic) when Python
 * with numpy is present; skips LOUDLY when it is not, like realFfmpeg does
 * without ffmpeg. The bench PC has no numpy; the laptop NVR's detector venv
 * does (CAMPLAT_PYTHON points at it).
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
  console.log("yolox postprocess\n  SKIP no Python with numpy here (set CAMPLAT_PYTHON to the detector venv's python)");
  console.log("yolox postprocess: 0 passed, 0 failed (skipped)");
  process.exit(0);
}
const r = spawnSync(python, [path.join(import.meta.dirname, "..", "detector", "test_postprocess.py")], { stdio: "inherit" });
process.exit(r.status ?? 1);
