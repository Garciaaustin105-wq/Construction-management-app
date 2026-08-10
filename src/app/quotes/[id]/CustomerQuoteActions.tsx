"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

export default function CustomerQuoteActions({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  async function approve() {
    if (!confirm("Approve this quote? An invoice will be created.")) return;
    setBusy("approve");
    const { error } = await supabase.rpc("approve_quote", {
      p_quote_id: quoteId,
    });
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Quote approved. Invoice created.");
      router.refresh();
    }
    setBusy(null);
  }

  async function reject() {
    if (!confirm("Reject this quote?")) return;
    setBusy("reject");
    const { error } = await supabase
      .from("quotes")
      .update({ status: "rejected", rejected_at: new Date().toISOString() })
      .eq("id", quoteId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Quote rejected");
      router.refresh();
    }
    setBusy(null);
  }

  return (
    <div className="space-y-2">
      <button
        onClick={approve}
        disabled={busy !== null}
        className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-base active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy === "approve" ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <CheckCircle2 className="w-5 h-5" />
        )}
        Approve Quote
      </button>
      <button
        onClick={reject}
        disabled={busy !== null}
        className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy === "reject" ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <XCircle className="w-4 h-4" />
        )}
        Reject Quote
      </button>
    </div>
  );
}