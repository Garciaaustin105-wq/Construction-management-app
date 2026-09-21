/**
 * Events database for detection results.
 *
 * Stores detection events with streaming updates from the detector service.
 * Uses node:sqlite for persistence without external dependencies.
 */

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
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
CREATE INDEX IF NOT EXISTS idx_events_camera_first ON events(camera_id, first_ms);
`;

const toIso = (ms) => new Date(ms).toISOString();
const fromIso = (iso) => Date.parse(iso);

/**
 * Add the `species` column to a database that predates it.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
 * so on the live appliance - thousands of rows, no `species` column - the
 * schema string above is silently skipped and every upsert naming `species`
 * would fail. PRAGMA table_info is the only way to ask sqlite what columns a
 * table actually has; ALTER TABLE ADD COLUMN is run once, only when it is
 * missing, and only adds - it never touches an existing row, which keeps
 * their `species` a real NULL (absent, not the string "null").
 */
function ensureSpeciesColumn(db) {
  const columns = db.prepare("PRAGMA table_info(events)").all();
  const hasSpecies = columns.some((c) => c.name === "species");
  if (!hasSpecies) {
    db.exec("ALTER TABLE events ADD COLUMN species TEXT");
  }
}

function rowToEvent(row) {
  const event = {
    id: row.id,
    cameraId: row.camera_id,
    kind: row.kind,
    firstUtc: toIso(row.first_ms),
    lastUtc: toIso(row.last_ms),
    count: row.count,
    bestConfidence: row.best_confidence,
    bestBox: {
      x: row.best_x,
      y: row.best_y,
      w: row.best_w,
      h: row.best_h,
    },
    bestUtc: toIso(row.best_ms),
    finished: row.finished === 1,
  };
  if (row.plate !== null) {
    event.plate = row.plate;
  }
  // NULL (no species, or an old row from before this column existed) must
  // come back as an ABSENT field, matching contracts/detection.ts where
  // species is optional - never `null`, never the string "null".
  if (row.species !== null) {
    event.species = row.species;
  }
  return event;
}

export function openEventsDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  ensureSpeciesColumn(db);

  const stmts = {
    upsert: db.prepare(`
      INSERT INTO events (id, camera_id, kind, first_ms, last_ms, count, best_confidence, best_x, best_y, best_w, best_h, best_ms, plate, species, finished)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_ms=excluded.last_ms,
        count=excluded.count,
        best_confidence=excluded.best_confidence,
        best_x=excluded.best_x,
        best_y=excluded.best_y,
        best_w=excluded.best_w,
        best_h=excluded.best_h,
        best_ms=excluded.best_ms,
        plate=excluded.plate,
        species=excluded.species,
        finished=MAX(finished, excluded.finished)
    `),
    all: db.prepare("SELECT * FROM events ORDER BY first_ms, id"),
    byId: db.prepare("SELECT * FROM events WHERE id = ?"),
  };

  /**
   * One prepared statement per (kinds, species) pair asked for, made once and
   * kept. There are only eight possible kind sets and species sets are rare
   * and small in practice, so caching by the pair costs nothing.
   *
   * Both filters MUST be inside the query. Filtering the rows afterwards
   * means a day with six hundred cars and one person answers "no person" -
   * and species has exactly the same trap: a day with six hundred cars and
   * one truck would answer "no truck" if the limit were spent on cars first
   * and the truck filtered out only after. The limit is spent on rows that
   * are then thrown away, and the one sighting that mattered never comes back.
   */
  const inRangeStmts = new Map();
  function inRangeStmt(kinds, species) {
    const key = `${kinds === null ? "*" : kinds.join(",")}|${species === null ? "*" : species.join(",")}`;
    let stmt = inRangeStmts.get(key);
    if (stmt === undefined) {
      // Overlap, not containment: someone who walked in at 23:59 and left at
      // 00:01 belongs to both days. Ordered by time so the same question gives
      // the same answer twice, and asked for one row more than the caller
      // wants, so "that is all of them" can be told from "there are more".
      const kindFilter = kinds === null ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
      const speciesFilter = species === null ? "" : ` AND species IN (${species.map(() => "?").join(", ")})`;
      stmt = db.prepare(`
        SELECT * FROM events
        WHERE camera_id = ? AND last_ms >= ? AND first_ms <= ?${kindFilter}${speciesFilter}
        ORDER BY first_ms, id
        LIMIT ?
      `);
      inRangeStmts.set(key, stmt);
    }
    return stmt;
  }

  return {
    upsert(updateObj, finished) {
      const event = updateObj.event;
      stmts.upsert.run(
        updateObj.id,
        event.cameraId,
        event.kind,
        fromIso(event.firstUtc),
        fromIso(event.lastUtc),
        event.count,
        event.bestConfidence,
        event.bestBox?.x ?? null,
        event.bestBox?.y ?? null,
        event.bestBox?.w ?? null,
        event.bestBox?.h ?? null,
        fromIso(event.bestUtc),
        event.plate ?? null,
        event.species ?? null,
        finished ? 1 : 0,
      );
    },

    all() {
      return stmts.all.all().map(rowToEvent);
    },

    /** One event by id, or null. For turning an id a client sent (a thumbnail
     *  request, a "jump to this event") into the row, without scanning. */
    getById(id) {
      const row = stmts.byId.get(id);
      return row ? rowToEvent(row) : null;
    },

    /**
     * The events of one camera that touch a window, oldest first.
     *
     * `kinds` is a list to keep (the caller has already checked them); omit it
     * (null/undefined) for all of them. `species` is optional and works the
     * same way, one level finer - "show me all the events of a white truck"
     * needs `species: ["truck"]`, not just `kinds: ["vehicle"]`. Both filters
     * apply together (AND). Returns `{ events, truncated }`: `truncated` is
     * true when the limit cut the answer short, so the page can say so instead
     * of showing a quiet half of a busy day as if it were the whole of it.
     */
    inRange(cameraId, startUtc, endUtc, kinds, limit, species) {
      const wanted = Array.isArray(kinds) ? [...new Set(kinds)].sort() : null;
      if (wanted !== null && wanted.length === 0) return { events: [], truncated: false };
      const wantedSpecies = Array.isArray(species) ? [...new Set(species)].sort() : null;
      if (wantedSpecies !== null && wantedSpecies.length === 0) return { events: [], truncated: false };
      const rows = inRangeStmt(wanted, wantedSpecies).all(
        cameraId, fromIso(startUtc), fromIso(endUtc), ...(wanted ?? []), ...(wantedSpecies ?? []), limit + 1,
      );
      return { events: rows.slice(0, limit).map(rowToEvent), truncated: rows.length > limit };
    },

    close() {
      db.close();
    },
  };
}
