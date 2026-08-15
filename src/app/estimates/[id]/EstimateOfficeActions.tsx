"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Send, Trash2, Loader2, Receipt, X } from "lucide-react";

// Office actions for an estimate on the Preview & Send tab. Owns the optional
// personal note shown at the top of the send email. Send hits the service-role
// /api/estimates/[id]/send route (email first, then mark sent); Mark Rejected
// and Delete are direct client writes (office RLS allows both). Resend rotates
// the share_token (old links stop working) and re-emails.
export default function EstimateOfficeActions({
  estimateId,
  status,
  invoiceId,
  jobId,
}: {
  estimateId: string;
  status: string;
  invoiceId: string | null;
  jobId?: string | null;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const jobQuery = jobId ? `?job=${jobId}` : "";

  async function sendToCustomer() {
    setBusy(true);
    try {
      const res = await fetch(`/api/estimates/${estimateId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim() || null }),
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
      .from("estimates")
      .update({ status: "rejected", rejected_at: new Date().toISOString() })
      .eq("id", estimateId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Estimate marked as rejected");
      router.refresh();
    }
    setBusy(false);
  }

  async function deleteEstimate() {
    if (!confirm("Delete this draft estimate? This can't be undone.")) return;
    setBusy(true);
    const { error } = await supabase
      .from("estimates")
      .delete()
      .eq("id", estimateId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Estimate deleted");
      router.push(jobId ? `/jobs/${jobId}` : "/estimates");
    }
    setBusy(false);
  }

  const canSend = status === "draft" || status === "sent";

  return (
    <div className="space-y-3">
      {canSend && (
        <label className="block">
          <span className="text-sm font-medium text-gray-700">
            Personal note (optional)
          </span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            placeholder="Added to the top of the email, e.g. &ldquo;Hi Jane, here&rsquo;s the estimate we discussed&hellip;&rdquo;"
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
          />
        </label>
      )}

      {canSend && (
        <button
          onClick={sendToCustomer}
          disabled={busy}
          className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Send className="w-5 h-5" />
          )}
          {status === "sent" ? "Resend to Customer" : "Send to Customer"}
        </button>
      )}

      {status === "sent" && (
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
      )}

      {status === "draft" && (
        <button
          onClick={deleteEstimate}
          disabled={busy}
          className="w-full bg-red-50 border border-red-200 text-red-700 py-3 rounded-lg font-semibold text-sm active:bg-red-100 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          Delete draft
        </button>
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