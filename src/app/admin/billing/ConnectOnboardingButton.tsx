"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

// Starts (or resumes) Stripe Connect onboarding for the office's org. POSTs to
// /api/billing/connect/start, which returns a single-use Stripe-hosted Account
// Link {url}; we redirect there. Used on /admin/billing when customer online
// payments are off (no connected account, not charges-enabled, or the account
// is platform-liable under the old setup) so the office can reconnect.
export default function ConnectOnboardingButton({
  label,
  variant = "primary",
}: {
  label: string;
  variant?: "primary" | "secondary";
}) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/connect/start", {
        method: "POST",
      });
      if (res.ok) {
        const { url } = await res.json();
        window.location.href = url;
      } else {
        const { error } = await res.json().catch(() => ({}));
        setError(error ?? "Could not start");
        setConnecting(false);
      }
    } catch {
      setError("Could not start");
      setConnecting(false);
    }
  }

  return (
    <div>
      <button
        onClick={start}
        disabled={connecting}
        className={
          (variant === "primary"
            ? "bg-blue-600 text-white active:bg-blue-700"
            : "bg-white border border-gray-300 text-gray-900 active:bg-gray-50") +
          " px-4 py-2 rounded-lg font-semibold text-sm disabled:opacity-50 inline-flex items-center gap-2"
        }
      >
        {connecting && <Loader2 className="w-4 h-4 animate-spin" />}
        {label}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}