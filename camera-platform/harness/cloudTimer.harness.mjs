/**
 * harness/cloudTimer.harness.mjs -- agent/camctl.mjs's `checkin` timer path
 * and the two units install.sh/upgrade.sh write for it (CLOUD-LINK-SPEC.md
 * section C; section E's "timer path" and "units" bullets exactly). The
 * contract itself (checkCloudSettings, the four states, the URL helpers) is
 * harness/cloudLink.harness.mjs's own job, not this file's.
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/cloudTimer.harness.mjs`.
 *
 * Every stateDir here is a fresh temp directory (build rule 21: harnesses
 * never touch real data unscoped); nothing is written under the real
 * appliance paths in agent/config.mjs, and nothing here ever reaches the
 * network -- runTimerCheckin's `fetchFn` is always a fake built in this file,
 * the same shape harness/checkin.harness.mjs and harness/cloudEnroll.harness.mjs
 * already use for sendCheckin()/enroll() directly. The device identity is
 * left to sendCheckin()'s own real default (agent/device-identity.mjs) --
 * deliberately NOT faked here, since that module only ever touches whatever
 * stateDir it is given, and a real box's own camplat-checkin.timer run uses
 * the real one too.
 *
 * THE FEARED FAILURES, by name (build rule 19):
 * - a checkin actually sent (fetchFn called at all) when cloud.json is
 *   missing, or holds enabled: false -- the box's default, off-by-default
 *   state (CLOUD-LINK-SPEC.md's own "Owner's rules that shape it").
 * - either of those "nothing to do" paths leaving process.exitCode set,
 *   which would make a oneshot unit "fail" on every box that has never
 *   turned the cloud link on -- burying the one log line that would matter.
 * - a real attempt's outcome -- sent OR failed -- never reaching
 *   checkin-last.json, so the System page's status view goes stale forever;
 *   or a FAILED attempt being swallowed silently (exitCode left at 0) rather
 *   than surfaced, which would hide a box that stopped reaching the cloud.
 * - cloud.json's url reaching sendCheckin() verbatim instead of through
 *   checkinUrlOf() -- posting to the box's own base address instead of
 *   .../checkin.
 * - a hand-edited or half-written cloud.json (bad JSON, or a shape
 *   checkCloudSettings itself refuses) read past instead of refused.
 * - install.sh or upgrade.sh's checkin timer drifting from the cloud's own
 *   CHECKIN_INTERVAL_MS (cloud/api/fleet.mjs, 60 000 ms) -- section C says
 *   they must agree; upgrade.sh installing no units at all, the exact gap
 *   CLOUD-LINK-SPEC.md section C calls out by name.
 */
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { check, eq, same, report } from "./_assert.mjs";
import { readCloudSettings, runTimerCheckin } from "../agent/camctl.mjs";

console.log("cloud timer");

const here = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), "camplat-cloud-timer-"));
let dirCounter = 0;
async function freshStateDir() {
  const dir = join(root, `state-${dirCounter++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** `body` is what fetchFn's `text()` returns -- a real HTTP client hands
 *  sendCheckin() the same, whatever the real cloud actually sent back. */
function fakeFetch(status, body = "", { calls = [] } = {}) {
  return { fn: async (url, opts) => { calls.push({ url, opts }); return { status, text: async () => body }; }, calls };
}

/** A fetchFn that fails the check immediately if it is ever called -- the
 *  shape every "nothing to do" test below uses to prove no request left the
 *  box at all, not merely that its outcome went unchecked. */
function fetchMustNotBeCalled() {
  return async () => { throw new Error("fetchFn must not be called: nothing should be sent"); };
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Runs `fn` (a call into runTimerCheckin) with process.exitCode reset
 *  beforehand and captured/reset afterward, so one check's simulated failure
 *  can never leak into this harness's own final exit status (report() below
 *  sets it from failures.length, and nothing else may touch it). */
async function withExitCode(fn) {
  const before = process.exitCode;
  process.exitCode = undefined;
  await fn();
  const seen = process.exitCode;
  process.exitCode = before;
  return seen;
}

const NOW = () => new Date("2026-09-28T12:00:00.000Z");

/* ── timer path: REQUIRED -- no cloud.json sends nothing, exits 0 ──────── */

await check("REQUIRED: no cloud.json at all -- sends nothing (fetchFn never called) and exits 0", async () => {
  const stateDir = await freshStateDir();
  const exitCode = await withExitCode(() => runTimerCheckin({ stateDir, fetchFn: fetchMustNotBeCalled(), now: NOW }));
  eq(exitCode, undefined, "no exit code set -- exit 0");
  eq(await readJsonOrNull(join(stateDir, "checkin-last.json")), null, "nothing written -- there was no attempt");
});

/* ── timer path: REQUIRED -- enabled: false sends nothing ──────────────── */

await check("REQUIRED: cloud.json present with enabled: false -- sends nothing and exits 0", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", enabled: false }));
  const exitCode = await withExitCode(() => runTimerCheckin({ stateDir, fetchFn: fetchMustNotBeCalled(), now: NOW }));
  eq(exitCode, undefined, "no exit code set -- exit 0");
  eq(await readJsonOrNull(join(stateDir, "checkin-last.json")), null, "nothing written -- there was no attempt");
});

await check("enabled: false with url: null (the written default) also sends nothing", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, "cloud.json"), JSON.stringify({ url: null, enabled: false }));
  const exitCode = await withExitCode(() => runTimerCheckin({ stateDir, fetchFn: fetchMustNotBeCalled(), now: NOW }));
  eq(exitCode, undefined);
});

/* ── timer path: REQUIRED -- a valid enabled URL sends, and writes checkin-last.json ── */

await check("REQUIRED: enabled true with a valid https URL -- sends (fake fetch) and writes checkin-last.json", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", enabled: true }));
  const { fn, calls } = fakeFetch(200, "");
  const exitCode = await withExitCode(() => runTimerCheckin({ stateDir, fetchFn: fn, now: NOW }));
  eq(calls.length, 1, "exactly one request went out");
  eq(exitCode, undefined, "outcome sent -- no exit code set");

  const last = await readJsonOrNull(join(stateDir, "checkin-last.json"));
  eq(typeof last?.seq, "number", "a seq was recorded");
  same(last, { seq: last?.seq, lastOutcome: "sent", lastAtUtc: "2026-09-28T12:00:00.000Z" });
});

await check("the request goes to the base address's own /checkin, via checkinUrlOf -- never the bare cloud.json url", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test/fleet/", enabled: true }));
  const { fn, calls } = fakeFetch(200, "");
  await withExitCode(() => runTimerCheckin({ stateDir, fetchFn: fn, now: NOW }));
  eq(calls.length, 1);
  eq(calls[0].url, "https://cloud.example.test/fleet/checkin", "one slash, joined by checkinUrlOf, never the raw stored address");
});

/* ── timer path: a failed attempt is still recorded and still surfaced ─── */

await check("a REJECTED check-in (cloud answers 4xx) still writes checkin-last.json with that outcome, and exits 1", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", enabled: true }));
  const { fn } = fakeFetch(401, "");
  const exitCode = await withExitCode(() => runTimerCheckin({ stateDir, fetchFn: fn, now: NOW }));
  eq(exitCode, 1, "a failed attempt is a failed unit run, not a quiet no-op");
  const last = await readJsonOrNull(join(stateDir, "checkin-last.json"));
  eq(last?.lastOutcome, "rejected", "the real outcome is recorded, not swallowed");
  eq(last?.lastAtUtc, "2026-09-28T12:00:00.000Z");
});

await check("a network failure (fetchFn rejects) still writes checkin-last.json, never left as the previous stale record silently", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", enabled: true }));
  const failing = async () => { throw new Error("ECONNREFUSED (fake)"); };
  const exitCode = await withExitCode(() => runTimerCheckin({ stateDir, fetchFn: failing, now: NOW }));
  eq(exitCode, 1);
  const last = await readJsonOrNull(join(stateDir, "checkin-last.json"));
  eq(last?.lastOutcome, "network_error");
});

/* ── the contract gate: a hand-edited or half-written cloud.json is refused, never guessed past ── */

await check("readCloudSettings: no file at all reads as the default (off, no address), not an error", async () => {
  const stateDir = await freshStateDir();
  const r = await readCloudSettings(stateDir);
  same(r, { kind: "ok", settings: { url: null, enabled: false } });
});

await check("readCloudSettings: invalid JSON is refused as corrupt, not guessed past", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, "cloud.json"), "{ not json");
  const r = await readCloudSettings(stateDir);
  eq(r.kind, "corrupt");
});

await check("readCloudSettings: a shape checkCloudSettings itself refuses (http://) is refused here too -- the SAME contract, not a looser local copy", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, "cloud.json"), JSON.stringify({ url: "http://cloud.example.test", enabled: true }));
  const r = await readCloudSettings(stateDir);
  eq(r.kind, "corrupt");
  eq(r.reason.includes("bad_url"), true, r.reason);
});

await check("runTimerCheckin on a corrupt cloud.json: Refused, exit 1, fetchFn never called", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, "cloud.json"), "not json at all");
  const exitCode = await withExitCode(() => runTimerCheckin({ stateDir, fetchFn: fetchMustNotBeCalled(), now: NOW }));
  eq(exitCode, 1);
});

/* ------------------------------------------------------------------------ *
 * units: install.sh and upgrade.sh both write camplat-checkin.service and
 * camplat-checkin.timer, with the 60 s interval the cloud's own
 * CHECKIN_INTERVAL_MS agrees with (CLOUD-LINK-SPEC.md section C), and
 * upgrade.sh enables the timer -- the exact gap the spec calls out: "upgrade.sh
 * today installs no units, so without this a box already in the field would
 * never get the timer."
 * ------------------------------------------------------------------------ */
console.log("\ncloud timer units");

/** The text between `cat > /etc/systemd/system/<unit> <<UNIT` and the next
 *  bare `UNIT` line -- a plain text slice, not a systemd parser: section E
 *  calls this "a text check", and every other setup-script check in this
 *  codebase (harness/service.harness.mjs) reads these files the same way. */
function unitBlock(scriptText, unitFile) {
  const re = new RegExp(`cat > /etc/systemd/system/${unitFile.replace(/\./g, "\\.")} <<UNIT\\n([\\s\\S]*?)\\nUNIT\\b`);
  const m = re.exec(scriptText);
  return m ? m[1] : null;
}

const installSh = readFileSync(join(here, "..", "setup", "install.sh"), "utf8");
const upgradeSh = readFileSync(join(here, "..", "setup", "upgrade.sh"), "utf8");

for (const [name, text] of [["install.sh", installSh], ["upgrade.sh", upgradeSh]]) {
  await check(`REQUIRED: ${name} writes camplat-checkin.service, oneshot, running camctl checkin with no --url`, () => {
    const block = unitBlock(text, "camplat-checkin.service");
    eq(block !== null, true, `${name} has no camplat-checkin.service unit`);
    eq(block.includes("Type=oneshot"), true, name);
    eq(/ExecStart=\S+\s+\S*agent\/camctl\.mjs checkin\s*$/m.test(block), true, `${name}: ExecStart must run checkin with no --url`);
    eq(block.includes("--url"), false, `${name}: the timer's own service must never pass --url`);
  });

  await check(`REQUIRED: ${name} writes camplat-checkin.timer at the 60 s interval the cloud agrees with`, () => {
    const block = unitBlock(text, "camplat-checkin.timer");
    eq(block !== null, true, `${name} has no camplat-checkin.timer unit`);
    eq(block.includes("OnBootSec=2min"), true, name);
    eq(block.includes("OnUnitActiveSec=60s"), true, `${name}: must match cloud/api/fleet.mjs's CHECKIN_INTERVAL_MS (60 000 ms)`);
    eq(block.includes("AccuracySec=5s"), true, name);
    eq(block.includes("WantedBy=timers.target"), true, `${name}: the timer needs its own [Install] section to be enable-able`);
  });
}

await check("REQUIRED: upgrade.sh enables camplat-checkin.timer -- the gap the spec names: upgrade.sh used to install no units at all", () => {
  eq(/systemctl enable(?:\s+--now)?\s+[^\n]*\bcamplat-checkin\.timer\b/.test(upgradeSh), true,
    "upgrade.sh never enables camplat-checkin.timer");
});

await check("install.sh enables camplat-checkin.timer too, alongside the other units it has always enabled", () => {
  eq(/systemctl enable\s+[^\n]*\bcamplat-checkin\.timer\b/.test(installSh), true,
    "install.sh's enable line does not include camplat-checkin.timer");
});

await check("neither script's checkin unit block references a camera credential file (config.json is fine; cameras.json/camera.secret are not)", () => {
  for (const [name, text] of [["install.sh", installSh], ["upgrade.sh", upgradeSh]]) {
    const svc = unitBlock(text, "camplat-checkin.service") ?? "";
    eq(svc.includes("cameras.json"), false, name);
    eq(svc.includes("camera.secret"), false, name);
  }
});

report("cloud timer (timer path + units)");
