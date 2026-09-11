import { spawnSync } from "node:child_process";
const suites = ["retention", "segment", "camera", "rtsp", "eviction", "recovery", "net", "ffprobe", "discovery", "budget", "recorder", "scale", "bandwidth", "timeline", "uploadPolicy", "cameraSource"];
let failed = 0;
for (const s of suites) {
  const r = spawnSync(process.execPath, [`harness/${s}.harness.mjs`], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(failed === 0 ? "\nALL SUITES PASSED" : `\n${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
