"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { formatMoney, computeTotal } from "@/lib/money";
import StatusBadge from "@/components/StatusBadge";
import { Receipt, Calculator } from "lucide-react";

interface LawnJobFinancialsProps {
  jobId: string;
  canEdit: boolean;
}

type RawEstimate = {
  id: string;
  status: string;
  title: string | null;
  created_at: string;
  estimate_line_items: { quantity: number; unit_price: number }[] | null;
};

type RawInvoice = {
  id: string;
  status: string;
  paid_at: string | null;
  created_at: string;
  amount_paid?: number | null;
  invoice_line_items: { quantity: number; unit_price: number }[] | null;
};

export default function LawnJobFinancials({ jobId, canEdit }: LawnJobFinancialsProps) {
  const [estimates, setEstimates] = useState<RawEstimate[]>([]);
  const [invoices, setInvoices] = useState<RawInvoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchFinancials = async () => {
      const supabase = createClient();
      const [{ data: estimatesData }, { data: invoicesData }] = await Promise.all([
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

      setEstimates(estimatesData ?? []);
      setInvoices(invoicesData ?? []);
      setLoading(false);
    };

    fetchFinancials();
  }, [jobId]);

  const estimateRows = estimates.map((e) => {
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

  const invoiceRows = invoices.map((inv) => {
    const items =
      (inv.invoice_line_items as unknown as { quantity: number; unit_price: number }[]) ?? [];
    const invTotal = computeTotal(items);
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

  if (!canEdit && estimateRows.length === 0 && invoiceRows.length === 0) {
    return null;
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
        <Receipt className="w-4 h-4" />
        Estimates & Invoices
      </h2>

      {canEdit && (
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
        {loading && (
          <div className="bg-white rounded-lg p-3 text-center text-sm text-gray-500">
            Loading…
          </div>
        )}

        {!loading && estimateRows.map((e) => (
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
                <StatusBadge status={e.status} />
                <span className="text-sm font-semibold text-gray-900">
                  {formatMoney(e.total)}
                </span>
              </div>
            </div>
          </Link>
        ))}

        {!loading && invoiceRows.map((inv) => (
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
                <StatusBadge status={inv.status} />
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

        {!loading && estimateRows.length === 0 && invoiceRows.length === 0 && (
          <div className="bg-white rounded-lg p-4 text-center text-sm text-gray-500">
            No estimates or invoices yet for this job.
          </div>
        )}
      </div>

      {canEdit && unpaidTotal > 0 && (
        <p className="text-xs text-amber-700 mt-2 bg-amber-50 border border-amber-200 rounded p-2">
          Outstanding: {formatMoney(unpaidTotal)}
        </p>
      )}
    </section>
  );
}