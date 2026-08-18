import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMyOrg } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { getProvider } from "@/lib/accounting/provider";
import { signState } from "@/lib/accounting/crypto";
import "@/lib/accounting/providers"; // registers adapters in the registry
import type { AccountingProviderId } from "@/lib/accounting/provider";

export const dynamic = "force-dynamic";

// Begin OAuth2 for an accounting provider (QuickBooks first; Xero/FreshBooks/
// Wave/Stripe-BYO later). Org admin only. Returns the provider authorization
// URL for the client to redirect to. `state` is orgId signed with HMAC (verified
// in the callback) so a forged callback can't bind a stranger's tokens to the
// org. The provider id comes from the request body so one route serves all.

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
      { error: "Only an organization admin can connect a bookkeeping provider" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    provider?: string;
  };
  const providerId = (body.provider ?? "quickbooks") as AccountingProviderId;
  if (!["quickbooks", "xero", "freshbooks", "wave", "stripe_byo"].includes(providerId)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/accounting/callback`;
  // state = `${orgId}|${provider}.${hmac(orgId|provider)}` — the callback splits
  // + verifies the HMAC. Provider rides along because Intuit doesn't echo custom
  // params back on the redirect.
  const signed = `${tenant.orgId}|${providerId}`;
  const state = `${signed}.${signState(signed)}`;

  try {
    const provider = getProvider(providerId);
    const url = provider.getAuthUrl(redirectUri, state);
    return NextResponse.json({ url, provider: providerId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not build authorization URL" },
      { status: 502 }
    );
  }
}