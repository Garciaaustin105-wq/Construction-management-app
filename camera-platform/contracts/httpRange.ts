/**
 * HTTP byte ranges over a segment file (RFC 9110 §14).
 *
 * Playback is a browser <video> element pointed at a fragmented MP4 and left to
 * seek. It seeks with Range requests, so the range arithmetic IS playback: an
 * off-by-one here is a stream that stalls one byte short of the end, and a
 * wrong 416 is a clip that will not open at all.
 *
 * THE SIZE COMES FROM stat(), NEVER FROM THE INDEX. The index's `bytes` is null
 * while a segment is open and can be stale after recovery; a Content-Range built
 * from it lies about the file on disk. So this module refuses a size that is not
 * a real byte count rather than treating null as zero.
 */

/** Why a Range header was ignored in favour of the whole file. */
export type RangeIgnoredReason =
  /** Not a `bytes` range — RFC 9110 says an unknown unit MUST be ignored. */
  | "unit"
  /** Several ranges. Serving multipart/byteranges buys a video player nothing. */
  | "multi_range"
  /** Unparseable, or last-pos before first-pos. Ignored, as the RFC allows. */
  | "malformed";

export type ByteRangePlan =
  /** 200 with the whole file. `ignored` says why a Range header was not honoured. */
  | { kind: "full"; status: 200; length: number; ignored: RangeIgnoredReason | null }
  /** 206. `start` and `end` are inclusive byte offsets, as in Content-Range. */
  | { kind: "partial"; status: 206; start: number; end: number; length: number; contentRange: string }
  /** 416. `contentRange` is `bytes *\/<size>`, which the RFC requires. */
  | { kind: "unsatisfiable"; status: 416; contentRange: string };

export class ByteRangeError extends Error {}

/**
 * Decide what to send for one GET, given its Range header and the file's size.
 *
 * - No header (null, undefined or blank): full.
 * - Trim the header, then split at the first `=`. No `=`, or nothing before it:
 *   malformed. A unit other than `bytes` (case-insensitive): "unit". A comma
 *   anywhere after the `=`: "multi_range". Only then is the one range parsed.
 * - `bytes=a-b`: a..min(b, size-1). b < a is malformed. a >= size is 416.
 * - `bytes=a-`: a..size-1. a >= size is 416.
 * - `bytes=-n`: the last n bytes (the whole file when n >= size). n = 0 is 416.
 * - The unit is case-insensitive. Whitespace around the whole header is ignored;
 *   whitespace inside it is malformed. Only digits are numbers: no signs, no
 *   decimals, no exponents.
 * - A size of 0 has no satisfiable range: every valid range is 416.
 *
 * Throws ByteRangeError when `sizeBytes` is not a non-negative safe integer —
 * that is a caller passing the index's null, and the caller must stat the file.
 */
export function planByteRange(header: string | null | undefined, sizeBytes: number): ByteRangePlan {
  // Before anything else: a size that is not a byte count is the index's null
  // arriving where stat() was meant to, and every answer built on it is a lie.
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new ByteRangeError(
      `sizeBytes must be a non-negative safe integer from stat(), got ${JSON.stringify(sizeBytes)}`);
  }
  const whole = (ignored: RangeIgnoredReason | null): ByteRangePlan =>
    ({ kind: "full", status: 200, length: sizeBytes, ignored });
  const unsatisfiable = (): ByteRangePlan =>
    ({ kind: "unsatisfiable", status: 416, contentRange: `bytes */${sizeBytes}` });

  const value: unknown = header;
  if (value === null || value === undefined) return whole(null);
  if (typeof value !== "string") return whole("malformed");
  const trimmed = value.trim();
  if (trimmed === "") return whole(null);

  const equals = trimmed.indexOf("=");
  if (equals <= 0) return whole("malformed");
  const unit = trimmed.slice(0, equals);
  const spec = trimmed.slice(equals + 1);
  if (unit.toLowerCase() !== "bytes") return whole("unit");
  if (spec.includes(",")) return whole("multi_range");

  const suffix = SUFFIX_PATTERN.exec(spec);
  if (suffix !== null) {
    const countText = suffix[1];
    if (countText === undefined) return whole("malformed");
    const count = Number(countText);
    // n = 0 asks for the last nothing: satisfiable by no byte of any file.
    if (count === 0 || sizeBytes === 0) return unsatisfiable();
    const start = count >= sizeBytes ? 0 : sizeBytes - count;
    return partial(start, sizeBytes - 1, sizeBytes);
  }

  const range = RANGE_PATTERN.exec(spec);
  if (range === null) return whole("malformed");
  const firstText = range[1];
  const lastText = range[2];
  if (firstText === undefined || lastText === undefined) return whole("malformed");
  const first = Number(firstText);
  // An absurd run of digits reads as Infinity, which min() clamps; what it must
  // never do is become NaN and slip through as a plausible offset.
  const stated = lastText === "" ? null : Number(lastText);
  // Backwards is malformed whatever the file is; only then does the file's size
  // decide, so `bytes=0-` on an empty file is 416 rather than malformed.
  if (stated !== null && stated < first) return whole("malformed");
  if (first >= sizeBytes) return unsatisfiable();
  const last = stated === null ? sizeBytes - 1 : Math.min(stated, sizeBytes - 1);
  return partial(first, last, sizeBytes);
}

/** `bytes=-n`: the last n bytes. */
const SUFFIX_PATTERN = /^-([0-9]+)$/;

/** `bytes=a-b` and `bytes=a-`. Digits only: no sign, no point, no exponent. */
const RANGE_PATTERN = /^([0-9]+)-([0-9]*)$/;

function partial(start: number, end: number, sizeBytes: number): ByteRangePlan {
  return {
    kind: "partial",
    status: 206,
    start,
    end,
    length: end - start + 1,
    contentRange: `bytes ${start}-${end}/${sizeBytes}`,
  };
}
