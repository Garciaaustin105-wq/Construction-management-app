/**
 * The arithmetic behind the review page's playback controls: speed, stepping,
 * and jumping between the chunks that actually got recorded.
 *
 * The failure this exists to prevent: a gap in the recording that the page
 * quietly papers over. An operator scrubbing to 14:30 and landing at 14:32
 * because the page "helpfully" snapped forward to the next footage will never
 * learn that two minutes are missing -- which is the one thing they opened
 * the page to find out. So a seek lands where it was asked to land and
 * reports what is there, and a control with nowhere to go says so instead of
 * doing nothing.
 *
 * All times are SECONDS from the start of the reviewed day ("day-seconds").
 * Pure: no clock, no I/O, no DOM.
 */

export type PlaybackRate = number;

/**
 * The speeds the UI offers, slowest first. Frozen because the buttons are
 * generated from this list; a caller that edited it would change the control
 * bar of every page in the process.
 */
export const PLAYBACK_RATES: readonly number[] = Object.freeze([0.25, 0.5, 1, 2, 4, 8]);

/**
 * The neighbouring speed, one step in `direction`.
 *
 * Clamps at both ends rather than wrapping. Wrapping from 8x back to 0.25x on
 * one press too many looks exactly like the picture freezing, and an operator
 * who sees that concludes the recording is broken.
 *
 * An unlisted `current` snaps to the nearest listed speed and does NOT then
 * move: something other than these buttons set it, and snapping is
 * recoverable where guessing a direction from an unknown value is not. A tie
 * resolves to the slower of the two, because arriving slower than expected is
 * obvious on screen and easily corrected, where arriving faster can look like
 * dropped frames.
 */
export function nextRate(current: number, direction: 1 | -1): number {
  const slowest = PLAYBACK_RATES[0] ?? 1;
  const fastest = PLAYBACK_RATES[PLAYBACK_RATES.length - 1] ?? 1;

  const index = PLAYBACK_RATES.indexOf(current);
  if (index === -1) {
    let closest = slowest;
    let smallestGap = Math.abs(current - slowest);
    for (const rate of PLAYBACK_RATES) {
      const gap = Math.abs(current - rate);
      // Strictly less, so a tie keeps the earlier -- slower -- entry.
      if (gap < smallestGap) {
        smallestGap = gap;
        closest = rate;
      }
    }
    return closest;
  }

  const moved = index + direction;
  if (moved < 0) return slowest;
  if (moved >= PLAYBACK_RATES.length) return fastest;
  return PLAYBACK_RATES[moved] ?? current;
}

/**
 * A speed as a button label. Built by hand rather than through Intl or
 * toFixed: a fixed width renders 1x as "1.00x", which reads as a measurement
 * of something on a control the operator is meant to press without reading.
 */
export function rateLabel(rate: number): string {
  return String(rate) + "x";
}

export interface RecordedRange {
  startS: number; // day-seconds, inclusive
  endS: number; // day-seconds, exclusive
}

export interface RangeSummary {
  ranges: RecordedRange[]; // sorted by startS, overlaps merged, real gaps kept
  recordedS: number; // total seconds actually covered
  firstS: number | null; // null when nothing was recorded -- never 0
  lastS: number | null; // null when nothing was recorded -- never 0
}

/**
 * Folds raw recorded ranges into what the timeline should draw.
 *
 * Merges ranges that touch exactly as well as ones that overlap. The recorder
 * seals a file every 60 seconds, so a continuous hour arrives as sixty ranges
 * meeting end-to-start; drawn separately they make an unbroken recording look
 * riddled with gaps that do not exist.
 *
 * Keeps real gaps, because the gap is the thing the operator came to find.
 *
 * Drops any range that is not two finite numbers with end after start. A
 * zero-length range is not a recording, and one NaN would spread through
 * recordedS and render as "NaN" on the page.
 *
 * firstS and lastS are null when nothing was recorded, never 0: midnight is a
 * real time of day, and "no footage" must not read as "footage at 00:00:00"
 * (build rule 5).
 *
 * The caller's array and its objects are never modified.
 */
export function summariseRanges(input: readonly RecordedRange[]): RangeSummary {
  const usable: RecordedRange[] = [];
  for (const range of input) {
    if (
      Number.isFinite(range.startS) &&
      Number.isFinite(range.endS) &&
      range.endS > range.startS
    ) {
      usable.push({ startS: range.startS, endS: range.endS });
    }
  }
  usable.sort((a, b) => a.startS - b.startS);

  const ranges: RecordedRange[] = [];
  for (const range of usable) {
    const open = ranges[ranges.length - 1];
    // <= not <, so ranges that merely touch are joined rather than drawn apart.
    if (open !== undefined && range.startS <= open.endS) {
      if (range.endS > open.endS) open.endS = range.endS;
    } else {
      ranges.push(range);
    }
  }

  let recordedS = 0;
  for (const range of ranges) recordedS += range.endS - range.startS;

  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  return {
    ranges,
    recordedS,
    firstS: first === undefined ? null : first.startS,
    lastS: last === undefined ? null : last.endS,
  };
}

export interface SeekResult {
  timeS: number; // where to go, in day-seconds
  clamped: boolean; // the request was outside the recording and was moved
  inRecording: boolean; // timeS falls inside a RecordedRange
}

/**
 * Where a seek should actually land.
 *
 * It clamps into the day's footage but does NOT snap into a range. Landing in
 * a gap is a true answer about the recording; moving the operator to the
 * nearest footage instead would hide the very gap they were looking for, and
 * `inRecording: false` is how the page knows to say "nothing recorded here".
 */
export function seekTo(summary: RangeSummary, requestedS: number): SeekResult {
  const firstS = summary.firstS;
  const lastS = summary.lastS;
  if (summary.ranges.length === 0 || firstS === null || lastS === null) {
    return { timeS: 0, clamped: true, inRecording: false };
  }

  let timeS = requestedS;
  let clamped = false;
  // A broken number goes to the first frame rather than propagating as NaN
  // into a currentTime assignment, which throws and leaves the player dead.
  if (!Number.isFinite(timeS)) {
    timeS = firstS;
    clamped = true;
  }
  if (timeS < firstS) {
    timeS = firstS;
    clamped = true;
  }
  if (timeS > lastS) {
    timeS = lastS;
    clamped = true;
  }

  let inRecording = false;
  for (const range of summary.ranges) {
    // end is exclusive: the last second of a range is the second before it.
    if (timeS >= range.startS && timeS < range.endS) {
      inRecording = true;
      break;
    }
  }
  return { timeS, clamped, inRecording };
}

/**
 * The -10s / +10s buttons. Routed through seekTo so a step and a scrub cannot
 * disagree about where the edge of the recording is.
 */
export function stepBy(summary: RangeSummary, currentS: number, deltaS: number): SeekResult {
  return seekTo(summary, currentS + deltaS);
}

/**
 * Jump to the start of the next recorded chunk, or back to the start of the
 * previous one.
 *
 * Backwards from inside a chunk lands on THAT chunk's start, not the one
 * before it -- the same as the previous-track button on every player anyone
 * has used, and the behaviour an operator will expect without being told.
 *
 * Returns null when there is nowhere to go, so the page can disable the
 * button. A button that silently does nothing is what makes an operator press
 * it twenty times and then telephone the installer.
 */
export function nextGapEdge(
  summary: RangeSummary,
  currentS: number,
  direction: 1 | -1,
): SeekResult | null {
  // A range start is by definition inside that range, so these are never
  // clamped and never land in a gap.
  if (direction === 1) {
    for (const range of summary.ranges) {
      if (range.startS > currentS) {
        return { timeS: range.startS, clamped: false, inRecording: true };
      }
    }
    return null;
  }

  for (let i = summary.ranges.length - 1; i >= 0; i--) {
    const range = summary.ranges[i];
    if (range !== undefined && range.startS < currentS) {
      return { timeS: range.startS, clamped: false, inRecording: true };
    }
  }
  return null;
}

/**
 * Day-seconds as a 24-hour clock.
 *
 * A negative or broken input reads "--:--:--" and never "00:00:00": an
 * unknown time must not be readable as midnight (build rule 5).
 *
 * Past midnight it keeps counting -- "24:00:00", "25:00:00" -- rather than
 * wrapping. A recording that overran into the next day is exactly the case
 * where the operator needs to see that it did, and a wrapped clock hides it.
 *
 * Built with padStart rather than Date or toLocaleTimeString: those would
 * render the appliance's locale and timezone into a figure that is already
 * relative to the reviewed day's own midnight.
 */
export function clockText(dayS: number): string {
  if (!Number.isFinite(dayS) || dayS < 0) return "--:--:--";
  // Floor, never round: rounding up reports a second that has not happened.
  const total = Math.floor(dayS);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0")
  );
}
