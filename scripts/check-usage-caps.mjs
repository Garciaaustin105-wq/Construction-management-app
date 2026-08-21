// Throwaway READ-ONLY probe: prints each org's current usage vs the Starter +
// Pro caps from src/lib/plans.ts, so we can see whether a downgrade would block
// (downgrade-guard teeth) WITHOUT manually seeding jobs. NO secrets echoed.
// Usage:  node scripts/check-usage-caps.mjs
// (Local-Ollama qwen2.5-coder:14b wrote the first draft; Claude-direct rewrote
//  it — the model counted jobs via .select("*").limit(1) which returns 0/1, and
//  used wrong caps. Verify-then-fix per the local-AI delegation rule.)
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envPath = new URL("../.env.local", import.meta.url);
if (!existsSync(envPath)) {
  console.error("no .env.local found");
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    })
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const GB = 1024 ** 3;
// Mirrors src/lib/plans.ts CONSTRUCTION_TIERS / LAWN_TIERS exactly.
const CAPS = {
  construction: {
    starter: { jobs: 10, customers: 50, crew: 15, seats: 5, storage: 5 * GB },
    pro: { jobs: 50, customers: 500, crew: 100, seats: 25, storage: 25 * GB },
  },
  lawn: {
    starter: { jobs: 25, customers: 100, crew: 25, seats: 5, storage: 5 * GB },
    pro: { jobs: 150, customers: 1000, crew: 150, seats: 25, storage: 75 * GB },
  },
};

// Head-count helper (exact, no rows fetched into memory). extra = [[method, ...args]].
async function count(table, orgId, extra = []) {
  let q = admin.from(table).select("id", { count: "exact", head: true }).eq("organization_id", orgId);
  for (const [k, ...args] of extra) q = q[k](...args);
  const { count, error } = await q;
  if (error) {
    console.error(`${table} count error for ${orgId}:`, error.message);
    return 0;
  }
  return count ?? 0;
}

const { data: orgs, error: oe } = await admin
  .from("organizations")
  .select("id, name, plan, app_variant, storage_bytes");
if (oe) {
  console.error("orgs query error:", oe.message);
  process.exit(1);
}

const fmt = (bytes) => (bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

for (const org of orgs) {
  const variant = org.app_variant || "construction";
  const [jobs, customers, crew, seats] = await Promise.all([
    count("jobs", org.id),
    count("customers", org.id),
    count("crew_members", org.id),
    count("profiles", org.id, [["neq", "role", "customer"]]),
  ]);
  const storage = Number(org.storage_bytes ?? 0) || 0;
  const plan = org.plan || "trial";

  console.log(`\n=== ${org.name ?? "(unnamed)"} [${variant}] plan=${plan} ===`);
  console.log(`  id: ${org.id}`);
  console.log(`  usage: jobs=${jobs}, customers=${customers}, crew=${crew}, seats=${seats}, storage=${fmt(storage)} (${storage})`);

  // Show what a downgrade to Starter / Pro would block against (skip for
  // trial/enterprise/expired/canceled — null/0 caps, not a downgrade target).
  for (const target of ["starter", "pro"]) {
    const cap = CAPS[variant]?.[target];
    if (!cap) continue;
    const dims = [
      ["jobs", jobs, cap.jobs],
      ["customers", customers, cap.customers],
      ["crew", crew, cap.crew],
      ["seats", seats, cap.seats],
      ["storage", storage, cap.storage],
    ];
    const over = dims.filter(([, cur, c]) => cur > c).map(([d, cur, c]) => `${d}: ${cur} > ${c} (remove ${cur - c})`);
    if (over.length) {
      console.log(`  → downgrade to ${target}: BLOCKED — ${over.join("; ")}`);
    } else {
      console.log(`  → downgrade to ${target}: allowed (under all caps)`);
    }
  }
}