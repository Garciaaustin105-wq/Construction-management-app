# Construction Management Feature Scoping — Terra Vista (Aug 2026)

## Executive Summary
Terra Vista is a construction SaaS targeting small to mid-sized residential and commercial general contractors (GCs) at $49-$399/month. Our goal is to offer Buildertrend-class features at Contractor-Foreman prices. This document outlines the current feature set, gaps compared to competitors, and a roadmap for future development.

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
5. **Lien waivers + OSHA safety logs / certified payroll** — Foreman/Procore compliance. **Table-stakes for COMMERCIAL GC only (not residential focus).**
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

### NOW (table-stakes we lack, buildable on existing schema: customers/jobs/estimates/invoices/change_orders)
- **Client Portal**: Effort: M, Value: High, Note: Unified login portal.
- **Selections**: Effort: M, Value: High, Note: Client picks finishes online.
- **Purchase Orders/Bills**: Effort: L, Value: High, Note: Outgoing payments to subs/suppliers.
- **Proposals/e-sign**: Effort: M, Value: High, Note: Polished client-ready proposal.

### NEXT (growth + differentiator)
- **In-app messaging**: Effort: M, Value: Med, Note: Team/subs/clients chat.
- **Project templates**: Effort: M, Value: Med, Note: Reuse schedule/selections/tasks.
- **Document mgmt + versioning**: Effort: L, Value: Med, Note: Drawings/specs revision compare.
- **Subcontractor mgmt/portal**: Effort: L, Value: Med, Note: Commercial focus.
- **Subcontractor invoicing**: Effort: L, Value: Med, Note: Commercial focus.
- **AI client updates**: Effort: M, Value: High, Note: Auto-generate progress updates.

### Defer (complex/niche or enterprise)
- **Takeoff**: Effort: L, Value: Low, Note: Digital blueprint measurement.
- **Resource/equipment/fleet/materials tracking**: Effort: L, Value: Low, Note: Procore-tier.
- **Bid management**: Effort: L, Value: Low, Note: Commercial bid market.
- **BIM / portfolio mgmt**: Effort: L, Value: Low, Note: Enterprise focus.

## Honest Differentiators
- **Buildertrend-class features at Contractor-Foreman prices**: Cost-effective solution for small to mid-sized GCs.
- **Accounting sync (QB/Xero/FreshBooks)**: Seamless financial integration.
- **Token portals (not unified login)**: Secure access for multiple users.
- **Notifications (not messaging)**: Real-time updates without chat functionality.

## Recommendation
Focus on closing the table-stakes gaps by implementing the Client Portal, Selections, Purchase Orders/Bills, and Proposals/e-sign features. This will provide a robust foundation for our product and differentiate us from competitors. Additionally, consider the growth opportunities with In-app messaging, Project templates, Document mgmt + versioning, Subcontractor mgmt/portal, and Subcontractor invoicing. Defer complex/niche features like Takeoff, Resource/equipment/fleet/materials tracking, Bid management, and BIM / portfolio mgmt until later stages of development.