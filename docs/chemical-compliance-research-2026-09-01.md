# Chemical compliance — corrected research

**Written 2026-09-01 by Claude Opus 5. Supersedes the regulatory research and the
"what's NOT built" list in the earlier chemical-compliance handoff.**

Read this before designing anything. The previous handoff contained a wrong rule
citation, a wrong characterisation of Florida's notification model, and a roadmap
that lists eight already-shipped items as missing.

**This is engineering research, not legal advice.** Every operative claim below is
sourced. Where I could not reach a primary source I say so. Nothing here should be
turned into a UI that tells an operator they are compliant.

---

## 1. Corrections to the previous handoff

| Previous handoff said | Actually |
|---|---|
| Rule **5E-14.117** sets Florida's recordkeeping format | 5E-14.117 is *"Application for Department Credentials"* — the **licensing** rule. The notice rule is **5E-14.147**, under **§482.2265, F.S.** |
| Florida is **registry-based** for notification | Florida requires **physical sign posting**. No registry and no neighbour-notice provision appears in 5E-14.147 or §482.2265 |
| Posting duration "commonly 24 hours" | **5E-14.147 specifies no duration.** The 24-hour figure is not Florida's |
| Federal RUP records: private **and** commercial | USDA **rescinded** the private-applicator requirement effective **11 July 2025**. Commercial is unaffected |
| Items 3–10 are unbuilt | **Eight of ten are already built** — see §5 |

## 2. Private vs commercial — the term that keeps causing trouble

This is not about company size and does not map to our pricing tiers.

- **Private applicator** — a *farmer*: applies restricted-use pesticides to land
  they own or rent, to produce an agricultural commodity.
- **Commercial applicator** — applies pesticides **on someone else's property,
  for hire**. Any lawn-care business, at any size, on any plan tier.

**Every Terra Verde user who sprays a customer's yard is a commercial applicator**,
including a solo operator on Free. Consequently the July 2025 rescission — which is
private-only — almost certainly relieves none of them.

## 3. The distinction that actually drives the design

**Restricted-use (RUP) vs general-use.**

- Federal recordkeeping (7 CFR Part 110) applies to **restricted-use only**:
  2-year retention, brand/product name, EPA registration number, total quantity,
  location and size of area treated, target site, date.
- Most lawn products are **general-use** — no licence needed to buy them.
- **State law is frequently broader** and covers *all* pesticide applications by a
  commercial applicator, not just RUPs.

So for a large share of our users the federal rule never fires, while state rules
do. Our existing features are anchored on RUP; see §6.

## 4. Florida, verified

Florida is the researched target market. Two instruments matter.

### §482.2265, F.S. — "Consumer information; notice of application of pesticide"

Two distinct duties:

1. **On request**, before application, the licensee gives the customer the
   pesticide's common or brand name, the **common name of the active
   ingredient**, and safety information from the product label.
2. **Posting is mandatory** — see below. Not on request.

### Rule 5E-14.147, F.A.C. — "Notice of Pesticide Application"

> A notice shall be posted in a conspicuous location **at the time of application**
> of a pesticide **to a lawn or to exterior foliage**.

Sign specification:

| Attribute | Requirement |
|---|---|
| Size | **minimum 4″ × 5″** |
| Material | rigid, durable, **weatherproof** |
| Colour | background and lettering of **contrasting** colour |
| Content | **business name of the licensee** clearly set forth |
| Print/symbol | must conform to the department's example |
| May be part of a larger sign carrying more information | yes |

**Not present in the Florida rule:** any posting duration, any advance-notice
period, any neighbour notification, any registry, any exemption by product type.

**Scope is the headline.** Posting attaches to "a pesticide" applied "to a lawn or
to exterior foliage" — no carve-out for general-use products. It is a far broader
trigger than the federal RUP rule.

### Other states — in scope from day one

Florida is documented here in depth because it is the only state researched to
primary sources so far, **not because it is the target market. The market is the
whole USA.** Treat Florida below as a worked example of the *shape* of these rules,
not as the first milestone.

**New York** genuinely requires 48-hour advance notice to neighbours, adopted
county-by-county (nine counties plus NYC had opted in as of 2008 per NPIC).
**Connecticut** and **Iowa** have their own posting/prior-notice rules. The
previous handoff's "21–23 states" figure traces to a 2004 Beyond Pesticides
document; **it is not verified here and should not be built from.** NPIC itself
names only New York and directs readers to their state agency.

## 5. What is already built (verified against the DB and the code, 2026-09-01)

The previous roadmap's items 3–10 are largely shipped. There is a `/lawn/compliance`
page and an 896-line `ComplianceRecordsManager.tsx` the handoff does not mention.

| Item | Evidence |
|---|---|
| License expiry alerts | `api/lawn/cron/compliance-reminders` sweep A; `crew_members.applicator_license_category` exists |
| RUP purchase tracking | `rup_purchases` table, wired |
| Inventory | `chemical_products.quantity_on_hand` |
| CEU tracking | `applicator_ceu_records` |
| Sensitive sites | referenced in `app/lawn/new/page.tsx` |
| Supervision | `noncertified_applicator_training`, `chemical_applications.supervising_applicator_id` |
| Disposal records | `chemical_disposal_records` — own table, as specified |
| 30-day customer copy | `chemical_applications.shared_at`, cron sweep B nudges at 25 days |

**Genuinely absent** (searched: no table, no code):

- **Application-time posting / notice evidence** — nothing matches yard sign,
  neighbour, posting, or registry anywhere in `src/`.
- **State-configurable report format and retention** — no `state_code`, no
  `retention_years`, no format switch.

## 6. Competitive position — verified 2026-09-01

The previous handoff's competitive claims were checked against public sources. Three
of three were wrong, and the true picture is more favourable than it claimed.

| | Pricing | Chemical tracking |
|---|---|---|
| **Jobber** | $29 / $99 / $149 + **$29 per extra user** | **None at all** — no application records, no EPA logs, no licence tracking |
| **Yardbook** | Free tier; chemicals on **paid** Business $34.99 | Paid tier only, and **Android-only, no iOS** |
| **GorillaDesk** | $49 / $99 / $299 **per technician schedule** | Mature — product, EPA #, rate, area, date |
| **Service Autopilot** | $49 / $199 / $499 + **unpublished signup fee** | Mature — applicator logs **+ state compliance reporting** |
| **LawnPro** | $59–$129 | **Unverified** — sources gave pricing only |
| **Terra Verde** | $0–$199 **flat per org** | 8 of 10 items built; no notice evidence, no state report |

**Jobber has no chemical tracking whatsoever.** The previous handoff lists Jobber
among the competitors reviewed but never surfaces this. It is the largest name in
the category and cannot do lawn-treatment compliance at all — public reviews say you
would run a separate system alongside it. This is the single most useful competitive
fact in this document and the audit missed it.

**"Yardbook ships it free" was wrong** — chemical programs sit on the paid Business
plan, and Yardbook is Android-only, which excludes it for many operators anyway.

**The pricing claim was right but badly undersold.** "Beat or match the mid-market"
understates it: GorillaDesk bills *per technician schedule*, Jobber charges per-user
overages, Service Autopilot carries an unpublished signup fee on every plan. A
four-crew operation pays GorillaDesk roughly $196–$1,196/mo against our $199
ceiling. **Flat per-org is the strongest card we hold**, and it is strongest exactly
where compliance matters most — multi-crew operations spraying chemicals.

**The audit misidentified the gap.** Service Autopilot ships *state compliance
reporting*, not merely logging. That is the previous handoff's own item #2, which it
ranked below notification. So the live competitive hole is the **state-formatted
report a feature-peer already sells**, not the yard-sign posting nobody has.

*Caveat: these are review-site figures, not vendor pricing pages. Given the audit
was wrong on three of three checkable claims, confirm directly before setting tiers
against them.*

## 7. What this means for the build

**The posting trigger is not the RUP trigger.** Our compliance surface keys off
restricted-use — the 30-day sweep only chases RUP records. Florida posting fires on
**every** pesticide application to a lawn. Reusing the RUP predicate would miss most
applications that require a sign.

**The evidence half is small and universal; the rule half is where the country
varies.** Florida needs only posting — no registry, no neighbour notice — but New
York needs 48-hour advance notice to abutters and other states use a registry, so
all three modes are in scope nationally. What every one of them needs recorded is
nearly the same:

- a record that a notice happened — posted, sent, or registry-checked — at what
  time, by which licensed business, against which application, ideally with a photo
  as evidence;
- the on-request product disclosure (§482.2265 in Florida, with analogues
  elsewhere), which is **already in `chemical_products`** — brand name, active
  ingredient, and `active_ingredient_percent`.

Build that record once and it is correct everywhere. The per-state differences —
trigger, lead time, sign attributes, duration, recipients — belong in configuration
alongside it, not in branching code.

**Do not encode state statutes as application logic.** A screen that asserts "you
are compliant in Ohio" makes a legal claim on the operator's behalf; if a statute
moves and we are stale, we have manufactured liability rather than closed it. The
defensible shape is: **the operator configures the rule, the app proves what was
done.** State presets can follow later as clearly-labelled, operator-confirmable
defaults with citations — never as built-in truth.

## 8. Confidence and gaps

**Verified against a primary or near-primary source:** the 5E-14.147 sign
specification and posting trigger; §482.2265's on-request disclosure; the scope and
11 July 2025 effective date of the USDA rescission; the federal RUP data elements
and 2-year retention.

**Not verified — do not build on these yet:**

- The **sign example image** referenced by 5E-14.147 for print and symbol
  conformity. I could not view it. **Required before generating printable signs.**
- I read 5E-14.147 via Cornell LII and a statute mirror, **not FDACS's own current
  publication.** Confirm against FDACS before shipping.
- Whether Florida sets a posting **duration** anywhere outside 5E-14.147.
- The multi-state list. Treat the 2004 figure as a research lead only.
- Whether an **expired licence should block logging** — still an open product
  decision from the original handoff, untouched here.

## 9. Suggested sequence

**The market is the whole USA, not Florida.** An earlier draft of this section
sequenced Florida first and deferred multi-state; that was wrong, and it was wrong
because it inherited the previous handoff's assumption about the target market
rather than checking it. All three notification models are live somewhere in the
country on day one.

What the Florida work still buys us is the **shape**, which generalises even though
its numbers do not. Across states the *evidence* is close to identical — a notice
happened, at what time, by whom, against which application, in what form. Nearly
all the variation lives in the **rule**: what triggers it, how far in advance, what
the sign must look like, how long it stays up, who must be told. Split on that seam:

**The competitive check in §6 inverts the previous handoff's priority order.**
Notification/posting was its #1; no competitor ships it, which makes it speculative
differentiation, and it is the most expensive and most liability-laden item on the
list. Meanwhile Service Autopilot already sells **state compliance reporting** — the
handoff's #2 — so that is where a peer is actively beating us, and the data for it
is already captured.

1. **State-configurable retention and report format.** The live competitive gap.
   Replaces hardcoded federal defaults (2 vs 3 years, field variations). The
   underlying records already exist, so this is largely an export and configuration
   problem, not a data-capture one.
2. **One universal notice-evidence record.** State-agnostic, so it is correct in all
   fifty. Cheap, and it closes a real hole — today an application cannot record that
   a notice was given at all.
3. **Per-org rule configuration** covering the three real modes — posting, advance
   neighbour notice, registry check — plus lead time, sign attributes and duration
   as data. Seed with per-state templates the operator **confirms**, presented as a
   starting point with citations, never as the app asserting that state's law.
4. Per-state research, **as customers appear in each state**, not up front. Fifty
   states to the standard of §4 is on the order of 25–50 hours, never finishes
   because statutes change, and is normally compliance-professional work. One state
   at a time, prompted by revenue, is an hour each.

Ordering (1) before (2) matters: the evidence table is the half we can get right
without being a fifty-state authority, and it is what an inspector actually asks
for. A rules engine with nothing recorded against it proves nothing.

At national scale, encoding statutes as application logic is not the cautious-versus-
bold trade-off it looks like in one state — it is a maintenance liability that grows
with every state sold into, and each stale entry is a false assurance given to an
operator who is relying on it.

## Sources

- Fla. Admin. Code R. 5E-14.147 — https://www.law.cornell.edu/regulations/florida/Fla-Admin-Code-Ann-R-5E-14-147
- Fla. Stat. §482.2265 — https://www.flsenate.gov/Laws/Statutes/2023/482.2265
- NPIC, pesticide neighbour notification — https://npic.orst.edu/reg/notification.html
- USDA rescission explainer, Illinois Extension — https://extension.illinois.edu/blogs/pesticide-news/2025-05-29-usda-rescinds-federal-restricted-use-pesticide-recordkeeping
- USDA AMS, understanding federal pesticide recordkeeping — https://www.ams.usda.gov/rules-regulations/pesticide-records/understanding
- Federal Register, rescission notice — https://www.federalregister.gov/documents/2025/05/12/2025-08220/rescission-of-recordkeeping-on-restricted-use-pesticides-by-certified-applications
