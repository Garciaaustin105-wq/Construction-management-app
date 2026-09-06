# How landscape labor is actually priced — and what this app should do about it

Research pass, 2026-09-05. Question asked: how do contractors price sod labor,
planting labor and the other labor components, and what should the estimator
seed?

---

## The headline finding

**The industry is moving away from unit pricing and toward production hours,
and the app already sits on the right side of that line.**

The clearest statement of it comes from a contractor who ran their whole
operation on unit pricing — X per square foot for pavers, walls, concrete,
grass, grading — and abandoned it. Their account: unit pricing held up while
they were personally on site, and profitability collapsed once a foreman ran
the crew without set production goals. They moved to estimating entirely on
hours.

That is the same conclusion the plant catalogue reached from the other
direction: **man-minutes per unit, never a percentage of material cost.** On a
large tree the plant is cheap relative to the crew and machine needed to set
it, so %-of-cost labor breaks down exactly where the money is.

So the model is right. What follows is what to put in it.

---

## 1. The numbers that came back

Every figure below is a published production rate or a stated labor-hour range.
Where a figure had to be derived from a price, it says so — those are weaker.

### Sod

| Condition | Rate | Per 1000 sqft |
|---|---|---|
| Best case, short carry (800 sqft barrowed 30 ft) | 275 sqft/man-hr | 218 man-min |
| Flat, accessible 1000 sqft lawn | 6–8 man-hr | 360–480 man-min |
| Irregular shape or difficult soil | 10–12 man-hr | 600–720 man-min |
| Worst case cited (750 sqft carried up 20 flights) | 100 sqft/man-hr | 600 man-min |

Nearly a **3x spread**, and it tracks **carry distance and access**, not grass
type. Seeded at **420 man-min per 1000 sqft** (~143 sqft/man-hr), the middle of
the accessible band.

Blended $/sqft figures also exist — labor $0.35–1.00/sqft, installed
$1.70–2.60/sqft — but those bundle labor, overhead and margin. They are useful
as a sanity check on a finished quote and useless as an input.

### Planting

| Item | Rate | Per plant |
|---|---|---|
| Shrubs | 5 per man-hour | 12 man-min |
| Small pots (2.5 L), 2 people, post-hole digger | 100+/hr for 2 | ~1.2 man-min |
| 18 in B&B tree, 2 hand-digging, medium soil | 8.5/day | ~113 man-min |
| 18 in B&B tree, 3 with a 48 HP excavator | 19/day | ~76 man-min |
| Tree into pre-excavated hole, trained crew | 1 man-hr + 0.5 machine-hr | 60 man-min |

**This independently validates the plant seed.** The catalogue carries 12 min
for a 1-gal shrub against a found figure of 12, and 120 min for a 2 in caliper
B&B tree against a found 113 hand-dug / 76 with a machine. The seeded numbers
sit at the conservative hand-dig end of the published range, which is the right
place for a default.

Note the machine effect: **the same tree is 113 man-minutes by hand and 76 with
an excavator.** That is a 33% swing from equipment alone, which is an argument
for tying the equipment lines and the labor lines together rather than
estimating them independently.

### Trenching

| Method | Rate | Per foot |
|---|---|---|
| Hand dug | ~10 ft/hr | 6 man-min |
| Machine trencher, pass only | ~300 ft/hr | 0.2 man-min |

Prices, for cross-check: irrigation-specific trenching $1.54–2.41/LF; general
residential $5–12/LF; difficult (rock, depth, utilities) $13–40/LF; landscapers
charging $50–100/hr for trenching work.

Seeded per foot: **machine 2, hand 6, vibratory plow 1, boring 8, restoration
2.** Hand-dig comes straight off the 10 ft/hr figure. The others are derived —
the 300 ft/hr machine figure is the cutting pass only, and spoil handling,
backfill and cleanup are the rest of the job. At $75/man-hr the machine figure
prices to ~$2.50/ft, just above the irrigation-specific band and well under the
general one, which is the right neighbourhood.

### Other labor components

| Task | Rate | Notes |
|---|---|---|
| Mulch, open accessible beds | 1.5–2.5 cu yd/man-hr | 24–40 man-min/yd |
| Mulch, obstacles or long carry | 1.0–1.5 cu yd/man-hr | 40–60 man-min/yd |
| Fertilizer, push spreader | 43,000 sqft/hr | product cost excluded |
| Bed re-edging | $1.50–3.50/LF | price, no rate published |
| Hand weeding before mulch | $40–70/hr | price, no rate published |

### Billing rates, 2026

$65–145 per man-hour. Install-plus-maintenance companies $75–100; lean
startups $65–75; high-end design/build with serious equipment $100–145. Sod
crews are quoted lower, $35–75 per worker-hour, which likely reflects
cost-side or lower-end market rates rather than a billing rate.

---

## 2. The caveat every source repeats

> Do not borrow production rates. Time your own next three installs and log
> mulch, sod, planting and edging **separately**.

With a supporting figure worth keeping: a **20% underestimate on labor hours
turns a $30,000 annual contract from profitable to break-even.**

This is the single most important finding for the product, and it points at a
feature rather than a seed value. **The app already collects crew time entries.
Nothing currently feeds them back to the catalogue.** An org running a hundred
jobs is sitting on better production rates than any published table, and cannot
see them.

That is the gap worth building next: a screen that reads back actual
man-minutes per unit from completed jobs and offers to update the catalogue
figure. Seeded numbers get an org started; their own numbers are the product.

---

## 3. Where the app's labor model currently stands

Three different labor units, all correct for their domain:

| Catalogue | Unit | State |
|---|---|---|
| Plants | `install_minutes` per size | **Seeded**, 690 sizes, validated above |
| Sod | `install_minutes_per_1000_sqft` | **Seeded** this pass, 11 products |
| Irrigation components | `install_minutes` per each/foot | **Zero** — see below |
| Irrigation trenching | `install_minutes` per foot | **Seeded** this pass, 5 rows |

### Why the 68 irrigation parts stay at zero

No per-part labor table exists in the open literature. The search returns
consumer cost guides, repair-call times, and all-in figures. The one solid
industry rule of thumb is **roughly one man per zone per 10-hour day** for
residential new install — which covers trenching, pipe, heads, valve and wire
*together*.

Splitting that across 68 rows by guesswork would produce numbers that look
sourced and are not, and they would double-count against head install minutes
the moment those get filled in. Trenching is the exception precisely because
its production rate is published directly rather than buried in a blended
total.

### What has no home at all

Mulch, edging, bed prep, grading, haul-off and disposal have **no labor line
anywhere in the app**. The rates above exist and are usable; the table to put
them in does not. Mulch is per cubic yard, edging is per linear foot, bed prep
is per square foot — three more units on top of the three already in use.

Recommendation: **one `labor_items` table** with a unit enum and man-minutes
per unit, rather than a fourth bespoke catalogue. The component contract
already proves the shape works — `unit` on the row, `basis` naming it on every
charge, per-unit money on the line item. Not built; flagged.

---

## 4. What this pass changed

- `sod_products.sqft_per_pallet` 0 → 450 on all 11 products. **This was a
  defect, not a gap**: pallet count is sqft ÷ sqft_per_pallet, so zero produced
  no estimate rather than a cautious one. The sod calculator did not work.
- `sod_products.install_minutes_per_1000_sqft` 0 → 420.
- Five per-linear-foot trenching rows, labor only, with man-minutes.
- New `trenching` component category.

Both sod updates touch only rows still at 0, so an org that has tuned its own
figures keeps them.

---

## Sources

Fetched 2026-09-05.

- [LawnSite — sod install, pallets/sqft per day](https://www.lawnsite.com/threads/sod-install-how-many-pallets-sq-feet-a-day.520353/)
- [LawnSite — sod installation prep, install, man-hour help](https://www.lawnsite.com/threads/sod-installation-prep-install-man-hour-help.333986/)
- [LawnSite — estimating labor, large tree planting](https://www.lawnsite.com/threads/estimating-labor-large-tree-planting.517756/)
- [LawnSite — production rates](https://www.lawnsite.com/threads/production-rates.486287/)
- [Landscape Juice Network — planting shrubs, how many per hour](https://landscapejuicenetwork.com/forum/topics/planting-shrubs-how-many-per-hour)
- [ContractorTalk — trenching production rates](https://www.contractortalk.com/threads/trenching-production-what-is-average-rate.60762/)
- [SynkedUP — landscaping cost per hour, 2026 rates](https://synkedup.com/landscaping-cost-per-hour/)
- [SiteRecon — landscaping production rates guide](https://order.siterecon.ai/landscaping-templates/landscaping-production-rates-guide)
- [DoorstepHQ — what to charge for mulch installation](https://doorstephq.com/blog/what-to-charge-for-mulch-installation)
- [Sod Solutions — square feet per pallet](https://sodsolutions.com/lawn-101/square-feet-per-pallet/)
- [The Grass Outlet — how big is a pallet of sod](https://thegrassoutlet.com/how-big-is-a-pallet-of-sod/)
- [HomeGuide — sod installation cost](https://homeguide.com/costs/sod-installation-cost)
- [HomeGuide — trenching cost](https://homeguide.com/costs/trenching-cost)
- [Homewyse — cost to trench for irrigation line](https://www.homewyse.com/services/cost_to_trench_for_irrigation_line.html)
- [Angi — sod installation cost](https://www.angi.com/articles/how-much-does-it-cost-lay-sod.htm)
