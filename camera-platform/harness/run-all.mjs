import { spawnSync } from "node:child_process";
const suites = ["retention", "alerts", "alertsRun", "segment", "loadtest", "camera", "rtsp", "eviction", "recovery", "net", "ffprobe", "realFfmpeg", "discovery", "budget", "recorder", "scale", "bandwidth", "timeline", "uploadPolicy", "cameraSource", "service", "httpRange", "apiQuery", "indexCoverage", "cameraView", "cameraGroups", "siteHealth", "liveNegotiation", "live", "liveBuffer", "liveReconnect", "detection", "alertRules", "aiSettings", "reviewClient", "alertBanner", "reviewPage", "systemPage", "gridLayout", "wallPage", "playback", "access", "routeAccess", "auth", "zipStore", "exportPlan", "exportManifest", "exportStream", "apiServer"];
let failed = 0;
for (const s of suites) {
  const r = spawnSync(process.execPath, [`harness/${s}.harness.mjs`], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(failed === 0 ? "\nALL SUITES PASSED" : `\n${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
