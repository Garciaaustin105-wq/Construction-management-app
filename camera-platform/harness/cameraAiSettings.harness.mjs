// harness/cameraAiSettings.harness.mjs — contracts/cameraAiSettings.ts
//
// FEARED: a blank read as a zero (a missing camera or field turning into "0
// confidence" / "never open" / "no kinds"); a minConfidence saved below the
// site's storing floor; the first bad field on a form hiding every other one;
// a point on a zone's edge going either way; a DST day using the wrong hours;
// the box's units guessed instead of found.

import { check, eq, same, throws, report } from "./_assert.mjs";
import {
  MIN_CONFIDENCE, MAX_CONFIDENCE, CONFIDENCE_STEP, MAX_ZONES, MIN_ZONE_POINTS, MAX_ZONE_POINTS,
  DEFAULT_CAMERA_AI_SETTINGS,
  checkCameraAiSettings, checkCameraAiSettingsFile, settingsForCamera, diffCameraAiSettings,
  boxGroundPointFraction, pointInZone, zoneVerdict, judgeDetection, scheduleOpen,
} from "../dist/cameraAiSettings.js";

console.log("camera AI settings");

const FLOOR = 0.5;

function zone(id, mode, points) {
  return { id, mode, points };
}

const wholeFrameCamera = {};

// ---------------------------------------------------------------- defaults

check("a missing camera validates as the defaults: whole frame, always, inherit, both kinds", () => {
  const r = checkCameraAiSettings(undefined, FLOOR);
  eq(r.ok, true);
  same(r.settings, { zones: [], schedule: null, minConfidence: null, kinds: { person: true, vehicle: true } });
  same(r.settings, DEFAULT_CAMERA_AI_SETTINGS);
});

check("a null camera validates the same as a missing one", () => {
  const r = checkCameraAiSettings(null, FLOOR);
  eq(r.ok, true);
  same(r.settings, DEFAULT_CAMERA_AI_SETTINGS);
});

check("an empty object validates: every field defaults, none becomes a zero", () => {
  const r = checkCameraAiSettings({}, FLOOR);
  eq(r.ok, true);
  same(r.settings, DEFAULT_CAMERA_AI_SETTINGS);
});

check("a camera absent from a validated file gets the defaults", () => {
  const filed = checkCameraAiSettingsFile({ version: 1, cameras: {} }, FLOOR);
  eq(filed.ok, true);
  same(settingsForCamera(filed.file, "cam-nope"), DEFAULT_CAMERA_AI_SETTINGS);
});

check("checkCameraAiSettings needs a real floor, not a guess", () => {
  throws(() => checkCameraAiSettings({}, "0.5"), "string floor");
  throws(() => checkCameraAiSettings({}, 1.5), "out of range floor");
  throws(() => checkCameraAiSettings({}, NaN), "NaN floor");
});

// ---------------------------------------------------------------- minConfidence

check("minConfidence accepts every 0.05 step from 0.30 to 0.90", () => {
  for (let v = MIN_CONFIDENCE; v <= MAX_CONFIDENCE + 1e-9; v += CONFIDENCE_STEP) {
    const r = checkCameraAiSettings({ minConfidence: v }, MIN_CONFIDENCE);
    eq(r.ok, true, `minConfidence ${v}`);
    eq(r.settings.minConfidence, Math.round(v * 100) / 100, `minConfidence ${v} normalized`);
  }
});

check("minConfidence null means inherit the site default", () => {
  const r = checkCameraAiSettings({ minConfidence: null }, FLOOR);
  eq(r.ok, true);
  eq(r.settings.minConfidence, null);
});

check("minConfidence outside 0.30-0.90 is refused", () => {
  const low = checkCameraAiSettings({ minConfidence: 0.25 }, 0.1);
  eq(low.ok, false);
  same(low.errors, [{ field: "minConfidence", reason: "bad_confidence_range" }]);
  const high = checkCameraAiSettings({ minConfidence: 0.95 }, 0.1);
  eq(high.ok, false);
  same(high.errors, [{ field: "minConfidence", reason: "bad_confidence_range" }]);
});

check("minConfidence off the 0.05 steps is refused", () => {
  const r = checkCameraAiSettings({ minConfidence: 0.33 }, 0.1);
  eq(r.ok, false);
  same(r.errors, [{ field: "minConfidence", reason: "bad_confidence_step" }]);
});

check("FEARED: minConfidence below the caller's storing floor is refused", () => {
  const r = checkCameraAiSettings({ minConfidence: 0.4 }, 0.5);
  eq(r.ok, false);
  same(r.errors, [{ field: "minConfidence", reason: "below_storing_floor" }]);
  // exactly at the floor is fine
  const ok = checkCameraAiSettings({ minConfidence: 0.5 }, 0.5);
  eq(ok.ok, true);
  eq(ok.settings.minConfidence, 0.5);
});

check("a floor above the whole 0.30-0.90 band leaves only null (inherit) valid", () => {
  const r = checkCameraAiSettings({ minConfidence: 0.9 }, 0.95);
  eq(r.ok, false);
  same(r.errors, [{ field: "minConfidence", reason: "below_storing_floor" }]);
  const inherit = checkCameraAiSettings({ minConfidence: null }, 0.95);
  eq(inherit.ok, true);
  eq(inherit.settings.minConfidence, null);
});

check("a bad-typed minConfidence is refused, not coerced", () => {
  same(checkCameraAiSettings({ minConfidence: "0.5" }, FLOOR).errors, [{ field: "minConfidence", reason: "bad_confidence" }]);
  same(checkCameraAiSettings({ minConfidence: NaN }, FLOOR).errors, [{ field: "minConfidence", reason: "bad_confidence" }]);
});

// ---------------------------------------------------------------- kinds

check("kinds default to both on when the field is missing", () => {
  eq(checkCameraAiSettings({}, FLOOR).settings.kinds, { person: true, vehicle: true });
});

check("kinds are read as given when both are present", () => {
  const r = checkCameraAiSettings({ kinds: { person: false, vehicle: true } }, FLOOR);
  eq(r.ok, true);
  same(r.settings.kinds, { person: false, vehicle: true });
});

check("a half-written kinds object is refused, not guessed at per flag", () => {
  const r = checkCameraAiSettings({ kinds: { person: false } }, FLOOR);
  eq(r.ok, false);
  same(r.errors, [{ field: "kinds.vehicle", reason: "bad_kind_flag" }]);
});

check("an unknown key in kinds is refused", () => {
  const r = checkCameraAiSettings({ kinds: { person: true, vehicle: true, face: true } }, FLOOR);
  eq(r.ok, false);
  eq(r.errors.some((e) => e.field === "kinds" && e.reason === "unknown_field"), true);
});

// ---------------------------------------------------------------- zones

check("zones default to empty: the whole frame counts", () => {
  eq(checkCameraAiSettings({}, FLOOR).settings.zones, []);
});

check("a good zone round-trips", () => {
  const points = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const r = checkCameraAiSettings({ zones: [zone("z1", "watch", points)] }, FLOOR);
  eq(r.ok, true);
  same(r.settings.zones, [{ id: "z1", mode: "watch", points }]);
});

check("a zone needs 3 to 32 points", () => {
  const two = checkCameraAiSettings({ zones: [zone("z1", "watch", [[0, 0], [1, 1]])] }, FLOOR);
  eq(two.ok, false);
  same(two.errors, [{ field: "zones[0].points", reason: "bad_zone_point_count" }]);
  const many = Array.from({ length: 33 }, (_, i) => [i / 33, 0]);
  const overMany = checkCameraAiSettings({ zones: [zone("z1", "watch", many)] }, FLOOR);
  eq(overMany.ok, false);
  same(overMany.errors, [{ field: "zones[0].points", reason: "bad_zone_point_count" }]);
});

check("at most 8 zones per camera", () => {
  const nine = Array.from({ length: 9 }, (_, i) => zone(`z${i}`, "watch", [[0, 0], [1, 0], [1, 1]]));
  const r = checkCameraAiSettings({ zones: nine }, FLOOR);
  eq(r.ok, false);
  eq(r.errors.some((e) => e.field === "zones" && e.reason === "too_many_zones"), true);
});

check("a bad zone mode, a point out of range, and a duplicate id are all reported at once", () => {
  const r = checkCameraAiSettings(
    {
      zones: [
        zone("z1", "watch", [[0, 0], [1, 0], [1, 1]]),
        zone("z1", "somewhere", [[0, 0], [2, 0], [1, 1]]),
      ],
    },
    FLOOR,
  );
  eq(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  same(fields, ["zones[1].id", "zones[1].mode", "zones[1].points[1]"]);
});

check("FEARED: the first bad field never hides the rest — every problem across every part of the camera comes back together", () => {
  const r = checkCameraAiSettings(
    {
      zones: [zone("z1", "bad-mode", [[0, 0], [1, 1]])],
      schedule: { timeZone: "Mars/Olympus", weekly: [], closedDates: [] },
      minConfidence: 0.33,
      kinds: { person: "yes" },
    },
    0.5,
  );
  eq(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  same(fields, ["kinds.person", "kinds.vehicle", "minConfidence", "schedule", "zones[0].mode", "zones[0].points"]);
});

// ---------------------------------------------------------------- schedule (reusing alertRules)

const weekday = [{ open: 8 * 60, close: 22 * 60 }];
function chicagoSchedule(over = {}) {
  return {
    timeZone: "America/Chicago",
    weekly: [[], weekday, weekday, weekday, weekday, weekday, [{ open: 18 * 60, close: 2 * 60 }]],
    closedDates: ["2026-12-25"],
    ...over,
  };
}

check("schedule null means always (no restriction)", () => {
  const r = checkCameraAiSettings({ schedule: null }, FLOOR);
  eq(r.ok, true);
  eq(r.settings.schedule, null);
  eq(scheduleOpen({ schedule: null }, Date.parse("2026-01-01T03:00:00Z")), true);
});

check("a good schedule round-trips and validates through alertRules' own checkRule", () => {
  const s = chicagoSchedule();
  const r = checkCameraAiSettings({ schedule: s }, FLOOR);
  eq(r.ok, true);
  same(r.settings.schedule, s);
});

check("a bad time zone, bad hours and a bad closed date are refused with alertRules' own reasons", () => {
  same(checkCameraAiSettings({ schedule: chicagoSchedule({ timeZone: "Mars/Olympus" }) }, FLOOR).errors, [
    { field: "schedule", reason: "bad_time_zone" },
  ]);
  same(checkCameraAiSettings({ schedule: chicagoSchedule({ weekly: [[{ open: 600, close: 600 }], [], [], [], [], [], []] }) }, FLOOR).errors, [
    { field: "schedule", reason: "bad_hours" },
  ]);
  same(checkCameraAiSettings({ schedule: chicagoSchedule({ closedDates: ["2026-02-30"] }) }, FLOOR).errors, [
    { field: "schedule", reason: "bad_closed_date" },
  ]);
});

check("FEARED: a DST-day schedule uses the right hours on both sides of the change", () => {
  const s = chicagoSchedule();
  const r = checkCameraAiSettings({ schedule: s }, FLOOR);
  eq(r.ok, true);
  // Sunday 2026-03-08 is the US spring-forward day; the site's Mon-Fri hours
  // do not apply to Sunday (closed all day) but Saturday's past-midnight
  // 18:00-02:00 block still runs into it as usual, DST or not.
  const open = (iso) => scheduleOpen({ schedule: r.settings.schedule }, Date.parse(iso));
  eq(open("2026-03-08T06:30:00Z"), true); // Sat 2026-03-07 24:30 CST -> Sun 00:30, past midnight
  eq(open("2026-03-08T07:59:00Z"), true); // 01:59 CST, still before the 02:00 close
  eq(open("2026-03-08T08:00:00Z"), false); // 03:00 CDT (clocks sprang forward at 2am): past the close
  eq(open("2026-03-08T14:00:00Z"), false); // Sunday afternoon: closed all day
  // Weekday hours read the same wall-clock 08:00-22:00 on both sides of the change.
  eq(open("2026-03-09T12:59:00Z"), false); // Mon 06:59 CDT: not yet open
  eq(open("2026-03-09T13:00:00Z"), true); // Mon 08:00 CDT: open
  eq(open("2026-11-02T13:59:00Z"), false); // Mon 07:59 CST (after fall-back): not yet open
  eq(open("2026-11-02T14:00:00Z"), true); // Mon 08:00 CST: open
});

// ---------------------------------------------------------------- whole file

check("checkCameraAiSettingsFile validates every camera and collects every camera's problems", () => {
  const file = {
    version: 1,
    cameras: {
      good: { zones: [], schedule: null, minConfidence: 0.5, kinds: { person: true, vehicle: true }, updatedUtc: "2026-09-26T00:00:00Z", updatedBy: "austin" },
      bad1: { minConfidence: 0.33, updatedUtc: "2026-09-26T00:00:00Z", updatedBy: "austin" },
      bad2: { minConfidence: 0.5, updatedUtc: "not-a-time", updatedBy: "austin" },
    },
  };
  const r = checkCameraAiSettingsFile(file, 0.3);
  eq(r.ok, false);
  const byCam = new Map();
  for (const e of r.errors) byCam.set(e.cameraId, [...(byCam.get(e.cameraId) ?? []), e.reason]);
  eq(byCam.has("good"), false);
  same(byCam.get("bad1"), ["bad_confidence_step"]);
  same(byCam.get("bad2"), ["bad_time"]);
});

check("checkCameraAiSettingsFile accepts a good file and settingsForCamera reads it back", () => {
  const file = {
    version: 1,
    cameras: {
      cam1: { zones: [zone("z1", "ignore", [[0, 0], [1, 0], [1, 1]])], schedule: null, minConfidence: null, kinds: { person: true, vehicle: false }, updatedUtc: "2026-09-26T00:00:00Z", updatedBy: "austin" },
    },
  };
  const r = checkCameraAiSettingsFile(file, 0.3);
  eq(r.ok, true);
  const settings = settingsForCamera(r.file, "cam1");
  same(settings, { zones: [{ id: "z1", mode: "ignore", points: [[0, 0], [1, 0], [1, 1]] }], schedule: null, minConfidence: null, kinds: { person: true, vehicle: false } });
});

check("bad version and non-object cameras are refused at the file level", () => {
  eq(checkCameraAiSettingsFile({ version: 2, cameras: {} }, 0.3).errors.some((e) => e.field === "version"), true);
  eq(checkCameraAiSettingsFile({ version: 1, cameras: [] }, 0.3).errors.some((e) => e.field === "cameras"), true);
  eq(checkCameraAiSettingsFile("nope", 0.3).errors[0].field, "file");
});

// ---------------------------------------------------------------- diff (for the audit)

check("diffCameraAiSettings names only the fields that changed, never the values", () => {
  const before = { zones: [], schedule: null, minConfidence: null, kinds: { person: true, vehicle: true } };
  const after = { zones: [], schedule: null, minConfidence: 0.6, kinds: { person: false, vehicle: true } };
  same(diffCameraAiSettings(before, after).sort(), ["kinds", "minConfidence"]);
  same(diffCameraAiSettings(before, before), []);
});

// ---------------------------------------------------------------- boxGroundPointFraction

check("boxGroundPointFraction is the box's bottom-centre, and needs no frame-size conversion (the box is already a frame fraction)", () => {
  const frame = { width: 1920, height: 1080 };
  const r = boxGroundPointFraction({ x: 0.4, y: 0.3, w: 0.2, h: 0.4 }, frame);
  eq(r.ok, true);
  eq(r.x, 0.5);
  eq(r.y, 0.7);
  // A wildly different frame size changes nothing: the fraction is resolution-independent.
  const r2 = boxGroundPointFraction({ x: 0.4, y: 0.3, w: 0.2, h: 0.4 }, { width: 320, height: 240 });
  eq(r2.x, r.x);
  eq(r2.y, r.y);
});

check("boxGroundPointFraction refuses an unreadable box or frame", () => {
  const frame = { width: 640, height: 480 };
  eq(boxGroundPointFraction({ x: 0.4, y: 0.3, w: 0, h: 0.4 }, frame), { ok: false, reason: "bad_box" });
  eq(boxGroundPointFraction({ x: 0.4, y: 0.3, w: 0.2, h: 0.4 }, { width: 0, height: 480 }), { ok: false, reason: "bad_frame" });
  eq(boxGroundPointFraction(null, frame), { ok: false, reason: "bad_box" });
  eq(boxGroundPointFraction({ x: 0.4, y: 0.3, w: 0.2, h: 0.4 }, null), { ok: false, reason: "bad_frame" });
});

// ---------------------------------------------------------------- the zone test

check("no watch zones means the whole frame counts", () => {
  eq(zoneVerdict([], { x: 0.5, y: 0.5 }), "visible");
  eq(zoneVerdict([zone("z1", "ignore", [[0.9, 0.9], [1, 0.9], [1, 1]])], { x: 0.1, y: 0.1 }), "visible");
});

check("FEARED: a point inside an ignore zone that sits inside a watch zone is hidden — ignore beats watch", () => {
  const watch = zone("w1", "watch", [[0, 0], [1, 0], [1, 1], [0, 1]]);
  const ignore = zone("i1", "ignore", [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]);
  eq(zoneVerdict([watch, ignore], { x: 0.5, y: 0.5 }), "hidden");
  eq(zoneVerdict([watch, ignore], { x: 0.1, y: 0.1 }), "visible");
});

check("a watch zone with the point outside every watch zone is hidden", () => {
  const watch = zone("w1", "watch", [[0, 0], [0.3, 0], [0.3, 0.3], [0, 0.3]]);
  eq(zoneVerdict([watch], { x: 0.9, y: 0.9 }), "hidden");
  eq(zoneVerdict([watch], { x: 0.1, y: 0.1 }), "visible");
});

check("concave polygons are supported (even-odd)", () => {
  // A "C" shape / notch: a square with a bite taken out of its right side.
  const notch = [
    [0, 0], [1, 0], [1, 0.4], [0.5, 0.4], [0.5, 0.6], [1, 0.6], [1, 1], [0, 1],
  ];
  eq(pointInZone(0.9, 0.5, notch), false); // inside the bite: outside the shape
  eq(pointInZone(0.9, 0.1, notch), true); // above the bite: inside
  eq(pointInZone(0.9, 0.9, notch), true); // below the bite: inside
  eq(pointInZone(0.25, 0.5, notch), true); // left of the bite, inside the solid part
});

check("FEARED: a point exactly on a zone's edge counts as inside", () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  eq(pointInZone(0, 0.5, square), true); // on the left edge
  eq(pointInZone(0.5, 0, square), true); // on the top edge
  eq(pointInZone(1, 1, square), true); // exactly on a vertex
  eq(pointInZone(1, 0.5, square), true); // on the right edge
  // a diagonal edge (not axis-aligned)
  const triangle = [[0, 0], [1, 0], [0, 1]];
  eq(pointInZone(0.5, 0.5, triangle), true); // on the hypotenuse
  eq(pointInZone(0.51, 0.51, triangle), false); // just outside it
});

// ---------------------------------------------------------------- judgeDetection

function judgeEvent(over = {}) {
  return { kind: "person", bestConfidence: 0.8, bestBox: { x: 0.4, y: 0.3, w: 0.2, h: 0.4 }, ...over };
}

check("below the camera's threshold: not stored at all", () => {
  const settings = { ...DEFAULT_CAMERA_AI_SETTINGS, minConfidence: 0.7 };
  eq(judgeDetection(settings, judgeEvent({ bestConfidence: 0.69 }), 0.3, 0), { store: false });
  eq(judgeDetection(settings, judgeEvent({ bestConfidence: 0.7 }), 0.3, 0), { store: true, hiddenBy: null });
});

check("minConfidence null inherits the site floor as the threshold", () => {
  const settings = { ...DEFAULT_CAMERA_AI_SETTINGS, minConfidence: null };
  eq(judgeDetection(settings, judgeEvent({ bestConfidence: 0.49 }), 0.5, 0), { store: false });
  eq(judgeDetection(settings, judgeEvent({ bestConfidence: 0.5 }), 0.5, 0), { store: true, hiddenBy: null });
});

check("a kind switched off is stored hidden behind settings:kind, not dropped", () => {
  const settings = { ...DEFAULT_CAMERA_AI_SETTINGS, kinds: { person: false, vehicle: true } };
  eq(judgeDetection(settings, judgeEvent({ kind: "person" }), 0.3, 0), { store: true, hiddenBy: "settings:kind" });
  eq(judgeDetection(settings, judgeEvent({ kind: "vehicle" }), 0.3, 0), { store: true, hiddenBy: null });
});

check("an out-of-zone event is stored hidden behind settings:zone, not dropped", () => {
  const watch = zone("w1", "watch", [[0, 0], [0.3, 0], [0.3, 0.3], [0, 0.3]]);
  const settings = { ...DEFAULT_CAMERA_AI_SETTINGS, zones: [watch] };
  // feet at x + w/2 = 0.5, y + h = 0.7: outside the watch zone
  eq(judgeDetection(settings, judgeEvent(), 0.3, 0), { store: true, hiddenBy: "settings:zone" });
  eq(judgeDetection(settings, judgeEvent({ bestBox: { x: 0.05, y: 0.05, w: 0.1, h: 0.1 } }), 0.3, 0), { store: true, hiddenBy: null });
});

check("kind is judged before zone: a switched-off kind outside its zone is still reported as settings:kind", () => {
  const watch = zone("w1", "watch", [[0, 0], [0.3, 0], [0.3, 0.3], [0, 0.3]]);
  const settings = { ...DEFAULT_CAMERA_AI_SETTINGS, kinds: { person: false, vehicle: true }, zones: [watch] };
  eq(judgeDetection(settings, judgeEvent({ kind: "person" }), 0.3, 0), { store: true, hiddenBy: "settings:kind" });
});

check("a plate is never hidden by kinds (person/vehicle only) but is still judged by zone", () => {
  const settings = { ...DEFAULT_CAMERA_AI_SETTINGS, kinds: { person: false, vehicle: false } };
  eq(judgeDetection(settings, judgeEvent({ kind: "plate" }), 0.3, 0), { store: true, hiddenBy: null });
});

check("judgeDetection needs a real floor, not a guess", () => {
  throws(() => judgeDetection(DEFAULT_CAMERA_AI_SETTINGS, judgeEvent(), "0.3", 0), "string floor");
});

report("camera AI settings");
