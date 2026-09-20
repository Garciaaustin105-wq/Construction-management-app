/**
 * D2: events -> marks on the Review timeline, and the jumps between them
 * (agent/ui/review-client.mjs).
 *
 * The bar this has to clear: a known person walked past some time in the last
 * 24 hours, and you find them in under 30 seconds without scrubbing. So:
 *
 * THE FEARED FAILURES: a marker drawn in the wrong place, so "jump there" lands
 * on empty footage and the operator stops trusting the marks; "next" skipping
 * an event, so the walk-by you are looking for is never shown; "next" returning
 * the event you are already on, so the button looks dead; an event the page
 * could not read silently vanishing, so an empty timeline means both "nothing
 * happened" and "something broke".
 */
import {
  eventMarkers,
  stepToEvent,
  markerSummary,
  seekInstantFor,
  MARKER_LEAD_MS,
} from "../agent/ui/review-client.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("event markers");

const DAY_START = "2026-09-18T00:00:00.000Z";
const DAY_END = "2026-09-19T00:00:00.000Z";

let nextId = 0;
function ev(firstUtc, lastUtc, kind = "person", extra = {}) {
  nextId += 1;
  return {
    id: `e${nextId}`,
    cameraId: "cam1",
    kind,
    firstUtc,
    lastUtc: lastUtc ?? firstUtc,
    count: 12,
    bestConfidence: 0.8,
    bestBox: { x: 0.1, y: 0.2, w: 0.2, h: 0.5 },
    bestUtc: firstUtc,
    ...extra,
  };
}

const markersOf = (events, kinds) => eventMarkers(events, DAY_START, DAY_END, kinds).markers;

check("THE FEARED ONE: a marker sits where the event happened, to the second", () => {
  const noon = ev("2026-09-18T12:00:00.000Z", "2026-09-18T12:00:06.000Z");
  const [m] = markersOf([noon]);
  eq(m.fraction, 0.5, "noon is halfway through the day");
  eq(m.atUtc, "2026-09-18T12:00:00.000Z", "the moment it started");
  eq(m.untilUtc, "2026-09-18T12:00:06.000Z", "and when it ended");
  eq(m.id, noon.id, "carries the event's id, for the strip and for seeking");
  eq(m.kind, "person", "kind");
  eq(m.count, 12, "how many sightings were folded in");
  // A quarter past six in the evening: 18.25 / 24.
  const [q] = markersOf([ev("2026-09-18T18:15:00.000Z")]);
  eq(Math.abs(q.fraction - 18.25 / 24) < 1e-12, true, `18:15 -> ${q.fraction}`);
});

check("an event that outlives the window is clamped, not hidden or drawn off the bar", () => {
  const overnight = ev("2026-09-17T23:50:00.000Z", "2026-09-18T00:10:00.000Z");
  const [m] = markersOf([overnight]);
  eq(m.fraction, 0, "it began before the window: pinned to the left edge");
  eq(m.atUtc, "2026-09-17T23:50:00.000Z", "but it still says when it really began");
  eq(m.clampedStart, true, "and says that the mark was moved");
  const late = ev("2026-09-18T23:59:00.000Z", "2026-09-19T00:30:00.000Z");
  const [n] = markersOf([late]);
  eq(n.endFraction, 1, "and the right edge is the end of the window");
  eq(n.clampedEnd, true, "flagged too");
});

check("an event outside the window is dropped, and counted as such", () => {
  const out = eventMarkers([ev("2026-09-16T12:00:00.000Z", "2026-09-16T12:00:05.000Z")], DAY_START, DAY_END);
  eq(out.markers.length, 0, "nothing drawn");
  eq(out.dropped.outsideWindow, 1, "counted");
  eq(out.dropped.unreadable, 0, "not confused with a broken one");
});

check("THE FEARED ONE: an event the page cannot read is reported, never placed at 1970", () => {
  const bad = [
    ev("not a time"),
    ev("2026-09-18T12:00:00.000Z", "2026-09-18T11:00:00.000Z"),  // ends before it starts
    { id: "x", cameraId: "cam1", kind: "person" },                // no times at all
    null,
    "nope",
    ev("2026-09-18T12:00:00.000Z", "2026-09-18T12:00:01.000Z", "unicorn"),
  ];
  const out = eventMarkers(bad, DAY_START, DAY_END);
  eq(out.markers.length, 0, "none of them drawn");
  eq(out.dropped.unreadable, bad.length, "every one counted");
  for (const m of eventMarkers([...bad, ev("2026-09-18T12:00:00.000Z")], DAY_START, DAY_END).markers) {
    eq(m.fraction >= 0 && m.fraction <= 1, true, "and the good one still lands");
  }
});

check("markers come back in time order whatever order the events arrive in", () => {
  const events = [
    ev("2026-09-18T18:00:00.000Z"),
    ev("2026-09-18T06:00:00.000Z"),
    ev("2026-09-18T12:00:00.000Z"),
  ];
  eq(markersOf(events).map((m) => m.atUtc), [
    "2026-09-18T06:00:00.000Z",
    "2026-09-18T12:00:00.000Z",
    "2026-09-18T18:00:00.000Z",
  ], "sorted");
});

check("a bad window refuses rather than drawing everything at zero", () => {
  for (const [a, b] of [[DAY_END, DAY_START], [DAY_START, DAY_START], ["nope", DAY_END], [DAY_START, null]]) {
    const out = eventMarkers([ev("2026-09-18T12:00:00.000Z")], a, b);
    eq(out.markers.length, 0, `no markers for window ${a} .. ${b}`);
    eq(out.badWindow, true, "and it says the window was the problem");
  }
});

check("the kind filter keeps only what was asked for, and says what it hid", () => {
  const events = [
    ev("2026-09-18T06:00:00.000Z", null, "person"),
    ev("2026-09-18T07:00:00.000Z", null, "vehicle"),
    ev("2026-09-18T08:00:00.000Z", null, "person"),
  ];
  eq(markersOf(events).length, 3, "no filter: all of them");
  eq(markersOf(events, ["person"]).map((m) => m.kind), ["person", "person"], "just people");
  const out = eventMarkers(events, DAY_START, DAY_END, ["person"]);
  eq(out.dropped.filteredOut, 1, "THE FEARED ONE: the hidden vehicle is counted, so the page can say 1 hidden");
  eq(markersOf(events, []).length, 0, "an empty filter shows nothing (every box unticked)");
  eq(eventMarkers(events, DAY_START, DAY_END, []).dropped.filteredOut, 3, "all three hidden");
});

check("THE FEARED ONE: next never skips an event and never returns the one you are on", () => {
  const ms = markersOf([
    ev("2026-09-18T06:00:00.000Z"),
    ev("2026-09-18T06:00:30.000Z"),
    ev("2026-09-18T12:00:00.000Z"),
  ]);
  const first = stepToEvent(ms, DAY_START, "next");
  eq(first.atUtc, "2026-09-18T06:00:00.000Z", "from the start of the day");
  eq(stepToEvent(ms, first.atUtc, "next").atUtc, "2026-09-18T06:00:30.000Z", "the very next one, half a minute later");
  eq(stepToEvent(ms, "2026-09-18T06:00:29.999Z", "next").atUtc, "2026-09-18T06:00:30.000Z", "a millisecond before it");
  eq(stepToEvent(ms, "2026-09-18T06:00:30.000Z", "next").atUtc, "2026-09-18T12:00:00.000Z", "standing exactly on one moves past it");
  eq(stepToEvent(ms, "2026-09-18T12:00:00.000Z", "next"), null, "past the last one: nothing, rather than wrapping round to the morning");
});

check("previous is the mirror of next, including standing exactly on an event", () => {
  const ms = markersOf([
    ev("2026-09-18T06:00:00.000Z"),
    ev("2026-09-18T06:00:30.000Z"),
    ev("2026-09-18T12:00:00.000Z"),
  ]);
  eq(stepToEvent(ms, DAY_END, "previous").atUtc, "2026-09-18T12:00:00.000Z", "from the end of the day");
  eq(stepToEvent(ms, "2026-09-18T12:00:00.000Z", "previous").atUtc, "2026-09-18T06:00:30.000Z", "standing on one moves back past it");
  eq(stepToEvent(ms, "2026-09-18T06:00:00.000Z", "previous"), null, "before the first one: nothing");
  eq(stepToEvent(ms, "rubbish", "previous"), null, "an unreadable moment steps nowhere");
  eq(stepToEvent([], DAY_START, "next"), null, "no markers at all");
  eq(stepToEvent(ms, DAY_START, "sideways"), null, "an unknown direction refuses");
});

check("THE FEARED ONE: two events at the same instant are both reachable, as the page actually steps", () => {
  // The page knows which marker it is sitting on, so it passes that marker's
  // own time AND id — which is how the person and the car that arrive in the
  // same second get skipped if stepping is done on the clock alone.
  const ms = markersOf([
    ev("2026-09-18T09:00:00.000Z", null, "person"),
    ev("2026-09-18T09:00:00.000Z", null, "vehicle"),
    ev("2026-09-18T10:00:00.000Z", null, "person"),
  ]);
  const a = ms[0];
  const b = stepToEvent(ms, a.atUtc, "next", a.id);
  eq(b === null, false, "standing on the first, next must not run out of events");
  eq(b.id !== a.id, true, "the other one at that instant, not the first again");
  eq(b.atUtc, a.atUtc, "same moment");
  eq(stepToEvent(ms, b.atUtc, "next", b.id).atUtc, "2026-09-18T10:00:00.000Z", "then on to ten o'clock");
  eq(stepToEvent(ms, b.atUtc, "previous", b.id).id, a.id, "and back the same way");
  eq(stepToEvent(ms, a.atUtc, "previous", a.id), null, "before the first: nothing");
  eq(stepToEvent(ms, "2026-09-18T10:00:00.000Z", "next", ms[2].id), null, "standing on the last: nothing");
  eq(stepToEvent(ms, a.atUtc, "next", "an-id-that-was-filtered-away").atUtc,
    "2026-09-18T10:00:00.000Z", "an id no longer on the bar steps by the clock instead");
});

check("an event with no usable id is unreadable: the strip and the buttons key on it", () => {
  const nameless = ev("2026-09-18T12:00:00.000Z");
  delete nameless.id;
  const blank = ev("2026-09-18T13:00:00.000Z");
  blank.id = "";
  const out = eventMarkers([nameless, blank, ev("2026-09-18T14:00:00.000Z")], DAY_START, DAY_END);
  eq(out.markers.length, 1, "only the one that can be pointed at");
  eq(out.dropped.unreadable, 2, "the other two counted");
});

check("a filter that is not a list refuses rather than quietly showing everything or nothing", () => {
  const events = [ev("2026-09-18T06:00:00.000Z", null, "person")];
  const out = eventMarkers(events, DAY_START, DAY_END, "person");
  eq(out.markers.length, 0, "nothing drawn");
  eq(out.badFilter, true, "and it says the filter was the problem");
  eq(eventMarkers(events, DAY_START, DAY_END, ["person"]).badFilter, false, "a real list is fine");
});

check("seeking refuses an unreadable window rather than throwing at the person", () => {
  const [m] = markersOf([ev("2026-09-18T12:00:00.000Z")]);
  eq(seekInstantFor(m, "rubbish", DAY_END), null, "no window");
  eq(seekInstantFor({ atUtc: "nope" }, DAY_START, DAY_END), null, "no marker time");
});

check("jumping to a marker starts a little before it, and never before the window", () => {
  eq(MARKER_LEAD_MS, 3000, "three seconds of run-up, so you see them arrive");
  const [m] = markersOf([ev("2026-09-18T12:00:00.000Z")]);
  eq(seekInstantFor(m, DAY_START, DAY_END), "2026-09-18T11:59:57.000Z", "three seconds early");
  const [early] = markersOf([ev("2026-09-18T00:00:01.000Z")]);
  eq(seekInstantFor(early, DAY_START, DAY_END), DAY_START, "clamped to the start of the window");
});

check("the summary counts what is drawn, per kind, for the filter buttons", () => {
  const events = [
    ev("2026-09-18T06:00:00.000Z", null, "person"),
    ev("2026-09-18T07:00:00.000Z", null, "vehicle"),
    ev("2026-09-18T08:00:00.000Z", null, "person"),
    ev("2026-09-18T09:00:00.000Z", null, "plate", { plate: "ABC123" }),
  ];
  eq(markerSummary(markersOf(events)), { person: 2, vehicle: 1, plate: 1, total: 4 }, "counts");
  eq(markerSummary([]), { person: 0, vehicle: 0, plate: 0, total: 0 }, "nothing is zeroes, not blanks");
});

report("event markers");
