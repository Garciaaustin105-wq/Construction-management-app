"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, BookOpen, CheckCircle2, AlertCircle, Unplug } from "lucide-react";
import { useToast } from "@/components/Toast";
import type { AccountingProviderId } from "@/lib/accounting/provider";

// Bookkeeping integration connect card (QuickBooks first; Xero/FreshBooks/Wave/
// Stripe-BYO later). Mirrors ConnectStripeButton but talks to the
// /api/accounting/* routes. Payments pivot (2026-08-17): the platform never
// touches customer money — the org connects ITS OWN bookkeeping provider and
// the app syncs customers/invoices/estimates/payments to it.

export default function AccountingConnectButton({
  provider,
  label,
  initialConnected = false,
  initialStatus = null,
  initialMetadata = null,
}: {
  provider: AccountingProviderId;
  label: string;
  initialConnected?: boolean;
  initialStatus?: string | null;
  initialMetadata?: Record<string, unknown> | null;
}) {
  const toast = useToast();
  const searchParams = useSearchParams();
  const accountingReturn = searchParams.get("accounting");
  const [connected, setConnected] = useState(initialConnected);
  const [status, setStatus] = useState(initialStatus);
  const [metadata] = useState(initialMetadata);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const refreshStatus = useCallback(
    async (silent: boolean) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await fetch("/api/accounting/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, probe: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!silent) toast.error(data?.error ?? "Could not refresh status");
          return;
        }
        setConnected(!!data.connected);
        setStatus(data.status ?? null);
        if (data.status === "expired") {
          if (!silent) toast.warning(`${label} access expired — reconnect.`);
        }
      } catch {
        if (!silent) toast.error("Could not refresh status");
      } finally {
        if (!silent) setRefreshing(false);
      }
    },
    [provider, label, toast]
  );

  useEffect(() => {
    if (accountingReturn === "connected") {
      toast.success(`${label} connected.`);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConnected(true);
    } else if (accountingReturn?.startsWith("error=")) {
      toast.error(decodeURIComponent(accountingReturn.slice(6)));
    }
    // Silent refresh on mount to pick up a just-completed OAuth callback.
    if (initialConnected) refreshStatus(true).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountingReturn, initialConnected]);

  const startConnect = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/accounting/connect/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        toast.error(data?.error ?? `Could not start ${label} connection`);
        setLoading(false);
        return;
      }
      window.location.assign(data.url);
    } catch {
      toast.error(`Could not start ${label} connection`);
      setLoading(false);
    }
  };

  const disconnect = async () => {
    if (!confirm(`Disconnect ${label}? Your synced data stays in ${label}, but the app will stop syncing until you reconnect.`)) return;
    setDisconnecting(true);
    try {
      const res = await fetch("/api/accounting/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? "Could not disconnect");
        return;
      }
      setConnected(false);
      setStatus("disconnected");
      toast.success(`${label} disconnected.`);
    } catch {
      toast.error("Could not disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  const company = (metadata?.companyName as string | undefined) ?? null;

  return (
    <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
      <div className="flex items-center gap-2">
        <BookOpen className="w-4 h-4 text-emerald-600" />
        <h2 className="text-sm font-semibold text-gray-700">{label}</h2>
      </div>
      <p className="text-xs text-gray-500">
        Connect your {label} account. The app syncs your customers, invoices, estimates, and payments to {label} and reads payment status back — so your books stay current without double entry. The platform never touches your customer money.
      </p>

      {!connected && (
        <button
          onClick={startConnect}
          disabled={loading}
          className="w-full bg-emerald-600 text-white py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          Connect {label}
        </button>
      )}

      {connected && (
        <>
          {status === "active" ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-green-700">
                <CheckCircle2 className="w-4 h-4" />
                <span className="text-sm font-medium">
                  {label} connected{company ? ` — ${company}` : ""}
                </span>
              </div>
              <p className="text-xs text-gray-500">Invoices you send will sync to {label} automatically.</p>
            </div>
          ) : status === "expired" ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-amber-700">
                <AlertCircle className="w-4 h-4" />
                <span className="text-sm font-medium">Access expired — reconnect {label}</span>
              </div>
              <p className="text-xs text-amber-600">Your authorization expired. Reconnect to resume syncing.</p>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-gray-700">
              <AlertCircle className="w-4 h-4" />
              <span className="text-sm font-medium">Status: {status ?? "unknown"}</span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <button
              onClick={() => refreshStatus(false)}
              disabled={refreshing}
              className="text-xs text-blue-600 active:text-blue-700 disabled:opacity-50 flex items-center gap-1"
            >
              {refreshing && <Loader2 className="w-4 h-4 animate-spin" />}
              Refresh status
            </button>
            <button
              onClick={disconnect}
              disabled={disconnecting}
              className="text-xs text-red-600 active:text-red-700 disabled:opacity-50 flex items-center gap-1"
            >
              {disconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unplug className="w-4 h-4" />}
              Disconnect
            </button>
          </div>

          {status === "expired" && (
            <button
              onClick={startConnect}
              disabled={loading}
              className="w-full bg-emerald-600 text-white py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Reconnect {label}
            </button>
          )}
        </>
      )}
    </div>
  );
}