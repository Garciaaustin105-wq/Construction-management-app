# Competitive audit — the lawn estimator, 2026-09-06

**Question:** now that the estimator is extensive, where do we actually stand?

**Short answer:** the estimator moved us out of the market we were competing in.
Against Jobber and Housecall Pro we were one more field-service CRM with a
pricing story. Against LMN and Aspire we are now a **cheaper, narrower tool that
does one thing none of them do** — and we are missing two things all of them
have.

---

## 0. What this audit is and is not

Sourced from web research (Sept 2026), the repo's own research
(`voice-of-customer-deep-dive-2026-08-17.md`,
`pricing-repackaging-proposal-2026-09-01.md`), and the code at `0f93fa7`.

**We have one real customer.** Nothing here is inferred from usage — there is no
usage to infer from. Every judgement is structural: what the code does, what
rivals charge, what their users complain about.

**"Built" is not "proven."** Most of what follows shipped in the last two weeks
and has been exercised by harnesses, not by crews. Read every claim below as
*"the software does this"*, never as *"this works in the field"*.

---

## 1. There are four markets here, not one

The estimator work pushed us across boundaries that the incumbents keep separate.
That is the whole story of this audit.

| Market | Who owns it | What it costs | Are we in it? |
|---|---|---|---|
| Field-service ops (scheduling, invoicing, CRM) | Jobber, Housecall Pro, Service Autopilot, RealGreen | Jobber Connect/Grow **$349–$599/mo** at 6 crews | Yes, since the beginning |
| Landscape estimating + job costing | **LMN, Aspire**, SingleOps | LMN **$297–$697/mo**; Aspire aimed at $2M+ revenue | **Yes — this is new** |
| Property measurement / takeoff | SiteRecon, PropertyIntel (ex-Go iLawn), Go iLawn | **$39–$500/mo on top** of the above | **Yes — and we do not charge for it** |
| Irrigation design | Land F/X, Pro Contractor Studio, CAD-based tools | Perpetual/CAD licensing, 4–6 weeks to learn | **Partly, and deliberately not fully** |

A landscape contractor who wants what our estimator now does buys **two or three
of those products**. Our top tier is **$199 flat per org**, unlimited users.

---

## 2. Where we are genuinely ahead

### 2.1 The feedback loop. This is the one nobody else has.

Every serious rival does job costing: the estimate becomes a budget, actuals are
tracked against it, variance is reported. LMN and Aspire both lead on this.

**Then they stop.** The documented workflow across the industry is:

> track crew time → capture actual costs → compare to estimates → *identify
> patterns manually* → *manually update production rates* for future bids.

The research turned up **no competitor that closes that loop in software**.
Refining production rates is homework the contractor does, in a spreadsheet,
if they ever get to it.

We close it. `/lawn/labor-feedback` reads clocked time back against what was
quoted and **proposes a specific rate for a specific catalogue row**, with:

- the sample size (nothing proposed below 3 jobs),
- the spread (nothing proposed above a 3x range — "these were not the same job"),
- direct vs proportional attribution, never blended,
- medians, never means,
- and a one-row Apply. **There is deliberately no bulk endpoint.**

As of today it covers labor items, components, plants, sod **and heads**.

That is the defensible thing in this product. It is not a feature rivals lack
because they never thought of it — it is one they cannot bolt on without the
per-row rate catalogue and the snapshot discipline underneath it.

**Caveat, and it is a big one:** the loop needs 3+ comparable jobs per row before
it says anything. With one customer it has said nothing yet. It is unproven, not
disproven.

### 2.2 Measurement is included, not a second subscription

SiteRecon starts at **$39/user/mo** and runs to **$500/mo**; PropertyIntel is
**$199–$499/mo** with no CRM. Aerial measurement is a *product* in this market.

We measure on the map inside the estimate — polygons, planar geometry, no extra
vendor, no per-property fee.

**And we take field data the aerial services structurally cannot get.** The site
importer ingests Moasure / GNSS rover / surveyor CSV with two-point anchoring for
local coordinate frames. Satellite AI cannot see under a tree canopy, cannot give
you elevation, and cannot measure what is not yet built. That is a real edge on
renovation and grading work, and nobody in the field-service tier has it.

*Note:* sources disagree on whether LMN measures natively — one 2026 comparison
credits it with "built-in digital takeoffs from aerial images," another states
the platform "does not measure properties from aerial imagery natively" and
partners with SiteRecon. Both are recorded; neither is averaged. **Worth
resolving before any sales copy leans on it.**

### 2.3 Irrigation heads on a satellite map, not in CAD

Irrigation design today lives in CAD-adjacent tools — Land F/X, Pro Contractor
Studio, AutoCAD overlays — which the trade press says take **four to six weeks of
daily practice** to become fluent in. They are design tools that also quote.

We place heads on the property map with real coverage arcs from a real nozzle
catalogue (20 models, 145 nozzles, throw distances from manufacturer charts), and
the heads price and time themselves. No CAD, no learning curve.

### 2.4 Nothing in the takeoff tier knows what a plant is

Dedicated takeoff software — PlanSwift ($2,000/yr), STACK ($249+/user/mo),
Bluebeam, Buildxact — is **plan-based**: you trace blueprints. A 2026 comparison
of them concludes that **none include built-in plant material, irrigation, or sod
libraries**, and that most residential landscapers do not need them at all.

We carry 223 species / 690 sizes, 11 sod products with pallet math, 73 irrigation
components, 40 labor lines, 18 machines — priced per org, measured off the map.

### 2.5 Pricing structure (unchanged, still the sharpest edge)

Flat per-org, unlimited users, published, month-to-month. Against LMN's
module-based licensing, Jobber's per-user overage, Aspire's opacity, and
RealGreen's annual lock-in — whose users describe it as *"the Comcast of field
service software."* A four-crew shop pays us **$199** against **$196–$1,196**.

---

## 3. Where we are behind, honestly

### 3.1 No purchasing. This is the biggest functional gap.

There is **no purchase order, no material ordering, no vendor** anywhere in the
codebase. Aspire's entire pitch is estimate → job → **purchasing** → job costing
as one chain. We produce a quantity take-off and then drop it: the contractor
retypes the plant list into an order.

For a design/build contractor that is a daily irritation, and it is the first
thing an Aspire evaluator will ask about.

### 3.2 We refuse the hydraulics. That is correct, and it still costs us deals.

Irrigation design tools compute friction loss, working pressure, and zone sizing.
We deliberately do not: **zone sizing, spacing and pressure loss are licensed
engineering** (build rule 12). We count what a professional specified; we do not
specify.

That is the right call and it should not change. But be clear-eyed: an irrigation
contractor comparing us to Pro Contractor Studio will find a real hole, and
"we won't guess at something that could be wrong" is a harder sell than a number.

### 3.3 The rate catalogue starts empty on purpose

We seed names, categories and units — never prices or labor rates. LMN ships
labor-burden calculation and Aspire ships production-rate kits; both give a new
customer something to price with on day one.

A new org opens our catalogue and every rate is blank. That is the honest design
(a wrong rate that looks confident is worse than a blank one, and the research is
shown beside the field as a suggestion) but it is a **real onboarding cliff** and
the competitor demo will feel more finished.

### 3.4 Depth vs. an incumbent's decade

Aspire has kits of unlimited complexity, multi-branch, snow, purchasing, and a
finance team's reporting. LMN has labor burden and a training ecosystem. We have
a good two weeks of estimator. Against a $2M+ commercial operation we are not in
the running, and should not pretend to be.

### 3.5 The loudest unmet needs in the market are still unbuilt

From our own voice-of-customer research, the things Jobber users beg for — bulk
**seasonal pause/restart**, **skip-visit**, bulk scheduling, text-photos-to-client
— are still on the list. The estimator work was deeper, but it was not what the
market was shouting about.

---

## 4. Who we actually beat, and where

| Rival | Verdict |
|---|---|
| **Jobber** | We win outright on estimating depth — it has no production-rate estimating or true job costing. It wins on maturity, integrations and mobile polish. |
| **Housecall Pro / RealGreen** | Not estimating competitors at all. We win on structure and on their own users' complaints (billing, lock-in, support). |
| **SingleOps** | Arborist-first. Different buyer; little overlap. |
| **LMN** | The closest real fight. They win on labor burden, training, and being a known quantity. We win on price, included measurement, irrigation heads, and the feedback loop. |
| **Aspire** | Lose on depth and purchasing; not our buyer below $1M revenue — where reviewers say Aspire is the wrong tool anyway. **That is our lane.** |
| **SiteRecon / PropertyIntel** | We do not beat their measurement AI. We make buying it optional, and we take field data they cannot. |
| **Land F/X / Pro Contractor Studio** | Lose on design and hydraulics. Win on not being CAD. |

---

## 5. What this means

**Stop selling as a field-service CRM.** That fight is against mature products on
their turf. The estimator is the reason to switch.

**The pitch that is actually true:** *"Measure the property, place the plants and
the heads, price it from your own catalogue — and then have the software tell you
what your crews actually take, and offer to correct the rate. LMN and Aspire make
you work that out yourself. Jobber cannot estimate this at all. And you are not
paying SiteRecon on top."*

**The two gaps to close, in order:**

1. **Purchasing** — estimate → material order. The quantities are already
   computed; not emitting an order is leaving the chain broken one link from the
   end. Biggest functional gap and the most mechanical to close.
2. **The onboarding cliff** — a new org faces a catalogue of blank rates. Not by
   seeding values (that rule stands), but by making the first-run path through
   entering them short and obvious.

**Do not close #3.2.** Refusing to compute hydraulics is a liability decision, not
a feature gap.

**Before any of that:** the feedback loop is the differentiator and it has never
run on real data. Getting one real contractor to 3+ comparable jobs on one
catalogue row is worth more than any feature on this page — it is the difference
between a claim and a demo.

---

## Sources

Web, Sept 2026:
[GreenMargins takeoff comparison](https://greenmargins.com/blog/best-landscape-takeoff-software) ·
[LMN estimating (Granum)](https://granum.com/lmn/estimating/) ·
[LMN vs Jobber](https://granum.com/lmn-vs-jobber/) ·
[Jobber vs LMN pricing](https://fieldservicesoftware.io/comparisons/jobber-vs-lmn/) ·
[Aspire estimating](https://www.youraspire.com/features/estimating) ·
[Landscape software comparison](https://gettinylawn.com/blog/landscape-business-software-comparison-jobber-aspire-lmn-singleops/) ·
[SynkedUP on production rates](https://synkedup.com/landscape-estimating-software/) ·
[SiteRecon pricing (Capterra)](https://www.capterra.com/p/276749/SiteRecon/) ·
[Satellite measuring software 2026](https://servicebusinessacademy.org/best-satellite-measuring-software-landscaping-2026/) ·
[Irrigation design software (Turf)](https://turfmagazine.com/irrigation-design-software/) ·
[Pro Contractor Studio](https://www.softwarerepublic.com/)

In-repo: `voice-of-customer-deep-dive-2026-08-17.md`,
`pricing-repackaging-proposal-2026-09-01.md`,
`handoff/handoff-ui-state-of-play.md`.
