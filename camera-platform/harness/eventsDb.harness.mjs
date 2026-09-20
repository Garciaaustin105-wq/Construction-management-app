/**
 * D2: asking the events database for one camera's events in a window
 * (agent/events-db.mjs, inRange).
 *
 * THE FEARED FAILURES: a busy day of cars burying the one person who walked
 * past, because the row limit was spent before the filter ran; an answer cut
 * short without saying so, so half a day reads as the whole of it; an event
 * that straddles midnight belonging to neither day.
 */
import { openEventsDb } from "../agent/events-db.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("events db");

const iso = (ms) => new Date(ms).toISOString();
const DAY = Date.parse("2026-09-18T00:00:00.000Z");
const DAY_END = DAY + 24 * 3600_000;

function dbWith(events) {
  const db = openEventsDb(":memory:");
  for (const e of events) db.upsert({ id: e.id, event: e }, true);
  return db;
}

function ev(id, kind, atMs, lengthMs = 5000, cameraId = "cam1") {
  return {
    id,
    cameraId,
    kind,
    firstUtc: iso(atMs),
    lastUtc: iso(atMs + lengthMs),
    count: 10,
    bestConfidence: 0.9,
    bestBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 },
    bestUtc: iso(atMs),
  };
}

check("a window comes back oldest first, and only for the camera asked about", () => {
  const db = dbWith([
    ev("b", "person", DAY + 2 * 3600_000),
    ev("a", "vehicle", DAY + 1 * 3600_000),
    ev("other", "person", DAY + 90 * 60_000, 5000, "cam2"),
  ]);
  const out = db.inRange("cam1", iso(DAY), iso(DAY_END), null, 100);
  eq(out.events.map((e) => e.id), ["a", "b"], "in time order, cam1 only");
  eq(out.truncated, false, "nothing was cut");
  eq(out.events[0].kind, "vehicle", "kinds survive the trip");
  eq(out.events[0].bestBox, { x: 0.1, y: 0.1, w: 0.2, h: 0.4 }, "and so does the box");
  db.close();
});

check("THE FEARED ONE: one person among six hundred cars is still found", () => {
  const many = [];
  for (let i = 0; i < 600; i++) many.push(ev(`car${i}`, "vehicle", DAY + i * 60_000));
  many.push(ev("thePerson", "person", DAY + 23 * 3600_000));
  const db = dbWith(many);
  const out = db.inRange("cam1", iso(DAY), iso(DAY_END), ["person"], 500);
  eq(out.events.map((e) => e.id), ["thePerson"], "the filter runs in the query, not after the limit");
  eq(out.truncated, false, "and one person is not a truncated answer");
  db.close();
});

check("an answer cut short by the limit says so", () => {
  const many = [];
  for (let i = 0; i < 12; i++) many.push(ev(`e${i}`, "person", DAY + i * 60_000));
  const db = dbWith(many);
  const out = db.inRange("cam1", iso(DAY), iso(DAY_END), null, 10);
  eq(out.events.length, 10, "ten back");
  eq(out.truncated, true, "and it admits there are more");
  eq(db.inRange("cam1", iso(DAY), iso(DAY_END), null, 12).truncated, false, "exactly the limit is not truncated");
  db.close();
});

check("an event that straddles the edge belongs to both windows, not to neither", () => {
  const db = dbWith([ev("midnight", "person", DAY - 60_000, 120_000)]);   // 23:59 to 00:01
  eq(db.inRange("cam1", iso(DAY), iso(DAY_END), null, 10).events.length, 1, "the new day sees it");
  eq(db.inRange("cam1", iso(DAY - 86_400_000), iso(DAY), null, 10).events.length, 1, "the old day too");
  eq(db.inRange("cam1", iso(DAY + 3600_000), iso(DAY_END), null, 10).events.length, 0, "a later window does not");
  db.close();
});

check("filters: several kinds, and an empty list means nothing rather than everything", () => {
  const db = dbWith([
    ev("p", "person", DAY + 3600_000),
    ev("v", "vehicle", DAY + 2 * 3600_000),
    ev("l", "plate", DAY + 3 * 3600_000),
  ]);
  const ids = (kinds) => db.inRange("cam1", iso(DAY), iso(DAY_END), kinds, 100).events.map((e) => e.id);
  eq(ids(["person", "vehicle"]), ["p", "v"], "two kinds");
  eq(ids(["vehicle", "person"]), ["p", "v"], "the order asked in does not change the answer");
  eq(ids(null), ["p", "v", "l"], "no filter is every kind");
  eq(ids([]), [], "THE FEARED ONE: every box unticked shows nothing, not everything");
  db.close();
});

report("events db");
