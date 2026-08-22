import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getMe } from "@/lib/tenant";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";
import { isIspOrg } from "@/lib/ispModule";
import { getConnectAccount } from "@/lib/ispBilling";
import { createClient } from "@/lib/supabase/server";
import TopBar from "@/components/TopBar";
import IspBillingPanel from "@/components/IspBillingPanel";

export const dynamic = "force-dynamic";

// Stripe Connect setup + dunning configuration for the org's subscriber billing.
//
// The connect row is read server-side so the panel paints its real state on
// first frame (no "Not connected" flash for an org that is connected). The
// panel then re-reads from Stripe on `?connect=return`, because our cached
// flags are stale by definition the moment the user comes back from onboarding.

export default async function IspBillingPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (isSuperAdmin(me.role) || !isOfficeLike(me.role)) redirect("/dashboard");
  if (!me.orgId) redirect("/dashboard");
  if (!(await isIspOrg(me.orgId))) redirect("/dashboard");

  const row = await getConnectAccount(me.orgId);

  const supabase = await createClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("dunning_grace_days")
    .eq("id", me.orgId)
    .maybeSingle();

  const initial =
    row && row.status !== "disconnected"
      ? {
          connected: true,
          status: row.status,
          chargesEnabled: row.charges_enabled,
          payoutsEnabled: row.payouts_enabled,
          detailsSubmitted: row.details_submitted,
          livemode: row.livemode,
        }
      : { connected: false };

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar
        title="ISP Billing"
        subtitle="Bill subscribers through your own Stripe account"
      />
      <main className="max-w-md lg:max-w-3xl mx-auto p-4">
        {/* useSearchParams() in the panel needs a Suspense boundary. */}
        <Suspense fallback={null}>
          <IspBillingPanel
            initial={initial}
            initialGraceDays={(org?.dunning_grace_days as number | null) ?? 14}
          />
        </Suspense>
      </main>
    </div>
  );
}
