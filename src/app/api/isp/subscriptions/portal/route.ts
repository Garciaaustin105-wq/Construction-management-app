import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { getStripe } from "@/lib/billing";
import { createAdminClient } from "@/lib/supabase/admin";
import { forAccount, requireChargeableAccount } from "@/lib/ispBilling";

export const dynamic = "force-dynamic";

// Mint a Stripe Billing Portal link for a subscriber (update card, view
// invoices, cancel).
//
// OFFICE-ONLY BY DESIGN. ISP subscribers are office-managed `customers` rows —
// no auth.users, no profiles row, no in-app login. So the subscriber never
// calls this themselves; the office opens it on their behalf and hands over the
// link (or the customer follows it from a dunning email).
//
// An earlier revision had a second branch that resolved the caller's own
// customer_id through profiles.customer_id, for a signed-in subscriber hitting
// the deleted /portal/subscription page. That branch is gone along with its
// backing RLS policy — under the office-managed model no subscriber has a
// profiles row, so it could only ever resolve null and 400. Do not reinstate it
// without also reinstating the customer-side auth model; a half-restored
// version (branch without policy, or policy without branch) is the failure this
// pair was collapsed to avoid.
//
// The link Stripe returns is a bearer credential — anyone holding it can view
// invoices and cancel service. Send it to the customer directly; don't post it
// anywhere shared.

export async function POST(request: Request) {
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only office staff can open a subscriber's billing portal" },
      { status: 403 }
    );
  }

  const admin = createAdminClient();
  const body = (await request.json().catch(() => ({}))) as {
    customerId?: string;
  };

  const customerId = body.customerId ?? null;
  if (!customerId) {
    return NextResponse.json({ error: "Missing customer" }, { status: 400 });
  }

  const { data: sub } = await admin
    .from("isp_subscriptions")
    .select("id, organization_id, stripe_customer_id")
    .eq("customer_id", customerId)
    .in("status", ["none", "trialing", "active", "past_due", "suspended"])
    .maybeSingle();

  if (!sub || sub.organization_id !== tenant.orgId) {
    return NextResponse.json(
      { error: "No active subscription for this customer" },
      { status: 404 }
    );
  }
  if (!sub.stripe_customer_id) {
    return NextResponse.json(
      { error: "This customer hasn't completed sign-up yet." },
      { status: 400 }
    );
  }

  try {
    const account = await requireChargeableAccount(tenant.orgId);
    const stripe = await getStripe();
    const opts = forAccount(account.stripe_account_id);
    const origin = new URL(request.url).origin;

    let session: Stripe.BillingPortal.Session;
    try {
      session = await stripe.billingPortal.sessions.create(
        {
          customer: sub.stripe_customer_id,
          return_url: `${origin}/isp/checkout/complete`,
        },
        opts
      );
    } catch (err) {
      // A connected account has no default Billing Portal configuration until
      // one is created — the platform's own portal settings do NOT carry over.
      // Stripe surfaces this as an invalid_request about a missing default
      // configuration, which reads like a code bug but is really first-run
      // setup. Create a minimal configuration on their account and retry once.
      const message = err instanceof Error ? err.message : "";
      if (!/configuration/i.test(message)) throw err;

      await stripe.billingPortal.configurations.create(
        {
          business_profile: {
            headline: "Manage your internet service",
          },
          features: {
            payment_method_update: { enabled: true },
            invoice_history: { enabled: true },
            customer_update: {
              enabled: true,
              allowed_updates: ["email", "address", "phone"],
            },
          },
        },
        opts
      );

      session = await stripe.billingPortal.sessions.create(
        {
          customer: sub.stripe_customer_id,
          return_url: `${origin}/isp/checkout/complete`,
        },
        opts
      );
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Could not open the billing portal",
      },
      { status: 502 }
    );
  }
}
