// Behavioural tests for src/lib/stopClusters.ts.
// Build:  see build-clusters.sh (compiles with the @/ alias, then rewrites it)
import * as C from "./.cl-build/stopClusters.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "\n        " + d : ""}`); } };

// 0.001 deg latitude is ~111 m. Longitude at lat 30 is ~96 m per 0.001 deg.
const S = (id, dLat, dLng = 0) => ({ id, lat: 30 + dLat, lng: -95 + dLng });

console.log("\n[shape]");
ok("empty input gives no clusters", C.clusterStops([]).length === 0);
{
  const cs = C.clusterStops([S("a", 0)]);
  ok("a lone stop is a cluster of one", cs.length === 1 && cs[0].stopIds.length === 1);
  ok("a lone stop has zero radius", cs[0].radiusM === 0);
  ok("ids start at c0", cs[0].id === "c0");
}

console.log("\n[linking]");
{
  // 0.001 deg lat apart = ~111 m, inside the 250 m link radius
  const cs = C.clusterStops([S("a", 0), S("b", 0.001)]);
  ok("two neighbours form ONE cluster", cs.length === 1 && cs[0].stopIds.join(",") === "a,b");
}
{
  // 0.005 deg lat = ~555 m, outside 250 m
  const cs = C.clusterStops([S("a", 0), S("b", 0.005)]);
  ok("two distant stops stay separate", cs.length === 2);
}

console.log("\n[transitive chaining — the load-bearing property]");
{
  // a-b ~222 m, b-c ~222 m, a-c ~444 m. a and c are NOT within the link radius
  // of each other, but the street chains them into one work area.
  const stops = [S("a", 0), S("b", 0.002), S("c", 0.004)];
  const cs = C.clusterStops(stops);
  ok("a chain of neighbours is ONE cluster even when the ends are far apart",
     cs.length === 1 && cs[0].stopIds.join(",") === "a,b,c",
     "single-link chaining is the feature here: streets chain");
  ok("the cluster radius exceeds the link radius",
     cs[0].radiusM > 200,
     "proves it is not a fixed-radius bubble around a centroid");
}

console.log("\n[determinism]");
{
  const stops = [S("d", 0.004), S("a", 0), S("c", 0.002), S("b", 0.001), S("z", 0.05)];
  const shuffled = [stops[4], stops[0], stops[3], stops[2], stops[1]];
  const a = JSON.stringify(C.clusterStops(stops));
  const b = JSON.stringify(C.clusterStops(shuffled));
  ok("input order does not change the output", a === b);
  ok("clusters are ordered by their first stop id",
     C.clusterStops(stops)[0].stopIds[0] === "a");
}
{
  const stops = [S("b", 0.001), S("a", 0)];
  C.clusterStops(stops);
  ok("does not reorder the caller's array", stops[0].id === "b");
}

console.log("\n[geometry]");
{
  const cs = C.clusterStops([S("a", 0), S("b", 0.002)]);
  ok("centroid is the midpoint", Math.abs(cs[0].centroid.lat - 30.001) < 1e-9);
  ok("radius is centroid-to-farthest, about half the span",
     cs[0].radiusM > 100 && cs[0].radiusM < 120);
}

console.log("\n[lookup]");
{
  const cs = C.clusterStops([S("a", 0), S("b", 0.001), S("z", 0.05)]);
  ok("clusterOf finds the containing cluster", C.clusterOf("b", cs)?.stopIds.includes("a"));
  ok("clusterOf returns null for an unknown stop", C.clusterOf("nope", cs) === null);
  ok("nearestCluster returns null for no clusters", C.nearestCluster(30, -95, []) === null);
  const near = C.nearestCluster(30, -95, cs);
  ok("nearestCluster picks the closer centroid", near.cluster.stopIds.includes("a"));
  ok("nearestCluster reports a sane distance", near.distanceM >= 0 && near.distanceM < 200);
}

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
