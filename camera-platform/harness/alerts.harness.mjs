/** Health alerts. The failures feared: a missing measurement shown as fine; one
 *  slow check raising an incident; a reboot raising every camera; a clock jump
 *  raising everything; a raised alert logged again every minute; raised alerts
 *  forgotten because the recorder stopped reporting. */
import { defaultThresholds, isReadableHealth, cameraObservations, diskObservations, observe, stepAlert, evaluateAlerts }
  from "../dist/alerts.js";
import { check, eq, same, report } from "./_assert.mjs";

console.log("alerts");

const T0 = Date.UTC(2026, 8, 14, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const S = 1000;
const M = 60 * S;
const GB = 1e9;
const TH = defaultThresholds(60);

function health(over = {}) {
  return {
    atUtc: iso(T0 - 10 * S),
    startedUtc: iso(T0 - 60 * M),
    cameraIds: ["cam-1", "cam-2"],
    storeRoots: ["/srv/camplat/disk0"],
    refusedRoots: [],
    disks: [{ root: "/srv/camplat/disk0", total: 1000 * GB, used: 800 * GB, free: 200 * GB, quarantine: { files: 0, bytes: 0 } }],
    lastSealedUtc: { "cam-1": iso(T0 - 50 * S), "cam-2": iso(T0 - 70 * S) },
    retentionRefused: null,
    ...over,
  };
}
const byKey = (list) => Object.fromEntries(list.map((o) => [o.key, o]));
/** Run evaluateAlerts over a series of [health, nowMs], carrying alerts forward. */
function run(series, previous = []) {
  let alerts = previous;
  const transitions = [];
  for (const [h, nowMs] of series) {
    const r = evaluateAlerts(h, alerts, iso(nowMs), TH);
    alerts = r.alerts;
    transitions.push(...r.transitions);
  }
  return { alerts, transitions, by: byKey(alerts) };
}

await check("thresholds carry their units and scale the silent window with the segment length", () => {
  same(defaultThresholds(60), { staleAfterMs: 90_000, cameraSilentAfterMs: 300_000, diskFullFraction: 0.92,
    quarantineLimitBytes: 1_000_000_000, clockAheadToleranceMs: 60_000, raiseAfterChecks: 2, clearAfterChecks: 2 }, "60 s segments");
  eq(defaultThresholds(300).cameraSilentAfterMs, 900_000, "300 s segments get 3 segments of silence");
});

await check("a health report is readable only when every field alerts rely on is there", () => {
  eq(isReadableHealth(health()), true, "the full report");
  for (const [what, h] of [["null", null], ["an array", []], ["a string", "{}"],
    ["bad atUtc", health({ atUtc: "yesterday" })], ["no startedUtc", health({ startedUtc: undefined })],
    ["cameraIds not strings", health({ cameraIds: [1] })], ["storeRoots missing", health({ storeRoots: undefined })],
    ["refusedRoots as objects", health({ refusedRoots: [{ root: "/x" }] })], ["disks without root", health({ disks: [{ total: 1 }] })],
    ["disks entry null", health({ disks: [null] })], ["lastSealedUtc an array", health({ lastSealedUtc: [] })],
    ["retentionRefused a number", health({ retentionRefused: 0 })]]) {
    eq(isReadableHealth(h), false, `refused: ${what}`);
  }
});

await check("THE FEARED ONE: a missing measurement is unknown, never ok", () => {
  const disk = byKey(diskObservations(health({ disks: [{ root: "/srv/camplat/disk0" }] }), TH));
  eq(disk["disk_filling:/srv/camplat/disk0"].condition, "unknown", "no sizes");
  eq(disk["disk_filling:/srv/camplat/disk0"].value, "not measured", "says so");
  eq(disk["quarantine_large:/srv/camplat/disk0"].condition, "unknown", "no quarantine figure");
  eq(disk["disk_missing:/srv/camplat/disk0"].condition, "ok", "but the drive answered");
  const zeroTotal = byKey(diskObservations(health({ disks: [{ root: "/srv/camplat/disk0", total: 0, used: 0, quarantine: null }] }), TH));
  eq(zeroTotal["disk_filling:/srv/camplat/disk0"].condition, "unknown", "a zero-size drive is not 0% used");
  const gone = byKey(diskObservations(health({ disks: [] }), TH));
  eq([gone["disk_missing:/srv/camplat/disk0"].condition, gone["disk_missing:/srv/camplat/disk0"].value],
    ["bad", "not measured: the drive did not answer"], "a drive that did not answer is missing, not fine");
  eq(gone["disk_filling:/srv/camplat/disk0"].condition, "unknown", "and its fill is unknown");
  const refused = byKey(diskObservations(health({ refusedRoots: ["/srv/camplat/disk0"] }), TH));
  eq([refused["disk_missing:/srv/camplat/disk0"].condition, refused["disk_missing:/srv/camplat/disk0"].value],
    ["bad", "refused at start"], "a refused root");
});

await check("disk and quarantine values read with their units, against their thresholds", () => {
  const d = (used, qBytes) => byKey(diskObservations(health({ disks: [{ root: "/r", total: 1000 * GB, used, quarantine: { files: 1, bytes: qBytes } }], storeRoots: ["/r"] }), TH));
  eq([d(920 * GB, 0)["disk_filling:/r"].condition, d(920 * GB, 0)["disk_filling:/r"].value], ["ok", "92.0% used"], "exactly at the line is not over it");
  eq([d(921 * GB, 0)["disk_filling:/r"].condition, d(921 * GB, 0)["disk_filling:/r"].value], ["bad", "92.1% used"], "over it");
  eq([d(1, 1_500_000_000)["quarantine_large:/r"].condition, d(1, 1_500_000_000)["quarantine_large:/r"].value], ["bad", "1500.0 MB in quarantine"], "quarantine over");
  eq(d(1, 0)["quarantine_large:/r"].value, "0.0 MB in quarantine", "an empty quarantine is a measured zero");
  eq(diskObservations(health({ storeRoots: ["/a", "/b"], disks: [{ root: "/a", total: 1, used: 0 }, { root: "/b", total: 1, used: 0 }] }), TH).map((o) => o.key),
    ["disk_missing:/a", "disk_filling:/a", "quarantine_large:/a", "disk_missing:/b", "disk_filling:/b", "quarantine_large:/b"], "order");
});

await check("THE FEARED ONE: a reboot does not raise every camera", () => {
  const justStarted = health({ startedUtc: iso(T0 - 30 * S), lastSealedUtc: { "cam-1": null } });
  const cams = byKey(cameraObservations(justStarted, T0, TH));
  eq([cams["camera_not_recording:cam-1"].condition, cams["camera_not_recording:cam-1"].value], ["unknown", "recorder started 30 s ago"], "null last seal");
  eq(cams["camera_not_recording:cam-2"].condition, "unknown", "no entry at all");
  // Even run through the whole evaluation many times inside the window, nothing is raised.
  const r = run([0, 1, 2, 3].map((i) => [health({ atUtc: iso(T0 + i * M - 5 * S), startedUtc: iso(T0 - 30 * S), lastSealedUtc: {} }), T0 + i * M]));
  eq(r.transitions.filter((t) => t.id === "camera_not_recording"), [], "no camera raised during the first 5 minutes");
  eq(r.by["camera_not_recording:cam-1"].state, "unknown", "still unknown");
});

await check("a silent camera is named, with how long, once the window has passed", () => {
  const h = health({ lastSealedUtc: { "cam-1": iso(T0 - 301 * S), "cam-2": null } });
  const cams = cameraObservations(h, T0, TH);
  eq(cams.map((o) => [o.key, o.condition, o.value]), [
    ["camera_not_recording:cam-1", "bad", "301 s since the last sealed segment"],
    ["camera_not_recording:cam-2", "bad", "no segment sealed in the 3600 s since the recorder started"],
  ], "both, in config order");
  eq(cameraObservations(health({ lastSealedUtc: { "cam-1": iso(T0 - 300 * S), "cam-2": iso(T0) } }), T0, TH).map((o) => o.condition), ["ok", "ok"], "the window's edge is ok");
});

await check("THE FEARED ONE: one slow check raises nothing; two in a row do", () => {
  const stale = health({ atUtc: iso(T0 - 91 * S) });
  const blip = run([[health(), T0], [stale, T0 + M], [health({ atUtc: iso(T0 + 2 * M - 5 * S) }), T0 + 2 * M]]);
  eq(blip.transitions, [], "a single stale report is not an incident");
  eq(blip.by["recorder_stale:recorder"].state, "clear", "and it is clear again");
  const twice = run([[health(), T0], [health({ atUtc: iso(T0 - 91 * S) }), T0], [health({ atUtc: iso(T0 - 91 * S) }), T0 + M]]);
  eq(twice.by["recorder_stale:recorder"].state, "raised", "two stale checks raise it");
  eq(twice.transitions.map((t) => [t.key, t.from, t.to, t.value]),
    [["recorder_stale:recorder", "clear", "raised", "151 s since the last health report"]], "logged once, with the measurement");
});

await check("THE FEARED ONE: a raised alert logs once across 100 checks, and clears only after two good ones", () => {
  const full = (nowMs, used) => [health({ atUtc: iso(nowMs - 5 * S), disks: [{ root: "/srv/camplat/disk0", total: 1000 * GB, used, quarantine: { files: 0, bytes: 0 } }],
    lastSealedUtc: { "cam-1": iso(nowMs - 5 * S), "cam-2": iso(nowMs - 5 * S) } }), nowMs];
  const series = [];
  for (let i = 0; i < 100; i++) series.push(full(T0 + i * M, 990 * GB));
  const r = run(series);
  eq(r.transitions.map((t) => [t.key, t.to]), [["disk_filling:/srv/camplat/disk0", "raised"]], "one transition in 100 checks");
  eq(r.by["disk_filling:/srv/camplat/disk0"].since, iso(T0 + M), "since the second bad check");
  eq(r.by["disk_filling:/srv/camplat/disk0"].value, "99.0% used", "value kept current");
  const oneGood = run([full(T0 + 100 * M, 500 * GB), full(T0 + 101 * M, 990 * GB)], r.alerts);
  eq(oneGood.by["disk_filling:/srv/camplat/disk0"].state, "raised", "good then bad: still raised");
  eq(oneGood.transitions, [], "and nothing logged");
  const cleared = run([full(T0 + 102 * M, 500 * GB), full(T0 + 103 * M, 500 * GB)], oneGood.alerts);
  eq(cleared.transitions.map((t) => [t.key, t.from, t.to]), [["disk_filling:/srv/camplat/disk0", "raised", "clear"]], "two good checks clear it, logged once");
});

await check("THE FEARED ONE: when the recorder stops reporting, nothing raised is forgotten or judged on stale data", () => {
  const silentCam = (nowMs) => [health({ atUtc: iso(nowMs - 5 * S), lastSealedUtc: { "cam-1": iso(T0 - 20 * M), "cam-2": iso(nowMs - 5 * S) } }), nowMs];
  const raised = run([silentCam(T0), silentCam(T0 + M)]);
  eq(raised.by["camera_not_recording:cam-1"].state, "raised", "setup: cam-1 raised");
  const frozen = health({ atUtc: iso(T0 + M - 5 * S), lastSealedUtc: { "cam-1": iso(T0 - 20 * M), "cam-2": iso(T0 + M - 5 * S) } });
  const later = run([[frozen, T0 + 5 * M], [frozen, T0 + 6 * M]], raised.alerts);
  eq(later.by["recorder_stale:recorder"].state, "raised", "the recorder is stale");
  eq(Object.keys(later.by).includes("camera_not_recording:cam-1"), true, "cam-1 is still listed");
  eq([later.by["camera_not_recording:cam-1"].state, later.by["camera_not_recording:cam-1"].value],
    ["unknown", "no current health report"], "as unknown, not clear and not judged on the old report");
  eq(later.by["disk_filling:/srv/camplat/disk0"].state, "unknown", "the disk too");
  const missing = run([[null, T0 + 7 * M]], later.alerts);
  eq([missing.by["recorder_stale:recorder"].state, missing.by["recorder_stale:recorder"].value], ["unknown", "no health report"], "no file at all");
  eq(Object.keys(missing.by).length, Object.keys(later.by).length, "nothing dropped");
  eq(evaluateAlerts({ junk: true }, [], iso(T0), TH).alerts.find((a) => a.key === "recorder_stale:recorder").value,
    "the health report is unreadable", "an unreadable report says so");
});

await check("THE FEARED ONE: a clock jump raises clock_suspect, not a pile of stale alerts", () => {
  const future = observe(health({ atUtc: iso(T0 + 10 * M) }), ["camera_not_recording:cam-1"], iso(T0), TH);
  eq(future.map((o) => [o.key, o.condition, o.value]), [
    ["clock_suspect:recorder", "bad", "the last health report is 600 s in the future"],
    ["recorder_stale:recorder", "unknown", "the box clock is suspect"],
    ["camera_not_recording:cam-1", "unknown", "no current health report"],
  ], "clock went backwards");
  const epoch = observe(health({ atUtc: iso(5 * S) }), [], iso(10 * S), TH);
  eq([epoch[0].condition, epoch[0].value], ["bad", "the box clock reads 1970-01-01T00:00:10.000Z"], "a box at epoch 0");
  eq(epoch[1].condition, "unknown", "judges nothing else");
  eq(observe(health({ atUtc: iso(T0 + 59 * S) }), [], iso(T0), TH)[0].condition, "ok", "a minute of skew is tolerated");
});

await check("keys hold colons in Windows roots, removed cameras are dropped, alerts are sorted", () => {
  const r = run([[health({ storeRoots: ["C:/camplat/disk0"], disks: [{ root: "C:/camplat/disk0", total: 10, used: 1 }] }), T0]]);
  const prev = r.alerts;
  const stale = observe(null, prev.map((a) => a.key), iso(T0), TH).find((o) => o.key === "disk_filling:C:/camplat/disk0");
  eq([stale.id, stale.subject], ["disk_filling", "C:/camplat/disk0"], "split at the first colon only");
  const fewer = run([[health({ cameraIds: ["cam-2"] }), T0 + M]], run([[health(), T0]]).alerts);
  eq(Object.keys(fewer.by).includes("camera_not_recording:cam-1"), false, "a camera that left the config is dropped");
  const keys = fewer.alerts.map((a) => a.key);
  eq(keys, [...keys].sort(), "sorted by key");
  eq(observe(health({ retentionRefused: "unmeasured cameras: cam-2" }), [], iso(T0), TH).find((o) => o.id === "retention_unknown").value,
    "unmeasured cameras: cam-2", "the refusal's own message");
});

await check("stepAlert: never seen, unknown, and a raised alert that goes unknown", () => {
  const obs = (condition) => ({ key: "k:x", id: "disk_filling", subject: "x", condition, value: "v" });
  const first = stepAlert(null, obs("ok"), iso(T0), TH);
  eq([first.record.state, first.record.since, first.transition], ["clear", iso(T0), null], "first ok is clear, quietly");
  const u = stepAlert(null, obs("unknown"), iso(T0), TH);
  eq([u.record.state, u.record.badStreak, u.record.goodStreak, u.transition], ["unknown", 0, 0, null], "first unknown");
  let rec = null;
  for (let i = 0; i < 2; i++) rec = stepAlert(rec, obs("bad"), iso(T0 + i * M), TH).record;
  const lost = stepAlert(rec, obs("unknown"), iso(T0 + 2 * M), TH);
  eq([lost.transition?.from, lost.transition?.to], ["raised", "unknown"], "losing sight of a raised alert is logged");
  eq(stepAlert(lost.record, obs("bad"), iso(T0 + 3 * M), TH).record.state, "unknown", "one bad after unknown does not re-raise yet");
});

report("alerts");
