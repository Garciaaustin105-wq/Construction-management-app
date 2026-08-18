"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

// Logged-in customer Approve/Reject for a change order awaiting their decision.
// Calls the authed /api/change-orders/[id]/decide route (→ decide_change_order
// SECURITY DEFINER RPC). Mirrors CustomerEstimateActions but for change orders;
// no invoice is created (the office invoices an approved CO separately).
export default function ClientChangeOrderActions({
  coId,
}: {
  coId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  async function decide(decision: "approve" | "reject") {
    const verb = decision === "approve" ? "Approve" : "Reject";
    if (!confirm(`${verb} this change order?`)) return;
    setBusy(decision);
    try {
      const res = await fetch(`/api/change-orders/${coId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? `Failed to ${verb.toLowerCase()}`);
        setBusy(null);
        return;
      }
      toast.success(`Change order ${decision === "approve" ? "approved" : "rejected"}`);
      router.refresh();
    } catch {
      toast.error("Network error — try again.");
    }
    setBusy(null);
  }

  return (
    <div className="space-y-2">
      <button
        onClick={() => decide("approve")}
        disabled={busy !== null}
        className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy === "approve" ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <CheckCircle2 className="w-5 h-5" />
        )}
        Approve
      </button>
      <button
        onClick={() => decide("reject")}
        disabled={busy !== null}
        className="w-full bg-white border border-gray-300 text-gray-700 py-2.5 rounded-xl font-semibold active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy === "reject" ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <XCircle className="w-4 h-4" />
        )}
        Decline
      </button>
    </div>
  );
}