import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { replaceDraftLineItems, type LineItemInput } from "@/lib/invoiceLineItems";

export const dynamic = "force-dynamic";

// Replace all line items on a DRAFT invoice (§1.2: fix a typo / add / remove a
// line without void+recreate). Office/admin/PM only. The draft gate + race
// guard + org guard live in the SECURITY DEFINER RPC (see
// src/lib/invoiceLineItems.ts + replace_draft_invoice_line_items.sql); this
// route just auths the caller and forwards. A sent/paid/void invoice is refused
// by the RPC (409); a missing/other-org invoice is refused (404).
//
// The model is full-replace: the client sends the entire desired line-item
// array. Array order is the source of truth. The office edits freely in the
// LineItemEditor, then clicks Save — the whole array is swapped atomically.

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // One cached identity read (shared with the root layout) — no extra round trip.
  const tenant = await getMe();
  if (!tenant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can edit invoices" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    items?: LineItemInput[];
  };
  if (!Array.isArray(body.items)) {
    return NextResponse.json({ error: "Missing items array" }, { status: 400 });
  }

  // Drop fully-blank rows (no description AND zero qty AND zero price) so the
  // editor's trailing blank row can't sneak in as a $0 line. A draft with zero
  // meaningful lines is degenerate — the office should void it instead.
  const meaningful = body.items.filter(
    (it) =>
      (it.description?.trim() ?? "") !== "" ||
      Number(it.quantity) > 0 ||
      Number(it.unit_price) > 0
  );
  if (meaningful.length === 0) {
    return NextResponse.json(
      { error: "Add at least one line item (or void the draft)" },
      { status: 400 }
    );
  }

  const result = await replaceDraftLineItems({
    invoiceId: id,
    orgId: tenant.orgId,
    items: meaningful,
  });
  if (result.error) {
    // The RPC raises 'Invoice is sent — …' (non-draft) or 'Invoice not found'
    // (missing / other org). Map accordingly.
    const status = /not found/i.test(result.error) ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ items: result.items, total: result.total });
}