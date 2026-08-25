"use client";

import { useState } from "react";
import { Loader2, CreditCard } from "lucide-react";

// Phase 3 — the payment affordances on the public invoice view. Rendered (by
// page.tsx) ONLY when the org clears the three-way gate: lawn variant, Stripe
// connect_charges_enabled, and NOT platform-liable. Both routes are public
// (the share_token is the credential) and return {url}; we redirect there.
// The "Save card for autopay" button's consent line (Phase 2c) is what makes
// saving a card an explicit opt-in to automatic charging — the webhook sets
// autopay_enabled only because this flow's SetupIntent carries enroll_autopay.
export default function InvoicePayActions({ token }: { token: string }) {
  const [paying, setPaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startPay() {
    setPaying(true);
    setError(null);
    try {
      const res = await fetch(`/api/invoices/pay/${token}`, {
        method: "POST",
      });
      if (res.ok) {
        const { url } = await res.json();
        window.location.href = url;
      } else {
        const { error } = await res.json().catch(() => ({}));
        setError(error ?? "Could not start payment");
        setPaying(false);
      }
    } catch {
      setError("Could not start payment");
      setPaying(false);
    }
  }

  async function startSaveCard() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/invoices/save-card/${token}`, {
        method: "POST",
      });
      if (res.ok) {
        const { url } = await res.json();
        window.location.href = url;
      } else {
        const { error } = await res.json().catch(() => ({}));
        setError(error ?? "Could not start card setup");
        setSaving(false);
      }
    } catch {
      setError("Could not start card setup");
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 mt-3">
      <button
        onClick={startPay}
        disabled={paying || saving}
        className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {paying ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <CreditCard className="w-4 h-4" />
        )}
        Pay now
      </button>

      <button
        onClick={startSaveCard}
        disabled={paying || saving}
        className="w-full bg-white border border-gray-300 text-gray-900 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <CreditCard className="w-4 h-4" />
        )}
        Save card for autopay
      </button>

      {/* Phase 2c — explicit consent, plain language. Saving enrolls in
          autopay; the office can turn it off (the toggle in CustomersManager
          allows turning off unconditionally). */}
      <p className="text-xs text-gray-500 leading-relaxed">
        Saving a card enrolls you in automatic payment of future invoices. You
        can turn this off anytime by contacting the office.
      </p>

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}