/**
 * Rules database: manager-rule firings (MANAGER-RULES-SPEC.md section 3).
 * agent/api-server.mjs's own evaluator (wired around contracts/managerRules.ts's
 * `evaluateManagerRule`) is its only writer — every row here is a firing that
 * function actually returned, never re-derived, never edited: build rule 7,
 * "a firing keeps the name it had", is enforced by this file simply never
 * offering an UPDATE.
 *
 * Unlike agent/occupancy-db.mjs, this file has exactly one process on either
 * end (agent/api-server.mjs writes it on its own 5 s timer and reads it back
 * for /reports and for retention) — there is no cross-process writer to wait
 * out the way events.db's detect-service/api-server split needs, so this
 * stays the same small, synchronous, no-batching shape occupancy-db.mjs
 * already uses rather than borrowing events-db.mjs's busy-timeout dance for a
 * contention this file never has.
 */

import { DatabaseSync } from "node:sqlite";

export const RULES_DB_FILE = "rules.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS firings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  camera_id TEXT NOT NULL,
  area_id TEXT,
  kind TEXT NOT NULL,
  what TEXT NOT NULL,
  complete INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  duration_ms INTEGER,
  text TEXT NOT NULL,
  alert_wanted INTEGER NOT NULL,
  report_wanted INTEGER NOT NULL
);
-- The evaluator's own cooldown read: this rule's most recent firing.
CREATE INDEX IF NOT EXISTS idx_firings_rule_end ON firings(rule_id, end_ms);
-- /reports' own read shape: every firing in a local day, oldest first.
CREATE INDEX IF NOT EXISTS idx_firings_start ON firings(start_ms);
-- Events-retention's own shape: every firing for one camera, by time.
CREATE INDEX IF NOT EXISTS idx_firings_camera_end ON firings(camera_id, end_ms);
-- Idempotent storage (build gap 2): (rule_id, what, start_ms) alone pins one
-- real event -- see this file's own header-adjacent comment on insert() for
-- why those three columns, and never rule_name, are the identity of a
-- firing. A second evaluator pass over the SAME transitions (a restarted
-- evaluator with lastFiredAtMs unavailable, or two overlapping ticks) must
-- never double-write; contracts/managerRules.ts's own evaluateManagerRule
-- already skips a candidate at or before lastFiredAtMs, but that is a
-- courtesy from the READER, not a guarantee from STORAGE -- this index is
-- the guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS idx_firings_dedup ON firings(rule_id, what, start_ms);
`;

const BUSY_TIMEOUT_MS = 2000;

export function openRulesDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(SCHEMA);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO firings (rule_id, rule_name, camera_id, area_id, kind, what, complete, start_ms, end_ms, duration_ms, text, alert_wanted, report_wanted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const lastFiredStmt = db.prepare("SELECT MAX(end_ms) AS m FROM firings WHERE rule_id = ?");
  const forRangeStmt = db.prepare(
    "SELECT rule_id AS ruleId, rule_name AS ruleName, camera_id AS cameraId, area_id AS areaId, kind, what, complete, start_ms AS startMs, end_ms AS endMs, duration_ms AS durationMs, text, alert_wanted AS alertWanted, report_wanted AS reportWanted FROM firings WHERE start_ms >= ? AND start_ms < ? ORDER BY start_ms, id",
  );
  const cameraRowCountsStmt = db.prepare("SELECT camera_id AS cameraId, COUNT(*) AS n FROM firings GROUP BY camera_id ORDER BY camera_id");
  const deleteEndedBeforeStmt = db.prepare(
    "DELETE FROM firings WHERE id IN (SELECT id FROM firings WHERE camera_id = ? AND (end_ms IS NOT NULL AND end_ms < ? OR end_ms IS NULL AND start_ms < ?) LIMIT ?)",
  );
  const allStmt = db.prepare(
    "SELECT rule_id AS ruleId, rule_name AS ruleName, camera_id AS cameraId, area_id AS areaId, kind, what, complete, start_ms AS startMs, end_ms AS endMs, duration_ms AS durationMs, text, alert_wanted AS alertWanted, report_wanted AS reportWanted FROM firings ORDER BY start_ms, id",
  );

  /**
   * One firing — exactly a contracts/managerRules.ts `ManagerRuleFiring`.
   * `INSERT OR IGNORE` against `idx_firings_dedup` (rule_id, what, start_ms):
   * re-inserting a firing this rule has already stored, byte-for-byte or
   * not, is silently dropped rather than duplicated OR updated — build
   * gap 2, "idempotent in storage, not only through the evaluator's
   * cooldown". `start_ms` alone (per rule, per `what`) already pins one real
   * occupancy event, for every condition contracts/managerRules.ts's own
   * evaluateManagerRule produces:
   *   - enters / leaves: the transition instant itself (`cur.atMs`) — one
   *     edge can only happen once;
   *   - absent_longer_than / present_longer_than: the STRETCH's own start,
   *     not the crossing instant — one clean stretch crosses its threshold
   *     at most once (contracts/managerRules.ts's own longerThanCandidates);
   *   - away_and_back, complete OR incomplete (ended by a return, or by
   *     sliding into not_watching — build gap 1's "away_and_back that ends
   *     in not_watching"): the DEPARTURE instant, not the return — one
   *     departure can only end once, whichever way it ends.
   * A rename changes only `rule_name`; it never touches `rule_id`, `what` or
   * `start_ms`, so IGNORE on a re-evaluated, renamed rule leaves the
   * ORIGINAL snapshot's name in the stored row untouched (build rule 7).
   */
  function insert(f) {
    insertStmt.run(
      f.ruleId, f.ruleName, f.cameraId, f.areaId, f.kind, f.what, f.complete ? 1 : 0,
      f.startMs, f.endMs, f.durationMs, f.text, f.alertWanted ? 1 : 0, f.reportWanted ? 1 : 0,
    );
  }

  const toBool = (r) => ({ ...r, complete: r.complete === 1, alertWanted: r.alertWanted === 1, reportWanted: r.reportWanted === 1 });

  /** The last time this rule fired (its most recent firing's endMs), for
   *  evaluateManagerRule's own `lastFiredAtMs` — null when it never has.
   *  evaluateManagerRule's own candidate generators always set `gateAtMs`
   *  equal to the firing's `endMs` (see contracts/managerRules.ts), so this
   *  column alone is the whole answer; no separate "fired at" column needed. */
  function lastFiredAtMs(ruleId) {
    const row = lastFiredStmt.get(ruleId);
    return row && typeof row.m === "number" ? row.m : null;
  }

  /** Every firing with `startMs` in `[fromMs, toMs)` — /reports' own read: a
   *  local day, already converted to a UTC ms range by the caller. */
  function firingsInRange(fromMs, toMs) {
    return forRangeStmt.all(fromMs, toMs).map(toBool);
  }

  /** Events-retention's own shape (agent/event-retention.mjs's `planEventRetention`
   *  reused as-is): how many firing rows each camera has right now. */
  function cameraRowCounts() {
    return cameraRowCountsStmt.all().map((r) => ({ cameraId: r.cameraId, events: Number(r.n) }));
  }

  /** Delete up to `limit` firings for one camera whose `endMs` (or, for the
   *  one shape that can lack it, `startMs`) is before `beforeMs` — the same
   *  batched-delete shape agent/event-retention.mjs already drives for
   *  events.db, reused for firings (MANAGER-RULES-SPEC.md: "Retention deletes
   *  transitions and firings older than the footage, never newer"). */
  function deleteEndedBefore(cameraId, beforeMs, limit) {
    return deleteEndedBeforeStmt.run(cameraId, beforeMs, beforeMs, limit).changes;
  }

  /** Every row, for a harness (or a future export) — never used on a hot path. */
  function all() {
    return allStmt.all().map(toBool);
  }

  function close() {
    db.close();
  }

  return { insert, lastFiredAtMs, firingsInRange, cameraRowCounts, deleteEndedBefore, all, close };
}
