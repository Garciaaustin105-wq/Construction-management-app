// harness/alertRules.harness.mjs — contracts/alertRules.ts
//
// FEARED: an hour of silence all summer (a fixed UTC offset); a bar that is
// open past midnight alerting at 01:30; a holiday ignored; a bad rule that
// quietly never fires; forty alerts for one person pacing.
//
// Site: America/Chicago. CDT (UTC-5) from 2026-03-08 02:00, CST (UTC-6) from
// 2026-11-01 02:00.

import { check, eq, report } from "./_assert.mjs";
import { localParts, previousDate, checkRule, isOpen, decideAlert } from "../dist/alertRules.js";

console.log("alert rules");

const z = (iso) => Date.parse(iso);
const hm = (h, m = 0) => h * 60 + m;
const weekday = [{ open: hm(8), close: hm(22) }];

function makeRule(over = {}) {
  return {
    id: "after-hours",
    cameraIds: ["cam1", "gate"],
    kinds: ["person"],
    minConfidence: 0.5,
    schedule: {
      timeZone: "America/Chicago",
      // Sun closed; Mon-Fri 08:00-22:00; Sat 18:00-02:00 (past midnight)
      weekly: [[], weekday, weekday, weekday, weekday, weekday, [{ open: hm(18), close: hm(2) }]],
      closedDates: ["2026-12-25", "2026-12-26"],
    },
    zones: [],
    cooldownSeconds: 300,
    ...over,
  };
}
const withSchedule = (over) => makeRule({ schedule: { ...makeRule().schedule, ...over } });

const event = (firstUtc, over = {}) => ({
  cameraId: "cam1", kind: "person", firstUtc, lastUtc: firstUtc, count: 3,
  bestConfidence: 0.8, bestBox: { x: 0.4, y: 0.3, w: 0.1, h: 0.4 }, bestUtc: firstUtc, ...over,
});

check("previousDate", () => {
  eq(previousDate("2026-03-01"), "2026-02-28");
  eq(previousDate("2024-03-01"), "2024-02-29");
  eq(previousDate("2026-01-01"), "2025-12-31");
  eq(previousDate("2026-11-01"), "2026-10-31");
});

check("localParts reads the zone's own offset", () => {
  eq(localParts("America/Chicago", z("2026-07-16T03:30:00Z")), { date: "2026-07-15", weekday: 3, minute: hm(22, 30) });
  eq(localParts("America/Chicago", z("2026-01-15T03:30:00Z")), { date: "2026-01-14", weekday: 3, minute: hm(21, 30) });
  eq(localParts("UTC", z("2026-07-16T00:00:00Z")), { date: "2026-07-16", weekday: 4, minute: 0 });
});

check("FEARED: the spring-forward hour", () => {
  eq(localParts("America/Chicago", z("2026-03-08T07:59:00Z")), { date: "2026-03-08", weekday: 0, minute: hm(1, 59) });
  eq(localParts("America/Chicago", z("2026-03-08T08:00:00Z")), { date: "2026-03-08", weekday: 0, minute: hm(3) });
  const s = makeRule().schedule;
  eq(isOpen(s, z("2026-03-08T07:59:00Z")), true); // Saturday night's hours, 01:59
  eq(isOpen(s, z("2026-03-08T08:00:00Z")), false); // 03:00, past the 02:00 close
});

check("FEARED: the fall-back hour happens twice", () => {
  eq(localParts("America/Chicago", z("2026-11-01T06:30:00Z")).minute, hm(1, 30));
  eq(localParts("America/Chicago", z("2026-11-01T07:30:00Z")).minute, hm(1, 30));
  const s = makeRule().schedule;
  eq(isOpen(s, z("2026-11-01T06:30:00Z")), true);
  eq(isOpen(s, z("2026-11-01T07:30:00Z")), true);
  eq(isOpen(s, z("2026-11-01T08:00:00Z")), false); // 02:00 CST
});

check("FEARED: summer and winter both close at 22:00 local", () => {
  const s = makeRule().schedule;
  // Wednesday 2026-07-15, CDT
  eq(isOpen(s, z("2026-07-16T02:30:00Z")), true); // 21:30
  eq(isOpen(s, z("2026-07-16T03:00:00Z")), false); // 22:00 exactly: closed
  eq(isOpen(s, z("2026-07-16T03:30:00Z")), false); // 22:30
  // Wednesday 2026-01-14, CST
  eq(isOpen(s, z("2026-01-15T03:30:00Z")), true); // 21:30
  eq(isOpen(s, z("2026-01-15T04:30:00Z")), false); // 22:30
  // opens at 08:00 exactly
  eq(isOpen(s, z("2026-07-15T12:59:00Z")), false);
  eq(isOpen(s, z("2026-07-15T13:00:00Z")), true);
});

check("FEARED: hours past midnight", () => {
  const s = makeRule().schedule;
  eq(isOpen(s, z("2026-07-18T22:00:00Z")), false); // Sat 17:00
  eq(isOpen(s, z("2026-07-19T04:00:00Z")), true); // Sat 23:00
  eq(isOpen(s, z("2026-07-19T06:30:00Z")), true); // Sun 01:30, on Saturday's hours
  eq(isOpen(s, z("2026-07-19T07:00:00Z")), false); // Sun 02:00
  eq(isOpen(s, z("2026-07-19T17:00:00Z")), false); // Sun noon, closed all day
  // Friday's hours do not run past midnight into Saturday
  eq(isOpen(s, z("2026-07-18T06:30:00Z")), false); // Sat 01:30
});

check("FEARED: holidays are closed all day, including the night they start", () => {
  const s = makeRule().schedule;
  eq(isOpen(s, z("2026-12-24T18:00:00Z")), true); // Thu noon
  eq(isOpen(s, z("2026-12-25T18:00:00Z")), false); // Fri noon, holiday
  eq(isOpen(s, z("2026-12-27T05:00:00Z")), false); // Sat 23:00, holiday
  eq(isOpen(s, z("2026-12-27T07:00:00Z")), false); // Sun 01:00, on the holiday's hours
  const open = withSchedule({ closedDates: [] }).schedule;
  eq(isOpen(open, z("2026-12-27T07:00:00Z")), true);
});

check("a day open 00:00-24:00 is open at 23:59", () => {
  const s = withSchedule({ weekly: Array.from({ length: 7 }, () => [{ open: 0, close: 1440 }]), closedDates: [] }).schedule;
  eq(isOpen(s, z("2026-07-16T04:59:00Z")), true);
  eq(isOpen(s, z("2026-07-16T05:00:00Z")), true);
});

check("checkRule accepts a good rule", () => {
  eq(checkRule(makeRule()), { ok: true });
  eq(checkRule(makeRule({ zones: [[[0, 0.5], [1, 0.5], [1, 1]]], cooldownSeconds: 0 })), { ok: true });
});

check("FEARED: a bad rule is refused when saved, not silent later", () => {
  const refuse = (rule, reason) => eq(checkRule(rule), { ok: false, reason });
  const r = makeRule();
  refuse(null, "bad_id");
  refuse({ ...r, id: "" }, "bad_id");
  refuse({ ...r, cameraIds: [] }, "no_cameras");
  refuse({ ...r, cameraIds: ["cam1", ""] }, "no_cameras");
  refuse({ ...r, kinds: [] }, "bad_kinds");
  refuse({ ...r, kinds: ["face"] }, "bad_kinds");
  refuse({ ...r, minConfidence: 1.5 }, "bad_confidence");
  refuse({ ...r, minConfidence: NaN }, "bad_confidence");
  refuse(withSchedule({ timeZone: "Mars/Olympus" }), "bad_time_zone");
  refuse(withSchedule({ timeZone: "" }), "bad_time_zone");
  refuse(withSchedule({ timeZone: 5 }), "bad_time_zone");
  refuse(withSchedule({ weekly: r.schedule.weekly.slice(0, 6) }), "bad_hours");
  refuse(withSchedule({ weekly: [[{ open: 600, close: 600 }], [], [], [], [], [], []] }), "bad_hours");
  refuse(withSchedule({ weekly: [[{ open: 600, close: 1441 }], [], [], [], [], [], []] }), "bad_hours");
  refuse(withSchedule({ weekly: [[{ open: 60.5, close: 600 }], [], [], [], [], [], []] }), "bad_hours");
  refuse(withSchedule({ weekly: [null, [], [], [], [], [], []] }), "bad_hours");
  refuse(withSchedule({ closedDates: ["2026-02-30"] }), "bad_closed_date");
  refuse(withSchedule({ closedDates: ["12/25/2026"] }), "bad_closed_date");
  refuse({ ...r, zones: [[[0, 0], [1, 1]]] }, "bad_zone");
  refuse({ ...r, zones: [[[0, 0], [1.2, 1], [0, 1]]] }, "bad_zone");
  refuse({ ...r, cooldownSeconds: 1.5 }, "bad_cooldown");
  refuse({ ...r, cooldownSeconds: 86401 }, "bad_cooldown");
});

// Wednesday 2026-07-15 23:00 CDT: closed
const NIGHT = "2026-07-16T04:00:00.000Z";

check("an after-hours person alerts", () => {
  eq(decideAlert(makeRule(), event(NIGHT), null), { alert: true });
});

check("refusals come in order, each with its reason", () => {
  const no = (reason) => ({ alert: false, reason });
  eq(decideAlert(makeRule({ cooldownSeconds: -1 }), event(NIGHT), null), no("invalid_rule"));
  eq(decideAlert(makeRule(), event(NIGHT, { cameraId: "cam9" }), null), no("wrong_camera"));
  eq(decideAlert(makeRule(), event(NIGHT, { kind: "vehicle" }), null), no("wrong_kind"));
  eq(decideAlert(makeRule(), event(NIGHT, { bestConfidence: 0.49 }), null), no("below_confidence"));
  eq(decideAlert(makeRule(), event(NIGHT, { bestConfidence: 0.5 }), null), { alert: true });
  eq(decideAlert(makeRule(), event("2026-07-15T17:00:00.000Z"), null), no("open_hours"));
  // wrong camera outranks open hours
  eq(decideAlert(makeRule(), event("2026-07-15T17:00:00.000Z", { cameraId: "cam9" }), null), no("wrong_camera"));
});

check("zones judge where the feet are, not the middle of the box", () => {
  const lowerHalf = [[0, 0.5], [1, 0.5], [1, 1], [0, 1]];
  const rule = makeRule({ zones: [lowerHalf] });
  // centre y 0.4 is above the zone, feet y 0.6 inside: it counts
  eq(decideAlert(rule, event(NIGHT, { bestBox: { x: 0.4, y: 0.2, w: 0.1, h: 0.4 } }), null), { alert: true });
  // feet y 0.4: outside
  eq(decideAlert(rule, event(NIGHT, { bestBox: { x: 0.4, y: 0.1, w: 0.1, h: 0.3 } }), null), { alert: false, reason: "outside_zones" });
  // a second zone that holds it
  const topLeft = [[0, 0], [0.6, 0], [0.6, 0.45], [0, 0.45]];
  eq(decideAlert(makeRule({ zones: [lowerHalf, topLeft] }), event(NIGHT, { bestBox: { x: 0.4, y: 0.1, w: 0.1, h: 0.3 } }), null), { alert: true });
  // a triangle: feet (0.45, 0.7) is outside the triangle (0,0.5)-(0.3,0.5)-(0,1)
  eq(decideAlert(makeRule({ zones: [[[0, 0.5], [0.3, 0.5], [0, 1]]] }), event(NIGHT), null), { alert: false, reason: "outside_zones" });
});

check("FEARED: cooldown stops a flood, and ends", () => {
  const rule = makeRule();
  const before = (s) => new Date(Date.parse(NIGHT) - s * 1000).toISOString();
  eq(decideAlert(rule, event(NIGHT), before(60)), { alert: false, reason: "cooldown" });
  eq(decideAlert(rule, event(NIGHT), NIGHT), { alert: false, reason: "cooldown" });
  eq(decideAlert(rule, event(NIGHT), before(300)), { alert: true });
  // a last alert after this event (clock skew, replay) does not block it
  eq(decideAlert(rule, event(NIGHT), new Date(Date.parse(NIGHT) + 5000).toISOString()), { alert: true });
  eq(decideAlert(makeRule({ cooldownSeconds: 0 }), event(NIGHT), NIGHT), { alert: true });
});

check("decideAlert changes neither the rule nor the event", () => {
  const rule = makeRule({ zones: [[[0, 0.5], [1, 0.5], [1, 1], [0, 1]]] });
  const ev = event(NIGHT);
  const a = JSON.stringify(rule), b = JSON.stringify(ev);
  decideAlert(rule, ev, null);
  eq(JSON.stringify(rule), a);
  eq(JSON.stringify(ev), b);
});

report("alert rules");
