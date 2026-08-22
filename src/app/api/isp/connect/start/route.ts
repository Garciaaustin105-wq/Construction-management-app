import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { isIspOrg } from "@/lib/ispModule";
import {
  createConnectedAccount,
  createOnboardingLink,
  getConnectAccount,
} from "@/lib/ispBilling";

export const dynamic = "force-dynamic";

// Begin (or resume) Stripe Connect onboarding for the org's ISP subscriber
// billing. Org admin only. Returns a single-use Stripe-hosted onboarding URL
// for the client to redirect to.
//
// WHY THERE IS NO OAUTH HERE (it's the obvious question, given
// /api/accounting/connect/start right next door):
// Stripe no longer recommends OAuth for connecting accounts — their single-
// platform policy means an existing Stripe account generally can't be linked to
// an additional platform, so the OAuth path fails for exactly the users who
// most expect it to work. The current path is: create the Account via API, then
// hand the user a Stripe-hosted onboarding link. There is consequently no
// client_id, no redirect URI to register, and no `state` HMAC to verify —
// nothing comes back to us on a callback that needs authenticating, because the
// account id was ours before the user ever left. `?connect=return` is a UI hint
// only and is never trusted; the real state comes from re-reading the account
// (see /api/isp/connect/refresh).
//
// This route is INTENTIONALLY re-runnable: an org that abandons onboarding
// halfway clicks the same button and gets a fresh link for the SAME account
// (account links expire in minutes and are single-use). It creates a second
// Stripe account only if we have no row at all.

export async function POST(request: Request) {
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can connect a Stripe account" },
      { status: 403 }
    );
  }
  if (!(await isIspOrg(tenant.orgId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      {
        error:
          "Stripe isn't configured on this deployment yet. Contact your administrator.",
      },
      { status: 409 }
    );
  }

  const origin = new URL(request.url).origin;

  try {
    const row = await getConnectAccount(tenant.orgId);

    if (!row || row.status === "disconnected") {
      // Read the org's own details so Stripe's onboarding form arrives
      // pre-filled rather than blank. Prefill is a convenience only — Stripe
      // still makes the account holder confirm everything before accepting the
      // service agreement, and once the first account link is created we can no
      // longer read or write their KYC data at all.
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();
      const { data: org } = await supabase
        .from("organizations")
        .select("id, name, email")
        .eq("id", tenant.orgId)
        .maybeSingle();

      const accountId = await createConnectedAccount({
        id: tenant.orgId,
        name: (org?.name as string | null) ?? null,
        email: (org?.email as string | null) ?? null,
      });
      const url = await createOnboardingLink(accountId, origin);
      return NextResponse.json({ url, accountId, created: true });
    }

    const url = await createOnboardingLink(row.stripe_account_id, origin);
    return NextResponse.json({ url, accountId: row.stripe_account_id, created: false });
  } catch (err) {
    // Stripe's own message is the useful one here ("Connect isn't enabled on
    // this account", "capability not available in your country", …) — passing
    // it through saves an admin a support round trip.
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Could not start Stripe onboarding",
      },
      { status: 502 }
    );
  }
}
