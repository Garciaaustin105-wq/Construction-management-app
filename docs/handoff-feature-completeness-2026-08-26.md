# Handoff — feature-completeness audit, remaining items

**2026-08-26 · branch `feat/feature-completeness` (off `feat/feature-integration-fixes`)**
**Focus: launch the LAWN variant and start generating money.**

The audit lives at `docs/audit-feature-completeness-2026-08-26.md` — every gap
below is evidenced there with file:line or live SQL. This doc is the
**delegation plan**: what's done, what's left, what Claude-direct keeps, what
gets built against a contract by Opus / local AI.

---

## Delegation rules (do not cross these)

- **Claude-direct (do NOT hand off):** SQL migrations, RLS, `auth.*`, role
  gating, server route logic (especially decide/send/payment/cron), export
  endpoints, schema constraints, E2E verification of money/auth paths.
- **Opus / local `gpt-oss` (build against the contract):** UI components,
  buttons, modals, status badges, email/SMS template copy + markup, non-gating
  display logic.
- **Contract-first:** before Opus builds an item, the matching `src/lib/*.ts`
  contract file is written (by Claude) and committed, so the sensitive shape is
  fixed and Opus wires UI to it — not the other way around. Contract files are
  written **per-item when that item starts**, not all upfront (saves tokens).
- **Local AI refuses** `sql/rls/auth/security` tasks — don't route those there.

---

## DONE this session (verified)

| § | item | commit | verification |
|---|------|--------|--------------|
| 3.2 | Guard approved time entries | `ba7fc2e` | RLS live (`pg_policies` confirmed `status IS DISTINCT FROM 'approved'` on crew update+delete); UI gated; tsc 0 |
| 1.1 | Overdue invoice reminder cron | `a40d9f4` | route + `deliverInvoice.skipSentAtStamp` + `vercel.json` cron; tsc 0; live filter query clean (0 overdue, pre-launch) |
| 6 | Notification feed icon cases | `5319891` (with §2.2) | added review_feedback/new_lead/lead_stale/invoice_payment_failed; tsc 0 |
| 2.2 | Exclude rejected time from JobBudget | `5319891` | `.in("status",["approved","pending"])`; tsc 0 |
| 4 | Pesticide compliance (license gate + re-entry notice) | `5d883c4` | contract `lawnApplicator.ts` + route 400 on block + `ApplicatorLicenseBadge` (gpt-oss, zero fix-up) + `customerNotifications.reEntryNotice` + status-route re-entry query + seed for new orgs; tsc 0 |
| 5.3 | Lead → estimate link + auto won/lost sync | `2f930cb` | `leads.estimate_id` + DB trigger `trg_sync_lead_from_estimate` (path-agnostic covers authed RPCs + public /decide) LIVE; `leads.ts linkEstimateToLead`; `LinkEstimateToLead.tsx` (gpt-oss, zero fix-up) wired into LeadDetailDrawer; tsc 0 |
| 1.3 | Estimate expiry enforcement | `3d2102d` | `estimates_status_check`+`expired` LIVE; cron `/api/estimates/cron/expire` (13:37, construction-owned gate) + `/decide` 410 race-defense + `/q/[token]` expired banner; DEFERRED re-issue-at-current-pricing; tsc 0 |
| 5.1 | Paused-visit un-pause | `a607d6a` | lifecycle `paused→pending` (existing Reopen button + /status route cover it, no notify on resume) + `bulk-resume` resumes paused visits with due_date≥resume_from (past stays as record) + `resumed_visits` count toasted + `lawn_visits_status_check` CHECK LIVE; tsc 0 |

All on `feat/feature-completeness`. Not merged to `main`, not deployed.

---

## Remaining — by lawn-launch priority

### P1 · §4 Pesticide compliance (legal liability, lawn-specific) — RECOMMENDED NEXT

**Gap (audit §4):** an application can be logged under an applicator whose
license is expired/absent, and the re-entry interval is shown only to the office
— the homeowner with kids/dog never receives it.

**Sensitive (Claude-direct):**
- `/api/lawn/applications/route.ts`: validate applicator eligibility before
  insert. Block (or hard-warn + flag the row) when no license or expired.
- Wire the re-entry interval into the customer `service_complete` notification:
  `src/lib/customerNotifications.ts` payload + the `service_complete` template
  gets a `{{re_entry_until}}` token (seeded template update = SQL).
- Dashboard expiry warning ahead of date is a gated read — keep the query.

**Delegatable (Opus/local):**
- Office "expiring soon" license badge/dashboard widget (display only).
- Customer portal visit row rendering of the re-entry window.

**Contract to write first:** `src/lib/lawnApplicator.ts`
```ts
export type ApplicatorEligibility = {
  ok: boolean;
  severity: "block" | "warn";   // block = refuse the application; warn = log + flag
  reason: string;              // "no license" | "license expired YYYY-MM-DD" | ""
};
export function checkApplicatorEligibility(input: {
  licenseNumber: string | null;
  licenseExpires: string | null;   // ISO date
  today?: string;                   // ISO date, default new Date() — injected for tests
}): ApplicatorEligibility;
```
The route calls this; the office dashboard widget reuses it. (Decision needed:
**block vs warn** — see Open questions.)

**Files:** `src/app/api/lawn/applications/route.ts`, `src/lib/customerNotifications.ts`,
`src/components/ChemicalApplicationsManager.tsx`, seeded notification templates (SQL),
`src/components/CrewMembersManager.tsx` (badge already exists — verify).

---

### P1 · §5.3 Lead → estimate link (lawn CRM funnel is a headline differentiator)

**Gap (audit §5.3):** `leads.status` has `quoted` but no lead→estimate link;
conversion creates a customer and stops; nothing moves a lead to `won`/`lost`
when the estimate is approved/rejected. The board is hand-maintained → wrong
within a month.

**Sensitive (Claude-direct):**
- SQL: `alter table leads add column estimate_id uuid references estimates(id);`
  add `won`/`lost` to `leads_status_check` if absent.
- `src/lib/leads.ts`: `createEstimateFromLead(leadId, {origin})` — creates an
  estimate (draft) from the lead, stamps `leads.estimate_id`, moves lead to
  `quoted`. The estimate decide path (already gated) updates the lead to
  `won`/`lost` on approval/rejection — wire this in the decide route.
- RLS: ensure crew/office can't write `estimate_id` arbitrarily — gate via the
  lib function (SECURITY DEFINER if needed).

**Delegatable (Opus/local):**
- Lead board: "Create estimate" action per `quoted`/`new` lead; won/lost badge
  rendering; the board columns reflecting new statuses.

**Contract to write first:** `src/lib/leads.ts` (extend existing)
```ts
export async function createEstimateFromLead(
  leadId: string,
  opts?: { origin?: string }
): Promise<{ estimateId: string }>;
// decide route (approved/rejected) calls:
export async function syncLeadFromEstimateDecision(estimateId: string): Promise<void>;
```

**Files:** `src/lib/leads.ts`, `src/app/api/estimates/by-token/[token]/decide/route.ts`,
lead-board UI (find via `src/app/admin/leads`), SQL migration.

---

### P2 · §5.1 Paused lawn visit can't un-pause (seasonal dead-end)

**Gap (audit §5.1):** `LAWN_VISIT_TRANSITIONS.paused = []` and `bulk-resume`
leaves paused visits as-is → winter-paused visits clutter the calendar forever.

**Sensitive (Claude-direct):**
- `src/lib/lifecycles/lawn-visit.ts`: allow `paused → pending` (resume).
- Route to resume a single paused visit (extend the visit status route or add
  `/api/lawn/visits/[id]/resume`); keep the same_org + assignment guards.
- `bulk-resume` route: also resume paused visits (or add a separate
  "resume paused" bulk action) — the current "leave paused as-is" is the bug.
- `lawn_visits.status` is the only status column with no CHECK — add one
  (enum of valid statuses) so a bad write is caught. (Audit flags this.)

**Delegatable (Opus/local):**
- "Resume" button on paused visit rows (calendar + visit list).
- Bulk "resume paused" control next to bulk-pause.

**Contract to write first:** `src/lib/lifecycles/lawn-visit.ts` (modify transitions)
```ts
LAWN_VISIT_TRANSITIONS.paused = ["pending"];   // resume
// plus a canTransition helper used by the route AND the UI button
```

**Files:** `src/lib/lifecycles/lawn-visit.ts`, `src/app/api/lawn/schedules/bulk-resume/route.ts`,
visit status route, calendar/visit-list UI, SQL (status CHECK).

---

### P2 · §1.2 Invoice draft status + line-item editing (money-path friction)

**Gap (audit §1.2):** invoices are write-once (no draft status; line items
inserted in 3 places, updated in none). An office typo is only fixable by
void+recreate, leaving the customer with two documents.

**Sensitive (Claude-direct):**
- SQL: add `draft` to `invoices_status_check`; decide the new default
  (`'draft'` changes the meaning of every existing insert — audit carefully;
  existing rows are `'sent'`). Gate line-item mutate to `status='draft'` (or
  unpaid + no sent_at — define precisely).
- `src/lib/invoiceLineItems.ts`: `upsertLineItem`, `deleteLineItem` with the
  status gate enforced server-side (RLS or SECURITY DEFINER).
- The estimate→invoice and change-order→invoice converters create `draft` not
  `sent`; the office "Send" action flips `draft → sent` (uses existing
  `deliverInvoice`, which already stamps `sent_at`).

**Delegatable (Opus/local):**
- Line-item editor UI (add/edit/delete rows) on the invoice detail page.
- "Save as draft" vs "Send" button flows in `NewInvoiceForm.tsx`.

**Contract to write first:** `src/lib/invoiceLineItems.ts`
```ts
export async function upsertLineItem(invoiceId, item): Promise<LineItem>;
export async function deleteLineItem(invoiceId, lineItemId): Promise<void>;
// both throw if invoice.status not in ('draft') — server-enforced
```

**Files:** `src/lib/invoiceLineItems.ts` (new), `NewInvoiceForm.tsx`, invoice
detail page, estimate→invoice + CO→invoice converters, SQL migration.

---

### P2 · §1.3 Estimate expiry enforcement (margin protection)

**Gap (audit §1.3):** `estimates.valid_until` is decorative; a customer can
accept a six-month-old price and the app builds the invoice at that price.

**Sensitive (Claude-direct):**
- `/api/estimates/by-token/[token]/decide/route.ts`: reject when
  `valid_until < today` (return 410 Gone / "estimate expired").
- SQL: add `expired` to `estimates_status_check`; a cron flips `sent → expired`
  when `valid_until < today` (pattern: `lawn/cron/remind`).
- "Re-issue at current pricing" = office action that clones the expired
  estimate's lines at current rates → new `sent` estimate (route = sensitive).

**Delegatable (Opus/local):**
- Expired state display on the proposal page (customer sees "this estimate has
  expired" instead of the accept button).
- Office "Re-issue" button.

**Contract:** the decide-route gate (a date check) + a `reissueEstimate`
server function. No new `src/lib` file necessarily; extend the estimates lib.

**Files:** `decide/route.ts`, estimates cron (new), estimates lib, SQL migration,
proposal + admin estimate UI.

---

### P3 · §1.5 Payment reversal (Connect customer payments, lawn-only, edge case)

**Gap (audit §1.5):** `payments` has no delete/reverse path; a manual payment
entered wrong is unfixable from the UI.

**Sensitive (Claude-direct):**
- SQL: soft-reverse — `alter table payments add column reversed_at timestamptz,
  reversal_of uuid, reason text`; a reversal inserts a negative-mirror row
  (or stamps `reversed_at`) and adjusts `invoices.amount_paid`. **Accounting
  sync implications** — a reversal must push a correcting entry to QBO/Xero/
  FreshBooks (one-way sync already shipped). Keep the sync call in the lib.
- `src/lib/payments.ts`: `reversePayment(paymentId, {reason})` — server-only,
  recalculates invoice balance, fires accounting sync.
- Route: `POST /api/payments/[id]/reverse` (office-only).

**Delegatable (Opus/local):** "Reverse payment" button + confirm modal on the
invoice detail page.

**Contract to write first:** `src/lib/payments.ts` (extend existing)
```ts
export async function reversePayment(
  paymentId: string,
  opts: { reason: string }
): Promise<{ reversed: boolean; newBalanceDue: number }>;
```

**Files:** `src/lib/payments.ts`, `src/app/api/payments/[id]/reverse/route.ts` (new),
invoice detail UI, SQL migration, accounting sync hook.

---

### P3 · §7 small gaps (line each)

- **Delete paths** for `daily_logs`, `submittals`, `recurring_schedules`,
  `chemical_applications` — or a correction mechanism if append-only is
  intended. Decision per table.
- **`estimate_template_items.organization_id` has no FK** — add the FK
  constraint (SQL, Claude-direct).
- **`purge_rate_limits()` never scheduled** — add a cron (pattern: existing
  crons) or a Vercel cron entry; keep the function read-only-safe.

---

## Suggested sequence (lawn launch + money)

1. **§4 pesticide** — legal liability on day one of chemical apps. Small.
2. **§5.3 lead→estimate** — closes the lawn CRM funnel (headline differentiator).
3. **§1.3 estimate expiry** — protects margin; small route gate + cron.
4. **§5.1 paused-visit un-pause** — seasonal UX; not a summer-launch blocker.
5. **§1.2 invoice draft + editing** — money-path friction; bigger migration.
6. **§1.5 payment reversal** — edge case; bigger (accounting sync).
7. **§7 small gaps** — opportunistically.

## Open questions (need a human call)

- **§4 block vs warn:** refuse the application when the applicator's license is
  expired/missing, or log + flag the row? Block is safer legally; warn keeps
  the crew unblocked in the field. Recommendation: **block**, with an office
  override (licensed applicator reassigns).
- **§1.2 default status:** flip new invoices to `draft` by default? Existing
  rows stay `sent`. Confirm the office "Send" step is the intended gate.
- **§7 append-only vs delete:** which of daily_logs/submittals/etc. are truly
  append-only (need a correction entry) vs deletable?

## State

- Branch `feat/feature-completeness` has 7 commits beyond `feat/feature-integration-fixes`.
- Nothing merged to `main`; nothing deployed. Vercel cron entries for
  `/api/invoices/cron/remind` + `/api/estimates/cron/expire` only activate after
  merge to `main` + deploy.
- RLS migration `time_approved_guard`, `leads_estimate_link`, `estimates_expired_status`,
  and `lawn_visits_status_check` are **live** on the DB (applied via Supabase);
  the repo SQL files are the record of them.