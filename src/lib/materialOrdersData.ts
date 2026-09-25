import type { SupabaseClient } from "@supabase/supabase-js";
import type { MaterialLine } from "@/lib/materialTakeoff";
import {
  orderProblem,
  transitionProblem,
  type MaterialOrder,
  type MaterialOrderItem,
  type MaterialOrderStatus,
  type MaterialOrderWithItems,
  type OrderDraft,
} from "@/lib/materialOrders";

/**
 * Database glue for materialOrders.ts.
 *
 * Split from the math so the contract's harness runs standalone, same as
 * crewFeedback / crewFeedbackData.
 */

// Selected explicitly rather than with *, and asserted below, because a column
// missing from a select list reads as undefined and every check against it
// quietly passes. That has bitten this repo twice — AREA_COLUMNS, then
// NOZZLE_COLUMNS, where a below-minimum safety refusal was inert for weeks.
export const ORDER_COLUMNS =
  "id, organization_id, estimate_id, status, supplier, note, placed_at, created_at, share_token, sent_at, show_prices, delivery_note";

export const ORDER_ITEM_COLUMNS =
  "id, material_order_id, snapshot, quantity, unit, unit_cost";

if (!ORDER_COLUMNS.includes("share_token")) {
  throw new Error("ORDER_COLUMNS must select share_token — the supplier link reads it");
}
if (!ORDER_COLUMNS.includes("show_prices")) {
  throw new Error("ORDER_COLUMNS must select show_prices — the supplier page decides on it");
}
if (!ORDER_COLUMNS.includes("status")) {
  throw new Error("ORDER_COLUMNS must select status — the frozen check reads it");
}
if (!ORDER_ITEM_COLUMNS.includes("unit_cost")) {
  throw new Error("ORDER_ITEM_COLUMNS must select unit_cost — the total reads it");
}

export async function listMaterialOrders(
  supabase: SupabaseClient,
  estimateId: string
): Promise<{ data: MaterialOrderWithItems[]; error: string | null }> {
  const { data: orders, error } = await supabase
    .from("material_orders")
    .select(ORDER_COLUMNS)
    .eq("estimate_id", estimateId)
    .order("created_at", { ascending: false });
  if (error) return { data: [], error: error.message };

  const rows = (orders ?? []) as unknown as MaterialOrder[];
  if (rows.length === 0) return { data: [], error: null };

  const { data: items, error: itemErr } = await supabase
    .from("material_order_items")
    .select(ORDER_ITEM_COLUMNS)
    .in("material_order_id", rows.map((o) => o.id));
  if (itemErr) return { data: [], error: itemErr.message };

  const byOrder = new Map<string, MaterialOrderItem[]>();
  for (const raw of (items ?? []) as unknown as MaterialOrderItem[]) {
    const bucket = byOrder.get(raw.material_order_id);
    if (bucket) bucket.push(raw);
    else byOrder.set(raw.material_order_id, [raw]);
  }

  return {
    data: rows.map((o) => ({ ...o, items: byOrder.get(o.id) ?? [] })),
    error: null,
  };
}

/**
 * Create an order from a draft.
 *
 * The lines are COPIED, not referenced. Every later read of this order comes
 * from these rows, so re-pricing the catalogue or editing the estimate leaves
 * it exactly as it was — which is the whole reason the table exists.
 *
 * Created as `draft`. Placing it is a separate, deliberate act, because
 * "created" and "sent to a supplier" are not the same event and only one of
 * them is reversible.
 */
export async function createMaterialOrder(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    estimateId: string;
    draft: OrderDraft;
    supplier?: string | null;
    note?: string | null;
  }
): Promise<{ data: MaterialOrder | null; error: string | null }> {
  const problem = orderProblem(input.draft);
  if (problem) return { data: null, error: problem };

  const { data, error } = await supabase
    .from("material_orders")
    .insert({
      organization_id: input.organizationId,
      estimate_id: input.estimateId,
      status: "draft",
      supplier: input.supplier?.trim() || null,
      note: input.note?.trim() || null,
    })
    .select(ORDER_COLUMNS)
    .single();
  if (error) return { data: null, error: error.message };

  const order = data as unknown as MaterialOrder;
  const rows = input.draft.lines.map((l: MaterialLine) => ({
    organization_id: input.organizationId,
    material_order_id: order.id,
    snapshot: l,
    quantity: l.quantity,
    unit: l.unit,
    unit_cost: l.unitCost,
  }));

  const { error: itemErr } = await supabase.from("material_order_items").insert(rows);
  if (itemErr) {
    // An order with no lines is a document that says a job needs no material.
    // Rather than leave one behind, take the header back out — the insert of
    // the header is the only thing that succeeded.
    await supabase.from("material_orders").delete().eq("id", order.id);
    return { data: null, error: itemErr.message };
  }

  return { data: order, error: null };
}

export async function setMaterialOrderStatus(
  supabase: SupabaseClient,
  order: Pick<MaterialOrder, "id" | "status">,
  to: MaterialOrderStatus
): Promise<string | null> {
  const problem = transitionProblem(order.status, to);
  if (problem) return problem;

  const patch: Record<string, unknown> = { status: to };
  // Stamped once, when it actually goes out. Not on create — an order can sit
  // in draft for a week.
  if (to === "placed") patch.placed_at = new Date().toISOString();

  const { error } = await supabase.from("material_orders").update(patch).eq("id", order.id);
  return error?.message ?? null;
}

export async function deleteMaterialOrder(
  supabase: SupabaseClient,
  order: Pick<MaterialOrder, "id" | "status">
): Promise<string | null> {
  if (order.status !== "draft") {
    return "Only a draft can be deleted. An order that has been placed is a record — cancel it instead.";
  }
  const { error } = await supabase.from("material_orders").delete().eq("id", order.id);
  return error?.message ?? null;
}
