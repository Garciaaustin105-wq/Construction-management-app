/**
 * The clip library is the answer key every detector stage is scored against
 * (AI-PLAN D0). A wrong answer key does not fail loudly: it makes a bad
 * detector look good. So most of these checks are about the key refusing to
 * be wrong, and about the score refusing to flatter.
 */
import { checkLibrary, scoreLibrary, exitGate, SCENE_TAGS, MAX_CLIP_MS, MIN_GATE_PERSONS, MIN_GATE_EMPTY_HOURS } from "../dist/clipLibrary.js";
import { check, eq, report } from "./_assert.mjs";

const T0 = Date.UTC(2026, 8, 17, 14, 0, 0);
const at = (sec) => new Date(T0 + sec * 1000).toISOString();

function clip(over = {}) {
  return {
    id: "walk-1",
    cameraId: "cam2-sub",
    startUtc: at(0),
    endUtc: at(60),
    scenes: ["person"],
    expected: [{ kind: "person", fromUtc: at(10), toUtc: at(20), count: 1 }],
    ...over,
  };
}
const lib = (...clips) => ({ version: 1, clips });
function event(kind, fromSec, toSec, over = {}) {
  return {
    cameraId: "cam2-sub", kind, firstUtc: at(fromSec), lastUtc: at(toSec), count: 5,
    bestConfidence: 0.8, bestBox: { x: 0, y: 0, w: 0.1, h: 0.2 }, bestUtc: at(fromSec), ...over,
  };
}
function refused(raw, fragment) {
  const r = checkLibrary(raw);
  eq(r.ok, false, "refused: " + fragment);
  if (!r.errors.some((e) => e.includes(fragment))) {
    throw new Error(`expected an error mentioning "${fragment}", got ${JSON.stringify(r.errors)}`);
  }
}

/* ---------------- the answer key refuses to be wrong ---------------- */

check("a well-formed library is accepted as it was written", () => {
  const raw = lib(clip(), clip({ id: "empty-1", startUtc: at(100), endUtc: at(160), scenes: ["empty"], expected: [] }));
  const r = checkLibrary(raw);
  eq(r.ok, true, "ok");
  eq(r.library.clips.length, 2, "both clips");
  eq(r.library.clips[0].expected[0].count, 1, "count kept");
});

check("SCENE_TAGS is the vocabulary, and an unknown tag is refused, not dropped", () => {
  for (const t of ["empty", "person", "vehicle", "shadows", "headlights", "rain", "animal", "night"]) {
    if (!SCENE_TAGS.includes(t)) throw new Error("missing tag " + t);
  }
  refused(lib(clip({ scenes: ["person", "ghost"] })), "ghost");
});

check("THE FEARED ONE: a clip tagged empty that expects someone is refused", () => {
  // Scored as empty, every correct detection in it would count as false.
  refused(lib(clip({ scenes: ["empty"] })), "empty");
});

check("a clip that expects nothing must say it is empty", () => {
  // Otherwise a forgotten answer silently becomes "nobody was there".
  refused(lib(clip({ expected: [] })), "empty");
});

check("an expected event outside its clip is refused", () => {
  refused(lib(clip({ expected: [{ kind: "person", fromUtc: at(50), toUtc: at(70), count: 1 }] })), "outside");
});

check("a clip that ends before it starts, or runs longer than the cap, is refused", () => {
  refused(lib(clip({ endUtc: at(0) })), "end");
  refused(lib(clip({ endUtc: new Date(T0 + MAX_CLIP_MS + 1000).toISOString(), expected: [] , scenes: ["empty"] })), "long");
});

check("a count must be a whole number of people, at least one", () => {
  for (const count of [0, 1.5, -1, "2", null]) {
    refused(lib(clip({ expected: [{ kind: "person", fromUtc: at(10), toUtc: at(20), count }] })), "count");
  }
});

check("plates are not scored here; only person and vehicle", () => {
  refused(lib(clip({ expected: [{ kind: "plate", fromUtc: at(10), toUtc: at(20), count: 1 }] })), "kind");
});

check("duplicate ids are refused -- a score by clip id would merge them", () => {
  refused(lib(clip(), clip({ startUtc: at(100), endUtc: at(160), expected: [], scenes: ["empty"] })), "duplicate");
});

check("THE FEARED ONE: overlapping clips on one camera are refused, or one detection counts twice", () => {
  refused(lib(clip(), clip({ id: "walk-2", startUtc: at(30), endUtc: at(90), expected: [], scenes: ["empty"] })), "overlap");
  // The same minutes on a different camera are fine.
  eq(checkLibrary(lib(clip(), clip({ id: "walk-2", cameraId: "cam1-main" }))).ok, true, "other camera ok");
});

check("junk is refused with reasons, never thrown", () => {
  for (const raw of [null, 42, "x", {}, { version: 2, clips: [] }, { version: 1, clips: "no" }]) {
    const r = checkLibrary(raw);
    eq(r.ok, false, JSON.stringify(raw));
    if (!Array.isArray(r.errors) || r.errors.length === 0) throw new Error("no reason given");
  }
});

check("an unparseable time is refused", () => {
  refused(lib(clip({ startUtc: "yesterday" })), "time");
});

check("a bad clip id is refused (it becomes a file name)", () => {
  refused(lib(clip({ id: "../../etc/passwd" })), "id");
});

/* ---------------- the score refuses to flatter ---------------- */

check("a person found inside the window is found; nothing else is false", () => {
  const s = scoreLibrary(checkLibrary(lib(clip())).library, [event("person", 12, 18)]);
  eq(s.person.expected, 1, "expected");
  eq(s.person.found, 1, "found");
  eq(s.person.falseEvents, 0, "false");
  eq(s.person.missed, [], "missed");
});

check("a detection a moment either side of the window still counts (tolerance)", () => {
  const s = scoreLibrary(checkLibrary(lib(clip())).library, [event("person", 21, 25)], { toleranceMs: 2000 });
  eq(s.person.found, 1, "found at +1 s");
  const far = scoreLibrary(checkLibrary(lib(clip())).library, [event("person", 30, 35)], { toleranceMs: 2000 });
  eq(far.person.found, 0, "not at +10 s");
  eq(far.person.falseEvents, 1, "and that one is false");
  eq(far.person.missed, [{ clipId: "walk-1", fromUtc: at(10), count: 1 }], "the miss is named");
});

check("THE FEARED ONE: one event cannot be two people", () => {
  const two = clip({ expected: [{ kind: "person", fromUtc: at(10), toUtc: at(20), count: 2 }] });
  const s = scoreLibrary(checkLibrary(lib(two)).library, [event("person", 12, 18)]);
  eq(s.person.expected, 2, "two expected");
  eq(s.person.found, 1, "one found, not two");
});

check("a vehicle is not a person", () => {
  const s = scoreLibrary(checkLibrary(lib(clip())).library, [event("vehicle", 12, 18)]);
  eq(s.person.found, 0, "no person");
  eq(s.vehicle.falseEvents, 1, "a false vehicle");
});

check("a split track is a duplicate, not a false person", () => {
  // The detector saw the one person twice. That is worth knowing, but it is
  // not the same failure as seeing a person where there was nobody.
  const s = scoreLibrary(checkLibrary(lib(clip())).library, [event("person", 11, 14), event("person", 16, 19)]);
  eq(s.person.found, 1, "found once");
  eq(s.person.duplicates, 1, "one duplicate");
  eq(s.person.falseEvents, 0, "no false person");
});

check("events on another camera, or outside every clip, are not scored at all", () => {
  const s = scoreLibrary(checkLibrary(lib(clip())).library, [
    event("person", 12, 18, { cameraId: "cam1-main" }),
    event("person", 500, 510),
  ]);
  eq(s.person.found, 0, "other camera does not count");
  eq(s.person.falseEvents, 0, "and nothing outside the clips is false");
});

check("hours are measured; false per hour is null with no footage, not zero", () => {
  const empty = scoreLibrary({ version: 1, clips: [] }, []);
  eq(empty.hoursScored, 0, "no hours");
  eq(empty.person.falsePerHour, null, "no rate from nothing");
  eq(empty.person.recall, null, "no recall from nothing");
  const oneHourEmpty = clip({ id: "empty-1", endUtc: at(3600), scenes: ["empty", "night"], expected: [] });
  const s = scoreLibrary(checkLibrary(lib(oneHourEmpty)).library, [event("person", 100, 101), event("person", 900, 905)]);
  eq(s.hoursScored, 1, "one hour");
  eq(s.emptyHours, 1, "and it is empty-scene footage");
  eq(s.person.falsePerHour, 2, "two false people an hour");
});

check("scoring does not mutate what it was given", () => {
  const library = checkLibrary(lib(clip())).library;
  const events = [event("person", 12, 18)];
  const before = JSON.stringify([library, events]);
  scoreLibrary(library, events);
  eq(JSON.stringify([library, events]), before, "untouched");
});

/* ---------------- the gate refuses small samples ---------------- */

function scoreWith(persons, emptyHours, found, falseEvents) {
  return {
    hoursScored: emptyHours + 1, emptyHours,
    person: { expected: persons, found, duplicates: 0, falseEvents, missed: [], recall: persons ? found / persons : null, falsePerHour: falseEvents / (emptyHours + 1) },
    vehicle: { expected: 0, found: 0, duplicates: 0, falseEvents: 0, missed: [], recall: null, falsePerHour: 0 },
  };
}

check("THE FEARED ONE: three people found out of three is not 'passes the 95% bar'", () => {
  const g = exitGate(scoreWith(3, 2, 3, 0));
  eq(g.enough, false, "not enough people to say");
  if (!g.why.some((w) => w.includes(String(MIN_GATE_PERSONS)))) throw new Error("does not say how many are needed");
  eq(g.meetsRecall, null, "no recall verdict");
});

check("no empty-scene hour means no false-rate verdict", () => {
  const g = exitGate(scoreWith(40, MIN_GATE_EMPTY_HOURS / 2, 40, 0));
  eq(g.enough, false, "not enough empty footage");
  eq(g.meetsFalseRate, null, "no false-rate verdict");
});

check("with enough footage the gate reports each bar separately", () => {
  const g = exitGate(scoreWith(40, 2, 38, 1));
  eq(g.enough, true, "enough");
  eq(g.meetsRecall, true, "38/40 = 95% meets 95%");
  eq(g.meetsFalseRate, true, "1 in 3 h is under 1/h");
  const bad = exitGate(scoreWith(40, 2, 37, 9));
  eq(bad.meetsRecall, false, "92.5% does not");
  eq(bad.meetsFalseRate, false, "3/h does not");
});

report("clipLibrary");
