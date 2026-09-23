/**
 * Teach list: which moments in a day of footage are worth a person's tap
 * (TEACH-LIST-SPEC.md). The answer key `camctl score` needs is empty, and
 * `exitGate` (clipLibrary.ts) refuses a verdict below MIN_GATE_PERSONS people
 * and MIN_GATE_EMPTY_HOURS of empty scene. Scrubbing video by hand to find
 * moments worth labelling is slow, so this proposes them instead.
 *
 * THE WHOLE POINT: a miss leaves no event. A wrong "nobody was there" answer
 * on ordinary footage looks exactly like a right one, so the only place a
 * miss can be caught is where the motion gate's OWN bookkeeping disagrees
 * with storage -- it looked, and something moved, and nothing was kept. That
 * is why `moved_nothing_stored` outranks every other kind here: it is the one
 * moment where the measurement itself points at a possible miss, rather than
 * just needing a label.
 *
 * Pure: no I/O, no clock read (`nowUtc` is an input, like the rest of this
 * codebase's contracts). Every input is already-fetched data -- this file
 * only ranks and shapes it. Rule 11: a moment reports what was measured
 * ("moved in 12 frames, nothing stored"), never a verdict ("a missed
 * person") -- the evidence shapes below carry no wording, only numbers.
 */
import { MIN_GATE_EMPTY_HOURS, type ClipLibrary } from "./clipLibrary.js";

/** Cap on how many moments one call proposes, so a busy day's page stays a page. */
export const MAX_MOMENTS = 40;

/** `moved_nothing_stored` minutes merge while adjacent, up to this many. */
export const MERGE_MINUTES = 5;

/** The length of one `quiet` span. */
export const QUIET_SPAN_MINUTES = 5;

/** How far a `person_stored` moment's span reaches past the event itself. */
export const PERSON_PAD_MS = 10_000;

const MINUTE_MS = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * One motion gate window, exactly as agent/detect-service.mjs appends it to
 * `<stateDir>/gate-windows/<YYYY-MM-DD>.jsonl` (one line per camera per
 * minute; see contracts/detectStream.ts's "gate" WorkerLine, which this
 * mirrors field for field). A key absent from `reasons` means zero, matching
 * how the gate itself only writes reasons that actually occurred.
 */
export interface GateWindow {
  cameraId: string;
  atUtc: string;
  windowS: number;
  frames: number;
  looked: number;
  reasons: Readonly<Record<string, number>>;
}

/**
 * The one stored-event shape this file needs -- DetectionEvent's own fields
 * (contracts/detection.ts) plus `suppressedBy`, the known-object flag
 * events-db.mjs adds at the storage layer (DetectionEvent itself predates
 * known objects and does not carry it). `null` means not hidden.
 */
export interface StoredEvent {
  id: string;
  cameraId: string;
  kind: "person" | "vehicle" | "plate";
  firstUtc: string;
  lastUtc: string;
  count: number;
  bestConfidence: number;
  bestUtc: string;
  suppressedBy: string | null;
}

/** One span of footage that still exists on this recorder, from the index. */
export interface FootageSpan {
  startUtc: string;
  endUtc: string;
}

export type MomentKind = "moved_nothing_stored" | "person_stored" | "quiet";

export interface MovedNothingStoredEvidence {
  frames: number;
  motionLooks: number;
}

export interface PersonStoredEvidence {
  bestConfidence: number;
  sightings: number;
  /** A known-object flag on the event: exactly the false people worth a
   *  "nobody" answer, never dropped from the list for being hidden. */
  hidden: boolean;
}

export interface QuietEvidence {
  minutes: number;
}

export interface TeachMoment {
  kind: MomentKind;
  cameraId: string;
  startUtc: string;
  endUtc: string;
  /**
   * Where GET /still should cut its frame: the middle of the span for
   * `moved_nothing_stored` and `quiet`; the event's own bestUtc for
   * `person_stored` -- the sighting that made the detector confident, not an
   * arbitrary point inside the +/-10 s pad.
   */
  stillAtUtc: string;
  evidence: MovedNothingStoredEvidence | PersonStoredEvidence | QuietEvidence;
}

export interface ProposeTeachMomentsInput {
  cameraId: string;
  dayStartUtc: string;
  dayEndUtc: string;
  /** So a partial "today" never proposes a minute that has not happened yet. */
  nowUtc: string;
  /** Every window on record for this day; windows of other cameras are ignored. */
  gateWindows: readonly GateWindow[];
  /** Every stored event touching this day, on this camera, hidden ones included. */
  events: readonly StoredEvent[];
  /** The WHOLE answer key -- MIN_GATE_EMPTY_HOURS is a library-wide bar, not a per-camera one. */
  library: ClipLibrary;
  /** This camera's recorded spans. A moment whose span is not fully inside one is never proposed. */
  footage: readonly FootageSpan[];
}

export interface TeachMomentsResult {
  moments: TeachMoment[];
  /** Valid candidates left out, per kind: by the cap, or because `quiet` only
   *  proposes as many as the empty-hour target still needs. Rule 16: say what
   *  could not be used, never drop it silently. */
  omitted: Record<MomentKind, number>;
  notes: string[];
}

const toIso = (ms: number): string => new Date(ms).toISOString();
const floorToMinute = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/** True when every millisecond of [startMs, endMs) is covered by `spans`. An
 *  empty or inverted range is never "covered" -- there is nothing to cover. */
function footageCovers(startMs: number, endMs: number, spans: readonly FootageSpan[]): boolean {
  if (startMs >= endMs) return false;
  const sorted = spans
    .map((s) => ({ s: Date.parse(s.startUtc), e: Date.parse(s.endUtc) }))
    .filter((v) => Number.isFinite(v.s) && Number.isFinite(v.e) && v.e > v.s)
    .sort((a, b) => a.s - b.s);
  let cursor = startMs;
  for (const span of sorted) {
    if (span.s > cursor) break; // a gap starts exactly at cursor
    if (span.e > cursor) cursor = span.e;
    if (cursor >= endMs) return true;
  }
  return cursor >= endMs;
}

interface TimedEvent extends StoredEvent {
  firstMs: number;
  lastMs: number;
}

/** Runs of adjacent motion-only minutes, each capped at MERGE_MINUTES: a run
 *  longer than the cap splits into consecutive chunks rather than being cut
 *  off, since every one of those minutes is still a candidate on its own. */
function mergeMovedMinutes(
  motionMinutes: readonly { key: number; window: GateWindow }[],
): { startMs: number; endMs: number; frames: number; motionLooks: number }[] {
  const runs: { startMs: number; endMs: number; frames: number; motionLooks: number }[] = [];
  let idx = 0;
  while (idx < motionMinutes.length) {
    const first = motionMinutes[idx]!;
    let frames = first.window.frames;
    let motionLooks = first.window.reasons.motion ?? 0;
    let lastKey = first.key;
    let count = 1;
    let next = idx + 1;
    while (
      count < MERGE_MINUTES &&
      next < motionMinutes.length &&
      motionMinutes[next]!.key === lastKey + MINUTE_MS
    ) {
      const w = motionMinutes[next]!.window;
      frames += w.frames;
      motionLooks += w.reasons.motion ?? 0;
      lastKey = motionMinutes[next]!.key;
      count += 1;
      next += 1;
    }
    runs.push({ startMs: first.key, endMs: lastKey + MINUTE_MS, frames, motionLooks });
    idx = next;
  }
  return runs;
}

/**
 * Propose moments worth a tap, ranked moved_nothing_stored > person_stored >
 * quiet, capped at MAX_MOMENTS total in that priority order. Never throws:
 * an invalid day range answers with no moments and a note, not an exception,
 * since a malformed input here is the caller's bug, not a client's.
 */
export function proposeTeachMoments(input: ProposeTeachMomentsInput): TeachMomentsResult {
  const { cameraId, dayStartUtc, dayEndUtc, nowUtc, gateWindows, events, library, footage } = input;
  const notes: string[] = [];
  const omitted: Record<MomentKind, number> = { moved_nothing_stored: 0, person_stored: 0, quiet: 0 };
  const empty = (note: string): TeachMomentsResult => ({ moments: [], omitted, notes: [note] });

  const dayStartMs = Date.parse(dayStartUtc);
  const dayEndMsRaw = Date.parse(dayEndUtc);
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(dayEndMsRaw) || dayEndMsRaw <= dayStartMs) {
    return empty("dayStartUtc/dayEndUtc do not describe a valid range");
  }
  const nowMs = Date.parse(nowUtc);
  const dayEndMs = Number.isFinite(nowMs) ? Math.min(dayEndMsRaw, nowMs) : dayEndMsRaw;
  if (dayEndMs <= dayStartMs) {
    return empty("this day has not started yet");
  }

  // Rule 7 / rule 18 territory: a moment already answered for must never be
  // offered again. Same-camera clips only -- another camera's clip says
  // nothing about whether THIS footage is covered.
  const cameraLibraryClips = library.clips
    .filter((c) => c.cameraId === cameraId)
    .map((c) => ({ startMs: Date.parse(c.startUtc), endMs: Date.parse(c.endUtc) }))
    .filter((v) => Number.isFinite(v.startMs) && Number.isFinite(v.endMs) && v.endMs > v.startMs);
  const overlapsLibrary = (startMs: number, endMs: number): boolean =>
    cameraLibraryClips.some((c) => c.startMs < endMs && startMs < c.endMs);

  // One gate window per calendar minute, this camera only. A duplicate
  // minute (should not happen) keeps the last one seen rather than double
  // counting it.
  const minuteMap = new Map<number, GateWindow>();
  for (const w of gateWindows) {
    if (w.cameraId !== cameraId) continue;
    const atMs = Date.parse(w.atUtc);
    if (!Number.isFinite(atMs)) continue;
    minuteMap.set(floorToMinute(atMs), w);
  }

  const minuteKeys: number[] = [];
  let missingMinutes = 0;
  for (let t = floorToMinute(dayStartMs); t < dayEndMs; t += MINUTE_MS) {
    minuteKeys.push(t);
    if (!minuteMap.has(t)) missingMinutes += 1;
  }
  if (missingMinutes > 0) {
    // Rule 5 / rule 16: a missing minute is unknown, never quiet and never
    // motion -- the gate might have been off, or the detector down.
    notes.push(
      `${missingMinutes} of ${minuteKeys.length} minute(s) had no gate data for ${cameraId} on this day; not counted as quiet or as motion`,
    );
  }

  const cameraEvents: TimedEvent[] = events
    .filter((e) => e.cameraId === cameraId)
    .map((e) => ({ ...e, firstMs: Date.parse(e.firstUtc), lastMs: Date.parse(e.lastUtc) }))
    .filter((e) => Number.isFinite(e.firstMs) && Number.isFinite(e.lastMs));
  // ANY kind, hidden included -- a hidden event still means something was
  // stored, which is exactly what disqualifies a minute from moved_nothing_stored
  // and a span from quiet. Half-open at the end, like every other span in this
  // file (footageCovers, the minute windows themselves): an event starting
  // exactly AT endMs belongs to the window that starts there, not this one. The
  // closed `<=` this replaced double-counted that boundary instant into both
  // windows, so an event starting exactly on a minute boundary wrongly struck
  // out the minute BEFORE it too.
  const anyEventOverlaps = (startMs: number, endMs: number): boolean =>
    cameraEvents.some((e) => e.firstMs < endMs && e.lastMs >= startMs);

  let footageExcluded = 0;
  let libraryExcluded = 0;

  // ---------- 1. moved_nothing_stored ----------
  const motionMinutes: { key: number; window: GateWindow }[] = [];
  for (const key of minuteKeys) {
    const w = minuteMap.get(key);
    if (w === undefined) continue;
    if ((w.reasons.motion ?? 0) <= 0) continue;
    if (anyEventOverlaps(key, key + MINUTE_MS)) continue;
    motionMinutes.push({ key, window: w });
  }
  const movedCandidates: TeachMoment[] = [];
  for (const run of mergeMovedMinutes(motionMinutes)) {
    if (!footageCovers(run.startMs, run.endMs, footage)) {
      footageExcluded += 1;
      continue;
    }
    if (overlapsLibrary(run.startMs, run.endMs)) {
      libraryExcluded += 1;
      continue;
    }
    movedCandidates.push({
      kind: "moved_nothing_stored",
      cameraId,
      startUtc: toIso(run.startMs),
      endUtc: toIso(run.endMs),
      stillAtUtc: toIso(Math.floor((run.startMs + run.endMs) / 2)),
      evidence: { frames: run.frames, motionLooks: run.motionLooks },
    });
  }

  // ---------- 2. person_stored ----------
  const personCandidates: TeachMoment[] = [];
  for (const e of cameraEvents) {
    if (e.kind !== "person") continue;
    const startMs = e.firstMs - PERSON_PAD_MS;
    const endMs = e.lastMs + PERSON_PAD_MS;
    if (!footageCovers(startMs, endMs, footage)) {
      footageExcluded += 1;
      continue;
    }
    if (overlapsLibrary(startMs, endMs)) {
      libraryExcluded += 1;
      continue;
    }
    personCandidates.push({
      kind: "person_stored",
      cameraId,
      startUtc: toIso(startMs),
      endUtc: toIso(endMs),
      stillAtUtc: e.bestUtc,
      evidence: { bestConfidence: e.bestConfidence, sightings: e.count, hidden: e.suppressedBy !== null },
    });
  }
  personCandidates.sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));

  // ---------- 3. quiet ----------
  // The day cut into non-overlapping QUIET_SPAN_MINUTES blocks, aligned to
  // dayStartMs (a UTC day boundary, itself minute-aligned) -- a trailing
  // partial block is dropped rather than padded, since "gate windows present
  // for every minute" cannot be true of a block that is not whole yet.
  const quietBlocks: { startMs: number; endMs: number }[] = [];
  for (let idx = 0; idx + QUIET_SPAN_MINUTES <= minuteKeys.length; idx += QUIET_SPAN_MINUTES) {
    const blockKeys = minuteKeys.slice(idx, idx + QUIET_SPAN_MINUTES);
    let allQuiet = true;
    for (const k of blockKeys) {
      const w = minuteMap.get(k);
      if (w === undefined || (w.reasons.motion ?? 0) > 0) {
        allQuiet = false;
        break;
      }
    }
    if (!allQuiet) continue;
    const startMs = blockKeys[0]!;
    const endMs = blockKeys[blockKeys.length - 1]! + MINUTE_MS;
    if (anyEventOverlaps(startMs, endMs)) continue;
    if (!footageCovers(startMs, endMs, footage)) {
      footageExcluded += 1;
      continue;
    }
    if (overlapsLibrary(startMs, endMs)) {
      libraryExcluded += 1;
      continue;
    }
    quietBlocks.push({ startMs, endMs });
  }

  // Whole milliseconds throughout, never hours-as-float: MIN_GATE_EMPTY_HOURS
  // - currentEmptyHours landed on 1.0000000000000004 in review, one float
  // subtraction away from the exact 1.0 it meant, and ceil() turned that into
  // an extra quiet span nobody asked for. Integer ms has no such gap.
  const currentEmptyMs = library.clips.reduce((sum, c) => {
    if (!c.scenes.includes("empty")) return sum;
    const s = Date.parse(c.startUtc);
    const en = Date.parse(c.endUtc);
    if (!Number.isFinite(s) || !Number.isFinite(en) || en <= s) return sum;
    return sum + (en - s);
  }, 0);
  const neededMs = Math.max(0, MIN_GATE_EMPTY_HOURS * MS_PER_HOUR - currentEmptyMs);
  const spanMs = QUIET_SPAN_MINUTES * MINUTE_MS;
  const neededSpans = quietBlocks.length === 0 ? 0 : Math.min(quietBlocks.length, Math.ceil(neededMs / spanMs));

  // Spread across the day: the middle of each of N equal buckets over the
  // day's L valid quiet blocks, not just the first N -- the +0.5 matters most
  // exactly when N is small (one span picks the day's middle block, not its
  // first). With neededSpans <= quietBlocks.length, floor((k+0.5) * L / N) is
  // strictly increasing in k (floor(x+y) >= floor(x)+floor(y), and L/N >= 1),
  // so every index is distinct and none run past the last block.
  const quietCandidates: TeachMoment[] = [];
  for (let k = 0; k < neededSpans; k += 1) {
    const block = quietBlocks[Math.floor(((k + 0.5) * quietBlocks.length) / neededSpans)]!;
    quietCandidates.push({
      kind: "quiet",
      cameraId,
      startUtc: toIso(block.startMs),
      endUtc: toIso(block.endMs),
      stillAtUtc: toIso(Math.floor((block.startMs + block.endMs) / 2)),
      evidence: { minutes: QUIET_SPAN_MINUTES },
    });
  }
  if (quietBlocks.length > neededSpans) {
    notes.push(
      `${quietBlocks.length - neededSpans} more quiet 5-minute span(s) were available but not needed: ` +
        `the library's empty-scene footage already reaches, or these bring it to, ${MIN_GATE_EMPTY_HOURS} hour(s)`,
    );
  }

  if (footageExcluded > 0) {
    notes.push(`${footageExcluded} candidate moment(s) were not proposed: their footage is gone or only partly recorded`);
  }
  if (libraryExcluded > 0) {
    notes.push(`${libraryExcluded} candidate moment(s) were not proposed: already covered by an existing "Teach the AI" clip`);
  }

  // ---------- cap, in priority order ----------
  const moments: TeachMoment[] = [];
  let budget = MAX_MOMENTS;
  const takeFrom = (list: readonly TeachMoment[], kind: MomentKind): void => {
    const take = Math.min(list.length, budget);
    for (let i = 0; i < take; i += 1) moments.push(list[i]!);
    omitted[kind] += list.length - take;
    budget -= take;
  };
  takeFrom(movedCandidates, "moved_nothing_stored");
  takeFrom(personCandidates, "person_stored");
  takeFrom(quietCandidates, "quiet");
  if (omitted.moved_nothing_stored + omitted.person_stored + omitted.quiet > 0) {
    notes.push(`the ${MAX_MOMENTS}-moment cap left out ${omitted.moved_nothing_stored} moved_nothing_stored, ${omitted.person_stored} person_stored, ${omitted.quiet} quiet`);
  }

  return { moments, omitted, notes };
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export type DayRefusal = { ok: false; status: 400; code: "bad_day"; message: string };
export type ParsedDay = { ok: true; dayStartUtc: string; dayEndUtc: string };

/**
 * Turn a `day=YYYY-MM-DD` query value into the UTC midnight-to-midnight
 * range `proposeTeachMoments` and the gate-windows file layout both use (the
 * day file is named by this same UTC calendar day). Refuses blank, malformed
 * and non-existent dates the same way contracts/apiQuery.ts's parseInstant
 * refuses a bad instant: a value, never a throw.
 */
export function parseDay(raw: string | null | undefined): ParsedDay | DayRefusal {
  if (raw === null || raw === undefined || raw === "") {
    return { ok: false, status: 400, code: "bad_day", message: "day is required" };
  }
  const m = DAY_PATTERN.exec(raw);
  if (m === null) {
    return { ok: false, status: 400, code: "bad_day", message: `day must be YYYY-MM-DD, got ${JSON.stringify(raw)}` };
  }
  const [, yearText, monthText, dayText] = m as unknown as [string, string, string, string];
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { ok: false, status: 400, code: "bad_day", message: `day names a date that does not exist: ${raw}` };
  }
  const start = new Date(0);
  start.setUTCFullYear(year, month - 1, day);
  start.setUTCHours(0, 0, 0, 0);
  const startMs = start.getTime();
  return { ok: true, dayStartUtc: new Date(startMs).toISOString(), dayEndUtc: new Date(startMs + MS_PER_DAY).toISOString() };
}
