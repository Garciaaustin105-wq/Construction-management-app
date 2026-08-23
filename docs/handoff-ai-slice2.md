# Opus handoff — AI admin slice 2: "Draft customer email" UI

You (Opus) build the **UI** for AI-admin slice 2 on `feat/ai-admin` (== main `4241d66`). Claude-direct already wrote the **contract + server route + page tweak** and type-checked them (`tsc --noEmit` green). You build against the contract — do NOT touch the route or the contract types.

## What slice 2 is
The lawn office picks a **customer** + an **email type** → the server reads that customer's lawn history → an LLM drafts a plain-text email (subject + body) → the office **copies it / opens it in their own email client** (mailto). **No in-app send this slice** — copy + mailto only.

The existing "Summarize visits" card (slice 1) stays as-is. You add a **second card** "Draft customer email" below it on the same page.

## Already done by Claude-direct (don't change)
- **`src/lib/aiClient.ts`** — added `CustomerEmailType`, `DraftCustomerEmailRequest`, `DraftCustomerEmailResponse`, and `draftCustomerEmail(body, signal?)` (a typed fetch wrapper, same shape as `summarizeVisits`). **Import these.**
- **`src/app/api/ai/draft-customer-email/route.ts`** — the POST route. Same gate/quota/RLS/Haiku pattern as slice 1. Returns `DraftCustomerEmailResponse`.
- **`src/app/lawn/ai/page.tsx`** — the customers select now includes `email_opt_in`, and `CustomerOption` now carries `emailOptIn: boolean`.
- **`src/app/lawn/ai/AiAdminClient.tsx`** — the `CustomerOption` type is already updated to `{ id, name, emailOptIn }`. (You're editing this file for the UI.)

## The contract you build against (from `src/lib/aiClient.ts`)
```ts
export type CustomerEmailType = "season_recap" | "renewal" | "check_in" | "upsell";

export interface DraftCustomerEmailRequest {
  customerId: string;        // required
  type: CustomerEmailType;
  from?: string;             // YYYY-MM-DD, default 365d ago
  to?: string;               // YYYY-MM-DD, default today
}

export interface DraftCustomerEmailResponse {
  draftable: boolean;        // false = not enough data; body holds the reason
  subject: string;           // "" when !draftable
  body: string;              // plain text, \n between paragraphs
  customerName: string;
  customerEmail: string | null;  // contact_email for mailto; null = no email on file
  emailOptIn: boolean;
  visitCount: number;
  hasSchedule: boolean;
  quota: AiQuota;            // post-action — update the shared meter
}

export async function draftCustomerEmail(
  body: DraftCustomerEmailRequest,
  signal?: AbortSignal
): Promise<DraftCustomerEmailResponse>;
```
**Error contract is identical to slice 1** — `AiRequestError` with `.status`: 401/403/400/402 (tier has no AI)/429 (over cap)/502 (provider)/503 (not configured). Branch on `status` the same way the existing `run()` does.

## UI spec — `src/app/lawn/ai/AiAdminClient.tsx`

### New "Draft customer email" card (below the summarize card, inside the same `!disabled` branch so the upgrade wall still hides it)
- **Customer picker** — reuse the `Select` pattern, but **required** (no "All customers" option). If none selected, `toast.warning("Pick a customer")` on Draft.
- **Email type `Select`** — four options: "Season recap" (`season_recap`), "Renewal reminder" (`renewal`), "Check-in / follow-up" (`check_in`), "Service recommendation" (`upsell`). **The `upsell` `<option>` is `disabled` when the selected customer's `emailOptIn` is false** — look up the selected `CustomerOption` from `customers` and read `.emailOptIn`. When disabled, hint text under the select: "Customer hasn't opted into marketing — pick another type." If the currently-selected type is `upsell` and the user switches to a non-opted customer, reset type to `season_recap`.
- **Date range** — optional `from`/`to` date inputs (same styling as slice 1's). **Default `from` = 365 days ago, `to` = today** (wider than summarize's 30d — an email references a season). Reuse the `isoDaysAgo` helper already in this file (add `isoDaysAgo(365)` for the default `from`).
- **Draft button** — Sparkles icon; label "Draft email"; while running "Drafting…"; "Uses 1 AI action" note. Disabled while `running || exhausted`.
- On click → call `draftCustomerEmail({ customerId, type, from, to })`. On success: set the email-result state + `setQuota(res.quota)` (same shared meter as summarize). On `!res.draftable` → show `res.body` as an info message (see below), no copy/mailto, and `toast.info` is fine. Error handling mirrors the existing `run()` (429/402/403 → toast + `loadQuota()`).

### Email result rendering (when a draft comes back, `draftable === true`)
Render **editable** fields so the office can tweak before copying:
- Subject: an `<input>` (text), prefilled `res.subject`.
- Body: a `<textarea>` (rows ~10), prefilled `res.body`, monospace not needed.
- **Actions row**:
  - **Copy** button → `navigator.clipboard.writeText(\`Subject: \${subject}\n\n\${body}\`)`; `toast.success("Copied")`. (Copy subject + body together so pasting into any mail client is one step.)
  - **Open in email** — an `<a>` styled as a secondary button, `href={mailtoHref}` where `mailtoHref = \`mailto:\${encodeURIComponent(res.customerEmail ?? "")}?subject=\${encodeURIComponent(subject)}&body=\${encodeURIComponent(body)}\``. **Disabled (render as plain text + tooltip, or omit the link) when `res.customerEmail` is null** — then show hint "No email on file — use Copy instead". The mailto should use the **live editable** subject/body state (let the office edit, then open).
- Keep the editable subject/body in local state so edits persist across Copy/Open.

### `!draftable` result rendering
Show `res.body` as a plain informational `<p>` (no subject input, no textarea, no Copy/Open actions). E.g. a `Card` with `CardHeader title="Not enough history"` + the body text. Meter unchanged (no action was consumed).

### Remove the slice-1 placeholder
Delete the disabled "Draft client update" button in the **summarize** result's `AiResultCard` `actions` (the `actions={...}` prop around line 269-276 in the current file) — slice 2 lands the real feature, so the placeholder is obsolete. The summarize result can render with `actions` omitted (or a Copy button if you want — optional, not required).

## Reuse (already shipped — do not recreate)
- `Card` / `CardHeader` (`@/components/ui/Card`), `Button` / `LinkButton` (`@/components/ui/Button`), `FormField` / `Select` (`@/components/ui/FormField`), `FormGrid` (`@/components/ui/FormGrid`).
- `AiUsageMeter` (the shared meter — both cards update the same `quota` state).
- `AiResultCard` — **unchanged**, still used for the summarize result. The email draft renders inline in the new card (your call whether to factor a small `EmailDraftCard` local component; no new shared component required).
- `useToast` (`@/components/Toast`).
- The existing `quota` / `isAiDisabled` / `isAiExhausted` / `loadQuota` machinery — reuse verbatim. The email draft is a second action on the same page sharing the same quota state.
- `AiRequestError` for error branching.

## Hard constraints (from the user's standing rules)
- **No in-app send.** Do NOT import `sendCustomerEmail`, Resend, or anything from `src/lib/email.ts`. Copy + mailto only.
- **No SQL, no service-role client, no `src/proxy.ts` change.** The route already handles gating + RLS + quota.
- **Primary buttons stay `bg-blue-600`** on both deploys (don't recolor per variant). Lawn-green stays on chrome only.
- **`CustomerOption` type is now `{ id, name, emailOptIn }`** — keep it; the page passes `emailOptIn`.
- Keep the page a server component (it already is); your changes are inside the `AiAdminClient` client component only.
- Don't `git add -A`. Don't commit — Claude-direct does the build-gate + ship after your UI lands.

## When you're done
Tell the user (or Claude-direct) the UI is written. Claude-direct will then run the build-gate (`tsc --noEmit` + lawn build + construction build, wiping `.next` between) and ship. Do NOT push.

## Reference files to read first
- `src/app/lawn/ai/AiAdminClient.tsx` (the file you're editing — slice-1 patterns to mirror)
- `src/lib/aiClient.ts` (the contract — lines for `DraftCustomerEmail*` + `draftCustomerEmail`)
- `src/app/api/ai/draft-customer-email/route.ts` (the route — to see exactly what comes back)
- `src/app/lawn/ai/page.tsx` (the server page — confirms `CustomerOption` now has `emailOptIn`)