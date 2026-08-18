# Construction NOW-Tier Deep-Dive — Terra Vista (Aug 2026)

## Executive Summary
The NOW tier is the **parity** work — the four feature groups BOTH low-cost rivals (Contractor Foreman + JobTread) already have, so we stop losing deals on missing basics before we touch compliance or growth. The four: **Unified Client Portal**, **Proposals/e-sign**, **Purchase Orders/Bills**, and **Subcontractor portal + invoicing + sub-contracts with retainage**. They share three pieces of infrastructure we design once and reuse: a **magic-link external-user auth** model (for clients and subs), a **generic `portal_approvals`** table (approval + e-signature record), and **external-user RLS tiers** (`tier_client`, `tier_subcontractor`). Build order: Client Portal (keystone — defines the auth + approvals + dashboard shell) → Proposals/e-sign (quick win, reuses estimates) → Purchase Orders/Bills (biggest schema build, enables sub billing) → Sub portal + sub-contracts + retainage (needs the bills table + external-user auth). Everything here reads existing tables; the new tables are additive and run via the user-pastes-SQL workflow.

## Scope
**Construction variant only.** Lawn competes in a different market (field-service/landscape tools) and is analyzed separately. Construction-only features (sub-contracts/retainage, POs/bills to subs) apply to construction; the client portal and proposals apply to both variants but are specified here for construction.

---

## 1. Unified Client Portal

### What
A single dashboard where the owner/client sees all their projects, outstanding approvals, estimate/CO/invoice status, schedule, photos, messages, and pays — replacing our fragmented token portals.

### Competitors
- **Buildertrend** — unique login, personalized dashboard, **multi-project under one login** (switch via dropdown), global search, Direct Chat / Comments / Messages, upload photos/files/videos, warranty claims, approve appointments, web + mobile app, notification settings, and client-visible budget columns (Original / Revised / Committed / Actual / Projected / Cost-to-Complete).
- **Contractor Foreman** — approve estimates/COs/RFIs/submittals **with an approval trail**; financial summary (contract totals, billed, balance due); shared schedule/daily logs/photo galleries; **access control full or read-only per contact, toggle per project**; multi-project login; online payments (CC/ACH, no account needed).
- **JobTread** — **magic-link** (no app download, no account) opens the portal in a browser; view job-doc status + change history for estimates/COs/invoices; share files/photos; messages; share schedules + assign to-dos; customize per role; collect online payments; eSign proposals.

> **Key nuance:** JobTread's portal is magic-link — the same approach as our token portals. So our gap is **not** "login vs magic-link." It's the **unified dashboard, multi-project switch, approval trail, financial summary, and client-side messaging** that Buildertrend + Foreman have and we don't.

### Our state
Fragmented token portals only (`/q/`, `/invoices/view/`, `/co/`, `/s/`, `/v/`); no dashboard, no multi-project, no approval trail, no financial summary, no client messaging. `customers.email` exists but there is no client auth.

### Proposed build
- **Tables:** `client_users` (id, email, name) + `client_user_customers` (client_user_id, customer_id) — one client user can own many customers/jobs; `portal_approvals` (id, job_id, document_type `'estimate'|'change_order'|'invoice'|'submittal'`, document_id, action `'approved'|'declined'`, signer_name, signature_text, signed_at, ip) — **shared** with Proposals/e-sign; `portal_messages` (id, job_id, client_user_id, body, from_role `'client'|'office'`, created_at).
- **Auth:** magic-link email (no password), reusing the password-reset bearer-token pattern already shipped (`6d4a914`) adapted for client login. A client_user gets a one-time emailed link.
- **Pages:** `/portal` (client dashboard: projects list, outstanding approvals, recent invoices/estimates, balance, schedule summary, messages); `/portal/[jobId]` (single project: estimates/COs/invoices/submittals, photos, schedule, messages, pay).
- **RLS:** new `tier_client` SECURITY DEFINER helper — client_user sees rows where `customer_id` ∈ their `client_user_customers`; `portal_approvals`/`portal_messages` scoped by job_id ∈ their customers' jobs. (SECURITY DEFINER, never a policy subquerying the same table — avoids 42P17 recursion.)
- **Effort:** L. **Dependencies:** external-user auth model (keystone, reused by Sub portal); `portal_approvals` table (reused by Proposals).
- **MVP vs stretch:** MVP = dashboard + approvals + financial summary + per-project doc views (reuse existing token-portal components unified under `/portal`). Stretch = client messaging, cross-org multi-project, client budget visibility.

---

## 2. Proposals / e-sign

### What
A branded, client-ready proposal layer on top of estimates, with e-signature that converts a signed proposal into a contract and feeds job costing.

### Competitors
- **JobTread** — 3-phase: (1) build budget from a pre-built Cost Catalog (set qty, auto-calc price on target margin, drag-and-drop); (2) create the proposal — pick a document template, filter which budget items to include, apply logo/brand colors, configure detail visibility (**line items vs summary**), set dates + tax; (3) send via the Customer Portal magic link — client reviews, **comments, requests changes**, eSigns → proposal becomes a contract → approved budget feeds **job costing + POs + vendor bills**. Supports **phased proposals** from the same budget (Phase 1 / Phase 2).
- **Buildertrend** — clients review and approve Proposals directly from the Client Portal; e-sign by typing or drawing a signature; signed agreement stored in the **Approvals** section; builder controls which proposal features are shared with the client.
- **Contractor Foreman** — Estimates with **electronic signatures** + instant client approval; real-time material/labor pricing via 1build.com or a custom cost library.

### Our state
Estimates with markup/contingency/tax/deposit + public portal `/q/`, but no branded proposal template, no e-sign, no "approved → contract" conversion, no comment/request-changes loop.

### Proposed build
- **Tables:** reuse `estimates` + `estimate_line_items` as the budget source (**no new budget table**). Optional `proposal_templates` (id, org_id, name, logo_url, accent_color, show_line_items bool, sections jsonb) for MVP. Record the signature in the shared `portal_approvals` table (document_type='estimate'). Set `estimates.status = 'approved'` (already an allowed value: draft/sent/approved/converted/rejected) on e-sign, and add `estimates.signed_proposal_url` (stored signed PDF). **No new status enum value needed** — 'approved' already exists.
- **Pages:** office `/admin/estimates/[id]/proposal` (pick template, toggle line-item vs summary, attach photos/plans, send to client via portal); client `/portal/[jobId]/proposal/[estimateId]` (branded view, comment/request-changes, **e-sign widget — type or draw**, Approve → status='approved', generate + store signed PDF).
- **RLS:** client signs only estimates on their jobs (via `tier_client`); office OFFICE_OR_PM sends.
- **Effort:** M. **Dependencies:** Client Portal (the proposal lives in the portal); `portal_approvals` table.
- **MVP vs stretch:** MVP = branded view + e-sign (type + draw) + `status='approved'` + signed PDF. Stretch = comment/request-changes loop, phased proposals, template library, approved-budget → PO auto-feed.

---

## 3. Purchase Orders / Bills

### What
Outgoing commitments to subs/vendors (POs with quantities, cost codes, delivered/billed tracking) and incoming bills (sub/supplier invoices), with PO→bill linking and a bill approval workflow.

### Competitors
- **Buildertrend** — POs created from scratch / change orders / bids / selections / estimates; POs **sent to subs/vendors for electronic review + e-sign**; approved POs can be **amended without recalling** (Version History, reapproval for modified portions); bills from scratch / an existing PO / the **Cost Inbox** (uploaded receipts); **OCR auto-fill bill from file** (title, vendor, dates, cost items); link bills to POs; **bill approvers** move a bill In Review → Ready for Payment; PO suffix feature aids QuickBooks reconciliation.
- **Contractor Foreman** — **generate a bill from a PO with one click** (partial bills tracked automatically); **delivered vs billed quantity tracking** (staged billing / partial shipments); pricing requests to vendors via email (no vendor account); Kanban by status (waiting on vendor / approvals / deliveries).
- **JobTread** — convert bids → POs/work orders with one click; send to suppliers/subs for **acceptance + eSign**; collect eSignatures on payment terms; track outstanding payables.

### Our state
**Zero POs, zero bills.** We have `receipts` (material expenses) + a `subcontractors` table but no commitment or incoming-invoice model. This is the biggest schema addition of the NOW tier.

### Proposed build
- **Tables:** `purchase_orders` (id, org_id, job_id, vendor_id → reuse `subcontractors` for MVP (or add a `vendors` table later), status `'draft'|'sent'|'approved'|'billed'|'closed'`, cost_code_id, notes, created_by) + `purchase_order_lines` (po_id, description, qty, unit_cost, amount, delivered_qty, billed_qty); `bills` (id, org_id, job_id, vendor_id, po_id nullable, sub_contract_id nullable, amount, status `'received'|'in_review'|'ready_for_payment'|'paid'`, due_date, attachments jsonb, approver_id). Link bill → PO and bill → sub_contract.
- **Pages:** `/admin/po` (list + Kanban by status), `/admin/po/[id]` (detail, send-to-vendor email, accept/e-sign stub, amend); `/admin/bills` (list, upload receipt, link to PO, approval workflow In Review → Ready).
- **RLS:** OFFICE_OR_PM create/approve; vendor sees own PO via portal (`tier_vendor`, stretch).
- **Effort:** L. **Dependencies:** vendor model (reuse `subcontractors` for MVP); QB sync extension to push bills/expenses (our one-way sync already pushes invoices/customers — bills are a new push object).
- **MVP vs stretch:** MVP = POs + lines + bills + PO→bill link + basic approval status. Stretch = vendor e-sign acceptance, bill OCR auto-fill, PO version history/amendments, QB bill sync.

---

## 4. Subcontractor portal + subcontractor invoicing + sub-contracts with retainage

### What
Subs get a portal (their sub-contracts, COs, POs/bills, compliance docs, schedule); subcontractor invoicing (sub submits bills, GC compares to PO/sub-contract); sub-contracts with retainage (commitment amount, retainage %, auto-calc, single-click bill creation).

### Competitors
- **Buildertrend** — Sub Portal (**free for subs**): scheduling access, review/approve POs + e-sign, outstanding POs, **lien waivers**, change orders, document mgmt + version control, in-platform messaging, daily logs + tasks, warranties.
- **Contractor Foreman** — Sub-Contracts: create from Bid Manager one-click, import estimate items, **retainage set once per sub** (auto-calc, prevents overpayments), single-click bill creation, Kanban, custom fields.
- **JobTread** — Vendor/Sub Mgmt: digital bid requests, send POs/work orders, eSign, tasks + scheduling, share photos/daily logs, payables tracking, **vendor compliance (COI + licenses tracking)**.

### Our state
`subcontractors` table (basic), no sub portal, no sub invoicing, no sub-contracts, no retainage. Customer notifications exist; no sub-side.

### Proposed build
- **Tables:** `sub_contracts` (id, org_id, job_id, subcontractor_id, amount, retainage_pct, status `'draft'|'sent'|'signed'|'billed'|'closed'`, scope text, from_bid bool) + `sub_contract_lines` (sub_contract_id, description, qty, unit_cost, amount; importable from estimate/cost items). **Retainage auto-calc:** retained = amount × retainage_pct; billable now = amount − retained − previously_billed. Sub bills reuse the `bills` table (vendor_id = subcontractor_id, sub_contract_id link).
- **Auth:** `sub_users` (id, email, name, subcontractor_id) magic-link, same pattern as `client_users`.
- **Pages:** `/sub` (sub portal: their sub-contracts, COs, POs, bills, compliance-docs placeholder, schedule); `/admin/subcontracts` (list, create from estimate/bid, set retainage, single-click bill).
- **RLS:** `tier_subcontractor` — sub_user sees rows where `subcontractor_id` = their `sub_users.subcontractor_id`; office OFFICE_OR_PM.
- **Effort:** L. **Dependencies:** `bills` table from POs/Bills (#3); external-user auth pattern from Client Portal (#1); subcontractor email (add column if missing).
- **MVP vs stretch:** MVP = sub_contracts + retainage calc + sub bills + sub portal (read + bill submit). Stretch = sub e-sign on the sub-contract, compliance docs (COI/W9 — that's the NEXT-tier "sub compliance" item), sub messaging.

---

## Shared Infrastructure (design once, reuse across all four)
- **External-user auth:** magic-link bearer-token login (reuse the password-reset pattern `6d4a914`) for BOTH `client_users` and `sub_users`. No passwords.
- **`portal_approvals` table:** generic approval/signature record (document_type + document_id + signer + signature + timestamp + ip). Reused by Client Portal approvals + Proposals/e-sign + (later) CO e-sign.
- **RLS external-user tiers:** `tier_client`, `tier_subcontractor` as SECURITY DEFINER helpers (never a policy subquerying the same table → avoids 42P17 recursion).
- **Per-document views:** keep the existing token portals working; unify them under the `/portal` and `/sub` dashboards.

## Sequencing
1. **Client Portal** — keystone: defines external-user auth + `portal_approvals` + the dashboard shell that Proposals live in.
2. **Proposals/e-sign** — needs #1 + `portal_approvals`; quick win, reuses estimates → fastest visible value.
3. **Purchase Orders/Bills** — independent biggest schema build; enables sub billing.
4. **Sub portal + sub-contracts + retainage** — needs #3's `bills` table + #1's external-user auth pattern.

## Effort Summary

| Feature | Effort | Dependencies | MVP scope |
|---|---|---|---|
| Client Portal | L | External-user auth; `portal_approvals` | Dashboard + approvals + financial summary + per-project doc views |
| Proposals/e-sign | M | Client Portal; `portal_approvals` | Branded view + e-sign (type/draw) + `status='approved'` + signed PDF |
| Purchase Orders/Bills | L | Vendor model; QB sync extension | POs + lines + bills + PO→bill link + approval status |
| Sub portal + sub-contracts + retainage | L | `bills` table; external-user auth | sub_contracts + retainage calc + sub bills + sub portal (read + bill submit) |