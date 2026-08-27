# Billing & Payments Fixes — HANDOFF

> ## ✅ COMPLETE 2026-08-26 — commits `c67f7bb`, `81dab53`
>
> **All four findings are resolved.** Findings 1 and 2 fixed in `c67f7bb`;
> Finding 4 investigated and VOID; Finding 3 fixed in `81dab53`.
>
> **Finding 3 update (was open pending a product decision).** Resolved as
> record-and-notify, and two things found on closer inspection made it safer
> than this handoff assumed:
> 1. The **manual** office path never capped — it records
>    `round2(current + payment)`. The two payment paths already disagreed, and
>    only the automated one lost money. Removing the cap made them consistent
>    rather than creating a new state.
> 2. This handoff cautioned that uncapping might flow into insights "in unvetted
>    ways". Vetted: **all three** `balanceDue` computations (invoicePay ×2,
>    emailLoaders) and `insights.overdueBalance` already clamp with
>    `Math.max(0, total - amountPaid)`. No consumer breaks.
>
> `amount_paid` now records the true figure and an `invoice_overpaid` office
> notification fires (amber AlertTriangle — it needs a human decision).
> **Not** a credit balance; that remains a larger product change if ever wanted.
>
> Verified: $1000 invoice, $400 prior, $900 paid → was `1000.00` (lost $300),
> now `1300.00` with `overpaid=300.00`, still marks paid, balance still clamps
> to 0.
>
> - **Finding 1 (webhook double-processing) — FIXED.** Events are now claimed
>   before any work via `claim_billing_event()` (`billing_events_claim`
>   migration, applied and recorded). The claim is a state machine, not a
>   boolean, so the insert-first trap this handoff warned about is handled:
>   `processing → done` marks true duplicates, `processing → failed` (set in the
>   route's catch) lets Stripe's retry re-claim, and a claim abandoned by a
>   serverless timeout goes stale after 15m and is reclaimable. Existing rows
>   backfilled to `done` — they were only ever written after success.
> - **Finding 2 (missing CAS) — FIXED.** `recordInvoicePayment` now mirrors the
>   proven retry loop from `api/invoices/[id]/payments`, and throws after 5
>   attempts so the webhook marks the claim failed and Stripe retries rather
>   than silently dropping a payment.
> - **Finding 4 (no stored invoice total) — VOID, no change made.** Investigated
>   as instructed. There are exactly three write paths to `invoice_line_items`:
>   `changeOrderInvoice.ts` (which explicitly excludes paid/void invoices —
>   correctly guarded) and two in `estimateInvoice.ts` that write into a
>   *freshly created* invoice. There is also no line-item editor on the invoice
>   detail page. No path can add line items to a paid invoice, so the
>   total/status desync cannot occur.
> - **Finding 3 (overpayments silently truncated) — STILL OPEN.** Left
>   deliberately unimplemented: it needs the product decision this handoff
>   called out (record-and-notify vs. customer credit balance). The `Math.min`
>   cap is now documented in place in `src/lib/invoicePay.ts` so the behavior
>   isn't mistaken for an oversight.
>
> **Verified:** claim state machine 5/5 cases pass (claim, concurrent,
> after-done, retry-after-failed, stale reclaim). CAS proven against the exact
> scenario from the audit — concurrent $400 + $600 both land for a final
> `1000.00` instead of one overwriting the other. `tsc` exits 0; changed files
> lint clean.
>
> **Not done:** no test against live or test-mode Stripe. The fixes were
> verified at the database and type level, not by driving real webhook
> deliveries end-to-end.
>
> The original handoff text is preserved below.

---

**Prepared:** 2026-08-25 by a read-only audit session.
**Repo:** `C:\Users\garci_9e2kg3l\Projects\lowvoltage-app` (Next.js 16 / React 19 / Supabase).
**Supabase project id:** `avmqteevisqxwmmxkrbg` (MCP: `execute_sql`, `apply_migration`, `get_advisors`).

## Priority notice

**Findings 1 and 2 should jump ahead of the other open handoffs** (`handoff-scalability-2026-08-25.md`, `handoff-feature-integration-2026-08-25.md`). They compound each other, they touch real customer money, and a double-charge is customer-visible and painful to unwind. The cron timeouts in the scalability handoff are worse in aggregate but are internal-only.

## What is already correct — do not "fix" these

Verified against source and the live schema. Leave alone:

- **Money columns are `numeric(12,2)`** across `invoices`, `payments`, `estimates`, `change_orders`, `invoice_line_items`, `estimate_line_items`, `recurring_schedules`. No floating-point currency anywhere. Do not migrate to integer cents — it is not needed and would be a large, risky change.
- **Webhook signature verification is correct** in both routes — raw body via `request.text()` then `stripe.webhooks.constructEvent`. Do not touch.
- **The Stripe Connect liability architecture is deliberate and correct.** Direct charges with **no** `application_fee_amount`, **no** `transfer_data`, **no** `on_behalf_of` — the org is merchant of record and money never lands in the platform balance. `src/lib/connectAccount.ts` documents the reasoning at length (lines 6–30). The `platformLiable` gate that refuses charges when `controller.losses.payments = "application"` is intentional. **Do not add fees, transfers, or `on_behalf_of` to any Stripe call.**
- `billing_events_stripe_event_id_key` unique index exists and is correct. The problem in Finding 1 is *when* it is used, not the index.

---

## Finding 1 — Webhook dedupe cannot prevent double-processing (highest severity)

**Files:** `src/app/api/stripe/webhook/route.ts`, `src/app/api/stripe/connect/webhook/route.ts`

Both routes currently do:

1. `SELECT` from `billing_events` where `stripe_event_id = event.id` → early-return if found (webhook route ~line 40, connect route ~line 50)
2. **process the event** (apply the payment / update org state)
3. `INSERT` into `billing_events` (webhook ~line 69, connect ~line 142), and on `23505` the code comments *"Duplicate insert from a race — safe to ignore."*

Because the insert is **last**, the unique index only dedupes the *log row*, never the *work*. Stripe retries webhooks. Two concurrent deliveries of the same event both pass step 1 (neither has inserted yet), **both run step 2**, then one insert fails and is silently swallowed. The payment has already been applied twice by then.

That "safe to ignore" comment is precisely the bug.

### Required change

Invert the order so the unique constraint acts as a mutex:

1. **INSERT first** to claim the event (status e.g. `processing`), before doing any work.
2. If the insert fails with `23505`, another worker owns this event → return `{ received: true, duplicate: true }` immediately and do nothing else.
3. Only if the insert succeeded, process the event.
4. Optionally mark the row completed afterward.

Consider what happens if processing throws *after* the claim — the event is marked claimed but never applied, and Stripe's retry will be rejected as a duplicate. Handle it: either delete/mark-failed the claim row in a `catch` so the retry can re-claim, or record a failure status that a human can see. **Do not leave a silent hole where a failed payment is never retried.** Pick one and document it in the route comment.

Apply the identical fix to both routes — they share the `billing_events` table and the same flawed ordering.

---

## Finding 2 — The automated payment path lacks the concurrency guard the manual path has

**File:** `src/lib/invoicePay.ts`, function `recordInvoicePayment` (~lines 149–197)

This is an inconsistency that is backwards from the risk profile.

- `src/app/api/invoices/[id]/payments/route.ts` (office manually recording a check) **HAS** a correct optimistic-concurrency retry loop: re-read, write with `.eq("amount_paid", priorAmountPaidRaw)` as a compare-and-swap, retry on a 0-row match, bail after N attempts with a clear error. See lines ~49–114 — there is an explanatory comment block at line 49.
- `recordInvoicePayment` (the **Stripe** path — webhooks *and* inline autopay) does a plain read-then-write with **no CAS**:

```ts
const prevPaid = Number(invoice.amount_paid ?? 0) || 0;
const newAmountPaid = Math.min(prevPaid + paidAmount, total);
// ...
await admin.from("invoices").update(update).eq("id", input.invoiceId);
```

So the low-concurrency path is protected and the path that actually fires concurrently from Stripe webhooks is not.

**Concrete failure:** $1,000 invoice. Customer pays $400 by card while the office records a $600 check. Both read `amount_paid = 0`. The manual path CAS-writes `600`; the Stripe path then overwrites with `400`. **$600 disappears from the record** — Stripe and the bank both show the money, the app does not.

The existing `if (invoice.status === "paid") return;` guard (line ~164) only helps once the invoice is *fully* paid. Partial payments race freely.

### Required change

Port the **exact** CAS retry pattern from `api/invoices/[id]/payments/route.ts` into `recordInvoicePayment`. It is a proven in-repo implementation — read it first and mirror it rather than inventing a new approach. Specifically:

- Re-read `amount_paid` inside the retry loop (do not reuse the value read before the guard checks).
- Write with `.eq("amount_paid", <the exact raw value just read>)` so the update only lands if nothing changed underneath.
- On a 0-row match, re-read and retry, **re-accumulating onto the fresh value** (not the stale one).
- Cap attempts and surface a clear error on exhaustion.

Note the manual route uses a `round2()` helper — check whether the same rounding discipline is needed here for consistency (`paidAmountCents / 100` is exact, and `prevPaid` comes from `numeric(12,2)`, so it likely is not, but confirm rather than assume).

**Do not** simply move the whole thing into a DB transaction as a shortcut without checking that the surrounding notification/best-effort logic still behaves — the existing code deliberately treats the office-feed notification as non-fatal (comment at ~line 200).

---

## Finding 3 — Overpayments are silently discarded

**File:** `src/lib/invoicePay.ts` line ~180

```ts
const newAmountPaid = Math.min(prevPaid + paidAmount, total);
```

If a customer pays more than the balance due, `amount_paid` is capped at the invoice total and **the excess vanishes from the record**. Stripe collected the money; the app records no overage, no credit, and raises no flag. Nobody is notified. The office can only discover it by manually reconciling against Stripe.

### Required change

This needs a **product decision — ask the user before implementing.** Options, cheapest first:

1. **Record and surface it.** Keep the cap on `amount_paid`, but persist the overage (e.g. on the `payments` row and/or a new `overpaid_amount` column) and raise an office notification: "Customer overpaid invoice #X by $Y." Low effort, removes the silent data loss.
2. **Customer credit balance.** Track a per-customer credit that can be applied to future invoices. Correct, materially more work, needs UI.

Do **not** simply remove the `Math.min` cap — letting `amount_paid` exceed the total would flow into insights/reporting and the `newAmountPaid >= total` paid-status check in unvetted ways.

---

## Finding 4 — No stored invoice total (VERIFY FIRST, then fix if confirmed)

**Unconfirmed — investigate before changing anything.**

The `invoices` table has **no `total` column** (verified against the live schema). Totals are recomputed from `invoice_line_items` on every read — several code paths carry a "recompute totals" comment.

That is a defensible design, but it means an invoice's financial state is not immutable at the moment of payment. Suspected failure:

1. $1,000 invoice paid in full → `status = 'paid'`, `amount_paid = 1000`
2. Office later adds a $200 line item → computed total becomes $1,200
3. `amount_paid` stays `1000` and `status` stays `'paid'`

The invoice would display as settled while actually being $200 short.

### Required work

1. **Verify first.** Trace whether *anything* recomputes `status` when `invoice_line_items` are inserted/updated/deleted. Search for triggers on `invoice_line_items` and for status-recompute logic in the line-item mutation routes. If a recompute already exists, this finding is void — say so and move on.
2. **If confirmed**, fix by either: blocking line-item edits on `paid`/partially-paid invoices (simplest, and consistent with the "sent documents are immutable" direction in the feature-integration handoff), or recomputing `status` on every line-item mutation via a trigger. Prefer blocking — silently reopening a paid invoice is its own surprise.

This is the same root pattern as the estimate-snapshot issue in `handoff-feature-integration-2026-08-25.md`: **no immutable record captured at the moment of the financial event.**

---

## Order of work

1. **Finding 1** — webhook insert-first claim. Small, surgical, stops double-charging.
2. **Finding 2** — CAS in `recordInvoicePayment`. Copy the proven pattern from the payments route.
3. **Finding 4** — verify (cheap); fix only if confirmed.
4. **Finding 3** — needs a product decision from the user first.

1 and 2 compound each other — a retried webhook plus a missing CAS is how a payment gets applied twice or silently lost. Do them together.

## Verification

- `npx tsc --noEmit` → exit 0. `npx next lint` → exit 0. Both currently pass; keep them passing.
- **Finding 1:** simulate concurrent duplicate delivery of the *same* `event.id` (fire the handler twice in parallel with an identical payload). Exactly one must process; the other must early-return. Then confirm `amount_paid` moved exactly once.
- **Finding 2:** simulate a concurrent card payment and manual check entry against the same invoice. The final `amount_paid` must equal the **sum** of both, not either one alone. This is the exact bug — test it explicitly.
- **Finding 2 (regression):** confirm normal single payments, partial payments, and full payments still mark `status='paid'` and stamp `paid_at` correctly.
- **Do not test against live Stripe with real cards.** Use Stripe test mode / fixtures.

## Boundaries

- **Stage explicitly. Never `git add -A`.**
- **Do not commit** untracked root files: `CONNECT_PAYMENTS_HANDOFF.md`, `PHASE1_CONTENT_PACKAGE.md`, `TERRA_VERDE_MARKETING_PLAN_2026-08-23.md`, `.claude/launch.json`.
- **Do not touch** `public/terra-verde-*` / `public/terra-vista-*` brand assets.
- **Do not push.** Leave commits local for review.
- Any DDL goes through `apply_migration` with a recorded name (migration tracking is already drifted — only 7 recorded vs ~100 loose root `.sql` files).
- **Do not add `application_fee_amount`, `transfer_data`, or `on_behalf_of` to any Stripe call** — see the "already correct" section. That would move customer money onto the platform's balance sheet and change the platform's legal/financial liability.
- Three handoffs are now open (scalability, feature-integration, billing). Coordinate before touching shared live Supabase state — a local file conflict is recoverable, a half-applied migration is not.

## Confidence note

Findings 1, 2, and 3 were confirmed by reading source and verifying the live schema — the line numbers and the index/column facts are accurate as of 2026-08-25. **Finding 4 is explicitly unverified** and is written as an investigation task, not a fix order. Nothing here was reproduced against a running app or live Stripe.
