"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { CheckCircle2, XCircle, RotateCcw, Loader2, Trash2 } from "lucide-react";

export default function InvoiceActions({
  invoiceId,
  status,
}: {
  invoiceId: string;
  status: string;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function updateStatus(newStatus: string, paidAt: string | null) {
    setBusy(true);
    const { error } = await supabase
      .from("invoices")
      .update({ status: newStatus, paid_at: paidAt, updated_at: new Date().toISOString() })
      .eq("id", invoiceId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success(`Invoice marked ${newStatus}`);
      router.refresh();
    }
    setBusy(false);
  }

  async function deleteInvoice() {
    if (!confirm("Delete this invoice? This can't be undone.")) return;
    setBusy(true);
    const { error } = await supabase.from("invoices").delete().eq("id", invoiceId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Invoice deleted");
      router.push("/invoices");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      {status === "sent" && (
        <>
          <button
            onClick={() => updateStatus("paid", new Date().toISOString())}
            disabled={busy}
            className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-base active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <CheckCircle2 className="w-5 h-5" />
            )}
            Mark Paid
          </button>
          <button
            onClick={() => updateStatus("void", null)}
            disabled={busy}
            className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <XCircle className="w-4 h-4" />
            )}
            Mark Void
          </button>
        </>
      )}

      {status === "paid" && (
        <button
          onClick={() => updateStatus("sent", null)}
          disabled={busy}
          className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RotateCcw className="w-4 h-4" />
          )}
          Mark Unpaid
        </button>
      )}

      {status === "void" && (
        <button
          onClick={() => updateStatus("sent", null)}
          disabled={busy}
          className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RotateCcw className="w-4 h-4" />
          )}
          Restore as Unpaid
        </button>
      )}

      <div className="pt-2 mt-2 border-t border-gray-200">
        <button
          onClick={deleteInvoice}
          disabled={busy}
          className="w-full bg-red-50 border border-red-200 text-red-700 py-3 rounded-lg font-semibold text-sm active:bg-red-100 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
          Delete Invoice
        </button>
      </div>
    </div>
  );
}