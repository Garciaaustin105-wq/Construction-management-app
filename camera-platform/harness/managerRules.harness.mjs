// harness/managerRules.harness.mjs — contracts/managerRules.ts
//
// FEARED: a rule using hours it does not have; an away-and-back reported for
// a return that was never actually watched (a guessed return instead of a
// measurement); a not_watching gap counted as entering, leaving, or a
// completed away; a firing's own numbers moving when re-evaluated later; a
// report line that names a person; open_hours/closed_hours getting the DST
// day wrong.

import { check, eq, same, throws, report } from "./_assert.mjs";
import {
  MANAGER_RULE_TEMPLATES, checkManagerRule, evaluateManagerRule,
  deriveManagerLeaveEpisodes, evaluateManagerLeavesRule, evaluateManagerReturnsRule,
} from "../dist/managerRules.js";

console.log("manager rules");

const hm = (h, m = 0) => h * 60 + m;
const weekday = [{ open: hm(8), close: hm(22) }];
// Sun closed; Mon-Fri 08:00-22:00; Sat closed -- America/Chicago, CDT->CST on 2026-11-01.
const OPEN_HOURS = {
  timeZone: "America/Chicago",
  weekly: [[], weekday, weekday, weekday, weekday, weekday, []],
  closedDates: [],
};
const TZ = "America/Chicago";
const z = (iso) => Date.parse(iso);

function baseRule(over = {}) {
  return {
    id: "r1",
    name: "Manager's desk unattended",
    enabled: true,
    template: "desk_unattended",
    cameraId: "cam1",
    areaId: "desk",
    kind: "person",
    condition: { type: "absent_longer_than", minutes: 20 },
    when: "open_hours",
    notify: { alert: true, report: true, cooldownMinutes: 0 },
    createdBy: "installer1",
    updatedUtc: "2026-09-01T00:00:00.000Z",
    updatedBy: "installer1",
    ...over,
  };
}

// ---------------------------------------------------------------- templates

check("the template table matches the spec exactly, desk_unattended first", () => {
  eq(MANAGER_RULE_TEMPLATES.length, 10);
  eq(MANAGER_RULE_TEMPLATES[0].label, "Manager's desk unattended");
  const rows = MANAGER_RULE_TEMPLATES.map((t) => ({
    template: t.template, label: t.label, kind: t.kind, condition: t.condition, when: t.when,
    alert: t.notify.alert, report: t.notify.report,
  }));
  same(rows, [
    { template: "desk_unattended", label: "Manager's desk unattended", kind: "person", condition: { type: "absent_longer_than", minutes: 20 }, when: "open_hours", alert: true, report: true },
    { template: "away_and_back", label: "Manager away and back (desk)", kind: "person", condition: { type: "away_and_back", minMinutes: 5 }, when: "open_hours", alert: false, report: true },
    { template: "away_and_back", label: "Manager's car away and back", kind: "vehicle", condition: { type: "away_and_back", minMinutes: 10 }, when: "open_hours", alert: false, report: true },
    { template: "after_hours_person", label: "Person after hours", kind: "person", condition: { type: "enters" }, when: "closed_hours", alert: true, report: true },
    { template: "lingering", label: "Lingering", kind: "person", condition: { type: "present_longer_than", minutes: 10 }, when: "always", alert: true, report: true },
    { template: "vehicle_arrives", label: "Vehicle arrives", kind: "vehicle", condition: { type: "enters" }, when: "always", alert: true, report: true },
    { template: "vehicle_leaves", label: "Vehicle leaves", kind: "vehicle", condition: { type: "leaves" }, when: "always", alert: true, report: true },
    { template: "door_used", label: "Door used", kind: "person", condition: { type: "enters" }, when: "always", alert: false, report: true },
    { template: "manager_leaves", label: "Manager leaves", kind: "person", condition: { type: "manager_leaves", awayMinutes: 5 }, when: "open_hours", alert: true, report: true },
    { template: "manager_returns", label: "Manager returns", kind: "person", condition: { type: "manager_returns", awayMinutes: 5 }, when: "open_hours", alert: false, report: true },
  ]);
  eq(MANAGER_RULE_TEMPLATES[3].wholeCamera, true); // "Person after hours"
  eq(MANAGER_RULE_TEMPLATES.filter((t) => t.wholeCamera).length, 1);
});

// ---------------------------------------------------------------- validation

check("a good rule is accepted", () => {
  const r = checkManagerRule(baseRule(), OPEN_HOURS);
  eq(r.ok, true);
  eq(r.rule.name, "Manager's desk unattended");
});

check("every field problem is listed, not just the first", () => {
  const r = checkManagerRule({ id: "", name: "", enabled: "no", template: "bogus", cameraId: "", areaId: 5, kind: "dog", condition: {}, when: "sometimes", notify: {}, createdBy: "", updatedUtc: "not a date", updatedBy: "" }, OPEN_HOURS);
  eq(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  eq(fields, ["areaId", "cameraId", "condition.type", "createdBy", "enabled", "id", "kind", "name", "notify.alert", "notify.cooldownMinutes", "notify.report", "template", "updatedBy", "updatedUtc", "when"]);
});

check("areaId: null (whole camera) is fine; a non-empty string is fine; anything else is refused", () => {
  eq(checkManagerRule(baseRule({ areaId: null }), OPEN_HOURS).ok, true);
  eq(checkManagerRule(baseRule({ areaId: "back-door" }), OPEN_HOURS).ok, true);
  eq(checkManagerRule(baseRule({ areaId: "" }), OPEN_HOURS).ok, false);
});

check("every condition shape is checked, extra fields and bad numbers refused", () => {
  const cond = (condition) => checkManagerRule(baseRule({ condition }), OPEN_HOURS);
  eq(cond({ type: "enters" }).ok, true);
  eq(cond({ type: "leaves" }).ok, true);
  eq(cond({ type: "enters", extra: 1 }).ok, false);
  eq(cond({ type: "absent_longer_than", minutes: 20 }).ok, true);
  eq(cond({ type: "absent_longer_than", minutes: 0.5 }).ok, true); // fractional minutes: a rate, not forced to an integer
  eq(cond({ type: "absent_longer_than", minutes: 0 }).ok, false);
  eq(cond({ type: "absent_longer_than", minutes: -5 }).ok, false);
  eq(cond({ type: "absent_longer_than" }).ok, false);
  eq(cond({ type: "present_longer_than", minutes: 10 }).ok, true);
  eq(cond({ type: "away_and_back", minMinutes: 5 }).ok, true);
  eq(cond({ type: "away_and_back", minMinutes: 0 }).ok, false);
  eq(cond({ type: "manager_leaves", awayMinutes: 5 }).ok, true);
  eq(cond({ type: "manager_leaves", awayMinutes: 0 }).ok, false);
  eq(cond({ type: "manager_leaves" }).ok, false);
  eq(cond({ type: "manager_leaves", awayMinutes: 5, extra: 1 }).ok, false);
  eq(cond({ type: "manager_returns", awayMinutes: 5 }).ok, true);
  eq(cond({ type: "manager_returns", awayMinutes: -1 }).ok, false);
  eq(cond({ type: "nonsense" }).ok, false);
});

check("FEARED: a rule using hours it does not have is refused, never guessed", () => {
  const r = checkManagerRule(baseRule({ when: "open_hours" }), null);
  eq(r.ok, false);
  eq(r.errors.some((e) => e.field === "when" && e.reason === "hours_not_set"), true);
  eq(checkManagerRule(baseRule({ when: "closed_hours" }), null).ok, false);
  // "always" needs no hours at all
  eq(checkManagerRule(baseRule({ when: "always" }), null).ok, true);
});

check("notify.cooldownMinutes accepts 0 and rejects negative or non-numeric", () => {
  const notify = (n) => checkManagerRule(baseRule({ notify: { alert: true, report: true, cooldownMinutes: n } }), OPEN_HOURS);
  eq(notify(0).ok, true);
  eq(notify(-1).ok, false);
  eq(notify("5").ok, false);
  eq(notify(NaN).ok, false);
});

// ---------------------------------------------------------------- the evaluator: enters / leaves

function transitions(...pairs) {
  return pairs.map(([state, atMs]) => ({ state, atMs }));
}

const T0 = z("2026-07-20T13:00:00.000Z"); // Monday, well inside open hours (08:00 local CDT = 13:00Z)

check("enters fires on absent->present; leaves fires on present->absent; not_watching never counts as either", () => {
  const rule = baseRule({ condition: { type: "enters" }, when: "always" });
  const stream = transitions(
    ["absent", T0],
    ["present", T0 + 1_000], // enters
    ["not_watching", T0 + 2_000],
    ["present", T0 + 3_000], // from not_watching: never an "enters"
    ["absent", T0 + 4_000],
    ["present", T0 + 5_000], // enters
  );
  const firings = evaluateManagerRule(rule, stream, T0 + 6_000, null, TZ, null);
  eq(firings.length, 2);
  eq(firings.map((f) => f.startMs), [T0 + 1_000, T0 + 5_000]);
  eq(firings.every((f) => f.what === "enters" && f.complete === true && f.endMs === f.startMs && f.durationMs === 0), true);

  const leaveRule = baseRule({ condition: { type: "leaves" }, when: "always" });
  const leaves = evaluateManagerRule(leaveRule, stream, T0 + 6_000, null, TZ, null);
  eq(leaves.length, 1);
  eq(leaves[0].startMs, T0 + 4_000);
});

check("the very first transition can never itself be an enter/leave (no known prior state)", () => {
  const rule = baseRule({ condition: { type: "enters" }, when: "always" });
  const stream = transitions(["present", T0]);
  eq(evaluateManagerRule(rule, stream, T0 + 1, null, TZ, null), []);
});

// ---------------------------------------------------------------- absent_longer_than / present_longer_than

check("absent_longer_than fires once, at the exact crossing instant, with duration fixed at the threshold", () => {
  const rule = baseRule({ condition: { type: "absent_longer_than", minutes: 20 }, when: "always" });
  const start = T0;
  const stream = transitions(["present", start - 1_000], ["absent", start]);
  const now = start + 20 * 60_000 + 5_000; // 20 min 5 s later
  const firings = evaluateManagerRule(rule, stream, now, null, TZ, null);
  eq(firings.length, 1);
  eq(firings[0].startMs, start);
  eq(firings[0].endMs, start + 20 * 60_000);
  eq(firings[0].durationMs, 20 * 60_000);
  eq(firings[0].complete, true);

  // FEARED: calling it again with a LATER now must not move the firing's own numbers
  const later = evaluateManagerRule(rule, stream, now + 10 * 60_000, null, TZ, null);
  eq(later.length, 1);
  same(later[0], firings[0]);
});

check("absent_longer_than does not fire before the threshold is crossed", () => {
  const rule = baseRule({ condition: { type: "absent_longer_than", minutes: 20 }, when: "always" });
  const stream = transitions(["present", T0 - 1_000], ["absent", T0]);
  eq(evaluateManagerRule(rule, stream, T0 + 19 * 60_000, null, TZ, null), []);
});

check("FEARED: a not_watching gap inside an absent stretch restarts the clock", () => {
  const rule = baseRule({ condition: { type: "absent_longer_than", minutes: 20 }, when: "always" });
  const stream = transitions(
    ["present", T0 - 1_000],
    ["absent", T0],
    ["not_watching", T0 + 15 * 60_000], // 15 min in: gone before the 20 min threshold
    ["absent", T0 + 16 * 60_000], // clock restarts here
  );
  // 19 minutes after the RESTART: still short of 20
  eq(evaluateManagerRule(rule, stream, T0 + 16 * 60_000 + 19 * 60_000, null, TZ, null), []);
  // 20 minutes after the restart: fires, timed from the restart, not the original start
  const firings = evaluateManagerRule(rule, stream, T0 + 16 * 60_000 + 20 * 60_000, null, TZ, null);
  eq(firings.length, 1);
  eq(firings[0].startMs, T0 + 16 * 60_000);
  eq(firings[0].endMs, T0 + 16 * 60_000 + 20 * 60_000);
});

check("present_longer_than (lingering) mirrors absent_longer_than on the present state", () => {
  const rule = baseRule({ condition: { type: "present_longer_than", minutes: 10 }, when: "always", kind: "person" });
  const stream = transitions(["absent", T0 - 1_000], ["present", T0]);
  eq(evaluateManagerRule(rule, stream, T0 + 9 * 60_000, null, TZ, null), []);
  const firings = evaluateManagerRule(rule, stream, T0 + 10 * 60_000, null, TZ, null);
  eq(firings.length, 1);
  eq(firings[0].what, "present_longer_than");
});

// ---------------------------------------------------------------- away_and_back

check("away_and_back gives the exact duration, firing once at the return", () => {
  const rule = baseRule({ condition: { type: "away_and_back", minMinutes: 5 }, when: "always" });
  const start = T0;
  const end = T0 + 12 * 60_000;
  const stream = transitions(["present", T0 - 1_000], ["absent", start], ["present", end]);
  const firings = evaluateManagerRule(rule, stream, end + 1, null, TZ, null);
  eq(firings.length, 1);
  eq(firings[0].startMs, start);
  eq(firings[0].endMs, end);
  eq(firings[0].durationMs, 12 * 60_000);
  eq(firings[0].complete, true);
});

check("away_and_back under minMinutes never fires, even on a clean return", () => {
  const rule = baseRule({ condition: { type: "away_and_back", minMinutes: 5 }, when: "always" });
  const stream = transitions(["present", T0 - 1_000], ["absent", T0], ["present", T0 + 4 * 60_000]);
  eq(evaluateManagerRule(rule, stream, T0 + 5 * 60_000, null, TZ, null), []);
});

check("FEARED: an away that runs into not_watching before returning is reported as an incomplete record, never a guessed return", () => {
  const rule = baseRule({ condition: { type: "away_and_back", minMinutes: 5 }, when: "always" });
  const departAt = T0;
  const goneAt = T0 + 30 * 60_000; // 30 min later, tracking is lost
  const stream = transitions(
    ["present", T0 - 1_000],
    ["absent", departAt],
    ["not_watching", goneAt],
    ["present", goneAt + 5 * 60_000], // a LATER return -- must NOT be paired with the original departure
  );
  const firings = evaluateManagerRule(rule, stream, goneAt + 6 * 60_000, null, TZ, null);
  eq(firings.length, 1);
  eq(firings[0].complete, false);
  eq(firings[0].startMs, departAt);
  eq(firings[0].endMs, goneAt);
  eq(firings[0].durationMs, null); // never a guessed duration
  eq(firings[0].text.includes("away from"), true);
  eq(firings[0].text.includes("then not watching from"), true);
});

check("a departure that never touched present at its start (came from not_watching) is not a valid away_and_back start", () => {
  const rule = baseRule({ condition: { type: "away_and_back", minMinutes: 5 }, when: "always" });
  const stream = transitions(
    ["not_watching", T0 - 1_000],
    ["absent", T0], // did not depart FROM present
    ["present", T0 + 10 * 60_000],
  );
  eq(evaluateManagerRule(rule, stream, T0 + 11 * 60_000, null, TZ, null), []);
});

// ---------------------------------------------------------------- when: open_hours / closed_hours, across DST

check("FEARED: open_hours and closed_hours follow openHours across a DST day", () => {
  // 2026-11-01 02:00 America/Chicago: CDT (UTC-5) -> CST (UTC-6).
  const rule = baseRule({ condition: { type: "enters" }, when: "open_hours" });
  const closedRule = baseRule({ condition: { type: "enters" }, when: "closed_hours" });
  // Sunday is closed all day in OPEN_HOURS -> "open_hours" never fires, "closed_hours" always does
  const sundayStream = transitions(["absent", z("2026-11-01T06:00:00.000Z") - 1_000], ["present", z("2026-11-01T06:00:00.000Z")]);
  eq(evaluateManagerRule(rule, sundayStream, z("2026-11-01T07:00:00.000Z"), OPEN_HOURS, TZ, null), []);
  eq(evaluateManagerRule(closedRule, sundayStream, z("2026-11-01T07:00:00.000Z"), OPEN_HOURS, TZ, null).length, 1);
  // Monday 2026-11-02: CST now in force. 08:00 local = 14:00Z (open); 21:59 local = 03:59Z next day (open); 22:00 local = 04:00Z (closed)
  const mondayOpen = transitions(["absent", z("2026-11-02T14:00:00.000Z") - 1_000], ["present", z("2026-11-02T14:00:00.000Z")]);
  eq(evaluateManagerRule(rule, mondayOpen, z("2026-11-02T14:00:01.000Z"), OPEN_HOURS, TZ, null).length, 1);
  const mondayClosed = transitions(["absent", z("2026-11-03T04:00:00.000Z") - 1_000], ["present", z("2026-11-03T04:00:00.000Z")]);
  eq(evaluateManagerRule(rule, mondayClosed, z("2026-11-03T04:00:01.000Z"), OPEN_HOURS, TZ, null), []);
  eq(evaluateManagerRule(closedRule, mondayClosed, z("2026-11-03T04:00:01.000Z"), OPEN_HOURS, TZ, null).length, 1);
});

check("FEARED: evaluating an hours-gated rule with no openHours throws rather than guessing", () => {
  const rule = baseRule({ when: "open_hours" });
  const stream = transitions(["present", T0 - 1_000], ["absent", T0]);
  throws(() => evaluateManagerRule(rule, stream, T0 + 21 * 60_000, null, TZ, null), "no openHours");
});

// ---------------------------------------------------------------- cooldown

check("FEARED: absent_longer_than respects the cooldown across separate stretches", () => {
  const rule = baseRule({
    condition: { type: "absent_longer_than", minutes: 5 },
    when: "always",
    notify: { alert: true, report: true, cooldownMinutes: 30 },
  });
  const stream = transitions(
    ["present", T0 - 1_000],
    ["absent", T0], // crosses 5 min at T0+5min
    ["present", T0 + 6 * 60_000],
    ["absent", T0 + 7 * 60_000], // crosses at T0+12min -- inside the 30 min cooldown from the first firing
    ["present", T0 + 13 * 60_000],
    ["absent", T0 + 40 * 60_000], // crosses at T0+45min -- outside the cooldown
  );
  const now = T0 + 46 * 60_000;
  const noCooldown = evaluateManagerRule({ ...rule, notify: { ...rule.notify, cooldownMinutes: 0 } }, stream, now, null, TZ, null);
  eq(noCooldown.length, 3);
  const withCooldown = evaluateManagerRule(rule, stream, now, null, TZ, null);
  eq(withCooldown.length, 2);
  eq(withCooldown.map((f) => f.startMs), [T0, T0 + 40 * 60_000]);
});

check("cooldown is measured from lastFiredAtMs across evaluator calls, not just within one call", () => {
  const rule = baseRule({
    condition: { type: "absent_longer_than", minutes: 5 },
    when: "always",
    notify: { alert: true, report: true, cooldownMinutes: 30 },
  });
  const stream = transitions(["present", T0 - 1_000], ["absent", T0]);
  const now = T0 + 5 * 60_000 + 1;
  // an already-recorded firing 10 minutes ago blocks this one (30 min cooldown)
  eq(evaluateManagerRule(rule, stream, now, null, TZ, now - 10 * 60_000), []);
  // one from 31 minutes ago does not
  eq(evaluateManagerRule(rule, stream, now, null, TZ, now - 31 * 60_000).length, 1);
});

check("FEARED: an evaluator tick immediately after an insert never re-derives its own just-recorded firing, even with cooldownMinutes 0 (every shipped template's default)", () => {
  // Every real evaluator tick feeds back rules.db's own lastFiredAtMs
  // (MAX(end_ms) for this rule) -- for an ONGOING absent stretch that is
  // still absent, this is exactly this rule's own most recent candidate's
  // gateAtMs, unchanged. cooldownMinutes: 0 (the default for every shipped
  // template) must not let that exact repeat slip through the cooldown
  // check on every subsequent 5s tick.
  for (const conditionType of ["absent_longer_than", "present_longer_than"]) {
    const rule = baseRule({
      condition: { type: conditionType, minutes: 20 },
      when: "always",
      notify: { alert: true, report: true, cooldownMinutes: 0 },
    });
    const targetState = conditionType === "absent_longer_than" ? "absent" : "present";
    const otherState = targetState === "absent" ? "present" : "absent";
    const stream = transitions([otherState, T0 - 1_000], [targetState, T0]);
    const nowMs = T0 + 25 * 60_000;
    const tick1 = evaluateManagerRule(rule, stream, nowMs, null, TZ, null);
    eq(tick1.length, 1);
    // Same unchanged occupancy stream, a later `now`, and the FIRST call's own
    // firing fed back as lastFiredAtMs -- exactly agent/api-server.mjs's
    // runManagerRulesEvaluatorPass on its very next timer tick.
    const tick2 = evaluateManagerRule(rule, stream, nowMs + 5_000, null, TZ, tick1[0].endMs);
    eq(tick2, []);
    const tick3 = evaluateManagerRule(rule, stream, nowMs + 10_000, null, TZ, tick1[0].endMs);
    eq(tick3, []);
  }

  // away_and_back: the departure closes (returns to present) once, and the
  // very same closed instant must not re-fire on the next tick either, even
  // though the transitions array never changes.
  const awayRule = baseRule({
    condition: { type: "away_and_back", minMinutes: 5 },
    when: "always",
    notify: { alert: false, report: true, cooldownMinutes: 0 },
  });
  const departAt = T0;
  const returnAt = T0 + 6 * 60_000;
  const awayStream = transitions(["present", T0 - 1_000], ["absent", departAt], ["present", returnAt]);
  const awayTick1 = evaluateManagerRule(awayRule, awayStream, returnAt + 1, null, TZ, null);
  eq(awayTick1.length, 1);
  const awayTick2 = evaluateManagerRule(awayRule, awayStream, returnAt + 5_000, null, TZ, awayTick1[0].endMs);
  eq(awayTick2, []);
});

check("FEARED: renaming a rule does not produce a second, duplicate firing for an event that already fired", () => {
  const stream = transitions(["present", T0 - 1_000], ["absent", T0]);
  const original = baseRule({
    name: "Manager's desk unattended",
    condition: { type: "absent_longer_than", minutes: 20 },
    when: "always",
    notify: { alert: true, report: true, cooldownMinutes: 0 },
  });
  const nowMs = T0 + 25 * 60_000;
  const before = evaluateManagerRule(original, stream, nowMs, null, TZ, null);
  eq(before.length, 1);
  eq(before[0].ruleName, "Manager's desk unattended");
  // Renamed, same id, same UNCHANGED transitions, lastFiredAtMs fed back from
  // the rename's own prior firing -- the real shape of "the manager renames
  // the rule a moment after it fired".
  const renamed = { ...original, name: "Front desk empty" };
  const after = evaluateManagerRule(renamed, stream, nowMs + 5_000, null, TZ, before[0].endMs);
  eq(after, []); // never a second firing for the same already-recorded instant, under either name
});

// ---------------------------------------------------------------- identity-free wording and the name snapshot

check("firing text is identity-free and uses the format from the spec", () => {
  const rule = baseRule({
    id: "r1", name: "Manager's desk unattended", condition: { type: "absent_longer_than", minutes: 45 }, when: "always",
  });
  const start = z("2026-07-15T19:10:00.000Z"); // 14:10 America/Chicago (CDT)
  const stream = transitions(["present", start - 1_000], ["absent", start]);
  const firings = evaluateManagerRule(rule, stream, start + 46 * 60_000, null, TZ, null);
  eq(firings.length, 1);
  eq(firings[0].text, "Manager's desk unattended 14:10-14:55 (45 min)");
  // never contains anything that looks like a person's name -- there is no field for one
  eq(Object.keys(rule).includes("personName"), false);
});

check("FEARED: firings carry a snapshot of the rule's name -- renaming the rule does not touch a firing already produced", () => {
  const stream = transitions(["present", T0 - 1_000], ["absent", T0]);
  const original = baseRule({ name: "Manager's desk unattended", condition: { type: "absent_longer_than", minutes: 5 }, when: "always" });
  const before = evaluateManagerRule(original, stream, T0 + 5 * 60_000, null, TZ, null);
  eq(before[0].ruleName, "Manager's desk unattended");
  // the SAME rule id, renamed -- re-evaluating with the new object naturally
  // reflects the new name for any NEWLY qualifying firing (this file is
  // stateless); it is the caller's job (rules.db) to never overwrite an
  // already-stored firing's snapshot with a fresh call's answer.
  const renamed = { ...original, name: "Front desk unattended" };
  const after = evaluateManagerRule(renamed, stream, T0 + 5 * 60_000, null, TZ, null);
  eq(after[0].ruleName, "Front desk unattended");
  eq(before[0].ruleName, "Manager's desk unattended"); // the earlier array is untouched
});

// ---------------------------------------------------------------- alert/report follow the rule

check("alertWanted and reportWanted follow the rule's own notify flags; an incomplete away_and_back never wants an alert", () => {
  const alertOff = baseRule({ condition: { type: "away_and_back", minMinutes: 5 }, when: "always", notify: { alert: true, report: true, cooldownMinutes: 0 } });
  const departAt = T0;
  const goneAt = T0 + 10 * 60_000;
  const stream = transitions(["present", T0 - 1_000], ["absent", departAt], ["not_watching", goneAt]);
  const firings = evaluateManagerRule(alertOff, stream, goneAt + 1, null, TZ, null);
  eq(firings.length, 1);
  eq(firings[0].alertWanted, false); // incomplete: never alerts, whatever notify.alert says
  eq(firings[0].reportWanted, true); // still reported, per the spec's wording example

  const reportOnly = baseRule({ condition: { type: "enters" }, when: "always", notify: { alert: false, report: true, cooldownMinutes: 0 } });
  const enterStream = transitions(["absent", T0 - 1_000], ["present", T0]);
  const f2 = evaluateManagerRule(reportOnly, enterStream, T0 + 1, null, TZ, null);
  eq(f2[0].alertWanted, false);
  eq(f2[0].reportWanted, true);
});

// ---------------------------------------------------------------- appearance-based: "Manager leaves" / "Manager returns"
// (contracts/appearance.ts's matchAppearance sightings, never occupancy —
// deriveManagerLeaveEpisodes is the ONE piece of shared machinery both
// evaluators read, so the two templates can never disagree about which
// departure they are each describing.)

const L0 = z("2026-07-20T19:00:00.000Z"); // 14:00 America/Chicago (CDT), well inside OPEN_HOURS

function sighting(atMs, similarityPercent = 90, which = "primary") {
  return { atMs, which, similarityPercent };
}

const leavesRule = (over = {}) => baseRule({
  template: "manager_leaves",
  name: "Manager leaves",
  areaId: "back-door",
  condition: { type: "manager_leaves", awayMinutes: 5 },
  when: "open_hours",
  notify: { alert: true, report: true, cooldownMinutes: 0 },
  ...over,
});

const returnsRule = (over = {}) => baseRule({
  template: "manager_returns",
  name: "Manager returns",
  areaId: "back-door",
  condition: { type: "manager_returns", awayMinutes: 5 },
  when: "open_hours",
  notify: { alert: false, report: true, cooldownMinutes: 0 },
  ...over,
});

check("deriveManagerLeaveEpisodes: no desk sighting within awayMinutes confirms a leave, still open (no return yet)", () => {
  const episodes = deriveManagerLeaveEpisodes([sighting(L0, 91)], [], 5);
  eq(episodes.length, 1);
  eq(episodes[0].departAtMs, L0);
  eq(episodes[0].confirmedLeaveAtMs, L0 + 5 * 60_000);
  eq(episodes[0].returnAtMs, null);
  eq(episodes[0].returnSimilarityPercent, null);
});

check("FEARED: a desk sighting before awayMinutes elapses cancels the departure outright -- never reported at all", () => {
  const door = [sighting(L0, 91)];
  const desk = [sighting(L0 + 2 * 60_000, 95)]; // back at the desk after only 2 minutes
  eq(deriveManagerLeaveEpisodes(door, desk, 5), []);
});

check("a desk sighting at or after awayMinutes confirms AND closes the episode as the return", () => {
  const door = [sighting(L0, 88)];
  const desk = [sighting(L0 + 12 * 60_000, 93)];
  const episodes = deriveManagerLeaveEpisodes(door, desk, 5);
  eq(episodes.length, 1);
  eq(episodes[0].confirmedLeaveAtMs, L0 + 5 * 60_000);
  eq(episodes[0].returnAtMs, L0 + 12 * 60_000);
  eq(episodes[0].returnSimilarityPercent, 93);
});

check("a burst of door sightings before the desk gap resolves is ONE episode, starting at the FIRST sighting", () => {
  const door = [sighting(L0, 85), sighting(L0 + 30_000, 90), sighting(L0 + 60_000, 92)];
  const desk = [sighting(L0 + 20 * 60_000, 91)];
  const episodes = deriveManagerLeaveEpisodes(door, desk, 5);
  eq(episodes.length, 1);
  eq(episodes[0].departAtMs, L0);
  eq(episodes[0].departSimilarityPercent, 85);
});

check("after a completed episode, a later door sighting starts a fresh one", () => {
  const door = [sighting(L0, 85), sighting(L0 + 60 * 60_000, 87)];
  const desk = [sighting(L0 + 10 * 60_000, 90)];
  const episodes = deriveManagerLeaveEpisodes(door, desk, 5);
  eq(episodes.length, 2);
  eq(episodes[0].returnAtMs, L0 + 10 * 60_000);
  eq(episodes[1].departAtMs, L0 + 60 * 60_000);
  eq(episodes[1].returnAtMs, null);
});

check("evaluateManagerLeavesRule/evaluateManagerReturnsRule throw when handed a rule of the wrong condition type", () => {
  throws(() => evaluateManagerLeavesRule(returnsRule(), [], [], "Back door", L0, OPEN_HOURS, TZ, null), "leaves given a returns rule");
  throws(() => evaluateManagerReturnsRule(leavesRule(), [], [], "Manager's desk", L0, OPEN_HOURS, TZ, null), "returns given a leaves rule");
});

check("evaluateManagerLeavesRule does not fire before the confirmation instant, and fires at it with identity-free, rounded wording", () => {
  const rule = leavesRule();
  const door = [sighting(L0, 86.4)];
  eq(evaluateManagerLeavesRule(rule, door, [], "Back door", L0 + 4 * 60_000, OPEN_HOURS, TZ, null), []);
  const firings = evaluateManagerLeavesRule(rule, door, [], "Back door", L0 + 5 * 60_000 + 1, OPEN_HOURS, TZ, null);
  eq(firings.length, 1);
  eq(firings[0].what, "manager_leaves");
  eq(firings[0].startMs, L0);
  eq(firings[0].endMs, L0 + 5 * 60_000);
  eq(firings[0].durationMs, 5 * 60_000);
  eq(firings[0].text, "Person matching today's manager (86%) left through Back door 14:00");
  eq(firings[0].alertWanted, true);
  eq(firings[0].reportWanted, true);
  eq(firings[0].text.toLowerCase().includes("manager"), true);
  // identity-free: no field anywhere carries a name
  eq(Object.keys(firings[0]).includes("personName"), false);
});

check("evaluateManagerLeavesRule: a cancelled departure (desk sighting too soon) never fires, even long after", () => {
  const rule = leavesRule();
  const door = [sighting(L0, 90)];
  const desk = [sighting(L0 + 2 * 60_000, 95)];
  eq(evaluateManagerLeavesRule(rule, door, desk, "Back door", L0 + 60 * 60_000, OPEN_HOURS, TZ, null), []);
});

check("evaluateManagerReturnsRule fires once the manager is back, with the duration measured from the ORIGINAL departure", () => {
  const rule = returnsRule();
  const door = [sighting(L0, 89.6)];
  const desk = [sighting(L0 + 45 * 60_000, 91.2)];
  // still away: nothing to report
  eq(evaluateManagerReturnsRule(rule, door, [], "Manager's desk", L0 + 30 * 60_000, OPEN_HOURS, TZ, null), []);
  const firings = evaluateManagerReturnsRule(rule, door, desk, "Manager's desk", L0 + 45 * 60_000 + 1, OPEN_HOURS, TZ, null);
  eq(firings.length, 1);
  eq(firings[0].what, "manager_returns");
  eq(firings[0].startMs, L0);
  eq(firings[0].endMs, L0 + 45 * 60_000);
  eq(firings[0].durationMs, 45 * 60_000);
  eq(firings[0].text, "Person matching today's manager (91%) matched back at Manager's desk 14:45 (45 min)");
  eq(firings[0].alertWanted, false); // this template's own notify.alert is off
  eq(firings[0].reportWanted, true);
});

check("evaluateManagerReturnsRule never fires for a cancelled (too-soon) departure", () => {
  const rule = returnsRule();
  const door = [sighting(L0, 90)];
  const desk = [sighting(L0 + 2 * 60_000, 95)]; // cancels the departure at the SAME instant it would otherwise "return"
  eq(evaluateManagerReturnsRule(rule, door, desk, "Manager's desk", L0 + 60 * 60_000, OPEN_HOURS, TZ, null), []);
});

check("both templates respect when: open_hours, and cooldown/lastFiredAtMs the same way the occupancy evaluator does", () => {
  // Sunday is closed all day in OPEN_HOURS.
  const sunday = z("2026-07-19T13:00:00.000Z");
  const rule = leavesRule();
  eq(evaluateManagerLeavesRule(rule, [sighting(sunday, 90)], [], "Back door", sunday + 6 * 60_000, OPEN_HOURS, TZ, null), []);

  const cooldownRule = leavesRule({ notify: { alert: true, report: true, cooldownMinutes: 30 } });
  const door = [sighting(L0, 90), sighting(L0 + 10 * 60_000, 90)];
  const desk = [sighting(L0 + 6 * 60_000, 95)]; // closes the FIRST departure as a genuine return
  const firstFirings = evaluateManagerLeavesRule(cooldownRule, [door[0]], desk, "Back door", L0 + 5 * 60_000 + 1, OPEN_HOURS, TZ, null);
  eq(firstFirings.length, 1);
  // The second departure confirms only 10 minutes after the first firing: inside the 30 min cooldown.
  const secondFirings = evaluateManagerLeavesRule(cooldownRule, door, desk, "Back door", L0 + 20 * 60_000, OPEN_HOURS, TZ, firstFirings[0].endMs);
  eq(secondFirings, []);
});

report("manager rules");
