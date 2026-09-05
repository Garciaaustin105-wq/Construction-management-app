// E2E for the landscape install-labor layer: the org defaults, the
// per-estimate settings, and the legend/margin math run against REAL database
// rows rather than hand-made objects.
//
// Run:
//   npx tsc src/lib/plantProducts.ts --outDir .labor-build --module esnext \
//     --target es2022 --moduleResolution bundler --skipLibCheck
//   node e2e-labor-settings.mjs
//
// That compile reports ONE error — TS2307 on the `import type { EstimateArea }`
// from "@/lib/estimateAreas", because the path alias is not configured on a
// bare tsc invocation. It is expected, not a failure: the import is type-only,
// so it is erased and the emitted JS is complete. Asserted below by importing
// the build and calling it.
//
// WHY THIS EXISTS, beyond the round-trips: every earlier check of
// buildPlantLegend / estimateMargin used hand-made JS objects. Section 3 runs
// the same math over rows that actually made the round trip through Postgres
// and jsonb, which is the only way to know the snapshot survives storage.
//
// CORRECTION worth keeping: an earlier note in this repo claimed PostgREST
// returns `numeric` as a STRING. Through supabase-js it comes back as a
// NUMBER — the string form came from the MCP SQL console, a different path.
// readPlantSnapshot coerces either way, which is still right (a value can
// reach `meta` as a string if a caller stores a raw form field), and section 3
// asserts both forms rather than assuming one.
//
// The authed surfaces (/api/org PATCH, the settings form, the panel) are NOT
// covered here — same boundary the chemical harness draws: this verifies the
// DB layer via the service-role key, and the browser layer stays manual.
//
// SAFETY: every row is created in Terra Verde Test Co and deleted at the end.
// Peanutz L&L is a live customer and is never read or written.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const TEST_ORG = "600d02fa-fae2-440b-99ab-42e96997da91"; // Terra Verde Test Co
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { buildPlantLegend, estimateMargin, laborLineItem, mobilizationUnset,
  installTimeUnset, mobilizationShare, readPlantSnapshot } =
  await import("./.labor-build/plantProducts.js");

let pass = 0, fail = 0;
const t = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

// Track everything created so cleanup is exhaustive even on early failure.
const created = { estimates: [], products: [] };
let orgBefore = null;

try {
  // -------------------------------------------------------- 1. org defaults
  // The columns are asserted by round-tripping them rather than by reading
  // information_schema — a select that returns the value proves more than a
  // catalogue lookup does.
  console.log("\n[1] org labor defaults round-trip");
  const { data: orgRow, error: orgReadErr } = await admin
    .from("organizations")
    .select("id, default_labor_rate, default_labor_cost_rate, default_mobilization_hours")
    .eq("id", TEST_ORG)
    .single();
  t("test org reads back with the three default columns", !orgReadErr && !!orgRow,
    orgReadErr?.message);
  orgBefore = orgRow
    ? {
        default_labor_rate: orgRow.default_labor_rate,
        default_labor_cost_rate: orgRow.default_labor_cost_rate,
        default_mobilization_hours: orgRow.default_mobilization_hours,
      }
    : null;

  await admin.from("organizations")
    .update({ default_labor_rate: 65, default_labor_cost_rate: 38, default_mobilization_hours: 1.5 })
    .eq("id", TEST_ORG);
  const { data: afterSet } = await admin.from("organizations")
    .select("default_labor_rate, default_labor_cost_rate, default_mobilization_hours")
    .eq("id", TEST_ORG).single();
  t("defaults persist", Number(afterSet.default_labor_rate) === 65
    && Number(afterSet.default_labor_cost_rate) === 38
    && Number(afterSet.default_mobilization_hours) === 1.5,
    JSON.stringify(afterSet));

  // The distinction the whole design rests on.
  await admin.from("organizations").update({ default_mobilization_hours: 0 }).eq("id", TEST_ORG);
  const { data: zero } = await admin.from("organizations")
    .select("default_mobilization_hours").eq("id", TEST_ORG).single();
  t("0 stores as 0, not null", Number(zero.default_mobilization_hours) === 0
    && zero.default_mobilization_hours !== null);
  t("0 is NOT treated as unset by the contract", mobilizationUnset(0) === false);

  await admin.from("organizations").update({ default_mobilization_hours: null }).eq("id", TEST_ORG);
  const { data: nulled } = await admin.from("organizations")
    .select("default_mobilization_hours").eq("id", TEST_ORG).single();
  t("null stores as null", nulled.default_mobilization_hours === null);
  t("null IS treated as unset by the contract", mobilizationUnset(null) === true);

  // ------------------------------------------------ 2. per-estimate settings
  console.log("\n[2] per-estimate labor settings round-trip");
  const { data: est, error: estErr } = await admin.from("estimates")
    .insert({ organization_id: TEST_ORG, title: "ZZ labor e2e" })
    .select("id, status, labor_rate, labor_cost_rate, mobilization_hours").single();
  t("estimate created", !estErr && !!est, estErr?.message);
  if (est) created.estimates.push(est.id);
  t("a new estimate starts with all three unset", est
    && est.labor_rate === null && est.labor_cost_rate === null && est.mobilization_hours === null);

  await admin.from("estimates")
    .update({ labor_rate: 65, labor_cost_rate: 38, mobilization_hours: 1.5 })
    .eq("id", est.id);
  const { data: estAfter } = await admin.from("estimates")
    .select("labor_rate, labor_cost_rate, mobilization_hours").eq("id", est.id).single();
  t("per-estimate settings persist", Number(estAfter.labor_rate) === 65
    && Number(estAfter.mobilization_hours) === 1.5, JSON.stringify(estAfter));

  // ------------------------------------ 3. the math, on REAL database rows
  console.log("\n[3] legend + margin against rows returned by Postgres");
  const { data: species } = await admin.from("plant_products")
    .insert([
      { organization_id: TEST_ORG, name: "ZZ Live Oak", category: "tree", color: "#8b5cf6" },
      { organization_id: TEST_ORG, name: "ZZ Dwarf Holly", category: "shrub", color: "#16a34a" },
    ]).select("id, name, category, color");
  species?.forEach((s) => created.products.push(s.id));
  const oak = species.find((s) => s.name === "ZZ Live Oak");
  const holly = species.find((s) => s.name === "ZZ Dwarf Holly");

  const { data: sizes } = await admin.from("plant_product_sizes").insert([
    { organization_id: TEST_ORG, plant_product_id: oak.id, size: "30 gal", cost: 150, unit_price: 450, install_minutes: 90 },
    { organization_id: TEST_ORG, plant_product_id: holly.id, size: "3 gal", cost: 9.5, unit_price: 38, install_minutes: 8 },
  ]).select("id, plant_product_id, size, cost, unit_price, install_minutes");
  const oakSize = sizes.find((s) => s.plant_product_id === oak.id);
  const hollySize = sizes.find((s) => s.plant_product_id === holly.id);

  // What the coercion actually has to survive. supabase-js gives a number
  // here; a string can still reach `meta` from a form field, so both must work
  // and neither may produce NaN.
  const asNum = readPlantSnapshot({ kind: "point", meta: { plant_product_id: "x", name: "X", cost: 9.5, unit_price: 38 } });
  const asStr = readPlantSnapshot({ kind: "point", meta: { plant_product_id: "x", name: "X", cost: "9.50", unit_price: "38.00" } });
  const asJunk = readPlantSnapshot({ kind: "point", meta: { plant_product_id: "x", name: "X", cost: "abc", unit_price: null } });
  t("supabase-js returns numeric as a number on this path",
    typeof oakSize.cost === "number", `got ${typeof oakSize.cost}`);
  t("coercion accepts the number form", asNum.cost === 9.5 && asNum.unit_price === 38);
  t("coercion accepts the string form", asStr.cost === 9.5 && asStr.unit_price === 38);
  t("garbage degrades to 0, never NaN",
    asJunk.cost === 0 && asJunk.unit_price === 0 && !Number.isNaN(asJunk.cost));

  // Place 4 oaks and 20 hollies as kind='point' rows, exactly as placePlant will.
  const snap = (p, s) => ({
    plant_product_id: p.id, plant_size_id: s.id, name: p.name, botanical_name: null,
    category: p.category, size: s.size, cost: Number(s.cost),
    unit_price: Number(s.unit_price), install_minutes: Number(s.install_minutes),
  });
  const points = [
    ...Array.from({ length: 4 }, () => ({
      estimate_id: est.id, organization_id: TEST_ORG, name: oak.name, color: oak.color,
      polygon: [{ lat: 27.95, lng: -82.45 }], area_sqft: 0, kind: "point", meta: snap(oak, oakSize),
    })),
    ...Array.from({ length: 20 }, () => ({
      estimate_id: est.id, organization_id: TEST_ORG, name: holly.name, color: holly.color,
      polygon: [{ lat: 27.95, lng: -82.45 }], area_sqft: 0, kind: "point", meta: snap(holly, hollySize),
    })),
  ];
  const { error: ptErr } = await admin.from("estimate_areas").insert(points);
  t("24 plant points insert as kind='point'", !ptErr, ptErr?.message);

  // Read them back the way listEstimateAreas does.
  const AREA_COLUMNS =
    "id, estimate_id, name, color, polygon, area_sqft, kind, length_ft, meta, service_type, notes, access_tags, created_at";
  const { data: areas } = await admin.from("estimate_areas")
    .select(AREA_COLUMNS).eq("estimate_id", est.id).order("created_at");
  t("all 24 read back", areas.length === 24, `got ${areas.length}`);
  t("kind survives the round-trip", areas.every((a) => a.kind === "point"));
  t("a point stores exactly one coordinate", areas.every((a) => a.polygon.length === 1));

  const rows = buildPlantLegend(areas);
  t("legend groups to 2 rows", rows.length === 2, JSON.stringify(rows.map((r) => r.name)));
  t("trees sort above shrubs", rows[0].category === "tree");
  t("counts are right", rows[0].count === 4 && rows[1].count === 20);

  const m = estimateMargin(rows, 65, 38, 1.5);
  t("material revenue 2560", near(m.materialRevenue, 2560), `got ${m.materialRevenue}`);
  t("material cost 790", near(m.materialCost, 790), `got ${m.materialCost}`);
  t("planting 8.67 man-hours", near(m.plantManHours, 8.67), `got ${m.plantManHours}`);
  t("total 10.17 man-hours with mobilization", near(m.manHours, 10.17), `got ${m.manHours}`);
  t("labor revenue 661.05", near(m.laborRevenue, 661.05), `got ${m.laborRevenue}`);
  t("total 3221.05", near(m.revenue, 3221.05), `got ${m.revenue}`);
  t("margin 63.5% — matches the handoff", near(m.margin * 100, 63.5, 0.05),
    `got ${(m.margin * 100).toFixed(2)}%`);

  console.log("\n[4] the four warnings, each on its own condition");
  t("mobilization null fires", mobilizationUnset(null) === true);
  t("mobilization 1.5 quiet", mobilizationUnset(1.5) === false);
  t("install times present -> quiet", installTimeUnset(rows) === false);
  t("no billed rate -> margin is material only",
    estimateMargin(rows, null, 38, 1.5).laborPriced === false);
  t("billed rate present -> labor priced", m.laborPriced === true);
  t("big job is not mostly drive time", (mobilizationShare(rows, 1.5) ?? 0) <= 0.5);

  console.log("\n[5] the labor line item");
  const line = laborLineItem(m.manHours, 65, 38);
  t("line quantity is man-hours", near(line.quantity, 10.17));
  t("unit_price is the billed rate", line.unit_price === 65);
  t("internal_cost is PER-UNIT, matching jobProfitability's qty x cost",
    line.internal_cost === 38);
  t("no rate -> null, so no $0 labor line can be added",
    laborLineItem(m.manHours, null, 38) === null);

  console.log("\n[6] RLS is on and denies an unauthenticated write");
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: anonUpd } = await anon.from("organizations")
    .update({ default_labor_rate: 999 }).eq("id", TEST_ORG).select("id");
  t("anon cannot write org labor defaults", !anonUpd || anonUpd.length === 0);
  const { data: stillSet } = await admin.from("organizations")
    .select("default_labor_rate").eq("id", TEST_ORG).single();
  t("the value was not changed by the anon attempt",
    Number(stillSet.default_labor_rate) === 65, `got ${stillSet.default_labor_rate}`);
} finally {
  // ------------------------------------------------------------- cleanup
  console.log("\n[cleanup]");
  for (const id of created.estimates) {
    await admin.from("estimate_areas").delete().eq("estimate_id", id);
    await admin.from("estimates").delete().eq("id", id);
  }
  for (const id of created.products) {
    await admin.from("plant_product_sizes").delete().eq("plant_product_id", id);
    await admin.from("plant_products").delete().eq("id", id);
  }
  if (orgBefore) await admin.from("organizations").update(orgBefore).eq("id", TEST_ORG);
  const { count: leftAreas } = await admin.from("estimate_areas")
    .select("id", { count: "exact", head: true }).eq("organization_id", TEST_ORG).eq("kind", "point");
  const { count: leftProducts } = await admin.from("plant_products")
    .select("id", { count: "exact", head: true }).eq("organization_id", TEST_ORG);
  console.log(`  test rows removed; plant points left in test org: ${leftAreas ?? 0}, catalogue rows: ${leftProducts ?? 0}`);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}
