import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import JobLaborRateControl from "@/components/JobLaborRateControl";
import Link from "next/link";
import { Calculator, Plus } from "lucide-react";

// Office-only: cost-budget-vs-actual per cost code for a job.
//   Budget   = latest estimate's line items (qty × internal_cost, falling back
//              to unit_price when no internal cost is set), grouped by cost code.
//   Actuals  = shared receipts (amount) + crew time entries (hours × job labor_rate).
// Variance  = cost budget − actual  (positive = under budget, negative = over).
//
// Using internal_cost (not the customer sell price) gives the conventional PM
// reading: budget is what the work costs us, actuals are what we spent. Older
// estimates without internal_cost fall back to unit_price so they still work.
//
// Receipts/time with no cost code roll into an "Uncoded" bucket so the office
// can see untagged spend at a glance. Untagged receipts still count toward the
// job total; untagged time hours are shown but, like all labor, only priced
// when a labor rate is set.

type EstimateLine = {
  cost_code_id: string | null;
  quantity: number;
  unit_price: number;
  internal_cost: number | null;
};
type ChangeOrderLine = {
  cost_code_id: string | null;
  quantity: number;
  unit_price: number;
};
type ChangeOrderRow = { is_credit: boolean; change_order_lines: ChangeOrderLine[] | null };
type TimeRow = { cost_code_id: string | null; clock_in_at: string; clock_out_at: string | null };
type ReceiptRow = { cost_code_id: string | null; amount: number | null };
type CodeRow = { id: string; code: string; name: string };

function hoursBetween(inIso: string, outIso: string): number {
  const ms = new Date(outIso).getTime() - new Date(inIso).getTime();
  return ms > 0 ? ms / 3_600_000 : 0;
}

export default async function JobBudget({ jobId }: { jobId: string }) {
  const supabase = await createClient();

  // Fan out every independent read in parallel — the labor rate used to be a
  // serial await before this block, adding a round trip before any of the
  // budget queries could start.
  const [
    { data: job },
    { data: estimate },
    { data: costCodes },
    { data: timeRows },
    { data: receiptRows },
    { data: changeOrders },
  ] = await Promise.all([
    // Job labor rate (for converting hours → dollars).
    supabase.from("jobs").select("labor_rate").eq("id", jobId).single(),
    // Latest estimate (any status) for the job → the working cost budget.
    supabase
      .from("estimates")
      .select("id, title, status, created_at, estimate_line_items(cost_code_id, quantity, unit_price, internal_cost)")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("cost_codes").select("id, code, name").order("code"),
    supabase
      .from("time_entries")
      .select("cost_code_id, clock_in_at, clock_out_at")
      .eq("job_id", jobId)
      // Exclude rejected entries — they're not real cost. Approved + pending
      // both count (pending is real labor awaiting approval). Audit §2.2.
      .in("status", ["approved", "pending"]),
    supabase
      .from("receipts")
      .select("cost_code_id, amount")
      .eq("job_id", jobId),
    // Approved change orders for the job → their lines raise/lower the budget
    // per cost code (credits are negative). Pending/rejected COs are ignored.
    supabase
      .from("change_orders")
      .select("id, is_credit, change_order_lines(cost_code_id, quantity, unit_price)")
      .eq("job_id", jobId)
      .eq("status", "approved"),
  ]);
  const laborRate = job?.labor_rate != null ? Number(job.labor_rate) : null;

  const codeName = new Map<string, CodeRow>(
    ((costCodes as CodeRow[] | null) ?? []).map((c) => [c.id, c])
  );

  // Cost budget per cost code (from the latest estimate). Uses internal_cost
  // when set, falling back to unit_price so estimates without cost data still
  // produce a budget figure.
  const budgetByCode = new Map<string, number>();
  let estimateTotal = 0;
  const estLines = (estimate?.estimate_line_items as EstimateLine[] | null) ?? [];
  for (const l of estLines) {
    const key = l.cost_code_id ?? "__uncoded__";
    const unitCost =
      l.internal_cost != null && Number(l.internal_cost) !== 0
        ? Number(l.internal_cost)
        : Number(l.unit_price) || 0;
    const line = (Number(l.quantity) || 0) * unitCost;
    budgetByCode.set(key, (budgetByCode.get(key) ?? 0) + line);
    estimateTotal += line;
  }

  // Approved change orders raise (or lower, for credits) the cost budget per
  // cost code. They're additive to the estimate budget so the office sees the
  // updated contract value after approved changes.
  const coRows = (changeOrders as ChangeOrderRow[] | null) ?? [];
  let coCount = 0;
  for (const co of coRows) {
    coCount += 1;
    const sign = co.is_credit ? -1 : 1;
    for (const l of (co.change_order_lines ?? [])) {
      const key = l.cost_code_id ?? "__uncoded__";
      const line = sign * (Number(l.quantity) || 0) * (Number(l.unit_price) || 0);
      budgetByCode.set(key, (budgetByCode.get(key) ?? 0) + line);
      estimateTotal += line;
    }
  }

  // Actuals: labor hours + receipts, per cost code.
  const hoursByCode = new Map<string, number>();
  let totalHours = 0;
  for (const t of (timeRows as TimeRow[] | null) ?? []) {
    if (!t.clock_out_at) continue; // open/on-the-clock entries not counted in actuals
    const h = hoursBetween(t.clock_in_at, t.clock_out_at);
    const key = t.cost_code_id ?? "__uncoded__";
    hoursByCode.set(key, (hoursByCode.get(key) ?? 0) + h);
    totalHours += h;
  }

  const receiptsByCode = new Map<string, number>();
  let totalReceipts = 0;
  for (const r of (receiptRows as ReceiptRow[] | null) ?? []) {
    const amt = Number(r.amount) || 0;
    const key = r.cost_code_id ?? "__uncoded__";
    receiptsByCode.set(key, (receiptsByCode.get(key) ?? 0) + amt);
    totalReceipts += amt;
  }

  const laborCost = laborRate != null ? totalHours * laborRate : 0;
  const actualTotal = laborCost + totalReceipts;
  const totalVariance = estimateTotal - actualTotal;

  // Union of all cost codes that appear in budget or actuals.
  const keys = new Set<string>([
    ...budgetByCode.keys(),
    ...hoursByCode.keys(),
    ...receiptsByCode.keys(),
  ]);

  // No estimate AND no actuals → nothing to show.
  if (keys.size === 0) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
          <Calculator className="w-4 h-4" />
          Cost Budget vs Actual
        </h2>
        <div className="bg-white rounded-lg p-4 text-center">
          <p className="text-sm text-gray-500">
            No estimate or cost-coded activity yet.
          </p>
          <Link
            href={`/estimates/new?job=${jobId}`}
            className="inline-flex items-center gap-1 mt-2 text-sm text-blue-600 font-medium"
          >
            <Plus className="w-4 h-4" />
            Create an estimate
          </Link>
        </div>
      </section>
    );
  }

  // Build rows sorted: coded first (by code), uncoded last.
  const UNCODED = "__uncoded__";
  const sortedKeys = [...keys].sort((a, b) => {
    if (a === UNCODED) return 1;
    if (b === UNCODED) return -1;
    return (codeName.get(a)?.code ?? "~~~~").localeCompare(codeName.get(b)?.code ?? "~~~~");
  });

  const rateMissing = laborRate == null && totalHours > 0;

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
        <Calculator className="w-4 h-4" />
        Cost Budget vs Actual
      </h2>

      {/* Budget source + labor rate control */}
      <div className="bg-white rounded-lg p-3 shadow-sm mb-2 space-y-2">
        {estimate ? (
          <div className="flex items-center justify-between gap-2">
            <Link
              href={`/estimates/${estimate.id}`}
              className="text-xs text-gray-600 truncate"
            >
              Budget from <span className="font-medium text-gray-900">
                {estimate.title || "latest estimate"}
              </span>{" "}
              <span className="text-gray-400 capitalize">({estimate.status})</span>
            </Link>
            <JobLaborRateControl jobId={jobId} initialRate={laborRate} />
          </div>
        ) : (
          <>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              No estimate for this job — actuals show but there&rsquo;s no budget to
              compare against.{" "}
              <Link href={`/estimates/new?job=${jobId}`} className="underline font-medium">
                Create an estimate
              </Link>
              .
            </p>
            <JobLaborRateControl jobId={jobId} initialRate={laborRate} />
          </>
        )}
        {rateMissing && (
          <p className="text-xs text-gray-500">
            Set a labor rate above to price {totalHours.toFixed(1)} hrs of crew time.
          </p>
        )}
      </div>

      {/* Per-code table */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="text-left font-semibold px-2 py-2">Code</th>
                <th className="text-right font-semibold px-2 py-2">Budget</th>
                <th className="text-right font-semibold px-2 py-2">Labor {laborRate != null ? `$` : "hrs"}</th>
                <th className="text-right font-semibold px-2 py-2">Receipts</th>
                <th className="text-right font-semibold px-2 py-2">Actual</th>
                <th className="text-right font-semibold px-2 py-2">Var</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sortedKeys.map((key) => {
                const c = key === UNCODED ? null : codeName.get(key);
                const budget = budgetByCode.get(key) ?? 0;
                const hours = hoursByCode.get(key) ?? 0;
                const labor = laborRate != null ? hours * laborRate : 0;
                const recpts = receiptsByCode.get(key) ?? 0;
                const actual = labor + recpts;
                const variance = budget - actual;
                const over = variance < -0.005;
                const under = variance > 0.005;
                return (
                  <tr key={key} className={key === UNCODED ? "text-gray-500 italic" : ""}>
                    <td className="px-2 py-2">
                      <div className="font-mono font-semibold text-gray-900 not-italic">
                        {c ? c.code : "Uncoded"}
                      </div>
                      {c && (
                        <div className="text-[10px] text-gray-400 truncate max-w-[7rem] not-italic">
                          {c.name}
                        </div>
                      )}
                    </td>
                    <td className="text-right px-2 py-2 tabular-nums">{formatMoney(budget)}</td>
                    <td className="text-right px-2 py-2 tabular-nums">
                      {laborRate != null ? formatMoney(labor) : hours > 0 ? `${hours.toFixed(1)}h` : "—"}
                    </td>
                    <td className="text-right px-2 py-2 tabular-nums">{formatMoney(recpts)}</td>
                    <td className="text-right px-2 py-2 tabular-nums font-medium">{formatMoney(actual)}</td>
                    <td
                      className={`text-right px-2 py-2 tabular-nums font-semibold ${
                        over ? "text-red-600" : under ? "text-green-600" : "text-gray-400"
                      }`}
                    >
                      {formatMoney(variance)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50 font-semibold text-gray-900">
              <tr>
                <td className="px-2 py-2">Total</td>
                <td className="text-right px-2 py-2 tabular-nums">{formatMoney(estimateTotal)}</td>
                <td className="text-right px-2 py-2 tabular-nums">
                  {laborRate != null ? formatMoney(laborCost) : `${totalHours.toFixed(1)}h`}
                </td>
                <td className="text-right px-2 py-2 tabular-nums">{formatMoney(totalReceipts)}</td>
                <td className="text-right px-2 py-2 tabular-nums">{formatMoney(actualTotal)}</td>
                <td
                  className={`text-right px-2 py-2 tabular-nums ${
                    totalVariance < -0.005 ? "text-red-600" : totalVariance > 0.005 ? "text-green-600" : "text-gray-500"
                  }`}
                >
                  {formatMoney(totalVariance)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <p className="text-[10px] text-gray-400 mt-1">
        Cost budget = latest estimate (internal cost, falling back to sell price)
        {coCount > 0 ? ` + ${coCount} approved change order${coCount > 1 ? "s" : ""}` : ""}
        {" · "}Labor = closed time entries × rate · Receipts = shared expenses. Positive variance = under budget.
      </p>
    </section>
  );
}