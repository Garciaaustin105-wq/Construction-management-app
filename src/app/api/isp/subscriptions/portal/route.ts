import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { getStripe } from "@/lib/billing";
import { createAdminClient } from "@/lib/supabase/admin";
import { forAccount, requireChargeableAccount } from "@/lib/ispBilling";

export const dynamic = "force-dynamic";

// Open a Stripe Billing Portal session so a subscriber can update their card,
// see their invoices, or cancel.
//
// AUTHORIZATION — two very different callers share this route:
//   * Office staff acting on a customer's behalf ("their card expired, send
//     them the link"). Gated by isOfficeLike + org match.
//   * The subscriber themselves, from /portal/subscription. They may ONLY open
//     their own, resolved through profiles.customer_id — the same bridge
//     customer_rls.sql uses. A customer-role caller cannot pass someone else's
//     customerId, because we ignore the body's customerId for them entirely and
//     read it off their own profile.
//
// That second rule is the one worth being careful about: accepting customerId
// from the body for a customer-role user would let any signed-in subscriber
// open any other subscriber's billing portal, which exposes their invoices and
// lets them cancel someone else's internet.

export async function POST(request: Request) {
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!tenant.orgId) {
    return NextResponse.json({ error: "No organization" }, { status: 403 });
  }

  const admin = createAdminClient();
  const body = (await request.json().catch(() => ({}))) as {
    customerId?: string;
  };

  let customerId: string | null = null;

  if (isOfficeLike(tenant.role)) {
    customerId = body.customerId ?? null;
  } else {
    // Subscriber path: derive from their own profile, never from the request.
    const { data: profile } = await admin
      .from("profiles")
      .select("customer_id")
      .eq("id", tenant.user.id)
      .maybeSingle();
    customerId = (profile?.customer_id as string | null) ?? null;
  }

  if (!customerId) {
    return NextResponse.json(
      { error: "No customer account found" },
      { status: 400 }
    );
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
          return_url: `${origin}/portal/subscription`,
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
          return_url: `${origin}/portal/subscription`,
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
