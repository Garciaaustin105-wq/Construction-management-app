import * as S from "./.sr-build/shiftRules.js";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d ? "\n        " + d : "")); } };
const MIN = 60_000, HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

console.log("\n[the 18-second shift]");
ok("18 seconds is trivially short", S.isTriviallyShort(18_000));
ok("4 minutes is still trivially short", S.isTriviallyShort(4 * MIN));
ok("exactly 5 minutes is NOT", S.isTriviallyShort(5 * MIN) === false);
ok("a full shift is not", S.isTriviallyShort(8 * HOUR) === false);
ok("a negative duration counts as short", S.isTriviallyShort(-1));

console.log("\n[backdating limits]");
ok("right now is fine", S.validateBackdate(NOW, NOW).ok);
ok("this morning is fine", S.validateBackdate(NOW - 9 * HOUR, NOW).ok);
ok("15h59 back is fine", S.validateBackdate(NOW - 15.9 * HOUR, NOW).ok);
{
  const r = S.validateBackdate(NOW - 20 * HOUR, NOW);
  ok("20 hours back is refused", r.ok === false && r.reason === "too_old");
  ok("and says what to do instead", r.ok === false && r.message.includes("ask the office"));
}
{
  const r = S.validateBackdate(NOW + 2 * HOUR, NOW);
  ok("a future start is refused", r.ok === false && r.reason === "future",
     "nobody claims tomorrow's hours today");
}
ok("a slow tap is tolerated", S.validateBackdate(NOW + 60_000, NOW).ok,
   "a couple of minutes of clock skew is not a future claim");

console.log("\n[labelling self-reported time]");
ok("a live stamp is not backdated", S.isBackdated(NOW, NOW) === false);
ok("30 seconds earlier is not backdated", S.isBackdated(NOW - 30_000, NOW) === false);
ok("4 hours earlier IS backdated", S.isBackdated(NOW - 4 * HOUR, NOW));

console.log("\n[what the office is told]");
ok("a clean shift says nothing",
   S.describeShiftFlags({ backdated: false, autoClosed: false, crewSize: 3 }).length === 0);
ok("a missing crew size is called out",
   S.describeShiftFlags({ crewSize: null }).join() === "Crew size not recorded");
ok("crew size of 1 is NOT 'not recorded'",
   S.describeShiftFlags({ crewSize: 1 }).length === 0,
   "== null must not catch a real value");
ok("undefined counts as missing", S.describeShiftFlags({}).length === 1);
{
  const all = S.describeShiftFlags({ backdated: true, autoClosed: true, crewSize: null });
  ok("all three, in order",
    all.join(" | ") === "Start time entered by hand | Ended automatically — the crew did not clock out | Crew size not recorded");
  ok("none of it blames the crew",
    all.every((p) => !/forgot|failed|should have/i.test(p)));
}

console.log("\n[durations]");
ok("zero", S.formatDuration(0) === "0m");
ok("negative clamps", S.formatDuration(-5000) === "0m");
ok("under an hour", S.formatDuration(45 * MIN) === "45m");
ok("padded minutes", S.formatDuration(2 * HOUR + 5 * MIN) === "2h 05m");
ok("whole hours still pad", S.formatDuration(3 * HOUR) === "3h 00m");
ok("a long day", S.formatDuration(12 * HOUR) === "12h 00m");

console.log("\n" + (fail === 0 ? "ALL GREEN" : "FAILURES") + " — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
