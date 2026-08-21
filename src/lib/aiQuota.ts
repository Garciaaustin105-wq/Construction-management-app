import { createAdminClient } from "@/lib/supabase/admin";

// Per-org MONTHLY AI-action quota gate (companion to ai_action_gating.sql).
//
// Every AI route calls checkAiQuota(orgId) BEFORE invoking the LLM — if the org
// is over its monthly cap, return 429 and DO NOT call the LLM (no variable
// cost). After a successful LLM call, call recordAiAction(...) to log tokens +
// cost; record_ai_action re-checks the cap at insert (TOCTOU-safe) and raises
// if a race pushed the org over, so a route can rely on either gate.
//
// Quotas live in the DB (ai_action_max) and mirror src/lib/plans.ts
// maxAiActionsPerMonth — the DB is authoritative for enforcement (a client can't
// bypass it), plans.ts is for display. This helper never reads plans.ts for
// the decision; it only forwards the DB result.
//
// Server-only: createAdminClient reads the service-role key. Never import from
// client code.

export interface AiQuota {
  allowed: boolean;
  /** Actions used this calendar month. */
  used: number;
  /** Monthly cap; null = unlimited (not currently any tier). */
  max: number | null;
}

/** Check whether the org may run another AI action this month. Call BEFORE the
 *  LLM. Returns {allowed, used, max}. On RPC error, deny by default (allowed:
 *  false) — failing closed avoids unbounded LLM spend if the gate is down. */
export async function checkAiQuota(orgId: string): Promise<AiQuota> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("check_ai_quota", { p_org: orgId });
  if (error || !data) {
    return { allowed: false, used: 0, max: 0 };
  }
  // check_ai_quota returns table(...) -> supabase-js resolves an array of one row.
  const rows = data as unknown as { allowed: boolean; used: number; max: number | null }[];
  const row = Array.isArray(rows) ? rows[0] : (rows as unknown as typeof rows);
  if (!row) {
    return { allowed: false, used: 0, max: 0 };
  }
  return {
    allowed: !!row.allowed,
    used: Number(row.used) || 0,
    max: row.max === null || row.max === undefined ? null : Number(row.max),
  };
}

/** Log a completed AI action + its token usage + cost in cents. Returns the
 *  remaining actions this month (max - used - 1), or -1 when unlimited.
 *  Throws if the DB raised the over-quota exception (the LLM call already
 *  happened in this case — surface as a 429 to the client, but the spend is
 *  already incurred; check_ai_quota first is what keeps spend bounded). */
export async function recordAiAction(
  orgId: string,
  profileId: string | null,
  feature: string,
  tokensIn: number,
  tokensOut: number,
  costCents = 0
): Promise<{ remaining: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("record_ai_action", {
    p_org: orgId,
    p_profile: profileId,
    p_feature: feature,
    p_tokens_in: tokensIn,
    p_tokens_out: tokensOut,
    p_cost_cents: costCents,
  });
  if (error) {
    throw new Error(error.message);
  }
  return { remaining: Number(data) || 0 };
}