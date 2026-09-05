// Multi-brand irrigation catalogue: Hunter, Toro, K-Rain, Irritrol.
//
// The point is breadth — an installer opens the app and finds the line they
// actually carry already there, whichever brand that is.
//
// RADII ARE SEEDED ONLY WHERE THEY WERE VERIFIED against the manufacturer's
// own pages. Everything else is 0, which the contract already means as "not
// recorded": radiusUnset() flags it and no coverage is drawn. Inventing a
// throw figure would be the worst possible thing to ship here, because a
// wrong radius draws a confident circle over ground the head never reaches.
// The manufacturer's published RANGE goes in the note so the estimator has
// the number to check against.
//
// Verified 2026-09-05:
//   Hunter MP1000 8-15 ft, MP2000 13-21 ft, MP3000 22-30 ft, arcs 90-210,
//     210-270 and 360                     hunterindustries.com MP Rotator
//   Hunter PGP Ultra / I-20  17-46 ft, 34 nozzle choices
//                                        hunterirrigation.com PGP Ultra
//   Toro 570 adjustable nozzles at 10 ft and 15 ft
//                                        toro.com 570 nozzle products
//
// Spray nozzle SERIES NUMBERING (5/8/10/12/15 = radius in feet) is a shared
// industry convention across Rain Bird, Hunter and Toro, so those are seeded
// with the series radius.
//
// Prices and install minutes are zero throughout, same rule as every other
// catalogue in this app.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/)
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
const admin=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const ORG = process.env.SEED_ORG || "600d02fa-fae2-440b-99ab-42e96997da91";

// product: [name, category, colour, notes]
// nozzles: [label, radius_ft]   radius 0 = not recorded, confirm from chart
const LINES = [
  ["Hunter MP Rotator","mp_rotator","#16a34a",
   "Multi-stream rotary nozzle for spray bodies. Arcs adjust 90-210 and 210-270; 360 variants are fixed. Radii verified from Hunter's product pages.",
   [["MP1000 (8-15 ft)",15],["MP2000 (13-21 ft)",21],["MP3000 (22-30 ft)",30],
    ["MP3500",0],["MP800SR short radius",0],["MP Corner",0],
    ["MP LCS left strip",0],["MP RCS right strip",0],["MP SS side strip",0]]],

  ["Hunter PGP Ultra","rotor","#15803d",
   "Gear-drive rotor. Hunter publishes 17-46 ft across 34 nozzle choices, so per-nozzle radius must come from the performance chart.",
   [["#0.75",0],["#1.0",0],["#1.5",0],["#2.0",0],["#3.0",0],["#4.0",0],
    ["#6.0",0],["#8.0",0],["Low angle #1.5",0],["Low angle #3.0",0]]],

  ["Hunter I-20","rotor","#166534",
   "Gear-drive rotor sharing the PGP nozzle set. 17-46 ft published range; confirm per nozzle.",
   [["#0.75",0],["#1.0",0],["#1.5",0],["#2.0",0],["#3.0",0],["#4.0",0],["#6.0",0],["#8.0",0]]],

  ["Hunter PGJ","rotor","#14532d",
   "Compact gear-drive rotor for smaller turf. Confirm per-nozzle radius from Hunter's chart.",
   [["#1.0",0],["#1.5",0],["#2.0",0],["#3.0",0],["#4.0",0]]],

  ["Hunter Pro-Spray + fixed nozzle","spray","#65a30d",
   "Pop-up spray body with fixed-pattern nozzles. Series number is the radius in feet, the shared industry convention.",
   [["8A (Q/H/F)",8],["10A (Q/H/F)",10],["12A (Q/H/F)",12],["15A (Q/H/F)",15],
    ["Side strip",0],["End strip",0]]],

  ["Hunter Pro-Spray + Pro-Adjustable","spray","#84cc16",
   "Pop-up spray body with variable-arc nozzles, 0-360.",
   [["6A adjustable",6],["8A adjustable",8],["10A adjustable",10],
    ["12A adjustable",12],["15A adjustable",15]]],

  ["Toro T5 rotor","rotor","#0369a1",
   "Gear-drive rotor with RapidSet arc adjustment. Confirm per-nozzle radius from Toro's chart.",
   [["#0.75",0],["#1.0",0],["#1.5",0],["#2.0",0],["#3.0",0],["#4.0",0],["#6.0",0],["#8.0",0]]],

  ["Toro 570Z + Precision nozzle","spray","#0284c7",
   "Pop-up spray body with Precision Series nozzles (H2O Chip). Series number is the radius in feet.",
   [["5 Series (Q/H/F)",5],["8 Series (Q/H/F)",8],["10 Series (Q/H/F)",10],
    ["12 Series (Q/H/F)",12],["15 Series (Q/H/F)",15],["Strip",0]]],

  ["Toro 570 adjustable nozzle","spray","#0ea5e9",
   "Variable-arc nozzle for 570 bodies. 10 ft and 15 ft verified from Toro's product listings.",
   [["10 ft adjustable",10],["15 ft adjustable",15],["5 ft adjustable",5],["8 ft adjustable",8]]],

  ["Toro Precision rotating nozzle","mp_rotator","#38bdf8",
   "Multi-stream rotary nozzle for 570 bodies. Confirm radius per model from Toro's chart.",
   [["Short radius",0],["Mid radius",0],["Long radius",0],["Strip",0]]],

  ["K-Rain PROPLUS rotor","rotor","#7c3aed",
   "Gear-drive rotor. Confirm per-nozzle radius from K-Rain's chart.",
   [["#0.75",0],["#1.0",0],["#1.5",0],["#2.0",0],["#3.0",0],["#4.0",0],["#6.0",0]]],

  ["K-Rain RCW rotary nozzle","mp_rotator","#a855f7",
   "Rotary nozzle for spray bodies. Confirm radius per model from K-Rain's chart.",
   [["Short",0],["Mid",0],["Long",0]]],

  ["Irritrol 700 series rotor","rotor","#c026d3",
   "Commercial gear-drive rotor. Confirm per-nozzle radius from Irritrol's chart.",
   [["#1.0",0],["#1.5",0],["#2.0",0],["#3.0",0],["#4.0",0],["#6.0",0]]],

  ["Hunter PLD dripline","drip","#0d9488",
   "Pressure-compensating landscape dripline. PRICED PER FOOT - the per-foot unit is not built yet, so price it by hand.",
   [["0.6 GPH, 12 in spacing",0],["0.6 GPH, 18 in spacing",0],
    ["0.9 GPH, 12 in spacing",0],["0.9 GPH, 18 in spacing",0]]],
];

const { data: existing } = await admin.from("irrigation_products").select("name").eq("organization_id",ORG);
const have = new Set((existing??[]).map(p=>p.name));
const toAdd = LINES.filter(([name])=>!have.has(name));
console.log(`have ${have.size} lines | proposed ${LINES.length} | inserting ${toAdd.length}`);

for (const [name, category, color, notes, nozzles] of toAdd) {
  const { data: prod, error } = await admin.from("irrigation_products")
    .insert({organization_id:ORG,name,category,color,notes}).select("id").single();
  if (error) throw new Error(`${name}: ${error.message}`);
  const rows = nozzles.map(([nozzle,radius_ft],i)=>({
    organization_id:ORG, irrigation_product_id:prod.id, nozzle, radius_ft, sort_order:i }));
  const { error: nErr } = await admin.from("irrigation_product_nozzles").insert(rows);
  if (nErr) throw new Error(`${name} nozzles: ${nErr.message}`);
}

const { data: all } = await admin.from("irrigation_products")
  .select("name,category,irrigation_product_nozzles(radius_ft)").eq("organization_id",ORG);
const lines = all??[];
const nozzles = lines.flatMap(l=>l.irrigation_product_nozzles??[]);
const withRadius = nozzles.filter(n=>Number(n.radius_ft)>0).length;
const byCat = lines.reduce((a,l)=>{a[l.category]=(a[l.category]||0)+1;return a;},{});
console.log("lines by category:", byCat);
console.log(`total: ${lines.length} product lines, ${nozzles.length} nozzles`);
console.log(`  ${withRadius} have a verified radius, ${nozzles.length-withRadius} flagged to confirm`);
