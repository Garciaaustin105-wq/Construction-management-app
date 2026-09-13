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
