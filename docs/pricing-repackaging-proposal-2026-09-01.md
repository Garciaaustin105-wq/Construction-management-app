# Lawn tier repackaging — proposal

**Written 2026-09-01 by Claude Opus 5. A PROPOSAL against `src/lib/plans.ts`.
Nothing here is applied.**

---

## RESOLVED 2026-09-01 — the alarm below was a false alarm

**Checked against `route_optimizations_log`: 10 calls ever, since 2026-08-23.**
Nine from `Terra Verde Test Co` (our own sandbox), **one** from `Peanutz L&L` — our
only real customer — on 2026-08-27, never repeated. Worst case ~$31 in total, ever,
assuming every call maxed the 25-point matrix.

**What this supports, and only this: we are not currently being billed much.** That
is a fact about our own spend today. It is **not** evidence about demand, and it
must not be read as any of the following, all of which would rest on a single real
customer who used the feature once:

- ~~"Route optimization is an unused feature"~~ — n=1. Unknowable from this.
- ~~"The blocker is missing map pins"~~ — Peanutz has 5 lawn properties with 2
  pinned, which is a plausible *hypothesis* for a single non-return. It is not a
  finding. They may equally have found it fine and not needed it again, or never
  seen the control.

**The caps below therefore become MORE important, not less.** With one customer we
have no idea what usage looks like at fifty. Leaving four tiers uncapped is a bet
that future customers behave like the only one we have. Bounding worst-case exposure
is exactly what you do when you cannot forecast — **cap before scaling, not after.**

**The wider constraint on this whole document:** with n=1, no pricing decision can be
validated against usage. Everything here must stand on evidence that does not need
it — structural inspection (Starter's job limit is identical to Free, broken on its
face), competitor benchmarks, and bounded cost models. Any argument of the form
"customers do/don't use X" is out of scope until there are customers to observe.

The per-call cost model below is sound and is the right one to re-apply once real
usage exists.

---

## Original analysis (arithmetic sound, premise wrong)

Route optimization calls **Google Distance Matrix**, a metered per-element API
(`src/app/api/lawn/route-optimize/route.ts:154`), capped at **2–25 points per call**.
A 25-point call is a 25×25 matrix = **625 billable elements**.

At Google's list rate as I recall it (~$5 per 1,000 elements) that is **~$3.13 per
optimization**. If that rate is right, then:

| Tier | Price | Cost of ONE optimization/day for a month |
|---|---|---|
| Free | $0 | ~$94 |
| Starter | $29 | ~$94 |
| Growth | $69 | ~$94 |

**Route optimization would be unprofitable on the bottom three tiers at one use per
day** — and it is currently **unlimited on all four paid tiers**, and 5/day on Free.

I could not find a cap I was happy with. Every cap generous enough to be useful
still exceeds the tier's revenue. That is not a packaging problem and repackaging
will not fix it.

**So the first action is not to pick caps — it is to look at the actual Google bill.**
Three outcomes:

1. **My rate is wrong / usage is far lower than worst case** → the caps below are
   fine as cheap insurance.
2. **The rate is right and usage is real** → route optimization needs to be a
   metered add-on, a Pro-and-up feature, or moved to a cheaper routing approach.
   Distance Matrix is the most expensive way to do this.
3. **Nobody uses it** → cap it hard and stop thinking about it.

Everything below the "cost" section is confident. The route-opt caps are *interim
bounding*, not a recommendation to keep the feature as priced.

---

## Proposed limits

Current → proposed. Unchanged rows omitted.

```diff
 free: {
   priceMonthly: 0,
   maxJobs: 25,
-  maxRouteOptsPerDay: 5,
+  maxRouteOptsPerDay: 1,          // interim: bound worst-case Google spend on a $0 tier
 },

 starter: {
   priceMonthly: 29,
-  maxJobs: 25,                    // BROKEN: identical to free — no reason to upgrade
+  maxJobs: 75,
-  maxRouteOptsPerDay: null,       // unlimited calls to a metered API on a $29 plan
+  maxRouteOptsPerDay: 5,
   maxStorageBytes: 5 * GB,
 },

 growth: {
   priceMonthly: 69,
-  maxJobs: 65,
+  maxJobs: 200,
-  maxRouteOptsPerDay: null,
+  maxRouteOptsPerDay: 15,
 },

 pro: {
   priceMonthly: 149,
-  maxJobs: 150,
+  maxJobs: 600,
-  maxRouteOptsPerDay: null,
+  maxRouteOptsPerDay: 40,
-  maxStorageBytes: 75 * GB,
+  maxStorageBytes: 50 * GB,       // make room for Business to mean something
 },

 enterprise: {                      // label "Business"
   priceMonthly: 199,
-  maxJobs: 500,
+  maxJobs: null,                   // unlimited, matching its unlimited crew/customers
-  maxRouteOptsPerDay: null,
+  maxRouteOptsPerDay: 100,
   maxStorageBytes: 75 * GB,        // now 1.5x Pro rather than identical
 },
```

**Why the jobs ladder moves this much.** A job is a *property* — the unit a lawn
business grows in. Free 25 → Starter 25 means the binding constraint does not move
at the most important conversion step: an operator with 30 properties gets nothing
for $29 and either jumps to $69 or leaves. The proposed 25 / 75 / 200 / 600 / ∞ is a
clean ladder where each step buys roughly 3x the business.

**Storage.** Pro and Business are both 75 GB today — $50 more for zero additional
storage. Dropping Pro to 50 GB is the cheaper fix than raising Business, since
storage is real cost.

## Proposed feature gates (new fields)

`plans.ts` currently has no feature booleans — every tier gets every feature, only
quantities differ. The principle: **wall what costs nothing marginal; meter what
costs per use.**

```diff
 export type PlanConfig = {
   ...
+  /** State-formatted compliance export. Zero marginal cost; high perceived value;
+   *  the thing Service Autopilot actively beats us with. */
+  stateComplianceReport: boolean;
+  /** Photo library browse + bulk download. Orgs use these to advertise. */
+  photoLibraryDownload: boolean;
+  /** Live crew GPS. Realtime broadcast + Active CPU — a genuine cost driver. */
+  crewGpsTracking: boolean;
 };
```

| Feature | Free | Starter | Growth | Pro | Business |
|---|---|---|---|---|---|
| Chemical application logging | ✅ | ✅ | ✅ | ✅ | ✅ |
| **State compliance report/export** | — | — | ✅ | ✅ | ✅ |
| **Photo library + bulk download** | — | ✅ | ✅ | ✅ | ✅ |
| **Live crew GPS** | — | — | ✅ | ✅ | ✅ |
| AI actions | 0 | 0 | 25 | 100 | 5000 |

**Chemical logging stays available on every tier, deliberately.** Competitors do
gate it, so walling it would be commercially defensible — but if a Starter operator
sprays and cannot record it because of a billing tier, our paywall has become a
factor in their non-compliance. Gate the **report and export**, not the record. Same
revenue, and the record always exists.

**Crew GPS is the one gate that is also a cost control.** It is a differentiator per
the competitive audit *and* it drives Realtime broadcast and Vercel Active CPU,
which is the binding resource on our Vercel plan. Worth confirming whether it is
currently ungated — if so it is the second margin hole after route optimization.

**AI needs no change.** Haiku 4.5 at 5,000 actions runs ~$20–25/month — about 11% of
the Business tier. It is the one metered feature already priced sensibly.

## What this does NOT change

**Flat per-org billing stays.** It is the sharpest advantage we have: GorillaDesk
bills per technician schedule ($49/$99/$299 each), Jobber charges $29 per user over
plan limits, Service Autopilot adds an unpublished signup fee. A four-crew shop pays
us $199 against their $196–$1,196. Feature-gating a few high-value surfaces is fine;
Swiss-cheesing the product would destroy the "simple, no surprises" story that makes
flat pricing worth choosing.

## Open questions before this ships

1. **The Google bill.** See the top of this document. This gates the whole
   route-optimization decision and possibly the feature's viability as priced.
2. **Is crew GPS currently ungated?** Not verified.
3. **Grandfathering.** Free drops from 5 route opts/day to 1. Existing free orgs
   will feel that. Starter/Growth/Pro all *gain* jobs, so those are safe.
4. **Do the new gates need DB enforcement?** `maxAiActionsPerMonth` and
   `maxRouteOptsPerDay` are mirrored in SQL (`ai_action_max()`, `route_opt_max()`)
   so app and DB agree. Any gate that guards a paid resource should follow that
   pattern rather than living in the client only.
5. Competitor figures come from review sites, not vendor pricing pages. The prior
   audit was wrong on three of three checkable claims — confirm before pricing
   against them.
