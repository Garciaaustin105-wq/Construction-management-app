// Pure aggregation helpers for the in-app insights dashboards (construction
// /admin/insights + lawn /lawn/insights). Server-safe — no "use client", no DB,
// no RLS. Every function is pure math over rows the caller fetched via the RLS
// session client. Sharing one source of truth here keeps the two variant
// dashboards + the existing JobBudget cost model in agreement.
//
// Reuses money.ts (computeTotal / computeEstimateTotals — totals are always
// recomputed from line items, never trusted from a stored column) and
// weekUtils.hoursFromMs. SQL/RLS/auth/financial correctness stay Claude-direct
// per [[lowvoltage-local-model-delegation]].
//
// Job profitability model (v1): uses the blended `jobs.labor_rate` (no per-role
// rate exists yet) + `estimate_line_items.internal_cost` (office-only, with a
// `unit_price` fallback matching JobBudget.tsx) + `receipts.amount` (materials)
// + approved `change_orders` (credits subtracted). Per-role costing is phase 2.

import { computeTotal, computeEstimateTotals } from "@/lib/money";
import { hoursFromMs } from "@/lib/weekUtils";

// ── Row shapes (structural; a page's fuller row type just needs these fields) ──

export type InsightsInvoice = {
  status: string;
  paid_at: string | null;
  due_date: string | null;
  amount_paid: number | null;
  invoice_line_items: { quantity: number; unit_price: number }[];
};

export type InsightsEstimate = {
  status: string;
  markup_pct?: number | null;
  contingency_pct?: number | null;
  tax_pct?: number | null;
  deposit_pct?: number | null;
  deposit_amount?: number | null;
  estimate_line_items: {
    quantity: number;
    unit_price: number;
    internal_cost?: number | null;
  }[];
};

export type InsightsTimeEntry = {
  user_id: string;
  clock_in_at: string;
  clock_out_at: string;
  user?: { full_name: string | null } | null;
};

// ── Calendar helpers ──────────────────────────────────────────────────────────

export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Last `n` months including the current one, oldest first. */
export function monthBuckets(n: number): { key: string; label: string }[] {
  const now = new Date();
  const out: { key: string; label: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ key: monthKey(d), label: MONTHS[d.getMonth()] });
  }
  return out;
}

// ── Invoice / estimate math ──────────────────────────────────────────────────

export function invoiceTotal(inv: InsightsInvoice): number {
  return computeTotal(inv.invoice_line_items ?? []);
}

export function invoiceBalance(inv: InsightsInvoice): number {
  return Math.max(0, invoiceTotal(inv) - (Number(inv.amount_paid ?? 0) || 0));
}

export function estimateGrandTotal(est: InsightsEstimate): number {
  return computeEstimateTotals(est.estimate_line_items ?? [], {
    markupPct: est.markup_pct,
    contingencyPct: est.contingency_pct,
    taxPct: est.tax_pct,
    depositPct: est.deposit_pct,
    depositAmount: est.deposit_amount,
  }).grandTotal;
}

// ── A/R aging ─────────────────────────────────────────────────────────────────
// Only OPEN invoices (status 'sent') age. A positive balance that is not yet
// due (or has no due date) is "current"; once past due it falls into 0-30 /
// 31-60 / 61-90 / 90+ day buckets measured from due_date.

export type ArAging = {
  current: number;
  d0_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
};

export function arAgingBuckets(invoices: InsightsInvoice[], todayISO: string): ArAging {
  const out: ArAging = { current: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const todayMs = new Date(`${todayISO}T00:00:00`).getTime();
  for (const inv of invoices) {
    if (inv.status !== "sent") continue;
    const bal = invoiceBalance(inv);
    if (bal <= 0) continue;
    if (!inv.due_date) {
      out.current += bal;
      continue;
    }
    const dueMs = new Date(`${inv.due_date}T00:00:00`).getTime();
    if (Number.isNaN(dueMs)) {
      out.current += bal;
      continue;
    }
    if (dueMs >= todayMs) {
      out.current += bal; // not yet due
      continue;
    }
    const daysLate = Math.floor((todayMs - dueMs) / 86_400_000);
    if (daysLate <= 30) out.d0_30 += bal;
    else if (daysLate <= 60) out.d31_60 += bal;
    else if (daysLate <= 90) out.d61_90 += bal;
    else out.d90_plus += bal;
  }
  return out;
}

/** Sum of the overdue buckets (everything past due). */
export function overdueTotal(aging: ArAging): number {
  return aging.d0_30 + aging.d31_60 + aging.d61_90 + aging.d90_plus;
}

// ── Sales pipeline ───────────────────────────────────────────────────────────

export type SalesPipeline = {
  draft: number;
  sent: number;
  approved: number;
  rejected: number;
  count: number; // active (draft+sent+approved)
  value: number; // $ value of active estimates
};

export function salesPipeline(estimates: InsightsEstimate[]): SalesPipeline {
  const count = (s: string) => estimates.filter((e) => e.status === s).length;
  const active = estimates.filter(
    (e) => e.status === "draft" || e.status === "sent" || e.status === "approved"
  );
  return {
    draft: count("draft"),
    sent: count("sent"),
    approved: count("approved"),
    rejected: count("rejected"),
    count: active.length,
    value: active.reduce((s, e) => s + estimateGrandTotal(e), 0),
  };
}

/** Sum of paid-invoice totals whose paid_at falls in the given YYYY-MM month. */
export function collectedThisMonth(
  invoices: InsightsInvoice[],
  currentMonthKey: string
): number {
  return invoices
    .filter(
      (i) =>
        i.status === "paid" &&
        i.paid_at &&
        monthKey(new Date(i.paid_at)) === currentMonthKey
    )
    .reduce((s, i) => s + invoiceTotal(i), 0);
}

// ── Crew productivity ─────────────────────────────────────────────────────────

export type CrewHours = { id: string; hours: number; name: string };

/** Top N crew by total clocked hours (excludes open/clocked-in entries). */
export function crewHoursByWorker(times: InsightsTimeEntry[], topN = 6): CrewHours[] {
  const hours = new Map<string, number>();
  const names = new Map<string, string>();
  for (const t of times) {
    const ms =
      new Date(t.clock_out_at).getTime() - new Date(t.clock_in_at).getTime();
    hours.set(t.user_id, (hours.get(t.user_id) ?? 0) + hoursFromMs(ms));
    if (t.user?.full_name) names.set(t.user_id, t.user.full_name);
  }
  return [...hours.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id, hrs]) => ({ id, hours: hrs, name: names.get(id) ?? "Crew" }));
}

// ── Job profitability (v1, blended labor rate) ────────────────────────────────

export type JobProfitabilityInput = {
  estimate: InsightsEstimate | null;
  changeOrdersApproved: { amount: number | null; is_credit: boolean | null }[];
  timeEntries: { clock_in_at: string; clock_out_at: string }[];
  receipts: { amount: number | null }[];
  laborRate: number | null;
};

export type JobProfitability = {
  contractValue: number; // estimate grand total + approved change orders (credits −)
  estimatedCost: number; // Σ qty × (internal_cost ?? unit_price)
  actualLaborHours: number;
  actualLaborCost: number; // hours × blended laborRate (0 when rate missing)
  actualMaterialCost: number; // Σ receipts.amount
  actualCost: number;
  projectedMargin: number; // contractValue − estimatedCost
  projectedMarginPct: number;
  laborRateMissing: boolean;
  hasEstimate: boolean;
  hasInternalCost: boolean; // any line carried a real internal_cost
};

export function jobProfitability(input: JobProfitabilityInput): JobProfitability {
  const { estimate, changeOrdersApproved, timeEntries, receipts, laborRate } = input;

  const coDelta = changeOrdersApproved.reduce((s, co) => {
    const amt = Number(co.amount ?? 0) || 0;
    return s + (co.is_credit ? -amt : amt);
  }, 0);
  const contractValue = (estimate ? estimateGrandTotal(estimate) : 0) + coDelta;

  // Estimated cost: use internal_cost where present, else fall back to unit_price
  // (matches JobBudget.tsx budget column — estimates without cost data still get
  // a budget figure). hasInternalCost is true only if any line had a real cost.
  let hasInternalCost = false;
  const estimatedCost = estimate
    ? (estimate.estimate_line_items ?? []).reduce((s, li) => {
        const qty = li.quantity || 0;
        const ic =
          li.internal_cost != null && Number(li.internal_cost) > 0
            ? Number(li.internal_cost)
            : null;
        if (ic != null) hasInternalCost = true;
        const cost = ic != null ? ic : li.unit_price || 0;
        return s + qty * cost;
      }, 0)
    : 0;

  const actualLaborHours = timeEntries.reduce(
    (s, t) =>
      s +
      hoursFromMs(
        new Date(t.clock_out_at).getTime() - new Date(t.clock_in_at).getTime()
      ),
    0
  );
  const rate = laborRate != null ? Number(laborRate) : null;
  const laborRateMissing = rate == null || rate <= 0;
  const actualLaborCost = laborRateMissing ? 0 : actualLaborHours * rate!;
  const actualMaterialCost = receipts.reduce(
    (s, r) => s + (Number(r.amount ?? 0) || 0),
    0
  );
  const actualCost = actualLaborCost + actualMaterialCost;
  const projectedMargin = contractValue - estimatedCost;
  const projectedMarginPct = contractValue > 0 ? (projectedMargin / contractValue) * 100 : 0;

  return {
    contractValue,
    estimatedCost,
    actualLaborHours,
    actualLaborCost,
    actualMaterialCost,
    actualCost,
    projectedMargin,
    projectedMarginPct,
    laborRateMissing,
    hasEstimate: !!estimate,
    hasInternalCost,
  };
}