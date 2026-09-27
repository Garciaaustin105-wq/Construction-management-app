/**
 * Manager rules end to end through the real server: GET/POST /areas,
 * GET /areas/list, GET/POST /rules, GET /rule-templates, GET /reports,
 * GET/POST /open-hours (MANAGER-RULES-SPEC.md sections 1, 3, 4, 5), plus the
 * managerRules feature switch (404 feature_off), the role matrix (manager
 * 200 on rules/reports/open-hours, 403 elsewhere; a display 403 on all of
 * it), and the evaluator's own wiring (a rule fires once occupancy.db has a
 * transition, and a firing keeps the name its rule had when it fired).
 *
 * THE FEARED FAILURES, by name:
 * - the switch defaulting anything but off, or a route answering normally
 *   while it is off;
 * - a manager reaching /areas (drawing) or a store/display reaching
 *   anything hours.manage/rules.manage gates;
 * - a rule saved with when: "open_hours" while the site has no openHours,
 *   and that refusal not naming "hours_not_set";
 * - a firing's own text changing after its rule is renamed;
 * - a camera credential, URL, or a person's name anywhere in any response,
 *   the audit log, or rules.json/areas.json on disk.
 */
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { indexPathFor } from "../agent/config.mjs";
import { openOccupancyDb } from "../agent/occupancy-db.mjs";
import { wholeCameraAreaId } from "../dist/managerRules.js";
import { check, eq, same, report } from "./_assert.mjs";

console.log("manager rules API");

const CAM_PW = "manager-rules-s3cret";
const audits = [];
const authAs = (principal) => ({
  principalOf: () => principal,
  handle: async () => false,
  audit: (event, _req, fields) => audits.push({ event, ...fields }),
});
const installer = authAs({ kind: "user", username: "tech", role: "installer" });
const manager = authAs({ kind: "user", username: "regional", role: "manager" });
const store = authAs({ kind: "user", username: "clerk", role: "store" });
const display = authAs({ kind: "display", displayId: "wall-1" });

const stateDir = await mkdtemp(join(tmpdir(), "camplat-mgrrules-"));
const config = {
  siteId: "bench",
  storeRoots: [join(stateDir, "disk0")],
  credentials: { username: "svc", password: "svc-pw" },
  cameras: [{ cameraId: "cam-1", name: "Front Desk", url: `rtsp://admin:${CAM_PW}@10.0.0.5:554/main` }],
};
await writeFile(join(stateDir, "config.json"), JSON.stringify(config));

const index = openIndex(indexPathFor(stateDir));
// Both background timers are pushed out to "never, in this test's lifetime":
// the main `server` here proves the ROUTES, not the evaluator's own timing
// (fastServer, below, and the dedicated idle/firing checks own that) -- this
// keeps its lazy occupancy.db/rules.db handles from racing this file's own
// close-and-delete cleanup at the very end.
const NEVER_MS = 10 * 60_000;
const startServer = (auth, overrides = {}) => createApiServer({
  stateDir, config, index, auth, eventRetentionIntervalMs: NEVER_MS, managerRulesIntervalMs: NEVER_MS, ...overrides,
});
let server = startServer(installer);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let base = `http://127.0.0.1:${server.address().port}`;

const send = async (method, path, body, srv = server) => {
  const b = srv === server ? base : `http://127.0.0.1:${srv.address().port}`;
  const res = await fetch(b + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, text, json };
};
const noSecrets = (text, what) => {
  if (text.includes(CAM_PW) || /rtsp:\/\//i.test(text)) throw new Error(`${what} carries a camera credential or address: ${text}`);
};

const MANAGER_ROUTES = ["/areas", "/areas/list", "/rules", "/rule-templates", "/reports?day=2026-09-26"];

try {
  await check("REQUIRED: managerRules is off by default -- every manager-rules route answers 404 feature_off", async () => {
    for (const path of MANAGER_ROUTES) {
      const r = await send("GET", path);
      eq(r.status, 404, path);
      eq(r.json.code, "feature_off", path);
    }
  });

  await check("/open-hours is NOT gated by the managerRules switch -- it is plain site data either way", async () => {
    const r = await send("GET", "/open-hours");
    eq(r.status, 200);
    eq(r.json.openHours, null, "not set yet");
  });

  await check("REQUIRED: a rule using open_hours while openHours is unset is refused, naming hours_not_set", async () => {
    // Turn the switch on first (a fresh POST /site-settings body only ever
    // names managerRules directly here -- no site type needed for this check).
    const on = await send("POST", "/site-settings", { features: { managerRules: true } });
    eq(on.status, 200);
    eq(on.json.settings.features.managerRules, true);

    const r = await send("POST", "/rules", {
      name: "Manager's desk unattended", enabled: true, template: "desk_unattended",
      cameraId: "cam-1", areaId: null, kind: "person",
      condition: { type: "absent_longer_than", minutes: 20 }, when: "open_hours",
      notify: { alert: true, report: true, cooldownMinutes: 0 },
    });
    eq(r.status, 400);
    eq(r.json.errors.some((e) => e.field === "when" && e.reason === "hours_not_set"), true, JSON.stringify(r.json.errors));
  });

  await check("POST /open-hours sets the schedule; GET reflects it, and a later /site-settings save never touches it", async () => {
    const schedule = { timeZone: "America/Chicago", weekly: [[], [{ open: 480, close: 1080 }], [{ open: 480, close: 1080 }], [{ open: 480, close: 1080 }], [{ open: 480, close: 1080 }], [{ open: 480, close: 1080 }], []], closedDates: [] };
    const r = await send("POST", "/open-hours", { openHours: schedule });
    eq(r.status, 200);
    same(r.json.openHours, schedule);
    eq((await send("GET", "/open-hours")).json.openHours !== null, true);

    // An installer saving displayName through /site-settings (which never
    // mentions openHours in its body) must not clear it. Full-replace
    // convention (the same one /site-settings already keeps for `features`):
    // this save names every feature switch it wants kept, managerRules
    // included, the way a real Site-section form would submit its own
    // current state rather than a partial patch.
    // Also sets the site's own zone to the SAME zone the schedule above uses
    // -- "in the site tz" (MANAGER-RULES-SPEC.md section 5) means the site's
    // own effective zone, and a real installer sets both together the same
    // way camera-ai schedules already do ("new schedules use the site zone").
    const saved = await send("POST", "/site-settings", { displayName: "Bench", timeZone: "America/Chicago", features: { managerRules: true } });
    eq(saved.status, 200);
    eq(saved.json.settings.features.managerRules, true, "still on: this save named it explicitly");
    eq((await send("GET", "/open-hours")).json.openHours !== null, true, "openHours survives an unrelated /site-settings save");
  });

  let areaId;
  await check("installer draws an area (POST /areas); GET /areas lists it with its polygon", async () => {
    const r = await send("POST", "/areas", { cameraId: "cam-1", name: "Manager's desk", points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] });
    eq(r.status, 200, r.text);
    eq(r.json.area.cameraId, "cam-1");
    areaId = r.json.area.id;
    const list = await send("GET", "/areas");
    eq(list.json.areas.length, 1);
    eq(list.json.areas[0].points.length, 4);
  });

  await check("GET /areas/list (the manager's reduced, READ-ONLY view): name, camera AND the polygon -- the Rules page's own outlined still needs it, and this route grants no way to move it", async () => {
    const r = await send("GET", "/areas/list", undefined, server);
    eq(r.status, 200);
    same(r.json.areas, [{
      id: areaId, cameraId: "cam-1", cameraName: "Front Desk", name: "Manager's desk",
      points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]],
    }]);
  });

  let ruleId;
  await check("POST /rules now succeeds (openHours is set); GET /rule-templates lists 10, desk_unattended first", async () => {
    const r = await send("POST", "/rules", {
      name: "Manager's desk unattended", enabled: true, template: "desk_unattended",
      cameraId: "cam-1", areaId, kind: "person",
      condition: { type: "absent_longer_than", minutes: 20 }, when: "open_hours",
      notify: { alert: true, report: true, cooldownMinutes: 0 },
    });
    eq(r.status, 200, r.text);
    ruleId = r.json.rule.id;
    eq(r.json.rule.createdBy, "tech");

    const templates = await send("GET", "/rule-templates");
    eq(templates.json.templates.length, 10);
    eq(templates.json.templates[0].template, "desk_unattended");
    eq(templates.json.templates[0].label, "Manager's desk unattended");
  });

  await check("REQUIRED: an area on the wrong camera, or a camera that does not exist, is refused", async () => {
    const badCamera = await send("POST", "/rules", {
      name: "x", enabled: true, template: "custom", cameraId: "no-such-cam", areaId: null, kind: "person",
      condition: { type: "enters" }, when: "always", notify: { alert: false, report: true, cooldownMinutes: 0 },
    });
    eq(badCamera.status, 404);
    eq(badCamera.json.code, "no_such_camera");

    const badArea = await send("POST", "/areas", { cameraId: "no-such-cam", name: "x", points: [[0, 0], [1, 0], [1, 1], [0, 1]] });
    eq(badArea.status, 404);
    eq(badArea.json.code, "no_such_camera");
  });

  // ---------------------------------------------------------------- roles

  await check("REQUIRED: a manager gets 200 on rules, templates, reports and open-hours; 403 on areas, cameras and site settings", async () => {
    const openHoursBefore = (await send("GET", "/open-hours")).json.openHours;
    const s = startServer(manager);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    try {
      eq((await send("GET", "/rules", undefined, s)).status, 200, "manager: rules");
      eq((await send("GET", "/rule-templates", undefined, s)).status, 200, "manager: templates");
      eq((await send("GET", "/reports?day=2026-09-26", undefined, s)).status, 200, "manager: reports");
      eq((await send("GET", "/open-hours", undefined, s)).status, 200, "manager: reads open hours");
      eq((await send("POST", "/open-hours", { openHours: null }, s)).status, 200, "manager: may edit open hours");
      eq((await send("GET", "/areas", undefined, s)).status, 403, "manager: never the polygon editor");
      eq((await send("POST", "/areas", { cameraId: "cam-1", name: "x", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, s)).status, 403, "manager: cannot draw");
      eq((await send("GET", "/site-settings", undefined, s)).status, 403, "manager: not the rest of the Site section");
      eq((await send("POST", "/cameras", {}, s)).status, 403, "manager: not camera.manage");
      // Restore the schedule this check's own manager-edit cleared.
      await send("POST", "/open-hours", { openHours: openHoursBefore }, server);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  await check("a store account: 200 on reports (spec section 5 names it explicitly), 403 on rules/areas/open-hours", async () => {
    const s = startServer(store);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    try {
      eq((await send("GET", "/reports?day=2026-09-26", undefined, s)).status, 200, "store: reports");
      eq((await send("GET", "/rules", undefined, s)).status, 403, "store: not rules.manage");
      eq((await send("GET", "/areas", undefined, s)).status, 403, "store: not camera.manage");
      eq((await send("GET", "/open-hours", undefined, s)).status, 403, "store: not hours.manage");
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  await check("FEARED: a display is refused on every one of these routes, including reports", async () => {
    const s = startServer(display);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    try {
      for (const path of [...MANAGER_ROUTES, "/open-hours"]) {
        eq((await send("GET", path, undefined, s)).status, 403, `display: ${path}`);
      }
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  // ---------------------------------------------------------------- feature off again: nothing lingers

  await check("REQUIRED: switching managerRules back off 404s every route again, rules/areas already on file notwithstanding", async () => {
    const off = await send("POST", "/site-settings", { features: { managerRules: false } });
    eq(off.status, 200);
    for (const path of MANAGER_ROUTES) {
      eq((await send("GET", path)).status, 404, path);
    }
    // Turn it back on for the evaluator checks below -- full-replace, so the
    // zone set earlier is named again rather than silently reset to null.
    await send("POST", "/site-settings", { timeZone: "America/Chicago", features: { managerRules: true } });
  });

  // ---------------------------------------------------------------- the evaluator, wired through the real server

  await check("REQUIRED: the evaluator is idle while the switch is off -- rules.db is never even created", async () => {
    const idleStateDir = await mkdtemp(join(tmpdir(), "camplat-mgrrules-idle-"));
    const idleIndex = openIndex(indexPathFor(idleStateDir));
    await writeFile(join(idleStateDir, "config.json"), JSON.stringify(config));
    // Seed occupancy.db directly, as detect-service would -- proving the
    // evaluator itself (not merely "no rules") is what stays idle.
    const occ = openOccupancyDb(join(idleStateDir, "occupancy.db"));
    occ.insert({ areaId: "some-area", cameraId: "cam-1", kind: "person", state: "absent", atMs: Date.parse("2026-09-26T12:00:00Z") });
    occ.close();
    const s = createApiServer({ stateDir: idleStateDir, config, index: idleIndex, auth: installer, managerRulesIntervalMs: 20 });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    try {
      await new Promise((r) => setTimeout(r, 200));
      const names = await import("node:fs/promises").then((fs) => fs.readdir(idleStateDir));
      eq(names.includes("rules.db"), false, "the switch was never turned on: no evaluator write, ever");
    } finally {
      s.closeManagerRulesEvaluator();
      s.closeEventRetention();
      s.closeOccupancy();
      s.closeRules();
      await new Promise((r) => s.close(r));
      idleIndex.close();
      await rm(idleStateDir, { recursive: true, force: true });
    }
  });

  // T0: a Monday 09:00 America/Chicago (well within the schedule's open_hours
  // above) — fixed in the past relative to the real calendar, and the
  // evaluator's own clock is pinned to just after it below, so this check
  // never depends on what day it actually is when the suite runs.
  const T0 = Date.parse("2026-09-28T14:00:00Z"); // Monday 09:00 CDT
  const reportDay = "2026-09-28";
  await check("REQUIRED: a real occupancy transition produces a firing, appearing on GET /reports for that local day", async () => {
    const fastServer = startServer(installer, { managerRulesIntervalMs: 20, now: () => new Date(T0 + 30 * 60_000) });
    await new Promise((r) => fastServer.listen(0, "127.0.0.1", r));
    try {
      const occ = openOccupancyDb(join(stateDir, "occupancy.db"));
      occ.insert({ areaId, cameraId: "cam-1", kind: "person", state: "present", atMs: T0 });
      occ.insert({ areaId, cameraId: "cam-1", kind: "person", state: "absent", atMs: T0 + 60_000 });
      // absent_longer_than 20 minutes -> crosses at T0 + 60_000 + 20*60_000.
      occ.close();

      const day = "2026-09-28";
      let report = null;
      for (let i = 0; i < 100; i += 1) {
        await new Promise((r) => setTimeout(r, 30));
        const r = await send("GET", `/reports?day=${day}`, undefined, fastServer);
        if (r.json.groups.some((g) => g.firings.length > 0)) { report = r.json; break; }
      }
      if (report === null) throw new Error("no firing appeared within the poll window");
      eq(report.timeZone, "America/Chicago");
      const group = report.groups.find((g) => g.ruleId === ruleId);
      eq(group !== undefined, true, "the rule that was set up above");
      eq(group.firings.length, 1, "exactly one firing, not the FEARED >= 1 that a duplicate slips past");
      eq(group.firings[0].what, "absent_longer_than");
      eq(group.firings[0].text.includes("Manager's desk unattended"), true, group.firings[0].text);
      eq(/[0-9]{1,2}:[0-9]{2}/.test(group.firings[0].text), true, "a clock label, identity-free");

      // FEARED: the underlying occupancy transitions never change again, but
      // the real evaluator keeps ticking every 20ms — this rule's own
      // template ships with cooldownMinutes: 0, so without the "already
      // recorded" gate this same firing would be re-derived and re-inserted
      // on every subsequent tick. Wait out many more ticks and confirm the
      // report still shows exactly one line for it.
      await new Promise((r) => setTimeout(r, 400));
      const after = await send("GET", `/reports?day=${day}`, undefined, fastServer);
      const groupAfter = after.json.groups.find((g) => g.ruleId === ruleId);
      eq(groupAfter.firings.length, 1, "no duplicate accumulated over further evaluator ticks");
    } finally {
      fastServer.closeManagerRulesEvaluator();
      // Let a tick already in flight at the instant of clearInterval finish
      // (the same discipline apiServer.harness.mjs's own retention-wiring
      // check keeps) before closing the db handles it might still be using.
      await new Promise((r) => setTimeout(r, 100));
      fastServer.closeOccupancy();
      fastServer.closeRules();
      await new Promise((r) => fastServer.close(r));
    }
  });

  await check("FEARED: renaming the rule never changes a firing's own already-produced text (build rule 7)", async () => {
    const before = await send("GET", "/reports?day=2026-09-28");
    const beforeText = before.json.groups.find((g) => g.ruleId === ruleId).firings[0].text;
    eq(beforeText.includes("Manager's desk unattended"), true);

    const renamed = await send("POST", "/rules", {
      id: ruleId, name: "Front desk empty too long", enabled: false, template: "desk_unattended",
      cameraId: "cam-1", areaId, kind: "person",
      condition: { type: "absent_longer_than", minutes: 20 }, when: "open_hours",
      notify: { alert: true, report: true, cooldownMinutes: 0 },
    });
    eq(renamed.status, 200);
    eq(renamed.json.rule.name, "Front desk empty too long");

    const after = await send("GET", "/reports?day=2026-09-28");
    const afterText = after.json.groups.find((g) => g.ruleId === ruleId).firings[0].text;
    eq(afterText, beforeText, "THE FEARED ONE: the OLD firing's text must not change just because the rule was renamed");
    eq(afterText.includes("Manager's desk unattended"), true, "still the name it had when it fired");
  });

  // ---------------------------------------------------------------- build gap 1: whole-camera rules

  await check("REQUIRED: \"Person after hours\" (a whole-camera rule, areaId: null) fires for an enter while closed, and NOT for an enter while open", async () => {
    const created = await send("POST", "/rules", {
      name: "Person after hours", enabled: true, template: "after_hours_person",
      cameraId: "cam-1", areaId: null, kind: "person",
      condition: { type: "enters" }, when: "closed_hours",
      notify: { alert: true, report: true, cooldownMinutes: 0 },
    });
    eq(created.status, 200, created.text);
    const afterHoursRuleId = created.json.rule.id;

    // T0 (defined above) is 2026-09-28 09:00 America/Chicago -- inside the
    // 08:00-18:00 open_hours schedule set earlier. T_CLOSED is 01:00 the
    // same day -- well outside it.
    const T_CLOSED = Date.parse("2026-09-28T06:00:00Z"); // 01:00 CDT: closed
    const wholeAreaId = wholeCameraAreaId("cam-1");
    const occ = openOccupancyDb(join(stateDir, "occupancy.db"));
    occ.insert({ areaId: wholeAreaId, cameraId: "cam-1", kind: "person", state: "absent", atMs: T_CLOSED - 20_000 });
    occ.insert({ areaId: wholeAreaId, cameraId: "cam-1", kind: "person", state: "present", atMs: T_CLOSED }); // enters while CLOSED -> must fire
    occ.insert({ areaId: wholeAreaId, cameraId: "cam-1", kind: "person", state: "absent", atMs: T_CLOSED + 100_000 });
    occ.insert({ areaId: wholeAreaId, cameraId: "cam-1", kind: "person", state: "present", atMs: T0 }); // enters while OPEN -> must NOT fire
    occ.close();

    const fastServer = startServer(installer, { managerRulesIntervalMs: 20, now: () => new Date(T0 + 60_000) });
    await new Promise((r) => fastServer.listen(0, "127.0.0.1", r));
    try {
      const day = "2026-09-28";
      let group = null;
      for (let i = 0; i < 100; i += 1) {
        await new Promise((r) => setTimeout(r, 30));
        const r = await send("GET", `/reports?day=${day}`, undefined, fastServer);
        const g = r.json.groups.find((x) => x.ruleId === afterHoursRuleId);
        if (g && g.firings.length > 0) { group = g; break; }
      }
      if (group === null) throw new Error("Person after hours never fired for the closed-hours enter");
      eq(group.firings.length, 1, "exactly the closed-hours enter -- the open-hours one must never fire");
      eq(group.firings[0].what, "enters");

      // Give the evaluator several more ticks: the open-hours transition
      // must never turn into a second, later firing either.
      await new Promise((r) => setTimeout(r, 200));
      const after = await send("GET", `/reports?day=${day}`, undefined, fastServer);
      const groupAfter = after.json.groups.find((x) => x.ruleId === afterHoursRuleId);
      eq(groupAfter.firings.length, 1, "still just the one -- the open-hours enter stays gated out forever, not just on the first tick");
    } finally {
      fastServer.closeManagerRulesEvaluator();
      await new Promise((r) => setTimeout(r, 100));
      fastServer.closeOccupancy();
      fastServer.closeRules();
      await new Promise((r) => fastServer.close(r));
    }
  });

  await check("REQUIRED: a whole-camera not_watching never produces enters or leaves", async () => {
    const created = await send("POST", "/rules", {
      name: "Vehicle arrives (whole camera)", enabled: true, template: "vehicle_arrives",
      cameraId: "cam-1", areaId: null, kind: "vehicle",
      condition: { type: "enters" }, when: "always",
      notify: { alert: true, report: true, cooldownMinutes: 0 },
    });
    eq(created.status, 200, created.text);
    const vehicleRuleId = created.json.rule.id;

    const wholeAreaId = wholeCameraAreaId("cam-1");
    const V0 = Date.parse("2026-09-28T06:00:00Z");
    const occ = openOccupancyDb(join(stateDir, "occupancy.db"));
    occ.insert({ areaId: wholeAreaId, cameraId: "cam-1", kind: "vehicle", state: "absent", atMs: V0 });
    occ.insert({ areaId: wholeAreaId, cameraId: "cam-1", kind: "vehicle", state: "not_watching", atMs: V0 + 1_000 });
    // not_watching -> present is NEVER an "enters", even though the state
    // right before it was absent two steps back (MANAGER-RULES-SPEC.md: "A
    // transition from or into not_watching never counts as entering or
    // leaving").
    occ.insert({ areaId: wholeAreaId, cameraId: "cam-1", kind: "vehicle", state: "present", atMs: V0 + 2_000 });
    occ.insert({ areaId: wholeAreaId, cameraId: "cam-1", kind: "vehicle", state: "absent", atMs: V0 + 3_000 }); // present->absent: a "leaves", irrelevant to this rule
    occ.insert({ areaId: wholeAreaId, cameraId: "cam-1", kind: "vehicle", state: "not_watching", atMs: V0 + 4_000 });
    occ.insert({ areaId: wholeAreaId, cameraId: "cam-1", kind: "vehicle", state: "present", atMs: V0 + 5_000 }); // not_watching->present again: still never an "enters"
    occ.close();

    const fastServer = startServer(installer, { managerRulesIntervalMs: 20, now: () => new Date(V0 + 10_000) });
    await new Promise((r) => fastServer.listen(0, "127.0.0.1", r));
    try {
      await new Promise((r) => setTimeout(r, 300)); // several evaluator ticks
      const r = await send("GET", "/reports?day=2026-09-28", undefined, fastServer);
      const group = r.json.groups.find((x) => x.ruleId === vehicleRuleId);
      eq(group === undefined || group.firings.length === 0, true, "no not_watching edge was ever read as an enter");
    } finally {
      fastServer.closeManagerRulesEvaluator();
      await new Promise((r) => setTimeout(r, 100));
      fastServer.closeOccupancy();
      fastServer.closeRules();
      await new Promise((r) => fastServer.close(r));
    }
  });

  await check("GET /reports refuses a bad day, and reports the oldest footage this NVR keeps", async () => {
    const bad = await send("GET", "/reports?day=not-a-day");
    eq(bad.status, 400);
    eq(bad.json.code, "bad_day");
    const ok = await send("GET", "/reports?day=2026-09-28");
    eq(ok.status, 200);
    eq("oldestFootageUtc" in ok.json, true);
  });

  await check("FEARED: no camera credential, URL, or a person's name anywhere -- areas.json, rules.json, the audit log, or any of these responses", async () => {
    noSecrets(JSON.stringify(audits), "audit log");
    noSecrets(await readFile(join(stateDir, "areas.json"), "utf8"), "areas.json");
    noSecrets(await readFile(join(stateDir, "rules.json"), "utf8"), "rules.json");
    const reportText = (await send("GET", "/reports?day=2026-09-28")).text;
    noSecrets(reportText, "GET /reports");
    eq(/\bface\b/i.test(reportText), false, "identity-free: no face-recognition wording anywhere");
  });
} finally {
  server.closeManagerRulesEvaluator();
  server.closeEventRetention();
  server.closeOccupancy();
  server.closeRules();
  await new Promise((r) => server.close(r));
  index.close();
  await rm(stateDir, { recursive: true, force: true });
}

report("manager rules API");
