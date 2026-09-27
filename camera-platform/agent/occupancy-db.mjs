/**
 * Occupancy database: the transition log for manager rules' presence
 * tracking (MANAGER-RULES-SPEC.md section 2). agent/detect-service.mjs is
 * its ONLY writer -- every row here is a transition contracts/zoneOccupancy.ts's
 * `advanceOccupancy` actually returned, one (area, kind) state change at a
 * time, never a raw frame or a guess.
 *
 * Small, synchronous writes (one row per transition, no batching): a busy
 * frame path cannot afford to wait on this file, and a failure to open or
 * write it is the CALLER's to catch and log -- this module throws plainly on
 * either, exactly like agent/events-db.mjs's own openEventsDb/upsert, so
 * "never thrown into the frame path" is a discipline detect-service.mjs
 * keeps, not one this file has to fake by swallowing errors itself.
 *
 * Retention (deleting transitions older than the camera's oldest footage) is
 * EVENTS-RETENTION-SPEC.md's own pass, a separate owner (build rule 3: this
 * file only writes and reads rows, it never decides how long to keep them).
 */

import { DatabaseSync } from "node:sqlite";

export const OCCUPANCY_DB_FILE = "occupancy.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS occupancy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id TEXT NOT NULL,
  camera_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
-- The evaluator's own read shape (MANAGER-RULES-SPEC.md section 3): one
-- rule's (area, kind) transition stream, chronological.
CREATE INDEX IF NOT EXISTS idx_occupancy_area_kind_at ON occupancy(area_id, kind, at_ms);
-- Events-retention's own shape: every transition for one camera, by time.
CREATE INDEX IF NOT EXISTS idx_occupancy_camera_at ON occupancy(camera_id, at_ms);

-- Manager-of-the-day appearance matches (APPEARANCE-OF-DAY-SPEC.md,
-- MANAGER-RULES-SPEC.md build 3): one row per person detection that matched
-- today's signature ("On each person detection on any camera, detect-service
-- compares the signature with today's. At or above the match threshold, that
-- detection is a 'manager match' with its %"), for each area that detection's
-- box lies inside -- agent/detect-service.mjs is its only writer, fed by the
-- SAME per-frame loop that already writes the 'occupancy' table above, never
-- from a signature itself (which never reaches this database at all -- only
-- a similarity percentage and which of today's one or two managers it was
-- closer to). NEVER a name, NEVER a face, NEVER the 145-number signature.
-- Read by agent/api-server.mjs's evaluator for the "Manager leaves" /
-- "Manager returns" templates (contracts/managerRules.ts's own
-- deriveManagerLeaveEpisodes, evaluateManagerLeavesRule/
-- evaluateManagerReturnsRule) against one area's own stream at a time -- the
-- rule's chosen door/exit area, or the site's one manager's-desk area.
-- Wiped whole whenever appearance-today.json itself is wiped (local
-- midnight, a stale-date start, or the appearanceOfDay switch turning off) --
-- "Those rows are deleted with the nightly wipe, since they derive from the
-- signature" -- never by the footage-based retention pass the 'occupancy'
-- table above uses, because these rows do not describe what a camera saw,
-- they describe a comparison against a signature that no longer exists.
CREATE TABLE IF NOT EXISTS manager_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id TEXT NOT NULL,
  camera_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  which TEXT NOT NULL,
  similarity_percent REAL NOT NULL
);
-- The evaluator's own read shape: one area's own sighting stream, chronological.
CREATE INDEX IF NOT EXISTS idx_manager_matches_area_at ON manager_matches(area_id, at_ms);
`;

/** Short: this file's writer (detect-service) is a single short-lived
 *  process making one small insert at a time, never a batch; a reader (the
 *  future rule evaluator, or a harness) that happens to overlap a write
 *  should see "try again" quickly, not stall the frame path that is waiting
 *  on the SAME insert to return. */
const BUSY_TIMEOUT_MS = 2000;

/** events-db.mjs's own retention-write timeout, restated here for the same
 *  reason (agent/event-retention.mjs's own extension, MANAGER-RULES-SPEC.md:
 *  "Retention deletes transitions ... older than the footage"): a real
 *  delete against this file competes with detect-service's OWN inserts from
 *  a separate process, and this connection's normal BUSY_TIMEOUT_MS (2000)
 *  would freeze api-server.mjs's whole event loop for up to 2 s waiting on
 *  detect-service's write lock. Deletes alone borrow this short window. */
const RETENTION_WRITE_BUSY_TIMEOUT_MS = 200;

function isSqliteBusy(err) {
  return Boolean(err) && err.code === "ERR_SQLITE_ERROR"
    && (err.errcode === 5 || /database is locked/i.test(String(err.message ?? "")));
}

export function openOccupancyDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    "INSERT INTO occupancy (area_id, camera_id, kind, state, at_ms) VALUES (?, ?, ?, ?, ?)",
  );
  const forAreaKindStmt = db.prepare(
    "SELECT state, at_ms AS atMs FROM occupancy WHERE area_id = ? AND kind = ? ORDER BY at_ms, id",
  );
  const insertManagerMatchStmt = db.prepare(
    "INSERT INTO manager_matches (area_id, camera_id, at_ms, which, similarity_percent) VALUES (?, ?, ?, ?, ?)",
  );
  const managerMatchesForAreaStmt = db.prepare(
    "SELECT at_ms AS atMs, which, similarity_percent AS similarityPercent FROM manager_matches WHERE area_id = ? ORDER BY at_ms, id",
  );
  const clearManagerMatchesStmt = db.prepare("DELETE FROM manager_matches");
  const allStmt = db.prepare(
    "SELECT id, area_id AS areaId, camera_id AS cameraId, kind, state, at_ms AS atMs FROM occupancy ORDER BY at_ms, id",
  );
  // Retention's own shape (agent/event-retention.mjs's planEventRetention,
  // reused as-is): how many transition rows each camera has right now, and a
  // batched delete of the oldest ones before a given instant.
  const cameraRowCountsStmt = db.prepare("SELECT camera_id AS cameraId, COUNT(*) AS n FROM occupancy GROUP BY camera_id ORDER BY camera_id");
  const deleteBeforeStmt = db.prepare(
    "DELETE FROM occupancy WHERE id IN (SELECT id FROM occupancy WHERE camera_id = ? AND at_ms < ? LIMIT ?)",
  );

  /** One transition: `{ areaId, cameraId, kind, state, atMs }` -- exactly a
   *  contracts/zoneOccupancy.ts `OccupancyTransition` plus the (area,
   *  camera, kind) it belongs to, which the pure tracker itself never knows. */
  function insert(t) {
    insertStmt.run(t.areaId, t.cameraId, t.kind, t.state, t.atMs);
  }

  /** This (area, kind)'s own transition stream, chronological -- what the
   *  rule evaluator (agent/api-server.mjs) reads per rule. */
  function transitionsFor(areaId, kind) {
    return forAreaKindStmt.all(areaId, kind);
  }

  function cameraRowCounts() {
    return cameraRowCountsStmt.all().map((r) => ({ cameraId: r.cameraId, events: Number(r.n) }));
  }

  /**
   * Delete up to `limit` transitions for one camera older than `beforeMs`.
   * Runs under a SHORT busy_timeout, restored unconditionally afterward, and
   * returns `null` (never throws, never zero) on a lock miss -- "try again
   * next pass", the exact discipline events-db.mjs's own deleteEndedBefore
   * keeps for the same reason: this file's real writer is a different,
   * continuously-running process (detect-service.mjs), and this connection's
   * normal busy_timeout would otherwise stall every HTTP request on this
   * server for up to BUSY_TIMEOUT_MS waiting for a frame-path insert to let go.
   */
  function deleteEndedBefore(cameraId, beforeMs, limit) {
    if (typeof cameraId !== "string" || cameraId === "") {
      throw new TypeError(`deleteEndedBefore needs a camera id, not ${JSON.stringify(cameraId)}`);
    }
    if (!Number.isFinite(beforeMs)) {
      throw new RangeError(`deleteEndedBefore needs a real instant in ms, not ${JSON.stringify(beforeMs)}`);
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`deleteEndedBefore needs a positive whole-number limit, not ${JSON.stringify(limit)}`);
    }
    db.exec(`PRAGMA busy_timeout = ${RETENTION_WRITE_BUSY_TIMEOUT_MS}`);
    try {
      return Number(deleteBeforeStmt.run(cameraId, beforeMs, limit).changes);
    } catch (err) {
      if (isSqliteBusy(err)) return null;
      throw err;
    } finally {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  /** Every row, for a harness (or a future export) -- never used on the
   *  frame path itself. */
  function all() {
    return allStmt.all();
  }

  /** One manager-match sighting: `{ areaId, cameraId, atMs, which,
   *  similarityPercent }` -- exactly a contracts/managerRules.ts
   *  `ManagerMatchSighting` plus the (area, camera) it belongs to, which that
   *  pure type never knows. Never thrown into the frame path by the caller
   *  (agent/detect-service.mjs) -- this function itself throws plainly on a
   *  real failure, the same discipline `insert` already keeps for
   *  occupancy transitions. */
  function insertManagerMatch(m) {
    insertManagerMatchStmt.run(m.areaId, m.cameraId, m.atMs, m.which, m.similarityPercent);
  }

  /** One area's own manager-match sighting stream, chronological -- what the
   *  "Manager leaves"/"Manager returns" evaluator (agent/api-server.mjs)
   *  reads for the rule's own door/exit area, and separately for the site's
   *  one manager's-desk area. */
  function managerMatchesForArea(areaId) {
    return managerMatchesForAreaStmt.all(areaId);
  }

  /** Delete every manager-match row -- the nightly wipe (or a stale-date
   *  start, or the appearanceOfDay switch turning off): "those rows are
   *  deleted with the nightly wipe, since they derive from the signature"
   *  (APPEARANCE-OF-DAY-SPEC.md). Whole-table, never a footage-based cutoff
   *  -- these rows are never retained past the day they were matched on,
   *  whatever the camera's own footage horizon is. */
  function clearManagerMatches() {
    clearManagerMatchesStmt.run();
  }

  function close() {
    db.close();
  }

  return {
    insert, transitionsFor, cameraRowCounts, deleteEndedBefore, all, close,
    insertManagerMatch, managerMatchesForArea, clearManagerMatches,
  };
}
