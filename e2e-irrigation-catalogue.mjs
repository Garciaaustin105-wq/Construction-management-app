// Browser E2E for the lawn sprinkler-head catalogue at /lawn/irrigation —
// models + nozzles (Lane A). Office/PM CRUD straight through RLS against the
// LIVE DB:
//   - gates: crew account bounced, office admin reaches the screen
//   - model add (identity only — a head MODEL carries no price; prices live
//     on nozzles, exactly as a plant species carries none and its sizes do)
//   - nozzles: add (3.0 → 15-VAN → MP3000), render in sort_order — NOT
//     alphabetically (alphabetical would give 15-VAN, 3.0, MP3000)
//   - THE THROW FIELD: labelled "Throw from the head (ft)", renders
//     describeThrow() LIVE while typing — "30 ft from the head · 60 ft
//     across" — so entering the diameter is visible at the moment of entry
//   - radius 0 renders as NOT RECORDED ("throw not recorded"), never "0 ft
//     from the head" (54 seeded nozzles ship in exactly that state)
//   - nozzle edit + warned delete; model deactivate/activate (deactivate-not-
//     delete: placed heads snapshot their own data, but a deleted model can't
//     be placed again)
//   - test data: Terra Verde Test Co (600d02fa…), fabricated; every E2E-
//     prefixed irrigation_products row is wiped at start and end (its nozzles
//     go first, by irrigation_product_id — no FK-cascade reliance)
//
// Run (from the repo/worktree root — needs the dev server up):
//   npx next dev -p 3007            # once
//   node e2e-irrigation-catalogue.mjs
// playwright is not a repo dependency; if `import 'playwright'` fails, point
// PLAYWRIGHT_DIR at an install (e.g. Tools/e2e-lawn/node_modules/playwright).
// Each browser context performs its own /login fragment login (a fresh context
// carries no session), and the desktop delete phase needs its OWN
// page.on('dialog') — Playwright auto-dismisses unhandled confirm()s, and
// confirm() returning false silently aborts the delete.
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

const MODEL = "E2E PGP Rotor";

// REST reads are service-role and the endpoint throttles rapid-fire probes;
// the browser actions pace these naturally, with small waits before each.
// Both readers are scoped to the rows THIS harness creates (E2E-prefixed).
async function restModels() {
  await new Promise((r) => setTimeout(r, 1200));
  const { data, error } = await admin
    .from("irrigation_products")
    .select("id, name, category, color, notes, active")
    .eq("organization_id", ORG)
    .like("name", "E2E%");
  if (error) throw new Error("rest models read: " + error.message);
  return data ?? [];
}
async function restNozzles() {
  await new Promise((r) => setTimeout(r, 1200));
  // Nozzles carry no org-scoped name pattern of their own, so scope them
  // through the E2E models.
  const models = await restModels();
  const ids = models.map((m) => m.id);
  if (ids.length === 0) return [];
  const { data, error } = await admin
    .from("irrigation_product_nozzles")
    .select("id, irrigation_product_id, nozzle, radius_ft, cost, unit_price, install_minutes, sort_order, active")
    .in("irrigation_product_id", ids)
    .order("sort_order");
  if (error) throw new Error("rest nozzles read: " + error.message);
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
  await page.goto(`${BASE}/lawn/irrigation`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(2500); // route compile + RLS fetch
}

// DataTable renders its mobile cards as divs inside a div.lg:hidden (NOT a
// ul/li list like the hand-rolled plant screen) — all mobile selectors here
// go through that wrapper.
const MOBILE_CARD = ".lg\\:hidden > div";
function cardFor(page, text) {
  return page.locator(MOBILE_CARD, { hasText: text }).first();
}

// The nozzle-label spans inside the expanded panel carry a min-width marker
// class; reading them in DOM order is the sort_order assertion.
async function renderedNozzleOrder(page) {
  return page.evaluate(() => {
    const card = [...document.querySelectorAll(".lg\\:hidden > div")].find((el) =>
      el.textContent.includes("E2E PGP Rotor")
    );
    if (!card) return null;
    return [...card.querySelectorAll("span")]
      .filter((s) => s.className.includes("min-w-[64px]"))
      .map((s) => s.textContent.trim());
  });
}

// Opens the inline nozzle form inside the expanded panel and fills it. The
// throw input is found by its LABEL ("Throw from the head (ft)") — the
// panel wraps inputs in <label> elements rather than setting aria-label.
async function addNozzle(page, card, { nozzle, radius, cost, price, minutes }) {
  const panel = card.locator("div.rounded-lg.border", { hasText: "Add nozzle" }).first();
  await panel.locator("button", { hasText: "Add nozzle" }).click();
  const form = panel.locator("form");
  await form.locator('input[placeholder^="Nozzle label"]').fill(nozzle);
  // The live describeThrow hint BEFORE anything is typed: radius 0 = not
  // recorded, and the hint must say so — never render "0 ft from the head".
  await page.waitForTimeout(300);
  const hint0 = (await form.locator("label", { hasText: "Throw from the head" }).textContent().catch(() => "")) ?? "";
  if (!radius) {
    check("live hint for radius 0 says 'throw not recorded' (never \"0 ft\")",
      hint0.includes("throw not recorded") && !hint0.includes("0 ft from the head"),
      hint0.trim().slice(0, 160));
  }
  if (radius) {
    await form.locator("label", { hasText: "Throw from the head" }).locator("input").fill(radius);
    // The hint renders BOTH numbers live, before save — the entire defence
    // against entering the diameter instead of the radius.
    const hint = (await form.locator("label", { hasText: "Throw from the head" }).textContent().catch(() => "")) ?? "";
    const r = Number(radius);
    check(`live hint while typing ${radius} shows both numbers`,
      hint.includes(`${r} ft from the head`) && hint.includes(`${r * 2} ft across`),
      hint.trim().slice(0, 160));
  }
  if (cost) await form.locator("label", { hasText: "Cost ($)" }).locator("input").fill(cost);
  if (price) await form.locator("label", { hasText: /^Price/ }).locator("input").fill(price);
  if (minutes) await form.locator("label", { hasText: "Install time" }).locator("input").fill(minutes);
  await form.locator('button[type="submit"]').click();
  await page.getByText("Nozzle added").waitFor({ timeout: 15_000 }).catch(() => {});
  await form.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Catalogue isolation — same discipline as e2e-plant-catalogue.mjs: DEACTIVATE
// what is already there, run against a clean-looking catalogue, reactivate
// exactly what was deactivated. Deletes below are scoped to the E2E-prefixed
// rows this harness creates, never to the org (the test org holds a seeded
// 54-nozzle catalogue with radii deliberately NOT recorded).
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
  const models = await restModels();
  const ids = models.map((m) => m.id);
  if (ids.length) {
    await admin.from("irrigation_product_nozzles").delete().in("irrigation_product_id", ids);
    await admin.from("irrigation_products").delete().in("id", ids);
  }
}

// Module scope on purpose: a crash mid-run must still be able to reactivate
// what was hidden, or the org is left with an invisible catalogue.
let hiddenModelIds = [];

async function main() {
  hiddenModelIds = await hideExistingCatalogue(ORG);
  await deleteE2eRows();
  const startModels = await restModels();
  console.log(`baseline: ${startModels.length} E2E model row(s) (after reset)`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  let confirmCount = 0;
  page.on("dialog", (d) => { confirmCount++; d.accept().catch(() => {}); });

  await login(page, OFFICE_EMAIL);

  // ================= 1. GATES =================
  await gotoCatalogue(page);
  check("office admin reaches /lawn/irrigation", page.url().endsWith("/lawn/irrigation"), page.url());

  const crewCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const crewPage = await crewCtx.newPage();
  await login(crewPage, CREW_EMAIL);
  await crewPage.goto(`${BASE}/lawn/irrigation`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await crewPage.waitForTimeout(2500);
  check("crew account is bounced off /lawn/irrigation", !crewPage.url().includes("/lawn/irrigation"), crewPage.url());
  await crewCtx.close();

  // ================= 2. ADD MODEL =================
  await page.getByRole("button", { name: /Add model/i }).first().click();
  const drawer = page.locator('aside[role="dialog"]');
  await drawer.waitFor({ timeout: 15_000 });
  await drawer.locator('input[placeholder^="Model name"]').fill(MODEL);
  await drawer.locator("select").selectOption("rotor");
  await drawer.getByRole("button", { name: "Colour #3b82f6" }).click();
  await drawer.locator("textarea").fill("E2E model note");
  await drawer.locator('button[type="submit"]').click();
  await page.getByText("Model added").waitFor({ timeout: 15_000 }).catch(() => {});
  check("toast 'Model added' after submit", await page.getByText("Model added").isVisible().catch(() => false));
  await drawer.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});

  const card = cardFor(page, MODEL);
  const cardText = (await card.textContent().catch(() => "")) ?? "";
  check(
    "mobile card shows the model with 'No nozzles yet'",
    cardText.includes(MODEL) && cardText.includes("No nozzles yet"),
    cardText.trim().slice(0, 140)
  );
  const modelRows = await restModels();
  const m = modelRows.find((r) => r.name === MODEL);
  check(
    "REST: model persisted (category, colour, notes) — identity only",
    !!m && m.category === "rotor" && m.color === "#3b82f6" && m.active === true,
    JSON.stringify(m)
  );

  // ================= 3. NOZZLE EDITOR: sort_order not alphabetical =================
  await card.locator(`button[aria-label="Show nozzles for ${MODEL}"]`).click();
  await card.getByText("No nozzles yet", { exact: false }).first().waitFor({ timeout: 10_000 });
  check("expanded panel shows the unfinished 'No nozzles yet' state", true);

  await addNozzle(page, card, { nozzle: "3.0", radius: "30", cost: "2.10", price: "8", minutes: "2" });
  await addNozzle(page, card, { nozzle: "15-VAN", radius: "15", cost: "1.40", price: "5", minutes: "2" });
  await addNozzle(page, card, { nozzle: "MP3000", cost: "3.80", price: "14", minutes: "3" }); // throw NOT recorded (radius left empty)

  const order = await renderedNozzleOrder(page);
  check(
    "nozzles render in sort_order (3.0, 15-VAN, MP3000) — alphabetical would be 15-VAN, 3.0, MP3000",
    JSON.stringify(order) === JSON.stringify(["3.0", "15-VAN", "MP3000"]),
    JSON.stringify(order)
  );
  const nozzles = await restNozzles();
  const byNozzle = Object.fromEntries(nozzles.map((n) => [n.nozzle, n]));
  check(
    "REST: all three nozzles persisted with sort_order 0, 1, 2",
    nozzles.length === 3 &&
      byNozzle["3.0"]?.sort_order === 0 && byNozzle["15-VAN"]?.sort_order === 1 && byNozzle["MP3000"]?.sort_order === 2,
    JSON.stringify(nozzles.map((n) => [n.nozzle, n.sort_order]))
  );

  // ================= 4. THROW DISPLAY RULES =================
  const panelText = (await card.textContent().catch(() => "")) ?? "";
  check(
    "recorded throw renders both numbers ('30 ft from the head · 60 ft across')",
    panelText.includes("30 ft from the head · 60 ft across"),
    panelText.slice(0, 200)
  );
  const mpRow = page.locator("div.flex.items-start", {
    has: page.locator('button[aria-label="Edit nozzle MP3000"]'),
  }).last();
  const mpText = (await mpRow.textContent().catch(() => "")) ?? "";
  check(
    "radius 0 renders as NOT RECORDED ('throw not recorded'), never '0 ft'",
    mpText.includes("throw not recorded") && !mpText.includes("0 ft from the head"),
    mpText.trim().slice(0, 200)
  );
  check(
    "REST: MP3000 persisted with radius_ft 0 (deliberately unrecorded throw)",
    Number(byNozzle["MP3000"]?.radius_ft) === 0,
    JSON.stringify(byNozzle["MP3000"])
  );

  // ================= 5. NOZZLE EDIT (price change) =================
  await card.locator('button[aria-label="Edit nozzle 15-VAN"]').click();
  const form = card.locator("form");
  await form.locator("label", { hasText: /^Price/ }).locator("input").fill("9");
  await form.locator('button[type="submit"]').click();
  await page.getByText("Nozzle updated").waitFor({ timeout: 15_000 }).catch(() => {});
  check("toast 'Nozzle updated' after edit", await page.getByText("Nozzle updated").isVisible().catch(() => false));
  await form.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  const afterEdit = await restNozzles();
  check("REST: nozzle edit persisted ($8 → $9)", Number(afterEdit.find((n) => n.nozzle === "15-VAN")?.unit_price) === 9);

  // ================= 6. MODEL DEACTIVATE / ACTIVATE =================
  await card.locator("button", { hasText: "Deactivate" }).first().click();
  await page.waitForTimeout(1500);
  const dimText = (await card.textContent().catch(() => "")) ?? "";
  check("deactivate dims the row with an (inactive) marker", dimText.includes("(inactive)"), dimText.trim().slice(0, 120));
  check("REST: deactivate persisted", (await restModels()).find((r) => r.name === MODEL)?.active === false);
  await card.locator("button", { hasText: "Activate" }).first().click();
  await page.waitForTimeout(1500);
  check("REST: re-activate persisted", (await restModels()).find((r) => r.name === MODEL)?.active === true);

  // ================= 7. DESKTOP: table + expansion + warned nozzle delete =================
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskPage = await deskCtx.newPage();
  deskPage.on("dialog", (d) => { confirmCount++; d.accept().catch(() => {}); });
  await login(deskPage, OFFICE_EMAIL); // fresh context = its own login
  await deskPage.goto(`${BASE}/lawn/irrigation`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await deskPage.waitForTimeout(2500);

  const deskTable = deskPage.locator("table");
  await deskTable.locator(`button[aria-label="Show nozzles for ${MODEL}"]`).click();
  await deskTable.getByText("30 ft from the head · 60 ft across").first().waitFor({ timeout: 10_000 }).catch(() => {});
  check("desktop expansion renders nozzle rows inside the table", await deskTable.getByText("30 ft from the head · 60 ft across").first().isVisible().catch(() => false));

  // Delete the MP3000 nozzle via the contract's deleteIrrigationNozzle.
  const confirmsBefore = confirmCount;
  await deskTable.locator('button[aria-label="Delete nozzle MP3000"]').click();
  await deskPage.getByText("Nozzle deleted").waitFor({ timeout: 15_000 }).catch(() => {});
  check("nozzle delete warns with a confirm dialog", confirmCount > confirmsBefore);
  check("toast 'Nozzle deleted'", await deskPage.getByText("Nozzle deleted").isVisible().catch(() => false));
  check("REST: nozzle really deleted", !(await restNozzles()).some((n) => n.nozzle === "MP3000"));
  await deskCtx.close();

  check("no page errors during the run", errors.length === 0, errors.join(" | "));

  await browser.close();
  await restoreCatalogue(hiddenModelIds);
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  // Restore on the FAILURE path too. Without this a crashed run leaves every
  // model inactive and the catalogue simply looks empty in the app.
  await restoreCatalogue(hiddenModelIds).catch(() => {});
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});