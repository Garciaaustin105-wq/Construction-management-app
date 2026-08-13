"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { DollarSign, RotateCcw, Loader2 } from "lucide-react";

// Inline "Mark paid back" / "Mark unpaid" toggle for the receipts report table.
// Office/admin can flip a receipt's reimbursed state directly in the report and
// see it update immediately (optimistic local flip + router.refresh so the row
// re-sorts into the paid/owed totals). Mirrors the toggle on the receipts
// overview + job page (same RLS `office_receipts_all` UPDATE policy).
export default function ReceiptReportPaidToggle({
  receiptId,
  reimbursed,
  reimbursedAt,
}: {
  receiptId: string;
  reimbursed: boolean;
  reimbursedAt: string | null;
}) {
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Optimistic state so the badge flips before the server re-render lands.
  const [localPaid, setLocalPaid] = useState(reimbursed);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = !localPaid;
    setLocalPaid(next); // optimistic
    try {
      const { error } = await supabase
        .from("receipts")
        .update({
          reimbursed: next,
          reimbursed_at: next ? new Date().toISOString() : null,
        })
        .eq("id", receiptId);
      if (error) {
        setLocalPaid(!next); // revert
        toast.error(`Failed: ${error.message}`);
        return;
      }
      toast.success(next ? "Marked paid back" : "Marked unpaid");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold disabled:opacity-50 ${
        localPaid
          ? "bg-emerald-100 text-emerald-700 active:bg-emerald-200"
          : "bg-orange-100 text-orange-700 active:bg-orange-200"
      }`}
      title={localPaid ? "Mark unpaid" : "Mark paid back"}
    >
      {busy ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : localPaid ? (
        <RotateCcw className="w-3 h-3" />
      ) : (
        <DollarSign className="w-3 h-3" />
      )}
      {localPaid
        ? `Paid${reimbursedAt ? ` · ${new Date(reimbursedAt).toLocaleDateString()}` : ""}`
        : "Owed"}
    </button>
  );
}