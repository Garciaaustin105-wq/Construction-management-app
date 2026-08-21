// Throwaway: check org billing state for grandfathered $99 lawn sub.
// Loads .env.local itself; prints ONLY plan/plan_status/amount/name/email — never keys.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envPath = new URL("../.env.local", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
if (!existsSync(envPath)) {
  console.error("No .env.local found at", envPath);
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
const url = env["NEXT_PUBLIC_SUPABASE_URL"];
const serviceKey = env["SUPABASE_SERVICE_ROLE_KEY"];
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

// One request only (probe-throttle rule).
const { data, error } = await admin
  .from("organizations")
  .select("name, app_variant, plan, plan_status, subscription_amount_cents, stripe_subscription_id, stripe_customer_id")
  .not("stripe_subscription_id", "is", null);

if (error) {
  console.error("Query failed:", error.message);
  process.exit(1);
}

console.log(`Orgs with a Stripe subscription: ${data?.length ?? 0}\n`);
for (const o of data ?? []) {
  console.log(
    `- ${o.name} [${o.app_variant ?? "?"}] plan=${o.plan} status=${o.plan_status} ` +
      `amount=${o.subscription_amount_cents ?? "(null)"}¢ sub=${o.stripe_subscription_id}`
  );
}

// Also show any org whose amount still looks like legacy $99 (9900) for the lawn variant.
const legacy = (data ?? []).filter((o) => o.subscription_amount_cents === 9900);
console.log(`\nLegacy $99 (9900¢) subs: ${legacy.length}`);
for (const o of legacy) {
  console.log(`  - ${o.name} [${o.app_variant}] plan=${o.plan} status=${o.plan_status}`);
}