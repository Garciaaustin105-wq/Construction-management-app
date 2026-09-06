// Install-labor benchmarks for the plant catalogue, in MAN-minutes.
//
// Source: docs/handoff/handoff-plant-catalogue-seeding.md §3.4, compiled from nursery
// trade lists, a published landscape estimating guide and contractor threads.
// Labor is modelled as SIZE-BANDED man-minutes, never as a percentage of
// material cost — the contractor consensus in that research is that %-of-cost
// labor breaks down badly on large trees, where the plant is cheap relative to
// the crew and equipment needed to set it.
//
// WHY THIS IS SAFE TO SEED WHEN PRICING IS NOT: a man-minute figure is a
// physical claim about how long a job takes, and the published bands agree
// within a factor most crews can tune from. A price is a business decision
// that varies by supplier, region and margin, and no published number can
// stand in for it.
//
// STILL A STARTING POINT. Every one of these should be tuned against the org's
// own time entries — the app already collects them. Access, soil, and whether
// a machine is on site move these numbers more than plant size does: the same
// 2 in caliper tree is ~24 man-minutes with a 6-man machine crew and up to 240
// hand-dug with poor access.
//
// Published bands used (§3.4). Midpoints unless noted:
//   1-gal perennial            ~10
//   shrub 1-3 gal              9-15
//   shrub 5-7 gal              15-24
//   15-gal shrub / small tree  30-60
//   30-gal tree                60-120
//   B&B 2-3 in caliper         90-150
//   B&B 4-6 in caliper         150-240
//   palm <=25 gal              60-90
//   palm 30-45 gal             120-180  (+ crane/boom above ~15 ft)
//   annual flat, installed     10-15 per flat
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/)
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
const admin=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const ORG = process.env.SEED_ORG || "600d02fa-fae2-440b-99ab-42e96997da91";

// [category, size] -> man-minutes
const MINUTES = {
  tree: {
    "15 gal": 45,            // 30-60 band, midpoint
    "30 gal": 90,            // 60-120 band, midpoint
    "2 in cal B&B": 120,     // 90-150 band, midpoint
    "3 in cal B&B": 150,     // top of the 90-150 band, where 4-6 in begins
  },
  palm: {
    "6 ft CT": 75,           // <=25 gal band, midpoint
    "10 ft CT": 150,         // 30-45 gal band, midpoint
    "16 ft CT": 180,         // top of band; above ~15 ft needs a crane or boom
  },
  shrub: {
    "1 gal": 12,             // 9-15 band, midpoint
    "3 gal": 15,             // top of the 1-3 gal band
    "7 gal": 20,             // 15-24 band, midpoint
  },
  perennial: { "1 gal": 10, "3 gal": 15 },
  grass:     { "1 gal": 10, "3 gal": 15 },
  vine:      { "1 gal": 10, "3 gal": 15 },
  groundcover: {
    "4 in pot": 3,
    "1 gal": 10,
    "flat of 18": 15,        // per FLAT, not per plant - the unit is the flat
  },
  annual: { "4 in pot": 3, "flat of 18": 15 },
};

const { data: species, error } = await admin.from("plant_products")
  .select("id,category,plant_product_sizes(id,size,install_minutes)")
  .eq("organization_id", ORG);
if (error) throw new Error(error.message);

const updates = [];
let unmatched = new Set();
for (const sp of species ?? []) {
  const table = MINUTES[sp.category];
  for (const sz of sp.plant_product_sizes ?? []) {
    const mins = table?.[sz.size];
    if (mins === undefined) { unmatched.add(`${sp.category} / ${sz.size}`); continue; }
    // Never overwrite a figure someone has already tuned.
    if (Number(sz.install_minutes) > 0) continue;
    updates.push({ id: sz.id, install_minutes: mins });
  }
}
console.log(`sizes to set: ${updates.length}`);
if (unmatched.size) console.log("no benchmark for:", [...unmatched].join(" | "));

for (let i = 0; i < updates.length; i += 50) {
  await Promise.all(updates.slice(i, i + 50).map((u) =>
    admin.from("plant_product_sizes").update({ install_minutes: u.install_minutes }).eq("id", u.id)));
}

const { data: after } = await admin.from("plant_product_sizes")
  .select("install_minutes").eq("organization_id", ORG);
const set = (after ?? []).filter((r) => Number(r.install_minutes) > 0).length;
console.log(`catalogue: ${(after ?? []).length} sizes, ${set} with an install time, ${(after ?? []).length - set} still unset`);
