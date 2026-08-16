"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Check } from "lucide-react";
import { useToast } from "@/components/Toast";

type Tier = {
  tier: "starter" | "pro" | "enterprise";
  label: string;
  blurb: string;
  maxUsers: number | null;
  maxJobs: number | null;
};

export default function BillingForm({
  currentPlan,
  planStatus,
  trialDaysLeft,
  isExpired,
  hasSubscription,
  tiers,
  connectSection,
}: {
  currentPlan: string;
  planStatus: string;
  trialDaysLeft: number | null;
  isExpired: boolean;
  hasSubscription: boolean;
  tiers: Tier[];
  connectSection?: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const searchParams = useSearchParams();
  const [loadingTier, setLoadingTier] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const status = searchParams.get("status");

  useEffect(() => {
    if (status === "success") {
      toast.success("Subscription active — thanks!");
    } else if (status === "cancel") {
      toast.warning("Checkout canceled.");
    }
  }, [status, toast]);

  const labelMap: Record<string, string> = {
    trial: "Trial",
    starter: "Starter",
    pro: "Pro",
    enterprise: "Enterprise",
    expired: "Expired",
    canceled: "Canceled",
  };

  const subscribe = async (tier: string) => {
    setLoadingTier(tier);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const data = await res.json();
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
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {tiers.map((tier) => (
            <div
              key={tier.tier}
              className="bg-white rounded-lg p-4 shadow-sm space-y-2"
            >
              <p className="font-bold">{tier.label}</p>
              <p className="text-xs text-gray-500">{tier.blurb}</p>
              <p className="text-sm text-gray-500">
                {tier.maxUsers !== null
                  ? `Up to ${tier.maxUsers} users`
                  : "Unlimited users"}
              </p>
              <p className="text-sm text-gray-500">
                {tier.maxJobs !== null
                  ? `Up to ${tier.maxJobs} jobs`
                  : "Unlimited jobs"}
              </p>
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

        {/* Receive customer invoice payments online (Stripe Connect). Rendered
            by the server page as a self-contained client component. */}
        {connectSection}
      </main>
    </div>
  );
}