// cloud/harness/run-all.mjs — runs every cloud harness suite.
// Invoke from camera-platform/ as: node cloud/harness/run-all.mjs
// (paths below are relative to that cwd, matching harness/run-all.mjs's own convention).
//
// Suites are DISCOVERED, not listed: every *.harness.mjs in this directory
// runs. A hand-kept list let slices 2-5 and the API suites go unregistered;
// a suite nobody runs is a suite that passes by default.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const suites = readdirSync("cloud/harness")
  .filter((f) => f.endsWith(".harness.mjs"))
  .sort();
if (suites.length === 0) {
  console.error("no cloud harness suites found -- run this from camera-platform/");
  process.exit(1);
}
const failedNames = [];
for (const f of suites) {
  const r = spawnSync(process.execPath, [`cloud/harness/${f}`], { stdio: "inherit" });
  if (r.status !== 0) failedNames.push(f);
}
console.log(
  failedNames.length === 0
    ? `\nALL ${suites.length} SUITES PASSED`
    : `\n${failedNames.length} of ${suites.length} SUITE(S) FAILED: ${failedNames.join(", ")}`,
);
process.exit(failedNames.length === 0 ? 0 : 1);
