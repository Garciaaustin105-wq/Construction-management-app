"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Send, Pencil, Trash2, Loader2, Receipt, X } from "lucide-react";

export default function QuoteActions({
  quoteId,
  status,
  invoiceId,
  jobId,
}: {
  quoteId: string;
  status: string;
  invoiceId: string | null;
  jobId?: string | null;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Append ?job= to onward navigations when we arrived from a job folder, so
  // the edit / invoice pages' back buttons return to that job too.
  const jobQuery = jobId ? `?job=${jobId}` : "";

  // Email the customer a frictionless /q/{token} link + mark the quote sent.
  // The route emails first and only marks sent on success, so "sent" always
  // means "delivered". On a draft this is Send; on a sent quote it's Resend
  // (the route rotates the token, so the old link stops working).
  async function sendToCustomer() {
    setBusy(true);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/send`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? `Send failed (${res.status})`);
      } else {
        toast.success(`Sent to ${data.sentTo ?? "customer"}`);
        router.refresh();
      }
    } catch {
      toast.error("Send failed — please try again.");
    } finally {
      setBusy(false);
    }
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
            onClick={sendToCustomer}
            disabled={busy}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
            Send to Customer
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => router.push(`/quotes/${quoteId}/edit${jobQuery}`)}
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
          <button
            onClick={sendToCustomer}
            disabled={busy}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
            Resend to Customer
          </button>
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

      {status === "approved" && invoiceId && (
        <button
          onClick={() => router.push(`/invoices/${invoiceId}${jobQuery}`)}
          className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-base active:bg-green-700 flex items-center justify-center gap-2"
        >
          <Receipt className="w-5 h-5" />
          View Invoice
        </button>
      )}
    </div>
  );
}