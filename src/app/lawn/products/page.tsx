import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import ChemicalProductsManager from "@/components/ChemicalProductsManager";
import type { ChemicalProduct } from "@/lib/chemicals";

export const dynamic = "force-dynamic";

// Office chemical-product catalog (lawn variant). The office/PM builds the
// org's product list once — name, EPA reg #, active ingredient, default rate +
// unit, re-entry interval, active flag, notes. Crew read this catalog (to pick
// a product when logging a field application), but only office/PM manage it.
//
// Gate: requireRole(OFFICE_OR_PM) — matches the chem_product_office_all RLS
// policy (tier_office_or_pm) exactly (role-gate-mismatch pattern). Then a
// lawn-org gate: chemical tracking is lawn-only for launch.
//
// The manager is a client component (inline CRUD needs the browser); this
// server shell seeds it with the org's products via RLS (the session client is
// org-scoped by chem_product_same_org_read). CRUD is client-side through RLS
// — no /api route for products, mirroring customers. Only office/PM can write
// (chem_product_office_all), so the write path is enforced at RLS too.

export default async function ChemicalProductsPage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("chemical_products")
    .select(
      "id, organization_id, name, epa_reg_number, active_ingredient, default_rate, rate_unit, re_entry_hours, active, notes, created_at"
    )
    .order("name", { ascending: true });

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Chemical Products" subtitle="Catalog" />
      <main className="max-w-md lg:max-w-7xl mx-auto p-4">
        <Suspense fallback={null}>
          <ChemicalProductsManager
            initial={(data as ChemicalProduct[] | null) ?? []}
            orgId={me.orgId ?? ""}
          />
        </Suspense>
      </main>
    </div>
  );
}