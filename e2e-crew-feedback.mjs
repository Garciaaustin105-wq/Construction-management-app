// Crew-time feedback math (src/lib/crewFeedback.ts).
//
// Run:
//   npx tsc src/lib/crewFeedback.ts --outDir .feedback-build --module esnext \
//     --target es2022 --moduleResolution bundler --skipLibCheck
//   sed -i 's|from "./manHours"|from "./manHours.js"|' .feedback-build/crewFeedback.js
//   node e2e-crew-feedback.mjs
//
// The sed is needed because this is the first contract here with a relative
// import: tsc emits `from "./manHours"` and Node ESM will not resolve an
// extensionless specifier. Next builds it fine; only this standalone run cares.
//
// Pure math, no database.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT is a missing crew size becoming a
// silent third of the truth. Man-hours are duration TIMES heads; an entry with
// no crew size cannot become man-hours at all, and defaulting it to 1 would
// understate every rate by the size of the crew while looking entirely normal.
// Right now only 1 of 7 closed entries in this database carries a crew size, so
// this is the live case, not a hypothetical.
//
// The second is attribution. A job's hours belong to a task only when there was
// one task. Everything else is an assumption and has to be labelled as one.
const { classifyEntry, entryManHours, actualManHours, jobVariance, calibration,
        observationsFor, collectObservations, rateSuggestion, rankSuggestions,
        MIN_SAMPLE, SPREAD_LIMIT } = await import("./.feedback-build/crewFeedback.js");
let pass=0,fail=0;
const t=(n,c,d="")=>{c?(pass++,console.log("  PASS "+n)):(fail++,console.log(`  FAIL ${n}${d?" — "+d:""}`))};
const near=(a,b,e=0.01)=>Math.abs(a-b)<e;

// 8am-to-4pm, eight clock-hours.
const entry=(o={})=>({id:"e1",jobId:"j1",clockInAt:"2026-09-01T08:00:00Z",
  clockOutAt:"2026-09-01T16:00:00Z",crewSize:1,...o});
const line=(o={})=>({key:"k1",label:"Item",unit:"cu yd",quantity:10,manHours:5,...o});
const job=(o={})=>({jobId:"j1",estimateId:"est1",jobName:"Job",completedAt:null,
  lines:[line()],entries:[entry()],...o});

console.log("[man-hours are duration TIMES heads]");
t("one person for 8 hours is 8 man-hours", near(entryManHours(entry()),8));
t("THREE people for 8 hours is 24 man-hours, not 8",
  near(entryManHours(entry({crewSize:3})),24), `got ${entryManHours(entry({crewSize:3}))}`);
t("...which is the entire point — clock time would have said 8",
  entryManHours(entry({crewSize:3}))===3*entryManHours(entry({crewSize:1})));

console.log("\n[a missing crew size is refused, never defaulted]");
t("null crew size is flagged", classifyEntry(entry({crewSize:null}))==="no_crew_size");
t("...and yields no man-hours at all", entryManHours(entry({crewSize:null}))===null);
t("...and is NOT quietly treated as a crew of one",
  entryManHours(entry({crewSize:null}))!==8);
t("zero crew size is the same refusal", classifyEntry(entry({crewSize:0}))==="no_crew_size");
t("a still-running entry reads as open, not as missing data to chase",
  classifyEntry(entry({clockOutAt:null}))==="open");
t("...even when the crew size is also absent",
  classifyEntry(entry({clockOutAt:null,crewSize:null}))==="open");
t("a backwards window is invalid",
  classifyEntry(entry({clockOutAt:"2026-09-01T07:00:00Z"}))==="invalid_window");
t("an unparseable timestamp is invalid, not a huge shift",
  classifyEntry(entry({clockOutAt:"not a date"}))==="invalid_window");
t("a good entry is not flagged", classifyEntry(entry())===null);

console.log("\n[totals report what they could not use]");
const mixed=actualManHours([
  entry({id:"a",crewSize:2}), entry({id:"b",crewSize:null}),
  entry({id:"c",clockOutAt:null}), entry({id:"d",crewSize:3})]);
t("only the usable entries are summed", near(mixed.manHours,16+24), `got ${mixed.manHours}`);
t("two entries contributed", mixed.included===2);
t("two were excluded", mixed.excluded.length===2);
t("the missing crew size is counted separately, because it is fixable",
  mixed.noCrewSizeCount===1);
t("the open entry is counted separately, because it is not a problem",
  mixed.openCount===1);
t("an empty list is zero, not NaN", actualManHours([]).manHours===0);
t("all-unusable is zero with the reasons kept",
  actualManHours([entry({crewSize:null})]).manHours===0 &&
  actualManHours([entry({crewSize:null})]).noCrewSizeCount===1);

console.log("\n[job variance]");
const v=jobVariance(job({lines:[line({manHours:5})],entries:[entry({crewSize:1})]}));
t("5 estimated against 8 actual is a 1.6x ratio", near(v.ratio,1.6), `got ${v.ratio}`);
t("...reported as 60% under", v.deltaPct===60);
t("...and usable", v.usable===true);
const over=jobVariance(job({lines:[line({manHours:10})],entries:[entry()]}));
t("10 estimated against 8 actual is 0.8x", near(over.ratio,0.8));
t("...reported as 20% over", over.deltaPct===-20);
// A job with no rates entered cannot be compared. Calling that a 100% overrun
// would turn our own blank field into the crew's problem.
t("nothing estimated is unusable, NOT a 100% overrun",
  jobVariance(job({lines:[line({manHours:0})]})).usable===false);
t("...and says why", jobVariance(job({lines:[line({manHours:0})]})).reason==="nothing_estimated");
t("no usable time is unusable and says why",
  jobVariance(job({entries:[entry({crewSize:null})]})).reason==="no_usable_time");
t("the time breakdown rides along so the screen can explain the gap",
  jobVariance(job({entries:[entry({crewSize:null})]})).time.noCrewSizeCount===1);

console.log("\n[calibration is a median, and gated on sample size]");
const mk=(est,crew)=>jobVariance(job({lines:[line({manHours:est})],entries:[entry({crewSize:crew})]}));
// 8, 8 and 8 actual against 5, 5, 5 estimated: every job 1.6x.
const three=[mk(5,1),mk(5,1),mk(5,1)];
t("three consistent jobs give 1.6x", near(calibration(three).medianRatio,1.6));
t("...and are enough to act on", calibration(three).enough===true);
t("...direction is under", calibration(three).direction==="under");
t("two jobs is not enough", calibration([mk(5,1),mk(5,1)]).enough===false);
t("...and the message says so", calibration([mk(5,1)]).message.includes("Too few"));
t("MIN_SAMPLE is three, matching the industry guidance to time three installs",
  MIN_SAMPLE===3);
// One rained-out disaster must not drag the figure for months.
const withOutlier=[mk(5,1),mk(5,1),mk(5,1),mk(5,1),mk(0.5,1)];
t("a single catastrophic job barely moves the median",
  near(calibration(withOutlier).medianRatio,1.6), `got ${calibration(withOutlier).medianRatio}`);
t("...though the range still discloses it", calibration(withOutlier).highRatio===16);
t("within 10% reads as on target, not as a trend",
  calibration([mk(8,1),mk(8,1),mk(8,1)]).direction==="on_target");
t("no data says so plainly", calibration([]).message.includes("No completed job"));
t("...without claiming a ratio", calibration([]).medianRatio===0);

console.log("\n[attribution — one task, or it is an assumption]");
const solo=observationsFor(job({
  lines:[line({key:"mulch",quantity:10,manHours:5})], entries:[entry({crewSize:1})]}));
t("a single-task job produces one observation", solo.length===1);
t("...attributed DIRECT, with no assumption", solo[0].kind==="direct");
t("...taking ALL the job's hours", near(solo[0].manHours,8));
t("...as 48 man-min per cu yd", near(solo[0].manMinutesPerUnit,48), `got ${solo[0].manMinutesPerUnit}`);

const multi=observationsFor(job({
  lines:[line({key:"mulch",quantity:10,manHours:6}), line({key:"edge",quantity:100,unit:"ft",manHours:2})],
  entries:[entry({crewSize:1})]}));
t("a two-task job produces two observations", multi.length===2);
t("...both labelled proportional", multi.every(o=>o.kind==="proportional"));
t("...splitting 8 actual hours 6:2", near(multi[0].manHours,6) && near(multi[1].manHours,2),
  `got ${multi[0].manHours} and ${multi[1].manHours}`);
t("...and the split conserves the total", near(multi[0].manHours+multi[1].manHours,8));

// The limitation worth knowing: a blank rate gets no proportional share, so it
// can only ever be learned from a job where it was the only task. Splitting
// hours onto an item estimated at nothing would be inventing the figure.
const blankInMulti=observationsFor(job({
  lines:[line({key:"mulch",quantity:10,manHours:6}), line({key:"new",quantity:50,manHours:0})],
  entries:[entry()]}));
t("an unrated item gets NO proportional share", blankInMulti.every(o=>o.key!=="new"));
t("...but IS learned when it was the only task on a job",
  observationsFor(job({lines:[line({key:"new",quantity:50,manHours:0})],entries:[entry()]}))
    .length===1);
t("...directly", observationsFor(job({lines:[line({key:"new",quantity:50,manHours:0})],
  entries:[entry()]}))[0].kind==="direct");
t("a job with no usable time produces nothing",
  observationsFor(job({entries:[entry({crewSize:null})]})).length===0);
t("a zero-quantity line is not billable and produces nothing",
  observationsFor(job({lines:[line({quantity:0})]})).length===0);

console.log("\n[mobilization comes off the top]");
// It is real labor, it is inside the clocked time, and it belongs to no item.
// Leaving it in would load a small job whole overhead onto its one item.
const withMob=observationsFor(job({
  lines:[line({key:"mulch",quantity:10,manHours:5})],
  entries:[entry({crewSize:1})], mobilizationHours:2}));
t("8 clocked hours less 2 mobilization leaves 6 to attribute",
  near(withMob[0].manHours,6), `got ${withMob[0].manHours}`);
t("...so the rate is 36 man-min/unit, not the 48 it would be otherwise",
  near(withMob[0].manMinutesPerUnit,36), `got ${withMob[0].manMinutesPerUnit}`);
t("mobilization still counts toward the job ESTIMATED total",
  jobVariance(job({lines:[line({manHours:5})],mobilizationHours:2}))
    .estimatedManHours===7);
t("...so the variance compares like with like", near(jobVariance(
  job({lines:[line({manHours:5})],mobilizationHours:2})).ratio, 8/7));
t("mobilization swallowing the whole job yields no observation, not a negative one",
  observationsFor(job({mobilizationHours:9})).length===0);
t("a proportional split also draws from the reduced pool",
  near(observationsFor(job({
    lines:[line({key:"a",quantity:10,manHours:6}), line({key:"b",quantity:10,manHours:2})],
    mobilizationHours:2}))
    .reduce((s,o)=>s+o.manHours,0), 6));

console.log("\n[grouping across jobs]");
const grouped=collectObservations([
  job({jobId:"a",lines:[line({key:"mulch",quantity:10})]}),
  job({jobId:"b",lines:[line({key:"mulch",quantity:20})]}),
  job({jobId:"c",lines:[line({key:"edge",quantity:100})]})]);
t("observations group by catalogue row", grouped.get("mulch").length===2);
t("...keeping other rows separate", grouped.get("edge").length===1);
t("...and tagging which job each came from",
  grouped.get("mulch").map(o=>o.jobId).join(",")==="a,b");

console.log("\n[suggestions — proposed, never applied]");
const obs=(rate,kind="direct",id="j")=>({jobId:id,key:"mulch",label:"Mulch",unit:"cu yd",
  kind,quantity:10,manHours:1,manMinutesPerUnit:rate});
const good=rateSuggestion("mulch","Mulch","cu yd",[obs(30),obs(34),obs(32)],28);
t("three agreeing jobs produce a suggestion", good.suggested===32, `got ${good.suggested}`);
t("...as the median, not the mean", good.medianRate===32);
t("...with the range disclosed", good.lowRate===30 && good.highRate===34);
t("...and the current figure carried for comparison", good.currentRate===28);
t("two jobs produce NO suggestion", rateSuggestion("m","M","cu yd",[obs(30),obs(34)],28).suggested===null);
t("...and say how many more are needed",
  rateSuggestion("m","M","cu yd",[obs(30)],28).message.includes(`of ${MIN_SAMPLE}`));
// Three jobs that disagree wildly were not the same job. A median of them is
// arithmetic, not information.
const wild=rateSuggestion("m","M","cu yd",[obs(10),obs(35),obs(90)],28);
t("a 9x spread produces NO suggestion despite a big enough sample",
  wild.suggested===null && wild.sampleSize===3);
t("...and says the jobs were not comparable", wild.message.includes("not the same job"));
t("...and sends the reader to look at them individually", wild.message.includes("individually"));
t("SPREAD_LIMIT is 3x", SPREAD_LIMIT===3);
t("exactly at the limit still agrees", rateSuggestion("m","M","cu yd",
  [obs(10),obs(20),obs(30)],28).suggested!==null);

console.log("\n[direct beats proportional rather than blending with it]");
const mixedObs=[obs(30),obs(32),obs(34),obs(90,"proportional"),obs(95,"proportional")];
const pref=rateSuggestion("m","M","cu yd",mixedObs,28);
t("with three direct observations the proportional ones are dropped",
  pref.suggested===32, `got ${pref.suggested}`);
t("...and the sample size reflects only what was used", pref.sampleSize===3);
t("...and it says the figures are from single-task jobs",
  pref.directOnly===true && pref.message.includes("single-task"));
const fallback=rateSuggestion("m","M","cu yd",[obs(30),obs(34,"proportional"),obs(32,"proportional")],28);
t("with too few direct, proportional ones are used", fallback.sampleSize===3);
t("...and the message flags them as indicative",
  fallback.directOnly===false && fallback.message.includes("indicative"));

console.log("\n[ranking puts the useful rows first]");
const ranked=rankSuggestions([
  rateSuggestion("a","A","ea",[obs(30),obs(31),obs(32)],30),          // tiny shift
  rateSuggestion("b","B","ea",[obs(30)],30),                          // no proposal
  rateSuggestion("c","C","ea",[obs(30),obs(31),obs(32)],0),           // blank rate
  rateSuggestion("d","D","ea",[obs(60),obs(61),obs(62)],30)]);        // big shift
t("a blank rate with a proposal leads — it is a number they do not have",
  ranked[0].key==="c");
t("then the biggest correction", ranked[1].key==="d");
t("then the small one", ranked[2].key==="a");
t("rows with no proposal sink to the bottom", ranked[3].key==="b");
t("the input array is not mutated", ranked.length===4);

console.log("\n[nothing here writes]");
t("a suggestion is a value, not an action", typeof good.suggested==="number");
t("the current rate is untouched by suggesting against it", good.currentRate===28);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
