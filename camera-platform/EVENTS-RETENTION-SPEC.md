# Events retention: an event lives exactly as long as its video

Decided by the owner 2026-09-23: *"events stay with the video and does not
delete until the saved recording deletes."* There is no separate events-days
setting. Plate reads' `plateRetentionDays` is unrelated and untouched.

## Why this is needed

Nothing deletes an `events.db` row today (`agent/events-db.mjs` says so).
Video is deleted by the recorder every 5 minutes, oldest first, per drive
(`agent/recorder-service.mjs` `runAgeEviction` then `runEviction`). The bench
holds about 30 hours of video, yet its events go back days: about 3,450 in 4
days, mostly one parked car recounted.

## The rule

For each camera C, **footageFromMs(C)** is the `start_ms` of the oldest segment
row the recording index still holds for C (`segindex` `earliestFor`). The
index row goes only AFTER the file is unlinked (`agent/segstore.mjs`
`applyEviction`, then `index.removeMany`). So everything C recorded before
footageFromMs(C) is gone from disk.

An event E of camera C is deleted when, and only when:

    E.last_ms < footageFromMs(C) - EVENT_RETENTION_MARGIN_MS   (5,000 ms)

- **No remaining video overlaps the event.** Every remaining segment starts at
  or after footageFromMs(C), and that is later than E ends.
- **An event straddling the oldest video is kept** until ALL of its video is
  gone.
- **Held footage keeps its events.** A held segment (`hold` /
  `pending_upload`, never evicted) stays in the index, so footageFromMs(C)
  cannot pass it. Events after it are kept. This is conservative: it keeps
  more, never less.
- **The margin covers clock precision.** Segment starts come from a
  1-second-precision filename. Event stamps are ffmpeg arrival wall clock.
  Events from before the 2026-09-23 lag fix carry read-time stamps, which
  are LATE, never early, so they only make events look newer. 5 s covers
  both, and costs at most one extra segment's worth of events kept for one
  extra pass.
- **An event in progress is never deleted.** Its last_ms is about now, which
  is at or after footageFromMs(C) whenever C has any footage. There is no
  `finished` filter, so a crash-leftover unfinished row does not leak forever.
- **No footage in the index means keep.** If C has no segment rows, keep
  every event of C and REPORT it (reason `no_footage_in_index`). That covers
  a camera removed from config whose footage has all aged out, a
  detection-only camera, and a recorder that never ran. Refuse rather than
  guess (build rule 10). Never borrow another camera's horizon: cameras sit
  on different drives with different retention.
- **Index unreadable, or events.db missing: delete nothing.** Report why,
  never create events.db (the API opens it only if it exists).
- **Suppressed events are no different.** Known-object matching compares new
  detections against the object's own stored box and never re-reads old
  rows. `memberEventIds` tolerates dangling ids. The sample still already
  fails once the video is gone.

## Shape (build rules 1 and 2: contract, then harness, then wiring)

1. **`contracts/eventRetention.ts`** (pure, no I/O).
   - `EVENT_RETENTION_MARGIN_MS = 5000`.
   - `planEventRetention({ cameras, footageFromMs, marginMs })`:
     - `cameras`: `[{ cameraId, events }]` from events.db.
     - `footageFromMs`: a Map or record of cameraId to number or null.
     - Returns `{ prune: [{ cameraId, beforeMs }], keep: [{ cameraId,
       events, reason }] }`.
   - Units in every name.
   - A non-finite or negative footageFromMs counts as missing, never 0.

2. **`harness/eventRetention.harness.mjs`.** Test the failure feared: an event
   deleted while any of its video remains.
   - Boundaries: just inside and just outside the margin, straddling.
   - A camera with no footage.
   - A NaN, null, 0 or negative horizon.
   - An empty events list.

3. **I/O module `agent/event-retention.mjs`:**
   - `runEventRetention({ eventsDb, index, now, batch, dryRun })`.
   - Gets the distinct camera ids in events.db and their counts (new
     events-db method, via `idx_events_camera_first`).
   - Asks the index for each camera's `earliestFor`.
   - Plans with the contract, then deletes in batches: new events-db method
     `deleteEndedBefore(cameraId, beforeMs, limit)`, which runs `DELETE ...
     WHERE id IN (SELECT id ... WHERE camera_id=? AND first_ms < ? AND
     last_ms < ? LIMIT ?)`. The `first_ms` bound lets the camera index do
     the work.
   - Yields between batches (setImmediate) so HTTP stays responsive.
   - Returns counts only: deleted per camera, kept per camera with reason,
     footageFrom per camera as ISO, error. Never a path, never a URL.
   - `dryRun` counts what would go and deletes nothing.

4. **Wiring in `agent/api-server.mjs`:**
   - Run once at start, then every 5 minutes, unref()'d like
     `stillsCleanupTimer`.
   - Never two runs at once.
   - Uses the existing lazy `openEvents()` (null means no events.db: skip)
     and the existing `index`.
   - After each run, write `<stateDir>/event-retention.json` (tmp then
     rename) with `{ atUtc, marginMs, deleted, deletedSinceStart, cameras:
     [...], kept: [...], busyCameras: [...], error }`, and log one line
     when deleted > 0.
   - `busyCameras` lists cameras a pass stopped early because the detector
     held the write lock (a delete waits at most 200 ms, never the normal
     5 s, so the server cannot freeze).
   - On an error, `deleted` still counts every batch that already landed.
   - An error is caught, logged and recorded. It never stops the server.
   - Expose a close hook for harnesses the same way the stills timer does.

5. **`camctl events-retention`.** Read-only: prints the dry-run plan and the
   last `event-retention.json`. Counts and times only.

6. **Review page.** If the Review page shows a known object's sample still
   (`/event-crop?id=`), it must treat 404 `no_such_event` the same as
   `footage_gone` (a quiet "picture no longer available"), since the row now
   goes with its video.

## Out of scope for this pass (report, do not build)

- Gate-window day files and the `/still` cache keep their fixed 7 days. Both
  already refuse moments whose footage is gone.
- ~~One non-ENOENT unlink error aborting a whole eviction pass.~~ Fixed
  2026-09-23. `applyEviction` now records each failure and continues. Both
  eviction loops run each drive on its own. A failed file keeps its index
  row, so this rule still never sees video as gone while it exists.
- The `hold` / `pending_upload` flags are never set by production code today.
