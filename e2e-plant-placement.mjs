// Browser E2E for plant placement on the measurement map
// (docs/handoff-plant-map-placement.md). Runs the REAL workspace at
// /lawn/estimate/[id] against the LIVE database, in Terra Verde Test Co.
//
// THE MAP IS STUBBED — read this before trusting or dismissing the run:
// NEXT_PUBLIC_GOOGLE_MAPS_API_KEY exists only in Vercel env and is
// referrer-restricted to the two app domains, so real Google tiles can NEVER
// render in local dev (the estimator-workspace lane hit this too: "Maps tiles
// need Vercel key (never render in dev)"). loadGoogleMaps() resolves the
// existing `google` global when one is present, so the harness injects a
// window.google.maps stub BEFORE app scripts load and the component runs its
// real logic — the placement branch, the marker teardown/rebuild effect, the
// picker, the selection card — against stub objects whose live instances are
// counted on window.__e2e. Everything DB-side is REAL: rows round-trip through
// Postgres, the legend is derived from real meta snapshots, deletes are real.
// What the stub cannot prove: actual pixel rendering of a real google.maps
// Marker. Everything else it proves.
//
// Covering the handoff's eight assertions:
//   1. three plants → three kind='point' rows, REST-verified, one-coordinate
//      polygon + FULL snapshot in meta
//   2. markers render and SURVIVE A PAGE RELOAD (the polygon.length>=3 trap)
//   3. mixed estimate: area list shows ONLY polygons, "N areas" excludes plants
//   4. placing plants leaves existing polygon area_sqft untouched
//   5. the legend moves WITHOUT legend code in the map — LandscapeLaborPanel
//      totals change on place and on delete (loadAreas was called)
//   6. picker empty state appears with no catalogue and links to /lawn/plants
//   7. delete a plant → marker AND legend row both go
//   8. double-place guard: two rapid clicks in the same spot → one plant
//      (both clicks are dispatched synchronously in one evaluate, so the
//      second always lands inside the first save's in-flight window — the
//      exact race the useRef guard exists for)
//
// Run (from the worktree root — needs the worktree dev server up):
//   npx next dev -p 3007                 # once; .env.local must exist
//   PLAYWRIGHT_DIR=C:/Users/garci_9e2kg3l/Tools/e2e-lawn/node_modules/playwright \
//     node e2e-plant-placement.mjs
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
const E2E_PASSWORD = "E2e-Lawn-lwer5vah!";
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

const SPECIES = "E2E Dwarf Yaupon";
const BOTANICAL = "Ilex v. 'Nana'";
const NO_SIZE_SPECIES = "E2E Unsized Viburnum";

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
// surface (exactly what LawnMeasurementMap touches) plus a registry the
// harness counts. loadGoogleMaps resolves `google` without any network.
const MAP_STUB = `
  window.__e2e = { markers: [], polys: [], mapClickListeners: [], map: null };
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
    },
  };
  window.__e2eMapClick = (lat, lng) => {
    const ev = { latLng: { lat: () => lat, lng: () => lng } };
    [...window.__e2e.mapClickListeners].forEach((f) => f(ev));
  };
  // Live plant-marker count: markers the map still owns, carrying the plant
  // marker signature (cursor "pointer" — vertex handles are "move", geocode
  // pin has no cursor option).
  window.__e2ePlantMarkerCount = () =>
    window.__e2e.markers.filter((m) => m.map && m.cursor === "pointer").length;
  window.__e2eMarkerClick = (i) => {
    const ms = window.__e2e.markers.filter((m) => m.map && m.cursor === "pointer");
    (ms[i].__listeners.click || []).forEach((f) => f({}));
  };
`;

async function gotoEstimate(page, estimateId) {
  await page.goto(`${BASE}/lawn/estimate/${estimateId}`, {
    waitUntil: "domcontentloaded", timeout: 90_000,
  });
  // Wait for the map stub + the workspace's first areas load + catalogue fetch.
  await page.waitForFunction(() => !!window.__e2e?.map, undefined, { timeout: 30_000 });
  await page.waitForTimeout(2500);
}

async function pickSize(page, speciesId, sizeLabel) {
  await page.selectOption('select[aria-label="Plant species"]', speciesId);
  await page.selectOption('select[aria-label="Plant size"]', { label: sizeLabel });
  // Selecting a size arms placement (sticky banner appears).
  await page.getByText("Tap the map to place one").waitFor({ timeout: 10_000 });
}

let estimateId = null;
const createdEstimates = [];
try {
  // ---------------- reset: wipe the org catalogue (sizes cascade) ----------------
  await admin.from("plant_products").delete().eq("organization_id", ORG);

  // ---------------- test estimate + one real polygon area ----------------
  const { data: est, error: estErr } = await admin
    .from("estimates")
    .insert({ organization_id: ORG, title: "ZZ plant placement e2e" })
    .select("id, status")
    .single();
  if (estErr) throw new Error("estimate insert: " + estErr.message);
  estimateId = est.id;
  createdEstimates.push(est.id);
  console.log(`estimate ${est.id} (${est.status})`);

  const POLY = [
    { lat: 27.95, lng: -82.46 },
    { lat: 27.9502, lng: -82.46 },
    { lat: 27.9502, lng: -82.4596 },
    { lat: 27.95, lng: -82.4596 },
  ];
  const { error: polyErr } = await admin.from("estimate_areas").insert({
    estimate_id: estimateId,
    organization_id: ORG,
    name: "E2E Front Yard",
    color: "#22c55e",
    polygon: POLY,
    area_sqft: 1000,
    kind: "area",
  });
  if (polyErr) throw new Error("polygon insert: " + polyErr.message);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("dialog", (d) => d.accept().catch(() => {}));
  await page.addInitScript(MAP_STUB);
  await login(page, OFFICE_EMAIL);

  // ================= PHASE A — no catalogue: picker empty state (assertion 6)
  console.log("\n[A] picker empty state, no plants in the catalogue");
  await gotoEstimate(page, estimateId);
  const emptyNote = page.getByText("No plants in the catalogue yet", { exact: false }).first();
  await emptyNote.waitFor({ timeout: 20_000 }).catch(() => {});
  check("amber empty-state note appears when the org has no plants", await emptyNote.isVisible().catch(() => false));
  const link = page.locator('a[href="/lawn/plants"]');
  check("empty state links to /lawn/plants", (await link.count()) > 0 && await link.first().isVisible().catch(() => false));
  const emptyLabor = page.getByText("Place plants on the map to price install labor").first();
  check("labor panel shows its empty case before anything is placed", await emptyLabor.isVisible().catch(() => false));

  // ================= PHASE B — seed catalogue; picker arms placement ========
  console.log("\n[B] catalogue seeded; species→size picker enters placement");
  const { data: species, error: spErr } = await admin
    .from("plant_products")
    .insert({ organization_id: ORG, name: SPECIES, botanical_name: BOTANICAL, category: "shrub", color: "#a855f7" })
    .select("id")
    .single();
  if (spErr) throw new Error("species insert: " + spErr.message);
  const { data: noSizeSpecies, error: nsErr } = await admin
    .from("plant_products")
    .insert({ organization_id: ORG, name: NO_SIZE_SPECIES, category: "shrub", color: "#ef4444" })
    .select("id")
    .single();
  if (nsErr) throw new Error("no-size species insert: " + nsErr.message);
  const { data: size, error: szErr } = await admin
    .from("plant_product_sizes")
    .insert({
      organization_id: ORG, plant_product_id: species.id,
      size: "3 gal", cost: 9.5, unit_price: 38, install_minutes: 20, sort_order: 0,
    })
    .select("id")
    .single();
  if (szErr) throw new Error("size insert: " + szErr.message);

  await gotoEstimate(page, estimateId); // reload so the catalogue fetch picks up
  const speciesSelect = page.locator('select[aria-label="Plant species"]');
  check("picker renders with the seeded catalogue", await speciesSelect.isVisible().catch(() => false));
  const noSizeOptionOk = await page.evaluate((name) => {
    const sel = document.querySelector('select[aria-label="Plant species"]');
    const opt = [...sel.options].find((o) => o.textContent.includes(name));
    return !!opt && opt.disabled && opt.textContent.includes("(no sizes yet)");
  }, NO_SIZE_SPECIES);
  check("a species with no sizes is disabled and labelled '(no sizes yet)'", noSizeOptionOk === true);

  await pickSize(page, species.id, "3 gal — $38.00");
  check("selecting a size enters placement mode (sticky banner)", true);

  // ================= PHASE C — place two plants, REST-verified (assertion 1)
  console.log("\n[C] place two plants via map taps");
  await page.evaluate(() => window.__e2eMapClick(27.9501, -82.4598));
  const firstPlaced = await page
    .waitForFunction(() => window.__e2ePlantMarkerCount() === 1, undefined, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!firstPlaced) {
    console.log("  (diagnostics: first placement produced no marker)");
    console.log(
      await page.evaluate(
        () =>
          JSON.stringify(
            {
              markersCreated: window.__e2e.markers.length,
              liveMarkers: window.__e2ePlantMarkerCount(),
              body: document.body.innerText.slice(0, 1200),
            },
            null,
            1
          )
      )
    );
  }
  check("first tap places a marker", firstPlaced);
  await page.evaluate(() => window.__e2eMapClick(27.95015, -82.4597));
  await page.waitForFunction(() => window.__e2ePlantMarkerCount() === 2, undefined, { timeout: 20_000 });
  check("two taps → two live markers (placement stayed armed)", true);
  let rows = await restAreas(estimateId);
  let points = rows.filter((r) => r.kind === "point");
  check(
    "REST: two kind='point' rows exist",
    points.length === 2 && rows.filter((r) => r.kind === "area").length === 1,
    JSON.stringify(rows.map((r) => [r.kind, r.name]))
  );

  // ================= PHASE D — double-place guard (assertion 8) ============
  console.log("\n[D] double-place guard: two rapid clicks, one spot");
  await page.evaluate(() => {
    window.__e2eMapClick(27.9502, -82.4595);
    window.__e2eMapClick(27.9502, -82.4595);
  });
  await page.waitForFunction(() => window.__e2ePlantMarkerCount() === 3, undefined, { timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 1500)); // let any stray second write land
  rows = await restAreas(estimateId);
  points = rows.filter((r) => r.kind === "point");
  check("two rapid clicks in the same spot create ONE plant, not two", points.length === 3,
    `point rows: ${points.length}`);

  // ================= ASSERTION 1 — full snapshot proof =====================
  const placed = points.find((p) => Math.abs(p.polygon[0].lat - 27.9502) < 1e-6);
  check(
    "each point row carries a ONE-coordinate polygon",
    points.every((p) => Array.isArray(p.polygon) && p.polygon.length === 1),
    JSON.stringify(points.map((p) => p.polygon.length))
  );
  check(
    "meta holds the FULL plant snapshot (ids + price + size + install + category)",
    !!placed && placed.meta.plant_product_id === species.id &&
      placed.meta.plant_size_id === size.id &&
      placed.meta.name === SPECIES && placed.meta.botanical_name === BOTANICAL &&
      placed.meta.category === "shrub" && placed.meta.size === "3 gal" &&
      Number(placed.meta.cost) === 9.5 && Number(placed.meta.unit_price) === 38 &&
      Number(placed.meta.install_minutes) === 20,
    JSON.stringify(placed?.meta)
  );

  // ================= ASSERTION 4 — polygon sqft untouched ==================
  const polyRow = rows.find((r) => r.kind === "area");
  check("existing polygon area_sqft is untouched by placement", Number(polyRow.area_sqft) === 1000,
    String(polyRow.area_sqft));

  // ================= ASSERTION 5 — legend moved WITHOUT legend code ========
  console.log("\n[E] legend + counters after placement");
  const laborMaterial = page.getByText("$114.00", { exact: false }).first(); // 3 × $38
  await laborMaterial.waitFor({ timeout: 15_000 }).catch(() => {});
  check("LandscapeLaborPanel material total moved to $114.00 (3 × $38) on its own", await laborMaterial.isVisible().catch(() => false));
  check("labor panel no longer shows the empty case", !(await emptyLabor.isVisible().catch(() => false)));
  check("man-hours reflect 3 × 20 man-min = 1 planting hour", await page.getByText("1 planting +", { exact: false }).first().isVisible().catch(() => false));

  // ================= ASSERTION 3 — area list + counters exclude plants =====
  const areaInputs = page.locator('input[aria-label="Area name"]');
  check("area list shows ONLY the polygon (1 row)", (await areaInputs.count()) === 1,
    `area rows: ${await areaInputs.count()}`);
  check("area list row is the polygon, not a plant", (await areaInputs.first().inputValue()) === "E2E Front Yard");
  check("header counts 1 area measured (plants not counted)", await page.getByText("1 area measured").first().isVisible().catch(() => false));

  // ================= RELOAD — assertion 2 (markers survive) ================
  console.log("\n[F] reload: markers survive, list still polygon-only");
  await gotoEstimate(page, estimateId);
  await page.waitForFunction(() => window.__e2ePlantMarkerCount() === 3, undefined, { timeout: 20_000 });
  check("all three plant markers render and SURVIVE A PAGE RELOAD", true);
  check("after reload the area list still shows only the polygon", (await page.locator('input[aria-label="Area name"]').count()) === 1);
  check("after reload the legend still totals $114.00", await page.getByText("$114.00", { exact: false }).first().isVisible().catch(() => false));

  // ================= ASSERTION 7 — select via marker, note, delete =========
  console.log("\n[G] marker click → card → note → delete");
  await page.evaluate(() => window.__e2eMarkerClick(0));
  const cardName = page.locator("p", { hasText: SPECIES }).first();
  await cardName.waitFor({ timeout: 10_000 });
  // Scope to the card itself: divs that carry BOTH the delete and the close
  // button, innermost match = the card (outer ancestors also qualify).
  const cardText = await page
    .locator("div", { has: page.getByRole("button", { name: "Delete plant" }) })
    .filter({ has: page.getByRole("button", { name: "Close plant card" }) })
    .last()
    .textContent();
  check("clicking a marker opens the inspect card with species/size/price/install",
    cardText.includes("3 gal") && cardText.includes("$38.00") && cardText.includes("20 man-min"),
    cardText.slice(0, 200));
  await page.fill('input[aria-label="Placement note"]', "specimen, face the street");
  await page.locator('input[aria-label="Placement note"]').blur();
  await new Promise((r) => setTimeout(r, 2000));
  const notedRow = (await restAreas(estimateId)).find((r) => r.kind === "point");
  check(
    "note edit persists AND the snapshot fields survive (whole-meta read-modify-write)",
    notedRow.meta.note === "specimen, face the street" && Number(notedRow.meta.unit_price) === 38,
    JSON.stringify(notedRow.meta)
  );
  await page.getByRole("button", { name: "Delete plant" }).click();
  await page.waitForFunction(() => window.__e2ePlantMarkerCount() === 2, undefined, { timeout: 20_000 });
  check("deleted plant's marker is gone (2 left)", true);
  const afterDelete = await restAreas(estimateId);
  check("REST: deleted row is gone", afterDelete.filter((r) => r.kind === "point").length === 2);
  const materialAfter = page.getByText("$76.00", { exact: false }).first(); // 2 × $38
  await materialAfter.waitFor({ timeout: 15_000 }).catch(() => {});
  check("legend row went with it — material total now $76.00", await materialAfter.isVisible().catch(() => false));

  check("no page errors during the run", errors.length === 0, errors.join(" | "));

  await browser.close();
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
} finally {
  // Cleanup: test org only. estimate_areas first (belt), then the estimate.
  if (estimateId) {
    await admin.from("estimate_areas").delete().eq("estimate_id", estimateId);
    await admin.from("estimates").delete().eq("id", estimateId);
  }
  await admin.from("plant_products").delete().eq("organization_id", ORG);
  console.log("\ncleanup: estimate + areas + catalogue wiped for the test org");
}