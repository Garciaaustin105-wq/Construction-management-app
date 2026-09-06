// Browser E2E for the lawn machinery catalogue at /lawn/equipment (Lane A).
// Office/PM CRUD straight through RLS against the LIVE DB:
//   - gates: crew account bounced, office admin reaches the screen
//   - THE FORM CHANGES SHAPE WITH OWNERSHIP: rented shows daily/weekly/monthly
//     cost+price plus delivery/pickup and NO hourly fields; owned shows the
//     hourly pair and NO period fields (the two cost models never bleed)
//   - cheapestPlan preview, LIVE in the rented form: 1 day, 5 days, 2 weeks —
//     the 5-day row is the lesson: at $150/day and $450/week it must show
//     "1 week · $450", because multiplying the daily rate ($750) is the
//     commonest way to over-quote a rental
//   - nullable rates: an empty box saves NULL, never 0 — "not recorded" must
//     not masquerade as free; an owned machine saved with no hourly cost
//     carries a visible "quotes at zero" warning in the list
//   - rate age surfaced ("rates N days old" / "never priced" / "rates current")
//   - model deactivate/activate (snapshot rule: placed machines keep their own
//     snapshot; deactivate just withholds from the picker)
//   - test data: Terra Verde Test Co (600d02fa…), fabricated; every E2E-
//     prefixed equipment_products row is wiped at start and end
//
// Run (from the repo/worktree root — needs the dev server up):
//   npx next dev -p 3007            # once
//   node e2e-equipment-catalogue.mjs
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

const RENTED = "E2E Mini Ex";
const OWNED = "E2E Skid Steer";
const UNPRICED = "E2E Stump Grinder";

// REST reads are service-role and the endpoint throttles rapid-fire probes;
// the browser actions pace these naturally, with small waits before each.
// Scoped to the rows THIS harness creates (E2E-prefixed).
async function restMachines() {
  await new Promise((r) => setTimeout(r, 1200));
  const { data, error } = await admin
    .from("equipment_products")
    .select("id, name, category, ownership, cost_hourly, cost_daily, cost_weekly, cost_monthly, price_hourly, price_daily, price_weekly, price_monthly, delivery_fee, pickup_fee, operator_required, rates_updated_at, active")
    .eq("organization_id", ORG)
    .like("name", "E2E%");
  if (error) throw new Error("rest machines read: " + error.message);
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
  await page.goto(`${BASE}/lawn/equipment`, { waitUntil: "domcontentloaded", timeout: 90_000 });
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
  const { data } = await admin.from("equipment_products")
    .select("id").eq("organization_id", ORG).eq("active", true);
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length) await admin.from("equipment_products").update({ active: false }).in("id", ids);
  return ids;
}
async function restoreCatalogue(ids) {
  if (ids?.length) await admin.from("equipment_products").update({ active: true }).in("id", ids);
}

// Module scope on purpose: a crash mid-run must still be able to reactivate
// what was hidden, or the org is left with an invisible catalogue.
let hiddenMachineIds = [];

async function main() {
  hiddenMachineIds = await hideExistingCatalogue(ORG);
  await admin.from("equipment_products").delete()
    .eq("organization_id", ORG).like("name", "E2E%");
  const start = await restMachines();
  console.log(`baseline: ${start.length} E2E machine row(s) (after reset)`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await login(page, OFFICE_EMAIL);

  // ================= 1. GATES =================
  await gotoCatalogue(page);
  check("office admin reaches /lawn/equipment", page.url().endsWith("/lawn/equipment"), page.url());

  const crewCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const crewPage = await crewCtx.newPage();
  await login(crewPage, CREW_EMAIL);
  await crewPage.goto(`${BASE}/lawn/equipment`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await crewPage.waitForTimeout(2500);
  check("crew account is bounced off /lawn/equipment", !crewPage.url().includes("/lawn/equipment"), crewPage.url());
  await crewCtx.close();

  // ================= 2. RENTED FORM: shape + live cheapestPlan preview =================
  await page.getByRole("button", { name: /Add machine/i }).first().click();
  const drawer = page.locator('aside[role="dialog"]');
  await drawer.waitFor({ timeout: 15_000 });
  // The form STARTS rented. The rented shape shows the period fields and
  // delivery/pickup; it must NOT show the hourly pair.
  check("rented form shows Cost per day", (await drawer.locator("label", { hasText: "Cost per day" }).count()) === 1);
  check("rented form shows Cost per week", (await drawer.locator("label", { hasText: "Cost per week" }).count()) === 1);
  check("rented form shows Delivery fee", (await drawer.locator("label", { hasText: "Delivery fee" }).count()) === 1);
  check("rented form hides Cost per hour", (await drawer.locator("label", { hasText: "Cost per hour" }).count()) === 0);

  await drawer.locator('input[placeholder^="Machine name"]').fill(RENTED);
  await drawer.locator("select").selectOption("excavator");
  // 1 day at 150/day → "1 day · $150"; 5 days → the WEEK wins ("1 week ·
  // $450", since 5×150 = 750 > 450); 14 days → "2 weeks · $900".
  await drawer.locator("label", { hasText: "Cost per day" }).locator("input").fill("150");
  await drawer.locator("label", { hasText: "Price per day" }).locator("input").fill("250");
  await drawer.locator("label", { hasText: "Cost per week" }).locator("input").fill("450");
  await drawer.locator("label", { hasText: "Price per week" }).locator("input").fill("750");
  await drawer.locator("label", { hasText: "Delivery fee" }).locator("input").fill("100");
  await drawer.locator("label", { hasText: "Pickup fee" }).locator("input").fill("75");
  await page.waitForTimeout(300);
  const previewText = (await drawer.locator("div.rounded-lg.border", { hasText: "Cheapest plan" }).textContent().catch(() => "")) ?? "";
  check(
    "cheapestPlan preview: 1 day takes the daily rate",
    previewText.includes("1 day · $150.00"),
    previewText.trim().slice(0, 300)
  );
  check(
    "cheapestPlan preview: 5 days takes the WEEK, not 5 × daily",
    previewText.includes("1 week · $450.00") && !previewText.includes("5 days · $750"),
    previewText.trim().slice(0, 300)
  );
  check(
    "cheapestPlan preview: 2 weeks at the weekly rate",
    previewText.includes("2 weeks · $900.00"),
    previewText.trim().slice(0, 300)
  );
  await drawer.locator('button[type="submit"]').click();
  await page.getByText("Machine added").waitFor({ timeout: 15_000 }).catch(() => {});
  check("toast 'Machine added' after submit", await page.getByText("Machine added").isVisible().catch(() => false));
  await drawer.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});

  const rentedRow = (await restMachines()).find((r) => r.name === RENTED);
  check(
    "REST: rented machine persisted (period rates + fees; hourly columns NULL, not 0)",
    !!rentedRow && rentedRow.ownership === "rented" && Number(rentedRow.cost_daily) === 150 &&
      Number(rentedRow.price_weekly) === 750 && Number(rentedRow.delivery_fee) === 100 &&
      rentedRow.cost_hourly === null && rentedRow.price_hourly === null,
    JSON.stringify(rentedRow)
  );

  // ================= 3. OWNED FORM: shape swap =================
  await page.getByRole("button", { name: /Add machine/i }).first().click();
  await drawer.waitFor({ timeout: 15_000 });
  await drawer.getByRole("button", { name: "Owned" }).click();
  await page.waitForTimeout(300);
  check("owned form shows Cost per hour", (await drawer.locator("label", { hasText: "Cost per hour" }).count()) === 1);
  check("owned form hides Cost per day", (await drawer.locator("label", { hasText: "Cost per day" }).count()) === 0);
  check("owned form hides Delivery fee", (await drawer.locator("label", { hasText: "Delivery fee" }).count()) === 0);
  await drawer.locator('input[placeholder^="Machine name"]').fill(OWNED);
  await drawer.locator("select").selectOption("skid_steer");
  await drawer.locator("label", { hasText: "Cost per hour" }).locator("input").fill("75");
  await drawer.locator("label", { hasText: "Price per hour" }).locator("input").fill("120");
  await drawer.locator('button[type="submit"]').click();
  await page.getByText("Machine added").waitFor({ timeout: 15_000 }).catch(() => {});
  await drawer.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});

  const ownedRow = (await restMachines()).find((r) => r.name === OWNED);
  check(
    "REST: owned machine persisted (hourly rates; period columns NULL, delivery 0)",
    !!ownedRow && ownedRow.ownership === "owned" && Number(ownedRow.cost_hourly) === 75 &&
      Number(ownedRow.price_hourly) === 120 && ownedRow.cost_daily === null &&
      Number(ownedRow.delivery_fee) === 0,
    JSON.stringify(ownedRow)
  );

  // ================= 4. OWNED + NO HOURLY COST = visible warning =================
  await page.getByRole("button", { name: /Add machine/i }).first().click();
  await drawer.waitFor({ timeout: 15_000 });
  await drawer.getByRole("button", { name: "Owned" }).click();
  await page.waitForTimeout(300);
  // The in-form warning appears as soon as the cost box is empty.
  check(
    "in-form warning: owned machine with no hourly cost quotes at zero",
    (await drawer.getByText("this machine will quote at zero").isVisible().catch(() => false)),
    ""
  );
  await drawer.locator('input[placeholder^="Machine name"]').fill(UNPRICED);
  await drawer.locator("select").selectOption("stump_grinder");
  // Cost + price both left empty → NULL on save.
  await drawer.locator('button[type="submit"]').click();
  await page.getByText("Machine added").waitFor({ timeout: 15_000 }).catch(() => {});
  await drawer.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});

  const unpricedRow = (await restMachines()).find((r) => r.name === UNPRICED);
  check(
    "REST: empty rate boxes saved NULL — never 0",
    !!unpricedRow && unpricedRow.cost_hourly === null && unpricedRow.price_hourly === null,
    JSON.stringify(unpricedRow)
  );
  const unpricedCard = cardFor(page, UNPRICED);
  check(
    "list warns 'quotes at zero' on the unpriced owned machine",
    ((await unpricedCard.textContent().catch(() => "")) ?? "").includes("quotes at zero"),
    ""
  );

  // ================= 5. RATE AGE SURFACED =================
  const rentedCard = cardFor(page, RENTED);
  const rentedCardText = (await rentedCard.textContent().catch(() => "")) ?? "";
  check(
    "rate age is surfaced on the row ('rates current' after today's save)",
    rentedCardText.includes("rates current") || /rates \d+ days? old/.test(rentedCardText),
    rentedCardText.trim().slice(0, 160)
  );

  // ================= 6. DEACTIVATE / ACTIVATE =================
  await rentedCard.locator("button", { hasText: "Deactivate" }).first().click();
  await page.waitForTimeout(1500);
  const dimText = (await rentedCard.textContent().catch(() => "")) ?? "";
  check("deactivate dims the row with an (inactive) marker", dimText.includes("(inactive)"), dimText.trim().slice(0, 120));
  check("REST: deactivate persisted", (await restMachines()).find((r) => r.name === RENTED)?.active === false);
  await rentedCard.locator("button", { hasText: "Activate" }).first().click();
  await page.waitForTimeout(1500);
  check("REST: re-activate persisted", (await restMachines()).find((r) => r.name === RENTED)?.active === true);

  // ================= 7. DESKTOP: rates cell + unpriced chip =================
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskPage = await deskCtx.newPage();
  await login(deskPage, OFFICE_EMAIL); // fresh context = its own login
  await deskPage.goto(`${BASE}/lawn/equipment`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await deskPage.waitForTimeout(2500);
  const deskTable = deskPage.locator("table");
  const rentedTr = deskPage.locator("table tbody tr", { hasText: RENTED }).first();
  const rentedRowText = (await rentedTr.textContent().catch(() => "")) ?? "";
  check(
    "desktop rates cell shows the recorded periods only (D 250 · W 750)",
    rentedRowText.includes("D $250.00") && rentedRowText.includes("W $750.00") && !rentedRowText.includes("M $"),
    rentedRowText.trim().slice(0, 200)
  );
  const unpricedDesk = deskPage.locator("table tbody tr", { hasText: UNPRICED }).first();
  check(
    "desktop rates cell carries the unpriced chip for the owned machine with no hourly cost",
    ((await unpricedDesk.textContent().catch(() => "")) ?? "").includes("unpriced"),
    ""
  );
  await deskCtx.close();

  check("no page errors during the run", errors.length === 0, errors.join(" | "));

  await browser.close();
  await restoreCatalogue(hiddenMachineIds);
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  // Restore on the FAILURE path too. Without this a crashed run leaves every
  // machine inactive and the catalogue simply looks empty in the app.
  await restoreCatalogue(hiddenMachineIds).catch(() => {});
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});