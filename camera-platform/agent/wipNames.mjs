/**
 * In-progress segment naming.
 *
 * The appliance is Linux, where ffmpeg's `%s` strftime expansion yields epoch
 * seconds and the whole store contract keys on it. Microsoft's CRT — and so
 * every Windows ffmpeg build — does not implement `%s`: it expands to an empty
 * string and the muxer fails with "Failed to open segment ''" before any
 * recording happens (found on the bench, 2026-09-13).
 *
 * So the Windows bench runs a second, clearly-fenced format:
 *   `%Y%m%dT%H%M%S` — 14 digits + T + 6 digits, fixed width, sortable as text.
 * It parses as LOCAL wall time, which is the best a filename can do there.
 * Every non-Windows platform takes the `%s` path unchanged; nothing on Linux
 * ever sees the bench format. Sealed names (`<epochMs>.mp4`) are computed by
 * Node at seal time and are identical on every platform.
 */

const WIN32_WIP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;

export function wipPattern(platform = process.platform) {
  return platform === "win32" ? "%Y%m%dT%H%M%S.mp4" : "%s.mp4";
}

/**
 * Start time in epoch ms for an in-progress filename. Digits-only is ffmpeg's
 * `%s` epoch seconds (the appliance format); the bench format is local wall
 * time. Returns NaN for anything it cannot understand — callers refuse and
 * quarantine, exactly as they did for non-epoch names before this module.
 */
export function wipStartMs(filename) {
  const base = String(filename).replace(/\.mp4$/, "");
  if (/^\d+$/.test(base)) {
    const epochSeconds = Number(base);
    if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) return NaN;
    return epochSeconds * 1000;
  }
  const m = WIN32_WIP_RE.exec(String(filename));
  if (m === null) return NaN;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** Chronological comparator for in-progress filenames, both formats. */
export function wipCompare(a, b) {
  return wipStartMs(a) - wipStartMs(b);
}