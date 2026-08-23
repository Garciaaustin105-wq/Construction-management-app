// Typed browser-side wrappers for the /api/ai/* routes.
//
// This file is the CLIENT half of the AI-admin contract. It deliberately holds
// no business logic and no Supabase access: every call goes through a server
// route so the LLM provider key, the quota gate (checkAiQuota /
// recordAiAction) and the service-role client all stay server-only. Importing
// src/lib/aiQuota.ts from client code would pull the service-role key into the
// browser bundle — never do that; read the quota through GET /api/ai/quota.
//
// ── CONTRACT STATUS ────────────────────────────────────────────────────────
// The /api/ai/* route handlers are owned by Claude-direct and DO NOT EXIST
// YET. The shapes below are this file's PROPOSAL, chosen to match what is
// already live so the routes can be dropped in without touching the UI:
//   • AiQuota is re-declared here to mirror the `AiQuota` interface exported by
//     src/lib/aiQuota.ts EXACTLY ({allowed, used, max}). It is re-declared
//     rather than imported because that module is server-only.
//   • Errors are read from a `{ error: string }` body, the shape every existing
//     route in src/app/api already returns.
// If the delivered routes differ, this file is the single place to change.

/** Mirrors the server-side `AiQuota` in src/lib/aiQuota.ts. Keep in sync. */
export interface AiQuota {
  /** False when the org is at/over its monthly cap, or the gate failed closed. */
  allowed: boolean;
  /** Actions used this calendar month. */
  used: number;
  /** Monthly cap. null = unlimited. 0 = AI disabled on this tier. */
  max: number | null;
}

/** A period of lawn visits to summarize. Both dates are inclusive, `YYYY-MM-DD`
 *  (the same format lawn_visits.due_date is compared against everywhere else in
 *  the app — see /lawn's `today` computation). */
export interface SummarizeVisitsRequest {
  from: string;
  to: string;
  /** Optional narrowing to one customer. Omit for the whole org. */
  customerId?: string;
  /** Optional narrowing to one job. Reserved — slice 1's UI ships a customer
   *  picker only (see src/app/lawn/ai/AiAdminClient.tsx), but the field is in
   *  the contract so the route need not change when the picker lands. */
  jobId?: string;
}

export interface SummarizeVisitsResponse {
  /** The LLM's summary. Plain text (may contain blank-line paragraphs and
   *  "- " bullets); rendered by AiResultCard without a markdown dependency. */
  summary: string;
  /** How many visits fed the summary — lets the UI say "0 visits in range"
   *  instead of showing an LLM apologising for empty input. */
  visitCount: number;
  /** Quota AFTER this action was recorded, so the meter can update without a
   *  second round trip. */
  quota: AiQuota;
}

// ── Slice 2: draft a customer email ─────────────────────────────────────────
// The office picks a customer + an email type; the server reads that customer's
// lawn history (visits, recurring schedule, chemical applications, invoices —
// all reached THROUGH jobs.customer_id except invoices, which has its own) and
// an LLM drafts a plain-text email the office copies into their own mail client.
// No in-app send this slice (copy + mailto only) — see the route header.

/** Which kind of customer email to draft. `upsell` is marketing-flavored: the
 *  UI only offers it when the selected customer has email_opt_in = true. */
export type CustomerEmailType = "season_recap" | "renewal" | "check_in" | "upsell";

export interface DraftCustomerEmailRequest {
  /** Required — email drafts are per-customer (no org-wide draft). */
  customerId: string;
  type: CustomerEmailType;
  /** YYYY-MM-DD context-window start. Defaults to 365 days ago (an email
   *  references a season, not a billing month). */
  from?: string;
  /** YYYY-MM-DD context-window end. Defaults to today. */
  to?: string;
}

export interface DraftCustomerEmailResponse {
  /** False when there isn't enough lawn history to draft — `body` then holds a
   *  human-readable reason and the UI shows it as info (no copy/mailto). No LLM
   *  call and no quota are consumed in that case. */
  draftable: boolean;
  /** Empty string when `draftable` is false. */
  subject: string;
  /** Plain text, "\n" between paragraphs — ready for clipboard and a mailto:
   *  body parameter. When `!draftable`, the reason text. */
  body: string;
  customerName: string;
  /** `customers.contact_email` for the mailto link. null = no email on file
   *  (the UI then offers Copy only, not "Open in email"). */
  customerEmail: string | null;
  /** `customers.email_opt_in`. The UI uses this to gate the `upsell` type. */
  emailOptIn: boolean;
  /** Visits in the context window. */
  visitCount: number;
  /** Whether a recurring schedule exists (renewal relevance). */
  hasSchedule: boolean;
  /** Quota AFTER this action was recorded (mirrors slice 1). */
  quota: AiQuota;
}

/** Thrown for any non-2xx from an /api/ai route. `status` lets the UI tell an
 *  over-quota 429 apart from a genuine failure. */
export class AiRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AiRequestError";
    this.status = status;
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // Non-JSON body (a proxy error page, an empty 502) — fall through.
  }
  return `Request failed (${res.status})`;
}

/** Current month's AI usage for the caller's org. */
export async function fetchAiQuota(signal?: AbortSignal): Promise<AiQuota> {
  const res = await fetch("/api/ai/quota", { signal });
  if (!res.ok) throw new AiRequestError(await readError(res), res.status);
  return (await res.json()) as AiQuota;
}

/** Summarize the org's lawn visits for a period. Consumes one AI action.
 *  Expect a 429 when the org is over its monthly cap and a 402/403 when the
 *  tier has no AI at all — the caller should have hidden the form in the
 *  latter case, but the route is the authority. */
export async function summarizeVisits(
  body: SummarizeVisitsRequest,
  signal?: AbortSignal
): Promise<SummarizeVisitsResponse> {
  const res = await fetch("/api/ai/summarize-visits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new AiRequestError(await readError(res), res.status);
  return (await res.json()) as SummarizeVisitsResponse;
}

/** Draft a customer email from that customer's lawn history. Consumes one AI
 *  action (unless `draftable` comes back false — then nothing was spent).
 *  Same error contract as summarizeVisits: 401/403/400/402/429/502/503. */
export async function draftCustomerEmail(
  body: DraftCustomerEmailRequest,
  signal?: AbortSignal
): Promise<DraftCustomerEmailResponse> {
  const res = await fetch("/api/ai/draft-customer-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new AiRequestError(await readError(res), res.status);
  return (await res.json()) as DraftCustomerEmailResponse;
}

/** True when the org's tier has no AI at all (as opposed to having AI but
 *  having spent it). Drives the upgrade wall vs the "you're out for this
 *  month" notice — two different messages for two different fixes.
 *
 *  NOTE: `max === 0` is the right test, not "is the free tier". Per
 *  src/lib/plans.ts, BOTH `free` and the PAID `starter` tier are 0, as are
 *  `expired`/`canceled`. A paying Starter customer sees this wall. */
export function isAiDisabled(quota: AiQuota | null): boolean {
  return !!quota && quota.max === 0;
}

/** True when the tier has AI but the org has spent this month's allowance. */
export function isAiExhausted(quota: AiQuota | null): boolean {
  if (!quota || quota.max === null || quota.max === 0) return false;
  return !quota.allowed || quota.used >= quota.max;
}
