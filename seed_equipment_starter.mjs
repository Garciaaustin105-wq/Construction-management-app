// Common landscape machinery — the MACHINES, with no rates.
//
// Same rule as every other catalogue here: the equipment an org uses is
// broadly the same trade to trade, so the list is useful; the rates are
// regional, per-supplier and negotiated, so inventing them would let someone
// quote plausible figures that are wrong.
//
// Every rate ships NULL, which the contract already means as "not recorded"
// rather than free — cheapestPlan returns unpriced:true and equipmentCharge
// flags owned gear with no hourly cost, which is the silent one: it quotes at
// zero and makes the job look more profitable than it is.
//
// ownership defaults to 'rented' because that is the common case; an org
// switches the ones it owns and sets an internal hourly cost.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/)
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
const admin=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const ORG = process.env.SEED_ORG || "600d02fa-fae2-440b-99ab-42e96997da91";

// [name, category, operator_required, note]
const EQUIP = [
  ["Skid steer (compact track loader)","skid_steer",true,"Grading, moving pallets and material. The landscape workhorse."],
  ["Skid steer — auger attachment","auger",true,"Tree pits and post holes. Usually an add-on to the skid steer rental."],
  ["Skid steer — grapple bucket","skid_steer",true,"Debris and brush handling."],
  ["Mini excavator (1.5-3 ton)","excavator",true,"Trenching, stump and root removal, drainage."],
  ["Walk-behind trencher","trencher",true,"Irrigation mainline and lateral trenching."],
  ["Ride-on trencher","trencher",true,"Longer irrigation runs and sleeving."],
  ["Sod cutter","sod_cutter",true,"Stripping existing turf before a re-sod."],
  ["Stump grinder","stump_grinder",true,"Stump removal after a tree take-out."],
  ["Walk-behind tiller","tiller",true,"Bed prep and soil amendment."],
  ["Dump trailer (14 ft)","dump_trailer",false,"Debris haul-off and bulk material delivery."],
  ["Dump truck (single axle)","truck",true,"Bulk soil, mulch and debris."],
  ["Boom / crane truck","crane",true,"Setting large trees and palms. Needed above roughly 15 ft of trunk."],
  ["Plate compactor","other",true,"Base compaction for hardscape and paths."],
  ["Auger (two-man, handheld)","auger",true,"Small plant pits where a machine cannot reach."],
  ["Water truck / tank trailer","truck",true,"Establishment watering on new installs without irrigation."],
];

const { data: existing } = await admin.from("equipment_products").select("name").eq("organization_id",ORG);
const have=new Set((existing??[]).map(e=>e.name));
const add=EQUIP.filter(([n])=>!have.has(n));
console.log(`have ${have.size} | proposed ${EQUIP.length} | inserting ${add.length}`);
if (add.length) {
  const { error } = await admin.from("equipment_products").insert(add.map(([name,category,op,note])=>({
    organization_id:ORG, name, category, ownership:"rented", operator_required:op,
    notes:`${note} Set your own rates - and switch to OWNED with an internal hourly cost if you own it.`,
    // Rates deliberately null: not recorded, not free.
    cost_hourly:null,cost_daily:null,cost_weekly:null,cost_monthly:null,
    price_hourly:null,price_daily:null,price_weekly:null,price_monthly:null,
  })));
  if (error) throw new Error(error.message);
}
const { data: all } = await admin.from("equipment_products")
  .select("category,cost_daily,cost_hourly,rates_updated_at").eq("organization_id",ORG);
const priced=(all??[]).filter(e=>e.cost_daily!=null||e.cost_hourly!=null).length;
console.log(`equipment: ${(all??[]).length} machines, ${priced} priced, ${(all??[]).length-priced} awaiting rates`);
