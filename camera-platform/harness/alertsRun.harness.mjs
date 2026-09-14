/** The alerts check as a process. The failures feared: a half-written or corrupt
 *  file crashing it, so alerts silently stop updating; one bad record throwing
 *  away every raised alert; the recorder restarted every minute while stale. */
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readHealth, isAlertRecord, readPreviousAlerts, runAlertsCheck, shouldRestartRecorder, transitionLogLine }
  from "../agent/alerts-run.mjs";
import { defaultThresholds } from "../dist/alerts.js";
import { check, eq, report } from "./_assert.mjs";

console.log("alerts run");

const TH = defaultThresholds(60);
const T0 = Date.parse("2026-09-14T12:00:00.000Z");
const at = (ms) => () => new Date(ms);
const dirs = [];
const fresh = async () => { const d = await mkdtemp(path.join(tmpdir(), "camplat-alerts-")); dirs.push(d); return d; };
const record = (over = {}) => ({ key: "disk_filling:/d0", id: "disk_filling", subject: "/d0", state: "raised",
  since: "2026-09-14T11:00:00.000Z", badStreak: 5, goodStreak: 0, value: "95.0% used", ...over });
const health = (atMs) => ({ atUtc: new Date(atMs).toISOString(), startedUtc: new Date(T0 - 3600_000).toISOString(),
  cameraIds: [], storeRoots: [], refusedRoots: [], disks: [], lastSealedUtc: {}, retentionRefused: null });
const byKey = (alerts) => Object.fromEntries(alerts.map((a) => [a.key, a]));

try {
  await check("readHealth: missing is null, corrupt or unreadable says so, and nothing throws", async () => {
    const d = await fresh();
    eq(await readHealth(path.join(d, "health.json")), null, "missing");
    await writeFile(path.join(d, "health.json"), '{"atUtc": "2026-09');
    const half = await readHealth(path.join(d, "health.json"));
    eq(typeof half?.unreadable, "string", "half a file is unreadable, not missing");
    await writeFile(path.join(d, "health.json"), JSON.stringify({ a: 1 }));
    eq(await readHealth(path.join(d, "health.json")), { a: 1 }, "parsed as it is");
    const asDir = path.join(d, "dir.json");
    await mkdir(asDir);
    eq(typeof (await readHealth(asDir))?.unreadable, "string", "a read failure other than absence");
  });

  await check("isAlertRecord accepts a record and nothing short of one", () => {
    eq(isAlertRecord(record()), true, "a record");
    for (const [what, r] of [["null", null], ["array", []], ["bad state", record({ state: "firing" })],
      ["negative streak", record({ badStreak: -1 })], ["fractional streak", record({ goodStreak: 0.5 })],
      ["streak as text", record({ badStreak: "2" })], ["no since", record({ since: undefined })], ["value a number", record({ value: 95 })]]) {
      eq(isAlertRecord(r), false, what);
    }
  });

  await check("THE FEARED ONE: one bad record does not throw away the raised alerts beside it", async () => {
    const d = await fresh();
    const file = path.join(d, "alerts.json");
    await writeFile(file, JSON.stringify({ checkedUtc: "x", alerts: [record(), { key: "junk" }, record({ key: "disk_filling:/d1", subject: "/d1" })] }));
    const r = await readPreviousAlerts(file);
    eq(r.records.map((x) => x.key), ["disk_filling:/d0", "disk_filling:/d1"], "both good records kept");
    eq(r.discarded, ["alerts.json entry 1 is not an alert record"], "the bad one named");
    eq(await readPreviousAlerts(path.join(d, "none.json")), { records: [], discarded: [] }, "missing is a first run");
    await writeFile(file, "{ half");
    const corrupt = await readPreviousAlerts(file);
    eq([corrupt.records, corrupt.discarded.length, corrupt.discarded[0].startsWith("alerts.json is not JSON: ")], [[], 1, true], "corrupt");
    await writeFile(file, JSON.stringify([record()]));
    eq(await readPreviousAlerts(file), { records: [], discarded: ["alerts.json has no alerts list"] }, "wrong shape");
  });

  await check("THE FEARED ONE: corrupt files never stop the check; it still writes alerts.json", async () => {
    const d = await fresh();
    await writeFile(path.join(d, "health.json"), "{ half");
    await writeFile(path.join(d, "alerts.json"), "also { half");
    const r = await runAlertsCheck({ stateDir: d, thresholds: TH, now: at(T0) });
    eq(byKey(r.alerts)["recorder_stale:recorder"]?.value, "the health report is unreadable", "says why");
    eq(r.discarded.length, 1, "the discarded alerts file is reported");
    const written = JSON.parse(await readFile(path.join(d, "alerts.json"), "utf8"));
    eq(written.checkedUtc, "2026-09-14T12:00:00.000Z", "checkedUtc, so a reader can tell the check itself stopped");
    eq(written.alerts, r.alerts, "the same alerts");
    eq(existsSync(path.join(d, "alerts.json.tmp")), false, "no half-written file left");
    const none = await runAlertsCheck({ stateDir: await fresh(), thresholds: TH, now: at(T0) });
    eq(byKey(none.alerts)["recorder_stale:recorder"]?.value, "no health report", "no health file at all");
  });

  await check("streaks survive between runs: a recorder stale on two timer runs is raised once", async () => {
    const d = await fresh();
    await writeFile(path.join(d, "health.json"), JSON.stringify(health(T0 - 200_000)));
    const first = await runAlertsCheck({ stateDir: d, thresholds: TH, now: at(T0) });
    eq(first.transitions, [], "first stale check");
    const second = await runAlertsCheck({ stateDir: d, thresholds: TH, now: at(T0 + 60_000) });
    eq(second.transitions.map((t) => [t.key, t.to]), [["recorder_stale:recorder", "raised"]], "raised on the second");
    eq(shouldRestartRecorder(second.transitions), true, "restart on raising");
    const third = await runAlertsCheck({ stateDir: d, thresholds: TH, now: at(T0 + 120_000) });
    eq([third.transitions, shouldRestartRecorder(third.transitions)], [[], false], "THE FEARED ONE: no restart again while it stays raised");
  });

  await check("shouldRestartRecorder only for recorder_stale going into raised", () => {
    const t = (id, from, to) => ({ key: `${id}:recorder`, id, subject: "recorder", from, to, atUtc: "x", value: "v" });
    eq(shouldRestartRecorder([]), false, "nothing");
    eq(shouldRestartRecorder([t("recorder_stale", "raised", "clear")]), false, "clearing");
    eq(shouldRestartRecorder([t("recorder_stale", "raised", "unknown")]), false, "going unknown (the clock is suspect)");
    eq(shouldRestartRecorder([t("disk_filling", "clear", "raised")]), false, "another alert");
    eq(shouldRestartRecorder([t("disk_filling", "clear", "raised"), t("recorder_stale", "unknown", "raised")]), true, "among others");
  });

  await check("transition log lines are one JSON line each, warning when raised or lost", () => {
    const t = { key: "disk_filling:/d0", id: "disk_filling", subject: "/d0", from: "clear", to: "raised", atUtc: "2026-09-14T12:00:00.000Z", value: "95.0% used" };
    const line = transitionLogLine(t);
    eq(line.includes("\n"), false, "one line");
    eq(JSON.parse(line), { level: "warn", msg: "alert raised", key: "disk_filling:/d0", from: "clear", to: "raised", value: "95.0% used", atUtc: "2026-09-14T12:00:00.000Z" }, "fields");
    eq(JSON.parse(transitionLogLine({ ...t, from: "raised", to: "unknown" })).level, "warn", "losing sight of a raised alert warns");
    eq(JSON.parse(transitionLogLine({ ...t, from: "raised", to: "clear" })).level, "info", "clearing is info");
  });
} finally {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}

report("alerts run");
