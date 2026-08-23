import { createClient } from "@/lib/supabase/server";
import { formatMoney, computeTotal } from "@/lib/money";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";

// Estimate status -> badge tone (was the legacy StatusBadge's shared palette).
const ESTIMATE_STATUS_TONE: Record<string, BadgeTone> = {
  draft: "neutral",
  sent: "brand",
  approved: "success",
  rejected: "danger",
  converted: "success",
};

// Invoice status -> badge tone (was the legacy StatusBadge's shared palette).
const INVOICE_STATUS_TONE: Record<string, BadgeTone> = {
  draft: "neutral",
  sent: "brand",
  paid: "success",
  void: "neutral",
};
import { Receipt, Calculator } from "lucide-react";
import Link from "next/link";

export default async function JobFinancials({
  jobId,
  role,
}: {
  jobId: string;
  role: string;
}) {
  const supabase = await createClient();

  const [{ data: estimates }, { data: invoices }] = await Promise.all([
    // Estimates — office sees all; crew sees their assigned jobs (RLS).
    supabase
      .from("estimates")
      .select(
        "id, status, title, created_at, estimate_line_items(quantity, unit_price)"
      )
      .eq("job_id", jobId)
      .order("created_at", { ascending: false }),
    supabase
      .from("invoices")
      .select(
        "id, status, paid_at, created_at, amount_paid, invoice_line_items(quantity, unit_price)"
      )
      .eq("job_id", jobId)
      .order("created_at", { ascending: false }),
  ]);

  const estimateRows = (estimates ?? []).map((e) => {
    const items =
      (e.estimate_line_items as unknown as { quantity: number; unit_price: number }[]) ?? [];
    return {
      id: e.id,
      status: e.status,
      title: e.title,
      createdAt: e.created_at,
      total: computeTotal(items),
    };
  });

  const invoiceRows = (invoices ?? []).map((inv) => {
    const items =
      (inv.invoice_line_items as unknown as { quantity: number; unit_price: number }[]) ?? [];
    const invTotal = computeTotal(items);
    // amount_paid is seeded with the estimate deposit on approval; the balance
    // due is the grand total minus what's been paid. Outstanding totals use the
    // balance so a collected deposit isn't counted as still-owed.
    const amountPaid = Number((inv as { amount_paid?: number | null }).amount_paid ?? 0) || 0;
    const balanceDue = Math.max(0, invTotal - amountPaid);
    return {
      id: inv.id,
      status: inv.status,
      paidAt: inv.paid_at,
      createdAt: inv.created_at,
      total: invTotal,
      amountPaid,
      balanceDue,
    };
  });

  const unpaidTotal = invoiceRows
    .filter((i) => i.status === "sent")
    .reduce((sum, i) => sum + i.balanceDue, 0);

  if (
    role !== "office" &&
    estimateRows.length === 0 &&
    invoiceRows.length === 0
  ) {
    return null;
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
        <Receipt className="w-4 h-4" />
        Estimates & Invoices
      </h2>

      {role === "office" && (
        <div className="grid grid-cols-2 gap-2 mb-2">
          <Link
            href={`/estimates/new?job=${jobId}`}
            className="bg-blue-600 text-white text-center py-2.5 rounded-lg font-semibold text-sm active:bg-blue-700 flex items-center justify-center gap-1"
          >
            <Calculator className="w-4 h-4" />
            Estimate
          </Link>
          <Link
            href={`/invoices/new?job=${jobId}`}
            className="bg-white border border-gray-300 text-gray-900 text-center py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 flex items-center justify-center gap-1"
          >
            <Receipt className="w-4 h-4" />
            Invoice
          </Link>
        </div>
      )}

      <div className="space-y-2">
        {estimateRows.map((e) => (
          <Link
            key={e.id}
            href={`/estimates/${e.id}?job=${jobId}`}
            className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
          >
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
                  <Calculator className="w-3 h-3" />
                  Estimate
                </p>
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  {e.title ? `${e.title} · ` : ""}
                  {new Date(e.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <StatusBadge tone={ESTIMATE_STATUS_TONE[e.status] ?? "neutral"}>{e.status.replace("_", " ")}</StatusBadge>
                <span className="text-sm font-semibold text-gray-900">
                  {formatMoney(e.total)}
                </span>
              </div>
            </div>
          </Link>
        ))}

        {invoiceRows.map((inv) => (
          <Link
            key={inv.id}
            href={`/invoices/${inv.id}?job=${jobId}`}
            className={`block rounded-lg p-3 shadow-sm active:opacity-80 ${
              inv.status === "sent"
                ? "bg-amber-50 border border-amber-200"
                : "bg-white"
            }`}
          >
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
                  <Receipt className="w-3 h-3" />
                  Invoice
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {inv.paidAt
                    ? `Paid ${new Date(inv.paidAt).toLocaleDateString()}`
                    : `Issued ${new Date(inv.createdAt).toLocaleDateString()}`}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <StatusBadge tone={INVOICE_STATUS_TONE[inv.status] ?? "neutral"}>{inv.status.replace("_", " ")}</StatusBadge>
                <span className="text-sm font-semibold text-gray-900">
                  {formatMoney(
                    inv.status === "sent" && inv.amountPaid > 0
                      ? inv.balanceDue
                      : inv.total
                  )}
                </span>
                {inv.status === "sent" && inv.amountPaid > 0 && (
                  <span className="text-[10px] text-gray-400">
                    after deposit
                  </span>
                )}
              </div>
            </div>
          </Link>
        ))}

        {estimateRows.length === 0 && invoiceRows.length === 0 && (
          <div className="bg-white rounded-lg p-4 text-center text-sm text-gray-500">
            No estimates or invoices yet for this job.
          </div>
        )}
      </div>

      {role === "office" && unpaidTotal > 0 && (
        <p className="text-xs text-amber-700 mt-2 bg-amber-50 border border-amber-200 rounded p-2">
          Outstanding: {formatMoney(unpaidTotal)}
        </p>
      )}
    </section>
  );
}