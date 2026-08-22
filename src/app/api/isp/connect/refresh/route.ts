import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { isIspOrg } from "@/lib/ispModule";
import { refreshConnectAccount } from "@/lib/ispBilling";

export const dynamic = "force-dynamic";

// Re-read the org's connected account from Stripe and persist the capability
// flags. Org admin only.
//
// This exists because returning from Stripe's onboarding flow tells us almost
// nothing: Stripe is explicit that hitting `return_url` means only that the
// flow was entered and exited, NOT that onboarding completed or that any
// requirement was satisfied. A user can bail halfway and still land on
// return_url. So the settings page calls this on mount after `?connect=return`
// and gets the truth, rather than optimistically flipping itself to
// "Connected" and then failing at the first enrollment.
//
// `account.updated` webhooks keep the flags fresh afterwards; this route is the
// manual path for the return trip and the "Refresh status" button.

export async function POST() {
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can refresh Stripe status" },
      { status: 403 }
    );
  }
  if (!(await isIspOrg(tenant.orgId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const row = await refreshConnectAccount(tenant.orgId);
    if (!row) {
      return NextResponse.json({ connected: false });
    }
    return NextResponse.json({
      connected: true,
      status: row.status,
      chargesEnabled: row.charges_enabled,
      payoutsEnabled: row.payouts_enabled,
      detailsSubmitted: row.details_submitted,
      livemode: row.livemode,
      requirements: row.requirements,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Could not refresh Stripe status",
      },
      { status: 502 }
    );
  }
}
