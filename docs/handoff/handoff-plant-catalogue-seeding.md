# Handoff — seed + import the plant catalogue from nursery research

**Owner: Opus lane. Written 2026-09-05 by the Claude-direct lane after finishing
map placement (`493053f feat/plant-map-placement`).**

The catalogue screens are DONE and E2E-proven (30/30 `/lawn/plants`, 28/28 map
placement). What the catalogue does not have is **any real plants in it** — it
was E2E'd with throwaway rows and wiped clean at the end. This handoff covers
turning nursery research into a real, seeded catalogue, and what is still
missing to make that data trustworthy.

---

## 1. State of the system (do not re-derive any of this)

- Contract: `src/lib/plantProducts.ts` (do NOT edit without Claude-direct —
  Opus-heavy split). Key exports: `listPlantCatalogue`, `plantSnapshot`,
  `readPlantSnapshot`, `buildPlantLegend`, `createPlantProduct`,
  `createPlantSize`, `updatePlantSize`, `deletePlantSize`.
- Tables: `plant_products` (species: name, botanical_name, category, color,
  notes, active) + `plant_product_sizes` (size, cost, unit_price,
  install_minutes, sort_order, active). FK cascade species→sizes.
- Categories (`PLANT_CATEGORIES`): `tree, palm, shrub, perennial, grass,
  annual, groundcover`. Adding one is a one-line change, no migration.
- UI: `/lawn/plants` (PlantCatalogueManager — species drawer, inline size
  editor, sort_order ordering, mobile cards vs desktop table) and the map's
  plant picker + placement mode in `LawnMeasurementMap.tsx`.
- Placement math that the seeded data feeds: `cost` = NURSERY MATERIAL ONLY
  (never fake labor into it); `install_minutes` = MAN-minutes (2 people × 10
  min = 20); `0` = NOT estimated and renders as "—", never as free; sizes
  render in `sort_order`, never alphabetically ("15 gal" sorts before
  "3 gal" alphabetically — the original trap).
- Pricing snapshot rule: quotes store a snapshot of the size row in
  `estimate_areas.meta` — re-seeding/re-pricing the catalogue never silently
  changes existing quotes. Safe to iterate on prices after go-live.

## 2. What is missing today (the gap list)

1. **Zero catalogue rows.** No seeded plants for any org; regional defaults
   were deliberately deferred ("no seeded default plants" from the catalogue
   lane).
2. **No import path.** The manager is one-at-a-time UI. Seeding ~100 species
   × ~3 sizes = 300+ size rows through the UI is not viable. Opus needs either
   (a) a one-off SQL seed script, (b) a CSV importer screen (office-only), or
   (c) a `/api/plants/import` route. Recommend (a) first, (b) later.
3. **Colors are unassigned in the data.** `color` drives map markers and the
   area color cycle. `AREA_COLORS` (from `estimateAreas.ts`) is the palette —
   assign per species (e.g. trees one hue, shrubs another) or accept the
   default.
4. **`active` has no UI affordance on sizes** (species has
   deactivate/activate, sizes don't) — retired sizes can only be deactivated
   via SQL for now.
5. **No nav link** to `/lawn/plants` yet (tab-bar placement decided later) —
   office users reach it by URL only.
6. **No pricing (deliberate).** Owner directive 2026-09-05: this handoff
   carries NO prices. `cost`/`unit_price` are NOT seeded — the owner sets
   material cost and sell price later, through the catalogue UI or a
   follow-up pricing pass. `install_minutes` IS in scope (labor time, not
   money). Opus must decide how unpriced sizes are represented (0 vs a
   nullable contract change) and confirm the UI renders them as "—", never
   "$0.00".

## 3. Research data

(Filled from four parallel research agents — trees/palms, shrubs, perennials/
grasses/groundcovers/annuals, and size/labor methodology. See §3.1–3.4.)

**Owner directive 2026-09-05: NO PRICING in this handoff.** §3 is an
AVAILABILITY list — which plants/trees/shrubs US nurseries actually carry, in
what container sizes, and whether they suit Tampa 9b/10a. Costs and sell
prices are decided by the owner later (see §2 item 6); the only numbers kept
are container-size conventions and install-labor man-minutes (§3.4), because
the schema needs `install_minutes` and `sort_order` even before any pricing.

<!-- RESEARCH SECTIONS INJECTED BELOW -->

### 3.1 Trees + palms (agent 1)

Availability compiled from Florida wholesale growers (TreeWorld/Homestead,
HDC Palms/Okeechobee, Palmco, Walker Tree Farm/Eustis, Kings Nursery/Arcadia,
Greenleaf), Florida retail (Dino's Palms, Palm Trees Direct), national
retail (Moon Valley, The Tree Center, Fast-Growing-Trees), and public
government bid documents (Tampa Housing Authority, City of North Port) — the
bids are the most reliable "what FL installers actually buy" source.

| Common name | Botanical name | Sizes nurseries sell | FL 9b/10a? | Note |
|---|---|---|---|---|
| Southern live oak | *Quercus virginiana* | 15/25/45/65 gal, 1.5–3 in cal, field B&B | Yes | 50–80 ft; THE Florida shade workhorse; huge canopy |
| Southern magnolia 'DD Blanchard' | *Magnolia grandiflora* | 7/15/30/45/65/100 gal, field B&B | Yes | 40–60 ft evergreen; standard spec tree in FL bids |
| Little Gem magnolia | *M. grandiflora* 'Little Gem' | 3/7/15/30 gal | Yes | 20–35 ft dwarf form; most-produced FL magnolia cultivar |
| Natchez crape myrtle | *Lagerstroemia* × 'Natchez' | 3/15/30/45 gal | Yes | 20–30 ft; exfoliating bark, mildew-resistant standard |
| Bald cypress | *Taxodium distichum* | 15/25/45/65 gal | Yes | 50–70 ft; wet-site tolerant, fine in dry lawns |
| Red maple ('Florida Flame', 'October Glory') | *Acer rubrum* | 15/25/45 gal | Yes | 40–50 ft; fast native shade, fall color |
| Drake Chinese elm | *Ulmus parvifolia* 'Drake' | 15/25/45 gal | Yes | 40–50 ft; top Tampa street tree, drought tough |
| Japanese blueberry | *Elaeocarpus decipiens* | 15/25/45 gal | Yes | 30–40 ft; dense evergreen screen/street tree |
| Shoal Creek vitex | *Vitex agnus-castus* 'Shoal Creek' | 3/7/15/30 gal | Yes | 15–25 ft; summer lilac spikes, pollinator magnet |
| Desert willow | *Chilopsis linearis* | 15/25 gal, 24 in box | Yes | 15–25 ft; drought-tolerant, orchid-like blooms |
| Golden raintree | *Koelreuteria* spp. | 25/45 gal | Yes | 30–40 ft; yellow blooms, tough urban tree |
| River birch ('Dura-Heat') | *Betula nigra* | 15/25/45 gal | Marginal | 40–70 ft; great north of Orlando, heat-stressed in Tampa |
| Eastern redbud 'Forest Pansy' | *Cercis canadensis* | 3/7/15 gal | Yes | 20–30 ft; understory accent, purple foliage |
| East Palatka holly | *Ilex* × attenuata 'East Palatka' | 15/25/45 gal | Yes | 25–35 ft; classic FL privacy/screen tree |
| Bottlebrush | *Callistemon citrinus* (syn. *Melaleuca citrina*) | 7/15/25 gal | Yes | 10–15 ft; red bottlebrush blooms, wet-tolerant |
| Sabal (cabbage) palm | *Sabal palmetto* | 15/25 gal + field trunks 8–16 ft CT | Yes | FL state tree; hurricane-proof standard |
| Queen palm | *Syagrus romanzoffiana* | 15/25 gal | Yes | 40–50 ft; cheapest big-tropical look, heavy feeder |
| Foxtail palm | *Wodyetia bifurcata* | 7/10/15/25/65 gal | Yes (10a) / Marginal (9b) | 30 ft; self-cleaning, #1 FL "pretty palm" |
| Sylvester date palm | *Phoenix sylvestris* | 15/25/45 gal | Yes | 40 ft; diamond-cut trunk, builder favorite |
| European fan palm | *Chamaerops humilis* | 7/15/25 gal | Yes | 8–15 ft; hardiest fan palm, cold AND drought |
| Chinese fan palm | *Livistona chinensis* | 7/15/25 gal | Yes | 30 ft; drooping fan fronds, very common |
| Areca palm | *Dypsis lutescens* | 7/15/25 gal | Marginal (9b) / Yes (10a) | 15–20 ft clumping hedge palm; dies back in hard freezes |
| Royal palm | *Roystonea regia* | 15/25 gal + field CT | Marginal | 70–100 ft; fronds burn below 30°F — South FL tree, risky in Tampa |
| Pygmy date palm | *Phoenix roebelenii* | 7/15/25 gal, single/multi/trunking | Marginal (9b) / Yes (10a) | 6–10 ft; underplanting favorite, hurt below ~30°F |
| Canary Island date palm | *Phoenix canariensis* | 15/25/45 gal + huge field CT | Yes | 50–60 ft; specimen "pineapple" palm; lethal bronzing risk in FL |
| Mule / Pindo palm | *Butia* × *syagrus* / *B. capitata* | 15/25 gal | Yes | 15–25 ft; cold-hardy feather palm, edible fruit |
| Sago palm | *Cycas revoluta* | 7/15/25 gal | Yes | 4–8 ft cycad; foundation/entry accent (toxic to pets) |
| Bismarck palm | *Bismarckia nobilis* | 15/25 gal | Marginal-Yes (10a) | 40 ft; massive silver-blue fan, pure specimen play |
| Windmill palm | *Trachycarpus fortunei* | 7/15 gal | Yes | 20–40 ft; hardiest trunking palm, cold-climate seller nationwide |

**Workhorse purchase sizes for installers:**
- **15-gallon is the volume size for everything** — palms and trees. Gov
  bids spec it routinely; 25-unit minimums are common at wholesale.
- **25/30-gallon is the "instant landscape" size** for residential jobs.
- **45-gallon is the statement-tree size.**
- **Palms sell by clear-trunk feet once past 15 gal** (e.g. sabal 14–16 ft
  CT) rather than gallon labels.
- 3/7-gal is retail/big-box territory, not installer stock, except for mass
  accent plantings (sago, bottlebrush, dwarf shrub material).

**Tampa trap:** areca, pygmy date, royal, and Christmas palm are widely
carried and cheap at 15-gal but burn below ~30°F (UF/IFAS: royal fronds burn
<30°F, recovery 6+ months). European fan, pindo, sabal, and windmill sell
cold-hardiness for the same money — flag the tender ones 9b-marginal in
`notes` if seeded.

**Sources:** [HDC Palms (Okeechobee FL)](https://www.hdcpalms.com); [TreeWorld
Wholesale (Homestead FL)](https://www.treeworldwholesale.com); [Dino's
Palms](https://dinospalms.com/product-category/palms/); [Palm Trees
Direct](https://www.palmtreesdirectinc.com/palms.html); [Moon Valley
Nurseries](https://www.moonvalleynurseries.com); [Greenleaf
Nursery](https://www.greenleafnursery.com) (caliper tiers behind trade
account); [UF/IFAS Gardening Solutions](https://gardeningsolutions.ifas.ufl.edu)
for the zone/cold-damage verdicts. River birch, windmill palm, and redbud
have no reliable published FL availability — confirm with a trade-account
grower before seeding.

### 3.2 Shrubs + hedges (agent 2)

Availability compiled from Florida wholesale growers and distributors
(Urra's Nursery/Miami, Creek Nursery/FL, Fort Christmas Nursery/Central FL,
Hempels/Ocoee FL — tray-of-48 volume pricing, Canterbury Farms/Hudson FL
Tampa-area, Growers Outlet of Lake Worth) plus national shrub growers
(Tennessee Wholesale Nursery).

**Tampa-area workhorses:**

| Common name | Botanical name | Sizes nurseries sell | FL 9b/10a? | Note |
|---|---|---|---|---|
| Dwarf yaupon holly 'Schillings' | *Ilex vomitoria* 'Nana'/'Schillings' | 3G, 7G | Yes | 3–4 ft, sun/shade; #1 foundation dwarf, low trim |
| Sweet viburnum | *Viburnum odoratissimum* | 3/7/15/25/30G | Yes | 15–25 ft; fast hedge/privacy screen, sun |
| Sandankwa viburnum | *Viburnum suspensum* | 3G, 7G | Yes | 4–6 ft; shade-tolerant hedge, salt ok |
| Podocarpus (Maki) | *Podocarpus macrophyllus* | 3/7/15/25/45G | Yes | 10–20 ft; narrow hedge, no aphids, tidy |
| Podocarpus 'Pringles' (dwarf) | *P. macrophyllus* 'Pringles' | 3/7/15/25G | Yes | 3–4 ft dwarf; low hedge/foundation |
| Clusia (small-leaf) | *Clusia guttifera* | 3/7/15/25/45G | Marginal | 15–20 ft; modern SoFL hedge; frost-burns in Tampa cold snaps |
| Ficus hedge | *Ficus benjamina* | 3/7/15/25G | Marginal | Fastest hedge but whitefly (fig psyllid) + cold; being replaced by clusia/viburnum |
| Green Island ficus | *Ficus microcarpa* 'Green Island' | 3G, 7G | Yes | 1–2 ft; low accent/groundcover mass |
| Ixora 'Maui Red/Yellow' | *Ixora coccinea* | 3G, 7G | Yes | 4–6 ft; sun, acid soil; red-flower hedge/accent |
| Dwarf ixora (Taiwanese) | *Ixora taiwanensis* / *I. chinensis* | 3G, 7G | Yes | 2–3 ft; border/foundation color |
| Tropical hibiscus (bush) | *Hibiscus rosa-sinensis* | 3/7/15G | Yes (burns <32°F) | 4–8 ft; color accent, butterfly-friendly |
| Hibiscus standard (tree) | *Hibiscus rosa-sinensis* (std/braided) | 7/15/25G | Yes | Patio specimen, entry accents |
| Croton (Petra, Mammy, Gold Dust) | *Codiaeum variegatum* | 3/7/15G | Marginal (leaf-drop <40°F) | 3–6 ft; tropical color accent, part sun |
| Pittosporum | *Pittosporum tobira* (+ 'Variegata') | 3G, 7G | Yes | 4–12 ft; hedge/foundation, drought ok |
| Loropetalum (Ruby/Plum/Daruma) | *Loropetalum chinense* var. *rubrum* | 1/3/7G | Yes | 4–10 ft; purple-foliage hedge/foundation |
| Japanese boxwood | *Buxus microphylla* var. *japonica* | 3G, 7G | Yes (microphylla types) | 3–6 ft; formal low hedge, shears well |
| Arboricola / Trinette | *Schefflera arboricola* | 3/7/10+G | Yes | 4–8 ft; shade-tolerant hedge/foundation, variegated forms |
| Agapanthus (Lily of the Nile) | *Agapanthus africanus* / 'Blue Nile' | 1G, 3G | Yes | 2–3 ft; mass border, blue/white summer bloom |
| Copperleaf | *Acalypha wilkesiana* | 3G, 7G | Marginal (tender) | 5–8 ft; tropical color accent/hedge |
| Firebush | *Hamelia patens* (dwarf *H. nodosa*) | 3G, 7G | Yes | 3–6 ft; FL-native, hummingbirds, sun |
| Plumbago 'Imperial Blue' | *Plumbago auriculata* | 3G, 7G | Yes (dies back, resprouts) | 3–5 ft; blue-flower mass/foundation |
| Gardenia (Frostproof/Miami Supreme) | *Gardenia jasminoides* | 3/7/15/25G | Yes | 4–8 ft; fragrant foundation accent, part sun, acid mix |
| Oleander ('Petite Pink', 'Calypso') | *Nerium oleander* | 3/7/15G | Yes | 6–12 ft; screen/hedge, salt + heat ok |
| Split-leaf philodendron (Selloum) | *Philodendron bipinnatifidum* | 3/7/15/25G | Yes | 5–8 ft; tropical accent/fill, part shade |
| Confederate jasmine | *Trachelospermum jasminoides* | 3/7/15/25G (trellis) | Yes | Vine; fence/trellis screen, fragrant |
| Indian hawthorn | *Rhaphiolepis indica* | 3G, 7G | Yes | 3–5 ft; compact foundation evergreen |
| Bougainvillea | *Bougainvillea* spp./cultivars | 3/7/15G | Yes | Sun-baked color vine/shrub; salt ok |
| Southern wax myrtle | *Morella cerifera* (syn. *Myrica*) | 3/7/15G | Yes | 15–20 ft; native screen, salt ok |
| Formosa azalea | *Rhododendron* (Satsuki/Southern Indica hybrids) | 3G, 7G | Yes | 6–8 ft; spring bloom, understory |
| Thryallis | *Galphimia glauca* | 3G | Yes | 3–6 ft; yellow bloom hedge accent, drought ok |
| Nandina | *Nandina domestica* | 3G, 7G | Yes | 4–6 ft; foliage color accent; ⚠️ invasive — use 'Firepower' dwarf |
| Cocoplum | *Chrysobalanus icaco* | 3/7/15G | Marginal (frost-burns 9b) | Native hedge, salt ok; mostly SoFL |
| Sea grape | *Coccoloba uvifera* | 3/7/15/25G | Marginal (coastal Tampa) | Coastal screen/specimen; female fruit |

**Broadly popular US landscape shrubs:**

| Common name | Botanical name | Sizes nurseries sell | FL 9b/10a? | Note |
|---|---|---|---|---|
| Bigleaf hydrangea | *Hydrangea macrophylla* | 1G, 3G | Marginal (afternoon-heat stress in 9b/10a) | 3–5 ft; shade accent, morning sun |
| Panicle hydrangea 'Limelight' | *Hydrangea paniculata* 'Limelight' | 1/3/7G | Marginal (needs chill; struggles 10a) | 6–8 ft; summer specimen |
| Japanese spirea ('Magic Carpet', 'Goldmound') | *Spiraea japonica* | 3", 1G, 3G | Marginal (ok 9b, thin in 10a) | 2–3 ft; mass/foundation color |
| Glossy abelia 'Kaleidoscope' | *Abelia × grandiflora* 'Kaleidoscope' | 1G, 3G | Yes | 2–3 ft; long-bloom low hedge, sun |
| Knock Out rose | *Rosa* 'Radtko'/'Knock Out' | 1/3/7G | Yes | 3–4 ft; repeat-bloom accent, black-spot pressure in FL humidity |
| Wintergreen boxwood | *Buxus microphylla* var. *koreana* × *sempervirens* | 2.25 gal, 3G | Marginal (better than English in heat) | 3–4 ft; formal edging |
| Encore azalea | *Rhododendron* ('Encore' series) | 1/3/7G | Yes | 3–5 ft; rebloom; availability quote-by-phone at most growers |

**Sources:** [Urra's Nursery availability (Miami, current
2026-09-05)](https://www.plantant.com/include/availability/availability_by_name.php?supplier_id=1005058);
[Fort Christmas Nursery](https://fortchristmasnursery.com/shrubs);
[Creek Nursery wholesale list](https://www.creeknursery.com/creek_nursery_wholesale_availability.pdf);
[Canterbury Farms (Hudson FL, ⚠️ list dated June 2017)](https://canterburyfarmsnursery.com/wp-content/uploads/2017/06/MasterRetail-June17.pdf);
[Hempels Nursery (Ocoee FL)](https://www.hempelsnursery.com);
[Tennessee Wholesale Nursery](https://tennessee-wholesale-nursery.com).

### 3.3 Perennials, grasses, groundcovers, annuals (agent 3)

Availability compiled from Florida wholesale growers and distributors
(Southern Grove/Plant City, Ground Works/Palm Beach, Florida Tropicals
Direct/Acosta, Green Seasons, Hicks/West Palm Beach, Pennate/Tampa, Palm
Coast Growers, Bellefontaine/Ft. Myers), pro distributors (SiteOne) and
national liner growers (GrowersExchange, TN Nursery, Hollandia).

| Common name | Botanical name | Group | Sizes nurseries sell | FL 9b/10a? | Note |
|---|---|---|---|---|---|
| Pink Muhly Grass | *Muhlenbergia capillaris* | Grass | 1 gal, 3 gal, plug trays (50-cell) | Yes | #1 Tampa grass; fall pink plumes; carried by nearly every FL grower |
| Dwarf Fountain Grass | *Pennisetum alopecuroides* 'Hameln' | Grass | 1 gal, 3 gal, 5 gal | Yes | Cold-hardy to z5, thrives in FL; 18" mounding accent |
| Purple Fountain Grass | *Pennisetum setaceum* 'Rubrum' | Grass | 1 gal, 3 gal | Marginal | Tender — freezes back in Tampa winters; grown as summer accent, often replanted |
| Dwarf Fakahatchee Grass | *Tripsacum dactyloides* (dwarf) | Grass | 3 gal (larger clumping form too) | Yes | Native, wet- or dry-soil workhorse |
| Flax Lily / Dianella | *Dianella tasmanica* 'Variegata' | Groundcover | 1 gal, 3 gal, bare-root | Yes (8b–11) | Top Tampa shade/low-sun mass-planting workhorse; trim spring |
| Asiatic Jasmine | *Trachelospermum asiaticum* | Groundcover | flat of 18 (4"), 1 gal, 3 gal, liners | Yes | Tampa's default evergreen groundcover; flats for mass coverage, gallons for edging |
| Perennial Peanut 'Ecoturf' | *Arachis glabrata* 'Ecoturf' | Groundcover | 1 gal, sod by pallet | Yes | Tampa-area sod farms (Ruskin) grow Ecoturf/Brooksville 67/68; nitrogen-fixing lawn alternative |
| Dwarf Mondo Grass | *Ophiopogon japonicus* 'Nanus' | Groundcover | 1 gal, 3.5" plugs, flats | Yes | Cheap border/bed-edge filler; plugs cheapest at volume |
| Mondo Grass (standard) | *Ophiopogon japonicus* | Groundcover | flat of 18, 1 gal | Yes | Similar use to liriope; finer texture |
| Liriope 'Big Blue' / Variegated | *Liriope muscari* | Groundcover | 2.5–3" plugs, 1 gal, 3 gal | Yes | Bed-edge and tree-ring workhorse statewide |
| Society Garlic | *Tulbaghia violacea* | Perennial | 1 gal, 3 gal, 7 gal | Yes | Variegated form common; deer-resistant, fragrant foliage (Pennate/Tampa carries it) |
| Lantana (Dallas Red / Bloomify) | *Lantana camara* hybrids | Perennial | 4", 1 gal, 3 gal | Yes (sterile cultivars) | Butterfly/heat workhorse; UF recommends sterile types (Dallas Red, Bloomify) over seed-set types |
| Dwarf Pentas | *Pentas lanceolata* (dwarf series) | Perennial | 4", plugs, 1 gal, 2 gal | Yes (10a); Marginal 9b frost | Butterfly magnet; freezes back in north Tampa, returns from root |
| Mealy-cup Salvia / Blue Salvia | *Salvia farinacea* ('Victoria', 'Blue Spires') | Perennial | 4", 1 gal, plugs | Yes | Long-season blue spike; farinacea is the perennial FL choice |
| Dwarf Firebush | *Hamelia patens* 'Compacta' | Perennial | 1 gal, 3 gal | Yes | Hummingbird shrub used en masse as a perennial bed filler |
| Blue Daze | *Evolvulus glomeratus* 'Blue Daze' | Perennial | 1 gal, 3 gal | Marginal (9b frost; reliable 10a) | Silver-blue sprawling mound; dies to root in a Tampa freeze, usually recovers |
| Mexican Heather | *Cuphea hyssopifolia* | Perennial | 4", 1 gal, 3 gal | Yes | Tight evergreen mound, nonstop small blooms; Tampa staple |
| Dwarf Ruellia 'Katie' | *Ruellia simplex* 'Katie' | Perennial | 1 gal, 3 gal | Yes | Low dwarf form; sterile cultivars required — standard Ruellia simplex is FL Category I invasive |
| Bulbine | *Bulbine frutescens* | Perennial | 1 gal | Yes | Drought-tolerant succulent perennial; orange/yellow spikes, deadhead to keep tidy |
| Dune / Beach Sunflower | *Helianthus debilis* | Perennial | 4", 1 gal, 3 gal | Yes | Native, salt/drought tolerant, sprawling; self-seeds readily |
| Wax Begonia | *Begonia semperflorens-cultorum* | Annual | flat of 18 (3.5"), 36-cell, 4", 1 qt | Yes (cool-season annual in Tampa) | Fall/winter/spring color workhorse; melts in peak summer heat |
| SunPatiens / New Guinea Impatiens | *Impatiens × hybrida* (SunPatiens) | Annual | flat of 18, 4", 6", 1 qt | Yes | The standard impatiens substitute; handles FL sun + mildew-proof |
| Impatiens (common) | *Impatiens walleriana* | Annual | flat of 18, 4" | Marginal | Downy mildew has largely ended its use — quote SunPatiens/begonia instead |
| Annual Vinca / Madagascar Periwinkle | *Catharanthus roseus* | Annual | flat of 18 (4"), 1 gal | Yes | Tampa's toughest summer full-sun annual (Cora XDR for wet season) |
| Caladium | *Caladium × hortulanum* | Annual | bulbs (No.2/jumbo), 4.5" pot | Yes (summer; tubers lifted/treated as annual) | Shade workhorse; fancy-leaf types need warmth — plant after mid-April in Tampa |
| Croton 'Petra' | *Codiaeum variegatum* 'Petra' | Annual (up north; shrub here) | 6", 1 gal, 3 gal | Marginal (9b frost; reliable 10a) | Sold as a houseplant/annual nationally; in Tampa a frost-tender evergreen shrub |
| Coneflower | *Echinacea purpurea* / 'Cheyenne Spirit' | Perennial | bare-root/25-ct tray, 1 gal | Marginal | Short-lived in 9b/10a heat+humidity; fine as a spring/fall seasonal |
| Black-Eyed Susan 'Goldsturm' | *Rudbeckia fulgida* var. *sullivantii* 'Goldsturm' | Perennial | 25-ct tray, 1 gal | Marginal (10a) | *R. hirta* natives do better in FL; treat Goldsturm as a cooler-season perennial |
| Hosta | *Hosta* spp. ('Patriot', 'Frances Williams') | Perennial | 25-ct tray, 1 gal | **No** | Requires winter chill — fails in 9b/10a; do not seed for Tampa clients |
| Daylily 'Stella de Oro' | *Hemerocallis* 'Stella de Oro' | Perennial | bare-root fan, 1 gal | Yes | Evergreen daylily cultivars thrive statewide; reblooming workhorse |
| Salvia 'May Night' | *Salvia nemorosa* 'Mainacht' | Perennial | 25-ct tray, 1 gal | Marginal | Needs drier/cooler conditions than Tampa summer; use *S. farinacea* instead locally |
| Russian Sage | *Perovskia atriplicifolia* | Perennial | 1 gal | Marginal | Hates Gulf humidity; occasional in 9b, unreliable 10a |
| Shasta Daisy | *Leucanthemum × superbum* | Perennial | 25-ct tray, 1 gal | Marginal/No | Crown rot in FL summers; not a Tampa-recommended item |
| Coreopsis | *Coreopsis* spp. (incl. *C. leavenworthii*, FL native) | Perennial | 4", 1 gal, bare-root | Yes (native *leavenworthii*) | FL state wildflower; annual/threadleaf types reseed readily |

**Availability notes.** (a) Workhorse purchase sizes: 1-gal for nearly all
grasses/perennials/flax lily; 3-gal for instant-size shrubby perennials;
4"/flats-of-18 for groundcovers + seasonal color; bare-root fans/plugs for
liriope/daylilies; bulk caladium bulbs; pallet-quoted sod for perennial
peanut. (b) True FL wholesale availability is largely quote-gated (tax ID +
minimums) — the list above is what these growers ADVERTISE carrying; treat it
as an offer list, verified against a real availability call before seeding an
org. (c) Do NOT seed Hosta, Russian Sage, or Shasta Daisy for Tampa clients.

**Sources:** Southern Grove Growers/Plant City availability lists; [Florida
Tropicals Direct — Acosta 2024 catalogue PDF](https://floridatropicalsdirect.com/pdf/Acosta%202024.pdf);
[Ground Works](https://groundworks.site); [SiteOne](https://www.siteone.com);
[Fresh Sod (Tampa) Ecoturf](https://www.freshsod.com/ecoturf-perennial-peanut/);
[Pennate Group (Tampa)](https://pennate-group.com/product/tulbaghia-violacea-society-garlic/);
[UF IFAS Gardening Solutions](https://gardeningsolutions.ifas.ufl.edu) for
suitability verdicts.

### 3.4 Container-size conventions + install-labor benchmarks (agent 4; no pricing)

**The container ladder (ANSI Z60.1).** `#N` is the *trade gallon* — nominal,
not liquid capacity (a #3 holds ~2.3 actual gal, a #15 holds ~11–13). Above
#25 the trade says "25/30/45/65/100 gallon box" — boxes, not pots.

| Container | Top dia. | Typical height (plants) | Typical height (trees) |
|---|---|---|---|
| #1 (~1 gal) | 6–7" | 6"–2' | — |
| #3 (~3 gal) | 10–11" | 1.5–4' | — |
| #5 | 11–13" | 2–4' | — |
| #7 | 14" | 2.5–5' | 5–6' **est.** |
| #15 | 17.5–19.5" | 4.5–5.5' | 8–10', ~1.5–2" cal |
| #25 | 23–24" | 5.5–6.5' | ~2–2.5" cal **est.** |
| #45 | 28–32" | 6.5–8.5' | ~3"+ cal **est.** |

**Caliper** = trunk diameter in inches, measured 6" above the root flare
(12" if ≥1.5"). The `.25` steps are real ANSI spec points ("1.75in cal" is a
discrete size, not slop). Shade-tree spec: 1" cal ≈ 6' height, 2" ≈ 10', 3" ≈
14'; B&B ball diameter ≈ caliper × 12–18". Terms: **B&B** balled & burlapped,
**FG** field-grown, **CT** clear trunk (palms, in feet of trunk), **HT/OA**
height/overall.

**What installers actually buy, per group** (drives which sizes to seed):

| Group | Usual purchase sizes |
|---|---|
| Shade tree | #15 (1.5–2" cal), 30 gal (2"), 45 gal (2.25–2.5"), 65 gal (3"), 100 gal box, then B&B 3–6" cal |
| Palm | 15–25 gal; field-grown priced/sold per trunk-foot (Queen, Sylvester, Sabal CT) |
| Shrub | 3 gal (workhorse), 7 gal (hedge), 15 gal (specimen/instant privacy) |
| Perennial | #1 / 1 gal (some quarts) |
| Annual | 72/606 flats, 36/1206 flats, 48-count jumbo packs |

**Install-labor benchmarks** (MAN-minutes — the `install_minutes` unit; a
2-person crew working 10 min = 20 man-min):

| Item | Man-minutes |
|---|---|
| 1-gal perennial | ~10 |
| Shrub 1–3 gal | 9–15 |
| Shrub 5–7 gal | 15–24 |
| 15-gal shrub/small tree | 30–60 **est.** |
| 30-gal tree | 60–120 **est.** (machine-assisted; more hand-dug) |
| B&B 2–3" caliper | 90–150 |
| B&B 4–6" caliper | 150–240 |
| 2" cal tree, bulk, solo w/ auger | ~90 |
| 2" cal tree, 6-man machine crew | ~24/tree |
| 2" cal tree, hand-dig, poor access | up to 240 |
| 18" B&B tree, medium soil, 2 guys hand-dig | ~113 |
| Palm ≤25 gal | 60–90 (no equipment line) |
| Palm 30–45 gal | 120–180 + equipment flag (crane/boom for 15 ft+) |
| Annual flat (72-ct), installed | 10–15/flat |

**Sources:** ANSI Z60.1 trade-size standards via nursery trade lists
(Greenleaf/Gulf Coast Specialties, Walker Tree Farm, Plantation Tree Co, COD
Trees, Kings Nursery, Palm Beach County native-vegetation pricing);
[The Virtual Estimation planting labor table](https://thevirtualestimation.com/blog/landscaping-estimating-guide-grading-planting-irrigation-hardscape/);
LawnSite contractor threads ([large-tree labor](https://www.lawnsite.com/threads/estimating-labor-large-tree-planting.517756/),
[per-size labor](https://www.lawnsite.com/threads/labor-charge-for-various-plant-sizes.467170/)).
Labor modeled as size-banded man-minutes, NOT a flat % of material — the
contractor consensus is that %-of-cost labor fails on large trees.

## 4. Suggested seed pipeline for Opus

1. Curate the research tables down to the OFFER: ~40–80 species the company
   will actually sell (not all ~120 researched). Tampa lens: zone 9b/10a
   suitable = yes gets seeded; marginal = seeded but `notes` says why; no =
   skip.
2. For each species: name, botanical_name (from research — the reliable import
   key), category from `PLANT_CATEGORIES`, color from `AREA_COLORS`, notes.
3. Sizes: workhorse sizes only at first (research §3.4 names them), 2–4 sizes
   per species, `sort_order` ascending smallest→largest. `size` strings as the
   nursery writes them ("3 gal", "1.75in cal", "B&B", "flat of 18").
4. `cost` / `unit_price`: NOT seeded (owner directive — no pricing in this
   handoff). Ship sizes with both as `0` and treat the catalogue as unpriced
   until the owner sets numbers — but FIRST confirm how the UI renders an
   unpriced size (should be "—", never "$0.00"), and consider making the
   columns nullable in the contract instead. Do NOT invent prices to fill
   the gap.
5. `install_minutes` from the labor benchmarks (§3.4); anything
   uncertain ships as `0` (renders "—", can be set later) — NEVER guess as a
   small non-zero number, because "—" and "free labor" are the two failure
   modes and only one of them is a lie.
6. Deliver as idempotent SQL (upsert on botanical_name within the org) in
   `sql/`, run against the LIVE Supabase only for the test org first
   (`600d02fa-fae2-440b-99ab-42e96997da91` Terra Verde Test Co), browser-check
   `/lawn/plants` + the map picker, THEN ask the user before touching any real
   org. NEVER read or write Peanutz L&L (`d236eba1…`, live comped customer).
7. Re-run `e2e-plant-catalogue.mjs` and `e2e-plant-placement.mjs` after
   seeding (they wipe plant_products for the TEST org only — do not seed the
   test org until after those runs, or run them first).

## 5. Definition of done

- Test org has a realistic seeded catalogue; `/lawn/plants` renders it fast
  with correct sort_order and man-min shown; unpriced sizes render as "—"
  (never "$0.00"), per the §2 item 6 decision.
- Map picker + placement run a full quote flow on seeded data (place → legend
  → line item).
- Real org seeding is a separate, user-approved step.