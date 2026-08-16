import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMyOrg } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { getStripe } from "@/lib/billing";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Refresh + read the org's Stripe Connect account status (admin only). Calls
// Stripe to get the live charges_enabled + details_submitted, caches them on
// the org (so the public invoice view can show/hide the Pay button without a
// Stripe API call per load), and returns the status. Called on billing-page
// load + after onboarding return + on a manual "Refresh" click.

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const tenant = await getMyOrg(supabase);
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can view payment setup" },
      { status: 403 }
    );
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("stripe_connect_account_id, connect_charges_enabled, connect_details_submitted")
    .eq("id", tenant.orgId)
    .maybeSingle();

  const accountId = (org?.stripe_connect_account_id as string) ?? null;
  if (!accountId) {
    return NextResponse.json({
      connected: false,
      chargesEnabled: false,
      detailsSubmitted: false,
    });
  }

  // Pull the live status from Stripe and cache it.
  const stripe = await getStripe();
  let chargesEnabled = !!org?.connect_charges_enabled;
  let detailsSubmitted = !!org?.connect_details_submitted;
  try {
    const account = await stripe.accounts.retrieve(accountId);
    chargesEnabled = !!account.charges_enabled;
    detailsSubmitted = !!account.details_submitted;
    await createAdminClient()
      .from("organizations")
      .update({
        connect_charges_enabled: chargesEnabled,
        connect_details_submitted: detailsSubmitted,
      })
      .eq("id", tenant.orgId);
  } catch (err) {
    // A transient Stripe API failure shouldn't 500 the page — fall back to the
    // cached flags and surface the error so the admin can retry.
    return NextResponse.json({
      connected: true,
      chargesEnabled,
      detailsSubmitted,
      error: err instanceof Error ? err.message : "Could not reach Stripe",
    });
  }

  return NextResponse.json({
    connected: true,
    chargesEnabled,
    detailsSubmitted,
  });
}