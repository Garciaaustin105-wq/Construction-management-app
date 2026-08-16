"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

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
    if (!confirm("Approve this estimate? An invoice will be created.")) return;
    setBusy("approve");
    // approve_estimate returns the new invoice id (construction) or null (lawn
    // jobs approve-only — cycle billing handles their invoicing).
    const { data: invoiceId, error } = await supabase.rpc("approve_estimate", {
      p_estimate_id: estimateId,
    });
    if (error) {
      toast.error(`Failed: ${error.message}`);
      setBusy(null);
      return;
    }
    if (invoiceId) {
      // Construction: auto-deliver the deposit invoice to the customer
      // (whichever channel is on file). Best-effort — approval already
      // succeeded, so a not-yet-configured email/text is a warning, not a
      // failure.
      toast.success("Estimate approved. Invoice created — sending to customer…");
      try {
        const res = await fetch(`/api/invoices/${invoiceId}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ via: "auto" }),
        });
        const data = await res.json().catch(() => ({}));
        if (data?.delivered) {
          const channels = (data.sentVia as string[] | undefined)?.join(" + ") ?? "customer";
          const dest =
            [data.sentTo?.email, data.sentTo?.phone].filter(Boolean).join(" / ") ||
            "customer";
          toast.success(`Invoice sent via ${channels} to ${dest}`);
        } else if (Array.isArray(data?.warnings) && data.warnings.length > 0) {
          for (const w of data.warnings) {
            toast.warning(`${w.channel}: ${w.message}`);
          }
        }
      } catch {
        toast.warning("Invoice created, but we couldn't auto-send it — resend it from the Invoices tab once email/text is configured.");
      }
    } else {
      // Lawn: approve-only (no invoice). Cycle billing invoices the visits.
      toast.success("Estimate approved.");
    }
    router.refresh();
    setBusy(null);
  }

  async function reject() {
    if (!confirm("Reject this estimate?")) return;
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