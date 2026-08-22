import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { createPortalSession } from "@/lib/billing";

// Open the Stripe Customer Portal (update card, cancel, view invoices).
// Org admin only.

export async function POST(request: Request) {
  const supabase = await createClient();
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant = await getMe();
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
    const { url } = await createPortalSession(
      {
        id: org.id,
        name: org.name,
        email: org.email,
        stripeCustomerId: org.stripe_customer_id,
      },
      origin
    );
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }
}