"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, AlertTriangle } from "lucide-react";

// Lightweight trial / expired / past-due banner shown on the dashboard for the
// org admin. Fetches /api/org/plan and renders nothing for platform accounts,
// non-admins, or healthy paid plans. Only the admin can act on it, so it's
// gated to admins.

type PlanInfo = {
  plan: string | null;
  planStatus: string | null;
  trialDaysLeft: number | null;
  isExpired: boolean;
  isPlatform: boolean;
  isAdmin: boolean;
};

export default function PlanBanner() {
  const [info, setInfo] = useState<PlanInfo | null>(null);

  useEffect(() => {
    fetch("/api/org/plan")
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});
  }, []);

  if (!info || info.isPlatform || !info.isAdmin || info.plan === null) {
    return null;
  }

  if (info.isExpired || info.plan === "canceled") {
    return (
      <Link
        href="/admin/billing"
        className="block bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm flex items-center gap-2"
      >
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        <span>
          Your plan is inactive.{" "}
          <u>Choose a plan to resume</u> creating jobs and users.
        </span>
      </Link>
    );
  }

  if (info.planStatus === "past_due") {
    return (
      <Link
        href="/admin/billing"
        className="block bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-sm flex items-center gap-2"
      >
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        <span>
          Payment past due.{" "}
          <u>Update your billing info</u> to avoid interruption.
        </span>
      </Link>
    );
  }

  if (
    info.plan === "trial" &&
    info.trialDaysLeft !== null &&
    info.trialDaysLeft <= 7
  ) {
    const left = info.trialDaysLeft;
    return (
      <Link
        href="/admin/billing"
        className="block bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-sm flex items-center gap-2"
      >
        <Sparkles className="w-4 h-4 flex-shrink-0" />
        <span>
          {left === 0
            ? "Your trial ends today."
            : `${left} trial day${left === 1 ? "" : "s"} left.`}{" "}
          <u>Choose a plan</u> to keep your account active.
        </span>
      </Link>
    );
  }

  return null;
}