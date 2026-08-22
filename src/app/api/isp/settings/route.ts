import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { isIspOrg } from "@/lib/ispModule";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Org-level ISP billing settings. Currently just the dunning grace window.
//
// WHY THIS IS A ROUTE AND NOT AN RLS-DIRECT CLIENT UPDATE (the rest of the ISP
// admin UI writes straight through the client):
// `organizations` has exactly one UPDATE policy — "Org admin update org" —
// and it requires profiles.role = 'admin' literally. It does NOT admit 'office'.
// But every other surface here is gated with isOfficeLike(), which admits
// office, admin, AND super_admin. So an `office` user editing this field
// client-direct would hit RLS, update zero rows, and get NO error back from
// PostgREST — the input would just silently snap back on reload with no
// explanation. Going through the service role keeps the permission model the
// same as the rest of the ISP module instead of having one field that
// mysteriously doesn't save for half the people who can see it.

export async function POST(request: Request) {
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can change billing settings" },
      { status: 403 }
    );
  }
  if (!(await isIspOrg(tenant.orgId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    dunningGraceDays?: unknown;
  };

  const raw = Number(body.dunningGraceDays);
  if (!Number.isInteger(raw) || raw < 0 || raw > 90) {
    return NextResponse.json(
      { error: "Grace period must be a whole number of days between 0 and 90" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("organizations")
    .update({ dunning_grace_days: raw })
    .eq("id", tenant.orgId);

  if (error) {
    return NextResponse.json(
      { error: "Could not save the grace period" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, dunningGraceDays: raw });
}
