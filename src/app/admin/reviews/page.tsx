import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import ReviewsInbox from "@/components/ReviewsInbox";
import type { ReviewRequest } from "@/lib/reviews";

export const dynamic = "force-dynamic";

// Office review-request inbox (lawn variant). Lists the rating-gate rows minted
// when a paid lawn org marks a visit done: who was asked, the rating they left
// (if any), and unhappy feedback the office should follow up on before the
// customer vents publicly. The gate itself runs in the visit status route; this
// page is read-only visibility + filtering (no CRUD yet — offices act on
// feedback by following up directly, not by editing rows).
//
// Gate: requireRole(OFFICE_OR_PM) — matches the review_requests RLS policy
// (tier_office_or_pm) exactly so the page gate and the data gate never drift
// (the role-gate-mismatch pattern). Then a lawn-org gate: only lawn orgs mint
// review_requests for launch (construction opts in later with no schema change),
// so a non-lawn org that reaches here is redirected.
//
// Seed via RLS (the session client is org-scoped by the policy), mirroring
// /admin/customers + /admin/leads. The list is a client component for filtering;
// no server round-trips on filter changes.

export default async function ReviewsPage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("review_requests")
    .select(
      "id, organization_id, customer_id, visit_id, channel, rating, feedback, status, created_at, opened_at, completed_at, customers(name)"
    )
    .order("created_at", { ascending: false });

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Reviews" subtitle="Rating gate" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        <Suspense fallback={null}>
          <ReviewsInbox initial={(data as ReviewRequest[] | null) ?? []} />
        </Suspense>
      </main>
    </div>
  );
}