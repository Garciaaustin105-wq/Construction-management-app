"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { customConfirm } from "@/lib/dialogs";

// Logged-in customer Approve/Reject for an estimate awaiting their decision.
// Calls the approve_estimate / reject_estimate SECURITY DEFINER RPCs (customer-
// only, owning-customer + same_org guarded server-side). Mirrors the public
// /q/{token} decide flow but uses the user session instead of a token.
export default function CustomerEstimateActions({
  estimateId,
}: {
  estimateId: string;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  async function approve() {
    if (!customConfirm("Approve this estimate? An invoice will be created.")) return;
    setBusy("approve");
    const { error } = await supabase.rpc("approve_estimate", {
      p_estimate_id: estimateId,
    });
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Estimate approved. Invoice created.");
      router.refresh();
    }
    setBusy(null);
  }

  async function reject() {
    if (!customConfirm("Reject this estimate?")) return;
    setBusy("reject");
    const { error } = await supabase.rpc("reject_estimate", {
      p_estimate_id: estimateId,
    });
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Estimate rejected");
      router.refresh();
    }
    setBusy(null);
  }

  return (
    <div className="space-y-2">
      <button
        onClick={approve}
        disabled={busy !== null}
        className="w-full bg-green-600 text-white py-4 rounded-xl font-semibold text-lg active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy === "approve" ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <CheckCircle2 className="w-5 h-5" />
        )}
        Approve Estimate
      </button>
      <button
        onClick={reject}
        disabled={busy !== null}
        className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-xl font-semibold text-base active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy === "reject" ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <XCircle className="w-4 h-4" />
        )}
        Reject Estimate
      </button>
    </div>
  );
}