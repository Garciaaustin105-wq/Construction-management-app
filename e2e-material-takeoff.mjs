// Material take-off (src/lib/materialTakeoff.ts).
//
// Run:
//   npx tsc src/lib/materialTakeoff.ts src/lib/plantProducts.ts \
//     src/lib/irrigationProducts.ts src/lib/sodProducts.ts \
//     src/lib/irrigationSystem.ts --outDir .mat-build --module esnext \
//     --target es2022 --moduleResolution bundler --skipLibCheck
//   node fix-mat-specifiers.mjs      (rewrites "@/lib/x" -> "./x.js")
//   node e2e-material-takeoff.mjs
//
// The rewrite is not optional. These modules import each other through the "@/"
// path alias, and a VALUE import survives into the emitted JS where Node cannot
// resolve it. A harness in this repo sat unrunnable for days on exactly that.
//
// Pure math, no database.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT is ordering the wrong amount of sod.
// You lay square feet and you BUY pallets, and the two numbers are never equal.
// An order built from the job's consumption under-orders every time, silently,
// by up to a whole pallet — and the shortfall shows up with a crew standing on
// the site.
const M = await import("./.mat-build/materialTakeoff.js");
const { buildMaterialTakeoff, takeoffWarning, sodLeftoverSqft } = M;

let pass = 0, fail = 0;
const t = (n, c, d = "") => {
  c ? (pass++, console.log("  PASS " + n))
    : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));
};
const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
const at = (r) => ({ lat: 28, lng: -82.5 });

// ── fixtures ────────────────────────────────────────────────────────────────
const plant = (id, size, cost, price = 40) => ({
  kind: "point", polygon: [at()], color: "#0a0", area_sqft: 0,
  meta: { plant_product_id: id, name: "Holly", size, cost, unit_price: price,
    install_minutes: 12, category: "shrub" },
});
const sodArea = (sqft, o = {}) => ({
  kind: "area", polygon: [at()], color: "#0f0", area_sqft: sqft,
  meta: { sod_product_id: o.id ?? "s1", name: o.name ?? "Floratam", grass_type: "st_augustine",
    sqft_per_pallet: o.per ?? 450, cost_per_sqft: o.cost ?? 0.35,
    price_per_sqft: 0.75, install_minutes_per_1000_sqft: 90, waste_pct: o.waste ?? 0 },
});
const head = (nozzleId, cost, arc = 360) => ({
  kind: "point", polygon: [at()], color: "#00f", area_sqft: 0,
  meta: { irrigation_product_id: "pgp", irrigation_nozzle_id: nozzleId,
    name: "Hunter PGP", category: "rotor", nozzle: "#4", radius_ft: 32,
    arc_deg: arc, cost, unit_price: 24, install_minutes: 8 },
});
const comp = (id, unit, cost, quantity) => ({
  snapshot: { irrigation_component_id: id, name: "1in PVC", category: "lateral",
    unit, cost, unit_price: cost * 2, install_minutes: 0.5 },
  quantity,
});
const takeoff = (areas = [], components = []) =>
  buildMaterialTakeoff({ areas, components });

console.log("[sod is bought in PALLETS, never in square feet]");
{
  // 1000 sqft at 450/pallet is 2.22 pallets -> 3, and you pay for 1350 sqft.
  const t1 = takeoff([sodArea(1000)]);
  const line = t1.lines.find((l) => l.source === "sod");
  t("the unit is the pallet", line.unit === "pallet");
  t("...rounded UP, because part pallets are not sold", line.quantity === 3);
  t("...priced per pallet, not per square foot", near(line.unitCost, 450 * 0.35));
  // 1350 x 0.35 = 472.50 bought, vs 1000 x 0.35 = 350 laid.
  t("THE ORDER COSTS WHAT THE PALLETS COST", near(line.extendedCost, 472.5),
    `got ${line.extendedCost}`);
  t("...which is MORE than the job consumes — the gap is the leftover",
    line.extendedCost > 350);
  t("the leftover is reported, not hidden", near(sodLeftoverSqft([sodArea(1000)].length ? { areas: [sodArea(1000)], components: [] } : {}), 350));
}

console.log("\n[three beds are three roundings, not one]");
{
  // Each of these rounds up on its own. Re-deriving from 1500 combined sqft
  // would order 4 pallets and leave the crew short.
  const three = takeoff([sodArea(500), sodArea(500), sodArea(500)]);
  const line = three.lines.find((l) => l.source === "sod");
  t("each area rounds up separately", line.quantity === 6, `got ${line.quantity}`);
  t("...and one calculation over the combined area would have ordered 4",
    Math.ceil(1500 / 450) === 4);
}

console.log("\n[a missing pallet size is not a quantity of zero]");
{
  const bad = takeoff([sodArea(1000, { per: 0 })]);
  const line = bad.lines.find((l) => l.source === "sod");
  t("THE LINE IS NOT ORDERABLE", line.orderable === false);
  t("...and says why", (line.note ?? "").toLowerCase().includes("pallet size"));
  t("...and does not offer square feet as a quantity", line.quantity === 0);
  t("...and contributes nothing to the total", bad.total === 0);
  t("...and is counted so the screen can say so", bad.unorderableCount === 1);
  t("the warning names it",
    (takeoffWarning(bad) ?? "").includes("cannot be ordered"));
}

console.log("\n[unpriced is not free]");
{
  const free = takeoff([plant("p1", "3 gal", 0)]);
  const line = free.lines[0];
  t("a zero cost is flagged unpriced", line.unpriced === true);
  t("...still orderable — you know WHAT to buy, just not the price",
    line.orderable === true);
  t("...and is left OUT of the total rather than adding nothing to it",
    free.total === 0 && free.unpricedCount === 1);
  t("the warning says the total is missing money",
    (takeoffWarning(free) ?? "").includes("no cost recorded"));

  const mixed = takeoff([plant("p1", "3 gal", 0), plant("p2", "7 gal", 10)]);
  t("a priced line still totals", near(mixed.total, 10));
  t("...and the unpriced one is still counted", mixed.unpricedCount === 1);
}

console.log("\n[a complete take-off warns about nothing]");
t("no warning when every line is priced and orderable",
  takeoffWarning(takeoff([plant("p1", "3 gal", 9)])) === null);

console.log("\n[grouping — what merges and what must not]");
{
  const same = takeoff([plant("p1", "3 gal", 9), plant("p1", "3 gal", 9)]);
  t("two of the same plant are one line of two", same.lines.length === 1 && same.lines[0].quantity === 2);

  const repriced = takeoff([plant("p1", "3 gal", 9), plant("p1", "3 gal", 11)]);
  t("THE SAME PLANT AT TWO COSTS STAYS TWO LINES", repriced.lines.length === 2);
  t("...because one merged line reconciles against neither price",
    near(repriced.total, 20));

  const sizes = takeoff([plant("p1", "3 gal", 9), plant("p1", "7 gal", 9)]);
  t("different sizes are different things to order", sizes.lines.length === 2);

  // Arc is set on site with a screwdriver. It is not a different part.
  const arcs = takeoff([head("n1", 6, 90), head("n1", 6, 360), head("n1", 6, 180)]);
  t("ARC DOES NOT SPLIT A NOZZLE LINE — you buy the nozzle",
    arcs.lines.length === 1 && arcs.lines[0].quantity === 3);
  const nozzles = takeoff([head("n1", 6), head("n2", 6)]);
  t("...but two different nozzles are two lines", nozzles.lines.length === 2);
}

console.log("\n[components carry their own unit]");
{
  const c = takeoff([], [comp("c1", "foot", 0.42, 200), comp("c2", "each", 3.1, 12)]);
  const pipe = c.lines.find((l) => l.unit === "foot");
  t("a per-foot component is ordered by the foot", pipe.quantity === 200);
  t("...extended per foot", near(pipe.extendedCost, 84));
  t("an each component is ordered by the each",
    c.lines.find((l) => l.unit === "each").quantity === 12);
  t("the total covers both", near(c.total, 84 + 37.2), `got ${c.total}`);

  const dup = takeoff([], [comp("c1", "foot", 0.42, 100), comp("c1", "foot", 0.42, 150)]);
  t("the same component twice sums into one line",
    dup.lines.length === 1 && dup.lines[0].quantity === 250);
  const zero = takeoff([], [comp("c1", "foot", 0.42, 0)]);
  t("a zero quantity is not a line at all", zero.lines.length === 0);
}

console.log("\n[the boundary — what is NOT a material]");
{
  // Labor and equipment are not passed in at all, by design. The check that
  // matters is that nothing sneaks in through the area list.
  const labourish = takeoff([{
    kind: "area", polygon: [at()], color: "#000", area_sqft: 500,
    meta: { labor_item_id: "l1", name: "Bed prep" },
  }]);
  t("A LABOR AREA PRODUCES NO MATERIAL LINE", labourish.lines.length === 0);
  const plain = takeoff([{ kind: "area", polygon: [at()], color: "#000", area_sqft: 500, meta: {} }]);
  t("a bare measured polygon is not a material", plain.lines.length === 0);
  t("an empty estimate is an empty take-off, not a zero-dollar order",
    takeoff().lines.length === 0 && takeoff().total === 0);
}

console.log("\n[ordering of the list]");
{
  const all = takeoff([plant("p1", "3 gal", 9), sodArea(1000), head("n1", 6)],
    [comp("c1", "foot", 0.42, 100)]);
  t("plants, then sod, then heads, then components",
    all.lines.map((l) => l.source).join(",") === "plant,sod,head,component",
    all.lines.map((l) => l.source).join(","));
  t("every line carries a unit", all.lines.every((l) => !!l.unit));
  t("every line carries its extended cost",
    all.lines.every((l) => typeof l.extendedCost === "number"));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
