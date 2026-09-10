/**
 * Material orders — a take-off, frozen at the moment you buy from it.
 *
 * The take-off (materialTakeoff.ts) is LIVE: edit the estimate and it follows.
 * That is right for a shopping list and wrong for an order, because the moment
 * a supplier has the paperwork, the numbers on it stopped being yours to
 * change. So placing an order copies the lines, exactly as estimates snapshot
 * their pricing, and nothing that happens to the estimate afterwards moves it.
 *
 * WHAT IT REFUSES TO PUT ON AN ORDER, and why each refusal is not pedantry:
 *
 * - A line with no orderable quantity. Sod with no pallet size has no count;
 *   sending a supplier a request for "0" or for square feet is worse than
 *   sending nothing, because it looks like an answer.
 * - Nothing at all. An empty order is a document that says a job needs no
 *   material, which is never true and is easy to act on by mistake.
 *
 * It does NOT refuse an unpriced line. You often order before you know the
 * price — that is what a quote request IS. The line goes on, at zero, flagged,
 * and the order's total says it is incomplete rather than pretending.
 *
 * Pure. No database. The I/O half lives in materialOrdersData.ts.
 */

import type { MaterialLine, MaterialTakeoff } from "@/lib/materialTakeoff";

/**
 * draft is the only editable state. Everything else is a record of something
 * that already happened, enforced here AND by a trigger — a rule that lives
 * only in TypeScript is one the next writer walks straight past.
 */
export type MaterialOrderStatus = "draft" | "placed" | "received" | "canceled";

export type MaterialOrder = {
  id: string;
  organization_id: string;
  estimate_id: string;
  status: MaterialOrderStatus;
  supplier: string | null;
  note: string | null;
  placed_at: string | null;
  created_at: string;
  /** The credential in the supplier link. Never rendered on a public page. */
  share_token: string;
  sent_at: string | null;
  /**
   * Whether the supplier sees money.
   *
   * OFF by default, and that default is the point: unit_cost is what the ORG
   * expects to pay and may have come from a DIFFERENT supplier. Prices hidden,
   * this document asks for a quote; prices shown, it is a purchase order. Both
   * are useful and confusing them costs real money.
   */
  show_prices: boolean;
  delivery_note: string | null;
};

export type MaterialOrderItem = {
  id: string;
  material_order_id: string;
  snapshot: MaterialLine;
  quantity: number;
  unit: MaterialLine["unit"];
  unit_cost: number;
};

export type MaterialOrderWithItems = MaterialOrder & { items: MaterialOrderItem[] };

/** What an order would contain, and what it would leave behind. */
export type OrderDraft = {
  lines: MaterialLine[];
  /** Lines that cannot go on an order, with the reason already on each. */
  excluded: MaterialLine[];
  total: number;
  unpricedCount: number;
};

const money = (n: number) => Math.round(n * 100) / 100;

export function draftFromTakeoff(takeoff: MaterialTakeoff): OrderDraft {
  const lines: MaterialLine[] = [];
  const excluded: MaterialLine[] = [];
  for (const l of takeoff.lines) {
    // Orderable AND a real quantity. The second check is not redundant: a line
    // can be marked orderable and still round to nothing.
    if (l.orderable && l.quantity > 0) lines.push(l);
    else excluded.push(l);
  }
  let total = 0;
  let unpricedCount = 0;
  for (const l of lines) {
    if (l.unpriced) unpricedCount += 1;
    else total += l.extendedCost;
  }
  return { lines, excluded, total: money(total), unpricedCount };
}

/**
 * Why this draft cannot become an order, or null when it can.
 *
 * Returns a sentence for a person, not a code. The caller shows it verbatim.
 */
export function orderProblem(draft: OrderDraft): string | null {
  if (draft.lines.length === 0) {
    if (draft.excluded.length > 0) {
      return "Nothing on this estimate can be ordered yet. Every line is missing something — fix those first.";
    }
    return "There is nothing to order. Place plants, sod or heads on the map, or add parts.";
  }
  return null;
}

/**
 * One sentence about what an order leaves out, or null when it leaves nothing.
 *
 * Said BEFORE the order is created, not after: the point is that someone
 * decides whether to go ahead knowing what is missing.
 */
export function exclusionWarning(draft: OrderDraft): string | null {
  const parts: string[] = [];
  if (draft.excluded.length > 0) {
    parts.push(
      `${draft.excluded.length} line${draft.excluded.length === 1 ? "" : "s"} cannot be ordered and will be left off`
    );
  }
  if (draft.unpricedCount > 0) {
    parts.push(
      `${draft.unpricedCount} line${draft.unpricedCount === 1 ? "" : "s"} have no cost, so the total is not the whole bill`
    );
  }
  if (parts.length === 0) return null;
  return `${parts.join(", and ")}.`;
}

/** True when the order is still the org's to change. */
export function isEditable(order: Pick<MaterialOrder, "status">): boolean {
  return order.status === "draft";
}

/**
 * Whether a status change is allowed, and why not when it is not.
 *
 * Placed can still be received or canceled — an order in the world can arrive
 * or be pulled. Nothing returns to draft: a document a supplier has seen cannot
 * become editable again by changing a dropdown.
 */
const NEXT: Record<MaterialOrderStatus, MaterialOrderStatus[]> = {
  draft: ["placed", "canceled"],
  placed: ["received", "canceled"],
  received: [],
  canceled: [],
};

export function transitionProblem(
  from: MaterialOrderStatus,
  to: MaterialOrderStatus
): string | null {
  if (from === to) return null;
  if (NEXT[from].includes(to)) return null;
  if (to === "draft") {
    return "An order that has left draft cannot go back to it. Cancel it and raise a new one.";
  }
  return `An order that is ${from} cannot become ${to}.`;
}

/** What the order actually costs, from the SNAPSHOTS — never from the catalogue. */
export function orderTotal(items: Pick<MaterialOrderItem, "quantity" | "unit_cost">[]): number {
  return money(items.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0));
}

/** Lines on the order with no price. Counted, so the total can say it is partial. */
export function unpricedItems(
  items: Pick<MaterialOrderItem, "unit_cost">[]
): number {
  return items.filter((i) => !(i.unit_cost > 0)).length;
}

/**
 * What the supplier is looking at, in words.
 *
 * A document with no prices is a request for a quote, not an order — saying so
 * on the page stops a supplier reading a blank price column as "free" or as an
 * omission to be queried.
 */
export function describeSupplierDoc(order: Pick<MaterialOrder, "show_prices">): string {
  return order.show_prices
    ? "This is an order. The prices are what we expect to pay — tell us if any are wrong before you ship."
    : "This is a request for a quote, not an order. Prices are deliberately left off: please quote us.";
}

/** The path a supplier opens. Origin is added by the caller, which knows it. */
export function orderSharePath(order: Pick<MaterialOrder, "share_token">): string {
  return `/o/${order.share_token}`;
}

/**
 * Can this order be sent yet?
 *
 * A draft can. What it must not be is EMPTY — a supplier receiving a document
 * with no lines has been sent a puzzle, and it is the kind of mistake that is
 * only obvious after they reply asking what it is.
 */
export function sendProblem(
  order: Pick<MaterialOrder, "status">,
  itemCount: number
): string | null {
  if (itemCount <= 0) {
    return "This order has no lines. There is nothing for a supplier to read.";
  }
  if (order.status === "canceled") {
    return "This order was canceled. Raise a new one rather than sending it.";
  }
  return null;
}

export function describeStatus(status: MaterialOrderStatus): string {
  switch (status) {
    case "draft":
      return "Draft — not sent, still yours to change";
    case "placed":
      return "Placed — with the supplier, lines frozen";
    case "received":
      return "Received";
    case "canceled":
      return "Canceled";
  }
}
