# Feature Integration Fixes — HANDOFF

**Prepared:** 2026-08-25 by a read-only audit session.
**Repo:** `C:\Users\garci_9e2kg3l\Projects\lowvoltage-app` (Next.js 16 / React 19 / Supabase; variants: construction = Terra Vista, lawn = Terra Verde).
**Supabase project id:** `avmqteevisqxwmmxkrbg` (MCP: `execute_sql`, `apply_migration`, `get_advisors`).

## The thesis

These are **five user-reported defects from real daily use**. Four are *integration gaps* — each feature works in isolation but was never wired to the next one, forcing the user to hunt for options and re-enter information the system already has. One (#3/#5) is a genuine correctness and liability problem: **the app records that something happened, but never what was sent or who approved it.**

Fix them in the dependency order in the last section — they are not independent.

---

## Issue 1 — Email preview before sending

**Report:** "when i send emails to the customer i want the email preview to pop up in a little window showing the email preview and the estimate we are adding with line items etc."

**Status: infrastructure already exists; only the UI is missing.** Do not build a new renderer.

`src/lib/email.ts` already separates pure renderers from senders:
- `renderEstimateEmail()` — line 57
- `renderInvoiceReceiptEmail()` — line 761
- `renderChangeOrderEmail()` — line 976

`loadEstimateForEmail()` (`src/lib/emailLoaders.ts`) loads real data, and `/admin/email-preview` **already previews these emails with real data**. The send route (`src/app/api/estimates/[id]/send/route.ts`) uses `sendEstimateEmail` and notes at line 24 that these paths are *shared* with the preview feature.

The gap: send is fire-and-forget. There is no confirmation step.

Note: `src/app/estimates/[id]/page.tsx` has an edit/preview tab toggle (lines 150, 720) — that previews the **proposal document**, NOT the **email**. It does not answer "what is the customer about to receive." Don't confuse the two.

### Required work

- Add a server route (e.g. `POST /api/estimates/[id]/preview`) that calls the **existing** `loadEstimateForEmail()` + `renderEstimateEmail()` and returns the rendered HTML.
- Show it in a modal (iframe or sandboxed container) with Send / Cancel, triggered by the existing send button.
- Do the same for the invoice-receipt and change-order send paths using their existing renderers.

**Critical:** render server-side through the existing renderer. **Do not reimplement the preview client-side** — a second render path will drift from what actually sends, which is the exact class of bug being fixed. The preview must be the same bytes the customer receives.

---

## Issue 2 — Photos: wrong render, slow, no download

**Report:** "when i click on the preview pictures in home page it doesnt render correctly its only when i go to the photos tab am i able to render the photos correctly, they also take such a long time to render, currently there is no way to download the photos."

Three separate defects.

### 2a. Home-page click opens the 240px thumbnail, not the original

`src/components/SignedPhotoGrid.tsx`:
- line 26: URLs are minted via `signedThumbnail(supabase, "job-photos", p.storage_path, 240)`
- line 56: the anchor sets `href={urls[p.id]}` — **the same 240px transformed URL**

So clicking a photo on the dashboard opens a 240px image. The photos tab uses a **different component**, `src/components/PhotoLightbox.tsx`, which mints `signedFull()` (line 93, untransformed) for its full view — which is why the same photo looks correct there. This exactly matches the report.

**Fix:** the grid cell should keep the thumbnail for display but resolve `signedFull()` for the click target (or open the lightbox). Consider reusing `PhotoLightbox` on the dashboard rather than maintaining two divergent grids — that divergence *is* the bug.

### 2b. Slow rendering

Both grids mint signed URLs **client-side after hydration** in a `useEffect` (`SignedPhotoGrid.tsx` lines 20–46): one storage round-trip per photo, in parallel, plus Supabase image-transform cold-start per unique `(width, quality)`. Nothing is cached, so navigating back re-mints everything.

**Fix:** the pages rendering these grids are already **server components** that fetch the photo rows in an existing `Promise.all` (see `src/app/dashboard/page.tsx` ~line 148). Mint the signed URLs there and pass them down as props. That removes the client waterfall entirely. Keep a client fallback only if a URL is missing.

### 2c. No download exists

Confirmed: neither `SignedPhotoGrid` nor `PhotoLightbox` has any download affordance. (`PhotoLightbox` line 315 is a Google Maps link, not a download.)

**Implementation gotcha:** the HTML `download` attribute is **ignored on cross-origin URLs**, so `<a download href={signedUrl}>` will just navigate — it will look broken. Supabase's `createSignedUrl` accepts a `{ download: true }` option that sets the correct `Content-Disposition` response header. Use that (add a `signedDownload()` helper in `src/lib/storage.ts` alongside the existing `signedThumbnail` / `signedFull`, following that file's pattern).

---

## Issue 3 — Sent/approved estimates open the editor, and nothing records what was sent

**Report:** "when i go to see a approved estimate or a sent estimate i click on the estimate tab and click on the estimate it gives me the estimate editor then the email preview as if im creating a new email, this should not be like this and it should show the estimate that was sent to the customer."

### Root cause (immediate)

`src/app/estimates/[id]/page.tsx` line 331:

```ts
const editable = estimate.status === "draft" || estimate.status === "sent";
```

`sent` is treated as editable → you get the editor.

### Root cause (deeper — this is the real problem)

`src/app/api/estimates/[id]/send/route.ts` (~line 195) on send only does:

```ts
.update({ status: ..., sent_at: new Date().toISOString() })
```

**No snapshot of what was sent is ever stored.** Every "view" re-renders from *current* data. If anyone edits after sending, you are looking at the edited version, not what the customer received. There is currently **no way to prove what was sent** — a liability issue, not just a UX annoyance.

### Required work

1. **Archive a snapshot at send time.** Store the rendered email HTML plus the line-item/total JSON as they existed at send. Either a new `estimate_sends` table (preferred — supports resends and a history) or `jsonb` columns on `estimates`. Use `apply_migration` with a recorded name.
2. **Make `sent` and `approved` view-only.** Change the `editable` predicate to `draft` only. Add an explicit "Revise" action for office/PM that is deliberate (either creates a new version or returns the estimate to draft) rather than silently editing a sent document.
3. **"View sent estimate" renders the snapshot**, not live data.

Snapshot infrastructure here is reused by Issue 1 — build it once.

---

## Issue 4 — Change orders can't be added to the original estimate's receipt

**Report:** "when i have a estimate and approved and then we have a change order, when i go to send a receipt there is no way to add the change order to the original estimate receipt."

**Status: the integration does not exist at all.** A grep for change-order handling across `src/app/api/invoices/` and the receipt path (`src/app/api/invoices/[id]/receipt/route.ts`) returns **nothing**. Change orders are tracked financially in reporting only (`src/lib/insights.ts` line 15 — approved COs feed insights) but never flow into an invoice or receipt.

### Required work

- Allow approved change orders for a job to be pulled onto an invoice as line items (office-selectable, showing which CO each line came from).
- Update `renderInvoiceReceiptEmail()` (`src/lib/email.ts` line 761) so the receipt shows the breakdown: original estimate total + approved change orders = final total. The customer must be able to see *why* the total differs from the estimate they approved.
- Only `approved` change orders are eligible. Guard against double-billing the same CO across two invoices.

**Depends on Issue 5** — a change order must be reliably approvable (including in-person) before it can be billed.

---

## Issue 5 — No manual change-order approval, and no record of who approved

**Report:** "when a owner pays in check or approves in person and not through email there is no way for me admin or office/pm to manually approve the change order. when we manually approve the change order it needs to state who approved and saved the time stamp so we dont have pms or office people or admin approving change orders for no reason."

Two independent blockers.

### Blocker A — the RPC is customer-only

`src/app/api/change-orders/[id]/decide/route.ts` calls the `decide_change_order` SECURITY DEFINER RPC, which enforces that the caller is a **customer** whose `profiles.customer_id` matches the CO's job's customer, `same_org`, and `status='sent'`. There is **no office/admin/PM path**. Check-paying and in-person customers genuinely cannot be recorded today.

### Blocker B — the schema cannot store attribution

Verified against the live database. `change_orders` has `approved_at`, `rejected_at`, `created_by` — but **no `approved_by`, no `approval_method`**. Identical gap on `estimates`.

So even if a manual-approve button were added today, **it could not record who clicked it** — which is precisely the accountability the user is asking for.

### Required work

**Migration** (via `apply_migration`, recorded name — do not apply raw SQL):

```sql
alter table public.change_orders
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approval_method text
    check (approval_method in ('customer_portal','email','manual_office')),
  add column if not exists approval_note text;
```

Apply the same to `estimates` (in-person / check approvals have the identical gap — do both in one pass).

**New RPC** `office_approve_change_order(p_co_id uuid, p_note text)`:
- Gate to office/admin/PM. The helpers already exist — `tier_office_or_pm(organization_id)` is used in current policies, and `is_office_or_pm(uid)` exists. **Read `src/app/api/change-orders/[id]/decide/route.ts` and the existing `decide_change_order` definition first and mirror its structure and guard style.**
- Stamp `approved_by = auth.uid()`, `approved_at = now()`, `approval_method = 'manual_office'`, `approval_note = p_note`.
- Require `status = 'sent'` (same precondition as the customer path).
- Fire the same office feed notification the customer path does (deduped, best-effort).

**UI:**
- Manual "Approve on behalf of customer" action for office/admin/PM on the change-order detail page (`src/app/change-orders/[id]/page.tsx`), with a required note field (e.g. "paid by check #1234" / "approved in person").
- **Display who approved, when, and by which method** on the CO detail view and in change-order reports (`src/app/api/reports/change-orders/route.ts`). Visible attribution is the whole point — it's what discourages casual approvals.

**Backfill note:** existing approved rows will have `approved_by = null`. Either leave them null and render "—" / "legacy", or set `approval_method = 'customer_portal'` where `approved_at is not null`. Ask the user before backfilling; don't invent attribution for historical rows.

---

## Dependency order — work it in this sequence

1. **Issue 2 (photos)** — self-contained, three small fixes, immediate daily relief. No schema change.
2. **Issue 5 (CO approval + attribution)** — the migration unblocks #4.
3. **Issue 4 (COs → receipts)** — requires #5.
4. **Issue 3 (send snapshots + view-only sent estimates)** — builds the snapshot infra.
5. **Issue 1 (preview modal)** — reuses #3's renderer plumbing.

#3 and #5 share a root cause (no record of *what* happened or *who* did it). #4 depends on #5. Do not start #4 before #5.

---

## Verification

- `npx tsc --noEmit` → must exit 0 before any commit. `npx next lint` → exit 0.
- Both currently pass; keep them passing.
- **Issue 2:** click a photo on the dashboard and confirm it opens the full-resolution image, matching the photos tab. Confirm download actually downloads (not navigates) — this is the cross-origin gotcha above.
- **Issue 3:** send an estimate, then edit the underlying data, then view the sent estimate — it must show the **originally sent** version.
- **Issue 5:** verify a crew or customer role **cannot** call the new office RPC (should be denied), and that office/admin/PM approval writes `approved_by`, `approved_at`, and `approval_method` correctly. **Test tenant isolation** — an office user in org A must not be able to approve a CO in org B.
- **Issue 1:** confirm the preview HTML is byte-identical to what is sent (same renderer, not a reimplementation).

## Boundaries

- **Stage explicitly. Never `git add -A`.**
- **Do not commit** untracked root files: `CONNECT_PAYMENTS_HANDOFF.md`, `PHASE1_CONTENT_PACKAGE.md`, `TERRA_VERDE_MARKETING_PLAN_2026-08-23.md`, `.claude/launch.json`.
- **Do not touch** `public/terra-verde-*` or `public/terra-vista-*` brand assets — logo work is finished and committed.
- **Do not push.** Leave commits local for review.
- All DDL goes through `apply_migration` with a recorded name — migration tracking is already drifted (only 7 recorded vs ~100 loose root `.sql` files); do not make it worse.
- There is a **separate open handoff**, `docs/handoff-scalability-2026-08-25.md` (cron N+1 + RLS). If both are in flight, coordinate before touching shared live Supabase state — a local file conflict is recoverable, a half-applied policy or column migration is not.

## Confidence note

All findings were verified by reading source and querying the live schema — **not** by clicking through a running browser. The line numbers and the schema gaps are confirmed facts. The photo-click and estimate-editor diagnoses match the user's reported symptoms precisely. If behavior diverges during implementation, the cited line numbers are the place to start.
