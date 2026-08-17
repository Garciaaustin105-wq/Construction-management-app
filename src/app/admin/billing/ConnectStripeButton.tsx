"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, CreditCard, CheckCircle2, AlertCircle } from "lucide-react";
import { useToast } from "@/components/Toast";

export default function ConnectStripeButton({
  initialConnectAccountId,
  initialChargesEnabled,
  initialDetailsSubmitted,
  initialPayoutsEnabled,
}: {
  initialConnectAccountId: string | null;
  initialChargesEnabled: boolean;
  initialDetailsSubmitted: boolean;
  initialPayoutsEnabled: boolean;
}) {
  const toast = useToast();
  const searchParams = useSearchParams();
  const connectReturn = searchParams.get("connect");
  const [connectAccountId] = useState<string | null>(initialConnectAccountId);
  const [chargesEnabled, setChargesEnabled] = useState(initialChargesEnabled);
  const [detailsSubmitted, setDetailsSubmitted] = useState(initialDetailsSubmitted);
  const [payoutsEnabled, setPayoutsEnabled] = useState(initialPayoutsEnabled);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refreshStatus = useCallback(
    async (silent: boolean) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await fetch("/api/billing/connect/status", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!silent) toast.error(data?.error ?? "Could not refresh status");
          return;
        }
        if (data.connected) {
          setChargesEnabled(!!data.chargesEnabled);
          setDetailsSubmitted(!!data.detailsSubmitted);
          setPayoutsEnabled(!!data.payoutsEnabled);
        }
        if (data.error && !silent) toast.warning(data.error);
      } catch {
        if (!silent) toast.error("Could not refresh status");
      } finally {
        if (!silent) setRefreshing(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    if (connectReturn === "success" || connectReturn === "return") {
      toast.success("Stripe connected — verifying your account...");
    } else if (connectReturn === "refresh") {
      toast.warning("The onboarding link expired. Click to resume.");
    }
    // Silent refresh on mount to pick up a just-completed onboarding (errors
    // swallowed). The setState inside refreshStatus runs after the awaited
    // fetch — not synchronously in the effect body — but the rule can't see
    // through the promise, so it's disabled here.
    if (connectAccountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refreshStatus(true).catch(() => {});
    }
  }, [connectReturn, connectAccountId, refreshStatus, toast]);

  const startOnboarding = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/billing/connect/start", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        toast.error(data?.error ?? "Could not start Stripe onboarding");
        setLoading(false);
        return;
      }
      window.location.assign(data.url);
    } catch {
      toast.error("Could not start Stripe onboarding");
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
      <div className="flex items-center gap-2">
        <CreditCard className="w-4 h-4 text-blue-600" />
        <h2 className="text-sm font-semibold text-gray-700">Receive customer payments online</h2>
      </div>
      <p className="text-xs text-gray-500">Connect your Stripe account so customers can pay invoices online. Payments go directly to your account.</p>

      {!connectAccountId && (
        <button
          onClick={startOnboarding}
          disabled={loading}
          className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          Connect Stripe
        </button>
      )}

      {connectAccountId && (
        <>
          {/* "Fully verified" = charges AND payouts both enabled. An Express
              account can have charges_enabled but payouts disabled (bank/
              identity not finished) — in that state Pay Here is OFF (funds
              would strand in the Stripe balance), so we warn explicitly. */}
          {chargesEnabled && payoutsEnabled ? (
            <div className="flex items-center gap-2 text-green-700">
              <CheckCircle2 className="w-4 h-4" /> <span className="text-sm font-medium">Stripe connected — ready to accept payments</span>
            </div>
          ) : chargesEnabled && !payoutsEnabled ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-amber-700">
                <AlertCircle className="w-4 h-4" /> <span className="text-sm font-medium">Almost there — payouts not enabled yet</span>
              </div>
              <p className="text-xs text-amber-600">
                Customers cannot pay online until your account is fully verified. Finish your bank account + identity verification in Stripe so payouts are enabled — until then the Pay button is hidden on invoices.
              </p>
            </div>
          ) : !detailsSubmitted ? (
            <div className="flex items-center gap-2 text-amber-700">
              <AlertCircle className="w-4 h-4" /> <span className="text-sm font-medium">Setup incomplete — finish your Stripe details</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-gray-700">
              <AlertCircle className="w-4 h-4" /> <span className="text-sm font-medium">Finishing verification — Stripe will enable payments shortly</span>
            </div>
          )}

          {chargesEnabled && payoutsEnabled ? (
            <button
              onClick={() => refreshStatus(false)}
              disabled={refreshing}
              className="text-xs text-blue-600 active:text-blue-700 disabled:opacity-50 flex items-center gap-1"
            >
              {refreshing && <Loader2 className="w-4 h-4 animate-spin" />}
              Refresh status
            </button>
          ) : (
            <>
              <button
                onClick={startOnboarding}
                disabled={loading}
                className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                Finish setup
              </button>
              <button
                onClick={() => refreshStatus(false)}
                disabled={refreshing}
                className="text-xs text-blue-600 active:text-blue-700 disabled:opacity-50 flex items-center gap-1"
              >
                {refreshing && <Loader2 className="w-4 h-4 animate-spin" />}
                Refresh status
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}