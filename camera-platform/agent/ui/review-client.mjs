// agent/ui/review-client.mjs
//
// Pure client-side half of the review page (A3 slice 2): lays out a day's
// coverage strip, maps clicks to instants and back, and turns a /playback
// response into one thing for the page to do. Contract: REVIEW-UI-SPEC.md
// section 1. Zero imports — the browser page and the Node harness import the
// IDENTICAL file. Refusals are VALUES ({ error }), never thrown.
//
// The rule this module exists to enforce: a hole in the recording must never
// look like recording, and the part of today that has not happened yet must
// never look like a hole.

/**
 * Bars for the coverage strip, from a /timeline 200 body.
 *
 * Returns { bars } — one bar per run, in order, then a "future" bar when
 * effective.endUtc is before requested.endUtc. Each bar, keys in this order:
 * { kind, startUtc, endUtc, left, width, widened, gapReason, gapSource }.
 * left/width are fractions of the REQUESTED range, computed in milliseconds:
 * left = (start - requestedStart) / total, width = (end - start) / total,
 * total = requestedEnd - requestedStart. Times are parsed with Date.parse
 * (they are the server's own ISO strings) and a time that is not a string, or
 * parses to NaN, "does not parse". A gap narrower than
 * minGapFraction is widened to it (widened: true) and shifted left if it would
 * pass the right edge; recorded and future bars are never widened.
 * startUtc/endUtc are copied through as given. gapReason/gapSource are the
 * run's (null for recorded and future).
 *
 * { error } when body is not an object; requested/effective are missing or a
 * time does not parse; requested end <= requested start; effective start is not
 * requested start; effective end is after requested end or not after effective
 * start; runs is not a non-empty array; a run's kind is not "recorded" or
 * "gap"; the runs are not contiguous from effective start to effective end;
 * minGapFraction is not a finite number in [0, 1).
 */
function isNonArrayObject(x) { return typeof x === "object" && x !== null && !Array.isArray(x); }
function parseTime(s, name) { if (typeof s !== "string") return { error: `${name} not a string` }; const ms = Date.parse(s); if (Number.isNaN(ms)) return { error: `${name} does not parse` }; return ms; }
export function layoutCoverage(body, minGapFraction = 0.004) {
  // Validate body
  if (!isNonArrayObject(body)) return { error: "body must be an object" };
  // Validate minGapFraction
  if (typeof minGapFraction !== "number" || !Number.isFinite(minGapFraction) || minGapFraction < 0 || minGapFraction >= 1) return { error: "minGapFraction must be a finite number in [0,1)" };
  // Extract requested and effective
  const requested = body.requested;
  const effective = body.effective;
  if (!isNonArrayObject(requested) || !isNonArrayObject(effective)) return { error: "requested/effective must be objects" };
  const reqStartMs = parseTime(requested.startUtc, "requested.startUtc"); if (reqStartMs.error) return reqStartMs;
  const reqEndMs = parseTime(requested.endUtc, "requested.endUtc"); if (reqEndMs.error) return reqEndMs;
  const effStartMs = parseTime(effective.startUtc, "effective.startUtc"); if (effStartMs.error) return effStartMs;
  const effEndMs = parseTime(effective.endUtc, "effective.endUtc"); if (effEndMs.error) return effEndMs;
  // Validate ranges
  if (reqEndMs <= reqStartMs) return { error: "requested end <= requested start" };
  if (effStartMs !== reqStartMs) return { error: "effective start != requested start" };
  if (effEndMs > reqEndMs) return { error: "effective end > requested end" };
  if (effEndMs <= effStartMs) return { error: "effective end <= effective start" };
  // Validate runs
  const runs = body.runs;
  if (!Array.isArray(runs) || runs.length === 0) return { error: "runs must be a non-empty array" };
  const total = reqEndMs - reqStartMs;
  const bars = [];
  let prevEndMs = effStartMs;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!isNonArrayObject(run)) return { error: "run must be an object" };
    const kind = run.kind;
    if (kind !== "recorded" && kind !== "gap") return { error: "run kind must be recorded or gap" };
    const startMs = parseTime(run.startUtc, `run ${i} startUtc`); if (startMs.error) return startMs;
    const endMs = parseTime(run.endUtc, `run ${i} endUtc`); if (endMs.error) return endMs;
    if (endMs <= startMs) return { error: "run end <= run start" };
    if (i === 0) {
      if (startMs !== effStartMs) return { error: "first run does not start at effective start" };
    } else {
      if (startMs !== prevEndMs) return { error: "runs are not contiguous" };
    }
    prevEndMs = endMs;
    // Build bar
    let left = (startMs - reqStartMs) / total;
    const width0 = (endMs - startMs) / total;
    let widened = false;
    let width = width0;
    if (kind === "gap") {
      if (width < minGapFraction) { width = minGapFraction; widened = true; }
      if (left + width > 1) { left = 1 - width; }
    }
    bars.push({
      kind,
      startUtc: run.startUtc,
      endUtc: run.endUtc,
      left,
      width,
      widened,
      gapReason: kind === "gap" ? run.gapReason : null,
      gapSource: kind === "gap" ? run.gapSource : null,
    });
  }
  // After loop, prevEndMs should equal effEndMs
  if (prevEndMs !== effEndMs) return { error: "runs do not cover effective range" };
  // Add future bar if needed
  if (effEndMs < reqEndMs) {
    const left = (effEndMs - reqStartMs) / total;
    const width = (reqEndMs - effEndMs) / total;
    bars.push({
      kind: "future",
      startUtc: body.effective.endUtc,
      endUtc: body.requested.endUtc,
      left,
      width,
      widened: false,
      gapReason: null,
      gapSource: null,
    });
  }
  return { bars };
}


/**
 * The instant a click at `fraction` of the strip lands on.
 *
 * fraction is clamped to [0, 1]; ms = start + Math.floor(fraction * (end - start));
 * half-open, so a result at or past end becomes end - 1.
 * Returns { utc: new Date(ms).toISOString() }.
 * { error } when fraction is not a finite number, a time does not parse, or
 * end <= start.
 */
export function fractionToInstant(fraction, startUtc, endUtc) {
  // Validate fraction
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
    return { error: "fraction must be a finite number" };
  }
  // Validate startUtc
  if (typeof startUtc !== "string" || Number.isNaN(Date.parse(startUtc))) {
    return { error: "startUtc does not parse" };
  }
  // Validate endUtc
  if (typeof endUtc !== "string" || Number.isNaN(Date.parse(endUtc))) {
    return { error: "endUtc does not parse" };
  }
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (endMs <= startMs) {
    return { error: "endUtc must be after startUtc" };
  }
  const fractionClamped = Math.min(Math.max(fraction, 0), 1);
  let ms = startMs + Math.floor(fractionClamped * (endMs - startMs));
  if (ms >= endMs) {
    ms = endMs - 1;
  }
  return { utc: new Date(ms).toISOString() };
}

/**
 * The playhead position: (t - start) / (end - start) when start <= t <= end.
 * null when outside the range, when any time does not parse, or end <= start.
 */
export function instantToFraction(utc, startUtc, endUtc) {
  if (typeof utc !== "string" || Number.isNaN(Date.parse(utc))) return null;
  if (typeof startUtc !== "string" || Number.isNaN(Date.parse(startUtc))) return null;
  if (typeof endUtc !== "string" || Number.isNaN(Date.parse(endUtc))) return null;
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (endMs <= startMs) return null;
  const tMs = Date.parse(utc);
  if (tMs < startMs || tMs > endMs) return null;
  return (tMs - startMs) / (endMs - startMs);
}

const GAP_LABELS = {
  camera_offline: "Camera offline",
  appliance_offline: "Recorder offline",
  disk_full: "Not recorded: disk full",
  evicted_by_retention: "Deleted by the retention policy",
  tampered: "Tamper detected",
};

/**
 * Plain words for a gap. ASCII only.
 * camera_offline -> "Camera offline"; appliance_offline -> "Recorder offline";
 * disk_full -> "Not recorded: disk full"; evicted_by_retention -> "Deleted by
 * the retention policy"; tampered -> "Tamper detected"; unknown or any other
 * value -> "Not recorded: reason unknown". When source === "inferred", append
 * " (nothing was logged for this hole)".
 */
export function describeGap(reason, source) {
  let label;
  if (typeof reason === "string" && Object.prototype.hasOwnProperty.call(GAP_LABELS, reason)) {
    label = GAP_LABELS[reason];
  } else {
    label = "Not recorded: reason unknown";
  }
  if (source === "inferred") {
    label += " (nothing was logged for this hole)";
  }
  return label;
}

/**
 * One action for the page, from any parsed /playback body (success or refusal).
 * Keys in the order shown.
 *
 * - not an object -> { action: "error", code: "bad_response", message: "the recorder sent something unreadable" }
 * - ok === false -> { action: "error", code, message }, each copied when a string,
 *   else "bad_response" / the unreadable message.
 * - ok !== true, or resolution not an object -> the bad_response error.
 * - kind "segment" -> { action: "play", src: "/segments/" + segmentId, offsetSeconds, segmentStartUtc, segmentEndUtc }.
 *   segmentId must match /^[A-Za-z0-9_-]{1,64}\.(0|[1-9][0-9]*)$/ and offsetSeconds
 *   must be a finite number >= 0, else the bad_response error. Never reads resolution.path.
 * - kind "gap" -> { action: "gap", label: describeGap(reason, source), nextRecordedUtc }
 *   (nextRecordedUtc copied when a string, else null).
 * - kind "recording" -> { action: "live", segmentStartUtc }.
 * - kind "future" -> { action: "future", nowUtc }.
 * - any other kind -> the bad_response error.
 */
export function planPlayback(body) {
  // Check body is object
  if (!(typeof body === "object" && body !== null && !Array.isArray(body))) {
    return { action: "error", code: "bad_response", message: "the recorder sent something unreadable" };
  }

  // Handle error response
  if (body.ok === false) {
    const code = typeof body.code === "string" ? body.code : "bad_response";
    const message = typeof body.message === "string" ? body.message : "the recorder sent something unreadable";
    return { action: "error", code, message };
  }

  // Any ok value other than true leads to unreadable
  if (body.ok !== true) {
    return { action: "error", code: "bad_response", message: "the recorder sent something unreadable" };
  }

  // Resolve the playback resolution
  const resolution = body.resolution;
  if (!(typeof resolution === "object" && resolution !== null && !Array.isArray(resolution))) {
    return { action: "error", code: "bad_response", message: "the recorder sent something unreadable" };
  }

  const kind = resolution.kind;
  if (kind === "segment") {
    const segmentId = resolution.segmentId;
    const offsetSeconds = resolution.offsetSeconds;
    const segmentStartUtc = resolution.segmentStartUtc;
    const segmentEndUtc = resolution.segmentEndUtc;
    const idRegex = /^[A-Za-z0-9_-]{1,64}\.(0|[1-9][0-9]*)$/;
    if (typeof segmentId !== "string" || !idRegex.test(segmentId)) {
      return { action: "error", code: "bad_response", message: "the recorder sent something unreadable" };
    }
    if (typeof offsetSeconds !== "number" || !Number.isFinite(offsetSeconds) || offsetSeconds < 0) {
      return { action: "error", code: "bad_response", message: "the recorder sent something unreadable" };
    }
    return {
      action: "play",
      src: "/segments/" + segmentId,
      offsetSeconds,
      segmentStartUtc,
      segmentEndUtc,
    };
  }

  if (kind === "gap") {
    const reason = resolution.reason;
    const source = resolution.source;
    const label = describeGap(reason, source);
    const nextRecordedUtc = typeof resolution.nextRecordedUtc === "string" ? resolution.nextRecordedUtc : null;
    return {
      action: "gap",
      label,
      nextRecordedUtc,
    };
  }

  if (kind === "recording") {
    const segmentStartUtc = resolution.segmentStartUtc;
    return {
      action: "live",
      segmentStartUtc,
    };
  }

  if (kind === "future") {
    const nowUtc = resolution.nowUtc;
    return {
      action: "future",
      nowUtc,
    };
  }

  return { action: "error", code: "bad_response", message: "the recorder sent something unreadable" };
}

/**
 * A byte count for a person, always with its unit. Decimal units (1 KB = 1000 B),
 * ASCII only. null when n is not a safe integer >= 0 (Number.isSafeInteger).
 * - n < 1000: String(n) + " B".
 * - n < 999950: (n / 1e3).toFixed(1) + " KB".
 * - n < 999950000: (n / 1e6).toFixed(1) + " MB".
 * - otherwise: (n / 1e9).toFixed(2) + " GB".
 * (The 999950 boundaries stop a value reading "1000.0 KB": it reads "1.0 MB".)
 */
export function formatBytes(n) {
  if (!Number.isSafeInteger(n) || n < 0) return null;
  if (n < 1000) return `${n} B`;
  if (n < 999950) return `${(n / 1e3).toFixed(1)} KB`;
  if (n < 999950000) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

function badResponse(code, message) {
  return { action: "error", code, message };
}

/**
 * What the export control shows, from any parsed /export/plan body (success
 * or refusal). Keys in the order shown. Copies only the named fields: the body
 * is never spread.
 *
 * - not an object (null and arrays are not) -> { action: "error", code: "bad_response", message: "the recorder sent something unreadable" }
 * - ok === false -> { action: "error", code, message }, each copied when a string,
 *   else "bad_response" / the unreadable message.
 * - ok !== true -> the bad_response error.
 * - The bad_response error too unless ALL of: fileCount is a safe integer >= 1;
 *   totalBytes is a safe integer >= 0; delivered is an object whose startUtc and
 *   endUtc are strings that Date.parse to numbers (not NaN) with end > start;
 *   gaps is an array.
 * - Otherwise { action: "offer", fileCount, totalBytes, size: formatBytes(totalBytes),
 *   deliveredStartUtc: delivered.startUtc, deliveredEndUtc: delivered.endUtc,
 *   gapCount: gaps.length }.
 */
export function planExportOffer(body) {
  // validate body is object
  if (!isNonArrayObject(body)) {
    return badResponse("bad_response", "the recorder sent something unreadable");
  }
  // handle error response
  if (body.ok === false) {
    const code = typeof body.code === "string" ? body.code : "bad_response";
    const message = typeof body.message === "string" ? body.message : "the recorder sent something unreadable";
    return badResponse(code, message);
  }
  // any ok value other than true leads to unreadable
  if (body.ok !== true) {
    return badResponse("bad_response", "the recorder sent something unreadable");
  }
  // Now ok true
  const fileCount = body.fileCount;
  if (!Number.isSafeInteger(fileCount) || fileCount < 1) {
    return badResponse("bad_response", "the recorder sent something unreadable");
  }
  const totalBytes = body.totalBytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    return badResponse("bad_response", "the recorder sent something unreadable");
  }
  const delivered = body.delivered;
  if (!isNonArrayObject(delivered)) {
    return badResponse("bad_response", "the recorder sent something unreadable");
  }
  const delStart = delivered.startUtc;
  const delEnd = delivered.endUtc;
  if (typeof delStart !== "string" || typeof delEnd !== "string") {
    return badResponse("bad_response", "the recorder sent something unreadable");
  }
  const delStartMs = Date.parse(delStart);
  const delEndMs = Date.parse(delEnd);
  if (Number.isNaN(delStartMs) || Number.isNaN(delEndMs) || delEndMs <= delStartMs) {
    return badResponse("bad_response", "the recorder sent something unreadable");
  }
  const gaps = body.gaps;
  if (!Array.isArray(gaps)) {
    return badResponse("bad_response", "the recorder sent something unreadable");
  }
  const size = formatBytes(totalBytes);
  return {
    action: "offer",
    fileCount,
    totalBytes,
    size,
    deliveredStartUtc: delStart,
    deliveredEndUtc: delEnd,
    gapCount: gaps.length,
  };
}

/**
 * A month as a Sunday-first grid, for the day picker. Pure: no clock, no local
 * time zone. Every date is built with Date.UTC, so the grid is the same on
 * every machine.
 *
 * year: an integer 1970..9999. month: an integer 1..12. recordedDays: an array
 * of "YYYY-MM-DD" strings, the days this camera has footage for.
 *
 * Returns { year, month, label, weeks }, keys in that order.
 * - label: the English month name and the year, e.g. "September 2026". ASCII.
 * - weeks: an array of arrays of exactly 7 cells, Sunday first. A cell is null
 *   where the grid pads before the 1st or after the last day, else
 *   { day, dayOfMonth, recorded } with keys in that order: day is
 *   "YYYY-MM-DD" (zero padded), dayOfMonth is 1..31, recorded is true when
 *   that exact day string is in recordedDays. recordedDays entries that are
 *   not strings, or are not a day of this month, are ignored; the list is
 *   never parsed as a date.
 * - Every day of the month appears exactly once, in order.
 *
 * { error } when year is not an integer in 1970..9999, month is not an integer
 * in 1..12, or recordedDays is not an array. Never throws.
 */
export function monthCalendar(year, month, recordedDays) {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) return { error: "invalid year" };
  if (!Number.isInteger(month) || month < 1 || month > 12) return { error: "invalid month" };
  if (!Array.isArray(recordedDays)) return { error: "invalid recordedDays" };
  const recordedSet = new Set();
  for (const d of recordedDays) {
    if (typeof d === "string") recordedSet.add(d);
  }
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const label = monthNames[month-1] + " " + year;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstDayWeekday = new Date(Date.UTC(year, month-1, 1)).getUTCDay();
  const weeks = [];
  let week = new Array(7).fill(null);
  let dayIndex = 0;
  for (let i = 0; i < firstDayWeekday; i++) {
    week[i] = null;
  }
  dayIndex = firstDayWeekday;
  for (let day = 1; day <= daysInMonth; day++) {
    const dayStr = year.toString().padStart(4, "0") + "-" + month.toString().padStart(2, "0") + "-" + day.toString().padStart(2, "0");
    const cell = { day: dayStr, dayOfMonth: day, recorded: recordedSet.has(dayStr) };
    week[dayIndex] = cell;
    dayIndex++;
    if (dayIndex === 7) {
      weeks.push(week);
      week = new Array(7).fill(null);
      dayIndex = 0;
    }
  }
  if (dayIndex > 0) {
    weeks.push(week);
  }
  return { year, month, label, weeks };
}

/**
 * The choices in the From and To dropdowns: every step of one local day, so a
 * time is picked and never typed. Pure: the zone is passed in, never read from
 * the machine.
 *
 * runs: the runs array of a /timeline body; only kind "recorded" counts, and a
 * run that cannot be read (not an object, or a time that does not parse) is
 * ignored rather than guessed at. dayStartUtc / dayEndUtc: the day's window as
 * ISO strings (local midnight to the next local midnight, so a DST day is 23 or
 * 25 hours). stepMin: an integer 1..720. tz: an IANA zone, used only to format.
 *
 * Returns { options }: one option per step from dayStartUtc while the instant
 * is before dayEndUtc, then one final option at dayEndUtc. Each option is
 * { value, hhmm, label, recorded }, keys in that order:
 * - value: the instant as an ISO string, new Date(ms).toISOString(). This is
 *   what the page puts in the <option> value, so the two 1 AMs of a fall-back
 *   day stay different choices.
 * - hhmm: the wall clock in the zone, "HH:MM", 24 hour, zero padded; "24:00"
 *   for the final end-of-day option. Some ICU builds render midnight as "24",
 *   so a leading "24" from the formatter becomes "00".
 * - label: the wall clock in plain words, 12 hour, e.g. "12:00 AM", "1:15 PM";
 *   "Midnight (end of day)" for the final option. ASCII only: any U+202F or
 *   U+00A0 the formatter produces becomes a plain space.
 * - recorded: true when the instant falls inside a recorded run, start
 *   inclusive and end exclusive. For the final end-of-day option the instant
 *   read is dayEndUtc minus one millisecond, so a day recorded to midnight
 *   says recorded.
 *
 * { error } when a time does not parse, dayEndUtc is not after dayStartUtc,
 * stepMin is not an integer in 1..720, runs is not an array, or tz is not a
 * string an Intl.DateTimeFormat will accept. Never throws.
 */
export function timeOptions(runs, dayStartUtc, dayEndUtc, stepMin = 15, tz) {
  try {
    if (!Array.isArray(runs)) return { error: "runs is not an array" };
    const startMs = Date.parse(dayStartUtc);
    if (!Number.isFinite(startMs)) return { error: "dayStartUtc does not parse" };
    const endMs = Date.parse(dayEndUtc);
    if (!Number.isFinite(endMs)) return { error: "dayEndUtc does not parse" };
    if (!(endMs > startMs)) return { error: "dayEndUtc is not after dayStartUtc" };
    if (!Number.isInteger(stepMin) || stepMin < 1 || stepMin > 720) return { error: "stepMin is not an integer in 1..720" };
    if (typeof tz !== "string") return { error: "tz is not a string" };
    let fmt24 = null;
    let fmt12 = null;
    try {
      fmt24 = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
      fmt12 = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
    } catch (e) {
      return { error: "tz is not a zone Intl accepts" };
    }
    const own = function (obj, key) {
      try {
        if (obj === null || typeof obj !== "object") return undefined;
        if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
        return obj[key];
      } catch (e) {
        return undefined;
      }
    };
    const spans = [];
    for (const r of runs) {
      try {
        if (r === null || typeof r !== "object") continue;
        if (own(r, "kind") !== "recorded") continue;
        const sMs = Date.parse(own(r, "startUtc"));
        const eMs = Date.parse(own(r, "endUtc"));
        if (Number.isFinite(sMs) && Number.isFinite(eMs)) spans.push([sMs, eMs]);
      } catch (e) {
        continue;
      }
    }
    const isRecorded = function (probe) {
      for (let i = 0; i < spans.length; i++) {
        if (probe >= spans[i][0] && probe < spans[i][1]) return true;
      }
      return false;
    };
    const toAscii = function (s) {
      return s.replace(/[\u00A0\u202F]/g, " ");
    };
    const partOf = function (fmt, date, type) {
      const parts = fmt.formatToParts(date);
      for (const p of parts) {
        if (p && p.type === type) return p.value;
      }
      return "";
    };
    const pad2 = function (s) {
      return s.length >= 2 ? s : "0" + s;
    };
    const clockAt = function (ms) {
      const d = new Date(ms);
      let h = pad2(partOf(fmt24, d, "hour"));
      if (h === "24") h = "00";
      const m = pad2(partOf(fmt24, d, "minute"));
      let lh = partOf(fmt12, d, "hour");
      if (lh === "24" || lh === "00") lh = "12";
      const lm = pad2(partOf(fmt12, d, "minute"));
      const ap = partOf(fmt12, d, "dayPeriod");
      return { hhmm: h + ":" + m, label: toAscii(lh + ":" + lm + " " + ap) };
    };
    const optionAt = function (ms, isFinal) {
      const c = isFinal ? { hhmm: "24:00", label: "Midnight (end of day)" } : clockAt(ms);
      return {
        value: new Date(ms).toISOString(),
        hhmm: c.hhmm,
        label: c.label,
        recorded: isRecorded(isFinal ? ms - 1 : ms),
      };
    };
    const options = [];
    const stepMs = stepMin * 60000;
    for (let ms = startMs; ms < endMs; ms += stepMs) {
      options.push(optionAt(ms, false));
    }
    options.push(optionAt(endMs, true));
    return { options };
  } catch (e) {
    return { error: "could not build the time options" };
  }
}

/**
 * The window a length chip means: lengthMin minutes centred on the moment
 * being watched, then moved so it never asks the recorder for footage it
 * cannot have. Pure.
 *
 * momentUtc: the instant on screen. lengthMin: a finite number > 0 (the chips
 * are 1, 5, 15 and 60 for a download and 1, 2 and 5 for teaching). nowUtc: the
 * recorder's now. dayStartUtc / dayEndUtc: the day's window.
 *
 * The window may only lie inside [dayStartUtc, min(dayEndUtc, nowUtc)] - call
 * that the reachable span.
 * 1. start = moment - lengthMin*60000/2, end = start + lengthMin*60000.
 * 2. If start is before the span's start, shift both right by the shortfall;
 *    if end is after the span's end, shift both left by the overshoot.
 * 3. Clamp whatever is left to the span. A span shorter than the length is
 *    returned whole.
 *
 * Returns { startUtc, endUtc, lengthMin, clamped }, keys in that order:
 * ISO strings, lengthMin the minutes actually covered ((end - start)/60000, a
 * number that may be fractional), clamped true when the window is not the
 * centred one it started as.
 *
 * { error } when a time does not parse, lengthMin is not a finite number > 0,
 * dayEndUtc is not after dayStartUtc, or the reachable span is empty (nowUtc
 * at or before dayStartUtc: that day has not started). Never throws.
 */
export function rangeAround(momentUtc, lengthMin, nowUtc, dayStartUtc, dayEndUtc) {
  for (const t of [momentUtc, nowUtc, dayStartUtc, dayEndUtc]) {
    if (typeof t !== "string") return { error: "a time is not a string" };
  }
  const moment = Date.parse(momentUtc);
  const now = Date.parse(nowUtc);
  const dayStart = Date.parse(dayStartUtc);
  const dayEnd = Date.parse(dayEndUtc);
  if (!Number.isFinite(moment) || !Number.isFinite(now)
    || !Number.isFinite(dayStart) || !Number.isFinite(dayEnd)) return { error: "a time does not parse" };
  if (dayEnd <= dayStart) return { error: "the day ends before it starts" };
  if (typeof lengthMin !== "number" || !Number.isFinite(lengthMin) || lengthMin <= 0) {
    return { error: "the length is not a number of minutes" };
  }
  // The window may only lie in the reachable span: this day, up to now.
  const spanEnd = Math.min(dayEnd, now);
  if (spanEnd <= dayStart) return { error: "that day has not started" };
  const width = lengthMin * 60000;
  let start = moment - width / 2;
  let end = start + width;
  let clamped = false;
  if (spanEnd - dayStart < width) {
    start = dayStart;
    end = spanEnd;
    clamped = true;
  } else if (start < dayStart) {
    end += dayStart - start;
    start = dayStart;
    clamped = true;
  } else if (end > spanEnd) {
    start -= end - spanEnd;
    end = spanEnd;
    clamped = true;
  }
  return {
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(end).toISOString(),
    lengthMin: (end - start) / 60000,
    clamped,
  };
}

/**
 * A refusal in words the person holding the phone can act on. The recorder's
 * codes are for logs, not for a customer standing in a car wash.
 *
 * code: the recorder's code. message: the recorder's own sentence.
 * Returns one plain-ASCII sentence, at most 240 characters.
 *
 * A code it knows is answered in plain words and the recorder's message is
 * dropped - the plain sentence replaces the jargon, it does not decorate it:
 * The table is the recorder's own codes, from contracts/apiQuery.ts,
 * contracts/exportPlan.ts and agent/api-server.mjs:
 *   export_too_large         -> "That is more video than one download can hold. Pick a shorter length."
 *   export_nothing_recorded  -> "Nothing was recorded in that stretch."
 *   export_reaches_recording -> "That stretch runs into footage still being recorded. Pick a time that has finished."
 *   export_size_unknown      -> "The recorder cannot say yet how big that download would be. Try a shorter stretch."
 *   no_coverage              -> "Nothing was recorded then."
 *   no_usable_bytes          -> "The footage for that stretch cannot be read."
 *   window_in_future         -> "That day has not happened yet."
 *   window_too_large         -> "That is too long a stretch to ask for at once."
 *   inverted_window          -> "Pick an end time after the start time."
 *   no_such_camera           -> "That camera is not set up on this recorder."
 *   bad_camera               -> the same sentence
 *   bad_camera_id            -> the same sentence
 *   no_cameras               -> "No cameras are set up on this recorder yet."
 *   index_state_invalid      -> "The recorder kept a record of what it holds that disagrees with itself. Nothing is hidden, but it needs a look."
 *   forbidden                -> "This account is not allowed to do that."
 *   unauthorized             -> "Sign in to do that."
 *   bad_response             -> "The recorder sent something this page could not read."
 *   unreachable              -> "Cannot reach the recorder."
 *
 * Anything else is REPORTED, never guessed at: "Something went wrong" then,
 * when message is a non-empty string, ": " and the message, then, when code is
 * a non-empty string, " (" and the code and ")", then ".". Only the codes in
 * the table above are known - a key that happens to exist on Object.prototype
 * ("constructor", "toString") is not one of them.
 *
 * The code and the message are the recorder's text, so they are cleaned before
 * they are shown: every character outside printable ASCII becomes a space, runs
 * of spaces collapse to one, and the ends are trimmed. The message is cut to
 * 160 characters and the code to 40. Never throws.
 */
export function friendlyProblem(code, message) {
  const mapping = {
    export_too_large: "That is more video than one download can hold. Pick a shorter length.",
    export_nothing_recorded: "Nothing was recorded in that stretch.",
    export_reaches_recording: "That stretch runs into footage still being recorded. Pick a time that has finished.",
    export_size_unknown: "The recorder cannot say yet how big that download would be. Try a shorter stretch.",
    no_coverage: "Nothing was recorded then.",
    no_usable_bytes: "The footage for that stretch cannot be read.",
    window_in_future: "That day has not happened yet.",
    window_too_large: "That is too long a stretch to ask for at once.",
    inverted_window: "Pick an end time after the start time.",
    no_such_camera: "That camera is not set up on this recorder.",
    bad_camera: "That camera is not set up on this recorder.",
    bad_camera_id: "That camera is not set up on this recorder.",
    no_cameras: "No cameras are set up on this recorder yet.",
    index_state_invalid: "The recorder kept a record of what it holds that disagrees with itself. Nothing is hidden, but it needs a look.",
    forbidden: "This account is not allowed to do that.",
    unauthorized: "Sign in to do that.",
    bad_response: "The recorder sent something this page could not read.",
    unreachable: "Cannot reach the recorder."
  };
  const codeStr = typeof code === 'string' ? code : '';
  const msgStr = typeof message === 'string' ? message : '';
  if (Object.prototype.hasOwnProperty.call(mapping, codeStr)) {
    return mapping[codeStr];
  }
  function clean(str, maxLen) {
    let cleaned = str.replace(/[^\x20-\x7E]/g, ' ');
    cleaned = cleaned.replace(/ +/g, ' ');
    cleaned = cleaned.trim();
    if (cleaned.length > maxLen) {
      cleaned = cleaned.slice(0, maxLen);
    }
    return cleaned;
  }
  const cleanedCode = clean(codeStr, 40);
  const cleanedMsg = clean(msgStr, 160);
  let result = 'Something went wrong';
  if (cleanedMsg.length > 0) {
    result += ': ' + cleanedMsg;
  }
  if (cleanedCode.length > 0) {
    result += ' (' + cleanedCode + ')';
  }
  result += '.';
  if (result.length > 240) {
    result = result.slice(0, 240);
  }
  return result;
}

/**
 * How much the AI has been taught so far, and how much is still short of the
 * gate, from a GET /clip-library body's `library`. Counts; it does not judge.
 *
 * The gates are the answer key's own, in contracts/clipLibrary.ts:
 * MIN_GATE_PERSONS is 20 and MIN_GATE_EMPTY_HOURS is 1 (60 minutes). This file
 * imports nothing, so they are repeated here; if they move there, move them
 * here.
 *
 * A clip is counted only when it reads as one: an object whose startUtc and
 * endUtc parse with end after start, whose scenes is an array, and whose
 * expected is an array in which every entry is an object with a kind and a
 * count that is a safe integer >= 0. Anything else is counted in `skipped` and
 * contributes nothing - a clip that cannot be read is not a clip of zero.
 *
 * Returns, keys in this order:
 * { clipCount, personCount, vehicleCount, emptyMinutes, personsStillNeeded,
 *   emptyMinutesStillNeeded, skipped }
 * - personCount / vehicleCount: the expected counts summed over counted clips.
 * - emptyMinutes: the milliseconds of every counted clip whose scenes include
 *   "empty", summed first and floored to whole minutes once at the end.
 * - personsStillNeeded: Math.max(0, 20 - personCount).
 * - emptyMinutesStillNeeded: Math.max(0, 60 - emptyMinutes).
 *
 * { error } when library is not an object (null and arrays are not) or
 * library.clips is not an array. Never throws.
 */
export function clipProgress(library) {
  if (typeof library !== 'object' || library === null || Array.isArray(library)) {
    return { error: "invalid library" };
  }
  if (!Object.prototype.hasOwnProperty.call(library, 'clips') || !Array.isArray(library.clips)) {
    return { error: "invalid library" };
  }
  const clips = library.clips;
  let clipCount = 0;
  let personCount = 0;
  let vehicleCount = 0;
  let emptyMs = 0;
  let skipped = 0;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (typeof clip !== 'object' || clip === null || Array.isArray(clip)) {
      skipped++;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(clip, 'startUtc')) {
      skipped++;
      continue;
    }
    const startStr = clip.startUtc;
    if (typeof startStr !== 'string') {
      skipped++;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(clip, 'endUtc')) {
      skipped++;
      continue;
    }
    const endStr = clip.endUtc;
    if (typeof endStr !== 'string') {
      skipped++;
      continue;
    }
    const startMs = Date.parse(startStr);
    const endMs = Date.parse(endStr);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      skipped++;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(clip, 'scenes')) {
      skipped++;
      continue;
    }
    const scenes = clip.scenes;
    if (!Array.isArray(scenes)) {
      skipped++;
      continue;
    }
    let expected;
    if (!Object.prototype.hasOwnProperty.call(clip, 'expected')) {
      expected = [];
    } else {
      const exp = clip.expected;
      if (!Array.isArray(exp)) {
        skipped++;
        continue;
      }
      expected = exp;
    }
    let validExpected = true;
    for (let j = 0; j < expected.length; j++) {
      const e = expected[j];
      if (typeof e !== 'object' || e === null || Array.isArray(e)) {
        validExpected = false;
        break;
      }
      if (!Object.prototype.hasOwnProperty.call(e, 'kind') || !Object.prototype.hasOwnProperty.call(e, 'count')) {
        validExpected = false;
        break;
      }
      const count = e.count;
      if (!Number.isSafeInteger(count) || count < 0) {
        validExpected = false;
        break;
      }
    }
    if (!validExpected) {
      skipped++;
      continue;
    }
    clipCount++;
    for (let j = 0; j < expected.length; j++) {
      const e = expected[j];
      if (e.kind === 'person') {
        personCount += e.count;
      } else if (e.kind === 'vehicle') {
        vehicleCount += e.count;
      }
    }
    if (scenes.includes('empty')) {
      emptyMs += endMs - startMs;
    }
  }
  const emptyMinutes = Math.floor(emptyMs / 60000);
  const personsStillNeeded = Math.max(0, 20 - personCount);
  const emptyMinutesStillNeeded = Math.max(0, 60 - emptyMinutes);
  return {
    clipCount,
    personCount,
    vehicleCount,
    emptyMinutes,
    personsStillNeeded,
    emptyMinutesStillNeeded,
    skipped
  };
}

/**
 * Which local days a month of runs has footage on, so the calendar can mark
 * them. Pure: the zone is passed in, never read from the machine.
 *
 * runs: the runs array of a /timeline body covering the month; only kind
 * "recorded" counts, and a run that cannot be read (not an object, or a time
 * that does not parse, or an end at or before its start) is ignored rather
 * than guessed at. tz: an IANA zone.
 *
 * Returns { days }: the local day of every instant a recorded run covers, as
 * "YYYY-MM-DD" strings, sorted ascending with no duplicates. A run that crosses
 * midnight names both days. The range is half-open, so a run ending exactly at
 * midnight does not name the day after.
 *
 * Walk each run by stepping twelve hours at a time from its start, naming the
 * day at each step, and name the day of (end - 1 ms) last. Twelve hours cannot
 * step over a day, since the shortest local day is 23 hours, and a month-long
 * run is then seventy steps rather than billions of milliseconds.
 *
 * { error } when runs is not an array, or tz is not a string an
 * Intl.DateTimeFormat will accept. Never throws.
 */
export function recordedDays(runs, tz) {
  try {
    if (!Array.isArray(runs)) return { error: "runs not array" };
    if (typeof tz !== "string") return { error: "tz not string" };
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch (e) {
      return { error: "invalid zone" };
    }
    const daysSet = new Set();
    const stepMs = 12 * 60 * 60 * 1000;
    for (const run of runs) {
      if (!run || typeof run !== "object") continue;
      if (run.kind !== "recorded") continue;
      const startStr = run.startUtc;
      const endStr = run.endUtc;
      if (typeof startStr !== "string" || typeof endStr !== "string") continue;
      const start = new Date(startStr);
      const end = new Date(endStr);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
      if (end.getTime() <= start.getTime()) continue;
      let current = start.getTime();
      const endTime = end.getTime();
      while (current < endTime) {
        const date = new Date(current);
        const parts = formatter.formatToParts(date);
        let y, m, d;
        for (const p of parts) {
          if (p.type === "year") y = p.value;
          else if (p.type === "month") m = p.value;
          else if (p.type === "day") d = p.value;
        }
        daysSet.add(`${y}-${m}-${d}`);
        current += stepMs;
      }
      const last = new Date(endTime - 1);
      const parts = formatter.formatToParts(last);
      let y, m, d;
      for (const p of parts) {
        if (p.type === "year") y = p.value;
        else if (p.type === "month") m = p.value;
        else if (p.type === "day") d = p.value;
      }
      daysSet.add(`${y}-${m}-${d}`);
    }
    const daysArray = Array.from(daysSet);
    daysArray.sort();
    return { days: daysArray };
  } catch (e) {
    return { error: "error" };
  }
}
