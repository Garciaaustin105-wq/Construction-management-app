/**
 * Events database for detection results.
 *
 * Stores detection events with streaming updates from the detector service.
 * Uses node:sqlite for persistence without external dependencies.
 *
 * Two columns serve known objects (contracts/knownObjects.ts): `travel`, how
 * far an event's box got from where it started, and `suppressed_by`, the id
 * of the known object an event is hidden behind. Suppression is a FLAG on a
 * row that is still stored, never a delete: a hidden event can always be
 * shown again (inRange's `hidden` option), and a reset by hand clears the
 * flag (clearSuppressed) rather than having to bring anything back.
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
  travel REAL,
  suppressed_by TEXT,
  finished INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_camera_first ON events(camera_id, first_ms);
-- recentFinished, the known-objects learning pass every 10 minutes, asks for
-- finished events of EVERY camera that ended in the last two days. Found in
-- review (2026-09-23): with only the camera index it scanned and sorted the
-- whole table each pass, and nothing prunes this table, so it slowed every
-- day. One more b-tree update per upsert is the price.
CREATE INDEX IF NOT EXISTS idx_events_finished_last ON events(finished, last_ms);
`;

/**
 * What `inRange` can be asked to do with suppressed events. "include" is the
 * default so every caller written before suppression existed keeps seeing
 * everything it saw before; the page asks for "exclude" on purpose.
 */
export const HIDDEN_MODES = ["include", "exclude", "only"];

const toIso = (ms) => new Date(ms).toISOString();
const fromIso = (iso) => Date.parse(iso);

/**
 * The connection's normal busy_timeout: how long ANY statement on this handle
 * waits for a lock before giving up. Fine for a read (WAL readers do not
 * block on a writer) and fine for the upsert/setSuppressed writes camctl and
 * detect-service make from their own short-lived processes.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Found in review (2026-09-23): events retention's deleteEndedBefore is the
 * FIRST write agent/api-server.mjs's own long-lived process ever issues
 * against this file (every other route it serves only reads). node:sqlite's
 * DatabaseSync runs every call synchronously on the caller's own thread, so
 * `BEGIN IMMEDIATE` waiting out the connection's normal 5000 ms busy_timeout
 * while detect-service's separate process holds the write lock would freeze
 * every HTTP request and live stream that server is serving for up to 5
 * seconds, once per tick and once per batch of a backlog (reproduced with two
 * DatabaseSync handles on one file: a 5000 ms busy_timeout blocked the
 * process for ~5.6 s before throwing "database is locked").
 *
 * The fix is not a shorter wait tolerated silently — it is a short wait that,
 * on a miss, is reported as "try again" rather than guessed at: a lock miss
 * costs one skipped batch (the caller's loop or next tick retries), never a
 * multi-second stall of the whole process.
 */
const RETENTION_WRITE_BUSY_TIMEOUT_MS = 200;

/** SQLITE_BUSY (node:sqlite's DatabaseSync throws ERR_SQLITE_ERROR with this
 *  errcode, "database is locked") — the one failure a short busy_timeout on
 *  the retention write path is expected to hit, and the only one it is
 *  allowed to swallow into "try again later" rather than a thrown error. */
function isSqliteBusy(err) {
  return Boolean(err) && err.code === "ERR_SQLITE_ERROR"
    && (err.errcode === 5 || /database is locked/i.test(String(err.message ?? "")));
}

/**
 * Columns added after the table first shipped, in the order they arrived.
 *
 * None has a DEFAULT, on purpose: ALTER TABLE ADD COLUMN without one leaves
 * every existing row a real NULL, and NULL is the only honest value for a
 * row stored before anyone measured the thing. For `travel` this is the one
 * that matters (build rule 5): a zero would read as "never moved", which is
 * exactly the value that lets an event be learned as a known object and
 * hidden. An old row's travel is UNKNOWN, and unknown is never "did not move".
 */
const ADDED_COLUMNS = [
  { name: "species", type: "TEXT" },
  { name: "travel", type: "REAL" },
  { name: "suppressed_by", type: "TEXT" },
];

/**
 * Add the columns a database that predates them is missing.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
 * so on the live appliance - thousands of rows, none of these columns - the
 * schema string above is silently skipped and every upsert naming them would
 * fail. PRAGMA table_info is the only way to ask sqlite what columns a table
 * actually has; ALTER TABLE ADD COLUMN is run once per column, only when it
 * is missing, and only adds - it never touches an existing row, which keeps
 * their values a real NULL (absent, not the string "null", not 0).
 */
function ensureAddedColumns(db) {
  const columnNames = () => new Set(db.prepare("PRAGMA table_info(events)").all().map((c) => c.name));
  let present = columnNames();
  for (const { name, type } of ADDED_COLUMNS) {
    if (present.has(name)) continue;
    try {
      db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
    } catch (err) {
      // The detector service and the API server both open this file, and
      // after an upgrade they start together: both can see a column missing,
      // and the second ALTER then fails with "duplicate column name". That is
      // the job already done by the other process, not a failure - so look
      // again, and only a column that is STILL missing is a real error.
      present = columnNames();
      if (!present.has(name)) throw err;
    }
  }
}

/**
 * A travel we can trust, or null. Travel is a distance (contracts/detection.ts:
 * how far the box centre got, in the first box's diagonals), so anything not
 * a finite number >= 0 is not a measurement - and storing it would risk the
 * one wrong answer that looks plausible: a garbage value read as "did not
 * move". NULL means unknown, and unknown is never learned from or hidden.
 */
function travelOf(event) {
  const t = event.travel;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : null;
}

/** An object id to hide events behind: a non-empty string, nothing else. */
function isObjectId(value) {
  return typeof value === "string" && value.length > 0;
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
    // Unlike species below, these two are always PRESENT, and null when the
    // column is NULL. The known-objects contract reads `travel: number | null`
    // and treats null as "unknown - never learn from it, never hide it"; an
    // absent field would reach it as undefined, which is neither. And never
    // 0 for an old row: that would be "did not move", a claim nobody measured.
    travel: row.travel ?? null,
    suppressedBy: row.suppressed_by ?? null,
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

/**
 * The upsert, in two forms that differ only in whether an update touches
 * `suppressed_by`. A caller that says nothing about suppression (every call
 * written before it existed) must leave the flag exactly as it is - so that
 * form does not name the column in its UPDATE at all, rather than trying to
 * reconstruct "as it was" from a value it was never given. A brand-new row
 * starts unsuppressed either way unless a string was given.
 */
function upsertSql(setsSuppression) {
  return `
      INSERT INTO events (id, camera_id, kind, first_ms, last_ms, count, best_confidence, best_x, best_y, best_w, best_h, best_ms, plate, species, travel, suppressed_by, finished)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        travel=excluded.travel,${setsSuppression ? "\n        suppressed_by=excluded.suppressed_by," : ""}
        finished=MAX(finished, excluded.finished)
    `;
}

export function openEventsDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
  db.exec(SCHEMA);
  ensureAddedColumns(db);

  const stmts = {
    upsertKeepingSuppression: db.prepare(upsertSql(false)),
    upsertSettingSuppression: db.prepare(upsertSql(true)),
    all: db.prepare("SELECT * FROM events ORDER BY first_ms, id"),
    byId: db.prepare("SELECT * FROM events WHERE id = ?"),
    // Newest first so the LIMIT keeps the newest; recentFinished turns the
    // page back round to oldest first before handing it over.
    recentFinished: db.prepare(`
      SELECT * FROM events
      WHERE finished = 1 AND last_ms >= ?
      ORDER BY first_ms DESC, id DESC
      LIMIT ?
    `),
    // `IS NOT ?` rather than `!= ?`: it is sqlite's NULL-safe comparison, so
    // a row that is not hidden at all (NULL) is still "different", and a row
    // already hidden behind this very object is left alone and not counted -
    // the count is of rows that actually changed.
    setSuppressed: db.prepare("UPDATE events SET suppressed_by = ? WHERE id = ? AND suppressed_by IS NOT ?"),
    clearSuppressed: db.prepare("UPDATE events SET suppressed_by = NULL WHERE suppressed_by = ?"),
    // Every distinct camera in the table and how many rows it has, for
    // events retention (EVENTS-RETENTION-SPEC.md): idx_events_camera_first
    // is (camera_id, first_ms), so grouping by camera_id alone still walks
    // it rather than the whole table.
    cameraEventCounts: db.prepare("SELECT camera_id, COUNT(*) AS n FROM events GROUP BY camera_id ORDER BY camera_id"),
    // Deletes the oldest matching rows for one camera, oldest first, a batch
    // at a time. `first_ms < ?` is redundant with `last_ms < ?` (first_ms is
    // never after last_ms) but it is what lets idx_events_camera_first do the
    // work: without it sqlite would have to check every row of the camera
    // against last_ms with no index to narrow the scan first.
    deleteEndedBefore: db.prepare(`
      DELETE FROM events WHERE id IN (
        SELECT id FROM events WHERE camera_id = ? AND first_ms < ? AND last_ms < ? LIMIT ?
      )
    `),
    // The same predicate, unbounded by any LIMIT: every row that a real
    // deletion would eventually remove across as many batches as it takes,
    // counted rather than removed. What a dry run reports.
    countEndedBefore: db.prepare("SELECT COUNT(*) AS n FROM events WHERE camera_id = ? AND first_ms < ? AND last_ms < ?"),
  };

  /**
   * One prepared statement per distinct camera COUNT, for eventsInWindow and
   * oldestFirstMs below -- both take a variable-length camera id list, which
   * sqlite has no way to bind as a single parameter, so the `IN (?, ?, ...)`
   * clause is built per call-shape and cached by how many placeholders it
   * needs (the activity page only ever asks for one camera or the whole
   * configured list, so this cache never grows past a couple of entries).
   */
  const eventsInWindowStmts = new Map();
  function eventsInWindowStmt(n) {
    let stmt = eventsInWindowStmts.get(n);
    if (stmt === undefined) {
      const placeholders = Array.from({ length: n }, () => "?").join(", ");
      stmt = db.prepare(`
        SELECT camera_id, kind, first_ms, suppressed_by FROM events
        WHERE camera_id IN (${placeholders}) AND first_ms >= ? AND first_ms < ?
        ORDER BY first_ms
      `);
      eventsInWindowStmts.set(n, stmt);
    }
    return stmt;
  }
  const oldestFirstMsStmts = new Map();
  function oldestFirstMsStmt(n) {
    let stmt = oldestFirstMsStmts.get(n);
    if (stmt === undefined) {
      const placeholders = Array.from({ length: n }, () => "?").join(", ");
      stmt = db.prepare(`SELECT MIN(first_ms) AS m FROM events WHERE camera_id IN (${placeholders})`);
      oldestFirstMsStmts.set(n, stmt);
    }
    return stmt;
  }

  /**
   * Run several statements as one: reads see one snapshot, writes land all
   * together or not at all. IMMEDIATE for writes takes the write lock up
   * front, so busy_timeout waits for it instead of failing half way.
   */
  function together(fn, { write }) {
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      // sqlite rolls some failures back on its own (a full disk, for one),
      // and a ROLLBACK with nothing open throws - which would bury the error
      // that actually happened under one about the clean-up.
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /** The WHERE clause shared by an inRange page and its hidden count. */
  function windowWhere(kinds, species) {
    // Overlap, not containment: someone who walked in at 23:59 and left at
    // 00:01 belongs to both days.
    const kindFilter = kinds === null ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
    const speciesFilter = species === null ? "" : ` AND species IN (${species.map(() => "?").join(", ")})`;
    return `camera_id = ? AND last_ms >= ? AND first_ms <= ?${kindFilter}${speciesFilter}`;
  }

  /**
   * One prepared statement per (kinds, species, hidden) asked for, made once
   * and kept. There are only eight possible kind sets, species sets are rare
   * and small in practice, and there are three hidden modes, so caching by
   * the triple costs nothing.
   *
   * Every filter MUST be inside the query. Filtering the rows afterwards
   * means a day with six hundred cars and one person answers "no person" -
   * and species has exactly the same trap: a day with six hundred cars and
   * one truck would answer "no truck" if the limit were spent on cars first
   * and the truck filtered out only after. So does suppression: an umbrella
   * hidden six hundred times would spend the limit on rows the page then
   * drops, and the one real person that evening would never come back.
   */
  const inRangeStmts = new Map();
  function inRangeStmt(kinds, species, hidden) {
    const key = `${kinds === null ? "*" : kinds.join(",")}|${species === null ? "*" : species.join(",")}|${hidden}`;
    let stmt = inRangeStmts.get(key);
    if (stmt === undefined) {
      // Ordered by time so the same question gives the same answer twice,
      // and asked for one row more than the caller wants, so "that is all of
      // them" can be told from "there are more".
      const hiddenFilter = hidden === "exclude" ? " AND suppressed_by IS NULL"
        : hidden === "only" ? " AND suppressed_by IS NOT NULL"
        : "";
      stmt = db.prepare(`
        SELECT * FROM events
        WHERE ${windowWhere(kinds, species)}${hiddenFilter}
        ORDER BY first_ms, id
        LIMIT ?
      `);
      inRangeStmts.set(key, stmt);
    }
    return stmt;
  }

  /** The hidden count for the same window and filters, cached the same way. */
  const hiddenCountStmts = new Map();
  function hiddenCountStmt(kinds, species) {
    const key = `${kinds === null ? "*" : kinds.join(",")}|${species === null ? "*" : species.join(",")}`;
    let stmt = hiddenCountStmts.get(key);
    if (stmt === undefined) {
      stmt = db.prepare(`
        SELECT COUNT(*) AS n FROM events
        WHERE ${windowWhere(kinds, species)} AND suppressed_by IS NOT NULL
      `);
      hiddenCountStmts.set(key, stmt);
    }
    return stmt;
  }

  return {
    /**
     * Store one event, new or updated. `opts.suppressedBy` says what to do
     * with the known-object flag: leave it out (undefined) and the flag stays
     * exactly as it is - every call written before suppression existed;
     * `null` clears it (an event that has since travelled is no longer the
     * known object, and shows again on its next update); a string hides the
     * event behind that object. Anything else is refused before anything is
     * written: an empty string would count as hidden while naming nothing.
     */
    upsert(updateObj, finished, opts = {}) {
      const suppressedBy = opts?.suppressedBy;
      if (suppressedBy !== undefined && suppressedBy !== null && !isObjectId(suppressedBy)) {
        throw new TypeError(`suppressedBy must be undefined, null or a non-empty string, not ${JSON.stringify(suppressedBy)}`);
      }
      const event = updateObj.event;
      const stmt = suppressedBy === undefined ? stmts.upsertKeepingSuppression : stmts.upsertSettingSuppression;
      stmt.run(
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
        travelOf(event),
        suppressedBy ?? null,
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
     * apply together (AND). `opts.hidden` is one of HIDDEN_MODES: "include"
     * (the default - suppressed events come back like any other), "exclude"
     * or "only".
     *
     * Returns `{ events, truncated, hiddenCount }`: `truncated` is true when
     * the limit cut the answer short, so the page can say so instead of
     * showing a quiet half of a busy day as if it were the whole of it.
     * `hiddenCount` is how many suppressed events match the same window,
     * kinds and species, whatever `hidden` was and however many the limit let
     * through - so the page can say "3 hidden" even while it is hiding them,
     * and the toggle that shows them reveals exactly that many.
     */
    inRange(cameraId, startUtc, endUtc, kinds, limit, species, opts = {}) {
      const hidden = opts?.hidden ?? "include";
      if (!HIDDEN_MODES.includes(hidden)) {
        throw new TypeError(`hidden must be one of ${HIDDEN_MODES.join(", ")}, not ${JSON.stringify(hidden)}`);
      }
      const wanted = Array.isArray(kinds) ? [...new Set(kinds)].sort() : null;
      if (wanted !== null && wanted.length === 0) return { events: [], truncated: false, hiddenCount: 0 };
      const wantedSpecies = Array.isArray(species) ? [...new Set(species)].sort() : null;
      if (wantedSpecies !== null && wantedSpecies.length === 0) return { events: [], truncated: false, hiddenCount: 0 };
      const args = [cameraId, fromIso(startUtc), fromIso(endUtc), ...(wanted ?? []), ...(wantedSpecies ?? [])];
      // One snapshot for both reads, so the detector hiding a batch of events
      // between them cannot make the count disagree with the page.
      return together(() => {
        const rows = inRangeStmt(wanted, wantedSpecies, hidden).all(...args, limit + 1);
        const { n } = hiddenCountStmt(wanted, wantedSpecies).get(...args);
        return { events: rows.slice(0, limit).map(rowToEvent), truncated: rows.length > limit, hiddenCount: Number(n) };
      }, { write: false });
    },

    /**
     * Finished events of every camera that ended at or after `sinceUtc`,
     * oldest first: what learning known objects reads. Hidden ones are
     * included - the learner has to see what is already known to match it
     * rather than learn it twice.
     *
     * Returns `{ events, truncated }`. When there are more than `limit`, the
     * NEWEST `limit` are the ones kept (and `truncated` says some were left
     * out): learning is about what is in view now, and keeping the oldest
     * would leave something that appeared this afternoon unlearned until the
     * morning's events aged out of the window.
     *
     * Refuses (throws) an instant that does not parse or a limit that is not
     * a positive integer, rather than answering a question nobody asked: a
     * NaN bound would quietly match nothing, and "nothing finished" reads as
     * a real answer.
     */
    recentFinished(sinceUtc, limit) {
      const sinceMs = typeof sinceUtc === "string" ? fromIso(sinceUtc) : NaN;
      if (!Number.isFinite(sinceMs)) {
        throw new TypeError(`recentFinished needs an ISO instant, not ${JSON.stringify(sinceUtc)}`);
      }
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError(`recentFinished needs a positive whole-number limit, not ${JSON.stringify(limit)}`);
      }
      const rows = stmts.recentFinished.all(sinceMs, limit + 1);
      return { events: rows.slice(0, limit).reverse().map(rowToEvent), truncated: rows.length > limit };
    },

    /**
     * Hide these events behind a known object (the members that taught it).
     * Returns how many rows actually changed: an id that is not stored, or
     * one already hidden behind this same object, is not counted. All of
     * them or none of them - a learned object is never left half applied.
     */
    setSuppressed(ids, objectId) {
      if (!isObjectId(objectId)) {
        throw new TypeError(`setSuppressed needs an object id, not ${JSON.stringify(objectId)}`);
      }
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
        throw new TypeError("setSuppressed needs a list of event ids");
      }
      if (ids.length === 0) return 0;
      return together(() => {
        let changed = 0;
        for (const id of ids) changed += Number(stmts.setSuppressed.run(objectId, id, objectId).changes);
        return changed;
      }, { write: true });
    },

    /**
     * Show again every event hidden behind one known object - a reset by
     * hand. Only that object's events: another object's stay hidden. Returns
     * how many rows changed.
     */
    clearSuppressed(objectId) {
      if (!isObjectId(objectId)) {
        throw new TypeError(`clearSuppressed needs an object id, not ${JSON.stringify(objectId)}`);
      }
      return Number(stmts.clearSuppressed.run(objectId).changes);
    },

    /**
     * Every camera with at least one event, and how many it has right now.
     * Used by events retention (EVENTS-RETENTION-SPEC.md) to know which
     * cameras to plan for without loading a single event into memory.
     */
    cameraEventCounts() {
      return stmts.cameraEventCounts.all().map((r) => ({ cameraId: r.camera_id, events: Number(r.n) }));
    },

    /**
     * Delete up to `limit` of one camera's events that ended before
     * `beforeMs` (`last_ms < beforeMs`), oldest first. Returns how many rows
     * were removed — fewer than `limit` (0 included) means nothing more is
     * left to delete for this camera at this threshold; the caller loops
     * until that happens (events retention's own batching, so one camera's
     * backlog never holds the write lock in a single huge transaction).
     *
     * `opts.dryRun` counts every matching row instead — never bounded by
     * `limit`, so it answers the same question a real run would take
     * however many batches to finish, and deletes nothing. A dry run only
     * reads (`BEGIN`, not `BEGIN IMMEDIATE`), so it never takes the write
     * lock and never hits the short retention busy_timeout below.
     *
     * A real delete runs under a SHORT busy_timeout
     * (RETENTION_WRITE_BUSY_TIMEOUT_MS), not the connection's normal one:
     * this is api-server.mjs's only write against a file detect-service's
     * separate process writes to continuously, and node:sqlite's DatabaseSync
     * is synchronous, so waiting out the normal 5 s busy_timeout for
     * `BEGIN IMMEDIATE` would freeze the whole server (every HTTP request,
     * every live stream) for up to 5 seconds. On a lock miss this returns
     * `null` — "try again later", not zero rows deleted — rather than
     * throwing or blocking; the caller's batch loop (agent/event-retention.mjs)
     * treats `null` as "stop for this camera this pass, the next tick will
     * pick up where this left off".
     */
    deleteEndedBefore(cameraId, beforeMs, limit, opts = {}) {
      if (typeof cameraId !== "string" || cameraId === "") {
        throw new TypeError(`deleteEndedBefore needs a camera id, not ${JSON.stringify(cameraId)}`);
      }
      if (!Number.isFinite(beforeMs)) {
        throw new RangeError(`deleteEndedBefore needs a real instant in ms, not ${JSON.stringify(beforeMs)}`);
      }
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError(`deleteEndedBefore needs a positive whole-number limit, not ${JSON.stringify(limit)}`);
      }
      const dryRun = opts?.dryRun === true;
      if (dryRun) {
        return together(() => Number(stmts.countEndedBefore.get(cameraId, beforeMs, beforeMs).n), { write: false });
      }
      db.exec(`PRAGMA busy_timeout = ${RETENTION_WRITE_BUSY_TIMEOUT_MS}`);
      try {
        return together(() => Number(stmts.deleteEndedBefore.run(cameraId, beforeMs, beforeMs, limit).changes), { write: true });
      } catch (err) {
        if (isSqliteBusy(err)) return null;
        throw err;
      } finally {
        // Restored unconditionally, success or failure: every other query on
        // this shared connection (upsert, inRange, the next dry run) must go
        // back to waiting the connection's normal amount, not this one's.
        db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
      }
    },

    /**
     * Every event (finished or not) of these cameras whose `first_ms` falls
     * in `[startUtc, endUtc)`, for the activity page
     * (ACTIVITY-PAGE-SPEC.md): only `cameraId`, `kind`, `firstMs` and
     * `suppressedBy` — exactly what contracts/activity.ts's `countSightings`
     * needs, and no more (never a plate, a box, a confidence — this route
     * has no business with any of that).
     *
     * Uses `idx_events_camera_first` (camera_id, first_ms): the window is
     * bounded by `first_ms` alone, unlike `inRange`'s `last_ms >=` /
     * `first_ms <=` overlap test — an activity bucket is decided by where a
     * sighting STARTED (build rule: "a sighting counts in the hour its
     * first_ms falls in"), not by how long it ran, so a still-open event
     * that started inside the window belongs here even though it has not
     * finished, and one that started before the window but is still running
     * now does not.
     *
     * `cameraIds` must be a non-empty array of camera ids the caller already
     * validated (e.g. one requested camera, or the server's whole configured
     * list) — an empty array answers `[]` rather than the SQL-invalid
     * `IN ()`, and is never itself "no filter" (that is what the caller
     * passing every configured camera means instead).
     */
    eventsInWindow(cameraIds, startUtc, endUtc) {
      if (!Array.isArray(cameraIds) || cameraIds.length === 0) return [];
      const rows = eventsInWindowStmt(cameraIds.length).all(...cameraIds, fromIso(startUtc), fromIso(endUtc));
      return rows.map((r) => ({
        cameraId: r.camera_id,
        kind: r.kind,
        firstMs: Number(r.first_ms),
        suppressedBy: r.suppressed_by ?? null,
      }));
    },

    /**
     * The earliest `first_ms` still stored for these cameras, as an ISO
     * instant — the activity page's `countsFromUtc` (ACTIVITY-PAGE-SPEC.md):
     * "the oldest event still held, meaning how far back the video, and so
     * the counts, reach". Events retention deletes an event only once its
     * own footage is gone (EVENTS-RETENTION-SPEC.md), so this is a real
     * measurement of that boundary, not a guess.
     *
     * `null` when these cameras have no events at all — genuinely different
     * from "everything is older than instant X": it means there is no X to
     * compare against yet, so the caller must not treat every bucket as
     * "before the oldest video" just because this came back empty.
     */
    oldestFirstMs(cameraIds) {
      if (!Array.isArray(cameraIds) || cameraIds.length === 0) return null;
      const row = oldestFirstMsStmt(cameraIds.length).get(...cameraIds);
      return row?.m === null || row?.m === undefined ? null : Number(row.m);
    },

    close() {
      db.close();
    },
  };
}
