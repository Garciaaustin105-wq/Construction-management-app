import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { assertNotFreePlan } from "@/lib/planGate";
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
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can connect a bookkeeping provider" },
      { status: 403 }
    );
  }

  // Accounting sync is a paid feature — free (lawn) orgs can't connect. Reads
  // + disconnect stay open so a lapsed-paid org can still manage/clean up an
  // existing connection. 402 before any provider/OAuth work so no state is set.
  const freeGate = assertNotFreePlan(tenant);
  if (freeGate) return freeGate;

  const body = (await request.json().catch(() => ({}))) as {
    provider?: string;
  };
  const providerId = (body.provider ?? "quickbooks") as AccountingProviderId;
  if (!["quickbooks", "xero", "freshbooks", "wave", "stripe_byo"].includes(providerId)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/accounting/callback`;

  // Resolve the adapter up front so a misconfiguration returns a FRIENDLY 409
  // instead of either (a) building a malformed auth URL with an empty client_id
  // (redirects the user to an Intuit/Xero/FreshBooks error page) or (b) calling
  // signState() which throws "ACCOUNTING_TOKEN_ENCRYPTION_KEY is not set" — an
  // opaque error toast. Both look like "the button is broken" to an office user.
  let provider;
  try {
    provider = getProvider(providerId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown provider" },
      { status: 400 }
    );
  }

  if (!provider.isConfigured()) {
    return NextResponse.json(
      {
        error: `${provider.label} isn't configured yet. An admin needs to add the ${provider.label} API credentials (client id + secret) before you can connect.`,
      },
      { status: 409 }
    );
  }

  if (!process.env.ACCOUNTING_TOKEN_ENCRYPTION_KEY) {
    return NextResponse.json(
      {
        error:
          "Accounting integration isn't fully configured yet (missing token encryption key). Contact your admin.",
      },
      { status: 409 }
    );
  }

  // state = `${orgId}|${provider}.${hmac(orgId|provider)}` — the callback splits
  // + verifies the HMAC. Provider rides along because Intuit doesn't echo custom
  // params back on the redirect.
  const signed = `${tenant.orgId}|${providerId}`;
  const state = `${signed}.${signState(signed)}`;

  try {
    const url = provider.getAuthUrl(redirectUri, state);
    return NextResponse.json({ url, provider: providerId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not build authorization URL" },
      { status: 502 }
    );
  }
}