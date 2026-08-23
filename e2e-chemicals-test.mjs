// E2E for the lawn chemical-application tracking DB layer. The POST log +
// CSV export routes are AUTHED (office session), so they're covered by the
// build + manual browser verification (like the review gate-mint half). This
// script verifies the DB layer via the service-role key from .env.local ONLY:
//   1. chemical_products table round-trip (insert/read/delete).
//   2. chemical_applications trigger: set_org_from_job stamps organization_id
//      from job_id on insert (the route OMITS organization_id; the trigger must
//      fill it). Verified by inserting with NO organization_id + a real job_id
//      and reading back the stamped org.
//   3. re_entry_until is the ROUTE's job (computeReEntryUntil), not a DB trigger
//      — a raw insert with re_entry_hours set leaves re_entry_until NULL; that's
//      expected, not a bug. The POST route computes it. (Asserted here so a future
//      "why is re_entry_until null" is diagnosed correctly.)
// No secrets printed. Cleanup deletes every test row.
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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

const MARK = `E2E_CHEM_${Date.now()}`;
const mintedProductIds = [];
const mintedAppIds = [];

async function main() {
  // 1) Find a real lawn org + a real job in it (the trigger reads the job).
  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name, app_variant")
    .eq("app_variant", "lawn")
    .limit(1);
  const org = (orgs ?? [])[0];
  if (!org) throw new Error("No lawn org found — run free-tier/leads SQL?");
  const { data: jobs } = await admin
    .from("jobs")
    .select("id, name")
    .eq("organization_id", org.id)
    .limit(1);
  const job = (jobs ?? [])[0];
  if (!job) throw new Error(`No job found in lawn org ${org.name} — seed one.`);
  console.log(`Using lawn org: ${org.name} (${org.id})`);
  console.log(`Using job: ${job.name} (${job.id})`);
  console.log(`Test marker: ${MARK}\n`);

  // 2) chemical_products round-trip.
  console.log("[chemical_products]");
  const { data: prod, error: pErr } = await admin
    .from("chemical_products")
    .insert({
      organization_id: org.id,
      name: `${MARK} Test Product`,
      epa_reg_number: "E2E-123-456",
      active_ingredient: "Glyphosate 41%",
      default_rate: 2.5,
      rate_unit: "oz/1000sqft",
      re_entry_hours: 4,
      active: true,
      notes: MARK,
    })
    .select("id, name, epa_reg_number, re_entry_hours")
    .single();
  check("insert product", !pErr && !!prod, pErr?.message);
  if (prod) mintedProductIds.push(prod.id);
  check("read back fields",
    !!prod && prod.name.startsWith(MARK) && prod.epa_reg_number === "E2E-123-456" && prod.re_entry_hours === 4);

  // 3) chemical_applications — trigger stamps organization_id from job_id.
  //    Insert with NO organization_id (the route does this); the
  //    set_org_from_job trigger must fill it. product_name is NOT NULL.
  console.log("\n[chemical_applications]");
  const { data: app, error: aErr } = await admin
    .from("chemical_applications")
    .insert({
      job_id: job.id,
      product_id: prod?.id ?? null,
      product_name: `${MARK} Test App`,
      quantity_used: 10,
      quantity_unit: "oz",
      rate: 2.5,
      area_treated_sqft: 5000,
      target_pest: "weeds",
      wind_mph: 5,
      temp_f: 72,
      applied_at: new Date().toISOString(),
      re_entry_hours: 4,
      notes: MARK,
    })
    .select("id, organization_id, job_id, product_id, product_name, re_entry_hours, re_entry_until")
    .single();
  check("insert application", !aErr && !!app, aErr?.message);
  if (app) mintedAppIds.push(app.id);
  check("trigger stamped organization_id from job_id",
    !!app && app.organization_id === org.id,
    app ? `got ${app.organization_id}` : "");
  check("re_entry_until is NULL on raw insert (route computes it, not the DB)",
    !!app && app.re_entry_until === null,
    app ? `got ${app.re_entry_until}` : "");

  // 4) Cleanup.
  console.log("\n[cleanup]");
  for (const id of mintedAppIds) {
    const { error } = await admin.from("chemical_applications").delete().eq("id", id);
    check(`delete application ${id.slice(0, 8)}`, !error, error?.message);
  }
  for (const id of mintedProductIds) {
    const { error } = await admin.from("chemical_products").delete().eq("id", id);
    check(`delete product ${id.slice(0, 8)}`, !error, error?.message);
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });