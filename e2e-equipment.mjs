// Equipment costing checks (src/lib/equipmentProducts.ts).
//
// Run:
//   npx tsc src/lib/equipmentProducts.ts --outDir .eq-build --module esnext \
//     --target es2022 --moduleResolution bundler --skipLibCheck
//   node e2e-equipment.mjs
//
// Pure math, no database. The case worth protecting is the period plan: rental
// houses price a week well below seven days, so multiplying the daily rate is
// often the most expensive possible answer and the one a spreadsheet reaches
// for first.
const { cheapestPlan, equipmentCharge, equipmentTotals, equipmentLineItem,
        readEquipmentSnapshot, rateAgeDays } = await import("./.eq-build/equipmentProducts.js");
let pass=0,fail=0;
const t=(n,c,d="")=>{c?(pass++,console.log("  PASS "+n)):(fail++,console.log(`  FAIL ${n}${d?" — "+d:""}`))};
const near=(a,b,e=0.01)=>Math.abs(a-b)<e;
const R={daily:150,weekly:450,monthly:1200};

console.log("[cheapest period plan]");
t("1 day takes the daily rate", cheapestPlan(1,R).total===150);
t("2 days is still daily", cheapestPlan(2,R).total===300);
t("3 days daily (450) ties the week — never MORE than a week", cheapestPlan(3,R).total<=450);
t("5 days takes the WEEK, not 5 x daily",
  cheapestPlan(5,R).total===450, `got ${cheapestPlan(5,R).total}`);
t("...and says so", cheapestPlan(5,R).label==="1 week", cheapestPlan(5,R).label);
t("naive daily x days would have charged 750", 5*150===750);
t("9 days is a week plus 2 days", cheapestPlan(9,R).label==="1 week + 2 days");
t("9 days costs 750, not 1350", cheapestPlan(9,R).total===750, `got ${cheapestPlan(9,R).total}`);
// A rental "month" is 4 weeks / 28 days at most houses, so 30 days is a month
// plus two — NOT one month. The convention is a parameter because some
// suppliers bill calendar months, and two days on every long hire is real.
t("28 days is exactly one month", cheapestPlan(28,R).total===1200, `got ${cheapestPlan(28,R).total}`);
t("30 days is a month plus 2 days on a 28-day month",
  cheapestPlan(30,R).total===1500, `got ${cheapestPlan(30,R).total}`);
t("...and exactly one month if the supplier bills calendar months",
  cheapestPlan(30,R,30).total===1200, `got ${cheapestPlan(30,R,30).total}`);
t("a month still beats 4 weeks + 2 days", 1200 < 4*450+2*150);
t("a part day rounds up to a whole one", cheapestPlan(0.5,R).total===150);
t("zero days costs nothing", cheapestPlan(0,R).total===0);

console.log("\n[missing rates are not free rates]");
t("no rates at all flags unpriced", cheapestPlan(5,{daily:null,weekly:null,monthly:null}).unpriced===true);
t("...and does not invent a total", cheapestPlan(5,{daily:null,weekly:null,monthly:null}).total===0);
t("weekly only, 3 days rounds up to the week",
  cheapestPlan(3,{daily:null,weekly:450,monthly:null}).total===450);
t("weekly only, 9 days takes two weeks rather than pretending days are free",
  cheapestPlan(9,{daily:null,weekly:450,monthly:null}).total===900);

console.log("\n[rented: delivery counts once, not per day]");
const rented={equipment_product_id:"e1",name:"Skid steer",category:"skid_steer",ownership:"rented",
  cost_hourly:null,cost_daily:150,cost_weekly:450,cost_monthly:1200,
  price_hourly:null,price_daily:225,price_weekly:675,price_monthly:1800,
  delivery_fee:85,pickup_fee:85,operator_required:true};
const c=equipmentCharge({snapshot:rented,quantity:1,hours:0,days:5});
t("cost is the week plus both fees", near(c.cost,450+170), `got ${c.cost}`);
t("revenue likewise on the sell rates", near(c.revenue,675+170), `got ${c.revenue}`);
t("mobilization is reported separately", near(c.mobilization,170));
t("fees do NOT scale with days", near(equipmentCharge({snapshot:rented,quantity:1,hours:0,days:30}).mobilization,170));
t("two machines means two deliveries",
  near(equipmentCharge({snapshot:rented,quantity:2,hours:0,days:5}).mobilization,340));
t("two machines rents two weeks",
  near(equipmentCharge({snapshot:rented,quantity:2,hours:0,days:5}).cost,900+340));

console.log("\n[owned: the silent one]");
const owned={...rented,name:"Our dump trailer",ownership:"owned",cost_hourly:18,price_hourly:45,
  delivery_fee:0,pickup_fee:0,operator_required:false};
const o=equipmentCharge({snapshot:owned,quantity:1,hours:6,days:0});
t("owned bills by the hour", near(o.cost,108) && near(o.revenue,270), `${o.cost}/${o.revenue}`);
t("owned has no delivery", o.mobilization===0);
t("owned with NO hourly cost is flagged, not quoted at zero",
  equipmentCharge({snapshot:{...owned,cost_hourly:null},quantity:1,hours:6,days:0}).unpriced===true);
t("...and unused owned gear is not flagged",
  equipmentCharge({snapshot:{...owned,cost_hourly:null},quantity:1,hours:0,days:0}).unpriced===false);

console.log("\n[totals + line item]");
const tot=equipmentTotals([{snapshot:rented,quantity:1,hours:0,days:5},{snapshot:owned,quantity:1,hours:6,days:0}]);
t("totals sum both models", near(tot.cost,620+108) && near(tot.revenue,845+270), `${tot.cost}/${tot.revenue}`);
t("operator requirement surfaces", tot.needsOperator===true);
const li=equipmentLineItem(tot.charges[0]);
t("line names the machine and the basis", li.description==="Skid steer — 1 week", li.description);
t("line carries cost for margin", near(li.internal_cost,620));
t("nothing billable -> null, so no $0 equipment line",
  equipmentLineItem(equipmentCharge({snapshot:{...rented,price_daily:null,price_weekly:null,price_monthly:null,delivery_fee:0,pickup_fee:0},quantity:1,hours:0,days:5}))===null);

console.log("\n[snapshot + rate age]");
t("garbage reads as no equipment", readEquipmentSnapshot({foo:1})===null);
t("string numerics coerce", readEquipmentSnapshot({equipment_product_id:"x",name:"X",cost_daily:"150"}).cost_daily===150);
t("a missing rate stays NULL, not 0",
  readEquipmentSnapshot({equipment_product_id:"x",name:"X"}).cost_daily===null);
t("never-priced returns null age", rateAgeDays({rates_updated_at:null})===null);
t("a date gives an age in days", rateAgeDays({rates_updated_at:new Date(Date.now()-3*86400000).toISOString()})===3);
console.log(`\n  ${pass} passed, ${fail} failed`);
