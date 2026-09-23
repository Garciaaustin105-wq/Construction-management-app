/**
 * Events retention: an event lives exactly as long as its video.
 *
 * Decided by the owner 2026-09-23 (EVENTS-RETENTION-SPEC.md): there is no
 * separate events-days setting. An event of camera C is deleted when, and
 * only when, no remaining video overlaps it: every segment the recording
 * index still holds for C starts at or after footageFromMs(C), and the
 * event's own last sighting ends before that (less a margin for clock
 * precision — see EVENT_RETENTION_MARGIN_MS below).
 *
 * This is pure planning only: it never opens events.db or the index. The I/O
 * module (agent/event-retention.mjs) reads footageFromMs(C) from the
 * recording index's earliestFor and does the actual deleting.
 */

/** Segment starts come from a 1-second-precision filename; event stamps are
 *  ffmpeg arrival wall clock, and events from before the 2026-09-23 lag fix
 *  carry read-time stamps, which are LATE, never early. 5 s covers both. */
export const EVENT_RETENTION_MARGIN_MS = 5000;

export interface CameraEventCount {
  cameraId: string;
  /** How many event rows this camera has in events.db right now — a count,
   *  never the events themselves: this plan prunes on footage horizons, not
   *  on what any one event contains. */
  events: number;
}

/** Why a camera's events are kept whole rather than pruned by a horizon. */
export type EventRetentionKeepReason = "no_footage_in_index";

export interface EventRetentionPlan {
  /** A camera whose events with `last_ms < beforeMs` may be deleted. Events
   *  at or after `beforeMs` are left alone — this plan says nothing about
   *  them, since it never reads individual events. */
  prune: { cameraId: string; beforeMs: number }[];
  /** A camera whose events are ALL kept, and why. */
  keep: { cameraId: string; events: number; reason: EventRetentionKeepReason }[];
}

/**
 * `footageFromMs`: cameraId -> the start of the oldest segment the recording
 * index still holds for that camera (segindex's `earliestFor`, already
 * converted from its ISO string with Date.parse — see build rule 9, numeric
 * wherever a value can be fractional, and rule 6, every quantity carries its
 * unit: the Ms suffix here), or `null`/missing when the camera has no
 * segment rows at all.
 *
 * A non-finite or negative value counts as missing, never as footage
 * starting at the epoch (build rule 5: a blank is not a zero) — refused into
 * "keep" rather than guessed into a prune that could delete everything.
 */
export type FootageFromMs = ReadonlyMap<string, number | null> | Readonly<Record<string, number | null>>;

function footageMsFor(footageFromMs: FootageFromMs, cameraId: string): number | null {
  const raw = footageFromMs instanceof Map
    ? footageFromMs.get(cameraId)
    : (footageFromMs as Readonly<Record<string, number | null>>)[cameraId];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * Plan which cameras' events may be pruned, and before what instant.
 *
 * Refuses to guess a camera's horizon (build rule 10): no footage in the
 * index for a camera is a REPORTED keep (`no_footage_in_index`), covering a
 * camera removed from config whose footage has all aged out, a
 * detection-only camera, and a recorder that never ran — never another
 * camera's horizon borrowed, since cameras sit on different drives with
 * different retention.
 */
export function planEventRetention({
  cameras,
  footageFromMs,
  marginMs = EVENT_RETENTION_MARGIN_MS,
}: {
  cameras: readonly CameraEventCount[];
  footageFromMs: FootageFromMs;
  marginMs?: number;
}): EventRetentionPlan {
  const prune: EventRetentionPlan["prune"] = [];
  const keep: EventRetentionPlan["keep"] = [];
  for (const { cameraId, events } of cameras) {
    const footageMs = footageMsFor(footageFromMs, cameraId);
    if (footageMs === null) {
      keep.push({ cameraId, events, reason: "no_footage_in_index" });
      continue;
    }
    prune.push({ cameraId, beforeMs: footageMs - marginMs });
  }
  return { prune, keep };
}
