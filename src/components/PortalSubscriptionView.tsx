"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useToast } from "@/components/Toast";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Loader2,
  Wifi,
  WifiOff,
} from "lucide-react";

// What a subscriber sees about their own internet service.
//
// Tone matters more than usual here: this is the screen someone lands on when
// their internet has just been cut off. It says what happened, what it costs,
// and exactly what to do about it — no billing jargon, no blame, and a working
// button rather than "contact support."

function money(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function date(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function PortalSubscriptionView({
  status,
  planName,
  planPriceCents,
  currentPeriodEnd,
  graceUntil,
  hasStripeSubscription,
}: {
  status: string | null;
  planName: string | null;
  planPriceCents: number | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  hasStripeSubscription: boolean;
}) {
  const toast = useToast();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);

  const justCheckedOut = params.get("checkout") === "success";

  async function openPortal() {
    setBusy(true);
    const res = await fetch("/api/isp/subscriptions/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json();
    if (!res.ok) toast.error(json.error ?? "Could not open billing");
    else window.location.href = json.url as string;
    setBusy(false);
  }

  if (!status) {
    return (
      <div className="bg-white rounded-lg p-6 shadow-sm text-center">
        <WifiOff className="h-8 w-8 text-gray-300 mx-auto" />
        <p className="mt-2 text-sm text-gray-500">
          You don&apos;t have an internet plan set up yet.
        </p>
      </div>
    );
  }

  const suspended = status === "suspended";
  const pastDue = status === "past_due";
  const healthy = status === "active" || status === "trialing";

  return (
    <div className="space-y-3">
      {/* Checkout just completed — the webhook may not have landed yet, so say
          "confirming" rather than showing a stale "not signed up" state. */}
      {justCheckedOut && status === "none" && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
          <p className="text-sm text-blue-900">
            Thanks — we&apos;re confirming your payment. This page will show your
            plan in a moment.
          </p>
        </div>
      )}

      <div className="bg-white rounded-lg p-4 shadow-sm">
        <div className="flex items-center gap-2">
          {healthy ? (
            <Wifi className="h-5 w-5 text-emerald-600" />
          ) : suspended ? (
            <WifiOff className="h-5 w-5 text-red-600" />
          ) : (
            <AlertTriangle className="h-5 w-5 text-amber-500" />
          )}
          <div>
            <p className="font-semibold text-gray-900">
              {planName ?? "Internet service"}
            </p>
            <p className="text-xs text-gray-500">
              {money(planPriceCents)} per month
            </p>
          </div>
        </div>

        {healthy && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-gray-600">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            Active — next payment {date(currentPeriodEnd)}
          </p>
        )}

        {pastDue && (
          <div className="mt-3 rounded bg-amber-50 border border-amber-200 p-3">
            <p className="text-sm font-medium text-amber-900">
              We couldn&apos;t process your last payment
            </p>
            <p className="mt-1 text-sm text-amber-800">
              {graceUntil
                ? `Please update your payment method by ${date(graceUntil)} to keep your service on.`
                : "Please update your payment method to keep your service on."}
            </p>
          </div>
        )}

        {suspended && (
          <div className="mt-3 rounded bg-red-50 border border-red-200 p-3">
            <p className="text-sm font-medium text-red-900">
              Your service is suspended
            </p>
            <p className="mt-1 text-sm text-red-800">
              Update your payment method below. Your internet turns back on as
              soon as the payment goes through.
            </p>
          </div>
        )}

        {status === "canceled" && (
          <p className="mt-3 text-sm text-gray-600">
            Your plan is canceled. Service ends {date(currentPeriodEnd)}.
          </p>
        )}

        {hasStripeSubscription && (
          <button
            onClick={openPortal}
            disabled={busy}
            className={`mt-4 w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 ${
              suspended || pastDue
                ? "bg-slate-900 text-white"
                : "border border-gray-300 text-gray-700"
            }`}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CreditCard className="h-4 w-4" />
            )}
            {suspended || pastDue ? "Update payment method" : "Manage billing"}
          </button>
        )}
      </div>
    </div>
  );
}
