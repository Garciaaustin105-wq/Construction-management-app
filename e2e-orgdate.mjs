import * as D from "./.od-build/orgDate.js";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d ? "\n        " + d : "")); } };
const at = (iso) => new Date(iso);

console.log("\n[the 8pm rollover — the actual bug]");
{
  // 20:01 Eastern on Aug 31 is 00:01 UTC on Sep 1.
  const evening = at("2026-09-01T00:01:00Z");
  ok("UTC has already rolled over", evening.toISOString().slice(0, 10) === "2026-09-01");
  ok("but the business is still on Aug 31",
     D.todayInZone("America/New_York", evening) === "2026-08-31",
     "this is the four-hour window where the old code called today's work Overdue");
  ok("so a visit due today is bucketed TODAY, not overdue",
     D.dueBucket("2026-08-31", D.todayInZone("America/New_York", evening)) === "today");
  ok("and tomorrow's is upcoming, not today",
     D.dueBucket("2026-09-01", D.todayInZone("America/New_York", evening)) === "upcoming");
}
{
  const midday = at("2026-08-31T18:00:00Z"); // 14:00 Eastern
  ok("mid-afternoon they agree", D.todayInZone("America/New_York", midday) === "2026-08-31");
}

console.log("\n[zones]");
{
  const t = at("2026-09-01T03:30:00Z"); // 23:30 Eastern Aug 31, 20:30 Pacific Aug 31
  ok("Eastern", D.todayInZone("America/New_York", t) === "2026-08-31");
  ok("Pacific", D.todayInZone("America/Los_Angeles", t) === "2026-08-31");
  ok("UTC", D.todayInZone("UTC", t) === "2026-09-01");
  ok("a null zone falls back to the default", D.todayInZone(null, t) === "2026-08-31");
  ok("an unknown zone degrades instead of throwing",
     D.todayInZone("Mars/Olympus_Mons", t) === "2026-08-31");
}

console.log("\n[buckets]");
ok("earlier is overdue", D.dueBucket("2026-08-24", "2026-08-31") === "overdue");
ok("same is today", D.dueBucket("2026-08-31", "2026-08-31") === "today");
ok("later is upcoming", D.dueBucket("2026-09-05", "2026-08-31") === "upcoming");

console.log("\n[days late]");
ok("7 days", D.daysLate("2026-08-24", "2026-08-31") === 7);
ok("1 day", D.daysLate("2026-08-30", "2026-08-31") === 1);
ok("today is not late", D.daysLate("2026-08-31", "2026-08-31") === 0);
ok("future is not late", D.daysLate("2026-09-02", "2026-08-31") === 0);
ok("across a DST boundary stays whole",
   D.daysLate("2026-10-30", "2026-11-06") === 7,
   "UTC-midnight parsing keeps this exact; local midnights differ by 23 or 25 hours");
ok("garbage does not throw", D.daysLate("not-a-date", "2026-08-31") === 0);

console.log("\n[labels]");
ok("plural", D.lateLabel("2026-08-24", "2026-08-31") === "7 days late");
ok("singular", D.lateLabel("2026-08-30", "2026-08-31") === "1 day late");
ok("empty when on time", D.lateLabel("2026-08-31", "2026-08-31") === "");
ok("stamp reads as a date", D.formatDueStamp("2026-08-24") === "Mon, Aug 24");
ok("stamp does not shift by a day",
   D.formatDueStamp("2026-01-01") === "Thu, Jan 1",
   "formatted in UTC so it cannot disagree with the bucket above it");
ok("bad input returns the raw string", D.formatDueStamp("nope") === "nope");

console.log("\n" + (fail === 0 ? "ALL GREEN" : "FAILURES") + " — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
