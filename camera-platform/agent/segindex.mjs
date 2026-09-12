/**
 * The segment index, on SQLite (node:sqlite — built into Node 22, no dependency).
 *
 * WHY not JSON: 16 cameras x 60s segments x 30 days is ~691,000 rows. A JSON
 * file of that is ~100 MB rewritten on every seal.
 *
 * The rule this layer must not break: NULL round-trips as NULL. `bytes` on an
 * open segment and `bitrate_kbps` on an unmeasured one are unknown, not zero,
 * and a storage layer that coerces them is where "a blank is not a zero" quietly
 * stops being true.
 */
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS segments (
  camera_id      TEXT    NOT NULL,
  start_ms       INTEGER NOT NULL,
  end_ms         INTEGER,
  path           TEXT    NOT NULL UNIQUE,
  bytes          INTEGER,
  state          TEXT    NOT NULL,
  hold           INTEGER NOT NULL DEFAULT 0,
  pending_upload INTEGER NOT NULL DEFAULT 0,
  bitrate_kbps   INTEGER,
  PRIMARY KEY (camera_id, start_ms)
);
CREATE INDEX IF NOT EXISTS idx_segments_start ON segments(start_ms);
CREATE INDEX IF NOT EXISTS idx_segments_state ON segments(state);
CREATE TABLE IF NOT EXISTS gaps (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id TEXT    NOT NULL,
  start_ms  INTEGER NOT NULL,
  end_ms    INTEGER NOT NULL,
  reason    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gaps_camera ON gaps(camera_id, start_ms);
`;

const toIso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const fromIso = (iso) => (iso === null || iso === undefined ? null : Date.parse(iso));

function rowToSegment(row) {
  return {
    cameraId: row.camera_id,
    startUtc: toIso(row.start_ms),
    endUtc: toIso(row.end_ms),
    path: row.path,
    bytes: row.bytes,                 // NULL stays null
    state: row.state,
    hold: row.hold === 1,
    pendingUpload: row.pending_upload === 1,
    bitrateKbps: row.bitrate_kbps,    // NULL stays null
  };
}

export function openIndex(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");   // survives a power cut mid-write
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);

  const stmts = {
    upsert: db.prepare(`
      INSERT INTO segments (camera_id,start_ms,end_ms,path,bytes,state,hold,pending_upload,bitrate_kbps)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(camera_id,start_ms) DO UPDATE SET
        end_ms=excluded.end_ms, path=excluded.path, bytes=excluded.bytes,
        state=excluded.state, hold=excluded.hold,
        pending_upload=excluded.pending_upload, bitrate_kbps=excluded.bitrate_kbps`),
    byPath: db.prepare("SELECT * FROM segments WHERE path = ?"),
    // The API serves by the client-facing id (cameraId + startMs), never by
    // path — a client never sends a path and the server never builds one from
    // what a client sent.
    byKey: db.prepare("SELECT * FROM segments WHERE camera_id = ? AND start_ms = ?"),
    all: db.prepare("SELECT * FROM segments ORDER BY start_ms"),
    byCamera: db.prepare("SELECT * FROM segments WHERE camera_id = ? ORDER BY start_ms"),
    inRange: db.prepare(`SELECT * FROM segments WHERE camera_id = ?
      AND start_ms < ? AND (end_ms IS NULL OR end_ms > ?) ORDER BY start_ms`),
    byState: db.prepare("SELECT * FROM segments WHERE state = ? ORDER BY start_ms"),
    // Eviction candidates, oldest first, already filtered to what may be
    // deleted. Loading the whole index to find these took 6.8s and 180 MB of
    // objects at 30 days of retention; this is the same answer in milliseconds.
    oldestEvictable: db.prepare(`SELECT * FROM segments
      WHERE hold = 0 AND pending_upload = 0 AND state != 'open' AND bytes IS NOT NULL
      ORDER BY start_ms LIMIT ?`),
    delByPath: db.prepare("DELETE FROM segments WHERE path = ?"),
    totalBytes: db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM segments"),
    countAll: db.prepare("SELECT COUNT(*) AS n FROM segments"),
    addGap: db.prepare("INSERT INTO gaps (camera_id,start_ms,end_ms,reason) VALUES (?,?,?,?)"),
    gapsFor: db.prepare("SELECT * FROM gaps WHERE camera_id = ? ORDER BY start_ms"),
  };

  return {
    db,
    put(segment) {
      stmts.upsert.run(
        segment.cameraId,
        fromIso(segment.startUtc),
        fromIso(segment.endUtc),
        segment.path,
        segment.bytes,
        segment.state,
        segment.hold ? 1 : 0,
        segment.pendingUpload ? 1 : 0,
        segment.bitrateKbps,
      );
    },
    /** Many segments in one transaction — sealing is frequent and fsync is not free. */
    putMany(segments) {
      this.db.exec("BEGIN");
      try {
        for (const s of segments) this.put(s);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    },
    get(path) {
      const row = stmts.byPath.get(path);
      return row ? rowToSegment(row) : null;
    },
    getByKey(cameraId, startMs) {
      const row = stmts.byKey.get(cameraId, startMs);
      return row ? rowToSegment(row) : null;
    },
    all: () => stmts.all.all().map(rowToSegment),
    forCamera: (cameraId) => stmts.byCamera.all(cameraId).map(rowToSegment),
    inRange: (cameraId, startUtc, endUtc) =>
      stmts.inRange.all(cameraId, fromIso(endUtc), fromIso(startUtc)).map(rowToSegment),
    withState: (state) => stmts.byState.all(state).map(rowToSegment),
    oldestEvictable: (limit) => stmts.oldestEvictable.all(limit).map(rowToSegment),
    remove: (path) => stmts.delByPath.run(path),
    removeMany(paths) {
      this.db.exec("BEGIN");
      try {
        for (const p of paths) stmts.delByPath.run(p);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    },
    totalBytes: () => stmts.totalBytes.get().total,
    count: () => stmts.countAll.get().n,
    addGap: (gap) => stmts.addGap.run(gap.cameraId, fromIso(gap.startUtc), fromIso(gap.endUtc), gap.reason),
    gapsFor: (cameraId) => stmts.gapsFor.all(cameraId).map((r) => ({
      cameraId: r.camera_id, startUtc: toIso(r.start_ms), endUtc: toIso(r.end_ms), reason: r.reason,
    })),
    close: () => db.close(),
  };
}
