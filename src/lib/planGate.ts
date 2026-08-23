import { NextResponse } from "next/server";
import { effectiveStatus, type OrgBilling } from "@/lib/billing";
import type { MyTenant } from "@/lib/tenant";

// Plan-gate helpers for paid-only features. The free tier (lawn) gives the
// solo operator full operational power but gates paid differentiators and
// real-future-cost items. Accounting sync is one of those: it costs platform
// integration maintenance + provider-API metering (Intuit CorePlus READ is
// metered — see lowvoltage-intuit-partner-metering), so a free org may not
// connect or sync. Reads + disconnect stay allowed (a free org that was once
// paid must still be able to clean up an existing connection).
//
// `effectiveStatus` mirrors the lazy trial-expiry used everywhere else, so a
// trial that has aged into 'expired' is correctly treated as NOT free (it's
// its own blocked state — createGate handles that separately) and a genuine
// 'free' org returns the 402 here.

/** Build the minimal OrgBilling slice effectiveStatus needs from a cached tenant. */
function tenantBilling(t: MyTenant): OrgBilling {
  return {
    plan: t.plan ?? "trial",
    planStatus: t.planStatus ?? "trial",
    trialEndsAt: t.trialEndsAt,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionAmountCents: 0,
  };
}

/** The effective plan for a cached tenant (lazy trial expiry applied). */
export function effectivePlan(t: MyTenant): string {
  return effectiveStatus(tenantBilling(t)).plan;
}

/**
 * Returns a 402 NextResponse when the caller's effective plan is `free`, else
 * null. Drop-in at the top of a paid-only route, right after the auth/role gate:
 *
 *   const tenant = await getMe();
 *   if (!tenant) return ...401;
 *   if (!isOfficeLike(tenant.role)) return ...403;
 *   const gated = assertNotFreePlan(tenant);
 *   if (gated) return gated;
 *
 * Reused so the same gating + upgrade copy applies wherever a paid-only
 * surface ships (accounting sync now; API/MCP later).
 */
export function assertNotFreePlan(t: MyTenant): NextResponse | null {
  if (effectivePlan(t) === "free") {
    return NextResponse.json(
      {
        error:
          "Bookkeeping sync is a paid feature. Upgrade to Starter or higher to connect your accounting provider.",
      },
      { status: 402 }
    );
  }
  return null;
}