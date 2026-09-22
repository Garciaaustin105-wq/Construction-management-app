/**
 * What the motion gate costs: which people (and vehicles) the model would have
 * found looking at every frame, that it does not find when the gate decides
 * which frames it looks at. Pure: no I/O, no clock, no child processes.
 * agent/gate-check.mjs runs replay.py in shadow mode (the model on EVERY frame,
 * the gate beside it marking the frames it would have looked at) and hands
 * the lines here.
 *
 * WHY THIS IS CAREFUL. The answer the owner wants is one number - who the
 * gate loses - and every shortcut makes that number smaller than it is:
 *   - matching the two runs by time overlap calls a person found whenever
 *     anyone else was found at the same moment; two people in view, the gate
 *     catching one, would read as both found. So sightings are matched
 *     exactly: a gated sighting is a byte-identical copy of a reference one,
 *     and each is followed into the event it joined;
 *   - a frame line that does not say whether the gate looked is neither
 *     "looked" nor "not looked": it is left out of both sets and counted;
 *   - "no people" is not "100% found": every share is null when there is
 *     nothing to divide by.
 * It measures and never judges: no line calls the gate good or bad, and
 * nothing here changes a setting.
 */

import { parseUtc, toUtc } from "./time.js";
import { MERGE_GAP_MS, type Box, type Detection, type DetectionEvent } from "./detection.js";
import { advanceFold, emptyFold } from "./detectStream.js";
import { detectionsFromReplay, type GateTotals } from "./scoreRun.js";

// ---------------------------------------------------------------- reading

/** One file of shadow replay output, read into the two sets it compares. */
export interface ShadowRead {
  /** Every frame's detections at or above the floor: what the model finds looking at everything. */
  reference: Detection[];
  /** The same detections, from only the frames the gate would have looked at. */
  gated: Detection[];
  /** Frame lines read, and how many of them the gate would have looked at. */
  frames: number;
  looked: number;
  /** Boxes under the live floor, dropped as live drops them. */
  belowFloor: number;
  /** Lines or boxes that could not be read, frames with no gateLooked among them. */
  unreadable: number;
  /** The file's final gate line, as the scoring runner reads it; null when there was none. */
  gate: GateTotals | null;
  errors: string[];
}

/** How many unplaceable frame lines are named by line number before the rest are only counted. */
const NAMED_UNPLACED = 5;

/**
 * Read replay.py's --gate-shadow stdout for ONE file. Parsing is
 * detectionsFromReplay's, called once over every frame (the reference) and
 * once over the looked frames (the gated set), so a box here is exactly the
 * box the scoring runner would have read - and the gated copies are equal,
 * field for field, to the reference detections from the same frame.
 */
export function readShadowReplay(input: {
  cameraId: string;
  fileStartMs: number;
  lines: readonly string[];
  minConfidence: number;
}): ShadowRead {
  const { cameraId, fileStartMs, lines, minConfidence } = input ?? ({} as never);
  if (!Array.isArray(lines)) {
    // Let the shared reader refuse it, in its own words.
    const bad = detectionsFromReplay({ cameraId, fileStartMs, lines, minConfidence });
    return { reference: [], gated: [], frames: 0, looked: 0, belowFloor: 0, unreadable: 0, gate: null, errors: bad.errors };
  }
  const everyFrame: string[] = [];
  const lookedFrames: string[] = [];
  let unplaced = 0;
  const unplacedAt: number[] = [];
  lines.forEach((line, i) => {
    if (typeof line !== "string" || line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON: the shared reader counts it as unreadable.
      everyFrame.push(line);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
        (parsed as Record<string, unknown>).type !== undefined) {
      // Error and gate lines (and anything else with a type) are the shared
      // reader's to handle, once: only the every-frame pass sees them.
      everyFrame.push(line);
      return;
    }
    const looked = (parsed as Record<string, unknown>).gateLooked;
    if (typeof looked !== "boolean") {
      // A frame that cannot be placed is not guessed into either set: calling
      // it "looked" would hide a loss, "not looked" would invent one.
      unplaced++;
      if (unplacedAt.length < NAMED_UNPLACED) unplacedAt.push(i + 1);
      return;
    }
    everyFrame.push(line);
    if (looked) lookedFrames.push(line);
  });
  const ref = detectionsFromReplay({ cameraId, fileStartMs, lines: everyFrame, minConfidence });
  const gated = detectionsFromReplay({ cameraId, fileStartMs, lines: lookedFrames, minConfidence });
  const errors = [...ref.errors];
  if (unplaced > 0) {
    const more = unplaced > unplacedAt.length ? ` and ${unplaced - unplacedAt.length} more` : "";
    errors.push(`${unplaced} frame line${unplaced === 1 ? "" : "s"} did not say whether the gate looked ` +
      `(line${unplacedAt.length === 1 ? "" : "s"} ${unplacedAt.join(", ")}${more}); left out of both sets`);
  }
  return {
    reference: ref.detections,
    gated: gated.detections,
    frames: ref.frames,
    // Counted by the same reader, over the same lines, so a looked frame the
    // reader could not use is not counted as looked either.
    looked: gated.frames,
    belowFloor: ref.belowFloor,
    unreadable: ref.unreadable + unplaced,
    gate: ref.gate,
    errors,
  };
}

/** Every file's read, summed for the result. */
export interface ShadowReadTotals {
  files: number;
  frames: number;
  looked: number;
  belowFloor: number;
  unreadable: number;
  /** Each file's errors, prefixed with its path so the owner can find it. */
  errors: string[];
}

export function sumShadowReads(reads: readonly { path: string; read: ShadowRead }[]): ShadowReadTotals {
  const out: ShadowReadTotals = { files: 0, frames: 0, looked: 0, belowFloor: 0, unreadable: 0, errors: [] };
  for (const { path, read } of reads) {
    out.files++;
    out.frames += read.frames;
    out.looked += read.looked;
    out.belowFloor += read.belowFloor;
    out.unreadable += read.unreadable;
    for (const e of read.errors) out.errors.push(`${path}: ${e}`);
  }
  return out;
}

// ---------------------------------------------------------------- folding

/**
 * A sighting's identity: its moment, kind, box and confidence, exactly as
 * read. A gated sighting is a copy of a reference one, so the two keys are
 * the same string; anything else is a different sighting.
 */
export function sightingKey(d: Detection): string {
  const b = d.box;
  return `${d.atUtc}|${d.kind}|${b.x},${b.y},${b.w},${b.h}|${d.confidence}`;
}

export interface MembershipFold {
  /** The events, in the order they were opened: the order foldDetections returns them in. */
  events: { id: string; event: DetectionEvent }[];
  /** sightingKey(d) -> the id of the event that sighting joined. */
  memberOf: Map<string, string>;
  /**
   * Keys that two identical sightings held while landing in DIFFERENT
   * events. memberOf keeps the first; the comparison attributes neither, and
   * counts them, rather than guess which one a copy was.
   */
  ambiguous: Set<string>;
}

/**
 * Fold detections the way the live service does - advanceFold, one frame
 * batch at a time, the clock at the batch's moment - and remember which event
 * every sighting joined. Its events equal foldDetections' for the same input,
 * so what is compared here is what the service stores and the scorer grades.
 */
export function foldWithMembership(detections: readonly Detection[]): MembershipFold {
  const timed = detections.map((d) => ({ d, atMs: parseUtc(d.atUtc) }));
  timed.sort((a, b) => a.atMs - b.atMs);
  const order: string[] = [];
  const opened = new Set<string>();
  const latest = new Map<string, DetectionEvent>();
  const memberOf = new Map<string, string>();
  const ambiguous = new Set<string>();
  let state = emptyFold();
  let i = 0;
  while (i < timed.length) {
    const atMs = timed[i]!.atMs;
    let j = i;
    while (j < timed.length && timed[j]!.atMs === atMs) j++;
    const batch = timed.slice(i, j).map((t) => t.d);
    const step = advanceFold(state, batch, batch[0]!.atUtc);
    step.assigned.forEach((id, k) => {
      // An event's first sighting is the one that opened it, so first sight
      // of an id is opening order.
      if (!opened.has(id)) {
        opened.add(id);
        order.push(id);
      }
      const key = sightingKey(batch[k]!);
      const prior = memberOf.get(key);
      if (prior === undefined) memberOf.set(key, id);
      else if (prior !== id) ambiguous.add(key);
    });
    for (const u of [...step.updated, ...step.finished]) latest.set(u.id, u.event);
    state = step.state;
    i = j;
  }
  if (timed.length > 0) {
    // Everything still open is finished by a clock well past the last sighting.
    const flush = advanceFold(state, [], toUtc(timed[timed.length - 1]!.atMs + MERGE_GAP_MS + 1));
    for (const u of flush.finished) latest.set(u.id, u.event);
  }
  return { events: order.map((id) => ({ id, event: latest.get(id)! })), memberOf, ambiguous };
}

// ---------------------------------------------------------------- comparing

export type ComparedKind = "person" | "vehicle";
export const COMPARED_KINDS: readonly ComparedKind[] = Object.freeze(["person", "vehicle"]);

/** Where to look: the replayed file holding a moment, and how far into it. */
export interface FootageAt {
  path: string;
  offsetSec: number;
}

/** A reference event (found looking at every frame), as the report lists it. */
export interface ListedEvent {
  firstUtc: string;
  lastUtc: string;
  bestUtc: string;
  bestConfidence: number;
  bestBox: Box;
  /** Sightings folded into it looking at every frame. */
  sightings: number;
  /** How many of those the gate would have looked at. */
  gatedSightings: number;
  /** How many events those gated sightings fold into. */
  gatedEvents: number;
  /** Whether a live event of the same kind was stored near it (time and kind only). */
  storedLive: boolean;
  /** The file holding bestUtc, or null when no replayed file does. */
  footage: FootageAt | null;
}

/** A gated event whose sightings come from two or more reference events. */
export interface MergedEvent {
  firstUtc: string;
  lastUtc: string;
  bestUtc: string;
  bestConfidence: number;
  /** Gated sightings folded into it. */
  sightings: number;
  /** How many reference events those sightings come from. */
  referenceEvents: number;
  footage: FootageAt | null;
}

/** A live event with no reference event near it. */
export interface LiveOnlyEvent {
  firstUtc: string;
  lastUtc: string;
  bestUtc: string;
  bestConfidence: number;
  count: number;
  footage: FootageAt | null;
}

export interface KindComparison {
  /** Events looking at every frame. */
  reference: number;
  /** Reference events at least one of whose sightings the gate looked at. */
  found: number;
  /** Reference events the gate looked at none of: the number the owner asked for. */
  lost: ListedEvent[];
  /** Found, but whose gated sightings fold into two or more events. */
  split: ListedEvent[];
  merged: MergedEvent[];
  /** Events the gated sightings fold into. */
  gated: number;
  /** found / reference; null when there is no reference event to divide by. */
  foundShare: number | null;
  referenceSightings: number;
  gatedSightings: number;
  /** Gated sightings with no reference sighting of the same key: a fault, never dropped. */
  unattributed: number;
  /** Gated sightings whose key two different events share, so could not be attributed. */
  ambiguous: number;
  live: {
    /** Live events of this kind handed in. */
    events: number;
    /** Reference events with a live event of this kind near them. */
    storedLive: number;
    storedLiveShare: number | null;
    notStoredLive: ListedEvent[];
    liveOnly: LiveOnlyEvent[];
  };
}

export interface GateCheckComparison {
  person: KindComparison;
  vehicle: KindComparison;
  /** Sightings and live events of kinds this does not compare (plates), counted so nothing vanishes. */
  otherKinds: { reference: number; gated: number; live: number };
  /** Across both kinds. */
  unattributed: number;
  ambiguous: number;
  /** Live events whose times could not be read: left out of the live comparison. */
  liveUnreadable: number;
  /** How a live event is matched to a reference one: by time and kind only, never by box. */
  liveMatchedBy: "time_and_kind";
}

/**
 * The file that holds `ms`: the last one starting at or before it, when `ms`
 * is before that file's end; files sorted by start. null before the first
 * file, in a gap between files, or past the last one. Found in review: a live
 * event just after the replayed span used to be pointed into the last file,
 * at an offset past its end. A file given without an end is open-ended.
 */
function footageAt(files: readonly ReplayedFile[], ms: number): FootageAt | null {
  let hit: ReplayedFile | null = null;
  for (const f of files) {
    if (f.startMs <= ms) hit = f;
    else break;
  }
  if (hit === null) return null;
  if (typeof hit.endMs === "number" && Number.isFinite(hit.endMs) && ms >= hit.endMs) return null;
  return { path: hit.path, offsetSec: (ms - hit.startMs) / 1000 };
}

type TimedLive = { event: DetectionEvent; firstMs: number; lastMs: number };

/** A replayed file: where it is, and when it starts and (when known) ends. */
export interface ReplayedFile {
  path: string;
  startMs: number;
  endMs?: number;
}

/** Whether a live event overlaps a reference event widened by the fold's own gap. */
const nearLive = (live: TimedLive, firstMs: number, lastMs: number) =>
  live.firstMs <= lastMs + MERGE_GAP_MS && live.lastMs >= firstMs - MERGE_GAP_MS;

function compareKind(
  kind: ComparedKind,
  ref: MembershipFold,
  gatedFold: MembershipFold,
  gated: readonly Detection[],
  live: readonly TimedLive[],
  files: readonly ReplayedFile[],
): KindComparison {
  const refEvents = ref.events.filter((e) => e.event.kind === kind);
  const gatedEvents = gatedFold.events.filter((e) => e.event.kind === kind);

  // Follow every gated sighting into the reference event it is a copy of,
  // and into the gated event it joined.
  const perRef = new Map<string, { sightings: number; events: Set<string> }>();
  const perGated = new Map<string, Set<string>>();
  let gatedSightings = 0;
  let unattributed = 0;
  let ambiguous = 0;
  for (const d of gated) {
    if (d.kind !== kind) continue;
    gatedSightings++;
    const key = sightingKey(d);
    if (ref.ambiguous.has(key) || gatedFold.ambiguous.has(key)) {
      ambiguous++;
      continue;
    }
    const refId = ref.memberOf.get(key);
    const gatedId = gatedFold.memberOf.get(key);
    if (refId === undefined || gatedId === undefined) {
      unattributed++;
      continue;
    }
    const r = perRef.get(refId) ?? { sightings: 0, events: new Set<string>() };
    r.sightings++;
    r.events.add(gatedId);
    perRef.set(refId, r);
    const g = perGated.get(gatedId) ?? new Set<string>();
    g.add(refId);
    perGated.set(gatedId, g);
  }

  const liveOfKind = live.filter((l) => l.event.kind === kind);
  const lost: ListedEvent[] = [];
  const split: ListedEvent[] = [];
  const notStoredLive: ListedEvent[] = [];
  const liveMatched = new Set<TimedLive>();
  let found = 0;
  let storedLive = 0;
  let referenceSightings = 0;
  for (const { id, event } of refEvents) {
    referenceSightings += event.count;
    const firstMs = parseUtc(event.firstUtc);
    const lastMs = parseUtc(event.lastUtc);
    let stored = false;
    for (const l of liveOfKind) {
      if (nearLive(l, firstMs, lastMs)) {
        stored = true;
        liveMatched.add(l);
      }
    }
    const g = perRef.get(id);
    const listed: ListedEvent = {
      firstUtc: event.firstUtc,
      lastUtc: event.lastUtc,
      bestUtc: event.bestUtc,
      bestConfidence: event.bestConfidence,
      bestBox: { ...event.bestBox },
      sightings: event.count,
      gatedSightings: g?.sightings ?? 0,
      gatedEvents: g?.events.size ?? 0,
      storedLive: stored,
      footage: footageAt(files, parseUtc(event.bestUtc)),
    };
    if (g === undefined) lost.push(listed);
    else {
      found++;
      if (g.events.size >= 2) split.push(listed);
    }
    if (stored) storedLive++;
    else notStoredLive.push(listed);
  }

  const merged: MergedEvent[] = [];
  for (const { id, event } of gatedEvents) {
    const refs = perGated.get(id);
    if (refs === undefined || refs.size < 2) continue;
    merged.push({
      firstUtc: event.firstUtc,
      lastUtc: event.lastUtc,
      bestUtc: event.bestUtc,
      bestConfidence: event.bestConfidence,
      sightings: event.count,
      referenceEvents: refs.size,
      footage: footageAt(files, parseUtc(event.bestUtc)),
    });
  }

  const liveOnly: LiveOnlyEvent[] = [];
  for (const l of liveOfKind) {
    if (liveMatched.has(l)) continue;
    let bestMs: number | null = null;
    try {
      bestMs = parseUtc(l.event.bestUtc);
    } catch {
      bestMs = null;
    }
    liveOnly.push({
      firstUtc: l.event.firstUtc,
      lastUtc: l.event.lastUtc,
      bestUtc: l.event.bestUtc,
      bestConfidence: l.event.bestConfidence,
      count: l.event.count,
      footage: bestMs === null ? null : footageAt(files, bestMs),
    });
  }

  const reference = refEvents.length;
  return {
    reference,
    found,
    lost,
    split,
    merged,
    gated: gatedEvents.length,
    foundShare: reference > 0 ? found / reference : null,
    referenceSightings,
    gatedSightings,
    unattributed,
    ambiguous,
    live: {
      events: liveOfKind.length,
      storedLive,
      storedLiveShare: reference > 0 ? storedLive / reference : null,
      notStoredLive,
      liveOnly,
    },
  };
}

/**
 * Compare the every-frame run with the gated one, sighting by sighting, and
 * both with what the live service stored for the same hours - a third source,
 * shown beside the other two, never averaged with them.
 */
export function compareShadow(input: {
  files: readonly ReplayedFile[];
  reference: readonly Detection[];
  gated: readonly Detection[];
  live: readonly DetectionEvent[];
}): GateCheckComparison {
  const files = [...(input?.files ?? [])].sort((a, b) => a.startMs - b.startMs);
  const reference = input?.reference ?? [];
  const gated = input?.gated ?? [];
  const compared = COMPARED_KINDS as readonly string[];

  const live: TimedLive[] = [];
  let liveUnreadable = 0;
  let liveOther = 0;
  for (const event of input?.live ?? []) {
    if (!compared.includes(event?.kind)) {
      liveOther++;
      continue;
    }
    try {
      live.push({ event, firstMs: parseUtc(event.firstUtc), lastMs: parseUtc(event.lastUtc) });
    } catch {
      liveUnreadable++;
    }
  }
  live.sort((a, b) => a.firstMs - b.firstMs);

  const refFold = foldWithMembership(reference);
  const gatedFold = foldWithMembership(gated);
  const person = compareKind("person", refFold, gatedFold, gated, live, files);
  const vehicle = compareKind("vehicle", refFold, gatedFold, gated, live, files);
  return {
    person,
    vehicle,
    otherKinds: {
      reference: reference.filter((d) => !compared.includes(d.kind)).length,
      gated: gated.filter((d) => !compared.includes(d.kind)).length,
      live: liveOther,
    },
    unattributed: person.unattributed + vehicle.unattributed,
    ambiguous: person.ambiguous + vehicle.ambiguous,
    liveUnreadable,
    liveMatchedBy: "time_and_kind",
  };
}

// ---------------------------------------------------------------- totals and report

export interface GateTotalsSum {
  frames: number;
  looked: number;
  /** looked / frames; null when no file gave totals covering any frame. */
  share: number | null;
  reasons: Record<string, number>;
  /** Files with no gate totals line: their frames are in none of the figures above. */
  missing: number;
}

/** Sum each replayed file's final gate line; a file without one is counted, never read as zeros. */
export function sumGateTotals(files: readonly (GateTotals | null)[]): GateTotalsSum {
  let frames = 0;
  let looked = 0;
  let missing = 0;
  const reasons: Record<string, number> = {};
  for (const t of files) {
    if (t === null || t === undefined) {
      missing++;
      continue;
    }
    frames += t.frames;
    looked += t.looked;
    for (const [reason, n] of Object.entries(t.reasons)) {
      reasons[reason] = (reasons[reason] ?? 0) + (n ?? 0);
    }
  }
  return { frames, looked, share: frames > 0 ? looked / frames : null, reasons, missing };
}

/** A gate check as agent/gate-check.mjs saves it: the run's facts, and the comparison. */
export interface GateCheckResult {
  atUtc: string;
  camera: {
    /** The camera the live detector watches. */
    detectCameraId: string;
    /** The recorded camera replayed. */
    footageCameraId: string;
    /** True only when that recording is the very stream the live detector reads. */
    footageIsLiveStream: boolean;
  };
  settings: {
    fps: number;
    fpsSource: "live" | "by_hand";
    minConfidence: number;
    model: string;
    gate: {
      /** As replayed; null means the worker's own default, not zero. */
      threshold: number | null;
      keepaliveMs: number | null;
      /** Whether the gate is on in the live service. */
      liveEnabled: boolean;
    };
  };
  span: {
    requestedFromUtc: string;
    requestedToUtc: string;
    replayedFromUtc: string | null;
    replayedToUtc: string | null;
    /** Every file handed to the replay, failed ones included. */
    files: { path: string; startMs: number; endMs: number }[];
    skipped: { path: string; reason: string }[];
    failed: { path: string; error: string }[];
  };
  /** sumGateTotals over the replayed files, `frames` renamed `total`. */
  frames: { total: number; looked: number; share: number | null; reasons: Record<string, number>; missing: number };
  /** sumShadowReads over the replayed files. */
  read: ShadowReadTotals;
  live: { truncated: boolean };
  comparison: GateCheckComparison;
}

const int = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

/**
 * A share with one decimal, that never rounds to a figure it has not
 * reached: 1,999 of 2,000 is "over 99.9%", not "100.0%", and 1 of 54,000 is
 * "under 0.1%", not "0.0%".
 */
function share(x: number): string {
  if (x > 0 && x < 0.001) return "under 0.1%";
  if (x < 1 && x > 0.999) return "over 99.9%";
  return `${(x * 100).toFixed(1)}%`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/** "03:14:09.600Z" when it is the same day as `from`, the whole instant otherwise. */
const until = (from: string, to: string) => (from.slice(0, 11) === to.slice(0, 11) ? to.slice(11) : to);

const where = (f: FootageAt | null) =>
  (f === null ? "no replayed file holds that moment" : `footage ${f.path} at ${f.offsetSec.toFixed(1)} s`);

function listedLine(label: string, e: ListedEvent): string {
  return `  ${label}: ${e.firstUtc} to ${until(e.firstUtc, e.lastUtc)}, ${plural(e.sightings, "sighting")}` +
    `${e.gatedSightings > 0 ? ` (${int(e.gatedSightings)} looked at)` : ""}, best confidence ${e.bestConfidence.toFixed(2)} ` +
    `at ${e.bestUtc}; ${where(e.footage)}; ${e.storedLive ? "a live event was stored near it" : "no live event was stored near it"}.`;
}

const NOUN: Record<ComparedKind, { Many: string; many: string; one: string }> = {
  person: { Many: "People", many: "people", one: "person" },
  vehicle: { Many: "Vehicles", many: "vehicles", one: "vehicle" },
};

/**
 * The report, as lines of plain text: what was replayed, with what settings,
 * what the gate would have looked at, who it would have lost, what live
 * stored, and everything that could not be used. Measurements only - there
 * is no line here that says whether the gate should stay as it is.
 */
export function gateCheckReport(result: GateCheckResult): string[] {
  const { camera, settings, span, frames, read, comparison } = result;
  const lines: string[] = [];
  const notLive = !camera.footageIsLiveStream;
  // With footage that is not the live stream every measurement line says so,
  // not just the first: a line quoted on its own must still carry it.
  const tag = notLive ? "[not the live stream] " : "";

  const failedPaths = new Set(span.failed.map((f) => f.path));
  const replayedMs = span.files.filter((f) => !failedPaths.has(f.path)).reduce((sum, f) => sum + (f.endMs - f.startMs), 0);
  const stream = notLive
    ? `which is NOT the stream the live detector reads for ${camera.detectCameraId} (chosen by hand)`
    : `the stream the live detector reads${camera.detectCameraId !== camera.footageCameraId ? ` for ${camera.detectCameraId}` : ""}`;
  const rate = settings.fpsSource === "live" ? "the live rate" : "set by hand, not the live rate";
  lines.push(`Replayed ${duration(replayedMs)} of ${camera.footageCameraId}, ${stream}, at ${settings.fps} fps (${rate}): ` +
    `${plural(read.frames, "frame")}.`);
  lines.push(`Asked for ${span.requestedFromUtc} to ${span.requestedToUtc}; footage replayed ` +
    (span.replayedFromUtc !== null && span.replayedToUtc !== null ? `${span.replayedFromUtc} to ${span.replayedToUtc}` : "none") +
    `, ${plural(span.files.length - span.failed.length, "file")}.`);
  lines.push(`Confidence floor ${settings.minConfidence.toFixed(2)} and model ${settings.model}, as live runs them.`);

  const g = settings.gate;
  const gateSettings = `${g.threshold === null ? "the worker's default threshold" : `threshold ${g.threshold}`}, ` +
    `${g.keepaliveMs === null ? "the worker's default keepalive" : `keepalive ${g.keepaliveMs / 1000} s`}`;
  lines.push(g.liveEnabled
    ? `The gate is ON on this NVR (${gateSettings}); this replays it as set.`
    : `The gate is OFF on this NVR; this previews it at ${gateSettings}.`);

  const reasons = Object.entries(frames.reasons)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} ${int(n)}`);
  const why = reasons.length > 0 ? `: ${reasons.join(", ")}` : "";
  if (frames.share === null) {
    lines.push(`${tag}The gate's totals cover no frames, so there is no share looked at to state.`);
  } else if (frames.missing === 0 && frames.total === read.frames && frames.looked === read.looked) {
    lines.push(`${tag}The gate would have looked at ${int(frames.looked)} of them (${share(frames.share)})${why}.`);
  } else {
    // Two counts of the same thing disagreeing is information: both are shown.
    lines.push(`${tag}The gate would have looked at ${int(frames.looked)} of the ${plural(frames.total, "frame")} ` +
      `its totals cover (${share(frames.share)})${why}.`);
    lines.push(`${tag}The frame lines themselves mark ${int(read.looked)} of ${plural(read.frames, "frame")} as looked at; ` +
      "the two counts differ, and both are shown.");
  }

  for (const kind of COMPARED_KINDS) {
    const k = comparison[kind];
    const n = NOUN[kind];
    if (k.reference === 0) {
      lines.push(`${tag}${n.Many} the model finds when it looks at every frame: 0, so there is no share found with the gate to state.`);
    } else {
      lines.push(`${tag}${n.Many} the model finds when it looks at every frame: ${int(k.reference)}. ` +
        `Also found with the gate: ${int(k.found)} (${share(k.foundShare ?? 0)}). ` +
        `Missed with the gate: ${int(k.lost.length)}. Split into more than one event: ${int(k.split.length)}.`);
    }
    for (const e of k.lost) lines.push(listedLine("missed", e));
    for (const e of k.split) lines.push(listedLine(`split into ${e.gatedEvents} events`, e));
    if (k.merged.length > 0) {
      lines.push(`${tag}With the gate, ${plural(k.merged.length, "event")} hold more than one ${n.one} from the every-frame run (merged):`);
      for (const m of k.merged) {
        lines.push(`  merged from ${m.referenceEvents} events: ${m.firstUtc} to ${until(m.firstUtc, m.lastUtc)}, ` +
          `${plural(m.sightings, "sighting")}, best confidence ${m.bestConfidence.toFixed(2)} at ${m.bestUtc}; ${where(m.footage)}.`);
      }
    }
  }

  for (const kind of COMPARED_KINDS) {
    const k = comparison[kind];
    const n = NOUN[kind];
    lines.push(`${tag}Stored live over the same hours: ${plural(k.live.events, `${n.one} event`)} ` +
      `(matched by time and kind only${result.live.truncated ? "; the live query hit its limit, so there may be more" : ""}).`);
    if (k.reference > 0) {
      lines.push(`  ${int(k.live.storedLive)} of the ${int(k.reference)} ${k.reference === 1 ? n.one : n.many} found looking at every frame ` +
        `have a live event within ${MERGE_GAP_MS / 1000} s of them (${share(k.live.storedLiveShare ?? 0)}).`);
    }
    for (const e of k.live.notStoredLive) lines.push(listedLine("not stored live", e));
    for (const l of k.live.liveOnly) {
      lines.push(`  stored live, with no event here: ${l.firstUtc} to ${until(l.firstUtc, l.lastUtc)}, ` +
        `${plural(l.count, "sighting")}, best confidence ${l.bestConfidence.toFixed(2)} at ${l.bestUtc}; ${where(l.footage)}.`);
    }
  }

  // Rule 16: whatever could not be used, and why.
  const couldNot: string[] = [];
  if (notLive) {
    couldNot.push(`${camera.footageCameraId} is not the stream the live detector reads for ${camera.detectCameraId}; ` +
      "every figure above is from that footage, not from what live sees");
  }
  for (const s of span.skipped) couldNot.push(`skipped ${s.path}: ${s.reason}`);
  for (const f of span.failed) {
    const file = span.files.find((x) => x.path === f.path);
    const length = file === undefined ? "length not known" : duration(file.endMs - file.startMs);
    couldNot.push(`replay failed for ${f.path} (${length} of footage, not counted): ${f.error}`);
  }
  if (read.unreadable > 0) couldNot.push(`${plural(read.unreadable, "detector line or box", "detector lines or boxes")} could not be read`);
  for (const e of read.errors) couldNot.push(`replay: ${e}`);
  if (frames.missing > 0) {
    couldNot.push(`${plural(frames.missing, "replayed file")} gave no gate totals, so the gate figures leave ${frames.missing === 1 ? "it" : "them"} out`);
  }
  if (result.live.truncated) couldNot.push("the live events query hit its limit, so the live figures cover only the rows it returned");
  if (comparison.liveUnreadable > 0) couldNot.push(`${plural(comparison.liveUnreadable, "live event")} with times that could not be read`);
  if (comparison.unattributed > 0) {
    couldNot.push(`${plural(comparison.unattributed, "gated sighting")} match no sighting of the every-frame run; ` +
      "that should be impossible, so the comparison above has a fault in it");
  }
  if (comparison.ambiguous > 0) {
    couldNot.push(`${plural(comparison.ambiguous, "gated sighting")} could belong to more than one event, so were not attributed to either`);
  }
  const o = comparison.otherKinds;
  if (o.reference + o.gated + o.live > 0) {
    couldNot.push(`other kinds (plates) are not compared: ${int(o.reference)} every-frame, ${int(o.gated)} gated ` +
      `and ${int(o.live)} live`);
  }
  if (couldNot.length > 0) {
    lines.push("Could not use:");
    for (const c of couldNot) lines.push(`  - ${c}.`);
  } else {
    lines.push("Could not use: nothing; every file, line and live row was read.");
  }
  lines.push(`${plural(read.frames, "frame line")} read; ${plural(read.belowFloor, "box", "boxes")} under the ` +
    `${settings.minConfidence.toFixed(2)} floor dropped, as live drops them.`);
  return lines;
}
