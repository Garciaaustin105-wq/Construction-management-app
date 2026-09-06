// Browser E2E for sprinkler-head placement on the measurement map (Lane B of
// the UI handoff: docs/handoff/handoff-ui-lane-b-heads-on-map.md). Runs the
// REAL workspace at /lawn/estimate/[id] against the LIVE database, in Terra
// Verde Test Co. Isolation + stub discipline copied from e2e-plant-placement
// .mjs — read its header comment for the full MAP_STUB rationale.
//
// THE MAP IS STUBBED (same as the plant harness): NEXT_PUBLIC_GOOGLE_MAPS_API
// _KEY is referrer-restricted and can never render tiles in dev, so the
// harness injects a window.google.maps stub BEFORE app scripts load. This
// harness EXTENDS the plant harness's stub with google.maps.Circle — head
// coverage for a 360 draws a Circle, which the plant stub never needed. All
// DB-side behaviour is REAL.
//
// Covering the Lane B Verify section:
//   1. three heads → three kind='point' rows with a FULL head snapshot
//      (ids + name + nozzle + radius + arc + heading + price + minutes)
//   2. they survive a reload
//   3. a head does not render as a plant and a plant does not render as a
//      head (distinct marker signatures, distinct inspect cards)
//   4. a 360 draws a circle; a 90 draws a polygon with STRAIGHT EDGES (the
//      ring starts at the centre) plus the arc
//   5. radius_ft 0 draws no coverage at all — marker yes, shape no
//   6. two rapid clicks in one spot make ONE head (the useRef double-place
//      guard, both clicks synchronous in one evaluate)
// Plus, because the lane scope demands them:
//   - the pressure-test prompt renders BEFORE layout (working psi 30 → the
//     contract's "BELOW the 45 psi" verdict verbatim), and the form saves
//   - describeCoverage lines render verbatim per measured area: reached %,
//     overlap %, and the pressure caveat — no invented single score
//   - part-circle rotate (±45°) persists heading_deg via whole-meta RMW
//   - per-placement note survives with the snapshot fields intact
//   - delete head removes the row and the marker
//
// Run (from the repo root — needs the dev server up):
//   npx next dev -p 3007                 # once; .env.local must exist
//   PLAYWRIGHT_DIR=C:/Users/garci_9e2kg3l/Tools/e2e-lawn/node_modules/playwright \
//     node e2e-head-placement.mjs
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

const HEAD_MODEL = "E2E Rotor Pro";
const HEAD_ZERO = "E2E Zero Throw";
const SPECIES = "E2E Dwarf Yaupon";
const BOTANICAL = "Ilex v. 'Nana'";

// REST reads are service-role; the endpoint throttles rapid-fire probes, so
// pace every read (probe-throttle memory) and probe ONE table per read.
async function restAreas(estimateId) {
  await new Promise((r) => setTimeout(r, 1200));
  const { data, error } = await admin
    .from("estimate_areas")
    .select("id, name, color, polygon, area_sqft, kind, meta")
    .eq("estimate_id", estimateId)
    .order("created_at");
  if (error) throw new Error("rest areas read: " + error.message);
  return data ?? [];
}

async function restEstimate(estimateId) {
  await new Promise((r) => setTimeout(r, 1200));
  const { data, error } = await admin
    .from("estimates")
    .select("pressure_static_psi, pressure_working_psi, pressure_gpm, pressure_tested_at, pressure_notes")
    .eq("id", estimateId)
    .single();
  if (error) throw new Error("rest estimate read: " + error.message);
  return data;
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

// Injected before app scripts on EVERY navigation — the plant harness's stub
// plus google.maps.Circle (head coverage for a 360 draws one) and head-aware
// counters. The marker SIGNATURES matter, and they are the whole proof of
// assertion 3:
//   plant marker → cursor "pointer", icon fill COLOURED, stroke "#ffffff"
//   head marker  → cursor "pointer", icon fill "#ffffff", stroke COLOURED
//   vertex handles are cursor "move"; gap dots carry no cursor at all —
//   so the two counters below cannot count each other's kind.
const MAP_STUB = `
  window.__e2e = { markers: [], polys: [], circles: [], mapClickListeners: [], map: null };
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
        addListener(type, fn) {
          if (type === "click") window.__e2e.mapClickListeners.push(fn);
          (this.__listeners[type] = this.__listeners[type] || []).push(fn);
        }
        getZoom() { return 19; } fitBounds() {} setCenter() {}
      },
      Marker: class {
        constructor(opts) {
          Object.assign(this, opts);
          this.__listeners = {};
          this.map = opts.map === undefined ? null : opts.map;
          window.__e2e.markers.push(this);
        }
        addListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); }
        setMap(m) { this.map = m; }
      },
      Polygon: class {
        constructor(opts) {
          Object.assign(this, opts);
          this.__listeners = {};
          this.map = opts.map === undefined ? null : opts.map;
          window.__e2e.polys.push(this);
        }
        addListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); }
        setMap(m) { this.map = m; }
      },
      Circle: class {
        constructor(opts) {
          Object.assign(this, opts);
          this.__listeners = {};
          this.map = opts.map === undefined ? null : opts.map;
          window.__e2e.circles.push(this);
        }
        addListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); }
        setMap(m) { this.map = m; }
      },
    },
  };
  window.__e2eMapClick = (lat, lng) => {
    const ev = { latLng: { lat: () => lat, lng: () => lng } };
    [...window.__e2e.mapClickListeners].forEach((f) => f(ev));
  };
  // Live plant markers: owned by the map + plant signature (white STROKE).
  window.__e2ePlantMarkerCount = () =>
    window.__e2e.markers.filter((m) => m.map && m.cursor === "pointer" &&
      m.icon && m.icon.strokeColor === "#ffffff" && m.icon.fillColor !== "#ffffff").length;
  // Live head markers: owned by the map + head signature (white FILL).
  window.__e2eHeadMarkerCount = () =>
    window.__e2e.markers.filter((m) => m.map && m.cursor === "pointer" &&
      m.icon && m.icon.fillColor === "#ffffff").length;
  // Coverage shapes the map still owns: circles + coverage polygons (the
  // 0.15-fill signature; static/draft polygons use 0.3/0.35).
  window.__e2eShapeCount = () =>
    window.__e2e.circles.filter((c) => c.map).length +
    window.__e2e.polys.filter((p) => p.map && p.fillOpacity === 0.15).length;
  window.__e2eGapDotCount = () =>
    window.__e2e.markers.filter((m) => m.map && m.icon && m.icon.fillColor === "#b45309").length;
  const plantMarkers = () =>
    window.__e2e.markers.filter((m) => m.map && m.cursor === "pointer" &&
      m.icon && m.icon.strokeColor === "#ffffff" && m.icon.fillColor !== "#ffffff");
  const headMarkers = () =>
    window.__e2e.markers.filter((m) => m.map && m.cursor === "pointer" &&
      m.icon && m.icon.fillColor === "#ffffff");
  window.__e2eMarkerClick = (i) => {
    (plantMarkers()[i].__listeners.click || []).forEach((f) => f({}));
  };
  window.__e2eHeadMarkerClick = (i) => {
    (headMarkers()[i].__listeners.click || []).forEach((f) => f({}));
  };
  // Index of the head marker whose title contains the given text (-1 absent).
  window.__e2eHeadMarkerIndex = (text) =>
    headMarkers().findIndex((m) => (m.title || "").includes(text));
`;

async function gotoEstimate(page, estimateId) {
  await page.goto(`${BASE}/lawn/estimate/${estimateId}`, {
    waitUntil: "domcontentloaded", timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.__e2e?.map, undefined, { timeout: 30_000 });
  await page.waitForTimeout(2500);
}

// ---------------------------------------------------------------------------
// Catalogue isolation — DEACTIVATE the org's real head models for the run,
// delete only E2E-prefixed leftovers from earlier runs, restore on success
// AND failure. Nozzles go first by irrigation_product_id — no FK-cascade
// reliance (same as e2e-irrigation-catalogue.mjs).
// ---------------------------------------------------------------------------
async function hideExistingCatalogue(ORG) {
  const { data } = await admin.from("irrigation_products")
    .select("id").eq("organization_id", ORG).eq("active", true);
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length) await admin.from("irrigation_products").update({ active: false }).in("id", ids);
  return ids;
}
async function restoreCatalogue(ids) {
  if (ids?.length) await admin.from("irrigation_products").update({ active: true }).in("id", ids);
}
async function deleteE2eRows() {
  const { data } = await admin.from("irrigation_products")
    .select("id").eq("organization_id", ORG).like("name", "E2E%");
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length) {
    await admin.from("irrigation_product_nozzles").delete().in("irrigation_product_id", ids);
    await admin.from("irrigation_products").delete().in("id", ids);
  }
}

// Module scope on purpose: a crash mid-run must still be able to restore what
// was hidden, or the org is left with an invisible catalogue.
let hiddenModelIds = [];
const createdEstimates = [];

async function main() {
  try {
    hiddenModelIds = await hideExistingCatalogue(ORG);
    await deleteE2eRows();
  // The test plant species from earlier runs (plant catalogue itself is NOT
  // hidden — the plant picker just needs one E2E species to place).
  await admin.from("plant_products").delete().eq("organization_id", ORG).like("name", "E2E%");

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

  // ---------------- test estimate + one real polygon area ----------------
  const { data: est, error: estErr } = await admin
    .from("estimates")
    .insert({ organization_id: ORG, title: "ZZ head placement e2e" })
    .select("id, status")
    .single();
  if (estErr) throw new Error("estimate insert: " + estErr.message);
  createdEstimates.push(est.id);
  console.log(`estimate ${est.id} (${est.status})`);

  const POLY = [
    { lat: 27.95, lng: -82.46 },
    { lat: 27.9502, lng: -82.46 },
    { lat: 27.9502, lng: -82.4596 },
    { lat: 27.95, lng: -82.4596 },
  ];
  const { error: polyErr } = await admin.from("estimate_areas").insert({
    estimate_id: est.id,
    organization_id: ORG,
    name: "E2E Front Yard",
    color: "#22c55e",
    polygon: POLY,
    area_sqft: 1000,
    kind: "area",
  });
  if (polyErr) throw new Error("polygon insert: " + polyErr.message);
  // A site that HAS been tested — but at 30 psi working, i.e. BELOW the 45 the
  // catalogue radii assume. The verdict line must say so, verbatim.
  const { error: pErr } = await admin.from("estimates").update({
    pressure_static_psi: 52,
    pressure_working_psi: 30,
    pressure_gpm: 9.5,
    pressure_notes: "hose bib, all zones open",
  }).eq("id", est.id);
  if (pErr) throw new Error("pressure seed: " + pErr.message);

  // ================= PHASE A — pressure prompt BEFORE layout ================
  console.log("\n[A] pressure prompt renders before any layout");
  await gotoEstimate(page, est.id);
  const below = page.getByText("is 15 psi BELOW the 45 psi", { exact: false }).first();
  await below.waitFor({ timeout: 20_000 }).catch(() => {});
  check(
    "pressure verdict renders verbatim (30 psi working, 15 psi below 45)",
    await below.isVisible().catch(() => false)
  );
  check(
    "static-only note absent (working pressure recorded)",
    !(await page.getByText("no WORKING pressure", { exact: false }).first().isVisible().catch(() => false))
  );

  // ================= PHASE B — seed catalogue, arm placement ================
  console.log("\n[B] catalogue seeded; model→nozzle arms head placement");
  const { data: model, error: mErr } = await admin
    .from("irrigation_products")
    .insert({ organization_id: ORG, name: HEAD_MODEL, category: "rotor", color: "#0ea5e9" })
    .select("id")
    .single();
  if (mErr) throw new Error("model insert: " + mErr.message);
  const { data: zeroModel, error: zErr } = await admin
    .from("irrigation_products")
    .insert({ organization_id: ORG, name: HEAD_ZERO, category: "spray", color: "#f97316" })
    .select("id")
    .single();
  if (zErr) throw new Error("zero model insert: " + zErr.message);
  const nozzle15 = "E2E 15 ft nozzle";
  const { data: nz15, error: n15Err } = await admin
    .from("irrigation_product_nozzles")
    .insert({
      organization_id: ORG, irrigation_product_id: model.id, nozzle: nozzle15,
      radius_ft: 15, cost: 1.2, unit_price: 5, install_minutes: 3, sort_order: 0,
    })
    .select("id")
    .single();
  if (n15Err) throw new Error("nozzle 15 insert: " + n15Err.message);
  const { data: nz0, error: n0Err } = await admin
    .from("irrigation_product_nozzles")
    .insert({
      organization_id: ORG, irrigation_product_id: zeroModel.id, nozzle: "E2E unrecorded",
      radius_ft: 0, cost: 0.5, unit_price: 2, install_minutes: 1, sort_order: 0,
    })
    .select("id")
    .single();
  if (n0Err) throw new Error("zero nozzle insert: " + n0Err.message);

  await gotoEstimate(page, est.id); // reload so the catalogue fetch picks up
  const modelSelect = page.locator('select[aria-label="Head model"]');
  check("head picker renders with the seeded catalogue", await modelSelect.isVisible().catch(() => false));

  await page.selectOption('select[aria-label="Head model"]', model.id);
  // describeThrow spells out BOTH numbers in the option label.
  const nozzleLabel = await page
    .locator('select[aria-label="Head nozzle"] option', { hasText: nozzle15 })
    .textContent();
  check(
    "nozzle option spells out radius AND diameter (describeThrow)",
    !!nozzleLabel && nozzleLabel.includes("15 ft from the head") && nozzleLabel.includes("30 ft across"),
    nozzleLabel ?? ""
  );
  await page.selectOption('select[aria-label="Head nozzle"]', nz15.id);
  await page.getByText("Tap the map to place one").waitFor({ timeout: 10_000 });
  check("selecting a nozzle enters placement mode (sticky banner)", true);

  // ================= PHASE C — place a 360, then a 90, then radius 0 ========
  console.log("\n[C] three heads placed via map taps");
  // Head 1: default arc (360) → coverage draws a google.maps.Circle.
  await page.evaluate(() => window.__e2eMapClick(27.95005, -82.4599));
  await page.waitForFunction(() => window.__e2eHeadMarkerCount() === 1, undefined, { timeout: 20_000 });
  check("first tap places a head marker", true);
  check("360 head draws ONE circle", (await page.evaluate(() => window.__e2eShapeCount())) === 1,
    `shapes: ${await page.evaluate(() => window.__e2eShapeCount())}`);

  // Head 2: change the arc to 90 WHILE armed → coverage draws the pie-slice
  // polygon: straight edges from the centre, so the ring STARTS at the head.
  await page.selectOption('select[aria-label="Spray arc"]', "90");
  await page.evaluate(() => window.__e2eMapClick(27.95015, -82.4597));
  await page.waitForFunction(() => window.__e2eHeadMarkerCount() === 2, undefined, { timeout: 20_000 });
  const slice = await page.evaluate(() => {
    const p = window.__e2e.polys.find(
      (q) => q.map && q.fillOpacity === 0.15 && q.paths && q.paths.length
    );
    return p ? { len: p.paths.length, lat0: p.paths[0]._lat, lng0: p.paths[0]._lng } : null;
  });
  check("90 head draws a coverage polygon (not a circle)",
    !!slice && (await page.evaluate(() => window.__e2e.circles.filter((c) => c.map).length)) === 1,
    JSON.stringify(slice));
  check(
    "90 ring starts AT the head (straight edge drawn) with the arc sampled after it",
    !!slice && slice.len >= 10 &&
      Math.abs(slice.lat0 - 27.95015) < 1e-6 && Math.abs(slice.lng0 - -82.4597) < 1e-6,
    JSON.stringify(slice)
  );

  // Head 3: the radius-0 nozzle. Stop placing first, re-arm with the other
  // model (the banner replaced the selects while armed).
  await page.getByRole("button", { name: "Done placing" }).click();
  await page.waitForTimeout(300);
  await page.selectOption('select[aria-label="Head model"]', zeroModel.id);
  await page.selectOption('select[aria-label="Head nozzle"]', { index: 1 });
  await page.getByText("Tap the map to place one").waitFor({ timeout: 10_000 });
  await page.evaluate(() => window.__e2eMapClick(27.9501, -82.4598));
  await page.waitForFunction(() => window.__e2eHeadMarkerCount() === 3, undefined, { timeout: 20_000 });
  const shapesAfterZero = await page.evaluate(() => window.__e2eShapeCount());
  check("radius_ft 0 head: marker yes, coverage NO (still 2 shapes)",
    shapesAfterZero === 2, `shapes: ${shapesAfterZero}`);

  let rows = await restAreas(est.id);
  let heads = rows.filter((r) => r.kind === "point" && r.meta?.irrigation_product_id);
  check("REST: three kind='point' head rows exist",
    heads.length === 3 && rows.filter((r) => r.kind === "area").length === 1,
    JSON.stringify(rows.map((r) => [r.kind, r.name])));

  // ================= FULL SNAPSHOT PROOF ====================================
  const byRadius = (ft) => heads.find((h) => Number(h.meta?.radius_ft) === ft);
  const h360 = heads.find((h) => h.meta?.arc_deg === 360);
  const h90 = heads.find((h) => h.meta?.arc_deg === 90);
  check("one-coordinate polygon on every head row",
    heads.every((h) => Array.isArray(h.polygon) && h.polygon.length === 1));
  check(
    "FULL head snapshot in meta (ids, nozzle, radius, arc, heading, price, minutes)",
    !!h360 && !!h90 &&
      h360.meta.irrigation_product_id === model.id && h360.meta.irrigation_nozzle_id === nz15.id &&
      h360.meta.name === HEAD_MODEL && h360.meta.nozzle === nozzle15 &&
      h360.meta.heading_deg === 0 && Number(h360.meta.cost) === 1.2 &&
      Number(h360.meta.unit_price) === 5 && Number(h360.meta.install_minutes) === 3 &&
      h90.meta.category === "rotor",
    JSON.stringify([h360?.meta, h90?.meta])
  );
  const hZero = byRadius(0);
  check("radius-0 head stored with radius_ft 0 (never silently corrected)",
    !!hZero && Number(hZero.meta.radius_ft) === 0 && hZero.meta.irrigation_nozzle_id === nz0.id,
    JSON.stringify(hZero?.meta));

  // ================= COVERAGE LINES, VERBATIM ===============================
  // NOTE: the area NAME lives in an input value, which textContent never
  // returns — match against body innerText, not the list item.
  const bodyText = (await page.locator("body").textContent().catch(() => "")) ?? "";
  check(
    "coverage report shows the reached percentage",
    /inside at least one head's throw/.test(bodyText) &&
      /% of [\d,]+ sq ft is inside at least one head's throw/.test(bodyText),
    bodyText.slice(bodyText.indexOf("inside at least") - 120, bodyText.indexOf("inside at least") + 160)
  );
  check(
    "coverage report shows the OVERLAP percentage too (both numbers, never one score)",
    /is reached by two or more heads/.test(bodyText),
    bodyText.slice(bodyText.indexOf("reached by two") - 80, bodyText.indexOf("reached by two") + 160)
  );
  check(
    "the pressure caveat renders verbatim with the coverage",
    bodyText.includes("lower pressure throws shorter"),
    ""
  );
  const gapInfo = await page.evaluate(() => ({
    dots: window.__e2eGapDotCount(),
    hasGapLine: /not reached by any head/.test(document.body.innerText),
  }));
  check(
    "gap points are marked on the map when the report reports gaps",
    !gapInfo.hasGapLine || gapInfo.dots > 0,
    JSON.stringify(gapInfo)
  );

  // ================= HEAD ≠ PLANT ===========================================
  console.log("\n[D] a head does not render as a plant and vice versa");
  const { data: species, error: spErr } = await admin
    .from("plant_products")
    .insert({ organization_id: ORG, name: SPECIES, botanical_name: BOTANICAL, category: "shrub", color: "#a855f7" })
    .select("id")
    .single();
  if (spErr) throw new Error("species insert: " + spErr.message);
  const { data: size, error: szErr } = await admin
    .from("plant_product_sizes")
    .insert({
      organization_id: ORG, plant_product_id: species.id,
      size: "3 gal", cost: 9.5, unit_price: 38, install_minutes: 20, sort_order: 0,
    })
    .select("id")
    .single();
  if (szErr) throw new Error("size insert: " + szErr.message);

  await gotoEstimate(page, est.id); // reload so the plant catalogue fetch picks up
  await page.selectOption('select[aria-label="Plant species"]', species.id);
  await page.selectOption('select[aria-label="Plant size"]', { label: "3 gal — $38.00" });
  await page.getByText("Tap the map to place one").waitFor({ timeout: 10_000 });
  await page.evaluate(() => window.__e2eMapClick(27.95012, -82.45985));
  await page.waitForFunction(() => window.__e2ePlantMarkerCount() === 1, undefined, { timeout: 20_000 });
  check("plant placed: exactly 1 plant marker", true);
  const headCountMixed = await page.evaluate(() => window.__e2eHeadMarkerCount());
  check("the plant did NOT render as a head (head count unchanged at 3)",
    headCountMixed === 3, `heads: ${headCountMixed}`);
  const plantCountMixed = await page.evaluate(() => window.__e2ePlantMarkerCount());
  check("the heads do NOT render as plants (plant count exactly 1)",
    plantCountMixed === 1, `plants: ${plantCountMixed}`);

  // Inspect cards discriminate too: head marker → "Delete head"; plant
  // marker → "Delete plant".
  await page.evaluate(() => window.__e2eHeadMarkerClick(0));
  await page.getByRole("button", { name: "Delete head" }).waitFor({ timeout: 10_000 });
  check("clicking a head marker opens the HEAD card", true);
  await page.evaluate(() => window.__e2eMarkerClick(0));
  await page.getByRole("button", { name: "Delete plant" }).waitFor({ timeout: 10_000 });
  check("clicking a plant marker opens the PLANT card", true);

  // ================= RELOAD — assertion 2 ===================================
  console.log("\n[E] reload: heads, markers and coverage survive");
  await gotoEstimate(page, est.id);
  await page.waitForFunction(() => window.__e2eHeadMarkerCount() === 3, undefined, { timeout: 20_000 });
  check("all three head markers render and SURVIVE A PAGE RELOAD", true);
  check("plant marker survives the reload too",
    (await page.evaluate(() => window.__e2ePlantMarkerCount())) === 1);
  check("coverage shapes survive the reload (1 circle + 1 slice, radius-0 draws none)",
    (await page.evaluate(() => window.__e2eShapeCount())) === 2);

  // ================= PRESSURE FORM ==========================================
  console.log("\n[F] pressure test form saves through the UI");
  await page.getByRole("button", { name: "Edit pressure test" }).click();
  await page.locator('input[aria-label="Working pressure psi"]').fill("48");
  await page.locator('input[aria-label="Static pressure psi"]').fill("55");
  await page.getByRole("button", { name: "Save test" }).click();
  await page.getByText("Pressure test saved").waitFor({ timeout: 15_000 }).catch(() => {});
  const estRow = await restEstimate(est.id);
  check("REST: working psi saved to the estimate (48)",
    Number(estRow.pressure_working_psi) === 48, JSON.stringify(estRow));
  check("REST: pressure_tested_at stamped", !!estRow.pressure_tested_at);
  const atOrAbove = page.getByText("at or above the 45 psi", { exact: false }).first();
  await atOrAbove.waitFor({ timeout: 15_000 }).catch(() => {});
  check("verdict flips to 'at or above' after the save", await atOrAbove.isVisible().catch(() => false));

  // ================= ROTATE + NOTE + DELETE =================================
  console.log("\n[G] rotate a part circle, note, delete");
  await page.evaluate((t) => window.__e2eHeadMarkerClick(window.__e2eHeadMarkerIndex(t)), "90°");
  await page.getByRole("button", { name: "Delete head" }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Rotate head 45 degrees right" }).click();
  await new Promise((r) => setTimeout(r, 2000));
  let rotated = (await restAreas(est.id)).find((r) => r.meta?.arc_deg === 90);
  check("±45° rotate persists heading_deg 45 (whole-meta RMW)",
    Number(rotated?.meta?.heading_deg) === 45 && rotated.meta.unit_price === 5,
    JSON.stringify(rotated?.meta));
  await page.fill('input[aria-label="Placement note"]', "corner, throw toward driveway");
  await page.locator('input[aria-label="Placement note"]').blur();
  await new Promise((r) => setTimeout(r, 2000));
  const noted = (await restAreas(est.id)).find((r) => r.meta?.arc_deg === 90);
  check("head note persists AND snapshot fields survive the meta write",
    noted?.meta?.note === "corner, throw toward driveway" && Number(noted.meta.radius_ft) === 15,
    JSON.stringify(noted?.meta));

  // ================= DOUBLE-PLACE GUARD (assertion 6) =======================
  console.log("\n[H] double-place guard: two rapid clicks, one spot");
  // Re-arm head placement: the mode does not survive a reload, and the
  // delete in [G] did not touch it — without this the two clicks land on
  // nothing and the guard is never exercised.
  await page.selectOption('select[aria-label="Head model"]', model.id);
  await page.selectOption('select[aria-label="Head nozzle"]', nz15.id);
  await page.getByText("Tap the map to place one").waitFor({ timeout: 10_000 });
  await page.evaluate(() => {
    window.__e2eMapClick(27.95018, -82.4596);
    window.__e2eMapClick(27.95018, -82.4596);
  });
  await page.waitForFunction(() => window.__e2eHeadMarkerCount() === 4, undefined, { timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 1500)); // let any stray second write land
  rows = await restAreas(est.id);
  heads = rows.filter((r) => r.kind === "point" && r.meta?.irrigation_product_id);
  check("two rapid clicks in the same spot create ONE head, not two", heads.length === 4,
    `head rows: ${heads.length}`);

  // ================= DELETE =================================================
  console.log("\n[I] delete a head");
  await page.evaluate((t) => window.__e2eHeadMarkerClick(window.__e2eHeadMarkerIndex(t)), "90°");
  await page.getByRole("button", { name: "Delete head" }).click();
  await page.waitForFunction(() => window.__e2eHeadMarkerCount() === 3, undefined, { timeout: 20_000 });
  check("deleted head's marker is gone", true);
  check("REST: deleted row is gone",
    (await restAreas(est.id)).filter((r) => r.meta?.irrigation_product_id).length === 3);

  check("no page errors during the run", errors.length === 0, errors.join(" | "));

  await browser.close();
} finally {
  // Cleanup: test org only. Nozzles first (no cascade reliance), then the
  // models, the E2E plant species, and the estimate + its areas.
  try {
    await deleteE2eRows();
    await admin.from("plant_products").delete().eq("organization_id", ORG).like("name", "E2E%");
    for (const id of createdEstimates) {
      await admin.from("estimate_areas").delete().eq("estimate_id", id);
      await admin.from("estimates").delete().eq("id", id);
    }
  } catch (e) {
    console.error("cleanup error:", e);
  }
  await restoreCatalogue(hiddenModelIds);
  console.log("cleanup done (E2E rows deleted, catalogue restored)");
  }
}

main()
  .then(() => {
    console.log(`\n${pass} pass, ${fail} fail`);
    process.exit(fail ? 1 : 0);
  })
  .catch(async (e) => {
    console.error("HARNESS ERROR:", e);
    process.exit(1);
  });