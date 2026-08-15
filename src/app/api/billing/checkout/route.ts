import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMyOrg } from "@/lib/tenant";
import { createCheckoutSession } from "@/lib/billing";
import { PAID_TIERS, type PaidTier } from "@/lib/plans";

// Start a Stripe Checkout session for a paid tier. Org admin only.

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
  if (tenant.role !== "admin") {
    return NextResponse.json(
      { error: "Only the organization admin can manage billing" },
      { status: 403 }
    );
  }
  if (!tenant.orgId) {
    return NextResponse.json(
      { error: "Your account has no organization" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const raw = body?.tier;
  if (typeof raw !== "string" || !(PAID_TIERS as readonly string[]).includes(raw)) {
    return NextResponse.json({ error: "Invalid plan tier" }, { status: 400 });
  }
  const tier = raw as PaidTier;

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, email, stripe_customer_id")
    .eq("id", tenant.orgId)
    .single();
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const origin = new URL(request.url).origin;
  try {
    const { url } = await createCheckoutSession(
      {
        id: org.id,
        name: org.name,
        email: org.email,
        stripeCustomerId: org.stripe_customer_id,
      },
      tier,
      origin
    );
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}