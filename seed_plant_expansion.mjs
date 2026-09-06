import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/)
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
const admin=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const ORG="600d02fa-fae2-440b-99ab-42e96997da91";

// Expansion pass. The first list skewed southern/Gulf; this fills the
// northern and transition-zone gap (oaks, spruce, arborvitae, native
// perennials and prairie grasses) and adds vines, which had no category.
const P = [
  // ── shade and street trees ──────────────────────────────────────────
  ["Bur Oak","Quercus macrocarpa","tree","#8b5cf6"],
  ["Swamp White Oak","Quercus bicolor","tree","#7e22ce"],
  ["Willow Oak","Quercus phellos","tree","#6d28d9"],
  ["Nuttall Oak","Quercus texana","tree","#5b21b6"],
  ["Hackberry","Celtis occidentalis","tree","#a78bfa"],
  ["Honeylocust","Gleditsia triacanthos inermis","tree","#c4b5fd"],
  ["Japanese Zelkova","Zelkova serrata","tree","#a16207"],
  ["London Planetree","Platanus x acerifolia","tree","#78716c"],
  ["Tulip Poplar","Liriodendron tulipifera","tree","#84cc16"],
  ["Sweetgum","Liquidambar styraciflua","tree","#dc2626"],
  ["American Hornbeam","Carpinus caroliniana","tree","#57534e"],
  ["Ironwood","Ostrya virginiana","tree","#44403c"],
  ["Quaking Aspen","Populus tremuloides","tree","#fde047"],
  ["Chinese Pistache","Pistacia chinensis","tree","#ea580c"],
  ["Trident Maple","Acer buergerianum","tree","#f87171"],
  ["Autumn Brilliance Serviceberry","Amelanchier x grandiflora","tree","#fb7185"],
  // ── flowering / ornamental trees ────────────────────────────────────
  ["Yoshino Cherry","Prunus x yedoensis","tree","#f9a8d4"],
  ["Kwanzan Cherry","Prunus serrulata","tree","#f472b6"],
  ["Chaste Tree","Vitex agnus-castus","tree","#818cf8"],
  ["Little Gem Magnolia","Magnolia grandiflora Little Gem","tree","#4d7c0f"],
  ["Trumpet Tree","Handroanthus impetiginosus","tree","#e879f9"],
  ["Jacaranda","Jacaranda mimosifolia","tree","#8b5cf6"],
  ["Bottlebrush","Callistemon citrinus","tree","#e11d48"],
  // ── evergreen / conifer ─────────────────────────────────────────────
  ["American Holly","Ilex opaca","tree","#166534"],
  ["Foster Holly","Ilex x attenuata Fosteri","tree","#15803d"],
  ["Leyland Cypress","x Cupressocyparis leylandii","tree","#14532d"],
  ["Italian Cypress","Cupressus sempervirens","tree","#065f46"],
  ["Norway Spruce","Picea abies","tree","#064e3b"],
  ["Colorado Blue Spruce","Picea pungens","tree","#0369a1"],
  ["White Spruce","Picea glauca","tree","#0e7490"],
  ["Deodar Cedar","Cedrus deodara","tree","#115e59"],
  ["Emerald Green Arborvitae","Thuja occidentalis Smaragd","tree","#16a34a"],
  ["Tamarack","Larix laricina","tree","#ca8a04"],
  // ── palms ───────────────────────────────────────────────────────────
  ["Pygmy Date Palm","Phoenix roebelenii","palm","#b45309"],
  ["Areca Palm","Dypsis lutescens","palm","#d97706"],
  ["Mexican Fan Palm","Washingtonia robusta","palm","#a16207"],
  ["Foxtail Palm","Wodyetia bifurcata","palm","#ea580c"],
  // ── shrubs ──────────────────────────────────────────────────────────
  ["Knock Out Rose","Rosa Radrazz","shrub","#e11d48"],
  ["Encore Azalea","Rhododendron hybrid","shrub","#f43f5e"],
  ["PJM Rhododendron","Rhododendron PJM","shrub","#c026d3"],
  ["Nandina","Nandina domestica","shrub","#dc2626"],
  ["Pittosporum","Pittosporum tobira","shrub","#22c55e"],
  ["Sweet Viburnum","Viburnum odoratissimum","shrub","#16a34a"],
  ["Dwarf Burford Holly","Ilex cornuta Burfordii Nana","shrub","#15803d"],
  ["Oleander","Nerium oleander","shrub","#ec4899"],
  ["Plumbago","Plumbago auriculata","shrub","#60a5fa"],
  ["Firebush","Hamelia patens","shrub","#f97316"],
  ["Ixora","Ixora coccinea","shrub","#ef4444"],
  ["Croton","Codiaeum variegatum","shrub","#eab308"],
  ["Arboricola","Schefflera arboricola","shrub","#4ade80"],
  ["Clusia","Clusia rosea","shrub","#059669"],
  ["Annabelle Hydrangea","Hydrangea arborescens","shrub","#e5e7eb"],
  ["Oakleaf Hydrangea","Hydrangea quercifolia","shrub","#a3e635"],
  ["Rose of Sharon","Hibiscus syriacus","shrub","#d946ef"],
  ["Forsythia","Forsythia x intermedia","shrub","#facc15"],
  ["Weigela","Weigela florida","shrub","#fb7185"],
  ["Ninebark","Physocarpus opulifolius","shrub","#b91c1c"],
  ["Japanese Barberry","Berberis thunbergii","shrub","#991b1b"],
  ["Burning Bush","Euonymus alatus","shrub","#dc2626"],
  ["Redosier Dogwood","Cornus sericea","shrub","#ef4444"],
  ["Gray Dogwood","Cornus racemosa","shrub","#9ca3af"],
  ["Gro-Low Sumac","Rhus aromatica","shrub","#ea580c"],
  ["St. John's Wort","Hypericum kalmianum","shrub","#fbbf24"],
  ["Black Chokeberry","Aronia melanocarpa","shrub","#1f2937"],
  ["American Elderberry","Sambucus canadensis","shrub","#4b5563"],
  ["Dwarf Bush Honeysuckle","Diervilla lonicera","shrub","#f59e0b"],
  ["New Jersey Tea","Ceanothus americanus","shrub","#e5e7eb"],
  ["Anglojap Yew","Taxus x media","shrub","#14532d"],
  ["Wintergreen Arborvitae","Thuja occidentalis Wintergreen","shrub","#166534"],
  // ── grasses ─────────────────────────────────────────────────────────
  ["Karl Foerster Feather Reed Grass","Calamagrostis x acutiflora","grass","#d4a373"],
  ["Switchgrass","Panicum virgatum","grass","#a16207"],
  ["Little Bluestem","Schizachyrium scoparium","grass","#c2410c"],
  ["Prairie Dropseed","Sporobolus heterolepis","grass","#ca8a04"],
  ["Blue Fescue","Festuca glauca","grass","#38bdf8"],
  ["Purple Fountain Grass","Pennisetum setaceum Rubrum","grass","#a21caf"],
  ["Lomandra","Lomandra longifolia","grass","#65a30d"],
  ["Sweet Flag","Acorus gramineus","grass","#84cc16"],
  ["Pennsylvania Sedge","Carex pensylvanica","grass","#4d7c0f"],
  // ── perennials ──────────────────────────────────────────────────────
  ["Hosta","Hosta spp.","perennial","#22c55e"],
  ["Catmint","Nepeta x faassenii","perennial","#818cf8"],
  ["Russian Sage","Perovskia atriplicifolia","perennial","#a5b4fc"],
  ["Autumn Joy Sedum","Hylotelephium spectabile","perennial","#fb7185"],
  ["Threadleaf Coreopsis","Coreopsis verticillata","perennial","#fde047"],
  ["Shasta Daisy","Leucanthemum x superbum","perennial","#f9fafb"],
  ["Agapanthus","Agapanthus africanus","perennial","#3b82f6"],
  ["Coral Bells","Heuchera spp.","perennial","#be123c"],
  ["Butterfly Weed","Asclepias tuberosa","perennial","#f97316"],
  ["Stella de Oro Daylily","Hemerocallis Stella de Oro","perennial","#facc15"],
  ["Rozanne Geranium","Geranium Rozanne","perennial","#6366f1"],
  ["Verbena","Verbena spp.","perennial","#c026d3"],
  ["Bulbine","Bulbine frutescens","perennial","#fb923c"],
  ["Society Garlic","Tulbaghia violacea","perennial","#a78bfa"],
  ["Canna","Canna x generalis","perennial","#dc2626"],
  ["Blue Daze","Evolvulus glomeratus","perennial","#60a5fa"],
  ["Prairie Smoke","Geum triflorum","perennial","#e11d48"],
  // ── groundcovers ────────────────────────────────────────────────────
  ["Periwinkle","Vinca minor","groundcover","#6366f1"],
  ["Pachysandra","Pachysandra terminalis","groundcover","#15803d"],
  ["Ajuga","Ajuga reptans","groundcover","#7c3aed"],
  ["Creeping Phlox","Phlox subulata","groundcover","#f472b6"],
  ["Blue Pacific Juniper","Juniperus conferta Blue Pacific","groundcover","#0891b2"],
  ["Perennial Peanut","Arachis glabrata","groundcover","#eab308"],
  ["Dwarf Mondo Grass","Ophiopogon japonicus Nana","groundcover","#0284c7"],
  // ── vines ───────────────────────────────────────────────────────────
  ["Confederate Jasmine","Trachelospermum jasminoides","vine","#f9fafb"],
  ["Carolina Jessamine","Gelsemium sempervirens","vine","#facc15"],
  ["Clematis","Clematis spp.","vine","#a855f7"],
  ["Bougainvillea","Bougainvillea spp.","vine","#e11d48"],
  ["Boston Ivy","Parthenocissus tricuspidata","vine","#16a34a"],
  ["Crossvine","Bignonia capreolata","vine","#ea580c"],
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
    toAdd.map(([name,botanical,category,color])=>({organization_id:ORG,name,botanical_name:botanical,
      category,color,notes:"Starter catalogue - set your own sizes, cost and price."}))
  ).select("id,name,category");
  if (error) throw new Error(error.message);
  const sizeRows = made.flatMap(p=>(SIZES[p.category]??["1 gal"]).map((size,i)=>
    ({organization_id:ORG,plant_product_id:p.id,size,sort_order:i})));
  // Chunked: a single insert of ~350 rows is fine, but chunking keeps the
  // failure blast radius small if one row is malformed.
  for (let i=0;i<sizeRows.length;i+=100) {
    const { error: sErr } = await admin.from("plant_product_sizes").insert(sizeRows.slice(i,i+100));
    if (sErr) throw new Error(sErr.message);
  }
  console.log(`inserted ${made.length} species and ${sizeRows.length} sizes`);
}

const { data: byCat } = await admin.from("plant_products")
  .select("category").eq("organization_id",ORG);
const counts = (byCat??[]).reduce((a,r)=>{a[r.category]=(a[r.category]||0)+1;return a;},{});
const { count: sz } = await admin.from("plant_product_sizes")
  .select("id",{count:"exact",head:true}).eq("organization_id",ORG);
console.log("catalogue by category:", counts);
console.log(`total: ${(byCat??[]).length} species, ${sz} sizes`);
