/**
 * Events retention end to end (agent/event-retention.mjs), against REAL
 * temporary sqlite files opened with openEventsDb and openIndex — nothing
 * fake stands in for either database here (build rule 21: real data only in
 * a scoped, disposable copy).
 *
 * THE FEARED FAILURE, restated from EVENTS-RETENTION-SPEC.md: an event
 * deleted while any of its video remains. Every check below is that failure,
 * a boundary next to it, or one of the refusals the spec insists on.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventsDb } from "../agent/events-db.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { runEventRetention, EVENT_RETENTION_MARGIN_MS, EVENT_RETENTION_BATCH } from "../agent/event-retention.mjs";
import { check, mustAwait, eq, report } from "./_assert.mjs";

console.log("eventRetentionRun");

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-23T00:00:00.000Z");
const NOW = Date.parse("2026-09-23T06:00:00.000Z");
const MARGIN = EVENT_RETENTION_MARGIN_MS;

/** A fresh temp directory holding index.db and events.db, real sqlite files,
 *  torn down after each check. */
function site() {
  const dir = mkdtempSync(join(tmpdir(), "camplat-eventretention-"));
  const indexFile = join(dir, "index.db");
  const eventsFile = join(dir, "events.db");
  return {
    dir,
    indexFile,
    eventsFile,
    openIndex: () => openIndex(indexFile),
    openEvents: () => openEventsDb(eventsFile),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seg(cameraId, startMs, { lengthMs = 60_000, hold = false, root = "/d0", state = "sealed" } = {}) {
  return {
    cameraId, startUtc: iso(startMs), endUtc: iso(startMs + lengthMs),
    path: `${cameraId}/${startMs}.mp4`, bytes: 1000, state, hold, pendingUpload: false, bitrateKbps: 2000, root,
  };
}

let n = 0;
function event(cameraId, firstMs, lastMs, { finished = true, id } = {}) {
  n += 1;
  return {
    id: id ?? `${cameraId}:${firstMs}:${n}`,
    cameraId, kind: "person", firstUtc: iso(firstMs), lastUtc: iso(lastMs),
    count: 3, bestConfidence: 0.8, bestBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, bestUtc: iso(firstMs),
  };
}
const putEvent = (db, e, finished = true) => db.upsert({ id: e.id, event: e }, finished);
const now = () => new Date(NOW);

await mustAwait("THE FEARED ONE: an event entirely before the oldest footage is deleted; within the margin, straddling, and after it are kept", async () => {
  const s = site();
  try {
    const index = s.openIndex();
    index.put(seg("cam1", T0)); // footageFromMs(cam1) = T0
    index.close();

    const events = s.openEvents();
    const beforeFootage = event("cam1", T0 - 100_000, T0 - MARGIN - 1); // last_ms just outside the margin: deleted
    const withinMargin = event("cam1", T0 - 20_000, T0 - MARGIN + 1);   // last_ms just inside the margin: kept
    const straddling = event("cam1", T0 - 10_000, T0 + 2_000);          // spans the oldest segment's start: kept
    const afterFootage = event("cam1", T0 + 50_000, T0 + 60_000);       // entirely after: kept
    for (const e of [beforeFootage, withinMargin, straddling, afterFootage]) putEvent(events, e);
    events.close();

    const run = openEventsDb(s.eventsFile);
    const idx2 = openIndex(s.indexFile);
    try {
      const result = await runEventRetention({ eventsDb: run, index: idx2, now });
      eq(result.error, null, "no error");
      eq(result.deleted, 1, "exactly the one event entirely before the footage");
      eq(result.cameras, [{ cameraId: "cam1", deleted: 1, footageFromUtc: iso(T0) }], "reported against the footage horizon it used");
      eq(result.kept, [], "cam1 has footage, so it is not in the whole-camera keep list");
      const remaining = run.all().map((e) => e.id).sort();
      eq(remaining, [afterFootage.id, straddling.id, withinMargin.id].sort(), "THE FEARED ONE: nothing whose video still exists was deleted");
    } finally { run.close(); idx2.close(); }
  } finally { s.done(); }
});

await mustAwait("THE FEARED ONE: an event whose last_ms lands EXACTLY on the threshold (footageFromMs minus the margin) survives - the spec's own strict '<', not '<='", async () => {
  const s = site();
  try {
    const index = s.openIndex();
    index.put(seg("cam1", T0)); // footageFromMs(cam1) = T0, threshold = T0 - MARGIN
    index.close();

    const events = s.openEvents();
    // last_ms === T0 - MARGIN exactly: the contract's threshold itself.
    // EVENTS-RETENTION-SPEC.md is strict ("E.last_ms < ... - MARGIN"), and
    // deleteEndedBefore's SQL is `last_ms < ?` - this is the one instant
    // where flipping that to `<=` would delete a row that must be kept.
    const atThreshold = event("cam1", T0 - 200_000, T0 - MARGIN);
    putEvent(events, atThreshold);
    events.close();

    const run = openEventsDb(s.eventsFile);
    const idx2 = openIndex(s.indexFile);
    try {
      const result = await runEventRetention({ eventsDb: run, index: idx2, now });
      eq(result.deleted, 0, "THE FEARED ONE: nothing deleted - last_ms at the threshold is not < the threshold");
      eq(run.all().map((e) => e.id), [atThreshold.id], "the exact-threshold event survives");
    } finally { run.close(); idx2.close(); }
  } finally { s.done(); }
});

await mustAwait("held old footage pins the horizon: a segment under hold is never evicted, so events after it are kept even though a newer segment also exists", async () => {
  const s = site();
  try {
    const index = s.openIndex();
    // The oldest segment is HELD, so it is never evicted and stays the
    // earliest row forever; a newer, ordinary segment also exists, but
    // footageFromMs(cam2) must still be the held one's start, not the newer
    // segment's — anything else would let go of events the held footage
    // still covers.
    index.put(seg("cam2", T0 - 2_000_000, { hold: true }));
    index.put(seg("cam2", T0 - 10_000));
    index.close();

    const events = s.openEvents();
    // Between the held segment and the newer one: if footageFromMs had
    // (wrongly) advanced to the newer segment's start, this would be deleted;
    // pinned to the held segment, it is not.
    const pinnedByHold = event("cam2", T0 - 1_600_000, T0 - 1_500_000);
    // Genuinely older than even the held segment, less the margin: this one
    // really is gone.
    const trulyGone = event("cam2", T0 - 3_000_000, T0 - 2_500_000);
    putEvent(events, pinnedByHold);
    putEvent(events, trulyGone);
    events.close();

    const run = openEventsDb(s.eventsFile);
    const idx2 = openIndex(s.indexFile);
    try {
      const result = await runEventRetention({ eventsDb: run, index: idx2, now });
      eq(result.cameras, [{ cameraId: "cam2", deleted: 1, footageFromUtc: iso(T0 - 2_000_000) }], "the horizon used is the HELD segment's start");
      eq(run.all().map((e) => e.id), [pinnedByHold.id], "THE FEARED ONE: held footage's events survive; only the one truly before it goes");
    } finally { run.close(); idx2.close(); }
  } finally { s.done(); }
});

await mustAwait("a camera with no segments in the index at all is kept whole, and reported why", async () => {
  const s = site();
  try {
    const index = s.openIndex();
    index.put(seg("cam-with-footage", T0));
    index.close(); // cam-no-footage never appears in the index

    const events = s.openEvents();
    const orphan1 = event("cam-no-footage", T0 - 10_000_000, T0 - 9_000_000);
    const orphan2 = event("cam-no-footage", T0 - 5_000_000, T0 - 4_000_000);
    const covered = event("cam-with-footage", T0 - 10_000_000, T0 - 9_000_000); // this one IS old enough to go
    putEvent(events, orphan1);
    putEvent(events, orphan2);
    putEvent(events, covered);
    events.close();

    const run = openEventsDb(s.eventsFile);
    const idx2 = openIndex(s.indexFile);
    try {
      const result = await runEventRetention({ eventsDb: run, index: idx2, now });
      eq(result.kept, [{ cameraId: "cam-no-footage", events: 2, reason: "no_footage_in_index" }],
        "reported by name, with its count, never guessed at");
      eq(result.cameras, [{ cameraId: "cam-with-footage", deleted: 1, footageFromUtc: iso(T0) }], "the other camera is still pruned normally");
      eq(run.all().map((e) => e.id).sort(), [orphan1.id, orphan2.id].sort(), "THE FEARED ONE: a camera the index knows nothing of keeps every event, none borrowed from another camera's horizon");
    } finally { run.close(); idx2.close(); }
  } finally { s.done(); }
});

await mustAwait("an in-progress, unfinished, recent event is kept; a crash-leftover unfinished event that is genuinely old is not exempted forever", async () => {
  const s = site();
  try {
    const index = s.openIndex();
    index.put(seg("cam3", T0));
    index.close();

    const events = s.openEvents();
    const inProgress = event("cam3", NOW - 5_000, NOW - 1_000); // last_ms is "now", well after any footage horizon
    const crashLeftover = event("cam3", T0 - 10_000_000, T0 - 9_000_000); // old, and STILL marked unfinished
    putEvent(events, inProgress, false);
    putEvent(events, crashLeftover, false);
    events.close();

    const run = openEventsDb(s.eventsFile);
    const idx2 = openIndex(s.indexFile);
    try {
      const result = await runEventRetention({ eventsDb: run, index: idx2, now });
      eq(result.deleted, 1, "the old one goes despite being unfinished: THE SPEC'S OWN WORDS - there is no finished filter, so a crash-leftover row does not leak forever");
      eq(run.all().map((e) => e.id), [inProgress.id], "the one still in progress remains");
      eq(run.getById(inProgress.id).finished, false, "and its finished flag is untouched by retention");
    } finally { run.close(); idx2.close(); }
  } finally { s.done(); }
});

await mustAwait("THE FEARED ONE: more rows than fit in one batch are still all deleted, and the loop ends", async () => {
  const s = site();
  try {
    const index = s.openIndex();
    index.put(seg("cam4", T0));
    index.close();

    const SMALL_BATCH = 3;
    const TOTAL = SMALL_BATCH * 3 + 1; // several full batches plus a remainder
    const events = s.openEvents();
    const ids = [];
    for (let i = 0; i < TOTAL; i++) {
      const e = event("cam4", T0 - 10_000_000 + i * 1000, T0 - 9_000_000 + i * 1000);
      ids.push(e.id);
      putEvent(events, e);
    }
    // One kept event, well after the horizon, so the batch loop cannot
    // mistake "ran out of matching rows" for "deleted everything there was".
    const kept = event("cam4", T0 + 100_000, T0 + 110_000);
    putEvent(events, kept);
    events.close();

    const run = openEventsDb(s.eventsFile);
    const idx2 = openIndex(s.indexFile);
    try {
      const result = await runEventRetention({ eventsDb: run, index: idx2, now, batch: SMALL_BATCH });
      eq(result.deleted, TOTAL, `all ${TOTAL} deleted despite a batch size of ${SMALL_BATCH}`);
      eq(result.cameras, [{ cameraId: "cam4", deleted: TOTAL, footageFromUtc: iso(T0) }], "one camera entry, the batches summed");
      eq(run.all().map((e) => e.id), [kept.id], "and the loop stopped exactly where it should: the one row left is the one that should be");
    } finally { run.close(); idx2.close(); }
  } finally { s.done(); }
});

await mustAwait("dryRun: counts exactly what a real run would delete, deletes nothing", async () => {
  const s = site();
  try {
    const index = s.openIndex();
    index.put(seg("cam5", T0));
    index.close();

    const events = s.openEvents();
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const e = event("cam5", T0 - 10_000_000 + i * 1000, T0 - 9_000_000 + i * 1000);
      ids.push(e.id);
      putEvent(events, e);
    }
    const kept = event("cam5", T0 + 100_000, T0 + 110_000);
    putEvent(events, kept);
    events.close();

    const dryRunDb = openEventsDb(s.eventsFile);
    const dryIdx = openIndex(s.indexFile);
    let dry;
    try {
      dry = await runEventRetention({ eventsDb: dryRunDb, index: dryIdx, now, batch: 3, dryRun: true });
    } finally { dryRunDb.close(); dryIdx.close(); }
    eq(dry.deleted, 8, "counts every row a real run would eventually remove, not one batch's worth");
    eq(dry.cameras, [{ cameraId: "cam5", deleted: 8, footageFromUtc: iso(T0) }], "reported the same shape as a real run");

    // Nothing was deleted: re-open and confirm every row, then run for real
    // and confirm the SAME total actually goes.
    const checkDb = openEventsDb(s.eventsFile);
    eq(checkDb.all().length, 9, "THE FEARED ONE: dryRun deleted nothing");
    checkDb.close();

    const realDb = openEventsDb(s.eventsFile);
    const realIdx = openIndex(s.indexFile);
    let real;
    try {
      real = await runEventRetention({ eventsDb: realDb, index: realIdx, now, batch: 3 });
    } finally { realDb.close(); realIdx.close(); }
    eq(real.deleted, dry.deleted, "the dry run's count matches what actually goes");
    const after = openEventsDb(s.eventsFile);
    eq(after.all().map((e) => e.id), [kept.id], "and now it really is gone, except the one that should survive");
    after.close();
  } finally { s.done(); }
});

await mustAwait("events.db absent is the caller's null: nothing is read, nothing is deleted, nothing is created", async () => {
  const s = site();
  try {
    const index = s.openIndex();
    index.put(seg("cam6", T0));
    index.close();
    // s.eventsFile is never created.

    const idx2 = openIndex(s.indexFile);
    try {
      const result = await runEventRetention({ eventsDb: null, index: idx2, now });
      eq(result, { atUtc: NOW_ISO(), marginMs: MARGIN, deleted: 0, cameras: [], kept: [], busyCameras: [], error: null }, "a plain no-op result");
    } finally { idx2.close(); }
  } finally {
    // No events.db was ever created by the run above.
    eq(existsSync(s.eventsFile), false, "THE FEARED ONE: a run over a null events.db must never create one");
    s.done();
  }
});

function NOW_ISO() { return iso(NOW); }

await mustAwait("an index that cannot be read is refused whole: reported as an error, nothing deleted", async () => {
  const s = site();
  try {
    const index = s.openIndex();
    index.put(seg("cam7", T0));
    index.close();

    const events = s.openEvents();
    putEvent(events, event("cam7", T0 - 10_000_000, T0 - 9_000_000));
    events.close();

    const run = openEventsDb(s.eventsFile);
    const brokenIndex = { earliestFor: () => { throw new Error("index is corrupt"); } };
    try {
      const result = await runEventRetention({ eventsDb: run, index: brokenIndex, now });
      eq(result.deleted, 0, "nothing deleted");
      eq(result.cameras, [], "nothing reported as pruned");
      eq(result.kept, [], "nothing reported as kept either - the whole run is refused, not half-answered");
      eq(typeof result.error === "string" && result.error.includes("index is corrupt"), true, `names why: ${result.error}`);
      eq(run.all().length, 1, "the row is untouched");
    } finally { run.close(); }
  } finally { s.done(); }
});

// The two below drive runEventRetention with stand-ins for the database, so a
// lock miss and a mid-run failure can be made to happen on a chosen batch.
const fakeIndex = { earliestFor: () => iso(T0) };

await mustAwait("a camera stopped by detect-service's write lock is NAMED, not silently shorter", async () => {
  const eventsDb = {
    cameraEventCounts: () => [{ cameraId: "cam-busy", events: 900 }, { cameraId: "cam-free", events: 3 }],
    deleteEndedBefore: (cameraId) => (cameraId === "cam-busy" ? null : 3),
  };
  const result = await runEventRetention({ eventsDb, index: fakeIndex, now, batch: 500 });
  eq(result.error, null, "a lock miss is not an error");
  eq(result.busyCameras, ["cam-busy"], "the camera left for a later pass is listed");
  eq(result.deleted, 3, "the free camera was still pruned");
});

await mustAwait("an error after some batches landed still reports what was ALREADY deleted - rows gone are gone", async () => {
  let calls = 0;
  const eventsDb = {
    cameraEventCounts: () => [{ cameraId: "cam-a", events: 1200 }],
    deleteEndedBefore: () => {
      calls += 1;
      if (calls <= 2) return 500;
      throw new Error("disk I/O error");
    },
  };
  const result = await runEventRetention({ eventsDb, index: fakeIndex, now, batch: 500 });
  eq(typeof result.error === "string" && result.error.includes("disk I/O error"), true, `names why: ${result.error}`);
  eq(result.deleted, 1000, "the two batches that landed before the failure are counted, not reported as 0");
});

report("eventRetentionRun");
