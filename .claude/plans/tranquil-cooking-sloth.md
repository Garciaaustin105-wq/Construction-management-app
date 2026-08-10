# Phase 2 — Quotes & Invoicing

## Context

Phase 1 (jobs, photos, RFIs, blueprints, customers, users, auth) is complete and polished. Phase 2 begins with **Quotes & Invoicing**, the most directly revenue-related workflow for a low-voltage contractor. Office creates quotes for customers, customers approve them in their portal, and approval converts the quote to an invoice. Office tracks invoice payment status.

Per the user's choices:
- Quote first → customer taps "Approve" → converted to invoice.
- Free-form line items (description + qty + unit price; auto-calculated totals). No item catalog in MVP.
- Invoice status: `draft | sent | paid`. No partial payments.

## Schema (SQL — file: `quotes_invoices.sql`)

Two tables. Line items live in a child table for clean updates (avoid blob updates on the parent).

### `quotes`
- `id` uuid PK default `gen_random_uuid()`
- `job_id` uuid NOT NULL references `jobs(id) on delete cascade`
- `customer_id` uuid references `customers(id) on delete set null` (denormalized for fast filtering; kept in sync with `jobs.customer_id`)
- `status` text NOT NULL default `'draft'` check in `('draft','sent','approved','rejected')`
- `notes` text (free-form message to customer)
- `sent_at`, `approved_at`, `rejected_at` timestamptz
- `created_by` uuid references `profiles(id)`
- `created_at`, `updated_at` timestamptz default `now()`

### `quote_line_items`
- `id` uuid PK
- `quote_id` uuid NOT NULL references `quotes(id) on delete cascade`
- `description` text NOT NULL
- `quantity` numeric(10,2) NOT NULL default 1
- `unit_price` numeric(10,2) NOT NULL default 0
- `position` integer NOT NULL default 0 (preserve user order; sort by this)
- `created_at` timestamptz default `now()`

### `invoices`
- `id` uuid PK
- `quote_id` uuid NOT NULL unique references `quotes(id) on delete cascade` (1:1 — approval clones quote into invoice)
- `job_id` uuid references `jobs(id) on delete cascade` (denormalized)
- `customer_id` uuid references `customers(id) on delete set null`
- `status` text NOT NULL default `'sent'` check in `('sent','paid','void')`
- `paid_at` timestamptz
- `created_at`, `updated_at` timestamptz default `now()`

### `invoice_line_items`
- Same shape as `quote_line_items` but `invoice_id` FK. Snapshot of quote line items at conversion time (so editing a quote later doesn't change the issued invoice).

### RLS policies

Use the existing `public.is_office(uid)` helper function (defined in `fix_recursion_v2.sql`) for office gates — same pattern already in use.

- **`quotes`**: office full CRUD; crew read-only if `job_id in (select id from jobs where auth.uid() = any(assigned_crew))`; customer select when `customer_id in (select customer_id from profiles where id = auth.uid())`.
- **`quote_line_items`**: same as parent quote.
- **`invoices`**: office full CRUD; crew no access; customer select when scoped to their `customer_id`.
- **`invoice_line_items`**: same as parent invoice.

Use the existing pattern: `for all` policy split into `for select`, `for insert`, `for update`, `for delete` (or single `for all` with `using + with check`). Match the style of `office_only_jobs_update.sql` and `office_delete_jobs.sql` — snake_case policy names, single-line bodies.

### Customer approval flow (RPC)

Customer portal calls a Postgres function `approve_quote(quote_id uuid)` that atomically:
1. Verifies caller is the customer that owns the quote (security definer; checks `profiles.customer_id`).
2. Sets `quotes.status = 'approved'`, `approved_at = now()`.
3. Inserts an `invoices` row + copies all `quote_line_items` to `invoice_line_items`.
4. Returns the new invoice id.

This is one round trip from the client and the customer never gets write access to either table. Saves an `invoices` insert + line items copy that would otherwise be two writes plus race-prone.

## Files to create

### SQL
- `C:\Users\garci_9e2kg3l\Projects\lowvoltage-app\quotes_invoices.sql` — schema, RLS, and `approve_quote` RPC.

### Components (under `src/components/`)
- **`LineItemEditor.tsx`** — client component. Props: `items: { description, quantity, unit_price }[]`, `onChange`. Renders rows: description input + qty number input + unit price number input + delete row button + add row button. Computes line subtotal and grand total. Reusable for both quotes and invoice view.
- **`StatusBadge.tsx`** — small inline component returning colored pill for a status string (extracted from the duplicated `statusColor` helper in 3 files). Centralizes color logic. Default export takes `{ status: string, size?: "sm" | "md" }`.

### Pages — office (under `src/app/`)
- **`quotes/page.tsx`** — server. Lists all quotes across jobs (most recent first), filterable by status via search param `?status=`. Each row shows: job name, customer, status, total. Tap → `/quotes/[id]`. Header with `+ New Quote` button.
- **`quotes/new/page.tsx`** — client. Form: pick a job (required), optional notes, line items editor, total preview, submit creates draft quote. Mirrors `admin/projects/new/page.tsx` style.
- **`quotes/[id]/page.tsx`** — server. Quote detail. Shows line items read-only with grand total; status; if `draft` shows office edit/delete controls (link to `/quotes/[id]/edit`); if `sent` shows "Mark Sent" and a "Convert to Invoice (skip approval)" office-only button for cases where verbal approval is given; if `approved` shows link to the created invoice.
- **`quotes/[id]/edit/page.tsx`** — client. Same form as `new` but pre-filled. Updates quote + replaces line items (delete-all + re-insert is simpler than diff and acceptable for MVP).
- **`invoices/page.tsx`** — server. Lists all invoices. Status filter via search param. Each row: customer, job, status, total, paid date.
- **`invoices/[id]/page.tsx`** — server. Invoice detail: line items read-only, totals, status. Office actions: "Mark Paid" (sets `status='paid'`, `paid_at=now()`), "Mark Void", "Mark Unpaid". Customer view: just status + paid date.

### Updates to existing pages
- **`src/app/jobs/[id]/page.tsx`** — office: add `Quotes` section listing this job's quotes (status + total, tap → quote detail) + `Invoices` section listing invoices + a `+ New Quote` button. Customer: show invoices for this job. Crew: no change.
- **`src/app/dashboard/page.tsx`** — office: add a "Recent Invoices" or "Unpaid Invoices" card (top of page after New Project button) with the most recent 5 unpaid invoices linking to invoice detail.
- **`src/app/customer/page.tsx`** — add `Quotes Awaiting Approval` section at the top showing the customer's `sent` quotes (each with an Approve/Reject button calling the `approve_quote` RPC or rejecting inline). Add `Invoices` section showing `sent` + `paid` invoices. Both sections reuse the existing `Card → EmptyState` pattern.

### Updates to other components
- **`src/app/api/jobs/[jobId]/view/route.ts`** (or a new API route) — extend notification badge to count pending quotes needing approval for the customer. Or just keep current photo/RFI notifications and add quotes as a separate badge. Defer to a follow-up; the approval UI itself surfaces pending quotes prominently enough.
- **`src/components/BottomNav.tsx`** — no change (still Home/Photo/Admin/SignOut).
- **`src/lib/useUnreadCount.ts`** — no change initially.

## Reuse patterns

- **`useToast`** from `src/components/Toast.tsx` — every create/update/delete uses toast for success/error.
- **`Spinner`** from `src/components/Skeleton.tsx` — in submit buttons.
- **`EmptyState`, `EmptyIcons`** from `src/components/EmptyState.tsx` — for empty list views.
- **`TopBar`**, **`BottomNav`** — page chrome.
- **Server page prelude**: `await createClient()` + `auth.getUser()` + role lookup — copied verbatim from `src/app/dashboard/page.tsx`.
- **Form patterns**: client form with `useState` per field, `loading` boolean, blue-600 submit button with `Loader2`, header with `ArrowLeft` back link + centered title (mirroring `src/app/admin/projects/new/page.tsx`).
- **FK select syntax**: `select("id, name, customers(name)")` and `(parent as unknown as { name: string } | null)?.name` (already established pattern).
- **`statusColor` helper** — currently duplicated 3 times. Extract to `StatusBadge` and replace all three call sites while we're here. (Lightweight cleanup, not a behavior change.)

## Verification

1. **Run SQL** in Supabase SQL Editor → expect "Success. No rows returned." Confirms tables, RLS, and `approve_quote` RPC exist.
2. **Build check** — `npm run build` (the user has been doing this; we'll keep doing it) — confirms types compile, no Supabase query type drift.
3. **Office flow**:
   - Sign in as office user.
   - Open a job → see new "Quotes" section with `+ New Quote`.
   - Create a quote with 3 line items → submit → quote appears as `draft`.
   - Edit it, change a line item, save.
   - Mark it `sent`.
   - As the customer (sign in as customer user in another browser), open the job in the portal → see the quote with Approve/Reject buttons.
   - Tap Approve → toast "Approved", quote disappears, invoice appears in customer's "Invoices" section.
   - Back as office, dashboard "Unpaid Invoices" shows the new invoice.
   - Open invoice → tap "Mark Paid" → status flips to `paid`, dashboard card no longer shows it.
4. **Crew flow**: sign in as crew. Open an assigned job → no Quotes/Invoices section visible (crew has no access).
5. **RLS check**: in browser devtools, attempt `supabase.from("invoices").insert(...)` from the customer's session — should fail with permission error.
6. **Phone check**: tap approval on phone, refresh, verify same behavior as desktop (uses pull-to-refresh on customer portal).

## Out of scope (deferred)

- Item catalog / product library.
- Partial payments.
- Tax line, discount line, deposit requests.
- PDF rendering / email delivery of quotes and invoices.
- Crew-side visibility into project revenue (would be a future "My Earnings" or "Job Margin" view).
- Quote revisions / versioning.
- Multi-currency.
