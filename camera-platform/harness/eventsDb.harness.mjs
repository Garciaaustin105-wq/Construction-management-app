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
 *
 * Known objects (travel, suppressed_by) add their own: the live database's
 * thousands of old rows coming out of the migration with travel 0 - "never
 * moved", the one value that lets an event be learned and hidden - instead
 * of NULL, unknown; an old-style upsert quietly un-hiding (or hiding) an
 * event it said nothing about; six hundred hidden umbrellas spending the
 * page's limit so the one real person that evening never comes back; a
 * hidden count taken from the page instead of the window, so "500 hidden"
 * when there were 600; learning handed the oldest events when the newest
 * are the ones in view; and a reset by hand showing another object's events.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEventsDb, HIDDEN_MODES } from "../agent/events-db.mjs";
import { check, mustAwait, eq, throws, report } from "./_assert.mjs";

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

/** Open a fresh temp directory, run `fn(file)`, and always remove it after. */
async function withTempDb(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "camplat-eventsdb-"));
  try {
    await fn(path.join(dir, "events.db"));
  } finally {
    // WAL mode leaves -wal/-shm files that only release their lock once the
    // connection that opened them is closed; rm runs after every connection
    // the check opened has been closed.
    await rm(dir, { recursive: true, force: true });
  }
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
  // Not the whole event: travel and suppressedBy are null ON PURPOSE (see
  // rowToEvent) - it is species that must not appear, as "null" or at all.
  eq(JSON.stringify(event).includes("\"species\""), false, "and it is not the string \"null\" either");
  db.close();
});

await mustAwait("THE FEARED ONE: an old database with no species column opens, migrates, and keeps every row", async () => {
  await withTempDb(async (file) => {
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
    // Two schemas back is still a valid starting point: every later column
    // arrives in the same open, each old row unknown rather than zero.
    eq(all.map((e) => [e.travel, e.suppressedBy]), [[null, null], [null, null]], "old rows: travel unknown, nothing hidden");

    // And the migrated database is fully usable: a new write naming species
    // does not fail, and querying by it works.
    db.upsert({ id: "new1", event: ev("new1", "vehicle", DAY + 2000, 5000, "cam1", "truck") }, true);
    const found = db.inRange("cam1", iso(DAY), iso(DAY_END), null, 100, ["truck"]);
    eq(found.events.map((e) => e.id), ["new1"], "a species written after migration is queryable");
    eq(found.events[0].species, "truck", "with the field itself present");
    db.close();

    // Confirm the columns themselves now exist, on their own short-lived
    // connection so it releases its lock before the temp directory goes.
    const inspect = new DatabaseSync(file);
    const columns = inspect.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
    inspect.close();
    eq(["species", "travel", "suppressed_by"].every((c) => columns.includes(c)), true, "the columns now exist");
  });
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

// ---------- known objects: travel and suppressed_by ----------

/**
 * The live appliance's schema on 2026-09-22, the day these two columns were
 * added: species present, travel and suppressed_by not. Written out by hand,
 * not taken from events-db.mjs, so a change there cannot quietly change what
 * "the old database" means here.
 */
const SCHEMA_BEFORE_KNOWN_OBJECTS = `
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
    species TEXT,
    finished INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_events_camera_first ON events(camera_id, first_ms);
`;

await mustAwait("THE FEARED ONE: the live database - thousands of rows, no travel, no suppressed_by - migrates with every old row's travel NULL, never 0", async () => {
  await withTempDb(async (file) => {
    // Three thousand rows made by the OLD schema, the way the bench box's
    // events.db holds them: two cameras, people and vehicles, some with a
    // species, the last one still open (a detector mid-event at upgrade).
    const OLD_ROWS = 3000;
    const legacy = new DatabaseSync(file);
    legacy.exec("PRAGMA journal_mode = WAL");
    legacy.exec(SCHEMA_BEFORE_KNOWN_OBJECTS);
    const insert = legacy.prepare(`
      INSERT INTO events (id, camera_id, kind, first_ms, last_ms, count, best_confidence, best_x, best_y, best_w, best_h, best_ms, plate, species, finished)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    legacy.exec("BEGIN");
    for (let i = 0; i < OLD_ROWS; i++) {
      const at = DAY + i * 20_000;
      const vehicle = i % 3 === 0;
      insert.run(
        `old${String(i).padStart(4, "0")}`, i % 2 === 1 ? "cam1" : "cam2", vehicle ? "vehicle" : "person",
        at, at + 5000, 3, 0.6, 0.7, 0.36, 0.09, 0.42, at, null, vehicle ? "car" : null,
        i === OLD_ROWS - 1 ? 0 : 1,
      );
    }
    legacy.exec("COMMIT");
    legacy.close();

    const db = openEventsDb(file);
    const all = db.all();
    eq(all.length, OLD_ROWS, "every old row survived");
    eq(all.filter((e) => e.travel === 0).length, 0, "THE FEARED ONE: not one old row reads as 'did not move'");
    eq(all.filter((e) => e.travel !== null).length, 0, "every old row's travel is unknown (null)");
    eq(all.filter((e) => e.suppressedBy !== null).length, 0, "no old row is hidden");
    eq(all.filter((e) => e.species === "car").length, OLD_ROWS / 3, "species kept where there was one");
    eq(all.filter((e) => Object.hasOwn(e, "species")).length, OLD_ROWS / 3, "and still absent where there was not");

    // What the page sees by default: every old event, and nothing counted
    // as hidden (a migration that defaulted the flag to '' would hide them all).
    const day = db.inRange("cam1", iso(DAY), iso(DAY_END), null, OLD_ROWS, null, { hidden: "exclude" });
    eq([day.events.length, day.hiddenCount, day.truncated], [OLD_ROWS / 2, 0, false], "the page still shows every old cam1 event");

    // What the learner sees: the finished old rows, each with travel null,
    // so it can say "travel_unknown" about them rather than learn from them.
    const recent = db.recentFinished(iso(DAY), OLD_ROWS);
    eq(recent.events.length, OLD_ROWS - 1, "every finished old row is there to be considered (the open one is not)");
    eq(recent.events.every((e) => e.travel === null), true, "and every one of them says its travel is unknown");

    // Writes naming the new columns work on the migrated file - a brand-new
    // event, and the one old event still open, finished after the upgrade.
    db.upsert({ id: "new1", event: { ...ev("new1", "person", DAY + 3600_000), travel: 0.12 } }, true, { suppressedBy: "cam1:person:1" });
    eq([db.getById("new1").travel, db.getById("new1").suppressedBy], [0.12, "cam1:person:1"], "a new event with travel and a flag");
    const lastOld = db.getById(`old${OLD_ROWS - 1}`);
    db.upsert({ id: lastOld.id, event: { ...lastOld, count: 4, travel: 0.3 } }, true);
    eq([db.getById(lastOld.id).travel, db.getById(lastOld.id).finished], [0.3, true], "the old open event takes its travel when next updated");
    db.close();

    // Ask sqlite itself, not rowToEvent: the stored value is a real NULL,
    // not a 0.0 or a "null" that the reader happens to dress up.
    const raw = new DatabaseSync(file);
    const travelTypes = raw.prepare("SELECT typeof(travel) AS t, COUNT(*) AS n FROM events WHERE id LIKE 'old%' GROUP BY t ORDER BY t").all();
    const flagTypes = raw.prepare("SELECT typeof(suppressed_by) AS t, COUNT(*) AS n FROM events WHERE id LIKE 'old%' GROUP BY t").all();
    const columnCount = raw.prepare("PRAGMA table_info(events)").all().length;
    raw.close();
    eq(travelTypes.map((r) => [r.t, r.n]), [["null", OLD_ROWS - 1], ["real", 1]], "sqlite: old travel is NULL (only the updated one is real)");
    eq(flagTypes.map((r) => [r.t, r.n]), [["null", OLD_ROWS]], "sqlite: old suppressed_by is NULL");

    // A second open is a no-op: no column added twice, no row touched.
    const again = openEventsDb(file);
    eq(again.all().length, OLD_ROWS + 1, "reopened: the same rows");
    again.close();
    const inspect = new DatabaseSync(file);
    eq(inspect.prepare("PRAGMA table_info(events)").all().length, columnCount, "reopened: the same columns");
    inspect.close();
  });
});

check("upsert: suppressedBy left out keeps the flag, null clears it, a string sets it", () => {
  const db = openEventsDb(":memory:");
  const e = { ...ev("u1", "person", DAY + 3600_000), travel: 0.1 };
  const flag = () => db.getById("u1").suppressedBy;

  db.upsert({ id: "u1", event: e }, false);
  eq(flag(), null, "a new row with nothing said starts shown");
  db.upsert({ id: "u1", event: e }, false, { suppressedBy: "obj-A" });
  eq(flag(), "obj-A", "a string hides it");

  db.upsert({ id: "u1", event: { ...e, count: 11 } }, false);
  eq(flag(), "obj-A", "THE FEARED ONE: an old-style two-argument call leaves it hidden");
  db.upsert({ id: "u1", event: { ...e, count: 12 } }, false, {});
  eq(flag(), "obj-A", "so does an empty opts");
  db.upsert({ id: "u1", event: { ...e, count: 13 } }, false, { suppressedBy: undefined });
  eq(flag(), "obj-A", "and an explicit undefined");
  eq(db.getById("u1").count, 13, "while the rest of the row did update");

  db.upsert({ id: "u1", event: { ...e, count: 14, travel: 0.9 } }, true, { suppressedBy: null });
  const shown = db.getById("u1");
  eq([shown.suppressedBy, shown.travel, shown.finished], [null, 0.9, true], "null clears it: the event that travelled shows again");
  db.upsert({ id: "u1", event: { ...e, count: 15 } }, false, { suppressedBy: "obj-A" });
  eq([flag(), db.getById("u1").finished], ["obj-A", true], "a finished event never un-finishes, whatever the flag does");

  db.upsert({ id: "u2", event: ev("u2", "person", DAY) }, true, { suppressedBy: "obj-B" });
  eq(db.getById("u2").suppressedBy, "obj-B", "a new row can be stored already hidden");
  db.upsert({ id: "u3", event: ev("u3", "person", DAY) }, true, { suppressedBy: null });
  eq(db.getById("u3").suppressedBy, null, "and a new row with null is simply shown");
  db.close();
});

check("upsert refuses a suppressedBy that names nothing, and writes nothing", () => {
  const db = openEventsDb(":memory:");
  for (const bad of ["", 0, 1, false, true, {}, ["obj-A"]]) {
    throws(() => db.upsert({ id: "x", event: ev("x", "person", DAY) }, true, { suppressedBy: bad }), `suppressedBy ${JSON.stringify(bad)}`);
  }
  eq(db.all().length, 0, "not one refused call wrote a row");
  db.close();
});

check("travel: 0 stays 0, absent stays unknown, and nothing but a real distance is stored", () => {
  const db = openEventsDb(":memory:");
  const put = (id, travel) => {
    const e = ev(id, "person", DAY);
    if (travel !== undefined) e.travel = travel;
    db.upsert({ id, event: e }, true);
    return db.getById(id).travel;
  };
  eq(put("zero", 0), 0, "THE FEARED ONE: a one-sighting event's 0 is a measurement, not a blank");
  eq(put("walker", 3.25), 3.25, "a walker's travel round-trips");
  eq(put("absent", undefined), null, "no travel is unknown (null), never 0");
  eq(put("null", null), null, "null stays null");
  eq(put("nan", NaN), null, "NaN is not a distance");
  eq(put("inf", Infinity), null, "nor is infinity");
  eq(put("negative", -0.2), null, "nor a negative one - it would read as 'did not move'");
  eq(put("text", "0.1"), null, "nor a string that looks like one");

  // An event's travel only grows as it goes on (contracts/detection.ts);
  // each update replaces the stored one, so the row follows it.
  const growing = { ...ev("grow", "person", DAY), travel: 0.1 };
  db.upsert({ id: "grow", event: growing }, false);
  db.upsert({ id: "grow", event: { ...growing, count: 20, travel: 1.4 } }, false);
  eq(db.getById("grow").travel, 1.4, "an update carries the new travel");
  db.close();
});

check("hidden: include is the default and shows everything; exclude and only split it; hiddenCount is the same whichever", () => {
  const db = dbWith([
    ev("p1", "person", DAY + 1 * 3600_000),
    ev("u1", "person", DAY + 2 * 3600_000),
    ev("p2", "person", DAY + 3 * 3600_000),
    ev("u2", "person", DAY + 4 * 3600_000),
    ev("u3", "person", DAY + 5 * 3600_000),
  ]);
  eq(db.setSuppressed(["u1", "u2", "u3"], "obj"), 3, "three hidden");
  const ask = (opts) => {
    const r = db.inRange("cam1", iso(DAY), iso(DAY_END), null, 100, null, opts);
    return [r.events.map((e) => e.id), r.hiddenCount];
  };
  const everything = [["p1", "u1", "p2", "u2", "u3"], 3];
  eq(ask(undefined), everything, "no opts: every existing caller sees everything, as before");
  eq(ask({}), everything, "empty opts: the same");
  eq(ask({ hidden: "include" }), everything, "include: the same");
  eq(ask({ hidden: "exclude" }), [["p1", "p2"], 3], "exclude: only what is shown, and how many are not");
  eq(ask({ hidden: "only" }), [["u1", "u2", "u3"], 3], "only: just the hidden ones");
  const fiveArgs = db.inRange("cam1", iso(DAY), iso(DAY_END), null, 100);
  eq([fiveArgs.events.length, fiveArgs.hiddenCount], [5, 3], "the five-argument call the API server and gate check make today");
  eq(
    db.inRange("cam1", iso(DAY), iso(DAY_END), null, 100, null, { hidden: "include" }).events.map((e) => e.suppressedBy),
    [null, "obj", null, "obj", "obj"],
    "each event says what hides it, so the page can grey those",
  );
  eq(HIDDEN_MODES, ["include", "exclude", "only"], "the three modes, for a caller validating its own parameter");
  db.close();
});

check("THE FEARED ONE: six hundred hidden umbrellas do not spend the limit, and the count is not the page's", () => {
  const many = [];
  for (let i = 0; i < 600; i++) many.push(ev(`umbrella${i}`, "person", DAY + i * 60_000));
  many.push(ev("thePerson", "person", DAY + 23 * 3600_000));
  const db = dbWith(many);
  eq(db.setSuppressed(many.slice(0, 600).map((e) => e.id), "cam1:person:1"), 600, "all six hundred hidden");

  const shown = db.inRange("cam1", iso(DAY), iso(DAY_END), null, 500, null, { hidden: "exclude" });
  eq(shown.events.map((e) => e.id), ["thePerson"], "the hidden filter runs in the query, not after the limit");
  eq(shown.truncated, false, "and one person is not a truncated answer");
  eq(shown.hiddenCount, 600, "all 600 counted - not the 500 the limit would have let through");

  const onlyHidden = db.inRange("cam1", iso(DAY), iso(DAY_END), null, 10, null, { hidden: "only" });
  eq([onlyHidden.events.length, onlyHidden.truncated, onlyHidden.hiddenCount], [10, true, 600], "a page of the hidden ones admits there are more");
  db.close();
});

check("hiddenCount counts this camera, this window and these filters - what the toggle would actually reveal", () => {
  const db = dbWith([
    ev("h-person", "person", DAY + 3600_000),
    ev("h-car", "vehicle", DAY + 2 * 3600_000, 5000, "cam1", "car"),
    ev("h-other-camera", "person", DAY + 3600_000, 5000, "cam2"),
    ev("h-yesterday", "person", DAY - 3 * 3600_000),
    ev("shown", "person", DAY + 4 * 3600_000),
  ]);
  db.setSuppressed(["h-person", "h-car", "h-other-camera", "h-yesterday"], "obj");
  const count = (kinds, species) => db.inRange("cam1", iso(DAY), iso(DAY_END), kinds, 100, species, { hidden: "exclude" }).hiddenCount;
  eq(count(null, null), 2, "this camera's two in this window; not cam2's, not yesterday's");
  eq(count(["person"], null), 1, "only people asked for: only the hidden person counts");
  eq(count(["vehicle"], ["truck"]), 0, "a hidden car is not a hidden truck");
  eq(count(["vehicle"], ["car"]), 1, "but it is a hidden car");
  eq(db.inRange("cam1", iso(DAY), iso(DAY_END), [], 100, null, { hidden: "exclude" }), { events: [], truncated: false, hiddenCount: 0 }, "nothing asked for: nothing, and nothing hidden");
  eq(db.inRange("cam1", iso(DAY), iso(DAY_END), null, 100, [], { hidden: "only" }), { events: [], truncated: false, hiddenCount: 0 }, "the same for an empty species list");
  db.close();
});

check("a hidden mode that is not one of the three is refused, never read as include", () => {
  const db = dbWith([ev("p", "person", DAY + 3600_000)]);
  for (const bad of ["Exclude", "all", "hide", "", true, 1]) {
    throws(() => db.inRange("cam1", iso(DAY), iso(DAY_END), null, 100, null, { hidden: bad }), `hidden ${JSON.stringify(bad)}`);
  }
  db.close();
});

check("THE LEARNING PASS DOES NOT READ THE WHOLE TABLE: recentFinished's query uses an index (found in review)", () => {
  // The same SQL as recentFinished in agent/events-db.mjs: if that query
  // changes, change it here too.
  const file = path.join(mkdtempSync(path.join(tmpdir(), "camplat-evq-")), "events.db");
  const db = openEventsDb(file);
  const raw = new DatabaseSync(file);
  try {
    const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_finished_last'").all();
    eq(idx.length, 1, "the index exists on a new database");
    const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT * FROM events WHERE finished = 1 AND last_ms >= ? ORDER BY first_ms DESC, id DESC LIMIT ?`)
      .all(0, 10).map((r) => r.detail).join(" | ");
    eq(/SCAN events(?! USING)/.test(plan), false, `no full scan: ${plan}`);
    eq(/idx_events_finished_last/.test(plan), true, `uses the index: ${plan}`);
  } finally { raw.close(); db.close(); }
});

check("recentFinished: the finished events of every camera that ended since, oldest first, hidden ones included", () => {
  const db = openEventsDb(":memory:");
  const put = (e, finished = true) => db.upsert({ id: e.id, event: e }, finished);
  put(ev("b", "person", DAY + 2 * 3600_000, 5000, "cam1"));
  put(ev("a", "vehicle", DAY + 1 * 3600_000, 5000, "cam2"));
  put(ev("straddles", "person", DAY - 10 * 60_000, 11 * 60_000));      // ended a minute after `since`
  put(ev("endsAtSince", "person", DAY - 5000, 5000));                 // ended exactly at `since`
  put(ev("endedBefore", "person", DAY - 5001, 5000));                 // ended a millisecond before it
  put(ev("stillOpen", "person", DAY + 3 * 3600_000), false);
  put(ev("hidden", "person", DAY + 4 * 3600_000));
  db.setSuppressed(["hidden"], "obj");

  const out = db.recentFinished(iso(DAY), 100);
  eq(out.events.map((e) => e.id), ["straddles", "endsAtSince", "a", "b", "hidden"], "oldest first, across cameras");
  eq(out.truncated, false, "all of them");
  eq(out.events.find((e) => e.id === "hidden").suppressedBy, "obj", "a hidden event is still there, and says so");
  eq(out.events.every((e) => e.finished && Object.hasOwn(e, "travel")), true, "only finished ones, each carrying its travel");
  db.close();
});

check("THE FEARED ONE: recentFinished cut short keeps the NEWEST, says so, and still hands them over oldest first", () => {
  const events = [];
  for (let i = 0; i < 12; i++) events.push(ev(`e${String(i).padStart(2, "0")}`, "person", DAY + i * 60_000));
  const db = dbWith(events);
  const cut = db.recentFinished(iso(DAY), 5);
  eq(cut.events.map((e) => e.id), ["e07", "e08", "e09", "e10", "e11"], "the five newest, oldest of them first");
  eq(cut.truncated, true, "and it admits some were left out");
  const exact = db.recentFinished(iso(DAY), 12);
  eq([exact.events.length, exact.truncated, exact.events[0].id], [12, false, "e00"], "exactly the limit is not truncated");
  eq(db.recentFinished(iso(DAY), 13).truncated, false, "nor is one to spare");
  db.close();
});

check("recentFinished refuses a question it cannot answer honestly", () => {
  const db = dbWith([ev("p", "person", DAY)]);
  for (const since of ["yesterday", "", undefined, null, DAY]) {
    throws(() => db.recentFinished(since, 10), `since ${JSON.stringify(since)}`);
  }
  for (const limit of [0, -1, 1.5, NaN, undefined, "10"]) {
    throws(() => db.recentFinished(iso(DAY), limit), `limit ${JSON.stringify(limit)}`);
  }
  db.close();
});

check("setSuppressed and clearSuppressed count the rows they actually change, and touch only their own object's", () => {
  const db = dbWith(["a", "b", "c", "d"].map((id, i) => ev(id, "person", DAY + i * 60_000)));
  const flags = () => Object.fromEntries(db.all().map((e) => [e.id, e.suppressedBy]));

  eq(db.setSuppressed(["a", "b", "not-stored"], "obj-1"), 2, "an id that is not stored is not counted");
  eq(db.setSuppressed(["a", "b"], "obj-1"), 0, "doing it again changes nothing, and says so");
  eq(db.setSuppressed(["c", "c"], "obj-2"), 1, "an id twice is still one row");
  eq(db.setSuppressed([], "obj-1"), 0, "an empty list is nothing to do");
  eq(flags(), { a: "obj-1", b: "obj-1", c: "obj-2", d: null }, "each hidden behind its own object");

  eq(db.clearSuppressed("obj-1"), 2, "a reset by hand shows that object's events again");
  eq(flags(), { a: null, b: null, c: "obj-2", d: null }, "THE FEARED ONE: another object's events stay hidden");
  eq(db.clearSuppressed("obj-1"), 0, "a second reset has nothing left to do");
  eq(db.clearSuppressed("never-existed"), 0, "nor does a reset of an object nobody learned");

  eq(db.setSuppressed(["c"], "obj-3"), 1, "an event moved to a newly learned object is a change");
  eq(db.all().length, 4, "and through all of it every row is still stored: a flag, never a delete");
  db.close();
});

check("setSuppressed and clearSuppressed refuse arguments that name nothing", () => {
  const db = dbWith([ev("a", "person", DAY)]);
  db.setSuppressed(["a"], "obj-1");
  for (const objectId of ["", null, undefined, 7]) {
    throws(() => db.setSuppressed(["a"], objectId), `setSuppressed object ${JSON.stringify(objectId)}`);
    // An unchecked null would be `WHERE suppressed_by = NULL`, which matches
    // nothing and reports 0 - a reset that did nothing, reported as done.
    throws(() => db.clearSuppressed(objectId), `clearSuppressed object ${JSON.stringify(objectId)}`);
  }
  throws(() => db.setSuppressed("a", "obj-2"), "one id instead of a list");
  throws(() => db.setSuppressed([1], "obj-2"), "an id that is not a string");
  eq(db.getById("a").suppressedBy, "obj-1", "and none of them touched the row");
  db.close();
});

// This evening's bench camera (2026-09-22, tagged by hand): a furled patio
// umbrella by the fence stored as a person 17 times at one spot, and the two
// real people who came through the gate. [tag, firstUtc, lastUtc, count,
// bestConfidence, x, y, w, h] - the real numbers, trimmed to what a row holds.
const EVENING = [
  ["UMBRELLA", "2026-09-22T21:55:07.748Z", "2026-09-22T21:55:07.748Z", 1, 0.6226, 0.69768, 0.36345, 0.09393, 0.42538],
  ["UMBRELLA", "2026-09-22T21:56:59.379Z", "2026-09-22T21:56:59.379Z", 1, 0.5047, 0.69773, 0.36596, 0.08889, 0.41594],
  ["UMBRELLA", "2026-09-22T22:01:52.974Z", "2026-09-22T22:01:52.974Z", 1, 0.5123, 0.69909, 0.36571, 0.08833, 0.43438],
  ["REAL_PERSON", "2026-09-22T22:03:18.756Z", "2026-09-22T22:03:22.960Z", 20, 0.9259, 0.18121, 0.59159, 0.18379, 0.40399],
  ["UMBRELLA", "2026-09-22T22:05:02.386Z", "2026-09-22T22:05:02.386Z", 1, 0.5341, 0.69785, 0.36701, 0.09931, 0.42035],
  ["UMBRELLA", "2026-09-22T22:05:18.590Z", "2026-09-22T22:05:25.379Z", 3, 0.6479, 0.69783, 0.36372, 0.08986, 0.40962],
  ["UMBRELLA", "2026-09-22T22:06:00.379Z", "2026-09-22T22:06:00.379Z", 1, 0.5901, 0.69961, 0.36481, 0.07954, 0.41503],
  ["UMBRELLA", "2026-09-22T22:07:05.161Z", "2026-09-22T22:07:14.559Z", 3, 0.7988, 0.69979, 0.36473, 0.08178, 0.41967],
  ["UMBRELLA", "2026-09-22T22:07:33.954Z", "2026-09-22T22:07:36.562Z", 3, 0.6457, 0.7002, 0.36623, 0.08032, 0.41702],
  ["UMBRELLA", "2026-09-22T22:07:49.149Z", "2026-09-22T22:08:03.400Z", 4, 0.6743, 0.69975, 0.36437, 0.09332, 0.41222],
  ["UMBRELLA", "2026-09-22T22:08:22.198Z", "2026-09-22T22:08:28.393Z", 3, 0.7623, 0.70121, 0.36325, 0.07917, 0.43076],
  ["UMBRELLA", "2026-09-22T22:08:47.989Z", "2026-09-22T22:11:29.956Z", 40, 0.7881, 0.69939, 0.36584, 0.08819, 0.41676],
  ["UMBRELLA", "2026-09-22T22:12:04.606Z", "2026-09-22T22:12:07.800Z", 2, 0.5668, 0.70037, 0.36335, 0.08832, 0.41729],
  ["UMBRELLA", "2026-09-22T22:12:22.001Z", "2026-09-22T22:12:22.001Z", 1, 0.5589, 0.69792, 0.3626, 0.09173, 0.42515],
  ["UMBRELLA", "2026-09-22T22:12:41.995Z", "2026-09-22T22:13:29.988Z", 11, 0.7684, 0.6976, 0.36341, 0.09171, 0.43008],
  ["UMBRELLA", "2026-09-22T22:13:59.381Z", "2026-09-22T22:14:05.775Z", 2, 0.6638, 0.69782, 0.36306, 0.0853, 0.42685],
  ["UMBRELLA", "2026-09-22T22:16:38.396Z", "2026-09-22T22:16:38.396Z", 1, 0.5169, 0.69589, 0.36153, 0.08744, 0.44704],
  ["UMBRELLA", "2026-09-22T22:20:31.210Z", "2026-09-22T22:20:31.210Z", 1, 0.5817, 0.69874, 0.36382, 0.08386, 0.42189],
  ["REAL_PERSON", "2026-09-22T22:26:52.780Z", "2026-09-22T22:27:00.976Z", 33, 0.9214, 0.23881, 0.67734, 0.13168, 0.31926],
];

check("this evening's bench camera: the 17 umbrella rows hidden, the two people at the gate still shown", () => {
  const db = openEventsDb(":memory:");
  const tags = new Map();
  EVENING.forEach(([tag, firstUtc, lastUtc, count, bestConfidence, x, y, w, h], i) => {
    const id = `cam-bench:${Date.parse(firstUtc)}:${i}`;
    tags.set(id, tag);
    db.upsert({ id, event: { id, cameraId: "cam-bench", kind: "person", firstUtc, lastUtc, count, bestConfidence, bestBox: { x, y, w, h }, bestUtc: firstUtc } }, true);
  });
  const umbrellaIds = [...tags].filter(([, tag]) => tag === "UMBRELLA").map(([id]) => id);
  eq(db.setSuppressed(umbrellaIds, "cam-bench:person:1790000000000"), 17, "the seventeen umbrella rows hidden");

  const evening = (hidden) => db.inRange("cam-bench", "2026-09-22T21:00:00.000Z", "2026-09-22T23:00:00.000Z", ["person"], 100, null, { hidden });
  const page = evening("exclude");
  eq(page.events.map((e) => e.firstUtc), ["2026-09-22T22:03:18.756Z", "2026-09-22T22:26:52.780Z"], "the page shows the two people at the gate, 6:03 and 6:26 PM");
  eq(page.events.every((e) => tags.get(e.id) === "REAL_PERSON"), true, "and they are the two tagged as real");
  eq(page.hiddenCount, 17, "and says 17 are hidden");
  eq(evening("include").events.length, 19, "the toggle brings back all nineteen");
  eq(evening("only").events.every((e) => e.bestBox.x > 0.69 && e.bestBox.x < 0.71), true, "the hidden ones are all at the umbrella's spot");

  eq(db.clearSuppressed("cam-bench:person:1790000000000"), 17, "a reset by hand");
  eq([evening("exclude").events.length, evening("exclude").hiddenCount], [19, 0], "and the evening is back as it was stored");
  db.close();
});

report("events db");
