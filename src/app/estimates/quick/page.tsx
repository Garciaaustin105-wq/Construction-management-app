import { Suspense } from "react";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import QuickQuoteForm from "@/components/QuickQuoteForm";

/**
 * Quick Quote page – a lightweight estimate entry point for sales reps.
 * Requires an office or PM role and renders the QuickQuoteForm client component.
 */
export const dynamic = "force-dynamic";

export default async function QuickQuotePage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Measure & quote" subtitle="Estimates" />
      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        <Suspense fallback={null}>
          <QuickQuoteForm orgId={me.orgId ?? ""} />
        </Suspense>
      </main>
    </div>
  );
}
