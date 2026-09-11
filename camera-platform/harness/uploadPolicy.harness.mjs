/** Which detections become timeline events. Clips are never copied to the cloud —
 *  a marker points into the recording already on the appliance.
 *
 *  The failure feared: a car wash generating vehicle detections all day, turning
 *  the timeline into a solid stripe in which the one event anybody wanted is
 *  invisible. */
import { decideUpload, projectedMonthlyBytes, DEFAULT_POLICY } from "../dist/uploadPolicy.js";
import { check, eq, report } from "./_assert.mjs";

console.log("upload policy");

const CLIP = 9_400_000;   // a 30s span, for budget arithmetic only — not uploaded
const hours = { openMinute: 7 * 60, closeMinute: 20 * 60, utcOffsetMinutes: -5 * 60 };
const carwash = { siteKind: "carwash", hours, ...DEFAULT_POLICY.carwash };
const storage = { siteKind: "storage", hours, ...DEFAULT_POLICY.storage };
const budget = (over = {}) => ({
  spentTodayBytes: 0, dailyBudgetBytes: 200 * CLIP,
  spentMonthBytes: 0, monthlyBudgetBytes: 3000 * CLIP,
  lastUploadMs: {}, ...over,
});
// 14:00 and 02:00 local, given a -5h offset.
const at = (localHour) => new Date(Date.UTC(2026, 8, 11, localHour + 5, 0, 0)).toISOString();
const cand = (over = {}) => ({
  cameraId: "cam-1", atUtc: at(14), kind: "vehicle", confidence: 0.9, estimatedBytes: CLIP, ...over,
});

check("THE FEARED ONE: a car at a car wash at 2pm is not an event", () => {
  const d = decideUpload(cand(), carwash, budget());
  eq(d.kind, "index_only", "indexed locally, not uploaded");
  if (!d.reason.includes("the business")) throw new Error("reason should say why");
});

check("the same car at 2am is exactly why the cameras are there", () => {
  const d = decideUpload(cand({ atUtc: at(2) }), carwash, budget());
  eq(d.kind, "upload", "uploaded");
  eq(d.priority, 70, "high priority");
});

check("a person after hours outranks everything except an alarm", () => {
  const person = decideUpload(cand({ atUtc: at(2), kind: "person" }), carwash, budget());
  const vehicle = decideUpload(cand({ atUtc: at(2), kind: "vehicle" }), carwash, budget());
  if (person.priority <= vehicle.priority) throw new Error("a person at 2am should outrank a vehicle");
});

check("daytime motion never earns a cloud copy", () => {
  eq(decideUpload(cand({ kind: "motion" }), carwash, budget()).kind, "index_only", "car wash");
  eq(decideUpload(cand({ kind: "motion" }), storage, budget()).kind, "index_only", "storage too");
});

check("a plate at the gate is worth uploading even during business hours", () => {
  const d = decideUpload(cand({ kind: "plate" }), carwash, budget());
  eq(d.kind, "upload", "plates matter by day at a car wash");
});

check("storage treats a daytime vehicle differently from a car wash", () => {
  eq(decideUpload(cand(), storage, budget()).kind, "upload", "unusual at a storage site");
  eq(decideUpload(cand(), carwash, budget()).kind, "index_only", "routine at a car wash");
});

check("cooldown stops one car triggering forty clips", () => {
  const first = at(2);
  const b = budget({ lastUploadMs: { "cam-1|vehicle": Date.parse(first) } });
  const soon = new Date(Date.parse(first) + 60_000).toISOString();
  eq(decideUpload(cand({ atUtc: soon }), carwash, b).kind, "index_only", "60s later, still cooling down");
  const later = new Date(Date.parse(first) + 400_000).toISOString();
  eq(decideUpload(cand({ atUtc: later }), carwash, b).kind, "upload", "after the cooldown, uploaded");
});

check("low confidence is indexed, not uploaded", () => {
  eq(decideUpload(cand({ atUtc: at(2), confidence: 0.4 }), carwash, budget()).kind, "index_only", "weak detection");
});

check("THE FEARED ONE: an exhausted budget is recorded, never silently dropped", () => {
  const b = budget({ spentTodayBytes: 200 * CLIP });
  const d = decideUpload(cand({ atUtc: at(2) }), carwash, b);
  eq(d.kind, "budget_exhausted", "reported as a decision");
  eq(d.spentBytes, 200 * CLIP, "says how much was spent");
  eq(d.budgetBytes, 200 * CLIP, "and what the budget was");
});

check("THE FEARED ONE: an alarm bypasses the budget entirely", () => {
  const b = budget({ spentTodayBytes: 999 * CLIP, spentMonthBytes: 99_999 * CLIP });
  const d = decideUpload(cand({ atUtc: at(14), alarm: true }), carwash, b);
  eq(d.kind, "upload", "uploaded regardless");
  eq(d.bypassedBudget, true, "explicitly flagged");
  eq(d.priority, 100, "top priority");
});

check("an alarm during business hours still bypasses — tamper does not wait for closing", () => {
  const d = decideUpload(cand({ atUtc: at(14), kind: "motion", confidence: 0.1, alarm: true }), carwash, budget());
  eq(d.kind, "upload", "even low-confidence daytime motion, if the alarm fired");
});

check("the monthly budget catches what the daily one lets through", () => {
  const b = budget({ spentMonthBytes: 3000 * CLIP });
  eq(decideUpload(cand({ atUtc: at(2) }), carwash, b).kind, "budget_exhausted", "monthly cap holds");
});

check("overnight opening hours crossing midnight are handled", () => {
  const nightShift = { siteKind: "storage", hours: { openMinute: 22 * 60, closeMinute: 6 * 60, utcOffsetMinutes: -5 * 60 }, ...DEFAULT_POLICY.storage };
  const during = decideUpload(cand({ atUtc: at(23), kind: "motion" }), nightShift, budget());
  eq(during.kind, "index_only", "23:00 counts as open, so motion is routine");
  const outside = decideUpload(cand({ atUtc: at(12), kind: "motion" }), nightShift, budget());
  eq(outside.kind, "upload", "midday counts as closed for a night-shift site");
});

check("projection sizes a budget before anyone is surprised by a bill", () => {
  eq(projectedMonthlyBytes(30, CLIP) / 1e9, 8.46, "30/day is 8.5 GB/month");
  const runaway = projectedMonthlyBytes(3000, CLIP) / 1e9;
  if (runaway < 800) throw new Error("unfiltered car wash volume should be enormous");
});

report("upload policy");
