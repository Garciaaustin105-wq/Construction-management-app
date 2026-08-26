"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { CheckCircle2, Loader2 } from "lucide-react";

export default function OfficeManualApprove({
  coId,
}: {
  coId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function approve() {
    if (busy) return;
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      toast.error("A note is required (e.g. 'paid by check #1234').");
      return;
    }
    if (!confirm("Approve this change order on the customer's behalf? You will be recorded as the approver.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/change-orders/${coId}/office-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: trimmedNote }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? "Failed to approve");
        return;
      }
      toast.success("Change order approved (manual)");
      router.refresh();
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-4 space-y-2">
      <h2 className="text-sm font-semibold text-gray-500 uppercase">Approve on behalf of customer</h2>
      <p className="text-xs text-gray-500">Use this when the customer approves in person or pays by check. Your name and note are recorded as the approval.</p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Required — e.g. 'paid by check #1234' or 'approved in person'"
        className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
      />
      <button
        onClick={approve}
        disabled={busy || !note.trim()}
        className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
        {busy ? "Approving..." : "Approve on behalf of customer"}
      </button>
    </div>
  );
}