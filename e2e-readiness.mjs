import * as R from "./.fr-build/fieldReadiness.js";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "\n        " + d : ""}`); } };
const has = (r, code) => r.issues.find((i) => i.code === code) ?? null;

console.log("\n[mode]");
ok("no linked crew = solo", R.fieldMode(0) === "solo");
ok("one linked crew = crew", R.fieldMode(1) === "crew");

console.log("\n[the inversion: same facts, opposite meaning]");
{
  const facts = { visitsToday: 4, unassignedToday: 4, withPinToday: 4, withSqftToday: 4 };
  const solo = R.assessReadiness({ ...facts, crewMembersWithLogin: 0 });
  const crew = R.assessReadiness({ ...facts, crewMembersWithLogin: 1 });
  ok("SOLO: 4 unassigned visits raise NO issue at all", has(solo, "unassigned_visits") === null,
     "unassigned IS the owner's route; warning would train people to 'fix' working config");
  ok("SOLO: nothing is blocking", R.hasBlocking(solo) === false);
  ok("CREW: the same 4 unassigned visits are BLOCKING", has(crew, "unassigned_visits")?.severity === "blocking");
  ok("CREW: hasBlocking is true", R.hasBlocking(crew) === true);
  ok("SOLO auto-stamps all 4", solo.autoStampableToday === 4);
  ok("CREW auto-stamps none of them", crew.autoStampableToday === 0,
     "this is the Peanutz state: work scheduled, nobody can see it");
}

console.log("\n[no visits]");
{
  const r = R.assessReadiness({ crewMembersWithLogin: 1, visitsToday: 0,
    unassignedToday: 0, withPinToday: 0, withSqftToday: 0 });
  ok("an empty day reports exactly one info issue", r.issues.length === 1 && r.issues[0].code === "no_visits");
  ok("an empty day is not blocking", R.hasBlocking(r) === false);
  ok("an empty day auto-stamps nothing", r.autoStampableToday === 0);
}

console.log("\n[severity of the softer gaps]");
{
  const r = R.assessReadiness({ crewMembersWithLogin: 0, visitsToday: 10,
    unassignedToday: 10, withPinToday: 6, withSqftToday: 2 });
  ok("missing pins are a warning, not blocking", has(r, "missing_pins")?.severity === "warning");
  ok("missing pins counted correctly", has(r, "missing_pins")?.count === 4);
  ok("missing sqft is only info", has(r, "missing_sqft")?.severity === "info");
  ok("missing sqft counted correctly", has(r, "missing_sqft")?.count === 8);
  ok("solo still auto-stamps every pinned visit", r.autoStampableToday === 6);
  ok("nothing here blocks the day", R.hasBlocking(r) === false);
}

console.log("\n[conservative overlap in crew mode]");
{
  // 10 visits, 3 unassigned, 8 pinned. At worst the 3 unassigned are all pinned,
  // leaving 5 that are certainly both reachable and pinned.
  const r = R.assessReadiness({ crewMembersWithLogin: 2, visitsToday: 10,
    unassignedToday: 3, withPinToday: 8, withSqftToday: 10 });
  ok("reports the guaranteed overlap, not an optimistic guess", r.autoStampableToday === 5,
     "max(0, pinned - unassigned); understating is the safe direction");
  const worst = R.assessReadiness({ crewMembersWithLogin: 2, visitsToday: 10,
    unassignedToday: 9, withPinToday: 2, withSqftToday: 10 });
  ok("never goes negative", worst.autoStampableToday === 0);
}

console.log("\n[issue ordering is stable]");
{
  const r = R.assessReadiness({ crewMembersWithLogin: 1, visitsToday: 5,
    unassignedToday: 2, withPinToday: 1, withSqftToday: 0 });
  ok("blocking first, then warning, then info",
     r.issues.map((i) => i.code).join(",") === "unassigned_visits,missing_pins,missing_sqft");
}

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
