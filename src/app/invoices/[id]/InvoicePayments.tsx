"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { Loader2, RotateCcw } from "lucide-react";
import { formatMoney } from "@/lib/money";

// §1.5: the recorded-payments list on the invoice detail page, made
// interactive. A non-reversed payment row shows a Reverse button (office
// only); clicking prompts for a reason and POSTs /api/payments/[id]/reverse.
// A reversed row is shown struck-through with a Reversed badge and the reason.
// The "Paid so far" footer is the invoice's amount_paid (already reflects the
// reversal server-side), passed in from the server page.

export type PaymentRow = {
  id: string;
  amount: number;
  method: string;
  reference: string | null;
  paid_at: string;
  recorded_by_name: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
};

export default function InvoicePayments({
  payments,
  amountPaid,
  isOffice,
}: {
  payments: PaymentRow[];
  amountPaid: number;
  isOffice: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [reversingId, setReversingId] = useState<string | null>(null);

  async function handleReverse(p: PaymentRow) {
    const reason = window.prompt(
      `Reverse this ${p.method} payment of ${formatMoney(p.amount)}?\n\nReason (required):`
    );
    if (reason === null) return; // canceled
    if (!reason.trim()) {
      toast.error("A reason is required to reverse a payment");
      return;
    }
    setReversingId(p.id);
    try {
      const res = await fetch(`/api/payments/${p.id}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? `Reverse failed (${res.status})`);
      } else {
        toast.success("Payment reversed");
        router.refresh();
      }
    } catch {
      toast.error("Reverse failed — please try again.");
    } finally {
      setReversingId(null);
    }
  }

  if (payments.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-3 text-sm text-gray-500">
        No payments recorded yet
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm divide-y">
      {payments.map((p) => {
        const reversed = !!p.reversed_at;
        const chip =
          p.method === "cash"
            ? "bg-green-100 text-green-700"
            : p.method === "check"
              ? "bg-blue-100 text-blue-700"
              : "bg-gray-100 text-gray-600";
        return (
          <div
            key={p.id}
            className={`p-3 flex items-start justify-between gap-2 ${
              reversed ? "opacity-60" : ""
            }`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase ${chip}`}
                >
                  {p.method}
                </span>
                <span
                  className={`text-sm font-semibold text-gray-900 tabular-nums ${
                    reversed ? "line-through" : ""
                  }`}
                >
                  {formatMoney(p.amount)}
                </span>
                {reversed && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase bg-amber-100 text-amber-700">
                    Reversed
                  </span>
                )}
              </div>
              {p.reference && (
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  Ref: {p.reference}
                </p>
              )}
              <p className="text-xs text-gray-400 mt-0.5">
                {new Date(p.paid_at).toLocaleDateString()}
                {p.recorded_by_name ? ` · by ${p.recorded_by_name}` : ""}
              </p>
              {reversed && p.reversal_reason && (
                <p className="text-xs text-amber-700 mt-0.5">
                  Reason: {p.reversal_reason}
                </p>
              )}
            </div>
            {isOffice && !reversed && (
              <button
                type="button"
                onClick={() => handleReverse(p)}
                disabled={reversingId === p.id}
                title="Reverse this payment"
                className="shrink-0 text-xs font-semibold text-gray-600 bg-white border border-gray-300 rounded-lg px-2 py-1.5 active:bg-gray-50 disabled:opacity-50 flex items-center gap-1"
              >
                {reversingId === p.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="w-3.5 h-3.5" />
                )}
                Reverse
              </button>
            )}
          </div>
        );
      })}
      <div className="p-3 bg-gray-50 flex justify-between items-center rounded-b-lg">
        <span className="text-sm font-semibold text-gray-900">Paid so far</span>
        <span className="text-base font-bold text-gray-900 tabular-nums">
          {formatMoney(amountPaid)}
        </span>
      </div>
    </div>
  );
}