// Action-planner tests. Rewritten when settlement took over completion.
//
// The suite this replaced asserted "depart -> POST /status {done}". That
// behaviour was removed: a depart must never complete a visit, because
// completing one emails the customer, and the geofence has no idea whether the
// whole crew has left, whether they stayed gone, or whether the office wanted
// to approve it first. Settlement answers all three.
import * as A from "./.geofence-build/geofenceActions.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d ? "\n        " + d : "")); } };
const ev = (type, stopId) => ({ type, stopId, at: 0 });

console.log("\n[arrive starts the visit]");
{
  const r = A.planGeofenceCalls([ev("arrive", "v1")], A.emptyLedger());
  ok("arrive -> POST /start",
    r.calls.length === 1 && r.calls[0].url === "/api/lawn/visits/v1/start"
    && r.calls[0].kind === "start" && r.calls[0].body === null);
  ok("and is recorded in the ledger", r.ledger.started.join() === "v1");
}

console.log("\n[a depart must NEVER complete a visit]");
{
  const r = A.planGeofenceCalls([ev("depart", "v1")], A.emptyLedger());
  ok("depart emits no calls at all", r.calls.length === 0,
     "completing here would email a customer with none of the four gates checked");
  ok("and changes nothing in the ledger", r.ledger.started.length === 0);
}
{
  // The case that made the old behaviour dangerous: one crew member walks to
  // the truck while the rest are still cutting.
  const l = A.planGeofenceCalls([ev("arrive", "v2")], A.emptyLedger()).ledger;
  const r = A.planGeofenceCalls([ev("depart", "v2")], l);
  ok("one phone leaving a started visit sends nothing", r.calls.length === 0,
     "walking to the truck for a trimmer must not tell a homeowner the lawn is done");
  ok("the visit stays started", r.ledger.started.join() === "v2");
}
{
  const r = A.planGeofenceCalls(
    [ev("depart", "a"), ev("arrive", "b")], A.emptyLedger());
  ok("driving A -> B plans only B's start",
    r.calls.length === 1 && r.calls[0].visitId === "b" && r.calls[0].kind === "start");
}

console.log("\n[at most once per visit]");
{
  let l = A.emptyLedger();
  l = A.planGeofenceCalls([ev("arrive", "v3")], l).ledger;
  const again = A.planGeofenceCalls([ev("arrive", "v3")], l);
  ok("a second arrive fires nothing", again.calls.length === 0,
     "GPS re-entering the radius must not restart the visit");
  const both = A.planGeofenceCalls([ev("arrive", "v4"), ev("arrive", "v4")], A.emptyLedger());
  ok("a duplicate inside one batch fires once", both.calls.length === 1);
}

console.log("\n[rollback lets a failed call retry]");
{
  let l = A.emptyLedger();
  const r = A.planGeofenceCalls([ev("arrive", "v5")], l); l = r.ledger;
  const blocked = A.planGeofenceCalls([ev("arrive", "v5")], l);
  ok("while recorded, it will not re-fire", blocked.calls.length === 0);
  l = A.rollbackCall(l, r.calls[0]);
  const retry = A.planGeofenceCalls([ev("arrive", "v5")], l);
  ok("after rollback the next fix retries", retry.calls.length === 1,
     "a network blip mid-route must not silently lose the start stamp");
  const noop = A.rollbackCall(A.emptyLedger(), r.calls[0]);
  ok("rolling back an absent id is a no-op", noop.started.length === 0);
}

console.log("\n[immutability]");
{
  const l = { started: ["keep"] };
  const before = JSON.stringify(l);
  A.planGeofenceCalls([ev("arrive", "new")], l);
  ok("planGeofenceCalls does not mutate the ledger", JSON.stringify(l) === before);
  A.rollbackCall(l, { method: "POST", url: "", body: null, visitId: "keep", kind: "start" });
  ok("rollbackCall does not mutate the ledger", JSON.stringify(l) === before);
}

console.log("\n" + (fail === 0 ? "ALL GREEN" : "FAILURES") + " — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
