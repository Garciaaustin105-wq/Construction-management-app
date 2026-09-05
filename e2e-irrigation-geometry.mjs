// Geometry and legend checks for sprinkler heads (src/lib/irrigationProducts.ts).
//
// Run:
//   npx tsc src/lib/irrigationProducts.ts --outDir .irr-build --module esnext //     --target es2022 --moduleResolution bundler --skipLibCheck
//   node e2e-irrigation-geometry.mjs
//
// That compile reports ONE error, TS2307 on the type-only import of
// "@/lib/estimateAreas": the path alias is not configured on a bare tsc call.
// Expected, not a failure — the import is erased, the emitted JS is complete.
//
// Pure math, no database and no browser. The arc geometry is the only genuinely
// new code in the irrigation work, and it is the kind that looks right and is
// wrong by a cos(lat) factor, so it is checked against known ground distances
// rather than against itself: 25 ft north and 25 ft east must BOTH be 25 ft on
// the ground while spanning different numbers of degrees.
const M = await import("./.irr-build/irrigationProducts.js");
const { pointAtBearing, coverageRing, coverageSqft, buildHeadLegend, headLineItem, headLegendManHours, radiusUnset } = M;
let pass=0, fail=0;
const t=(n,c,d="")=>{ if(c){pass++;console.log("  PASS "+n);} else {fail++;console.log(`  FAIL ${n}${d?" — "+d:""}`);} };
const near=(a,b,e)=>Math.abs(a-b)<e;
const C={lat:28.0,lng:-82.5};

console.log("[bearing + distance]");
// 1 degree of latitude is ~364,000 ft. 25 ft north should move ~25/364000 deg.
const n25 = pointAtBearing(C,25,0);
t("25 ft north moves only latitude", near(n25.lng, C.lng, 1e-12), `lng moved ${Math.abs(n25.lng-C.lng)}`);
t("25 ft north is ~25 ft", near((n25.lat-C.lat)*364000, 25, 0.5), `got ${((n25.lat-C.lat)*364000).toFixed(2)} ft`);
const e25 = pointAtBearing(C,25,90);
t("25 ft east moves only longitude", near(e25.lat, C.lat, 1e-12));
// At 28N a degree of longitude is 364000*cos(28) = ~321,400 ft.
t("25 ft east is ~25 ft after cos(lat)", near((e25.lng-C.lng)*364000*Math.cos(28*Math.PI/180), 25, 0.5),
  `got ${((e25.lng-C.lng)*364000*Math.cos(28*Math.PI/180)).toFixed(2)} ft`);
t("east and north are the same GROUND distance, not the same degrees",
  Math.abs(e25.lng-C.lng) > Math.abs(n25.lat-C.lat));

console.log("\n[coverage ring]");
const full = coverageRing(C,25,360,0);
const quarter = coverageRing(C,25,90,0);
t("360 ring does not include the centre (it is a circle)",
  !full.some(p=>p.lat===C.lat && p.lng===C.lng));
t("90 ring STARTS at the head, so the two straight edges draw",
  quarter[0].lat===C.lat && quarter[0].lng===C.lng);
t("90 uses about a quarter of the points of a full circle",
  near(quarter.length, full.length/4, 4), `full ${full.length}, quarter ${quarter.length}`);
t("every ring point is the radius from the centre",
  full.slice(1).every(p=>{
    const dN=(p.lat-C.lat)*364000, dE=(p.lng-C.lng)*364000*Math.cos(28*Math.PI/180);
    return near(Math.hypot(dN,dE),25,0.5);
  }));
t("radius 0 draws NOTHING, not a dot", coverageRing(C,0,360,0).length===0);
t("negative radius draws nothing", coverageRing(C,-5,360,0).length===0);

console.log("\n[coverage sqft]");
t("full 25 ft head wets pi*r^2", near(coverageSqft(25,360), Math.PI*625, 0.05), `got ${coverageSqft(25,360)}`);
t("half arc wets half", near(coverageSqft(25,180), Math.PI*625/2, 0.05));
t("quarter arc wets a quarter", near(coverageSqft(25,90), Math.PI*625/4, 0.05));
t("no radius wets nothing", coverageSqft(0,360)===0);

console.log("\n[legend]");
const mk=(arc,price=28,cost=9,mins=12,noz="3.0",r=25)=>({kind:"point",color:"#0ea5e9",
  meta:{irrigation_product_id:"rb5000",irrigation_nozzle_id:"n1",name:"Rain Bird 5000",category:"rotor",
    nozzle:noz,radius_ft:r,arc_deg:arc,heading_deg:0,cost,unit_price:price,install_minutes:mins}});
const legend = buildHeadLegend([mk(360),mk(360),mk(90),mk(180),mk(180),mk(180)]);
t("same nozzle at different arcs stays SEPARATE rows", legend.length===3, JSON.stringify(legend.map(r=>r.arc_deg)));
t("arcs sort ascending within a model", legend.map(r=>r.arc_deg).join()==="90,180,360");
t("counts are right", legend.find(r=>r.arc_deg===180).count===3);
t("man-hours across all heads", near(headLegendManHours(legend), 6*12/60, 0.01), `got ${headLegendManHours(legend)}`);
const li = headLineItem(legend.find(r=>r.arc_deg===90));
t("line item names the arc and radius", li.description==="Rain Bird 5000 3.0 90° 25ft", li.description);
t("line item cost is PER UNIT", li.internal_cost===9);
t("full circle reads 'full' not 360°", headLineItem(legend.find(r=>r.arc_deg===360)).description.includes("full"));
t("a plant is NOT a head", buildHeadLegend([{kind:"point",color:"#16a34a",
  meta:{plant_product_id:"p1",name:"Holly",unit_price:38}}]).length===0);
t("radiusUnset true only when nothing has a radius", radiusUnset(buildHeadLegend([mk(360,28,9,12,"3.0",0)]))===true);
t("radiusUnset false when a radius exists", radiusUnset(legend)===false);
console.log(`\n  ${pass} passed, ${fail} failed`);
