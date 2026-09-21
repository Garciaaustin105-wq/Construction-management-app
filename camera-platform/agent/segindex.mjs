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
    root: row.root ?? null,
  };
}

export function openIndex(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");   // survives a power cut mid-write
  db.exec("PRAGMA synchronous = NORMAL");
  // The recorder, the API and camctl each open this file. A second writer
  // waits for the first instead of failing at once with "database is locked".
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  // Indexes made before segments recorded their drive gain the column; the
  // rows stay null until recovery sees their files (assignRoot).
  if (!db.prepare("PRAGMA table_info(segments)").all().some((c) => c.name === "root")) {
    db.exec("ALTER TABLE segments ADD COLUMN root TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_segments_root_start ON segments(root, start_ms)");
  // healthfacts.mjs footageFacts() groups sealed rows by camera and drive on
  // every GET /health (the System page polls every 5 s) and every 30 s health
  // write. Measured on 691,200 rows (16 cameras x 30 days): about 320 ms
  // without this index, which forces a temporary B-tree for the grouping;
  // about 130 ms with it.
  db.exec("CREATE INDEX IF NOT EXISTS idx_segments_state_camera_root ON segments(state, camera_id, root)");

  const stmts = {
    upsert: db.prepare(`
      INSERT INTO segments (camera_id,start_ms,end_ms,path,bytes,state,hold,pending_upload,bitrate_kbps,root)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(camera_id,start_ms) DO UPDATE SET
        end_ms=excluded.end_ms, path=excluded.path, bytes=excluded.bytes,
        state=excluded.state, hold=excluded.hold,
        pending_upload=excluded.pending_upload, bitrate_kbps=excluded.bitrate_kbps,
        root=COALESCE(excluded.root, segments.root)`),
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
    // The same, for one drive. A row whose drive is unknown is never offered:
    // deleting "the oldest" from the wrong drive frees nothing there and, on
    // ENOENT, drops footage that still exists from the index.
    oldestEvictableOn: db.prepare(`SELECT * FROM segments
      WHERE root = ? AND hold = 0 AND pending_upload = 0 AND state != 'open' AND bytes IS NOT NULL
      ORDER BY start_ms LIMIT ?`),
    setRoot: db.prepare("UPDATE segments SET root = ? WHERE path = ? AND root IS NOT ?"),
    // Past the age limit: ENDED before the cutoff, and deletable at all.
    olderOn: db.prepare(`SELECT * FROM segments
      WHERE root = ? AND end_ms IS NOT NULL AND end_ms < ?
        AND hold = 0 AND pending_upload = 0 AND state != 'open'
      ORDER BY start_ms LIMIT ?`),
    olderStats: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes, MIN(start_ms) AS oldest
      FROM segments WHERE end_ms IS NOT NULL AND end_ms < ?
        AND hold = 0 AND pending_upload = 0 AND state != 'open'`),
    delByPath: db.prepare("DELETE FROM segments WHERE path = ?"),
    totalBytes: db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM segments"),
    countAll: db.prepare("SELECT COUNT(*) AS n FROM segments"),
    addGap: db.prepare("INSERT INTO gaps (camera_id,start_ms,end_ms,reason) VALUES (?,?,?,?)"),
    extendGap: db.prepare("UPDATE gaps SET end_ms = MAX(end_ms, ?) WHERE id = ?"),
    pullGapStart: db.prepare("UPDATE gaps SET start_ms = MIN(start_ms, ?) WHERE id = ?"),
    gapsFor: db.prepare("SELECT * FROM gaps WHERE camera_id = ? ORDER BY start_ms"),
    earliestForCamera: db.prepare("SELECT start_ms FROM segments WHERE camera_id = ? ORDER BY start_ms LIMIT 1"),
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
        segment.root ?? null,
      );
    },
    /** Many segments in one transaction — sealing is frequent and fsync is not free. */
    putMany(segments) {
      db.exec("BEGIN");
      try {
        for (const s of segments) this.put(s);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
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
    /** Without `root`, across every drive: only right on a single-drive box. */
    oldestEvictable: (limit, root) => (root === undefined
      ? stmts.oldestEvictable.all(limit)
      : stmts.oldestEvictableOn.all(root, limit)).map(rowToSegment),
    /** Record that these paths were found on `root`. Returns rows changed. */
    assignRoot(root, paths) {
      let changed = 0;
      db.exec("BEGIN");
      try {
        for (const p of paths) changed += Number(stmts.setRoot.run(root, p, root).changes);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return changed;
    },
    /** Deletable segments on `root` that ended before `cutoffMs`, oldest first. */
    olderThan: (cutoffMs, root, limit) => stmts.olderOn.all(root, cutoffMs, limit).map(rowToSegment),
    /** What an age limit at `cutoffMs` would delete, on every drive. */
    olderThanStats(cutoffMs) {
      const r = stmts.olderStats.get(cutoffMs);
      return { segments: Number(r.n), bytes: Number(r.bytes), oldestUtc: toIso(r.oldest) };
    },
    remove: (path) => stmts.delByPath.run(path),
    removeMany(paths) {
      db.exec("BEGIN");
      try {
        for (const p of paths) stmts.delByPath.run(p);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    totalBytes: () => stmts.totalBytes.get().total,
    count: () => stmts.countAll.get().n,
    /** Returns the new gap's id, so an outage still going on can be extended. */
    addGap: (gap) => Number(stmts.addGap.run(gap.cameraId, fromIso(gap.startUtc), fromIso(gap.endUtc), gap.reason).lastInsertRowid),
    /** Moves a gap's end later; never earlier. */
    extendGap: (id, endUtc) => { stmts.extendGap.run(fromIso(endUtc), id); },
    /** Moves a gap's start earlier; never later. */
    pullGapStart: (id, startUtc) => { stmts.pullGapStart.run(fromIso(startUtc), id); },
    gapsFor: (cameraId) => stmts.gapsFor.all(cameraId).map((r) => ({
      cameraId: r.camera_id, startUtc: toIso(r.start_ms), endUtc: toIso(r.end_ms), reason: r.reason,
    })),
    /** Start of this camera's oldest held segment, or null when it holds none. */
    earliestFor: (cameraId) => {
      const row = stmts.earliestForCamera.get(cameraId);
      return row ? toIso(row.start_ms) : null;
    },
    close: () => db.close(),
  };
}
