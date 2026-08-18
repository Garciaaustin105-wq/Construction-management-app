# Construction Competitor Deep-Dive — Terra Vista (Aug 2026)

> Companion to `docs/construction-feature-scoping-2026-08-17.md`. This deeper dig corrects two errors in the v1 scoping doc and adds per-competitor granularity.

## Executive Summary
The deeper dig changes the competitive picture materially, and more soberly than v1 suggested. **Contractor Foreman and JobTread already cover most table-stakes *and* the compliance cluster at low prices** — Foreman ($49–332/mo flat, unlimited users) has AIA G702/G703, lien waivers, OSHA 300 auto-entries, safety meetings, submittals with approval workflows, sub-contracts with retainage, bid management, drawing markup, team chat, and subcontractor compliance tracking (COI/insurance-expiry alerts). JobTread ($16–20/user/mo, all features included) has AIA payment apps, retainage, sub/vendor portal + billing, POs, selections, customer portal, CRM, takeoff, warranties, e-sign, online payments, and two-way QuickBooks. Compliance specialists (Nexus AP $99/mo, Billitron free <$50k) additionally cover certified payroll (WH-347).

**Implication:** compliance and the broad feature set are **not differentiators** — they are table-stakes our low-cost rivals already deliver. Our real remaining wedge **narrows to three things**: (1) **multi-provider accounting sync** (QuickBooks Online + Xero + FreshBooks — Foreman is QB-only with Xero "coming mid-2026"; JobTread is QBO-only), (2) **in-app Insights + per-job profitability computed without the accounting provider** (we hold both revenue and cost; rivals tie reporting/job-costing to QuickBooks), and (3) **two purpose-built variants** (construction + lawn) on one platform. The build order shifts: **reach parity first** on the table-stakes both low-cost rivals have, **then add compliance as table-stakes** (not as a moat) to stop losing commercial-GC deals to Foreman/JobTread, **then growth** to match Buildertrend — while protecting the sync + insights lead.

## Corrected Feature Availability Matrix

| Feature | Procore | Buildertrend | Contractor Foreman | JobTread | Fieldwire | PlanRadar | Terra Vista |
|---|---|---|---|---|---|---|---|
| Daily Logs | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Punch List | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| RFIs | Yes | Yes | Yes | Yes (Form Builder) | Partial | Partial | Yes |
| Submittals (w/ approval workflow) | Yes | Yes | Yes | Yes (Form Builder) | Partial | Partial | Yes (portal) |
| Change Orders | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Gantt + dependencies | Yes | Yes | Yes | Partial (tasks) | Partial | Partial | Yes |
| CPM critical path | Yes | Yes | Yes | No | No | No | Yes |
| City inspections checklist | Yes | No | Yes | No | Partial | Partial | Yes |
| Estimating (cost codes + markup) | Yes | Yes | Yes | Yes | No | No | Yes |
| Invoices | Yes | Yes | Yes | Yes | No | No | Yes |
| AIA G702/G703 progress billing | Yes | Yes | Yes | Yes | No | No | **No** |
| Retainage tracking | Yes | Yes | Yes | Yes | No | Yes | **No** |
| Online payment processing | Yes | Yes | Yes (2.9%/1%) | Yes | No | No | No (intentional) |
| Job profitability / budget-vs-actual | Yes | Yes | Yes | Yes | Partial | Partial | Yes |
| Per-job cost-code budgeting | Yes | Yes | Yes | Yes | No | No | Yes |
| Cost codes | Yes | Yes | Yes | Yes | No | No | Yes |
| Crew time tracking | Yes | Yes | Yes | Yes | Partial | No | Yes |
| Receipts / expenses | Yes | Yes | Yes | Yes | No | No | Yes |
| Purchase orders / bills | Yes | Yes | Yes | Yes | No | No | **No** |
| Proposals w/ e-sign | Yes | Yes | Yes | Yes | No | No | **No** |
| Unified client portal (login) | Yes | Yes | Yes | Yes | Partial | Partial | **No** (token portals) |
| Selections | No | Yes | No | Yes | No | No | **No** |
| Subcontractor mgmt / portal | Yes | Yes | Yes | Yes | Yes | Yes | **No** (table only) |
| Subcontractor invoicing | Yes | Yes | Yes | Yes | No | No | **No** |
| Sub-contract w/ retainage | Yes | Yes | Yes | Yes | No | No | **No** |
| Lien waivers | Yes | No | Yes (Document Writer) | No | No | No | **No** |
| Certified payroll (WH-347) | Yes | No | No | No | No | No | **No** |
| OSHA safety logs (300/300A) | Yes | No | Yes (auto 300) | No | No | No | **No** |
| Safety meetings / toolbox talks | Yes | No | Yes (800+ topics) | No | Partial | Partial | **No** |
| Subcontractor compliance (COI/W9/expiry) | Yes | Partial | Yes (Directory alerts) | No | No | No | **No** |
| Document mgmt + versioning | Yes | Yes | No | Partial | Yes | Partial (Enterprise) | **No** |
| Drawings/PDF markup + compare | Yes | Yes | Yes (markup) | Partial | Yes | Yes | **No** |
| Takeoff | Yes | Yes | No | Yes | No | No | **No** |
| Bid management | Yes | Yes | Yes | Yes | No | No | **No** |
| CRM / lead mgmt | Yes | Yes | No | Yes | No | No | **No** |
| In-app messaging | Yes | Yes | Yes (Team Chat) | Yes | Yes | Yes | **No** (notifications) |
| Project templates | Yes | Yes | No | Yes | No | No | **No** |
| Warranties | Yes | Yes | Yes | Yes | No | No | **No** |
| AI client updates | Yes (Helix) | Yes | No | Partial (Workflows) | No | No | **No** |
| Accounting sync | Sage/QB/Viewpoint/CMiC/Xero/Yardi | 20+ integrations | QB two-way (Xero coming) | QBO two-way | Limited | 200+ (PlanRadar Connect) | **QBO + Xero + FreshBooks** (one-way + paid read-back) |
| Reporting / exports | Yes | Yes | Yes | Yes | Partial | Partial | Yes (Excel + PDF) |
| In-app insights / command-center | Yes | Yes | Partial (tied to QB) | Partial (tied to QB) | No | No | **Yes (provider-independent)** |
| Multi-variant (construction + lawn) | No | No | No | No | No | No | **Yes** |

## Competitor Deep Profiles

**Contractor Foreman ($49–332/mo, flat-rate unlimited users — our direct price rival).** 47 features. The surprise of this dig: Foreman is far deeper than v1 credited. Financials include **AIA G702/G703** auto-generation with background retainage, progress invoicing, adjustable retainage (10%→5%), T&M billing, purchase orders (deliver/billed tracking, bills from POs), online payments (CC 2.9% / ACH 1%), and **sub-contracts** with retainage tracking, single-click bill creation, Kanban status, custom fields, and progress billing for subs. Project mgmt: daily logs (weather/crew/safety/materials), Gantt with critical path + baselines, punchlists, RFIs, **submittals with automated approval workflows**, permits, inspections. Documents: **drawing/PDF markup** (redline, measure) and a **Document Writer** that generates **lien waivers** via mail merge. People: Time Cards (GPS/geofence → job costing), **Team Chat**, **Incidents with automatic OSHA 300 entries**, **Safety Meetings (800+ toolbox topics EN/ES)**, and a **Directory with certification tracking + insurance-expiry alerts** (= subcontractor compliance). Sales: bid management (side-by-side vendor bids → PO/sub-contract). Construction client portal (contract approvals, progress payments). Integrations: two-way QuickBooks (Desktop sync ends Jan 1 2026), CompanyCam, Stripe, Zapier, Gusto, MS Project; **Xero coming mid-2026**. Net: Foreman already has the compliance cluster v1 thought was a differentiator.

**JobTread ($16–20/user/mo tiered to $4 at 31+ users; all features included, unlimited jobs/docs + portal users).** The strongest low-cost threat to our wedge — far fuller than v1's one-line "~$159 simplicity" treatment. Sales & estimating: CRM, estimating, **takeoff (formulas)**, contracts & e-signatures, cost catalog, **bid requests** (digital sub/vendor pricing → POs one-click), lead mgmt, web clipper. Project mgmt: tasks & scheduling, daily logs, time tracking, custom forms, **Sub & Vendor Portals** (bid submission, PO acceptance, task completion, photo sharing, bill submission), specs, mobile app, no-code workflows. Job finances: budgeting, change orders, job costing, **POs & Work Orders**, **AIA Payment Applications**, **Retainage & Hold-Backs** (dedicated feature), **Sub & Vendor Billing** (compare bills to POs), customer invoices with view-tracking, reporting & dashboards. Customer experience: **Customer Portals**, **Selections & Allowances**, messaging, homeowner financing, online payments, warranty mgmt. **Two-way QuickBooks Online** (best-in-class). Net: JobTread already delivers our entire v1 NOW+NEXT tier — AIA, retainage, sub portal+billing, POs, selections, customer portal, CRM, takeoff, warranties, e-sign, online payments — at a lower per-user price.

**Buildertrend (~$499/mo, 130+ features, ~20K contractors).** The residential/mid-market feature reference. Scheduling (calendar/list/Gantt + baselines + dependencies), change orders (e-sign), daily logs (+weather), **selections** (client picks finishes online, running total — signature feature), tasks, time clock (Gusto), warranties, project templates. Financial: budget (cost-code, profitability), bids, **bills & POs**, estimates, invoices, online payments, **takeoff**, **proposals (estimates → client-ready w/ e-sign)**. Communication: customer portal (login: reports/photos/messages/selections/invoices), sub portal, in-app messages, unlimited file storage, **AI-powered client updates**. Sales: lead mgmt, email marketing. 20+ integrations. The feature ceiling we'd grow toward, not the price tier we'd match.

**PlanRadar (~$32/user/mo Basic, steep jump to $107 Starter).** Mid-GC field/office balance, strong on defect/snag tracking: log/assign/resolve with mobile photo + geolocation capture, QR scan, 360° reality capture (SiteView), issues pinned to drawings or BIM, ticket-based workflow, inspection checklists, role-based permissions, multilingual, unlimited subs/watchers on all plans, strong time-stamped audit trail. Weaknesses: **drawing version control Enterprise-tier only**, Basic caps at 10 digital plans, form customization restrictive, reporting shallow, light on financials. Integrations via PlanRadar Connect (200+ no-code) + Open API.

**Fieldwire (Hilti; $39/user/mo annual; free 5-user/3-project/100-sheet tier).** Mobile-first field. Drawings: strong plan viewing + markup, offline iOS/Android, sheet comparison (Pro+), tasks/punch pinned to sheets, layered PDF export, BIM viewer (navigate/measure). Punch/defect: records retain media + checklist through closure, reusable templates, walkthrough closeout with hashtags + location pins. Tasks with comment threads across GC/subs/inspectors. Weaknesses: forms/reports light, mobile trails web on some features, reporting lighter than Procore, large sheet uploads lag, integrations limited, light on financials. A drawings/punch specialist, not a financials/compliance tool.

**Compliance & finance specialists (construction-payment platforms — not full PM suites).** These set the compliance bar and are cheap. **Built** — AIA G702/G703 (sub pay apps, discrepancy flagging, roll-up to owner billing), auto lien waivers (sub signs before money moves), insurance/safety/financial doc tracking + alerts, ACH sub payments with payee verification; enterprise pricing. **Nexus AP ($99/mo unlimited users)** — AI-extracted G702/G703 validated vs schedule of values, automated 50-state lien waivers with payment holds, **certified payroll (Davis-Bacon/WH-347)**, retainage per subcontract; integrates Sage/Intacct/Vista/Procore/QBO/Xero. **Billitron (free <$50k, sub-focused)** — auto G702/G703 from SOV with retainage, conditional/unconditional waivers (50-state), **WH-347 certified payroll**, W-9 + COI tracking with expiry. **Acumatica Construction Edition (consumption/unlimited users)** — full ERP with native certified payroll (multi-union/locals/classifications), G702/G703 from live job cost, lien waivers, COI/bond tracking. **Kiron** — reads compliance docs from email inboxes (no portal), validates COIs (ACORD 25) and lien waivers against draws. Takeaway: AIA, lien waivers, certified payroll, and COI tracking are widely and cheaply available — compliance is table-stakes, not a moat.

## What We Miss

**Table-stakes we lack that BOTH Foreman and JobTread have:**
- Unified client portal (logged-in) — we have only fragmented token portals
- Proposals w/ e-sign
- Purchase orders / bills
- Subcontractor portal + subcontractor invoicing
- Sub-contract with retainage

**Compliance we lack (Foreman + JobTread + specialists cover it):**
- AIA G702/G703 progress billing + schedule of values + retainage (Foreman, JobTread)
- Subcontractor compliance tracking — COI/W9/license/bond expiry + alerts (Foreman)
- Lien waivers — conditional/unconditional, progress/final (Foreman; specialists 50-state)
- Certified payroll (WH-347 / Davis-Bacon prevailing wage) — needs per-classification wage rates (specialists; neither Foreman nor JobTread has it)
- OSHA safety logs (300/300A/301) + toolbox talks (Foreman)

**Growth we lack (Buildertrend/Fieldwire/PlanRadar set the bar):**
- Document mgmt with versioning + drawings/PDF markup + revision compare
- In-app messaging (team/subs/clients)
- Project templates
- Selections (JobTread + Buildertrend)
- Warranties
- AI client updates (Buildertrend)
- Takeoff, bid management, CRM/leads (JobTread + Buildertrend have; we deliberately defer)

## How We Stack Up

| Area | Verdict | Why |
|---|---|---|
| Project mgmt (logs, punch, RFIs, submittals, COs, Gantt/CPM) | **Parity** | We match Foreman/JobTread/Buildertrend; our Gantt+CPM + city-inspections checklist are above JobTread. |
| Financials core (estimates, invoices, job costing, cost codes, budget-vs-actual) | **Parity** | Covered; we lack POs/bills + AIA + retainage (below). |
| In-app Insights / command-center | **We Lead** | We surface job profitability, AR aging, pipeline, crew productivity in-app without the accounting provider; Foreman/JobTread tie reporting to QuickBooks. |
| Accounting sync breadth | **We Lead** | 3 live providers (QBO + Xero + FreshBooks) vs Foreman QB-only (Xero "coming") and JobTread QBO-only. |
| Multi-variant (construction + lawn) | **We Lead (only)** | No competitor runs both businesses on one platform. |
| Compliance (AIA, retainage, lien waivers, OSHA, certified payroll, sub compliance) | **We Lag** | Foreman + JobTread + specialists cover it; we have none. |
| Client experience (unified portal, proposals e-sign, selections) | **We Lag** | Rivals have logged-in portals + proposals; we have token portals only. |
| Subcontractor mgmt (portal, invoicing, sub-contracts) | **We Lag** | Foreman + JobTread have full sub workflows; we have a table only. |
| Document mgmt (versioning, drawing markup, compare) | **We Lag** | Fieldwire/PlanRadar/Buildertrend have; we have upload only. |
| Collaboration (messaging, templates) | **We Lag** | All rivals have chat + templates; we have notifications only. |
| Online payments | **Intentional** | We abstain (customer pays on own provider page) — differentiator, not a gap. |
| Procore-tier (takeoff, fleet, bid, BIM, portfolio, CRM) | **Lag / Not pursuing** | Deliberately out of wedge. |

## Revised Honest Differentiators (only the real ones)
1. **Multi-provider accounting sync** — QBO + Xero + FreshBooks, one-way push + paid-status read-back. Foreman is QB-only; JobTread is QBO-only. Three live providers is rare at this price.
2. **In-app Insights + provider-independent job profitability** — we hold both revenue (invoices) and cost (time/materials/change orders) and surface profitability/AR-aging/pipeline/crew productivity in-app. Rivals' reporting is tied to their accounting provider.
3. **Two purpose-built variants** (construction + lawn) on one platform — no competitor serves both.

(We no longer claim compliance or token portals/notifications as differentiators — corrected.)

## Recommendation
**Stop claiming compliance as the differentiator — it isn't.** Build order:

1. **NOW — reach parity** on the table-stakes BOTH low-cost rivals already have, so we stop losing deals on missing basics: **Unified Client Portal** (logged-in, replaces token portals), **Proposals/e-sign**, **Purchase Orders/Bills**, **Subcontractor portal + invoicing + sub-contracts with retainage**.
2. **NEXT — compliance as table-stakes (not a moat)** to not lose commercial-GC deals to Foreman/JobTread: **AIA G702/G703 + retainage + schedule of values**, **subcontractor compliance (COI/W9/bond expiry + alerts)**, **lien waivers**, **certified payroll (WH-347 — pulls per-classification wage-rate work forward; this is the one piece Foreman+JobTread both lack, so it's our only compliance edge)**, **OSHA 300/300A + toolbox talks**. Then growth to match Buildertrend: **doc versioning + drawing markup**, **in-app messaging**, **project templates**, **selections**, **AI client updates**.
3. **Protect the moat** — keep multi-provider sync + in-app insights as the lead in sales positioning; they're what we have that the low-cost rivals genuinely don't.
4. **Deliberately skip the Procore tier** — takeoff, fleet, bid management, BIM, portfolio, CRM — unless a real job demands it.

The honest framing: a commercial GC gets working multi-provider sync + in-app job profitability + compliance/operational parity at $49–399, instead of Foreman/JobTread's QB-only reporting or Procore's $10k+/yr enterprise bloat they won't use.