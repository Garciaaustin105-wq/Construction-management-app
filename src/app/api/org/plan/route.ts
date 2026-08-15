import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMyOrg } from "@/lib/tenant";
import { getEffectiveBilling } from "@/lib/billing";

// Returns the caller's org plan + effective status + limits. Any org member
// can read this (used by the app chrome + the billing page + gating UI).

export async function GET() {
  const supabase = await createClient();
  const tenant = await getMyOrg(supabase);
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  // super_admin (no org) — no plan to report.
  if (!tenant.orgId) {
    return NextResponse.json({ isPlatform: true, plan: null });
  }

  const billing = await getEffectiveBilling(supabase, tenant.orgId);
  if (!billing) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const trialDaysLeft = billing.trialEndsAt
    ? Math.max(
        0,
        Math.ceil(
          (new Date(billing.trialEndsAt).getTime() - Date.now()) / 86_400_000
        )
      )
    : null;

  return NextResponse.json({
    plan: billing.plan,
    planStatus: billing.planStatus,
    trialEndsAt: billing.trialEndsAt,
    trialDaysLeft,
    limits: billing.limits,
    isExpired: billing.isExpired,
    isPlatform: false,
    isAdmin: tenant.role === "admin",
  });
}