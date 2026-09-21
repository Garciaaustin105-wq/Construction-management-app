/**
 * D2: asking the events database for one camera's events in a window
 * (agent/events-db.mjs, inRange), and carrying the species field a caller
 * can search for ("show me all the events of a white truck").
 *
 * THE FEARED FAILURES: a busy day of cars burying the one person (or the one
 * truck) who walked past, because the row limit was spent before the filter
 * ran; an answer cut short without saying so, so half a day reads as the
 * whole of it; an event that straddles midnight belonging to neither day;
 * a species stored as the string "null" instead of being simply absent; and
 * the one that matters most here - a real, already-populated database from
 * before this column existed failing every write the moment species is added,
 * because `CREATE TABLE IF NOT EXISTS` does nothing to a table that already
 * exists.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEventsDb } from "../agent/events-db.mjs";
import { check, mustAwait, eq, report } from "./_assert.mjs";

console.log("events db");

const iso = (ms) => new Date(ms).toISOString();
const DAY = Date.parse("2026-09-18T00:00:00.000Z");
const DAY_END = DAY + 24 * 3600_000;

function dbWith(events) {
  const db = openEventsDb(":memory:");
  for (const e of events) db.upsert({ id: e.id, event: e }, true);
  return db;
}

function ev(id, kind, atMs, lengthMs = 5000, cameraId = "cam1", species) {
  const event = {
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
  if (species !== undefined) event.species = species;
  return event;
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

check("species round-trips through upsert and back", () => {
  const db = dbWith([ev("t1", "vehicle", DAY + 3600_000, 5000, "cam1", "truck")]);
  const [event] = db.all();
  eq(event.species, "truck", "the species made it to storage and back");
  eq(db.getById("t1").species, "truck", "and back by id too");
  eq(
    db.inRange("cam1", iso(DAY), iso(DAY_END), null, 100).events[0].species,
    "truck",
    "and back through inRange",
  );
  db.close();
});

check("an event with no species comes back with the field absent, not null", () => {
  const db = dbWith([ev("noSpecies", "person", DAY + 3600_000)]);
  const [event] = db.all();
  eq(event.species, undefined, "no species key at all");
  eq(Object.prototype.hasOwnProperty.call(event, "species"), false, "hasOwnProperty says the same");
  eq(JSON.stringify(event).includes("null"), false, "and it is not the string \"null\" either");
  db.close();
});

await mustAwait("THE FEARED ONE: an old database with no species column opens, migrates, and keeps every row", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "camplat-eventsdb-"));
  const file = path.join(dir, "events.db");
  try {
    // Build the pre-species schema by hand - exactly what SCHEMA looked like
    // before this column existed - and put real rows in it, the way thousands
    // of rows already sit on a real appliance.
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        camera_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        first_ms INTEGER NOT NULL,
        last_ms INTEGER NOT NULL,
        count INTEGER NOT NULL,
        best_confidence REAL NOT NULL,
        best_x REAL,
        best_y REAL,
        best_w REAL,
        best_h REAL,
        best_ms INTEGER NOT NULL,
        plate TEXT,
        finished INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_events_camera_first ON events(camera_id, first_ms);
    `);
    const insert = legacy.prepare(`
      INSERT INTO events (id, camera_id, kind, first_ms, last_ms, count, best_confidence, best_x, best_y, best_w, best_h, best_ms, plate, finished)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("old1", "cam1", "person", DAY, DAY + 5000, 4, 0.8, 0.1, 0.1, 0.2, 0.4, DAY, null, 1);
    insert.run("old2", "cam1", "vehicle", DAY + 1000, DAY + 6000, 7, 0.7, 0.1, 0.1, 0.2, 0.4, DAY + 1000, null, 1);
    legacy.close();

    // Open it the normal way. This must not throw, must add the column, and
    // must not lose or corrupt the rows that were already there.
    const db = openEventsDb(file);
    const all = db.all();
    eq(all.length, 2, "both pre-existing rows survived the migration");
    eq(all.map((e) => e.id), ["old1", "old2"], "in their original order");
    eq(all.every((e) => !Object.prototype.hasOwnProperty.call(e, "species")), true, "old rows have no species field");

    // And the migrated database is fully usable: a new write naming species
    // does not fail, and querying by it works.
    db.upsert({ id: "new1", event: ev("new1", "vehicle", DAY + 2000, 5000, "cam1", "truck") }, true);
    const found = db.inRange("cam1", iso(DAY), iso(DAY_END), null, 100, ["truck"]);
    eq(found.events.map((e) => e.id), ["new1"], "a species written after migration is queryable");
    eq(found.events[0].species, "truck", "with the field itself present");
    db.close();

    // Confirm the column itself now exists, on its own short-lived connection
    // so it releases its lock before the temp directory is removed below.
    const inspect = new DatabaseSync(file);
    const columns = inspect.prepare("PRAGMA table_info(events)").all();
    inspect.close();
    eq(columns.some((c) => c.name === "species"), true, "the column now exists");
  } finally {
    // WAL mode leaves -wal/-shm files that only release their lock once the
    // connection that opened them is closed; rm runs after every connection
    // above has been closed.
    await rm(dir, { recursive: true, force: true });
  }
});

check("filtering by species returns only that species", () => {
  const db = dbWith([
    ev("c1", "vehicle", DAY + 3600_000, 5000, "cam1", "car"),
    ev("t1", "vehicle", DAY + 2 * 3600_000, 5000, "cam1", "truck"),
    ev("b1", "vehicle", DAY + 3 * 3600_000, 5000, "cam1", "bus"),
    ev("p1", "person", DAY + 4 * 3600_000, 5000, "cam1", "person"),
  ]);
  const ids = (species) => db.inRange("cam1", iso(DAY), iso(DAY_END), null, 100, species).events.map((e) => e.id);
  eq(ids(["truck"]), ["t1"], "only the truck");
  eq(ids(["car", "truck"]), ["c1", "t1"], "several species");
  eq(ids(null), ["c1", "t1", "b1", "p1"], "no species filter is everything");
  eq(ids([]), [], "an empty species list means nothing, same as kinds");
  db.close();
});

check("THE FEARED ONE: the species filter runs in the query, not after the limit", () => {
  const many = [];
  for (let i = 0; i < 600; i++) many.push(ev(`car${i}`, "vehicle", DAY + i * 60_000, 5000, "cam1", "car"));
  many.push(ev("theTruck", "vehicle", DAY + 23 * 3600_000, 5000, "cam1", "truck"));
  const db = dbWith(many);
  const out = db.inRange("cam1", iso(DAY), iso(DAY_END), null, 500, ["truck"]);
  eq(out.events.map((e) => e.id), ["theTruck"], "the species filter runs in the query, not after the limit");
  eq(out.truncated, false, "and one truck is not a truncated answer");
  db.close();
});

report("events db");
