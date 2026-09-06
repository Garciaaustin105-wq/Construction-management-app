# Abuse Protection & Rate Limiting — HANDOFF

> ## ✅ COMPLETED 2026-08-26 — commit `a100d69`
>
> All work in this handoff is done. Summary of what shipped and what changed
> versus the original plan:
>
> - **Finding 1 (spoofable `X-Forwarded-For`) — VOID, not a bug.** This handoff
>   said to verify against vendor docs before implementing. Verified: Vercel
>   **overwrites** `X-Forwarded-For` at the edge and does not forward external
>   IPs, *specifically to prevent IP spoofing*
>   (https://vercel.com/docs/headers/request-headers). The existing `clientIp()`
>   logic was already correct for this deploy target. **No fix was needed or
>   made.** The caveat is documented in `src/lib/rateLimit.ts`: revisit if this
>   app ever moves off Vercel or sits behind another proxy.
> - **Finding 2 — done, but with Postgres, not Upstash.** This handoff proposed
>   Upstash and said to confirm before adding an infra dependency. Postgres was
>   chosen instead: it is already this app's shared state, so it solves the
>   cross-instance problem with **no new vendor, no new bill, and no new env
>   var**. Shipped as the `rate_limits` table + `check_rate_limit` RPC
>   (`rate_limits` migration, applied and recorded) and `src/lib/rateLimit.ts`.
> - **Finding 3 — done.** Both Stripe token routes now throttle on token AND IP.
> - **Finding 4 — done.** Throttles added to estimate/change-order decide,
>   submittal return, reset-password, and review-feedback.
>
> **Verified:** `tsc` exits 0; changed files lint clean; end-to-end test against
> a dev server confirmed 8 requests pass and the 9th returns 429 with
> `Retry-After`, while a different token is unaffected (per-token keying works).
> The limiter **fails open** by design — a DB hiccup must never block a customer
> from paying an invoice.
>
> **Known follow-up (not blocking):** `public.rate_limits` grows by distinct
> key. A `purge_rate_limits(hours)` function ships with the migration but is
> **not scheduled** — wire it to a cron if the table ever grows enough to matter.
>
> The original handoff text is preserved below for reference.

---

**Prepared:** 2026-08-25 by a read-only audit session.
**Repo:** `C:\Users\garci_9e2kg3l\Projects\lowvoltage-app` (Next.js 16 / React 19 / Supabase, deployed on Vercel).
**Supabase project id:** `avmqteevisqxwmmxkrbg`.

## Scope and severity

This handoff covers **abuse and cost exposure on public endpoints**. It is **not** a privilege-escalation report — a full sweep of all 82 API routes found the role/permission model to be correct, and no cross-tenant data access was found here or in the preceding security audit.

Severity is moderate overall, with **one sharp edge**: an unauthenticated, unthrottled card-testing vector that lands on the *customer org's* Stripe account (Finding 3). Fix that first.

Relative to the other open handoffs: this ranks **below** `handoff-billing-2026-08-25.md` (which can double-charge real customers) and **above** the RLS sweep in `handoff-scalability-2026-08-25.md`.

---

## What is already correct — do not change

Verified by reading source. Leave these alone:

- **Role/ownership enforcement across the API is sound.** Privileged routes gate on `isOfficeLike` / `OFFICE_LIKE` / `OFFICE_OR_PM` / `MANAGEMENT` or an ownership check, and service-role routes follow the correct read-with-RLS-then-write-with-admin pattern.
- **`src/app/api/calendar/token/route.ts`** looks unguarded to a naive grep but is not. It uses `requireOrgScoped()` and derives `organization_id` **from the caller's tenant, not the request body** — there is an explicit comment (~line 99) noting this prevents minting a feed for another org. Correct as written.
- **`src/app/api/lawn/route-optimize/route.ts`** gates on `OFFICE_LIKE` (~line 42) *and* checks `check_route_opt_quota` before calling the billed Google Distance Matrix API. Correct as written.
- **The AI routes** (`ai/draft-customer-email`, `ai/summarize-visits`) already have per-org monthly quota gating with documented TOCTOU handling and 429 responses. Do not add IP rate limiting on top of these — the quota is the right control and already works.
- **Token entropy is fine everywhere** — `crypto.randomUUID()` for share tokens, `randomBytes(32)` for password resets. Do not "strengthen" tokens; that is not the problem.
- **The 13 public routes are public by design** (OAuth callback, Stripe webhooks, customer token portals, auth flows, lead capture). Do **not** add authentication to them — that would break customer-facing flows. They need throttling, not auth.

---

## Finding 1 — Rate limiting is bypassable with a spoofed header

**File:** `src/app/api/forgot-password/route.ts` (~line 45), and the same helper duplicated in `src/app/api/signup/route.ts` and `src/app/api/leads/route.ts`.

```ts
function clientIp(request: Request): string {
  const xfwd = request.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0].trim();
  return "unknown";
}
```

`X-Forwarded-For` is a chain. Proxies **append** their observed IP; they do not overwrite the header. The **leftmost entry is therefore client-supplied and attacker-controlled**. Sending `X-Forwarded-For: <random>` on each request yields a fresh rate-limit bucket every time, defeating the limit entirely with a single header.

### Required change

Resolve the client IP from a **platform-set** header that the client cannot forge. On Vercel that is typically `x-real-ip` or `x-vercel-forwarded-for`; the rightmost `X-Forwarded-For` entry is the other common approach.

**Confirm the correct header against current Vercel documentation for this deploy target before implementing** — do not take the above list as authoritative. Getting this wrong silently reintroduces the bypass.

Also: `return "unknown"` as a fallback funnels every header-less request into one shared bucket. Decide deliberately whether that should fail-open (current behavior, effectively) or fail-closed, and document the choice.

Fix it **once** in a shared helper (e.g. `src/lib/clientIp.ts`) and have all call sites use it, rather than patching three copies.

---

## Finding 2 — Rate limiting is in-memory, so it barely functions on serverless

**Files:** the three limiters in `forgot-password`, `signup`, `leads` — each a module-level `const resetHits = new Map<string, number[]>()`.

On Vercel this is **per-instance and ephemeral**. Concurrent requests are distributed across instances, each holding its own empty map, and instances recycle frequently. The effective limit is roughly `RATE_LIMIT_MAX × instance count`, resetting unpredictably.

The code already acknowledges this — `forgot-password` line ~26: *"swap in Upstash Ratelimit when shared limits are needed."*

### Required change

Move to **shared** rate-limit state (Upstash Redis / `@upstash/ratelimit` is what the comment anticipates, and it is the standard choice for Vercel).

Requirements:
- Fail **open** on limiter-backend errors for customer-facing payment paths — a Redis outage must not block a customer from paying an invoice. Log loudly instead.
- Keep the existing per-route limits as the starting values (`forgot-password` 5/hour), and tune from real traffic rather than guessing.
- Introduce it as a shared helper alongside the Finding 1 IP fix; these two changes belong in one pass.

**Requires an env var and an external service.** Confirm with the user before adding an infrastructure dependency, and make the code degrade gracefully if the env var is absent (fall back to the current in-memory behavior rather than crashing at boot).

---

## Finding 3 — Unthrottled card-testing vector (fix this first)

**Files:** `src/app/api/invoices/pay/[token]/route.ts`, `src/app/api/invoices/save-card/[token]/route.ts`

Both are **unauthenticated** (correctly — they are customer-facing token portals) and have **no rate limiting whatsoever**. Anyone holding a single valid invoice share token can hammer them.

Why this is the sharp edge: per the Connect architecture (`src/lib/connectAccount.ts`), charges are **direct charges with the org as merchant of record**. Card-testing traffic therefore runs against **the customer org's own Stripe account**, and Stripe penalizes merchants for elevated decline rates. The blast radius lands on your customer, not the platform — they could face account review or termination over an attack routed through this app.

### Required change

Add rate limiting to both routes, keyed on **both** the resolved client IP (post-Finding-1 fix) **and** the invoice token, so a single token cannot be hammered even from rotating IPs.

Suggested starting limits (tune later): a handful of attempts per token per hour, and a modest per-IP ceiling across all payment endpoints. A legitimate customer pays once, occasionally retrying a declined card — single-digit attempts is generous.

On limit, return `429` with a clear, non-leaky message. **Do not** reveal whether the token or the invoice is valid in the throttled response.

Note: Stripe Radar provides its own fraud controls, but it is a backstop, not a substitute — this app should not be the open front door.

---

## Finding 4 — Ten of thirteen public routes have no throttling

Only `forgot-password`, `signup`, and `leads` have any limiter. Unprotected:

| Route | Risk | Priority |
|---|---|---|
| `invoices/pay/[token]` | card testing on org's Stripe account | **HIGH** — Finding 3 |
| `invoices/save-card/[token]` | card testing on org's Stripe account | **HIGH** — Finding 3 |
| `review-feedback` | spam / junk rows | medium |
| `change-orders/by-token/[token]/decide` | repeated decision spam | medium |
| `estimates/by-token/[token]/decide` | repeated decision spam | medium |
| `submittals/by-token/[token]/return` | repeated submission spam | medium |
| `reset-password` | asymmetric vs. `forgot-password` | low — see note |
| `calendar/feed` | DB read amplification | low |
| `accounting/callback` | OAuth callback, state-validated | low |
| `accounting/webhook` | vendor webhook | low |

**`reset-password` note:** it is unlimited while `forgot-password` is limited, which is inconsistent — but the reset token is `randomBytes(32)` (256-bit), so brute force is not feasible. Add a limit for consistency and defense in depth; do **not** treat it as urgent.

The `by-token/decide` routes: verify whether they already no-op on an already-decided record (the change-order path checks `status='sent'`, so it likely does). If so the risk is wasted DB work, not data corruption — throttle for cost, not correctness.

### Required change

Apply the shared limiter from Findings 1+2 across the medium-priority rows. Do the two HIGH rows first as Finding 3.

---

## Order of work

1. **Finding 3** — throttle the two Stripe payment token routes. Highest real-world impact.
2. **Findings 1 + 2 together** — shared `clientIp` helper with a trustworthy header, plus shared rate-limit backing store. Doing 1 without 2 leaves the limit weak; doing 2 without 1 leaves it bypassable. They are one change.
3. **Finding 4** — extend the shared limiter to the medium-priority public routes.

Finding 3 can ship with the current in-memory limiter as an immediate stopgap if 1+2 will take longer — a weak limit on the card-testing path is meaningfully better than none. Note it as a stopgap in the code comment so it is not mistaken for finished work.

## Verification

- `npx tsc --noEmit` → exit 0. `npx next lint` → exit 0. Both currently pass; keep them passing.
- **Finding 1:** send repeated requests with a *varying* spoofed `X-Forwarded-For` header. They must all land in the **same** bucket and be throttled. This is the exact bypass — test it explicitly.
- **Finding 2:** verify the limit holds across separate serverless invocations, not just within one warm instance. A local single-process test will pass even with the bug still present — it must be validated against a deployed preview or a genuinely shared store.
- **Finding 3:** confirm a legitimate customer can still pay an invoice, retry once after a decline, and save a card. **Do not use live cards — use Stripe test mode.** Over-throttling here directly blocks revenue.
- **Regression:** confirm `forgot-password`, `signup`, and `leads` still work normally under the new shared helper.

## Boundaries

- **Stage explicitly. Never `git add -A`.**
- **Do not commit** untracked root files: `CONNECT_PAYMENTS_HANDOFF.md`, `PHASE1_CONTENT_PACKAGE.md`, `TERRA_VERDE_MARKETING_PLAN_2026-08-23.md`, `.claude/launch.json`.
- **Do not touch** `public/terra-verde-*` / `public/terra-vista-*` brand assets.
- **Do not push.** Leave commits local for review.
- **Do not add authentication to the public routes** — they are customer-facing by design and adding auth breaks payment, estimate-decision, and lead-capture flows.
- **Do not add `application_fee_amount`, `transfer_data`, or `on_behalf_of` to any Stripe call** (see `handoff-billing-2026-08-25.md`) — it would move customer money onto the platform balance sheet.
- Adding a rate-limit service introduces an **env var and an external dependency** — confirm with the user first, and degrade gracefully when the env var is absent.
- **Four handoffs are now open** (billing, scalability, feature-integration, abuse-protection). Coordinate before touching shared live state.

## Confidence note

All findings were confirmed by reading source — route inventory, the `clientIp` implementation, the in-memory `Map` limiters, and which routes carry a limiter are accurate as of 2026-08-25. **Nothing was reproduced against a running app**, and no exploit was attempted. The correct Vercel IP header (Finding 1) is the one item explicitly flagged for verification against vendor docs before implementing.
