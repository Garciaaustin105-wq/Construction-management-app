import * as S from "./.st-build/settlement.js";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d ? "\n        " + d : "")); } };
const MIN = 60_000;
const T0 = 1_800_000_000_000; // fixed epoch, no clock anywhere

console.log("\n[no measurement]");
{
  const r = S.assessSettlement({ onSiteFirstAt: null, onSiteLastAt: null, now: T0 });
  ok("nothing measured is not settleable", r.state === "not_measured" && !S.isSettleable(r));
  ok("and reads plainly", S.describeSettlement(r) === "No on-site time recorded");
}

console.log("\n[gates 1+2: the crew must be gone, and stay gone]");
{
  // 25 min on site, left 10 min ago, 30 min grace
  const r = S.assessSettlement(
    { onSiteFirstAt: T0 - 35 * MIN, onSiteLastAt: T0 - 10 * MIN, now: T0 });
  ok("still inside the grace window", r.state === "on_site");
  ok("not settleable yet", !S.isSettleable(r));
  ok("counts down in whole minutes", S.describeSettlement(r) === "Settles in 20 minutes");
}
{
  // THE LUNCH CASE: a phone pushes the high-water mark forward, which resets
  // the countdown with no special handling anywhere.
  const before = S.assessSettlement(
    { onSiteFirstAt: T0 - 60 * MIN, onSiteLastAt: T0 - 29 * MIN, now: T0 });
  const after = S.assessSettlement(
    { onSiteFirstAt: T0 - 60 * MIN, onSiteLastAt: T0 - 1 * MIN, now: T0 });
  ok("one minute from settling before the crew reappears", before.state === "on_site");
  ok("a later observation pushes settlement back out", after.settlesAt > before.settlesAt,
     "going back for a trimmer, or lunch on the lawn, needs no special case");
  ok("and it is still not settleable", !S.isSettleable(after));
}

console.log("\n[gate 3: too brief to be real work]");
{
  // 2 min on site, gone 45 min
  const r = S.assessSettlement(
    { onSiteFirstAt: T0 - 47 * MIN, onSiteLastAt: T0 - 45 * MIN, now: T0 });
  ok("a 2-minute stop never completes", r.state === "too_short");
  ok("not settleable", !S.isSettleable(r));
  ok("reads without blaming anyone", S.describeSettlement(r) === "On site too briefly to count");
}
{
  // exactly 4 minutes clears the floor
  const r = S.assessSettlement(
    { onSiteFirstAt: T0 - 49 * MIN, onSiteLastAt: T0 - 45 * MIN, now: T0 });
  ok("exactly the minimum passes", r.state !== "too_short");
}

console.log("\n[gate 4: office approval, and it defaults ON]");
{
  const input = { onSiteFirstAt: T0 - 70 * MIN, onSiteLastAt: T0 - 45 * MIN, now: T0 };
  const dflt = S.assessSettlement(input);
  ok("the DEFAULT holds for approval, it does not send",
     dflt.state === "awaiting_approval",
     "this is the only path that emails a customer; orgs opt IN to automation");
  ok("SETTLEMENT_DEFAULTS says so explicitly",
     S.SETTLEMENT_DEFAULTS.completionMode === "office_approval");
  const auto = S.assessSettlement(input, { completionMode: "auto" });
  ok("auto mode is ready to send", auto.state === "ready");
  ok("both count as settleable", S.isSettleable(dflt) && S.isSettleable(auto));
}

console.log("\n[gate order]");
{
  // A 2-minute visit still inside its grace window reports on_site, NOT
  // too_short — the crew may yet come back and make it long enough.
  const r = S.assessSettlement(
    { onSiteFirstAt: T0 - 12 * MIN, onSiteLastAt: T0 - 10 * MIN, now: T0 });
  ok("grace is checked before duration", r.state === "on_site",
     "a brief visit may still become a long one");
}

console.log("\n[settings and edges]");
{
  const r = S.assessSettlement(
    { onSiteFirstAt: T0 - 20 * MIN, onSiteLastAt: T0 - 6 * MIN, now: T0 },
    { graceMinutes: 5, completionMode: "auto" });
  ok("a shorter grace settles sooner", r.state === "ready");
  const one = S.assessSettlement(
    { onSiteFirstAt: T0 - 40 * MIN, onSiteLastAt: T0 - 29 * MIN, now: T0 });
  ok("singular minute is not '1 minutes'", S.describeSettlement(one) === "Settles in 1 minute");
  const neg = S.assessSettlement(
    { onSiteFirstAt: T0, onSiteLastAt: T0 - 5 * MIN, now: T0 + 60 * MIN });
  ok("an out-of-order write cannot go negative", neg.onSiteMs === 0);
}

console.log("\n" + (fail === 0 ? "ALL GREEN" : "FAILURES") + " — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
