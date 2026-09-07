// Catalogue readiness (src/lib/catalogueReadiness.ts).
//
// Run:
//   npx tsc src/lib/catalogueReadiness.ts --outDir .mat-build --module esnext \
//     --target es2022 --moduleResolution bundler --skipLibCheck
//   node e2e-catalogue-readiness.mjs
//
// Pure math, no database.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT is a progress bar that reads "0 of
// 690 priced" and makes a new customer close the tab. The shipped catalogue is
// a list to pick from, not homework, and the difference between a row nobody
// has used and a row already sitting on a quote is the whole feature. One is
// six hundred and ninety things to ignore; the other is four things to fix.
const M = await import("./.mat-build/catalogueReadiness.js");
const {
  groupReadiness, catalogueReadiness,
  CATALOGUE_STARTING_POINT_NOTE, CATALOGUE_REGION_NOTE,
} = M;

let pass = 0, fail = 0;
const t = (n, c, d = "") => {
  c ? (pass++, console.log("  PASS " + n))
    : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));
};
const g = (o = {}) => ({ group: "plants", total: 690, priced: 0, blocking: 0, ...o });

console.log("[day one — nothing priced is not a failure state]");
{
  const r = catalogueReadiness([g(), g({ group: "sod", total: 11 })]);
  t("the headline does not lead with the unpriced count",
    !r.headline.includes("690"), r.headline);
  t("...it says day one is normal", r.headline.includes("normal on day one"));
  t("...and that ONE priced row is enough to start",
    r.headline.includes("Price one thing"));
  t("NOTHING IS DEMANDED when nothing is blocking", r.callToAction === null);
  t("no group counts as started", r.startedGroups === 0);
}

console.log("[the per-group message tells them what NOT to do]");
{
  const one = groupReadiness(g({ priced: 0 }));
  t("an unpriced group says to price what they install",
    one.message.includes("actually install"));
  t("...and names the number they can IGNORE", one.message.includes("690"),
    one.message);
  t("...and is not marked clear-but-unstarted wrongly",
    one.started === false && one.clear === true);
}

console.log("\n[a row already on a quote IS a task]");
{
  const r = catalogueReadiness([
    g({ priced: 12, blocking: 4 }),
    g({ group: "labor", total: 38, priced: 3, blocking: 0 }),
  ]);
  t("the headline leads with what is already quoted",
    r.headline.includes("4 things") && r.headline.includes("no price"), r.headline);
  t("A CALL TO ACTION APPEARS", r.callToAction !== null);
  t("...naming the group", (r.callToAction ?? "").includes("plants"));
  t("...and only the blocked group", !(r.callToAction ?? "").includes("labor"));
  t("the blocked group says the quotes are understated",
    r.groups[0].message.includes("understated"));
  t("...and is not 'clear'", r.groups[0].clear === false);
  t("the total counts across groups", r.totalBlocking === 4);
}

console.log("\n[priced-and-clear is the good state, and says the rest can wait]");
{
  const r = catalogueReadiness([g({ priced: 12, blocking: 0 })]);
  t("the headline says they can quote", r.headline.includes("You can quote"));
  t("...and nothing is demanded", r.callToAction === null);
  t("the group reports what IS priced, not what is not",
    r.groups[0].message.startsWith("12 plant sizes priced"));
  t("...and frames the remainder as available, not outstanding",
    r.groups[0].message.includes("there when you need them"));
  t("678 unpriced rows still produce NO call to action", r.callToAction === null);
}

console.log("\n[blocking outranks everything]");
{
  // Even a mostly-priced catalogue leads with the four broken quotes.
  const r = catalogueReadiness([g({ priced: 686, blocking: 4 })]);
  t("a nearly complete catalogue still leads with the blockers",
    r.headline.includes("already quoted"));
  t("...and still asks for the fix", r.callToAction !== null);
}

console.log("\n[an empty group is not an unpriced group]");
{
  const empty = groupReadiness(g({ total: 0, priced: 0 }));
  t("EMPTY SAYS EMPTY, not '0 of 0 priced'",
    empty.message.includes("No plants in your catalogue yet"), empty.message);
  t("...and is not counted as started", empty.started === false);
  const r = catalogueReadiness([g({ total: 0 })]);
  t("a wholly empty catalogue says so", r.headline === "Your catalogue is empty.");
  t("...without demanding anything", r.callToAction === null);
}

console.log("\n[singulars read like English]");
{
  t("one blocking row is singular",
    groupReadiness(g({ blocking: 1 })).message.startsWith("1 plant size on"));
  t("...and the headline agrees",
    catalogueReadiness([g({ blocking: 1 })]).headline.includes("1 thing you"));
  t("one priced row is singular",
    groupReadiness(g({ priced: 1 })).message.startsWith("1 plant size priced"));
  t("every group has a noun",
    ["plants", "sod", "labor", "components", "nozzles"].every(
      (group) => groupReadiness(g({ group, total: 5, priced: 1 })).message.length > 0));
}

console.log("\n[the shipped-catalogue notes say what they must]");
{
  const n = CATALOGUE_STARTING_POINT_NOTE.toLowerCase();
  t("the note calls it a starting point, not a recommendation",
    n.includes("starting point") && n.includes("not a recommendation"));
  t("...says prices are blank because they are the org's",
    n.includes("yours to set"));
  t("...and kills the all-of-it assumption directly",
    n.includes("do not need to price all of it"));
  t("the region note warns the plant list is Southeast-weighted",
    CATALOGUE_REGION_NOTE.toLowerCase().includes("southeast"));
  t("...and says why it ships anyway",
    CATALOGUE_REGION_NOTE.toLowerCase().includes("starting from nothing"));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
