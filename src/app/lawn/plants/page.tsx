import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import PlantCatalogueManager from "@/components/PlantCatalogueManager";
import { listPlantProducts } from "@/lib/plantProducts";

export const dynamic = "force-dynamic";

// Office plant & tree catalog (lawn variant), phase 2 of the quick-estimator
// roadmap. The office/PM builds the org's plant list once — name, category,
// size, installed price, legend colour, notes, active flag. Placing plants on
// the map is a LATER handoff; this screen is the catalogue only.
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
  const { data } = await listPlantProducts(supabase, me.orgId ?? "");

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