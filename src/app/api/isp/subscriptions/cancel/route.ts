import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { isIspOrg } from "@/lib/ispModule";
import { getStripe } from "@/lib/billing";
import { createAdminClient } from "@/lib/supabase/admin";
import { forAccount, getConnectAccount } from "@/lib/ispBilling";

export const dynamic = "force-dynamic";

// Cancel a subscriber's plan. Office/PM only.
//
// Default is cancel-at-period-end, not immediate: the customer paid through the
// end of the current month, so cutting them off the moment someone clicks
// Cancel takes service they already bought. `immediate: true` is available for
// the cases that need it (fraud, moved out, duplicate enrollment).
//
// Stripe is the source of truth — we cancel there and let the resulting
// `customer.subscription.updated` / `.deleted` webhook write our row, rather
// than writing both and hoping they agree. The one exception is a row that
// never got a Stripe subscription at all (abandoned checkout), which we close
// out locally because no webhook is ever coming.

export async function POST(request: Request) {
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only office staff can cancel a subscription" },
      { status: 403 }
    );
  }
  if (!(await isIspOrg(tenant.orgId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    subscriptionId?: string;
    immediate?: boolean;
  };
  if (!body.subscriptionId) {
    return NextResponse.json({ error: "Missing subscription" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("isp_subscriptions")
    .select("id, organization_id, stripe_subscription_id, status")
    .eq("id", body.subscriptionId)
    .eq("organization_id", tenant.orgId)
    .maybeSingle();

  if (!sub) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }

  // Never reached Stripe (customer abandoned checkout). Close it locally.
  if (!sub.stripe_subscription_id) {
    await admin
      .from("isp_subscriptions")
      .update({ status: "canceled", canceled_at: new Date().toISOString() })
      .eq("id", sub.id);
    return NextResponse.json({ ok: true, canceled: "local" });
  }

  const account = await getConnectAccount(tenant.orgId);
  if (!account) {
    return NextResponse.json(
      { error: "This organization has no connected Stripe account." },
      { status: 400 }
    );
  }

  try {
    const stripe = await getStripe();
    const opts = forAccount(account.stripe_account_id);

    if (body.immediate) {
      // `{}` is the (empty) params argument — RequestOptions is the THIRD
      // positional arg here, and passing it second silently targets the
      // platform account instead of the org's.
      await stripe.subscriptions.cancel(sub.stripe_subscription_id, {}, opts);
    } else {
      await stripe.subscriptions.update(
        sub.stripe_subscription_id,
        { cancel_at_period_end: true },
        opts
      );
    }

    return NextResponse.json({
      ok: true,
      canceled: body.immediate ? "immediate" : "at_period_end",
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Could not cancel the subscription",
      },
      { status: 502 }
    );
  }
}
