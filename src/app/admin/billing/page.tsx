import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getMyOrg } from "@/lib/tenant";
import { getEffectiveBilling } from "@/lib/billing";
import { isOfficeLike } from "@/lib/roles";
import { PLAN_TIERS, PAID_TIERS, type PlanTier } from "@/lib/plans";
import BillingForm from "./BillingForm";
import ConnectStripeButton from "./ConnectStripeButton";

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
  if (!isOfficeLike(tenant.role) || !tenant.orgId) redirect("/dashboard");

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

  // Only show tiers that have a Stripe price configured (env var set). Tiers
  // without a price (e.g. Enterprise until STRIPE_PRICE_ENTERPRISE is set) are
  // hidden from self-serve purchase but remain assignable by super_admin and
  // their caps still apply. Setting the env var later makes the card appear.
  const tiers = PAID_TIERS.filter((t) => PLAN_TIERS[t].priceId).map((t) => {
    const c = PLAN_TIERS[t];
    return {
      tier: t,
      label: c.label,
      blurb: c.blurb,
      maxUsers: c.maxUsers,
      maxJobs: c.maxJobs,
    };
  });

  // Stripe Connect status (receiving customer invoice payments). The cached
  // flags drive the initial render; ConnectStripeButton refreshes them live.
  const { data: orgRow } = await supabase
    .from("organizations")
    .select(
      "stripe_connect_account_id, connect_charges_enabled, connect_details_submitted"
    )
    .eq("id", tenant.orgId)
    .maybeSingle();
  const connectSection = (
    <ConnectStripeButton
      initialConnectAccountId={
        (orgRow?.stripe_connect_account_id as string) ?? null
      }
      initialChargesEnabled={!!orgRow?.connect_charges_enabled}
      initialDetailsSubmitted={!!orgRow?.connect_details_submitted}
    />
  );

  return (
    <BillingForm
      currentPlan={billing.plan}
      planStatus={billing.planStatus}
      trialDaysLeft={trialDaysLeft}
      isExpired={billing.isExpired}
      hasSubscription={!!billing.stripeSubscriptionId}
      tiers={tiers}
      connectSection={connectSection}
    />
  );
}

export type { PlanTier };