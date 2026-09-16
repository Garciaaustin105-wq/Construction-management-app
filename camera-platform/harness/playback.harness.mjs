/**
 * The review page's playback arithmetic: speed, stepping, and jumping between
 * the chunks that actually got recorded.
 *
 * The failures these checks exist to prevent (build rule 19):
 *
 *  - A gap in the recording being hidden. An operator scrubbing to 14:30 and
 *    landing at 14:32 because the page "helpfully" snapped forward will never
 *    learn that two minutes are missing -- which is the one thing they came to
 *    find out.
 *  - Touching ranges drawn as separate chunks. The recorder seals a file every
 *    60s, so a continuous hour arrives as sixty ranges that touch exactly. Not
 *    merging them makes an unbroken recording look riddled with gaps.
 *  - "Nothing recorded" reading as midnight. firstS is null when there is no
 *    footage, never 0, and an unknown clock reads "--:--:--" (build rule 5).
 *  - A speed control that wraps from 8x back to 0.25x, which looks exactly
 *    like the video freezing.
 *  - A recording that ran past midnight silently wrapping to 00:00:00, hiding
 *    the fact that it overran.
 */
import {
  PLAYBACK_RATES, nextRate, rateLabel,
  summariseRanges, seekTo, stepBy, nextGapEdge, clockText,
} from "../dist/playback.js";
import { check, eq, same, report } from "./_assert.mjs";

console.log("playback");

const r = (startS, endS) => ({ startS, endS });
const spans = (summary) => summary.ranges.map((x) => [x.startS, x.endS]);

/* ---------------------------- speed ---------------------------- */

check("the speeds are a fixed ladder the UI can draw", () => {
  eq([...PLAYBACK_RATES], [0.25, 0.5, 1, 2, 4, 8], "in order, slowest first");
});

check("the speed control clamps at both ends instead of wrapping", () => {
  // Wrapping from 8x to 0.25x on one press too many looks exactly like the
  // picture freezing, and the operator concludes the recording is broken.
  eq(nextRate(8, 1), 8, "already at the top");
  eq(nextRate(0.25, -1), 0.25, "already at the bottom");
  eq(nextRate(1, 1), 2, "up one");
  eq(nextRate(1, -1), 0.5, "down one");
  eq(nextRate(4, 1), 8, "up to the top");
});

check("an unrecognised speed snaps to the nearest listed one and stays put", () => {
  // 3 is equidistant from 2 and 4. The tie goes to the SLOWER: arriving
  // slower than expected is visible on screen and one press fixes it, where
  // arriving faster reads as dropped frames and sends the operator looking
  // for a fault in the recording.
  eq(nextRate(3, 1), 2, "a tie resolves downwards");
  eq(nextRate(3, -1), 2, "and the direction does not move it -- it was not on the ladder");
  eq(nextRate(0.3, 1), 0.25, "0.3 is nearest 0.25");
  eq(nextRate(100, -1), 8, "beyond the top snaps to the top");
});

check("a speed reads as a button label, not a measurement", () => {
  eq(rateLabel(1), "1x", "not 1.0x");
  eq(rateLabel(0.5), "0.5x", "");
  eq(rateLabel(0.25), "0.25x", "");
  eq(rateLabel(8), "8x", "");
  eq(rateLabel(2), "2x", "");
});

/* -------------------------- the ranges -------------------------- */

check("ranges that touch are one recording, not sixty", () => {
  // The recorder seals every 60s. Drawing each sealed file as its own chunk
  // makes a continuous hour look full of gaps that do not exist.
  const sealed = Array.from({ length: 60 }, (_, i) => r(i * 60, (i + 1) * 60));
  const s = summariseRanges(sealed);
  eq(s.ranges.length, 1, "one unbroken hour");
  eq(spans(s), [[0, 3600]], "from the first to the last");
  eq(s.recordedS, 3600, "an hour of footage");
});

check("a real gap survives, because the gap is what the operator came for", () => {
  const s = summariseRanges([r(0, 600), r(900, 1200)]);
  eq(spans(s), [[0, 600], [900, 1200]], "two chunks, five minutes missing between them");
  eq(s.recordedS, 900, "and only the recorded seconds are counted");
  eq(s.firstS, 0, "");
  eq(s.lastS, 1200, "");
});

check("overlapping ranges merge without double-counting the overlap", () => {
  const s = summariseRanges([r(0, 100), r(50, 200)]);
  eq(spans(s), [[0, 200]], "one range");
  eq(s.recordedS, 200, "200s, not 250 -- an overlap is not extra footage");
});

check("the caller's ranges come back out of order and unmodified", () => {
  const input = [r(300, 400), r(0, 100)];
  const snapshot = JSON.parse(JSON.stringify(input));
  const s = summariseRanges(input);
  eq(spans(s), [[0, 100], [300, 400]], "sorted in the answer");
  same(input, snapshot, "and not sorted in the caller's array");
});

check("a zero-length or impossible range is not a recording", () => {
  const s = summariseRanges([r(100, 100), r(500, 400), r(0, 60)]);
  eq(spans(s), [[0, 60]], "only the real one survives");
  eq(s.recordedS, 60, "");
});

check("a nonsense range is dropped rather than poisoning the total", () => {
  const s = summariseRanges([r(Number.NaN, 100), r(0, Number.POSITIVE_INFINITY), r(0, 60)]);
  eq(spans(s), [[0, 60]], "the finite one");
  eq(s.recordedS, 60, "a NaN total would render as 'NaN days' on the page");
});

check("nothing recorded is null, never midnight", () => {
  const s = summariseRanges([]);
  eq(s.ranges.length, 0, "");
  eq(s.recordedS, 0, "zero seconds IS zero -- that one is a real measurement");
  eq(s.firstS, null, "but the first time is unknown, not 00:00:00");
  eq(s.lastS, null, "and so is the last");
});

/* --------------------------- seeking --------------------------- */

check("a seek into a gap lands in the gap and says so", () => {
  // THE FEARED ONE. Snapping forward to the next footage hides the gap, which
  // is the single thing the operator was looking for.
  const s = summariseRanges([r(0, 600), r(900, 1200)]);
  const hit = seekTo(s, 700);
  eq(hit.timeS, 700, "exactly where they asked");
  eq(hit.clamped, false, "it was inside the day's footage");
  eq(hit.inRecording, false, "and it honestly reports there is nothing there");
});

check("a seek outside the footage is clamped and admits it", () => {
  const s = summariseRanges([r(600, 1200)]);
  const early = seekTo(s, 0);
  eq(early.timeS, 600, "up to the first frame");
  eq(early.clamped, true, "and says it moved");
  const late = seekTo(s, 99999);
  eq(late.timeS, 1200, "down to the last");
  eq(late.clamped, true, "");
});

check("a seek with no footage at all does not pretend", () => {
  const s = summariseRanges([]);
  const hit = seekTo(s, 500);
  eq(hit.timeS, 0, "");
  eq(hit.clamped, true, "there was nowhere to go");
  eq(hit.inRecording, false, "and nothing to be inside of");
});

check("a broken number seeks to the start rather than to NaN", () => {
  const s = summariseRanges([r(600, 1200)]);
  const hit = seekTo(s, Number.NaN);
  eq(hit.timeS, 600, "the first frame");
  eq(hit.clamped, true, "and it is honest that this was not what was asked");
});

check("the boundary belongs to the range that starts there", () => {
  const s = summariseRanges([r(0, 600), r(900, 1200)]);
  eq(seekTo(s, 600).inRecording, false, "end is exclusive -- 600 is the first missing second");
  eq(seekTo(s, 900).inRecording, true, "start is inclusive");
  eq(seekTo(s, 599).inRecording, true, "");
  eq(seekTo(s, 1199).inRecording, true, "");
});

check("the ten-second buttons are a seek like any other", () => {
  const s = summariseRanges([r(0, 600)]);
  eq(stepBy(s, 100, 10).timeS, 110, "forward");
  eq(stepBy(s, 100, -10).timeS, 90, "back");
  const off = stepBy(s, 5, -10);
  eq(off.timeS, 0, "clamped at the start");
  eq(off.clamped, true, "and says so, so the button can stop flashing");
});

/* ---------------------- jumping between chunks ---------------------- */

check("jumping forward goes to the start of the next recording", () => {
  const s = summariseRanges([r(0, 600), r(900, 1200), r(1800, 2000)]);
  const hit = nextGapEdge(s, 300, 1);
  eq(hit.timeS, 900, "over the gap to the next footage");
  eq(hit.inRecording, true, "a range start is inside that range");
  eq(hit.clamped, false, "");
  eq(nextGapEdge(s, 900, 1).timeS, 1800, "strictly greater -- standing on a start moves on");
});

check("jumping back goes to the start of the recording you are standing in", () => {
  // The previous-track button on every player anyone has used: from inside a
  // track it goes to the top of THAT track, and only a second press leaves it.
  // Skipping straight to the previous chunk would make the start of the
  // current one unreachable by button, which is where an operator most often
  // wants to be.
  const s = summariseRanges([r(0, 600), r(900, 1200), r(1800, 2000)]);
  eq(nextGapEdge(s, 1850, -1).timeS, 1800, "back to the top of this chunk");
  eq(nextGapEdge(s, 1800, -1).timeS, 900, "strictly less -- a second press leaves it");
  eq(nextGapEdge(s, 900, -1).timeS, 0, "");
});

check("a jump with nowhere to go returns null, so the button can be disabled", () => {
  // A button that silently does nothing is what makes an operator press it
  // twenty times and then telephone the installer.
  const s = summariseRanges([r(0, 600)]);
  eq(nextGapEdge(s, 300, 1), null, "no later recording");
  eq(nextGapEdge(s, 0, -1), null, "standing on the only start, nothing is earlier");
  eq(nextGapEdge(summariseRanges([]), 0, 1), null, "and none at all when nothing recorded");
  eq(nextGapEdge(summariseRanges([]), 0, -1), null, "in either direction");
});

/* ---------------------------- the clock ---------------------------- */

check("a time reads as a clock", () => {
  eq(clockText(0), "00:00:00", "midnight");
  eq(clockText(3661), "01:01:01", "");
  eq(clockText(86399), "23:59:59", "the last second of the day");
  eq(clockText(59.9), "00:00:59", "floored, never rounded up to a second that has not happened");
});

check("an unknown time is not midnight", () => {
  eq(clockText(Number.NaN), "--:--:--", "");
  eq(clockText(-1), "--:--:--", "");
  eq(clockText(Number.POSITIVE_INFINITY), "--:--:--", "");
  if (clockText(Number.NaN) === clockText(0)) {
    throw new Error("a missing time must not be readable as 00:00:00");
  }
});

check("a recording that ran past midnight says so instead of wrapping", () => {
  // Wrapping to 00:00:00 hides an overrun, and an overrun is exactly when the
  // operator needs to know the recorder kept going.
  eq(clockText(86400), "24:00:00", "");
  eq(clockText(90000), "25:00:00", "");
});

report("playback");
