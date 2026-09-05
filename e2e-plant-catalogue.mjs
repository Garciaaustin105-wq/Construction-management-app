// Browser E2E for the lawn plant & tree catalogue at /lawn/plants — species +
// sizes (quick-estimator roadmap phase 2, catalogue screen only; placement is
// a later handoff). Office/PM CRUD straight through RLS against the LIVE DB:
//   - gates: crew account bounced, office admin reaches the screen
//   - empty state leads with the one-sentence explainer + add button
//   - species add/edit/deactivate/activate with REST persistence proofs
//   - sizes: add (3 gal → 7 gal → 15 gal), render in sort_order — NOT
//     alphabetically (alphabetical would give 15, 3, 7)
//   - margin renders for a priced size, "—" for an unpriced one (never 0%);
//     install_minutes 0 renders "—" too (not estimated, never free)
//   - species delete cascades its sizes (FK) — REST proves both tables empty
//   - test data: Terra Verde Test Co (600d02fa…), fabricated; every
//     plant_products row for the org is wiped at start and end (sizes cascade)
//
// Run (from the repo/worktree root — needs the worktree dev server up):
//   npx next dev -p 3007            # in the worktree, once
//   node e2e-plant-catalogue.mjs
// playwright is not a repo dependency; if `import 'playwright'` fails, point
// PLAYWRIGHT_DIR at an install (e.g. Tools/e2e-lawn/node_modules/playwright).
// Each browser context performs its own /login fragment login (a fresh context
// carries no session), the desktop delete phase needs its OWN page.on('dialog')
// (Playwright auto-dismisses unhandled confirm()s, and confirm() returning
// false silently aborts the delete — that cost two iterations to find), and
// mobile cards carry no delete button (chemical-manager parity), so the
// delete phase runs at 1440px where the table has it.
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
const BOTANICAL = "Ilex vomitoria 'Nana'";

// REST reads are service-role and the endpoint throttles rapid-fire probes;
// the browser actions pace these naturally, with small waits before each.
async function restSpecies() {
  await new Promise((r) => setTimeout(r, 1200));
  const { data, error } = await admin
    .from("plant_products")
    .select("id, name, botanical_name, category, color, notes, active")
    .eq("organization_id", ORG);
  if (error) throw new Error("rest species read: " + error.message);
  return data ?? [];
}
async function restSizes() {
  await new Promise((r) => setTimeout(r, 1200));
  const { data, error } = await admin
    .from("plant_product_sizes")
    .select("id, plant_product_id, size, cost, unit_price, install_minutes, sort_order, active")
    .eq("organization_id", ORG)
    .order("sort_order");
  if (error) throw new Error("rest sizes read: " + error.message);
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

async function gotoPlants(page) {
  await page.goto(`${BASE}/lawn/plants`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(2500); // route compile + RLS fetch
}

// The size-name spans inside the expanded panel carry a min-width marker
// class; reading them in DOM order is the sort_order assertion.
async function renderedSizeOrder(page) {
  return page.evaluate(() => {
    const li = [...document.querySelectorAll("ul li")].find((el) =>
      el.textContent.includes("E2E Dwarf Yaupon")
    );
    if (!li) return null;
    return [...li.querySelectorAll("span")]
      .filter((s) => s.className.includes("min-w-[64px]"))
      .map((s) => s.textContent.trim());
  });
}

async function addSize(page, { size, cost, price, minutes }) {
  const panel = page.locator("ul li div.rounded-lg.border", { hasText: "Add size" }).first();
  await panel.locator("button", { hasText: "Add size" }).click();
  const form = panel.locator("form");
  await form.locator('input[placeholder^="Size"]').fill(size);
  if (cost) await form.locator("label", { hasText: "Cost per plant" }).locator("input").fill(cost);
  if (price) await form.locator("label", { hasText: /^Price/ }).locator("input").fill(price);
  if (minutes) await form.locator("label", { hasText: "Install time" }).locator("input").fill(minutes);
  await form.locator('button[type="submit"]').click();
  await page.getByText("Size added").waitFor({ timeout: 15_000 }).catch(() => {});
  await form.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
}

async function main() {
  // Reset: wipe the org's catalogue (sizes cascade via FK).
  await admin.from("plant_products").delete().eq("organization_id", ORG);
  const startSpecies = await restSpecies();
  console.log(`baseline: ${startSpecies.length} plant_products row(s) for the test org (after reset)`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  let confirmCount = 0;
  page.on("dialog", (d) => { confirmCount++; d.accept().catch(() => {}); });

  await login(page, OFFICE_EMAIL);

  // ================= 1. EMPTY STATE =================
  await gotoPlants(page);
  check("office admin reaches /lawn/plants", page.url().endsWith("/lawn/plants"), page.url());
  const emptyP = page.getByText("Your plant & tree catalog is empty", { exact: false }).first();
  await emptyP.waitFor({ timeout: 30_000 }).catch(() => {});
  check("empty state leads with the one-sentence explainer", await emptyP.isVisible().catch(() => false));
  const firstAdd = page.getByRole("button", { name: "Add your first plant" });
  check("empty state offers the add button", await firstAdd.isVisible().catch(() => false));

  // ================= 2. GATE: crew bounced =================
  const crewCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const crewPage = await crewCtx.newPage();
  await login(crewPage, CREW_EMAIL);
  await crewPage.goto(`${BASE}/lawn/plants`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await crewPage.waitForTimeout(2500);
  check("crew account is bounced off /lawn/plants", !crewPage.url().includes("/lawn/plants"), crewPage.url());
  await crewCtx.close();

  // ================= 3. ADD SPECIES =================
  await firstAdd.click();
  const drawer = page.locator('aside[role="dialog"]');
  await drawer.waitFor({ timeout: 15_000 });
  await drawer.locator('input[placeholder="Plant or tree name *"]').fill(SPECIES);
  await drawer.locator('input[placeholder^="Botanical name"]').fill(BOTANICAL);
  await drawer.locator("select").selectOption("shrub");
  await drawer.getByRole("button", { name: "Colour #3b82f6" }).click();
  await drawer.locator("textarea").fill("E2E species note");
  await drawer.locator('button[type="submit"]').click();
  await page.getByText("Plant added").waitFor({ timeout: 15_000 }).catch(() => {});
  check("toast 'Plant added' after submit", await page.getByText("Plant added").isVisible().catch(() => false));
  await drawer.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});

  const card = page.locator("ul li").first();
  const cardText = (await card.textContent().catch(() => "")) ?? "";
  check(
    "mobile card shows name, botanical name and 'No sizes yet'",
    cardText.includes(SPECIES) && cardText.includes(BOTANICAL) && cardText.includes("No sizes yet"),
    cardText.trim().slice(0, 140)
  );
  const speciesRows = await restSpecies();
  const sp = speciesRows.find((r) => r.name === SPECIES);
  check(
    "REST: species persisted (botanical name, category, colour, notes; NO price columns)",
    !!sp && sp.botanical_name === BOTANICAL && sp.category === "shrub" && sp.color === "#3b82f6" && sp.active === true,
    JSON.stringify(sp)
  );

  // ================= 4. SIZE EDITOR: three sizes, sort_order not alphabetical =================
  await card.locator(`button[aria-label="Show sizes for ${SPECIES}"]`).click();
  await card.getByText("No sizes yet", { exact: false }).first().waitFor({ timeout: 10_000 });
  check("expanded panel shows the unfinished 'No sizes yet' state", true);

  await addSize(page, { size: "3 gal", cost: "9.50", price: "38", minutes: "20" });
  await addSize(page, { size: "7 gal", cost: "45", price: "95", minutes: "40" });
  await addSize(page, { size: "15 gal", cost: "85", price: "140", minutes: "60" });

  const order = await renderedSizeOrder(page);
  check(
    "sizes render in sort_order (3, 7, 15) — alphabetical would be 15, 3, 7",
    JSON.stringify(order) === JSON.stringify(["3 gal", "7 gal", "15 gal"]),
    JSON.stringify(order)
  );
  const sizes = await restSizes();
  const bySize = Object.fromEntries(sizes.map((s) => [s.size, s]));
  check(
    "REST: all three sizes persisted with sort_order 0, 1, 2",
    sizes.length === 3 &&
      bySize["3 gal"]?.sort_order === 0 && bySize["7 gal"]?.sort_order === 1 && bySize["15 gal"]?.sort_order === 2,
    JSON.stringify(sizes.map((s) => [s.size, s.sort_order]))
  );

  // ================= 5. MARGIN + INSTALL DISPLAY RULES =================
  const panelText = (await card.textContent().catch(() => "")) ?? "";
  check(
    "margin renders for a priced size, labelled material",
    panelText.includes("75% material margin") && panelText.includes("53% material margin"),
    panelText.slice(0, 200)
  );
  check("install minutes render as man-min", panelText.includes("20 man-min") && panelText.includes("60 man-min"));

  await addSize(page, { size: "#5", cost: "12" }); // price + install left empty
  // Assert on the #5 row itself — the panel also carries priced rows whose
  // "20 man-min" would substring-match a naive "0 man-min" check.
  const row5 = page.locator("div.flex.items-start", {
    has: page.locator('button[aria-label="Edit size #5"]'),
  }).first();
  const row5Text = (await row5.textContent().catch(() => "")) ?? "";
  check(
    "unpriced size renders margin as '—' (never 0%) and install as '—'",
    row5Text.includes("—") && !row5Text.includes("material margin") && !row5Text.includes("man-min"),
    row5Text.trim().slice(0, 200)
  );
  const restAfterUnpriced = await restSizes();
  const unpriced = restAfterUnpriced.find((s) => s.size === "#5");
  check(
    "REST: unpriced size persisted with unit_price 0 and install_minutes 0",
    !!unpriced && Number(unpriced.unit_price) === 0 && Number(unpriced.install_minutes) === 0,
    JSON.stringify(unpriced)
  );

  // ================= 6. SIZE EDIT (price change) =================
  await card.locator('button[aria-label="Edit size 7 gal"]').click();
  const form = card.locator("form");
  await form.locator("label", { hasText: /^Price/ }).locator("input").fill("105");
  await form.locator('button[type="submit"]').click();
  await page.getByText("Size updated").waitFor({ timeout: 15_000 }).catch(() => {});
  check("toast 'Size updated' after edit", await page.getByText("Size updated").isVisible().catch(() => false));
  await form.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  const afterEdit = await restSizes();
  check("REST: size edit persisted ($95 → $105)", Number(afterEdit.find((s) => s.size === "7 gal")?.unit_price) === 105);

  // ================= 7. SPECIES DEACTIVATE / ACTIVATE =================
  await card.locator("button", { hasText: "Deactivate" }).click();
  await page.waitForTimeout(1500);
  const dimText = (await card.textContent().catch(() => "")) ?? "";
  check("deactivate dims the row with an (inactive) marker", dimText.includes("(inactive)"), dimText.trim().slice(0, 120));
  check("REST: deactivate persisted", (await restSpecies()).find((r) => r.name === SPECIES)?.active === false);
  await card.locator("button", { hasText: "Activate" }).click();
  await page.waitForTimeout(1500);
  check("REST: re-activate persisted", (await restSpecies()).find((r) => r.name === SPECIES)?.active === true);

  // ================= 8. DESKTOP: table + warned deletes (species cascades) =================
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskPage = await deskCtx.newPage();
  deskPage.on("dialog", (d) => { confirmCount++; d.accept().catch(() => {}); });
  await login(deskPage, OFFICE_EMAIL); // fresh context = its own login
  await deskPage.goto(`${BASE}/lawn/plants`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await deskPage.waitForTimeout(2500);
  check("desktop table shows the same catalogue (count header)", await deskPage.getByText("1 species").isVisible().catch(() => false));

  // Scope to the table: the hidden mobile card (display:none but in the DOM)
  // carries the same aria-labels, and strict mode counts hidden elements.
  const deskTable = deskPage.locator("table");
  await deskTable.locator(`button[aria-label="Show sizes for ${SPECIES}"]`).click();
  await deskTable.getByText("75% material margin").waitFor({ timeout: 10_000 }).catch(() => {});
  check("desktop size rows render cost/price/margin/install", await deskTable.getByText("75% material margin").isVisible().catch(() => false));

  // Delete the "#5" size via the contract's deletePlantSize.
  const confirmsBefore = confirmCount;
  await deskTable.locator('button[aria-label="Delete size #5"]').click();
  await deskPage.getByText("Size deleted").waitFor({ timeout: 15_000 }).catch(() => {});
  check("size delete warns with a confirm dialog", confirmCount > confirmsBefore);
  check("toast 'Size deleted'", await deskPage.getByText("Size deleted").isVisible().catch(() => false));
  check("REST: size really deleted", !(await restSizes()).some((s) => s.size === "#5"));

  // Delete the species → its sizes cascade with it (FK on delete cascade).
  await deskTable.locator(`button[aria-label="Delete ${SPECIES}"]`).click();
  await deskPage.getByText("Plant deleted").waitFor({ timeout: 15_000 }).catch(() => {});
  check("species delete warns with a confirm dialog", confirmCount > confirmsBefore + 1);
  check("toast 'Plant deleted'", await deskPage.getByText("Plant deleted").isVisible().catch(() => false));
  const finalSpecies = await restSpecies();
  const finalSizes = await restSizes();
  check("REST: species gone", finalSpecies.length === 0, JSON.stringify(finalSpecies));
  check("REST: its sizes cascaded with it", finalSizes.length === 0, JSON.stringify(finalSizes));

  check("empty state returns after the catalogue is emptied",
    await deskPage.getByText("Your plant & tree catalog is empty", { exact: false }).first().isVisible().catch(() => false));
  await deskCtx.close();

  check("no page errors during the run", errors.length === 0, errors.join(" | "));

  await browser.close();
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });