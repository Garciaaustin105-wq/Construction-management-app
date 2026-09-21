/**
 * Choosing WHEN to cut a matched negative (contracts/negativeSampling.ts).
 *
 * Harvesting 34 crops of a parked car produced 34 pictures that all contain
 * the same porch post down the left and the same picket fence along the
 * bottom. A classifier trained on those learns "post plus fence means
 * vehicle" — the cheapest shortcut available — and scores beautifully on its
 * own camera while being worthless on any other. The cure is negatives cut
 * from the SAME rectangle at moments the thing was not there, so the only
 * difference between the two piles is the object itself.
 *
 * THE FEARED FAILURES:
 * - sampling a moment when the object WAS there and simply was not detected,
 *   which puts the thing you are training against into the negative pile and
 *   teaches the opposite of what was intended;
 * - taking every sample from one quiet minute, so the negatives share one
 *   lighting and one noise pattern and the classifier learns the time of day;
 * - quietly returning three samples when thirty were asked for.
 *
 * This module knows only when something was DETECTED. It cannot know whether
 * the object was present — a parked car is there all night whether or not the
 * detector says so. So it refuses when quiet time is thin rather than handing
 * back a pile that looks like data.
 */
import { planNegativeSamples, DEFAULT_MARGIN_MS } from "../dist/negativeSampling.js";
import { check, eq, report } from "./_assert.mjs";

console.log("negative sampling");

const T = Date.parse("2026-09-20T20:00:00.000Z");
const min = (n) => n * 60_000;
const isRefusal = (r) => r !== null && typeof r === "object" && r.ok === false;
const busy = (fromMin, toMin) => ({ startMs: T + min(fromMin), endMs: T + min(toMin) });
const plan = (opts) => planNegativeSamples({
  busy: [], availableFrom: T, availableTo: T + min(180), marginMs: DEFAULT_MARGIN_MS, count: 10, ...opts,
});

check("the margin is generous, because 'not detected' is not 'not there'", () => {
  eq(DEFAULT_MARGIN_MS, 5 * 60_000, "five minutes either side of every sighting");
});

check("with the whole window quiet, samples spread across all of it", () => {
  const r = plan({ count: 10 });
  eq(isRefusal(r), false, "planned");
  eq(r.instants.length, 10, "ten of them");
  const spanMs = r.instants[r.instants.length - 1] - r.instants[0];
  eq(spanMs > min(120), true, `spread across the window, not clustered: ${Math.round(spanMs / 60000)} min`);
  const sorted = [...r.instants].sort((a, b) => a - b);
  eq(r.instants, sorted, "in time order");
  eq(new Set(r.instants).size, 10, "and all different");
});

check("THE FEARED ONE: no sample lands near a moment the thing was detected", () => {
  // It was seen from 60 to 90 minutes in. With a five minute margin, nothing
  // between 55 and 95 may be sampled - a car detected at 60 was almost
  // certainly there at 57 too.
  const r = plan({ busy: [busy(60, 90)], count: 20 });
  eq(isRefusal(r), false, "planned");
  for (const t of r.instants) {
    const offMin = (t - T) / 60_000;
    eq(offMin < 55 || offMin > 95, true, `sample at ${offMin.toFixed(1)} min is too close to the sighting`);
  }
});

check("THE FEARED ONE: a thing detected the whole time is refused, not fudged", () => {
  // The parked car case exactly. There is no moment without it, so there are
  // no negatives to cut, and saying so is the only honest answer.
  const r = plan({ busy: [busy(0, 180)], count: 10 });
  eq(isRefusal(r), true, "refused");
  eq(r.reason, "no_quiet_time", "says why");
  eq(typeof r.message === "string" && r.message.length > 10, true, "in words a person can act on");
});

check("quiet time too thin for the margin is refused too", () => {
  // Two sightings with a six-minute hole between them: the margin eats it.
  const r = plan({ busy: [busy(0, 60), busy(66, 180)], count: 10 });
  eq(isRefusal(r), true, "refused");
  eq(r.reason, "no_quiet_time", "same reason");
});

check("fewer samples than asked for is reported, never silently returned", () => {
  // One quiet stretch, and a minimum spacing means it cannot hold thirty.
  const r = plan({ busy: [busy(0, 80), busy(95, 180)], count: 30, minSpacingMs: min(1) });
  eq(isRefusal(r), false, "it still answers");
  eq(r.instants.length < 30, true, `fewer than asked: ${r.instants.length}`);
  eq(r.asked, 30, "it remembers what was asked for");
  eq(r.shortfall, 30 - r.instants.length, "and states the shortfall plainly");
});

check("samples come from several quiet stretches, not just the biggest one", () => {
  const r = plan({ busy: [busy(30, 40), busy(80, 90), busy(130, 140)], count: 12 });
  eq(isRefusal(r), false, "planned");
  const early = r.instants.filter((t) => t < T + min(30)).length;
  const late = r.instants.filter((t) => t > T + min(140)).length;
  eq(early > 0 && late > 0, true, `drawn from both ends: ${early} early, ${late} late`);
});

check("nothing is sampled outside the footage we actually hold", () => {
  const r = plan({ availableFrom: T + min(60), availableTo: T + min(90), count: 5 });
  eq(isRefusal(r), false, "planned");
  for (const t of r.instants) {
    eq(t >= T + min(60) && t <= T + min(90), true, `sample inside the held range: ${(t - T) / 60000} min`);
  }
});

check("the same question always gives the same answer", () => {
  // No randomness: a harvest that cannot be repeated cannot be checked.
  const a = plan({ busy: [busy(40, 50)], count: 7 });
  const b = plan({ busy: [busy(40, 50)], count: 7 });
  eq(a.instants, b.instants, "identical");
});

check("rubbish in is refused, not sampled", () => {
  eq(isRefusal(planNegativeSamples(null)), true, "no options at all");
  eq(isRefusal(plan({ availableTo: T })), true, "an empty window");
  eq(isRefusal(plan({ availableTo: T - min(10) })), true, "a window that ends before it starts");
  eq(isRefusal(plan({ count: 0 })), true, "asking for none");
  eq(isRefusal(plan({ count: -3 })), true, "asking for fewer than none");
  eq(isRefusal(plan({ busy: "nope" })), true, "a busy list that is not a list");
  eq(isRefusal(plan({ busy: [{ startMs: 5 }] })), true, "a busy entry missing its end");
});

report("negative sampling");
