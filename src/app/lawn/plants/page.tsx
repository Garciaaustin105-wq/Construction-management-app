import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import PlantCatalogueManager from "@/components/PlantCatalogueManager";
import { listPlantCatalogue } from "@/lib/plantProducts";

export const dynamic = "force-dynamic";

// Office plant & tree catalog (lawn variant), phase 2 of the quick-estimator
// roadmap. The office/PM builds the org's species list once — name, botanical
// name, category, legend colour, notes, active flag — and attaches sizes
// (cost, installed price, install minutes) to each. Placing plants on the map
// is a LATER handoff; this screen is the catalogue only.
//
// Gate: requireRole(OFFICE_OR_PM) — matches the plant_product_office_all RLS
// policy (tier_office_or_pm) exactly (role-gate-mismatch pattern). Then a
// lawn-org gate: the estimator is lawn-only.
//
// The manager is a client component (inline CRUD needs the browser); this
// server shell seeds it with the org's plants via RLS through the
// plantProducts contract (same-org reads are plant_product_same_org_read).
// All CRUD goes through src/lib/plantProducts.ts — no inline queries, no
// re-derived math.

export default async function PlantCataloguePage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  // activeOnly=false: the manager dims retired rows, so it needs them — and
  // with the species/size split this also keeps retired SIZES visible.
  const { data } = await listPlantCatalogue(supabase, me.orgId ?? "", false);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Plants & Trees" subtitle="Catalog" />
      <main className="max-w-md lg:max-w-7xl mx-auto p-4">
        <Suspense fallback={null}>
          <PlantCatalogueManager initial={data} orgId={me.orgId ?? ""} />
        </Suspense>
      </main>
    </div>
  );
}