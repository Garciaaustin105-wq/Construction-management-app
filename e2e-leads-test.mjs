// E2E for the lawn lead-capture path. Runs against the dev server on
// localhost:3000 (variant-neutral — resolves orgs by lead_form_token, not
// build variant). Uses the service-role key from .env.local ONLY to (a) find a
// real lawn org token to hit the public route with, and (b) verify the DB side
// effects + clean up the test rows. The route itself is hit over HTTP, exactly
// as a logged-out prospect would. No secrets are printed.
//
// Auto-reply email: RESEND is not set locally, so the route logs status
// "failed" to notification_log (no real email is sent) — exactly what we want
// for a test.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const BASE = "http://localhost:3000";
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

const MARK = `E2E_LEADS_${Date.now()}`;

async function main() {
  // 1) Find a real lawn org with a lead_form_token.
  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name, lead_form_token, app_variant")
    .eq("app_variant", "lawn")
    .not("lead_form_token", "is", null)
    .limit(1);
  const org = (orgs ?? [])[0];
  if (!org) throw new Error("No lawn org with a lead_form_token found — run leads.sql backfill?");
  const token = org.lead_form_token;
  console.log(`Using lawn org: ${org.name} (${org.id})`);
  console.log(`Test marker: ${MARK}\n`);

  // 2) Public form page renders for a valid token.
  const pageRes = await fetch(`${BASE}/lead/${token}`);
  const pageHtml = await pageRes.text();
  check("GET /lead/[token] → 200", pageRes.status === 200, `got ${pageRes.status}`);
  check("page renders org name", pageHtml.includes(org.name), "org name missing");
  check("page renders the form (name field)", /name="name"/.test(pageHtml), "no name input");

  // 3) Valid capture POST.
  const captureBody = { token, name: MARK, phone: "+15555550100", service_interest: "weekly mowing", source: "referral", referral_detail: "E2E" };
  const cap = await fetch(`${BASE}/api/leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(captureBody) });
  const capJson = await cap.json();
  check("POST /api/leads valid → 201", cap.status === 201, `got ${cap.status} ${JSON.stringify(capJson)}`);
  const leadId = capJson.leadId;
  check("response includes leadId", !!leadId, JSON.stringify(capJson));

  if (leadId) {
    const { data: lead } = await admin.from("leads").select("*").eq("id", leadId).maybeSingle();
    check("lead row exists", !!lead);
    check("lead status = new", lead?.status === "new", lead?.status);
    check("lead source = referral", lead?.source === "referral", lead?.source);
    check("lead referral_detail persisted", lead?.referral_detail === "E2E", lead?.referral_detail);
    check("lead org matches token org", lead?.organization_id === org.id);

    // office feed notification
    const { data: notif } = await admin.from("notifications")
      .select("*").eq("type", "new_lead").eq("entity_id", leadId).maybeSingle();
    check("new_lead notification inserted", !!notif);

    // auto-reply log (no Resend locally → status failed/skipped, NOT a real send)
    const { data: log } = await admin.from("notification_log")
      .select("*").eq("entity_type", "lead").eq("entity_id", leadId).maybeSingle();
    check("notification_log row inserted", !!log);
    check("log event = lead_welcome", log?.event === "lead_welcome", log?.event);
    check("log channel = email", log?.channel === "email", log?.channel);
    console.log(`    (auto-reply log status: ${log?.status} — expected failed/skipped since RESEND unset)`);
  }

  // 4) Honeypot → silent 201, nothing inserted.
  const beforeHp = (await admin.from("leads").select("id", { count: "exact", head: true })).count ?? 0;
  const hp = await fetch(`${BASE}/api/leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, name: `${MARK}_HP`, company_website: "http://spam.example" }) });
  const hpJson = await hp.json();
  check("honeypot → 201", hp.status === 201, `got ${hp.status}`);
  const afterHp = (await admin.from("leads").select("id", { count: "exact", head: true })).count ?? 0;
  check("honeypot inserted nothing (count unchanged)", afterHp === beforeHp, `${beforeHp} → ${afterHp}`);

  // 5) Bogus token (WITH contact so it passes validation and reaches the
  //    token-resolution 404, not the contact-required 400).
  const bogus = await fetch(`${BASE}/api/leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "not-a-real-token", name: "x", email: "x@x.com" }) });
  check("bogus token → 404", bogus.status === 404, `got ${bogus.status}`);

  // 6) Missing name → 400.
  const noName = await fetch(`${BASE}/api/leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, phone: "x" }) });
  check("missing name → 400", noName.status === 400, `got ${noName.status}`);

  // 7) Missing email AND phone → 400.
  const noContact = await fetch(`${BASE}/api/leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, name: "y" }) });
  check("missing email+phone → 400", noContact.status === 400, `got ${noContact.status}`);

  // 8) Bogus source falls back to 'website' (route defaults), not rejected.
  const badSrc = await fetch(`${BASE}/api/leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, name: `${MARK}_SRC`, phone: "+15555550101", source: "tiktok" }) });
  const badSrcJson = await badSrc.json();
  const srcLeadId = badSrcJson.leadId;
  check("bad source → still 201 (defaults to website)", badSrc.status === 201, `got ${badSrc.status}`);
  if (srcLeadId) {
    const { data: sl } = await admin.from("leads").select("source").eq("id", srcLeadId).maybeSingle();
    check("bad source defaulted to 'website'", sl?.source === "website", sl?.source);
  }

  // ── Cleanup ──
  console.log("\nCleaning up test rows…");
  // collect all test lead ids (marker prefix)
  const { data: testLeads } = await admin.from("leads").select("id").like("name", `${MARK}%`);
  const ids = (testLeads ?? []).map((r) => r.id);
  if (ids.length) {
    await admin.from("notification_log").delete().in("entity_id", ids);
    await admin.from("notifications").delete().in("entity_id", ids);
    await admin.from("leads").delete().in("id", ids);
    // supabase-js doesn't always return a count on delete; verify by re-query.
    const { count: leftoverLeads } = await admin.from("leads").select("id", { count: "exact", head: true }).in("id", ids);
    check("test leads cleaned up", (leftoverLeads ?? 0) === 0, `${leftoverLeads} left`);
    const { count: leftoverNotif } = await admin.from("notifications").select("id", { count: "exact", head: true }).in("entity_id", ids);
    check("test notifications cleaned up", (leftoverNotif ?? 0) === 0, `${leftoverNotif} left`);
    const { count: leftoverLog } = await admin.from("notification_log").select("id", { count: "exact", head: true }).in("entity_id", ids);
    check("test notification_log cleaned up", (leftoverLog ?? 0) === 0, `${leftoverLog} left`);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("E2E script error:", e); process.exit(2); });