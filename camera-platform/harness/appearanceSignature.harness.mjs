// harness/appearanceSignature.harness.mjs — contracts/appearance.ts
// (APPEARANCE-OF-DAY-SPEC.md, MANAGER-RULES-SPEC.md build 3)
//
// NOT REGISTERED in harness/run-all.mjs (new harnesses never are — see
// AGENTS.md); run it directly: `node harness/appearanceSignature.harness.mjs`.
// (contracts/appearance.ts's own PYTHON sibling — the actual pixel maths in
// detector/appearance.py — has its own harness, harness/appearance.harness.mjs;
// this file is the pure TypeScript contract only: similarity, learning, the
// today-file, and matching, never a pixel.)
//
// FEARED: a malformed signature (wrong length, NaN, a string) accepted and
// producing a plausible-looking similarity instead of being refused; a
// Bhattacharyya coefficient's own rounding drift pushing similarity's 0..100
// bound; learning from fewer than 20 signatures; a second manager learned
// from a lighting shift rather than a genuinely different person; the
// stale-date check using UTC instead of the site's own time zone; a match
// decision picking the WORSE of two learned managers.

import { check, eq, same, throws, report } from "./_assert.mjs";
import {
  SIGNATURE_LENGTH, REGION_LENGTH,
  SIMILARITY_UPPER_WEIGHT, SIMILARITY_LOWER_WEIGHT,
  isValidSignature, similarity, medianSignature,
  MIN_SIGNATURES_TO_LEARN, SECOND_MANAGER_MIN_PRESENCE_MINUTES, SECOND_MANAGER_MAX_SIMILARITY_PERCENT,
  learnPrimaryManager, learnSecondManager, learnTodaysManager,
  APPEARANCE_TODAY_VERSION, checkAppearanceTodayFile, isAppearanceTodayStale,
  DEFAULT_APPEARANCE_MATCH_PERCENT, matchAppearance,
} from "../dist/appearance.js";

console.log("appearance signature");

// ---------------------------------------------------------------- helpers

function onehot(index) {
  const arr = new Array(REGION_LENGTH).fill(0);
  arr[index] = 1;
  return arr;
}

/** A synthetic, exactly-controllable signature: all of the upper and lower
 *  histogram's mass in one bin each, plus an aspect ratio — lets similarity
 *  be computed by hand rather than guessed at. */
function sig(upperBin, lowerBin, aspect = 1) {
  return [...onehot(upperBin), ...onehot(lowerBin), aspect];
}

function zeros(n) {
  return new Array(n).fill(0);
}

// ---------------------------------------------------------------- isValidSignature

check("isValidSignature accepts exactly SIGNATURE_LENGTH finite numbers, nothing else", () => {
  eq(SIGNATURE_LENGTH, 145);
  eq(REGION_LENGTH, 72);
  eq(isValidSignature(zeros(145)), true);
  eq(isValidSignature(zeros(144)), false, "one short");
  eq(isValidSignature(zeros(146)), false, "one long");
  eq(isValidSignature([]), false);
  eq(isValidSignature(null), false);
  eq(isValidSignature(undefined), false);
  eq(isValidSignature("not an array"), false);
  eq(isValidSignature({ length: 145 }), false, "array-like is not an array");
  const withNaN = zeros(145); withNaN[10] = NaN;
  eq(isValidSignature(withNaN), false);
  const withInfinity = zeros(145); withInfinity[10] = Infinity;
  eq(isValidSignature(withInfinity), false);
  const withString = zeros(145); withString[10] = "0.5";
  eq(isValidSignature(withString), false);
});

// ---------------------------------------------------------------- similarity

check("similarity of two identical signatures is exactly 100", () => {
  const a = sig(3, 5, 1.8);
  eq(similarity(a, a), 100);
});

check("similarity weights match the spec: 0.6 upper + 0.4 lower, times aspect agreement", () => {
  eq(SIMILARITY_UPPER_WEIGHT, 0.6);
  eq(SIMILARITY_LOWER_WEIGHT, 0.4);
  // Disjoint upper bins (coefficient 0), identical lower bins (coefficient 1),
  // matching aspect: 0.6*0 + 0.4*1 = 0.4 -> 40%.
  eq(similarity(sig(0, 0, 1), sig(1, 0, 1)), 40);
  // Identical upper AND lower, but the aspect ratio is exactly half: the
  // aspect-agreement factor is 0.5, applied on top of a perfect 100.
  eq(similarity(sig(0, 0, 2), sig(0, 0, 1)), 50);
});

check("similarity is symmetric", () => {
  const a = sig(2, 4, 1.3);
  const b = sig(5, 1, 0.9);
  eq(similarity(a, b), similarity(b, a));
});

check("REQUIRED: similarity is always bounded 0..100, even off rounding-drifted histograms that do not sum to exactly 1", () => {
  // detector/appearance.py rounds each histogram value to 3 decimal places
  // before it ever reaches here, so the true sum can land a hair off 1.
  const drift = [...zeros(72).map((_, i) => (i === 0 ? 1.002 : 0)), ...zeros(72).map((_, i) => (i === 0 ? 0.999 : 0)), 1];
  const s = similarity(drift, drift);
  eq(s <= 100, true, `${s} <= 100`);
  eq(s >= 0, true, `${s} >= 0`);
  // A completely mismatched build on top of disjoint histograms.
  eq(similarity(sig(0, 0, 0.1), sig(70, 71, 50)) >= 0, true);
});

check("similarity is 0 when every region and the aspect ratio disagree completely", () => {
  eq(similarity(sig(0, 0, 1), sig(1, 1, -1)), 0, "a non-positive aspect ratio agrees with nothing");
});

check("REQUIRED: similarity throws on a malformed signature rather than guessing a number", () => {
  throws(() => similarity(zeros(144), zeros(145)), "wrong length");
  throws(() => similarity(zeros(145), null), "null");
  throws(() => similarity(["x", ...zeros(144)], zeros(145)), "a non-number entry");
});

// ---------------------------------------------------------------- medianSignature

check("medianSignature of an empty list is null, never a guessed all-zero signature", () => {
  eq(medianSignature([]), null);
});

check("medianSignature of one signature is that signature", () => {
  const a = sig(1, 2, 1.5);
  eq(medianSignature([a]), a);
});

check("medianSignature is the element-wise median, odd and even counts both", () => {
  const a = [...zeros(72), ...zeros(72), 1];
  const b = [...zeros(72), ...zeros(72), 2];
  const c = [...zeros(72), ...zeros(72), 3];
  a[0] = 1; b[0] = 2; c[0] = 3;
  eq(medianSignature([a, b, c])[0], 2, "odd count: the middle value");
  eq(medianSignature([a, b, c])[144], 2, "aspect too");
  eq(medianSignature([a, b])[0], 1.5, "even count: the average of the middle two");
});

check("medianSignature throws when any input is not a real signature", () => {
  throws(() => medianSignature([zeros(145), zeros(144)]), "one short signature in the list");
});

// ---------------------------------------------------------------- learning today's manager

function run(eventId, deskPresenceMs, signatures) {
  return { eventId, deskPresenceMs, signatures };
}

function signaturesOf(count, upperBin, lowerBin, aspect = 1) {
  return Array.from({ length: count }, () => sig(upperBin, lowerBin, aspect));
}

check("learnPrimaryManager refuses no_runs on an empty list", () => {
  eq(learnPrimaryManager([]), { ok: false, reason: "no_runs" });
});

check("REQUIRED: learnPrimaryManager refuses too_few_signatures below MIN_SIGNATURES_TO_LEARN, even for the only/longest run", () => {
  eq(MIN_SIGNATURES_TO_LEARN, 20);
  const runs = [run("e1", 40 * 60_000, signaturesOf(19, 0, 0))];
  eq(learnPrimaryManager(runs), { ok: false, reason: "too_few_signatures" });
  // one more signature clears the gate
  const okRuns = [run("e1", 40 * 60_000, signaturesOf(20, 0, 0))];
  eq(learnPrimaryManager(okRuns).ok, true);
});

check("learnPrimaryManager picks the LONGEST desk presence, not the most signatures", () => {
  const runs = [
    run("shorter-but-more-signatures", 10 * 60_000, signaturesOf(30, 1, 1)),
    run("longest", 45 * 60_000, signaturesOf(20, 2, 2)),
  ];
  const r = learnPrimaryManager(runs);
  eq(r.ok, true);
  eq(r.fromEventId, "longest");
  eq(r.signatureCount, 20);
  same(r.signature, sig(2, 2, 1));
});

check("learnSecondManager: no_candidate when nobody else clears the 30-minute presence floor", () => {
  eq(SECOND_MANAGER_MIN_PRESENCE_MINUTES, 30);
  const primarySig = sig(0, 0, 1);
  const runs = [run("other", 29 * 60_000, signaturesOf(25, 5, 5))];
  eq(learnSecondManager(runs, "primary-id", primarySig), { ok: false, reason: "no_candidate" });
});

check("learnSecondManager excludes the primary's own event id from candidacy", () => {
  const primarySig = sig(0, 0, 1);
  const runs = [run("primary-id", 60 * 60_000, signaturesOf(25, 5, 5))];
  eq(learnSecondManager(runs, "primary-id", primarySig), { ok: false, reason: "no_candidate" });
});

check("learnSecondManager: too_few_signatures for a candidate with enough presence but under 20 signatures", () => {
  const primarySig = sig(0, 0, 1);
  const runs = [run("other", 31 * 60_000, signaturesOf(19, 5, 5))];
  eq(learnSecondManager(runs, "primary-id", primarySig), { ok: false, reason: "too_few_signatures" });
});

check("REQUIRED: learnSecondManager refuses too_similar at or above the 60% ceiling — a lighting shift, not a second person", () => {
  eq(SECOND_MANAGER_MAX_SIMILARITY_PERCENT, 60);
  const primarySig = sig(0, 0, 1);
  // Same upper bin as primary (shared shirt-colour mass), different lower —
  // similarity = 0.6*1 + 0.4*0 = 60%: AT the ceiling, so still too similar.
  const runs = [run("other", 31 * 60_000, signaturesOf(20, 0, 9))];
  eq(learnSecondManager(runs, "primary-id", primarySig), { ok: false, reason: "too_similar" });
});

check("learnSecondManager succeeds for a genuinely different, well-presenced candidate", () => {
  const primarySig = sig(0, 0, 1);
  const runs = [run("other", 31 * 60_000, signaturesOf(20, 9, 9))]; // disjoint upper AND lower: 0% similar
  const r = learnSecondManager(runs, "primary-id", primarySig);
  eq(r.ok, true);
  eq(r.fromEventId, "other");
  eq(r.similarityToFirstPercent, 0);
});

check("learnSecondManager, among several qualifying candidates, picks the longest-present one", () => {
  const primarySig = sig(0, 0, 1);
  const runs = [
    run("shorter", 31 * 60_000, signaturesOf(20, 9, 9)),
    run("longest", 90 * 60_000, signaturesOf(20, 8, 8)),
  ];
  eq(learnSecondManager(runs, "primary-id", primarySig).fromEventId, "longest");
});

check("REQUIRED: learnTodaysManager refuses no_open_hours before ever looking at a single run", () => {
  const runs = [run("e1", 40 * 60_000, signaturesOf(20, 0, 0))];
  eq(learnTodaysManager(null, runs, runs), { ok: false, reason: "no_open_hours" });
});

const OPEN_HOURS = { timeZone: "America/Chicago", weekly: [[], [{ open: 480, close: 1320 }], [], [], [], [], []], closedDates: [] };

check("learnTodaysManager propagates the primary's own refusal reason", () => {
  eq(learnTodaysManager(OPEN_HOURS, [], []), { ok: false, reason: "no_runs" });
});

check("learnTodaysManager: primary learned, no qualifying second manager -> secondary is null (the common case)", () => {
  const runsFirstHour = [run("mgr", 50 * 60_000, signaturesOf(25, 3, 3))];
  const r = learnTodaysManager(OPEN_HOURS, runsFirstHour, runsFirstHour);
  eq(r.ok, true);
  eq(r.primary.fromEventId, "mgr");
  eq(r.secondary, null);
});

check("learnTodaysManager: both a primary and a rare second manager learned together", () => {
  const runsFirstHour = [run("mgr1", 50 * 60_000, signaturesOf(25, 3, 3))];
  const runsFirstTwoHours = [
    ...runsFirstHour,
    run("mgr2", 35 * 60_000, signaturesOf(22, 9, 9)),
  ];
  const r = learnTodaysManager(OPEN_HOURS, runsFirstHour, runsFirstTwoHours);
  eq(r.ok, true);
  eq(r.primary.fromEventId, "mgr1");
  eq(r.secondary.fromEventId, "mgr2");
  eq(r.secondary.similarityToFirstPercent, 0);
});

// ---------------------------------------------------------------- the today-file

const VALID_PRIMARY = sig(1, 2, 1.4);
const VALID_SECONDARY = sig(5, 6, 0.9);

function todayFile(overrides = {}) {
  return {
    version: APPEARANCE_TODAY_VERSION,
    date: "2026-09-27",
    primary: VALID_PRIMARY,
    secondary: null,
    learnedAtUtc: "2026-09-27T06:00:00.000Z",
    ...overrides,
  };
}

check("a well-formed today-file, secondary null, validates whole", () => {
  const r = checkAppearanceTodayFile(todayFile());
  eq(r.ok, true);
  same(r.file, todayFile());
});

check("a well-formed today-file WITH a second manager validates whole", () => {
  const r = checkAppearanceTodayFile(todayFile({ secondary: VALID_SECONDARY }));
  eq(r.ok, true);
  same(r.file.secondary, VALID_SECONDARY);
});

check("REQUIRED: every problem in a bad today-file comes back at once", () => {
  const r = checkAppearanceTodayFile({
    version: 2,
    date: "not-a-date",
    primary: zeros(10),
    secondary: zeros(10),
    learnedAtUtc: "not a time",
  });
  eq(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  same(fields, ["date", "learnedAtUtc", "primary", "secondary", "version"]);
});

check("checkAppearanceTodayFile refuses a non-object outright", () => {
  eq(checkAppearanceTodayFile(null).ok, false);
  eq(checkAppearanceTodayFile(undefined).ok, false);
  eq(checkAppearanceTodayFile([]).ok, false);
  eq(checkAppearanceTodayFile("nope").ok, false);
});

check("checkAppearanceTodayFile refuses a bad date shape, distinct from a bad signature", () => {
  eq(checkAppearanceTodayFile(todayFile({ date: "2026/09/27" })).ok, false);
  eq(checkAppearanceTodayFile(todayFile({ date: "" })).ok, false);
  eq(checkAppearanceTodayFile(todayFile({ primary: [...VALID_PRIMARY, 0] })).ok, false, "146 numbers");
  eq(checkAppearanceTodayFile(todayFile({ secondary: "none" })).ok, false, "secondary must be null or a real signature, never a placeholder string");
});

// ---------------------------------------------------------------- stale-date check, in the SITE's own tz

check("isAppearanceTodayStale is false when the file's date is still today, in the site tz", () => {
  eq(isAppearanceTodayStale({ date: "2026-09-27" }, "America/Chicago", "2026-09-27T23:00:00.000Z"), false);
});

check("REQUIRED: isAppearanceTodayStale measures the SITE's own time zone, never UTC", () => {
  // 2026-09-28T02:00:00Z is already the 28th in UTC, but only 21:00 on the
  // 27th in America/Chicago (UTC-5 in September, CDT) -- NOT stale there.
  eq(isAppearanceTodayStale({ date: "2026-09-27" }, "America/Chicago", "2026-09-28T02:00:00.000Z"), false);
  // The same instant IS stale measured in UTC itself.
  eq(isAppearanceTodayStale({ date: "2026-09-27" }, "UTC", "2026-09-28T02:00:00.000Z"), true);
});

check("isAppearanceTodayStale is true once the site's own local date has moved on, at local midnight or a stale-dated start", () => {
  eq(isAppearanceTodayStale({ date: "2026-09-26" }, "America/Chicago", "2026-09-27T23:00:00.000Z"), true, "yesterday's file, any later start");
  eq(isAppearanceTodayStale({ date: "2026-09-28" }, "America/Chicago", "2026-09-27T23:00:00.000Z"), true, "a file somehow dated tomorrow is stale too -- 'not today' either way, never guessed as fine");
});

// ---------------------------------------------------------------- matching

check("DEFAULT_APPEARANCE_MATCH_PERCENT is 80, per the spec", () => {
  eq(DEFAULT_APPEARANCE_MATCH_PERCENT, 80);
});

check("matchAppearance: at or above the threshold against the primary (no second manager) is a match", () => {
  const today = { primary: sig(0, 0, 1), secondary: null };
  const exact = matchAppearance(sig(0, 0, 1), today, 80);
  eq(exact, { match: true, which: "primary", similarityPercent: 100 });
  const below = matchAppearance(sig(1, 1, 1), today, 80);
  eq(below.match, false);
  eq(below.similarityPercent, 0);
});

check("REQUIRED: matchAppearance picks the BETTER of the two learned managers, never the worse or always the first", () => {
  const today = { primary: sig(0, 0, 1), secondary: sig(9, 9, 1) };
  // Matches the SECOND manager well, the first not at all.
  const r = matchAppearance(sig(9, 9, 1), today, 80);
  eq(r, { match: true, which: "secondary", similarityPercent: 100 });
  // Matches the FIRST manager well, the second not at all.
  const r2 = matchAppearance(sig(0, 0, 1), today, 80);
  eq(r2, { match: true, which: "primary", similarityPercent: 100 });
});

check("matchAppearance: below threshold against BOTH managers is no match, reporting the better (still losing) similarity", () => {
  const today = { primary: sig(0, 0, 1), secondary: sig(1, 1, 1) };
  // Some overlap with "secondary" via disjoint bins gives 0 against both here;
  // use a partial match against primary's lower region only.
  const partial = sig(5, 0, 1); // upper disjoint from both, lower matches primary's lower bin (0)
  const r = matchAppearance(partial, today, 80);
  eq(r.match, false);
  eq(r.similarityPercent, 40, "0.4 lower weight, matched only primary's lower bin, still under 80");
});

check("REQUIRED: a caller with no second manager never has to fabricate one — secondary: null works throughout", () => {
  const today = { primary: sig(3, 3, 1), secondary: null };
  const r = matchAppearance(sig(3, 3, 1), today, DEFAULT_APPEARANCE_MATCH_PERCENT);
  eq(r, { match: true, which: "primary", similarityPercent: 100 });
});

report("appearance signature");
