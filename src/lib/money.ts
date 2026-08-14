// Pure money/line-item helpers shared by server and client components.
// IMPORTANT: this module must NOT have a "use client" directive and must not
// import any client-only code. Functions exported from a "use client" module
// become client-only references that throw when called from a server component
// (the cause of the /invoices/[id] 500s). Keeping these helpers in a plain
// server-safe module lets server components call them directly.

export type LineItem = {
  description: string;
  quantity: number;
  unit_price: number;
};

export function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount || 0);
}

export function computeTotal(items: { quantity: number; unit_price: number }[]) {
  return items.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );
}

// Pricing summary for the professional estimate document. Mirrors the math in
// approve_estimate (estimates_merge_a / estimate_creator_upgrade) and the
// decide route so the office preview, the customer view, and the generated
// invoice all derive the same grand total. All amounts round to cents the same
// way Postgres round(numeric, 2) does (half away from zero) so totals match the
// invoice summary lines to the penny.
export type EstimatePricing = {
  markupPct?: number | null;
  contingencyPct?: number | null;
  taxPct?: number | null;
  depositPct?: number | null;
  depositAmount?: number | null;
};

export type EstimateTotals = {
  subtotal: number;
  markupAmount: number;
  contingencyAmount: number;
  taxAmount: number;
  preTax: number;
  grandTotal: number;
  depositAmount: number;
  balanceDue: number;
};

// Round to cents, half away from zero (matches Postgres round(numeric, 2)).
function round2(n: number): number {
  const neg = n < 0 ? -1 : 1;
  return (Math.round(Math.abs(n) * 100) / 100) * neg;
}

export function computeEstimateTotals(
  items: { quantity: number; unit_price: number }[],
  pricing?: EstimatePricing | null
): EstimateTotals {
  const subtotal = computeTotal(items);
  const markupPct = Number(pricing?.markupPct ?? 0) || 0;
  const contingencyPct = Number(pricing?.contingencyPct ?? 0) || 0;
  const taxPct = Number(pricing?.taxPct ?? 0) || 0;
  const depositPct = Number(pricing?.depositPct ?? 0) || 0;
  const depositAmtArg = Number(pricing?.depositAmount ?? 0) || 0;

  const markupAmount = markupPct > 0 ? round2((subtotal * markupPct) / 100) : 0;
  const contingencyAmount =
    contingencyPct > 0 ? round2((subtotal * contingencyPct) / 100) : 0;
  const preTax = round2(subtotal + markupAmount + contingencyAmount);
  const taxAmount = taxPct > 0 ? round2((preTax * taxPct) / 100) : 0;
  const grandTotal = round2(preTax + taxAmount);

  // Deposit = explicit dollar amount when > 0, else % of the grand total.
  const depositAmount =
    depositAmtArg > 0 ? round2(depositAmtArg) : depositPct > 0 ? round2((grandTotal * depositPct) / 100) : 0;
  const balanceDue = round2(grandTotal - depositAmount);

  return {
    subtotal,
    markupAmount,
    contingencyAmount,
    taxAmount,
    preTax,
    grandTotal,
    depositAmount,
    balanceDue,
  };
}

// Office-only: total internal cost of a set of line items (qty × internal_cost).
// Lines without an internal_cost contribute 0 — this is the *true* cost figure
// for the editor's margin panel (margin = sell − this). JobBudget uses its own
// inline fallback to unit_price for the budget column (estimates without cost
// data still show a budget number there).
export function computeInternalCost(
  items: { quantity: number; internal_cost?: number | null }[]
): number {
  return items.reduce(
    (sum, item) =>
      sum +
      (item.quantity || 0) *
        (item.internal_cost != null ? Number(item.internal_cost) || 0 : 0),
    0
  );
}