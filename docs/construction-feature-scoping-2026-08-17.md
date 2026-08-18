# Construction Management Feature Scoping — Terra Vista (Aug 2026)

## Executive Summary
Terra Vista is a construction SaaS targeting small to mid-sized residential and commercial general contractors (GCs) at $49-$399/month. Our goal is to offer the **correct** features a GC company actually needs — practical operational + commercial-compliance depth — at Contractor-Foreman prices ($49–399). We are deliberately **not** trying to be Procore (no BIM, portfolio, bid management, fleet, takeoff, or enterprise bloat). The founding customer is a commercial GC, so commercial compliance (AIA progress billing, subcontractor compliance, lien waivers, certified payroll, OSHA safety logs) is a real, needed priority — and a differentiator, since most low-cost tools lack certified payroll and AIA billing. This document scopes the current feature set, gaps, and roadmap.

## Feature Availability Matrix

| Feature                        | Procore                | Buildertrend           | Contractor Foreman | Houzz Pro | Jobber | Terra Vista                |
|------------------------------|------------------------|------------------------|----------------------|-----------|--------|----------------------------|
| Daily Logs                     | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| Punch List                     | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| RFIs                           | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| Submittals                     | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| Change Orders                  | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| Gantt/Schedule w/ dependencies | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| CPM critical path              | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| City Inspections checklist     | Yes                    | No                     | No                   | No        | No     | Yes                        |
| Estimating (cost codes+markup) | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| Invoices                       | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| Online payment processing      | Yes                    | Yes                    | Yes                  | No        | No     | No (customer pays)         |
| Job profitability/budget-vs-actual | Yes | Yes | Yes | No | No | Yes |
| Per-job cost-code budgeting    | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| Cost codes                     | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| Crew time tracking             | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| Receipts/expenses              | Yes                    | Yes                    | Yes                  | No        | No     | Yes                        |
| Purchase orders/bills          | Yes                    | Yes                    | Yes                  | No        | No     | No                         |
| Proposals w/ e-sign            | Yes                    | Yes                    | No                   | No        | No     | No                         |
| Unified client portal (login)  | Yes                    | Yes                    | Yes (construction)   | Yes       | Yes     | No (token portals)         |
| Selections (finishes+running total) | No | Yes | No | No | No | No |
| Subcontractor mgmt/portal    | Yes                    | Yes                    | Yes                  | No        | No     | No                         |
| Subcontractor invoicing        | Yes                    | Yes                    | Yes                  | No        | No     | No                         |
| Lien waivers                   | Yes                    | No                     | No                   | No        | No     | No (commercial focus)      |
| OSHA/safety logs               | Yes                    | No                     | No                   | No        | No     | No (commercial focus)      |
| Document mgmt + versioning     | Yes                    | Yes                    | No                   | No        | No     | No                         |
| Takeoff                        | Yes                    | Yes                    | No                   | No        | No     | No                         |
| Bid management                 | Yes                    | No                     | No                   | No        | No     | No                         |
| CRM/lead mgmt                  | Yes                    | Yes                    | No                   | No        | No     | No                         |
| In-app messaging               | Yes                    | Yes                    | No                   | No        | No     | No (notifications only)    |
| Project templates              | Yes                    | Yes                    | No                   | No        | No     | No                         |
| AI client updates              | Yes                    | No                     | No                   | No        | No     | No                         |
| Accounting sync (QB/Xero/FreshBooks) | Yes | Yes | Yes | No | No | Yes |
| Warranties                     | Yes                    | Yes                    | No                   | No        | No     | No                         |
| Reporting/exports              | Yes                    | Yes                    | No                   | No        | No     | Yes                        |

## Gap Analysis

1. **Client Portal (unified, logged-in)** — We have fragmented token portals only; Buildertrend/Foreman have a unified login portal. **Table-stakes.**
2. **Selections (client picks finishes online, running total)** — Buildertrend signature; we have zero. **Table-stakes for residential/remodelers.**
3. **Purchase Orders / Bills (outgoing payments to subs/suppliers, PO mgmt)** — Buildertrend/Procore. **Table-stakes for GC.**
4. **Proposals (estimates -> polished client-ready proposal w/ e-signature)** — We have estimates + portal but no proposal polish/e-sign. **Table-stakes.**
5. **Commercial-GC compliance cluster** — lien waivers (conditional/unconditional, progress/final), certified payroll (prevailing wage / WH-347), OSHA safety logs (300/300A/301), AIA progress billing (G702/G703 + schedule of values + retainage), subcontractor compliance tracking (COI/W9/license/bond expiry). Founding customer is a commercial GC → **Needed, not deferred.** Certified payroll + AIA billing are differentiators (most low-cost tools — Jobber/Houzz/Foreman — lack them).
6. **In-app messaging (team/subs/clients)** — Buildertrend has; we have notifications, not chat. **Growth.**
7. **Project templates (reuse schedule/selections/tasks per job type)** — Buildertrend; scales repeat builders. **Growth.**
8. **Document management w/ versioning (drawings/specs revision compare)** — 83% critical; we have blueprints upload only, no versioning/compare. **Growth.**
9. **Subcontractor portal + subcontractor invoicing** — Procore/Foreman. **Growth (commercial).**
10. **Lead/CRM + proposals pipeline + email marketing** — Buildertrend sales side. **Lower (we are project-focused).**
11. **AI client updates (auto-generate progress updates from daily logs/schedule/invoices)** — cheap w/ our data; potential moat. **Differentiator.**
12. **Takeoff (digital blueprint measurement)** — complex/niche. **Defer.**
13. **Resource/equipment/fleet/materials tracking** — Procore-tier. **Defer.**
14. **Bid management + prequalification** — commercial bid market. **Defer.**
15. **BIM / portfolio mgmt** — enterprise, out of wedge. **Defer.**

## Tiered Roadmap

### NOW (correct GC features, buildable on existing schema: customers/jobs/estimates/invoices/change_orders/subcontractors)
- **AIA progress billing (G702/G703)**: Effort: L, Value: High, Note: Schedule of values + % complete + retainage → G702/G703. Commercial cash-flow core; ties to estimates. Differentiator (most cheap tools lack it).
- **Subcontractor compliance tracking**: Effort: M, Value: High, Note: COI + W9 + license + bond expiry + alerts. Commercial GCs must track sub insurance/licenses.
- **Client Portal**: Effort: M, Value: High, Note: Unified login portal for owners/architects (replaces fragmented token portals).
- **Purchase Orders/Bills**: Effort: L, Value: High, Note: Sub/supplier commitments + incoming invoicing.
- **Proposals/contracts e-sign**: Effort: M, Value: High, Note: Estimates → proposal + contract/change-order e-signature.

### NEXT (commercial compliance + growth)
- **Lien waivers**: Effort: M, Value: High, Note: Conditional/unconditional, progress/final; per-payment PDF + tracking. Ties to invoices/payments + subs.
- **Certified payroll (WH-347)**: Effort: L, Value: High, Note: Prevailing-wage weekly statements + fringe. NEEDS per-classification wage rates (pulls per-role-rate work forward). Differentiator.
- **OSHA safety logs**: Effort: M, Value: Med, Note: 300/300A/301 + toolbox talks + incident/near-miss tracking.
- **Subcontractor portal + invoicing**: Effort: L, Value: Med, Note: Subs get scopes/COs/invoices/compliance docs.
- **Document mgmt + versioning**: Effort: L, Value: Med, Note: Drawings/specs/submittals revision control (83% of buyers rate critical).
- **Selections**: Effort: M, Value: Med, Note: Client picks finishes + running total (residential-leaning; kept for non-commercial customers).
- **In-app messaging**: Effort: M, Value: Med, Note: Team/subs/clients chat.
- **Project templates**: Effort: M, Value: Med, Note: Reuse schedule/selections/tasks per job type.
- **AI client updates**: Effort: M, Value: High, Note: Auto-generate progress updates from daily logs/schedule/invoices.

### Not pursuing (deliberately NOT Procore — enterprise bloat outside a GC's practical needs)
- **Takeoff**: Effort: L, Value: Low, Note: Digital blueprint measurement.
- **Resource/equipment/fleet/materials tracking**: Effort: L, Value: Low, Note: Procore-tier.
- **Bid management + prequalification**: Effort: L, Value: Low, Note: Commercial bid market.
- **BIM / portfolio mgmt**: Effort: L, Value: Low, Note: Enterprise focus.
- **Lead/CRM + email marketing**: Effort: L, Value: Low, Note: Sales-side; we are project-focused.

## Honest Differentiators
- **Correct GC features at Contractor-Foreman prices ($49–399)** — practical operational + commercial-compliance depth, not Procore enterprise bloat.
- **A bookkeeping sync that actually works** (one-way to QuickBooks/Xero/FreshBooks) where competitors' syncs are spotty.
- **In-app insights + per-job profitability without QuickBooks** — we hold both revenue and cost (shipped /admin/insights).
- **AIA progress billing + certified payroll** — most low-cost tools (Jobber/Houzz/Foreman) lack these; commercial GCs need them.
- **Two purpose-built variants** (construction + lawn) one platform.

## Recommendation
Build the **correct, practical GC set** — not a feature chase, not Procore. Start with the NOW tier: **AIA progress billing + subcontractor compliance tracking** (commercial cash flow + sub risk — the pieces you actually need and most cheap tools lack), then **Client Portal + Purchase Orders/Bills + contracts/e-sign** (operational table-stakes). Then the NEXT-tier commercial compliance: **lien waivers → certified payroll → OSHA safety logs** (certified payroll pulls the per-classification wage-rate work forward). Growth items (messaging, templates, doc versioning, AI client updates) follow. Deliberately skip the Procore tier — takeoff, fleet, bid management, BIM, portfolio, CRM — unless a real job demands it. The wedge: a commercial GC gets the compliance + operational depth they actually need at $49–399, with a working sync and in-app insights, instead of paying Procore $10k+/yr for enterprise features they don't use.