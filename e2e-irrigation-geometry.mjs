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

console.log("\n[throw wording - the diameter mistake]");
t("says both numbers so a diameter entry is visible",
  M.describeThrow(30)==="30 ft from the head \u00b7 60 ft across", M.describeThrow(30));
t("a 30 ft head really does wet 60 ft across", near(2*30, 60, 0.001));
t("unrecorded throw says so rather than showing 0", M.describeThrow(0)==="throw not recorded");

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
const { pipeEstimate, distanceFt, headPoints } = M;
console.log("[distance]");
t("30 ft north measures 30 ft back", near(distanceFt(C, pointAtBearing(C,30,0)), 30, 0.05));
t("30 ft east measures 30 ft back (cos lat applied)", near(distanceFt(C, pointAtBearing(C,30,90)), 30, 0.05));
t("distance is symmetric", near(distanceFt(C,pointAtBearing(C,30,45)), distanceFt(pointAtBearing(C,30,45),C), 1e-9));

console.log("\n[minimum spanning tree]");
// Four heads on a 30 ft square: the cheapest way to link all four is three
// sides = 90 ft. Never the diagonal (42.4) and never all four sides (120).
const sq=[C, pointAtBearing(C,30,0), pointAtBearing(C,30,90), pointAtBearing(pointAtBearing(C,30,0),30,90)];
const e=pipeEstimate(sq,{});
t("30 ft square links with 90 ft of pipe", near(e.straightLineFt,90,0.2), `got ${e.straightLineFt}`);
t("uses n-1 segments", e.segments.length===3, `got ${e.segments.length}`);
t("no segment is the diagonal", e.segments.every(s=>s.ft<35), JSON.stringify(e.segments.map(s=>s.ft)));

console.log("\n[waste]");
const w=pipeEstimate(sq,{wastePct:10});
t("10% waste alone adds 10%", near(w.totalFt, 99, 0.2), `got ${w.totalFt}`);
t("straight line is unchanged by an allowance", near(w.straightLineFt,90,0.2));
const rt=pipeEstimate(sq,{routingPct:30});
t("30% routing gives a routed trench of 117 ft", near(rt.routedFt,117,0.2), `got ${rt.routedFt}`);
const both=pipeEstimate(sq,{routingPct:30,wastePct:10});
t("the two COMPOUND: 90 -> 117 -> 128.7, not 126",
  near(both.totalFt,128.7,0.3), `got ${both.totalFt}`);
t("additive would have under-bought by ~2.7 ft here",
  near(90*1.40, 126, 0.1) && both.totalFt > 126);
t("routed is reported separately so the trench length is visible",
  near(both.routedFt,117,0.2));
t("no allowances leaves the total at the straight line",
  near(pipeEstimate(sq,{}).totalFt, 90, 0.2));
t("negative allowances are ignored, not subtracted",
  near(pipeEstimate(sq,{routingPct:-20,wastePct:-5}).totalFt, 90, 0.2));
t("swapping the two is NOT silently equivalent",
  Math.abs(pipeEstimate(sq,{routingPct:30,wastePct:10}).routedFt
         - pipeEstimate(sq,{routingPct:10,wastePct:30}).routedFt) > 15);

console.log("\n[degenerate]");
t("one head needs no pipe", pipeEstimate([C],{wastePct:10}).straightLineFt===0);
t("no heads needs no pipe", pipeEstimate([],{wastePct:10}).straightLineFt===0);
t("two heads is just the gap", near(pipeEstimate([C,pointAtBearing(C,25,0)],{}).straightLineFt,25,0.05));

console.log("\n[reading heads off an estimate]");
const head=(lat,lng)=>({kind:"point",polygon:[{lat,lng}],meta:{irrigation_product_id:"h",name:"RB",radius_ft:25}});
const plant={kind:"point",polygon:[{lat:28,lng:-82.5}],meta:{plant_product_id:"p",name:"Holly"}};
const poly={kind:"area",polygon:[{lat:28,lng:-82.5}],meta:{}};
t("plants and polygons are not heads",
  headPoints([head(28,-82.5),plant,poly,head(28.0001,-82.5)]).length===2);

// ---------------------------------------------------------------------------
// Drip at plants
// ---------------------------------------------------------------------------
const { readDripConfig, dripTally, dripLineItem, plantsInHeadCoverage } = M;
const dplant=(id,cat,at,extra={})=>({id,kind:"point",color:"#16a34a",polygon:[at],
  meta:{plant_product_id:"p_"+cat,plant_size_id:"s",name:cat,category:cat,size:"3 gal",cost:9.5,unit_price:38,install_minutes:8,...extra}});
const dhead=(id,at,arc,heading,radius=25)=>({id,kind:"point",color:"#0ea5e9",polygon:[at],
  meta:{irrigation_product_id:"rb",irrigation_nozzle_id:"n",name:"Rain Bird 5000",category:"rotor",
    nozzle:"3.0",radius_ft:radius,arc_deg:arc,heading_deg:heading,cost:9,unit_price:28,install_minutes:12}});

console.log("\n[drip config]");
const cfg = readDripConfig({emitter:{irrigation_product_id:"e",irrigation_nozzle_id:"en",name:"Netafim",nozzle:"2 GPH",cost:0.45,unit_price:1.75,install_minutes:2},per_category:{tree:4,shrub:1,grass:0}});
t("emitter parsed", cfg.emitter?.name==="Netafim");
t("per-category parsed", cfg.perCategory.tree===4 && cfg.perCategory.shrub===1);
t("a zero count is the same as no drip for that category", cfg.perCategory.grass===undefined);
t("no drip on this job reads as no emitter", readDripConfig({}).emitter===null);
t("garbage reads as no drip, not NaN", readDripConfig("nonsense").emitter===null);

console.log("\n[emitters counted from placed plants]");
const pAreas=[dplant("t1","tree",C),dplant("t2","tree",pointAtBearing(C,100,0)),
  dplant("s1","shrub",pointAtBearing(C,120,0)),dplant("s2","shrub",pointAtBearing(C,140,0)),
  dplant("g1","grass",pointAtBearing(C,160,0))];
const tal=dripTally(pAreas,cfg);
t("2 trees x4 + 2 shrubs x1 = 10 emitters", tal.emitters===10, `got ${tal.emitters}`);
t("a category with no rule gets none", !tal.byCategory.some(c=>c.category==="grass"));
t("revenue is emitters x price", near(tal.revenue,17.5,0.01));
t("man-hours from PER-EMITTER minutes", near(tal.manHours,10*2/60,0.01));

console.log("\n[per-plant override]");
const ov=dripTally([...pAreas, dplant("t3","tree",pointAtBearing(C,180,0),{emitter_count:8})],cfg);
t("a specimen override wins over the rule", ov.emitters===18, `got ${ov.emitters}`);
t("overrides are surfaced, not hidden", ov.overriddenPlants===1);
t("an override of 0 removes that plant's drip",
  dripTally([dplant("x","tree",C,{emitter_count:0})],cfg).emitters===0);

console.log("\n[plants inside a head's throw]");
const near10=pointAtBearing(C,10,0), east10=pointAtBearing(C,10,90);
const south10=pointAtBearing(C,10,180), west10=pointAtBearing(C,10,270);
const cov=plantsInHeadCoverage([dhead("h1",C,360,0),dplant("in","shrub",near10),dplant("out","shrub",pointAtBearing(C,40,0))]);
t("a plant inside a 360 head is flagged", cov.some(c=>c.plantAreaId==="in"));
t("a plant beyond the throw is not", !cov.some(c=>c.plantAreaId==="out"));
t("the head is named so the UI can explain WHY", cov[0].headName==="Rain Bird 5000");
// heading is where the arc STARTS, sweeping clockwise — matches coverageRing.
const q=plantsInHeadCoverage([dhead("h2",C,90,0),dplant("n","shrub",near10),dplant("e","shrub",east10),
  dplant("s","shrub",south10),dplant("w","shrub",west10)]).map(c=>c.plantAreaId);
t("a 90 starting north covers due north", q.includes("n"));
t("east is the closing edge of a 0-to-90 sweep, so it IS covered", q.includes("e"));
t("due south is outside the sweep", !q.includes("s"));
t("due west is outside the sweep", !q.includes("w"));
const q2=plantsInHeadCoverage([dhead("h6",C,90,180),dplant("n","shrub",near10),
  dplant("s","shrub",south10),dplant("w","shrub",west10)]).map(c=>c.plantAreaId);
t("rotating the start bearing rotates the wedge", q2.includes("s")&&q2.includes("w")&&!q2.includes("n"));
t("a head with no recorded radius covers nothing",
  plantsInHeadCoverage([dhead("h3",C,360,0,0),dplant("p","shrub",near10)]).length===0);
t("heads never flag other heads", plantsInHeadCoverage([dhead("h4",C,360,0),dhead("h5",near10,360,0)]).length===0);

console.log("\n[dropping a covered plant is the ESTIMATOR's choice]");
const covAreas=[dhead("h1",C,360,0),dplant("in","tree",near10),dplant("out","tree",pointAtBearing(C,40,0))];
t("by default NOTHING is dropped — both trees still counted",
  dripTally(covAreas,cfg).emitters===8, `got ${dripTally(covAreas,cfg).emitters}`);
const drop=new Set(plantsInHeadCoverage(covAreas).map(c=>c.plantAreaId));
t("applying the suggestion drops only the covered tree",
  dripTally(covAreas,cfg,drop).emitters===4, `got ${dripTally(covAreas,cfg,drop).emitters}`);

console.log("\n[drip line item]");
const dli=dripLineItem(tal,cfg);
t("one line for all emitters", dli.quantity===10 && dli.unit==="EA");
t("names the emitter", dli.description==="Netafim 2 GPH drip emitters", dli.description);
t("cost is per unit", dli.internal_cost===0.45);
t("no emitters -> null, so no $0 drip line", dripLineItem(dripTally([],cfg),cfg)===null);
t("no drip configured -> null", dripLineItem(tal,readDripConfig({}))===null);

// Block-scoped: this section declares its own geometry helpers and the
// sections above already use several of those names.
{
const { coverageReport, describeCoverage, headsForCoverage } = M;
// A 40 x 40 ft square lawn, corners walked from C.
const NE = pointAtBearing(pointAtBearing(C, 40, 0), 40, 90);
const N = pointAtBearing(C, 40, 0);
const E = pointAtBearing(C, 40, 90);
const SQUARE = [C, N, NE, E];
const chead = (at, radius, arc = 360, heading = 0) => ({ at, snap: { radius_ft: radius, arc_deg: arc, heading_deg: heading } });
const mid = pointAtBearing(pointAtBearing(C, 20, 0), 20, 90);

console.log("[the area itself]");
const none = coverageReport(SQUARE, [], 2);
t("measures ~1600 sq ft for a 40 ft square", near(none.areaSqft, 1600, 120), `got ${none.areaSqft}`);
t("no heads -> nothing reached", none.reachedPct === 0);
t("no heads -> the whole area is gap", near(none.gapSqft, none.areaSqft, 1));
t("says so plainly", describeCoverage(none)[0] === "No heads placed yet.");

console.log("\n[one big head]");
// A head at the centre with a 40 ft throw reaches every corner (corner is
// 28.3 ft away), so the whole square is inside one throw.
const big = coverageReport(SQUARE, [chead(mid, 40)], 2);
t("one 40 ft head at centre reaches 100%", big.reachedPct === 100, `got ${big.reachedPct}`);
t("no gaps", big.gapSqft === 0);
t("but overlap is 0 — one head cannot overlap itself", big.overlapPct === 0);

console.log("\n[THE POINT: touching circles measure 100% and are under-designed]");
// Four heads, one per quadrant centre, each 14.2 ft radius: circles just touch.
const q = [
  pointAtBearing(pointAtBearing(C, 10, 0), 10, 90),
  pointAtBearing(pointAtBearing(C, 30, 0), 10, 90),
  pointAtBearing(pointAtBearing(C, 10, 0), 30, 90),
  pointAtBearing(pointAtBearing(C, 30, 0), 30, 90),
].map((p) => chead(p, 15));
const touching = coverageReport(SQUARE, q, 2);
// Head-to-head: same four heads with radius reaching each other (20 ft apart).
const headToHead = coverageReport(SQUARE, q.map((h) => chead(h.at, 22)), 2);
console.log(`      touching:     reached ${touching.reachedPct}%  overlap ${touching.overlapPct}%`);
console.log(`      head-to-head: reached ${headToHead.reachedPct}%  overlap ${headToHead.overlapPct}%`);
t("head-to-head reaches at least as much as touching", headToHead.reachedPct >= touching.reachedPct);
t("head-to-head has MUCH higher overlap — the number that distinguishes them",
  headToHead.overlapPct > touching.overlapPct + 20,
  `${touching.overlapPct}% vs ${headToHead.overlapPct}%`);
t("a single 'coverage score' could not tell these apart on reach alone",
  Math.abs(headToHead.reachedPct - touching.reachedPct) < 25);

console.log("\n[gaps]");
// One small head in a corner leaves most of the lawn dry.
const corner = coverageReport(SQUARE, [chead(C, 10)], 2);
t("a 10 ft head in one corner leaves big gaps", corner.gapSqft > 1200, `gap ${corner.gapSqft}`);
t("gap points are returned so the UI can mark them", corner.gapPoints.length > 0);
t("gap points are capped, not one per cell", corner.gapPoints.length <= 200);
t("reached + gap accounts for the whole area",
  near(corner.reachedSqft + corner.gapSqft, corner.areaSqft, 1));

console.log("\n[arcs are respected]");
// C is the SW corner and the square lies to its north and east, so a 0->90
// sweep covers ALL of it — correct, and the reason the first version of this
// test was wrong rather than the code.
const facingIn = coverageReport(SQUARE, [chead(C, 60, 90, 0)], 2);
t("a 90 aimed INTO the lawn covers it", facingIn.reachedPct === 100, `got ${facingIn.reachedPct}`);
// Rotate the same head to sweep south->west, away from the lawn.
const facingOut = coverageReport(SQUARE, [chead(C, 60, 90, 180)], 2);
t("the same 90 rotated away covers almost none of it",
  facingOut.reachedPct < 5, `got ${facingOut.reachedPct}`);
const full = coverageReport(SQUARE, [chead(C, 60, 360, 0)], 2);
t("a 180 covers less than a 360 when half its sweep is off the lawn",
  coverageReport(SQUARE, [chead(C, 60, 180, 90)], 2).reachedPct <= full.reachedPct);
t("a 360 with 60 ft radius covers the lot", full.reachedPct === 100);

console.log("\n[unrecorded throw is not zero coverage]");
const noRadius = coverageReport(SQUARE, [chead(mid, 0)], 2);
t("heads with no radius flags radiusMissing", noRadius.radiusMissing === true);
t("...and does not claim 0% covered as a design fact",
  describeCoverage(noRadius)[0].includes("cannot be measured"), describeCoverage(noRadius)[0]);
t("mixed: one real head means the report IS meaningful",
  coverageReport(SQUARE, [chead(mid, 0), chead(mid, 40)], 2).radiusMissing === false);

console.log("\n[reading the report]");
const lines = describeCoverage(headToHead);
t("leads with what was measured, not a grade", lines[0].includes("inside at least one head"));
t("names the overlap caveat rather than scoring the design",
  lines.some((l) => l.includes("not the same as watered ground")));
t("never uses the word 'covered' as a verdict", !lines.some((l) => /fully covered|pass(ed)?/i.test(l)));
t("warns that radii assume a design pressure",
  lines.some((l) => l.includes("design pressure")));
t("tells them to record a test BEFORE laying out the system",
  lines.some((l) => /record a pressure test at the site BEFORE laying out/i.test(l)));
t("the caveat rides along even on a perfect-looking report",
  describeCoverage(coverageReport(SQUARE, [chead(mid, 40)], 2)).some((l) => l.includes("design pressure")));

console.log("\n[reading heads off an estimate]");
const areaRows = [
  { kind: "point", polygon: [mid], meta: { irrigation_product_id: "h", name: "RB", radius_ft: 25, arc_deg: 360, heading_deg: 0 } },
  { kind: "point", polygon: [mid], meta: { plant_product_id: "p", name: "Holly" } },
  { kind: "area", polygon: SQUARE, meta: {} },
];
t("plants and polygons are not heads", headsForCoverage(areaRows).length === 1);
}

{
// Block-scoped like the coverage section above.
const { readPressureTest, pressureUntested, pressureVerdict, pressureAgeDays,
        CATALOGUE_DESIGN_PSI } = M;
console.log("[reading a recorded test]");
const full = readPressureTest({ pressure_static_psi: 62, pressure_working_psi: 48, pressure_gpm: 11, pressure_tested_at: "2026-09-01T10:00:00Z", pressure_notes: "hose bibb, north side" });
t("reads all five fields", full.staticPsi === 62 && full.workingPsi === 48 && full.gpm === 11);
t("string numerics coerce", readPressureTest({ pressure_working_psi: "48" }).workingPsi === 48);
t("blank is not zero", readPressureTest({ pressure_working_psi: "" }).workingPsi === null);
t("zero is not a pressure", readPressureTest({ pressure_working_psi: 0 }).workingPsi === null);
t("nothing recorded reads as untested", pressureUntested(readPressureTest(null)) === true);
t("a recorded static counts as tested", pressureUntested(readPressureTest({ pressure_static_psi: 60 })) === false);

console.log("\n[the prompt: test BEFORE layout]");
const none = pressureVerdict(readPressureTest(null));
t("untested is its own status", none.status === "untested");
t("says to record it BEFORE laying out", /BEFORE laying out/i.test(none.message), none.message);
t("names the pressure the radii assume", none.message.includes("45 psi"));
t("design pressure is 45", CATALOGUE_DESIGN_PSI === 45);

console.log("\n[static alone is not enough]");
const staticOnly = pressureVerdict(readPressureTest({ pressure_static_psi: 68 }));
t("flagged as static only", staticOnly.status === "static_only");
t("explains static always reads higher", /always reads higher/i.test(staticOnly.message));

console.log("\n[comparing against the catalogue]");
const good = pressureVerdict(readPressureTest({ pressure_working_psi: 52 }));
t("at or above design is stated plainly", good.status === "at_or_above");
t("no shortfall", good.shortfallPsi === 0);
const low = pressureVerdict(readPressureTest({ pressure_working_psi: 30 }));
t("below design is flagged", low.status === "below");
t("says by how much", low.shortfallPsi === 15, `got ${low.shortfallPsi}`);
t("warns every head throws SHORTER than drawn", /throw shorter than drawn/i.test(low.message));
t("sends them to the chart at the MEASURED pressure", low.message.includes("at 30 psi"));
t("does NOT invent a reduced radius",
  !/\d+\s*ft/.test(low.message), low.message);
t("exactly at design is not 'below'", pressureVerdict(readPressureTest({ pressure_working_psi: 45 })).status === "at_or_above");
t("a different design pressure is respected",
  pressureVerdict(readPressureTest({ pressure_working_psi: 30 }), 40).shortfallPsi === 10);

console.log("\n[age]");
t("never tested has no age", pressureAgeDays(readPressureTest(null)) === null);
t("a date gives days", pressureAgeDays(readPressureTest({ pressure_tested_at: new Date(Date.now() - 5 * 86400000).toISOString() })) === 5);
}

{
// Block-scoped: declares its own `near` and fixtures.
const { interpolateRadius, adjustedRadius, describeAdjustment } = M;
const near = (a, b, e = 0.05) => a !== null && Math.abs(a - b) < e;
// The real Hunter PGP blue 3.0 chart, as fetched from the published table.
const PGP30 = [
  { psi: 25, radius_ft: 35, gpm: 2.6 },
  { psi: 35, radius_ft: 36, gpm: 2.8 },
  { psi: 45, radius_ft: 38, gpm: 3.0 },
  { psi: 55, radius_ft: 39, gpm: 3.3 },
  { psi: 65, radius_ft: 39, gpm: 3.6 },
];
const nozzle = { radius_ft: 38, rated_psi: 45, min_psi: 25, performance: PGP30 };

console.log("[interpolating the real chart]");
t("exact chart point returns it", interpolateRadius(PGP30, 45) === 38);
t("another exact point", interpolateRadius(PGP30, 25) === 35);
t("between 35 and 45 lands between 36 and 38", near(interpolateRadius(PGP30, 40), 37, 0.51), `got ${interpolateRadius(PGP30, 40)}`);
t("above the chart is CAPPED, not extrapolated up", interpolateRadius(PGP30, 90) === 39);
t("below the chart returns null, never extrapolated down", interpolateRadius(PGP30, 15) === null);
t("one point cannot interpolate", interpolateRadius([{ psi: 45, radius_ft: 38 }], 30) === null);
t("garbage returns null", interpolateRadius(null, 30) === null);

console.log("\n[adjusting to a measured pressure]");
const at45 = adjustedRadius(nozzle, 45);
t("at rated pressure reads the chart", at45.method === "chart" && at45.radiusFt === 38);
const at40 = adjustedRadius(nozzle, 40);
t("off-chart-point interpolates", at40.method === "interpolated");
t("...and the note credits the manufacturer chart", /chart/i.test(at40.note));

console.log("\n[THE CLIFF: below minimum operating pressure]");
const low = adjustedRadius(nozzle, 20);
t("refuses to return a radius", low.radiusFt === null, `got ${low.radiusFt}`);
t("method says why", low.method === "below_minimum");
t("names the manufacturer's minimum", low.note.includes("25"), low.note);
t("says the nozzle will not perform as designed", /not perform|rotate|mist/i.test(low.note));
t("points at a different nozzle or a booster", /nozzle|booster/i.test(low.note));
t("exactly AT the minimum is allowed", adjustedRadius(nozzle, 25).radiusFt !== null);

console.log("\n[scaling when there is no chart]");
const noChart = { radius_ft: 38, rated_psi: 45, min_psi: 25, performance: [] };
const scaled = adjustedRadius(noChart, 30);
t("scales from the rated figure", scaled.method === "scaled");
t("...and is labelled an ESTIMATE", /estimate/i.test(scaled.note));
// 38 * (30/45)^0.125 = 38 * 0.9507 = 36.1
t("the exponent is flat, not sqrt: 45->30 psi costs ~2 ft not 7",
  near(scaled.radiusFt, 36.1, 0.15), `got ${scaled.radiusFt}`);
t("a square-root model would have said ~31 ft", Math.abs(38 * Math.sqrt(30 / 45) - 31.0) < 0.5);
t("scaling UP is modest too", near(adjustedRadius(noChart, 65).radiusFt, 38 * Math.pow(65 / 45, 0.125), 0.15));

console.log("\n[missing inputs are not zero]");
t("no pressure recorded shows the rated figure as-is",
  adjustedRadius(nozzle, null).method === "unknown" && adjustedRadius(nozzle, null).radiusFt === 38);
t("...and says no pressure was recorded", /no pressure|not.*recorded/i.test(adjustedRadius(nozzle, null).note));
t("a nozzle with no radius returns null, not 0",
  adjustedRadius({ radius_ft: 0, rated_psi: 45 }, 45).radiusFt === null);
t("unknown rated pressure cannot be adjusted",
  adjustedRadius({ radius_ft: 30, performance: [] }, 30).method === "unknown");

console.log("\n[wording]");
const words = [low, scaled, at45].map(describeAdjustment).join(" ");
t("never claims adequacy", !/\badequate\b|\bsufficient\b|\bwill work\b/i.test(words));
t("describeAdjustment returns one line each",
  [low, scaled, at45].every((a) => !describeAdjustment(a).includes("\n")));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
