// Florida / Gulf-coast expansion for the plant catalogue.
//
// The national list covers the transition zone and north well after the second
// pass, but thins out badly below it: no royal palm, no gumbo limbo, no
// buttonwood, no coontie, none of the tropical shrubs that make up most of a
// south Florida install. This fills that.
//
// Grounded in the UF/IFAS Florida-Friendly Landscaping plant categories
// (ffl.ifas.ufl.edu) cross-checked against standard Florida landscape
// practice. Natives are marked in the notes because Florida-Friendly and
// water-restriction conversations both turn on which plants are native.
//
// NO ZONES AND NO SUITABILITY CLAIMS, same rule as the rest of the catalogue:
// a royal palm is in the list because Florida crews install them, not because
// this app has decided one belongs on a given site.
//
// Prices and install times stay zero, same reason as everywhere else.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/)
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
const admin=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const ORG = process.env.SEED_ORG || "600d02fa-fae2-440b-99ab-42e96997da91";

// [common, botanical, category, colour, native?]
const P = [
  // ── trees ───────────────────────────────────────────────────────────
  ["Slash Pine","Pinus elliottii","tree","#166534",true],
  ["Longleaf Pine","Pinus palustris","tree","#14532d",true],
  ["Laurel Oak","Quercus laurifolia","tree","#7c3aed",true],
  ["Southern Red Cedar","Juniperus virginiana var. silicicola","tree","#065f46",true],
  ["Gumbo Limbo","Bursera simaruba","tree","#b45309",true],
  ["West Indian Mahogany","Swietenia mahagoni","tree","#78350f",true],
  ["Dahoon Holly","Ilex cassine","tree","#15803d",true],
  ["East Palatka Holly","Ilex x attenuata East Palatka","tree","#16a34a",false],
  ["Simpson's Stopper","Myrcianthes fragrans","tree","#4d7c0f",true],
  ["Green Buttonwood","Conocarpus erectus","tree","#047857",true],
  ["Silver Buttonwood","Conocarpus erectus var. sericeus","tree","#94a3b8",true],
  ["Sweetbay Magnolia","Magnolia virginiana","tree","#65a30d",true],
  ["Royal Poinciana","Delonix regia","tree","#dc2626",false],
  ["Golden Rain Tree","Koelreuteria elegans","tree","#facc15",false],
  ["Frangipani","Plumeria rubra","tree","#f9a8d4",false],
  ["Loquat","Eriobotrya japonica","tree","#ca8a04",false],
  ["Geiger Tree","Cordia sebestena","tree","#ea580c",true],
  ["Tea Olive","Osmanthus fragrans","tree","#84cc16",false],
  ["Weeping Podocarpus","Podocarpus gracilior","tree","#0f766e",false],
  // ── palms ───────────────────────────────────────────────────────────
  ["Royal Palm","Roystonea regia","palm","#a16207",true],
  ["Coconut Palm","Cocos nucifera","palm","#ca8a04",false],
  ["Bismarck Palm","Bismarckia nobilis","palm","#64748b",false],
  ["Montgomery Palm","Veitchia arecina","palm","#b45309",false],
  ["Alexander Palm","Ptychosperma elegans","palm","#d97706",false],
  ["Triangle Palm","Dypsis decaryi","palm","#92400e",false],
  ["Sylvester Palm","Phoenix sylvestris","palm","#78350f",false],
  ["Canary Island Date Palm","Phoenix canariensis","palm","#a3620a",false],
  ["Florida Thatch Palm","Thrinax radiata","palm","#65a30d",true],
  ["Saw Palmetto","Serenoa repens","palm","#4d7c0f",true],
  ["Bottle Palm","Hyophorbe lagenicaulis","palm","#c2410c",false],
  ["Sago Palm","Cycas revoluta","palm","#166534",false],
  // ── shrubs ──────────────────────────────────────────────────────────
  ["Green Island Ficus","Ficus microcarpa Green Island","shrub","#16a34a",false],
  ["Walter's Viburnum","Viburnum obovatum","shrub","#059669",true],
  ["American Beautyberry","Callicarpa americana","shrub","#a21caf",true],
  ["Thryallis","Galphimia gracilis","shrub","#facc15",false],
  ["Coontie","Zamia integrifolia","shrub","#15803d",true],
  ["Hibiscus","Hibiscus rosa-sinensis","shrub","#e11d48",false],
  ["Pentas","Pentas lanceolata","shrub","#f43f5e",false],
  ["Snowbush","Breynia disticha","shrub","#f5d0fe",false],
  ["Copperleaf","Acalypha wilkesiana","shrub","#b91c1c",false],
  ["Ti Plant","Cordyline fruticosa","shrub","#be123c",false],
  ["Bird of Paradise","Strelitzia reginae","shrub","#f97316",false],
  ["Xanadu Philodendron","Thaumatophyllum xanadu","shrub","#047857",false],
  ["Agave","Agave spp.","shrub","#94a3b8",false],
  ["Yucca","Yucca spp.","shrub","#a8a29e",false],
  ["Turk's Cap","Malvaviscus arboreus","shrub","#dc2626",true],
  ["Buttonbush","Cephalanthus occidentalis","shrub","#e5e7eb",true],
  ["Saltbush","Baccharis halimifolia","shrub","#9ca3af",true],
  ["Banana Shrub","Magnolia figo","shrub","#fde68a",false],
  ["Florida Anise","Illicium floridanum","shrub","#7f1d1d",true],
  ["Parson's Juniper","Juniperus chinensis Parsonii","shrub","#0f766e",false],
  ["Sandankwa Viburnum","Viburnum suspensum","shrub","#10b981",false],
  ["Wild Coffee","Psychotria nervosa","shrub","#166534",true],
  // ── grasses ─────────────────────────────────────────────────────────
  ["Fakahatchee Grass","Tripsacum dactyloides","grass","#a16207",true],
  ["Dwarf Fakahatchee Grass","Tripsacum floridanum","grass","#ca8a04",true],
  ["Sand Cordgrass","Spartina bakeri","grass","#d4a373",true],
  ["Purple Lovegrass","Eragrostis spectabilis","grass","#c026d3",true],
  // ── groundcovers ────────────────────────────────────────────────────
  ["Sunshine Mimosa","Mimosa strigillosa","groundcover","#f472b6",true],
  ["Beach Sunflower","Helianthus debilis","groundcover","#facc15",true],
  ["Wedelia","Sphagneticola trilobata","groundcover","#eab308",false],
  // ── vines ───────────────────────────────────────────────────────────
  ["Coral Honeysuckle","Lonicera sempervirens","vine","#dc2626",true],
  ["Passionflower","Passiflora incarnata","vine","#a855f7",true],
];

const SIZES = {
  tree:["15 gal","30 gal","2 in cal B&B","3 in cal B&B"],
  palm:["6 ft CT","10 ft CT","16 ft CT"],
  shrub:["1 gal","3 gal","7 gal"],
  grass:["1 gal","3 gal"],
  perennial:["1 gal","3 gal"],
  groundcover:["4 in pot","1 gal","flat of 18"],
  vine:["1 gal","3 gal"],
};

const { data: existing } = await admin.from("plant_products").select("name").eq("organization_id",ORG);
const have = new Set((existing??[]).map(p=>p.name));
const toAdd = P.filter(([name])=>!have.has(name));
console.log(`have ${have.size} | proposed ${P.length} | inserting ${toAdd.length}`);

if (toAdd.length) {
  const { data: made, error } = await admin.from("plant_products").insert(
    toAdd.map(([name,botanical,category,color,native])=>({
      organization_id:ORG, name, botanical_name:botanical, category, color,
      notes:`${native ? "Florida native. " : ""}Starter catalogue - set your own sizes, cost and price.`}))
  ).select("id,name,category");
  if (error) throw new Error(error.message);
  const sizeRows = made.flatMap(p=>(SIZES[p.category]??["1 gal"]).map((size,i)=>
    ({organization_id:ORG,plant_product_id:p.id,size,sort_order:i})));
  for (let i=0;i<sizeRows.length;i+=100) {
    const { error: sErr } = await admin.from("plant_product_sizes").insert(sizeRows.slice(i,i+100));
    if (sErr) throw new Error(sErr.message);
  }
  console.log(`inserted ${made.length} species and ${sizeRows.length} sizes`);
}

const { data: all } = await admin.from("plant_products").select("category,notes").eq("organization_id",ORG);
const counts=(all??[]).reduce((a,r)=>{a[r.category]=(a[r.category]||0)+1;return a;},{});
const natives=(all??[]).filter(r=>(r.notes||"").startsWith("Florida native")).length;
const { count: sz } = await admin.from("plant_product_sizes")
  .select("id",{count:"exact",head:true}).eq("organization_id",ORG);
console.log("by category:", counts);
console.log(`total: ${(all??[]).length} species (${natives} Florida natives), ${sz} sizes`);
