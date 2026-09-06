// Labor-item math (src/lib/laborItems.ts).
//
// Run:
//   npx tsc src/lib/laborItems.ts --outDir .labor-build --module esnext \
//     --target es2022 --moduleResolution bundler --skipLibCheck
//   node e2e-labor-items.mjs
//
// Pure math, no database — the Supabase import is a type and erases.
//
// Two things this file exists to protect.
//
// UNITS. Eight of them now, and the worst is msqft: typing 5000 into a field
// whose unit is thousand-square-feet is a THOUSAND-fold error that looks
// exactly like a correct entry. toMsqft() and the basis string are the defence.
//
// VALUES ARE THE ORG'S. Nothing in the contract may supply a default rate or a
// default price. The published benchmarks are a separate structure that is
// shown beside a field and never enters a calculation, and there are
// assertions below that hold that line.
const { LABOR_CATEGORIES, isLaborCategory, LABOR_UNITS, isLaborUnit,
        unitAbbrev, unitLabel, toMsqft, laborSnapshot, readLaborSnapshot,
        laborCharge, laborTotals, laborLineItem, LABOR_SCOPE_NOTE,
        LABOR_BENCHMARKS, BILL_RATE_BENCHMARK, benchmarkFor,
        describeBenchmark } = await import("./.labor-build/laborItems.js");
let pass=0,fail=0;
const t=(n,c,d="")=>{c?(pass++,console.log("  PASS "+n)):(fail++,console.log(`  FAIL ${n}${d?" — "+d:""}`))};
const near=(a,b,e=0.01)=>Math.abs(a-b)<e;
const snap=(o)=>({labor_item_id:"l1",name:"X",category:"other",unit:"each",
  cost:0,unit_price:0,install_minutes:0,...o});

console.log("[categories and units]");
t("every category is recognised", LABOR_CATEGORIES.every(isLaborCategory));
t("the tasks with no home before this all have one now",
  ["mulch","edging","bed_prep","grading","demolition","haul_off","drainage","cleanup"]
    .every(c=>LABOR_CATEGORIES.includes(c)));
t("eight units", LABOR_UNITS.length===8);
t("area, volume, weight, length, time and flat-fee are all covered",
  ["sqft","msqft","cubic_yard","ton","foot","hour","job","each"].every(isLaborUnit));
t("sqyd is deliberately absent — 1 sqyd is 9 sqft and the confusion is not worth it",
  isLaborUnit("sqyd")===false);
t("abbreviations are the ones a takeoff uses",
  unitAbbrev("cubic_yard")==="CY" && unitAbbrev("msqft")==="MSF" && unitAbbrev("sqft")==="SF");
t("long labels spell the trap out", unitLabel("msqft")==="thousand square feet");

console.log("\n[msqft — the thousand-fold trap]");
t("5,000 sqft measured is 5 MSF", toMsqft(5000)===5);
t("1,250 sqft is 1.25 MSF", toMsqft(1250)===1.25);
t("a fraction survives rather than rounding to a whole MSF", toMsqft(1499)===1.499);
t("zero area is zero", toMsqft(0)===0);
t("negative area is zero, not negative work", toMsqft(-500)===0);
t("NaN is zero", toMsqft(NaN)===0);
const seed=snap({name:"Overseed",category:"seeding",unit:"msqft",unit_price:18,install_minutes:1.4});
const m5=laborCharge(seed,toMsqft(5000));
t("5,000 sqft of overseed bills 5 units at 18", near(m5.revenue,90), `got ${m5.revenue}`);
// The basis restates the square footage, so an entry of 5000-meaning-sqft
// reads "5000 MSF (5,000,000 sqft)" on the line and is caught by eye.
t("the basis states BOTH the MSF and the sqft", m5.basis==="5 MSF (5,000 sqft)", m5.basis);
t("...so a thousand-fold slip is visible in the line itself",
  laborCharge(seed,5000).basis.includes("5,000,000 sqft"));

console.log("\n[fractional rates survive — the integer column bug]");
// 1.4 man-min per MSF and 0.5 per foot are real published figures. An integer
// column rounds the first to 1 (a 30% error) and this is why the schema is
// numeric.
t("1.4 man-min/MSF over 5 MSF is 7 man-min, not 5", near(m5.manHours,7/60), `got ${m5.manHours}`);
const edge=snap({name:"Spade edge",category:"edging",unit:"foot",unit_price:2.5,install_minutes:0.5});
t("0.5 man-min/ft over 400 ft is 3.33 man-hours, not 0",
  near(laborCharge(edge,400).manHours,3.33), `got ${laborCharge(edge,400).manHours}`);

console.log("\n[per-volume: mulch carries material AND labor]");
const mulch=snap({name:"Hardwood mulch",category:"mulch",unit:"cubic_yard",
  cost:32,unit_price:65,install_minutes:32});
const m12=laborCharge(mulch,12);
t("12 cu yd costs 12 x 32", near(m12.cost,384), `got ${m12.cost}`);
t("...and sells at 12 x 65", near(m12.revenue,780), `got ${m12.revenue}`);
t("32 man-min/yd over 12 yd is 6.4 man-hours", near(m12.manHours,6.4), `got ${m12.manHours}`);
t("basis names the unit", m12.basis==="12 cu yd", m12.basis);
t("one row carries material and labor together", m12.cost>0 && m12.manHours>0);

console.log("\n[per-hour: the quantity IS the time]");
const weeding=snap({name:"Hand weeding",category:"weeding",unit:"hour",unit_price:55});
const w8=laborCharge(weeding,8);
// install_minutes is 0 here and must be ignored. Reporting 0 man-hours for an
// eight-hour line because a column was blank is worse than ignoring it.
t("8 hours billed is 8 man-hours even with no rate entered",
  near(w8.manHours,8), `got ${w8.manHours}`);
t("...and it is not flagged untimed, because an hour row is timed by definition",
  w8.untimed===false);
t("revenue is the hourly rate times hours", near(w8.revenue,440));
t("a pure-labor row has no material cost", w8.cost===0);

console.log("\n[a blank is not a zero]");
const blank=snap({name:"Fine grading",category:"grading",unit:"sqft"});
const b1=laborCharge(blank,2000);
t("no price is flagged unpriced", b1.unpriced===true);
t("no rate is flagged untimed", b1.untimed===true);
t("...and untimed is SEPARATE from unpriced — a job can be priced but untimed",
  laborCharge(snap({unit:"sqft",unit_price:0.4}),2000).unpriced===false &&
  laborCharge(snap({unit:"sqft",unit_price:0.4}),2000).untimed===true);
t("an UNUSED row is neither", laborCharge(blank,0).unpriced===false &&
  laborCharge(blank,0).untimed===false);
t("it never reaches a customer line", laborLineItem(b1)===null);

console.log("\n[line items carry PER-UNIT money]");
const li=laborLineItem(m12);
t("a priced row produces a line", li!==null);
t("quantity is the cubic yards", li.quantity===12);
t("unit is CY", li.unit==="CY");
t("unit_price is per yard (65), NOT the 780 extended", near(li.unit_price,65), `got ${li.unit_price}`);
t("internal_cost is per yard (32), NOT the 384 extended", near(li.internal_cost,32), `got ${li.internal_cost}`);
t("quantity x unit_price reconstructs the revenue", near(li.quantity*li.unit_price,m12.revenue));
t("the description states the basis", li.description.includes("12 cu yd"));

console.log("\n[totals]");
const tot=laborTotals([
  {snapshot:mulch,quantity:12},{snapshot:weeding,quantity:8},{snapshot:blank,quantity:2000}]);
t("cost sums", near(tot.cost,384), `got ${tot.cost}`);
t("revenue omits the unpriced row rather than inventing one",
  near(tot.revenue,780+440), `got ${tot.revenue}`);
t("man-hours mix per-volume and per-hour", near(tot.manHours,6.4+8), `got ${tot.manHours}`);
t("the unpriced row is counted", tot.unpricedCount===1);
t("the untimed row is counted", tot.untimedCount===1);
t("an empty list totals zero, not NaN", laborTotals([]).cost===0);

console.log("\n[bad input never throws]");
t("negative quantity is 0", laborCharge(mulch,-5).cost===0);
t("NaN quantity is 0", laborCharge(mulch,NaN).revenue===0);
t("Infinity quantity is 0", laborCharge(mulch,Infinity).cost===0);

console.log("\n[snapshot round-trip]");
const row={id:"abc",organization_id:"o",name:"Haul off",category:"haul_off",
  unit:"cubic_yard",cost:0,unit_price:45,install_minutes:6,notes:null,
  active:true,created_at:"x"};
const s1=laborSnapshot(row);
t("id is kept under its own key", s1.labor_item_id==="abc");
t("unit is carried", s1.unit==="cubic_yard");
const s2=readLaborSnapshot(JSON.parse(JSON.stringify(s1)));
t("it reads back", s2!==null && s2.name==="Haul off");
t("numerics arriving as strings coerce", readLaborSnapshot({...s1,cost:"12.5"}).cost===12.5);
t("a fractional rate as a string survives",
  readLaborSnapshot({...s1,install_minutes:"1.4"}).install_minutes===1.4);
t("garbage becomes 0, not NaN", readLaborSnapshot({...s1,cost:"twelve"}).cost===0);
t("an unknown category falls back to other",
  readLaborSnapshot({...s1,category:"digging"}).category==="other");
t("an unknown unit falls back to each — never silently to a bigger unit",
  readLaborSnapshot({...s1,unit:"acre"}).unit==="each");
t("no id is not a snapshot", readLaborSnapshot({...s1,labor_item_id:null})===null);
t("null is not a snapshot", readLaborSnapshot(null)===null);
t("re-pricing the catalogue does not move a snapshot already taken",
  laborSnapshot({...row,unit_price:999}).unit_price===999 && s1.unit_price===45);

console.log("\n[suggestions are suggestions, not defaults]");
// The whole point: research informs the estimator, it does not fill the field.
const bm=benchmarkFor("mulch","cubic_yard");
t("a benchmark exists for mulch", bm!==null);
t("...and it is a published production rate", bm.minutes.typical===32);
t("a blank row does NOT pick it up", laborCharge(snap({category:"mulch",unit:"cubic_yard"}),12).manHours===0);
t("...nor the price", laborCharge(snap({category:"mulch",unit:"cubic_yard"}),12).revenue===0);
t("edging has only a market price, and says so",
  benchmarkFor("edging","foot").minutes===null &&
  benchmarkFor("edging","foot").price.typical===2.5);
t("...which the description frames as what OTHERS charge",
  describeBenchmark(benchmarkFor("edging","foot")).includes("Others charge"));
t("a single-source rate is not dressed up as a range",
  benchmarkFor("seeding","msqft").minutes.low===benchmarkFor("seeding","msqft").minutes.high);
t("...and the source says so", benchmarkFor("seeding","msqft").source.includes("single source"));
t("every benchmark names what moves the number",
  Object.values(LABOR_BENCHMARKS).every(b=>b.driver.length>10));
t("every description defers to the org's own times",
  Object.values(LABOR_BENCHMARKS).every(b=>describeBenchmark(b).includes("Your own crew times")));
t("a category with no research returns null rather than a guess",
  benchmarkFor("grading","sqft")===null);
t("the billing-rate benchmark is a range, not a recommendation",
  BILL_RATE_BENCHMARK.price.low===65 && BILL_RATE_BENCHMARK.price.high===145);

console.log("\n[scope — the double-count guard]");
t("the scope note names the three catalogues that already price labor",
  ["Sod","plant","irrigation"].every(w=>LABOR_SCOPE_NOTE.includes(w)));
t("...and says removal is different from installation",
  LABOR_SCOPE_NOTE.includes("Removal"));
t("no category invites duplicating sod or planting install",
  LABOR_CATEGORIES.includes("sod")===false && LABOR_CATEGORIES.includes("planting")===false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
