import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMyOrg } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { disconnect } from "@/lib/accounting/connections";
import type { AccountingProviderId } from "@/lib/accounting/provider";

export const dynamic = "force-dynamic";

// Disconnect an accounting provider: clears the encrypted tokens + marks the
// row `disconnected` (keeps the row for audit). Office/admin only.

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
      { error: "Only an organization admin can disconnect a bookkeeping provider" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const providerId = (body.provider ?? "quickbooks") as AccountingProviderId;
  if (!["quickbooks", "xero", "freshbooks", "wave", "stripe_byo"].includes(providerId)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  await disconnect(tenant.orgId, providerId);
  return NextResponse.json({ ok: true, provider: providerId });
}