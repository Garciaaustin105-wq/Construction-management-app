// Geofence state-machine test suite (phase 3).
//
// Written against the SPEC, before the implementation existed — which is why it
// caught the two real bugs in the first draft: departing property A was never
// emitted when arriving at B (A's visit would stay open forever), and a missing
// stop in the list threw instead of holding state.
//
// Run:
//   npx tsc src/lib/geofence.ts --outDir .geofence-build --module esnext //     --target es2022 --moduleResolution bundler --skipLibCheck
//   node e2e-geofence.mjs
//
// Pure module, so no database, no server, no auth needed.

import * as G from "./.geofence-build/geofence.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "\n        " + d : ""}`); } };

// A stop, and points at known distances from it. 0.001 deg lat ~= 111 m.
const STOP = { id: "s1", lat: 30.0000, lng: -95.0000 };
const FAR  = { id: "s2", lat: 30.0200, lng: -95.0000 };   // ~2.2 km away
const at = (lat, lng, ms, acc = 10) => ({ lat, lng, accuracyM: acc, at: ms });
const MIN = 60_000;

console.log("\n[distance]");
ok("same point = 0 m", Math.round(G.distanceMeters(30, -95, 30, -95)) === 0);
{
  const d = G.distanceMeters(30, -95, 30.001, -95);
  ok(`0.001 deg lat ~111 m (got ${Math.round(d)})`, d > 105 && d < 118);
}

console.log("\n[accuracy gate]");
{
  const s0 = G.initialGeofenceState();
  const r = G.stepGeofence(s0, at(30, -95, 0, 500), [STOP]);
  ok("a 500 m-accuracy fix is ignored", r.events.length === 0 && r.state.insideStopId === null);
  const r2 = G.stepGeofence(s0, at(30, -95, 0, null), [STOP]);
  ok("null accuracy is accepted", r2.state.insideStopId === "s1");
}

console.log("\n[arrive needs continuous dwell]");
{
  let s = G.initialGeofenceState(), ev = [];
  for (const t of [0, 30, 60]) {           // 60 s inside — under the 90 s dwell
    const r = G.stepGeofence(s, at(30, -95, t * 1000), [STOP]); s = r.state; ev.push(...r.events);
  }
  ok("no arrive before the dwell elapses", ev.length === 0);
  const r = G.stepGeofence(s, at(30, -95, 95_000), [STOP]);
  ok("arrive fires once past 90 s", r.events.some(e => e.type === "arrive" && e.stopId === "s1"));
  const r2 = G.stepGeofence(r.state, at(30, -95, 200_000), [STOP]);
  ok("arrive does NOT fire twice for the same stop", !r2.events.some(e => e.type === "arrive"));
}

console.log("\n[hysteresis — the whole point]");
{
  // arrive first
  let s = G.initialGeofenceState();
  s = G.stepGeofence(s, at(30, -95, 0), [STOP]).state;
  s = G.stepGeofence(s, at(30, -95, 95_000), [STOP]).state;
  // Sit at ~120 m: outside the 100 m ENTER ring but inside the 150 m EXIT ring.
  let ev = [];
  for (let k = 0; k < 8; k++) {
    const r = G.stepGeofence(s, at(30.00108, -95, 95_000 + k * MIN), [STOP]);
    s = r.state; ev.push(...r.events);
  }
  ok("parked in the hysteresis band never departs", ev.length === 0,
     `got ${JSON.stringify(ev)}`);
}

console.log("\n[depart needs to clear the EXIT radius for the full dwell]");
{
  let s = G.initialGeofenceState();
  s = G.stepGeofence(s, at(30, -95, 0), [STOP]).state;
  s = G.stepGeofence(s, at(30, -95, 95_000), [STOP]).state;
  const t0 = 200_000;
  let r = G.stepGeofence(s, at(30.02, -95, t0), [STOP]);         // 2 km away
  ok("no depart immediately on leaving", !r.events.some(e => e.type === "depart"));
  r = G.stepGeofence(r.state, at(30.02, -95, t0 + 60_000), [STOP]);
  ok("no depart at 60 s (dwell is 180 s)", !r.events.some(e => e.type === "depart"));
  r = G.stepGeofence(r.state, at(30.02, -95, t0 + 190_000), [STOP]);
  ok("depart fires past 180 s", r.events.some(e => e.type === "depart" && e.stopId === "s1"));
}

console.log("\n[walking to the truck must not end the visit]");
{
  let s = G.initialGeofenceState();
  s = G.stepGeofence(s, at(30, -95, 0), [STOP]).state;
  s = G.stepGeofence(s, at(30, -95, 95_000), [STOP]).state;
  let r = G.stepGeofence(s, at(30.02, -95, 200_000), [STOP]);       // steps away
  r = G.stepGeofence(r.state, at(30, -95, 260_000), [STOP]);        // comes back
  r = G.stepGeofence(r.state, at(30, -95, 500_000), [STOP]);        // still there
  ok("returning before the dwell cancels the depart",
     !r.events.some(e => e.type === "depart"), `got ${JSON.stringify(r.events)}`);
}

console.log("\n[moving between properties]");
{
  let s = G.initialGeofenceState();
  const stops = [STOP, FAR];
  s = G.stepGeofence(s, at(30, -95, 0), stops).state;
  s = G.stepGeofence(s, at(30, -95, 95_000), stops).state;          // arrived s1
  let ev = [];
  let r = G.stepGeofence(s, at(30.02, -95, 300_000), stops);  ev.push(...r.events);
  r = G.stepGeofence(r.state, at(30.02, -95, 500_000), stops); ev.push(...r.events);
  r = G.stepGeofence(r.state, at(30.02, -95, 700_000), stops); ev.push(...r.events);
  const dep = ev.findIndex(e => e.type === "depart" && e.stopId === "s1");
  const arr = ev.findIndex(e => e.type === "arrive" && e.stopId === "s2");
  ok("departs s1", dep !== -1);
  ok("arrives s2", arr !== -1);
  ok("depart is ordered before arrive", dep !== -1 && arr !== -1 && dep < arr,
     `events: ${JSON.stringify(ev)}`);
}

console.log("\n[robustness]");
{
  const s0 = G.initialGeofenceState();
  const r = G.stepGeofence(s0, at(30, -95, 0), []);
  ok("empty stop list is safe", r.events.length === 0 && r.state.insideStopId === null);
  const frozen = G.initialGeofenceState();
  const copy = JSON.stringify(frozen);
  G.stepGeofence(frozen, at(30, -95, 0), [STOP]);
  ok("does not mutate the input state", JSON.stringify(frozen) === copy);
}

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
