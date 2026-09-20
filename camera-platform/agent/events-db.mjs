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
  finished INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_camera_first ON events(camera_id, first_ms);
`;

const toIso = (ms) => new Date(ms).toISOString();
const fromIso = (iso) => Date.parse(iso);

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
  return event;
}

export function openEventsDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);

  const stmts = {
    upsert: db.prepare(`
      INSERT INTO events (id, camera_id, kind, first_ms, last_ms, count, best_confidence, best_x, best_y, best_w, best_h, best_ms, plate, finished)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        finished=MAX(finished, excluded.finished)
    `),
    all: db.prepare("SELECT * FROM events ORDER BY first_ms, id"),
    byId: db.prepare("SELECT * FROM events WHERE id = ?"),
  };

  /**
   * One prepared statement per set of kinds, made once and kept.
   *
   * The kind filter MUST be inside the query. Filtering the rows afterwards
   * means a day with six hundred cars and one person answers "no person":
   * the limit is spent on rows that are then thrown away, and the one sighting
   * that mattered never comes back. There are only eight possible sets, so
   * they cost nothing to keep.
   */
  const inRangeStmts = new Map();
  function inRangeStmt(kinds) {
    const key = kinds === null ? "*" : kinds.join(",");
    let stmt = inRangeStmts.get(key);
    if (stmt === undefined) {
      // Overlap, not containment: someone who walked in at 23:59 and left at
      // 00:01 belongs to both days. Ordered by time so the same question gives
      // the same answer twice, and asked for one row more than the caller
      // wants, so "that is all of them" can be told from "there are more".
      const filter = kinds === null ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
      stmt = db.prepare(`
        SELECT * FROM events
        WHERE camera_id = ? AND last_ms >= ? AND first_ms <= ?${filter}
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
     * for all of them. Returns `{ events, truncated }`: `truncated` is true
     * when the limit cut the answer short, so the page can say so instead of
     * showing a quiet half of a busy day as if it were the whole of it.
     */
    inRange(cameraId, startUtc, endUtc, kinds, limit) {
      const wanted = Array.isArray(kinds) ? [...new Set(kinds)].sort() : null;
      if (wanted !== null && wanted.length === 0) return { events: [], truncated: false };
      const rows = inRangeStmt(wanted).all(
        cameraId, fromIso(startUtc), fromIso(endUtc), ...(wanted ?? []), limit + 1,
      );
      return { events: rows.slice(0, limit).map(rowToEvent), truncated: rows.length > limit };
    },

    close() {
      db.close();
    },
  };
}
