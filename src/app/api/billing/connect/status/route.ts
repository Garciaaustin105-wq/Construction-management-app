import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import { createClient } from "@/lib/supabase/server";
import { getConnectAccount, refreshConnectAccount } from "@/lib/connectAccount";

export const dynamic = "force-dynamic";

// Refresh + read the org's Stripe Connect account status (office/admin, lawn
// only). Calls Stripe to get the live charges_enabled + details_submitted,
// caches them on the org (so the public invoice view can show/hide the Pay
// button without a Stripe API call per load), and returns the status. Called on
// billing-page load + after onboarding return + on a manual "Refresh" click.
//
// Does NOT read or return connect_payouts_enabled: that column was never run
// live and we deliberately gate on charges_enabled only (payouts being false
// strands money in the org's Stripe balance but does not block accepting a
// charge — see connectAccount.ts).

export async function POST() {
  const tenant = await getMe();
  if (!tenant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can view payment setup" },
      { status: 403 }
    );
  }
  if (!isLawn()) {
    return NextResponse.json(
      { error: "Online payments are not available on this variant" },
      { status: 403 }
    );
  }

  // Cached flags (rendered before the live retrieve resolves / on Stripe error).
  const cached = await getConnectAccount(tenant.orgId);
  if (!cached) {
    return NextResponse.json({
      connected: false,
      chargesEnabled: false,
      detailsSubmitted: false,
      platformLiable: false,
    });
  }

  try {
    const fresh = await refreshConnectAccount(tenant.orgId);
    return NextResponse.json({
      connected: true,
      chargesEnabled: fresh?.chargesEnabled ?? cached.chargesEnabled,
      detailsSubmitted: fresh?.detailsSubmitted ?? cached.detailsSubmitted,
      // Payment UI must gate on this as well as chargesEnabled: an account can
      // be fully chargeable at Stripe and still be one we refuse to use.
      platformLiable: fresh?.platformLiable ?? cached.platformLiable,
    });
  } catch (err) {
    // A transient Stripe API failure shouldn't 500 the page — fall back to the
    // cached flags and surface the error so the admin can retry.
    return NextResponse.json({
      connected: true,
      chargesEnabled: cached.chargesEnabled,
      detailsSubmitted: cached.detailsSubmitted,
      platformLiable: cached.platformLiable,
      error: err instanceof Error ? err.message : "Could not reach Stripe",
    });
  }
}