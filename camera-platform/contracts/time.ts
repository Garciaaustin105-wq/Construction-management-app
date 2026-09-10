/**
 * UTC instants as ISO 8601 strings, and the arithmetic over them.
 *
 * WHY a module for this: every quantity in this system carries its unit, and
 * "a time" is the one most often passed around as a bare string that turns out
 * to be local, or milliseconds, or seconds. Parsing goes through one door.
 */

/** Milliseconds since the Unix epoch. Distinct from seconds, deliberately. */
export type EpochMs = number;

export class TimeRangeError extends Error {}

/** Parse an ISO 8601 instant. Throws rather than returning NaN — a silent NaN
 *  propagates into a retention figure and looks like a plausible number. */
export function parseUtc(iso: string): EpochMs {
  if (typeof iso !== "string" || iso.length === 0) {
    throw new TimeRangeError(`expected an ISO 8601 string, got ${JSON.stringify(iso)}`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new TimeRangeError(`not a parseable ISO 8601 instant: ${JSON.stringify(iso)}`);
  }
  return ms;
}

export function toUtc(ms: EpochMs): string {
  if (!Number.isFinite(ms)) {
    throw new TimeRangeError(`not a finite epoch value: ${ms}`);
  }
  return new Date(ms).toISOString();
}

export interface UtcRange {
  startUtc: string;
  endUtc: string;
}

/** Validate a range and return it in epoch-ms form.
 *  An inverted or zero-length range is refused, never silently coerced. */
export function checkRange(range: UtcRange): { startMs: EpochMs; endMs: EpochMs } {
  const startMs = parseUtc(range.startUtc);
  const endMs = parseUtc(range.endUtc);
  if (endMs < startMs) {
    throw new TimeRangeError(`range ends before it starts: ${range.startUtc} .. ${range.endUtc}`);
  }
  if (endMs === startMs) {
    throw new TimeRangeError(`zero-length range at ${range.startUtc}`);
  }
  return { startMs, endMs };
}

export const SECONDS_PER_DAY = 86_400;
export const MS_PER_SECOND = 1_000;
