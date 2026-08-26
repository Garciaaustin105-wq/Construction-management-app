# Feature-completeness audit — what's missing to close each loop

**2026-08-26. Read-only audit; nothing was changed.**

The question this answers is not "does the feature exist" but **"can a real
office finish the job inside it, or do they have to leave the app?"** Every
finding below was verified against the code or the live schema — file/line or
SQL is cited so nothing here has to be taken on trust.

Ordering is by consequence, not by feature. The money and compliance loops come
first because those are the ones that cost something real when they're open.

---

## 1. The money loop never closes

### 1.1 There is no invoice reminder. At all.

`/admin/insights` computes an **Overdue A/R** tile
(`src/app/admin/insights/page.tsx:259`) and the invoices-by-status chart counts
overdue invoices (`:302`). So the app *knows* exactly which invoices are late —
and does nothing with it. There is no reminder email, no dunning schedule, no
"3 days overdue" nudge. The Stripe Connect webhook says so outright:

> `src/app/api/stripe/connect/webhook/route.ts:107` — "No auto-dunning v1: leave
> the invoice 'sent'…"

Grep for `reminder|dunning|nudge` across `src/lib` and `src/app/api` returns
**only** the lawn *visit* reminder and the stale-*lead* nudge. Invoices have
neither.

**What's missing:** a daily cron (the pattern already exists —
`lawn/cron/remind`) that finds `status='sent' and due_date < today`, respects a
per-org cadence, sends via the existing `deliverInvoice` path, and logs to
`notification_log` so it can't double-send. This is the highest-value gap in the
app: it is the difference between invoicing software and getting paid.

### 1.2 Invoices are write-once

`invoice_line_items` is **inserted in three places and updated in none.** The
only writers are `NewInvoiceForm.tsx:155`, the estimate→invoice conversion, and
the change-order→invoice conversion. There is no update and no delete anywhere
in `src`.

Compounding it, the status domain has no draft:

```sql
invoices_status_check CHECK (status = ANY (ARRAY['sent','paid','void']))
```

So an invoice is "sent" the moment it exists — there is no staging state — and
once it exists you cannot fix a typo, a wrong quantity, or a wrong price. The
only correction path is **void and re-create**, which leaves the customer
holding two documents and a voided number.

**What's missing:** a `draft` status, and a line-item editor gated to
`status='draft'` (or to unpaid).

### 1.3 Estimate expiry is decorative

`estimates.valid_until` is captured, rendered on the proposal, and pushed to the
calendar feed (`src/app/api/calendar/feed/route.ts:322`). Nothing enforces it.
The public decision endpoint gates on status only:

> `src/app/api/estimates/by-token/[token]/decide/route.ts:94` —
> `if (estimate.status !== "sent") …`

There is no `expired` value in `estimates_status_check`
(`draft|sent|approved|converted|rejected`). A customer can accept a six-month-old
price, and the app will build the invoice at that price.

**What's missing:** reject the decision when `valid_until < today`, an `expired`
status set by cron, and an office "re-issue at current pricing" action.

### 1.4 Estimate templates can be created but never managed

`EstimateLineItemEditor.tsx` can **save** a template (`:234`) and **apply** one
(`:206`). There is no rename, no edit, and no delete — `estimate_templates` does
not appear in any delete path in `src`. A template saved with a typo is in the
dropdown permanently.

### 1.5 A recorded payment cannot be reversed

`payments` has no delete path anywhere in `src`, and `recordInvoicePayment` only
ever adds. A manual payment entered against the wrong invoice, or for the wrong
amount, is unfixable from the UI.

---

## 2. Job costing is missing its two biggest inputs

`JobBudget.tsx` is genuinely well built — estimate line items plus approved
change orders as budget, receipts plus labor as actuals, per cost code, with an
"Uncoded" bucket for untagged spend. Three things break the number it prints.

### 2.1 Subcontractor cost does not exist as a concept

```sql
job_subcontractors: job_id, subcontractor_id, role_on_job,
                    created_at, organization_id, scheduled_date
```

**There is no amount column.** On most construction jobs subs are the largest
cost line, and the budget page cannot see a cent of it. The subcontractor
feature is a contact list with attachments and a schedule date — not a cost
feature. Every job's "actual" is understated by whatever the subs cost.

### 2.2 Rejected time still counts as cost

`JobBudget.tsx:69` pulls time entries with no status filter:

```ts
supabase.from("time_entries")
  .select("cost_code_id, clock_in_at, clock_out_at")
  .eq("job_id", jobId)          // ← no .eq("status", "approved")
```

The approval workflow exists (`time_entries.status`, `approved_by`,
`approved_at`, `TimeApproveButton`) and job costing ignores its result. A
rejected entry inflates job cost exactly as much as an approved one.

### 2.3 Labor is one blended rate for the whole job

`jobs.labor_rate` is the only rate in the system — grep for
`hourly_rate|pay_rate` across `src` returns nothing. A $20/hr laborer and a
$60/hr foreman cost the job the same. Any per-trade or per-person costing
question is unanswerable.

---

## 3. Time clock: solid tracking, not yet payroll

What works: clock in/out with GPS, cost-code tagging, manual entry, office edit,
force clock-out, approve/reject, weekly grouping by worker and by job, CSV
export.

### 3.1 No breaks, no overtime

There is no `break_minutes` column and no occurrence of `overtime` anywhere in
`src`. Weekly totals are raw wall-clock time between punches. In most states an
unpaid meal break must be deducted and hours past 40 pay at 1.5× — this export
cannot be handed to a payroll processor without manual rework, which is the
thing the feature was supposed to remove.

### 3.2 Approval is not durable — crew can edit or delete approved time

RLS allows crew to update and delete their own rows with **no status guard**:

```sql
crew time_update_own  UPDATE  USING (same_org(...) AND user_id = auth.uid())
crew time_delete_own  DELETE  USING (same_org(...) AND user_id = auth.uid())
```

The UI matches: `TimeEntryEditModal.tsx` has no status check, and
`crew/time/page.tsx:218 removeEntry()` deletes unconditionally. So a crew member
can change the hours on an entry **after** it has been approved, and
`approved_at` / `approved_by` stay stamped on the modified row. The approval
records who signed off on numbers that may no longer be the numbers.

**What's missing:** `and status <> 'approved'` on both crew policies, and the
same guard in the UI.

---

## 4. Pesticide compliance — the record is the deliverable, and it isn't guarded

This is the one where "feature present but loop open" carries legal weight,
because the CSV at `/api/lawn/applications/export` is the artifact a state
regulator reads.

### 4.1 Applicator licence is captured but never enforced

`crew_members.applicator_license_number` and `applicator_license_expires` are
collected, and `CrewMembersManager.tsx:294` even renders an **"expired"** badge.
`/api/lawn/applications/route.ts` validates the job, the visit, the crew
assignment, and the applicator id — and **never looks at the licence**. An
application can be logged, and will appear in the regulatory export, under an
applicator whose licence is expired or absent.

**What's missing:** block (or at minimum hard-warn and flag the row) when the
applicator has no licence or an expired one, plus an expiry warning on the
dashboard ahead of the date.

### 4.2 The customer is never told about the re-entry interval

The app computes `re_entry_until` from the product's `re_entry_hours`
(`src/app/api/lawn/applications/route.ts:176`) and shows *the office* "Stay off
lawn until…" (`src/components/ChemicalApplicationsManager.tsx:437`).

The customer notification events are `visit_reminder`, `on_my_way`,
`service_complete`, `service_skipped`, `review_request`. Re-entry appears in
none of them. **The homeowner with kids and a dog — the only person who acts on
a re-entry interval — never receives it.**

**What's missing:** append the re-entry window to `service_complete` whenever the
visit has an application, and put it on the customer portal visit row.

---

## 5. Dead ends — states and records with no way out

### 5.1 A paused lawn visit can never become un-paused

`LAWN_VISIT_TRANSITIONS.paused = []` (`src/lib/lifecycles/lawn-visit.ts`) — no
transitions out, so the UI offers no action. And `bulk-resume` deliberately
leaves them:

> `src/app/api/lawn/schedules/bulk-resume/route.ts:16` — "Paused winter visits
> (status='paused') are LEFT as-is"

…while generating a fresh set of pending visits. The paused rows stay on the
calendar forever. Bulk-pause for the winter and you have permanently
un-actionable clutter; want to service one property mid-pause and there is no
way to reopen its visit.

Related: `lawn_visits.status` is the **only** status column in the database with
**no CHECK constraint** — every other one has it. The lifecycle file says so
explicitly and names itself the enforcement point. One bad write from any future
code path and there is nothing to catch it.

### 5.2 The reviews inbox cannot be acted on

`src/app/admin/reviews/page.tsx` says it plainly:

> "no CRUD yet — offices act on feedback by following up directly, not by
> editing rows"

`review_requests.status` exists. But an office that follows up on a 2-star
complaint has no way to mark it handled, so the same unhappy customer sits at
the top of the inbox indefinitely and the list stops being a worklist.

### 5.3 "Quoted" leads are a label maintained by hand

`leads.status` includes `quoted`, but there is **no lead→estimate link** —
`leads` has `converted_customer_id` and no estimate reference. Conversion
(`src/lib/leads.ts:123`) creates a *customer* and stops. Nothing creates an
estimate from a lead, and nothing moves the lead to `won`/`lost` when the
estimate is approved or rejected. The office must remember to update the board
by hand, which means within a month the board is wrong.

### 5.4 RFIs from the field are effectively silent

An RFI raises only the per-job unread **badge count**
(`src/app/api/notifications/unread/route.ts:81`). It inserts no `notifications`
row and sends no email. `rfis` has no assignee and no due date. A crew member
blocked on a question in the field is invisible unless somebody happens to open
that specific job.

---

## 6. Notification feed: dead branches and, worse, silent failures

`NotificationsFeed.tsx` renders icons for nine types. Cross-referencing every
`from("notifications").insert` in `src`:

**Rendered but never emitted** (dead code):
`daily_log_submitted`, `punch_item_completed`.

**Emitted but with no icon case** — all fall through to the generic gray bell:
`review_feedback`, `new_lead`, `lead_stale`, and **`invoice_payment_failed`**.

That last one matters: a customer's payment failing looks visually identical to
an FYI. Given there is also no dunning (§1.1), a failed payment can go unnoticed
indefinitely.

The two dead branches also point at intended-but-unbuilt behaviour: submitting a
daily log and completing a punch item were clearly meant to notify the office,
and neither does.

---

## 7. Smaller gaps worth a line each

- **No delete path** exists for `daily_logs`, `submittals`,
  `recurring_schedules`, or `chemical_applications`. (`punch_items` and
  `change_orders` have `void` statuses instead, which is the right call.
  `daily_logs` and `chemical_applications` are arguably correct as append-only
  records — but then a mistyped one needs a *correction* mechanism, and there
  isn't one.)
- **`estimate_template_items.organization_id` has no FK** — noted in the earlier
  scalability pass, still open.
- **`purge_rate_limits()` exists but is never scheduled** — the `rate_limits`
  table grows without bound.

---

## Suggested order of work

Ranked by (money or liability at stake) ÷ (effort), not by how broken each is:

1. **Invoice reminders** (§1.1) — the cron pattern already exists; copy
   `lawn/cron/remind`. Converts directly into collected revenue.
2. **Guard approved time entries** (§3.2) — two RLS predicates and one UI check.
   Smallest fix on this list; closes a payroll-integrity hole.
3. **Applicator licence check + re-entry to the customer** (§4) — a validation
   branch and one template token. Liability, not convenience.
4. **`invoice_payment_failed` icon + the four missing cases** (§6) — a few lines.
5. **Filter rejected time out of JobBudget** (§2.2) — one `.eq()`.
6. **Estimate expiry enforcement** (§1.3) — one date check in the decide route,
   plus the cron for the status.
7. **Invoice `draft` status + line-item editing** (§1.2) — bigger; a migration
   plus an editor.
8. **Subcontractor cost** (§2.1) — bigger; needs a schema decision (contract
   amount vs. per-invoice sub billing) before any UI.

Items 1–5 are all small and independently shippable.
