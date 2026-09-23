/**
 * Events retention: an event lives exactly as long as its video
 * (EVENTS-RETENTION-SPEC.md). The pure decision is contracts/eventRetention.ts;
 * this file is the I/O around it — reading events.db and the recording index,
 * deleting in batches, and reporting what happened.
 *
 * Never opens events.db or the index itself: both are handed in already
 * open (or `eventsDb` is null, meaning there is none — see runEventRetention
 * below). agent/api-server.mjs wires this to its own lazy openEvents() and
 * its own index; camctl opens its own read-only copies for `events-retention`.
 */

import { planEventRetention, EVENT_RETENTION_MARGIN_MS } from "../dist/eventRetention.js";

export { EVENT_RETENTION_MARGIN_MS };

/** Rows deleted per call to deleteEndedBefore. Small enough that one batch
 *  never holds the write lock long enough to make an HTTP request wait. */
export const EVENT_RETENTION_BATCH = 500;

/** How often api-server.mjs runs this, once at start and then on this tick. */
export const EVENT_RETENTION_INTERVAL_MS = 5 * 60_000;

const toIso = (ms) => (ms === null ? null : new Date(ms).toISOString());

/** Yields to the event loop between batches so a long backlog never holds
 *  HTTP requests waiting behind it (spec section 3). */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Run one pass of events retention.
 *
 * `eventsDb` and `index` are already-open handles (agent/events-db.mjs,
 * agent/segindex.mjs) — this function opens neither and closes neither.
 * `eventsDb === null` means there is no events.db on this box (api-server's
 * openEvents() answers null rather than creating one): nothing is read,
 * nothing is deleted, nothing is created here either.
 *
 * Returns counts only — never a path, never a URL:
 *   { atUtc, marginMs, deleted, cameras: [{ cameraId, deleted, footageFromUtc }],
 *     kept: [{ cameraId, events, reason }], busyCameras: [cameraId], error }
 * busyCameras: cameras this pass stopped early because detect-service held
 * the write lock; their remaining events go on a later pass (rule 16: say
 * what could not be done). On an error, `deleted` and `cameras` still say
 * what was already deleted before it: rows gone are gone, and reporting 0
 * would be a wrong measurement.
 *
 * `dryRun: true` reports what WOULD be deleted (the same total a real run
 * would remove given enough batches) and deletes nothing.
 *
 * Refuses rather than guesses (build rule 10): an index that cannot be read
 * is reported as `error` and nothing is deleted, never partially acted on.
 */
export async function runEventRetention({
  eventsDb,
  index,
  now = () => new Date(),
  batch = EVENT_RETENTION_BATCH,
  dryRun = false,
}) {
  const atUtc = now().toISOString();
  const empty = { atUtc, marginMs: EVENT_RETENTION_MARGIN_MS, deleted: 0, cameras: [], kept: [], busyCameras: [], error: null };

  // events.db absent is the caller's null: nothing is read, nothing created.
  if (eventsDb === null || eventsDb === undefined) return empty;

  const cameras = [];
  const busyCameras = [];
  let deleted = 0;
  try {
    const cameraCounts = eventsDb.cameraEventCounts();
    if (cameraCounts.length === 0) return empty;

    // Index unreadable is refused whole (rule 10), not camera by camera: a
    // recording index that cannot answer earliestFor for ONE camera cannot be
    // trusted for the others sharing the same file, either.
    const footageFromMs = new Map();
    for (const { cameraId } of cameraCounts) {
      const iso = index.earliestFor(cameraId);
      const ms = iso === null ? null : Date.parse(iso);
      footageFromMs.set(cameraId, Number.isFinite(ms) ? ms : null);
    }

    const plan = planEventRetention({ cameras: cameraCounts, footageFromMs, marginMs: EVENT_RETENTION_MARGIN_MS });

    for (const { cameraId, beforeMs } of plan.prune) {
      let cameraDeleted;
      if (dryRun) {
        cameraDeleted = eventsDb.deleteEndedBefore(cameraId, beforeMs, batch, { dryRun: true });
        deleted += cameraDeleted;
      } else {
        cameraDeleted = 0;
        // Batches, not one huge DELETE: a camera with years of stale rows
        // (the 3,450-in-4-days case the spec measured) must not hold the
        // write lock for the whole backlog in one transaction.
        for (;;) {
          const n = eventsDb.deleteEndedBefore(cameraId, beforeMs, batch);
          // null means detect-service held the write lock at this instant
          // (found in review: a real delete now runs under a short
          // busy_timeout precisely so this never turns into a multi-second
          // stall — see deleteEndedBefore). Stop THIS camera for THIS pass;
          // whatever is left is still correct to delete and the next tick
          // (or the next batch, next time) will pick it up. Never treated as
          // "nothing left" (which would stop the loop the same way `n < batch`
          // does) and never retried in a tight loop that would just spin on
          // the same lock.
          if (n === null) {
            busyCameras.push(cameraId);
            break;
          }
          // Counted per batch, as it lands: if a later batch throws, the
          // rows this one already removed are still in the reported total.
          cameraDeleted += n;
          deleted += n;
          if (n < batch) break;
          await yieldToEventLoop();
        }
      }
      cameras.push({ cameraId, deleted: cameraDeleted, footageFromUtc: toIso(footageFromMs.get(cameraId)) });
    }

    const kept = plan.keep.map(({ cameraId, events, reason }) => ({ cameraId, events, reason }));
    return { atUtc, marginMs: EVENT_RETENTION_MARGIN_MS, deleted, cameras, kept, busyCameras, error: null };
  } catch (err) {
    // A mid-run failure is reported, never swallowed - and so is whatever was
    // already deleted before it threw: `deleted` counts every batch that
    // landed, including those of a camera cut off mid-way, which is why that
    // camera is missing from `cameras` but not from the total.
    return { ...empty, deleted, cameras, busyCameras, error: String(err?.message ?? err) };
  }
}
