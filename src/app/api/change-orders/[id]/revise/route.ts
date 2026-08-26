import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { getMeIdentity } from "@/lib/tenant";
import { OFFICE_OR_PM } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Office/admin/PM "Revise" of a SENT or REJECTED change order → returns it to
// draft so the office can edit + re-send. (Sent COs otherwise have no undo-send
// path; rejected COs had a broken local-only "Reopen as draft" before this.)
// Approved COs are NOT revisable — an approved CO may already be on an invoice
// (Issue 4 wires approved COs to invoice_line_items). The action nulls the
// share_token so the customer's existing /co/{token} link 404s, and clears the
// Issue 5 approval-attribution stamps (a revised + resent CO is a fresh
// decision). The `change_order_sends` snapshot rows stay (liability record).
// Guards: caller office/admin/PM (or super_admin); same org; status ∈ {sent, rejected}.
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
  if (!OFFICE_OR_PM.has(me.role as never) && !me.isSuperAdmin) {
    return NextResponse.json({ error: "Office or PM only" }, { status: 403 });
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: co } = await admin
    .from("change_orders")
    .select("id, status, organization_id")
    .eq("id", id)
    .maybeSingle();
  if (!co) {
    return NextResponse.json({ error: "Change order not found" }, { status: 404 });
  }
  const status = (co.status as string) ?? "";
  const orgId = (co.organization_id as string | null) ?? null;

  if (!me.isSuperAdmin && me.orgId !== orgId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  if (status !== "sent" && status !== "rejected") {
    const msg =
      status === "draft"
        ? "This change order is already a draft — just edit it."
        : status === "approved"
        ? "Approved change orders can't be revised (they may be on an invoice). Void it if you need to cancel."
        : status === "submitted"
        ? "This change order is submitted for internal review — edit it as a submitted draft."
        : status === "void"
        ? "Void change orders can't be revised."
        : `Change orders in status '${status}' can't be revised.`;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const { error } = await admin
    .from("change_orders")
    .update({
      status: "draft",
      share_token: null,
      sent_at: null,
      viewed_at: null,
      approved_at: null,
      rejected_at: null,
      // Clear Issue 5 attribution — a revised + resent CO is a fresh decision.
      approved_by: null,
      approval_method: null,
      approval_note: null,
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