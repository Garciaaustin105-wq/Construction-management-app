import { Suspense } from "react";
import { requireRole } from "@/lib/server-gate";
import { PIPELINE } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import QuickQuoteForm from "@/components/QuickQuoteForm";

/**
 * Quick Quote page – a lightweight estimate entry point for sales reps.
 * Gate matches /estimates and /estimates/new (PIPELINE) — was OFFICE_OR_PM,
 * which dead-ended sales reps clicking the "Quick quote" option on the
 * Estimates page's New menu (sales is in PIPELINE, not OFFICE_OR_PM).
 */
export const dynamic = "force-dynamic";

export default async function QuickQuotePage() {
  const me = await requireRole(PIPELINE, "/dashboard");

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Quick quote" subtitle="New prospect" />
      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        <Suspense fallback={null}>
          <QuickQuoteForm orgId={me.orgId ?? ""} />
        </Suspense>
      </main>
    </div>
  );
}
