import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { isIspOrg } from "@/lib/ispModule";
import { enrollCustomer } from "@/lib/ispSubscriptions";

export const dynamic = "force-dynamic";

// Enroll a customer onto a plan. Office/PM only.
//
// Returns a Stripe Checkout URL rather than completing the enrollment: the
// subscriber has to enter their own card and clear any 3DS challenge. The
// office hands that link to the customer (or opens it on a tablet at the
// kitchen table during the install). Nothing is billed until they finish, and
// the subscription only becomes real in our DB when the webhook says so.

export async function POST(request: Request) {
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only office staff can enroll a customer" },
      { status: 403 }
    );
  }
  if (!(await isIspOrg(tenant.orgId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    customerId?: string;
    planId?: string;
  };
  if (!body.customerId || !body.planId) {
    return NextResponse.json(
      { error: "Pick a customer and a plan" },
      { status: 400 }
    );
  }

  try {
    const result = await enrollCustomer({
      orgId: tenant.orgId,
      customerId: body.customerId,
      planId: body.planId,
      origin: new URL(request.url).origin,
    });
    return NextResponse.json({
      ok: true,
      checkoutUrl: result.checkoutUrl,
      subscriptionId: result.subscriptionRowId,
    });
  } catch (err) {
    // enrollCustomer throws user-facing messages by design (no Stripe account
    // connected, plan has no price, customer already subscribed) — pass them
    // straight through instead of flattening to "something went wrong."
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not enroll customer" },
      { status: 400 }
    );
  }
}
