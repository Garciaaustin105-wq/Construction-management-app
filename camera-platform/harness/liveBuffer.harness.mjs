/** Live buffer steering (agent/ui/live-client.mjs planLiveBuffer).
 *  THE FEARED FAILURE, from the bench: the trim removed the buffered range the
 *  playhead was in, so the tile froze at 19.9 s while the socket stayed open
 *  and the status still read "live". Every check below is about the playhead
 *  keeping data under it, or being moved to where the data is. */
import {
  planLiveBuffer,
  LIVE_TARGET_LATENCY_S, LIVE_MAX_LATENCY_S, LIVE_WINDOW_S, LIVE_KEEP_BEHIND_S, LIVE_IN_RANGE_TOLERANCE_S,
} from "../agent/ui/live-client.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("liveBuffer");
const NONE = { seekTo: null, removeEnd: null };
const plan = (r, t) => planLiveBuffer(r, t);

check("constants", () => {
  eq([LIVE_TARGET_LATENCY_S, LIVE_MAX_LATENCY_S, LIVE_WINDOW_S, LIVE_KEEP_BEHIND_S, LIVE_IN_RANGE_TOLERANCE_S],
    [1, 4, 20, 10, 0.25], "constants");
});

check("THE FEARED ONE, the bench case: playhead near the end of one range - trim behind it, never through it", () => {
  eq(plan([[0, 21]], 19.9), NONE, "19.9 s past the start is not over the window, and 1.1 s back is fine");
  eq(plan([[0, 23]], 22.5), { seekTo: null, removeEnd: 12.5 }, "22.5 s past the start: keep 10 s behind the playhead");
});

check("THE FEARED ONE, what the bench froze on: playhead in the hole before the data - seek into it", () => {
  eq(plan([[20.9, 23.9]], 19.9), { seekTo: 22.9, removeEnd: null }, "seek to edge - 1");
  eq(plan([[20.9, 21.2]], 19.9), { seekTo: 20.9, removeEnd: null }, "short range: seek to its start, not before it");
});

check("THE FEARED ONE, as a property: removeEnd is always behind where the playhead will be", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 5000; i++) {
    const n = 1 + Math.floor(rnd() * 4);
    const ranges = [];
    let at = rnd() * 50;
    for (let k = 0; k < n; k++) { const s = at + rnd() * 3; const e = s + rnd() * 40; ranges.push([s, e]); at = e; }
    const t = rnd() * (at + 10);
    const r = plan(ranges, t);
    const p = r.seekTo ?? t;
    if (r.seekTo !== null && !(r.seekTo >= ranges[n - 1][0] && r.seekTo <= ranges[n - 1][1])) {
      throw new Error(`seek outside the last range: ${JSON.stringify({ ranges, t, r })}`);
    }
    if (r.removeEnd !== null) {
      if (!(r.removeEnd <= p - LIVE_KEEP_BEHIND_S + 1e-9)) throw new Error(`trim reaches the playhead: ${JSON.stringify({ ranges, t, r })}`);
      if (!(r.removeEnd > ranges[0][0])) throw new Error(`empty trim: ${JSON.stringify({ ranges, t, r })}`);
    }
    const inside = ranges.some(([s, e]) => s - LIVE_IN_RANGE_TOLERANCE_S <= p && p <= e + LIVE_IN_RANGE_TOLERANCE_S);
    if (!inside) throw new Error(`playhead left outside the buffer: ${JSON.stringify({ ranges, t, r })}`);
  }
});

check("fallen behind the live edge: more than 4 s back is pulled to edge - 1, and the trim follows the new playhead", () => {
  eq(plan([[0, 14]], 10), NONE, "exactly 4 s back: leave it");
  eq(plan([[0, 14.5]], 10), { seekTo: 13.5, removeEnd: null }, "4.5 s back: seek");
  eq(plan([[0, 30]], 10), { seekTo: 29, removeEnd: 19 }, "seek, then trim behind the seek target");
});

check("playing normally inside a short buffer: nothing to do", () => {
  eq(plan([[0, 15]], 14), NONE, "short");
  eq(plan([[0, 0.5]], 0), NONE, "startup");
  eq(plan([[0.2, 2]], 0), NONE, "first frame just after 0 is within tolerance");
});

check("several ranges: trim from the first, seek out of a hole", () => {
  eq(plan([[0, 5], [6, 30]], 29), { seekTo: null, removeEnd: 19 }, "trim spans the old hole");
  eq(plan([[0, 5], [6, 30]], 5.5), { seekTo: 29, removeEnd: 19 }, "in a hole between ranges: seek");
  eq(plan([[0, 5], [6, 8]], 5.2), NONE, "within tolerance of a range end and 2.8 s back: leave it");
});

check("playhead past the end of the data is outside: seek back to the edge", () => {
  eq(plan([[10, 20]], 25), { seekTo: 19, removeEnd: null }, "past the edge");
});

check("refusals are values, never throws", () => {
  for (const [r, t, what] of [
    [null, 1, "null ranges"], [undefined, 1, "undefined"], ["0-5", 1, "string"], [{}, 1, "object"],
    [[], 1, "empty"], [[[0]], 1, "short pair"], [[[0, 5, 6]], 1, "long pair"], [[[5, 0]], 1, "end < start"],
    [[[0, NaN]], 1, "NaN"], [[[0, Infinity]], 1, "Infinity"], [[["0", "5"]], 1, "string numbers"],
    [[[0, 5], null], 1, "null pair"], [[[0, 5]], NaN, "NaN time"], [[[0, 5]], "3", "string time"],
    [[[0, 5]], undefined, "no time"], [[[0, 5]], Infinity, "infinite time"],
  ]) {
    let got;
    try { got = plan(r, t); } catch (e) { throw new Error(`${what}: threw ${e.message}`); }
    eq(got, NONE, what);
  }
});

check("ranges are not mutated", () => {
  const r = [[0, 5], [6, 30]];
  const before = JSON.stringify(r);
  plan(r, 5.5);
  eq(JSON.stringify(r), before, "ranges");
});

report("liveBuffer");
