import { NextResponse } from "next/server";
import { getProvider } from "@/lib/accounting/provider";
import type { AccountingProviderId } from "@/lib/accounting/provider";
import { signState } from "@/lib/accounting/crypto";
import { markConnected } from "@/lib/accounting/connections";
import { captureException } from "@/lib/sentry";

export const dynamic = "force-dynamic";

// OAuth2 callback for every accounting provider. The provider redirects here
// with `?code=…&state=…` (QBO also sends `realmId`). We:
//   1. Verify `state` = `${orgId}.${hmac}` so a forged callback can't bind
//      tokens to an org the caller doesn't own (CSRF).
//   2. Exchange the code for tokens (provider.exchangeCodeForTokens).
//   3. Attach realmId from the query (QBO returns it here, NOT in the token
//      body).
//   4. Encrypt + persist the connection (service role — RLS has no INSERT
//      policy for authenticated, mirroring the notifications model).
//   5. Redirect to /admin/billing with a status flag for the UI banner.
//
// No session check here: the OAuth redirect is a top-level GET the provider
// lands on, so the CSRF-signed state (not the session) is the trust boundary.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const realmId = url.searchParams.get("realmId");
  const error = url.searchParams.get("error");

  const billing = (suffix: string) =>
    NextResponse.redirect(new URL(`/admin/billing?accounting=${suffix}`, request.url));

  if (error) return billing(`error=${encodeURIComponent(error)}`);
  if (!code) return billing("error=missing_code");

  // Verify the HMAC-signed state. Format: `${orgId}|${provider}.${hmac}`.
  const dot = state.lastIndexOf(".");
  if (dot < 0) return billing("error=bad_state");
  const signed = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const bar = signed.indexOf("|");
  if (bar < 0) return billing("error=bad_state");
  const orgId = signed.slice(0, bar);
  const providerParam = signed.slice(bar + 1) as AccountingProviderId;
  if (!orgId || sig !== signState(signed)) return billing("error=bad_state");

  if (!["quickbooks", "xero", "freshbooks", "wave", "stripe_byo"].includes(providerParam)) {
    return billing("error=unknown_provider");
  }

  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/accounting/callback`;

  try {
    const provider = getProvider(providerParam);
    const tokens = await provider.exchangeCodeForTokens(code, redirectUri);
    // QBO returns realmId in the callback query, not the token body.
    if (realmId) tokens.realmId = realmId;
    await markConnected(orgId, providerParam, tokens, {
      connectedAt: new Date().toISOString(),
      provider: providerParam,
    });
    return billing("connected");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "token exchange failed";
    captureException(err instanceof Error ? err : new Error(msg), {
      extra: { organizationId: orgId, provider: providerParam },
    });
    return billing(`error=${encodeURIComponent(msg)}`);
  }
}