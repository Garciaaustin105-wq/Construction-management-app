import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getMe } from "@/lib/tenant";
import { createClient } from "@/lib/supabase/server";
import TopBar from "@/components/TopBar";
import PortalSubscriptionView from "@/components/PortalSubscriptionView";

export const dynamic = "force-dynamic";

// The subscriber's own view of their internet service.
//
// Reached by customer-role users (the profiles.customer_id bridge from
// customer_rls.sql) and by anyone returning from Stripe Checkout — the enroll
// flow's success_url points here.
//
// Everything on this page is read through the caller's OWN session, not the
// service role, so the "Customer see own …" RLS policies are what scope it. A
// customer with no isp_subscriptions row simply sees the empty state; there is
// no id in the URL to tamper with.

export default async function PortalSubscriptionPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  const supabase = await createClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("customer_id")
    .eq("id", me.user.id)
    .maybeSingle();

  const customerId = (profile?.customer_id as string | null) ?? null;
  if (!customerId) redirect("/dashboard");

  // RLS ("customer_read_own_isp_subscription") restricts this to their own row.
  const { data: sub } = await supabase
    .from("isp_subscriptions")
    .select("id, plan_id, status, current_period_end, grace_until, stripe_subscription_id")
    .eq("customer_id", customerId)
    .in("status", ["none", "trialing", "active", "past_due", "suspended"])
    .maybeSingle();

  let planName: string | null = null;
  let planPriceCents: number | null = null;
  if (sub?.plan_id) {
    // same_org_read_isp_plans lets a customer resolve their own plan's name.
    const { data: plan } = await supabase
      .from("isp_plans")
      .select("name, price_cents")
      .eq("id", sub.plan_id)
      .maybeSingle();
    planName = (plan?.name as string | null) ?? null;
    planPriceCents = (plan?.price_cents as number | null) ?? null;
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="My Internet" />
      <main className="max-w-md mx-auto p-4">
        {/* useSearchParams() in the view needs a Suspense boundary. */}
        <Suspense fallback={null}>
          <PortalSubscriptionView
            status={(sub?.status as string | null) ?? null}
            planName={planName}
            planPriceCents={planPriceCents}
            currentPeriodEnd={(sub?.current_period_end as string | null) ?? null}
            graceUntil={(sub?.grace_until as string | null) ?? null}
            hasStripeSubscription={!!sub?.stripe_subscription_id}
          />
        </Suspense>
      </main>
    </div>
  );
}
