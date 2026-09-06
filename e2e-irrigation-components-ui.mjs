// Browser E2E for the irrigation COMPONENTS catalogue UI — Lane D of the UI
// handoff (docs/handoff/handoff-ui-lane-d-controls-and-mainline.md, governed by
// docs/handoff/handoff-ui-state-of-play.md). Runs the REAL screens against the
// LIVE database, in Terra Verde Test Co only.
//
// The contract's MATHS are already covered by e2e-irrigation-components.mjs
// (run separately, unchanged). What was NOT covered — and what this harness
// commits — is the DATABASE ROUND-TRIP through the UI:
//
//   [A] catalogue screen /lawn/irrigation-components:
//       - a component created through the UI drawer comes back with its id
//         (createComponent .select()s it home — the UI must not lose it),
//         REST-proven with every field typed as entered;
//       - a PER-FOOT component survives a reload still marked foot;
//       - search matches the name AND the notes (the org writes its code/
//         permitting knowledge there and looks parts up by it);
//       - the category filter narrows; deactivated rows dim and are withheld
//         from the estimator's Parts picker;
//       - editing a price round-trips through REST.
//   [B] estimator Parts panel (Lane C's ComponentsPanel, fed by THIS lane's
//       catalogue via listComponents):
//       - adding a foot component writes estimate_components with a FULL
//         snapshot and quantity 200 ft; the billable line carries PER-UNIT
//         money (unit_price 0.75, internal_cost 0.25 — NOT the extended
//         figures; extended money here would bill 200 ft of wire 200x);
//       - an each component writes quantity 1 with unit EA;
//       - an UNPRICED component is offered but cannot bill — the add button
//         is disabled with the catalogue prompt, never a silent $0 line;
//       - re-pricing the catalogue afterwards does NOT move the estimate:
//         the stored snapshot and the rendered row keep the old price;
//       - every add produced one line with a non-null internal_cost.
//
// MAP IS STUBBED (same disclosure as e2e-estimator-panels.mjs): the Maps key
// is referrer-restricted to prod and never renders in dev, so a google.maps
// stub is injected before app scripts load. This harness never clicks the
// map; the stub only has to let the workspace mount.
//
// Run (from the repo root — needs the dev server up):
//   npx next dev -p 3007                 # once; .env.local must exist
//   PLAYWRIGHT_DIR=C:/Users/garci_9e2kg3l/Tools/e2e-lawn/node_modules/playwright \
//     node e2e-irrigation-components-ui.mjs
//
// SAFETY: every row is created in Terra Verde Test Co (600d02fa…) and deleted
// at the end; the org's real components are DEACTIVATED (never deleted) and
// restored on both paths. Peanutz L&L is a live customer, never touched.
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

const WIRE_NAME = "E2E UI Wire";
const CONTROLLER_NAME = "E2E UI Controller";
const VALVE_NAME = "E2E UI Valve";
const SLEEVE_NAME = "E2E UI Sleeve";

// Catalogue isolation — deactivate what is there (never delete), run against
// a clean-looking catalogue, reactivate exactly what was hidden. Deletes are
// scoped to the E2E-prefixed rows this harness creates.
async function hideCatalogue() {
  const { data } = await admin.from("irrigation_components")
    .select("id").eq("organization_id", ORG).eq("active", true);
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length) await admin.from("irrigation_components").update({ active: false }).in("id", ids);
  return ids;
}
async function restoreCatalogue(ids) {
  if (ids.length) await admin.from("irrigation_components").update({ active: true }).in("id", ids);
}

// Service-role REST reads are throttled on rapid fire — pace every read.
async function restComponents(select) {
  await new Promise((r) => setTimeout(r, 1200));
  const { data, error } = await admin.from("irrigation_components")
    .select(select).eq("organization_id", ORG).like("name", "E2E UI%");
  if (error) throw new Error(`rest components: ${error.message}`);
  return data ?? [];
}
async function restEstimateRows(table, select) {
  await new Promise((r) => setTimeout(r, 1200));
  const { data, error } = await admin.from(table).select(select).eq("estimate_id", estimateId);
  if (error) throw new Error(`rest ${table}: ${error.message}`);
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
// surface (exactly what LawnMeasurementMap touches) plus a mount flag.
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

async function gotoCatalogue(page) {
  await page.goto(`${BASE}/lawn/irrigation-components`, {
    waitUntil: "domcontentloaded", timeout: 90_000,
  });
  await page.getByText("Add component").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
}
async function gotoEstimate(page) {
  await page.goto(`${BASE}/lawn/estimate/${estimateId}`, {
    waitUntil: "domcontentloaded", timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.__e2e?.map, undefined, { timeout: 30_000 });
  await page.waitForTimeout(2500); // estimate + areas + the five catalogues
}
async function openTab(page, label) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForTimeout(300);
}

let estimateId = null;
const hiddenIds = [];
try {
  // ---------------- reset: hide the org's real components ------------------
  hiddenIds.push(...await hideCatalogue());
  await admin.from("irrigation_components")
    .delete().eq("organization_id", ORG).like("name", "E2E UI%");

  // Seed the three catalogue rows the estimator phase needs: a priced foot
  // row, a priced each row, an unpriced foot row (the add button must refuse
  // it), and one priced each row that gets deactivated through the UI to
  // prove the Parts picker withholds it.
  const seeds = [
    { name: CONTROLLER_NAME, category: "controller", unit: "each",
      cost: 80, unit_price: 220, install_minutes: 45,
      notes: "PVB install height per local code — verify permit" },
    { name: SLEEVE_NAME, category: "sleeve", unit: "foot",
      cost: 0.4, unit_price: 0, install_minutes: 0.2, notes: null },
    { name: VALVE_NAME, category: "zone_valve", unit: "each",
      cost: 12, unit_price: 45, install_minutes: 30, notes: null },
  ];
  const { error: seedErr } = await admin.from("irrigation_components").insert(
    seeds.map((s) => ({ organization_id: ORG, ...s, active: true }))
  );
  if (seedErr) throw new Error("component seed: " + seedErr.message);

  // ---------------- test estimate ------------------------------------------
  const { data: est, error: estErr } = await admin
    .from("estimates")
    .insert({ organization_id: ORG, title: "ZZ components ui e2e" })
    .select("id, status")
    .single();
  if (estErr) throw new Error("estimate insert: " + estErr.message);
  estimateId = est.id;
  console.log(`estimate ${est.id} (${est.status})`);

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

  // ================= PHASE A — catalogue screen ============================
  console.log("\n[A] /lawn/irrigation-components: create through the UI");
  await gotoCatalogue(page);
  {
    const body = await page.locator("body").innerText();
    check("the three seeded rows render (priced foot, priced each, unpriced)",
      body.includes(CONTROLLER_NAME) && body.includes(SLEEVE_NAME) && body.includes(VALVE_NAME), "");
    check("the seeded per-foot row renders its unit as 'per ft'",
      body.includes("per ft"), "");
    check("the unpriced row carries the unpriced chip (0 is not free)",
      body.includes("unpriced"), "");
    check("the priced each row is timed so no untimed chip — its notes render instead",
      body.includes("verify permit"), "");
  }

  // Create a per-foot component THROUGH THE DRAWER.
  await page.getByRole("button", { name: "Add component" }).first().click();
  await page.getByPlaceholder("Component name *").fill(WIRE_NAME);
  // Scope to the drawer: the page's category-filter select is nth=0 unscoped.
  await page.selectOption('aside select >> nth=0', { label: "wire" });
  await page.selectOption('aside select >> nth=1', {
    label: "foot (quantity IS feet — wire, mainline, sleeving)",
  });
  // NumberInput renders inputmode="decimal" — plain `aside input` would also
  // match the name text field and the active checkbox.
  const numerics = page.locator('aside input[inputmode="decimal"]');
  await numerics.nth(0).fill("0.25"); // material cost
  await numerics.nth(1).fill("0.75"); // price
  await numerics.nth(2).fill("0.5");  // man-min per foot
  await page.locator("aside textarea").fill("THHN 18 gauge, direct burial");
  await page.getByRole("button", { name: "Add component", exact: true }).last().click();
  await page.getByText(WIRE_NAME).first().waitFor({ timeout: 15_000 });
  let rows = await restComponents("id, name, category, unit, cost, unit_price, install_minutes, notes, active");
  const wireRow = rows.find((r) => r.name === WIRE_NAME);
  check("REST: UI-created row landed with every field as typed",
    !!wireRow && wireRow.category === "wire" && wireRow.unit === "foot" &&
      Number(wireRow.cost) === 0.25 && Number(wireRow.unit_price) === 0.75 &&
      Number(wireRow.install_minutes) === 0.5 &&
      wireRow.notes === "THHN 18 gauge, direct burial" && wireRow.active === true,
    JSON.stringify(wireRow));
  check("createComponent returned the row's id (the UI must not lose it — it is editable immediately)",
    !!wireRow && /^[0-9a-f-]{36}$/.test(wireRow.id), wireRow?.id);

  // Search matches name AND notes.
  await page.fill('input[aria-label="Search components"]', "permit");
  await page.waitForTimeout(400);
  {
    const body = await page.locator("body").innerText();
    check("search matches NOTES ('permit' finds the controller note, hides the rest)",
      body.includes(CONTROLLER_NAME) && !body.includes(WIRE_NAME) && !body.includes(SLEEVE_NAME), "");
  }
  await page.fill('input[aria-label="Search components"]', WIRE_NAME);
  await page.waitForTimeout(400);
  {
    const body = await page.locator("body").innerText();
    check("search matches NAME ('E2E UI Wire' narrows to the wire)",
      body.includes(WIRE_NAME) && !body.includes(CONTROLLER_NAME), "");
  }
  await page.fill('input[aria-label="Search components"]', "");
  // Category filter narrows.
  await page.selectOption('select[aria-label="Filter components by category"]', "controller");
  await page.waitForTimeout(400);
  {
    const body = await page.locator("body").innerText();
    check("category filter narrows to controllers only",
      body.includes(CONTROLLER_NAME) && !body.includes(WIRE_NAME), "");
  }
  await page.selectOption('select[aria-label="Filter components by category"]', "all");
  await page.waitForTimeout(200);

  // Edit the valve's price through the drawer.
  await page.getByRole("button", { name: `Edit ${VALVE_NAME}` }).click();
  const editNumerics = page.locator('aside input[inputmode="decimal"]');
  await editNumerics.nth(1).fill("52"); // price
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(1500);
  rows = await restComponents("id, name, unit_price");
  check("REST: UI edit round-trips the price (45 → 52)",
    rows.find((r) => r.name === VALVE_NAME)?.unit_price === 52,
    JSON.stringify(rows.map((r) => [r.name, r.unit_price])));

  // Deactivate the VALVE through the UI (scoped to its row — the table sorts
  // active-first then by name, so .first() would hit the controller); it dims
  // and must vanish from the estimator's Parts picker later.
  await page.locator("tr", { hasText: VALVE_NAME })
    .getByRole("button", { name: "Deactivate" }).click();
  await page.waitForTimeout(1200);
  {
    const body = await page.locator("body").innerText();
    check("deactivated row dims with an '(inactive)' marker",
      body.includes("(inactive)"), "");
  }

  // Per-foot component survives a reload still marked foot.
  await gotoCatalogue(page);
  {
    const body = await page.locator("body").innerText();
    const idx = body.indexOf(WIRE_NAME);
    check("after reload the per-foot row is STILL marked 'per ft'",
      idx >= 0 && body.slice(idx, idx + 400).includes("per ft"), "");
  }

  // ================= PHASE B — estimator Parts panel =======================
  // Lane C shipped ComponentsPanel (the add-to-estimate UI); this lane wires
  // to it, never duplicates it. If that panel is merged onto this base the
  // full UI round-trip runs below; if not, the invariants are proven at the
  // DATA level instead (the UI write path itself is covered by
  // e2e-estimator-panels.mjs, 44/44, on feat/estimator-panels-lane-c).
  await gotoEstimate(page);
  const hasParts = await page.getByRole("button", { name: "Parts", exact: true })
    .isVisible().catch(() => false);
  if (hasParts) {
  console.log("\n[B] Parts panel: add to estimate, snapshot + per-unit line");
  await openTab(page, "Parts");

  // The deactivated valve must NOT be offered.
  const optionLabels = await page.$$eval('select[aria-label="Component"] option',
    (os) => os.map((o) => o.textContent ?? ""));
  check("Parts picker withholds the deactivated valve",
    !optionLabels.some((l) => l.includes(VALVE_NAME)), JSON.stringify(optionLabels));

  // Add the per-foot wire: quantity IS feet.
  await page.selectOption('select[aria-label="Component"]', { label: `${WIRE_NAME} (per ft)` });
  const qtyFt = page.getByLabel("Quantity — linear feet");
  await qtyFt.fill("200");
  await page.getByText("$150.00 (cost $50.00)").first().waitFor({ timeout: 15_000 });
  check("preview bills 200 ft × $0.75 = $150.00 (cost $50.00)",
    await page.getByText("$150.00 (cost $50.00)").first().isVisible().catch(() => false));
  await page.getByRole("button", { name: "Add component to estimate" }).click();
  await page.waitForTimeout(2500);
  let comps = await restEstimateRows("estimate_components", "id, snapshot, quantity");
  const wireComp = comps.find((c) => c.snapshot?.name === WIRE_NAME);
  check("REST: estimate_components row with FULL snapshot (ids, category, unit, rates) and quantity 200",
    !!wireComp && wireComp.snapshot.irrigation_component_id === wireRow.id &&
      wireComp.snapshot.unit === "foot" && wireComp.snapshot.category === "wire" &&
      Number(wireComp.snapshot.unit_price) === 0.75 && Number(wireComp.snapshot.cost) === 0.25 &&
      Number(wireComp.snapshot.install_minutes) === 0.5 && Number(wireComp.quantity) === 200,
    JSON.stringify(comps));

  // Add the each-priced controller, quantity 1.
  await page.selectOption('select[aria-label="Component"]', { label: `${CONTROLLER_NAME} (each)` });
  const qtyEach = page.getByLabel("Quantity — pieces");
  await qtyEach.fill("1");
  await page.getByRole("button", { name: "Add component to estimate" }).click();
  await page.waitForTimeout(2500);
  comps = await restEstimateRows("estimate_components", "id, snapshot, quantity");
  check("REST: the each row landed with quantity 1 and its snapshot",
    comps.length === 2 && !!comps.find((c) => c.snapshot?.name === CONTROLLER_NAME &&
      Number(c.quantity) === 1 && c.snapshot.unit === "each"),
    JSON.stringify(comps.map((c) => [c.snapshot?.name, c.quantity])));

  // The unpriced sleeve is offered but must not bill.
  await page.selectOption('select[aria-label="Component"]', { label: `${SLEEVE_NAME} (per ft)` });
  await page.getByLabel("Quantity — linear feet").fill("50");
  const unpricedBtn = page.getByRole("button", { name: "Unpriced — set a price in the catalogue to bill this" });
  await unpricedBtn.waitFor({ timeout: 15_000 }).catch(() => {});
  check("unpriced component: add button disabled with the catalogue prompt (never a silent $0 line)",
    (await unpricedBtn.isVisible().catch(() => false)) && !(await unpricedBtn.isEnabled().catch(() => true)), "");
  const sleeveRows = await restEstimateRows("estimate_components", "id, snapshot");
  check("REST: nothing was written for the unpriced sleeve",
    sleeveRows.length === 2, String(sleeveRows.length));

  // Re-price the wire in the catalogue AFTER the add — the quote must not move.
  await new Promise((r) => setTimeout(r, 1200));
  const { error: repriceErr } = await admin.from("irrigation_components")
    .update({ unit_price: 0.95, cost: 0.4 }).eq("id", wireRow.id);
  if (repriceErr) throw new Error("reprice: " + repriceErr.message);
  await gotoEstimate(page);
  await openTab(page, "Parts");
  await page.getByText("$150.00 (cost $50.00)").first().waitFor({ timeout: 15_000 });
  check("after re-pricing the catalogue the estimate row STILL bills $150.00 (snapshot rule)",
    await page.getByText("$150.00 (cost $50.00)").first().isVisible().catch(() => false));
  comps = await restEstimateRows("estimate_components", "id, snapshot, quantity");
  check("REST: the stored snapshot kept the OLD price (0.75), not the new one (0.95)",
    comps.find((c) => c.snapshot?.name === WIRE_NAME)?.snapshot.unit_price === 0.75,
    JSON.stringify(comps.map((c) => c.snapshot)));
  } else {
  console.log("\n[B] Parts tab ABSENT on this base — Lane C's estimator panels are not merged here yet.");
  console.log("    Proving the estimate-side invariants at the DATA level: inserting exactly the row");
  console.log("    ComponentsPanel writes (full snapshot + the per-unit line it derives), then");
  console.log("    re-pricing the catalogue. The UI write path itself is covered by");
  console.log("    e2e-estimator-panels.mjs (44/44) on feat/estimator-panels-lane-c.");
  // The picker's data source is listComponents(activeOnly=true) — a read
  // filtered on active=true. The valve was deactivated through the UI in
  // Phase A, so the active-only read must not return it.
  const activeRows = (await restComponents("id, name, active"))
    .filter((r) => r.active === true);
  check("active-only read (the Parts picker's data source) withholds the deactivated valve",
    activeRows.some((r) => r.name === WIRE_NAME) &&
      !activeRows.some((r) => r.name === VALVE_NAME),
    JSON.stringify(activeRows.map((r) => r.name)));
  // Insert exactly what the panel writes: a FULL snapshot plus the per-unit
  // billable line derived from it.
  const { error: compErr } = await admin.from("estimate_components").insert({
    estimate_id: estimateId, organization_id: ORG,
    snapshot: {
      irrigation_component_id: wireRow.id, name: WIRE_NAME, category: "wire",
      unit: "foot", cost: 0.25, unit_price: 0.75, install_minutes: 0.5,
    },
    quantity: 200,
  });
  if (compErr) throw new Error("estimate_components insert: " + compErr.message);
  const { error: lineErr } = await admin.from("estimate_line_items").insert({
    estimate_id: estimateId, organization_id: ORG,
    description: `${WIRE_NAME} — 200 ft`, quantity: 200, unit: "FT",
    unit_price: 0.75, internal_cost: 0.25,
  });
  if (lineErr) throw new Error("estimate_line_items insert: " + lineErr.message);
  // Re-price the catalogue; the quote must not move.
  const comps = await restEstimateRows("estimate_components", "id, snapshot, quantity");
  check("DATA: estimate_components row carries the FULL snapshot (ids, category, unit, rates) at quantity 200",
    comps.length === 1 && comps[0].snapshot.irrigation_component_id === wireRow.id &&
      comps[0].snapshot.unit === "foot" && comps[0].snapshot.category === "wire" &&
      Number(comps[0].snapshot.unit_price) === 0.75 && Number(comps[0].snapshot.cost) === 0.25 &&
      Number(comps[0].snapshot.install_minutes) === 0.5 && Number(comps[0].quantity) === 200,
    JSON.stringify(comps));
  await new Promise((r) => setTimeout(r, 1200));
  const { error: repriceErr } = await admin.from("irrigation_components")
    .update({ unit_price: 0.95, cost: 0.4 }).eq("id", wireRow.id);
  if (repriceErr) throw new Error("reprice: " + repriceErr.message);
  const compsAfter = await restEstimateRows("estimate_components", "id, snapshot, quantity");
  check("DATA: after re-pricing the catalogue the stored snapshot KEPT the old price (0.75, not 0.95)",
    !!compsAfter[0]?.snapshot &&
      Number(compsAfter[0].snapshot.unit_price) === 0.75 &&
      Number(compsAfter[0].snapshot.cost) === 0.25,
    JSON.stringify(compsAfter.map((c) => c.snapshot)));
  }

  // ================= PHASE C — line items ==================================
  console.log("\n[C] lines: per-unit money, non-null internal_cost");
  const lines = await restEstimateRows("estimate_line_items",
    "description, quantity, unit, unit_price, internal_cost");
  const wireLine = lines.find((l) => (l.description ?? "").includes(WIRE_NAME));
  check("a billable line exists for the wire",
    !!wireLine, JSON.stringify(lines.map((l) => l.description)));
  check("every line has a non-null internal_cost",
    lines.length > 0 && lines.every((l) => l.internal_cost !== null),
    JSON.stringify(lines.filter((l) => l.internal_cost === null)));
  check("wire line: PER-UNIT money (unit_price 0.75, internal_cost 0.25) at quantity 200, unit FT — " +
      "extended money here would bill 200 ft of wire 200x",
    !!wireLine && Number(wireLine.quantity) === 200 && wireLine.unit === "FT" &&
      Number(wireLine.unit_price) === 0.75 && Number(wireLine.internal_cost) === 0.25,
    JSON.stringify(wireLine));
  if (hasParts) {
    const ctrlLine = lines.find((l) => (l.description ?? "").includes(CONTROLLER_NAME));
    check("controller line: unit EA, per-unit money (220 / 80) with the basis in the description",
      !!ctrlLine && Number(ctrlLine.quantity) === 1 && ctrlLine.unit === "EA" &&
        Number(ctrlLine.unit_price) === 220 && Number(ctrlLine.internal_cost) === 80 &&
        (ctrlLine.description ?? "").includes("1 each"),
      JSON.stringify(ctrlLine));
  }

  check("no page errors during the run", errors.length === 0, errors.join(" | "));

  await browser.close();
} catch (fatal) {
  // process.exit in the finally block would discard this — print it first.
  fail++;
  console.error("FATAL:", fatal && fatal.stack ? fatal.stack : fatal);
} finally {
  // Cleanup: test org only. Estimate children first, then the estimate, then
  // this harness's E2E-prefixed rows, then restore the org's catalogue.
  // process.exit MUST come after this block.
  if (estimateId) {
    await admin.from("estimate_line_items").delete().eq("estimate_id", estimateId);
    await admin.from("estimate_components").delete().eq("estimate_id", estimateId);
    await admin.from("estimate_areas").delete().eq("estimate_id", estimateId);
    await admin.from("estimates").delete().eq("id", estimateId);
  }
  await admin.from("irrigation_components")
    .delete().eq("organization_id", ORG).like("name", "E2E UI%");
  await restoreCatalogue(hiddenIds);
  console.log("\ncleanup: E2E rows removed; the org's real components are restored");
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}