"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";
import { Loader2, CheckCircle2, CreditCard } from "lucide-react";

export default function InvoicePayPanel({
  token,
  balanceDueStr,
  canPay,
  paid,
  justPaid,
  canceled,
}: {
  token: string;
  balanceDueStr: string;
  canPay: boolean;
  paid: boolean;
  justPaid: boolean;
  canceled: boolean;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);

  async function pay() {
    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/pay/${token}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        toast.error(data?.error ?? "Could not start payment");
        setLoading(false);
        return;
      }
      window.location.assign(data.url); // redirect to Stripe Checkout
    } catch {
      toast.error("Could not start payment");
      setLoading(false);
    }
  }

  if (justPaid) {
    return (
      <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-4 flex items-center gap-2">
        <CheckCircle2 className="w-5 h-5 shrink-0" />
        <div>
          <p className="font-semibold text-sm">Payment received — thank you!</p>
          <p className="text-xs text-green-700">Your invoice will update shortly.</p>
        </div>
      </div>
    );
  }

  if (paid) {
    return (
      <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-4 flex items-center gap-2">
        <CheckCircle2 className="w-5 h-5 shrink-0" />
        <p className="font-semibold text-sm">This invoice is paid in full. Thank you!</p>
      </div>
    );
  }

  if (!canPay && !canceled) {
    return null;
  }

  return (
    <div className="space-y-3">
      {canceled && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-sm mb-3">
          Payment canceled. You can try again anytime.
        </div>
      )}
      {canPay && (
        <button
          onClick={pay}
          disabled={loading}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <CreditCard className="w-5 h-5" />}
          Pay {balanceDueStr}
        </button>
      )}
    </div>
  );
}