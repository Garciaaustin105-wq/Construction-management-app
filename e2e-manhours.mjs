// Behavioural tests for src/lib/manHours.ts, run against the tsc-compiled output.
//   npx tsc src/lib/manHours.ts --outDir .mh-build --module esnext --target es2022 --moduleResolution bundler
//   node e2e-manhours.mjs
import {
  manHours, manMinutesPer1000Sqft, classifyMeasurement, median,
  lotSizeBand, buildBaseline, BASELINE_DEFAULTS, collapseClusters,
} from "./.mh-build/manHours.js";

let pass = 0, fail = 0;
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
function t(group, name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  [${group}] ${name}`); }
}
const M = (o) => ({ visitId: "v", onSiteMs: 20 * 60_000, crewSize: 2, lotSqft: 8000, ...o });

console.log("\n[man-hours]");
// The example the whole design turns on: 4 crew, 20 min on site.
t("mh", "4 crew x 20 min = 1.33 man-hours, not 0.33", near(manHours(20 * 60_000, 4), 1.333));
t("mh", "clock time alone would have been 0.33 h", near(20 * 60_000 / 3_600_000, 0.333));
t("mh", "zero crew yields 0", manHours(60_000, 0) === 0);
t("mh", "negative duration yields 0", manHours(-1, 4) === 0);

console.log("\n[rate]");
// Design doc: 4 houses, 34,000 sqft, 95 minutes, 4 crew -> ~11 man-min / 1000.
t("rate", "cluster example lands at ~11.2 man-min/1000",
  near(manMinutesPer1000Sqft(95 * 60_000, 4, 34000), 11.18, 0.05));
t("rate", "unknown area yields 0", manMinutesPer1000Sqft(60_000, 2, 0) === 0);

console.log("\n[classify order]");
t("cls", "no departure beats every other rule",
  classifyMeasurement(M({ onSiteMs: null, lotSqft: 0, crewSize: 0 })) === "no_departure");
t("cls", "under 4 minutes is too_short",
  classifyMeasurement(M({ onSiteMs: 3 * 60_000 })) === "too_short");
t("cls", "exactly 4 minutes is not too_short",
  classifyMeasurement(M({ onSiteMs: 4 * 60_000 })) !== "too_short");
t("cls", "missing area is NOT an outlier, it is null",
  classifyMeasurement(M({ lotSqft: null })) === null);
t("cls", "missing crew size is NOT an outlier, it is null",
  classifyMeasurement(M({ crewSize: 0 })) === null);
t("cls", "a two-hour lunch on a small lot is too_long",
  classifyMeasurement(M({ onSiteMs: 120 * 60_000, crewSize: 4, lotSqft: 5000 })) === "too_long");
t("cls", "a normal mow is unflagged",
  classifyMeasurement(M({ onSiteMs: 25 * 60_000, crewSize: 2, lotSqft: 8000 })) === null);
t("cls", "options override the default threshold",
  classifyMeasurement(M({ onSiteMs: 3 * 60_000 }), { minOnSiteMinutes: 2 }) !== "too_short");

console.log("\n[median]");
t("med", "empty is 0", median([]) === 0);
t("med", "odd length takes the middle", median([5, 1, 3]) === 3);
t("med", "even length averages the middle two", median([1, 2, 3, 4]) === 2.5);
const orig = [3, 1, 2];
median(orig);
t("med", "does not mutate its argument", orig[0] === 3 && orig[1] === 1);

console.log("\n[bands]");
t("band", "0 is unknown", lotSizeBand(0) === "unknown");
t("band", "4999 is under-5k", lotSizeBand(4999) === "under-5k");
t("band", "5000 is 5k-10k", lotSizeBand(5000) === "5k-10k");
t("band", "43559 is still 20k-1acre", lotSizeBand(43559) === "20k-1acre");
t("band", "one acre is 1acre-plus", lotSizeBand(43560) === "1acre-plus");

console.log("\n[baseline]");
const rows = [
  M({ visitId: "a", onSiteMs: 20 * 60_000, crewSize: 2, lotSqft: 8000 }),
  M({ visitId: "b", onSiteMs: 22 * 60_000, crewSize: 2, lotSqft: 8000 }),
  M({ visitId: "c", onSiteMs: 24 * 60_000, crewSize: 2, lotSqft: 8000 }),
  M({ visitId: "lunch", onSiteMs: 300 * 60_000, crewSize: 2, lotSqft: 8000 }),
  M({ visitId: "noarea", lotSqft: null }),
  M({ visitId: "open", onSiteMs: null }),
  M({ visitId: "driveby", onSiteMs: 60_000 }),
];
const b = buildBaseline(rows);
t("base", "only the three clean rows count", b.n === 3);
t("base", "median is the middle clean rate", near(b.medianManMinutesPer1000, 5.5, 0.01));
t("base", "excluded list is in input order",
  b.excluded.map((e) => e.visitId).join(",") === "lunch,noarea,open,driveby");
t("base", "the lunch row is flagged too_long",
  b.excluded.find((e) => e.visitId === "lunch").flag === "too_long");
t("base", "the unmeasured row carries NO flag, only exclusion",
  b.excluded.find((e) => e.visitId === "noarea").flag === null);
t("base", "the open visit is no_departure",
  b.excluded.find((e) => e.visitId === "open").flag === "no_departure");
t("base", "empty input is safe", buildBaseline([]).n === 0 && buildBaseline([]).medianManMinutesPer1000 === 0);

// The reason median was chosen over mean, asserted rather than asserted-in-prose.
console.log("\n[median robustness]");
const withLunch = [
  M({ visitId: "1", onSiteMs: 20 * 60_000, crewSize: 2, lotSqft: 8000 }),
  M({ visitId: "2", onSiteMs: 21 * 60_000, crewSize: 2, lotSqft: 8000 }),
  M({ visitId: "3", onSiteMs: 22 * 60_000, crewSize: 2, lotSqft: 8000 }),
  M({ visitId: "4", onSiteMs: 23 * 60_000, crewSize: 2, lotSqft: 8000 }),
  // Long, but under the too_long ceiling, so it is INCLUDED — exactly the case
  // a mean cannot survive and a median can.
  M({ visitId: "5", onSiteMs: 75 * 60_000, crewSize: 2, lotSqft: 8000 }),
];
const bl = buildBaseline(withLunch);
const rates = withLunch.map((m) => manMinutesPer1000Sqft(m.onSiteMs, m.crewSize, m.lotSqft));
const mean = rates.reduce((a, c) => a + c, 0) / rates.length;
t("rob", "the long row is included, not excluded", bl.n === 5);
t("rob", "median stays near the typical job", near(bl.medianManMinutesPer1000, 5.5, 0.01));
t("rob", "the mean is dragged well above the median", mean > bl.medianManMinutesPer1000 + 2);

console.log("\n[cluster collapse — the 4x inflation trap]");
{
  // The design's worked example: four adjacent houses, 8,500 sqft each,
  // one 95-minute window, 4 crew. As a CLUSTER that is 11.2 man-min/1000.
  const window = 95 * 60_000;
  const cluster = ["a", "b", "c", "d"].map((id) => ({
    visitId: id, onSiteMs: window, crewSize: 4, lotSqft: 8500, clusterKey: "K",
  }));

  // What a naive per-visit rate would produce — the bug this guards against.
  const perVisit = manMinutesPer1000Sqft(window, 4, 8500);
  t("cluster", "a per-visit rate would read ~44.7 (four times too high)", near(perVisit, 44.7, 0.1));

  const collapsed = collapseClusters(cluster);
  t("cluster", "four visits collapse to one row", collapsed.length === 1);
  t("cluster", "area SUMS to 34,000", collapsed[0].lotSqft === 34000);
  t("cluster", "the window does NOT sum", collapsed[0].onSiteMs === window);

  const b = buildBaseline(cluster);
  t("cluster", "baseline counts the cluster once, not four times", b.n === 1);
  t("cluster", "and lands on ~11.2, the figure the design specifies",
    near(b.medianManMinutesPer1000, 11.18, 0.05),
    "this is the whole point: one window over summed area");
}

console.log("\n[cluster with a missing lot size]");
{
  // One house in the cluster is unmeasured, so the total area is understated —
  // which would INFLATE the rate. The cluster must become unusable instead.
  const rows = [
    { visitId: "a", onSiteMs: 95 * 60_000, crewSize: 4, lotSqft: 8500, clusterKey: "K" },
    { visitId: "b", onSiteMs: 95 * 60_000, crewSize: 4, lotSqft: null, clusterKey: "K" },
  ];
  const collapsed = collapseClusters(rows);
  t("cluster", "a partially-measured cluster has NO usable area", collapsed[0].lotSqft === null);
  const b = buildBaseline(rows);
  t("cluster", "so it is excluded", b.n === 0);
  t("cluster", "as MISSING DATA, not as an outlier",
    b.excluded.length === 1 && b.excluded[0].flag === null,
    "an unmeasured lot must never look like an expensive job");
}

console.log("\n[collapse leaves solo rows alone]");
{
  const rows = [
    { visitId: "solo1", onSiteMs: 20 * 60_000, crewSize: 2, lotSqft: 8000 },
    { visitId: "solo2", onSiteMs: 20 * 60_000, crewSize: 2, lotSqft: 8000, clusterKey: null },
  ];
  const before = JSON.stringify(rows);
  const collapsed = collapseClusters(rows);
  t("cluster", "rows with no cluster key pass through untouched", collapsed.length === 2);
  t("cluster", "collapseClusters does not mutate its argument", JSON.stringify(rows) === before);
  t("cluster", "a cluster of one is not altered",
    collapseClusters([{ visitId: "x", onSiteMs: 1000, crewSize: 1, lotSqft: 5000, clusterKey: "Z" }])[0].visitId === "x");
}

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
