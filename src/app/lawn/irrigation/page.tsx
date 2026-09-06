import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import IrrigationProductsManager from "@/components/IrrigationProductsManager";
import { listIrrigationCatalogue } from "@/lib/irrigationProducts";

export const dynamic = "force-dynamic";

// Office sprinkler-head catalog (lawn variant), Lane A of the UI handoff.
// The office/PM builds the org's head MODELS once — name, category, legend
// colour, notes, active flag — and attaches NOZZLES (throw, cost, installed
// price, install minutes) to each. Placing heads on the map is the estimator's
// side; this screen is the catalogue only.
//
// Gate: requireRole(OFFICE_OR_PM) — matches the irrigation RLS tier
// (tier_office_or_pm) exactly (role-gate-mismatch pattern). Then a lawn-org
// gate: the estimator is lawn-only.
//
// The manager is a client component (inline CRUD needs the browser); this
// server shell seeds it with the org's catalogue via RLS through the
// irrigationProducts contract. All CRUD goes through src/lib/irrigationProducts.ts —
// no inline queries, no re-derived math.

export default async function IrrigationCataloguePage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  // activeOnly=false: the manager dims retired rows, so it needs them — and
  // the seeded catalogue ships 54 nozzles with radius 0 (throw deliberately
  // NOT recorded) that the office still has to be able to see and price.
  const { data } = await listIrrigationCatalogue(supabase, me.orgId ?? "", false);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Irrigation" subtitle="Catalog" />
      <main className="max-w-md lg:max-w-7xl mx-auto p-4">
        <Suspense fallback={null}>
          <IrrigationProductsManager initial={data} orgId={me.orgId ?? ""} />
        </Suspense>
      </main>
    </div>
  );
}