import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { createCheckoutSession, getOrgBilling, effectiveStatus } from "@/lib/billing";
import { PAID_TIERS, type PaidTier, getLimits } from "@/lib/plans";
import { getOrgUsage, isDowngrade, downgradeBlockers } from "@/lib/orgUsage";

// Start a Stripe Checkout session for a paid tier. Org admin only.
//
// DOWNGRADE GUARD: before creating a Checkout, if the target tier is a
// downgrade from the current EFFECTIVE plan (incl. a lapsed trial resubscribe),
// compare current usage (jobs/customers/crew/seats/storage) to the target
// tier's caps. If any dimension is over the cap, return 409 with the blockers
// instead of starting Checkout — the office must remove the excess (or export
// it first via /api/jobs/[id]/export) or pick a higher tier. This closes the
// "downgrade with no shrinkage" leak (holding higher-tier capacity at a lower
// price). Upgrades, same-tier re-subscribes, and trial→paid conversions are
// never blocked (isDowngrade returns false for those).

export async function POST(request: Request) {
  const supabase = await createClient();
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (tenant.role !== "admin") {
    return NextResponse.json(
      { error: "Only the organization admin can manage billing" },
      { status: 403 }
    );
  }
  if (!tenant.orgId) {
    return NextResponse.json(
      { error: "Your account has no organization" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const raw = body?.tier;
  if (typeof raw !== "string" || !(PAID_TIERS as readonly string[]).includes(raw)) {
    return NextResponse.json({ error: "Invalid plan tier" }, { status: 400 });
  }
  const tier = raw as PaidTier;

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, email, stripe_customer_id")
    .eq("id", tenant.orgId)
    .single();
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  // Downgrade guard (money leak #2). The Customer Portal is locked to
  // cancel-only (createPortalSession below), so plan changes only flow through
  // this route — making this the single place to gate downgrades.
  const billing = await getOrgBilling(supabase, org.id);
  if (billing) {
    const eff = effectiveStatus(billing);
    if (isDowngrade(eff.plan, tier)) {
      const usage = await getOrgUsage(supabase, org.id);
      const blockers = downgradeBlockers(usage, getLimits(tier));
      if (blockers.length > 0) {
        return NextResponse.json(
          {
            error: `Downgrade to ${tier} blocked: your current usage exceeds that plan.`,
            blockers,
          },
          { status: 409 }
        );
      }
    }
  }

  const origin = new URL(request.url).origin;
  try {
    const { url } = await createCheckoutSession(
      {
        id: org.id,
        name: org.name,
        email: org.email,
        stripeCustomerId: org.stripe_customer_id,
      },
      tier,
      origin
    );
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}