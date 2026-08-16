import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMyOrg } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { getStripe } from "@/lib/billing";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Start (or resume) Stripe Connect onboarding so an org can receive customer
// invoice payments into their own Stripe account. Org admin only. Creates an
// Express connected account (if none) stamped on the org, then returns a
// Stripe-hosted Account Link URL (onboarding form). Re-onboarding (account
// exists but not fully verified) reuses the existing account id with a fresh
// link — never creates a second account.

export async function POST(request: Request) {
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
      { error: "Only an organization admin can set up online payments" },
      { status: 403 }
    );
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, email, stripe_connect_account_id")
    .eq("id", tenant.orgId)
    .single();
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const origin = new URL(request.url).origin;
  const admin = createAdminClient();

  let accountId = (org.stripe_connect_account_id as string) ?? null;

  try {
    const stripe = await getStripe();

    // Create the Express connected account once.
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        metadata: { organization_id: org.id },
        ...(org.email ? { email: org.email } : {}),
      });
      accountId = account.id;
      await admin
        .from("organizations")
        .update({ stripe_connect_account_id: accountId })
        .eq("id", org.id);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/admin/billing?connect=refresh`,
      return_url: `${origin}/admin/billing?connect=return`,
      type: "account_onboarding",
    });
    if (!accountLink.url) {
      return NextResponse.json(
        { error: "Stripe did not return an onboarding URL" },
        { status: 502 }
      );
    }
    return NextResponse.json({ url: accountLink.url });
  } catch (err) {
    // Surface the real Stripe error (e.g. the platform account hasn't accepted
    // the Connect agreement / set onboarding URLs) instead of a generic 500 so
    // the admin sees exactly what to fix in the Stripe Dashboard.
    const msg = err instanceof Error ? err.message : "Could not reach Stripe";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}