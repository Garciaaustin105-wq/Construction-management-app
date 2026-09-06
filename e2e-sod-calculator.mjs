// Sod calculator checks (src/lib/sodProducts.ts).
//
// Run:
//   npx tsc src/lib/sodProducts.ts --outDir .sod-build --module esnext \
//     --target es2022 --moduleResolution bundler --skipLibCheck
//   node e2e-sod-calculator.mjs
//
// Pure math, no database. The case that matters is the one everybody gets
// wrong by hand: sod is measured in square feet and BOUGHT in whole pallets,
// so the order always rounds up and always leaves paid-for surplus.
const { sodEstimate, palletSizeUnset, sodLineItem, describePallet, sodSnapshot,
        sodEstimateForArea } = await import("./.sod-build/sodProducts.js");
let pass=0,fail=0;
const t=(n,c,d="")=>{c?(pass++,console.log("  PASS "+n)):(fail++,console.log(`  FAIL ${n}${d?" — "+d:""}`))};
const near=(a,b,e=0.01)=>Math.abs(a-b)<e;
const P={sqft_per_pallet:450,cost_per_sqft:0.35,price_per_sqft:0.85,install_minutes_per_1000_sqft:90};

console.log("[the worked case: 4,200 sq ft lawn]");
const e=sodEstimate(4200,P,10);
t("waste is 10% of the measured area", near(e.wasteSqft,420));
t("gross to cover is 4,620", near(e.grossSqft,4620));
t("order rounds UP: 4620/450 = 10.27 -> 11 pallets", e.pallets===11, `got ${e.pallets}`);
t("11 pallets is 4,950 sq ft purchased", near(e.purchasedSqft,4950));
t("330 sq ft is paid for and not laid", near(e.leftoverSqft,330), `got ${e.leftoverSqft}`);
t("priced on GROSS, not on what was purchased", near(e.revenue,4620*0.85), `got ${e.revenue}`);
t("cost likewise on gross", near(e.cost,4620*0.35));
t("man-hours from per-1000 rate", near(e.manHours,4620/1000*90/60), `got ${e.manHours}`);

console.log("\n[pallet size changes the order, so it cannot be assumed]");
t("same job at 400/pallet is 12 pallets", sodEstimate(4200,{...P,sqft_per_pallet:400},10).pallets===12);
t("same job at 500/pallet is 10 pallets", sodEstimate(4200,{...P,sqft_per_pallet:500},10).pallets===10);
t("unrecorded pallet size gives NULL, not a guess",
  sodEstimate(4200,{...P,sqft_per_pallet:0},10).pallets===null);
t("...and no purchased or leftover figure either",
  sodEstimate(4200,{...P,sqft_per_pallet:0},10).leftoverSqft===null);
t("palletSizeUnset flags it", palletSizeUnset({sqft_per_pallet:0})===true);
t("...and not when it is set", palletSizeUnset({sqft_per_pallet:450})===false);

console.log("\n[rounding up is never rounding down]");
t("exactly one pallet stays one", sodEstimate(450,P,0).pallets===1);
t("one square foot over needs two", sodEstimate(451,P,0).pallets===2);
t("a hair under one pallet still needs one", sodEstimate(449,P,0).pallets===1);
t("leftover is zero on an exact fit", near(sodEstimate(450,P,0).leftoverSqft,0));

console.log("\n[degenerate]");
t("no area, no pallets", sodEstimate(0,P,10).pallets===null);
t("no area, no revenue", sodEstimate(0,P,10).revenue===0);
t("negative area treated as none", sodEstimate(-500,P,10).grossSqft===0);
t("negative waste ignored, not subtracted", near(sodEstimate(1000,P,-20).grossSqft,1000));

console.log("\n[line item]");
const li=sodLineItem("Floratam St. Augustine",e,0.35);
t("billed on gross square feet", near(li.quantity,4620));
t("unit is SF", li.unit==="SF");
t("unit price recovers the per-sqft rate", near(li.unit_price,0.85,0.0001), `got ${li.unit_price}`);
t("internal cost is per square foot", li.internal_cost===0.35);
t("description states the cutting allowance", li.description.includes("10% cutting waste"), li.description);
t("no area -> null, so no $0 sod line", sodLineItem("x",sodEstimate(0,P,0),0.35)===null);
t("no price -> null", sodLineItem("x",sodEstimate(1000,{...P,price_per_sqft:0},0),0.35)===null);

console.log("\n[the pallet assumption is visible and changeable]");
t("the assumption is spelled out, not implied",
  describePallet(450)==="assuming 450 sq ft per pallet", describePallet(450));
t("an unset size asks for the real number instead of saying 0",
  describePallet(0)==="pallet size not set — enter what your farm ships", describePallet(0));
t("the estimate carries the size it used, so the count is checkable",
  sodEstimate(4200,P,10).sqftPerPallet===450);

const prod={id:"s1",organization_id:"o",name:"Floratam St. Augustine",grass_type:"st_augustine",
  sqft_per_pallet:450,cost_per_sqft:0.35,price_per_sqft:0.85,install_minutes_per_1000_sqft:90,
  notes:null,active:true,created_at:"2026-01-01"};
const fromCat=sodSnapshot(prod,10);
t("a job seeds its pallet size from the catalogue", fromCat.sqft_per_pallet===450);
const thisDelivery=sodSnapshot(prod,10,400);
t("...and the estimator can override it for THIS purchase", thisDelivery.sqft_per_pallet===400);
t("a bad override falls back to the catalogue rather than to zero",
  sodSnapshot(prod,10,0).sqft_per_pallet===450);
t("the override changes the order: 400/pallet needs 12, not 11",
  sodEstimate(4200,thisDelivery,10).pallets===12, `got ${sodEstimate(4200,thisDelivery,10).pallets}`);
t("overriding the job does NOT touch the catalogue", prod.sqft_per_pallet===450);

console.log("\n[sod on a measured area]");
const sodArea={kind:"area",area_sqft:4200,meta:{...thisDelivery}};
const forArea=sodEstimateForArea(sodArea);
t("reads the snapshot off the area", forArea.snapshot.name==="Floratam St. Augustine");
t("uses the area's own measured sqft", forArea.estimate.netSqft===4200);
t("uses the pallet size recorded on THAT job", forArea.estimate.pallets===12);
t("uses the waste recorded on that job", forArea.estimate.wastePct===10);
t("a plain measured area is not sod", sodEstimateForArea({kind:"area",area_sqft:1000,meta:{}})===null);
t("a plant point is not sod",
  sodEstimateForArea({kind:"point",area_sqft:0,meta:{plant_product_id:"p",name:"Holly"}})===null);
t("garbage in meta reads as no sod, not NaN",
  sodEstimateForArea({kind:"area",area_sqft:1000,meta:{sod_product_id:5}})===null);

console.log(`\n  ${pass} passed, ${fail} failed`);
