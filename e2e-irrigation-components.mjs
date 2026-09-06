// System-component costing checks (src/lib/irrigationSystem.ts).
//
// Run:
//   npx tsc src/lib/irrigationSystem.ts --outDir .sys-build --module esnext \
//     --target es2022 --moduleResolution bundler --skipLibCheck
//   node e2e-irrigation-components.mjs
//
// Pure math, no database — the Supabase import is a type and erases.
//
// The case worth protecting is UNITS. Heads are per-each; wire, mainline and
// sleeving are per-FOOT. A quantity of "2" means two valves or two feet
// depending on the row, and the failures that cost money are silent ones:
// a per-foot part billed as if the quantity were pieces, or an extended total
// reaching a line item that multiplies by quantity a second time.
const { COMPONENT_CATEGORIES, isComponentCategory, COMPONENT_UNITS, isComponentUnit,
        componentSnapshot, readComponentSnapshot, componentCharge, systemTotals,
        componentLineItem, stationCheck } = await import("./.sys-build/irrigationSystem.js");
let pass=0,fail=0;
const t=(n,c,d="")=>{c?(pass++,console.log("  PASS "+n)):(fail++,console.log(`  FAIL ${n}${d?" — "+d:""}`))};
const near=(a,b,e=0.01)=>Math.abs(a-b)<e;

const snap=(o)=>({irrigation_component_id:"c1",name:"X",category:"other",unit:"each",
  cost:0,unit_price:0,install_minutes:0,...o});

console.log("[categories and units]");
t("every category the schema allows is recognised",
  COMPONENT_CATEGORIES.every(isComponentCategory));
t("mainline, zone_valve, controller and sleeve are all present",
  ["mainline","zone_valve","controller","sleeve","backflow","wire"].every(c=>COMPONENT_CATEGORIES.includes(c)));
// pipeEstimate() computes lateral footage between heads and dripline is sold
// by the foot; without these two there was nothing to price either against.
t("lateral and drip exist so per-foot pipe has somewhere to live",
  ["lateral","drip"].every(c=>COMPONENT_CATEGORIES.includes(c)));
// Trenching is labor sold by the linear foot. It carries install_minutes and
// no material cost, which the per-foot machinery already handles correctly.
t("trenching is a category", COMPONENT_CATEGORIES.includes("trenching"));
const trench=snap({name:"Machine trench",category:"trenching",unit:"foot",
  cost:0,unit_price:1.85,install_minutes:2});
const t300=componentCharge(trench,300);
t("300 ft of trench sells at 300 x 1.85", near(t300.revenue,555), `got ${t300.revenue}`);
t("2 man-min/ft over 300 ft is 10 man-hours", near(t300.manHours,10), `got ${t300.manHours}`);
t("labor with no material cost is still not unpriced", t300.unpriced===false);
t("...and reaches the quote", componentLineItem(t300)!==null);
t("a zero internal_cost is honest for a labor line",
  componentLineItem(t300).internal_cost===0);
t("a typo is not a category", isComponentCategory("zonevalve")===false);
t("units are exactly each and foot", COMPONENT_UNITS.join(",")==="each,foot");
t("a roll is not a unit — that is the mistake this table exists to prevent",
  isComponentUnit("roll")===false);

console.log("\n[per-each pricing]");
const valve=snap({name:"1in valve",category:"zone_valve",unit:"each",cost:22,unit_price:44,install_minutes:25});
const v6=componentCharge(valve,6);
t("6 valves cost 6 x 22", near(v6.cost,132), `got ${v6.cost}`);
t("...and sell at 6 x 44", near(v6.revenue,264), `got ${v6.revenue}`);
t("25 man-min each is 2.5 man-hours for six", near(v6.manHours,2.5), `got ${v6.manHours}`);
t("basis names the unit", v6.basis==="6 each", v6.basis);

console.log("\n[per-FOOT pricing — quantity IS feet]");
const wire=snap({name:"18-2 wire",category:"wire",unit:"foot",cost:0.32,unit_price:0.75,install_minutes:0.5});
const w200=componentCharge(wire,200);
t("200 ft of wire costs 200 x 0.32", near(w200.cost,64), `got ${w200.cost}`);
t("...and sells at 150", near(w200.revenue,150), `got ${w200.revenue}`);
// 0.5 man-min per foot is trivial per foot and 100 man-minutes over a run.
// Per-foot install time multiplying by feet is the intended behaviour.
t("0.5 man-min/ft over 200 ft is 1.67 man-hours, not 0.5",
  near(w200.manHours,1.67), `got ${w200.manHours}`);
t("basis says ft, so nobody reads 200 as 200 rolls", w200.basis==="200 ft", w200.basis);
t("the SAME numbers as each would price 200 pieces identically — only the "+
  "label distinguishes them, which is why the label is mandatory",
  near(componentCharge({...wire,unit:"each"},200).cost, w200.cost));

console.log("\n[a missing price is not a free part]");
const unpriced=snap({name:"Backflow",category:"backflow",cost:180,unit_price:0,install_minutes:90});
const u=componentCharge(unpriced,1);
t("cost is still carried", near(u.cost,180));
t("no revenue", u.revenue===0);
t("flagged unpriced", u.unpriced===true);
t("an UNUSED component is not unpriced, it is unused",
  componentCharge(unpriced,0).unpriced===false);
t("it never reaches a customer line", componentLineItem(u)===null);

console.log("\n[line items carry PER-UNIT money]");
const li=componentLineItem(w200);
t("a priced run produces a line", li!==null);
t("quantity is the feet", li.quantity===200);
t("unit is FT", li.unit==="FT");
// The consumer multiplies quantity by these. Handing it the extended figure
// would bill 200 ft of wire two hundred times over.
t("unit_price is per foot (0.75), NOT the 150 extended", near(li.unit_price,0.75), `got ${li.unit_price}`);
t("internal_cost is per foot (0.32), NOT the 64 extended", near(li.internal_cost,0.32), `got ${li.internal_cost}`);
t("quantity x unit_price reconstructs the revenue", near(li.quantity*li.unit_price, w200.revenue));
t("quantity x internal_cost reconstructs the cost", near(li.quantity*li.internal_cost, w200.cost));
t("an each line says EA", componentLineItem(v6).unit==="EA");
t("...and prices per valve", near(componentLineItem(v6).unit_price,44));
t("the description states the basis", componentLineItem(v6).description.includes("6 each"));

console.log("\n[totals]");
const tot=systemTotals([
  {snapshot:valve,quantity:6},{snapshot:wire,quantity:200},{snapshot:unpriced,quantity:1}]);
t("cost sums all three", near(tot.cost,132+64+180), `got ${tot.cost}`);
t("revenue omits the unpriced part rather than inventing one",
  near(tot.revenue,264+150), `got ${tot.revenue}`);
t("man-hours mix per-each and per-foot", near(tot.manHours,2.5+1.67+1.5), `got ${tot.manHours}`);
t("the unpriced part is counted so the UI can say so", tot.unpricedCount===1);
t("an empty system totals zero, not NaN", systemTotals([]).cost===0);

console.log("\n[bad input never throws]");
t("negative quantity is 0", componentCharge(valve,-5).cost===0);
t("NaN quantity is 0", componentCharge(valve,NaN).revenue===0);
t("Infinity quantity is 0", componentCharge(valve,Infinity).cost===0);

console.log("\n[snapshot round-trip]");
const row={id:"abc",organization_id:"o",name:"PVB",category:"backflow",unit:"each",
  cost:210,unit_price:390,install_minutes:120,notes:null,active:true,created_at:"x"};
const s1=componentSnapshot(row);
t("snapshot keeps the id under its own key", s1.irrigation_component_id==="abc");
t("snapshot carries the unit", s1.unit==="each");
const s2=readComponentSnapshot(JSON.parse(JSON.stringify(s1)));
t("it reads back", s2!==null && s2.name==="PVB");
t("numerics survive as numbers", s2.unit_price===390);
t("numerics arriving as strings coerce",
  readComponentSnapshot({...s1,cost:"210.5"}).cost===210.5);
t("a garbage numeric becomes 0, not NaN",
  readComponentSnapshot({...s1,cost:"eleven"}).cost===0);
t("an unknown category falls back to other",
  readComponentSnapshot({...s1,category:"widget"}).category==="other");
t("an unknown unit falls back to each — never silently to foot",
  readComponentSnapshot({...s1,unit:"roll"}).unit==="each");
t("no id is not a snapshot", readComponentSnapshot({...s1,irrigation_component_id:null})===null);
t("null is not a snapshot", readComponentSnapshot(null)===null);
t("a re-priced catalogue does not move a snapshot already taken",
  componentSnapshot({...row,unit_price:999}).unit_price===999 && s1.unit_price===390);

console.log("\n[station check — arithmetic, never design]");
const short=stationCheck(6,4);
t("6 valves on a 4-station controller is short", short.ok===false);
t("...by 2", short.short===2);
t("...and says both numbers", short.message.includes("6")&&short.message.includes("4"));
t("8 stations covers 6 valves", stationCheck(6,8).ok===true);
t("...with no shortfall", stationCheck(6,8).short===0);
t("exactly equal is covered", stationCheck(6,6).ok===true);
// Missing data is not a shortfall. Reporting "6 short" because no controller
// has been picked yet would be the app inventing a problem.
t("no controller entered yet is not a shortfall", stationCheck(6,0).ok===true);
t("...and no shortfall number is reported from it", stationCheck(6,0).short===0);
t("neither entered is fine", stationCheck(0,0).ok===true);
t("negatives count as zero", stationCheck(-3,-2).ok===true);
t("NaN counts as zero", stationCheck(NaN,4).zoneValves===0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
