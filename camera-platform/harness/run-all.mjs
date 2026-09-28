import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
const suites = ["retention", "alerts", "alertsRun", "segment", "loadtest", "camera", "rtsp", "eviction", "recovery", "net", "ffprobe", "realFfmpeg", "discovery", "budget", "recorder", "scale", "driveRoot", "bandwidth", "timeline", "uploadPolicy", "cameraSource", "service", "httpRange", "apiQuery", "indexCoverage", "cameraView", "cameraEdit", "cameraSettings", "recordingSettings", "cameraGroups", "siteHealth", "liveNegotiation", "live", "liveBuffer", "liveReconnect", "detection", "detectSchedule", "clipLibrary", "clipSave", "alertRules", "aiSettings", "reviewClient", "alertBanner", "reviewPage", "systemPage", "gridLayout", "wallPage", "playback", "access", "routeAccess", "auth", "zipStore", "releaseTrust", "releaseVerify", "trustAnchor", "exportPlan", "exportManifest", "exportStream", "apiServer", "listenPlan", "listeners", "emptySegment", "liveShare", "cleanEmpty", "detectStream", "detectService", "yoloxPost", "eventQuery", "eventsDb", "eventMarkers", "boxJitter", "eventThumb", "eventCrop", "trackBoxes", "fixtures", "negativeSampling", "harvest", "footageHeld", "reviewRefresh", "recordingClient", "healthFacts", "scoreRun", "scoreClips", "motionGate", "replayShadow", "gateCheck", "gateCheckRun", "knownObjects", "knownObjectsStore", "knownObjectsApi", "webPush", "teachCandidates", "teachRoutes", "teachPage", "deviceCheckin", "checkin", "cloudEnroll", "deviceIdentity", "arrivalStamps", "hardenProc", "eventRetention", "eventRetentionRun", "networkView", "networkFacts", "networkPage", "healthHistory", "healthHistoryRun", "healthCharts", "activity", "activityMeasure", "activityRun", "activityPage", "cameraAiSettings", "cameraAiSettingsApi", "cameraAiPage", "siteSettings", "savedLayouts", "siteSettingsApi", "savedLayoutsApi", "sitePage", "layoutClientPage", "accountsPage", "sessionBarFeature", "areas", "zoneOccupancy", "managerRules", "occupancyRun", "managerRulesApi", "managerRulesRetention", "rulesPage", "areasPage", "reportsPage", "pushAlerts", "pushStore", "pushDelivery", "alertsPage", "sw", "appearance", "appearanceSignature", "appearanceOfDay"];
let failed = 0;
// A harness on disk that is not in the list above is a suite nobody runs,
// which passes by default. Build 3's three appearance suites sat unlisted
// this way; this guard makes the next one fail loudly instead.
const unlisted = readdirSync("harness")
  .filter((f) => f.endsWith(".harness.mjs"))
  .map((f) => f.slice(0, -".harness.mjs".length))
  .filter((name) => !suites.includes(name));
if (unlisted.length > 0) {
  console.error(`UNLISTED harness suite(s), add them to harness/run-all.mjs: ${unlisted.join(", ")}`);
  failed++;
}
for (const s of suites) {
  const r = spawnSync(process.execPath, [`harness/${s}.harness.mjs`], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(failed === 0 ? "\nALL SUITES PASSED" : `\n${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
