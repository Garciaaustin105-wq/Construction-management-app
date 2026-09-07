// Material orders (src/lib/materialOrders.ts).
//
// Run:
//   npx tsc src/lib/materialOrders.ts src/lib/materialTakeoff.ts \
//     src/lib/plantProducts.ts src/lib/irrigationProducts.ts \
//     src/lib/sodProducts.ts src/lib/irrigationSystem.ts \
//     --outDir .mat-build --module esnext --target es2022 \
//     --moduleResolution bundler --skipLibCheck
//   node fix-mat-specifiers.mjs
//   node e2e-material-orders.mjs
//
// Pure math, no database.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT is an order that moves after it has
// been sent. A take-off is live by design — edit the estimate and it follows —
// and that is exactly wrong once a supplier is holding the paperwork. The
// second is sending a supplier a line with no quantity, which looks like an
// answer and is not one.
const T = await import("./.mat-build/materialTakeoff.js");
const M = await import("./.mat-build/materialOrders.js");
const { buildMaterialTakeoff } = T;
const {
  draftFromTakeoff, orderProblem, exclusionWarning, isEditable,
  transitionProblem, orderTotal, unpricedItems, describeStatus,
} = M;

let pass = 0, fail = 0;
const t = (n, c, d = "") => {
  c ? (pass++, console.log("  PASS " + n))
    : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));
};
const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
const at = () => ({ lat: 28, lng: -82.5 });

const plant = (id, size, cost) => ({
  kind: "point", polygon: [at()], color: "#0a0", area_sqft: 0,
  meta: { plant_product_id: id, name: "Holly", size, cost, unit_price: 40,
    install_minutes: 12, category: "shrub" },
});
const sodArea = (sqft, per = 450) => ({
  kind: "area", polygon: [at()], color: "#0f0", area_sqft: sqft,
  meta: { sod_product_id: "s1", name: "Floratam", grass_type: "st_augustine",
    sqft_per_pallet: per, cost_per_sqft: 0.35, price_per_sqft: 0.75,
    install_minutes_per_1000_sqft: 90, waste_pct: 0 },
});
const draftOf = (areas, components = []) =>
  draftFromTakeoff(buildMaterialTakeoff({ areas, components }));

console.log("[what goes on an order, and what is held back]");
{
  const d = draftOf([plant("p1", "3 gal", 9), sodArea(1000)]);
  t("orderable lines go on", d.lines.length === 2);
  t("nothing is excluded when nothing is wrong", d.excluded.length === 0);
  t("the total is the snapshot cost", near(d.total, 9 + 472.5), `got ${d.total}`);
  t("a complete draft can be ordered", orderProblem(d) === null);
  t("...and warns about nothing", exclusionWarning(d) === null);
}

console.log("\n[a line with no quantity never reaches a supplier]");
{
  // Sod with no pallet size: there is no count, and square feet are not a
  // thing a farm sells.
  const d = draftOf([plant("p1", "3 gal", 9), sodArea(1000, 0)]);
  t("THE UNORDERABLE LINE IS HELD BACK", d.lines.length === 1);
  t("...and kept, so the screen can say what was dropped", d.excluded.length === 1);
  t("...with the reason already on it",
    (d.excluded[0].note ?? "").toLowerCase().includes("pallet size"));
  t("the warning says it will be left off",
    (exclusionWarning(d) ?? "").includes("left off"));
  t("the rest of the order still stands", orderProblem(d) === null);
}

console.log("\n[an empty order is refused]");
{
  const empty = draftOf([]);
  t("nothing to order is refused", !!orderProblem(empty));
  t("...and says what to do", (orderProblem(empty) ?? "").includes("Place plants"));

  const allBad = draftOf([sodArea(1000, 0)]);
  t("EVERY LINE UNORDERABLE IS ALSO REFUSED", !!orderProblem(allBad));
  t("...with a different reason — these are broken, not absent",
    (orderProblem(allBad) ?? "").includes("missing something"));
}

console.log("\n[unpriced goes on the order — that is what a quote request is]");
{
  const d = draftOf([plant("p1", "3 gal", 0)]);
  t("an unpriced line is NOT excluded", d.lines.length === 1 && d.excluded.length === 0);
  t("...and the order is allowed", orderProblem(d) === null);
  t("...but the total leaves it out", d.total === 0 && d.unpricedCount === 1);
  t("...and the warning says the total is partial",
    (exclusionWarning(d) ?? "").includes("not the whole bill"));
}

console.log("\n[a placed order is frozen]");
{
  t("a draft is editable", isEditable({ status: "draft" }) === true);
  t("A PLACED ORDER IS NOT", isEditable({ status: "placed" }) === false);
  t("nor a received one", isEditable({ status: "received" }) === false);
  t("nor a canceled one", isEditable({ status: "canceled" }) === false);
}

console.log("\n[status transitions]");
{
  t("draft can be placed", transitionProblem("draft", "placed") === null);
  t("draft can be canceled", transitionProblem("draft", "canceled") === null);
  t("placed can be received", transitionProblem("placed", "received") === null);
  t("placed can still be canceled — orders get pulled",
    transitionProblem("placed", "canceled") === null);
  t("NOTHING GOES BACK TO DRAFT", !!transitionProblem("placed", "draft"));
  t("...and says to raise a new one instead",
    (transitionProblem("placed", "draft") ?? "").includes("raise a new one"));
  t("a received order is settled", !!transitionProblem("received", "placed"));
  t("a canceled order is settled", !!transitionProblem("canceled", "received"));
  t("draft cannot skip straight to received", !!transitionProblem("draft", "received"));
  t("staying put is not a transition", transitionProblem("placed", "placed") === null);
}

console.log("\n[the order totals from ITS OWN snapshots, never the catalogue]");
{
  const items = [
    { quantity: 3, unit_cost: 157.5 },
    { quantity: 12, unit_cost: 9 },
  ];
  t("total is quantity x snapshot cost", near(orderTotal(items), 472.5 + 108));
  t("a fractional quantity is not rounded away",
    near(orderTotal([{ quantity: 200.5, unit_cost: 0.42 }]), 84.21));
  t("an unpriced item is counted", unpricedItems([{ unit_cost: 0 }, { unit_cost: 5 }]) === 1);
  t("...and adds nothing to the total",
    near(orderTotal([{ quantity: 10, unit_cost: 0 }]), 0));
  t("an empty order totals zero, not NaN", orderTotal([]) === 0);
}

console.log("\n[status reads as a sentence, not a code]");
{
  t("draft says it is still yours", describeStatus("draft").includes("yours to change"));
  t("placed says the lines are frozen", describeStatus("placed").includes("frozen"));
  t("every status has words", ["draft", "placed", "received", "canceled"]
    .every((s) => describeStatus(s).length > 0));
}

console.log("");
console.log("[the supplier document - what it is, and what it must not become]");
{
  const { describeSupplierDoc, orderSharePath, sendProblem } = M;

  // Prices OFF is a REQUEST FOR A QUOTE. unit_cost is what the org expects to
  // pay and may have come from a different supplier; showing it unasked is how
  // a discount gets lost.
  const quote = describeSupplierDoc({ show_prices: false });
  t("with prices off it says it is NOT an order", quote.includes("not an order"));
  t("...and asks them to quote", quote.toLowerCase().includes("quote us"));

  const po = describeSupplierDoc({ show_prices: true });
  t("with prices on it says it IS an order", po.startsWith("This is an order"));
  t("...and invites a correction rather than asserting the price",
    po.toLowerCase().includes("wrong before you ship"));
  t("THE TWO DOCUMENTS DO NOT READ THE SAME", quote !== po);

  t("the share path is the token, nothing else",
    orderSharePath({ share_token: "abc-123" }) === "/o/abc-123");

  // An empty document is a puzzle, and the supplier only discovers it by
  // replying to ask what it is.
  t("AN EMPTY ORDER CANNOT BE SENT", !!sendProblem({ status: "draft" }, 0));
  t("...and says why", (sendProblem({ status: "draft" }, 0) || "").includes("no lines"));
  t("a draft with lines can be sent", sendProblem({ status: "draft" }, 3) === null);
  t("a placed order can be re-sent", sendProblem({ status: "placed" }, 3) === null);
  t("a CANCELED order cannot be sent", !!sendProblem({ status: "canceled" }, 3));
  t("...and says to raise a new one",
    (sendProblem({ status: "canceled" }, 3) || "").includes("Raise a new one"));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
