// Server-only line-item editing for DRAFT invoices (§1.2). The actual atomic
// swap + draft gate + race guard live in the SECURITY DEFINER RPC
// `replace_draft_invoice_line_items` (see replace_draft_invoice_line_items.sql):
// it takes a FOR UPDATE lock on the invoice so a concurrent office "Send"
// (draft→sent) can't land mid-swap and wipe a now-sent invoice's lines (a $0
// sent invoice). This helper just marshals the call + normalizes the result.
//
// Only the service role calls the RPC (anon + authenticated execute revoked —
// the RPC is SECURITY DEFINER and checks org + status='draft' but NOT the
// caller's role, so the route's office gate is the role boundary and the RPC's
// org guard is the data boundary). The model is full-replace (PUT): the client
// sends the entire desired line-item array; array order is the source of truth
// (positions are re-indexed server-side; ids are minted fresh on every save).

import { createAdminClient } from "@/lib/supabase/admin";

export type LineItemInput = {
  description: string;
  quantity: number;
  unit_price: number;
};

export type LineItemRow = {
  id: string;
  invoice_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  position: number;
};

export type ReplaceLineItemsResult =
  | { items: LineItemRow[]; total: number; error?: undefined }
  | { items?: undefined; total?: undefined; error: string };

// Replace every line item on the draft invoice with `items` (array order =
// display order). Returns the persisted rows (with fresh ids) + the recomputed
// total, or an error string from the RPC (e.g. "Invoice is sent — only draft
// invoices can be edited." / "Invoice not found"). The caller maps the error to
// the right HTTP status.
export async function replaceDraftLineItems(input: {
  invoiceId: string;
  orgId: string;
  items: LineItemInput[];
}): Promise<ReplaceLineItemsResult> {
  const admin = createAdminClient();
  // Strip any ids/positions the client may send — the RPC re-indexes positions
  // from array order and mints fresh ids. Coerce numerics defensively; empty
  // arrays are rejected by the route before this runs.
  const payload = (input.items ?? []).map((it) => ({
    description: String(it.description ?? ""),
    quantity: Number(it.quantity) || 0,
    unit_price: Number(it.unit_price) || 0,
  }));

  const { data, error } = await admin.rpc("replace_draft_invoice_line_items", {
    p_invoice_id: input.invoiceId,
    p_org_id: input.orgId,
    p_items: payload,
  });
  if (error) {
    return { error: error.message };
  }

  // PostgREST returns numeric(10,2) columns as strings — normalize to numbers
  // so the UI doesn't have to. (Matches how every other invoice read does it:
  // Number(item.quantity) at the call site.)
  const raw = (data ?? []) as unknown as Array<{
    id: string;
    invoice_id: string;
    description: string | null;
    quantity: string | number;
    unit_price: string | number;
    position: string | number;
  }>;
  const items: LineItemRow[] = raw.map((r) => ({
    id: r.id,
    invoice_id: r.invoice_id,
    description: r.description ?? "",
    quantity: Number(r.quantity) || 0,
    unit_price: Number(r.unit_price) || 0,
    position: Number(r.position) || 0,
  }));
  const total = items.reduce(
    (s, i) => s + i.quantity * i.unit_price,
    0
  );
  return { items, total };
}