// E2E for the lawn review-rating-gate public path. Runs against the dev server
// on localhost:3000 (variant-neutral — resolves review_requests by token, not
// build variant). Uses the service-role key from .env.local ONLY to (a) mint
// test review_requests rows on a real lawn org to hit the public routes with,
// and (b) verify the DB side effects + clean up. The routes themselves are hit
// over HTTP, exactly as a logged-out customer would. No secrets are printed.
//
// The gate-MINT half (status route inserts a review_requests row when a PAID
// lawn org marks a visit done) needs an authenticated office session + a real
// visit, so it's NOT exercised here — it's covered by the build + manual
// browser verification. This script covers the PUBLIC half: /r/{token} render
// + /api/review-feedback submit (the new code).
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

const MARK = `E2E_REV_${Date.now()}`;
const mintedIds = [];
let mintedTokens = [];

async function main() {
  // 1) Find a real lawn org to attach test review_requests to.
  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name, app_variant")
    .eq("app_variant", "lawn")
    .limit(1);
  const org = (orgs ?? [])[0];
  if (!org) throw new Error("No lawn org found — run free-tier/leads SQL?");
  console.log(`Using lawn org: ${org.name} (${org.id})`);
  console.log(`Test marker: ${MARK}\n`);

  // Helper: mint a review_requests row and return its token.
  async function mint(channel = "email") {
    const { data, error } = await admin
      .from("review_requests")
      .insert({ organization_id: org.id, channel })
      .select("id, token")
      .single();
    if (error || !data) throw new Error(`mint failed: ${error?.message}`);
    mintedIds.push(data.id);
    mintedTokens.push(data.token);
    return data.token;
  }

  // 2) Public gate page renders for a valid token.
  const t1 = await mint();
  const pageRes = await fetch(`${BASE}/r/${t1}`);
  const pageHtml = await pageRes.text();
  check("GET /r/[token] → 200", pageRes.status === 200, `got ${pageRes.status}`);
  // Org names HTML-escape in the rendered page ("Peanutz L&L" → "Peanutz L&amp;L").
  check("page renders org name", pageHtml.includes(org.name.replace(/&/g, "&amp;")), "org name missing");
  check("page renders the gate (heading)", /How (did|was) we do|How was your service/.test(pageHtml), "no heading");

  // Page resolve should stamp opened_at + status=opened (one-shot).
  const { data: opened } = await admin.from("review_requests").select("status, opened_at").eq("token", t1).maybeSingle();
  check("resolve stamps status=opened", opened?.status === "opened", opened?.status);
  check("resolve stamps opened_at", !!opened?.opened_at);

  // 3) Happy submit (5★) → 201, status happy, redirectUrl returned.
  const t2 = await mint();
  const happy = await fetch(`${BASE}/api/review-feedback`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: t2, rating: 5 }),
  });
  const happyJson = await happy.json();
  check("happy POST → 201", happy.status === 201, `got ${happy.status} ${JSON.stringify(happyJson)}`);
  check("happy status = happy", happyJson.status === "happy", happyJson.status);
  const { data: happyRow } = await admin.from("review_requests").select("rating, status, feedback, completed_at").eq("token", t2).maybeSingle();
  check("happy row rating=5", happyRow?.rating === 5, String(happyRow?.rating));
  check("happy row status=happy", happyRow?.status === "happy", happyRow?.status);
  check("happy row completed_at set", !!happyRow?.completed_at);
  check("happy row feedback null (none sent)", happyRow?.feedback == null, JSON.stringify(happyRow?.feedback));

  // 4) Unhappy submit (2★) with feedback → 201, status unhappy, no redirectUrl,
  //    and a review_feedback notification dropped for the office.
  const t3 = await mint();
  const unhappy = await fetch(`${BASE}/api/review-feedback`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: t3, rating: 2, feedback: `${MARK} bad` }),
  });
  const unhappyJson = await unhappy.json();
  check("unhappy POST → 201", unhappy.status === 201, `got ${unhappy.status}`);
  check("unhappy status = unhappy", unhappyJson.status === "unhappy", unhappyJson.status);
  check("unhappy redirectUrl null", unhappyJson.redirectUrl == null, JSON.stringify(unhappyJson.redirectUrl));
  const { data: unhappyRow } = await admin.from("review_requests").select("id, rating, status, feedback").eq("token", t3).maybeSingle();
  check("unhappy row rating=2", unhappyRow?.rating === 2);
  check("unhappy row feedback stored", unhappyRow?.feedback === `${MARK} bad`, JSON.stringify(unhappyRow?.feedback));
  // office notification
  const { data: notif } = await admin.from("notifications")
    .select("*").eq("type", "review_feedback").eq("entity_id", unhappyRow.id).maybeSingle();
  check("review_feedback notification inserted", !!notif);

  // 5) Honeypot → 201, nothing stored (rating stays null).
  const t4 = await mint();
  const beforeHp = (await admin.from("review_requests").select("rating", { count: "exact", head: true }).eq("token", t4)).count;
  const hp = await fetch(`${BASE}/api/review-feedback`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: t4, rating: 5, company_website: "http://spam.example" }),
  });
  check("honeypot → 201", hp.status === 201, `got ${hp.status}`);
  const { data: hpRow } = await admin.from("review_requests").select("rating, status").eq("token", t4).maybeSingle();
  check("honeypot row unchanged (rating null)", hpRow?.rating == null, JSON.stringify(hpRow?.rating));

  // 6) Bogus token → 404.
  const bogus = await fetch(`${BASE}/api/review-feedback`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "not-a-real-token", rating: 5 }),
  });
  check("bogus token → 404", bogus.status === 404, `got ${bogus.status}`);

  // 7) Missing rating → 400.
  const noRating = await fetch(`${BASE}/api/review-feedback`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: t1 }),
  });
  check("missing rating → 400", noRating.status === 400, `got ${noRating.status}`);

  // 8) Out-of-range rating → 400.
  const badRating = await fetch(`${BASE}/api/review-feedback`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: t1, rating: 9 }),
  });
  check("rating 9 → 400", badRating.status === 400, `got ${badRating.status}`);

  // 9) GET → 405.
  const getProbe = await fetch(`${BASE}/api/review-feedback`);
  check("GET → 405", getProbe.status === 405, `got ${getProbe.status}`);

  // 10) Bogus token page → notFound(). Turbopack dev renders the not-found page
  //     with status 200 (a known dev artifact; production returns 404 — all the
  //     other token portals /lead /v /q behave identically), so check the body
  //     for the not-found marker rather than the status.
  const badPage = await fetch(`${BASE}/r/not-a-real-token`);
  const badBody = await badPage.text();
  const badNotFound =
    badPage.status === 404 ||
    /not found|this page could not be found|404/i.test(badBody);
  check("GET /r/bogus → notFound", badNotFound, `status=${badPage.status}`);

  // ── Cleanup ──
  console.log("\nCleaning up test rows…");
  if (mintedIds.length) {
    await admin.from("notifications").delete().in("entity_id", mintedIds);
    const { count: leftover } = await admin.from("review_requests").select("id", { count: "exact", head: true }).in("id", mintedIds);
    await admin.from("review_requests").delete().in("id", mintedIds);
    const { count: leftover2 } = await admin.from("review_requests").select("id", { count: "exact", head: true }).in("id", mintedIds);
    check("test review_requests cleaned up", (leftover2 ?? 0) === 0, `${leftover2} left (was ${leftover})`);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("E2E script error:", e); process.exit(2); });