import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { isIspOrg } from "@/lib/ispModule";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Disconnect the org's Stripe account from ISP billing. Org admin only.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//
//  * It does not delete or deauthorize the Stripe account. That account belongs
//    to the ORG, not to us — it is a full Stripe account they log into, holding
//    their payout history and their customers' saved cards. Deleting it would
//    be destroying someone else's business record. If they want us gone
//    entirely they can also revoke platform access from their own Stripe
//    dashboard, which is the point of using Connect in the first place.
//
//  * It does not cancel their subscribers' subscriptions. Those live on THEIR
//    account and keep billing on schedule — which is correct (their customers
//    keep their internet), but it does mean this app stops tracking those
//    charges. The caller is told so explicitly below rather than discovering it
//    when the dunning cron goes quiet.
//
// The row is kept and marked `disconnected` rather than deleted, so the
// stripe_account_id survives for audit and so reconnecting later re-uses the
// same account instead of stranding the old one.

export async function POST() {
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can disconnect a Stripe account" },
      { status: 403 }
    );
  }
  if (!(await isIspOrg(tenant.orgId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const admin = createAdminClient();

  // Count what will keep billing without us watching it, so the UI can say so.
  const { count: liveSubs } = await admin
    .from("isp_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", tenant.orgId)
    .in("status", ["trialing", "active", "past_due"]);

  const { error } = await admin
    .from("isp_connect_accounts")
    .update({
      status: "disconnected",
      charges_enabled: false,
    })
    .eq("organization_id", tenant.orgId);

  if (error) {
    return NextResponse.json(
      { error: "Could not disconnect the Stripe account" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    liveSubscriptions: liveSubs ?? 0,
    note:
      (liveSubs ?? 0) > 0
        ? `${liveSubs} active subscription(s) will keep billing in your Stripe account, but this app will no longer track their payments or handle missed-payment suspensions. Cancel them in Stripe if that isn't what you want.`
        : null,
  });
}
