import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { getMeIdentity } from "@/lib/tenant";

export const dynamic = "force-dynamic";

// Office/admin "Revise" of a SENT or REJECTED estimate → returns it to draft so
// the office can edit + re-send. Approved estimates are NOT revisable (an
// approved estimate may already have an invoice — use a change order to modify
// scope). The action nulls the share_token so the customer's existing /q/{token}
// link stops working (404) — they can't see a half-edited estimate; the office
// re-sends to mint a fresh token (and a fresh `estimate_sends` snapshot).
//
// The send snapshot (Issue 3) is the liability record of what was already sent,
// so revising the live row never destroys proof of the original terms. Guards:
// caller must be office/admin (or super_admin); the estimate must be in the
// caller's org (cross-tenant → 403); status ∈ {sent, rejected}.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (me.role !== "office" && me.role !== "admin" && !me.isSuperAdmin) {
    return NextResponse.json({ error: "Office or admin only" }, { status: 403 });
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Load the row to check status + org before any write. Service role reads
  // regardless of RLS, so the org guard is explicit (not RLS-enforced here).
  const { data: est } = await admin
    .from("estimates")
    .select("id, status, organization_id")
    .eq("id", id)
    .maybeSingle();
  if (!est) {
    return NextResponse.json({ error: "Estimate not found" }, { status: 404 });
  }
  const status = (est.status as string) ?? "";
  const orgId = (est.organization_id as string | null) ?? null;

  if (!me.isSuperAdmin && me.orgId !== orgId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  if (status !== "sent" && status !== "rejected") {
    const msg =
      status === "draft"
        ? "This estimate is already a draft — just edit it."
        : status === "approved"
        ? "Approved estimates can't be revised — create a change order to modify scope."
        : status === "converted"
        ? "This estimate is converted — edit the schedules directly."
        : `Estimates in status '${status}' can't be revised.`;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Return to draft + void the sent link + clear the lifecycle stamps. The
  // `estimate_sends` snapshot rows are untouched (they remain the historical
  // record). The `.eq("organization_id", orgId)` is the cross-tenant backstop
  // (defense-in-depth on top of the explicit guard above).
  const { error } = await admin
    .from("estimates")
    .update({
      status: "draft",
      share_token: null,
      sent_at: null,
      viewed_at: null,
      approved_at: null,
      rejected_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", orgId ?? "");

  if (error) {
    return NextResponse.json(
      { error: `Failed to revise: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}