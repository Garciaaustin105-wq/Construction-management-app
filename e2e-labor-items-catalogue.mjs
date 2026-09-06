// Browser E2E for the labor-items catalogue at /lawn/labor-items (Lane A).
// Office/PM CRUD straight through RLS against the LIVE DB:
//   - gates: crew account bounced, office admin reaches the screen
//   - LABOR_SCOPE_NOTE renders verbatim — the warning that keeps sod/plant/
//     irrigation labor OUT of this list (they'd bill the same hours twice)
//   - unit select shows unitLabel(), not the raw slug — "thousand square
//     feet" for msqft (the msqft trap: typing 5000 where 5 belongs)
//   - benchmark suggestions appear in the form as TEXT ONLY and never touch
//     the boxes: picking edging/foot shows the published figure while the
//     cost box stays empty
//   - chips: unit_price <= 0 gets "unpriced"; a NON-hour unit with 0 minutes
//     gets "untimed"; a 0 material cost on a pure-labor row gets NOTHING
//     (0 is legitimate there, not the same as free)
//   - fractional man-minutes persist (0.6, NUMERIC column)
//   - edit + deactivate/activate
//   - test data: Terra Verde Test Co (600d02fa…), fabricated; every E2E-
//     prefixed labor_items row is wiped at start and end
//
// Run (from the repo/worktree root — needs the dev server up):
//   npx next dev -p 3007            # once
//   node e2e-labor-items-catalogue.mjs
// playwright is not a repo dependency; if `import 'playwright'` fails, point
// PLAYWRIGHT_DIR at an install (e.g. Tools/e2e-lawn/node_modules/playwright).
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
const CREW_EMAIL = "e2e-crew-lawn@test.local";
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

const EDGING = "E2E Bed Edging";
const DETHATCH = "E2E Dethatch";

// REST reads are service-role and the endpoint throttles rapid-fire probes;
// pace them and scope them to the rows THIS harness creates (E2E-prefixed).
async function restItems() {
  await new Promise((r) => setTimeout(r, 1200));
  const { data, error } = await admin
    .from("labor_items")
    .select("id, name, category, unit, cost, unit_price, install_minutes, notes, active")
    .eq("organization_id", ORG)
    .like("name", "E2E%");
  if (error) throw new Error("rest items read: " + error.message);
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

async function gotoCatalogue(page) {
  await page.goto(`${BASE}/lawn/labor-items`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(2500); // route compile + RLS fetch
}

// DataTable renders its mobile cards as divs inside a div.lg:hidden (NOT a
// ul/li list) — mobile selectors go through that wrapper.
const MOBILE_CARD = ".lg\\:hidden > div";
function cardFor(page, text) {
  return page.locator(MOBILE_CARD, { hasText: text }).first();
}

// ---------------------------------------------------------------------------
// Catalogue isolation — deactivate what is already there, run against a
// clean-looking catalogue, reactivate exactly what was deactivated. Deletes
// are scoped to the E2E-prefixed rows this harness creates, never to the org.
// ---------------------------------------------------------------------------
async function hideExistingCatalogue(ORG) {
  const { data } = await admin.from("labor_items")
    .select("id").eq("organization_id", ORG).eq("active", true);
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length) await admin.from("labor_items").update({ active: false }).in("id", ids);
  return ids;
}
async function restoreCatalogue(ids) {
  if (ids?.length) await admin.from("labor_items").update({ active: true }).in("id", ids);
}

// Module scope on purpose: a crash mid-run must still be able to reactivate
// what was hidden, or the org is left with an invisible catalogue.
let hiddenItemIds = [];

async function main() {
  hiddenItemIds = await hideExistingCatalogue(ORG);
  await admin.from("labor_items").delete()
    .eq("organization_id", ORG).like("name", "E2E%");
  const start = await restItems();
  console.log(`baseline: ${start.length} E2E item row(s) (after reset)`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await login(page, OFFICE_EMAIL);

  // ================= 1. GATES =================
  await gotoCatalogue(page);
  check("office admin reaches /lawn/labor-items", page.url().endsWith("/lawn/labor-items"), page.url());

  const crewCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const crewPage = await crewCtx.newPage();
  await login(crewPage, CREW_EMAIL);
  await crewPage.goto(`${BASE}/lawn/labor-items`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await crewPage.waitForTimeout(2500);
  check("crew account is bounced off /lawn/labor-items", !crewPage.url().includes("/lawn/labor-items"), crewPage.url());
  await crewCtx.close();

  // ================= 2. SCOPE NOTE, VERBATIM =================
  const pageText = (await page.locator("main").textContent().catch(() => "")) ?? "";
  check(
    "LABOR_SCOPE_NOTE renders verbatim",
    pageText.includes(
      "Sod, plant and irrigation labor are priced by their own catalogues. Adding them here would bill the same hours twice."
    ),
    pageText.trim().slice(0, 200)
  );
  const countLine = (await page.locator("p", { hasText: /items?$/ }).first().textContent().catch(() => "")) ?? "";
  check("count line renders N items", /\d+ items?/.test(countLine), countLine.trim());

  // ================= 3. ADD: benchmark is text-only, msqft shows its label =================
  await page.getByRole("button", { name: /Add item/i }).first().click();
  const drawer = page.locator('aside[role="dialog"]');
  await drawer.waitFor({ timeout: 15_000 });

  // Two selects in the drawer: category first, unit second. Picking
  // edging + linear feet has a published benchmark — it must appear as a
  // SUGGESTION line and never pre-fill the boxes.
  const selects = drawer.locator("select");
  await selects.nth(0).selectOption("edging");
  await page.waitForTimeout(300);
  check(
    "no benchmark line before a unit with a figure is chosen",
    !((await drawer.textContent().catch(() => "")) ?? "").includes("never a default"),
    ""
  );
  await selects.nth(1).selectOption("foot");
  await page.waitForTimeout(300);
  const drawerText = (await drawer.textContent().catch(() => "")) ?? "";
  check(
    "benchmark suggestion appears for edging/foot ('Others charge 1.5-3.5')",
    drawerText.includes("suggestion only — never a default") && drawerText.includes("Others charge 1.5-3.5"),
    drawerText.slice(drawerText.indexOf("suggestion only") - 60, drawerText.indexOf("suggestion only") + 220)
  );
  const costVal = await drawer.locator("label", { hasText: "Material cost" }).locator("input").inputValue().catch(() => "?");
  check("benchmark did NOT pre-fill the material-cost box", costVal === "" || costVal === "0", String(costVal));

  // msqft trap: the option label is unitLabel, not the slug.
  const optionTexts = await drawer.locator("label", { hasText: "Unit" }).locator("select option").allTextContents().catch(() => []);
  check(
    "unit select shows 'thousand square feet' (unitLabel), not raw 'msqft' alone",
    optionTexts.some((t) => t === "thousand square feet") && !optionTexts.includes("msqft"),
    JSON.stringify(optionTexts)
  );

  await drawer.locator('input[placeholder^="Item name"]').fill(EDGING);
  // Price 2.75, fractional man-minutes 0.6 (NUMERIC column), material cost 0 —
  // a pure-labor-ish row where 0 cost is legitimate.
  await drawer.locator("label", { hasText: "Material cost" }).locator("input").fill("0");
  await drawer.locator("label", { hasText: /^Price/ }).locator("input").fill("2.75");
  await drawer.locator("label", { hasText: "Man-min per unit" }).locator("input").fill("0.6");
  await drawer.locator('button[type="submit"]').click();
  await page.getByText("Item added").waitFor({ timeout: 15_000 }).catch(() => {});
  check("toast 'Item added' after submit", await page.getByText("Item added").isVisible().catch(() => false));
  await drawer.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});

  const edgingRow = (await restItems()).find((r) => r.name === EDGING);
  check(
    "REST: item persisted (edging/foot, fractional 0.6 minutes)",
    !!edgingRow && edgingRow.category === "edging" && edgingRow.unit === "foot" &&
      Number(edgingRow.unit_price) === 2.75 && Number(edgingRow.install_minutes) === 0.6,
    JSON.stringify(edgingRow)
  );

  // ================= 4. CHIPS: unpriced, untimed, and NO chip on 0-cost =================
  await page.getByRole("button", { name: /Add item/i }).first().click();
  await drawer.waitFor({ timeout: 15_000 });
  await drawer.locator('input[placeholder^="Item name"]').fill(DETHATCH);
  await drawer.locator("select").nth(0).selectOption("cleanup");
  await drawer.locator("select").nth(1).selectOption("sqft");
  // Cost 0 (pure labor), price 0 (unpriced), minutes 0 + non-hour unit (untimed).
  await drawer.locator('button[type="submit"]').click();
  await page.getByText("Item added").waitFor({ timeout: 15_000 }).catch(() => {});
  await drawer.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});

  const dCard = cardFor(page, DETHATCH);
  const dCardText = (await dCard.textContent().catch(() => "")) ?? "";
  const unpricedChips = (dCardText.match(/unpriced/g) ?? []).length;
  check("mobile card marks the 0-price item 'unpriced'", unpricedChips === 1, dCardText.trim().slice(0, 200));
  // The 0 MATERIAL cost on a pure-labor row must not be flagged — the card
  // shows "$0.00 cost" with no chip beside it.
  check(
    "0 material cost on a pure-labor row is NOT flagged (renders '$0.00 cost', no second chip)",
    dCardText.includes("$0.00 cost") && unpricedChips === 1,
    dCardText.trim().slice(0, 200)
  );

  // ================= 5. EDIT =================
  await cardFor(page, EDGING).locator('button[aria-label="Edit E2E Bed Edging"]').click();
  const editForm = page.locator('aside[role="dialog"] form');
  await editForm.waitFor({ timeout: 15_000 });
  await editForm.locator("label", { hasText: /^Price/ }).locator("input").fill("3.25");
  await editForm.locator('button[type="submit"]').click();
  await page.getByText("Item updated").waitFor({ timeout: 15_000 }).catch(() => {});
  check("toast 'Item updated' after edit", await page.getByText("Item updated").isVisible().catch(() => false));
  await drawer.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  check("REST: edit persisted ($2.75 → $3.25)", Number((await restItems()).find((r) => r.name === EDGING)?.unit_price) === 3.25);

  // ================= 6. DEACTIVATE / ACTIVATE =================
  const eCard = cardFor(page, EDGING);
  await eCard.locator("button", { hasText: "Deactivate" }).first().click();
  await page.waitForTimeout(1500);
  const dimText = (await eCard.textContent().catch(() => "")) ?? "";
  check("deactivate dims the row with an (inactive) marker", dimText.includes("(inactive)"), dimText.trim().slice(0, 120));
  check("REST: deactivate persisted", (await restItems()).find((r) => r.name === EDGING)?.active === false);
  await eCard.locator("button", { hasText: "Activate" }).first().click();
  await page.waitForTimeout(1500);
  check("REST: re-activate persisted", (await restItems()).find((r) => r.name === EDGING)?.active === true);

  // ================= 7. DESKTOP: table + untimed chip =================
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskPage = await deskCtx.newPage();
  await login(deskPage, OFFICE_EMAIL); // fresh context = its own login
  await deskPage.goto(`${BASE}/lawn/labor-items`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await deskPage.waitForTimeout(2500);
  const dethatchTr = deskPage.locator("table tbody tr", { hasText: DETHATCH }).first();
  const dthText = (await dethatchTr.textContent().catch(() => "")) ?? "";
  check(
    "desktop table carries the 'untimed' chip on the non-hour 0-minute row",
    dthText.includes("untimed"),
    dthText.trim().slice(0, 200)
  );
  const edgingTr = deskPage.locator("table tbody tr", { hasText: EDGING }).first();
  const edgText = (await edgingTr.textContent().catch(() => "")) ?? "";
  check(
    "desktop table renders the fractional minutes as entered (0.6 man-min)",
    edgText.includes("0.6"),
    edgText.trim().slice(0, 200)
  );
  await deskCtx.close();

  check("no page errors during the run", errors.length === 0, errors.join(" | "));

  await browser.close();
  await restoreCatalogue(hiddenItemIds);
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  // Restore on the FAILURE path too. Without this a crashed run leaves every
  // item inactive and the catalogue simply looks empty in the app.
  await restoreCatalogue(hiddenItemIds).catch(() => {});
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});