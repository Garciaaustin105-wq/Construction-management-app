// Browser E2E for the estimator panels — Lane C of the quick-estimator
// handoff (docs/handoff/handoff-ui-lane-c-estimator-panels.md, governed by
// docs/handoff/handoff-ui-state-of-play.md). Runs the REAL workspace at
// /lawn/estimate/[id] against the LIVE database, in Terra Verde Test Co.
//
// THE MAP IS STUBBED — same disclosure as e2e-plant-placement.mjs: the Maps
// key is referrer-restricted to the prod domains and can never render in dev,
// so a window.google.maps stub is injected BEFORE app scripts load and the
// workspace runs its real logic against stub objects. Everything the panels
// touch is real: contract calculators, Supabase writes, optimistic rollback.
// This harness drives PANELS, not the map, so the stub matters even less here
// — the map only has to mount.
//
// Covering the lane's assertions:
//   1. SOD: assign a product to the measured area → gross = net + waste,
//      pallets CEILED UP, leftover shown; the per-job pallet override
//      (500 → 400) re-orders WITHOUT touching the catalogue (REST-proven).
//   2. PIPE: all three figures on screen (straight line floor, routed, total
//      to buy) and the allowances COMPOUND — 30% × 10% is 1.43, not 1.40.
//      Parts' "Use measured pipe" feeds the SAME total the Pipe panel shows.
//   3. DRIP: the head-overlap prompt appears and NOTHING is excluded until a
//      choice; Leave is session-local (prompt returns after reload); Remove
//      persists drip_config.excluded_plant_ids and the prompt stays gone.
//   4. MACHINES: a rented machine 5 days takes "1 week" (cheapest plan) with
//      mobilization once; an owned machine with no hourly cost is WARNED as
//      quoting at zero, not billed silently; needsOperator warning fires with
//      no labor and clears once labor is added.
//   5. EVERY panel add lands in estimate_line_items with a non-null
//      internal_cost — no $0-cost line can hide margin from jobProfitability.
//
// Math used in the assertions (computed here with the SAME formulas as the
// contracts, so the strings must match exactly):
//   pipe: heads 0.001 deg lng apart at lat 27.95 → distanceFt ≈ 322.3 ft
//         30/10 → routed 419.0, total 460.9 (1.30 × 1.10 = 1.43)
//         20/10 → routed 386.8, total 425.4
//   sod:  4,620 sqft + 10% waste → 5,082 gross; ceil(5082/500) = 11 pallets,
//         5,500 bought, 418 left over; override 400 → 13 pallets, 5,200, 118
//   drip: 2 shrubs × rule 2 = 4 emitters; Remove → 2 on 1 plant
//   machines: rented 5 days, daily 150/weekly 450 (price 300/900) → week,
//         revenue 900 + 150 mobilization = 1,050; owned 4 h unpriced → $380
//
// Run (from the repo root — needs the dev server up):
//   npx next dev -p 3007                 # once; .env.local must exist
//   PLAYWRIGHT_DIR=C:/Users/garci_9e2kg3l/Tools/e2e-lawn/node_modules/playwright \
//     node e2e-estimator-panels.mjs
//
// SAFETY: every row is created in Terra Verde Test Co (600d02fa…) and deleted
// at the end. Peanutz L&L is a live customer and is never read or written.
import fs from "node:fs";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  const dir = process.env.PLAYWRIGHT_DIR;
  if (!dir) throw new Error("playwright not resolvable — set PLAYWRIGHT_DIR");
  ({ chromium } = await import(`file://${dir.replace(/\\/g, "/")}/index.mjs`));
}

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const BASE = process.env.E2E_BASE || "http://localhost:3007";
const OFFICE_EMAIL = "e2e-admin-lawn@test.local";
// READ, NEVER HARDCODED. This literal sat in a PUBLIC repo alongside the anon
// key, which together are a complete sign-in for an office-role account. Put
// E2E_PASSWORD in .env.local (gitignored) or the environment.
const E2E_PASSWORD = process.env.E2E_PASSWORD || env.E2E_PASSWORD;
if (!E2E_PASSWORD) {
  throw new Error("E2E_PASSWORD is not set — add it to .env.local or export it.");
}
const ORG = "600d02fa-fae2-440b-99ab-42e96997da91"; // Terra Verde Test Co

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + String(detail).slice(0, 300) : ""}`); }
}

// ---------------------------------------------------------------------------
// Figures, computed with the contracts' own formulas (irrigationProducts
// distanceFt / pipeEstimate, sodProducts sodEstimate) so the asserted strings
// match what the panels render without hard-coding magic numbers.
// ---------------------------------------------------------------------------
const EARTH_R_M = 6371008.8, M_PER_FT = 0.3048;
function distanceFt(a, b) {
  const dLatM = ((b.lat - a.lat) * Math.PI / 180) * EARTH_R_M;
  const dLngM = ((b.lng - a.lng) * Math.PI / 180) * EARTH_R_M *
    Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dLatM, dLngM) / M_PER_FT;
}
const r1 = (n) => Math.round(n * 10) / 10;
// pipeEstimate rounds the straight line, applies routing to THAT, and applies
// waste to the UNROUNDED routed figure — replicate exactly or the strings
// drift by a tenth.
function pipeFigures(routingPct, wastePct) {
  const straight = r1(distanceFt(HEAD1, HEAD2));
  const routed = straight * (1 + routingPct / 100);
  return { straight, routed: r1(routed), total: r1(routed * (1 + wastePct / 100)) };
}
const ftStr = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

const HEAD1 = { lat: 27.95, lng: -82.46 };
const HEAD2 = { lat: 27.95, lng: -82.459 }; // 0.001 deg lng → ≈322.3 ft
const PLANT_IN_THROW = { lat: 27.95003, lng: -82.46 }; // ≈11 ft from HEAD1
const PLANT_OUT = { lat: 27.9503, lng: -82.4595 }; // ≈110 ft, outside 30 ft throw

const LAWN = { lat: 27.9502, lng: -82.4595 };
const SOD_NAME = "E2E St. Augustine";
const MULCH_NAME = "E2E Mulch";
const WIRE_NAME = "E2E Zone Wire";
const TRENCHER_NAME = "E2E Trencher";
const COMPACTOR_NAME = "E2E Plate Compactor";

// 4,620 sqft net + 10% waste → 5,082 gross; 500/pallet → 11 pallets.
const NET_SQFT = 4620, WASTE_PCT = 10;
const GROSS_SQFT = Math.round(NET_SQFT * (1 + WASTE_PCT / 100)); // 5082

// ---------------------------------------------------------------------------
// Catalogue isolation — same discipline as e2e-plant-placement.mjs, extended
// to the five panel catalogues. DEACTIVATE what is there (never delete), run
// against a clean-looking catalogue, reactivate exactly what was hidden.
// Deletes are scoped to E2E-prefixed rows this harness creates.
// ---------------------------------------------------------------------------
const CATALOGUE_TABLES = [
  "sod_products",
  "irrigation_products",
  "irrigation_components",
  "labor_items",
  "equipment_products",
];
async function hideCatalogues() {
  const hidden = [];
  for (const t of CATALOGUE_TABLES) {
    const { data } = await admin.from(t)
      .select("id").eq("organization_id", ORG).eq("active", true);
    const ids = (data ?? []).map((r) => r.id);
    if (ids.length) await admin.from(t).update({ active: false }).in("id", ids);
    hidden.push([t, ids]);
  }
  return hidden;
}
async function restoreCatalogues(hidden) {
  for (const [t, ids] of hidden) {
    if (ids.length) await admin.from(t).update({ active: true }).in("id", ids);
  }
}

// REST reads are service-role; the endpoint throttles rapid-fire probes, so
// pace every read (probe-throttle memory).
async function restEq(table, select, column = "estimate_id") {
  await new Promise((r) => setTimeout(r, 1200));
  const { data, error } = await admin.from(table).select(select).eq(column, estimateId);
  if (error) throw new Error(`rest ${table}: ${error.message}`);
  return data ?? [];
}
async function restAreas() {
  return restEq("estimate_areas", "id, name, kind, area_sqft, meta");
}
async function bodyHas(page, text) {
  const body = await page.locator("body").innerText();
  return body.includes(text);
}

async function login(page, email) {
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: E2E_PASSWORD }),
  });
  if (!r.ok) throw new Error(`password grant ${r.status}`);
  const { access_token, refresh_token } = await r.json();
  await page.goto(`${BASE}/login#access_token=${encodeURIComponent(access_token)}&refresh_token=${encodeURIComponent(refresh_token)}`, {
    waitUntil: "domcontentloaded", timeout: 90_000,
  });
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45_000 });
}

// Injected before app scripts on EVERY navigation: a minimal google.maps
// surface (exactly what LawnMeasurementMap touches) plus a mount flag. Same
// stub as e2e-plant-placement.mjs — this harness never clicks the map, so
// only the mount matters.
const MAP_STUB = `
  window.__e2e = { map: null };
  class E2ELatLng {
    constructor(lat, lng) { this._lat = lat; this._lng = lng; }
    lat() { return this._lat; } lng() { return this._lng; }
  }
  window.google = {
    maps: {
      LatLng: E2ELatLng,
      LatLngBounds: class { extend() {} },
      SymbolPath: { CIRCLE: 0 },
      event: { clearInstanceListeners(m) { m.__listeners = {}; } },
      Geocoder: class { geocode(_o, cb) { cb(null, "ZERO_RESULTS"); } },
      geometry: { spherical: { computeArea: () => 0 } },
      Map: class {
        constructor(_div, _opts) { this.__listeners = {}; window.__e2e.map = this; }
        addListener() {} getZoom() { return 19; } fitBounds() {} setCenter() {}
      },
      Marker: class {
        constructor(opts) { Object.assign(this, opts); this.map = opts.map === undefined ? null : opts.map; }
        addListener() {} setMap(m) { this.map = m; }
      },
      Polygon: class {
        constructor(opts) { Object.assign(this, opts); this.map = opts.map === undefined ? null : opts.map; }
        addListener() {} setMap(m) { this.map = m; }
      },
    },
  };
`;

async function gotoEstimate(page, estimateId) {
  await page.goto(`${BASE}/lawn/estimate/${estimateId}`, {
    waitUntil: "domcontentloaded", timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.__e2e?.map, undefined, { timeout: 30_000 });
  await page.waitForTimeout(2500); // workspace estimate + areas + 5 catalogues
}
async function openTab(page, label) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForTimeout(300);
}

let estimateId = null;
const hiddenCatalogues = [];
try {
  // ---------------- reset: hide the org's real catalogues -------------------
  hiddenCatalogues.push(...await hideCatalogues());
  for (const t of CATALOGUE_TABLES) {
    await admin.from(t).delete().eq("organization_id", ORG).like("name", "E2E%");
  }
  // Belt: nozzles whose product a previous run left behind.
  {
    const { data: e2eProducts } = await admin.from("irrigation_products")
      .select("id").eq("organization_id", ORG).like("name", "E2E%");
    const ids = (e2eProducts ?? []).map((r) => r.id);
    if (ids.length) await admin.from("irrigation_product_nozzles").delete().in("irrigation_product_id", ids);
  }

  // ---------------- seed the five panel catalogues --------------------------
  const { data: sodProd, error: sodErr } = await admin
    .from("sod_products")
    .insert({
      organization_id: ORG, name: SOD_NAME, grass_type: "st_augustine",
      sqft_per_pallet: 500, cost_per_sqft: 0.15, price_per_sqft: 0.45,
      install_minutes_per_1000_sqft: 420, active: true,
    })
    .select("id, sqft_per_pallet")
    .single();
  if (sodErr) throw new Error("sod product insert: " + sodErr.message);

  const { data: rotorProd, error: rotorErr } = await admin
    .from("irrigation_products")
    .insert({ organization_id: ORG, name: "E2E Rotor", category: "rotor", color: "#3b82f6", active: true })
    .select("id")
    .single();
  if (rotorErr) throw new Error("rotor product insert: " + rotorErr.message);
  const { data: rotorNozzle, error: rnErr } = await admin
    .from("irrigation_product_nozzles")
    .insert({
      organization_id: ORG, irrigation_product_id: rotorProd.id, nozzle: "4 ft",
      radius_ft: 30, cost: 2, unit_price: 8, install_minutes: 5, sort_order: 0, active: true,
    })
    .select("id")
    .single();
  if (rnErr) throw new Error("rotor nozzle insert: " + rnErr.message);

  const { data: dripProd, error: dripErr } = await admin
    .from("irrigation_products")
    .insert({ organization_id: ORG, name: "E2E Drip Emitter", category: "drip", color: "#a855f7", active: true })
    .select("id")
    .single();
  if (dripErr) throw new Error("drip product insert: " + dripErr.message);
  const { error: dnErr } = await admin
    .from("irrigation_product_nozzles")
    .insert({
      organization_id: ORG, irrigation_product_id: dripProd.id, nozzle: "1 GPH",
      radius_ft: 0, cost: 0.5, unit_price: 1.5, install_minutes: 2, sort_order: 0, active: true,
    })
    .select("id")
    .single();
  if (dnErr) throw new Error("drip nozzle insert: " + dnErr.message);

  const { error: wireErr } = await admin
    .from("irrigation_components")
    .insert({
      organization_id: ORG, name: WIRE_NAME, category: "wire", unit: "foot",
      cost: 0.2, unit_price: 0.6, install_minutes: 0.5, active: true,
    })
    .select("id")
    .single();
  if (wireErr) throw new Error("component insert: " + wireErr.message);

  const { error: mulchErr } = await admin
    .from("labor_items")
    .insert({
      organization_id: ORG, name: MULCH_NAME, category: "mulch", unit: "cubic_yard",
      cost: 25, unit_price: 75, install_minutes: 32, active: true,
    })
    .select("id")
    .single();
  if (mulchErr) throw new Error("labor item insert: " + mulchErr.message);

  const { error: trErr } = await admin
    .from("equipment_products")
    .insert({
      organization_id: ORG, name: TRENCHER_NAME, category: "trencher", ownership: "rented",
      cost_daily: 150, cost_weekly: 450, price_daily: 300, price_weekly: 900,
      delivery_fee: 75, pickup_fee: 75, operator_required: true,
      active: true, rates_updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (trErr) throw new Error("trencher insert: " + trErr.message);
  const { error: cpErr } = await admin
    .from("equipment_products")
    .insert({
      organization_id: ORG, name: COMPACTOR_NAME, category: "other", ownership: "owned",
      cost_hourly: null, price_hourly: 95, delivery_fee: 0, pickup_fee: 0,
      operator_required: false, active: true, rates_updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (cpErr) throw new Error("compactor insert: " + cpErr.message);

  // ---------------- test estimate + areas the panels read -------------------
  // Plants are seeded DIRECTLY as kind='point' rows with meta snapshots: the
  // contracts narrow meta (plant_product_id + name), so no plant catalogue is
  // needed. install_minutes 0 keeps hasLabor false for the machines phase.
  const SYNTHETIC_PLANT_ID = "11111111-1111-4111-8111-111111111111";
  const PLANT_META = {
    plant_product_id: SYNTHETIC_PLANT_ID, name: "E2E Dwarf Yaupon",
    category: "shrub", size: "3 gal", cost: 9.5, unit_price: 38, install_minutes: 0,
  };
  const HEAD_META = {
    irrigation_product_id: rotorProd.id, irrigation_nozzle_id: rotorNozzle.id,
    name: "E2E Rotor", category: "rotor", nozzle: "4 ft", radius_ft: 30,
    arc_deg: 360, heading_deg: 0, cost: 2, unit_price: 8, install_minutes: 5,
  };

  const { data: est, error: estErr } = await admin
    .from("estimates")
    .insert({ organization_id: ORG, title: "ZZ estimator panels e2e" })
    .select("id, status")
    .single();
  if (estErr) throw new Error("estimate insert: " + estErr.message);
  estimateId = est.id;
  console.log(`estimate ${est.id} (${est.status})`);

  const { error: areaErr } = await admin.from("estimate_areas").insert([
    {
      estimate_id: estimateId, organization_id: ORG,
      name: "E2E Lawn", color: "#22c55e", kind: "area", area_sqft: NET_SQFT, meta: {},
      polygon: [
        { lat: LAWN.lat, lng: -82.46 }, { lat: LAWN.lat, lng: -82.459 },
        { lat: 27.95, lng: -82.459 }, { lat: 27.95, lng: -82.46 },
      ],
    },
    {
      estimate_id: estimateId, organization_id: ORG,
      name: "E2E Plant A", color: "#84cc16", kind: "point", area_sqft: 0,
      polygon: [PLANT_IN_THROW], meta: PLANT_META,
    },
    {
      estimate_id: estimateId, organization_id: ORG,
      name: "E2E Plant B", color: "#84cc16", kind: "point", area_sqft: 0,
      polygon: [PLANT_OUT], meta: PLANT_META,
    },
    {
      estimate_id: estimateId, organization_id: ORG,
      name: "E2E Head 1", color: "#3b82f6", kind: "point", area_sqft: 0,
      polygon: [HEAD1], meta: HEAD_META,
    },
    {
      estimate_id: estimateId, organization_id: ORG,
      name: "E2E Head 2", color: "#3b82f6", kind: "point", area_sqft: 0,
      polygon: [HEAD2], meta: HEAD_META,
    },
  ]);
  if (areaErr) throw new Error("areas insert: " + areaErr.message);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if ((m.location().url || "").includes("challenges.cloudflare.com")) return;
    errors.push("console: " + m.text());
  });
  page.on("dialog", (d) => d.accept().catch(() => {}));
  await page.addInitScript(MAP_STUB);
  await login(page, OFFICE_EMAIL);
  await gotoEstimate(page, estimateId);

  // ================= PHASE A — SOD =========================================
  console.log("\n[A] sod: assign to measured area, pallets ceil up, per-job override");
  await openTab(page, "Sod");
  await page.selectOption('select[aria-label="Area to sod"]', { label: `E2E Lawn (4,620 sq ft)` });
  await page.selectOption('select[aria-label="Sod product"]', { label: SOD_NAME });
  await page.getByRole("button", { name: "Assign sod" }).click();
  const grossStr = GROSS_SQFT.toLocaleString("en-US");
  await page.getByText(`${grossStr} to cover`).first().waitFor({ timeout: 15_000 }).catch(() => {});
  {
    const body = await page.locator("body").innerText();
    check("gross sqft = net + 10% waste (5,082 to cover)", body.includes(`${grossStr} to cover`), body.slice(0, 200));
    check("pallets CEILED UP to 11 (5,082 / 500)", body.includes("Pallets to order") && body.includes("11"), "");
    check("bought sqft and leftover shown (5,500 bought · 418 left over)",
      body.includes("5,500 sq ft bought") && body.includes("418 sq ft left over"), "");
    check("billed on gross at price_per_sqft ($2,286.90)", body.includes("$2,286.90"), "");
  }
  // Per-job pallet override: this delivery came 400/pallet — 13 pallets now.
  // The pallet input is named by a wrapping label (sr-only span), not an
  // aria-label attribute — getByLabel reads the wrapping association.
  const palletInput = page.getByLabel("Pallet size for this job (sq ft per pallet)");
  await palletInput.fill("400");
  await palletInput.blur();
  await page.getByText("118 sq ft left over").first().waitFor({ timeout: 15_000 }).catch(() => {});
  {
    const body = await page.locator("body").innerText();
    check("override 400/pallet re-orders to 13 pallets (5,200 bought · 118 left over)",
      body.includes("118 sq ft left over") && body.includes("5,200 sq ft bought"), "");
  }
  await page.getByRole("button", { name: /Add sod to estimate/ }).click();
  await new Promise((r) => setTimeout(r, 2500));
  let areas = await restAreas();
  let lawnMeta = areas.find((a) => a.name === "E2E Lawn")?.meta ?? {};
  check("REST: sod snapshot written FLAT into area meta (product + pallets + waste + rates)",
    lawnMeta.sod_product_id === sodProd.id && Number(lawnMeta.sqft_per_pallet) === 400 &&
      Number(lawnMeta.waste_pct) === 10 && Number(lawnMeta.price_per_sqft) === 0.45,
    JSON.stringify(lawnMeta));
  {
    const { data: cat } = await admin.from("sod_products")
      .select("sqft_per_pallet").eq("id", sodProd.id).single();
    check("catalogue untouched by the per-job override (still 500 sq ft/pallet)",
      Number(cat?.sqft_per_pallet) === 500, String(cat?.sqft_per_pallet));
  }

  // ================= PHASE B — PIPE ========================================
  console.log("\n[B] pipe: three figures, compounding allowances, Parts feeds off it");
  await openTab(page, "Pipe");
  const f3010 = pipeFigures(30, 10); // the workspace's default allowances
  await page.getByText(`${ftStr(f3010.total)} ft`).first().waitFor({ timeout: 15_000 }).catch(() => {});
  {
    const body = await page.locator("body").innerText();
    check("straight-line floor shown (" + ftStr(f3010.straight) + " ft)", body.includes(`${ftStr(f3010.straight)} ft`), "");
    check("routed figure shown (" + ftStr(f3010.routed) + " ft)", body.includes(`${ftStr(f3010.routed)} ft`), "");
    check("total to buy shown (" + ftStr(f3010.total) + " ft)", body.includes(`${ftStr(f3010.total)} ft`), "");
    // COMPOUNDING: 1.30 × 1.10 = 1.43. An additive 1.40 would read 451.2.
    const additive = r1(f3010.straight * 1.4);
    check("allowances compound (total ≠ additive 1.40 — would be " + ftStr(additive) + " ft)",
      f3010.total !== additive && body.includes(`${ftStr(f3010.total)} ft`), "");
  }
  await page.fill('input[aria-label="Routing allowance percent"]', "20");
  const f2010 = pipeFigures(20, 10);
  await page.getByText(`${ftStr(f2010.total)} ft`).first().waitFor({ timeout: 15_000 }).catch(() => {});
  {
    const body = await page.locator("body").innerText();
    check("changing routing to 20% recomputes routed (" + ftStr(f2010.routed) + ") and total (" + ftStr(f2010.total) + ")",
      body.includes(`${ftStr(f2010.routed)} ft`) && body.includes(`${ftStr(f2010.total)} ft`), "");
  }
  // Parts: the measured pipe footage feeds a foot-priced component.
  await openTab(page, "Parts");
  await page.selectOption('select[aria-label="Component"]', { label: `${WIRE_NAME} (per ft)` });
  const usePipeBtn = page.getByRole("button", { name: new RegExp(`Use measured pipe \\(${ftStr(f2010.total)} ft\\)`) });
  await usePipeBtn.waitFor({ timeout: 15_000 }).catch(() => {});
  check("Parts offers 'Use measured pipe' with the SAME total the Pipe panel shows",
    await usePipeBtn.isVisible().catch(() => false));
  await usePipeBtn.click();
  const qtyInput = page.getByLabel("Quantity — linear feet");
  check("clicking it fills the quantity with the measured pipe footage",
    (await qtyInput.inputValue()) === String(f2010.total), await qtyInput.inputValue());
  await page.getByRole("button", { name: "Add component to estimate" }).click();
  await new Promise((r) => setTimeout(r, 2500));
  let comps = await restEq("estimate_components", "id, snapshot, quantity");
  check("REST: component row on estimate_components with snapshot and measured quantity",
    comps.length === 1 && comps[0].snapshot.name === WIRE_NAME &&
      Math.abs(Number(comps[0].quantity) - f2010.total) < 0.01,
    JSON.stringify(comps));

  // ================= PHASE C — DRIP ========================================
  console.log("\n[C] drip: overlap prompt waits for a choice; Remove persists");
  await openTab(page, "Drip");
  await page.selectOption('select[aria-label="Emitter product"]', { label: "E2E Drip Emitter" });
  // Selecting the product auto-commits emitter + first nozzle.
  await page.getByText(/inside a/).first().waitFor({ timeout: 15_000 }).catch(() => {});
  check("head-overlap prompt appears (1 plant inside the rotor's throw)",
    await page.getByText(/plant is inside a E2E Rotor's throw/).first().isVisible().catch(() => false));
  // Shrub rule: 2 emitters per shrub. Both plants still counted — nothing is
  // excluded until the estimator CHOOSES.
  const shrubRule = page.locator('input[aria-label="Emitters per Shrubs"]');
  await shrubRule.fill("2");
  await shrubRule.blur();
  await page.getByText("4 on 2 plants").first().waitFor({ timeout: 15_000 }).catch(() => {});
  check("rule 2/shrub counts BOTH plants before any choice (4 on 2 plants)",
    await page.getByText("4 on 2 plants").first().isVisible().catch(() => false));
  // LEAVE: session-local. Nothing persisted, prompt dismissed.
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await page.waitForTimeout(500);
  check("Leave dismisses the prompt and removes nothing",
    !(await page.getByText(/plant is inside a/).first().isVisible().catch(() => false)) &&
      await page.getByText("4 on 2 plants").first().isVisible().catch(() => false));
  await gotoEstimate(page, estimateId); // reload: Leave was session-local
  await openTab(page, "Drip");
  await page.getByText(/inside a/).first().waitFor({ timeout: 15_000 }).catch(() => {});
  check("after reload the prompt RETURNS (Leave was session-local by design)",
    await page.getByText(/plant is inside a E2E Rotor's throw/).first().isVisible().catch(() => false));
  // REMOVE: persists the exclusion in drip_config.
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByText("2 on 1 plant").first().waitFor({ timeout: 15_000 }).catch(() => {});
  check("Remove drops the covered plant's emitters (2 on 1 plant)",
    await page.getByText("2 on 1 plant").first().isVisible().catch(() => false));
  await new Promise((r) => setTimeout(r, 2500));
  const { data: estRow } = await admin.from("estimates")
    .select("drip_config").eq("id", estimateId).single();
  let plantAreas = await restAreas();
  const plantA = plantAreas.find((a) => a.name === "E2E Plant A");
  const excluded = Array.isArray(estRow?.drip_config?.excluded_plant_ids)
    ? estRow.drip_config.excluded_plant_ids : [];
  check("REST: drip_config carries emitter, rule and the excluded plant id",
    !!estRow?.drip_config?.emitter && estRow.drip_config.emitter.irrigation_product_id === dripProd.id &&
      Number(estRow.drip_config.per_category?.shrub) === 2 &&
      excluded.length === 1 && excluded[0] === plantA?.id,
    JSON.stringify(estRow?.drip_config));
  await gotoEstimate(page, estimateId); // reload: exclusion must survive
  await openTab(page, "Drip");
  await page.waitForTimeout(1500);
  check("after reload the prompt STAYS GONE for the excluded plant",
    !(await page.getByText(/plant is inside a/).first().isVisible().catch(() => false)));
  check("the exclusion is surfaced, not silent ('1 plant has emitters removed')",
    await page.getByText(/1 plant has emitters removed/).first().isVisible().catch(() => false));
  await page.getByRole("button", { name: /Add drip to estimate/ }).click();
  await new Promise((r) => setTimeout(r, 2500));

  // ================= PHASE D — MACHINES ====================================
  console.log("\n[D] machines: rented takes the week; unpriced owned warns");
  await openTab(page, "Machines");
  await page.selectOption('select[aria-label="Machine"]', { label: `${TRENCHER_NAME} (rented)` });
  await page.getByLabel("Days on the job").fill("5");
  await page.getByRole("button", { name: "Add machine" }).click();
  await page.getByText("1 week", { exact: false }).first().waitFor({ timeout: 15_000 }).catch(() => {});
  {
    const body = await page.locator("body").innerText();
    check("5 rented days takes the cheapest PLAN ('1 week', not '5 days')", body.includes("1 week"), "");
    check("revenue = week price + mobilization ($1,050.00)", body.includes("$1,050.00"), "");
    check("mobilization shown once, separately ($150.00)",
      body.includes("Mobilization (delivery + pickup, once)") && body.includes("$150.00"), "");
  }
  await page.selectOption('select[aria-label="Machine"]', { label: `${COMPACTOR_NAME} (owned)` });
  await page.getByLabel("Hours on the job").fill("4");
  await page.getByRole("button", { name: "Add machine" }).click();
  await page.getByText("No hourly cost set — this machine is quoting at zero").first()
    .waitFor({ timeout: 15_000 }).catch(() => {});
  {
    const body = await page.locator("body").innerText();
    check("owned machine with no hourly cost is WARNED as quoting at zero",
      body.includes("No hourly cost set — this machine is quoting at zero"), "");
    check("totals warning names the profit lie (job looks more profitable than it is)",
      body.includes("quoting at zero — the job will look"), "");
    check("needsOperator warning: machine needs an operator, no labor on the estimate",
      body.includes("needs an operator and there is no labor"), "");
  }
  await page.getByRole("button", { name: /Add equipment to estimate/ }).click();
  await new Promise((r) => setTimeout(r, 2500));
  let equip = await restEq("estimate_equipment", "id, snapshot, quantity, hours, days");
  check("REST: two estimate_equipment rows — days on the rented, hours on the owned",
    equip.length === 2 &&
      equip.some((r) => r.snapshot.name === TRENCHER_NAME && Number(r.days) === 5 && Number(r.hours) === 0) &&
      equip.some((r) => r.snapshot.name === COMPACTOR_NAME && Number(r.hours) === 4 && Number(r.days) === 0),
    JSON.stringify(equip.map((r) => [r.snapshot.name, r.hours, r.days])));

  // ================= PHASE E — LABOR =======================================
  console.log("\n[E] labor: row + billable line from one call");
  await openTab(page, "Labor");
  await page.selectOption('select[aria-label="Labor item"]', { label: `${MULCH_NAME} (CY)` });
  await page.getByLabel("Quantity — cubic yards").fill("2");
  await page.getByText("$150.00 (cost $50.00)").first().waitFor({ timeout: 15_000 }).catch(() => {});
  check("preview bills 2 × $75 with the unit in the basis (2 cu yd)",
    await page.getByText("$150.00 (cost $50.00)").first().isVisible().catch(() => false));
  await page.getByRole("button", { name: "Add labor item to estimate" }).click();
  await page.waitForTimeout(2500);
  const laborRows = await restEq("estimate_labor_items", "id, snapshot, quantity");
  check("REST: estimate_labor_items row with full snapshot and quantity 2",
    laborRows.length === 1 && laborRows[0].snapshot.name === MULCH_NAME &&
      Number(laborRows[0].snapshot.unit_price) === 75 && Number(laborRows[0].quantity) === 2,
    JSON.stringify(laborRows));

  // needsOperator flips OFF now that labor exists.
  await openTab(page, "Machines");
  await page.waitForTimeout(500);
  check("needsOperator warning gone once labor exists on the estimate",
    !(await page.getByText("needs an operator and there is no labor").first().isVisible().catch(() => false)));

  // ================= PHASE F — RELOAD PERSISTENCE ==========================
  console.log("\n[F] reload: rows and snapshots survive");
  await gotoEstimate(page, estimateId);
  await openTab(page, "Machines");
  await page.getByText("1 week", { exact: false }).first().waitFor({ timeout: 15_000 }).catch(() => {});
  check("machines rows survive a reload (rented still '1 week')",
    await page.getByText("1 week", { exact: false }).first().isVisible().catch(() => false));
  await openTab(page, "Labor");
  check("labor row survives a reload (2 cu yd)", await bodyHas(page, "2 cu yd"));
  await openTab(page, "Sod");
  check("sod assignment survives a reload (13 pallets after the override)",
    await bodyHas(page, "Pallets to order") && (await page.locator("body").innerText()).includes("118 sq ft left over"));

  // ================= PHASE G — LINE ITEMS ==================================
  console.log("\n[G] every panel add produced one line with non-null internal_cost");
  const lines = await restEq("estimate_line_items",
    "description, quantity, unit, unit_price, internal_cost");
  check("six billable lines exist (sod, wire, drip, 2 machines, labor)",
    lines.length === 6, JSON.stringify(lines.map((l) => l.description)));
  check("NO line has null internal_cost — nothing hides margin from jobProfitability",
    lines.length > 0 && lines.every((l) => l.internal_cost !== null),
    JSON.stringify(lines.filter((l) => l.internal_cost === null)));
  const sodLine = lines.find((l) => (l.description ?? "").includes(`${SOD_NAME} sod`));
  check("sod line: gross sqft billed, per-sqft money",
    !!sodLine && Number(sodLine.quantity) === GROSS_SQFT && sodLine.unit === "SF" &&
      Number(sodLine.unit_price) === 0.45 && Number(sodLine.internal_cost) === 0.15,
    JSON.stringify(sodLine));
  const wireLine = lines.find((l) => (l.description ?? "").includes(WIRE_NAME));
  check("component line: measured pipe quantity, per-unit money",
    !!wireLine && Math.abs(Number(wireLine.quantity) - f2010.total) < 0.01 &&
      Number(wireLine.unit_price) === 0.6 && Number(wireLine.internal_cost) === 0.2,
    JSON.stringify(wireLine));
  const dripLine = lines.find((l) => (l.description ?? "").includes("drip emitters"));
  check("drip line: 2 emitters after the Remove, per-emitter money",
    !!dripLine && Number(dripLine.quantity) === 2 && Number(dripLine.unit_price) === 1.5 &&
      Number(dripLine.internal_cost) === 0.5,
    JSON.stringify(dripLine));
  const mulchLine = lines.find((l) => (l.description ?? "").includes(MULCH_NAME));
  check("labor line: quantity IS the unit count, per-unit money",
    !!mulchLine && Number(mulchLine.quantity) === 2 && Number(mulchLine.unit_price) === 75 &&
      Number(mulchLine.internal_cost) === 25,
    JSON.stringify(mulchLine));
  const equipLines = lines.filter((l) => l.unit === "LOT");
  check("equipment lines: one LOT line per machine, whole-charge money",
    equipLines.length === 2 &&
      equipLines.some((l) => (l.description ?? "").includes(TRENCHER_NAME) && Number(l.internal_cost) === 600) &&
      equipLines.some((l) => (l.description ?? "").includes(COMPACTOR_NAME) && Number(l.internal_cost) === 0),
    JSON.stringify(equipLines));

  check("no page errors during the run", errors.length === 0, errors.join(" | "));

  await browser.close();
} catch (fatal) {
  // process.exit in the finally block would discard this — print it first.
  fail++;
  console.error("FATAL:", fatal && fatal.stack ? fatal.stack : fatal);
} finally {
  // Cleanup: test org only. Children first, then areas, then the estimate.
  // process.exit MUST come after this block (see e2e-plant-placement.mjs).
  if (estimateId) {
    await admin.from("estimate_line_items").delete().eq("estimate_id", estimateId);
    await admin.from("estimate_equipment").delete().eq("estimate_id", estimateId);
    await admin.from("estimate_labor_items").delete().eq("estimate_id", estimateId);
    await admin.from("estimate_components").delete().eq("estimate_id", estimateId);
    await admin.from("estimate_areas").delete().eq("estimate_id", estimateId);
    await admin.from("estimates").delete().eq("id", estimateId);
  }
  // Scoped to THIS harness's rows (E2E-prefixed names), never to the org.
  {
    const { data: e2eProducts } = await admin.from("irrigation_products")
      .select("id").eq("organization_id", ORG).like("name", "E2E%");
    const ids = (e2eProducts ?? []).map((r) => r.id);
    if (ids.length) await admin.from("irrigation_product_nozzles").delete().in("irrigation_product_id", ids);
  }
  for (const t of CATALOGUE_TABLES) {
    await admin.from(t).delete().eq("organization_id", ORG).like("name", "E2E%");
  }
  await restoreCatalogues(hiddenCatalogues);
  console.log("\ncleanup: E2E rows removed; the org's real catalogues are restored");
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}