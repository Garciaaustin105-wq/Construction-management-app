"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useToast } from "@/components/Toast";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

type ConnectStatus = {
  connected: boolean;
  status?: "pending" | "active" | "restricted" | "disconnected";
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  livemode?: boolean;
};

export default function IspBillingPanel({
  initial,
  initialGraceDays,
}: {
  initial: ConnectStatus;
  initialGraceDays: number;
}) {
  const toast = useToast();
  const params = useSearchParams();
  const [state, setState] = useState<ConnectStatus>(initial);
  const [busy, setBusy] = useState(false);
  const [graceDays, setGraceDays] = useState(String(initialGraceDays));

  const refresh = useCallback(
    async (quiet = false) => {
      setBusy(true);
      try {
        const res = await fetch("/api/isp/connect/refresh", { method: "POST" });
        const json = await res.json();
        if (!res.ok) {
          if (!quiet) toast.error(json.error ?? "Could not refresh status");
        } else {
          setState(json as ConnectStatus);
        }
      } catch {
        if (!quiet) toast.error("Could not reach Stripe");
      }
      setBusy(false);
    },
    [toast]
  );

  // Returning from Stripe's onboarding tells us nothing on its own — Stripe is
  // explicit that hitting return_url means only that the flow was entered and
  // exited, not that it was completed. So we re-read the account rather than
  // optimistically showing "Connected" to someone who bailed halfway.
  useEffect(() => {
    if (params.get("connect") !== "return") return;
    // Async IIFE so the setState inside refresh() lands in a later tick rather
    // than synchronously in the effect body (react-hooks/set-state-in-effect),
    // matching CostCodesManager's mount-load pattern.
    (async () => {
      await refresh(true);
    })();
  }, [params, refresh]);

  async function startConnect() {
    setBusy(true);
    try {
      const res = await fetch("/api/isp/connect/start", { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.url) {
        toast.error(json.error ?? "Could not start Stripe onboarding");
        setBusy(false);
        return;
      }
      // Account links are single-use and expire in minutes — go straight there.
      window.location.href = json.url as string;
    } catch {
      toast.error("Could not reach Stripe");
      setBusy(false);
    }
  }

  async function disconnect() {
    if (
      !confirm(
        "Disconnect Stripe from subscriber billing?\n\n" +
          "Your Stripe account and its payment history stay exactly as they are — " +
          "this only stops this app from managing subscriptions and missed payments."
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/isp/connect/disconnect", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Could not disconnect");
      } else {
        if (json.note) toast.warning(json.note);
        else toast.success("Disconnected");
        setState({ connected: false });
      }
    } catch {
      toast.error("Could not disconnect");
    }
    setBusy(false);
  }

  async function saveGrace() {
    const n = Number(graceDays);
    if (!Number.isInteger(n) || n < 0 || n > 90) {
      toast.warning("Enter a whole number of days between 0 and 90");
      return;
    }
    const res = await fetch("/api/isp/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dunningGraceDays: n }),
    });
    const json = await res.json();
    if (!res.ok) toast.error(json.error ?? "Could not save");
    else toast.success("Grace period saved");
  }

  const live = state.connected && state.chargesEnabled;

  return (
    <div className="space-y-4">
      {/* What this is, and the promise it makes. */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center gap-2 text-slate-700">
          <CreditCard className="h-5 w-5" />
          <h2 className="text-base font-semibold">Subscriber billing</h2>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Connect your own Stripe account to bill internet customers monthly.
          Payments go <strong>directly to you</strong> — they never pass through
          us, and we take nothing.
        </p>
        <p className="mt-2 flex items-start gap-2 text-xs text-slate-500">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
          <span>
            You own the account and can disconnect us from your Stripe dashboard
            at any time. Refunds, disputes, and payouts are handled by you in
            Stripe.
          </span>
        </p>
      </div>

      {/* Status */}
      <div className="bg-white rounded-lg p-4 shadow-sm">
        {!state.connected ? (
          <>
            <p className="text-sm text-gray-700">
              No Stripe account connected yet.
            </p>
            <button
              onClick={startConnect}
              disabled={busy}
              className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ExternalLink className="h-4 w-4" />
              )}
              Connect Stripe
            </button>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2">
              {live ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  {live
                    ? "Connected and ready to bill"
                    : state.status === "restricted"
                      ? "Stripe needs more information"
                      : "Onboarding not finished"}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {live
                    ? state.livemode
                      ? "Live mode — real charges."
                      : "Test mode — no real money moves."
                    : "You can't enroll subscribers until Stripe finishes verifying your account."}
                </p>
              </div>
            </div>

            <div className="mt-3 flex gap-2">
              {!live && (
                <button
                  onClick={startConnect}
                  disabled={busy}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  <ExternalLink className="h-4 w-4" />
                  Continue in Stripe
                </button>
              )}
              <button
                onClick={() => refresh(false)}
                disabled={busy}
                className="flex items-center justify-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Refresh
              </button>
            </div>

            <button
              onClick={disconnect}
              disabled={busy}
              className="mt-3 text-xs text-gray-500 hover:text-red-600 hover:underline"
            >
              Disconnect Stripe
            </button>
          </>
        )}
      </div>

      {/* Dunning */}
      <div className="bg-white rounded-lg p-4 shadow-sm">
        <h3 className="text-sm font-medium text-gray-900">
          Missed payments
        </h3>
        <p className="mt-1 text-xs text-gray-500">
          When a subscriber&apos;s payment fails we email them right away. If
          they still haven&apos;t paid after this many days, their service is
          marked suspended and they&apos;re emailed again.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            value={graceDays}
            onChange={(e) => setGraceDays(e.target.value)}
            className="w-20 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <span className="text-sm text-gray-600">days</span>
          <button
            onClick={saveGrace}
            className="ml-auto px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
