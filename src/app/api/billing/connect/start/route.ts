import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import { createClient } from "@/lib/supabase/server";
import {
  createConnectedAccount,
  createOnboardingLink,
} from "@/lib/connectAccount";

export const dynamic = "force-dynamic";

// Start (or resume) Stripe Connect onboarding so a lawn org can accept customer
// invoice payments into its own Stripe account. Office/admin only, LAWN-ONLY
// (construction gets Connect in a later phase; the proxy also 404s this route on
// the construction deploy as defense-in-depth). Creates a connected account
// (modern `controller` object — direct charges, org is merchant of record, the
// platform is never liable) stamped on the org, then returns a Stripe-hosted
// Account Link URL. Re-onboarding (account exists but not fully verified)
// reuses the existing account id with a fresh link — never creates a second
// account. See connectAccount.ts for the liability invariants.

export async function POST(request: Request) {
  const tenant = await getMe();
  if (!tenant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can set up online payments" },
      { status: 403 }
    );
  }
  if (!isLawn()) {
    return NextResponse.json(
      { error: "Online payments are not available on this variant" },
      { status: 403 }
    );
  }

  const supabase = await createClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, email, stripe_connect_account_id")
    .eq("id", tenant.orgId)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const origin = new URL(request.url).origin;
  let accountId = (org.stripe_connect_account_id as string | null) ?? null;

  try {
    if (!accountId) {
      accountId = await createConnectedAccount({
        id: org.id,
        name: (org.name as string | null) ?? null,
        email: (org.email as string | null) ?? null,
      });
    }
    const url = await createOnboardingLink(accountId, origin);
    return NextResponse.json({ url });
  } catch (err) {
    // Surface the real Stripe error (e.g. the platform account hasn't accepted
    // the Connect agreement / set onboarding URLs) instead of a generic 500 so
    // the admin sees exactly what to fix in the Stripe Dashboard.
    const msg = err instanceof Error ? err.message : "Could not reach Stripe";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}