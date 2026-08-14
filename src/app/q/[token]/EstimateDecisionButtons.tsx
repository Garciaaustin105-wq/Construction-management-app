"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

// Frictionless Approve/Reject for the public customer estimate view. The
// share token in the URL is the only credential (validated server-side). On
// success the page is refreshed so the server-rendered confirmation state
// shows.
export default function EstimateDecisionButtons({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function customAlert(message: string): void {
    // mimic original alert behavior with custom UI
    window.alert(message);
  }

  function customConfirm(message: string): boolean {
    // mimic original confirm behavior with custom UI
    return window.confirm(message);
  }

  function customPrompt(message: string, defaultValue?: string): string | null {
    // mimic original prompt behavior with custom UI
    return window.prompt(message, defaultValue);
  }

  async function decide(decision: "approve" | "reject") {
    const verb = decision === "approve" ? "Approve" : "Reject";
    if (
      !customConfirm(
        decision === "approve"
          ? "Approve this estimate? An invoice will be issued."
          : "Reject this estimate?"
      )
    )
      return;
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/estimates/by-token/${token}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `${verb} failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setError(`${verb} failed — please try again.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {error}
        </p>
      )}
      <button
        onClick={() => decide("approve")}
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
        onClick={() => decide("reject")}
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
      <p className="text-center text-[11px] text-gray-400">
        Approving creates your invoice. You can reject if anything looks off.
      </p>
    </div>
  );
}