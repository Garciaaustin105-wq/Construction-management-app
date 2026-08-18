# Pricing & Profitability Deep-Dive — Terra Vista (Aug 2026)

## Executive Summary
**We are profit-healthy at every tier and competitively well-positioned.** Marginal backend cost per tenant is ~$0.75/mo (Supabase rows + Vercel bandwidth/functions + Resend email + Google Maps, mostly covered by free tiers at low volume); the **only material per-tenant cost is Stripe's 2.9% + $0.30 on our own subscription billing (~3–4% of revenue)**. Net margin per active (non-trial) tenant is **~94–97%** across all six tiers. Our pricing undercuts Buildertrend ($339–829, now unpublished/volume-quoted) at every comparable tier, matches or undercuts Jobber/Housecall Pro on lawn, and — critically — our **flat org pricing (not per-user) beats JobTread/Jobber/Housecall/Fieldwire/PlanRadar once a crew exceeds ~3–5 users**, where their per-seat/user-cap ladders get expensive fast. The one real risk isn't margin per active tenant — it's **30-day free-trial cost** ($0 revenue while we bear ~$0.75/mo infra), which only matters at scale and is capped by trial dim-limits + a dormant-org cleanup cron. Recommendations: keep the tiers, add annual billing (locks revenue + cuts churn + lowers effective Stripe cost), enforce trial hygiene, ship POs/Bills to hold the $49 tier against Foreman Basic, and guard the "seats" tier dimension so it counts app-login users (office/PM) — not scheduling-only `crew_members` — or we lose the flat-pricing wedge.

> **Methodology:** construction and lawn competitor pricing are kept in separate sections (different markets, different rivals). The backend-cost and margin sections are shared (one Supabase project, one Vercel account serve both variants) and applied per-variant.

---

## 1. Construction Competitor Pricing

### Buildertrend (mid/residential; no published 2026 pricing — volume-quoted via an 11-bracket annual-volume form)
Estimated from third-party aggregators; unlimited users + unlimited projects on all tiers:

| Tier | Annual (mo. equiv.) | Monthly | What's included | The catch |
|---|---|---|---|---|
| Essential | ~$339/mo | ~$499/mo | Schedules (Gantt+calendar), daily logs (+weather), client portal, cloud files, mobile time tracking, basic CRM, basic invoicing, QB/Xero/Home Depot integrations | **No estimating module** — can't sell jobs/proposals at this tier |
| Advanced | ~$499/mo | ~$799/mo | + full estimating: proposals, change orders, takeoff, bid requests, purchase orders, budget-vs-actual, vendor POs | This is the realistic "we sell jobs" tier |
| Complete | ~$829/mo | ~$1,099/mo | + **Selections** (homeowner finish/material portal, G/B/B tiers, allowance tracking, approval workflow), warranty mgmt, RFIs, advanced dashboards | Selections is BT's signature moat for custom-home builders |

- Payment processing ~2.99% (cards). Onboarding (Boost) free on annual, ~$100/mo on month-to-month. **Documented renewal hikes of 50–75%** are a recurring complaint. AI Client Updates (Jun 2025) + AI Bill Pay (IBS Feb 2026) shipped.

### Contractor Foreman (our direct price rival; published, company-level w/ user caps, 30-day trial, 100-day money-back)
| Plan | Annual (mo. equiv.) | Quarterly | Users | Feature gating |
|---|---|---|---|---|
| Basic | $49 | n/a | 1 | Estimates, invoices, expenses, bills, POs, work orders, bid manager, COs, files/photos, document writer, lead mgmt — **NO scheduling, daily logs, time cards, QuickBooks, or client portal** |
| Standard | $105 | $132 | 3 | Same feature set as Basic, 3 users — still no scheduling/QB/portal |
| Plus | $166 | $206 | 8 | **+ scheduling (Gantt/CPM), daily logs, time cards GPS, safety meetings, OSHA 300, job-costing reports, QuickBooks Online, Zapier** — realistic PM start |
| Pro | $221 | $282 | 15 | **+ client portal + takeoffs** |
| Unlimited | $332 | $415 | Unlimited | + unlimited users, phone support, offline time cards |

- **The catch:** the headline $49 is estimating/invoices only — no PM, no QB, no portal. Portal needs Pro ($221). QB sync needs Plus ($166). Quarterly billing ~26% more; Basic not offered quarterly.

### JobTread ($16–20/user tiered, all features included)
$20/user (1–10) → $15 (11–20) → $10 (21–30) → $5 (31+); annual ~20% lower. Unlimited jobs/docs + portal users. AIA, retainage, sub/vendor portal+billing, POs, selections, customer portal, CRM, takeoff, warranties, e-sign, online payments, 2-way QBO. **The catch:** per-user — a 10-user crew ≈ $150–200/mo; grows linearly with seats.

### Fieldwire (Hilti; $39/user/mo annual; free 5-user/3-project tier), PlanRadar ($32/user Basic → $107 Starter; drawing versioning Enterprise-only), Procore (~$10K+/yr enterprise)
All per-user. Fieldwire/PlanRadar are drawings/punch specialists, light on financials.

**Construction pricing landscape takeaways:**
- Buildertrend is the price ceiling ($339–829) and hides pricing now → price-anchoring opportunity for us.
- Foreman is the floor on "real PM" (~$166 Plus), with $49 being a narrow estimating-only deal.
- JobTread/Fieldwire/PlanRadar are per-user — expensive for crews.

---

## 2. Lawn Competitor Pricing

### Jobber (field-service; tiered, user-allocated; annual saves ~35–40%; 14-day trial)
| Plan | Users | Monthly | Annual (mo. equiv.) |
|---|---|---|---|
| Core | 1 | $49 | ~$29–39 |
| Connect | 1 | $139 | ~$99–119 |
| Grow | 1 | $199 | ~$149–169 |
| Core Team | 1 | $49 | ~$21–29 |
| Connect Team | 5 | $199 | ~$149–169 |
| Grow Team | 10 | $299–399 | ~$229–299 |
| Plus Team | 15 | $499–699 | ~$399–529 |
- Extra users ~$29–35/mo each. Add-ons: Marketing Suite $99, AI Receptionist $29, Pipeline $49. Payments 2.9%+$0.30. **The catch:** a 2–5 person landscaping crew realistically pays $169–349/mo; per-user scaling cliff at >5 users.

### Housecall Pro (flat tiers, bundled users; 14-day trial)
| Plan | Users | Annual | Monthly |
|---|---|---|---|
| Basic | 1 | $59 | $79 |
| Essentials | 5 | $149 | $189 |
| MAX | 8 | $299 | $329 |
| Advanced/Enterprise | custom | custom | custom |
- Extra users ~$35. Payments 2.9%+$0.30. Stronger consumer-booking/marketing (postcards, email, reviews).

### FieldEdge (custom per-tech, ~$100–200/tech/mo; $10K–50K implementation)
HVAC/plumbing/electrical — **not a lawn competitor** (wrong trade).

### RealGreen by WorkWave (mid-large residential lawn; starts ~$199/mo flat; custom-quoted 3 tiers)
Per-user + modules; 8–12 week implementation; recurring price-hike complaints.

### Aspire (enterprise commercial landscape, 20–500+; custom single monthly license, unlimited users)
Payments/payroll/GPS priced separately; price-locked term. Above our segment.

**Lawn pricing landscape takeaways:**
- Our real rivals are Jobber + Housecall Pro (small-mid); RealGreen/Aspire are the mid-large/enterprise segment above us.
- Both Jobber + Housecall scale with users; we win at crew scale with flat org pricing.

---

## 3. Our Pricing
- **Construction:** $49 / $149 / $399 per org per month (enterprise tier labeled "Business"). Tier dimensions: jobs / line-items / storage / seats / crew / customers. 30-day free trial.
- **Lawn:** $29 / $99 / $199 per org per month. Same dim model. 30-day free trial.
- **Flat org pricing** (not per-user) across both — the key wedge.

---

## 4. Our Backend Cost per Tenant (shared across both variants)

| Component | Model | Marginal cost / tenant / mo (low volume) | Notes |
|---|---|---|---|
| Supabase (Pro $25/mo base, shared multi-tenant) | rows + storage + egress | ~$0.10–0.40 | Negligible per tenant until scale; one shared project `avmqteevisqxwmmxkrbg` |
| Vercel (Pro shared) | bandwidth + function executions | ~$0.00–0.10 | Marginal near-zero per tenant |
| Resend (email) | free 3k/mo → $20/50k | ~$0.10 | A GC sends ~50–200 transactional emails/mo |
| Google Maps API (lawn routes, autocomplete, static maps) | $200/mo free credit, then per-call | ~$0.05–0.20 (lawn) | Largely free-credit-covered at low/med volume |
| Twilio SMS (NOT yet active) | ~$0.0079/SMS | variable | Flip when A2P 10DLC ready; opt-in only |
| **Stripe (our own subscription billing)** | **2.9% + $0.30 per charge** | **see below — the only material cost** | Scales with our price |
| **Total infra (ex-Stripe)** | — | **~$0.50–0.75** | |

> Accounting-provider APIs (QBO/Xero/FreshBooks) are free for us to develop against; no per-tenant provider cost. We removed Pay Here, so we don't pay Stripe on customer invoice payments — only on our own subscription.

### Stripe cost per tier (our biggest per-tenant cost)
| Tier | Price | Stripe (2.9%+$0.30) | Infra (~$0.75) | Total cost | Net | Margin % |
|---|---|---|---|---|---|---|
| Construction Starter | $49 | $1.72 | $0.75 | $2.47 | $46.53 | **94.8%** |
| Construction Pro | $149 | $4.62 | $0.75 | $5.37 | $143.63 | **96.4%** |
| Construction Business | $399 | $11.87 | $0.75 | $12.62 | $386.38 | **96.8%** |
| Lawn Starter | $29 | $1.14 | $0.75 | $1.89 | $27.11 | **93.5%** |
| Lawn Pro | $99 | $3.17 | $0.75 | $3.92 | $95.08 | **96.0%** |
| Lawn Business | $199 | $6.07 | $0.75 | $6.82 | $192.18 | **96.6%** |

**Every active (non-trial) tenant is strongly profitable.** Infra is negligible; Stripe is the only material cost (~3–4%). Higher tiers have lower cost-as-% (the $0.30 fixed fee amortizes), so up-tiering improves margin.

---

## 5. Competitive Positioning (per tier)

### Construction
- **Our $49 vs Foreman Basic $49** — same price. We beat them on PM field features (Gantt/CPM, daily logs, punch, submittals, time tracking, receipts) + in-app Insights + **3-provider sync (QBO+Xero+FreshBooks)** vs their QB-none at Basic. We lose on POs/Bills/bid manager (they have; we don't yet). **Ship POs/Bills (NOW tier) to definitively win $49.** JobTread at $49 ≈ 2.5 users — a solo GC; we win on flat-pricing the moment they add a second seat.
- **Our $149 vs Foreman Plus $166 (8 users) + JobTread ~$150–200 (10 users)** — Foreman Plus adds scheduling/QB/OSHA/job costing; we already have scheduling/insights/QB-and-2-more at $49. Our $149 must bundle **POs/Bills + sub portal + proposals/e-sign + client portal + retainage** (the NOW tier) to justify vs Foreman Plus, plus our sync + insights lead. After NOW + NEXT-tier compliance (AIA/lien waivers/OSHA/certified payroll), our $149 ≈ Foreman Plus + 3-provider sync + insights − nothing. Strong.
- **Our $399 "Business" vs Buildertrend Advanced ~$499 + Complete ~$829, and Foreman Unlimited $332** — we sit below BT Advanced, above Foreman Unlimited. After NOW + NEXT, $399 matches BT Advanced feature breadth (estimating/proposals/POs/budget/sub portal/insights) + 3-provider sync, at a ~$100–430 discount to BT, and adds compliance (AIA/certified payroll) BT lacks natively. **Don't chase BT's $829 Complete/Selections tier** — $399 is the right ceiling; staying under BT's price is the positioning.

### Lawn
- **Our $29 vs Jobber Core $49 / Housecall Basic $59–79** — we underprice entry by ~$20–50. We match core (recurring schedules, Today's Route, visit lifecycle, customer portal, notifications) and lead on **3-provider sync** (they're QB-only) + in-app insights. We lag on GPS route-optimization depth + marketing suite (Jobber Marketing $99 add-on). 94% margin even at $29.
- **Our $99 vs Jobber Connect $139 (5 users, ~$99–119 annual) / Housecall Essentials $149** — competitive to under. Bundle route + recurring + sync + automated reminders + client hub equivalents; lead with 3-provider sync + insights.
- **Our $199 vs Jobber Grow $199 (10 users, ~$149–169 annual) / Housecall MAX $299 (8 users)** — matches Jobber Grow monthly, undercuts Housecall MAX by $100. RealGreen ($199+) and Aspire (custom) are above our segment — we don't compete head-on, leaving enterprise room above.

---

## 6. The Flat-Org-Pricing Wedge (and a critical caveat)

Our **flat per-org pricing beats every per-user rival once a crew exceeds ~3–5 users:**
- JobTread: 10 users ≈ $150–200/mo; 15 ≈ $150–300; we cap at $399 unlimited.
- Jobber: 10 users ≈ $299–399; 15 ≈ $499–699; we cap at $199 (lawn).
- Housecall: 8 users = $299; we cap at $199 (lawn).
- Fieldwire/PlanRadar: $32–39/user → 10 users = $320–390; we cap at $399 (construction).
- Foreman: user-capped (1/3/8/15/unlimited at $49/105/166/221/332) — our flat tiers avoid their seat-cliff entirely.

**⚠️ Critical caveat — the "seats" tier dimension.** Our tier model dims include **seats**. If "seats" counts `crew_members` (scheduling-only, no app login), we **destroy the flat-pricing wedge** and become a per-user product like the rivals. To preserve the wedge:
- **"seats" must count only app-login users (office/admin/project_manager/super_admin + any crew with a login), NOT `crew_members`** (who are scheduling-only and have no app login per the crew_members design `id=profiles.id`).
- Confirm the BillingForm + app-side enforcement count seats that way (this is a flagged follow-up from [[lowvoltage-tiers-crew-members]]: "BillingForm display + app-side enforcement pending").
- **Lead with "unlimited field crew, no per-seat cliff"** in sales vs JobTread/Jobber/Housecall/Fieldwire/PlanRadar — it's a genuine, defensible wedge.

---

## 7. Recommendations

1. **Keep the tiers.** All six are profit-healthy (94–97% margin) and competitively positioned. No price cut needed; no hike needed.
2. **Add annual billing (e.g., pay 10 months, 2 free → ~17% discount).** Locks revenue, cuts churn, lowers effective Stripe cost per period (fewer charges), and matches the SaaS norm rivals use. Annual is a margin + retention lever, not a discount giveaway.
3. **Trial hygiene (the only real margin risk).** $0 revenue for 30 days + ~$0.75/mo infra per trial org. Already mitigated by dim-limits (jobs/line-items/customers); add **email verification at signup** + a **dormant-trial-org cleanup cron** (auto-archive orgs that never converted past 30 days) to cap abuse before scaling.
4. **Ship POs/Bills (NOW tier) promptly** — it's what lets us definitively win the $49 tier against Foreman Basic (we already beat them on PM/sync/insights; POs/bills closes the one gap).
5. **Guard the seats dim** — seats = app-login users only, never `crew_members`. Verify BillingForm/enforcement. This preserves the flat-pricing wedge.
6. **Don't chase Buildertrend's $829 Complete tier** — our $399 + NOW + NEXT compliance/growth is the right ceiling. Staying under BT's price is the positioning.
7. **Consider ACH/SEPA for higher tiers** to cut the Stripe fee (ACH ~0.8%, vs 2.9% card) — minor, but on $399 it's ~$10 vs ~$12 saved per tenant/mo; adds up at scale. Lower priority than annual billing.

---

## 8. Risk Register
| Risk | Impact | Mitigation |
|---|---|---|
| Trial abuse at scale | $0.75/mo × many dormant trial orgs | Dim-limits (done) + signup email verification + dormant-org cleanup cron |
| Stripe fee on low tiers | $29 lawn → ~3.9% cost (thinnest %) | Annual billing; ACH for higher tiers; the $0.30 fixed fee amortizes on upgrades |
| Per-user rivals undercutting at solo (1 user) | JobTread $16–20 solo, Jobber ~$29 annual solo beat our $49/$29 at exactly 1 user | Accept — we win at 2+ seats; solo is a small segment; our feature breadth + sync + insights justify the gap |
| Renewal-hike reputation (BT's 50–75% hikes) | Our opportunity | Publish stable pricing + no surprise hikes — a real differentiator vs BT's documented complaint pattern |
| Foreman Basic $49 feature match | POs/bills/bids at $49 we lack | Ship POs/bills (NOW tier) |
| "seats" dim miscounting crew_members | Loses flat-pricing wedge | Verify BillingForm counts app-login users only |

## 9. Sources
- Buildertrend: [pricing page](https://buildertrend.com/construction-software-pricing/), [2026 analysis](https://projul.com/blog/buildertrend-pricing-analysis-2026/), [tier breakdown](https://toricentlabs.com/blog/buildertrend-pricing-2026.html)
- Contractor Foreman: [price comparison](https://contractorforeman.com/price-comparison/), [2026 review](https://aibuildermarketplace.com/b2b/contractor-foreman-review/), [PricingSaaS](https://pricingsaas.com/companies/contractorforeman)
- JobTread: [features](https://www.jobtread.com/features), [QBO integration](https://www.jobtread.com/integrations/quickbooks-online)
- Jobber: [pricing](https://www.getjobber.com/pricing/), [FSM comparison](https://www.stackscored.com/pricing/field-service-management/)
- Housecall Pro / FieldEdge: [FSM pricing](https://www.fsmadvisor.com/pricing), [Jobber vs Housecall](https://costbench.com/compare/housecall-pro-vs-jobber/)
- RealGreen: [pricing](https://www.realgreen.com/pricing); Aspire: [plans](https://www.youraspire.com/aspire-plans)
- PlanRadar/Fieldwire: [comparison](https://www.selecthub.com/construction-management-software/fieldwire-vs-planradar/)