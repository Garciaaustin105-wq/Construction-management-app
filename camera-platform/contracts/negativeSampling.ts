/**
 * Choosing WHEN to cut a matched negative. Pure: no I/O, no clock, no random.
 *
 * WHY: harvesting 34 crops of a parked car produced 34 pictures that all
 * contain the same porch post down the left edge and the same picket fence
 * along the bottom, because the camera is fixed and so is the car. A
 * classifier trained on that learns "post plus fence means vehicle" — the
 * cheapest shortcut in the data — and scores beautifully on its own camera
 * while being worthless anywhere else. The cure is negatives cut from the SAME
 * rectangle at moments the thing was not there, so the only difference between
 * the two piles is the object itself.
 *
 * WHAT THIS MODULE CANNOT KNOW, and the reason it refuses so readily: it sees
 * when something was DETECTED, not when it was PRESENT. A parked car is there
 * all night whether or not the detector says so on any given frame. So a
 * generous margin is kept around every sighting, and when quiet time is thin
 * the honest answer is "there are no negatives here" rather than a handful of
 * samples that quietly contain the very thing they are meant to exclude.
 */

/** Five minutes either side of every sighting. A car detected at 21:00 was
 *  almost certainly sitting there at 20:57 too. */
export const DEFAULT_MARGIN_MS = 5 * 60_000;

/** No two samples closer than this, so a pile of negatives is not one minute
 *  of one lighting condition repeated. */
export const DEFAULT_MIN_SPACING_MS = 30_000;

export interface BusySpan {
  startMs: number;
  endMs: number;
}

export interface SampleRequest {
  /** When the thing WAS detected. Sampling stays clear of these, plus margin. */
  busy: readonly BusySpan[];
  /** The footage actually held: nothing outside this can be cut. */
  availableFrom: number;
  availableTo: number;
  marginMs?: number;
  minSpacingMs?: number;
  count: number;
}

export interface SamplePlan {
  ok: true;
  /** Instants to cut, in time order. May be fewer than asked for. */
  instants: number[];
  /** What the caller asked for, so a shortfall cannot be quietly swallowed. */
  asked: number;
  /** asked - instants.length. Zero when the request was met in full. */
  shortfall: number;
  /** How much quiet time was available, in milliseconds. */
  quietMs: number;
}

export interface SampleRefusal {
  ok: false;
  reason: "bad_request" | "no_quiet_time";
  message: string;
}

function refuse(reason: SampleRefusal["reason"], message: string): SampleRefusal {
  return { ok: false, reason, message };
}

/**
 * Plan the instants to cut matched negatives from.
 *
 * 1. Refuse a request that cannot be read: no options, a window that does not
 *    run forwards, a count below one, a busy list that is not a list of spans.
 * 2. Widen every busy span by marginMs on both sides and merge the overlaps.
 * 3. Subtract them from [availableFrom, availableTo]. What is left is the
 *    quiet time. If none of it remains, refuse with "no_quiet_time" — that is
 *    the parked-car case, and there is nothing honest to return.
 * 4. Share the requested count across the quiet stretches in proportion to
 *    their length, so samples come from several stretches rather than only the
 *    longest, and no stretch is asked for more than it can hold at
 *    minSpacingMs apart.
 * 5. Within a stretch, space the samples evenly, inset by half a step so none
 *    sits exactly on a boundary.
 * 6. Return them in time order, with `shortfall` when fewer were possible.
 *    Never returns duplicates, and never anything outside the held footage.
 *
 * Deterministic: the same request always gives the same instants. A harvest
 * that cannot be repeated cannot be checked.
 */
export function planNegativeSamples(request: unknown): SamplePlan | SampleRefusal {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return refuse("bad_request", "planNegativeSamples needs a request object");
  }
  const r = request as SampleRequest;
  const marginMs = r.marginMs ?? DEFAULT_MARGIN_MS;
  const minSpacingMs = r.minSpacingMs ?? DEFAULT_MIN_SPACING_MS;

  for (const [name, v] of [["availableFrom", r.availableFrom], ["availableTo", r.availableTo],
    ["count", r.count], ["marginMs", marginMs], ["minSpacingMs", minSpacingMs]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) return refuse("bad_request", `${name} must be a number`);
  }
  if (r.availableTo <= r.availableFrom) return refuse("bad_request", "the held footage window does not run forwards");
  if (r.count < 1) return refuse("bad_request", "ask for at least one sample");
  if (!Array.isArray(r.busy)) return refuse("bad_request", "busy must be an array of spans");
  for (const b of r.busy) {
    if (b === null || typeof b !== "object") return refuse("bad_request", "a busy span must be an object");
    if (typeof b.startMs !== "number" || typeof b.endMs !== "number"
      || !Number.isFinite(b.startMs) || !Number.isFinite(b.endMs)) {
      return refuse("bad_request", "a busy span needs a numeric startMs and endMs");
    }
  }

  // Widen and merge.
  const blocked = r.busy
    .map((b) => ({ startMs: Math.min(b.startMs, b.endMs) - marginMs, endMs: Math.max(b.startMs, b.endMs) + marginMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const merged: BusySpan[] = [];
  for (const b of blocked) {
    const last = merged[merged.length - 1];
    if (last !== undefined && b.startMs <= last.endMs) last.endMs = Math.max(last.endMs, b.endMs);
    else merged.push({ ...b });
  }

  // Subtract from the held window.
  const quiet: BusySpan[] = [];
  let cursor = r.availableFrom;
  for (const b of merged) {
    if (b.startMs > cursor) quiet.push({ startMs: cursor, endMs: Math.min(b.startMs, r.availableTo) });
    cursor = Math.max(cursor, b.endMs);
    if (cursor >= r.availableTo) break;
  }
  if (cursor < r.availableTo) quiet.push({ startMs: cursor, endMs: r.availableTo });

  const usable = quiet.filter((q) => q.endMs > q.startMs);
  const quietMs = usable.reduce((sum, q) => sum + (q.endMs - q.startMs), 0);
  if (usable.length === 0 || quietMs <= 0) {
    return refuse("no_quiet_time",
      "this thing was detected for the whole of the footage held, so there is no moment without it to cut a negative from");
  }

  // Share the count across stretches by length, capped by what each can hold.
  const instants: number[] = [];
  for (const q of usable) {
    const span = q.endMs - q.startMs;
    const share = Math.max(1, Math.round((r.count * span) / quietMs));
    const capacity = Math.max(1, Math.floor(span / minSpacingMs));
    const take = Math.min(share, capacity);
    const step = span / take;
    for (let i = 0; i < take; i++) {
      const t = Math.round(q.startMs + step * i + step / 2);
      if (t >= r.availableFrom && t <= r.availableTo) instants.push(t);
    }
  }
  instants.sort((a, b) => a - b);
  const unique = instants.filter((t, i) => i === 0 || t !== instants[i - 1]);
  const kept = unique.slice(0, r.count);

  return { ok: true, instants: kept, asked: r.count, shortfall: r.count - kept.length, quietMs };
}
