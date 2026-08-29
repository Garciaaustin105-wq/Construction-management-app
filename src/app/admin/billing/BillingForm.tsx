"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Check, AlertTriangle } from "lucide-react";
import { useToast } from "@/components/Toast";
import type { PaidTier } from "@/lib/plans";

type Tier = {
  tier: PaidTier;
  label: string;
  blurb: string;
  maxUsers: number | null;
  maxJobs: number | null;
  maxCrewMembers: number | null;
  maxCustomers: number | null;
  maxLineItemsPerDoc: number | null;
  storage: string;
  storageCustom: boolean;
  priceMonthly: number;
};

type Blocker = {
  dim: "jobs" | "customers" | "crewMembers" | "seats" | "storage";
  label: string;
  current: number;
  cap: number;
  mustRemove: number;
};

function cap(n: number | null, noun: string): string {
  return n === null ? `Unlimited ${noun}*` : `Up to ${n} ${noun}${n === 1 ? "" : "s"}`;
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  const gb = n / 1024 / 1024 / 1024;
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

export default function BillingForm({
  currentPlan,
  planStatus,
  trialDaysLeft,
  isExpired,
  hasSubscription,
  tiers,
  accountingSection,
  customerPaymentsSection,
}: {
  currentPlan: string;
  planStatus: string;
  trialDaysLeft: number | null;
  isExpired: boolean;
  hasSubscription: boolean;
  tiers: Tier[];
  accountingSection?: ReactNode;
  customerPaymentsSection?: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const searchParams = useSearchParams();
  const [loadingTier, setLoadingTier] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [blockers, setBlockers] = useState<{ tier: string; items: Blocker[] } | null>(null);
  const status = searchParams.get("status");

  useEffect(() => {
    if (status === "success") {
      toast.success("Subscription active — thanks!");
    } else if (status === "cancel") {
      toast.warning("Checkout canceled.");
    }
  }, [status, toast]);

  const labelMap: Record<string, string> = {
    free: "Free",
    trial: "Trial",
    starter: "Starter",
    growth: "Growth",
    pro: "Pro",
    enterprise: "Enterprise",
    expired: "Expired",
    canceled: "Canceled",
  };

  const subscribe = async (tier: string) => {
    setLoadingTier(tier);
    setBlockers(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const data = await res.json();
      if (res.status === 409 && Array.isArray(data.blockers)) {
        // Downgrade guard: current usage exceeds the target tier. Show what to
        // remove (or export first) instead of a generic toast. The office trims
        // down below the cap and retries, or picks a higher tier.
        setBlockers({ tier, items: data.blockers as Blocker[] });
        toast.error("Downgrade blocked — see details below");
        setLoadingTier(null);
        return;
      }
      if (!res.ok) {
        toast.error(data.error ?? "Could not start checkout");
        setLoadingTier(null);
        return;
      }
      window.location.assign(data.url);
    } catch {
      toast.error("Could not start checkout");
      setLoadingTier(null);
    }
  };

  const manage = async () => {
    setManaging(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Could not open billing portal");
        setManaging(false);
        return;
      }
      window.location.assign(data.url);
    } catch {
      toast.error("Could not open billing portal");
      setManaging(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 max-w-[50%] truncate">
          Billing
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md lg:max-w-2xl mx-auto p-4 space-y-4">
        {isExpired || currentPlan === "canceled" ? (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
            Your plan is inactive. Pick a tier below to resume creating.
          </div>
        ) : planStatus === "past_due" ? (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-sm">
            Payment past due — update your billing info via Manage Subscription.
          </div>
        ) : null}

        <div className="bg-white rounded-lg p-4 shadow-sm">
          <p className="text-sm font-medium text-gray-700">Current plan:</p>
          <p className="text-lg font-bold text-gray-900">
            {labelMap[currentPlan] || currentPlan}
          </p>
          {currentPlan === "trial" && trialDaysLeft !== null && (
            <p className="text-sm text-gray-500">
              {trialDaysLeft === 0
                ? "Last day of trial"
                : `${trialDaysLeft} trial day${trialDaysLeft === 1 ? "" : "s"} left`}
            </p>
          )}
        </div>

        {blockers && (
          <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 space-y-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
              <div className="text-sm text-amber-900">
                <p className="font-semibold">
                  Downgrade to {labelMap[blockers.tier] || blockers.tier} blocked
                </p>
                <p className="text-amber-800">
                  Your current usage is above what that plan allows. Remove the
                  excess below (or export it first to keep your data), then retry.
                </p>
              </div>
            </div>
            <ul className="space-y-1.5 text-sm">
              {blockers.items.map((b) => {
                const isStorage = b.dim === "storage";
                const cur = isStorage ? formatBytes(b.current) : b.current;
                const capStr = isStorage ? formatBytes(b.cap) : b.cap;
                const remove = isStorage
                  ? `free up ${formatBytes(b.mustRemove)}`
                  : `remove ${b.mustRemove}`;
                return (
                  <li
                    key={b.dim}
                    className="flex items-center justify-between gap-2 bg-white/60 rounded px-3 py-2"
                  >
                    <span className="text-gray-800">
                      <span className="font-medium">{b.label}:</span> {cur}{" "}
                      <span className="text-gray-500">
                        ({labelMap[blockers.tier] || blockers.tier} allows {capStr})
                      </span>
                    </span>
                    <span className="text-amber-700 font-medium whitespace-nowrap">
                      {remove}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="text-xs text-amber-800 border-t border-amber-200 pt-2 space-y-1">
              <p>
                Tip: open any job and tap <span className="font-medium">Export</span>{" "}
                to download its files + summary before deleting. Then remove the
                extra records and come back here.
              </p>
              <button
                onClick={() => router.push("/dashboard")}
                className="text-amber-900 font-medium underline underline-offset-2"
              >
                Go to Dashboard to manage records
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {tiers.map((tier) => (
            <div
              key={tier.tier}
              className="bg-white rounded-lg p-4 shadow-sm space-y-2"
            >
              <div className="flex items-baseline justify-between">
                <p className="font-bold">{tier.label}</p>
                <p className="text-sm font-semibold text-gray-900">
                  ${tier.priceMonthly}<span className="text-xs font-normal text-gray-500">/mo</span>
                </p>
              </div>
              <p className="text-xs text-gray-500">{tier.blurb}</p>
              <ul className="text-xs text-gray-600 space-y-0.5">
                <li>{cap(tier.maxUsers, "user")}</li>
                <li>{cap(tier.maxJobs, "job")}</li>
                <li>{cap(tier.maxCrewMembers, "crew member")}</li>
                <li>{cap(tier.maxCustomers, "customer")}</li>
                <li>{tier.storage}</li>
              </ul>
              <button
                disabled={loadingTier !== null || currentPlan === tier.tier}
                onClick={() => subscribe(tier.tier)}
                className={`w-full ${
                  currentPlan === tier.tier && planStatus === "active"
                    ? "bg-gray-100 text-gray-500"
                    : "bg-blue-600 text-white"
                } py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2`}
              >
                {loadingTier === tier.tier && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                {currentPlan === tier.tier && planStatus === "active" ? (
                  <>
                    <Check className="w-4 h-4" />
                    Current plan
                  </>
                ) : (
                  "Subscribe"
                )}
              </button>
            </div>
          ))}
        </div>

        {hasSubscription && (
          <button
            disabled={managing}
            onClick={manage}
            className="w-full bg-gray-800 text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2"
          >
            {managing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading...
              </>
            ) : (
              "Manage Subscription (update card / cancel)"
            )}
          </button>
        )}

        {/* Customer online payments (lawn only — the payments pivot is reversed
            for lawn, so lawn orgs can accept direct-charge invoice payments +
            autopay). Server-rendered notice + a client reconnect button. */}
        {customerPaymentsSection}

        {/* Bookkeeping integration (payments pivot). The org connects its own
            provider (QuickBooks first); the platform never touches customer
            money. Rendered by the server page as a self-contained client comp. */}
        {accountingSection}

        {tiers.some((t) => t.storageCustom || t.maxUsers === null || t.maxJobs === null) && (
          <p className="text-xs text-gray-400 px-1">
            *Unlimited dimensions on the Business tier are a soft ceiling — need more? Call or email us.
          </p>
        )}
      </main>
    </div>
  );
}