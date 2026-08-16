"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

// Frictionless Approve/Reject for the public customer change-order view. The
// share token in the URL is the only credential (validated server-side). On
// success the page is refreshed so the server-rendered confirmation state
// shows.
export default function CODecisionButtons({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    const verb = decision === "approve" ? "Approve" : "Decline";
    if (
      !confirm(
        decision === "approve"
          ? "Approve this change order? This authorizes the change to proceed."
          : "Decline this change order?"
      )
    )
      return;
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/change-orders/by-token/${token}/decide`, {
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
        Approve Change Order
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
        Decline Change Order
      </button>
      <p className="text-center text-[11px] text-gray-400">
        Your decision is sent to {`the office`} immediately.
      </p>
    </div>
  );
}