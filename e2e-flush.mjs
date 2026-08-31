import * as F from "./.fl-build/endShiftFlush.js";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d ? "\n        " + d : "")); } };
const row = (id, mode, queued = false) =>
  ({ visit_id: id, completion_mode: mode, already_queued: queued });

console.log("\n[the two modes]");
{
  const a = F.planFlush([row("v1", "auto")]);
  ok("auto completes (and therefore emails)", a.length === 1 && a[0].kind === "complete");
  const b = F.planFlush([row("v2", "office_approval")]);
  ok("office_approval queues", b.length === 1 && b[0].kind === "queue");
}

console.log("\n[already queued is left alone]");
{
  const a = F.planFlush([row("v3", "office_approval", true), row("v4", "auto", true)]);
  ok("nothing is planned for visits a human already has", a.length === 0,
     "re-stamping would reorder the office queue and make old items look new");
}

console.log("\n[an unknown mode must NEVER send]");
{
  for (const bad of ["", "AUTO", "Auto", "automatic", "send", "unknown", "office-approval"]) {
    const a = F.planFlush([row("x", bad)]);
    ok(`"${bad}" queues rather than sends`, a[0]?.kind === "queue",
       "a typo or a mode added later must not email a customer");
  }
  ok("only the exact string auto sends", F.planFlush([row("y", "auto")])[0].kind === "complete");
}

console.log("\n[mixed batch]");
{
  const a = F.planFlush([
    row("a", "auto"), row("b", "office_approval"),
    row("c", "auto", true), row("d", "office_approval"),
  ]);
  ok("plans 3 of 4", a.length === 3);
  ok("one complete, two queues",
    a.filter((x) => x.kind === "complete").length === 1 &&
    a.filter((x) => x.kind === "queue").length === 2);
  ok("input order preserved", a.map((x) => x.visitId).join() === "a,b,d");
}

console.log("\n[summary wording]");
{
  const a = F.planFlush([row("a", "auto"), row("b", "office_approval"), row("c", "office_approval")]);
  ok("counts both outcomes",
    F.summariseFlush(a, 0) === "1 customer notified, 2 sent to the office to approve");
  ok("singular customer", F.summariseFlush(F.planFlush([row("a", "auto")]), 0) === "1 customer notified");
  ok("failures are reported, not hidden",
    F.summariseFlush(F.planFlush([row("a", "auto")]), 2)
      === "1 customer notified, 2 could not be settled");
  ok("nothing to say returns null", F.summariseFlush([], 0) === null);
}

console.log("\n[empty]");
ok("no settleable visits plans nothing", F.planFlush([]).length === 0);

console.log("\n" + (fail === 0 ? "ALL GREEN" : "FAILURES") + " — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
