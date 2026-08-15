import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getMyOrg } from "@/lib/tenant";
import { getEffectiveBilling } from "@/lib/billing";
import { PLAN_TIERS, PAID_TIERS, type PlanTier } from "@/lib/plans";
import BillingForm from "./BillingForm";

export const dynamic = "force-dynamic";

// Org-admin billing & subscription page. The org admin subscribes to a paid
// tier (Stripe Checkout) or manages an existing subscription (Stripe Customer
// Portal). Non-admins are bounced to the dashboard.

export default async function BillingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenant = await getMyOrg(supabase);
  if (!tenant) redirect("/login");
  if (tenant.role !== "admin" || !tenant.orgId) redirect("/dashboard");

  const billing = await getEffectiveBilling(supabase, tenant.orgId);
  if (!billing) redirect("/dashboard");

  // Async server component — runs once per request, so Date.now() is the
  // request time, not a client-render side effect. react-hooks/purity is a
  // false positive here.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const trialDaysLeft = billing.trialEndsAt
    ? Math.max(
        0,
        Math.ceil((new Date(billing.trialEndsAt).getTime() - now) / 86_400_000)
      )
    : null;

  const tiers = PAID_TIERS.map((t) => {
    const c = PLAN_TIERS[t];
    return {
      tier: t,
      label: c.label,
      blurb: c.blurb,
      maxUsers: c.maxUsers,
      maxJobs: c.maxJobs,
    };
  });

  return (
    <BillingForm
      currentPlan={billing.plan}
      planStatus={billing.planStatus}
      trialDaysLeft={trialDaysLeft}
      isExpired={billing.isExpired}
      hasSubscription={!!billing.stripeSubscriptionId}
      tiers={tiers}
    />
  );
}

export type { PlanTier };