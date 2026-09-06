import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import LaborItemsCatalogue from "@/components/LaborItemsCatalogue";
import { listLaborItems } from "@/lib/laborItems";

export const dynamic = "force-dynamic";

// Office labor catalog (lawn variant), Lane A of the UI handoff — the flat
// catalogue of labor lines that are NOT sod, plant or irrigation labor (those
// are priced by their own catalogues; see LABOR_SCOPE_NOTE, rendered by the
// manager).
//
// Gate: requireRole(OFFICE_OR_PM) — matches the labor_items RLS tier
// (tier_office_or_pm) exactly (role-gate-mismatch pattern). Then a lawn-org
// gate: the estimator is lawn-only.
//
// The manager is a client component (inline CRUD needs the browser); this
// server shell seeds it with the org's items via RLS through the laborItems
// contract. All CRUD goes through src/lib/laborItems.ts — no inline queries,
// no re-derived math.

export default async function LaborItemsPage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  // activeOnly=false: the manager dims retired rows, so it needs them.
  const { data } = await listLaborItems(supabase, me.orgId ?? "", false);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Labor Items" subtitle="Catalog" />
      <main className="max-w-md lg:max-w-7xl mx-auto p-4">
        <Suspense fallback={null}>
          <LaborItemsCatalogue initial={data} orgId={me.orgId ?? ""} />
        </Suspense>
      </main>
    </div>
  );
}