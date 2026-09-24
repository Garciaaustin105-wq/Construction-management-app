/**
 * Known objects: a recurring, still false detection learned once and hidden
 * automatically from then on (contracts/knownObjects.ts).
 *
 * Austin decided on 2026-09-20 that this applies with no click, so every
 * check here is a failure that would HIDE A REAL PERSON, or learn from
 * something that was never measured:
 * - THE DOORWAY: different people through one spot all day, learned as one
 *   object - then every person in that doorway disappears;
 * - THE STILL PERSON WHO WALKED IN: someone who walks up and stands exactly
 *   where the umbrella is;
 * - unknown travel read as "did not move";
 * - a busy half hour learned as furniture;
 * - a near miss, a lapsed object, a re-aimed camera, a plate;
 * - and this evening's real umbrella and the two real people at the gate.
 */
import {
  learnKnownObjects, matchKnown, lapseKnownObjects, noteMatch, checkKnownObjects, knownObjectNotice,
  resetKnownObject, answerKnownObject,
  KNOWN_IOU, KNOWN_MIN_EVENTS, KNOWN_MIN_SPAN_MS, MOVED_TRAVEL, KNOWN_LAPSE_MS, LEARN_WINDOW_MS,
  CONFIDENCE_CEILING, KNOWN_MAX_MEMBER_IDS, KNOWN_OBJECTS_VERSION,
} from "../dist/knownObjects.js";
import { FIXTURE_MIN_SIGHTINGS, FIXTURE_MIN_SPAN_MS } from "../dist/fixtures.js";
import { check, eq, close, throws, report } from "./_assert.mjs";

console.log("knownObjects");

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-22T12:00:00.000Z");
const at = (mins) => new Date(T0 + mins * 60000).toISOString();
let n = 0;
/** One finished event, still (travel 0.05) unless told otherwise. */
const ev = (mins, box, opts = {}) => ({
  id: opts.id ?? `e${++n}`,
  cameraId: opts.cameraId ?? "cam1",
  kind: opts.kind ?? "person",
  firstUtc: at(mins),
  lastUtc: at(mins + (opts.durMins ?? 0.1)),
  count: 5,
  bestConfidence: opts.confidence ?? 0.6,
  bestBox: box,
  bestUtc: at(mins),
  travel: "travel" in opts ? opts.travel : 0.05,
  finished: "finished" in opts ? opts.finished : true,
});
const FP = { cam1: "fp-cam1", cam2: "fp-cam2" };
const learn = (events, o = {}) => learnKnownObjects({
  events,
  existing: o.existing ?? [],
  nowUtc: o.nowUtc ?? at(o.nowMins ?? 300),
  fingerprints: o.fingerprints ?? FP,
  ...("ceiling" in o ? { confidenceCeiling: o.ceiling } : {}),
});
/** A spot where a thing stands; about the umbrella's size. */
const spot = { x: 0.60, y: 0.30, w: 0.09, h: 0.42 };
/** A still thing at `spot`, seen every 20 minutes for three hours. */
const stillDay = (opts = {}) => [0, 20, 40, 60, 80, 100, 120, 140, 160, 180].map((m) => ev(m, spot, opts));
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
};
/** Same size as `b`, slid right until the IoU is `target`: (w - d) / (w + d) = target. */
const slidTo = (b, target) => ({ ...b, x: b.x + (b.w * (1 - target)) / (1 + target) });
/** Every considered event must be taught-from or refused-with-a-reason, once (rule 16). */
const accounted = (out) => {
  const ids = [...out.learned.flatMap((o) => o.memberEventIds), ...out.rejected.flatMap((r) => r.eventIds)];
  eq(new Set(ids).size, ids.length, "no event is counted twice");
  eq(ids.length, out.considered, "every considered event is learned from or refused with a reason");
};
const reasons = (out) => [...new Set(out.rejected.map((r) => r.reason))].sort();

// The bench camera this evening, 2026-09-22, as stored (UTC). "U" is the
// furled patio umbrella by the fence (a false detection, 17 times); "P" is a
// real person at the gate (6:03 and 6:26 PM local). These rows predate travel,
// so none has one: below, a single-sighting row (first = last) is given travel
// 0, which is what the fold computes for one sighting, and the umbrella's
// longer rows 0.05 - an assumption, stated, that a still box stayed still.
const EVENING = [
  ["U", "2026-09-22T21:55:07.748Z", "2026-09-22T21:55:07.748Z", 0.6226, 0.69768, 0.36345, 0.09393, 0.42538],
  ["U", "2026-09-22T21:56:59.379Z", "2026-09-22T21:56:59.379Z", 0.5047, 0.69773, 0.36596, 0.08889, 0.41594],
  ["U", "2026-09-22T22:01:52.974Z", "2026-09-22T22:01:52.974Z", 0.5123, 0.69909, 0.36571, 0.08833, 0.43438],
  ["P", "2026-09-22T22:03:18.756Z", "2026-09-22T22:03:22.960Z", 0.9259, 0.18121, 0.59159, 0.18379, 0.40399],
  ["U", "2026-09-22T22:05:02.386Z", "2026-09-22T22:05:02.386Z", 0.5341, 0.69785, 0.36701, 0.09931, 0.42035],
  ["U", "2026-09-22T22:05:18.590Z", "2026-09-22T22:05:25.379Z", 0.6479, 0.69783, 0.36372, 0.08986, 0.40962],
  ["U", "2026-09-22T22:06:00.379Z", "2026-09-22T22:06:00.379Z", 0.5901, 0.69961, 0.36481, 0.07954, 0.41503],
  ["U", "2026-09-22T22:07:05.161Z", "2026-09-22T22:07:14.559Z", 0.7988, 0.69979, 0.36473, 0.08178, 0.41967],
  ["U", "2026-09-22T22:07:33.954Z", "2026-09-22T22:07:36.562Z", 0.6457, 0.7002, 0.36623, 0.08032, 0.41702],
  ["U", "2026-09-22T22:07:49.149Z", "2026-09-22T22:08:03.400Z", 0.6743, 0.69975, 0.36437, 0.09332, 0.41222],
  ["U", "2026-09-22T22:08:22.198Z", "2026-09-22T22:08:28.393Z", 0.7623, 0.70121, 0.36325, 0.07917, 0.43076],
  ["U", "2026-09-22T22:08:47.989Z", "2026-09-22T22:11:29.956Z", 0.7881, 0.69939, 0.36584, 0.08819, 0.41676],
  ["U", "2026-09-22T22:12:04.606Z", "2026-09-22T22:12:07.800Z", 0.5668, 0.70037, 0.36335, 0.08832, 0.41729],
  ["U", "2026-09-22T22:12:22.001Z", "2026-09-22T22:12:22.001Z", 0.5589, 0.69792, 0.3626, 0.09173, 0.42515],
  ["U", "2026-09-22T22:12:41.995Z", "2026-09-22T22:13:29.988Z", 0.7684, 0.6976, 0.36341, 0.09171, 0.43008],
  ["U", "2026-09-22T22:13:59.381Z", "2026-09-22T22:14:05.775Z", 0.6638, 0.69782, 0.36306, 0.0853, 0.42685],
  ["U", "2026-09-22T22:16:38.396Z", "2026-09-22T22:16:38.396Z", 0.5169, 0.69589, 0.36153, 0.08744, 0.44704],
  ["U", "2026-09-22T22:20:31.210Z", "2026-09-22T22:20:31.210Z", 0.5817, 0.69874, 0.36382, 0.08386, 0.42189],
  ["P", "2026-09-22T22:26:52.780Z", "2026-09-22T22:27:00.976Z", 0.9214, 0.23881, 0.67734, 0.13168, 0.31926],
];
const shift = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
/** The evening's rows as events, optionally shifted later by `ms`. */
const evening = (ms = 0, tag = "a") => EVENING.map(([who, first, last, conf, x, y, w, h], i) => ({
  id: `${tag}-${who}${i}`,
  cameraId: "bench",
  kind: "person",
  firstUtc: shift(first, ms),
  lastUtc: shift(last, ms),
  count: 1,
  bestConfidence: conf,
  bestBox: { x, y, w, h },
  bestUtc: shift(first, ms),
  travel: who === "P" ? null : first === last ? 0 : 0.05,
  finished: true,
  who,
}));
const BENCH = { bench: "fp-bench" };

// ------------------------------------------------------------------ the gates

check("the gates are the spec's, and the ceiling is 0.85 (Austin, 2026-09-23)", () => {
  eq(KNOWN_IOU, 0.8, "a spot, not a region");
  eq(KNOWN_MIN_EVENTS, 3, "rule 15's sample floor");
  eq(KNOWN_MIN_SPAN_MS, 2 * HOUR, "two hours of the same box");
  eq(MOVED_TRAVEL, 0.5, "half its own diagonal is 'moved'");
  eq(KNOWN_LAPSE_MS, 24 * HOUR, "a day unmatched lapses");
  eq(LEARN_WINDOW_MS, 48 * HOUR, "learning looks back two days");
  eq(CONFIDENCE_CEILING, 0.85, "between the real people measured (0.87-0.95) and the false ones (0.50-0.79)");
  eq(KNOWN_MAX_MEMBER_IDS, 500, "member ids capped");
  eq(KNOWN_OBJECTS_VERSION, 1, "stored file version");
  // groupFixtures refuses below ITS floor before this file sees a group, so
  // this file's floor must be at least as high or it would never apply.
  eq(KNOWN_MIN_EVENTS >= FIXTURE_MIN_SIGHTINGS, true, "floor at least groupFixtures's");
  eq(KNOWN_MIN_SPAN_MS >= FIXTURE_MIN_SPAN_MS, true, "span at least groupFixtures's");
});

check("a still thing at one spot for three hours is learned, once, with its numbers", () => {
  const events = stillDay().map((e, i) => ({ ...e, bestConfidence: 0.5 + i * 0.01 }));
  const nowUtc = at(200);
  const out = learn(events, { nowUtc });
  eq(out.learned.length, 1, "one object");
  const o = out.learned[0];
  eq(o.id, `cam1:person:${Date.parse(nowUtc)}`, "stable id: camera, kind, learned-at ms");
  eq(o.state, "active", "active");
  eq(o.box, spot, "the median box");
  eq(o.members, 10, "ten members");
  eq(o.matched, 0, "nothing matched yet");
  eq(o.memberEventIds, events.map((e) => e.id), "every member, oldest first");
  eq(o.sampleEventId, events[9].id, "the still is the most confident member");
  eq(o.confidenceMax, 0.59, "highest member score");
  eq(o.firstSeenUtc, at(0), "first seen");
  eq(o.lastSeenUtc, at(180.1), "last seen: the last member's END");
  eq(o.learnedAtUtc, nowUtc, "learned now");
  eq(o.lastMatchedUtc, null, "never matched, not 'matched at learning'");
  eq(o.cameraFingerprint, "fp-cam1", "the camera's fingerprint when learned");
  eq([o.lapsedAtUtc, o.lapseReason, o.answer], [null, null, null], "no lapse, no answer");
  eq(out.considered, 10, "ten considered");
  accounted(out);
  const stored = checkKnownObjects({ version: 1, objects: out.learned });
  eq(stored.ok, true, `what learning makes, the checker accepts: ${JSON.stringify(stored.errors)}`);
});

// ------------------------------------------------------------------ THE DOORWAY

check("THE DOORWAY (size): different silhouettes standing in one doorway all day are never learned", () => {
  // Worst case for travel: each of them stood still (travel 0.05). Only the
  // size guard stands between this and "hide everyone in the doorway". A
  // child, a courier, a tall adult by the lens: no two share a silhouette.
  const door = { x: 0.40, y: 0.30, w: 0.08, h: 0.30 };
  // Each silhouette is at least ~15% bigger per side than the next; two of
  // them arrive twice. (Closer builds than this are the KNOWN LIMIT below.)
  const sizes = [[0.05, 0.16], [0.06, 0.20], [0.08, 0.30], [0.11, 0.38], [0.13, 0.42], [0.15, 0.48]];
  const people = [];
  for (let i = 0; i < 12; i++) {
    const [w, h] = sizes[i % sizes.length];
    // Nobody stands on exactly the same pixel twice.
    people.push(ev(i * 60, { ...door, x: door.x + (i % 3) * 0.004, w, h }));
  }
  const out = learn(people, { nowMins: 12 * 60 });
  eq(out.learned.length, 0, `nothing learned: ${JSON.stringify(out.learned.map((o) => o.memberEventIds))}`);
  eq(reasons(out).every((r) => ["size_spread", "too_few", "not_tight"].includes(r)), true, `refused for size/shape: ${reasons(out)}`);
  accounted(out);
});

check("KNOWN LIMIT, measured and pinned: one build of person standing still at one spot, in separate events, IS learned", () => {
  // A cashier at a till, a guard at a post: something passes in front for
  // longer than the merge gap, and each new event starts with them already
  // standing, so its travel is small. Same silhouette, same spot, same
  // stillness - neither the size guard nor travel can tell that from an
  // umbrella, and boxJitter.ts (5b751c7) measured that wobble cannot either.
  // What stops it is CONFIDENCE_CEILING, set to 0.85 on 2026-09-23 because
  // of exactly this case: a still cashier scores like a real person (0.92).
  // PINNED both ways so nobody reads the doorway checks above as covering it.
  const cashier = [0, 40, 80, 125].map((m) => ev(m, spot, { confidence: 0.92, travel: 0.1 }));
  eq(learn(cashier).learned.length, 0, "the 0.85 ceiling stops it");
  eq(learn(cashier, { ceiling: null }).learned.length, 1, "without a ceiling it would be learned: the limit is real");
  // Still open under the ceiling: a still person who scores below 0.85 (far
  // away, or half hidden) at a known object's exact spot and size.
  // And the doorway guard's real resolution: two DIFFERENT people about 12%
  // apart per side (0.08 x 0.30 and 0.09 x 0.34 of the frame), each standing
  // still in the doorway twice, are learned as one thing.
  const door = { x: 0.40, y: 0.30, w: 0.08, h: 0.30 };
  const twoBuilds = [0, 60, 120, 180].map((m, i) => ev(m, i % 2 === 0 ? door : { ...door, w: 0.09, h: 0.34 }));
  eq(learn(twoBuilds, { nowMins: 200 }).learned.length, 1, "learned: similar builds are within the size guard");
});

check("THE DOORWAY (travel): same-size people walking through one doorway all day are never learned", () => {
  // The case the size guard CANNOT catch: twelve couriers of one silhouette.
  // Every one of them walked in, so every one travelled.
  const door = { x: 0.40, y: 0.30, w: 0.08, h: 0.30 };
  const people = [];
  for (let hour = 0; hour < 12; hour++) people.push(ev(hour * 60, door, { travel: 1 + (hour % 4) }));
  const out = learn(people, { nowMins: 12 * 60 });
  eq(out.learned.length, 0, "nothing learned");
  eq(reasons(out), ["moved"], "refused: moved");
  eq(out.rejected[0].eventIds.length, 12, "all twelve named");
  accounted(out);
});

check("a thing that moved even once in a group does not teach, and exactly 0.5 counts as moved", () => {
  const events = stillDay();
  events[3] = { ...events[3], travel: MOVED_TRAVEL };
  events[6] = { ...events[6], travel: 0.49 };
  const out = learn(events);
  eq(out.learned.length, 1, "the still ones still teach");
  eq(out.learned[0].memberEventIds.includes(events[3].id), false, "the one at 0.5 is not a member");
  eq(out.learned[0].memberEventIds.includes(events[6].id), true, "0.49 is still");
  eq(out.rejected.find((r) => r.reason === "moved")?.eventIds, [events[3].id], "named as moved");
  accounted(out);
});

// ------------------------------------------------------------------ THE STILL PERSON WHO WALKED IN

check("THE STILL PERSON WHO WALKED IN: travel >= 0.5 at the EXACT known box is never hidden", () => {
  const [o] = learn(stillDay()).learned;
  // Scored under the 0.85 ceiling, so travel alone decides here.
  const person = (travel) => ({ cameraId: "cam1", kind: "person", bestBox: { ...spot }, bestConfidence: 0.7, travel });
  eq(matchKnown(person(0.05), [o]), o.id, "control: a still thing on the box is hidden");
  eq(matchKnown(person(0.49), [o]), o.id, "just under the line is still");
  eq(matchKnown(person(0.5), [o]), null, "exactly 0.5 travelled: shown");
  eq(matchKnown(person(3.2), [o]), null, "walked across the yard and stood there: shown");
  eq(matchKnown(person(Infinity), [o]), null, "a travel that is not finite is not 'still'");
});

// ------------------------------------------------------------------ unknown travel

check("unknown travel is never learned from and never hidden (a blank is not a zero)", () => {
  for (const [label, travel] of [["null", null], ["NaN", NaN], ["negative", -0.1], ["a string", "0.1"]]) {
    const out = learn(stillDay({ travel }));
    eq(out.learned.length, 0, `${label}: nothing learned`);
    eq(reasons(out), ["travel_unknown"], `${label}: refused as travel_unknown`);
    accounted(out);
  }
  // An old row with no travel field at all - every event stored before today.
  const absent = stillDay().map(({ travel, ...rest }) => rest);
  const out = learn(absent);
  eq(out.learned.length, 0, "absent travel: nothing learned");
  eq(reasons(out), ["travel_unknown"], "absent travel: travel_unknown");

  const [o] = learn(stillDay()).learned;
  const base = { cameraId: "cam1", kind: "person", bestBox: { ...spot }, bestConfidence: 0.6 };
  eq(matchKnown({ ...base, travel: null }, [o]), null, "null travel: shown");
  eq(matchKnown({ ...base }, [o]), null, "absent travel: shown");
  eq(matchKnown({ ...base, travel: NaN }, [o]), null, "NaN travel: shown");
  eq(matchKnown({ ...base, travel: 0 }, [o]), o.id, "control: a measured 0 is hidden");
});

// ------------------------------------------------------------------ the span

check("17 events in 25 minutes (this evening's umbrella) are NOT learned", () => {
  const events = evening();
  const out = learnKnownObjects({ events, existing: [], nowUtc: "2026-09-22T22:30:00.000Z", fingerprints: BENCH });
  eq(out.learned.length, 0, "nothing learned from half an hour");
  const umbrella = out.rejected.find((r) => r.eventIds.includes("a-U0"));
  eq(umbrella?.reason, "too_brief", "the umbrella's group: too brief");
  eq(umbrella?.eventIds.length, 17, "all 17 in it");
  const people = out.rejected.filter((r) => r.eventIds.some((id) => id.includes("-P")));
  eq(people.map((r) => r.reason), ["travel_unknown"], "the two people: their travel was never measured");
  accounted(out);
});

check("the same 17 sightings over 90 minutes are still not learned; at exactly 2 hours they are", () => {
  const spread = (spanMins) => Array.from({ length: 17 }, (_, i) => ev((i * spanMins) / 16, spot, { durMins: 0 }));
  const ninety = learn(spread(90), { nowMins: 200 });
  eq(ninety.learned.length, 0, "90 minutes: groupFixtures would take it, the 2-hour floor does not");
  eq(reasons(ninety), ["too_brief"], "too_brief");
  const justShort = spread(120);
  justShort[16] = { ...justShort[16], lastUtc: new Date(Date.parse(justShort[0].firstUtc) + 2 * HOUR - 1).toISOString(),
    firstUtc: new Date(Date.parse(justShort[0].firstUtc) + 2 * HOUR - 1).toISOString() };
  eq(learn(justShort, { nowMins: 200 }).learned.length, 0, "one millisecond short of two hours: not learned");
  eq(learn(spread(120), { nowMins: 200 }).learned.length, 1, "exactly two hours: learned");
});

// ------------------------------------------------------------------ the real evening

check("THIS EVENING: the umbrella's real boxes and scores learn once they span two hours", () => {
  // The same 17 boxes and scores two hours later: the umbrella still there,
  // firing the same way. Only the times are shifted; no box is touched.
  const first = evening(0, "a");
  const later = evening(2 * HOUR, "b");
  const events = [...first, ...later];
  const out = learnKnownObjects({ events, existing: [], nowUtc: "2026-09-23T00:30:00.000Z", fingerprints: BENCH });
  eq(out.learned.length, 1, `the umbrella is learned: ${JSON.stringify(out.rejected.map((r) => [r.reason, r.eventIds.length]))}`);
  const o = out.learned[0];
  eq(o.members, 34, "all 34 umbrella rows - none dropped as not tight");
  eq(o.memberEventIds.every((id) => id.includes("-U")), true, "no real person among the members");
  close(o.box.h, 0.42, 0.01, "about 42% of the frame's height");
  close(o.box.x, 0.698, 0.002, "by the fence");
  eq(o.confidenceMax, 0.7988, "highest real score (above the 0.65 people remember)");
  eq(o.sampleEventId, "a-U7", "the still is the 0.7988 row, the earlier of the two");
  for (const m of events.filter((e) => e.who === "U")) {
    eq(iou(m.bestBox, o.box) >= KNOWN_IOU, true, `${m.id} sits on the learned box (IoU ${iou(m.bestBox, o.box).toFixed(3)})`);
  }

  // Every umbrella row, as it arrives, is hidden...
  for (const m of events.filter((e) => e.who === "U")) eq(matchKnown(m, [o]), o.id, `${m.id} hidden`);
  // ...and the two real people at the gate are not - even if they had stood
  // perfectly still (travel 0), because their boxes are elsewhere.
  for (const p of events.filter((e) => e.who === "P")) {
    eq(matchKnown({ ...p, travel: 0 }, [o]), null, `${p.id} (a real person at the gate) shown`);
  }
  // A real person standing right beside the umbrella is shown too.
  const beside = { x: o.box.x - o.box.w * 0.9, y: o.box.y, w: o.box.w * 1.1, h: o.box.h };
  eq(matchKnown({ cameraId: "bench", kind: "person", bestBox: beside, bestConfidence: 0.55, travel: 0 }, [o]), null, "a person beside it: shown");
  accounted(out);
});

// ------------------------------------------------------------------ tight geometry

check("a loose match is never hidden: IoU 0.7 and 0.79 shown, 0.81 hidden", () => {
  const [o] = learn(stillDay()).learned;
  const at_ = (target) => ({ cameraId: "cam1", kind: "person", bestBox: slidTo(o.box, target), bestConfidence: 0.6, travel: 0 });
  close(iou(at_(0.7).bestBox, o.box), 0.7, 1e-9, "the test box really is IoU 0.7");
  eq(matchKnown(at_(0.7), [o]), null, "IoU 0.7: shown");
  eq(matchKnown(at_(0.79), [o]), null, "IoU 0.79: shown");
  eq(matchKnown(at_(0.81), [o]), o.id, "IoU 0.81: hidden");
});

check("a group member not within 0.8 of the median box is dropped (not_tight), and the rest still teach", () => {
  const events = stillDay();
  // Close enough for groupFixtures (0.6) to put it in the group, too loose to teach.
  const loose = ev(90, slidTo(spot, 0.7));
  const out = learn([...events, loose]);
  eq(out.learned.length, 1, "the tight ten teach");
  eq(out.learned[0].memberEventIds.includes(loose.id), false, "the loose one is not a member");
  eq(out.rejected.find((r) => r.reason === "not_tight")?.eventIds, [loose.id], "named: not_tight");
  accounted(out);
});

check("if dropping the loose members leaves too few, nothing is learned", () => {
  const events = [ev(0, spot), ev(150, spot), ev(60, slidTo(spot, 0.7)), ev(90, slidTo(spot, 0.72)), ev(120, slidTo(spot, 0.65))];
  const out = learn(events);
  eq(out.learned.length, 0, "nothing learned");
  eq(out.learned.every((o) => o.members >= KNOWN_MIN_EVENTS), true, "and never below the floor");
  accounted(out);
});

// ------------------------------------------------------------------ lapsing

check("a lapsed object never matches, whatever the geometry", () => {
  const [o] = learn(stillDay()).learned;
  const event = { cameraId: "cam1", kind: "person", bestBox: { ...spot }, bestConfidence: 0.6, travel: 0 };
  eq(matchKnown(event, [o]), o.id, "control: active, hidden");
  for (const lapsed of [
    lapseKnownObjects([o], at(180.1 + 24 * 60), FP)[0],
    lapseKnownObjects([o], at(200), { ...FP, cam1: "re-aimed" })[0],
    resetKnownObject(o, at(200)),
  ]) {
    eq(lapsed.state, "lapsed", `lapsed (${lapsed.lapseReason})`);
    eq(matchKnown(event, [lapsed]), null, `${lapsed.lapseReason}: shown`);
  }
});

check("a fingerprint change lapses that camera only; a camera not in the config is left alone", () => {
  const objs = [
    ...learn(stillDay({ cameraId: "cam1" })).learned,
    ...learn(stillDay({ cameraId: "cam2" })).learned,
    ...learn(stillDay({ cameraId: "cam3" }), { fingerprints: { ...FP, cam3: "fp-cam3" } }).learned,
  ];
  eq(objs.length, 3, "three cameras, one object each");
  const now = at(190);
  const out = lapseKnownObjects(objs, now, { cam1: "fp-cam1-new", cam2: "fp-cam2" });
  eq(out.map((o) => [o.cameraId, o.state, o.lapseReason]), [
    ["cam1", "lapsed", "camera_changed"],
    ["cam2", "active", null],
    ["cam3", "active", null],
  ], "only cam1 lapsed");
  eq(out[0].lapsedAtUtc, now, "lapsed now");
  eq(out[1] === objs[1] && out[2] === objs[2], true, "unchanged objects come back as they were");
  eq(objs[0].state, "active", "the input is not changed");
  // cam3 is not watched: even two days unmatched is not "unseen".
  const later = lapseKnownObjects(objs, at(180 + 48 * 60), { cam1: "fp-cam1", cam2: "fp-cam2" });
  eq(later[2].state, "active", "not watched is not changed");
  eq(later[1].lapseReason, "unseen", "while a watched camera's object does lapse");
});

check("unseen lapses at 24 h from the last match, else the last sighting", () => {
  const [o] = learn(stillDay()).learned;
  const lastSeen = Date.parse(o.lastSeenUtc);
  const iso = (ms) => new Date(ms).toISOString();
  eq(lapseKnownObjects([o], iso(lastSeen + KNOWN_LAPSE_MS - 1), FP)[0].state, "active", "a millisecond short: active");
  const lapsed = lapseKnownObjects([o], iso(lastSeen + KNOWN_LAPSE_MS), FP)[0];
  eq([lapsed.state, lapsed.lapseReason], ["lapsed", "unseen"], "24 h: lapsed, unseen");
  const noted = noteMatch(o, { cameraId: "cam1", kind: "person", bestBox: spot, bestConfidence: 0.6, travel: 0 }, iso(lastSeen + 20 * HOUR));
  eq(lapseKnownObjects([noted], iso(lastSeen + 30 * HOUR), FP)[0].state, "active", "a match 20 h in keeps it for another day");
  eq(lapseKnownObjects([noted], iso(lastSeen + 44 * HOUR), FP)[0].lapseReason, "unseen", "until that day passes");
  const first = lapseKnownObjects([o], iso(lastSeen + 25 * HOUR), { cam1: "changed" })[0];
  eq(lapseKnownObjects([first], iso(lastSeen + 50 * HOUR), FP)[0].lapseReason, "camera_changed", "a lapse's first reason stands");
});

check("nothing is learned only to lapse on the next pass (stale)", () => {
  const events = stillDay();
  const lastEnd = Date.parse(events[9].lastUtc);
  const iso = (ms) => new Date(ms).toISOString();
  const fresh = learn(events, { nowUtc: iso(lastEnd + KNOWN_LAPSE_MS - 1) });
  eq(fresh.learned.length, 1, "a millisecond inside the day: learned");
  eq(lapseKnownObjects(fresh.learned, iso(lastEnd + KNOWN_LAPSE_MS - 1), FP)[0].state, "active", "and not lapsed by the same now");
  const stale = learn(events, { nowUtc: iso(lastEnd + KNOWN_LAPSE_MS) });
  eq(stale.learned.length, 0, "a full day since the last sighting: not learned");
  eq(reasons(stale), ["stale"], "named: stale");
});

check("a reset by hand is not undone by the next pass; new evidence after it can teach again", () => {
  const events = stillDay();
  const [o] = learn(events, { nowMins: 200 }).learned;
  const reset = resetKnownObject(o, at(210));
  eq([reset.state, reset.lapseReason, reset.lapsedAtUtc], ["lapsed", "reset_by_hand", at(210)], "reset");
  const again = learn(events, { existing: [reset], nowMins: 220 });
  eq(again.learned.length, 0, "the same evidence does not teach it back ten minutes later");
  eq(reasons(again), ["before_lapse"], "named: before_lapse");
  const after = [0, 60, 125].map((m) => ev(215 + m, spot));
  const relearn = learn([...events, ...after], { existing: [reset], nowMins: 400 });
  eq(relearn.learned.length, 1, "three new sightings over two hours after the reset: learned again");
  eq(relearn.learned[0].memberEventIds, after.map((e) => e.id), "from the new evidence only");
  eq(relearn.learned[0].id === o.id, false, "a new object, not the old one revived");
  accounted(relearn);
});

check("after a re-aim, nothing that camera saw before is learned from; the other camera is untouched", () => {
  const cam1 = stillDay({ cameraId: "cam1" });
  const [o] = learn(cam1, { nowMins: 200 }).learned;
  const [changed] = lapseKnownObjects([o], at(205), { cam1: "re-aimed", cam2: "fp-cam2" });
  eq(changed.lapseReason, "camera_changed", "lapsed by the re-aim");
  // Another spot on cam1, seen before the re-aim, and a thing on cam2.
  const elsewhere = [0, 60, 130].map((m) => ev(m, { x: 0.1, y: 0.1, w: 0.1, h: 0.2 }, { cameraId: "cam1" }));
  const cam2 = stillDay({ cameraId: "cam2" });
  const out = learn([...cam1, ...elsewhere, ...cam2], { existing: [changed], nowMins: 210, fingerprints: { cam1: "re-aimed", cam2: "fp-cam2" } });
  eq(out.learned.map((l) => l.cameraId), ["cam2"], "only cam2 learns");
  eq(out.rejected.filter((r) => r.cameraId === "cam1").map((r) => r.reason), ["before_lapse"], "cam1's old views: before_lapse");
  accounted(out);
});

// ------------------------------------------------------------------ plates, scope, known

check("a plate is never learned and never matched", () => {
  const plates = stillDay({ kind: "plate" });
  const out = learn(plates);
  eq(out.learned.length, 0, "no plate object");
  eq(out.considered, 0, "plates are not even considered");
  const [o] = learn(stillDay()).learned;
  const plateEvent = { cameraId: "cam1", kind: "plate", bestBox: { ...spot }, bestConfidence: 0.6, travel: 0 };
  eq(matchKnown(plateEvent, [o]), null, "a plate on a person object's box: shown");
  const plateObj = { ...o, kind: "plate" };
  eq(matchKnown(plateEvent, [plateObj]), null, "even against a hand-made plate object");
  eq(checkKnownObjects({ version: 1, objects: [plateObj] }).ok, false, "and the checker refuses a plate object");
});

check("scope: unfinished and out-of-window events are not considered", () => {
  const events = stillDay({ finished: false });
  eq(learn(events).considered, 0, "open events: an open event may still walk away");
  const noFlag = stillDay().map(({ finished, ...rest }) => rest);
  eq(learn(noFlag).considered, 0, "no finished flag is not 'finished'");
  const old = stillDay();
  const lastEnd = Date.parse(old[9].lastUtc);
  eq(learn(old, { nowUtc: new Date(lastEnd + LEARN_WINDOW_MS + 1).toISOString() }).considered, 0, "past the window: not considered");
  eq(learn(old, { nowUtc: new Date(Date.parse(old[0].lastUtc) + LEARN_WINDOW_MS).toISOString() }).considered, 10, "the window's edge is in");
});

check("already known is matched, not learned twice", () => {
  const events = stillDay();
  const [o] = learn(events, { nowMins: 200 }).learned;
  const more = [200, 260, 330].map((m) => ev(m, spot));
  const out = learn([...events, ...more], { existing: [o], nowMins: 340 });
  eq(out.learned.length, 0, "no second object");
  eq(reasons(out), ["already_known"], "named: already_known");
  accounted(out);
  // A group whose events EACH miss the object (IoU ~0.70) but whose median
  // box sits on it (IoU 0.81) is also already known: no near-duplicate object.
  const mid = slidTo(spot, 0.81);
  const dy = (spot.h * 0.15) / 1.85; // a pure vertical slide of IoU 0.85
  const up = { ...mid, y: mid.y - dy };
  const down = { ...mid, y: mid.y + dy };
  eq(iou(up, spot) < KNOWN_IOU && iou(down, spot) < KNOWN_IOU, true, "each member misses the object");
  // An even split, so the median's y lands between them, on the object.
  const straddle = [ev(400, up), ev(460, down), ev(530, up), ev(600, down)];
  const out2 = learn(straddle, { existing: [o], nowMins: 650 });
  eq(out2.learned.length, 0, "no near-duplicate object on the same spot");
  eq(reasons(out2), ["already_known"], "refused at the group: already_known");
  // Events on the known spot, interleaved with a new thing beside it (IoU 0.7:
  // a different spot). The known ones are named as known, not lost as "not
  // tight", and the new thing is its own object.
  const beside = slidTo(spot, 0.7);
  const mixed = [ev(700, spot), ev(710, beside), ev(760, beside), ev(800, spot), ev(830, beside), ev(900, beside)];
  const out3 = learn(mixed, { existing: [o], nowMins: 910 });
  eq(out3.rejected.find((r) => r.reason === "already_known")?.eventIds, [mixed[0].id, mixed[3].id], "the known spot's events: already_known");
  eq(out3.learned.map((l) => l.memberEventIds.length), [4], "the thing beside it is its own object");
  accounted(out3);
});

check("a camera with no fingerprint learns nothing (a re-aim could never be noticed)", () => {
  const out = learn(stillDay({ cameraId: "cam9" }));
  eq(out.learned.length, 0, "nothing learned");
  eq(reasons(out), ["no_fingerprint"], "named: no_fingerprint");
});

// ------------------------------------------------------------------ the ceiling's place

check("the confidence ceiling: 0.85 by default, honoured when passed, refused when junk", () => {
  const [o] = learn(stillDay()).learned;
  const strong = { cameraId: "cam1", kind: "person", bestBox: { ...spot }, bestConfidence: 0.99, travel: 0 };
  eq(matchKnown(strong, [o]), null, "by default 0.99 on the spot is shown: above the 0.85 ceiling");
  eq(matchKnown({ ...strong, bestConfidence: 0.85 }, [o]), o.id, "0.85 itself is hidden (only above it is shown)");
  eq(matchKnown(strong, [o], { confidenceCeiling: null }), o.id, "with no ceiling passed as null, 0.99 would be hidden");
  eq(matchKnown(strong, [o], { confidenceCeiling: 0.7 }), null, "set at 0.7: 0.99 shown");
  eq(matchKnown({ ...strong, bestConfidence: 0.7 }, [o], { confidenceCeiling: 0.7 }), o.id, "at the ceiling: hidden (above it is shown)");
  const loud = learn(stillDay({ confidence: 0.9 }), { ceiling: 0.7 });
  eq([loud.learned.length, reasons(loud)], [0, ["above_ceiling"]], "learning honours it too");
  for (const bad of [0, 1.5, -1, NaN, "0.7"]) {
    throws(() => matchKnown(strong, [o], { confidenceCeiling: bad }), `matchKnown ceiling ${String(bad)}`);
    throws(() => learn(stillDay(), { ceiling: bad }), `learn ceiling ${String(bad)}`);
  }
});

// ------------------------------------------------------------------ matching order

check("two objects match: the higher IoU wins; on a tie, the older one, whatever the order", () => {
  const [a] = learn(stillDay(), { nowMins: 200 }).learned;
  const b = { ...a, id: "cam1:person:later", learnedAtUtc: at(300), box: { ...spot } };
  const event = { cameraId: "cam1", kind: "person", bestBox: { ...spot }, bestConfidence: 0.6, travel: 0 };
  eq(matchKnown(event, [a, b]), a.id, "tie: older");
  eq(matchKnown(event, [b, a]), a.id, "tie: older, in either order");
  const nearer = { ...b, box: slidTo(spot, 0.9) };
  const onNearer = { ...event, bestBox: slidTo(spot, 0.9) };
  eq(matchKnown(onNearer, [a, nearer]), nearer.id, "higher IoU beats older");
  eq(matchKnown({ ...event, cameraId: "cam2" }, [a]), null, "another camera: shown");
  eq(matchKnown({ ...event, kind: "vehicle" }, [a]), null, "another kind: shown");
  eq(matchKnown(null, [a]), null, "junk event: shown, not a crash");
  eq(matchKnown({ ...event, bestBox: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } }, [a]), null, "a box off the frame: shown");
});

// ------------------------------------------------------------------ determinism and ids

check("the caller's order does not change what is learned", () => {
  const events = [...stillDay(), ...stillDay({ cameraId: "cam2" }), ev(50, slidTo(spot, 0.7))];
  const a = learn(events);
  const b = learn([...events].reverse());
  eq(b.learned, a.learned, "same objects");
  eq(b.considered, a.considered, "same count");
});

check("two objects of one camera and kind learned together get different ids", () => {
  const other = { x: 0.1, y: 0.1, w: 0.1, h: 0.2 };
  const out = learn([...stillDay(), ...[0, 60, 130].map((m) => ev(m, other))]);
  eq(out.learned.length, 2, "two objects");
  eq(new Set(out.learned.map((o) => o.id)).size, 2, "two ids");
  // Learned in the same millisecond as an object already in the store.
  const base = `cam1:person:${Date.parse(at(300))}`;
  const stored = { ...out.learned.find((o) => o.box.x === other.x), id: base };
  const clash = learn(stillDay(), { existing: [stored], nowMins: 300 });
  eq(clash.learned.map((o) => o.id), [`${base}-2`], "never an id already in the store");
  eq(checkKnownObjects({ version: 1, objects: out.learned }).ok, true, "the pair is a valid file");
});

check("member ids are capped at 500, oldest dropped, and the notice says so", () => {
  const many = Array.from({ length: 600 }, (_, i) => ev(i * 0.3, spot, { durMins: 0 }));
  const [o] = learn(many, { nowMins: 200 }).learned;
  eq(o.members, 600, "the true count");
  eq(o.memberEventIds.length, 500, "500 ids");
  eq(o.memberEventIds[0], many[100].id, "the oldest 100 dropped");
  eq(checkKnownObjects({ version: 1, objects: [o] }).ok, true, "valid");
  eq(knownObjectNotice(o)[1].includes("the 500 most recent of the 600 sightings"), true, knownObjectNotice(o)[1]);
});

// ------------------------------------------------------------------ noteMatch

check("noteMatch counts the match and widens the seen range, without changing its argument", () => {
  const [o] = learn(stillDay(), { nowMins: 200 }).learned;
  const event = { cameraId: "cam1", kind: "person", bestBox: spot, bestConfidence: 0.6, travel: 0, firstUtc: at(250), lastUtc: at(252) };
  const noted = noteMatch(o, event, at(253));
  eq([noted.matched, noted.lastMatchedUtc, noted.lastSeenUtc], [1, at(253), at(252)], "matched, when, and seen");
  eq(noted.firstSeenUtc, o.firstSeenUtc, "first seen unchanged");
  eq([o.matched, o.lastMatchedUtc], [0, null], "argument unchanged");
  const bare = noteMatch(noted, { cameraId: "cam1", kind: "person", bestBox: spot, bestConfidence: 0.6, travel: 0 }, at(260));
  eq([bare.matched, bare.lastSeenUtc], [2, at(252)], "an event with no times widens nothing (a blank is not now)");
  throws(() => noteMatch(o, { ...event, cameraId: "cam2" }, at(253)), "another camera");
  throws(() => noteMatch(o, { ...event, kind: "vehicle" }, at(253)), "another kind");
  throws(() => noteMatch(o, event, "not a time"), "a bad now");
  eq(checkKnownObjects({ version: 1, objects: [bare] }).ok, true, "still a valid object");
});

check("noteMatch moves sampleEventId to the event it just hid, only when it carries a real id", () => {
  const [o] = learn(stillDay(), { nowMins: 200 }).learned;
  const original = o.sampleEventId;
  const withId = { cameraId: "cam1", kind: "person", bestBox: spot, bestConfidence: 0.6, travel: 0, id: "hidden-event-7" };
  const noted = noteMatch(o, withId, at(253));
  eq(noted.sampleEventId, "hidden-event-7", "sample moves to the event's own events.db id");
  eq(o.sampleEventId, original, "the argument object is not mutated");

  // A missing id, or a blank one, is not a value (build rule 5): the sample
  // stays exactly where it was - the newest hide with a real id wins, not the
  // freshest hide of any kind.
  const noId = { cameraId: "cam1", kind: "person", bestBox: spot, bestConfidence: 0.6, travel: 0 };
  eq(noteMatch(noted, noId, at(260)).sampleEventId, "hidden-event-7", "missing id leaves sampleEventId unchanged");
  const blankId = { ...noId, id: "" };
  eq(noteMatch(noted, blankId, at(261)).sampleEventId, "hidden-event-7", "blank id leaves sampleEventId unchanged");

  // A later real id still moves it, and the object it started from is untouched.
  const again = noteMatch(noted, { ...withId, id: "hidden-event-9" }, at(262));
  eq(again.sampleEventId, "hidden-event-9", "a later id moves the sample again");
  eq(noted.sampleEventId, "hidden-event-7", "the previous object is not mutated");
  eq(checkKnownObjects({ version: 1, objects: [again] }).ok, true, "still a valid object");
});

// ------------------------------------------------------------------ the stored file

check("the checker accepts what this module makes, at every stage", () => {
  const [o] = learn(stillDay(), { nowMins: 200 }).learned;
  const answered = answerKnownObject(o, { belongs: false, by: "austin" }, at(230));
  const noted = noteMatch(answered, { cameraId: "cam1", kind: "person", bestBox: spot, bestConfidence: 0.6, travel: 0 }, at(240));
  const lapsed = lapseKnownObjects([{ ...noted, id: "x2" }], at(240), { cam1: "new" })[0];
  const reset = resetKnownObject({ ...o, id: "x3" }, at(240));
  const file = { version: 1, objects: [o, { ...answered, id: "x1" }, noted.id === o.id ? { ...noted, id: "x4" } : noted, lapsed, reset] };
  const out = checkKnownObjects(JSON.parse(JSON.stringify(file)));
  eq(out.ok, true, `accepted: ${JSON.stringify(out.errors)}`);
  eq(out.objects.length, 5, "all five");
  out.objects[0].box.x = 0.99;
  eq(file.objects[0].box.x, spot.x, "fresh copies: editing the result does not edit the input");
});

check("a file that cannot be trusted is refused WHOLE, and the checker never throws", () => {
  const [o] = learn(stillDay(), { nowMins: 200 }).learned;
  const good = JSON.parse(JSON.stringify(o));
  const bad = (what, file) => {
    const out = checkKnownObjects(file);
    eq(out.ok, false, `refused: ${what}`);
    eq(Array.isArray(out.errors) && out.errors.length > 0, true, `with a reason: ${what}`);
  };
  const withObj = (patch) => ({ version: 1, objects: [good, { ...good, id: "other", ...patch }] });
  bad("not an object", null);
  bad("an array", []);
  bad("version 2", { version: 2, objects: [] });
  bad("no objects", { version: 1 });
  bad("an unknown top-level key", { version: 1, objects: [], extra: 1 });
  bad("a duplicate id", { version: 1, objects: [good, good] });
  bad("an unknown key (a typo loses data)", withObj({ lapsedReason: "unseen" }));
  const missing = { ...good, id: "other" };
  delete missing.cameraFingerprint;
  bad("a missing key", { version: 1, objects: [good, missing] });
  bad("a box off the frame", withObj({ box: { x: 0.9, y: 0.1, w: 0.3, h: 0.2 } }));
  bad("a box with no extent", withObj({ box: { x: 0.1, y: 0.1, w: 0, h: 0.2 } }));
  bad("a plate", withObj({ kind: "plate" }));
  bad("active with a lapse reason", withObj({ lapseReason: "unseen" }));
  bad("lapsed with no reason", withObj({ state: "lapsed", lapsedAtUtc: at(1) }));
  bad("lapsed with an unknown reason", withObj({ state: "lapsed", lapsedAtUtc: at(1), lapseReason: "bored" }));
  bad("a time that is not ISO UTC", withObj({ learnedAtUtc: "yesterday" }));
  bad("a local time", withObj({ learnedAtUtc: "2026-09-22T18:00:00" }));
  bad("last seen before first", withObj({ lastSeenUtc: "2020-01-01T00:00:00.000Z" }));
  bad("members below the listed ids", withObj({ members: 2 }));
  bad("a fractional count", withObj({ matched: 1.5 }));
  bad("a score over 1", withObj({ confidenceMax: 7 }));
  bad("no member ids", withObj({ memberEventIds: [] }));
  bad("a blank fingerprint", withObj({ cameraFingerprint: "" }));
  bad("an answer with no one", withObj({ answer: { belongs: true, atUtc: at(1), by: " " } }));
  bad("an answer with an extra key", withObj({ answer: { belongs: true, atUtc: at(1), by: "a", note: "x" } }));
  bad("an answer that is not yes or no", withObj({ answer: { belongs: "yes", atUtc: at(1), by: "a" } }));
  bad("a getter that throws", { version: 1, get objects() { throw new Error("boom"); } });
  eq(checkKnownObjects({ version: 1, objects: [] }).ok, true, "an empty store is fine");
});

check("the other functions refuse junk loudly rather than guess", () => {
  const [o] = learn(stillDay(), { nowMins: 200 }).learned;
  throws(() => learn([{ ...stillDay()[0], bestBox: null }]), "an unreadable event");
  const twin = ev(0, spot);
  throws(() => learn([twin, { ...twin }]), "two events with one id");
  throws(() => learn(stillDay(), { nowUtc: "soon" }), "a bad now");
  throws(() => learn(stillDay(), { fingerprints: { cam1: "" } }), "a blank fingerprint");
  throws(() => learn(stillDay(), { existing: [{ ...o, state: "gone" }] }), "an unreadable existing object");
  throws(() => lapseKnownObjects([o], "soon", FP), "lapse: a bad now");
  throws(() => answerKnownObject(o, { belongs: "yes", by: "a" }, at(1)), "answer: not yes or no");
  throws(() => answerKnownObject(o, { belongs: true, by: "" }, at(1)), "answer: nobody");
  eq(learn([]).learned.length, 0, "no events is nothing learned, not an error");
  const viaMap = learnKnownObjects({ events: stillDay(), existing: [], nowUtc: at(300), fingerprints: new Map([["cam1", "fp-cam1"]]) });
  eq(viaMap.learned[0]?.cameraFingerprint, "fp-cam1", "fingerprints as a Map work too");
  eq(learn(stillDay({ cameraId: "constructor" })).learned.length, 0, "a camera named like an Object key has no fingerprint");
});

// ------------------------------------------------------------------ the notice

const VERDICT_WORDS = /umbrella|false|fake|mistake|wrong|not a person|furniture|is an? object|this is|verdict|ignore/i;

check("the notice states measurements, with ISO times, and never a verdict", () => {
  const [o] = learn(stillDay(), { nowMins: 200 }).learned;
  const noted = [210, 220, 230, 240].reduce(
    (acc, m) => noteMatch(acc, { cameraId: "cam1", kind: "person", bestBox: spot, bestConfidence: 0.6, travel: 0, firstUtc: at(m), lastUtc: at(m + 1) }, at(m + 1)),
    o,
  );
  const lines = knownObjectNotice(noted);
  eq(lines[0], `Seen as a person 14 times at the same spot, never moving, from ${at(0)} to ${at(241)}.`, "what was seen");
  eq(lines[1], `Hidden from events since ${at(200)}: the 10 sightings it was learned from, and 4 more since.`, "what was hidden");
  eq(lines[2], "Highest score as a person: 0.60.", "the score");
  eq(lines[3], "No answer recorded yet.", "no answer yet");
  for (const line of lines) eq(VERDICT_WORDS.test(line), false, `no verdict in: ${line}`);

  const answered = answerKnownObject(noted, { belongs: false, by: "austin" }, at(300));
  eq(knownObjectNotice(answered).at(-1), `Answered at ${at(300)} by austin: it should not be there.`, "the owner's answer, as theirs");
  eq(knownObjectNotice(answerKnownObject(noted, { belongs: true, by: "austin" }, at(300))).at(-1).endsWith("it belongs there."), true, "belongs");

  const cases = [
    [lapseKnownObjects([noted], at(241 + 24 * 60), FP)[0], "not matched for 24 hours"],
    [lapseKnownObjects([noted], at(250), { cam1: "new" })[0], "the camera's connection settings changed"],
    [resetKnownObject(noted, at(250)), "reset by hand"],
  ];
  for (const [lapsed, why] of cases) {
    const text = knownObjectNotice(lapsed);
    eq(text.some((l) => l === `Stopped hiding new events at ${lapsed.lapsedAtUtc}: ${why}.`), true, `lapsed: ${why}`);
    eq(text.some((l) => l.startsWith("Hidden from events since")), false, "a lapsed object does not claim to be hiding");
    for (const line of text) eq(VERDICT_WORDS.test(line), false, `no verdict in: ${line}`);
  }
  const vehicle = learn(stillDay({ kind: "vehicle" }), { nowMins: 200 }).learned[0];
  eq(knownObjectNotice(vehicle)[0].startsWith("Seen as a vehicle 10 times"), true, "a vehicle reads as a vehicle");
});

report("knownObjects");
