import * as A from "./.geofence-build/geofenceActions.js";
let pass=0, fail=0;
const ok=(n,c,d="")=>{ if(c){pass++;console.log(`  PASS  ${n}`);} else {fail++;console.log(`  FAIL  ${n}${d?"\n        "+d:""}`);} };
const ev=(type,stopId,at=0)=>({type,stopId,at});

console.log("\n[basic mapping]");
{
  const r=A.planGeofenceCalls([ev("arrive","v1")], A.emptyLedger());
  ok("arrive -> POST /start", r.calls.length===1 && r.calls[0].url==="/api/lawn/visits/v1/start" && r.calls[0].body===null && r.calls[0].kind==="start", JSON.stringify(r.calls));
  const d=A.planGeofenceCalls([ev("depart","v1")], A.emptyLedger());
  ok("depart -> POST /status {done}", d.calls.length===1 && d.calls[0].url==="/api/lawn/visits/v1/status" && d.calls[0].body?.status==="done" && d.calls[0].kind==="complete", JSON.stringify(d.calls));
}

console.log("\n[at-most-once — completion emails a customer]");
{
  let l=A.emptyLedger();
  let r=A.planGeofenceCalls([ev("depart","v1")], l); l=r.ledger;
  const again=A.planGeofenceCalls([ev("depart","v1")], l);
  ok("a second depart for the same visit fires nothing", again.calls.length===0, JSON.stringify(again.calls));
  const dup=A.planGeofenceCalls([ev("arrive","v9"),ev("arrive","v9")], A.emptyLedger());
  ok("duplicate events in ONE batch yield one call", dup.calls.length===1, JSON.stringify(dup.calls));
  let l2=A.emptyLedger();
  let s1=A.planGeofenceCalls([ev("arrive","v2")], l2); l2=s1.ledger;
  const s2=A.planGeofenceCalls([ev("arrive","v2")], l2);
  ok("a second arrive for the same visit fires nothing", s2.calls.length===0);
}

console.log("\n[missed arrival still completes]");
{
  const r=A.planGeofenceCalls([ev("depart","v3")], A.emptyLedger());
  ok("depart with no prior arrive still completes", r.calls.length===1 && r.calls[0].kind==="complete");
}

console.log("\n[ordering]");
{
  const r=A.planGeofenceCalls([ev("depart","a"),ev("arrive","b")], A.emptyLedger());
  ok("depart call precedes arrive call", r.calls[0]?.kind==="complete" && r.calls[1]?.kind==="start", JSON.stringify(r.calls.map(c=>c.kind)));
}

console.log("\n[rollback lets a failure retry]");
{
  let l=A.emptyLedger();
  const r=A.planGeofenceCalls([ev("depart","v4")], l); l=r.ledger;
  const blocked=A.planGeofenceCalls([ev("depart","v4")], l);
  ok("blocked before rollback", blocked.calls.length===0);
  l=A.rollbackCall(l, r.calls[0]);
  const retry=A.planGeofenceCalls([ev("depart","v4")], l);
  ok("retries after rollback", retry.calls.length===1);
  const noop=A.rollbackCall(A.emptyLedger(), r.calls[0]);
  ok("rolling back an absent id is a no-op", Array.isArray(noop.completed) && noop.completed.length===0);
}

console.log("\n[immutability]");
{
  const l=A.emptyLedger(); const before=JSON.stringify(l);
  A.planGeofenceCalls([ev("arrive","v5"),ev("depart","v6")], l);
  ok("planGeofenceCalls does not mutate the ledger", JSON.stringify(l)===before);
  const l2=A.emptyLedger(); l2.started.push("x"); const b2=JSON.stringify(l2);
  A.rollbackCall(l2,{method:"POST",url:"/x",body:null,visitId:"x",kind:"start"});
  ok("rollbackCall does not mutate the ledger", JSON.stringify(l2)===b2);
}
console.log(`\n${fail===0?"ALL GREEN":"FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);
