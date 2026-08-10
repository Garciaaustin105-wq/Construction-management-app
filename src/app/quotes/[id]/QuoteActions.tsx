"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Send, Pencil, Trash2, Loader2, Receipt, X } from "lucide-react";
import DeleteJobButton from "@/components/DeleteJobButton";

export default function QuoteActions({
  quoteId,
  status,
  jobId,
  customerId,
  invoiceId,
}: {
  quoteId: string;
  status: string;
  jobId: string;
  customerId: string | null;
  invoiceId: string | null;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function markSent() {
    setBusy(true);
    const { error } = await supabase
      .from("quotes")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", quoteId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Quote marked as sent");
      router.refresh();
    }
    setBusy(false);
  }

  async function reject() {
    setBusy(true);
    const { error } = await supabase
      .from("quotes")
      .update({ status: "rejected", rejected_at: new Date().toISOString() })
      .eq("id", quoteId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Quote marked as rejected");
      router.refresh();
    }
    setBusy(false);
  }

  async function deleteQuote() {
    if (!confirm("Delete this draft quote? This can't be undone.")) return;
    setBusy(true);
    const { error } = await supabase.from("quotes").delete().eq("id", quoteId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Quote deleted");
      router.push("/quotes");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      {status === "draft" && (
        <>
          <button
            onClick={markSent}
            disabled={busy}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
            Mark as Sent
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => router.push(`/quotes/${quoteId}/edit`)}
              className="bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 flex items-center justify-center gap-2"
            >
              <Pencil className="w-4 h-4" />
              Edit
            </button>
            <button
              onClick={deleteQuote}
              disabled={busy}
              className="bg-red-50 border border-red-200 text-red-700 py-3 rounded-lg font-semibold text-sm active:bg-red-100 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>
        </>
      )}

      {status === "sent" && (
        <>
          {invoiceId && (
            <button
              onClick={() => router.push(`/invoices/${invoiceId}`)}
              className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-base active:bg-green-700 flex items-center justify-center gap-2"
            >
              <Receipt className="w-5 h-5" />
              View Invoice
            </button>
          )}
          <button
            onClick={reject}
            disabled={busy}
            className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <X className="w-4 h-4" />
            )}
            Mark Rejected
          </button>
        </>
      )}
    </div>
  );
}