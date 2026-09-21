/**
 * The footage query behind "how long is footage kept" (agent/healthfacts.mjs
 * footageFacts), run against a real index file.
 *
 * Found in review on 2026-09-21: a segment whose length was never measured (a
 * recovered orphan, or one ffprobe could not read) is sealed with no end_ms.
 * MAX(end_ms) over a group made only of those is NULL, which became 0, so the
 * camera's CURRENT drive could be judged to be an old one. And a segment's
 * bytes counted towards the day's rate while its missing duration did not,
 * which inflates the rate.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../agent/segindex.mjs";
import { footageFacts } from "../agent/healthfacts.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("healthFacts");

const NOW = Date.parse("2026-09-21T20:00:00.000Z");
const H = 3_600_000;
const dir = mkdtempSync(join(tmpdir(), "camplat-healthfacts-"));
const index = openIndex(join(dir, "index.db"));
const seg = (cameraId, root, startMs, endMs, bytes, extra = {}) => ({
  cameraId,
  startUtc: new Date(startMs).toISOString(),
  endUtc: endMs === null ? null : new Date(endMs).toISOString(),
  path: `${root}/${cameraId}/${startMs}.mp4`,
  bytes,
  state: "sealed",
  hold: false,
  pendingUpload: false,
  bitrateKbps: null,
  root,
  ...extra,
});

try {
  index.put(seg("a", "/old", NOW - 30 * H, NOW - 30 * H + 60_000, 1e6));
  index.put(seg("a", "/new", NOW - 2 * H, null, 5e6));
  index.put(seg("a", "/new", NOW - 1 * H, null, 5e6));
  index.put(seg("b", "/new", NOW - 3 * H, NOW - 3 * H + 60_000, 7e6, { hold: true }));
  const rows = footageFacts(index, NOW);
  const onNew = rows.find((r) => r.cameraId === "a" && r.root === "/new");

  check("THE FEARED ONE: segments with no measured length still say when they were", () => {
    eq(onNew.newestMs, NOW - 1 * H, "newest is the latest START, a floor, not 0");
    eq(onNew.newestMs > rows.find((r) => r.root === "/old").newestMs, true,
      "so /new, not /old, reads as the drive the camera records to now");
  });

  check("a segment counts towards the day's rate in both bytes and time, or in neither", () => {
    eq(onNew.windowBytes, 0, "no bytes without a duration");
    eq(onNew.windowRecordedMs, 0, "and no duration");
    eq(onNew.bytes, 10e6, "but the bytes are still on the drive, and still counted there");
  });

  check("held segments are not rolling footage", () => {
    // Eviction cannot delete them, so they are left to the drive's otherBytes.
    eq(rows.some((r) => r.cameraId === "b"), false, "a held segment is not in the rows");
  });

  check("every value is a plain finite number", () => {
    for (const r of rows) {
      for (const k of ["segments", "bytes", "oldestMs", "newestMs", "recordedMs", "windowBytes", "windowRecordedMs"]) {
        eq(typeof r[k] === "number" && Number.isFinite(r[k]), true, `${r.cameraId}@${r.root} ${k} = ${r[k]}`);
      }
    }
  });

  check("the grouping uses an index, not a temporary sort of the whole table", () => {
    // The System page asks every 5 s. On 691,200 rows this was ~320 ms without
    // the index and ~130 ms with it.
    const plan = index.db
      .prepare(`EXPLAIN QUERY PLAN SELECT camera_id, root, COUNT(*) FROM segments
                 WHERE state = 'sealed' AND COALESCE(hold, 0) = 0 AND COALESCE(pending_upload, 0) = 0
                 GROUP BY camera_id, root`)
      .all()
      .map((r) => r.detail)
      .join(" | ");
    eq(/idx_segments_state_camera_root/.test(plan), true, `uses the index: ${plan}`);
    eq(/TEMP B-TREE/.test(plan), false, "and builds no temporary B-tree");
  });
} finally {
  index.close();
  rmSync(dir, { recursive: true, force: true });
}

report("healthFacts");
